# Change log: Add architecture note, deployment guide, and Phase 2 open decisions

- **Date:** 2026-08-29
- **Commit:** `63b6645fcc1ff938fac87923ccacbed11aeb51e2`

## What changed

- **`README.md`** — project overview, stack, local dev quickstart, env var
  table, repo layout, links to the docs below.
- **`docs/architecture.md`** — documents workout-blueprint's data model as
  investigated (YAML source layout, stable-id conventions per entity type,
  the `null` vs `[]` semantic distinction, relationship-field meanings,
  what the `decisionEngine`/`programmingEngine`/`packageEngine` do and why
  Phase 1 doesn't call them), Calorie Tracker's existing
  `workout_log.csv` schema, and how workout-logger's contract and storage
  sit between the two. Also records the SQLite rationale for Phase 1.
- **`docs/deployment.md`** — local dev commands, the full env var table
  (`DB_PATH`, `PORT`, `BLUEPRINT_REPO_PATH`) with local-vs-production
  values, and an explicit flag: the old app's own `DEPLOY.md` (read before
  it was deleted) shows it was deployed to Render's free tier, whose
  filesystem is ephemeral and resets on redeploy — the same risk applies
  to this app's SQLite file unless `DB_PATH` is backed by a persistent
  volume in production.
- **`docs/open-decisions.md`** — the 9 decisions Charan needs to make
  before Phase 2 (final storage choice, Blueprint integration method,
  historical CSV migration, Calorie Tracker history import, goal/program
  hierarchy, effective-set methodology, volume-range interpretation,
  recovery/fatigue methodology, progression methodology), each with the
  Phase 1 default already in place and why it isn't final.
- Also removed two `@ts-expect-error` directives in
  `tests/blueprintAdapter.test.ts` that `tsc --noEmit` flagged as unused
  (the mutation attempts they guarded fail at runtime via `Object.freeze`,
  not at the type level, so the directive was never suppressing a real
  compile error).

## Why

Required Phase 1 deliverable: a short architecture note plus deployment
instructions and an explicit list of decisions reserved for Charan, not
decided unilaterally.

## Verification

- `npx tsc --noEmit` — clean (after removing the two unused directives).
- `npx vitest run` — 17/17 passing.
- Full end-to-end smoke test via `curl` against a real (file-backed, not
  in-memory) SQLite DB: created an aesthetic goal referencing a real
  Blueprint id, started a workout session with that goal's context, logged
  one exercise with one completed set, marked the session completed with a
  duration, and confirmed `GET /api/export/completed-workouts` returned the
  logged set data with the "estimate" expenditure note attached.
