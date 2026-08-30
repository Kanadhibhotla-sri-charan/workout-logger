# 2026-08-30 — Badminton session logging (repo + route)

## Why

`badminton_session_details` has had a schema since an earlier pass of
the "Next Phase" spec batch, but nothing could actually write to it.
Spec §15: badminton is a first-class training modality — duration,
intensity, singles/doubles, games, quality, and fatigue must be
captured as their own data, and must never be converted into fake
hypertrophy-set-equivalents.

## What changed

- `src/repositories/badmintonSessionDetailsRepo.ts` (new) —
  `BadmintonSessionDetailsRepo.record()` upserts detail onto an
  existing `workout_sessions` row (1:1, keyed on
  `workout_session_id`). Validates: the referenced session exists
  (`UnknownWorkoutSessionError`), it is actually `session_type:
  'badminton'` (`NotABadmintonSessionError` — this data structurally
  cannot attach to a gym session), and `intensity`/`format`/
  `games_count`/`session_quality`/`post_session_fatigue` are each
  within their allowed values (`InvalidBadmintonSessionDetailsError`),
  mirroring the explicit-error-over-raw-SQLite-constraint approach
  already used by `AestheticAssessmentsRepo`. `get()` reads it back.
  `record()` upserts rather than insert-once, since a session's detail
  is realistically filled in and then sometimes corrected.
- `src/server/routes/workouts.ts` — `PUT /api/workouts/:id/badminton-details`
  (upsert), `GET /api/workouts/:id/badminton-details`. `GET
  /api/workouts/:id` now also returns `badminton_details` (`null` for
  a non-badminton session or one with nothing recorded yet) alongside
  the existing `exercises` array.

## Tests

`tests/badmintonSessionDetails.test.ts` (8 tests): full detail
round-trips through record/get; unknown session id rejected; a `gym`
session rejected; out-of-range `session_quality`/`post_session_fatigue`
rejected; invalid `intensity`/`format` rejected; a second `record()`
call upserts rather than duplicating; `get()` on an unrecorded session
returns `undefined`; the stored shape carries no `exposure_units` or
`sets` field — a structural check that this data stays its own thing
rather than getting folded into hypertrophy volume accounting.

## Verification (actually run)

```
$ npx tsc --noEmit
(no output — clean)

$ npx vitest run
 Test Files  27 passed (27)
      Tests  195 passed (195)
```

(187 tests before this batch; 195 after adding
`tests/badmintonSessionDetails.test.ts`'s 8 tests — no regressions.)

## Still open

This closes the last purely data-layer item from the current spec
batch (goal history, aesthetic tracking, outside-Blueprint gate, goal
creation/confirmation, badminton logging are all now backed by real
repos and routes). What remains is the actual deterministic engine:
exercise selection, volume, frequency/schedule, time/equipment
fitting, recovery, resource allocation, the daily workout-generation
pipeline, and progression — all still `NotApprovedError` stubs.
