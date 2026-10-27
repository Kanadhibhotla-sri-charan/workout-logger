# Blueprint schema 2: weekly numbers from Blueprint, 1-week cycle

Owner decisions 2026-10-27: every muscle counts per calendar week (the
14-day cycle is dropped); Blueprint's minimum rest between sessions is not
applied; goal muscles may go past Blueprint's per-session maximum.
Decision log §22.2.

## What
- `scripts/sync-blueprint.mts` copies the schema 2 data the logger had
  been dropping: schemaVersion, volumeGroups, volumeTargets,
  mobilityTargets, exerciseFamilies (mirrors Blueprint's own generator).
  Snapshot re-synced to Blueprint d5371ef (182 exercises, schema 2).
- `src/blueprint/volumeTargets.ts` (new): Blueprint's weekly numbers,
  sub-region children (min_share), target_credit per exercise (variant
  ids share their record's credit), volume levels per goal outcome.
- `weeklyLedger.ts` rewritten (weekly-ledger.v2): goals at "priority",
  the rest at "efficient", per calendar week; credited sets (completed
  sets x target_credit); chest and calves as groups, upper/mid pec and the
  triceps long head as min_share entries; core anti-extension added;
  Blueprint indirect_only muscles get status "indirect" (counted, not
  scheduled) unless they are goals. Removed: the 14-day cycle, the anchor
  date, and the logger-derived numbers (ledgerReference).
- `GET /api/insights/volume` and the Today card: every muscle "this week";
  share and indirect rows labelled.
- `AI_WEEKLY_LEDGER_ANCHOR` removed from the drop-in (now unused).
- Athletic day: only drills carrying an athletic goal (Blueprint's new
  upper-body / full-body mobility drills are for the warm-up work in a
  later step); `soft-tissue` mode accepted.
- Mapping-completeness test skips drills (their secondary_targets credit
  nothing).

## Numbers that change (goals)
triceps 24 -> 16 / week, brachialis 8 -> 14 / week, long head now at
least 33% of triceps. Indirect work counts at Blueprint's credit (0.25 /
0.5) instead of a flat 0.33.

## Checks
Ledger tests rewritten (13). Full suite: same 233 pre-existing failures as
before the sync (date-dependent), none new.

## Not changed
Session generation and the live planner (still shadow). Steps 2-4 to
follow: weekly plan drives sessions; minutes instead of exercise count;
variants, deload, warm-up mobility.
