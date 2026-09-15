# Goal Same-Day Conflict Restriction + Session-Muscle-Cap Increase — Implementation Report

## Why

After the Session Realism Cap shipped (4 muscles / 9 exercises per session, see
`docs/SESSION_REALISM_CAP_AND_AI_COACHING_FIX_REPORT.md`), the user reported a
real production case: `triceps-long-head` — a genuine top-priority goal
muscle — was being silently excluded from its own push session.

### Root cause, corrected

The first working theory was the alphabetical tie-break in `compareRankings()`
(`"triceps".localeCompare("triceps-long-head")`). Direct debug instrumentation
of `workoutBuilder.ts` against the real generated weeks (temporarily added,
then fully removed) disproved this: all real goal muscles, including
`triceps-long-head`, were correctly ranked inside the top-4 (and later top-7).
The real mechanism is **greedy exercise-slot consumption** in
`applySessionRealismCap`: when the muscles ranked ahead of it each need 2-3
exercises (carryover-inflated volume), they can consume most or all of the
9-exercise budget before the loop ever reaches a later — but still
legitimately top-N — muscle, excluding it entirely rather than trimming it
proportionally. This is a real, distinct, and still-unfixed limitation
(documented below under "Known remaining limitation"), separate from the two
changes this report covers.

### Two user-approved changes

1. **Raise `maxTargetsPerSession` from 4 to 7** (`maxExercisesPerSession`
   stays 9) — more headroom for the exercise-slot-consumption issue without
   fully solving it.
2. **Forbid two active aesthetic goals in the same push/pull/legs category**
   — the user's own reasoning: two goals that both land on the same weekly
   session (e.g. two push goals) permanently compete for that one session's
   share of the muscle/exercise cap, which is the same class of problem as
   the exercise-slot issue, just at the goal-activation level instead of the
   per-session level. Upper day is explicitly exempt (user: "can't keep from
   2 being same on upper day so that is fine") since it is the deliberate
   union of push+pull.

Before implementing, the real Blueprint data (`programming.json`, 26
aesthetic goals) was checked for any goal that itself spans more than one
category — per the user's explicit request ("check first if such a goal
exists"). Exactly one exists: `arm-side-thickness` (primary `brachialis-arm-thickness`
[pull], supporting `triceps` [push]). Per the user's explicit decision, this
goal "should be considered as two in itself" — it occupies both a push and a
pull slot on its own and can never be paired with any other active aesthetic
goal.

## What changed

**1. `src/engine/config.ts`** — `SESSION_REALISM_CAP.maxTargetsPerSession`
raised `4 -> 7` (doc comment updated to explain the pre-deployment finding
that motivated the increase). `maxExercisesPerSession` unchanged at 9.

**2. `src/repositories/goalsRepo.ts`** — new activation-time restriction:
- `ConflictingGoalCategoryError` (new) — thrown by `create()` and
  `reactivate()` alongside the existing `TooManyActiveAestheticGoalsError`
  (max-count check runs first, independently).
- `ppiCategoriesForGoal()` classifies a goal's own primary+supporting targets
  against `PUSH_PHYSIQUE_TARGETS` / `PULL_PHYSIQUE_TARGETS` /
  `LEGS_PHYSIQUE_TARGETS` (all pre-existing in `config.ts`).
- `assertNoGoalCategoryConflict()` rejects activation when the new goal's
  categories overlap any existing active aesthetic goal's categories, or
  when either goal spans more than one category (the `arm-side-thickness`
  case) — a multi-category goal blocks, and is blocked by, anything.
- Functional goals are entirely exempt (no Blueprint push/pull/legs
  classification exists for them).

## Regression: 23 pre-existing tests broken by the category restriction

Implementing the restriction correctly broke 23 tests that had, until now,
freely paired two same-category goals (mostly `chest-front-width` +
`arm-side-thickness`, both push-adjacent) as ordinary fixture setup with no
relation to category conflict at all. Per explicit instruction, the full
list was produced and reviewed with the user (list of failing tests, grouped
by root cause) before any fixture changes were made. All three patterns were
then fixed by substituting a non-conflicting real Blueprint goal id — every
substitution was verified beforehand via grep to confirm no test asserted an
exact numeric value tied to the specific target being swapped (only boolean
`.some(...)` existence checks), so the swap preserves each test's real intent.

**Pattern A — direct `arm-side-thickness` fixture pairing** (4 files):
`tests/engine/surgicalFixWeeklyPlanTests.test.ts`,
`tests/fixtures/realisticWeek.test.ts`,
`tests/fixtures/strictBugFixFullWeek.test.ts`,
`tests/engine/coreEngineSurgicalFixPassTests.test.ts` — swapped
`arm-side-thickness` -> `biceps-front-peak` (real Blueprint
`primary_targets: ['biceps']`, pull-only) and every
`target_id === 'brachialis-arm-thickness'` assertion -> `'biceps'`.

**Pattern B — two same-category goals unrelated to category testing** (2
files): `tests/engine/finalPassRequiredTests.test.ts` Test 1 (originally
relied on both goals landing on the *same* Monday push session to prove a
scarce time budget doesn't eliminate either — now split into two assertions,
one push goal checked on its own Monday session and one pull goal
(`back-width-v-taper` -> `lat-width`) checked on its own Tuesday session,
preserving the actual "time budget never eliminates goal work" regression
intent); `tests/engine/goalReviewAestheticTrendEvidence.test.ts` Test E
(assessment-history isolation between two goals — substituted the second
goal from `triceps-back-depth` [push] to `back-width-v-taper` [pull], no
change to the test's actual substance).

**Pattern C — positional "first N Blueprint goals" indexing** (3 files):
`tests/goals.test.ts`, `tests/engine/finalPassRequiredTests.test.ts` Test 2,
`tests/routes/goalsRoutes.test.ts` — Blueprint's own goal ordering has no
guaranteed push/pull/legs spread, so positional destructuring
(`const [first, second, third] = getAestheticGoals()`) could silently hit a
same-category pair. Replaced with three explicit, verified refs: one push
(`chest-front-width`), one pull (`back-width-v-taper`), one legs
(`glute-roundness`) — preserving each test's actual intent (the max-2-active
cap, not category conflict).

**3. `tests/goalCategoryConflict.test.ts`** (new, 10 tests) and
**`tests/engine/sessionRealismCap.test.ts`** (extended, +1 test) — direct
regression coverage for both changes, verified against real Blueprint data
(including a meta-test re-deriving the push/pull/legs classification
independently of production code and asserting `arm-side-thickness` is the
only multi-category goal among all 26 real aesthetic outcomes).

## Verification

- `npm run typecheck`: clean.
- Full suite, baseline-diffed against the true last-commit tree (237
  failures when this session's uncommitted work is fully reverted): the
  current tree has 230 failures — 7 fewer, all 7 accounted for by the two
  new feature test files becoming impossible to fail once the source
  changes are in place (they still exist as untracked files under `git
  stash`, which does not stash untracked files, so they briefly "fail
  against reverted source" during the A/B comparison — not a real
  discrepancy).
- All 23 previously-broken tests (Patterns A/B/C) confirmed passing again.
- 3 failures appear in `tests/ai-programmer/aiProposalRoutes.test.ts` that
  are not byte-identical to the recorded 229-failure baseline snapshot;
  confirmed pre-existing and unrelated by reproducing the exact same 3
  failures on the fully-reverted last-commit tree (that file already has
  47 pre-existing failures in the recorded baseline, unrelated to goals or
  categories — it never creates more than one aesthetic goal at a time).
  Zero regressions attributable to this change.

## Known remaining limitation (not fixed by this change, flagged for future work)

Raising the muscle cap to 7 gives more headroom but does not fully solve the
underlying greedy exercise-slot-consumption issue in `applySessionRealismCap`
— the dedicated regression test for the raised ceiling empirically needed a
carefully tuned fixture (`current_weekly_primary_sets: 3`) specifically
because higher volumes let 2-3 exercises-per-target exhaust the 9-exercise
budget before the 7-muscle budget binds, regardless of the muscle ceiling's
own value. A real fix would need proportional exercise-slot trimming across
targets rather than all-or-nothing per-target inclusion.

## Not yet started (separate, deferred task)

The non-goal-muscle rotation mechanism (the user's own detailed design:
goal muscles keep priority-based selection; non-goal muscles rotate through
eligible candidates in a fixed sequence, persisted across sessions/weeks) is
unrelated to this change and has not been started.

## Deployment

Committed to the repo per explicit instruction, overriding the usual
wait-for-approval step for this batch. **Not deployed** — the instruction
was scoped to "commit to the repo," not to deploy to production.
