# Change log: Phase 2 §3-6 — Training Exposure model extended, goal resolver + exposure engine

- **Date:** 2026-08-30
- **Commit:** `62a9aaf`

## What changed

- **`docs/TRAINING_EXPOSURE_MODEL.md` extended** with a new §0 explicitly
  separating three concepts the spec warned must not be conflated:
  Training Exposure (neutral, goal-agnostic — this document's rules),
  Hypertrophy Volume (goal-specific, physique — not computed), Functional
  Exposure (goal-specific, functional goals — not computed, and NOT
  assumed to share Hypertrophy Volume's arithmetic). Added §1 ("what is a
  target?") and adopted Strategy A (conservative, canonical-only) for
  direct/indirect contribution in §B, with Strategy B (extending
  Blueprint itself) written up as the alternative and explicitly left for
  Charan if preferred.

- **Contract changes** (`src/contracts/types.ts`, `CONTRACT_VERSION`
  `1.1.0` → `1.2.0`): `TrainingExposure.effective_sets` renamed to
  `exposure_units` — deliberately not "effective sets," which implies
  physiological precision a flat count doesn't have (§6 of the spec).
  Added `HypertrophyVolume` and `FunctionalExposure` as new, separate,
  still-uncomputed types so the §0 distinction is visible in code, not
  just prose. Added `TrainingProfile.week_start_day` (a `Weekday`, stored
  data — the spec explicitly warns against silently assuming Monday).

- **`src/engine/exposureEngine.ts`** (new): implements the now-adopted
  rules A (direct exposure), C (set contribution — full `exposure_units`
  credit per listed target), D (uncompleted sets — zero exposure), and G
  (weekly/rolling aggregation) as pure functions. Weekly aggregation uses
  the configurable `week_start_day`; rolling aggregation takes an
  explicit `windowDays` with no silent default.

- **`src/engine/goalResolver.ts`** (new): `buildPriorityMap(goal)`
  resolves a Goal to primary/supporting Blueprint targets. Aesthetic
  goals use the resolved `AestheticOutcome`'s authored
  primary/supporting split; functional goals have no such split in
  Blueprint's data, so the functional goal id itself becomes the sole
  primary target — the two goal types are not run through identical logic
  (spec §8), verified against all 7 real functional goals.

- **`src/engine/dateMath.ts`** (new): pure calendar-day arithmetic
  (`addDays`, `weekRangeContaining`, `rollingRangeEnding`), parsing dates
  as UTC midnight to avoid DST ambiguity for what is purely day counting.

## Why

Closes the exposure-methodology gap flagged as the most important next
step in Phase 1.5, and gives the rest of Phase 2's engine work a real,
adopted (not just documented) foundation to build on for the parts that
don't require inventing physiological precision.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run` — 82/82 passing (39 new: `goalResolver.test.ts`,
  `exposureEngine.test.ts`, `dateMath.test.ts`).
