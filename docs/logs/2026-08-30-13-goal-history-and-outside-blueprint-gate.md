# 2026-08-30 — Goal history schema, aesthetic tracking schema, and the outside-Blueprint exercise gate

## Why

Continuing the "Next Phase Implementation Specification" work. This
change covers three of that spec's data-layer requirements that hadn't
been built yet:

- §3: dated 1-5 aesthetic assessments and dated measurements, tracked
  per goal (not assumed universal to every goal).
- §4.2 / §17-18: outside-Blueprint exercises may only be *proposed*
  under a documented justification category, and never become
  prescribable until an explicit, separate approval step — plus an
  append-only history of goal-affecting events so a returning goal
  doesn't restart from zero.
- A single point of exercise-id resolution so every write path (workout
  sessions, program sessions) enforces the same "known exercise" rule:
  a real Blueprint exercise, or an approved outside-Blueprint proposal —
  nothing else.

## What changed

**Schema (`src/db/schema.sql`)**

- `goals` gained `review_cadence_days`, `source`
  (`structured`/`natural_language`), `source_text`.
- New `goal_events` (append-only): records `created`, `activated`,
  `deactivated`, `priority_changed`, `cadence_changed`,
  `exercise_changed`, `programming_modified` against a goal, with a JSON
  `detail` column and a timestamp. Nothing UPDATEs or DELETEs a goal's
  history — a goal_events row is written instead.
- New `aesthetic_assessments`: dated 1-5 rating per goal.
- New `measurements`: dated numeric measurement, optionally tied to a
  goal.
- New `outside_blueprint_exercises`: name, justification category
  (`blueprint_inadequate` / `contextual_constraint` /
  `meaningful_advantage`), justification text, `approved` (starts
  `0`), `approved_at`.
- New `badminton_session_details`: 1:1 child of `workout_sessions`
  (intensity, singles/doubles format, games count, session quality,
  post-session fatigue) — schema only in this pass; no repo/route
  consumes it yet (see "Still open" below).

**Contracts (`src/contracts/types.ts`)** — `CONTRACT_VERSION` bumped
1.2.0 → 1.3.0. New types: `GoalEventType`, `GoalEvent`,
`AestheticAssessment`, `Measurement`, `OutsideBlueprintJustification`,
`OutsideBlueprintExercise`. `Goal` extended with the three new fields
above.

**Repositories**

- `GoalEventsRepo` (new) — `record()` / `listForGoal()`.
- `GoalsRepo` (rewritten) — `create()` now enforces
  `MAX_ACTIVE_AESTHETIC_GOALS` (throws
  `TooManyActiveAestheticGoalsError` before persisting anything if the
  cap is already reached), defaults `review_cadence_days` from
  `REVIEW_CADENCE_DEFAULT_DAYS[goal_type]`, defaults `source` to
  `'structured'`, and records `created`/`activated` goal_events. Added
  `deactivate()`, `reactivate()` (re-checks the cap), `setPriority()`
  (records a `priority_changed` event with `{from, to}`).
- `AestheticAssessmentsRepo` (new) — validates the rating is an integer
  1-5 against `ASSESSMENT_SCALE` before persisting.
- `MeasurementsRepo` (new).
- `OutsideBlueprintExercisesRepo` (new) — `propose()` always persists
  `approved: false`; `approve()` is the only method that can flip it.
- `src/engine/exerciseUniverse.ts` (new, second impure/DB-touching
  engine module alongside `trainingState.ts`) — `resolveExercise()`
  checks Blueprint first, then approved-only outside-Blueprint
  proposals; a proposed-but-unapproved exercise resolves to `null`,
  same as a nonexistent id.
- `WorkoutSessionsRepo` — `addExercisePerformance` now goes through
  `resolveExercise` instead of `BlueprintAdapter.isKnownExercise`
  directly, so an approved outside-Blueprint exercise is now
  loggable. `UnknownBlueprintExerciseError` renamed to
  `UnknownExerciseError` (old name kept as a re-exported alias — no
  call site needed to change).
- `ProgramsRepo.createProgramSession` — previously had **no**
  exercise-id validation at the repo layer at all (only the route did,
  and only against Blueprint). Now validates every exercise via
  `resolveExercise` before any write, throwing `UnknownExerciseError`.

**Routes**

- `src/server/routes/programs.ts` — dropped its now-redundant direct
  `BlueprintAdapter.isKnownExercise` check; catches `UnknownExerciseError`
  from the repo layer and returns 400.
- `src/server/routes/outsideBlueprintExercises.ts` (new), mounted at
  `/api/outside-blueprint-exercises` — `GET /`, `POST /` (propose,
  validates `justification_category` is one of the three allowed
  values and that `justification_text` is non-empty), `GET /:id`,
  `POST /:id/approve`.

## Bug fixed during this pass

`OutsideBlueprintExercisesRepo.get`/`list` originally cast query rows
to `OutsideBlueprintExercise & { approved: number }` — since
`OutsideBlueprintExercise.approved` is `boolean`, that intersection
reduces to `never` and failed to typecheck (`tsc --noEmit` caught it
before any test run). Fixed by casting to
`Omit<OutsideBlueprintExercise, 'approved'> & { approved: number }`
instead.

## Tests

Added `tests/outsideBlueprintExercises.test.ts` (7 tests): a proposal
starts unapproved and unresolvable; `approve()` makes it resolvable
with the right `source`; `approve()` on an unknown id returns
`undefined`; a workout session rejects logging an unapproved outside
exercise and accepts an approved one; `list()` returns proposals
regardless of approval state.

No existing tests needed changes — `tests/goals.test.ts` (goal
creation) and `tests/workoutSessions.test.ts`
(`UnknownBlueprintExerciseError` by name) both still pass unmodified,
confirming the `GoalsRepo.create()` signature change and the error
rename are both backward-compatible in practice, not just in intent.

## Verification (actually run, not assumed)

```
$ npx tsc --noEmit
(no output — clean)

$ npx vitest run
 Test Files  25 passed (25)
      Tests  177 passed (177)
   Duration  3.16s
```

(170 tests passed before this batch's new test file; 177 after adding
`tests/outsideBlueprintExercises.test.ts`'s 7 tests — no regressions,
no skips.)

## Still open from this spec batch

- `badminton_session_details` has a schema but no repository or route
  yet — logging a badminton session's intensity/format/quality/fatigue
  isn't wired up. Tracked as its own follow-up.
- `goal_events`'s `exercise_changed` / `programming_modified` event
  types are defined in schema and contracts but nothing writes them
  yet — that lands naturally once the exercise-selection and
  workout-builder engines (spec §51/§57) exist and actually change a
  goal's programming.
- No UI yet for proposing/approving outside-Blueprint exercises or for
  entering assessments/measurements — tracked separately, and
  explicitly deprioritized by the spec itself ("Do not mark complete
  merely because the UI renders").
