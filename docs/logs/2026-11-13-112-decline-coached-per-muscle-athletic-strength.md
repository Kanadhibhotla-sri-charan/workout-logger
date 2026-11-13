# 112 · A decline is coached per muscle; Athletic strength block 1-4

Date: 2026-11-13 · Status: built, not deployed

## Request
Owner, on the deload that started 10 Nov and on Thu 12 Nov (Athletic):
- "It's about being a complete comprehensive fitness coach ... there are
  a lot of ways to address the decline without just bumping down the
  numbers that too entirely when the decline is observed in a single or
  two muscles."
- "there's never supposed to be any limit for strength block anyway put
  the limit of 4 ... no need that this number needs to be met every
  single time it's contextual and depends on coaching judgment of the
  model"
- "I didn't have rope."

## Findings
- 10 Nov: reactive deload (whole body, sets x0.5, 10-16 Nov) from two
  muscles, each on one falling exercise: side delt (upright row down,
  three lateral raises up but with 2 sessions each, so not counted) and
  triceps (leaning cable overhead extension down).
- 12 Nov Athletic: planned 2 light strength lifts (single-leg calf
  raise, reverse lunge); logged back squat, lying leg curl, hip
  abduction, hip adduction, leg-press calf raise. Jump rope planned, no
  rope: mountain climbers done.

## Changes
Decline (src/coaching/periodization/reactiveTrendEvaluator.ts,
src/engine/config.ts)
- Whole-body reactive deload only for a widespread decline:
  REACTIVE_TRIGGER.minimumDecliningTargets 2 -> 4. One to three
  declining muscles are level "watch"; no volume change.
- An exercise rising or holding over 2 sessions counts against a
  muscle's decline (a decline itself still needs 3 sessions).
- `decliningMuscles()` lists a session's declining muscles with each
  exercise's trend. It goes to the AI as
  programmingBrief.decliningMuscles (planned context: decliningMuscles)
  with rule 9b (legacy 10a): judge the cause per muscle (one stalled
  exercise, fatigue, pain / recovery notes, thin data) and choose the
  response (other candidate, keep rising exercises, train it earlier,
  sets toward either end of the legal range); state muscle, cause and
  response in programmingRationale. Other muscles keep normal volume.
- On production data the 10 Nov evaluation is now "watch" with one
  muscle (triceps long head, leaning cable overhead extension 56.3 ->
  51.8); side delt is not declining.

Athletic day (src/athletic/athleticSession.ts)
- Strength block 2-3 -> 1-4 lifts; ATHLETIC_MAX_EXERCISES 10 -> 12.
- Instruction 3: the legs' only strength day; how many lifts is the
  coach's judgment for the day (fresh legs and a quiet week: more and
  loaded; fatigue, soreness, hard days around: fewer); the maximum is a
  limit, not a number to reach; the rationale says why.

## At deploy (data, owner approval)
- End the reactive deload that started 10 Nov.
- Remove "jump rope" from the profile's available equipment.

## Tests
- periodizationSystem: 2-3 declining = watch + decliningMuscles; 4 =
  triggered (seeds extended). reactiveDeclinePerExercise: rising
  exercises count against a decline.
- athleticDay: declining muscle reaches brief and planned context, no
  deload; strength block [1, 4], max 12, instruction text.
- Full suite: 2364 passed, 13 failed (the date-rot files of log 111), 10
  skipped.
