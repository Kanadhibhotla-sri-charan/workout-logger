# Training Exposure Model

Design document for `TrainingExposure` (`src/contracts/types.ts`), answering:
*how much training has a given target actually received?* This is
deliberately a **design boundary, not an implementation** — no
hypertrophy-volume weighting or automatic aggregation logic is
implemented in this change. Nothing invented here without direct Blueprint
data backing it up is treated as decided; every such gap is marked
**Phase 2 — undecided** below, not silently defaulted.

Originally written for the Phase 1.5 remediation; extended here (Phase 2)
per the Training Engine Design spec's §3-§6 to separate three concepts
that must not be conflated, answer §4's five questions explicitly, and
adopt an explicit direct/indirect-contribution strategy per §5.

## 0. Three concepts that must not be conflated

```text
Training Exposure  ≠  Hypertrophy Volume  ≠  Functional Exposure
```

**Training Exposure** — a neutral, goal-agnostic record of how a
completed exercise/session touched a Blueprint target. It answers only
"did this happen, and how much of it," never "was this good for
hypertrophy" or "did this serve goal X." This is the `TrainingExposure`
contract type and the only thing this document's A-G sections below
compute a rule for. Expressed in **`exposure_units`**, never
"effective sets" — see §6 (Do not accept "one set = one effective set" as
physiological truth) below for why that distinction is load-bearing.

**Hypertrophy Volume** — a *goal-specific interpretation* of Training
Exposure for physique development. It may eventually fold in direct vs.
indirect contribution weighting, proximity to failure (RIR/RPE), exercise
role, target priority, recovery, and frequency — none of which are
decided or implemented here. This is a **separate, future type**
(`HypertrophyVolume` in `src/contracts/types.ts`, shape only, uncomputed),
layered on top of raw Training Exposure, not baked into it.

**Functional Exposure** — a potentially *different* metric for functional
goals (e.g. `rotator-cuff`, `core-anti-rotation`). This document does not
assume the same arithmetic that ends up governing hypertrophy volume
automatically applies here. Also a separate, future, uncomputed type
(`FunctionalExposure`).

Why this separation matters concretely: Blueprint's own
`functional_goals` field is present on only 8/123 exercise records (see
Method, below), all low-load stability/anti-movement patterns (planks,
Pallof press, hip abduction) — nothing about them resembles hypertrophy
programming (weekly set targets, rep ranges, progressive overload by
load). Reusing a hypertrophy-shaped formula for these would silently
misrepresent what "progress" even means for a functional goal. Section
21-27 general programming logic that depends on Training Exposure must
route through the correct one of these three concepts, never treat
Training Exposure itself as if it already were Hypertrophy Volume.

## 1. What is a target? (§4.1)

A **target** is any Blueprint entity a Goal or Exercise can point at by
canonical id, resolved only through `BlueprintAdapter` — never a display
name, never a free-text muscle name. Concretely, two closed families:

- **Physique target** (`BlueprintAdapter.getTarget(id)` /
  `getTargets()`) — an aesthetic/physique-development entity from
  `data/programming/physique-targets.yaml` (e.g. `upper-pec`,
  `brachialis-arm-thickness`). Referenced by `Exercise.physique_targets`
  and by an aesthetic Goal's resolved `AestheticOutcome.primary_targets`
  / `supporting_targets`.
- **Functional goal** (`BlueprintAdapter.getFunctionalGoal(id)` /
  `getFunctionalGoals()`) — a joint-health/movement-quality entity from
  `data/programming/functional-goals.yaml` (e.g. `rotator-cuff`,
  `core-anti-rotation`). Referenced by `Exercise.functional_goals` and
  directly by a functional Goal's `blueprint_ref`.

These are Blueprint's canonical taxonomy in full — this app does not
define a third, its-own target vocabulary. `AestheticOutcome` (e.g.
`arm-side-thickness`) is not itself a target; it's a Goal-level concept
that *names* primary/supporting physique targets (see §7 Goal Resolution,
`docs/TRAINING_ENGINE_DESIGN.md`).

## 2. What Blueprint currently provides, and what doesn't exist (§4.3, §4.4)

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

## B. Indirect exposure — Strategy decision (§5)

**Definition (spec)**: when an exercise contributes to a target through
its role in a compound movement, without that target being one of the
exercise's own listed `physique_targets`/`functional_goals` (e.g. a bench
press indirectly loading front delts/triceps).

Two strategies were evaluated, as required before implementing any
weighted indirect exposure:

**Strategy A — Conservative.** Count only canonical Blueprint target
relationships (i.e. treat indirect exposure as *not tracked* — only
direct `physique_targets`/`functional_goals` membership counts as
exposure at all). Advantages: highly explainable, no invented data,
simple, consistent with how Blueprint's own authors already resolve
multi-target ambiguity (splitting exercises rather than weighting them —
see the load-bearing finding above). Disadvantage: compound movements'
real secondary contribution (e.g. front delts/triceps on a bench press)
is invisible to the exposure model, which may understate how much a
supporting target was actually trained.

**Strategy B — Extend Blueprint.** Add a canonical, structured
relationship to Blueprint itself (e.g. an author-curated
`secondary_physique_targets: string[]` field alongside
`physique_targets`), and consume that once it exists. Advantage: precise,
still zero invented data — the *source of truth* grows, this app doesn't
guess. Disadvantage: requires a change to a different repository, outside
this app's authority, and depends on Blueprint's own authors curating it
(the same discipline that makes `physique_targets` trustworthy today).

**Decision: Strategy A is adopted for this app's own exposure
computation** (`src/engine/exposureEngine.ts`, Phase 2 foundation). It is
the only option that requires zero new invented data and follows every
"do not implement fuzzy matching against free-text secondary-target
descriptions" instruction directly — `Exercise.secondary_targets` is free
text (see the field table above) and is **never** used as an exposure
signal by this app, matched or otherwise. **This is a recommendation
pending Charan's sign-off** (see `docs/open-decisions.md`), not a
unilateral final answer — the direct/indirect treatment is explicitly
listed as something the user approves, not something a developer silently
decides. If Strategy B is preferred, that's a Blueprint-repo decision to
raise with Charan, not something this app should work around with a
guess in the meantime.

No indirect-exposure logic exists in this codebase, by design — Strategy
A means there is none to implement.

## C. Set contribution — adopted as the neutral exposure_units default

**Definition**: how much one completed set contributes to a target it
trains, measured in **`exposure_units`** — deliberately not "effective
sets" (see §6 below for why the naming distinction is load-bearing).

**Status: adopted for Training Exposure only, implemented in
`src/engine/exposureEngine.ts`.** Because `physique_targets` is flat and
unweighted (see §2), the rule is: *one completed set = one exposure_unit
toward every target listed in that exercise's `physique_targets` (or
`functional_goals`)* — no fractional split between multiple listed
targets, each gets full credit, matching how Blueprint itself avoids
fractional attribution. This is safe to implement now because it invents
no physiological precision — it is a pure counting rule over facts
Blueprint already states (which targets this exercise trains) and facts
this app already records (was the set completed). It answers only
"how much did this happen," nothing about whether it was optimal,
sufficient, or hypertrophy-effective. **What `exposure_units` do *not*
mean** — and must never be silently promoted into meaning — is covered
next.

## D. Uncompleted sets — adopted

**Definition**: how a skipped/failed/uncompleted set (`Set.completed ===
false`) should be treated.

**Status: adopted, implemented.** An uncompleted set produced no
exposure — it contributes zero `exposure_units`. This is a definitional
fact (an uncompleted set is not training that happened), not a judgment
call, so it's implemented directly in `exposureEngine.ts` rather than
listed as pending.

## §6. Do not accept "one set = one effective set" as physiological truth

`exposure_units` (C above) is a **neutral counting metric**, useful as a
building block, but it must never be silently relabeled or treated as
"one completed set = one effective hypertrophy set." That label implies
more physiological precision than flat, unweighted `physique_targets`
membership can support — it says nothing about proximity to failure,
exercise role, indirect contribution (deliberately excluded under
Strategy A), or target priority. Concretely, in this codebase:

- `src/contracts/types.ts`'s `TrainingExposure.exposure_units` (renamed
  from an earlier `effective_sets` placeholder — see `docs/logs/`) is the
  only field this document's rules populate.
- `HypertrophyVolume.effective_sets` (a **separate**, still-uncomputed
  type — see §0) is reserved for the day a real, evidence-backed
  hypertrophy-volume model is approved. Nothing in this codebase computes
  it yet, and nothing should populate it by just copying
  `exposure_units` over.

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

## G. Aggregation — implemented, with an explicit (not silently assumed) week boundary

**Definition**: exercise-level exposure rolled up to daily, weekly, and
rolling windows (spec §13-§14).

**Status: implemented in `src/engine/exposureEngine.ts`**, since A/C/D
(the parts it depends on) are adopted above and this is a query shape
over already-indexed data (`workout_sessions.date`,
`idx_workout_sessions_date`), not a new data source or a judgment call.

- **Week boundary**: `TrainingProfile.week_start_day` (a `Weekday`,
  defaults to `'monday'` but is stored data, never a hard-coded
  assumption — see §37's "do not silently assume Monday-Sunday" and
  `docs/TRAINING_ENGINE_DESIGN.md`). `aggregateWeeklyExposure` takes the
  configured start day and computes the 7-day window containing the
  query date accordingly.
- **Rolling window**: `aggregateRollingExposure` takes an explicit
  `windowDays` parameter (no silent default) — callers choose 7, 14, or
  any other window. This exists specifically to avoid the failure mode
  the spec calls out: a weekly total looking low while a huge session
  happened yesterday, outside the calendar-week boundary currently in
  view.
- **Completed-set treatment**: inherited directly from C/D — only
  completed sets contribute, one `exposure_unit` per listed target, no
  additional weighting at the aggregation step itself.
- **Target aggregation**: exposure is summed per `(target_type,
  target_id)` pair across every exercise/session in the window — a
  session touching the same target twice (e.g. two exercises both listing
  `triceps`) accumulates, it does not dedupe or cap.

## Explainability (§8/§29 of the spec)

Every derived exposure record is traceable back to its source — this is
implemented, not hypothetical, for A/C/D (`exposureEngine
.calculateTargetExposure` returns the trace fields directly, no separate
explanation step needed since the rule is a pure count):

```text
Target: triceps

Source: cable-pushdown (workout_sessions/2026-08-29, exercise #2)

Completed: 3 of 4 sets (1 uncompleted, per rule D — excluded)

Relationship: direct (triceps ∈ cable-pushdown.physique_targets)

Contribution: 3 exposure_units (per rule C)

Strategy: A — conservative, direct-only (indirect exposure not tracked,
per §5 decision above)

Reason: Blueprint physique_targets membership + this document's Set
Contribution rule (C), commit b018abc1049cb578e13ece8af442852af1dfacfe
```

Note what this trace does **not** claim: it never says "3 effective
hypertrophy sets" — see §6.

## Summary — what's implemented vs. still open

| Part | Status | Implemented in |
|---|---|---|
| A. Direct exposure | ✅ adopted & implemented | `src/engine/exposureEngine.ts` |
| B. Indirect exposure | ✅ **decided: Strategy A (not tracked)** — pending Charan's sign-off | n/a by design |
| C. Set contribution | ✅ adopted & implemented (`exposure_units`, full credit per listed target) | `src/engine/exposureEngine.ts` |
| D. Uncompleted sets | ✅ adopted & implemented (zero exposure) | `src/engine/exposureEngine.ts` |
| E. Intensity (RIR/RPE) | ❌ still open — blocked on logger UI collecting RIR/RPE first | — |
| F. Goal weighting | ❌ still open — design direction only, no formula | — |
| G. Aggregation (weekly/rolling) | ✅ adopted & implemented, explicit configurable week boundary | `src/engine/exposureEngine.ts` |
| Hypertrophy Volume (§0) | ❌ not started — separate future type, depends on E and F | — |
| Functional Exposure (§0) | ❌ not started — separate future type, may not share Hypertrophy Volume's rules | — |

What changed from Phase 1.5: A/C/D/G are now implemented, because each
one is a pure counting/query rule over facts Blueprint or this app's own
`Set.completed` flag already state — no physiological precision invented.
B is now a documented, adopted decision (Strategy A) rather than an open
question, though still pending formal user sign-off per §37. E and F
remain genuinely open — E because the data to weight by doesn't exist yet
in the logger, F because it requires a formula this document deliberately
does not invent. Hypertrophy Volume and Functional Exposure (§0) are new
placeholder types with zero computation, reserved for once E/F are
resolved.
