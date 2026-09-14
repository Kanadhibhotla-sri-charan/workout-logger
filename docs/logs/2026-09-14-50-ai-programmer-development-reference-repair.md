# 2026-09-14 — AI Programmer: Development-Reference/Volume Repair

Commit `83d3223`. Full detail in
`docs/AI_PROGRAMMER_DEVELOPMENT_REFERENCE_REPAIR_REPORT.md`; this entry
is the chronological summary.

## What prompted this

A real controlled-production Generate test (Tuesday, Push day) produced
a proposal that read like generic AI-invented accessory work — arm/
shoulder/core maintenance exercises at 2-3 sets each — rather than a
programmed Push session. A read-only architectural investigation
followed, tracing the full path from `POST /generate-session` through
context construction, prompt, parsing, and validation.

## What the investigation found

`programmerContextBuilder.ts` built context from real exposure/history
data (`assembleWeeklyPlanInput`, correctly reused) but never called
`developmentReferenceEngine.ts` (`getDevelopmentReference`,
`developmentPackageLevelFor` — the module that turns Efficient/Complete
Blueprint packages into an actual weekly-volume reference) or
`volumeEngine.ts` (`decideVolume` — the module that turns that
reference plus real exposure/recovery into a recommendation). Confirmed
by exhaustive grep: zero call sites for either module anywhere under
`src/ai-programmer/`. The AI also never learned a gym day's session
identity (Push/Pull/Legs/Upper) — `WeeklyProgramRepo` was queried only
for a boolean (`weekProgramExists`), never for the persisted session's
own `name`. Net effect: the AI independently invented both "which
muscles" and "how much volume," anchored only to a per-exercise
authored-prescription cap when one happened to exist for the exact
exercise chosen.

Terminology confirmed correct and unchanged:
`developmentPackageLevelFor(isSpecialization)` returns `'complete'` for
an active-goal target, `'efficient'` otherwise.

## The fix — no second volume engine

New `buildProgrammingBrief()` (`programmerContextBuilder.ts`) calls only
existing functions: `getDevelopmentReference`/`developmentPackageLevelFor`,
`decideVolume`/`classifyAestheticTrend`, `isTargetCompatibleWithPurpose`,
and `estimateMinutes` (exported from `workoutBuilder.ts`, one-line
change, no behavior change). Session identity is read from the already-
persisted `WeeklyProgramRepo` session `.name` for the target date —
never recomputed — so the AI path can never disagree with the
deterministic engine about which day is which.

`AIProgrammerContext` gained one new field, `programmingBrief`
(`programmerContextTypes.ts`): per-target development level, weekly
reference, per-exposure cap, current exposure, a `recommendedSessionSets
{min,max}` range, recovery adjustment, and session eligibility; plus a
session-level `{purpose, expectedCoverageTargetIds}` and an
`approxSessionSetBudget` derived from the real time budget.

New `programmerAdequacyValidator.ts`, wired into `generateSession()`
after domain validation, before persistence: session-identity coverage,
priority(goal)-target omission, under-prescription vs. the brief's own
floor, per-target Blueprint-cap violation, single-target dominance,
total-budget blowout. Deliberately bounds-based, never exact-match — an
exercise absent from every Blueprint package stays fully eligible; only
aggregate sets per target are ever inspected. New error:
`AIOutputAdequacyInvalidError` (502, `AI_OUTPUT_ADEQUACY_INVALID`).

## New tests

20 new: `programmingBrief.test.ts` (7 — Complete/Efficient assignment
against real Blueprint numbers, zero-volume build-up rule, session-
purpose eligibility, budget scaling), `sessionIdentityPropagation.test.ts`
(3 — reads the real persisted session name, null on non-gym/no-program
days), `programmerAdequacyValidator.test.ts` (8 — each rejection
category plus a flexible-exercise-selection acceptance case), and one
end-to-end rejection test each in `aiProgrammerService.test.ts` /
`aiProgrammerRoute.test.ts` proving an inadequate proposal never
reaches persistence, using real Blueprint numbers (a `upper-pec`
proposal exceeding its real 8-set Efficient per-exposure cap).

One pre-existing fixture regression surfaced and was fixed: a test in
`aiProposalRoutes.test.ts` whose single-exercise canned proposal became
legitimately inadequate once a real Push session identity was in play —
fixed by giving that one test an adequate fixture, not by weakening the
validator.

## Verification

Full suite diffed against a real-time `git stash` baseline at every
stage: zero new failures against the same ~229 pre-existing,
unrelated stale-calendar-date fixtures noted in the previous log entry.
`npm run typecheck` / `npm run build` clean. Deployed to production with
`AI_PROGRAMMER_ENABLED=false` first (unit file backed up, database
hash-verified unchanged), then flipped to `true` and health-verified
separately — see the next log entry for what the first live test found.
