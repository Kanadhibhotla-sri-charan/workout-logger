# 2026-09-23 — Triceps/session-completion repair

Follow-up to logs 67/68. Root-caused the triceps shortfall (log 68's live 3-run data: triceps actual 17/14/14 against a 24 target) before touching anything: it is a prescription-selection gap, not an accounting bug. Every triceps-bearing session across all 3 runs hit exactly the 10-exercise/session cap, with the last slot going to a duplicate non-goal exercise (usually a second oblique exercise) instead of the goal's own remaining authored exercises (dip, cable pushdown). The shared triceps/triceps-long-head crediting was hand-verified correct in every run (recomputed totals matched `generatedDirectSets` exactly). A parallel check on biceps/brachialis-arm-thickness (the closest structural analog) found a separate, currently-inert scope-resolution bug for non-goal parent/child pairs — explicitly out of scope for this change, left untouched.

Scope, per explicit instruction: only the completion-pass repair in `programmerProposalRepair.ts`. No prompt change. No change to `creditedTargetKeys` or package-level scope resolution.

## Where the repair was added

`src/ai-programmer/validation/programmerProposalRepair.ts`, whole-week path only (`repairWeekReconciliation`), added after the existing per-day set-ceiling repair:

- `AIWeekReconciliationRepairContext` — a new exported type, `AIReconciliationContext` plus an optional `programmingBrief`. Production's real reconcile_week context has no brief at all (existing note in `setCaps.ts`); this field is optional so real callers are unaffected, and the completion pass still has a real number to work toward even without one — the package's own deliverable figure (see "behavior outside this repair" below).
- `completeGoalVolume` — the pass itself: re-audits the whole week via the existing `auditWeeklyVolume` (not re-implemented) after every single swap, and only continues while a goal remains deficient, an unused authored exercise exists for it, and a safe exercise can be displaced.
- `findDisplaceableExercise` — the exercise a swap may take a slot from: not itself an active-goal exercise, and only when a sibling exercise for the same target remains afterward (never zeroes out a muscle's coverage for the day).
- `findMissingAuthoredExercise` — the next unused, authored exercise from the deficient target's own `validExercises` (never a different target's list).
- `buildGoalExercise` — constructs the added exercise from the real Blueprint-authored prescription, clamped to the same per-exposure cap `setCaps.ts` already defines.
- `repairWeekReconciliation`'s exported parameter type changed from `AIReconciliationContext` to the new superset type; the real call site in `aiProgrammerService.ts` (a plain `AIReconciliationContext`, no brief) still type-checks unchanged, since the added field is optional.

Single-session `repairProposal` was deliberately left untouched — the observed failure and this fix are both about whole-week session composition.

## Which exercise gets displaced, and why

In the reproduction: a session already has triceps-long-head's 2 shared overhead exercises, triceps's own close-grip-bench-press, and 7 non-goal filler exercises (10/10, at the exercise cap) — two of the filler targets have 2 exercises each (mirroring the real run's duplicate oblique exercise). The pass displaces one exercise from each doubled filler target in turn (the last one in the session, per the existing file's own removal convention) to add `dip-triceps-biased` then `cable-pushdown` — never touching a filler target that only has one exercise (that would zero it out) and never touching another active goal's exercise at all.

## Before/after triceps volume

Reproduction of the exact live numbers: before completion, `generatedDirectSets` for `triceps` = 14 (close-grip 3 + the two shared overhead exercises' 2+2, per session, x2 sessions) against a required 24 (real Blueprint data: 12/session x 2 push-compatible sessions — no synthetic brief needed). After completion: 24/24 — closed by adding dip (3) and pushdown (2) in each session. `triceps-long-head` stays at 8/8 throughout — it had nothing missing and is untouched.

## Tests

`tests/ai-programmer/programmerProposalRepair.test.ts`, new describe block `repairWeekReconciliation — goal-completion pass (2026-09-23)`:

1. **Completion succeeds**: reproduces the live composition (10/10 exercises, 2 doubled non-goal fillers) and asserts `triceps` reaches 24 (verified via the real `auditWeeklyVolume`, not a hand-rolled sum — the first version of this test used a naive per-exercise sum and failed, because it didn't replicate the real shared-exercise credit; fixed to call the actual audit function), `triceps-long-head` stays at 8, both `dip-triceps-biased` and `cable-pushdown` appear in every session, the exercise count stays at 10 (a replacement, never an addition), and a warning names each replacement.
2. **Safety fallback**: same composition, but every filler target is itself an active goal. No swap occurs, `triceps` stays at 14, dip/pushdown are absent, exercise count is untouched, and no "replaced" warning appears.

Run: `npx vitest run tests/ai-programmer/programmerProposalRepair.test.ts` → 19/19 passed (17 pre-existing + 2 new). `npx vitest run tests/ai-programmer/` → same 232 pre-existing date-rot failures as baseline (confirmed by name: unrelated `2026-09-13 is not editable` clock-vs-fixture failures, none in repair or audit files). Full suite: 232 failed / 1561 passed (was 1559 before this change) — identical failure count, 2 new passing tests, zero regressions. `npm run typecheck` and `npm run build` both clean.

## Behavior changed outside this specific fix

`repairWeekReconciliation` is the same function `aiProgrammerService.ts` runs on every real production `reconcile_week` request, not just the eval harness. Production's real context has no `programmingBrief`, but `auditWeeklyVolume` still computes a `required` figure with no brief supplied — falling back to the package's own deliverable (`min(reference, cap x compatible sessions)`). This means: **a real active goal target that ends up under-delivered in a real generated/reconciled week will now also get this completion pass**, using the deliverable figure as "required," not just the eval's synthetic brief number. This was not separately requested but is an unavoidable consequence of extending the shared repair function as asked, rather than forking a second, eval-only copy of it. The pass only ever adds volume toward a genuine active-goal shortfall, never exceeds any existing cap, and never displaces another goal's exercise — but it is a real, live change to production's week-reconciliation output, not confined to the eval harness, and is flagged here explicitly for that reason.
