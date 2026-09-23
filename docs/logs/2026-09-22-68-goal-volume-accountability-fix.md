# 2026-09-22 — Goal volume accountability fix (validator truthfulness + AI self-check)

Follow-up to log 67. Scope, per explicit instruction: fix the zero-unmet-set validator gap and strengthen the eval-only weekly AI contract so a goal is either satisfied or truthfully deferred. Do not force reference-volume prescriptions, change Blueprint semantics, change repair logic, or add a "capacity" deferral reason. Branch: `ai-weekly-eval-validation`.

## FINDING

The bug was in the eval harness (`scripts/modelEvalWholeWeekTwoStep.mjs`), not in `auditGoalDeferrals` itself — the validator function had no truthfulness check to bypass. The harness took whatever `unmetSets` the model declared and silently overwrote it with the audit's own computed shortfall before calling the validator:

```js
const deferrals = (raw.reconciliation?.deferrals ?? [])
  .map((d) => ({ ...d, unmetSets: audit.rows.find((r) => r.targetId === d.targetId)?.shortfall ?? d.unmetSets }))
  .filter((d) => d.unmetSets > 0);
```

So a model declaring `unmetSets: 0` (or any wrong number) on triceps while actually delivering 9 of 24 had that number silently corrected to 15 before validation, and — as long as it used an accepted `reasonCode` — the week passed with no record that the model's own number was wrong. The dishonesty was fixed instead of flagged.

Separately, discovered while tracing this: production's real `reconcile_week` context (`AIReconciliationContext`, `reconciliationContextTypes.ts`) has no `programmingBrief` and no per-target weekly number at all (no `recommendedWeeklyPrimarySets`). The weekly-target/deferral concept exists only in the eval harness's own bolt-on brief (`evalContext.programmingBrief`, built by `buildProgrammingBrief` and merged in ad hoc). `reconciliation.deferrals` likewise exists only as a schema field the harness injects at runtime (`weekReconciliationOutputSchema.ts` has no such field). Given this, the accountability contract in this fix is applied to the eval-only prompt and the shared `src` validator, not to the production system instruction (`buildWeekReconciliationSystemInstruction`) or the production output schema — those don't have a weekly number to hold the model accountable to. This is flagged under REMAINING ISSUE / RECOMMENDATION below; it was not treated as in scope to fix (adding brief data to production's real reconciliation context is a separate design decision, and item 9 of the instruction excluded volume-target/production changes from this task).

## VALIDATOR

`src/ai-programmer/validation/weeklyVolumeAudit.ts`:

- `AuditDeferral` gained a required `unmetSets: number` field.
- `auditGoalDeferrals` now checks, per goal shortfall row, in this order:
  1. No matching deferral at all → error (unchanged from before).
  2. Deferral has an invalid `reasonCode` → error (unchanged from before), and no further check on that row (already reported).
  3. Deferral's declared `unmetSets` is not a finite positive number (covers `0`, negative, missing, `NaN`) → error naming the declared value and the real audited shortfall.
  4. Deferral's declared `unmetSets` does not exactly equal the audited shortfall → error naming both numbers.
- No case silently substitutes the audited number for the declared one. A wrong declaration is now itself a rejection, never a quiet correction into a passing result.
- No tolerance/rounding logic existed to reuse; comparison is exact integer equality, since both the audited shortfall and every legitimate `unmetSets` value are whole numbers.

## AI CONTRACT

`scripts/modelEvalWholeWeekTwoStep.mjs` (eval-only; the app never calls this):

- Removed the silent-correction `.map`/`.filter` — the model's declared `deferrals` (targetId, unmetSets, reasonCode) are now passed to `auditGoalDeferrals` unchanged (coerced to the right shape/type only, never corrected in value). Declared deferrals are also recorded on the result object (`result.declaredDeferrals`) for visibility.
- `commitInstruction` (the eval-only prompt on top of the shared production instruction) now requires, before the final JSON, an explicit per-goal self-check: sum the goal's sets from the model's own final exercise list (never from memory or its own prior reasoning), compare with `programmingBrief.muscles[].recommendedWeeklyPrimarySets`, and either add no deferral (goal met) or add exactly one deferral with `unmetSets` equal to the exact difference, a `recovery`/`recent_overexposure` reason, and evidence. It states plainly that the harness recomputes the total independently from the same final exercise list and will reject a wrong declared number, and that a narrative claim of "goal met" is never a substitute for the count.
- The ad hoc eval-only JSON schema mutation for `reconciliation.deferrals` (targetId/unmetSets/horizon/reasonCode/evidence, reasonCode enum `recent_overexposure`/`recovery`/`capacity`/`rotation`) was left unchanged, per the explicit instruction not to add or remove allowed reasons in this task — `capacity` and `rotation` remain offerable to the model at the schema level but are still rejected by `auditGoalDeferrals` for a goal target exactly as before (`GOAL_DEFERRAL_REASONS` unchanged: `recovery`, `recent_overexposure`).
- No production system instruction, output schema, or type was touched (see FINDING above for why).

## TESTS

`tests/ai-programmer/weeklyVolumeAudit.test.ts`, `auditGoalDeferrals` describe block — rewritten/extended to the 7 requested cases plus the pre-existing reasonCode/normal-shortfall checks (23 tests total in the file, all passing):

| Case | Scenario | Result |
|---|---|---|
| 1 | Target fully met (all 5 triceps exercises at full sets, both sessions = 24/24), no deferral | PASS |
| 2 | Target 24, actual 9 (via the fixture's real shortfall), no deferral | FAIL |
| 3 | Same shortfall, deferral declares `unmetSets: 0` | FAIL |
| 4 | Same shortfall, deferral declares the exact audited shortfall, valid reason | PASS |
| 5 | Same shortfall, deferral declares `shortfall - 1`, valid reason | FAIL |
| 6 | Two independent goal targets (triceps, triceps-long-head); only one gets a truthful deferral | the deferred one passes, the other still fails on its own |
| 7 | A shared exercise (overhead extension) credits both triceps and triceps-long-head; each target's own correctly-shared shortfall is independently declared and passes | PASS |

Also kept: rejecting a `capacity`-reasoned deferral on a goal target even when `unmetSets` matches; no deferral required for a normal-muscle shortfall.

Run: `npx vitest run tests/ai-programmer/weeklyVolumeAudit.test.ts` → 23/23 passed. `npm run typecheck` → clean. `npm run build` → clean.

Full suite (`npx vitest run`): 232 failed / 1559 passed with this change, versus 232 failed / 1554 passed on the same branch without it (checked by stashing the change and re-running) — identical failure count, 5 new passing tests, zero regressions. The 232 failures are the pre-existing date-rot family (hardcoded 2026-09-13-era fixtures against a real clock now at 2026-09-22); this was verified to be unrelated to this change, not merely assumed.

## NORMAL MODE

Not run. This environment has no Velona credentials (`env | grep -i velona` empty) and no isolated eval database, so `EVAL_GOAL_TARGET` unset (normal `brief` mode) could not be executed live. `npm run build` was run so the harness is ready to execute once credentials/DB are available. This repeats the same limitation noted in logs 65/67.

## REMAINING ISSUE

Whether Qwen still ignores the target under the strengthened contract is unverified — no live run was possible here. Separately, and more structurally: even a perfect prompt and validator only matter where the model is actually given a number to be accountable to. Right now that is true only inside the eval harness. Production's real `reconcile_week` requests carry no weekly per-target number and no `deferrals` concept at all, so this accountability mechanism cannot yet do anything for a real user's week — it only audits the eval's own synthetic construction.

## RECOMMENDATION

One next step: run the eval harness in normal `brief` mode (no `EVAL_GOAL_TARGET`) against several iterations, using the now-strengthened `commitInstruction` and the now-truthful validator, and read `result.declaredDeferrals` alongside `result.weekAdequacy.deferralErrors` to see whether Qwen (a) reaches the brief's number, (b) honestly declares a matching shortfall, or (c) still under-delivers with a false or missing deferral — before deciding anything about widening this mechanism into production.
