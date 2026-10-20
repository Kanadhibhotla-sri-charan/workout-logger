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
    rep_unit            what each set's `reps` counts: 'reps' | 'steps' |
                         'seconds' | 'metres' (added 2026-10-11)
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

## Pushed file: `data/workout_sessions.json` (2026-10-21)

The route above needs Calorie Tracker to reach workout-logger, which it
cannot (Cloud Run and Claude cloud sessions; the VM has no auth or TLS).
So workout-logger pushes instead: `src/services/calorieTrackerSync.ts`
writes one file into the Calorie Tracker repo
(`Kanadhibhotla-sri-charan/food_and_workout_tracker`, branch from
`CALORIE_SYNC_BRANCH`) through the GitHub Contents API. Still one
direction: workout-logger writes only this file and never reads anything
else from that repo; Calorie Tracker only reads it.

```json
{
  "schema_version": 1,
  "generated_at": "2026-10-21T19:05:00+05:30",
  "days": {
    "2026-10-21": [
      { "session_id": "wsession_...", "session_type": "gym",
        "duration_minutes": 64, "duration_source": "user_entered", "badminton": null },
      { "session_id": "wsession_...", "session_type": "badminton",
        "duration_minutes": 120, "duration_source": "user_entered",
        "badminton": { "intensity": "medium", "format": "doubles", "games_count": 6 } }
    ],
    "2026-10-20": []
  }
}
```

- `days`: the last 14 dates in the user's timezone (IST), today first;
  every date present, `[]` = nothing completed that day (so "no workout"
  differs from "not synced yet"). Completed sessions only.
- `duration_source`: `user_entered` (typed in the logger), `legacy`
  (the old page-load clock, unreliable: Calorie Tracker ignores it), or
  `null` when there is no duration. There is no `measured` value: there
  is no automatic timing (see the decision log, section 21).
- `session_type`: `gym` or `badminton`. The Athletic leg day is a `gym`
  session.
- `badminton`: `{intensity, format, games_count}` (each may be null) on a
  badminton session, else `null`.
- No exercises, sets, notes, goals or AI data.

Commits use the message `Sync workout sessions`, only when `days` changed
(on 409/422 the sha is re-fetched and the write retried; the Calorie
Tracker app commits food logs to the same repo). Runs after "Finish
workout", after an edit to a completed session's duration or badminton
details, at start-up, and every 15 minutes. Off unless
`CALORIE_SYNC_TOKEN` is set (a fine-grained token for that one repo,
Contents read/write, kept in an env file on the VM; see
`ops/systemd/workout-logger-calorie-sync.conf`).

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
