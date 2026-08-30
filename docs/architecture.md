# Architecture

Three apps, three responsibilities:

| App | Owns | Answers |
|---|---|---|
| **workout-blueprint** | Exercise/muscle/goal/equipment knowledge (read-only, static) | "What is known?" |
| **workout-logger** (this app) | Goals, programs, actual training history | "What should this person do, and what did they actually do?" |
| **Calorie Tracker** (`food_and_workout_tracker`) | Food + daily energy log | "What does that activity imply for energy expenditure?" |

workout-logger sits in the middle: it reads Blueprint's knowledge by id,
never copies it, and exposes an export contract Calorie Tracker can read.
No app writes into another's storage.

## 1. workout-blueprint — what we found

Investigated at the commit recorded in `src/blueprint/snapshot/manifest.json`.

**Shape**: a static React/Vite app. Canonical data lives in YAML
(`data/exercises/*.yaml`, one file per muscle group; `data/programming/*.yaml`
for goals/targets/programming rules) and is transformed at build time by
`app/scripts/generate-data.mjs` into two JSON blobs the app bundles. Those
generated files are gitignored in Blueprint's own repo — there is no
committed JSON to fetch, only the YAML source and the transform script.
`npm run sync-blueprint` in this repo replicates that same transform.

**Stable IDs**: every entity has an explicit, author-written `id` field in
its YAML (lowercase kebab-case), never auto-derived from the name, and
guaranteed stable across renames (per Blueprint's own schema docs — an id
must never be reused for a different exercise even after retirement). This
is exactly the guarantee `BlueprintAdapter` relies on:

- Exercise: global `id`, e.g. `incline-dumbbell-press`, `dip-chest-biased`,
  `bulgarian-split-squat-hip-dominant`.
- Physique target: `id` in `physique-targets.yaml`, e.g. `upper-pec`,
  `lat-width`, `gastrocnemius` (24 total).
- Aesthetic outcome: `id` in `aesthetic-outcomes.yaml`, e.g.
  `chest-side-projection`, `back-width-v-taper` (26 total).
- Functional goal: `id` in `functional-goals.yaml`, e.g. `rotator-cuff`,
  `hip-stability` (7 total).
- Equipment: **no id, no catalog** — an open, free-text vocabulary living
  only as `Exercise.equipment: string[]` (`dumbbell`, `barbell`, `bench`,
  ...). `BlueprintAdapter.getEquipmentList()` derives the known set from
  the exercise data itself, same as Blueprint's own app does.

**Relationship fields** on an Exercise record have precise, non-overlapping
meanings: `overlaps_with` (same role, substantially similar — the only one
guaranteed to be a resolvable id list), `alternatives` (same role, fills the
gap when unavailable — currently empty on every record by design),
`complements` (prose describing a different, complementary stimulus — not
reliably ids). `null` vs `[]` is a meaningful distinction throughout
(`null` = not applicable to this record, `[]` = not yet populated) —
`BlueprintAdapter`'s types preserve it rather than normalizing.

**Engines** (`app/src/engine/`) — `decisionEngine`, `programmingEngine`,
`packageEngine`, plus `alternatives`/`complements`/`equipment`/`constraints`
helpers — implement Blueprint's own deterministic exercise-recommendation
and rep-range/volume guidance logic. workout-logger's Phase 1 does **not**
call or reimplement any of it: no decision/recommendation logic exists yet
in this app (see `docs/open-decisions.md`). Understanding their inputs/
outputs matters for Phase 2, when this app's own program-building logic
will need an equivalent — but Phase 1 only consumes raw catalog data
(exercises, targets, goals) through `BlueprintAdapter`.

## 2. Calorie Tracker — existing workout representation

`food_and_workout_tracker`'s `workout_log.csv` (one row per set for gym
sessions, one row per session for badminton, one row for a rest day):

```
date, session_type, workout_name, set_number, equipment, weight, reps,
hours, games, format, tdee_final, comment
```

`tdee_final` is filled only by that repo's own nightly job (workout
duration/intensity nudges a day-type TDEE baseline — see its
`workout-tdee` skill). `log.csv` is a nightly-job-only daily rollup.
Today, Calorie Tracker has **no way to consume actual sets/reps/load** —
its CSV is hand-entered or LLM-parsed free text, not structured performance
data.

## 3. Where workout-logger sits

- **From Blueprint**, workout-logger reads (never writes) exercises,
  physique targets, aesthetic outcomes, functional goals, and derived
  equipment — always by id, through `BlueprintAdapter`
  (`src/blueprint/adapter.ts`), the only module in this app that knows
  Blueprint's raw JSON shape.
- **Its own storage** (`src/db/schema.sql`) holds what Blueprint has no
  opinion on and Calorie Tracker has no room for: `users`/
  `training_profiles` (schedule, session-duration bounds, equipment,
  recurring non-gym activity — read as data by any future programming
  engine, never hard-coded), `goals` (a `blueprint_ref` id + priority),
  `programs`/`program_sessions` (planned training), and
  `workout_sessions`/`workout_exercises`/`workout_sets` (actual training
  history, with `session_type` matching Calorie Tracker's own
  `gym | badminton | other` and kept extensible for the same reason).
- **To Calorie Tracker**, workout-logger exposes
  `getCompletedWorkouts(date)` (`src/services/calorieTrackerExport.ts`):
  date, session_type, duration_minutes, per-exercise sets/reps/load, and
  completion — everything Calorie Tracker's CSV schema is missing today.
  The export is always framed as improving an **estimate** of workout
  expenditure, never as an exact calorie count; `tdee_final` computation
  stays entirely inside Calorie Tracker's own nightly job.

## 4. Responsibility boundary

Restated explicitly (this is the enforceable version of the table at the
top of this document):

```text
PHYSIQUE BLUEPRINT
───────────────────
Canonical exercise/goal knowledge. Read-only from workout-logger's side.

WORKOUT PROGRAMMER (this app)
──────────────────────────────
User training state. Programs. Goals. Workout sessions. Training history.
Programming decisions (once built).

CALORIE TRACKER
────────────────
Nutrition. Energy balance. Estimated expenditure.

WORKOUT PROGRAMMER → CALORIE TRACKER
──────────────────────────────────────
Completed workout/activity data only (getCompletedWorkouts — see
docs/CALORIE_TRACKER_INTEGRATION.md). One direction. Calorie Tracker never
writes back into workout-logger's storage, and workout-logger never reads
Calorie Tracker's storage directly.
```

**Calorie Tracker must never become responsible for**: exercise selection,
volume allocation, program generation, or progression. Those are entirely
this app's job (once the Training Exposure / programming engine work in
`docs/TRAINING_EXPOSURE_MODEL.md` and `docs/open-decisions.md` lands).

**workout-logger must never become responsible for**: food logging,
nutrition targets, or TDEE ownership. `tdee_final` is computed exclusively
by Calorie Tracker's own nightly job from whatever activity data it reads
via the export contract — this app only ever supplies the inputs to a
*better estimate*, never the number itself.

**workout-blueprint must never become responsible for**: anything
user-specific — no per-user state, no training history, no goals-in-
progress. It stays a static, read-only knowledge source; if that ever
needs to change, that's a decision for the Blueprint repo, not something
workout-logger works around by writing into it.

## Data contract

`src/contracts/types.ts` defines the versioned (`CONTRACT_VERSION`)
canonical shapes: `User`, `TrainingProfile`, `Goal`, `Program`,
`ProgramSession`, `WorkoutSession`, `ExercisePerformance`, `Set`,
`TrainingExposure`. Every reference to a Blueprint entity is a plain
`BlueprintId` (`string`) — resolved for display only through
`BlueprintAdapter`, never stored as a name. `TrainingExposure` is defined
but not yet computed or persisted — see `docs/TRAINING_EXPOSURE_MODEL.md`
for the design boundary Phase 2 will implement against. A `Goal`'s own
`id` and its `blueprint_ref` are distinct identifiers with a one-way
resolution path (`GoalsRepo.resolveBlueprint`) — see the `Goal` type's doc
comment. A `Program`'s `blueprint_commit` is captured once at creation and
never overwritten, so a historical program stays explainable even after
Blueprint's data changes under a later commit.

## Why SQLite for Phase 1

Single user, no concurrent writers, no need for a network round-trip in
dev. `better-sqlite3` is synchronous and simple; the schema
(`src/db/schema.sql`) is applied idempotently on startup via
`src/db/client.ts`. See `docs/deployment.md` for the production caveat this
choice implies, and `docs/open-decisions.md` for why the final storage
choice is still open.

## Timezone and date semantics

**Workout dates and times are interpreted in the user's configured local
timezone.** Concretely:

- `TrainingProfile.timezone` (an IANA name, e.g. `"Asia/Kolkata"`) is the
  single source of truth. `src/lib/timezone.ts` and
  `src/lib/userTimezone.ts` are the only places allowed to reason about
  timezones; everywhere else just passes plain strings through.
- `WorkoutSession.date` is a plain `YYYY-MM-DD` string with **no**
  timezone offset attached. `start_time`/`end_time` are plain `HH:MM`
  wall-clock strings in that same configured zone. This app never stores
  or compares a UTC instant for these fields, and never calls
  `Date#toISOString()` to derive "today" — that method is always UTC
  regardless of server or browser locale, which does not match the
  contract. `todayForUser(db)` (server) resolves "today" from the
  configured `TrainingProfile.timezone`, falling back to
  `DEFAULT_TIMEZONE` (`'UTC'`) only when no profile has been created yet.
- **Date filtering for the completed-workout export follows this same
  convention**: `GET /api/export/completed-workouts` without an explicit
  `?date=` defaults to `todayForUser(db)`, not the server process's own
  clock/timezone (which, in a container, is typically UTC and would
  silently disagree with the user's actual day on either side of
  midnight).
- **A workout crossing midnight has deterministic date semantics**: a
  `WorkoutSession` has exactly one `date` field, which is the date of
  record for the *entire* session regardless of what wall-clock
  `end_time` reads. If `end_time`'s clock value is numerically earlier
  than `start_time`'s (e.g. `start_time: "23:30"`, `end_time: "00:15"`),
  that means the session crossed midnight but stays recorded under its
  single `date` (the date the session started) — this app never
  auto-splits a session across two `WorkoutSession` rows and never
  infers a second calendar date from `end_time` alone.
- This is deliberately a thin, explicit contract, not a general timezone
  system — no per-field timezone storage, no DST-transition edge-case
  handling beyond what `Intl.DateTimeFormat` already gets right, no
  timezone conversion between a user's stored data and a different
  display timezone. If multi-timezone use (e.g. travel) becomes a real
  need, that's a deliberate future decision, not something to build
  speculatively now.

## Scope: single-user

```text
Phase 1/2: single-user scope
Authentication: out of scope
Multi-user authorization: out of scope
```

This application has exactly one implicit user (`UsersRepo
.getOrCreateDefault()` — see `src/repositories/usersRepo.ts`). There is no
login, no session/auth token, no per-request user identification, and no
authorization model of any kind. Every repository and route operates
against "the" user, not "a" user. This is a deliberate scope limit, not an
oversight — multi-user support would need real authentication and
per-resource ownership checks added deliberately if a future version
requires it; nothing here should be read as multi-user-ready, and no
multi-user complexity has been added speculatively.
