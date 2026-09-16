# 2026-09-16 — Legs-Session Exercise Cap

Commit (this entry's own). Full detail in
`docs/LEGS_SESSION_EXERCISE_CAP_FIX_REPORT.md`. Follows directly from log
entry 59.

## Why

Explicit user request, arising from the badminton-recovery-capacity
conversation: legs already absorb real fatigue from badminton the app's
volume targets never account for. Rather than change the volume target
itself (a separate, harder design question, still open), the user asked for
a narrower, immediate step — a tighter exercise-count ceiling specifically
for legs sessions.

## What changed

- `src/engine/config.ts`: new `LEGS_SESSION_MAX_EXERCISES = 5`, separate
  from the general `SESSION_REALISM_CAP.maxExercisesPerSession` (9), since
  it varies by session purpose. The muscle-count ceiling (7) is unchanged
  for every purpose, legs included.
- `src/engine/workoutBuilder.ts`: `applySessionRealismCap`/
  `sessionRealismSkipsFor` resolve the effective exercise ceiling from the
  day's own `sessionPurpose` — 5 on a legs day, 9 otherwise.
- Both AI validators (`programmerAdequacyValidator.ts`,
  `weekReconciliationDomainValidator.ts`) and both AI system instructions
  (`aiProgrammerService.ts`) updated to enforce and announce the same
  legs-specific ceiling — one constant, three enforcement points, matching
  the original Session Realism Cap's own discipline.

## Regression: two pre-existing tests broken by the tighter cap

Both were fresh, no-goal fixtures where several real leg-region targets
(gluteus-maximus, gluteus-medius-minimus, adductors, quads) genuinely tie
for priority, and the 5-exercise budget is now tight enough that quads (each
test's real subject) could lose the exercise-slot lottery. Fixed by logging
a small amount of exposure for gluteus-maximus via a genuinely isolated
exercise (cable-kickback-glute, verified `secondary_targets: []` in
Blueprint's own data) so it drops out of top priority without touching
quads's own exposure or last-trained date — an earlier attempt using a
different exercise was rejected after discovering it secondarily credited
quads too, which would have caused a different, misleading failure.

## Verification

`npm run typecheck` clean. Full suite baseline-diffed against the prior
commit's own known-failure snapshot: exact match, zero new failures, zero
regressions. Four new tests added (two in `sessionRealismCap.test.ts`, two
in `programmerAdequacyValidator.test.ts`) directly proving the legs-specific
ceiling and that other session purposes are unaffected.

## Also added this session: a proposed roadmap, not yet built

`docs/COACHING_DEPTH_PROGRAMMING_ROADMAP.md` — a 9-phase plan for
periodization, muscle-specific training profiles, a historical trend
engine, reactive deloads, intensity techniques, exercise pairing/rotation,
structural-balance advisories, and individual profile factors, discussed
and researched this session but explicitly not yet approved for
implementation. Recorded here so the roadmap document's own arrival in the
repo has a log entry, same as any other change — no code changes were made
for it.

## Not yet deployed

Committed to the repo. Deployment to production was not requested.
