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
  opinion on and Calorie Tracker has no room for: `goals` (a
  `blueprint_ref` id + priority), `programs`/`program_sessions` (planned
  training), and `workout_sessions`/`workout_exercises`/`workout_sets`
  (actual training history, with `session_type` matching Calorie
  Tracker's own `gym | badminton | other` and kept extensible for the
  same reason).
- **To Calorie Tracker**, workout-logger exposes
  `getCompletedWorkouts(date)` (`src/services/calorieTrackerExport.ts`):
  date, session_type, duration_minutes, per-exercise sets/reps/load, and
  completion — everything Calorie Tracker's CSV schema is missing today.
  The export is always framed as improving an **estimate** of workout
  expenditure, never as an exact calorie count; `tdee_final` computation
  stays entirely inside Calorie Tracker's own nightly job.

## Data contract

`src/contracts/types.ts` defines the versioned (`CONTRACT_VERSION`)
canonical shapes: `User`, `Goal`, `Program`, `ProgramSession`,
`WorkoutSession`, `ExercisePerformance`, `Set`, `TrainingExposure`. Every
reference to a Blueprint entity is a plain `BlueprintId` (`string`) —
resolved for display only through `BlueprintAdapter`, never stored as a
name. `TrainingExposure` is defined but not yet computed or persisted: it's
a placeholder for Phase 2's effective-set/volume aggregation.

## Why SQLite for Phase 1

Single user, no concurrent writers, no need for a network round-trip in
dev. `better-sqlite3` is synchronous and simple; the schema
(`src/db/schema.sql`) is applied idempotently on startup via
`src/db/client.ts`. See `docs/deployment.md` for the production caveat this
choice implies, and `docs/open-decisions.md` for why the final storage
choice is still open.
