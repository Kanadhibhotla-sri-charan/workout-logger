# Training Engine Design

Design document for the deterministic Training Engine — the system that
will eventually answer:

> Given this person's goal, history, available days, available time,
> equipment, recovery state, and Blueprint knowledge, what should they do
> today?

This is a **design boundary, not a workout generator**. Per the spec that
requested it, the goal of this phase was not to build automatic
programming — it was to build the contracts, module boundaries, and
proposed (not adopted) rules that a later, explicitly-approved
implementation will use. See `docs/open-decisions.md` for the running
list of what needs Charan's sign-off before anything below marked
"proposed" or "not implemented" becomes real.

Companion document: `docs/TRAINING_EXPOSURE_MODEL.md` covers exposure/
volume/functional-exposure in full detail (§0-§G there) and is not
repeated here — this document covers goal resolution, training state,
constraints, and everything downstream of exposure.

## What's actually implemented vs. proposed vs. blocked

| Status | Meaning |
|---|---|
| ✅ **Implemented** | Real code, real tests, in `src/engine/`. Safe because it's a pure fact-check or query — no invented physiological/programming precision. |
| 📝 **Proposed** | A concrete rule or ranking order is written up below for review, but no code implements it. Marked so a reviewer can approve, reject, or amend it without needing to read code. |
| 🚫 **Blocked** | A module exists (`src/engine/`) with a real interface/type signature, but its function body throws `NotApprovedError` — see `src/engine/errors.ts`. Nothing about it is decided yet. |

## 1. The pipeline (§31)

```text
generateWorkout(input)
        ↓
resolveGoals()              ✅ src/engine/goalResolver.ts
        ↓
buildTrainingState()        ✅ src/engine/trainingState.ts
        ↓
calculateExposure()         ✅ src/engine/exposureEngine.ts
        ↓
prioritizeTargets()         ✅ folded into goalResolver's PriorityMap (primary/supporting tiers)
        ↓
allocateVolume()            🚫 src/engine/volumeEngine.ts
        ↓
applyFrequency()             🚫 src/engine/frequencyEngine.ts
        ↓
applyRecovery()               🚫 src/engine/recoveryEngine.ts
        ↓
applyTimeConstraint()          ✅ src/engine/constraintEngine.ts (budget primitives only — see §8 below)
        ↓
applyEquipmentConstraint()      ✅ src/engine/constraintEngine.ts
        ↓
selectExercises()                 🚫 src/engine/exerciseSelector.ts
        ↓
buildWorkout()                      🚫 src/engine/workoutBuilder.ts
        ↓
attachProgression()                   🚫 src/engine/progressionEngine.ts
        ↓
generateExplanation()                   ✅ src/engine/explanationEngine.ts (only for the ✅ decisions above)
```

There is no `generateWorkout()` entry point wiring these together — that
would be the actual generator, explicitly out of scope until the 🚫 rows
are approved. The pipeline exists as documentation and as the shape each
module's interface was designed against.

## 2. Module boundaries (§30)

| Module | File | Status | Blocked on |
|---|---|---|---|
| Goal Resolver | `src/engine/goalResolver.ts` | ✅ | — |
| Training State | `src/engine/trainingState.ts` | ✅ | — |
| Exposure Engine | `src/engine/exposureEngine.ts` | ✅ | — (Strategy A adopted, `docs/TRAINING_EXPOSURE_MODEL.md` §B) |
| Priority Engine | folded into `goalResolver.PriorityMap` | ✅ (single-goal only) | multi-goal composition — §5 below |
| Constraint Engine (equipment) | `src/engine/constraintEngine.ts` | ✅ | — |
| Constraint Engine (time) | `src/engine/constraintEngine.ts` | ✅ (budget arithmetic only) | per-exercise time estimation — §8 below |
| Volume Engine | `src/engine/volumeEngine.ts` | 🚫 | `hypertrophy-volume-model` |
| Frequency Engine | `src/engine/frequencyEngine.ts` | 🚫 | `frequency-allocation-model` |
| Recovery Engine | `src/engine/recoveryEngine.ts` | 🚫 | `recovery-methodology` |
| Exercise Selector | `src/engine/exerciseSelector.ts` | 🚫 | `exercise-selection-ranking` |
| Workout Builder | `src/engine/workoutBuilder.ts` | 🚫 | all four above |
| Progression Engine | `src/engine/progressionEngine.ts` | 🚫 | `progression-methodology` |
| Explanation Engine | `src/engine/explanationEngine.ts` | ✅ (only for ✅ decisions) | exercise-selection explanation blocked on Exercise Selector |

Every module is small, deterministic functions with explicit inputs and
outputs — no class with hidden mutable state (§30's explicit instruction).
`trainingState.ts` is the one intentional exception to purity: it's the
documented boundary layer that reads the database and hands plain data to
every pure function above it (§32).

## 3. Goal resolution (§7, §9)

```text
User Goal (local id)
    ↓
Goal.blueprint_ref
    ↓
Blueprint outcome/goal knowledge (AestheticOutcome | FunctionalGoal)
    ↓
PriorityMap (primary/supporting targets)
```

Implemented in `src/engine/goalResolver.ts` — see that file and
`docs/TRAINING_EXPOSURE_MODEL.md` §1 for the target taxonomy it resolves
against. The mandatory "arms look thin from the side" scenario (§9) is
proven end-to-end in `tests/engine/goalResolver.test.ts` and
`tests/fixtures/armSideThickness.test.ts` (from Phase 1.5), using the real
Blueprint outcome `arm-side-thickness` (primary: `brachialis-arm-thickness`,
supporting: `triceps`) — no exercise list is hard-coded anywhere in that
proof, exactly as required.

## 4. Goal types are not programmed identically (§8)

`buildPriorityMap` branches explicitly on `goal_type`:
- **Aesthetic**: resolves an `AestheticOutcome`, which has an authored
  primary/supporting target split.
- **Functional**: resolves a `FunctionalGoal`, which has no such split in
  Blueprint's data (see `docs/TRAINING_EXPOSURE_MODEL.md`'s Method
  section) — the functional goal id itself becomes the sole primary
  target. `tests/engine/goalResolver.test.ts` asserts this holds for
  every one of Blueprint's 7 functional goals, not just one example.

Whether Hypertrophy Volume and Functional Exposure end up needing
different aggregation *arithmetic* downstream (not just different
resolution) is still open — see `docs/TRAINING_EXPOSURE_MODEL.md` §0.

## 5. Goal priority model (§10)

Implemented (single goal): `PrioritizedTarget.tier` is `'primary'` or
`'supporting'`; anything else is implicitly `'neutral'`
(`goalResolver.tierOf`).

**📝 Proposed, not implemented — multi-goal composition.** The spec
requires the model to "allow one primary goal, multiple supporting goals,
[and] changing priority over time." Today, `TrainingState.active_goals`
can hold multiple `Goal` rows, each independently resolved to its own
`PriorityMap` (`TrainingState.priority_maps`) — but nothing *combines*
them into one ranked view (e.g. "target X is primary for goal A and
merely neutral for goal B — what's its overall priority today?"). A
`'deprioritized'` tier (mentioned in §10) has no rule at all: nothing in
Blueprint or this app's data currently justifies actively deprioritizing
a target, so no code invents one. This composition step is deliberately
left undecided — folding several goals' priorities into one ranking is
exactly the kind of judgment call §37 reserves for Charan.

## 6. Goal history (§11)

**Not implemented — interface requirement only, per the spec's own
instruction** ("define the data/interface requirements even if full
adaptive goal evaluation is deferred"). Today, `GoalsRepo` has no
`update`/`deactivate` method at all — a Goal row, once created, is
immutable in this codebase (only `active` is even a field, and nothing
sets it to `false` after creation). What a real goal-history feature would
need to record, so it's written down before it's built rather than
reverse-engineered later:

```text
goal_id
event_type: 'created' | 'activated' | 'deactivated' | 'priority_changed'
occurred_at
previous_priority (for priority_changed)
new_priority (for priority_changed)
```

Likely shape: an append-only `goal_history` table (mirroring how
`docs/logs/` works for this repo's own changes — a durable record of
transitions, not a mutable "current state" that overwrites its own past).
Not built in this change; `TrainingState.active_goals` currently reflects
only the present, not how goals got there.

## 7. Training State (§12)

Implemented: `src/engine/trainingState.ts`. Field-by-field against the
spec's list:

| Spec field | Where it lives in `TrainingState` |
|---|---|
| current program | `current_program` (most-recently-created `status: 'active'` Program) |
| current goals | `active_goals` + `priority_maps` |
| recent completed workouts | `recent_sessions` (all statuses in the fetch window — filter by `status` if "completed only" is needed) |
| weekly exposure | `weekly_exposure` |
| rolling exposure | `rolling_exposure` |
| recent exercise performance | derivable from `recent_sessions` (no separate field — would just duplicate the same data differently shaped) |
| training frequency | derivable by counting `recent_sessions` by date — not a precomputed field, since "frequency" needs a window definition that's the caller's to choose (same reasoning as exposure's explicit windows) |
| schedule / time availability / equipment / other activities | `training_profile` |

`current_program`'s "most recently created active program" rule is a
simple, explicit, deterministic tie-break — not a claim that it's the
*only* correct definition of "current." Multiple concurrent active
programs aren't modeled as a real scenario yet; if that becomes real,
this rule should be revisited deliberately, not silently relied upon
forever.

## 8. Weekly and rolling exposure (§13-14)

Fully covered in `docs/TRAINING_EXPOSURE_MODEL.md` §G — implemented,
explicit week boundary (`TrainingProfile.week_start_day`, never a silent
Monday assumption) and explicit rolling window
(`aggregateRollingExposure`'s `windowDays` parameter, no default at the
engine layer). `trainingState.ts` defaults the rolling window to 14 days
at the *application* boundary (a reasonable UI/API default, not a claim
about physiology), matching the spec's own example.

## 9. Recovery model (§15)

🚫 Blocked (`recoveryEngine.applyRecoveryConstraint`,
`recovery-methodology`). Inputs are specified in
`src/engine/recoveryEngine.ts`'s `RecoveryConstraintInput`: rolling
exposure for the target, days since it was last trained, and today's
other activities. **📝 Proposed direction, not adopted**: a conservative
rule shaped like "recent high exposure + short interval since last
trained → reduce priority, don't actively avoid" (matching the spec's own
example concept) is the most defensible starting point, because it only
ever *reduces* recommended work, never invents a claim about biological
recovery capacity. The actual thresholds (`what counts as "high"`, `what
counts as "short"`) are not proposed — those need real judgment this
document isn't making unilaterally.

## 10. Badminton / other activity constraint (§16)

`TrainingProfile.other_activity_schedule` (Phase 1.5) already models this
as data — `RecurringActivity { day, activity_type, notes }`, with
`activity_type` open (`'gym' | 'badminton' | 'rest' | 'other' | string`).
`recoveryEngine.RecoveryConstraintInput.other_activity_today` is the
intended read path once recovery logic exists. **Explicit non-assumption,
per the spec**: nothing in this codebase treats badminton (or any other
activity) as contributing hypertrophy volume to any muscle target — it is
purely a context/recovery-capacity input until an explicit, approved
mapping says otherwise (none exists).

## 11. Time constraint (§17)

✅ implemented: `constraintEngine.fitsWithinBudget` /
`remainingBudgetMinutes` treat a session's time budget as a hard
constraint (arithmetic only — not a scheduling algorithm).

🚫 **Not implemented and not proposed**: estimating how long a given
exercise/set actually takes. Blueprint has no per-set duration data (only
a coarse `setup_time: DemandLevel` label); this app has no logged
duration-per-set data either. Every downstream consumer
(`workoutBuilder`) needs this estimate to exist before it can do anything
useful with the budget-checking primitives — this is explicitly named as
a blocker in `workoutBuilder.ts`'s own doc comment, not silently assumed
away.

## 12. Equipment constraint (§18)

✅ fully implemented: `constraintEngine.isExerciseEquipmentFeasible` /
`filterEquipmentFeasible`, reading `TrainingProfile.available_equipment`
and matching Blueprint's own `engine/equipment.ts` exact-match-all-
required rule (see `docs/architecture.md` §1). This is the one constraint
in the whole pipeline that's both fully decided *and* fully implemented —
equipment availability is a plain fact, not a judgment call.

**📝 Proposed, not implemented — substitution.** When the ideal exercise
is unavailable, §18 wants a fallback chain: goal → required target →
available exercises → best compatible alternative. The "available
exercises" step is `filterEquipmentFeasible` (done); "best compatible
alternative" is a ranking decision that belongs to Exercise Selector
(§13, blocked).

## 13. Exercise selection (§19) and rotation (§20)

🚫 Blocked (`exerciseSelector.selectExercise`,
`exercise-selection-ranking`). **📝 Proposed ranking order, for review, not
adopted**: among exercises that already pass `filterEquipmentFeasible`
and fit the remaining time budget,

```text
1. target priority tier (primary before supporting — from PriorityMap)
2. avoid redundancy with exercises already selected this session
   (Blueprint's own overlaps_with field is the natural signal — see
   docs/architecture.md §1)
3. avoid repeating the same exercise used very recently
   (recent_exercise_ids, from TrainingState.recent_sessions)
4. (everything else — fatigue cost, user preference — undecided)
```

This is a proposal, not a formula with weights — turning "avoid
redundancy" and "avoid recent repetition" into an actual tie-break order
(which wins when they conflict?) is exactly the kind of ranking decision
reserved for approval. **Exercise rotation** (§20) inherits directly from
this: once selection is real, a change in the selected exercise must
always cite one of the spec's named deterministic reasons (equipment
unavailable, no longer fits constraint, excessive redundancy, progression
issue, goal changed, user preference, program phase change) — never
random rotation. `explanationEngine.explainExerciseSelection` is the
intended place that reason surfaces once selection exists.

## 14. Volume allocation (§21) and personalization (§22)

🚫 Blocked (`volumeEngine.allocateVolume`, `hypertrophy-volume-model`).
Explicit non-assumption already enforced in the module's own type
comments: Blueprint's generic guidance (e.g. "18-20 sets/week") must
never be copied directly as "do 18-20 sets today," and the upper end of a
range is never assumed optimal. **📝 Proposed factor list, no formula**:
personalization should eventually weigh current exposure (§8, done),
goal priority tier (§5, done), recovery constraint (§9, blocked),
frequency/available days (§15, blocked), and recent performance
(§17-progression, blocked) — but the actual arithmetic combining these
into one number is not proposed here. Inventing a "pseudo-scientific
formula merely to produce a number" is exactly what §22 forbids.

## 15. Frequency allocation (§23) and the 4-day PPL + Upper fixture (§24)

🚫 Blocked (`frequencyEngine.allocateFrequency`,
`frequency-allocation-model`). The distinction the spec requires — desired
weekly exposure vs. the number of sessions used to deliver it — is
already structural in the contract (`TrainingExposure` is exposure-only;
`WorkoutSession`/`ProgramSession` are the session-count side), so nothing
new needed to be added to represent it; only the allocation rule itself
is missing. Fixture C (§16 below) exercises the *data* side of this (goal
+ 4 gym days + 2 badminton days, configurable, not hard-coded) without
requiring the allocation rule to exist.

## 16. Workout construction (§25)

🚫 Blocked (`workoutBuilder.buildWorkout`) — depends on all four blocked
engines above, by design (see that file's doc comment). Its output shape
(`PlannedExercise[]`, `estimated_minutes`, `reasoning`) is specified so
the eventual logger integration has a stable target to build against.

## 17. Progression (§26) and actual vs. planned performance (§27)

🚫 Blocked (`progressionEngine.computeProgression`,
`progression-methodology`) for the *decision* (when/how to progress).

**Already true and enforced independent of this module**: planned and
actual performance are structurally distinct in this codebase and always
have been (Phase 1) — `ProgramSessionExercise.target_sets/
target_reps_min/target_reps_max` (the plan) vs. `ExercisePerformance.sets`
(logged `Set[]`, each with its own `completed` flag — the actual result).
Nothing anywhere in this codebase assumes a planned set was completed;
`WorkoutSessionsRepo.addExercisePerformance` only ever persists what was
actually reported. `progressionEngine.ProgressionInput.previous_actual_sets`
is typed to read this real history, by name, so a future implementation
can't accidentally wire it to the plan instead.

## 18. History feedback loop (§28)

```text
Goal → Plan → Workout → Actual performance → Training exposure → ??? → Next planning decision
```

The first half of this loop is real and tested: actual performance
(logged `Set[]`) already flows into Training Exposure
(`exposureEngine`/`trainingState`). The second half — exposure informing
"progress/performance trend" and then a next planning decision — doesn't
exist, because nothing yet computes a trend (that's Progression, §17,
blocked) or a next plan (that's Workout Builder, §16, blocked). The loop
is architecturally possible (nothing about the schema or module
boundaries blocks it) but not closed.

## 19. Explainability (§29)

✅ implemented for real decisions only:
`explanationEngine.explainExposureContribution` and
`explainEquipmentFeasibility` produce plain-text explanations built
directly from the same data the (real, decided) rule used — never an LLM
asked to invent a plausible-sounding reason after the fact (§33).
`explainExerciseSelection` throws, because there is no real selection
decision yet to explain honestly.

## 20. Pure deterministic interfaces (§32)

`trainingState.ts` is the only module in `src/engine/` that touches the
database. Every other module — `goalResolver`, `exposureEngine`,
`dateMath`, `constraintEngine`, `explanationEngine`, and all six 🚫
stubs — takes plain data in and returns plain data out, with no hidden
reads of global/database state. This is deliberate and tested: every
`tests/engine/*.test.ts` file constructs its inputs by hand rather than
seeding a database and letting the function query it (except
`trainingState.test.ts`, which is specifically testing the one impure
boundary).

## 21. No AI/LLM dependency (§33)

Still true, unchanged from Phase 1: zero AI/LLM calls exist anywhere in
this codebase, in `src/engine/` or otherwise. Every ✅ implemented
function above is plain deterministic TypeScript. If a future
conversational goal-entry feature is added ("my arms look thin from the
side" → `blueprint_ref: 'arm-side-thickness'`), that mapping step could
use an LLM, but the engine consuming the resulting structured Goal must
never depend on one being available — exactly the worked example in §33.

## 22. Required design decisions (§34) — where each is discussed

| Category | Discussed in |
|---|---|
| Direct/indirect exposure, completed vs. incomplete sets, exposure aggregation | `docs/TRAINING_EXPOSURE_MODEL.md` §A-D, §G |
| Hypertrophy volume (fractional weighting, RIR/RPE) | `docs/TRAINING_EXPOSURE_MODEL.md` §0, §E-F |
| Functional exposure | `docs/TRAINING_EXPOSURE_MODEL.md` §0 |
| Primary vs. supporting priorities, multiple goals, goal history | §5-6 above |
| Weekly boundary, rolling window, volume allocation, frequency allocation | §8, §14-15 above |
| Recovery (recent exposure, spacing, other activities) | §9-10 above |
| Constraints (time, equipment, preferences, unavailable movements) | §11-13 above |
| Progression (reps, load, sets, replacement, deload) | §17 above |

All of the above are also tracked as individual items in
`docs/open-decisions.md`, which is the authoritative place to see approval
status — this document explains the reasoning and options, that one
tracks what's been signed off.

## 23. Required test fixtures (§35)

All fixtures live under `tests/fixtures/` and are configurable scenarios
(never hard-coded as this app's permanent state — see
`docs/architecture.md`'s single-user-scope note on not baking personal
config into source).

| Fixture | Proves | Status |
|---|---|---|
| A — Basic hypertrophy (one target, simple isolation exercise) | `exposureEngine` on the simplest real case | ✅ built |
| B — Compound movement (multiple Blueprint targets) | Strategy A explicitly: full credit per listed target, no indirect exposure invented | ✅ built |
| C — Arm-side thickness (goal + 4 gym days + 2 badminton days) | Goal resolution + `TrainingProfile` schedule representation together; explicitly does NOT require a generated workout | ✅ built (data/state only, per the fixture's own stated scope) |
| D — Time constrained (30-40 min budget) | The budget is enforced as hard, not truncated arbitrarily | ✅ built for `constraintEngine`'s actual scope (budget arithmetic); the "prioritize goal-critical work" behavior itself is `workoutBuilder`'s job and is correctly NOT tested here since that module doesn't exist |
| E — Equipment constrained (remove preferred exercise's equipment) | `filterEquipmentFeasible` correctly excludes/includes | ✅ built |
| F — Recent high exposure | `aggregateRollingExposure` surfaces yesterday's session within a 14-day window even when the 7-day weekly total looks low | ✅ built |
| G — Actual vs. planned | A session's actual logged sets differ from what was planned, and this app reads the actual, never the plan, for anything exposure-related | ✅ built |

Fixtures D and F deliberately test only the implemented layer they
depend on (constraint arithmetic, exposure aggregation) rather than
asserting behavior of a workout generator that doesn't exist — see each
fixture file's own comment for exactly what it does and does not claim.

## 24. Acceptance criteria (§36)

- [x] Timezone/date semantics are documented. (`docs/architecture.md`)
- [x] Single-user scope is explicitly documented. (`docs/architecture.md`)
- [x] Training Exposure remains separate from hypertrophy volume. (`docs/TRAINING_EXPOSURE_MODEL.md` §0, distinct contract types)
- [x] Functional exposure is not assumed to equal hypertrophy volume. (`docs/TRAINING_EXPOSURE_MODEL.md` §0, distinct contract types)
- [x] Direct vs indirect contribution has an explicit approved strategy. (Strategy A adopted — pending Charan's formal sign-off, see `docs/open-decisions.md`)
- [x] No fuzzy text matching is used to invent canonical relationships. (verified: `exposureEngine` never reads `secondary_targets`)
- [x] Goal resolution works through local Goal → Blueprint reference. (`goalResolver.ts`, tested)
- [x] Training State has a defined deterministic interface. (`trainingState.ts`)
- [x] Weekly and rolling exposure have defined semantics. (`docs/TRAINING_EXPOSURE_MODEL.md` §G, implemented)
- [x] Recovery constraints have documented inputs/rules. (§9 above; rule itself is proposed, not adopted — by design)
- [x] Time is treated as a real programming constraint. (`constraintEngine.ts`, arithmetic only — per-exercise estimation is the documented gap)
- [x] Equipment is treated as a real programming constraint. (`constraintEngine.ts`, fully implemented)
- [x] The 4-day gym + 2-day badminton scenario exists as a test fixture. (Fixture C)
- [x] Actual performance is separated from planned performance. (structural since Phase 1; §17 above)
- [x] Progression requirements are documented. (§17 above, `progressionEngine.ts`'s interface)
- [x] Engine module boundaries are established. (§2 above)
- [x] Core engine functions are deterministic and testable. (§20 above; 82 new engine tests)
- [x] Explanations can be generated from deterministic decisions. (`explanationEngine.ts`, for the decisions that exist)
- [x] No LLM is required for programming. (§21 above)
- [x] The full automatic optimizer is not implemented until the design decisions are approved. (§30 table — 6 of 12 modules are 🚫 by design)

## 25. Developer vs. user responsibilities (§37)

Unchanged from the spec: this document and its 📝 proposals are exactly
that — proposals. Charan approves (or amends) exposure methodology
(mostly done via Strategy A, pending final sign-off), direct/indirect
treatment, hypertrophy-volume interpretation, functional-exposure
interpretation, goal-priority behavior, recovery philosophy, and
progression rules before any 🚫 module is implemented for real. See
`docs/open-decisions.md` for the tracked list. The user is not asked to
manually calculate training volume anywhere in this design.

## 26. Phase 2 output (§38)

```text
Blueprint Adapter        ✅ (Phase 1)
Training Profile         ✅ (Phase 1.5, extended: timezone, week_start_day)
Goal Resolver             ✅ (this phase)
Training State             ✅ (this phase)
Exposure Model               ✅ (this phase, extended from Phase 1.5)
Rule Specifications             📝 (this document + docs/TRAINING_EXPOSURE_MODEL.md)
Engine Interfaces                 ✅ (this phase — 12 modules, 6 real + 6 documented-blocked)
Test Fixtures                       ✅ (this phase, A-G)
Deterministic Core                    ✅ (everything ✅ above; zero AI/LLM anywhere)
```

## 27. Final principle (§39)

Blueprint already answers "what exercises are good for chest?" This app
is trying to answer "given everything known about this person, what's the
highest-value training work they should do today?" — and this phase's job
was to make sure that question can eventually be answered **correctly,
transparently, and reproducibly**, not to answer it yet. Six of twelve
engine modules deliberately still throw `NotApprovedError`. That is the
intended state of this phase, not an unfinished one.
