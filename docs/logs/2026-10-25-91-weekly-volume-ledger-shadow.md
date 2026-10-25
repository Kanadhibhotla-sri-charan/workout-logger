# Weekly volume ledger, shadow mode

Commits `0df109d`, `9cdf72d` (main), 2026-10-25. Decision log section 22.

## Why
Real data 10-04..10-25: every Push/Pull day planned every muscle up to the
10-exercise cap; abs got leftovers (rectus abdominis never planned); goal
muscles got about a third of their weekly reference.

## What
- `src/ai-programmer/planning/weeklyLedger.ts`: per-muscle tally. Goal
  muscles: Complete number per calendar week, on every suitable day.
  Non-goal muscles: Efficient number per 14-day cycle that restarts when
  reached; overdue cycles keep counting and come first. Statuses must /
  can_wait / overdue / met / not_today.
- Own per-muscle numbers (`ledgerReference`): the engine's
  getDevelopmentReference credits whole shoulders/back/forearms/core
  packages to each member; the ledger counts only the exercises that train
  the muscle.
- Shadow only: `AI_WEEKLY_LEDGER_MODE=shadow` logs
  `[ai-programmer] weekly ledger shadow` next to each session plan.
  Generation unchanged.
- Fixed type errors in `tests/sync/calorieTrackerSync.test.ts`.

## Deployed
2026-10-25 17:43 UTC, backup
`deployment-backups/pre-0df109d-20261025T174258Z.sqlite` (integrity ok).
Drop-in `/etc/systemd/system/workout-logger.service.d/weekly-ledger.conf`
(`AI_WEEKLY_LEDGER_MODE=shadow`, `AI_WEEKLY_LEDGER_ANCHOR=2026-10-19`);
verified in the running process. `9cdf72d` deployed after (code only).
Rollback: delete the drop-in, daemon-reload, restart.

## Tests
`tests/ai-programmer/weeklyLedger.test.ts` (12). Full suite: no new
failures (same failing set with and without the change).
