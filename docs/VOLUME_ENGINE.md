# Volume engine — how §8-13 became real code

## Why primary_sets, not exposure_units or total_sets

Blueprint's own `weekly_volume` guidance
(`BlueprintAdapter.getGlobalPrinciples().weekly_volume`) is phrased as
"hard sets per muscle per week" — `starting_point_sets: [8, 12]`,
`practical_range_sets: [10, 20]`, `higher_recovery_dependent_sets: [20, 26]`.
That is the classic direct/working-set count, not a blend that includes
incidental secondary involvement from other lifts at a discount.

`TrainingExposure.exposure_units` mixes primary (1.00/set) and secondary
(0.33/set) contributions together by design (spec §7) — exactly right
for describing overall muscular stimulus, wrong for comparing against a
range that means direct sets. `TrainingExposure.total_sets` is closer
but still counts secondary-role sets at full weight (1 set = 1, whether
primary or secondary), which would overcount against a "hard sets"
range too.

So `TrainingExposure` gained `primary_sets` and `secondary_sets` (this
change: `src/contracts/types.ts`, `CONTRACT_VERSION` 1.3.0 → 1.4.0;
computed in `src/engine/exposureEngine.ts`'s `aggregateExposure`).
`volumeEngine.decideVolume` compares `primary_sets` — and only
`primary_sets` — against Blueprint's ranges. This is a documented
interpretation choice, not a new coefficient: it decides which existing
field to read, not what number to use.

## Why priority never multiplies volume

Spec §2.2 is explicit: *"Priority affects resource allocation but does
not directly determine volume."* Spec §9 reinforces it for the starting
case specifically: *"High priority + low exposure → build up rather
than jump to the Blueprint upper range"* — even a top-priority goal
starts at the same conservative low end as any other. So
`VolumeDecisionInput.goal_priority` is carried through only for
reasoning/explainability; no branch of `decideVolume` uses it
arithmetically. Priority's real lever is resource allocation (time,
frequency slots, exercise slots across competing goals) — a separate
concern (spec §17), not sets math.

## Why a stagnant target can return `introspect_needed` but never an
automatic `increase` or `reduce`

Spec §11's stagnation checklist (exercise selection, redundancy,
execution evidence, frequency, compound overlap, time/equipment
constraints, recovery, "whether current volume is actually
insufficient") spans data this module doesn't have — that's
`exerciseSelector`, `frequencyEngine`, and `constraintEngine`'s
territory. `decideVolume` cannot verify the checklist itself, so it
never silently assumes it's been checked. An increase requires the
caller to explicitly set `introspection_confirmed_no_other_explanation:
true` — asserting the checklist was actually walked (by the future full
pipeline once those other engines exist, or by a human today). Declining
progress or poor recovery never produces a reduction from this module at
all (spec §12: "do not automatically reduce volume... first inspect");
it always returns `introspect_needed` with the exact §12 checklist,
leaving the actual modification choice (reduce / redistribute / change
exercise / deload / ...) to whatever consumes that checklist.

## Where the aesthetic trend comes from

Spec §3's dated assessment scale (1 = significantly worse … 5 =
significantly improved) is already directional by construction — it
isn't a quality score that needs a second comparison against a prior
reading. `classifyAestheticTrend` reads the single most recent
assessment: 4-5 → `improving`, 3 → `stagnant`, 1-2 → `declining`, and
`insufficient_data` when there's no assessment or the most recent one is
more than twice the goal's own `review_cadence_days` old (a `[DEFAULT]`
staleness margin — spec §3 warns against reacting to "a single noisy
observation," and a stale reading is exactly that).

## What still isn't wired up

`decideVolume` is a pure decision function — it does not yet have a
caller that assembles its inputs from real `TrainingState` +
`AestheticAssessmentsRepo` + `recoveryEngine` output. That assembly is
`workoutBuilder`'s (the pipeline's) job, not built yet.
