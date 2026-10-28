# Flexibility block on every gym day

Owner 2026-10-28: Blueprint's flexibility plan was synced but never reached
the planner or the model. Decision log §22.4.

## What
- `src/athletic/flexibility.ts` (new): weekly flexibility minutes per
  Blueprint mobility goal and the deterministic block for a gym session.
- `src/blueprint/types.ts`, `adapter.ts`: `BlueprintMobilityTarget`,
  `listMobilityTargets()`.
- `athleticSession.ts`: `drillCatalogue` takes a goal filter (the Athletic
  day keeps its own goals).
- `athleticAddOn.ts`: no 'mobility' add-on next to a hard leg day any more.
- `programmerContextBuilder.ts` / `plannedContext.ts`: the block is in the
  model's context; `aiProgrammerService.ts` rule 10 and planned rule 6a tell
  the model the app adds it.
- `aiProgrammerService.ts`: proposal carries `flexibilityBlock`;
  `aiProposalLifecycle.ts` writes warm-up drills before the session and
  cool-down drills after it at commit.
- `public/program.html`: Flexibility section on a proposal;
  `public/today.html` + `/api/insights/volume`: Flexibility minutes card.
- `scripts/ledger-dry-run.mjs`: prints the week's minutes and the block.

## Checks
4 new tests and 4 updated add-on tests in `tests/athletic/athleticDay.test.ts`
(29 pass). Full suite: same 233 pre-existing failures, none new. Dry run on
a copy of production for Thu 10-29 Push / Fri 10-30 Pull (copy deleted).

## Deployed
2026-10-28 16:48 UTC (22:18 IST). Backup `deployment-backups/pre-4b10ed1-20261028T164747Z.sqlite`. Health ok; AI_PLANNED_GENERATION_ENABLED=true, AI_WEEKLY_LEDGER_MODE=on. `/api/insights/volume` returns the flexibility minutes (lower body hidden while legs are paused). Dry-run checkout on the VM removed.
