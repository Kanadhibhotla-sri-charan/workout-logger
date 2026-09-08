# Workout Programmer — Step 12 Final Surgical Fix Pass
## Recovery Evidence + Blueprint Fallback Guard

**Status:** Implementation specification  
**Scope:** Surgical fixes only  
**Deployment:** **DO NOT DEPLOY**  
**Primary target:** The latest Step 12 implementation/remediation archive  
**Baseline architecture:** Node.js + Express + SQLite + existing Workout Logger architecture  
**Rule:** Do not redesign Step 12. Fix only the issues explicitly specified below.

---

# 1. Objective

This pass addresses the remaining issues identified in the review of the latest Step 12 implementation.

There are exactly **two** areas to fix:

1. **Goal-review recovery evidence must use real recent rolling exposure.**
   - The current implementation incorrectly reuses phase-average exposure as the rolling exposure input.
   - `applyRecoveryConstraint()` must receive actual recent exposure from the existing exposure/TrainingState infrastructure.

2. **The universal global-volume fallback must not silently replace a missing Blueprint package for a physique target.**
   - Blueprint package references remain authoritative.
   - A missing target-specific package must not silently turn into a universal `[8, 12]`, `[10, 20]`, `[20, 26]`, etc. programming target.
   - Preserve legitimate existing global-principles behavior where it is explicitly intended and semantically valid.
   - Do not redesign the volume system.

Everything else in Step 12 is considered accepted and must remain unchanged unless a change is strictly required to implement the two fixes above.

---

# 2. NON-NEGOTIABLE CONSTRAINTS

## 2.1 Do not redesign the architecture

Do **not**:

- introduce a new exposure engine;
- introduce a second recovery engine;
- introduce a second volume-reference system;
- rewrite goal phases;
- rewrite goal review;
- rewrite current-week reconciliation;
- rewrite Training Profile;
- rewrite workout generation;
- change the Blueprint package definitions;
- change the exposure coefficients;
- change goal lifecycle semantics;
- change Add Unplanned Exercise;
- change Substitute;
- change historical immutability.

Reuse existing infrastructure.

---

## 2.2 Do not introduce arbitrary physiological thresholds

Do not add any new rules such as:

- 60%;
- 70%;
- 75%;
- 80%;
- 90%;
- 95%;
- 2%;
- 5%;
- 10%;
- N consecutive phases;
- "X sets above target means recovery failure";
- "X% increase means fatigue";
- "X missed sessions means poor adherence".

The existing recovery engine's own thresholds/rules may remain untouched if they are already part of the established recovery infrastructure.

This task is about supplying that engine with **correct evidence**, not inventing new recovery rules.

---

## 2.3 Do not reinterpret package references

The Blueprint package is a **development reference**, not a quota.

Do not:

- turn package values into hard minimums;
- create volume debt;
- require the user to "make up" missed sets;
- automatically escalate volume;
- treat package weekly direct sets as physiological effective sets.

---

# 3. FIX #1 — REAL ROLLING EXPOSURE FOR GOAL-REVIEW RECOVERY EVIDENCE

## 3.1 Current problem

The current `goalPhaseEngine.ts` review evidence path supplies recovery with:

```ts
weekly_exposure_units: actual_weekly_exposure,
rolling_exposure_units: actual_weekly_exposure,
rolling_window_days: 14,
```

This is incorrect.

`actual_weekly_exposure` is phase-level average exposure.

It is calculated from phase-wide exposure and elapsed weeks.

That value is **not** a 14-day rolling exposure.

Therefore the current implementation effectively tells the recovery engine:

> "Here is the phase-average weekly exposure, and here is the same phase-average value pretending to represent the most recent 14 days."

That is semantically wrong.

---

# 4. REQUIRED SEMANTICS

The review evidence must distinguish these concepts:

### A. Phase-wide exposure

Used for:

- phase exposure evidence;
- average weekly exposure;
- comparison against the Blueprint development reference.

This existing behavior must remain.

### B. Recent rolling exposure

Used for:

- recovery/fatigue evidence;
- detecting whether recent training exposure is materially different from the broader phase history.

This must be calculated from actual exposure during the requested rolling window.

These are different measurements and must not be substituted for one another.

---

# 5. REQUIRED IMPLEMENTATION

## 5.1 Inspect before modifying

Before changing code, inspect:

1. `src/engine/goalPhaseEngine.ts`
2. `src/engine/exposureEngine.ts`
3. `src/engine/recovery*` / the existing recovery constraint implementation
4. `src/engine/trainingState.ts` or equivalent TrainingState implementation
5. the existing exposure aggregation helpers
6. repositories used to retrieve completed workout sessions/sets
7. existing helpers for date-window exposure
8. tests covering:
   - exposure aggregation;
   - recovery constraints;
   - goal review;
   - TrainingState;
   - completed sessions.

Do not create a new helper if an existing helper already supports date-scoped exposure.

---

## 5.2 Reuse the existing exposure infrastructure

The preferred implementation is:

> calculate actual target exposure for the exact rolling date window using the existing exposure engine / TrainingState / session data infrastructure.

Do not manually reconstruct exposure from raw workout rows if an existing canonical exposure helper already exists.

The existing exposure model remains:

- primary target = `1.00`
- secondary target = `0.33`

Do not change those coefficients.

Do not change what constitutes a completed actual set.

---

# 6. REQUIRED ROLLING WINDOW

The existing recovery call uses:

```ts
rolling_window_days: 14
```

Keep that window unless the existing recovery engine explicitly defines another canonical window.

For a review as-of date:

```text
asOfDate
```

the rolling window must represent actual completed exposure in the preceding 14 calendar days, ending at `asOfDate`.

Conceptually:

```text
rollingStart = asOfDate - 13 days
rollingEnd   = asOfDate
```

This gives an inclusive 14-calendar-day window.

Use the project's existing date utilities and timezone handling.

Do not introduce UTC/local-date inconsistencies.

---

# 7. IMPORTANT: USE ACTUAL EXPOSURE

The rolling exposure must be based on **actual completed training**, not planned sessions.

A planned session that was:

- skipped;
- shortened;
- modified;
- partially completed;

must not contribute planned exposure that was never actually completed.

The same actual-vs-planned distinction already used elsewhere in Step 12 must remain authoritative.

---

# 8. TARGET-SPECIFIC EXPOSURE

The rolling exposure supplied to recovery must correspond to the **goal target** being reviewed.

Do not calculate:

> total gym exposure across all muscles

and pass that into a target-specific goal review.

For a triceps goal, the evidence must represent triceps exposure.

For a chest goal, it must represent chest exposure.

Use the existing target representation and exposure aggregation mechanisms.

---

# 9. PRIMARY VS SECONDARY EXPOSURE

Preserve the existing semantic distinction.

For goal-review development/recovery evidence:

- primary/direct exposure remains the primary signal;
- secondary exposure must not silently become direct hypertrophy evidence.

If the existing recovery API expects a single exposure number, determine from the existing implementation whether that parameter is explicitly intended to represent total exposure or primary exposure.

Do **not** invent a new weighting model.

If the recovery function is already documented/implemented as receiving primary exposure, pass target-specific primary exposure.

If it explicitly expects the established exposure-unit representation, use that canonical representation.

The implementation must make the semantic choice explicit in code rather than accidentally passing the phase average.

---

# 10. REQUIRED GOAL-REVIEW DATA SHAPE

Keep the existing phase-level fields such as:

```ts
actual_weekly_exposure
phase_total_primary_sets
phase_weeks_elapsed
```

unchanged unless a type change is strictly required.

Add or populate a clearly named recent field if necessary, for example:

```ts
rolling_exposure_units
```

or the existing equivalent.

The important requirement is:

```text
phase-average exposure != rolling exposure
```

and the code must preserve that distinction.

Do not overload `actual_weekly_exposure` to mean both.

---

# 11. REQUIRED REGRESSION TEST — RECENT EXPOSURE DIFFERS FROM PHASE AVERAGE

Add a test that would fail under the current buggy implementation.

The test must construct a phase where:

```text
older weeks = relatively low/moderate exposure
recent 14 days = materially higher exposure
```

Example shape:

```text
Week 1: low exposure
Week 2: low exposure
Week 3: low exposure
Recent 14 days: substantially higher exposure
```

The exact numerical values must come from the existing recovery engine/test conventions. Do not invent a physiological threshold.

Assert that:

1. `actual_weekly_exposure` remains the phase-average value;
2. `rolling_exposure_units` reflects the actual recent 14-day exposure;
3. the value passed to `applyRecoveryConstraint()` is the rolling value, not the phase average;
4. recovery therefore receives different weekly/rolling evidence when the underlying data differs.

The test should specifically fail if someone changes the implementation back to:

```ts
rolling_exposure_units: actual_weekly_exposure
```

---

# 12. REQUIRED REGRESSION TEST — NO RECENT TRAINING

Add a test where the target has phase history but no completed target exposure during the most recent rolling window.

Expected:

```text
rolling exposure = 0
```

or the existing canonical empty-window representation.

Do not substitute phase-average exposure.

This proves that the rolling window is genuinely date-scoped.

---

# 13. REQUIRED REGRESSION TEST — FUTURE DATA EXCLUSION

Add a test proving that completed exposure after `asOfDate` does not enter the rolling calculation.

The calculation must be:

```text
<= asOfDate
```

not:

```text
all available data
```

This is important because goal review can be run historically/as-of a specific date.

---

# 14. REQUIRED REGRESSION TEST — TARGET ISOLATION

Add a test proving that exposure for another muscle/goal target does not contaminate the rolling exposure.

Example:

```text
recent chest exposure > 0
recent triceps exposure = 0
goal target = triceps
```

Expected:

```text
triceps rolling exposure = 0
```

Do not allow unrelated target exposure to become recovery evidence for the goal.

---

# 15. DO NOT CHANGE THE RECOVERY ENGINE ITSELF UNLESS NECESSARY

The task is primarily an evidence-input correction.

Do not rewrite:

```text
applyRecoveryConstraint()
```

just because the old input was wrong.

First determine whether the existing function already has the correct semantics.

If it does, leave it unchanged.

Only modify the recovery function if inspection proves that it cannot accept the correct rolling evidence without a minimal, backward-compatible change.

If a recovery-engine change is necessary, document exactly why.

---

# 16. FIX #2 — GUARD THE GLOBAL VOLUME FALLBACK

## 16.1 Current concern

The current implementation contains a fallback in/around:

```text
src/engine/volumeEngine.ts
```

that can use:

```ts
BlueprintAdapter.getGlobalPrinciples().weekly_volume
```

when a target-specific package reference is unavailable.

The global principles contain broad guidance such as:

```yaml
starting_point_sets: [8, 12]
practical_range_sets: [10, 20]
higher_recovery_dependent_sets: [20, 26]
```

These values are **global guidance**, not a universal programming target.

A missing Blueprint package must not silently become:

> "Use the global set range as this target's volume."

---

# 17. REQUIRED BEHAVIOR FOR PHYSIQUE TARGETS

For a physique/development target:

```text
target → Blueprint development package
```

must remain authoritative.

If the package exists:

```text
use the target-specific package reference
```

If the package does not exist:

```text
do not silently substitute global volume guidance as a target-specific development reference
```

The system should instead preserve the existing explicit missing-reference semantics, or return/propagate an explicit "no development reference" state if that is already supported by the architecture.

Do not invent a new arbitrary fallback.

---

# 18. IMPORTANT: DO NOT BREAK FUNCTIONAL GOALS

Do not assume every goal must have a physique development package.

The Blueprint currently distinguishes development/physique package references from functional goals.

Before modifying the fallback, inspect:

- goal type;
- target type;
- Blueprint reference resolution;
- functional-goal behavior;
- existing tests.

The objective is specifically:

> prevent a missing **physique/development Blueprint package** from silently turning into a universal volume prescription.

Do not accidentally break legitimate functional-goal behavior.

---

# 19. REQUIRED INSPECTION FOR VOLUME FALLBACK

Before modifying `volumeEngine.ts`, inspect:

1. `src/engine/volumeEngine.ts`
2. `src/engine/developmentReferenceEngine.ts`
3. `src/types/*` for DevelopmentReference/goal target types
4. `src/engine/workoutBuilder.ts`
5. Blueprint package adapter/resolution code
6. tests covering development references
7. tests covering volume planning
8. tests covering functional goals
9. current package lookup behavior.

Determine exactly why the global principles fallback exists.

Do not remove it blindly.

---

# 20. REQUIRED GUARD

The implementation must establish this invariant:

> **A physique target with no resolved Blueprint development package must never silently receive global weekly-volume guidance as if that guidance were its target-specific development reference.**

Possible acceptable implementations include, depending on the existing type/engine design:

- returning `null`/missing reference;
- propagating an explicit unresolved reference;
- preventing target-specific volume calculation until a package exists;
- using an already-existing explicit non-development fallback path.

Choose the smallest implementation consistent with the current architecture.

Do not add a new architecture solely to represent this state.

---

# 21. REQUIRED TEST — MISSING PHYSIQUE PACKAGE

Add a regression test:

```text
physique/development target
→ no Blueprint package resolved
```

Assert:

```text
global weekly_volume is NOT used as the target's development reference
```

The test should specifically fail if someone reintroduces:

```ts
getGlobalPrinciples().weekly_volume
```

as the silent substitute.

---

# 22. REQUIRED TEST — EXISTING PACKAGE STILL WINS

Add/retain a test proving:

```text
physique target
+ valid Blueprint package
→ target-specific package reference
```

and that global principles do not override it.

Use the existing package fixture conventions.

Do not hardcode a universal volume number into the test merely to make it pass.

---

# 23. REQUIRED TEST — FUNCTIONAL GOAL REGRESSION

If functional goals currently use a different reference path, add/retain a regression test proving that this fix does not break them.

The test must establish:

```text
functional goal behavior before fix
=
functional goal behavior after fix
```

unless the current behavior itself is demonstrably incorrect.

Do not broaden this task into functional-goal redesign.

---

# 24. REQUIRED TEST — NON-GOAL PROGRAMMING REGRESSION

Preserve the accepted rule:

```text
non-goal development target → Efficient package reference
active goal → Complete package reference
```

The new guard must not break normal package-backed non-goal programming.

---

# 25. PRESERVE ALL ACCEPTED STEP 12 BEHAVIOR

After implementing these fixes, verify that all of the following remain intact.

## Development references

- Active goal → Complete package.
- Non-goal → Efficient package.
- Package reference is a weekly development reference.
- Package reference is not a quota.
- No universal 8/12/20/24 target.
- No 75–80% fallback.
- No arbitrary percentage debt.

## Exposure

- Primary/direct = `1.00`.
- Secondary/indirect = `0.33`.
- Secondary exposure is not automatically equivalent to direct hypertrophy work.
- Do not call exposure units "effective sets."

## Planning

- Weekly programming is solved before individual sessions.
- Goal priority influences allocation.
- Goals do not multiply volume.
- Constraints remain constraints.
- Programmer chooses exercises rather than blindly copying package lists.
- Exercise redundancy/coverage remain part of programming decisions.

## Adaptation

- Actual completed work outranks original prescription for remaining-week decisions.
- Missed work is a signal, not permanent debt.
- No automatic escalation merely because a session was missed.
- Same-week adaptation affects only remaining uncompleted work.
- Repeated adherence patterns can inform future programming.

## Goal phases

- Active goals have Complete-level phase references.
- Deactivation completes the active phase.
- Reactivation starts a fresh active phase.
- Goal phases remain separate from `workout_sessions.program_phase`.
- Phase review remains user-controlled.

## Goal review

- Aesthetic trend compares actual assessments over time.
- `5 → 4` is declining.
- `2 → 3` is improving.
- equal values are stagnant.
- insufficient history is insufficient data.
- No percentage trend threshold.
- No automatic graduation.
- Engine recommendations remain Continue/Adjust.
- User can explicitly Graduate.
- Adherence is contextual evidence, not a universal pass/fail gate.
- Adherence denominator uses actual configured calendar opportunities.
- Phase exposure is phase-wide and target-specific.
- Performance evidence is target-specific.
- Measurements are metric/unit-specific.
- Recovery evidence uses real recent exposure.

## Existing features

- Add Unplanned Exercise remains unchanged.
- Substitute remains unchanged.
- Training Profile remains unchanged.
- Current-week reconciliation remains unchanged.
- Historical actual workout data remains immutable.

---

# 26. FILES TO INSPECT FIRST

At minimum inspect:

```text
src/engine/goalPhaseEngine.ts
src/engine/exposureEngine.ts
src/engine/volumeEngine.ts
src/engine/developmentReferenceEngine.ts
src/engine/workoutBuilder.ts
```

Then inspect the actual recovery, TrainingState, goal, session, activity, and Blueprint adapter modules referenced by those files.

Also inspect relevant tests before modifying implementation.

Do not assume filenames if the repository has renamed a module; locate the canonical implementation first.

---

# 27. IMPLEMENTATION STYLE

Use the existing project's conventions.

Prefer:

- small helper functions;
- explicit names;
- existing date utilities;
- existing repositories;
- existing exposure aggregation;
- existing target-resolution logic;
- existing error/missing-reference semantics.

Avoid:

- duplicated SQL;
- duplicated exposure calculations;
- duplicated target mapping;
- new global constants for physiological thresholds;
- new database tables;
- schema migrations;
- architecture changes.

---

# 28. COMMENTS / DOCUMENTATION

Add a concise code comment wherever necessary to prevent regression.

For example, the rolling-exposure code should make it clear that:

```text
phase-average exposure and recent rolling exposure are intentionally different measurements.
```

Likewise, the Blueprint fallback guard should make it clear that:

```text
global principles are guidance and must not silently substitute for a missing target-specific development package.
```

Do not add large comment blocks that merely restate this specification.

---

# 29. TEST REQUIREMENTS

Add or update focused tests for:

### Recovery evidence

- real 14-day rolling exposure;
- recent exposure differs from phase average;
- no recent exposure;
- future data excluded;
- target isolation;
- actual rather than planned exposure.

### Blueprint fallback

- missing physique package does not use global volume;
- valid package still resolves normally;
- functional-goal behavior preserved where applicable;
- non-goal Efficient package behavior preserved.

Do not weaken existing tests.

Do not replace assertions with snapshots merely to make tests pass.

---

# 30. REQUIRED VALIDATION COMMANDS

After implementation, run exactly:

```bash
npm run typecheck
npm test
npm run build
npm run verify
```

All must pass.

If `npm run verify` already runs build/typecheck/tests, still run the individual commands above because this specification requires their explicit results.

Do not run:

```bash
npm audit fix
```

Do not upgrade npm.

Do not change Node versions.

---

# 31. REQUIRED FINAL REPORT FROM CLAUDE CODE

The implementation report must contain:

## A. Changed files

List every changed file exactly.

Example:

```text
src/engine/goalPhaseEngine.ts
src/engine/...
tests/...
```

Do not list files that were only inspected.

## B. Recovery fix

Explain:

1. where the old phase-average-as-rolling bug existed;
2. how actual rolling exposure is now calculated;
3. which existing infrastructure is reused;
4. how the target is isolated;
5. how actual-vs-planned data is handled;
6. how future dates are excluded.

## C. Blueprint fallback fix

Explain:

1. where the global fallback existed;
2. what condition now prevents silent substitution;
3. what happens when a physique package is missing;
4. why legitimate functional behavior remains intact.

## D. Tests

List the exact new/updated test names and what each proves.

## E. Command results

Report exact outcomes for:

```bash
npm run typecheck
npm test
npm run build
npm run verify
```

Include:

- test file count;
- total test count;
- passed;
- failed;
- skipped, if any.

Do not report "all tests pass" without actually running them.

---

# 32. DEPLOYMENT PROHIBITION

**DO NOT DEPLOY THIS CHANGE.**

Do not:

- SSH to the production VM;
- modify Nginx;
- modify systemd;
- copy files to the server;
- modify the production SQLite database;
- restart the production service;
- run migrations against production.

This is an implementation/test-only pass.

---

# 33. ACCEPTANCE CRITERIA

This pass is accepted only if all are true.

## Recovery

- [ ] Goal-review phase-average exposure remains phase-wide.
- [ ] Goal-review rolling exposure is independently calculated from actual recent dates.
- [ ] Rolling exposure uses the canonical existing exposure/TrainingState infrastructure.
- [ ] Rolling exposure is target-specific.
- [ ] Planned-but-uncompleted work does not count as actual rolling exposure.
- [ ] Future data is excluded.
- [ ] No recent exposure produces zero/empty-window evidence according to existing semantics.
- [ ] Regression test proves rolling exposure differs from phase average when underlying data differs.
- [ ] `applyRecoveryConstraint()` receives the real rolling evidence.
- [ ] No new recovery thresholds were introduced.

## Blueprint fallback

- [ ] A physique target with a valid package uses that package.
- [ ] A physique target with no package does not silently receive global weekly-volume guidance as its development reference.
- [ ] Global principles remain available where their existing semantics legitimately require them.
- [ ] Functional-goal behavior is not unintentionally broken.
- [ ] Non-goal Efficient behavior remains intact.
- [ ] No universal volume number has been introduced.

## Regression protection

- [ ] Existing Step 12 tests remain passing.
- [ ] Add Unplanned Exercise unchanged.
- [ ] Substitute unchanged.
- [ ] Current-week reconciliation unchanged.
- [ ] Training Profile unchanged.
- [ ] Historical actual data remains immutable.
- [ ] Goal phase lifecycle unchanged.
- [ ] Goal graduation remains user-controlled.
- [ ] Adherence remains contextual.
- [ ] Primary/secondary exposure coefficients remain unchanged.

## Validation

- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes.
- [ ] `npm run build` passes.
- [ ] `npm run verify` passes.
- [ ] No deployment performed.

---

# 34. FINAL INSTRUCTION TO CLAUDE CODE

Implement **only** the two surgical fixes in this document.

Do not treat this as an invitation to redesign Step 12.

The desired end state is:

```text
                    GOAL REVIEW
                         │
          ┌──────────────┴──────────────┐
          │                             │
   Phase-wide evidence          Recent evidence
          │                             │
  phase average exposure       actual rolling exposure
          │                             │
          └──────────────┬──────────────┘
                         │
                 recovery engine
```

and:

```text
Physique target
      │
      ▼
Blueprint package?
   │          │
  YES         NO
   │           │
   ▼           ▼
Use target-   Explicit missing
specific      reference behavior
package       / no silent substitution
                │
                ✕
       Do NOT use global
       weekly volume as
       target-specific volume
```

Do not change anything else unless it is strictly necessary to satisfy these invariants.

After implementation, run all four required validation commands and provide the exact changed-file list, test list/results, and command results.

**Do not deploy.**
