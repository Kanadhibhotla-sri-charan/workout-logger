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
