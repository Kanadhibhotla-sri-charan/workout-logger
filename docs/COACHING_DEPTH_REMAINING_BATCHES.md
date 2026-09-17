# Coaching Depth — Remaining Batches (Batch 3 onward)

Source of truth for scope: `docs/COACHING_DEPTH_PROGRAMMING_ROADMAP.md` (the
original 9-phase proposal). This document does not redefine any phase's
design — it groups the phases **not yet shipped** into a small number of
larger batches, to minimize the number of separate implement/verify/report
cycles given time constraints, while still respecting the roadmap's real
dependency chains. No code changes were made to produce this document.

**Consolidation approach:** the roadmap's own phase boundaries are mostly
about *risk isolation*, not hard technical necessity — only two dependency
chains are actually load-bearing (2 → 4, and 6a → 9). Everywhere else, the
roadmap splits phases apart for staged rollout caution, not because they
can't be built together. Given the goal here is fewer batches, this document
accepts the larger blast radius of building related, non-conflicting phases
in the same pass, and calls out explicitly where that raises risk relative
to the original one-phase-per-batch staging.

## What's already shipped (for context, not re-specified here)

| Roadmap phase | Status | Delivered by |
|---|---|---|
| Phase 1 — Muscle-specific training profiles | **Complete**, including live wiring | Batch 1 (profiles, read-only context) + Batch 2 (frequency reference + rep-range bias wired into `developmentReferenceEngine.ts`/`workoutBuilder.ts`) |
| Phase 3 — Historical trend engine | **Complete as designed** — observational only, no consumer yet | Batch 1 (`src/coaching/history/`) |

## Remaining phases and their real dependencies

| # | Phase | Hard dependency | New persisted state? |
|---|---|---|---|
| 2 | Periodization waves & block structure | Phase 1 (done) | Yes — small |
| 4 | Reactive deloads & specialization blocks | Phase 2 + Phase 3 (done) | Extends Phase 2's state |
| 5 | Intensity techniques | — | Yes — schema field |
| 6a | Exercise rotation | — | Yes — small |
| 6b | Exercise pairing / supersets | — | Yes — new field + UI |
| 7 | Structural balance advisories | — | No |
| 8 | Individual profile factors | — | Yes — profile fields |
| 9 (optional) | Adherence / preference weighting | Phase 6a | Maybe |

Only 2 → 4 and 6a → 9 are real chains. Everything else is free to combine.
That collapses the 7 remaining phases into **3 batches** instead of 8.

---

## Batch 3 — Periodization System (Phase 2 + Phase 4)

**Why combined:** Phase 4 is explicitly described in the roadmap as
"upgrading Phase 2's calendar-based deload to a real one" — it is not a
separate feature, it's the same block-state mechanism gaining a reactive
trigger. Building both in one pass means the block-state table, its repo,
and `volumeEngine.ts`'s deload-scaling logic are designed once for their
final shape (calendar **and** reactive triggers) instead of being retrofitted
in a second pass.

**Scope:**
- New per-user block-state repo (mirrors `NonGoalRotationRepo`'s pattern):
  tracks `weekIndexInBlock` and `isDeloadWeek`, read by every planner call,
  written only at `computeFreshWeek`'s real new-week boundary.
- Calendar-based cycle (e.g. 3 weeks ramping heavier/lower-rep or
  higher-volume, 1 deload week, repeat) — `volumeEngine.decideVolume` gains
  an optional `periodization_bias` input that scales sets down on a deload
  week; reuses Batch 1/2's `applyRepRangeBias` to wave reps within
  Blueprint's authored ranges across the block.
- Reactive trigger on top of the same table: if the already-built trend
  engine (`calculateBasicTrend`) shows genuine multi-lift stalling/decline
  for a target (matching `volumeEngine.ts`'s existing `'declining'` branch,
  which today only recommends introspection), the block deloads early
  instead of waiting for the calendar.
- Specialization blocks (temporarily raising one muscle's volume/frequency
  ceiling), reusing the same table — explicit user input for which muscle
  and how long, never engine-only.

**Files likely touched:** new `src/coaching/periodization/` module (types +
service + repo), `src/engine/volumeEngine.ts` (deload scaling + the
`'declining'` branch now acting, not just reporting), `src/engine/workoutBuilder.ts`
(reads block state for rep bias), `src/db/schema.sql` (new table), a small
explicit-input entry point (route + minimal UI) for specialization blocks.

**Verification:** tests proving a calendar deload week reduces sets, a
genuine multi-lift decline triggers an early deload while a single noisy
session does not (reusing the existing tolerance-band precedent), a ramp
week's rep bias shifts as designed, specialization blocks never trigger
without explicit input, full-suite regression diff against the current
baseline, one written report covering both mechanisms.

**Risk:** medium-high — the single biggest jump in this list, since it's
also the first batch where a *trend* is allowed to change volume/scheduling
(every prior batch's reports have stated this never happens). Combining
calendar and reactive deloads in one pass means this line gets crossed and
proven in one verification cycle rather than two — accept the larger blast
radius here deliberately, and give this batch's regression diff the closest
read of the three.

---

## Batch 4 — Exercise Variety & Preference (Phase 6a + Phase 6b + Phase 9)

**Why combined:** all three live in the same subsystem
(`exerciseSelector.ts`'s exercise-choice logic) and Phase 9 hard-depends on
Phase 6a's rotation lookup anyway, so there's no real saving from splitting
9 into a later batch — it rides along for free once 6a exists. Pairing (6b)
is architecturally the most invasive item in the whole roadmap, but it does
not conflict with rotation's mechanism (rotation decides *which* exercise;
pairing decides how two already-chosen exercises relate), so they can be
built side by side rather than sequentially.

**Scope:**
- **Rotation (6a):** Gate 5 in `exerciseSelector.ts` currently has an
  unconditional "current exercise wins if still valid" rule. A small
  persisted per-target "weeks on this exercise" counter (same repo pattern
  as Batch 3) forces a swap after N weeks, using Blueprint's own
  `overlaps_with` field (already populated) to pick a real alternative.
- **Pairing (6b):** a new cross-target decision step and a new
  `paired_with_exercise_id`-style field on `PlannedWorkItem`, plus UI to show
  a pair as one unit (supersets/pre-exhaust). No existing infrastructure for
  this today — `plannedWork` is currently an unordered flat list.
- **Adherence/preference (9):** an explicit user-provided disliked-exercise
  list that `exerciseSelector.ts` avoids, reusing 6a's rotation
  alternative-lookup to find a substitute rather than a second lookup path.

**Files likely touched:** new small repo for the rotation counter,
`src/engine/exerciseSelector.ts` (Gate 5 rotation exit + preference
avoidance), `src/engine/workoutBuilder.ts` (new pairing decision step,
likely a new function rather than extending `attemptSelection`),
`PlannedWorkItem`'s type, a small persisted preference list,
`public/logger.html`/`public/program.html` (pair display + preference UI).

**Verification:** tests proving rotation forces a swap after N weeks via a
real `overlaps_with` alternative and never before, a paired exercise is
placed adjacently and tagged correctly with unpaired exercises unaffected,
a disliked exercise is never selected once listed and selection is restored
when it's removed, full-suite regression diff, one written report.

**Risk:** high — pairing alone was flagged by the roadmap as the most
invasive single item on the list; bundling it with rotation means this batch
carries the largest new-surface-area of the three. Worth a deliberate
decision whether to still land pairing as a smaller follow-up slice inside
this same batch (ship rotation + preference first, pairing second) if the
combined diff turns out too large to review/verify confidently in one pass.

---

## Batch 5 — Programming Enrichment (Phase 5 + Phase 7 + Phase 8)

**Why combined:** none of the three touch the same code path or conflict
with each other — intensity techniques extend `PlannedWorkItem`/persistence,
structural balance is a pure read-only explainability addition, and
individual profile factors only affect the progression-increment constant.
They're bundled purely for batch-count efficiency, not because they share
mechanism; each is independently low/medium risk, so the combined risk is
additive rather than compounding.

**Scope:**
- **Intensity techniques (5):** a proper typed model for
  `BlueprintProgramming.intensityTechniques` (replacing today's `unknown[]`,
  zero consumers), new planned-side fields (`target_technique` on
  `ExercisePerformance`, a matching field on `PlannedWorkItem`) threaded
  through `finalizePlacement` → `PlannedWorkItem` → `buildWorkout`'s mapping
  → the `ExercisePerformance` persistence shape, gated by Blueprint's own
  `suitable_exercise_types`/`suitable_when_fatigue_cost_at_most`/
  `fatigue_time_implications` fields.
- **Structural balance advisories (7):** sum `weekly_exposure` across
  `PUSH_PHYSIQUE_TARGETS` vs `PULL_PHYSIQUE_TARGETS` (existing lists) and
  surface a warning past a threshold — purely advisory, never auto-adjusts
  volume.
- **Individual profile factors (8):** an explicit experience-level field on
  `training_profiles` (doesn't exist today) that scales
  `PROGRESSION_INCREMENTS.weeklyExposureUnits` (currently a flat `2` for
  everyone); optional injury-exclusion list read by Gate 1 in
  `exerciseSelector.ts`, built only if an actual injury arises.

**Files likely touched:** `src/blueprint/adapter.ts` (typed technique
accessor), `src/engine/workoutBuilder.ts` (`finalizePlacement`), the
`PlannedWorkItem`/`PlannedExercise`/`ExercisePerformance` types, a new field
on the existing decision-explanation object (structural balance), `src/db/schema.sql`
(profile experience field), `src/engine/config.ts` (profile-aware
increments), `src/engine/progressionEngine.ts`.

**Verification:** tests proving a technique only applies when Blueprint's
suitability fields allow it, the push/pull ratio warning fires correctly
without affecting volume, the progression increment scales per experience
level, full-suite regression diff, one written report covering all three.

**Risk:** medium overall (driven by intensity techniques touching the core
`PlannedWorkItem`/persistence shape many existing tests assert against);
structural balance and profile factors individually are low risk.

---

## Suggested ordering

**3 → 4 → 5**, matching the only two real dependency chains (2→4 lives
inside Batch 3; 6a→9 lives inside Batch 4). Batch 5 has zero dependency on
either and could run first if a lower-risk starting point is preferred —
in that case run **5 → 3 → 4** instead. Either way, no other reordering is
possible without breaking Batch 3's or Batch 4's own internal dependency.

## Verification approach (every batch, unchanged from Batches 1-2)

`npm run typecheck` clean, full `vitest` suite baseline-diffed against the
current known-failure snapshot (zero new failures required beyond the
existing, unrelated date-drift set documented in
`COACHING_DEPTH_BATCH_1_IMPLEMENTATION_REPORT.md` §9), new tests added
per-batch proving every new mechanism directly (not just "nothing broke"),
one written implementation report per batch, and no commit without the
user's explicit request and review of that batch's own test results.
