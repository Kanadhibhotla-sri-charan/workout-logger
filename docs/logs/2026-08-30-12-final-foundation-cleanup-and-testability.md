# Change log: Final Phase 2 cleanup — terminology fix + testability contract

- **Date:** 2026-08-30
- **Commit:** `514badb`
- **Source:** `workout_programmer_phase2_final_foundation_fixes.md`, a
  final small cleanup pass requested before Training Methodology
  Decisions begin. The Phase 2 foundation was confirmed structurally
  sound; this pass is wording accuracy + reproducible testability, not
  architecture change.

## What changed

**Terminology (spec §1-7):** "ADOPTED" / "ADOPTED — PENDING SIGN-OFF"
implied a decision had been made; it hadn't — only a conservative
engineering placeholder existed. Replaced throughout
`docs/TRAINING_EXPOSURE_MODEL.md`, `docs/TRAINING_ENGINE_DESIGN.md`,
`docs/open-decisions.md`, and `src/engine/exposureEngine.ts`'s comments
with a new **IMPLEMENTED — PROVISIONAL** status (🔶 in the design doc's
legend, distinct from ✅ Implemented-as-fact): the code is real and
tested, but the underlying rule (Strategy A conservative exposure,
completed-set-to-`exposure_units`) is not approved as final
training/physiology methodology. Added the spec's required exact framing
sentences: `docs/TRAINING_EXPOSURE_MODEL.md` §B now states Strategy A
"is the current provisional implementation because the current Blueprint
snapshot provides canonical exercise targets but does not provide
reliable fractional contribution weights for all secondary targets," and
`docs/open-decisions.md` #6 states "how indirect contribution should be
handled is a core Training Engine methodology decision for the next
phase." No code behavior changed. Re-checked spec §3-7 for regressions
(indirect-contribution framing, Training/Hypertrophy/Functional Exposure
still kept as separate types with no arbitrary functional rules added,
local-Goal-vs-Blueprint-goal architecture untouched, single-user scope
untouched, timezone contract still consistent across session creation,
date queries, completed-workout dates, and the Calorie Tracker export
default) — none found.

**Testability (spec §8-21), the critical part of this pass:** a prior
review of an uploaded repository snapshot could not run `npm test`
because dependencies weren't installed in that snapshot, so test-pass
claims in this repo's own history could not be independently verified
from that artifact. Response:

- `package.json`: added `npm run verify` (`typecheck && test`).
- `TESTING.md` (new): prerequisites, install/test/typecheck/verify
  commands, and an explicit offline-behavior section — Blueprint tests
  use the committed versioned snapshot (`src/blueprint/snapshot/`, never
  a live clone during `npm test`), Calorie Tracker export tests use only
  this repo's own in-memory database (no live service), the CSV
  migration dry-run tool is tested against an inline synthetic fixture
  (not the real, inaccessible `food_and_workout_tracker` CSV), and every
  test opens a fresh `:memory:` SQLite database — no state carried
  between runs, nothing to reset by hand. A troubleshooting section
  covers only things actually encountered in this repo.
- `README.md`: local-dev steps no longer imply `sync-blueprint` must run
  before `npm test` (it doesn't — the snapshot is already committed);
  added a concise Testing section linking to `TESTING.md`.

## Why

Makes the repository's test-pass claims independently reproducible by
whoever reviews it next, without relying on trusting this session's own
report — directly answering the spec's core complaint.

## Verification — commands actually executed, not claimed

**Environment:** Node v22.22.2, npm 10.9.7, Linux (container), single-user
local checkout, no CI.

In the working tree, before committing:
```
npm run typecheck   PASS   exit 0
npm test            PASS   23 test files, 125/125 tests, exit 0
```

**Critical step — a genuinely clean clone**, independent of this working
tree's `node_modules`: cloned `https://github.com/Kanadhibhotla-sri-charan/workout-logger.git`
fresh into a scratch directory, confirmed `git rev-parse HEAD` matched the
just-pushed commit `514badb`, then from that clean checkout:
```
npm install          PASS   172 packages added, exit 0
npm run typecheck    PASS   exit 0
npm test             PASS   23 test files, 125/125 tests, exit 0
npm run verify       PASS   125/125 tests, exit 0
npm run build        PASS   exit 0 (tsc -p tsconfig.json, bonus check beyond what was required)
```
Scratch directory deleted after verification. No step above required a
credential, a database file prepared in advance, or a live external
service.
