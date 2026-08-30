# Testing

How to reproduce this repo's automated verification from a clean
checkout, with no hidden local-machine state, no credentials, and no live
external services required.

## Prerequisites

```text
Node >= 20 (engines.node in package.json)
npm  >= 10 (any npm compatible with the committed package-lock.json works)
```

No database server, no global CLI tools, no environment variables are
required for the default test run.

## Install

```bash
npm install
```

Installs from the committed `package.json` + `package-lock.json`. This
also compiles/fetches `better-sqlite3`'s native binding (via
`prebuild-install`, a normal part of `npm install` for this package) —
that step needs the same npm-registry network access `npm install`
already needs for everything else; it does not talk to any
workout-logger-specific service.

## Test

```bash
npm test
```

Runs the full Vitest suite (`vitest run`) once, non-interactively. Every
test creates its own **in-memory SQLite database**
(`openDb(':memory:')`, see `src/db/client.ts`) and applies the committed
schema (`src/db/schema.sql`) fresh — no `.db` file, no database server,
no state carried over between test files or between runs. There is
nothing to reset by hand between runs.

For local iteration: `npm run test:watch` re-runs on file changes.

## Typecheck

```bash
npm run typecheck
```

`tsc --noEmit` against the committed `tsconfig.json`. Covers `src/`,
`scripts/`, and `tests/`.

## Full verification

```bash
npm run verify
```

Runs `typecheck` then `test`, in that order, and exits non-zero if either
fails — the one command to run before considering a change verified.

## Offline behavior

The full `npm test` / `npm run verify` run requires **no live external
service and no credentials**:

- **Blueprint data**: tests read `src/blueprint/adapter.ts`, which loads
  the committed, versioned snapshot at `src/blueprint/snapshot/*.json`
  (`exercises.json`, `programming.json`, `manifest.json`). This snapshot
  is checked into the repo — tests never clone or fetch
  `workout-blueprint` live. (`npm run sync-blueprint`, which *does* need
  network access to regenerate that snapshot, is a separate, manual
  maintenance script — it is never invoked by `npm test`, `npm run
  typecheck`, or `npm run verify`.)
- **Calorie Tracker integration**: `src/services/calorieTrackerExport.ts`
  and its tests (`tests/calorieTrackerExport.test.ts`) exercise the
  export contract entirely against this repo's own in-memory database —
  there is no live Calorie Tracker service to call, mock, or reach.
- **Database**: every test opens `openDb(':memory:')` — see Test, above.
  No shared or pre-existing database file is read.
- **Historical-CSV migration dry-run tool**
  (`scripts/migrate-workout-log-dry-run.mts`) is tested
  (`tests/migrationDryRun.test.ts`) against a small synthetic CSV fixture
  written inline in the test file — it does not read or require the real
  `food_and_workout_tracker` CSV, which this repo does not have access to.

Nothing in the default `npm test` run requires GitHub credentials,
Blueprint production credentials, Calorie Tracker credentials, database
credentials, or cloud credentials of any kind.

## Test fixtures

Every fixture the test suite depends on is committed in the repo — none
require developer-machine state:

- `tests/fixtures/` — the required Training Engine scenarios: basic
  hypertrophy (A), a compound exercise (B), the arm-side-thickness goal
  combined with a 4-gym/2-badminton schedule (C), a time-constrained
  session (D), an equipment-constrained session (E), recent high exposure
  (F), and planned-vs-actual performance (G). Each builds its own data
  inline (via the repositories, against an in-memory database) — none
  read a file that isn't in the repo.
- `src/blueprint/snapshot/*.json` — the versioned Blueprint data every
  Blueprint-dependent test resolves real exercises/targets/goals against.
- `tests/engine/`, plus the top-level `tests/*.test.ts` files — unit and
  integration tests for the repositories, engine modules, and API
  contracts, same self-contained pattern.

## Troubleshooting

- **`better-sqlite3` fails to install / build.** It ships prebuilt
  binaries for common platform/Node combinations via `prebuild-install`;
  on an unsupported platform it falls back to compiling from source,
  which needs a C++ toolchain (`node-gyp`'s usual requirements: Python 3,
  a C compiler). If `npm install` fails specifically on this package,
  that's the first thing to check — it is not specific to this repo's
  own code.
- **A local dev SQLite file (not `:memory:`) throws `NOT NULL constraint
  failed: programs.blueprint_commit` or similar.** `src/db/schema.sql`
  uses `CREATE TABLE IF NOT EXISTS`, which does not retroactively add
  columns to a table that already exists on disk. This only affects a
  persistent `DB_PATH` file created before a schema change (see
  `docs/logs/` for the commit that added `blueprint_commit`) — it never
  affects `npm test`, since every test uses a fresh in-memory database.
  Fix: delete the stale local file and let `src/db/client.ts` recreate it
  from the current schema.
- **`npm audit` reports vulnerabilities.** As of this writing they are
  all in the `vite`/`esbuild`/`vitest` dev-server toolchain (a
  dev-server-only advisory about accepting arbitrary requests), not in
  any production runtime dependency — see `docs/logs/` for the commit
  that first noted this. Re-check `npm audit`'s output before assuming a
  new finding is the same one.
- **`npm run sync-blueprint` fails (network error, git clone failure).**
  This script is not part of `npm test`/`npm run verify` and never runs
  automatically — it's a manual, occasional maintenance step for
  regenerating `src/blueprint/snapshot/`. A failure here has no effect on
  whether the test suite passes.

## README

`README.md` has a short pointer to this file; this file is the source of
truth for testing commands, kept in sync with `package.json`'s actual
`scripts` block rather than duplicated prose.
