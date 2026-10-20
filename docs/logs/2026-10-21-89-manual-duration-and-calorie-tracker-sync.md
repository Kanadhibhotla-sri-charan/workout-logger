# Manual workout duration and Calorie Tracker sync

**Commit:** see `git log` for "Manual workout duration" (2026-10-21).
Details: decision log §21 ([link](../AI_GENERATION_REDESIGN_DECISION_LOG.md)); contract:
`docs/CALORIE_TRACKER_INTEGRATION.md` ("Pushed file").

## What changed
- Logger: required "Duration (minutes)" on Finish, never prefilled;
  editable on a completed session; legacy durations flagged; the
  page-load "Elapsed" clock removed; badminton details editable after
  finishing. No automatic timing (it cannot be reliable for forgotten
  Finishes or sessions logged afterwards).
- API: whole minutes 1–360; finishing without a duration -> 400
  `DURATION_REQUIRED`; `workout_sessions.duration_source`
  (`user_entered` | `legacy`); all earlier durations marked `legacy` on
  start-up.
- `src/services/calorieTrackerSync.ts`: writes
  `data/workout_sessions.json` (14 IST dates, completed sessions only:
  type, duration, duration source, badminton intensity/format/games) to
  `food_and_workout_tracker` through the GitHub Contents API; commits
  "Sync workout sessions" only when the content changed; retries on
  409/422. Runs at start-up, after Finish, after a duration or badminton
  edit on a completed session, and every 15 minutes. Off unless
  `CALORIE_SYNC_TOKEN` is set (drop-in
  `ops/systemd/workout-logger-calorie-sync.conf`).

## Verified
`tests/sync/calorieTrackerSync.test.ts` (16); 11 existing route tests
now send a duration when finishing; full suite 2326, no new failures;
headless logger run against a local server (blank Finish refused; 65 ->
user_entered; legacy 2 -> 120 user_entered; badminton edited after
finishing).
