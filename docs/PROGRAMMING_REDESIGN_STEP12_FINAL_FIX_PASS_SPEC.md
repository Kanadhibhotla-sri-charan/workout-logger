# Workout Programmer — Final Step 12 Fix Pass
## Surgical Remediation Specification — Do Not Redesign

**Purpose:** Final targeted fixes for the current Step 12 implementation. The core architecture is accepted. Implement only the issues below, then fully verify the result.

## 1. Mandatory fixes

### P0-1 — Make aesthetic assessment a real trend

The current implementation classifies the latest 1–5 assessment directly. That is not a trend.

Compare the appropriate earlier assessment with the latest relevant assessment:

- latest > baseline → `improving`
- latest < baseline → `declining`
- latest = baseline → `stagnant`
- insufficient comparable assessments → existing `insufficient_data` representation

Do **not** invent percentage thresholds.

Prefer phase-aware evidence:

1. Two+ assessments inside the phase: earliest vs latest.
2. One assessment inside phase plus a comparable prior assessment: prior vs latest.
3. Only one assessment overall: insufficient data.
4. None: insufficient data.

Add tests:
- 2 → 3 = improving
- 5 → 4 = declining
- 3 → 3 = stagnant
- one assessment = insufficient
- unrelated goal assessment excluded

### P0-2 — Do not automatically graduate improving goals

The current implementation can recommend `Graduate` from improving aesthetic + measurement/performance + adherence/recovery.

That is too strong because the current goal model has no authoritative physical completion endpoint.

For normal physique goals without an explicit completion criterion:

- engine recommendation may be `Continue`
- engine recommendation may be `Adjust`
- engine must **not** automatically recommend `Graduate` merely from improvement

Keep `Continue`, `Adjust`, and `Graduate` as valid review decisions. A user may explicitly choose `Graduate`.

Do not implement:
- fixed number of improving phases
- percentage-based graduation
- adherence-based graduation
- any other invented universal graduation rule

Tests:
- all evidence improving → `Continue`, not `Graduate`
- multiple improving phases → still no automatic `Graduate`
- explicit user `Graduate` decision is preserved separately from engine recommendation

### P0-3 — Treat adherence as contextual evidence

Do not use `adherence_ratio < 1` as a universal failure condition.

Adherence answers:

> How closely did actual behavior follow the configured plan?

It does not answer:

> Did the goal succeed?

A 90% adherence case with improving evidence can recommend `Continue`.

A 100% adherence case with stagnant evidence must not automatically count as success.

Do not introduce arbitrary adherence thresholds.

Existing current-week activity overrides must be interpreted conservatively. An intentional override is not automatically a failure.

### P0-4 — Calculate adherence exactly

Replace approximate calculations such as `phaseDays / 7 * trainingDaysCount`.

Enumerate actual calendar dates from:

`phase.start_date → min(asOfDate, phase.end_date)`

For each date, determine the recurring Training Profile opportunity using the existing infrastructure.

- no future dates
- no extrapolation
- partial phases handled exactly
- do not create a second attendance model
- reuse existing activity/session/profile infrastructure
- account for explicit current-week overrides where the existing data supports that context

Tests:
- complete week exact count
- partial week exact count
- multi-week exact count
- future dates excluded
- intentional current-week override handled conservatively

## 2. Preserve all previous Step 12 decisions

Do not regress:

- active goal → Complete Blueprint package reference
- non-goal → Efficient Blueprint package reference
- package reference is a programming reference, not a quota
- no universal 8/12/20/24-set target
- no 75–80% fallback
- primary exposure = 1.00
- secondary exposure = 0.33
- secondary exposure is not equivalent to direct hypertrophy work
- actual completed/modified/unplanned work informs remaining programming
- planned-but-uncompleted work is not actual exposure
- no permanent volume debt
- no blind missed-set compensation
- deterministic decision hierarchy
- machine-readable deviation reasons
- target-specific performance evidence
- phase-wide actual exposure
- metric-specific measurements
- recovery infrastructure reuse
- active-goal/goal-phase lifecycle
- Add Unplanned Exercise
- Substitute
- Training Profile
- current-week overrides/reconciliation
- historical actual immutability
- dedicated goal phases separate from `workout_sessions.program_phase`

## 3. Phase exposure clarification

The previous remediation correctly changed goal-review exposure from current-week to phase-wide aggregation.

Keep that.

`phase_total_primary_sets` may remain if its semantics are explicit:

> total primary/direct exposure for the target across the reviewed phase.

Do not call it effective sets.

Do not change the 1.00/0.33 coefficients.

If secondary exposure is already readily available, it may be exposed separately. Do not redesign the system solely to add it.

## 4. Goal review evidence model

The review should conceptually be:

```text
Goal
 ↓
Goal Phase
 ↓
Evidence
 ├─ aesthetic assessment trend
 ├─ relevant measurement trends
 ├─ relevant performance trend
 ├─ phase-level actual primary exposure
 ├─ adherence/context
 └─ recovery/activity context
 ↓
Engine recommendation
 ├─ Continue
 └─ Adjust
 ↓
User review decision
 ├─ Continue
 ├─ Adjust
 └─ Graduate
```

Do not collapse goal success into sets completed.

Do not claim completion when the data model cannot establish completion.

## 5. Important programming semantics

Blueprint package reference:

> development programming objective/reference

not:

> exact weekly prescription

Constraints, recovery, actual work, exercise overlap, time, equipment, adherence patterns, and higher-priority goals may legitimately produce less or more programming.

No arbitrary percentage fallback.

The decision hierarchy remains:

```text
hard constraints
→ active-goal priority
→ Blueprint package reference
→ accumulated planned/actual direct & secondary exposure
→ recovery/fatigue
→ exercise coverage/redundancy
→ weekly/session distribution
```

This is precedence, not a weighted score.

## 6. Inspect before modifying

Before editing:

1. Inspect the current goal-review evidence builder.
2. Inspect aesthetic assessment repository/helper.
3. Inspect goal target representation.
4. Inspect Blueprint exercise-target mapping.
5. Inspect exposure aggregation.
6. Inspect goal phase lifecycle.
7. Inspect Training Profile/activity/session data used for adherence.
8. Inspect recovery infrastructure.
9. Inspect measurement repository.

Reuse existing infrastructure. Make the smallest coherent changes. Do not duplicate engines, repositories, mappings, or business rules.

## 7. Required regression tests

Add/retain tests for:

### Goal review
- aesthetic 2→3 improving
- aesthetic 5→4 declining
- aesthetic 3→3 stagnant
- one assessment insufficient
- unrelated assessment excluded
- unrelated exercise performance excluded
- relevant compound target semantics preserved
- phase exposure spans multiple weeks
- partial phase handled
- future exposure excluded
- metric identity/unit separation
- improving evidence does not auto-graduate
- multiple improving phases do not auto-graduate
- explicit user Graduate preserved
- adherence is contextual
- exact adherence date enumeration
- intentional current-week override handled conservatively
- recovery uses existing relevant infrastructure

### Programming
- goal Complete reference
- non-goal Efficient reference
- different muscles use their own Blueprint values
- package reference is not a quota
- no 75–80% fallback
- no universal volume target
- no permanent debt
- actual work outranks stale plan
- unplanned relevant work counts
- constraints can reduce programming

### Existing functionality
- Add Unplanned unchanged
- Substitute unchanged
- Training Profile unchanged
- current-week overrides unchanged
- current-week reconciliation unchanged
- historical actuals immutable

## 8. Do not make these changes

Do not:

- rewrite `workoutBuilder.ts`
- create a second programmer
- replace reconciliation
- create a second exposure/recovery model
- redesign SQLite/Express/Node
- introduce paid services/infrastructure
- invent physiological thresholds
- introduce universal volume percentages
- automatically increase volume every week
- automatically graduate goals
- rewrite historical workouts
- silently mutate recurring Training Profile
- make unrelated cleanup changes

## 9. Verification

Run the project's full verification sequence:

```bash
npm run typecheck
npm test
npm run build
npm run verify
```

If a command fails, diagnose and fix it before declaring success.

Report actual:
- test files
- total tests
- passed
- failed
- skipped
- typecheck
- build
- verify

Do not report “all tests pass” without actually running them.

## 10. Final Claude Code instruction

> Implement this Final Step 12 Fix Pass exactly.
>
> This is a surgical remediation pass. The existing architecture is accepted. Inspect the implementation first and modify only what is required.
>
> Mandatory P0 fixes:
>
> 1. Make aesthetic assessment evidence a real phase-aware trend by comparing appropriate assessments. Do not classify a single rating as a trend. Do not invent percentage thresholds.
> 2. Remove automatic engine graduation based merely on improving evidence. Without an authoritative goal-completion endpoint, improving evidence must lead to Continue/possibly Adjust, not automatic Graduate. Keep Graduate available as an explicit user decision.
> 3. Treat adherence as contextual evidence, not a universal pass/fail requirement. Do not use adherence < 1 as an automatic failure.
> 4. Calculate adherence by enumerating actual calendar dates in the review window; never use approximate weeks × training-days calculations.
>
> Preserve all previous Step 12 behavior: Complete for active goals, Efficient for non-goals, package reference ≠ quota, 1.00/0.33 exposure, no 75–80% fallback, no volume debt, actual training adaptation, target-specific performance evidence, phase-wide exposure, metric-specific measurements, existing recovery infrastructure, goal-phase lifecycle, Add Unplanned, Substitute, Training Profile, current-week reconciliation, and historical immutability.
>
> Do not create a second programmer, exposure engine, recovery engine, attendance model, or database architecture.
>
> Add the required regression tests, including tests proving that unrelated exercise performance cannot influence a goal, that aesthetic 5→4 is declining, that one assessment is insufficient, that improving evidence does not auto-graduate, and that adherence is exact and contextual.
>
> Run:
>
> `npm run typecheck`
> `npm test`
> `npm run build`
> `npm run verify`
>
> Fix failures before reporting completion.
>
> At the end report every changed file and why it changed, all tests added/changed, exact verification results, remaining limitations, and confirm that production was not deployed.
>
> Do not stop at acknowledgment. Implement and verify the complete fix pass.

## 11. Final acceptance checklist

- [ ] Aesthetic assessment is a real trend.
- [ ] 2→3 = improving.
- [ ] 5→4 = declining.
- [ ] 3→3 = stagnant.
- [ ] One assessment = insufficient.
- [ ] Unrelated assessments excluded.
- [ ] Unrelated exercise performance excluded.
- [ ] Phase exposure covers the full reviewed phase.
- [ ] Partial phase handled correctly.
- [ ] No automatic Graduate from improvement.
- [ ] No fixed improving-phase graduation rule.
- [ ] No arbitrary measurement/adherence graduation thresholds.
- [ ] User Graduate decision remains available.
- [ ] Adherence is contextual.
- [ ] Adherence is calculated by actual dates.
- [ ] Future dates excluded.
- [ ] Current-week overrides handled conservatively.
- [ ] Active goals use Complete reference.
- [ ] Non-goals use Efficient reference.
- [ ] No universal volume target.
- [ ] No 75–80% fallback.
- [ ] No permanent debt.
- [ ] 1.00 primary / 0.33 secondary preserved.
- [ ] Add Unplanned preserved.
- [ ] Substitute preserved.
- [ ] Training Profile preserved.
- [ ] Current-week reconciliation preserved.
- [ ] Historical actuals immutable.
- [ ] Typecheck passes.
- [ ] Tests pass.
- [ ] Build passes.
- [ ] Verify passes.
- [ ] No production deployment performed.

## 12. Core principle

```text
Blueprint reference
        ≠
planned volume
        ≠
actual volume
        ≠
goal progress
        ≠
goal completion
```

The system should be deterministic, explainable, conservative about claims, and responsive to actual training.

**Do not make the system claim that a physique goal is complete when the data model cannot actually establish that.**
