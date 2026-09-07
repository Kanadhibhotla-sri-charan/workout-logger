# Workout Programmer — Developer Implementation Specification

## Purpose

Implement the agreed Workout Programmer programming redesign in the existing Workout Logger codebase.

This is an **evolution of the existing programmer, not a rewrite**.

The implementation must make the Blueprint development packages authoritative reference inputs, incorporate actual training into remaining-week decisions, and introduce longitudinal goal phases and reviews while preserving the existing production architecture and already-working functionality.

---

# 1. Non-Negotiable Rules

## Blueprint

1. Blueprint is the sole source of development-package volume references.
2. **Active goal → Complete package.**
3. **Non-goal → Efficient package.**
4. Weekly references must be calculated from actual Blueprint package data.
5. Never hardcode a universal weekly volume number.
6. Never assume all muscles have the same volume or frequency.
7. Do not copy Complete/Efficient exercise lists directly into generated workouts.
8. Package numbers are **programming references, not quotas**.

## Exposure

9. Primary/direct exposure = **1.00** per completed set.
10. Secondary exposure = **0.33** per completed set.
11. Do not call exposure units "effective sets."
12. Secondary exposure informs programming decisions but does not automatically replace direct hypertrophy work 1:1.

## Adaptation

13. Actual completed work outranks the original prescription for remaining-week decisions.
14. User-added and user-modified work counts as actual training.
15. Same-week adaptation may modify only relevant remaining work.
16. Completed/history data must never be rewritten.
17. Missed reference volume is **not permanent volume debt**.
18. Do not implement an arbitrary 75–80% fallback.
19. Do not automatically compensate simply because a user missed sets.
20. Adaptation must consider why the deviation occurred.

## Goals

21. Active goals operate through approximately **4–6 week phases** initially.
22. Phase progression does not automatically mean volume escalation.
23. Exercise progression and goal progression are separate.
24. Goal review considers multiple evidence sources.
25. Review recommendation = **Continue / Adjust / Graduate**.
26. User has final authority.
27. Goal success is not defined by completing a volume reference.
28. Goal-phase state must remain separate from `workout_sessions.program_phase`.

---

# 2. Phase 1 — Inspect Before Modifying

Before changing code, inspect:

- `src/engine/`
- `src/lib/`
- `src/repositories/`
- `src/server/routes/`
- `src/types/`
- `src/blueprint/`
- `tests/`
- `data/programming/`

Pay particular attention to:

- `workoutBuilder.ts`
- `volumeEngine.ts`
- `exposureEngine.ts`
- `resourceAllocation.ts`
- `weekProgramReconciliation.ts`
- `developmentPackages.ts`
- `weeklyProgramRepo.ts`
- goal repositories
- assessment repositories
- measurement repositories
- goal event repository
- database schema/migration conventions
- existing programming tests

**Do not modify anything during inspection.**

First establish the existing test/build baseline and identify:

- reusable infrastructure
- old/conflicting programming behaviour
- genuinely missing infrastructure

Do not assume something is missing until the existing implementation has been inspected.

---

# 3. Phase 2 — Blueprint Development References

Create one authoritative programming abstraction for a target's development reference.

Conceptually:

```ts
DevelopmentReference
```

It should expose at least:

- target
- package ID
- package level
- weekly direct-set reference
- relevant coverage information

The weekly direct-set reference must be derived from the actual Blueprint package data:

```text
sum(package exercise sets) × package frequency
```

Do not duplicate package volume constants inside Logger.

If Blueprint package data changes, the calculated programming reference should change automatically.

---

# 4. Phase 3 — Replace Universal Development Volume

Inspect every place where programming currently assumes a global starting volume such as the global `8`-set starting point.

Do not remove the Blueprint global principles wholesale.

They remain valid as general programming guidance.

However, where the global starting point is currently being used as the **development target for every muscle**, replace that behaviour with the target's own package reference.

The desired model is:

```text
Active goal → Complete package reference
Non-goal → Efficient package reference
```

Different muscles must be allowed to have different Blueprint-derived references.

---

# 5. Phase 4 — Goal / Non-Goal Classification

Target classification must use the appropriate package reference.

### Active goal

Use the target's **Complete** package.

### Non-goal

Use the target's **Efficient** package.

Programming decisions should then consider:

- package reference
- actual direct exposure
- actual secondary exposure
- planned future work
- goal priority
- recovery
- constraints
- exercise coverage/redundancy

Do not use a universal threshold such as "8 sets" as the development target.

---

# 6. Phase 5 — Weekly-First Programming

Preserve the current weekly-first architecture.

The intended decision flow is:

1. Identify relevant targets.
2. Determine each target's Blueprint reference.
3. Identify active goals and priorities.
4. Calculate accumulated actual exposure.
5. Calculate relevant planned future work.
6. Apply hard constraints.
7. Evaluate recovery/fatigue.
8. Evaluate exercise coverage/redundancy.
9. Allocate weekly work.
10. Fit that work into sessions.

Do not revert to mechanically equal session splitting.

Do not regenerate the entire current week when only a small remaining portion needs adjustment.

---

# 7. Phase 6 — Goal-Specific Exercise Selection

Blueprint package references define development level and coverage; they do **not** dictate the exact generated exercise list.

For a goal such as:

> Triceps — Long Head Emphasis

the programmer should:

- develop the overall triceps
- bias appropriate long-head work
- use meaningful compound secondary exposure
- avoid redundant exercises
- respect equipment
- respect session capacity

Do **not** translate the goal into repeated sets of one exercise merely to reach the package number.

---

# 8. Phase 7 — Actual-Training Adaptation

Add an explicit remaining-week planning pass.

Conceptually:

```text
Current week
    ↓
Completed actual work
    ↓
Recalculate accumulated exposure
    ↓
Inspect remaining sessions
    ↓
Determine whether adjustment is justified
    ↓
Modify minimum necessary future work
```

Example:

```text
Monday planned = 4
Monday actual  = 2
```

Do **not** automatically make Friday `+2`.

Evaluate:

- actual exposure
- secondary exposure
- goal priority
- remaining capacity
- recovery
- exercise redundancy
- why the deviation occurred

The resulting action may be:

- no change
- useful additional work
- exercise redistribution
- another justified adjustment

---

# 9. Deviation Reasons

Where programming meaningfully deviates from the Blueprint reference, use machine-readable reasons.

Initial reasons:

- `time_constraint`
- `recovery`
- `sufficient_secondary_exposure`
- `goal_priority_tradeoff`
- `equipment_constraint`
- `exercise_redundancy`
- `actual_user_modification`
- `session_capacity`
- `adherence_pattern`

Reasons must correspond to the actual programming decision, not merely be decorative text.

---

# 10. Goal Phase Persistence

Add dedicated persistent goal-phase state.

A goal phase should conceptually contain:

- ID
- goal ID
- start date
- review date
- status
- package level
- priority snapshot where historically required
- emphasis
- created timestamp
- completion timestamp

Follow the existing SQLite schema/migration conventions.

Do **not** use `workout_sessions.program_phase` as the authoritative goal-phase record.

Goal phase is longitudinal goal state; workout session phase is session metadata.

---

# 11. Goal Phase Lifecycle

Implement the lifecycle:

```text
active
  ↓
review_due
  ↓
review
  ↓
continue / adjust / graduate
```

A new phase begins cleanly.

Previous phases remain historical.

No volume debt transfers from one phase to another.

A phase does not automatically escalate volume merely because another week has passed.

---

# 12. Goal Review Engine

Create a dedicated goal review engine rather than putting longitudinal review logic inside `workoutBuilder.ts`.

Review evidence should include, where available:

- aesthetic assessment
- relevant body measurements
- exercise performance
- actual exposure
- adherence
- recovery

Output should contain:

```text
recommendation:
  continue | adjust | graduate

evidence
reason
```

The engine recommends.

**The user decides.**

---

# 13. Goal Review Persistence

Persist:

- phase
- review date
- system recommendation
- user decision
- relevant evidence/snapshot
- reason

This must allow a later user/developer to understand what evidence informed the decision.

---

# 14. Assessment / Measurement Infrastructure

Inspect the existing:

- `aesthetic_assessments`
- `measurements`
- goal repositories
- goal event infrastructure

Reuse existing storage.

If functionality already exists in repositories but lacks routes/UI exposure, expose the existing functionality rather than creating duplicate tables or storage systems.

---

# 15. Testing Discipline

The current verified baseline is:

- **55 test files**
- **578 tests**

All existing tests must remain green.

After each logical implementation phase, run:

```bash
npm run verify
```

Do not wait until the end to discover regressions.

---

# 16. Required New Tests

## A. Blueprint reference tests

Verify:

- Efficient reference is calculated correctly.
- Complete reference is calculated correctly.
- Correct package is selected.
- No universal hardcoded number is used.
- Missing package behaviour is explicit.
- Different muscle groups can have different references.

## B. Goal/non-goal tests

Verify:

```text
Active goal → Complete
Non-goal → Efficient
```

Verify:

```text
Goal 1 > Goal 2 > normal development > maintenance
```

without priority multiplying volume.

## C. Exposure tests

Verify:

```text
Primary = 1.00
Secondary = 0.33
```

Verify secondary exposure influences decisions but is not mislabeled as direct sets.

## D. Weekly adaptation tests

Test:

- planned < actual
- planned > actual
- user-added work
- user-modified work
- unplanned exercises
- remaining future sessions
- completed future sessions
- current-week preservation

## E. No-debt tests

Verify:

```text
Missed reference
→ adaptation opportunity
→ week ends
→ no accumulating volume debt
```

## F. Constraint tests

Verify that package references do not override:

- time constraints
- equipment restrictions
- available training days
- recovery limitations
- explicit user exclusions

## G. Priority tests

Verify:

```text
Goal 1
  >
Goal 2
  >
normal development
  >
maintenance
```

but verify that priority does not multiply volume.

## H. Goal phase tests

Test:

- phase creation
- active state
- review due
- Continue
- Adjust
- Graduate
- new phase creation
- historical phase preservation
- no debt transfer

## I. User override tests

Example:

```text
System recommendation → Graduate
User decision → Continue
```

Verify the user's decision wins and is recorded.

## J. Review evidence tests

Do not let the system equate volume completion with success.

Test scenarios such as:

- improving assessment + improving measurement + improving performance
- stagnant assessment with low actual exposure
- stagnant assessment with adequate exposure
- poor recovery
- poor adherence

The review should diagnose before blindly escalating volume.

## K. Explainability tests

Verify that meaningful deviations have a valid reason from the defined reason set.

---

# 17. Regression Protection

Explicitly protect all existing functionality:

### Current-week reconciliation

- activity overrides
- persisted week
- future session preservation
- session ID preservation
- completed-session protection

### Exercises

- Add Unplanned Exercise
- Substitute

### Training Profile

Current-week changes must not silently mutate the recurring profile.

### History

Completed workout facts remain immutable.

### Database

SQLite integrity must remain valid.

---

# 18. Recommended Code Ownership

Reuse existing architecture where possible.

Conceptually:

```text
developmentPackages.ts
    ↓
Blueprint package lookup/reference

developmentReferenceEngine.ts
    ↓
Complete/Efficient development references

workoutBuilder.ts
    ↓
weekly/session programming orchestration

resourceAllocation.ts
    ↓
priority/resource conflicts

exposureEngine.ts
    ↓
actual + secondary exposure

recovery engine
    ↓
recovery signals

weekProgramReconciliation.ts
    ↓
current-week surgical adaptation

goalPhaseEngine.ts
    ↓
goal lifecycle + review recommendation

goalPhaseRepo.ts
    ↓
goal phase persistence

goalPhaseReviewsRepo.ts
    ↓
review evidence + decisions
```

Do not create a second independent workout programmer.

---

# 19. Implementation Sequence

Execute in this order:

```text
Phase 1
Inspect + establish baseline

        ↓

Phase 2
Blueprint development references

        ↓

Phase 3
Goal/non-goal package integration

        ↓

Phase 4
Weekly programming integration

        ↓

Phase 5
Actual-training adaptation

        ↓

Phase 6
Deviation reasons

        ↓

Phase 7
Goal phases

        ↓

Phase 8
Goal reviews

        ↓

Phase 9
Full regression + verification
```

Make small logical commits.

Do not combine the entire redesign into one giant change.

---

# 20. Git Discipline

Before implementation:

```bash
git status
git log -1
```

Create a dedicated branch.

Prefer logical commits such as:

```text
Add Blueprint development references
Use package references in weekly allocation
Adapt remaining week from actual training
Add goal phase persistence
Add goal phase review engine
Add programming regression tests
```

Review the diff after each logical stage.

---

# 21. Deployment Guardrails

**Do not deploy automatically.**

Before any deployment:

```bash
npm run verify
npm run build
```

Then inspect the final diff and test the local application.

Do not change:

- Node.js + Express architecture
- SQLite
- Nginx
- systemd
- Oracle VM infrastructure
- database architecture

Do not:

- add Docker
- add Kubernetes
- add a new database
- add paid services
- run `npm audit fix`
- perform unrelated dependency upgrades
- perform unrelated refactors

Deployment occurs only after explicit approval.

---

# 22. Exact Claude Code Instruction

Use the following as the developer-facing implementation brief:

> **Implement the Workout Programmer programming redesign specified below.**
>
> First inspect the existing Workout Logger and Blueprint integration and establish the current test/build baseline. Do not modify code during inspection.
>
> Modify the existing programming pipeline rather than creating a second independent programmer.
>
> Active goals must use the Blueprint Complete development-package weekly direct-set reference. Non-goals must use the Blueprint Efficient development-package weekly direct-set reference. These references must be calculated from actual Blueprint package data; do not introduce universal hardcoded weekly volume values.
>
> Package references are programming objectives/reference points, not rigid quotas and not today's prescription. Do not copy package exercise lists directly into generated workouts.
>
> Preserve the existing primary exposure coefficient of 1.00 and secondary exposure coefficient of 0.33. Secondary exposure must influence programming decisions but must not be mislabeled as direct sets or treated as a guaranteed 1:1 replacement for direct hypertrophy work.
>
> Weekly programming remains weekly-first. The decision hierarchy is:
>
> 1. hard constraints
> 2. active-goal priority
> 3. Blueprint package reference
> 4. accumulated planned/actual direct and secondary exposure
> 5. recovery/fatigue
> 6. exercise coverage/redundancy
> 7. weekly/session distribution
>
> Actual completed work, including user modifications and unplanned exercises, must inform remaining-week programming. Same-week adaptation may modify only relevant remaining work and must preserve completed/history data. Missed reference volume is not permanent volume debt and must never accumulate indefinitely. Do not implement an arbitrary 75–80% fallback.
>
> Do not automatically compensate merely because sets were missed. Evaluate actual exposure, secondary exposure, goal priority, recovery, constraints, session capacity, exercise redundancy, and the reason for the deviation.
>
> Goal phases should initially operate over approximately 4–6 weeks. Add dedicated persistent goal-phase state rather than using `workout_sessions.program_phase`. Implement phase review using aesthetic assessment, measurements where available, performance, actual exposure, adherence, and recovery. The system recommends Continue, Adjust, or Graduate; the user retains final authority. Do not use volume completion as the definition of goal success.
>
> Preserve existing Add Unplanned Exercise, Substitute, Training Profile, current-week activity overrides, current-week persistence/reconciliation, historical workout immutability, and the existing Node.js + Express + SQLite architecture.
>
> Add comprehensive tests and maintain all existing tests. Run `npm run verify` after each logical implementation stage and before completion.
>
> Do not make unrelated refactors, dependency upgrades, infrastructure changes, schema redesigns, or UI redesigns unless strictly required by the above functionality.
>
> Before declaring completion, report:
>
> - files changed
> - database changes
> - old programming behaviour replaced
> - new programming behaviour
> - tests added
> - full test result
> - build/typecheck result
> - any assumptions or unresolved issues
>
> Do not deploy until explicitly instructed.

---

# 23. Core Design Principle

The implementation must preserve this distinction:

```text
Blueprint reference
        ≠
planned volume
        ≠
actual volume
        ≠
goal success
```

The intended long-term loop is:

```text
Blueprint reference
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

The programmer should therefore answer:

> **"Given the Blueprint reference, this user's goals, actual training, recovery, constraints, exercise coverage, and remaining opportunities, what is the most appropriate training allocation now?"**

It should not answer:

> "The Blueprint says X sets, so prescribe X sets."

And it should not answer:

> "The user missed X sets, so add X sets."

The Blueprint is the reference. The programmer makes the allocation.
