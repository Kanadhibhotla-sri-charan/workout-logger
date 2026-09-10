# Workout Programmer — Remaining Post-v2 Corrective Fixes

## Purpose

This is the **remaining-issues-only** implementation specification for the current post-v2 Workout Programmer codebase.

The current implementation already contains the important v2 frequency improvements:

- actual recent exposure history;
- rolling 7-day exposure counting;
- minimum-spacing logic;
- same-run simulated exposure dates;
- exposure-scoped decisions;
- equipment/time invariance during normal generation;
- authored exercise-set protection;
- structured skip/reason handling.

**Do not replace or regress those working pieces.**

The remaining task is to remove the residual **calendar-week quota/debt architecture** that still sits underneath the corrected exposure-frequency logic.

---

# 1. Primary remaining defect

The current planner is still effectively structured as:

```text
weekly development/reference amount
        ↓
remainingWeeklySets
        ↓
calendar-day iteration
        ↓
frequency/exposure gate
        ↓
exercise prescription
```

The target architecture must instead be:

```text
development reference
        ↓
target development objective
        ↓
actual exposure history
        ↓
frequency/cadence decision
        ↓
next appropriate exposure
        ↓
exercise prescription
```

The frequency gate is now substantially corrected. **Do not remove it.**

The remaining correction is to stop `remainingWeeklySets` and related weekly-deficit state from acting as an authoritative reason to stop or force target programming.

---

# 2. `remainingWeeklySets` must stop being authoritative

Inspect the current uses of:

```ts
remainingWeeklySets
```

including its initialization, mutation, comparisons, and any conditions such as:

```ts
if (remainingWeeklySets <= 0) break;
```

The planner must not terminate target planning merely because a calendar-week set counter reached zero.

### Required behavior

A target's programming eligibility must be determined by:

1. whether its next exposure is appropriate;
2. actual exposure history;
3. frequency/cadence;
4. recovery;
5. legitimate programming/selection decisions.

It must **not** be determined by:

```text
"we already allocated this week's sets"
```

or:

```text
"we still owe this week's sets"
```

---

# 3. Preserve weekly references, but downgrade their authority

The following values may remain in the code where they are useful:

```ts
weekly_direct_set_reference
desiredWeekly
weekly_exposure_units
```

They can support:

- development-reference reporting;
- diagnostics;
- display;
- development-level comparisons;
- appropriate ranking information.

But they must not create:

- weekly set debt;
- forced catch-up;
- a hard weekly planning stop;
- automatic extra exposure;
- automatic additional sets;
- automatic additional exercises.

### Explicit invariant

A target being below its nominal weekly reference does **not** by itself mean:

```text
prescribe more work today
```

---

# 4. Remove the weekly "debt" concept

The programmer must not calculate or maintain an authoritative concept equivalent to:

```text
weekly_required_sets - weekly_completed_or_planned_sets
```

and then use the result to force future programming.

There is no missed-set debt.

### Example

If a target has a nominal reference of 16 sets/week but receives only one appropriate exposure in a particular calendar week:

```text
Week 1:
1 actual exposure
```

do not automatically produce:

```text
Week 2:
2 exposures
```

or:

```text
Week 2:
double sets
```

or:

```text
Week 2:
extra exercise because Week 1 was short
```

The next week begins from actual exposure state and the normal cadence decision.

---

# 5. Frequency logic must remain intact

The current rolling-frequency correction is a **success**.

Retain the logic that considers:

- actual exposure dates;
- exposure count in the relevant rolling window;
- minimum spacing;
- same-run simulated exposure dates.

Do not revert to a simple:

```ts
daysSinceLastExposure >= expectedExposureIntervalDays
```

implementation.

### Important

Minimum spacing is only one component.

For a target with frequency:

```text
2/week
```

this must still prevent:

```text
Monday
Thursday
Sunday
```

from automatically becoming three exposures merely because the minimum interval elapsed.

---

# 6. Actual vs simulated exposure remains strictly separated

Preserve the current distinction between:

### Actual state

Derived from completed/logged training.

### Planning state

Examples:

```ts
simulatedLastExposureDate
exposureDatesThisRun
```

Planning state exists only to prevent the current program-generation pass from scheduling contradictory/duplicate future exposures.

It must never:

- be persisted as completed training;
- modify actual exposure history;
- advance permanent cadence state;
- create future "completed" exposure records.

If the generated future session is never completed, it must have no effect on actual exposure state.

---

# 7. Calendar week must remain only a boundary

The calendar week may still be used for:

- program persistence;
- UI organization;
- reporting;
- weekly summaries.

It must not reset:

- actual exposure history;
- cadence state;
- frequency count;
- next-exposure reasoning.

The programmer should continue across:

```text
Sunday → Monday
```

using actual historical exposure data.

---

# 8. Do not force all reference volume into the generated week

A development reference is not a promise that every calendar week will contain exactly that number of sets.

If the available appropriate training opportunities produce less work than the reference:

- accept the actual programming;
- do not invent debt;
- do not cram exposures;
- do not inflate authored sets.

The reference remains a development guide.

---

# 9. Do not force an exposure merely to satisfy a weekly number

A target that is not due should remain not due even if:

```text
planned weekly sets < reference
```

Likewise, a target that is due should not be blocked solely because:

```text
remainingWeeklySets == 0
```

The exposure decision must take precedence over calendar-week arithmetic.

---

# 10. Target ranking must be reviewed

Inspect:

```ts
rankTarget(...)
```

and all callers/inputs involving:

```ts
weekly_exposure_units
weekly_direct_set_reference
needDeficit
```

Remove or refactor any logic where a weekly deficit becomes a hidden mandatory programming quota.

### Allowed use

Weekly reference information may still help distinguish:

- specialization/goal emphasis;
- normal development;
- maintenance;
- relative development priority.

### Not allowed

It must not mean:

```text
largest weekly deficit = must receive another exposure today
```

when the target is not due.

The corrected exposure/cadence decision must remain authoritative.

---

# 11. Keep development-level semantics

Do not change the established development-reference rule:

### Goal-linked targets

Use:

```text
Complete
```

development reference.

### Non-goal targets

Use:

```text
Efficient
```

development reference.

Do not introduce a generic 75–80% fallback.

These references describe development level; they do not become weekly quotas.

---

# 12. Keep package references separate from target programming

A package-level reference may still be calculated from Blueprint package data.

For example:

```text
package exercise sets × package frequency
```

may remain a package-level weekly reference.

However, do not automatically interpret the package aggregate as:

```text
every target's direct weekly requirement
```

when the package covers multiple targets.

Keep separate concepts for:

1. package reference;
2. target development objective;
3. per-exposure objective;
4. exercise authored sets;
5. actual exposure.

---

# 13. Preserve authored-set caps

Do not alter the existing protection that an exercise cannot exceed its Blueprint-authored per-session set count.

For example:

```text
Blueprint:
Hip Abduction = 2 sets/session
```

must never become:

```text
Hip Abduction = 8 sets
```

because a weekly reference is 8 or 16.

If more development work is appropriate, the programmer must construct it from legitimate Blueprint exercise variations/exposures.

Never mutate authored prescription to solve a reference-volume calculation.

---

# 14. Preserve Blueprint exercise validity

Do not introduce or retain a rule that says an authoritative Blueprint exercise is invalid because it:

- was not selected today;
- is not due today;
- belongs to another valid rotation;
- is redundant today;
- is deferred to a later exposure;
- is not the preferred variation today.

Those are selection decisions.

Only a genuine Blueprint/source-data defect should produce a data-integrity/invalid-prescription state.

---

# 15. Preserve time/equipment invariance

Normal generation must remain invariant to:

- available equipment;
- available training time.

Do not reintroduce equipment/time filtering into the normal exercise candidate pool.

Equipment/time logic may remain for explicit substitution or feasibility operations.

---

# 16. Skip scope must remain decision-scoped

Do not convert an individual exposure decision such as:

```text
not_due
```

into a week-wide skip automatically.

Use the existing structured scope/reason model.

Examples:

```text
not_due
adequate_exposure
recovery
not_compatible_today
data_integrity
```

should describe the actual reason for not prescribing.

A target not due on Monday may become due on Thursday.

---

# 17. Reconciliation remains canonical

Keep:

```text
ensureWeekProgramGenerated()
reconcileAfterActualTraining()
reconcileWeekProgram()
```

as the canonical programming/reconciliation path.

Do not add a separate "weekly deficit reconciliation" path.

After actual completion:

```text
actual training
    ↓
actual exposure calculation
    ↓
canonical planner
    ↓
future-program reconciliation
```

Completed/locked sessions must remain protected.

---

# 18. Required code-level cleanup

Before editing, inspect all references to:

```text
remainingWeeklySets
desiredWeekly
weekly_direct_set_reference
weekly_exposure_units
needDeficit
simulatedLastExposureDate
exposureDatesThisRun
isDueToday
```

For each occurrence, classify it as one of:

```text
A. authoritative actual state
B. temporary planning state
C. development/reference data
D. reporting/diagnostic data
E. obsolete weekly-quota logic
```

Only category E should be removed.

Do not delete useful reference/reporting data simply because it contains the word "weekly."

---

# 19. Preferred end-state of the planner

The final flow should conceptually resemble:

```text
For each target:

  1. Load development reference.
  2. Load actual exposure history.
  3. Determine frequency/cadence state.
  4. Determine whether next exposure is appropriate.
  5. If not appropriate:
       record structured reason.
       do not create weekly debt.
  6. If appropriate:
       select valid Blueprint exercises.
       respect authored sets.
       construct the exposure.
  7. During this generation run only:
       update simulated planning state.
  8. Never convert simulated work into actual history.
```

The exact function decomposition may differ from this conceptual flow. Adapt to the existing architecture rather than creating unnecessary duplicate engines.

---

# 20. Mandatory regression tests

Add/update tests for the remaining architecture.

## Test 1 — Weekly counter cannot stop a due exposure

Construct a case where:

```text
remainingWeeklySets = 0
```

but the target's actual exposure/frequency state says the target is due.

Expected:

```text
target can still receive its appropriate next exposure
```

The weekly counter must not block it.

---

## Test 2 — Weekly deficit cannot force a not-due target

Construct a case where:

```text
weekly reference is not yet met
```

but the target is not due according to actual exposure/frequency state.

Expected:

```text
target remains not due
```

No catch-up exposure is generated.

---

## Test 3 — No catch-up after an underfilled week

Example:

```text
Frequency: 2/week

Week 1:
1 actual exposure

Week 2:
```

Expected:

- no automatic doubling;
- no two exposures crammed into one session;
- no extra authored sets;
- no weekly debt.

---

## Test 4 — Frequency 2/week Monday/Thursday/Sunday

Expected:

```text
Monday  = exposure
Thursday = exposure
Sunday = not automatically another exposure
```

The rolling-frequency state must prevent the third exposure.

---

## Test 5 — Calendar boundary continuity

Example:

```text
Week 1: Thursday exposure
Week 2: Thursday next exposure
```

Expected:

- Week 2 does not reset the target's history;
- cadence is continuous.

---

## Test 6 — One compatible session per week

Example:

```text
Week 1: Thursday
Week 2: Thursday
Week 3: Thursday
```

for a target whose Blueprint frequency is 2/week.

Expected:

- one exposure per compatible actual opportunity;
- no debt;
- no forced second exposure inside a single session.

---

## Test 7 — Planned exposure is not actual

Generate a future exposure but do not complete it.

Regenerate/reconcile.

Expected:

```text
actual exposure history unchanged
```

---

## Test 8 — Actual completion changes future state

Complete/log the exposure.

Regenerate/reconcile.

Expected:

```text
actual exposure history updated
future cadence/programming responds
```

---

## Test 9 — Authored-set cap

For every selected exercise:

```text
generated sets <= Blueprint authored sets/session
```

---

## Test 10 — Blueprint exercise remains valid

An authoritative Blueprint exercise excluded from today's prescription must not be reported as:

```text
No valid prescription
```

unless there is an actual source-data defect.

---

## Test 11 — Time invariance

Same state/date, different available time.

Expected:

```text
normal generated program unchanged
```

---

## Test 12 — Equipment invariance

Same state/date, different equipment availability.

Expected:

```text
normal generated program unchanged
```

---

## Test 13 — Package aggregate is not duplicated

For a package covering multiple targets, verify that the package-level weekly reference does not automatically become the full direct weekly requirement of every target.

---

## Test 14 — Skip scope

A target with:

```text
not_due
```

on one session must not automatically appear as a week-level skip on every session.

---

## Test 15 — Completed/locked protection

After reconciliation:

- completed sessions remain unchanged;
- locked sessions remain unchanged;
- only eligible future sessions may change.

---

# 21. Verification checklist

Before declaring the fix complete, verify:

- [ ] `remainingWeeklySets` no longer acts as a hard planning stop.
- [ ] No weekly deficit creates mandatory exposure.
- [ ] No weekly deficit creates catch-up sets.
- [ ] No weekly deficit creates catch-up exercises.
- [ ] Correct rolling-frequency logic remains intact.
- [ ] Minimum spacing remains only a supporting constraint.
- [ ] Actual exposure history remains authoritative.
- [ ] Calendar-week transitions do not reset cadence.
- [ ] Simulated exposure remains temporary.
- [ ] Actual completion changes future programming.
- [ ] Efficient/Complete development semantics remain unchanged.
- [ ] Package reference and target objective remain separate.
- [ ] Authored exercise set counts remain authoritative.
- [ ] Blueprint exercises remain valid candidates.
- [ ] Normal generation remains time/equipment invariant.
- [ ] Skip scope remains decision-scoped.
- [ ] Canonical reconciliation remains intact.
- [ ] Completed/locked sessions remain protected.
- [ ] All existing tests remain green.
- [ ] New regression tests pass.
- [ ] Typecheck passes.
- [ ] Production build passes.
- [ ] Verification command(s) pass.

---

# 22. Deployment safety

After implementation:

1. Run the full test suite.
2. Run typecheck.
3. Run production build.
4. Run all project verification checks.
5. Inspect the diff for unintended database/schema/data changes.
6. Commit and push to GitHub `main`.
7. Deploy from the production VM by pulling GitHub `main`.
8. Do not deploy from the local Windows repository.
9. Do not reset, replace, or recreate the production SQLite database.
10. Do not run `sync-blueprint` during normal deployment.
11. Verify application service, nginx, HTTP health, SQLite integrity, and foreign-key integrity.
12. Verify historical sessions, goals, completed/locked sessions, and future programming.

---

# 23. Final acceptance principle

The remaining fix is successful when the planner can no longer be described as:

> "A weekly quota calculator with a frequency check."

It should instead be:

> **"An exposure-based programmer whose development references guide the amount of development, whose actual training history determines cadence, and whose calendar week merely organizes the resulting future program."**

The existing v2 rolling-frequency correction is part of that final architecture and must be preserved.
