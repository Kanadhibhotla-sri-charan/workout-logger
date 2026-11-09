# 105 · Goal muscles get the exercises and sets their week needs

Date: 2026-11-09 · Status: committed, not deployed

## Why
Owner: aesthetics must not be compromised (2026-11-05); goals confirmed as
triceps and brachialis (2026-11-09). Weekly totals from the ledger:

| week of | triceps | brachialis |
|---|---|---|
| 19 Oct | 10/16 | 5/14 |
| 26 Oct | 11/16 | 6/14 |
| 2 Nov  | 17/16 | 8/14 |

Triceps recovered after log 98; brachialis did not. Tomorrow's Pull day
(dry run on a copy of production): the ledger asked 7 brachialis sets, the
plan gave 4.

## Causes
1. Rotation shortlist (exercisePool.ts, 4 per target): for brachialis it
   held the ez-bar curl (no goal credit: goal muscles count direct work
   only), cross-body hammer curl and hammer curl; the cable rope hammer
   curl was left out.
2. Isolations are 2 sets each, so two hammer curls = 4 sets; the ledger
   brief then lowered the ask to what that could hold.

## Changes
- exercisePool.ts: a goal muscle's shortlist places go to its primary
  (direct) exercises first, rested or not. Triceps, with more than 4,
  still rotates.
- ledgerBrief.ts: when a goal's ask cannot be held at the usual sets, its
  primary exercises may take GOAL_EXERCISE_MAX_SETS = 3. A goal its
  exercises already hold keeps 2 per exercise.
- aiProposalLifecycle.ts: the commit re-check builds the context through
  withWeeklyLedger, as generation does, so a 3-set exercise is not
  rejected at commit.

## Result (dry run, production copy, no AI call)
Tue 10 Nov Pull: brachialis 4 -> 6 planned (cross-body, cable rope and
hammer curl). Fri Upper: what is left of the week, up to 3 sets per
hammer curl.

## Tests
tests/ai-programmer/goalCapacityAndTime.test.ts: shortlist, Tuesday stays
at 2 sets, Friday takes 3, triceps unchanged.
