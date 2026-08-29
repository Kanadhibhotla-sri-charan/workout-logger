# Workout Programmer — Phase 1 / 1.5

Infrastructure and contracts for a standalone workout programming and
logging app: goal/program context, a training profile, a workout logger,
and read-only integration with two sibling apps — **workout-blueprint**
(the fitness knowledge layer) and **Calorie Tracker**
(`food_and_workout_tracker`).

Phase 1/1.5 deliberately does **not** include an AI layer or a
volume/frequency/recovery decision engine. It builds the contracts,
storage, and design boundaries that engine will plug into later. See
`docs/open-decisions.md` for what's still unresolved before Phase 2, and
`docs/TRAINING_EXPOSURE_MODEL.md` for the specific design boundary the
future programming engine needs.

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
npm run sync-blueprint   # pulls the vendored Blueprint data snapshot (see below)
npm run dev               # starts the API + UI on http://localhost:3000
npm test
```

Open `http://localhost:3000/index.html` for goals/programs,
`/today.html` to start a workout, `/logger.html?session=<id>` to log sets,
`/profile.html` for the training profile, `/history.html` for past
sessions.

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
  repositories/  persistence for users/training profiles/goals/programs/
                 workout sessions
  services/      Calorie Tracker export contract
  server/        Express app, routes
public/          minimal static UI
scripts/         sync-blueprint.mts, migrate-workout-log-dry-run.mts
tests/           vitest suite (incl. tests/fixtures/ goal-resolution fixture)
docs/            architecture note, deployment guide, open decisions,
                 training exposure model, Calorie Tracker integration
                 contract, migration plan, per-change logs
```

## Docs

- [`docs/architecture.md`](docs/architecture.md) — Blueprint's data model,
  Calorie Tracker's schema, the three-app responsibility boundary, and how
  this app sits between them.
- [`docs/TRAINING_EXPOSURE_MODEL.md`](docs/TRAINING_EXPOSURE_MODEL.md) —
  design boundary for translating exercise performance into muscle/target
  training exposure; what's directly supported by Blueprint data today vs.
  what needs an explicitly approved new rule.
- [`docs/CALORIE_TRACKER_INTEGRATION.md`](docs/CALORIE_TRACKER_INTEGRATION.md)
  — the formal one-way export contract to Calorie Tracker.
- [`docs/MIGRATION_PLAN.md`](docs/MIGRATION_PLAN.md) — field-by-field plan
  and dry-run tool for a possible future historical-CSV import; no import
  has been performed.
- [`docs/deployment.md`](docs/deployment.md) — local vs. production setup.
- [`docs/open-decisions.md`](docs/open-decisions.md) — what Charan needs to
  decide before Phase 2.
- [`docs/logs/`](docs/logs/) — a dated log file per major change to this
  repo (what changed, why, how it was verified).
