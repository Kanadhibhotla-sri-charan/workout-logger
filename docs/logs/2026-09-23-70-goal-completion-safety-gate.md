# 2026-09-23 — Safety gate on the goal-completion repair

Follow-up to log 69's production-impact review. Implements only the smallest fix identified there: `completeGoalVolume` now requires a real `programmingBrief` to run at all. No other finding from that review (decideVolume wiring, recovery/rationale awareness, multi-goal priority ordering, `creditedTargetKeys`, the displacement algorithm) was touched — those remain open follow-up items.

## The guard

`src/ai-programmer/validation/programmerProposalRepair.ts`, first line of `completeGoalVolume`:

```ts
if (!context.programmingBrief) return { days: [...days], notes: [] };
```

With no brief, the function returns the days unchanged and no notes — a true no-op. Production's real `reconcile_week` context never builds a `programmingBrief`, so this pass no longer acts on it; it stays live for the eval harness, which does supply one.

Updated the doc comments on `AIWeekReconciliationRepairContext` and `completeGoalVolume` to state this plainly — the previous comment said a real request without a brief "still gets a required number to work toward," which was exactly the defect the review flagged; that language is now corrected to describe the guard instead.

## Test fix needed along the way

The existing two completion tests (log 69) called `richWeekContext(targets)` relying on a default `programmingBrief: tricepsBrief` parameter. Adding a genuine "no brief" test exposed a real test-authoring bug: `richWeekContext(targets, undefined, undefined)` does **not** produce `programmingBrief: undefined` — a JS default parameter still activates on an explicitly-passed `undefined` argument, so the "no-brief" test was actually still running the pass. Fixed by flipping the default: `richWeekContext` now defaults to no brief, and every test that needs the pass to run passes `tricepsBrief` explicitly. This is a test-file-only correction, not a change in application behavior.

## New tests

`tests/ai-programmer/programmerProposalRepair.test.ts`, new nested describe `safety gate (2026-09-23): requires a real programmingBrief to run at all`:

1. No brief supplied → `triceps` stays at 14 (the same shortfall as before), `dip-triceps-biased`/`cable-pushdown` never appear, no "replaced" warning — the completion pass made no swaps or additions at all.
2. Brief supplied (`tricepsBrief`, matching the real deliverable) → `triceps` reaches 24, `triceps-long-head` stays at 8, both missing exercises appear — the eval-path behavior from log 69 is unaffected by the guard.

## Verification

`npx vitest run tests/ai-programmer/programmerProposalRepair.test.ts` → 21/21 passed (19 pre-existing + 2 new). `npm run typecheck` → clean. `npm run build` → clean. Full suite: 232 failed / 1563 passed (was 1561 before this change) — identical pre-existing date-rot failure count, 2 new passing tests, zero regressions.

## Still open (not touched in this change)

The other four findings from log 69's review remain: decideVolume's real, conservative volume decision is not wired into `reconcile_week` at all; `completeGoalVolume` doesn't check a target's `recovery.priority_adjustment` or an exercise's own stated rationale before adding volume; multi-goal shortfall processing doesn't consult `context.activeGoals`' priority order; and `compatibleSessions`/`deliverable` is computed from the pre-reconciliation `existingProgram` snapshot, not the model's own reorganized day purposes. All are now moot for production specifically (the pass never runs there without a brief), but remain real gaps for whenever a real brief is eventually wired into reconciliation.
