# AI Weekly Evaluation and Validation Implementation Log

## Purpose

This document records the design discussions, observed failures, decisions, and implementation work for the AI workout-programming evaluation. The work is intentionally isolated from production data and production deployment. The evaluation target was Qwen `qwen/qwen3-next-80b-a3b-instruct` and the week-generation harness was designed to make one planning call and one commit call for a complete week containing four gym sessions.

## Initial evaluation scope

The supplied training history covered September 15–18, 2026:

- September 15: push session with incline press, fly, lateral raise, triceps extension, crunches.
- September 16: pull session with pulldown, pullover, row, rear-delt row, shrugs, curls.
- September 17: legs session with squats, hip thrusts, split squats, abduction, and forearms.
- September 18: upper session with curls, pushdowns, overhead extensions, incline press, pec deck, lateral raise, pullover, and face pulls.

The user required one model request for the whole week, not one request per day. The eval harness therefore uses exactly two model calls: a reasoning/planning call and a commit call returning all seven days.

## Main problems found

### Authored sets versus per-session caps

The original repair/validation behavior treated Blueprint-authored exercise sets as exact values. That conflicted with the coaching requirement that authored sets and `directSetsPerExposureCap` are maximums. A coach may intentionally assign fewer sets when recent exposure, recovery, session capacity, or prioritization supports it.

The resulting rule is:

- sets must be an integer from 1 through the allowed maximum;
- reps minimum/maximum and RIR minimum/maximum remain exact authored values;
- a reduced exercise requires an auditable rationale according to goal priority.

### Repair and duplicate exercises

Duplicate exercise assignments are repaired rather than rejected. When the same exercise is assigned to multiple targets, the repair keeps the occurrence with the stronger claim based on goal relevance, session-target fit, and unmet need, then removes the duplicate. Repair notes are emitted for duplicate removal and other repair actions, including role correction, set clamping, reps/RIR correction, and session-cap trimming.

The UI already displays proposal warnings, so these repair notes can be surfaced during proposal review.

### Weekly adequacy

The whole-week eval now calculates generated direct sets for each target and compares them with the target's weekly development reference. It reports the reference, generated sets, shortfall, goal status, and horizon.

- Goal-target shortfalls require a recovery or recent-overexposure reason and carryover.
- Normal-target shortfalls are warnings rather than failures.
- Deferrals are mechanically normalized so `unmetSets` is computed from reference minus planned volume instead of being trusted from model prose.
- The session target cap remains a hard rejection.

### Prompt contradiction

The shared base prompt originally said authored fields, including sets, must be copied exactly. A later rule said sets could be reduced. This caused the model to treat reductions as invalid or optional.

The prompt was changed so:

- reps and RIR fields are copied exactly;
- authored sets are maximums;
- fewer sets are allowed when supported by coaching data;
- a reduced exercise should carry a short reason in its own rationale field.

The whole-week eval no longer repeats the exercise-rationale rule; it relies on the shared base prompt.

### Tiered rationale validation

Missing rationale on a reduced exercise is tiered:

- missing rationale for a goal muscle is a failure;
- missing rationale for a normal muscle is a visible warning.

All other checks remain strict: set ceiling, minimum of one set, authored reps/RIR, session target cap, and goal weekly adequacy.

## Evaluation results

Three corrected Qwen whole-week iterations were run after rebuilding and verifying the isolated compiled copy. The final prompt/validator batch remained 0/3 passing.

The failures were model-quality findings, not evidence that the ceiling rule was broken:

- the model reduced close-grip bench press from 3 to 2 sets for the broad triceps goal without an exercise rationale;
- the model's broad-triceps weekly total was below its reference and did not provide valid recovery/recent-overexposure carryover;
- iteration 1 also exceeded authored/cap sets for several exercises and exceeded the 8-target session cap.

Normal-muscle rationale omissions were warnings. The earlier `unmetSets: 0` errors were eliminated.

## Shared-target audit limitation

The Blueprint scope defines some exercises as contributing to more than one target. In particular, overhead triceps extension contributes to both broad triceps and triceps long-head. The production/reference scope is represented in `src/blueprint/subTargetExerciseScope.ts`.

The current eval helper totals only the target ID assigned by the model. Therefore it credits an overhead extension to `triceps-long-head` but does not also credit it to `triceps`. This under-reports broad-triceps volume. The final reported broad-triceps totals of approximately 4–5/24 should be interpreted as under-counted; shared-target credit would raise them to approximately 12–13/24. The goal still remains short, so this measurement issue does not change the pass/fail conclusion, but it should be corrected before relying on the audit for production decisions.

Iteration 1's over-cap exercises were:

- chest-supported row: 4 versus allowed 3;
- seated cable row: 4 versus allowed 3;
- wide-pronated lat pulldown: 4 versus allowed 3;
- barbell/EZ-bar curl: 4 versus allowed 3;
- face pull: 3 versus allowed 2;
- lying leg curl: 3 versus allowed 2;
- a second face-pull assignment: 3 versus allowed 2;
- one Friday session had 9 distinct targets against the hard cap of 8.

These were assigned to individual targets and were not caused by shared-target scoping.

## Verification

Focused verification completed before this branch was created:

- TypeScript typecheck passed.
- System-instruction contract tests passed: 8/8.
- Repair tests passed: 8/8.

Production checkout, production database, and production user data were not modified by the evaluation runs. The model evaluations used an isolated temporary checkout/database and the configured Velona provider.

## Follow-up recommendation

Before treating weekly volume audit numbers as authoritative, update the eval helper to use the same sub-target exercise-scope mapping as the reference engine so shared exercises receive credit for every target they genuinely train. Do not loosen the goal adequacy rule or add more prompt rules based on these three Qwen iterations.

## Follow-up review and repairs (2026-09-20)

A read-through of the branch found that the eval and production were two different pipelines, which explains most of the failures reported above. Goal: a usable program after repair, instead of a rejection.

### Gaps found in commit 68bd7f0

1. The whole-week path (production and eval) never ran repair; only the single-session path did. So the eval judged raw model output against rules production repairs: 8-target overruns, over-authored sets and duplicates were rejected instead of fixed. The earlier claim that duplicate repair caused no failures was vacuous because repair never ran on a week.
2. Repair forced sets UP to the maximum unconditionally, silently reverting a coach's deliberate reduction, and made the reduced-rationale check unreachable in the single-session path.
3. The week validator never enforced the per-target set cap (it passed undefined and computed an unused variable). The dip-3 versus lower-pec-2 conflict stayed open there.
4. The eval read goal target ids from fields that do not exist (primaryTargetIds/supportingTargetIds), so its goal-deferral reason check never fired.
5. The prompt and error text required 'carryover' but the deferral schema has no such field and nothing checked it.
6. The eval hard-coded legsUseTwoWeekHorizon: true and horizon 'week' for every row; legs were audited against a weekly reference one leg day cannot deliver.
7. The audit credited only the assigned target, undercounting shared exercises.

### Changes

- programmerProposalRepair.ts: one shared repair for a single session and for every unlocked day of a week (locked days untouched). Sets are a ceiling: clamped down when above it, rounded to a whole number of at least 1, a reduction with a rationale is kept, a reduction on a non-goal muscle is kept, and an UNEXPLAINED reduction on a goal muscle is restored to the ceiling with a note (an unexplained cut to goal work is what the validator refuses, and restoring it delivers a usable session). Repair never raises a reduction the model chose for a stated reason.
- setCaps.ts (new): one source for the per-exposure cap, used by the repair and the week validator.
- weekReconciliationDomainValidator.ts: enforces the per-target cap.
- aiProgrammerService.ts: runs repairWeekReconciliation before week validation.
- weeklyVolumeAudit.ts (new, unit tested): credits shared exercises via the engine's own sub-target scope (untagged or unscoped exercises credit the assigned target); compares against what the week can deliver, min(weekly reference, per-exposure cap x compatible sessions); one definition of goal; goal deferrals need recovery or recent_overexposure, and the deferral is the carryover record (no separate field).
- modelEvalWholeWeekTwoStep.mjs: runs the repair, uses the audit module, reports usableAfterRepair separately from weekAdequacy, drops the false horizon flag and the carryover wording.
- Three tests that still asserted exact-match sets were updated to the ceiling rule (they were hidden by date rot).

### Verification

Typecheck clean. Full suite: 231 failed on both the branch baseline and after these changes, identical failure set (date rot in hardcoded 2026-09-13 fixtures), 19 new tests passing. With a temporary faked clock the AI programmer tests, including the week service and validators, pass except 9 that fail identically on the untouched branch. The live model eval was not rerun in this pass (needs the Velona credentials and isolated eval database).

