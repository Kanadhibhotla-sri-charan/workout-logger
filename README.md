# Workout Programmer — Phase 1

Infrastructure and contracts for a standalone workout programming and
logging app: goal/program context, a workout logger, and read-only
integration with two sibling apps — **workout-blueprint** (the fitness
knowledge layer) and **Calorie Tracker** (`food_and_workout_tracker`).

Phase 1 deliberately does **not** include an AI layer or a
volume/frequency/recovery decision engine. It builds the contracts and
storage that engine will plug into later. See `docs/open-decisions.md` for
what's still unresolved before Phase 2.

## What this is

- A user records **Goals** (aesthetic or functional, referencing
  workout-blueprint's own outcome/goal catalog by id), organizes them into
  **Programs** and **Program Sessions** (planned workouts), and logs
  **Workout Sessions** (what they actually did — exercises, sets, reps,
  weight, completion, duration).
- Every exercise is referenced by its stable workout-blueprint `id`, never
  by display name, through a single `BlueprintAdapter` (`src/blueprint/`).
  This app never duplicates Blueprint's exercise/muscle/goal/equipment
  taxonomy.
- A read contract (`getCompletedWorkouts(date)`) lets Calorie Tracker pull
  actual logged sets/reps/load/duration to produce a **better estimate**
  of workout expenditure — never an exact calorie figure.

See `docs/architecture.md` for the full picture (Blueprint's data model as
found, Calorie Tracker's existing schema, and how the three apps relate).

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
`/history.html` for past sessions.

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
  repositories/  persistence for goals/programs/workout sessions
  services/      Calorie Tracker export contract
  server/        Express app, routes
public/          minimal static UI
scripts/         sync-blueprint.mts
tests/           vitest suite
docs/            architecture note, deployment guide, open decisions
```

## Docs

- [`docs/architecture.md`](docs/architecture.md) — Blueprint's data model,
  Calorie Tracker's schema, and how this app sits between them.
- [`docs/deployment.md`](docs/deployment.md) — local vs. production setup.
- [`docs/open-decisions.md`](docs/open-decisions.md) — what Charan needs to
  decide before Phase 2.
- [`docs/logs/`](docs/logs/) — a dated log file per major change to this
  repo (what changed, why, how it was verified).
