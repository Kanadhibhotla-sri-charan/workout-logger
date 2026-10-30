# Goal muscles count direct sets; load hints in the logger

Owner 2026-10-30: "3 out of 4 workout sessions are done and I feel triceps
are still lagging behind". The weekly tally read triceps 17 / 16 (met), so
the planner stopped adding triceps. About 6 of the 17 were half credits
from pressing (incline barbell, decline DB, overhead, cable chest press).
Direct triceps work was 11 sets (12 and 10 the two weeks before), about 4
of them ramp sets at RIR 2-3. The skull crusher had stayed at 12.5 kg x 15
since 10-12. Owner chose A + D, D for every exercise.

## A. Goal muscles count direct work only (weeklyLedger.ts)
- `isDirectCredit(credit, targetId)`: the exercise gives the target's volume
  group full credit (1); a sub-region (triceps long head) looks at its
  parent, so a skull crusher still counts 0.5 toward the long head.
- `readDailyCredit(..., directOnly)`: ids in `directOnly` skip indirect
  credit. `buildWeeklyLedger` and `volumeOverview` pass the goal targets
  (and their sub-regions).
- Non-goal muscles keep Blueprint's partial credit.
- Today page volume card note updated.
- Differs from Blueprint's target_credit rule: noted for the Blueprint dev.

With this week's data, triceps reads 11 / 16 instead of 17 / 16.

## D. Load hints (src/engine/loadHint.ts, GET /api/workouts/:id, logger)
- `load_hints` (by performance id) on GET /api/workouts/:id for sessions
  not yet completed (a finished session's response is unchanged).
- From the last completed session of the same exercise, equipment,
  attachment and unit (progressSeriesKey), at the heaviest weight used
  (ramp sets ignored):
  - top of today's rep range -> "Go heavier: about X kg for <min>+"
    (+2.5 kg; dumbbells +2 kg, the next pair)
  - within the range -> same weight, aim for one more rep
  - below the range -> stay at that weight
  - 3+ sessions in a row at the same weight are called out.
- Logger: the hint shows in the exercise (replacing the old "Last time"
  line when both exist) and on the one-line row ("↑ 15 kg" or
  "42.5 kg × 13"). Not shown for drills, timed / distance sets, or a
  finished session. Display only; the AI plan is unchanged.

## Checks
- tests/ai-programmer/weeklyLedger.test.ts: direct-only test added (15 pass).
- tests/engine/loadHint.test.ts: 4 tests (heavier + stuck count, dumbbell
  step, reps / hold, attachment match and skips).
- Full suite: 246 failures, the same date-dependent set as before (one
  new failure on the way was a finished session's response changing;
  fixed by not computing hints for completed sessions).
- Demo DB (fake data) on a local server, phone width: row hints and the
  in-card hint render; no console errors.

## Owner note
The Legs pause is lifted, but leg rehab is done in separate sessions; the
planned leg work is skipped and what was done goes in the session notes.
