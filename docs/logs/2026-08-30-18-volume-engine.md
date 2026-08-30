# 2026-08-30 — Volume engine: §8-13's starting/maintain/increase/introspect decision

## Why

`volumeEngine.ts` previously threw `NotApprovedError` for lacking a
personalization model. Spec §8-13 actually specifies the *process* in
exact terms (starting volume builds up gradually regardless of
priority; maintain is the default; stagnation requires introspection
before any increase; decline/poor-recovery never auto-reduces) —
Blueprint's own `weekly_volume` reference ranges (already exposed in
the prior commit's `BlueprintGlobalPrinciples`) supply the numeric
ranges. Nothing here needed inventing.

## What changed

- `src/contracts/types.ts` — `TrainingExposure` gained `primary_sets`
  and `secondary_sets` (`total_sets = primary_sets + secondary_sets`
  always). `CONTRACT_VERSION` 1.3.0 → 1.4.0. `src/engine/exposureEngine.ts`'s
  `aggregateExposure` now tracks both. See `docs/VOLUME_ENGINE.md` for
  why volume comparisons need `primary_sets` specifically, not
  `total_sets` or `exposure_units`.
- `src/engine/volumeEngine.ts` (rewritten, real implementation) —
  `decideVolume()`: no existing direct volume → `increase` to
  Blueprint's `starting_point_sets[0]`, ignoring `goal_priority`
  entirely (spec §2.2/§9: priority does not multiply volume).
  `improving`/`insufficient_data` aesthetic trend → `maintain`.
  `declining` → always `introspect_needed` with the exact §12
  checklist, never an automatic reduction. `stagnant` with poor
  recovery, or without an explicit
  `introspection_confirmed_no_other_explanation: true` → also
  `introspect_needed` (§11 checklist). Only `stagnant` + recovery ok +
  confirmed introspection → `increase`, by the existing
  `PROGRESSION_INCREMENTS.weeklyExposureUnits`, capped at the current
  Blueprint reference range's upper bound. Also exports
  `classifyAestheticTrend()` — a dated 1-5 assessment (spec §3) is
  already directional by this app's own `ASSESSMENT_SCALE` labels, so
  no new trend-detection formula was needed, just reading the most
  recent non-stale assessment.
- `docs/VOLUME_ENGINE.md` (new) — documents the `primary_sets` choice,
  why priority never multiplies volume, why `introspect_needed` (never
  a silent `increase`/`reduce`) is the honest answer to stagnation and
  decline, and the trend-classification rule.
- `tests/engine/unapprovedStubs.test.ts` — dropped `volumeEngine`'s
  now-false "throws NotApprovedError" case.

## Tests

`tests/engine/volumeEngine.test.ts` (16 tests): trend classification
for all five 1-5 ratings plus `null`/stale → `insufficient_data`;
starting volume hits Blueprint's conservative low end and is identical
regardless of priority; good progress → `maintain` (required test 7);
stagnation → `introspect_needed` with a non-empty checklist (required
test 8); stagnation + confirmed + good recovery → small configured
increase (required test 9); the increase is capped at the reference
range's max; stagnation + poor recovery → still `introspect_needed`
even with confirmation set; decline + poor recovery → never `increase`
(required test 10); decline never returns an automatic reduction
either; reasoning is always a real, non-empty explanatory string.

## Verification (actually run)

```
$ npx tsc --noEmit
(no output — clean)

$ npx vitest run
 Test Files  30 passed (30)
      Tests  226 passed (226)
```

(211 tests before this batch; 226 after adding
`tests/engine/volumeEngine.test.ts`'s 16 tests, minus 1 removed from
`unapprovedStubs.test.ts` — no regressions.)

## Still open

`decideVolume` is a pure function with no caller yet assembling its
inputs from real `TrainingState`/`AestheticAssessmentsRepo`/
`recoveryEngine` — that assembly belongs to `workoutBuilder` (the
pipeline), still a stub. `frequencyEngine`, `exerciseSelector`, and
`workoutBuilder` remain the last three stubs; `frequencyEngine` is
next, since the weekly schedule config (`DEFAULT_WEEKLY_SCHEDULE`,
`FORBIDDEN_BODY_FOCUS_BY_DAY`) already exists and just needs a real
distribution rule on top of it.
