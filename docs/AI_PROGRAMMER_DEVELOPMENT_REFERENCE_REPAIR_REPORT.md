# AI Programmer — Development-Reference/Volume Repair

Covers three commits on `main`, in order:

- `3f2eda4` — server-side duplicate-generation guard
- `83d3223` — deterministic development-reference/volume repair (this document's main subject)
- (this commit) — allocation-contract prompt correction, following a live production test of `83d3223`

No architectural rewrite in any of the three — see "Non-goals" at the end.

## The defect

A read-only investigation of the real `generate-session` path (prompted by a live Tuesday Push proposal that looked like generic AI-invented accessory work rather than a programmed Push session) found that AI generation built its context from raw exposure/history facts (`assembleWeeklyPlanInput`, reused correctly) but never invoked `developmentReferenceEngine.ts`/`volumeEngine.ts` — the modules that turn those raw facts into an actual Efficient/Complete weekly-volume reference and a real per-target recommendation (`getDevelopmentReference`, `decideVolume`). Confirmed by exhaustive grep: those two modules, and the session-identity module (`sessionPurpose.ts`), had zero call sites anywhere under `src/ai-programmer/`. The AI also never learned which session identity (Push/Pull/Legs/Upper) a gym day actually was — `programmerContextBuilder.ts` queried `WeeklyProgramRepo` only for a boolean (`weekProgramExists`), never for the persisted session's own `name` (`sessionPurpose`, written verbatim by `weekProgramReconciliation.ts`).

Net effect: the AI independently invented both "which muscles" and "how much volume," anchored only to a per-exercise authored-prescription cap when Blueprint happened to author one for the exact exercise chosen — never a weekly-reference or session-level floor, and never a session-identity constraint.

**Terminology note, confirmed correct and unchanged by this repair:** `developmentPackageLevelFor(isSpecialization)` (`src/engine/developmentReferenceEngine.ts`) returns `'complete'` for an active-goal (specialization) target and `'efficient'` otherwise — Complete = goal-oriented/stronger emphasis, Efficient = non-goal/economical. This repair does not touch that mapping.

## The fix (`83d3223`)

**No second volume engine — pure reuse.** One new pure function, `buildProgrammingBrief()` (`src/ai-programmer/context/programmerContextBuilder.ts`), calls only:
- `getDevelopmentReference` / `developmentPackageLevelFor` (`developmentReferenceEngine.ts`)
- `decideVolume` / `classifyAestheticTrend` (`volumeEngine.ts`)
- `isTargetCompatibleWithPurpose` (`sessionPurpose.ts`)
- `estimateMinutes` (`workoutBuilder.ts` — exported, one-line change, no behavior change)

Session identity is **read, never recomputed**: `programmerContextBuilder.ts` now also reads the target date's `WeeklyProgramRepo` session `.name` (the exact `sessionPurpose` value already persisted for the week) rather than deriving it independently — so the AI path can never disagree with the deterministic engine about which day is Push/Pull/Legs/Upper.

`AIProgrammerContext` gained one new field, `programmingBrief` (`programmerContextTypes.ts`), carrying per-target `developmentLevel`, `weeklyDevelopmentReference`, `directSetsPerExposureCap`, `currentWeeklyDirectSets`/`currentWeeklySecondarySets`, `volumeAction`, `recommendedWeeklyPrimarySets`, `recommendedSessionSets {min,max}`, `recoveryAdjustment`, `eligibleForThisSession`, plus a session-level `{purpose, expectedCoverageTargetIds}` and `approxSessionSetBudget`.

New validator (`src/ai-programmer/validation/programmerAdequacyValidator.ts`), wired into `AIProgrammerService.generateSession()` after domain validation and before persistence: checks session-identity coverage, priority(goal)-target omission, under-prescription relative to the brief's own floor, per-target Blueprint-cap violation, single-target dominance, and total-session-budget blowout. Deliberately **range/bounds-based, never exact-match** — an exercise absent from every Blueprint package remains fully eligible; only aggregate sets per target are ever inspected, never which exercise delivered them. New error: `AIOutputAdequacyInvalidError` (502, `AI_OUTPUT_ADEQUACY_INVALID`), same safe-error convention as the existing `AIOutputDomainInvalidError`.

## Live production test of `83d3223` and what it found

With `AI_PROGRAMMER_ENABLED=true` on production, one real `generate-session` call for Tuesday 2026-09-15 (Push) was attempted twice (the first attempt failed on provider-side invalid JSON, unrelated to this repair; retried once per the standing "retry only if a proposal was never produced" rule). **The second attempt's adequacy validator correctly rejected the output**: the model chose 2–3 sets for `upper-pec`/`side-delt`/`triceps`/`triceps-long-head` against real deterministic floors of 7–8 (efficient) and 8–12 (complete, active-goal) sets — exactly the failure mode this repair set out to catch. No proposal was persisted either time; the database was verified byte-identical (hash-compared across all six affected tables) before and after both attempts.

This proved two things at once: the new deterministic guidance and validator are real and load-bearing (confirmed independently by inspecting the actual serialized `programmingBrief` for that date against a **read-only copy** of the production database, cross-checked against real Blueprint package numbers), but the *prompt* alone wasn't yet forcing the model to actually follow the guidance it was being handed.

## The correction (this commit)

Root cause in the prompt itself: the original rule 13 told the model to stay within `recommendedSessionSets` **"unless a stated reason... justifies falling below the min"** — a self-certifiable escape hatch requiring no actual verification, so the model could always claim "time budget" and go arbitrarily low.

Fix, in `buildProgrammerSystemInstruction()` (`src/ai-programmer/service/aiProgrammerService.ts`) only — no other file touched, validator untouched:
- Rule 13 now names and distinguishes the four numbers explicitly: `weeklyDevelopmentReference` (a weekly total, never this session's number), `recommendedSessionSets {min,max}` (this session's required allocation, "not a suggestion"), `directSetsPerExposureCap` (hard ceiling), `approxSessionSetBudget` (total session budget).
- Rule 14 separates the two decisions explicitly: WHICH targets/exercises (fully flexible) vs. HOW MANY sets (not flexible, governed by rule 15).
- Rule 15 replaces the old escape hatch with one **objectively checkable** condition: falling below a target's own min is permitted only when the sum of every eligible target's own min already exceeds `approxSessionSetBudget` — and even then, maintenance (non-goal) targets must absorb the shortfall before any goal-oriented target does, with the trade-off named in `programmingRationale`. Explicitly calls out the exact observed failure ("choosing 2-3 sets for a target whose min is 7-8 is a rules violation").
- Rules 16–18 (renumbered from 14–16) preserve session-identity/eligibility/exercise-flexibility language unchanged in substance.

## Verification

- Full suite diffed against a real-time baseline (`git stash` to the pre-repair commit, same `npx vitest run --reporter=verbose` command, sorted `FAIL` line lists diffed) at every stage — **zero new failures** introduced by any of the three commits; the ~229 failures present throughout are pre-existing, unrelated stale-calendar-date test fixtures (e.g. `SUNDAY = '2026-09-13'` hardcoded in several test files, now in the past relative to real wall-clock time) that this work did not touch and does not fix.
- 30 new tests across the three commits (5 duplicate-guard, 20 development-reference repair, 10 allocation-contract correction — `programmingBrief.test.ts`, `sessionIdentityPropagation.test.ts`, `programmerAdequacyValidator.test.ts`, `systemInstructionAllocationContract.test.ts`, plus route/service-level end-to-end rejection tests), all passing.
- One real fixture-level regression surfaced mid-implementation (a pre-existing test in `aiProposalRoutes.test.ts` whose single-exercise canned proposal became legitimately inadequate once a real Push session identity was in play) — fixed by giving that one test an adequate fixture, not by weakening the validator.
- Live production verification: two real Velona calls against Tuesday 2026-09-15, both correctly rejected pre-persistence (one on provider JSON validity, one on the new adequacy check); database hash-verified unchanged across all six affected tables both times.

## Known follow-up (not yet resolved)

The allocation-contract correction has **not yet been verified against a real Velona call** — the live test that diagnosed the escape-hatch bug predates this fix. The next live Generate-only test for Tuesday should confirm the model now allocates within `recommendedSessionSets` rather than merely being caught when it doesn't.

The adequacy validator's tunable constants (`MEANINGFUL_COVERAGE_MIN_SETS=2`, `MIN_EXPECTED_COVERAGE_TARGETS=2`, `MAX_SINGLE_TARGET_SHARE=0.6`, `MAX_TOTAL_SETS_BUDGET_MULTIPLIER=2`, `UNDER_PRESCRIPTION_TOLERANCE=0.5`) are documented `[DEFAULT]` choices in `programmerAdequacyValidator.ts`, not Blueprint-given or spec-mandated numbers — worth revisiting once more real generations exist to tune against, per this repo's own `[DEFAULT]`-tagging convention (`src/engine/config.ts`).

## Non-goals (explicitly out of scope, per direction received)

- No new/second volume engine — every quantitative decision reuses an existing deterministic function.
- No change to Blueprint, exercise eligibility, or the requirement that package membership never gates eligibility.
- No change to provider retry/timeout handling, the pending-proposal workflow, approval/commit separation, or the feature flag.
- No exact-match requirement against Efficient/Complete package exercise lists at any point — enforced only as aggregate volume ranges/caps.
