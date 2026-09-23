# 2026-09-23 — Add-when-capacity fallback for the goal-completion repair

Follow-up to log 72's fresh-slate validation, which surfaced a real gap: on lean, honest sessions (well under the 10-exercise cap, no doubled/redundant non-goal exercise to safely displace), `completeGoalVolume`'s displacement-only design left a legitimate, cap-legal shortfall unclosed even after the compatibleSessions fix made the shortfall visible and correctly flagged.

Scope, per explicit instruction: add a second, fallback repair path for exactly this case. Preserve displacement as primary. No prompt change, no bypass of eligibility/authored ceilings/session caps, no invented exercises.

## Exact control flow before this change

`src/ai-programmer/validation/programmerProposalRepair.ts`, `completeGoalVolume`: when a deficient goal target had an unused authored exercise (`findMissingAuthoredExercise` returned non-null) but `findDisplaceableExercise` found no safe candidate, the loop did `continue` straight to the next day — even when the session had exercise slots to spare. Confirmed directly in the code before editing.

## The fix

Two new pieces, both in `programmerProposalRepair.ts`:

- `hasSpareCapacityFor(dayExercises, purpose, target)` — true iff adding one more exercise for `target` would stay within `sessionRealismCapFor`'s real limits: the exercise-count cap, and (only when `target` is itself a leg or abs target) that category's own share-of-session cap. Never checks the muscle-count cap, since `target` is already present in the session by the time this is called — adding one more of its own exercises never introduces a new distinct target.
- In `completeGoalVolume`'s main loop: displacement is tried first, unchanged. Only when `findDisplaceableExercise` returns null does the pass now check `hasSpareCapacityFor`; if true, it builds the missing exercise via the same `buildGoalExercise` helper the displacement path already uses and appends it to the session (never inventing an exercise — still only ever drawn from the target's own `validExercises`), recording a distinct "added ... (session had spare exercise capacity, no safe exercise to displace)" note so it's never confused with a displacement in the log.

Both paths share `buildGoalExercise`, so the added exercise gets the exact same treatment as a displaced one: real `role`/`reps`/`rir` from its own authored prescription, sets clamped to `min(authored.sets, directSetsPerExposureCapFor(target))`.

## A mathematical note verified during testing

`direct_sets_per_exposure` (the per-exposure cap) is defined, by construction, as the sum of a target's own relevant authored exercises' sets. This means no single one of those exercises can ever itself exceed that target's own cap — checked directly against the real Blueprint data (a script comparing every complete-level target's own scoped exercises against its own cap found zero cases). The originally-planned "clamps an added exercise below its authored ceiling" test was rewritten once this was discovered: it now verifies the added exercise gets exactly its authored value and stays within the real cap, rather than asserting a clamp that cannot occur with real data through this mechanism. The `Math.min` clamp itself is unchanged and still applies exactly as it does on the displacement path, for robustness against any future data change.

## Tests

`tests/ai-programmer/programmerProposalRepair.test.ts`, new describe block `add-when-capacity fallback (2026-09-23)`:

1. **Add succeeds**: a lean session (goal's own exercise + 2 solo, non-doubled filler exercises, 3/10 exercises) with no safe displacement candidate — both missing triceps exercises get added, nothing displaced, exercise count grows from 3 to 5 (still well under the cap), and an independent re-audit (not the repair's own bookkeeping) confirms zero remaining shortfall.
2. **Displacement still wins when at cap**: reuses the existing padded (10/10) fixture — confirms the new fallback never fires when the primary path already succeeds; no "added...capacity" note appears, only "replaced" notes, and the cap is never exceeded.
3. **Authored value respected**: the added exercise (dip-chest-biased on lower-pec, real Blueprint data) is applied at exactly its own authored sets and never exceeds the real per-exposure cap — see the mathematical note above for why an actual clamp couldn't be demonstrated with real data.
4. **Safe decline**: a target with only one authored exercise (already present, already at ceiling) and a brief requiring far more — repair adds and displaces nothing, and an independent re-audit confirms the real shortfall persists and is not silently hidden.

Run: `npx vitest run tests/ai-programmer/programmerProposalRepair.test.ts` -> 25/25 passed (21 pre-existing + 4 new; one test was corrected mid-implementation after the mathematical note above was discovered via a failing assertion, not silently adjusted). `npm run typecheck` and `npm run build` -> clean. Full suite: 232 failed / 1574 passed (was 1570) — identical pre-existing date-rot failures, zero regressions, 4 new passing tests.

## Not changed

Parent/sub-target accounting (`creditedTargetKeys`, `getSubTargetExerciseIds`), the audit's crediting logic generally, the safety gate from commit 37c8a35 (still requires a real `programmingBrief`), exercise eligibility rules, and the parent/sub-target prompt (commit 0ce7b8f) are all untouched.
