# Change log: Phase 2 wrap-up — open-decisions.md rewrite, README/logs update

- **Date:** 2026-08-30

## What changed

- **`docs/open-decisions.md`** rewritten to reflect Phase 2's actual
  state rather than Phase 1.5's. Added a status legend (OPEN / PROPOSED /
  ADOPTED-PENDING-SIGN-OFF) and reorganized into Infrastructure /
  Training Exposure / Training Engine sections. Updated stale items:
  #6 (previously "effective-set methodology, nothing decided") now
  correctly reflects that Strategy A and the set-contribution rule are
  adopted and implemented, pending formal sign-off, and that what remains
  genuinely open is the Hypertrophy Volume and Functional Exposure models
  specifically. Added new items for the six engine decisions that block
  the stubbed modules (recovery methodology, frequency allocation,
  exercise-selection ranking, time-per-exercise estimation, plus the
  already-tracked volume/progression items), each pointing at the exact
  file/module it blocks.
- **`README.md`** updated: title and intro now say Phase 1/1.5/2, describe
  the Training Engine foundation and the implemented/blocked module
  split, add `docs/TRAINING_ENGINE_DESIGN.md` to the docs list, and add
  `src/engine/` and `src/lib/` to the repository layout.
- This file + updated `docs/logs/README.md` index — backfills log entries
  for the four Phase 2 commits made before this one, per the established
  per-change-log convention.

## Why

Keeps the durable, human-readable record (README, open-decisions, logs)
in sync with what Phase 2 actually built, rather than leaving it
describing Phase 1.5's state.

## Verification

- Read back `docs/open-decisions.md` end to end to confirm every item
  either points at a real file/module that exists, or is honestly marked
  OPEN with no code claiming otherwise.
- `npx vitest run` — 125/125 passing (no code changed in this step, docs
  only).
