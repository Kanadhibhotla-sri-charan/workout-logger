# 115 — Real exercise order from set times (2026-11-24)

The logger stored exercises only in the planned order, so the coach could not
tell what order the lifter actually trained in (it inferred "arms first worked
on 17 Nov" from an order that never happened). The owner saves each exercise in
the gym as it is done, so the save time gives the real order with no extra input.

- `workout_sets.logged_at` (new column, migration in `src/db/client.ts`): the time
  a set was first saved with a result (reps or ticked done). Saves replace an
  exercise's sets wholesale, so `updateExercisePerformanceSets` keeps each set's
  first time; a set cleared back to empty loses it. Older sets stay null.
- Coach context: per set `loggedAt`, per exercise `firstLoggedAt`, per session
  `performedOrder` (exercise ids by first logged set) when any time exists.
- Skill: "Exercise order" now explains these fields; sessions up to 23 Nov were
  done big muscles first, arms last (806ba28).
- Test: `tests/coach/opusCoach.test.ts` "real exercise order from set times".
  Full suite 2391 passed.

Not deployed yet.
