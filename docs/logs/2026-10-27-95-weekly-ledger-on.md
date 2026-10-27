# Weekly ledger drives the session

Owner 2026-10-27: switch now rather than after a shadow week. Decision log
§22.3. `AI_WEEKLY_LEDGER_MODE=on` (drop-in); rollback = `shadow` + restart.

## What
- `src/ai-programmer/planning/ledgerBrief.ts` (new): the ledger rewrites
  the generation brief (must / can wait / done; minimums; goal caps;
  validator floor 80% for must; one chest region carries the chest ask).
- `sessionPlanner.ts`: must before can-wait; can-wait fills up to 22 sets
  per 60 min; a goal blocked by side credit gets those targets planned
  first.
- `aiProgrammerService.ts`, `weekGeneration.ts`: contexts go through
  `withWeeklyLedger` (no-op unless mode is on; falls back on error).
- `scripts/ledger-dry-run.mjs`: read-only old-vs-new plan for a date, run
  on a copy of a database.

## Checks
New tests `tests/ai-programmer/ledgerBrief.test.ts` (2). Full suite: same
233 pre-existing failures, none new. Dry runs on a copy of production for
Thu 10-29 Push and Fri 10-30 Pull (copy deleted after).
