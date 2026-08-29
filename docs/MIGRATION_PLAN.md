# Historical data migration plan

Plan for a possible future import of Calorie Tracker's (`food_and_
workout_tracker`) historical `workout_log.csv` into workout-logger's
schema. **No import has been performed.** This session has no access to
the `food_and_workout_tracker` repository or its real CSV data — the
schema below is taken from the description Charan provided, not from an
inspected file. Everything here is a plan and a *dry-run tool*, per the
remediation spec's explicit sequencing:

1. Finalize the new workout schema. ✅ done (Phase 1 + Phase 1.5).
2. Map every old field to the new schema. ✅ below.
3. Identify fields with no equivalent. ✅ below.
4. Identify ambiguous exercise names. ✅ approach below, tool built.
5. Map exercises to canonical Blueprint IDs. ⏳ requires human review —
   the tool only proposes candidates.
6. Produce a migration report. ✅ `scripts/migrate-workout-log-dry-run.mts`.
7. Only then import. ❌ **not built** — deliberately out of scope until 1-6
   are complete against the real file and Charan has approved a reviewed
   exercise-name mapping. See `docs/open-decisions.md` #3.

## Source schema (as described, not yet inspected directly)

```text
workout_log.csv: date, session_type, workout_name, set_number, equipment,
                  weight, reps, hours, games, format, tdee_final, comment
```

One row per set (gym), one row per session (badminton), one row for a
rest day (`workout_name = "rest day"`, `session_type = rest`, rest of row
blank). Note from the old app's own `DEPLOY.md` (read before this repo was
wiped): weight/reps were stored as `TEXT`, not numeric, specifically to
allow free-form AI-parsed input like ranges ("8-10") — real data may
contain values the dry-run tool correctly flags as unparseable rather than
silently coercing.

## Field mapping

| CSV column | New schema field | Notes |
|---|---|---|
| `date` | `workout_sessions.date` | Direct. |
| `session_type` | `workout_sessions.session_type` | Direct — `gym`/`badminton`/`rest`/`other` already align with `SessionType`'s open string type. |
| `workout_name` | `workout_exercises.exercise_id` (via mapping) | **Not direct.** Free text must be matched to a Blueprint exercise id — see Ambiguous exercise names, below. For `rest day` rows, no exercise row is created at all. For badminton rows, `workout_name` is typically the literal string `"badminton"` — no Blueprint equivalent, not migrated as an exercise; kept as context in `workout_sessions.notes` if imported. |
| `set_number` | `workout_sets.set_number` | Direct, gym rows only. |
| `equipment` | *(not migrated as structured data)* | `Exercise.equipment` in the new schema is derived from the matched `exercise_id`, not copied from this free-text column. May be used by a human reviewer as a disambiguating signal when confirming an exercise-name match (e.g. "bench press" + `equipment=dumbbell` favors `incline-dumbbell-press` over a barbell variant). |
| `weight` | `workout_sets.weight` | Needs numeric coercion; the old TEXT column allowed ranges/free text (see above) — the dry-run tool flags unparseable values (`unparseable_weight_rows`) rather than guessing. |
| `reps` | `workout_sets.reps` | Same caveat as `weight`. |
| `hours` | `workout_sessions.duration_minutes` (× 60) | Badminton rows only; not applicable to gym rows (which don't record `hours`). |
| `games` | *(no equivalent — see below)* | |
| `format` | *(no equivalent — see below)* | |
| `tdee_final` | *(never migrated)* | Calorie Tracker's own nightly-job output. Entirely out of scope for workout-logger's schema — see `docs/CALORIE_TRACKER_INTEGRATION.md`'s responsibility boundary. Migrating this would violate the one-way contract. |
| `comment` | `workout_sessions.notes` | Direct, free text. |

## Fields with no schema equivalent

- **`games`** and **`format`** — badminton-specific stats (e.g. games won,
  singles/doubles) with no current field in `WorkoutSession` or any child
  table. Recommendation if importing: preserve as free text appended to
  `workout_sessions.notes` rather than silently dropping them, but this is
  a decision for whoever approves the actual import, not made here.
- **`equipment`** (as structured per-row data) — see mapping table above;
  not dropped entirely, just not persisted as its own column since the new
  schema derives equipment from the exercise id.

## Ambiguous exercise names

`workout_name` is uncontrolled free text (the old app had its own fuzzy
matcher, `src/services/exercise_matcher.py`, deleted when this repo was
wiped — its output was never checked against Blueprint's taxonomy, which
didn't exist as a shared reference at the time, so it can't be trusted as
a source of truth here). The approach:

1. For every **unique** `workout_name` in the CSV, compute a small set of
   candidate Blueprint exercise ids by simple token-overlap similarity
   against each exercise's `name` (`scripts/migrate-workout-log-dry-run.mts`
   — deliberately a plain heuristic, not a "smart" matcher, so its
   confidence is easy to reason about).
2. The dry-run report lists every unique name, how many rows use it, and
   its top candidates with a similarity score — **never an auto-decided
   mapping**.
3. A human (Charan) reviews the report and produces a confirmed mapping
   (`workout_name -> exercise_id`, or explicitly "no match / drop this
   name"). This mapping file does not exist yet.
4. Only after step 3 would an actual import tool (not built) consume that
   confirmed mapping — it would never re-run the fuzzy match live.

## The dry-run tool

`scripts/migrate-workout-log-dry-run.mts`:

```bash
npx tsx scripts/migrate-workout-log-dry-run.mts <path-to-workout_log.csv> [--out report.json]
```

- Reads the CSV, never writes to workout-logger's database, never imports
  anything.
- Reports: total rows, row counts per `session_type`, every unique
  `workout_name` with occurrence count and candidate Blueprint exercise
  matches, counts of unparseable `weight`/`reps` values, and the list of
  columns with no schema equivalent.
- Verified in this change against a small synthetic sample CSV
  (`tests/migrationDryRun.test.ts`, 6 tests) — proves the tool functions
  correctly, but **has not been run against the real `workout_log.csv`**,
  since this session has no access to `food_and_workout_tracker`. Running
  it against the real file, and reviewing its output, is the next step
  before any import decision is made — not something to do unattended.

## What's explicitly not happening yet

No destructive migration. No write path into `workout_sessions` /
`workout_exercises` / `workout_sets` from CSV data exists in this
codebase. The actual import tool (step 7) should only be built once
Charan has reviewed a real dry-run report and confirmed an exercise-name
mapping — see `docs/open-decisions.md` #3.
