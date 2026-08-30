# Workout Programmer

A standalone workout programming and logging app with a deterministic
Training Engine: goal/program context, a training profile, a workout
logger, exposure tracking, a full daily workout-generation pipeline, and
read-only integration with two sibling apps — **workout-blueprint** (the
fitness knowledge layer) and **Calorie Tracker**
(`food_and_workout_tracker`).

This app deliberately does **not** include an AI/LLM layer anywhere in
core programming — every decision is deterministic and reproducible from
stored inputs, grounded in exact numbers from the governing
specification or real Blueprint data (`globalPrinciples`,
`developmentPackages`), never invented. `src/engine/workoutBuilder.ts`'s
`assembleAndBuildWorkout(db, date, budgetMinutes)` is the real, wired
entry point that composes goal resolution, exposure, volume, frequency,
recovery, exercise selection, resource allocation, and time-fitting into
an actual generated workout. See `docs/TRAINING_ENGINE_DESIGN.md` for
the pipeline and module-by-module history, and `docs/open-decisions.md`
for what (narrowly) remains open — none of it blocks the pipeline above
from running today.

## What this is

- A user records **Goals** (aesthetic or functional, referencing
  workout-blueprint's own outcome/goal catalog by id — a Goal's own `id`
  and its `blueprint_ref` are distinct, never conflated, see
  `src/contracts/types.ts`), organizes them into **Programs** and
  **Program Sessions** (planned workouts, each recording the Blueprint
  snapshot commit that informed it), and logs **Workout Sessions** (what
  they actually did — exercises, sets, reps, weight, completion,
  duration).
- A **Training Profile** (`src/repositories/trainingProfileRepo.ts`,
  `/profile.html`) holds user-specific constraints — training days,
  preferred split, session-duration bounds, available equipment, and a
  recurring activity schedule (gym/badminton/rest/other) — as data a
  future programming engine reads, never as hard-coded assumptions.
- Every exercise is referenced by its stable workout-blueprint `id`, never
  by display name, through a single `BlueprintAdapter` (`src/blueprint/`).
  This app never duplicates Blueprint's exercise/muscle/goal/equipment
  taxonomy.
- A read contract (`getCompletedWorkouts(date)`) lets Calorie Tracker pull
  actual logged sets/reps/load/duration for **completed sessions only**,
  to produce a **better estimate** of workout expenditure — never an exact
  calorie figure. See `docs/CALORIE_TRACKER_INTEGRATION.md`.
- A deterministic **Training Engine foundation** (`src/engine/`) resolves
  goals to Blueprint targets, tracks how much training a target has
  actually received (`exposure_units` — deliberately not "effective
  sets"), and checks equipment/time constraints as hard facts — all pure,
  testable functions with zero AI/LLM involvement. See
  `docs/TRAINING_ENGINE_DESIGN.md`.

See `docs/architecture.md` for the full picture (Blueprint's data model as
found, Calorie Tracker's existing schema, the responsibility boundary
between all three apps, and how this app sits between them).

## Stack

- Node.js (>=20) + TypeScript, Express, better-sqlite3.
- No frontend framework — a handful of static HTML pages with vanilla JS
  calling a small REST API (`public/`). No analytics dashboard.
- Vitest for tests.

## Local development

```bash
npm install
npm run dev               # starts the API + UI on http://localhost:3000
```

Open `http://localhost:3000/index.html` for goals/programs,
`/today.html` to start a workout, `/logger.html?session=<id>` to log sets,
`/profile.html` for the training profile, `/history.html` for past
sessions.

`npm run sync-blueprint` (see below) regenerates the vendored Blueprint
data snapshot from a live `workout-blueprint` checkout — it's a manual
maintenance step, not part of normal local dev; the snapshot it produces
is already committed to this repo.

## Testing

```bash
npm test        # run the test suite once
npm run typecheck
npm run verify   # typecheck + test, exits non-zero on any failure
```

Every test runs against a fresh in-memory SQLite database and the
committed Blueprint snapshot — no live services, no credentials, no
database file to prepare by hand. See [`TESTING.md`](TESTING.md) for the
full reproduction steps, offline-behavior guarantees, and
troubleshooting.

### Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DB_PATH` | no | `./data/workout-logger.sqlite` | SQLite file path. Use `:memory:` for ephemeral/test runs. |
| `PORT` | no | `3000` | HTTP port for the Express server. |
| `BLUEPRINT_REPO_PATH` | no | — | Only used by `npm run sync-blueprint`. Point it at a local `workout-blueprint` checkout to regenerate the data snapshot without cloning; omit it and the script clones a shallow copy itself. |

No API keys or secrets are required for Phase 1 — there is no AI/LLM
integration and no external service calls at runtime. See
`docs/deployment.md` for what changes in production.

## Syncing Blueprint data

workout-blueprint doesn't commit its generated JSON (it's a Vite build
artifact). `npm run sync-blueprint` reads the same canonical YAML
(`data/exercises/*.yaml`, `data/programming/*.yaml`) that
workout-blueprint's own generator reads, reshapes it identically, and
writes a versioned snapshot to `src/blueprint/snapshot/` (committed to this
repo, with `manifest.json` recording the source commit). Re-run it whenever
Blueprint's data changes; `BlueprintAdapter` never talks to Blueprint at
request time.

## Repository layout

```
src/
  blueprint/     BlueprintAdapter + types + vendored data snapshot
  contracts/     canonical, versioned data contract (Goal, Program, ...)
  db/            SQLite schema + client
  engine/        Training Engine: goal resolution, training state,
                 exposure tracking, constraints, and 6 stubbed modules
                 pending approved design decisions (see docs below)
  lib/           timezone contract helpers
  repositories/  persistence for users/training profiles/goals/programs/
                 workout sessions
  services/      Calorie Tracker export contract
  server/        Express app, routes
public/          minimal static UI
scripts/         sync-blueprint.mts, migrate-workout-log-dry-run.mts
tests/           vitest suite (incl. tests/engine/, tests/fixtures/)
docs/            architecture note, deployment guide, open decisions,
                 training exposure model, training engine design,
                 Calorie Tracker integration contract, migration plan,
                 per-change logs
```

## Docs

- [`docs/architecture.md`](docs/architecture.md) — Blueprint's data model,
  Calorie Tracker's schema, the three-app responsibility boundary, the
  timezone contract, single-user scope, and how this app sits between the
  three apps.
- [`docs/TRAINING_EXPOSURE_MODEL.md`](docs/TRAINING_EXPOSURE_MODEL.md) —
  design boundary for translating exercise performance into muscle/target
  training exposure (`exposure_units`); separates Training Exposure,
  Hypertrophy Volume, and Functional Exposure as distinct concepts. The
  primary/secondary (1.00/0.33) compound-exposure split it originally
  proposed as "Strategy A" is now implemented exactly per spec §7 — see
  `docs/open-decisions.md` #6.
- [`docs/TRAINING_ENGINE_DESIGN.md`](docs/TRAINING_ENGINE_DESIGN.md) — the
  full Training Engine pipeline and module boundary, goal resolution and
  priority, training state, constraints. Originally written for Phase 2
  (when six modules were deliberately blocked pending approval); see its
  status banner and `docs/open-decisions.md` for what's since been
  resolved — all thirteen engine modules are real today.
- [`docs/VOLUME_ENGINE.md`](docs/VOLUME_ENGINE.md),
  [`docs/GOAL_MATCHING.md`](docs/GOAL_MATCHING.md),
  [`docs/SECONDARY_TARGET_MAPPING.md`](docs/SECONDARY_TARGET_MAPPING.md)
  — focused design notes for the volume-decision model, natural-language
  goal matching, and the compound-exercise secondary-target mapping,
  respectively.
- [`docs/CALORIE_TRACKER_INTEGRATION.md`](docs/CALORIE_TRACKER_INTEGRATION.md)
  — the formal one-way export contract to Calorie Tracker.
- [`docs/MIGRATION_PLAN.md`](docs/MIGRATION_PLAN.md) — field-by-field plan
  and dry-run tool for a possible future historical-CSV import; no import
  has been performed.
- [`docs/deployment.md`](docs/deployment.md) — local vs. production setup.
- [`TESTING.md`](TESTING.md) — how to reproduce the test suite from a
  clean checkout: prerequisites, commands, offline-behavior guarantees,
  troubleshooting.
- [`docs/open-decisions.md`](docs/open-decisions.md) — every open design
  decision Charan needs to weigh in on, organized by area, with status
  (open / proposed / adopted-pending-sign-off).
- [`docs/logs/`](docs/logs/) — a dated log file per major change to this
  repo (what changed, why, how it was verified).
