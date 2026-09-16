# Beyond Sets & Reps: Coaching-Depth Programming Roadmap

**Status: proposed, not yet approved for implementation.** This document
records the phased plan discussed with the user; nothing in it has been
built. Do not start any phase below without explicit go-ahead.

## Context

The deterministic engine (and the AI programmer built on top of it)
currently prescribes a workout using exactly three numbers per exercise:
sets, a rep range, and an RIR range — all pulled from one fixed Blueprint
package per muscle, recomputed fresh every week with no memory of the weeks
before it. After years of training, the user feels this is the ceiling
they've hit: sets/reps/weight alone haven't produced the results they want,
and they believe (correctly, in coaching terms) that the missing pieces are
things a program's *structure* controls — how volume and intensity wave over
time, when to back off, how a muscle-specific plan differs by muscle,
intensity techniques, exercise sequencing/rotation, and individual factors —
not proximity-to-failure or exercise form, which the user already manages
carefully outside the app (strict form technique study, consistently pushing
a genuine 1-3 RIR).

Two research passes over the codebase (`src/engine/*`, `src/repositories/*`,
`src/db/schema.sql`, `src/contracts/types.ts`, `src/ai-programmer/contracts/*`,
`src/blueprint/snapshot/*`) confirmed: **none of the items below exist
today, in any form.** The engine is a clean, well-architected, single-week
snapshot machine with no periodization, no mesocycle/deload concept, no
per-muscle profile beyond exercise selection, no planned-side technique/tempo
field, no exercise-pairing or rotation logic, and no training-age or injury
concept. This is a genuine gap, not a partially-built feature to extend.

This plan sequences the ideas into buildable phases: each phase should ship,
get tested, and be reviewed before the next begins — matching how every
other fix in this project has been done. Full engineering detail is included
for **Phase 1** (the first phase that would build, once approved); later
phases get a scope paragraph now and would get a full technical spec
immediately before their own build starts, so this document stays reviewable
instead of turning into a 500-line spec no one re-reads.

## Key existing building blocks (confirmed via research, to be reused rather than rebuilt)

- **`src/engine/volumeEngine.ts`** (`decideVolume`) — the one place weekly
  volume is decided per target. Pure, stateless, single-week input. This is
  where periodization/deload/training-age signals would plug in.
- **`src/engine/developmentReferenceEngine.ts`** (`getDevelopmentReference`) —
  picks Complete vs Efficient package per target. Frequency is a flat 2/week
  in every Blueprint package; there is no per-muscle frequency data today.
- **`src/engine/exerciseSelector.ts`** — the strict Gate 2-6 exercise-choice
  pipeline. Gate 5 ("current exercise wins if still valid") is the thing a
  rotation policy would need to override.
- **`src/engine/goalPhaseEngine.ts`** (`gatherReviewEvidence`, ~lines
  318-364) — the one existing precedent for turning raw logged sets into a
  real trend (`load = weight * (1 + reps/30)`, early-half vs late-half
  comparison). Scope today is one target per active goal, computed on
  demand, not persisted as its own series. The trend-engine phase would
  generalize this pattern rather than inventing a new one.
- **`src/repositories/nonGoalRotationRepo.ts`** — this session's own
  precedent for "a tiny per-user state table, read by every planner call,
  written only at the real weekly-regeneration boundary
  (`computeFreshWeek`)." The block-periodization phase would reuse this
  exact pattern for its own week-counter state.
- **Blueprint's `intensityTechniques` data**
  (`src/blueprint/snapshot/programming.json`, ~line 432) — drop-set,
  rest-pause, and myo-reps are already fully documented (what/when/when-not/
  fatigue implications) but typed `unknown[]` and completely unconsumed. The
  intensity-techniques phase would be substantially "wire up data that
  already exists" rather than authoring new coaching knowledge from scratch.
- **`PUSH_PHYSIQUE_TARGETS`/`PULL_PHYSIQUE_TARGETS`/`LEGS_PHYSIQUE_TARGETS`**
  (`src/engine/config.ts`) — the existing category lists, already reused
  once (goal-category-conflict fix). Structural-balance and pairing would
  both reuse these directly instead of inventing a second taxonomy.

## Roadmap

| # | Phase | Depends on | New persisted state? |
|---|---|---|---|
| 1 | Muscle-specific training profiles | — | No |
| 2 | Periodization waves & block structure (calendar-based) | 1 (nice-to-have, not hard) | Yes — small |
| 3 | Historical trend engine | — (independent of 2) | No (derives from existing data) |
| 4 | Reactive deloads & specialization blocks | 2 + 3 | Extends 2's state |
| 5 | Intensity techniques | — | Yes — schema field |
| 6 | Exercise pairing & deliberate rotation | — | Yes — small |
| 7 | Structural balance advisories | — | No |
| 8 | Individual profile factors (training age, injury exclusions) | — | Yes — profile fields |
| 9 (optional) | Adherence/preference weighting | 6 | Maybe |

Phases 1, 3, 5, 6, 7, 8 have no hard dependency on each other and could be
reordered if a different one is wanted first — this sequence just
front-loads the item that most directly explains "why sets/reps alone
hasn't worked" (periodization) while keeping phase 1 as a low-risk warm-up.

---

### Phase 1 — Muscle-Specific Training Profiles (full detail, first to build)

**Problem this closes:** Every muscle today gets the same universal
weekly-volume band and the same flat 2-sessions/week frequency reference
(confirmed — every single Blueprint development package uses
`sessions_per_week: 2`). A real coach trains calves, abs, and forearms more
often and often biases them toward higher reps; this app currently can't
express that at all.

**Design:**
- New config table in `src/engine/config.ts`, e.g.:
  ```ts
  export const MUSCLE_TRAINING_PROFILE_OVERRIDES: Partial<Record<BlueprintId, {
    frequencyPerWeek?: number;      // overrides the package's flat 2/week reference
    repRangeBias?: 'lower' | 'standard' | 'higher'; // which end of Blueprint's OWN authored reps_range to favor
  }>> = {
    'rectus-abdominis': { frequencyPerWeek: 4, repRangeBias: 'higher' },
    'obliques': { frequencyPerWeek: 4, repRangeBias: 'higher' },
    'gastrocnemius': { frequencyPerWeek: 4, repRangeBias: 'higher' },
    'soleus': { frequencyPerWeek: 4, repRangeBias: 'higher' },
    'forearm-flexors': { frequencyPerWeek: 3, repRangeBias: 'higher' },
    'forearm-extensors': { frequencyPerWeek: 3, repRangeBias: 'higher' },
    // extend as needed — this is a starting, editable coaching default set, not a closed list
  };
  ```
  Deliberately **never invents a rep number outside Blueprint's own authored
  `reps_range` string for the chosen exercise** — `repRangeBias` only picks
  which end of that existing range to lean toward (via the existing
  `parseRange` helper in `src/blueprint/developmentPackages.ts`), matching
  the codebase's "never guess a number Blueprint didn't author" discipline.
- **Frequency**: `developmentReferenceEngine.ts`'s `getDevelopmentReference`
  reads the override (if present) and substitutes it for
  `pkg.frequency.sessions_per_week` when computing
  `sessions_per_week_reference`, and recomputes `weekly_direct_set_reference`
  accordingly (`sum(exercise.sets) * effectiveFrequency`) so the two numbers
  never disagree.
- **Rep-range bias**: applied at the exercise-prescription step
  (`lookupExercisePrescriptionAnyLevel`/`parseRange`, called from
  `attemptSelection` in `workoutBuilder.ts`) — when a bias is present, resolve
  `reps_min`/`reps_max` from that exercise's own real Blueprint
  `reps_range` string by leaning to the low/high third of the parsed range
  instead of always taking the full authored range as-is.
- No new persisted state — pure config + a small read at two existing call
  sites.

**Files touched:** `src/engine/config.ts` (new export),
`src/engine/developmentReferenceEngine.ts` (frequency override),
`src/engine/workoutBuilder.ts` / `src/blueprint/developmentPackages.ts`
(rep-range bias application at the existing prescription-lookup site).

**Verification:** new unit tests proving (a) an overridden muscle's
`sessions_per_week_reference`/`weekly_direct_set_reference` reflect the
override while a non-overridden muscle is unaffected, (b) a biased muscle's
chosen `reps_min`/`reps_max` sits within Blueprint's own authored range but
shifted toward the requested end, (c) full regression suite baseline-diffed
against the current known-failure snapshot (established methodology this
whole session) shows zero new failures.

---

### Phase 2 — Periodization Waves & Block Structure (scope, detailed spec before build)

Introduces the missing concept of "which week of a training block is this,"
calendar-driven at first (e.g. 3 weeks ramping heavier/lower-rep or
higher-volume, 1 deload week, repeat) — no reactivity yet, that's Phase 4.
New per-user state (a small repo modeled directly on
`NonGoalRotationRepo`'s pattern: read by every planner call, written only at
`computeFreshWeek`'s real new-week boundary) tracks `weekIndexInBlock` and
`isDeloadWeek`. `volumeEngine.decideVolume` would gain an optional
`periodization_bias` input that scales the recommended sets down on a
deload week, and the rep-range-bias mechanism from Phase 1 gets reused to
wave reps heavier/lighter within Blueprint's own authored ranges. This is
the phase that most directly answers "why hasn't the same sets/reps approach
worked" — it makes the plan genuinely different week to week for the first
time.

### Phase 3 — Historical Trend Engine (scope)

Generalizes `goalPhaseEngine.ts`'s existing early-half/late-half load-trend
computation (currently narrow: one target per active goal, on-demand only)
into a reusable function any target can be asked about: "over the last N
real weeks, is this muscle's total volume load trending up, flat, or down."
Derives entirely from already-persisted data (`programs.target_allocations_json`
history + raw `workout_sets`) — no new tables, matching the codebase's
existing "derive from source of truth, never duplicate" discipline (see
`rebuildTargetAllocationsFromFinalSessions`'s own doc comment). Would ship
with no behavior change on its own — it's the sensing layer Phase 4 acts on.
Could be validated and shown to the user (e.g. a
`/api/programming/trends` read endpoint) before anything consumes it, to
sanity-check it reflects reality before it starts influencing decisions.

### Phase 4 — Reactive Deloads & Specialization Blocks (scope)

Upgrades Phase 2's calendar-based deload to a real one: if Phase 3's trend
engine shows genuine stalling or decline across multiple lifts for a target
(not just one bad session — matches the existing "declining trend" concept
already in `volumeEngine.ts`'s `'declining'` branch, which today only ever
recommends introspection, never acts), the block would deload early rather
than waiting for the calendar. Also adds specialization blocks: temporarily
raising one muscle's own volume/frequency ceiling for several weeks (reusing
the same per-user block-state table from Phase 2), at the deliberate expense
of feeling like everything else is "just maintained" during that window —
this needs the user's explicit input on which muscle and roughly how long
each time, not something the engine should pick on its own.

### Phase 5 — Intensity Techniques (scope)

Wires up Blueprint's already-authored drop-set/rest-pause/myo-reps
definitions (currently dead data, typed `unknown[]`, zero consumers) into
real prescriptions. Needs: (a) a proper typed model for
`BlueprintProgramming.intensityTechniques` replacing `unknown[]`, with an
adapter accessor; (b) new planned-side fields (e.g. `target_technique` on
`ExercisePerformance`, a matching field on `PlannedWorkItem`) threaded
through the exact construction chain the research identified
(`finalizePlacement` in `workoutBuilder.ts` → the `PlannedWorkItem`/
`PlannedExercise` interfaces → `buildWorkout`'s mapping → the
`ExercisePerformance` persistence shape); (c) a decision rule for *when* a
technique is appropriate, using Blueprint's own `suitable_exercise_types`/
`suitable_when_fatigue_cost_at_most`/`fatigue_time_implications` fields
(already authored) rather than inventing new criteria — likely gated to a
target's own last exercise of the session, matching the "when it may help"
guidance already in Blueprint's own text.

### Phase 6 — Exercise Pairing & Deliberate Rotation (scope)

Two related but separable pieces:
- **Rotation**: `exerciseSelector.ts`'s Gate 5 currently has an unconditional
  "current exercise wins if still valid" rule with no counterbalance — a
  small persisted per-target "weeks on this exercise" counter (new, small
  state, same repo pattern as Phase 2) would let a rotation rule force a
  swap after N weeks even though Gate 5 would otherwise keep it, using
  Blueprint's own `overlaps_with` field (already mostly populated with real
  exercise ids — confirmed structurally usable) to pick a real alternative
  covering the same target.
- **Pairing** (supersets/pre-exhaust): no infrastructure exists at all today
  — `plannedWork` is an unordered-by-pairing flat list, and exercise
  selection only ever considers one target at a time. This is the most
  architecturally invasive item on this list (a new cross-target decision
  step, a new `paired_with_exercise_id`-style field, and UI to show a pair as
  one unit) — recommend treating rotation and pairing as two separate
  sub-phases, building rotation first since it reuses more existing
  machinery.

### Phase 7 — Structural Balance Advisories (scope)

The simplest remaining phase, technically: sum `weekly_exposure` across
`PUSH_PHYSIQUE_TARGETS` vs `PULL_PHYSIQUE_TARGETS` (existing lists, already
proven reusable) for the week and surface a warning if the ratio drifts past
a threshold (e.g. push notably exceeding pull, a real shoulder-health
concern). Purely advisory at first — never auto-adjusts volume — matching
this codebase's own "recommend, don't auto-act" pattern already used for
declining-trend introspection. Could be moved earlier in the sequence if a
quick, low-risk phase is wanted in between two bigger ones.

### Phase 8 — Individual Profile Factors (scope)

Adds an explicit experience-level field to `training_profiles` (today it has
no such field at all) that scales the flat progression increment
(`PROGRESSION_INCREMENTS.weeklyExposureUnits`, currently a single constant
`2` for everyone) — a beginner gets bigger jumps, an advanced trainee smaller
ones. Given this app is single-user and the user is already an experienced
trainee, this phase's logic can initially be tuned and validated against
"advanced" behavior directly, then generalized into a real stored field once
useful (e.g. coming back from injury/layoff). Injury-history/exercise
exclusion (a real gap — no such list exists anywhere today) can piggyback on
the same phase as a smaller add-on: a simple excluded-target-ids list read
by `exerciseSelector.ts`'s Gate 1 feasibility check — build this part only
if/when there's an actual injury to work around, not speculatively.

### Phase 9 (optional/deferred) — Adherence & Preference Weighting

The fuzziest item — "don't prescribe an exercise the user dislikes" isn't
something the engine can infer, it needs explicit input (a disliked-exercise
list, reusing Phase 6's rotation alternative-lookup to avoid it). Recommend
deferring this until the other phases are live and there's a concrete list
of exercises the user actually wants excluded, rather than speculating now.

## Verification approach (every phase)

Matches the methodology already used throughout this project: `npm run
typecheck` clean, full `vitest` suite baseline-diffed against the current
known-failure snapshot (zero new failures required), new tests added
per-phase proving the new mechanism directly (not just "nothing broke"), a
written report + `docs/logs/` entry per phase, and no commit without the
user's review of that phase's own test results.

## Explicitly out of scope (per the user's own words)

RIR enforcement and exercise-form/technique cueing are deliberately excluded
from this roadmap — the user already manages both carefully outside the app
(studying muscle function/videos for form, consistently pushing a genuine
1-3 RIR) and considers them untrackable by software, not a gap to close here.

## Next step

This document is a proposal only. Once approved (in full, reordered, or
trimmed), Phase 1 would get a final implementation pass and ship first —
small, low-risk, and it directly sets up Phase 2's rep-range waving to have
sensible per-muscle defaults to wave around.
