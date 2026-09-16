# Legs-Session Exercise Cap — Implementation Report

## Why

Explicit user request, arising from the badminton-recovery-capacity
conversation earlier this session: legs already absorb real, unaccounted-for
fatigue from badminton (heavily lower-body — running, lunging, jumping,
direction changes) that the app's own volume targets never budgeted for. The
user asked for a separate, tighter exercise ceiling specifically for legs
sessions — 5 exercises instead of the general 9 — independent of, and in
addition to, the existing muscle-count ceiling (unchanged at 7 for every
session purpose, legs included).

## What changed

**`src/engine/config.ts`** — new `LEGS_SESSION_MAX_EXERCISES = 5` constant,
alongside the existing `SESSION_REALISM_CAP`. Kept as a separate export
(not folded into `SESSION_REALISM_CAP` itself) since it varies by session
purpose rather than being a single global number.

**`src/engine/workoutBuilder.ts`** — `applySessionRealismCap` now resolves
`maxExercisesForThisSession` per call: `LEGS_SESSION_MAX_EXERCISES` when the
day's `sessionPurpose` is `'legs'`, the general
`SESSION_REALISM_CAP.maxExercisesPerSession` otherwise. The muscle-count
ceiling (`maxTargetsPerSession`, 7) is completely unaffected — only the
exercise-count ceiling is purpose-dependent now. `sessionRealismSkipsFor`
takes the same `sessionPurpose` parameter so a deferred target's skip
message cites the correct ceiling (`"5-exercise"` on a legs day, `"9-exercise"`
elsewhere) rather than always reporting the general number.

**AI programmer enforcement** (same discipline as the original Session
Realism Cap — never trust the model's own instructions alone):
- `src/ai-programmer/validation/programmerAdequacyValidator.ts` — the
  single-session generation validator now checks
  `brief.session.purpose === 'legs'` and applies the tighter ceiling.
- `src/ai-programmer/validation/weekReconciliationDomainValidator.ts` — the
  week-reconciliation validator does the same per-day, keyed off
  `day.session.sessionPurpose`.
- `src/ai-programmer/service/aiProgrammerService.ts` — both system
  instructions (`buildProgrammerSystemInstruction` rule 26,
  `buildWeekReconciliationSystemInstruction` rule 18) now tell the model
  about the tighter legs-specific ceiling upfront, so a proposal is less
  likely to be generated over-budget and rejected after the fact.

All three enforcement points (deterministic engine, single-session AI
validator, week-reconciliation AI validator) read the same
`LEGS_SESSION_MAX_EXERCISES` constant — one source of truth, matching the
existing `SESSION_REALISM_CAP` pattern exactly.

## Regression: two pre-existing tests broken by the tighter cap

Both failures shared the same root cause: a fresh, no-active-goal fixture on
a real legs day has several real leg-region targets (`gluteus-maximus`,
`gluteus-medius-minimus`, `adductors`, `quads`, etc.) genuinely tied for
priority, and the 5-exercise budget is now tight enough that `quads` — each
test's actual subject — could lose the exercise-slot lottery to a
competing, untested muscle.

Diagnosed via direct debug instrumentation against each fixture (temporarily
added, then removed): `gluteus-maximus` alone was consuming 3 of the 5 slots
in the unmodified fixtures. Fixed by logging a small amount of real exposure
for `gluteus-maximus` via `cable-kickback-glute` — a genuinely isolated
exercise (`secondary_targets: []` in Blueprint's own data, verified before
choosing it) — so it drops out of top priority without touching `quads`'s
own exposure or last-trained date. (An earlier attempt using
`bulgarian-split-squat-hip-dominant` was rejected after discovering its own
Blueprint `secondary_targets` include quads — that exercise would have
silently given quads secondary credit and pushed it into a same-week
"not yet due" exclusion instead, a different and misleading bug.)

Fixed files:
- `tests/engine/finalPassRequiredTests.test.ts` (Test 8 — "a non-goal muscle
  with insufficient meaningful exposure receives normal-development
  consideration").
- `tests/routes/actualTrainingAdaptation.test.ts` (Scenario 1 — "completing
  a session exactly as planned triggers no unnecessary reallocation of a
  later, unlocked day") — fixed via a new shared `logGluteIsolationSession`
  helper, called before the test's own "before" snapshot.

## New regression coverage

- `tests/engine/sessionRealismCap.test.ts` — two new tests: a legs-purpose
  session with all 7 real leg-region targets eligible never exceeds 5
  exercises (while the muscle-count ceiling of 7 alone would allow all 7 a
  slot), and a push-purpose session in the same week keeps the general
  9-exercise ceiling, unaffected by the legs-only tightening.
- `tests/ai-programmer/programmerAdequacyValidator.test.ts` — two new tests:
  a legs-purpose proposal with 6 exercises is rejected (over the legs-only
  cap of 5, even though 6 is well under the general 9), and a push-purpose
  proposal with 6 exercises is accepted (unaffected by the legs-only rule).

## Verification

- `npm run typecheck`: clean.
- Full suite, baseline-diffed against the prior commit's own known-failure
  snapshot: **exact match, zero new failures, zero regressions** — every
  previously-passing test still passes, including the two fixed above.

## Deployment

Committed to the repo. **Not deployed** — deployment to production was not
requested.
