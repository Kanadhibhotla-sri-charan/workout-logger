# 2026-09-15 — Goal Same-Day Conflict Restriction + Session Muscle-Cap Increase

Commit (this entry's own). Full detail in
`docs/GOAL_CATEGORY_CONFLICT_AND_CAP_INCREASE_FIX_REPORT.md`. Follows
directly from log entry 57.

## Why

The Session Realism Cap (entry 57) exposed a real starvation case:
`triceps-long-head`, a genuine top-priority goal muscle, was silently
excluded from its own push session. The initial theory (an alphabetical
tie-break in `compareRankings`) was disproved by direct debug
instrumentation — the real cause is greedy exercise-slot consumption in
`applySessionRealismCap`: higher-ranked muscles can exhaust the
9-exercise budget before a later, still-legitimate top-N muscle is
reached. The user approved two changes to reduce this: raise the
muscle-per-session ceiling (4 -> 7), and forbid two active aesthetic
goals from sharing a push/pull/legs category in the first place, since
that is the same competition-for-one-session problem one level up.

## What changed

- `src/engine/config.ts`: `SESSION_REALISM_CAP.maxTargetsPerSession`
  raised 4 -> 7 (`maxExercisesPerSession` unchanged at 9).
- `src/repositories/goalsRepo.ts`: new `ConflictingGoalCategoryError` +
  `assertNoGoalCategoryConflict()`, checked in `create()`/`reactivate()`
  after the existing max-2-active-goals cap. Classifies each goal's
  targets against the existing `PUSH_PHYSIQUE_TARGETS` /
  `PULL_PHYSIQUE_TARGETS` / `LEGS_PHYSIQUE_TARGETS` lists. Verified
  against real Blueprint data first: exactly one of 26 real aesthetic
  goals (`arm-side-thickness`) spans more than one category — per the
  user's explicit decision, it now blocks (and is blocked by) any other
  active aesthetic goal. Upper day is exempt by design (push+pull union).

## Regression: 23 pre-existing tests, 3 root-cause patterns

The category restriction broke 23 tests that had used two same-category
goals as incidental fixture setup, unrelated to category conflict. Per
explicit instruction, the full failing-test list was reviewed with the
user before any fix was made. Fixed via three patterns: (A) direct
`arm-side-thickness` pairings swapped to `biceps-front-peak` in 4 files;
(B) two tests whose OWN substance didn't depend on category, fixed by
substituting one goal for a non-conflicting one in 2 files; (C)
positional "first N Blueprint goals" indexing (no guaranteed category
spread) replaced with explicit push/pull/legs refs in 3 files. Every
substitution was verified beforehand to touch only boolean existence
assertions, never an exact-value assertion tied to the swapped target.

## Verification

`npm run typecheck` clean. Full suite baseline-diffed against the true
last-commit tree: all 23 previously-broken tests pass again, both new
feature test files (`goalCategoryConflict.test.ts`,
`sessionRealismCap.test.ts`'s new case) pass, and the only other
deviation (3 failures in `tests/ai-programmer/aiProposalRoutes.test.ts`)
was confirmed pre-existing and unrelated by reproducing the identical 3
failures on the fully-reverted tree.

## Known remaining limitation

Raising the cap to 7 gives headroom but does not fully solve the
underlying greedy exercise-slot-consumption issue — a real fix needs
proportional exercise-slot trimming across targets, not all-or-nothing
per-target inclusion. Flagged for future work, not fixed here.

## Not yet started

The non-goal-muscle rotation mechanism (separate, user-specified design)
remains untouched.

## Not yet deployed

Committed per explicit instruction overriding the usual wait-for-approval
step for this batch. Deployment to production was not requested.
