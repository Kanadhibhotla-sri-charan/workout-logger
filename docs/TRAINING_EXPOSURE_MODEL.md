# Training Exposure Model

Design document for `TrainingExposure` (`src/contracts/types.ts`), answering:
*how much training has a given target actually received?* This is
deliberately a **design boundary, not an implementation** — per the Phase
1.5 remediation spec, no effective-set weighting or aggregation logic is
implemented in this change. Nothing invented here without direct Blueprint
data backing it up is treated as decided; every such gap is marked
**Phase 2 — undecided** below, not silently defaulted.

## Method

Before writing a rule, the actual Blueprint snapshot
(`src/blueprint/snapshot/exercises.json`, 123 records, commit
`b018abc1049cb578e13ece8af442852af1dfacfe`) was inspected field-by-field to
see what target/relationship information genuinely exists, rather than
assuming a shape. Findings that matter here:

| Field | Key present | Shape | Canonical ids? |
|---|---|---|---|
| `physique_targets` | 113/123 (absent, not null, on the rest) | flat `string[]`, undifferentiated | yes — resolves via `BlueprintAdapter.getTarget()` |
| `functional_goals` | 8/123 (absent on the rest) | flat `string[]`, undifferentiated | yes — resolves via `BlueprintAdapter.getFunctionalGoal()` |
| `primary_targets` / `secondary_targets` | always present | free text, often with parenthetical caveats (e.g. `"triceps (long-head-biased, strongly supported by hypertrophy research)"`) | **no** — not id-resolvable, not reliably string-matchable to a target's `name` |
| `coverage_categories` | always present | free text tags (`isolation`, `heavy-compound`, `low-setup`, `lengthened-position-emphasis`, ...) | no — describes exercise character, not per-muscle contribution |

(`src/blueprint/types.ts` was corrected in this change: `physique_targets`
and `functional_goals` are now typed as optional keys, matching what the
data actually does — see `docs/logs/` for that commit. Always read both
via `e.physique_targets ?? null` / `e.functional_goals ?? null`, never
assume the key exists.)

**The load-bearing finding**: Blueprint has **no per-target weighting** of
any kind. `physique_targets` is a flat, unordered set — "this exercise
trains these targets," full stop, no "60% this / 40% that." Where Blueprint
authors needed to express that two targets deserve materially different
programming treatment from what looks like "the same" exercise, they did
**not** invent a percentage split — they created two separate exercise
records instead (e.g. `dip-chest-biased` / `dip-triceps-biased`,
`bulgarian-split-squat-hip-dominant` / `...-knee-dominant`). This is a
deliberate authoring convention (see `docs/architecture.md` §1, ADR 0001),
not an oversight, and it's the strongest signal available for how this app
should treat exposure too: **prefer trusting Blueprint's own exercise
granularity over inventing a fractional-contribution formula.**

There is no field anywhere in Blueprint linking RIR/RPE to exposure
magnitude, and no compound-movement fractional-attribution data of any
kind. Any rule of that shape would be this app's own invention with zero
Blueprint backing — exactly what §6 of the remediation spec says not to do
without approval.

## A. Direct exposure

**Definition**: an exercise directly trains a target when the target's id
appears in `Exercise.physique_targets` (aesthetic) or
`Exercise.functional_goals` (functional).

**Status: directly supported by Blueprint data.** This is unambiguous —
the id either appears in the list or it doesn't — and requires no new
rule. This is the one part of the exposure model safe to implement as-is.

## B. Indirect exposure

**Definition (spec)**: when an exercise contributes to a target through
its role in a compound movement, without that target being one of the
exercise's own listed `physique_targets`/`functional_goals` (e.g. a bench
press indirectly loading front delts/triceps).

**Status: Phase 2 — undecided.** Blueprint's free-text `secondary_targets`
field is the closest candidate signal, but it is not canonical-id
resolvable (see table above) — treating it as indirect target exposure
today would mean inventing a text-matching heuristic against target
`name`s, which is exactly the kind of unverified rule §6 says not to
build without sign-off. Two real options for Phase 2, neither implemented
here:
1. Only recognize indirect exposure where `secondary_targets` text can be
   deterministically and unambiguously matched to a target's canonical
   `name` (conservative — likely misses real cases).
2. Ask whether Blueprint itself should grow a canonical
   `secondary_physique_targets: string[]` field (a Blueprint-side change,
   outside this app's authority — flag to Charan, don't build around a
   guess).

No indirect-exposure logic exists in this codebase.

## C. Set contribution

**Definition**: how much one completed set contributes to a target it
trains.

**Status: Phase 2 — undecided; a candidate default is proposed, not
adopted.** Because `physique_targets` is flat and unweighted (see Method),
the simplest internally-consistent default is: *one completed set = one
unit of exposure to every target listed in that exercise's
`physique_targets`* (no fractional split between multiple listed
targets — each gets full credit, not divided credit, again matching how
Blueprint itself avoids fractional attribution). This is written down here
as a **candidate**, not implemented, and not to be treated as final without
explicit approval — it directly determines what `effective_sets` will mean
once built, and the remediation spec is explicit that this number must not
be invented casually.

## D. Uncompleted sets

**Definition**: how a skipped/failed/uncompleted set (`Set.completed ===
false`) should be treated.

**Status: recommended default, still flagged for confirmation.** An
uncompleted set produced no training stimulus by definition — the
recommended rule is that it contributes zero exposure. This is closer to a
definitional fact than a judgment call (unlike C), but is still listed as
Phase 2 pending explicit sign-off rather than silently assumed in code,
per the spec's instruction to mark rather than invent.

## E. Intensity information (RIR/RPE)

**Status: Phase 2 — undecided, and currently unbuildable.** `Set.rir` /
`Set.rpe` already exist in the contract (`src/contracts/types.ts`,
nullable) but **nothing populates them yet** — `public/logger.html`'s set
editor only collects weight/reps/completed. Blueprint's own
`programmingEngine` uses RIR as *prescriptive* guidance (what RIR a set
should target) via `global-principles.yaml`'s `rir` block, not as a
*descriptive* measurement of what a user actually hit, so there is no
Blueprint data to borrow a weighting formula from either. Sequencing note
for Phase 2: intensity-weighted exposure needs the logger UI extended to
collect RIR/RPE *before* any weighting rule can be evaluated against real
data.

## F. Goal weighting

**Definition**: how a goal's priority and its primary/supporting target
split should change the interpretation of exposure (e.g. "general triceps
training" vs. "triceps as a supporting target for `arm-side-thickness`").

**Status: Phase 2 — undecided (design direction proposed).** A set's
physical reality doesn't know about goals — the same completed set is the
same completed set regardless of why it was performed. The proposed shape
(not implemented): keep raw `TrainingExposure` per target, target-only,
goal-agnostic (as already defined in the contract), and compute
goal-relative *coverage* as a separate, derived view at read time — join a
`Goal`'s resolved `primary_targets`/`supporting_targets` (via
`GoalsRepo.resolveBlueprint`) against the raw per-target exposure, and let
`Goal.priority` weight the result there. This keeps the base exposure
numbers reusable across goals rather than baking one goal's weighting
into a fact about what was actually trained. No weighting formula (how
much more a primary target should count than a supporting one) is decided.

## G. Aggregation

**Definition**: exercise-level exposure rolled up to daily, weekly, and
rolling windows.

**Status: buildable once A-F are decided; not a data-availability
problem.** `workout_sessions.date` is already indexed
(`idx_workout_sessions_date`), and `WorkoutSession` -> `ExercisePerformance`
-> `Set` is already fully queryable by date range. Once A-C settle what a
single exposure record means, daily/weekly/rolling aggregation is a query
shape, not a new data source.

## Explainability (§8 of the spec)

Every derived exposure record should eventually be traceable back to its
source. Worked (hypothetical) example, once C and D above are decided,
using real Blueprint ids:

```text
Target: triceps

Source: cable-pushdown (workout_sessions/2026-08-29, exercise #2)

Completed: 3 of 4 sets (1 uncompleted, per rule D — excluded)

Relationship: direct (triceps ∈ cable-pushdown.physique_targets)

Contribution: 3 units (per candidate rule C — pending approval)

Reason: Blueprint physique_targets membership + this document's Set
Contribution rule (C), commit b018abc1049cb578e13ece8af442852af1dfacfe
```

The output format itself does not need to exist yet — nothing in the
current schema prevents building it: `WorkoutSession.date`,
`ExercisePerformance.exercise_id`, and each `Set`'s `completed` flag are
already sufficient inputs for A, C, and D once C/D are approved.

## Summary — what's decided vs. open

| Part | Directly supported by Blueprint today | Needs a new rule (Phase 2) |
|---|---|---|
| A. Direct exposure | ✅ `physique_targets` / `functional_goals` membership | — |
| B. Indirect exposure | ❌ no canonical secondary-target ids | ✅ text-matching heuristic or a Blueprint-side schema change |
| C. Set contribution | ❌ no per-target weighting in Blueprint | ✅ candidate default proposed above, needs approval |
| D. Uncompleted sets | n/a (this app's own `Set.completed` flag) | ✅ recommended default proposed, needs approval |
| E. Intensity (RIR/RPE) | ❌ Blueprint's RIR is prescriptive, not descriptive | ✅ needs logger UI work first, then a rule |
| F. Goal weighting | ❌ Blueprint has no concept of a user or a goal | ✅ design direction proposed, no formula decided |
| G. Aggregation | ✅ schema already supports date-range queries | — (blocked on A-F, not on data) |

Nothing above is implemented as executable code in this change —
`TrainingExposure`'s shape in `src/contracts/types.ts` is unchanged from
Phase 1, still a placeholder. This document exists so that when Phase 2
picks up the open rows, it has an honest starting point instead of
reverse-engineering one from whatever first implementation happens to ship.
