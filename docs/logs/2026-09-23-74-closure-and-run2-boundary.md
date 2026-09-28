# 2026-09-23 — Closure: compatibleSessions + add-when-capacity work marked complete

No code changed in this entry. Records a decision and confirms pre-deployment validation.

## Decision

The compatibleSessions fix (log 72, commit a12bc97) and the add-when-capacity repair fallback (log 73, commit 3ccb780) are complete and are being kept as-is. No further changes to the goal-completion repair, and no further changes to the parent/sub-target prompt (commit 0ce7b8f), are being made based on the fresh-slate eval results (logs 71/74). Another prompt experiment is out of scope unless a separate, concrete production problem requires it.

## Run 2's shortfall is an intentional boundary, not a defect

In the final validation (log 74), run 2 ended with `triceps` still short (16/24) even after the add-when-capacity fallback fired three times. Root cause, confirmed by inspection: the model labeled every exercise on 2026-09-30 as `triceps-long-head`, never as plain `triceps`, so `completeGoalVolume`'s existing safety rule — never introduce a goal into a session/day where the model did not explicitly train that goal — correctly declined to expand into that day under the parent label. This is the same guard that has been in place since the repair was first added (log 69: "never introduce a new training day for a goal the model didn't already put there"), doing exactly what it was built to do.

This is recorded here explicitly as an accepted boundary: **if the model never explicitly assigns the parent target to a compatible day, repair may leave a genuine shortfall rather than creating a new training-day/target assignment.** The alternative — treating a day's shared-credit-only exercises as sufficient license to also expand the parent target's own dedicated exercises there — was considered and rejected, because it would mean repair overriding the model's own session-composition choice on a day the model never opted the parent target into at all. The validator correctly reports this shortfall (`weekAdequacy.ok: false` with an accurate deferral message); it is never silently hidden.

## Pre-deployment validation

Per the specific regression areas called out (compatibleSessions on blank weeks, displacement-based completion, add-when-capacity completion, authored set ceilings, exercise-cap enforcement, no-eligible-exercise safety):

- `npx vitest run tests/ai-programmer/weeklyVolumeAudit.test.ts tests/ai-programmer/programmerProposalRepair.test.ts tests/ai-programmer/weekReconciliationParentSubTargetInstruction.test.ts` -> 55/55 passed, covering every listed area across the three files.
- `npm run typecheck` -> clean.
- `npm run build` -> clean.
- `npx vitest run` (full suite) -> 232 failed / 1574 passed — identical to the last committed state (commit 3ccb780), the same pre-existing date-rot failure set documented throughout this investigation, zero regressions.

## State of the branch at this point

Commits since the triceps investigation began: 67ed888 (analysis), 1470f22 (deferral truthfulness), 338d515 (goal-completion repair), 37c8a35 (programmingBrief safety gate), 0ce7b8f (parent/sub-target prompt rule), a12bc97 (compatibleSessions fix), 3ccb780 (add-when-capacity fallback), this entry. Open, not-acted-on items carried forward from this investigation: the biceps/brachialis package-level scope-resolution mismatch (log 68, still latent and unrelated to triceps), and decideVolume/recovery/rationale awareness not being wired into `completeGoalVolume` (log 69's review, still gated off entirely by the `programmingBrief` requirement so it does not affect production today).
