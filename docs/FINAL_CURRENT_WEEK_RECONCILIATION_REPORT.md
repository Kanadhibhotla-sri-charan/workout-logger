# Final Current-Week Reconciliation Fix — Report

Per `docs/FINAL_CURRENT_WEEK_RECONCILIATION_SPEC.md`. This is a surgical
follow-up to `docs/CURRENT_WEEK_RECONCILIATION_REPORT.md`'s own fix: that
prior pass made current-week activity overrides real and separately
stored, but `/week` and `/today` still recomputed the **entire week from
the planner on every read** — deterministic recomputation, not persisted
plan reconciliation. This pass makes the week's actual generated plan a
real, persisted, incrementally-reconciled row set.

```
Files changed:
src/db/schema.sql                              (doc comments only — programs/program_sessions repurposed; 3 new nullable columns added directly to their CREATE TABLE statements)
src/db/client.ts                               (new addColumnIfMissing safe-migration helper, called for the 3 new columns)
src/repositories/weeklyProgramRepo.ts          (new — persisted-week-program storage: get/create/updateAggregates/getSession/upsertSession/deleteSession)
src/engine/weekProgramReconciliation.ts        (new — reconcileWeekProgram + ensureWeekProgramGenerated: the locked-day and unchanged-prescription rules)
src/server/routes/programming.ts               (/week, PUT .../activity, and /today rewired onto the persisted store; new toTodayExerciseShape translation function)
docs/FINAL_CURRENT_WEEK_RECONCILIATION_SPEC.md (this pass's spec, saved to the repo)
docs/FINAL_CURRENT_WEEK_RECONCILIATION_REPORT.md (this report)
tests/routes/weekProgramPersistence.test.ts    (new — 22 tests proving real persisted row identity, spec §22.1-§22.6)

Unchanged (verified, not modified):
public/logger.html                             (Add Unplanned Exercise + Substitute — byte-for-byte identical; `git diff --stat` is empty)
src/engine/workoutBuilder.ts                   (buildWeeklyProgrammingPlan/buildWorkout/assembleWeeklyPlanInput/programmingWeekStart — untouched; still the only planner)
src/repositories/programsRepo.ts               (legacy ProgramsRepo API — untouched; WeeklyProgramRepo is a separate, purpose-built repo over the same tables)
week_activity_overrides table/WeekActivityOverridesRepo (untouched — still the current-week-only override mechanism)

Genuine persisted current-week plan reconciliation (not mere recomputation):
PASS

/today reads the SAME persisted state as /week (never a second reconstruction):
PASS

Plain GET /week never regenerates the whole week:
PASS

PUT .../activity still the only write path, still current-week-only:
PASS

Locked (completed/in-progress) days never touched, regardless of the change:
PASS

Unaffected days keep the exact same program_sessions.id and byte-identical snapshot:
PASS

All 12 activity transitions preserve an unrelated day's persisted identity:
PASS

Repeated GETs create no new rows and no new session identities:
PASS

Add Unplanned Exercise unchanged:
PASS

Substitute unchanged:
PASS

Schema migration is additive/nullable, safe against an existing populated database:
PASS (verified directly — see "Migration safety verification" below)

npm run verify:
PASS (578/578 tests, clean build + typecheck)

Clean-checkout verification (npm ci + npm run verify from a fresh archive of the committed tree):
PASS (578/578 tests, clean build + typecheck)

Real Playwright browser smoke test proving persisted identity survives a UI-driven change + page reload:
PASS

Deployed:
NO (spec explicitly excludes deployment from this task)

Known limitations:
NONE
```

## How persisted current-week reconciliation works

**Storage.** The prior phase confirmed `programs`/`program_sessions` were
schema-only leftovers from an early design, never read by the live
programming path (`TrainingState.current_program` is written but never
consulted downstream). This pass repurposes them as the persisted
current-week-plan store, per the spec's own suggestion not to invent a
duplicate table set. Three nullable columns were added
(`programs.active_goals_json`, `programs.target_allocations_json`,
`program_sessions.snapshot_json`) via `addColumnIfMissing` — additive,
guarded by `PRAGMA table_info`, safe to run against a database that
already has rows in these tables (verified directly, see below). A
`programs` row is keyed by `start_date` = the week's Monday-anchored start
(`programmingWeekStart`); one `program_sessions` row per day that
currently has a real gym/both component, holding the exact enriched
per-day object `/week` returns (`sessionPurpose`, `plannedWork`,
`estimatedMinutes`, etc.) as a `snapshot_json` blob — chosen over trying to
force the nested `plannedWork`/`decision` objects into
`program_session_exercises`'s flat columns, which cannot represent them.

**Two-tier read/write split** (`src/engine/weekProgramReconciliation.ts`):
- `ensureWeekProgramGenerated` is a **pure read** if `weekStart` already
  has a persisted `programs` row — the planner
  (`buildWeeklyProgrammingPlan`) is never called. It only runs the planner
  the very first time a given week is ever requested. Both `GET /week` and
  `GET /today` call this — never anything else — so a plain GET can never
  regenerate the week (spec §18).
- `reconcileWeekProgram` is called only by `PUT
  /week/days/:day/activity`, the sole write path. It always re-runs the
  planner (it has to, to know what the new activity implies), then diffs
  the fresh result against what's persisted and writes only what actually
  changed, by two rules:
  1. **Locked days** — any date with a real `WorkoutSession` row whose
     status is `in_progress` or `completed` — are skipped entirely,
     regardless of what the fresh computation says. This holds even if the
     override targets that exact day: the persisted prescription for an
     already-started/finished day survives untouched.
  2. **Unlocked, unchanged days** are left untouched too. "Unchanged"
     compares only the core prescription (`exercise_id`, `target_id`,
     `target_type`, `sets`, `reps_min`, `reps_max`) — not the
     `reasoning`/`decision` explainability text, which legitimately
     differs on a fresh recompute whenever the week's eligible-gym-day
     count changes, even for a day whose actual prescribed exercises
     didn't change (an established finding from the prior phase). Only a
     day that's unlocked AND genuinely different gets `upsertSession`
     (which preserves the row's `id` if one already existed) or
     `deleteSession` (if it no longer has a gym component) called on it.

**`/today` unification.** `programming.ts`'s `/today` route previously
called `assembleAndBuildWorkout` — a second, independent invocation of the
planner — which is exactly the "today and week can silently disagree"
risk the spec called out. It's been rewritten to call the same
`ensureWeekProgramGenerated` + `buildWeekResponse`/`renderWeekDays` `/week`
uses, then slice out today's day object. This exposed one genuine
pre-existing inconsistency: `/today`'s exercise objects have always used
`target_sets`/`target_reps_min`/`target_reps_max`/`target_rir_min`/
`target_rir_max` field names, while `/week`'s `plannedWork` uses
`sets`/`reps_min`/`reps_max`/`rir_min`/`rir_max` — two independently-built
response shapes for the same data. A `toTodayExerciseShape` translation
function preserves the exact field names `public/logger.html` already
depends on for `/today` while leaving `/week`'s own shape untouched.

## Migration safety verification

Ran a direct check (not part of the automated suite) that simulates a
pre-existing production database: created `programs`/`program_sessions`
tables in their **old** shape (no `active_goals_json`,
`target_allocations_json`, or `snapshot_json` columns), inserted a real
row into each, then opened that file through the actual `openDb()` (which
runs `migrate()`). Result: all three columns were added, both pre-existing
rows survived with all their original column values unchanged, and the
new columns defaulted to `NULL` on the existing rows — confirming the
migration is purely additive and non-destructive against real, populated
data.

## Test commands run

```
npx vitest run tests/routes/weekProgramPersistence.test.ts   # the new §22 tests, in isolation: 22/22 passed
npx tsc --noEmit                                              # clean
npm run verify                                                # build + typecheck + full suite: 578/578 passed
```

Clean-checkout verification (per this session's established practice):
archived the current commit (`git stash create` / `git archive`) plus the
untracked new files into a scratch directory, ran `npm ci` then `npm run
verify` there — **578/578 tests passed, build + typecheck clean, exit code
0** — proving the change works from a fresh install, not just this
session's already-built `node_modules`/`dist`.

## Real browser smoke test

Started the actual built server (`dist/server/index.js`) against a fresh
SQLite file, set up a real profile + goal via the real API, then drove
Chromium (the pre-installed browser) through `public/program.html`:
1. Loaded the page, confirmed all 7 day cards render.
2. Read Monday's persisted `program_sessions` row directly from the
   server's own SQLite file (real row identity: `id` + `snapshot_json`).
3. Opened Friday's day modal and used the real "Change activity (this
   week)" control to switch Friday to Badminton — a real UI-driven PUT,
   not a direct API call.
4. Confirmed Friday now shows Badminton in the UI, and Monday's persisted
   row is **byte-identical** (same `id`, same `snapshot_json`) to what was
   captured in step 2.
5. Did a real full page reload and confirmed Monday's persisted row is
   still unchanged (no accidental regeneration on reload).
6. Confirmed `/today` and `/week` agree on Monday's `sessionPurpose` and
   `estimatedMinutes`.
7. Confirmed no unexpected browser console errors (the browser's own
   automatic `favicon.ico` 404 — present in every phase, unrelated to this
   fix — was the only console entry, and was excluded).

All steps passed.

## Add Unplanned Exercise / Substitute confirmation

`git diff --stat public/logger.html` against this session's base commit is
empty — the file was never touched. Direct inspection confirms
`openSubstitutePicker`, the "Add unplanned exercise" section, and
`createBlueprintExercisePicker` are all present, unchanged, at their prior
locations. The full test suite includes `tests/frontend/exercisePicker.test.ts`
(12 tests, unmodified, all passing), which further confirms the picker's
Blueprint-search/explicit-selection/ID-validation contract is untouched.
`GET /api/programming/substitutes` in `src/server/routes/programming.ts`
was not modified in this pass.

## Deployment

No deployment or infrastructure change was made or attempted, per the
spec's explicit exclusion.
