# Session Realism Cap + AI Coaching Guidance — Implementation Report

## Why

The cross-week and aggregate-integrity fixes made per-target volume division and carryover correct, but exposed a separate, real gap: nothing limited how many *different* muscles could share one session. A leg day with 5-6 leg-region muscles, each correctly getting its own fair share, could still add up to 13-20 total exercises — not humanly realistic, and the deterministic engine's Consolidated Fix architecture had deliberately removed any session-size limit years earlier (time/equipment only). The user explicitly authorized a narrow, deliberate reversal of that specific rule: a hard cap on exercise/muscle *count* per session — never on time or equipment — plus explicit AI guidance to reason like a coach rather than mechanically filling slots.

## What changed

**1. `src/engine/config.ts`** — `SESSION_REALISM_CAP = { maxTargetsPerSession: 4, maxExercisesPerSession: 9 }`, `[DEFAULT]`, one source of truth for both the deterministic engine and AI validation.

**2. `src/engine/workoutBuilder.ts`** (deterministic engine) — `applySessionRealismCap`, applied per session inside `buildWeeklyProgrammingPlan`:
- `dayCandidates` already arrives priority-ordered (the main per-target loop processes `rankedTargets` in `compareRankings` order). Candidates are grouped by target first, then kept target-by-target (never splitting one target's own multiple exercise entries between kept/deferred — an early version of this did split them and was caught by the engine's own `assertNoContradictoryProgramState` invariant check) until either cap is reached.
- Deferred candidates are excluded from `plannedWork`, which means `rebuildTargetAllocationsFromFinalSessions` automatically counts them as unmet — the same carryover machinery (fixed in the two prior entries) picks them up with zero new bookkeeping.
- A new `session_realism_cap` reason code was added to `SkippedTarget`/`friendlyExplanation.ts`, using the `'session'` scope the type system had explicitly reserved for exactly this ("a genuinely day-specific decision; no current mechanism produces one... kept for when one legitimately exists" — this is that mechanism). Each deferred target gets a real, visible skip entry — reusing that target's own already-computed `decision` object, never re-derived.
- Blueprint's Efficient/Complete numbers are untouched — they still decide `desiredWeekly`/volume exactly as before; the cap only decides how many of an already-decided set of muscles/exercises fit in one session.

**3. `src/ai-programmer/service/aiProgrammerService.ts`** — both `buildProgrammerSystemInstruction()` and `buildWeekReconciliationSystemInstruction()` gained:
- A coaching-philosophy preamble (verbatim framing of the user's own request): think like a real coach — realistic exercise selection, recovery, variation, technique, session quality — not a bot filling every eligible slot; volume numbers/goals are fixed, but *how* to build the session is the model's own judgment; look back 14 real days of history, not just the current session/week, before deciding.
- A new non-negotiable rule stating the same two hard numbers (`4` targets / `9` exercises) as a ceiling the model must never exceed, with explicit instruction to defer rather than cram when they would otherwise be exceeded.

**4. Enforcement on AI output** (never trust instructions alone):
- `programmerAdequacyValidator.ts` (`generate-session`): rejects a proposal with more than 4 distinct targets or more than 9 exercises.
- `weekReconciliationDomainValidator.ts` (`reconcile-week`): the same check, applied per unlocked day across the whole week.

## Regression fixes required along the way

- **A genuine bug in the first cap implementation**: naively slicing the kept-candidates array at the 9-exercise boundary could split one target's own multiple exercise entries across "kept" and "deferred" — caught immediately by the engine's own `assertNoContradictoryProgramState` check (a target both programmed and skipped is a defect, not a valid outcome). Fixed by grouping candidates by target before deciding kept/deferred, so a target is always wholly kept or wholly deferred.
- **Two pre-existing tests** (`finalPassRequiredTests.test.ts` Tests 13/14, caused by the same splitting bug) now pass once fixed.
- **Two pre-existing tests** (`sameWeekHistoryRecoveryFixRequiredTests.test.ts` items 13/14) needed their own fixtures adjusted: giving a plain normal-development target real same-week history *reduces* that target's own priority (it's now better-served), which can push it below 4 *other*, untouched targets under the new cap — the opposite of what those tests needed to observe. Fixed by adding a real active goal on the target being tested, which keeps it structurally prioritized regardless of the cap (specialization targets aren't purely need-ranked).
- **One test failure is pre-existing and unrelated**: `sameWeekHistoryRecoveryFixRequiredTests.test.ts` item 17 relies on the real wall-clock date and fails on baseline code too (confirmed by reverting all changes and re-running it in isolation) — pure calendar drift, already part of this session's established 229-failure baseline category.

## Verification

`npm run typecheck` / `npm run build` clean. Full suite baseline-diffed against the session's established 229 pre-existing failures: **zero new failures** (228 shown in the final run only because one baseline failure — an unrelated wall-clock-sensitive scenario — happened to pass this time; confirmed via the sorted-diff, which shows only that one line removed, nothing added).

## Not yet deployed

Implemented and tested locally only, per the user's own review-before-deploy pattern established throughout this session. Awaiting explicit approval to commit, push, and deploy.
