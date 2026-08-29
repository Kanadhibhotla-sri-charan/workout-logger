# Calorie Tracker integration contract

Formal write-up of the one-way boundary between workout-logger and
`food_and_workout_tracker` ("Calorie Tracker"), referenced from
`docs/architecture.md`'s responsibility boundary section.

## Direction

```text
workout-logger  ─────completed workout data─────>  Calorie Tracker
```

One direction only. Calorie Tracker reads from workout-logger; it never
writes back. workout-logger never reads Calorie Tracker's storage,
schema, or nightly-job outputs (`log.csv`, `tdee_final`) — the two apps
communicate only through this contract.

## Input: what workout-logger provides

`getCompletedWorkouts(date)` — implemented at
`src/services/calorieTrackerExport.ts`, exposed at
`GET /api/export/completed-workouts?date=YYYY-MM-DD`. Returns only
sessions whose final `status` is `'completed'` (see Fix #1 in
`docs/logs/`) — a planned or in-progress session is never returned here,
so it can never be mistaken for activity that already happened.

Per completed session:

```text
date                    YYYY-MM-DD
session_type            'gym' | 'badminton' | 'other' | ... (extensible,
                         matches Calorie Tracker's own workout_log.csv
                         session_type column)
duration_minutes        number | null
status                  always 'completed' in this export
exercises: [
  {
    exercise_id         Blueprint exercise id
    exercise_name       resolved display name (convenience only —
                         Calorie Tracker should not key off this)
    order
    role
    sets: [
      { set_number, weight, reps, completed }
    ]
  }
]
expenditure_note        see Output responsibility, below
```

A broader `getWorkoutSessions(date)` (same shape, any status) also exists
for workout-logger's own UI/history — Calorie Tracker should not call
this one; only `getCompletedWorkouts` is the intended contract.

## Output responsibility

**Calorie Tracker decides how to transform this activity data into an
estimated workout expenditure.** workout-logger does not calculate or own
a calorie number of any kind — there is no `calories` or
`calories_burned` field anywhere in this export (enforced by a test in
`tests/calorieTrackerExport.test.ts`), and every export carries an
`expenditure_note` reiterating that logged sets/reps/load only support a
**better estimate**, never an exact figure. `tdee_final` remains entirely
Calorie Tracker's own nightly-job computation — workout-logger has no
opinion on it and does not attempt to replicate or influence it.

## Coupling

workout-logger does not depend on Calorie Tracker's internal database
schema, its CSV file format, or its nightly job. The only shared surface
is this export contract (and the plain-language description of Calorie
Tracker's existing `workout_log.csv` columns in
`docs/architecture.md` §2, kept for context, not as something
workout-logger reads or writes). If Calorie Tracker's schema changes,
nothing here needs to change unless the *shape workout-logger exports*
needs to change — and that's this document's job to keep in sync, not a
reason to reach into Calorie Tracker's storage directly.

## What Calorie Tracker must not become responsible for

Exercise selection, volume allocation, program generation, or
progression — those stay entirely inside workout-logger. Calorie Tracker
consumes finished activity data; it does not participate in deciding what
that activity should be.

## What workout-logger must not become responsible for

Food logging, nutrition targets, or TDEE ownership. If a future workout-
logger feature seems to need any of these, that's a sign the feature
belongs in Calorie Tracker instead, or needs its own new, explicitly
one-way contract — not a reason to blur this boundary.
