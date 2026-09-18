# 2026-09-18 — Intensity-Technique Context-Bloat Fix

Commit (this entry's own). Follows directly from log entry 61.

## Why

While showing the user a human-readable translation of the real AI Programmer
input (a follow-up to entry 61's coaching-depth wiring), a real context built
against the current code measured **397,083 characters** — the user recalled
prompt-token counts of ~30k from earlier in the session and asked why it had
grown 10x. Measuring the actual duplication (not guessing) found the cause:
`plausibleIntensityTechniques` embedded each suitable technique's full
what/whenToUse/whenNotToUse/fatigueImplications text on every exercise entry
it applied to. There are only 3 real techniques in Blueprint's own catalogue
(drop-set, rest-pause, myo-reps), but 324 suitability matches across one
realistic session's targets — the exact same ~200-300 char paragraphs,
byte-identical, repeated 55-174 times each. That's 298,702 of the 397,083
chars (75%) as pure, avoidable duplication. A full scan for any other
repeated-string bloat pattern above 40 chars found nothing else worth
fixing — every other repeat was either tiny (<3KB total) or genuinely
different per-target computed text that happens to read identically because
the underlying facts are identical (not a framing bug).

## What changed

- `AIProgrammerValidExerciseContext.plausibleIntensityTechniques`
  (`programmerContextTypes.ts`): full objects → `readonly string[]` (ids
  only).
- New `AIProgrammerContext.intensityTechniqueCatalogue`: every technique id
  actually referenced anywhere in the context, resolved to its full text
  exactly once, keyed by id.
- New shared `buildIntensityTechniqueCatalogue()` (`programmerContextBuilder.ts`),
  used by both `buildProgrammerContext` (generate_session) and
  `buildReconciliationContext` (reconcile_week) — the latter reuses the same
  `buildTargetContexts` output and had the identical bug, silently, the
  whole time; `AIReconciliationContext` gained the matching
  `intensityTechniqueCatalogue` field so nothing there is left as an
  unresolvable bare id.
- `aiProgrammerService.ts` rule 19 updated to tell the model to resolve an
  id against `context.intensityTechniqueCatalogue`.

## Measured result

Real context for a representative Monday push-day session: **397,083 →
112,802 chars (72% smaller)** — matches the ~30k-token figure the user
remembered, and the context-size diagnostic warning (`"context is large"`)
no longer fires for this scenario.

## Verification

`npm run typecheck` clean. Full suite diffed line-by-line against the
established baseline: exact match, 231/231 pre-existing (date-drift)
failures, zero regressions. No test referenced the old
`plausibleIntensityTechniques` shape by name, so none needed updating.

## Not yet deployed

Committed to the repo only, per this project's established practice of
confirming before deploying multi-file changes.
