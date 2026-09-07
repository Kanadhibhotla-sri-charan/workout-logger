# Workout Programmer — Step 12 Remediation / Fix Specification

## Purpose

This document is the **targeted remediation pass** for the current Step 12 implementation in:

`workout-logger-programming-redesign-step12.zip`

The core Step 12 architecture is considered sound. **Do not redesign or replace it.** The goal is to correct the specific issues identified in review, especially in the new goal-phase/review layer, while preserving all previously accepted behavior.

The objective is to make this implementation ready for a final verification pass and deployment with as few additional iterations as possible.

---

# 1. Non-negotiable design principles

These rules are authoritative for this remediation.

## 1.1 Blueprint remains the source of package numbers

The Blueprint's Build Muscle development packages remain the sole source of:

- Efficient package weekly direct-set references for non-goal development
- Complete package weekly direct-set references for active goal development

Do **not** introduce new universal weekly volume numbers.

Do **not** replace package-specific references with:

- 8 sets for every muscle
- 12 sets for every muscle
- 20 sets for every muscle
- 24 sets for every muscle
- 75–80% of package volume
- any other global percentage or universal threshold

The existing global volume principles may remain as general programming guidance where already used, but they must not become a substitute for individual Blueprint package references.

---

## 1.2 Package reference is not today's prescription

A package reference is a **weekly programming objective/reference**, not a quota.

The programmer is allowed to produce less or more than the reference when justified by:

- hard constraints
- active-goal priority
- accumulated actual exposure
- secondary exposure
- recovery/fatigue
- exercise overlap/redundancy
- session capacity
- time constraints
- equipment constraints
- actual user modifications
- adherence patterns

There must be no automatic rule such as:

> Complete package = exact number of sets that must be completed every week.

---

## 1.3 Exposure model is locked

Keep:

- primary/direct exposure = `1.00`
- secondary/indirect exposure = `0.33`

Secondary exposure is meaningful but is **not equivalent to direct hypertrophy work**.

Do not change these coefficients during this remediation.

Do not rename exposure units to "effective sets".

---

## 1.4 Actual training outranks stale planning

For remaining-week decisions:

> Actual completed work and user modifications are more authoritative than the original prescription.

Actual work includes:

- prescribed work completed
- prescribed work completed with a modification
- user-added/unplanned exercises
- relevant completed sets from substitutions

Do not count merely planned-but-uncompleted work as actual exposure.

---

## 1.5 Missed reference is a signal, not debt

If the user does less than the package reference:

- do not create permanent debt
- do not automatically add all missed sets later
- do not blindly compensate with isolation work
- do not increase future volume merely because one week was incomplete

The system may adapt the remaining week when there is a justified opportunity.

Repeated patterns may inform future programming capacity.

---

## 1.6 Goal phase and goal success are separate from workout sessions

Do not use:

`workout_sessions.program_phase`

as the authoritative goal-phase state.

Goal phase state belongs in the dedicated goal-phase persistence model.

A goal phase should represent:

- phase identity
- goal
- start
- review point
- status
- programming reference/package level
- relevant priority/emphasis snapshot
- review outcome where applicable

---

# 2. P0 — Fix goal-review performance evidence

## Problem

The current goal review evidence can gather performance data from completed primary exercises without sufficiently restricting those exercises to the target represented by the goal.

This means an unrelated performance improvement could potentially influence the review of a goal.

Example of unacceptable behavior:

> Squat performance improves → contributes to the performance trend for a triceps goal.

That must not happen.

## Required behavior

Performance evidence for a goal must be **goal-target-specific**.

For a goal with a Blueprint target reference:

- identify the target represented by the goal
- identify exercises whose Blueprint target relationships are relevant to that target
- use only relevant exercise performance when constructing performance evidence for that goal

The existing Blueprint exercise metadata/target relationships must be reused.

Do not create a second manually maintained mapping if an authoritative Blueprint mapping already exists.

## Important

For compound exercises, use the existing target relationship semantics.

Do not assume that because an exercise has a secondary relationship to a target, its performance should automatically be treated as equivalent direct goal performance.

The review can use relevant performance evidence, but the exposure model remains:

- primary = 1.00
- secondary = 0.33

## Required implementation checks

Inspect the existing:

- goal target representation
- Blueprint exercise metadata
- exercise target lookup
- exposure engine
- performance repository
- goal review evidence builder

Then modify the smallest existing layer necessary.

Do not create a parallel exercise-target system.

## Required tests

Add tests covering at least:

### Test A — Relevant performance included

Goal:

`Triceps — Long-Head Emphasis`

Completed:

- relevant triceps exercise performance improves

Expected:

- triceps goal performance evidence reflects the improvement.

### Test B — Unrelated performance excluded

Same goal.

Completed:

- squat improves substantially
- unrelated leg exercise performance improves

Expected:

- triceps goal performance evidence is unchanged by those exercises.

### Test C — Compound relevance

A compound exercise that legitimately targets triceps as a secondary target may appear in the evidence only according to the existing target semantics.

Do not accidentally treat secondary exposure as direct exposure.

### Test D — Multiple relevant exercises

If several exercises are relevant to the goal target, their evidence can contribute without unrelated exercises leaking in.

---

# 3. P0 — Fix phase-level exposure evidence

## Problem

The current review evidence can expose a value that represents a recent/single-week exposure while the goal review is evaluating an entire multi-week phase.

A phase review must not describe a single week's exposure as though it were the phase's overall exposure.

## Required behavior

For each reviewed phase, calculate phase-level exposure from the actual training records whose dates fall inside that phase.

At minimum provide:

- phase start
- phase end/as-of date
- number of weeks/days covered
- phase total relevant exposure
- average weekly relevant exposure

Where practical, also retain a week-by-week breakdown for diagnostics.

## Definitions

### Phase total exposure

Sum the relevant actual exposure across the phase.

### Average weekly exposure

Normalize phase exposure across the actual covered weeks.

Do not pretend a partial phase is a full phase.

For example, if a phase has only 10 covered days at review time, the evidence should know that it is partial.

## Critical distinction

The review should distinguish:

```text
phase exposure
```

from:

```text
current-week exposure
```

Do not reuse a current-week variable under a misleading phase-level name.

## Required tests

### Test A — Multi-week aggregation

Create a phase spanning multiple weeks.

Record different actual exposures each week.

Expected:

- total = sum of all relevant actual exposure
- average = total / appropriate covered-week count

### Test B — Current week must not overwrite phase history

Earlier weeks contain exposure.

Current week contains different exposure.

Expected:

- phase review includes all phase weeks.

### Test C — Partial phase

Review occurs before the nominal phase end.

Expected:

- only actual covered dates are included
- no invented future exposure is included
- evidence identifies the phase as partial/in-progress.

### Test D — Unrelated target excluded

Exposure from another muscle/goal must not contribute to the target's phase exposure.

---

# 4. P0 — Remove invented graduation thresholds and arbitrary review methodology

## Problem

The implementation currently introduces concrete thresholds such as:

- adherence threshold around 60%
- measurement change threshold around 2%
- consecutive improving phases as a graduation requirement

These values were not part of the agreed Step 1–12 specification.

They must not become hidden physiological rules.

## Required behavior

The review engine should produce an evidence-based recommendation without inventing unsupported universal thresholds.

The supported recommendation vocabulary remains:

- `Continue`
- `Adjust`
- `Graduate`

However, the recommendation must be based on evidence rather than arbitrary hardcoded numbers that we have not deliberately approved.

## Graduation

Do NOT implement:

> "Graduate after exactly N consecutive improving phases."

Do NOT implement:

> "Graduate whenever measurement changes by X%."

Do NOT implement:

> "Graduate whenever adherence exceeds Y%."

Instead:

Graduation should be recommended only when the available evidence supports that the goal has sufficiently progressed toward its intended endpoint or the goal is otherwise reasonably considered complete.

If the system cannot establish that with the available evidence:

- do not falsely graduate
- prefer `Continue` or `Adjust` depending on the evidence
- record that evidence is insufficient when applicable

The user remains the final authority.

## Stagnation

Stagnation must not automatically mean:

> increase volume.

The system should diagnose first using:

- actual exposure
- adherence
- recovery
- performance
- relevant measurements
- aesthetic assessment
- user feedback where available

Only then can an `Adjust` recommendation be made.

## Adherence

Adherence may remain an evidence signal.

It must not silently become a universal physiological pass/fail threshold.

A low adherence pattern can explain why a goal did not progress, but that does not mean a fixed percentage is universally "failure".

## Required tests

### Test A — No fixed graduation count

A goal should not graduate merely because a hardcoded number of phases has improved.

### Test B — Insufficient evidence

Conflicting or insufficient evidence should not produce automatic graduation.

### Test C — Positive evidence

Strong, relevant positive evidence can support `Continue` or `Graduate` depending on whether the goal's endpoint is actually supported.

### Test D — Stagnation

Stagnation does not automatically increase volume.

### Test E — User authority

A user decision must be able to override the recommendation without the system silently changing it back.

---

# 5. P0 — Make goal-phase lifecycle consistent with active goals

## Problem

The new phase persistence model allows phases to be created somewhat independently of goal lifecycle.

An active goal can theoretically exist without an appropriate phase, and a phase could potentially specify a package level inconsistent with the goal's role.

## Required behavior

The goal lifecycle and phase lifecycle must be connected.

For active development goals:

- active goal → an active/current goal phase should exist
- active aesthetic goal development should use the Complete package reference
- non-goal development should use Efficient package reference

Do not allow a phase to silently undermine the goal's programming role.

## Important distinction

This does NOT mean every phase must automatically prescribe the Complete package volume exactly.

It means:

> the phase's development reference should be Complete for an active goal.

The actual programmer can still prescribe less/more for legitimate reasons.

## Initialization

Inspect the existing goal creation/activation path first.

If a phase is already initialized elsewhere, reuse it.

If not, add the smallest lifecycle hook needed so that activating/creating an active goal establishes its phase.

Do not create a second goal creation flow.

## Goal changes

If an active goal is:

- deactivated
- graduated
- replaced
- reprioritized
- materially changed

the phase lifecycle should reflect that change.

Do not silently rewrite historical phase evidence.

Historical phase records remain immutable except for explicit lifecycle state transitions supported by the design.

## Required tests

### Test A — Active goal gets phase

Create/activate a goal.

Expected:

- appropriate active phase exists.

### Test B — Goal phase reference

Active goal phase:

- package level = Complete

Non-goal reference:

- Efficient

### Test C — Deactivation

Deactivate goal.

Expected:

- current phase no longer remains falsely active.

### Test D — Historical phase preservation

Past phase evidence remains available.

### Test E — Goal change

Changing the goal does not silently mutate historical phase records.

---

# 6. P1 — Improve recovery evidence used by goal review

## Problem

The goal review currently uses an oversimplified recovery snapshot and may not reflect the same relevant recovery/activity information available to the normal programmer.

## Required behavior

Goal review should reuse existing recovery/activity infrastructure wherever possible.

Do not create a second recovery model.

Relevant inputs may include:

- recent training exposure
- recent target exposure
- training recency
- fatigue/recovery state
- badminton/other activity where already represented
- actual recent workload

The goal review does not need to duplicate every programmer calculation, but it must not knowingly fabricate a simplified recovery state that contradicts the main engine.

## Required tests

### Test A

High recent target workload → review evidence reflects relevant recovery consideration.

### Test B

No recent relevant workload → no false recovery warning.

### Test C

Badminton/other existing activity signal is handled consistently where the existing recovery engine supports it.

---

# 7. P1 — Make measurement evidence metric-specific

## Problem

The current review can compare measurements too generically.

Different metrics must not be treated as though they are interchangeable.

## Required behavior

Measurements should be compared by:

- metric identity/name
- unit
- target/goal relevance where applicable
- chronological date

Example:

```text
arm circumference
```

should be compared with:

```text
arm circumference
```

not:

```text waist circumference
```

or another metric.

## Multiple metrics

A goal may have multiple relevant measurements.

The review should retain separate evidence for each metric.

Do not collapse different measurements into a single meaningless percentage.

## Required tests

- same metric over time → valid trend
- different metrics → never compared directly
- different units → normalize only if an existing authoritative conversion exists; otherwise keep separate
- unrelated metric → excluded from goal-specific measurement evidence

---

# 8. P1 — Strengthen remaining-week adaptation verification

## Existing architecture to preserve

The existing weekly-first programmer and current-week reconciliation system are good.

Do not replace them.

The intended behavior remains:

```text
actual training
    ↓
recalculate accumulated exposure
    ↓
inspect remaining week
    ↓
adapt only where justified
```

## Required behavior

When actual training differs from plan:

- completed actual work must count
- user-added/unplanned relevant work must count
- modified completed work must count
- uncompleted planned work must not count as actual
- remaining sessions may adapt
- already completed history must never be rewritten
- unrelated future sessions should remain unchanged whenever possible
- no automatic debt creation

## Important

"Rerun the planner" is acceptable only if reconciliation guarantees the intended minimal-change semantics.

Do not assume that simply regenerating a week is sufficient.

## Required tests

### Scenario 1 — Planned work completed

Expected:

- no unnecessary extra compensation.

### Scenario 2 — Planned work missed

Expected:

- remaining week can adapt if justified
- no blind equivalent set debt.

### Scenario 3 — User adds relevant unplanned work

Expected:

- actual exposure includes it
- remaining work can reduce/reshape if appropriate.

### Scenario 4 — User adds unrelated work

Expected:

- unrelated target programming is not incorrectly reduced.

### Scenario 5 — Completed session

Expected:

- completed prescription/history is immutable.

### Scenario 6 — One session falls short

Expected:

- later session may adapt
- already completed session remains unchanged.

### Scenario 7 — Repeated shortfall

Expected:

- future programming can learn from adherence/capacity pattern
- no permanent debt accumulates.

### Scenario 8 — Repeated excess

Expected:

- future programming can learn from pattern
- no blind escalation occurs merely because the user repeatedly does extra sets.

---

# 9. P1 — Clarify package reference vs initial programming volume

The existing implementation may still use the global starting-point concept in the volume engine.

This is acceptable only if the semantics are explicit.

Document clearly:

> Blueprint package reference = development programming objective/reference.

and separately:

> Existing progression/volume logic may determine how much work is initially introduced.

Do not describe the package reference as an automatic prescription.

Do not accidentally reintroduce a hidden universal volume target.

For example:

```text
Complete reference = 26
```

does NOT mean:

```text
prescribe 26 today
```

and:

```text
Efficient reference = 16
```

does NOT mean:

```text
prescribe exactly 16 every week regardless of constraints.
```

The implementation must preserve this distinction in comments, types, and documentation.

---

# 10. Preserve these existing features exactly

The remediation must not regress any of the following.

## Add Unplanned Exercise

Must continue to:

- search the complete Blueprint exercise library
- require explicit exercise selection
- store underlying Blueprint ID
- reject arbitrary typed text
- count completed relevant work as actual training

Do not alter its behavior unless required by the target-specific exposure/review fixes.

## Substitute

Must continue to work exactly as before.

Do not redesign substitution.

## Training Profile

Must remain the recurring/default weekly schedule.

A current-week change must not silently mutate it.

## Current-week overrides

Must remain first-class.

Keep:

- Gym
- Badminton
- Both
- Unselected/rest

Do not add a separate stored Rest activity unless existing schema requires it.

## Current-week reconciliation

Preserve:

- existing future sessions where possible
- completed/locked sessions
- session IDs where appropriate
- user changes
- minimal reconciliation

## Historical actuals

Never:

- delete
- rewrite
- reinterpret
- overwrite

historical actual workout records merely because the programmer changes.

---

# 11. Preserve exposure semantics

Every change must continue to respect:

```text
Primary = 1.00
Secondary = 0.33
```

Do not convert secondary exposure into direct-set equivalence.

Do not call exposure units "effective sets".

Do not introduce exercise-specific coefficients during this remediation.

---

# 12. Preserve the decision hierarchy

The programming decision hierarchy remains:

```text
hard constraints
→ active-goal priority
→ Blueprint package reference
→ accumulated planned/actual direct & secondary exposure
→ recovery/fatigue
→ exercise coverage/redundancy
→ weekly/session distribution
```

This is **decision precedence**, not a weighted scoring formula.

Priority does not multiply volume.

Blueprint reference does not override:

- hard constraints
- actual completed work
- recovery
- higher-priority programming decisions

---

# 13. Preserve explainability

When the system deviates from a Blueprint package reference, use machine-readable reasons.

Accepted reason vocabulary includes:

- `time_constraint`
- `recovery`
- `sufficient_secondary_exposure`
- `goal_priority_tradeoff`
- `equipment_constraint`
- `exercise_redundancy`
- `actual_user_modification`
- `session_capacity`
- `adherence_pattern`

Do not create arbitrary unexplained deviation reasons.

If a new reason is genuinely required, document why before adding it.

---

# 14. Goal review evidence model

The final review evidence should conceptually look like:

```text
Goal
  ↓
Phase
  ↓
Evidence
  ├── aesthetic assessment trend
  ├── relevant measurement trends
  ├── relevant performance trend
  ├── actual target exposure across phase
  ├── adherence / completion pattern
  └── recovery / fatigue context
        ↓
Recommendation
  ├── Continue
  ├── Adjust
  └── Graduate
        ↓
User decision
```

The review must not reduce everything to:

```text
sets completed = success
```

or:

```text
measurement changed by X = success
```

or:

```text
performance increased = success
```

The evidence is multidimensional.

---

# 15. Goal phase timing

The previously agreed design remains:

> approximately 4–6 week phases.

This is a programming/review cadence, not a physiological guarantee.

Do not:

- automatically increase volume every week
- automatically graduate after a fixed number of phases
- automatically change exercises every phase

A phase can continue when evidence supports continuation.

A phase can be adjusted when diagnosis supports adjustment.

A phase can be graduated when the goal is sufficiently achieved or otherwise appropriately complete.

---

# 16. Recommended implementation order

Implement in exactly this order to minimize cross-feature debugging:

### Pass 1 — P0 performance evidence

1. Inspect goal target representation.
2. Inspect Blueprint exercise target metadata.
3. Inspect exposure target matching.
4. Correct goal-review performance filtering.
5. Add tests.
6. Run targeted tests.

### Pass 2 — P0 phase exposure

7. Inspect existing exposure aggregation.
8. Add phase date filtering.
9. Add phase total and average exposure.
10. Add partial-phase handling.
11. Add tests.
12. Run targeted tests.

### Pass 3 — P0 review methodology

13. Remove arbitrary graduation thresholds.
14. Remove fixed "N improving phases" graduation logic.
15. Remove universal measurement/adherence pass/fail thresholds where they are being used as physiological rules.
16. Preserve Continue/Adjust/Graduate vocabulary.
17. Add evidence insufficiency handling.
18. Add tests.

### Pass 4 — P0 goal-phase lifecycle

19. Inspect existing goal creation/activation flow.
20. Connect active goal lifecycle to phase lifecycle.
21. Ensure active goals use Complete package reference.
22. Preserve historical phase records.
23. Add lifecycle tests.

### Pass 5 — P1 recovery

24. Reuse existing recovery engine/data.
25. Remove fabricated/simplified recovery inputs where possible.
26. Add tests.

### Pass 6 — P1 measurements

27. Make measurement matching metric-specific.
28. Preserve multiple metrics separately.
29. Add tests.

### Pass 7 — P1 adaptation verification

30. Add/strengthen remaining-week tests.
31. Verify minimal reconciliation.
32. Verify no debt.
33. Verify actual modifications/unplanned work.
34. Verify repeated adherence patterns.

### Pass 8 — Documentation/type clarity

35. Clarify package reference vs actual prescription.
36. Clarify package reference vs global starting-point mechanics.
37. Ensure comments/types accurately describe semantics.

---

# 17. Testing requirements

Do not settle for only targeted tests.

The final verification must include:

```bash
npm run typecheck
npm test
npm run build
npm run verify
```

If `npm run verify` already runs build + typecheck + test, still run the project's canonical verification command and report its actual output.

## Test count

The previous baseline was:

> 55 test files / 578 tests

The Step 12 implementation reportedly increased this to:

> 656 tests

The final report must state:

- test files
- total tests
- passed
- failed
- skipped
- typecheck result
- build result

Do not merely state "tests pass".

---

# 18. Regression test requirements

Before declaring success, explicitly verify:

### Programming

- active goal → Complete reference
- non-goal → Efficient reference
- different muscles use different Blueprint references
- no universal 8-set target is used as the package reference
- package exercise lists are not copied blindly

### Exposure

- primary 1.00
- secondary 0.33
- actual completed sets only
- user-added relevant work counted

### Adaptation

- no permanent debt
- no blind compensation
- actual work influences remaining week
- repeated patterns inform future programming
- constraints can legitimately reduce programming

### Current-week state

- overrides persist
- profile unchanged
- completed history unchanged
- unaffected sessions preserved

### Goal phases

- phase separate from workout session phase field
- active goal has appropriate active phase
- historical phases retained
- review uses phase-level evidence
- recommendation is evidence-based
- user decision is authoritative

---

# 19. Do not make these changes

The developer must NOT use this remediation as an opportunity to:

- rewrite `workoutBuilder.ts` from scratch
- create a second programming engine
- replace the current reconciliation engine
- redesign SQLite persistence
- change Node/Express architecture
- introduce a new database
- introduce cloud infrastructure
- add paid services
- add arbitrary physiological formulas
- introduce universal set percentages
- introduce 75–80% package fallbacks
- change exposure coefficients
- change Training Profile semantics
- change Add Unplanned behavior
- change Substitute behavior
- rewrite historical workouts
- automatically increase volume every week
- automatically graduate goals after a fixed number of phases
- treat package references as quotas

This is a **targeted fix pass**, not a redesign.

---

# 20. Inspect-before-modifying requirement

Before editing any file:

1. Inspect the current Step 12 implementation.
2. Identify the exact existing functions responsible for:
   - goal review evidence
   - performance evidence
   - exposure aggregation
   - goal phase lifecycle
   - goal creation/activation
   - recovery evidence
   - measurement evidence
   - current-week adaptation
3. Reuse existing infrastructure wherever possible.
4. Make the smallest coherent changes.
5. Do not duplicate existing repositories, engines, mappings, or business rules.

If the implementation already satisfies a requirement, **do not change it merely for stylistic reasons.**

---

# 21. Expected changed-file discipline

At the end, report:

```text
Changed files:
- ...
- ...
- ...

Why each file changed:
- ...

Files intentionally left unchanged:
- ...
- ...

New tests:
- ...

Existing tests preserved:
- ...
```

Every changed file must have a concrete reason connected to this remediation.

---

# 22. Final Claude Code instruction

Use the following as the implementation instruction:

> You are implementing a targeted remediation pass for the Workout Programmer Step 12 implementation.
>
> Read this entire specification before changing anything.
>
> First inspect the current implementation and identify the exact existing functions/files responsible for goal review evidence, exposure aggregation, goal lifecycle, phase persistence, recovery evidence, measurement evidence, and remaining-week adaptation.
>
> Do NOT redesign the architecture. Do NOT replace the existing workout programmer. Do NOT create a second programming engine. Reuse existing Blueprint metadata, exposure infrastructure, recovery infrastructure, repositories, and current-week reconciliation wherever possible.
>
> Implement all P0 and P1 fixes in this document in the stated order.
>
> The four P0 requirements are mandatory:
>
> 1. Goal-review performance evidence must be target-specific. Unrelated exercise performance must never influence a goal review.
> 2. Goal-review exposure must be calculated across the actual goal phase, not represented by a single current-week value. Provide phase total and average/normalized weekly exposure and handle partial phases correctly.
> 3. Remove invented universal graduation thresholds and fixed "N improving phases" graduation logic. Do not introduce arbitrary measurement/adherence percentages as physiological pass/fail rules. Keep Continue/Adjust/Graduate as evidence-based recommendations with user final authority.
> 4. Connect active goal lifecycle to goal-phase lifecycle so active goals have an appropriate active phase and active goal development uses the Complete package reference. Preserve historical phases.
>
> Then implement the P1 requirements:
>
> - reuse real recovery/activity evidence rather than a fabricated simplified recovery snapshot;
> - make measurement evidence metric-specific;
> - strengthen remaining-week adaptation tests and guarantee minimal-change semantics;
> - clarify package reference versus initial volume/progression mechanics.
>
> Preserve all existing accepted behavior:
>
> - Add Unplanned Exercise
> - Substitute
> - Training Profile
> - current-week overrides
> - current-week reconciliation
> - historical actual immutability
> - primary exposure 1.00
> - secondary exposure 0.33
> - no universal package volume
> - no 75–80% fallback
> - no volume debt
> - no automatic weekly volume escalation
> - no arbitrary goal graduation
>
> Do not modify historical workout records.
>
> Do not silently modify the recurring Training Profile when changing the current week.
>
> Do not treat Blueprint package references as quotas.
>
> Do not invent new physiological thresholds unless explicitly supported by this specification.
>
> For every deviation from a Blueprint reference, preserve explainable machine-readable reasons.
>
> Add comprehensive regression tests for every changed behavior. Include both positive and negative tests, especially tests proving that unrelated exercises/measurements/exposure do not leak into a goal review.
>
> After implementation, run:
>
> `npm run typecheck`
>
> `npm test`
>
> `npm run build`
>
> `npm run verify`
>
> If any command fails, diagnose and fix the implementation rather than reporting success.
>
> At the end provide a concise but complete implementation report containing:
>
> 1. changed files;
> 2. exact behavior fixed;
> 3. tests added;
> 4. full test count/result;
> 5. typecheck result;
> 6. build result;
> 7. any remaining limitations;
> 8. confirmation that no deployment was performed.
>
> Do not stop after acknowledging the specification. Implement it fully, verify it fully, and report concrete results.

---

# 23. Final acceptance criteria

The remediation is complete only when all of the following are true:

- [ ] Goal performance evidence is target-specific.
- [ ] Unrelated exercise performance cannot affect goal review.
- [ ] Goal exposure is aggregated across the phase.
- [ ] Partial phases are handled correctly.
- [ ] Current-week exposure is not mislabeled as phase exposure.
- [ ] No arbitrary 2%/60%/N-phase graduation methodology remains as a universal rule.
- [ ] Graduation is evidence-based and conservative.
- [ ] Continue/Adjust/Graduate remain available.
- [ ] User has final authority.
- [ ] Active goals have appropriate active phases.
- [ ] Active goal development references Complete.
- [ ] Non-goal development references Efficient.
- [ ] Historical phase evidence is preserved.
- [ ] Recovery evidence uses existing relevant infrastructure.
- [ ] Measurements are metric-specific.
- [ ] Remaining-week adaptation has strong regression coverage.
- [ ] No volume debt exists.
- [ ] No 75–80% fallback exists.
- [ ] Primary exposure remains 1.00.
- [ ] Secondary exposure remains 0.33.
- [ ] Add Unplanned still works.
- [ ] Substitute still works.
- [ ] Training Profile remains unchanged by current-week overrides.
- [ ] Historical workouts remain immutable.
- [ ] Existing reconciliation behavior remains intact.
- [ ] No unnecessary architecture/infrastructure changes were made.
- [ ] Typecheck passes.
- [ ] Build passes.
- [ ] Full test suite passes.
- [ ] Final verification output is reported.

---

# 24. Design principle to keep visible

The entire implementation should continue to follow:

```text
Blueprint reference
        ≠
planned volume
        ≠
actual volume
        ≠
goal success
```

And the long-term programming loop remains:

```text
Blueprint package reference
        ↓
intelligent weekly allocation
        ↓
actual training
        ↓
actual exposure/history
        ↓
remaining-week adaptation
        ↓
next-week programming
        ↓
goal phase review
        ↓
Continue / Adjust / Graduate
        ↓
next phase
```

**Do not collapse these layers into one number.**
