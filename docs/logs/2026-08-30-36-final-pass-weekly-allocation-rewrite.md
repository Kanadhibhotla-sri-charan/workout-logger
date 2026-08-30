# 2026-08-30 — Final Programming-Engine Pass: weekly allocation rewrite

## What changed

The Final Programming-Engine Pass specification's core methodology
requirements — replacing spreadDays as the primary day-assignment
mechanism with real contextual weekly allocation, PPL+Upper session
purposes, removing all `1000 + index`-style artificial priority, and
exposure-aware (not `primary_sets === 0`) classification — are now
implemented in the real production path.

### §24: `supporting_targets` crash fixed

`BlueprintAestheticOutcome.supporting_targets` is now `string[]
| undefined` in `src/blueprint/types.ts` (matching the real snapshot
data — 22 of ~46 aesthetic outcomes genuinely lack the field), and
`goalResolver.buildPriorityMap` defaults to `[]` instead of crashing.
New regression test in `tests/engine/goalResolver.test.ts` loads
`chest-upper-shelf` (a real outcome confirmed to lack the field) and
asserts no crash. Two existing tests in
`tests/fixtures/armSideThickness.test.ts` updated for the new optional
type (their own fixture outcome does have real supporting_targets, so
behavior is unchanged — just a `?? []` for type-safety).

### §5/§9/§10: PPL+Upper session purposes — new `src/engine/sessionPurpose.ts`

New config data in `src/engine/config.ts` (`SessionPurpose`,
`SESSION_PURPOSE_ROTATION`, `PUSH_PHYSIQUE_TARGETS`,
`PULL_PHYSIQUE_TARGETS`, `LEGS_PHYSIQUE_TARGETS`,
`UPPER_PHYSIQUE_TARGETS` = union of push+pull, `UNIVERSAL_PHYSIQUE_TARGETS`
for abs/neck) operationalizes this user's real PPL+Upper split into
Blueprint's own target-id vocabulary — at target granularity (not the
coarser `parent_region` the Monday rule uses), since "arms" alone can't
distinguish push-muscle triceps from pull-muscle biceps.

`assignSessionPurposes()` rotates push/pull/legs/upper across the
week's real ordered gym days — the standard, well-known 4-day PPL+Upper
sequence, not an invented methodology, and not a target-priority
mechanism (spec §7's prohibition concerns which muscle gets resources
first, never which day-label a session receives). Two deterministic
swap passes keep 'legs' off Monday (hard, spec §5's absolute rule) and
off a recurring badminton day when a feasible alternative exists (soft
— remediation §9's "day-moving" badminton effect, now expressed as a
purpose swap instead of a per-target day swap).

`isTargetCompatibleWithPurpose()` is the real eligibility check every
physique_target now goes through; a functional_goal is always
compatible (the PPL+Upper split only concerns gym sessions).

### §6/§7/§12/§14: classification is now exposure-aware

`workoutBuilder.rankTarget()` classifies using
`weekly_exposure_units` (primary 1.00 + secondary 0.33 — the same
number every other engine module already uses) against Blueprint's own
`starting_point_sets[0]` threshold, replacing the forbidden
`current_weekly_primary_sets === 0` check. A muscle that's already
received substantial *compound* exposure this week (e.g. triceps from
heavy bench pressing) is now correctly classified 'maintenance', not
'normal_development' — directly implementing §12's "before adding
direct work, inspect compound exposure already allocated" without a
second, separate reconciliation mechanism.

### §7: `1000 + index` removed

`workoutBuilder.compareRankings()` replaces the old flat
`(goal_priority, target_id)` sort with a real multi-criteria comparator:
tier (Goal 1 → Goal 2 → normal_development → maintenance), then within
normal_development the actual exposure deficit (bigger deficit sorts
first — more urgently under-trained), within maintenance the actual
days-since-last-trained (longer sorts first — more due), and only once
those are genuinely tied does `target_id` break the tie. Every
non-specialization target's `goal_priority` field is now a single flat
constant (`NON_SPECIALIZATION_PRIORITY = 1000`, only used for
resourceAllocation's goal-BUCKET priority, never for within-bucket
ordering) instead of `1000 + index`.

### §8: `allocateFrequency`/spreadDays no longer the primary mechanism

`workoutBuilder.ts` no longer imports or calls `allocateFrequency`.
Day-eligibility for every target (goal-linked or not) now comes from
real session-purpose compatibility: `eligibleDaysThisWeek` = the week's
remaining real gym days (today onward) whose PPL+Upper purpose this
target is actually compatible with, capped at Blueprint's own
`typical_starting_range_per_week` upper bound. `setsToday =
ceil(desiredWeekly / sessionsRemainingThisWeek)` — the volume decision
itself is unchanged (§13: "retain the existing methodology"), but the
session count it's divided across is now a real, contextual,
PPL+Upper-aware number instead of `allocateFrequency`'s Blueprint-range-
clamped-to-total-available-days count. `frequencyEngine.ts` itself is
untouched and its own tests still pass — it's simply no longer called
from the real generation path.

### §16/§22: explainability — `weekly_allocation` + `session_purpose`

`DecisionExplanation.frequency` (the old `FrequencyAllocation` object)
is replaced with `weekly_allocation: WeeklyAllocationDecision | null`
(`session_purpose_today`, `eligible_days_this_week`,
`sessions_remaining_this_week`, `reasoning`) and a new top-level
`session_purpose: SessionPurpose | null` field — both populated from
real values computed in the same iteration, never fabricated.

## A design correction made mid-implementation

An initial version of this change also subtracted
`current_weekly_primary_sets` from `desiredWeekly` to compute a
"remaining need" for today's session — intended as a second, more
literal implementation of §12. This was wrong: `volumeEngine.decideVolume`'s
existing 'maintain' action already returns
`recommended_weekly_primary_sets === current_weekly_primary_sets`
exactly (by design, retained per §13), so subtracting a second time
made the "remaining need" always zero for every steady-state
(maintenance) target — silently skipping all of them, every day. §12's
real implementation is the classification fix above (compound exposure
already counted through `weekly_exposure_units`, upstream of this
decision); double-applying it here would have double-counted against
`decideVolume`'s own contract. Caught by the existing test suite
(9 real failures) before this reached a commit — see the "Verification"
section below for the full before/after story.

## Tests

- New `tests/engine/sessionPurpose.test.ts` (12 tests): purpose
  compatibility per target category, rotation, the Monday-hard and
  badminton-soft swap passes, determinism, and graceful handling of
  fewer/zero gym days.
- New `tests/engine/goalResolver.test.ts` §24 regression test.
- `tests/fixtures/armSideThickness.test.ts`: 2 call sites updated for
  the now-optional `supporting_targets` type.
- `tests/engine/workoutBuilder.test.ts` /
  `tests/engine/assembleAndBuildWorkout.test.ts`: existing tests that
  asserted specific set counts or day assignments under the old
  spreadDays mechanism were updated to the new real numbers this
  mechanism produces (session counts now reflect genuine PPL+Upper
  eligibility, which differs from the old Blueprint-range-only count);
  a handful of quads (legs-only) fixtures needed their gym-day lists
  adjusted so a legs-purpose day actually falls on the date being
  tested, since a single-gym-day fixture can now only ever land on
  'push' (rotation position 0) and never 'legs'. `.decision.frequency`
  references updated to `.decision.weekly_allocation`/
  `.decision.session_purpose`.

## Verification (real commands, real output)

First pass surfaced 9 real failures from the double-subtraction bug
described above:

```
$ npx vitest run
 Test Files  2 failed | 35 passed (37)
      Tests  9 failed | 345 passed (354)
```

After the design correction and mechanical test fixture updates:

```
$ npx tsc --noEmit
(no output — 0 errors)

$ npx vitest run
 Test Files  37 passed (37)
      Tests  354 passed (354)
```

Run from a clean working tree at the repo root.

## Status against the Final Pass hard completion gate (§29)

Resolved by this commit: `1000 + index` removed; normal-development
priority no longer depends on array/index/ID/alphabetical order before
genuine equivalence; `spreadDays()` is no longer the primary
programming-decision mechanism; PPL+Upper session purpose is present;
Monday still can never receive lower-body work (now enforced by the
purpose-rotation's hard swap, plus the existing defensive
`isBodyFocusAllowedOnDay` check); secondary 0.33 exposure is no longer
ignored when deciding direct work; normal development is no longer
triggered merely because direct primary sets equal zero;
`supporting_targets` can no longer crash legitimate goal resolution.

Still open, tracked in the following commits: the required 22 §25
end-to-end tests, the §26 realistic-week fixture update (PPL+Upper
context, two active ranked goals), and the final §27/§28 test-execution
report.
