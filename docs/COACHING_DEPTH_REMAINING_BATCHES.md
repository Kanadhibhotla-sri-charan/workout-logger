# Coaching Depth — Remaining Batches (Batch 3 onward)

Source of truth for scope: `docs/COACHING_DEPTH_PROGRAMMING_ROADMAP.md` (the
original 9-phase proposal). This document does not redefine any phase's
design — it only groups the phases **not yet shipped** into batches, in the
same style as `COACHING_DEPTH_BATCH_1_IMPLEMENTATION_SPEC.md`, and states the
dependency reasoning behind each grouping. No code changes were made to
produce this document.

## What's already shipped (for context, not re-specified here)

| Roadmap phase | Status | Delivered by |
|---|---|---|
| Phase 1 — Muscle-specific training profiles | **Complete**, including live wiring | Batch 1 (profiles, read-only context) + Batch 2 (frequency reference + rep-range bias wired into `developmentReferenceEngine.ts`/`workoutBuilder.ts`) |
| Phase 3 — Historical trend engine | **Complete as designed** — observational only, no consumer yet | Batch 1 (`src/coaching/history/`) |

Phase 3 was explicitly scoped in the roadmap to ship "with no behavior change
on its own — it's the sensing layer Phase 4 acts on." It is done; Phase 4
below is what finally consumes it.

## Remaining phases and their dependencies

| # | Phase | Hard dependency | New persisted state? |
|---|---|---|---|
| 2 | Periodization waves & block structure | Phase 1 (done) | Yes — small |
| 4 | Reactive deloads & specialization blocks | Phase 2 + Phase 3 (done) | Extends Phase 2's state |
| 5 | Intensity techniques | — | Yes — schema field |
| 6a | Exercise rotation | — | Yes — small |
| 6b | Exercise pairing / supersets | — (architecturally separate from 6a) | Yes — new field + UI |
| 7 | Structural balance advisories | — | No |
| 8 | Individual profile factors (experience level, injury exclusion) | — | Yes — profile fields |
| 9 (optional) | Adherence / preference weighting | Phase 6a | Maybe |

Only two hard chains exist: **2 → 4**, and **6a → 9 (optional)**. Everything
else (5, 6a, 6b, 7, 8) is independent and could be reordered freely. The
batches below respect the two hard chains and otherwise group phases by
shared risk profile and shared machinery, the same reasoning already used to
split Batch 1 (foundation) from Batch 2 (wiring).

---

## Batch 3 — Periodization Waves & Block Structure (Phase 2)

**Why its own batch:** this is the first phase that makes the plan change
week-to-week, not just muscle-to-muscle — genuinely new behavior with real
interaction risk against the already-tuned exposure-cycle/frequency-gate
model, so it gets isolated regression attention rather than being bundled
with anything else.

**Scope:**
- New per-user block-state repo, modeled on `NonGoalRotationRepo`'s existing
  pattern: read by every planner call, written only at `computeFreshWeek`'s
  real new-week boundary. Tracks `weekIndexInBlock` and `isDeloadWeek` on a
  calendar cycle (e.g. 3 weeks ramping heavier/lower-rep or higher-volume, 1
  deload week, repeat).
- `volumeEngine.decideVolume` gains an optional `periodization_bias` input
  that scales recommended sets down on a deload week.
- Reuses Batch 1/2's rep-range-bias mechanism (`applyRepRangeBias`) to wave
  reps heavier/lighter within Blueprint's own authored ranges across the
  block — no new bias primitive, just a new caller.
- No reactivity yet — purely calendar-driven, deliberately (Phase 4 adds
  reactivity on top).

**Files likely touched:** new `src/coaching/periodization/` module (types +
service + repo, mirroring `src/coaching/programState/`'s existing shape),
`src/engine/volumeEngine.ts` (new optional input), `src/engine/workoutBuilder.ts`
(reads the block state to bias reps), `src/db/schema.sql` (new table).

**Verification:** new unit + integration tests proving a deload week reduces
recommended sets and a ramp week's rep bias shifts as designed, full-suite
regression diff against the current baseline (same methodology as Batches
1-2), a written implementation report, no commit without review of that
batch's own test results.

**Risk:** medium — first phase to touch `volumeEngine.ts`'s actual
set-count output, which several existing tests assert exact values against.

---

## Batch 4 — Reactive Deloads & Specialization Blocks (Phase 4)

**Why after, not with, Batch 3:** hard-depends on Batch 3's block-state table
existing, and is the first phase to actually *consume* the historical trend
engine Batch 1 already built (`calculateBasicTrend`'s `up`/`down`/`stable`
output has been observational-only until this point). Splitting it out lets
Batch 3's calendar-only deload ship and prove itself before adding
reactivity on top — the roadmap itself calls this out as a deliberate
staging decision, not an arbitrary split.

**Scope:**
- If the trend engine shows genuine stalling/decline across multiple lifts
  for a target (not one bad session — matches `volumeEngine.ts`'s existing
  `'declining'` branch, which today only ever recommends introspection,
  never acts), the block deloads early rather than waiting for the calendar.
- Specialization blocks: temporarily raising one muscle's volume/frequency
  ceiling for several weeks, reusing Batch 3's same per-user block-state
  table. Which muscle and how long is explicit user input, never an
  engine-only decision — the roadmap is explicit that this must not be
  autonomous.

**Files likely touched:** the periodization module from Batch 3 (extended,
not replaced), `src/engine/volumeEngine.ts`'s `'declining'` branch (now acts,
not just reports), a new explicit-input entry point for specialization
blocks (route + minimal UI).

**Verification:** tests proving a genuine multi-lift decline triggers an
early deload while a single noisy session does not (reusing the existing
tolerance-band precedent from `trendCalculations.ts`), specialization blocks
never trigger without explicit user input, full-suite regression diff, report.

**Risk:** medium-high — first phase where a *trend* is allowed to change
volume/scheduling, which every prior batch's reports have explicitly stated
never happens. This batch is exactly the line being crossed, so it deserves
the most scrutiny of anything in this list.

---

## Batch 5 — Structural Balance Advisories (Phase 7)

**Why its own (small) batch:** the simplest remaining phase technically, and
the roadmap explicitly flags it as movable — "could be moved earlier in the
sequence if a quick, low-risk phase is wanted in between two bigger ones."
It has zero dependencies and touches no existing decision path, so it is a
natural low-risk batch to run either right after Batch 2 or as a breather
between Batch 4 and the larger Batch 6/7/8 work below.

**Scope:** sum `weekly_exposure` across `PUSH_PHYSIQUE_TARGETS` vs
`PULL_PHYSIQUE_TARGETS` (both existing, already-reused lists) for the week
and surface a warning if the ratio drifts past a threshold. Purely advisory
— never auto-adjusts volume, matching the codebase's existing
"recommend, don't auto-act" pattern.

**Files likely touched:** a new small function in or near
`developmentReferenceEngine.ts`/`workoutBuilder.ts`'s explainability output,
a new field on the existing decision-explanation object, minimal UI surface.

**Verification:** tests proving the ratio calculation and threshold warning
fire correctly and never affect any prescribed volume, full-suite regression
diff, report.

**Risk:** low.

---

## Batch 6 — Intensity Techniques (Phase 5)

**Why its own batch:** fully independent of everything else, but sizable —
it requires a new typed model (Blueprint's `intensityTechniques` is
currently `unknown[]`, zero consumers) and new fields threaded through the
entire construction chain, not a small add-on.

**Scope:**
- Proper typed model for `BlueprintProgramming.intensityTechniques`
  (replacing `unknown[]`) with an adapter accessor.
- New planned-side fields (e.g. `target_technique` on `ExercisePerformance`,
  a matching field on `PlannedWorkItem`) threaded through
  `finalizePlacement` → `PlannedWorkItem`/`PlannedExercise` → `buildWorkout`'s
  mapping → the `ExercisePerformance` persistence shape.
- A decision rule for *when* a technique is appropriate, using Blueprint's
  own already-authored `suitable_exercise_types`/
  `suitable_when_fatigue_cost_at_most`/`fatigue_time_implications` fields —
  never inventing new criteria. Likely gated to a target's last exercise of
  the session.

**Files likely touched:** `src/blueprint/adapter.ts` (typed accessor),
`src/engine/workoutBuilder.ts` (`finalizePlacement`), the
`PlannedWorkItem`/`PlannedExercise`/`ExercisePerformance` type definitions,
persistence mapping code.

**Verification:** tests proving a technique is only applied when Blueprint's
own suitability fields allow it, prescriptions without a suitable technique
are unaffected, full-suite regression diff, report.

**Risk:** medium — touches the core `PlannedWorkItem` shape and persistence,
which many existing tests assert the exact structure of.

---

## Batch 7 — Exercise Rotation (Phase 6a)

**Why split from pairing:** the roadmap explicitly recommends treating
rotation and pairing as separate sub-phases, "building rotation first since
it reuses more existing machinery." Rotation is a bounded, additive rule on
top of an existing gate; pairing is a new architectural concept.

**Scope:** `exerciseSelector.ts`'s Gate 5 currently has an unconditional
"current exercise wins if still valid" rule with no counterbalance. A small
persisted per-target "weeks on this exercise" counter (new, small state,
same repo pattern as Batch 3) lets a rotation rule force a swap after N
weeks even though Gate 5 would otherwise keep it, using Blueprint's own
`overlaps_with` field (already mostly populated, confirmed structurally
usable) to pick a real alternative covering the same target.

**Files likely touched:** new small repo (mirrors `NonGoalRotationRepo`),
`src/engine/exerciseSelector.ts` (Gate 5).

**Verification:** tests proving an exercise is forced to rotate after N
weeks via a real `overlaps_with` alternative, and is never rotated away
before N weeks, full-suite regression diff, report.

**Risk:** low-medium — Gate 5 is load-bearing, but the change is additive
(a new exit condition, not a rewrite of the gate hierarchy).

---

## Batch 8 — Exercise Pairing / Supersets (Phase 6b)

**Why its own, later batch:** the roadmap calls this "the most
architecturally invasive item on this list" — no infrastructure exists at
all today (`plannedWork` is an unordered flat list; selection only ever
considers one target at a time). This is deliberately sequenced after
rotation (Batch 7) so the codebase absorbs the smaller change first.

**Scope:** a new cross-target decision step, a new `paired_with_exercise_id`
-style field, and UI to show a pair as one unit (supersets/pre-exhaust).

**Files likely touched:** `src/engine/workoutBuilder.ts` (new pairing
decision step, likely a new function rather than extending
`attemptSelection`), `PlannedWorkItem`'s type, `public/logger.html`/
`public/program.html` (pair display).

**Verification:** tests proving a paired exercise is placed adjacently and
tagged correctly, unpaired exercises are unaffected, full-suite regression
diff, report.

**Risk:** high — new cross-target decision logic with no existing precedent
to model it on, unlike every other batch above.

---

## Batch 9 — Individual Profile Factors (Phase 8)

**Why its own batch:** independent of everything else, and deliberately
scoped small per the roadmap — this app is single-user and the user is
already an experienced trainee, so the core logic can be tuned and validated
against "advanced" behavior directly rather than building a general
experience-level system speculatively.

**Scope:**
- Explicit experience-level field on `training_profiles` (does not exist
  today) that scales the flat progression increment
  (`PROGRESSION_INCREMENTS.weeklyExposureUnits`, currently a single constant
  `2` for everyone).
- Optional add-on, build only if/when needed: an injury-history/excluded-
  target-ids list read by `exerciseSelector.ts`'s Gate 1 feasibility check.
  The roadmap is explicit this should not be built speculatively.

**Files likely touched:** `src/db/schema.sql` (new profile field(s)),
`src/engine/config.ts` (`PROGRESSION_INCREMENTS` becomes profile-aware),
`src/engine/progressionEngine.ts`, optionally `src/engine/exerciseSelector.ts`
Gate 1 (injury exclusion, only if actually needed).

**Verification:** tests proving the progression increment scales per
experience level, an excluded target is never selected when the optional
add-on is exercised, full-suite regression diff, report.

**Risk:** low.

---

## Batch 10 (optional / deferred) — Adherence & Preference Weighting (Phase 9)

**Why last and optional:** the roadmap itself recommends deferring this
until the other phases are live and there is a concrete list of exercises
the user actually wants excluded, rather than speculating now. It also
hard-depends on Batch 7's rotation alternative-lookup to avoid a disliked
exercise.

**Scope:** a disliked-exercise list (explicit user input, not inferred) that
`exerciseSelector.ts` avoids, reusing Batch 7's rotation machinery to find a
substitute rather than building a second alternative-lookup path.

**Files likely touched:** `src/engine/exerciseSelector.ts`, a small new
persisted preference list, minimal UI to manage it.

**Verification:** tests proving a disliked exercise is never selected once
listed, and that removing it from the list restores normal selection,
full-suite regression diff, report.

**Risk:** low, but only worth doing once there's real signal it's needed —
do not build this speculatively per the roadmap's own instruction.

---

## Suggested ordering

**Roadmap-strict order** (respects both hard chains, defers the optional
phase to last): **3 → 4 → 5 → 6 → 7 → 8 → 9 → 10.**

**Risk-smoothed alternative**: pull Batch 5 (Structural Balance Advisories)
forward to run immediately after Batch 2, before the riskier Batch 3/4
periodization work, since the roadmap explicitly allows this and it has zero
dependencies: **5 → 3 → 4 → 6 → 7 → 8 → 9 → 10.** This front-loads a fast,
low-risk win and defers periodization's higher regression risk without
changing what any later batch depends on.

Either way, Batch 3 → Batch 4 must stay adjacent and ordered (Phase 4 hard-
depends on Phase 2's block state), and Batch 7 must precede Batch 10 if
Batch 10 is ever built at all.

## Verification approach (every batch, unchanged from Batches 1-2)

`npm run typecheck` clean, full `vitest` suite baseline-diffed against the
current known-failure snapshot (zero new failures required beyond the
existing, unrelated date-drift set documented in
`COACHING_DEPTH_BATCH_1_IMPLEMENTATION_REPORT.md` §9), new tests added
per-batch proving the new mechanism directly, a written implementation
report per batch, and no commit without the user's explicit request and
review of that batch's own test results.
