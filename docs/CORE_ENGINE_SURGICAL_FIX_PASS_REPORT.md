# Final Core-Engine Surgical Fix Pass — Required Test Report

Per §23/§24 of the "FINAL CORE-ENGINE SURGICAL FIX PASS — Fix A/B/C +
Reproducible Verification" spec.

```
Install command:
npm ci

Verification command:
npm run verify

Exact result:
> workout-logger@0.1.0 verify
> npm run build && npm run typecheck && npm test

> workout-logger@0.1.0 build
> tsc -p tsconfig.json

> workout-logger@0.1.0 typecheck
> tsc --noEmit

> workout-logger@0.1.0 test
> vitest run

 Test Files  42 passed (42)
      Tests  416 passed (416)
   Duration  7.51s

Tests:
Total: 416
Passed: 416
Failed: 0
Skipped: 0

Build: PASS (tsc -p tsconfig.json — no errors)
Typecheck: PASS (tsc --noEmit — no errors)
```

This was run against a genuinely clean checkout: the working tree
(including the new, at-the-time-untracked
`tests/engine/coreEngineSurgicalFixPassTests.test.ts`) was archived via
`git archive` on a `git stash create` snapshot into a scratch directory
with no `node_modules`/`dist`/`.git`, so `npm ci` resolved every
dependency from scratch rather than reusing an already-populated
`node_modules`. Node v22.22.2, npm 10.9.7. No `package.json`/
`package-lock.json` dependency changes were required for this pass —
`verify` itself changed (Fix D: it now composes `build && typecheck &&
test`, since the project already had all three scripts); the toolchain
those three scripts need was already fully declared.

416 = the pre-existing 400 tests (all still passing unchanged — Fix A/B/C
introduced no regressions, confirmed by running the full suite both
before and after each fix) + 16 new `it`s in
`tests/engine/coreEngineSurgicalFixPassTests.test.ts`, covering the 13
required tests from §21 (some split into more than one assertion block
for clarity — see that file's own top-of-file comment and
`docs/logs/2026-09-01-42-core-engine-surgical-fix-pass.md` for the exact
mapping and the reasoning behind each scenario's numbers).

## Completion gate — status

All items pass:

- **Fix A** (final fitted sessions are the sole source of
  `targetAllocations`, via the new `rebuildTargetAllocationsFromFinalSessions`,
  called exactly once, after all resource/time fitting) — verified by
  Tests 1, 4, 8b.
- **Fix B** (only delivered sets are ever charged against remaining
  weekly need, for both progression-driven and time-fitting-driven
  reductions) — verified by Tests 2, 3, 4.
- **Fix C** (Blueprint package exercise count no longer floors or
  ceilings real exercise count; Blueprint-first selection still
  verified intact) — verified by Tests 5-8.
- **Fix D** (`npm ci` + a real, composed `npm run verify`) — verified by
  the exact commands/output above, executed for real, not claimed.

See `docs/logs/2026-09-01-42-core-engine-surgical-fix-pass.md` for the
full section-by-section account of what changed and why.

## Final stop

Every completion-gate item is satisfied by real, executed tests and a
real, executed clean-checkout verification run. Per the spec's own final
directive: the core engine is frozen again after this pass. Further work
moves to the Workout Logger UI — goal entry/confirmation/ranking, weekly
program display, workout logging, history/progression, Blueprint
integration, calorie-tracker integration, and using logged workout data
for calorie expenditure — not another cycle of engine redesign.
