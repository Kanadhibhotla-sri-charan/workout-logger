# 2026-09-23 — Parent/sub-target shared-credit prompt clarification

Follow-up to log 70's approved analysis. Implements the narrowly-scoped prompt fix identified there: the model was never told that a set assigned to a specific sub-target (e.g. triceps-long-head) is also credited toward a broader parent target (triceps) by the app's own accounting — so it treated covering the smaller sub-target as substantially discharging the parent's own separate requirement, without ever attempting to maximize the parent's remaining exclusive exercises.

## What changed

`src/ai-programmer/service/aiProgrammerService.ts`, `buildWeekReconciliationSystemInstruction()` only (not the single-session `buildProgrammerSystemInstruction` — the investigated failure and this fix are both scoped to week reconciliation; the same gap likely exists in the single-session prompt too, noted as a candidate follow-up, not touched here).

Added one new rule (renumbering the rest, 18 rules -> 19; no rule content besides the internal "rule 5 and 18" cross-reference — now "rule 5 and 19" — needed updating):

> 7. Some targets share one or more exercises with a more specific sub-target that is also present in context.targets — you can recognize this because the exact same exerciseId appears in both targets' own validExercises lists (e.g., a specific-emphasis variant of a broader muscle). A set you assign to the more specific sub-target is automatically credited by the app toward the broader target's own weekly number too — it is never counted as two separate sets, and you must never list the same exercise under both target ids to try to credit it twice. Once the sub-target's own number is genuinely covered, work out how much of the broader target's own number is still realistically unmet after that shared credit, then use your own coaching judgment — the same judgment rules 5 and 19 already give you, never a mechanical top-up — to decide whether and how to address whatever genuinely remains, using that target's own remaining eligible exercises and the full weekly context.

Deliberately generic (no mention of triceps by name) so it applies to any parent/sub-target pair, not just the one investigated.

## What was explicitly preserved, per the approved instructions

- Rule 5 ("Blueprint package references are development/coverage references, not rigid exercise quotas") — unchanged, only renumbered as an untouched string.
- The former rule 18 (session-cap / "deferred volume is never lost") — unchanged content, renumbered to 19; its one internal citation from the new rule points to the new number.
- No change to: the output schema, `AIProgrammerTargetContext`/`AIReconciliationContext` types, `getSubTargetExerciseIds`/`creditedTargetKeys` (shared-crediting logic), `weeklyVolumeAudit.ts`, `programmerProposalRepair.ts` (validator/repair), exercise-selection rules (`exerciseSelector.ts`), or any Blueprint data.
- No mechanical "insert N more sets" instruction — the new rule explicitly frames the remaining amount as something to address "using your own coaching judgment... never a mechanical top-up."

## Tests

New file `tests/ai-programmer/weekReconciliationParentSubTargetInstruction.test.ts`, 5 tests against the real instruction string (matching the existing convention from `systemInstructionAllocationContract.test.ts`, which covers the single-session prompt):
1. States the shared exercise is recognizable by the same exerciseId appearing in both targets' `validExercises`.
2. States the credit is shared, never double-counted, and the exercise must never be deliberately listed under both target ids.
3. States the model should work out the remaining amount and address it via its own coaching judgment, never a mechanical top-up.
4. Confirms rule 5's original wording and the former rule 18's "deferred volume is never lost" wording both survive verbatim, and that no "mechanically add/insert/fill" phrasing was introduced.
5. Confirms the rule list renumbers cleanly (1..19, no gaps or duplicates).

Run: `npx vitest run tests/ai-programmer/weekReconciliationParentSubTargetInstruction.test.ts` -> 5/5 passed. `npm run typecheck` -> clean. `npm run build` -> clean. Full suite: 232 failed / 1568 passed (was 1563) — identical pre-existing date-rot failures, 5 new passing tests, zero regressions.

## Scope note

This is a production-shared instruction (`buildWeekReconciliationSystemInstruction` backs real `reconcile_week` requests too, same as the goal-completion repair it complements). Unlike the repair pass, this change carries no gating concern: it is pure additional information for the model, changes no numeric enforcement, and does not depend on `programmingBrief` being present — it applies identically whether or not a brief exists.
