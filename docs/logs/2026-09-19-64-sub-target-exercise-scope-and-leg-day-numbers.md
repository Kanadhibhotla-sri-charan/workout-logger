# 2026-09-19 — Sub-Target Exercise Scope, One-Leg-Day Numbers, Fractional Need Ranking

Uncommitted-until-this-entry work from the goal-volume investigation (log 63 flagged it). Not deployed.

## Why

Blueprint packages are authored per muscle_group, but several groups hold multiple targets (chest: upper/mid/lower-pec; triceps: triceps + long head; biceps: biceps + brachialis; glutes; calves). Every sibling was credited with the WHOLE package, so a sub-slice goal (e.g. triceps-long-head) got the full 24-set triceps reference. Separately, the user trains legs once a week (Thu) with Saturday badminton, so leg references assuming 2x/week (quads 26) or curated 4x (calves 32) were undeliverable: a real-engine simulation showed one leg day delivering only calves, or only quads+one calf.

## What changed

- `src/blueprint/subTargetExerciseScope.ts` (new): per-package tags of which exercises count toward which target, read from each exercise's own Blueprint `contribution` text. Covers chest, triceps, biceps (sub-slices) and, for legs, glutes/calves (split per target) plus quads/hamstrings/glutes/calves secondary-role exercises tagged `[]` (excluded from the reference).
- `developmentReferenceEngine.ts`: sums only the scoped exercises for a target.
- `workoutBuilder.ts`: (1) package-sharing pooling bypassed for scope-tagged packages (each sibling already owns an exclusive slice); still applies to shoulders/back/forearms/core. (2) `rankTarget` need is now the FRACTION of a target's own reference still unmet, not the raw set count, so untouched non-goal muscles tie at 100% and the existing rotation ring decides. Absolute deficit made big-reference muscles win every week and starve the rest (simulated: quads+glute-max forever).

## Resulting per-session numbers (Complete / goal)

quads 8, hamstrings 5, glute-max 6, glute-med/min 2, gastroc 5, soleus 3; triceps-long-head 8/wk, brachialis 8/wk, upper-pec 14, mid-pec 10, lower-pec 10. Non-goal legs rotate: each gets one exposure roughly every 1-2 weeks (4-week simulation).

## Judgment calls (NOT Blueprint data, NOT evidence-backed)

- Dropping secondary-role leg exercises because Saturday badminton follows Thursday legs (eccentric/unilateral work).
- single-leg-calf-raise kept for gastrocnemius; tagged gastroc because its contribution text is generic.
- The badminton days (Sat/Sun) are assumed from the eval seed, not verified against production.

## Known limitations

- A deload cannot reduce a single-exercise target below that exercise's authored sets (repair clamps to Blueprint): gastroc/soleus/glute-med non-goal now have one exercise.
- Weekly references in code still assume Blueprint/curated frequency (quads 2x, calves 4x); the app's existing cross-week horizon carries the shortfall. A first attempt to cap references at real weekly exposures was reverted because it defeated that cross-week design.
- `adductors` has no package; `neck-thickness` removed earlier.
- Non-goal numbers for upper body (~1.5 exposures/wk average) were an estimate, not simulated.

## Verification

`npm run typecheck` clean. Full vitest: 231 failed / 1515 passed, failure set identical to the 231 baseline (one calendar-rotted programmerDomainValidator entry already excluded). Tests re-derived or added: developmentReferenceEngine (+leg scope test), developmentReferenceIntegration, finalRemainingPerExposure (Test D to gluteus-maximus), postV2CorrectiveFixV2 §24.L, nonGoalMuscleRotation (pull-day ring, +leg rotation test), sessionRealismCap (triceps trim fixture), programmingBrief, coachingDepth Batch 2/3, assembleAndBuildWorkout and finalPass badminton tests (seated-leg-curl seed).

## Trial

User will run these numbers for 2 weeks and compare against their logged history. Nothing here was compared to that history.
