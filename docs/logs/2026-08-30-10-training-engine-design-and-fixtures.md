# Change log: Phase 2 — Training Engine design doc + required test fixtures A-G

- **Date:** 2026-08-30
- **Commit:** `00db37e`

## What changed

- **`docs/TRAINING_ENGINE_DESIGN.md`** (new) — the main Phase 2 design
  document. Covers the pipeline (§31) and module boundary table (§30)
  with each stage's real status; goal resolution and why the two goal
  types don't share logic (§7-9); the goal priority model, explicitly
  scoped to single-goal today with multi-goal composition and goal
  history documented as open interface requirements rather than built
  (§10-11, per the spec's own instruction to define requirements even
  when deferring full implementation); Training State field-by-field
  (§12); recovery/badminton/time/equipment constraints each marked
  proposed vs. decided (§15-18); exercise selection, volume, frequency,
  and progression, each with the specific open decision blocking it and,
  where useful, an explicitly-labeled proposal for review rather than a
  unilateral answer (§19-27); the history feedback loop's current
  half-open state (§28); a consolidated cross-reference into
  `docs/open-decisions.md` (§34); fixture-by-fixture status (§35); and
  the full §36 acceptance criteria checklist, checked against what
  actually exists in the repo.

- **`tests/fixtures/`** — the seven required fixtures (§35), each stating
  its own scope explicitly wherever the spec's description implies
  behavior from a workout generator that doesn't exist yet:
  - **A** basicHypertrophy — one target, isolation exercise.
  - **B** compoundMovement — multiple targets, full (not fractional)
    credit each under Strategy A; explicit proof that free-text
    `secondary_targets` is never read as an exposure signal.
  - **C** armSideThicknessSchedule — the real `arm-side-thickness` goal
    resolved alongside a configurable 4-gym/2-badminton
    `TrainingProfile`, run twice with different schedules to prove
    nothing is hard-coded to "4 and 2."
  - **D** timeConstrained — the time budget as a hard ceiling
    (`constraintEngine` only; prioritizing which work survives a tight
    budget is `workoutBuilder`'s unbuilt job).
  - **E** equipmentConstrained — removing required equipment makes an
    exercise infeasible while a same-target alternative stays feasible
    (`constraintEngine` only; picking the *best* alternative is
    `exerciseSelector`'s unbuilt job).
  - **F** recentHighExposure — constructs the exact failure mode the
    spec names (a heavy session a calendar-week total misses) and proves
    a rolling window catches it.
  - **G** actualVsPlanned — planned 3×8 vs. actual 8/8/5: proves the plan
    and the logged result are stored separately, an incomplete set is
    never silently corrected toward the plan, and exposure reads only
    the actual completed sets.

## Why

Completes the spec's required design-decision documentation (§34) and
required test fixtures (§35) — the two remaining checklist items after
the engine module boundary itself was established.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run` — 125/125 passing (16 new fixture tests).
- Cross-checked every "✅ built" fixture claim in
  `docs/TRAINING_ENGINE_DESIGN.md` §23 against the actual test file
  before writing it into the doc, to avoid the doc overclaiming what
  exists.
