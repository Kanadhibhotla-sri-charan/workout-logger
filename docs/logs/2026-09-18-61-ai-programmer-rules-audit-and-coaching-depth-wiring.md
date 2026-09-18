# 2026-09-18 — AI Programmer Rules Audit and Coaching-Depth Signal Wiring

Commit (this entry's own). Full detail, including the model-evaluation
findings and the deferred reasoning-setup decision, in
`docs/AI_PROGRAMMER_RULES_AUDIT_AND_COACHING_DEPTH_WIRING_REPORT.md`. Follows
from log entry 60 and the `COACHING_DEPTH_PROGRAMMING_ROADMAP.md` it
introduced.

## Why

A model evaluation run (built to debug an unrelated generation-timeout bug)
surfaced that the Coaching Depth roadmap's 9 phases were built at the
deterministic-engine level but almost none of that signal ever reached the
AI's own context — and the system instruction itself had grown to 26 rules,
several defensively over-specified. User's explicit action plan: sharpen the
rules and wire the buildable signals into AI-visible context first, as
plumbing, before deciding between two candidate "genuine reasoning setup"
approaches for the model itself (deferred, not started).

## What changed

- `src/ai-programmer/service/aiProgrammerService.ts`: `buildProgrammerSystemInstruction()`
  rewritten, 26 rules → 23. 17 hard rules, then 6 rules (18–23) explicitly
  labeled as genuine coaching judgment calls with an evidence-citation
  requirement — exercise pairing, rotation, structural-balance response, and
  intensity-technique application were deliberately kept as AI judgment
  rather than hardened into deterministic triggers (full rationale in the
  report).
- `src/engine/config.ts`: new `sessionRealismCapFor()` — one shared source of
  truth for the leg+abs session-size exception (5 muscles/5 exercises on a
  legs day, 8 exercises if abs is also present, still capped at 5 leg
  exercises), replacing the flat legs-only cap from log entry 60.
- `src/engine/workoutBuilder.ts`, `src/ai-programmer/validation/programmerAdequacyValidator.ts`,
  `src/ai-programmer/validation/weekReconciliationDomainValidator.ts`: all
  four cap-enforcement call sites now read from `sessionRealismCapFor`.
- `src/ai-programmer/context/programmerContextBuilder.ts`,
  `programmerContextTypes.ts`: six new/wired signals — rep-range bias baking,
  training experience, structural advisories, antagonist pairing, intensity-
  technique suitability, exercise-rotation signal. Removed dead
  `availableEquipment`/`executionContext` data no rule depends on anymore.
- `src/engine/intensityTechniques.ts`: `isExerciseSuitable` exported for
  reuse by the context builder.
- `scripts/modelEval.mjs`: committed — the real-context model evaluation
  harness built this session, kept as a reusable tool rather than discarded.

## Verification

`npm run typecheck` clean. Full suite (`npx vitest run`, 1729 tests) diffed
line-by-line against `/tmp/failures_deloadfix.txt`: exact match, 231/231
pre-existing (date-drift) failures, zero new regressions. New/rewritten
tests: `tests/engine/sessionRealismCap.test.ts` (9/9),
`tests/ai-programmer/programmerAdequacyValidator.test.ts` (13/13),
`tests/ai-programmer/systemInstructionAllocationContract.test.ts` fully
rewritten to assert the same underlying safety properties against the new
rule text (old version pinned exact phrasing the audit deliberately changed)
— 8/8 passing.

## Not yet done

The two "genuine reasoning setup" approaches (dedicated reasoning-tuned
model vs. a two-step reason-then-commit pipeline) remain an open decision,
deliberately deferred until this plumbing landed — see report §6. Not yet
deployed to production; only committed to `main`, per explicit instruction.
