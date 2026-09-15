# 2026-09-14 — Session Realism Cap + AI Coaching Guidance

Commit (this entry's own). Full detail in
`docs/SESSION_REALISM_CAP_AND_AI_COACHING_FIX_REPORT.md`. Follows
directly from log entries 54-56.

## Why

The prior two fixes made per-target volume division and carryover
correct, but a real gap remained: nothing limited how many different
muscles could share one session — a leg day could correctly divide
each of 5-6 muscles' own volume fairly and still total 13-20
exercises. The user explicitly authorized a deliberate, narrow
reversal of the Consolidated Fix's own "session size is never
limited" rule: a hard cap on exercise/muscle COUNT only (never time or
equipment), plus explicit instruction for the AI to reason like a real
coach rather than mechanically filling every eligible slot.

## What changed

- `src/engine/config.ts`: `SESSION_REALISM_CAP = { maxTargetsPerSession:
  4, maxExercisesPerSession: 9 }` — one source of truth for both the
  deterministic engine and AI validation.
- `src/engine/workoutBuilder.ts`: `applySessionRealismCap` trims each
  session to the cap, using the already-existing priority order
  (never re-ranked) — deferred targets become real, traceable
  `unmetDirectSets` via the same carryover machinery already fixed in
  entries 54-55, with zero new bookkeeping. A new `session_realism_cap`
  skip reason (`SkippedTarget.reason_code`, `friendlyExplanation.ts`)
  makes deferred targets visible rather than silently dropped, reusing
  the `'session'` scope the type system had explicitly reserved for
  exactly this case.
- `src/ai-programmer/service/aiProgrammerService.ts`: both AI system
  instructions gained a coaching-philosophy preamble (verbatim framing
  of the user's own request) and a new non-negotiable rule stating the
  same two hard numbers.
- `programmerAdequacyValidator.ts` / `weekReconciliationDomainValidator.ts`:
  enforce the same cap on AI output server-side — never trusting the
  instruction alone.

## A real bug caught by the engine's own safety net

The first cap implementation sliced kept candidates by raw array
position, which could split one target's own multiple exercise entries
between "kept" and "deferred" — the engine's own
`assertNoContradictoryProgramState` check (a target cannot be both
programmed and skipped) caught this immediately as a thrown error in
two existing tests. Fixed by grouping candidates by target before
deciding kept/deferred, so a target is always wholly kept or wholly
deferred, never split.

## Test fixture updates required

Two pre-existing tests (`sameWeekHistoryRecoveryFixRequiredTests
.test.ts` items 13-14) depended on a plain normal-development target
both receiving real same-week history AND still appearing in a capped
session — but giving a target real history *reduces* its own need,
which can push it below other untouched targets under the new 4-target
cap. Fixed by giving the tested target a real active goal, which keeps
it structurally prioritized regardless of the cap. One additional
failure (item 17) is unrelated pre-existing wall-clock-date drift,
confirmed by reverting all changes and reproducing it on baseline code.

## Verification

`npm run typecheck` / `npm run build` clean. Full suite baseline-diffed
against the session's established 229 pre-existing failures: zero new
failures.

## Not yet deployed

Implemented and tested locally only — awaiting explicit approval to
commit, push, and deploy.
