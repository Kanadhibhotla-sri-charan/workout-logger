# Production data review for the Calorie Tracker integration

**No commit** (operations record), 2026-10-20.

Calorie Tracker (`food_and_workout_tracker`) asked how reliable
workout-logger's data is for picking a daily food target. The owner ran a
read-only query (`sqlite3 -readonly`) on the production DB; findings:

- `duration_minutes` was wrong on 10 of 26 gym sessions (1, 8, 9, 10, 26,
  187, 453 min) and on all 7 badminton sessions (1–6 min): the logger
  timed from page load. `start_time`/`end_time` never set.
- Sets: weight/reps nearly always filled; `rir` on every set since
  2026-10-13 (mostly 0 or 3); `rpe`, `rest_seconds`, `technique` never
  filled (no UI input). Logged weights are not comparable between
  exercises (per dumbbell, cable stack numbers, some apparent typos).
- Sessions are uniform: median 8 exercises, ~20 sets, ~64 min real
  duration; no intensity techniques.
- Profile timezone Asia/Calcutta; DB in WAL mode; VM hostname
  `workout-programmer-new-vnic`.
- **The daily backup timer (`ops/systemd/workout-logger-backup.timer`)
  is not installed on the VM**; the only backups are the pre-deploy ones
  in `~/workout-logger/deployment-backups/`. Fixed in log 90.

Outcome: log 89 (manual duration and the sync file).
