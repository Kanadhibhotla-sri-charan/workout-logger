# Workout Programmer — Post-v2 Corrective Fix v2

## Purpose

This specification is the implementation contract for correcting the remaining Workout Programmer issues identified after the v2 implementation review.

The goal is **not** to undo the successful v2 work. Preserve the existing improvements and correct the remaining semantic problems, especially the interaction between development references, weekly state, frequency, exposure cycles, exercise prescription, and skip explanations.

---

# 1. Preserve the v2 successes

Do **not** regress the following behavior that is already correct:

1. Equipment availability must **not** influence normal program generation.
2. Time availability must **not** influence normal program generation.
3. Equipment filtering may remain available for explicit substitution/feasibility operations.
4. Authored per-exercise session sets are authoritative.
5. The programmer must never inflate authored exercise sets merely to satisfy a target.
6. Blueprint exercises are valid prescribable exercises by definition when they are authoritative Blueprint exercise variations.
7. A Blueprint exercise not selected today is **not** an invalid exercise.
8. Friendly explanations should be generated from structured engine facts rather than invented prose.
9. Completed/locked sessions must remain protected during reconciliation.
10. Reconciliation must use the canonical programmer rather than ad-hoc SQL regeneration.
11. The Blueprint remains a runtime snapshot and normal startup/deployment must not require syncing from a live Blueprint repository.
12. Existing tests covering the above must continue to pass.

---

# 2. Core semantic correction

The current post-v2 implementation is still effectively combining:

> weekly volume objective → remainingWeeklySets → isDueToday → exposure

That is not sufficient.

The intended model is:

> development reference → target programming objective → actual exposure history/state → frequency decision → next appropriate exposure → exercise prescription

A calendar week is a **reporting and persistence boundary**. It is not automatically the target's exposure-cycle boundary.

The programmer must reason about **actual exposures**, not weekly set debt.

---

# 3. Frequency is NOT just minimum spacing

## Mandatory rule

Frequency cannot be implemented solely as:

```ts
daysSinceLastExposure >= expectedExposureIntervalDays
```

The existing calculation:

```ts
Math.floor(7 / sessionsPerWeekForInterval)
```

may be retained only as a **spacing heuristic**, never as the complete frequency gate.

### Why

For a target with frequency `2/week`, a simple 3-day minimum interval can allow:

- Monday
- Thursday
- Sunday

That produces three exposures inside a 7-day period.

That violates the intended frequency reference.

Therefore:

> **Minimum spacing and maximum/reference exposure frequency are separate constraints.**

---

# 4. Actual exposure history is the source of truth

Frequency decisions must be based on **actual completed/logged exposure history**, not on the number of sessions generated in the current calendar week.

Use the existing exposure engine/data wherever possible rather than introducing a parallel source of truth.

The programmer must be able to determine:

- when the target was last actually exposed;
- how many actual exposures occurred in the relevant rolling/reference window;
- whether another exposure is currently appropriate;
- whether the target is due for its next exposure;
- whether the target's cadence has crossed a calendar-week boundary.

## Important

Do not create weekly "missed-set debt."

If a target was intended for two exposures but only one compatible training session occurred:

- do **not** add the missing exposure as debt;
- do **not** double the next exposure;
- do **not** force two exposures into the next calendar week;
- simply continue from the actual exposure state.

---

# 5. Exposure state must cross calendar weeks

The programmer must not reset a target's exposure state merely because:

```text
calendar week changed
```

Example:

- Target exposure occurs Thursday of Week A.
- The next compatible target-training session is Thursday of Week B.

That is one actual exposure in Week A and one next exposure in Week B.

The calendar boundary must not cause the target to be treated as though it had no previous exposure.

Likewise, if a target has already received its appropriate exposures immediately before a calendar boundary, the new week must not automatically make it due again.

---

# 6. Frequency decision contract

For every target considered for programming, calculate or derive an exposure decision containing enough structured information to explain the result.

Conceptually:

```ts
type ExposureCycleDecision = {
  targetId: string;

  frequencyReference: number;

  lastActualExposureDate: string | null;

  actualExposureCountInReferenceWindow: number;

  expectedExposureIntervalDays: number | null;

  isDue: boolean;

  reason:
    | "due"
    | "not_due"
    | "recovery"
    | "not_compatible_today"
    | "adequate_exposure"
    | "data_integrity";
};
```

The exact type may differ if the current code already has a better equivalent, but the semantics must exist.

### Required behavior

A target is not automatically due merely because:

```text
days since last exposure >= minimum interval
```

It must also satisfy the applicable exposure-frequency/cadence constraint.

For example, with frequency `2/week`:

```text
Monday exposure
Thursday exposure
Sunday
```

Sunday must **not** automatically become a third exposure simply because three days have elapsed.

---

# 7. Rolling-window / cadence implementation

Prefer deriving cadence from actual exposure history rather than creating unnecessary persistent state.

A valid implementation may use:

- a rolling 7-day actual exposure count;
- actual exposure timestamps/dates;
- last actual exposure date;
- an exposure-cycle state derived from actual history.

If persistent cadence state is introduced, it must obey this rule:

> Persistent exposure state may only be advanced by actual logged/completed training, never by program generation.

Do not create a second independent history system if the existing exposure engine/data can support the calculation.

---

# 8. Planned exposure vs actual exposure

This distinction is mandatory.

The current `simulatedLastExposureDate` concept is useful and should be retained if it helps prevent duplicate exposures while projecting a future program.

However:

> `simulatedLastExposureDate` is planning state, not historical state.

A generated future session must **never**:

- write an actual exposure;
- increment an actual exposure count;
- advance a persistent cadence index;
- modify historical training data;
- reduce future frequency eligibility as though the user completed the session.

Simulation exists only inside the current planning computation.

### Example

If Monday's future program contains a planned target exposure but the user never completes it, then Tuesday's planning must not treat Monday as an actual exposure.

Only the user's completed/logged training can advance actual exposure state.

---

# 9. Calendar-week generation is projection, not quota fulfillment

`ensureWeekProgramGenerated()` should be understood as:

> project the next appropriate exposures into the requested calendar week.

It must **not** be interpreted as:

> fulfill this week's target-set quota.

The programmer may generate fewer exposures than the package's nominal weekly reference when the actual training schedule provides fewer appropriate opportunities.

That is valid behavior.

---

# 10. Remove weekly set debt as authoritative programming state

The following concepts must no longer be the authoritative mechanism for deciding whether a target receives another exposure:

```ts
desiredWeekly
remainingWeeklySets
weekly_direct_set_reference
weekly exposure deficit
```

They may remain where they are useful for:

- reporting;
- reference display;
- development-level calculations;
- diagnostics;
- non-authoritative planning heuristics.

But they must not cause:

> "The target did not receive enough sets this calendar week, therefore prescribe additional work."

There is no automatic catch-up debt.

---

# 11. Development references remain references

Keep the established distinction:

### Goal-linked target

Use the Blueprint's **Complete development-volume reference**.

### Non-goal target

Use the Blueprint's **Efficient development-volume reference**.

Do not introduce a generic 75–80% fallback.

However:

> Efficient/Complete are development references, not exact workout templates.

They do **not** dictate:

- today's exercise list;
- exact exercise count;
- exact weekly session construction;
- exact rotation;
- exact exercise order;
- exact number of exercises selected from the package.

The programmer remains responsible for constructing the appropriate exposure.

---

# 12. Package aggregate vs target objective

Keep package-level reference calculations where they are semantically valid.

For example, a package may have:

```text
exercise authored sets
× package frequency
= package weekly reference
```

That is a **package-level reference**.

Do not automatically assign the complete package aggregate to every target contained in the package.

If a package covers multiple targets, determine each target's objective using the Blueprint's actual target/exercise relationships.

### Mandatory separation

Keep these concepts distinct:

1. package development reference;
2. target development objective;
3. per-exposure target objective;
4. exercise-level authored sets;
5. actual logged exposure.

Never collapse them into one number.

---

# 13. Per-exposure objective

Where frequency information is available, derive an exposure-level reference where appropriate.

For example, if a target/package genuinely represents:

```text
X direct sets per week
N exposures per week
```

then an exposure-level reference may be derived from:

```text
X / N
```

But do **not** assume that a package's entire aggregate belongs to one target if the package contains multiple targets.

The exposure-level reference is a programming guide, not an obligation.

If authored exercise availability, rotation, recovery, or other legitimate programming reasons mean the exposure contains fewer sets than the reference:

- do not inflate authored sets;
- do not invent extra exercises;
- do not create future debt.

---

# 14. Authored exercise sets remain hard caps

If the Blueprint says:

```text
Exercise A = 2 sets/session
```

the programmer must not produce:

```text
Exercise A = 8 sets
```

just because the target's reference is 8 sets.

The correct response is to use:

- other valid Blueprint variations;
- another appropriate exposure;
- rotation;
- another legitimate programming combination.

Never mutate the authored prescription to satisfy a numeric target.

Add/retain a generic regression test proving that no selected exercise exceeds its authored per-session set count.

---

# 15. Blueprint exercise validity

Every authoritative Blueprint exercise variation is a valid exercise candidate.

The programmer must **never** classify a Blueprint exercise as:

> "No valid prescription"

merely because:

- it was not in today's selected package;
- it was not selected by ranking;
- it was not due for today's exposure;
- another exercise was preferred;
- its exposure is deferred;
- recovery makes it inappropriate today;
- it was redundant today.

Those are programming decisions, not validity failures.

### True data-integrity failure

A genuine missing/malformed prescription source may be reported as a data-integrity issue.

That must be distinguishable from normal programming exclusion.

---

# 16. Candidate selection vs prescription validity

Maintain the distinction:

```text
valid candidate
    ≠
selected today
```

The candidate pool should represent the authoritative Blueprint exercise library for the target.

Selection should then consider legitimate programming factors such as:

- current exposure need;
- previous exposure;
- rotation;
- redundancy;
- coverage;
- goal allocation;
- recovery;
- exercise variety;
- recent usage.

Do not make package membership a hidden hard eligibility gate if the exercise is otherwise an authoritative Blueprint exercise for the target.

---

# 17. No time/equipment influence on normal generation

Normal program generation must be invariant to:

- user's available training time;
- equipment availability.

If the same training state and date are supplied, changing only:

```text
time availability
equipment availability
```

must not cause a different normal generated program.

These constraints may remain available for:

- explicit exercise substitution;
- user-facing feasibility information;
- optional diagnostics.

They must not silently remove valid Blueprint exercises from normal programming.

Add regression tests proving program invariance.

---

# 18. Recovery remains a legitimate programming reason

Recovery constraints may prevent an otherwise valid target from being prescribed today.

That must be represented as:

```text
recovery
```

or another structured programming reason.

It must not become:

```text
no valid prescription
```

The explanation should identify the relevant structured reason and, where known, the previous actual exposure.

---

# 19. Skip scopes must match the decision

Do not attach the same week-level skip card to every session merely because a target was not selected once.

Use scope appropriate to the actual decision.

Suggested semantics:

| Reason | Appropriate scope |
|---|---|
| `not_due` | exposure/target decision |
| `adequate_exposure` | exposure/target decision |
| `recovery` | session/exposure decision |
| `not_compatible_today` | session decision |
| `data_integrity` | diagnostic/data scope |

A target that is not due on Monday is not necessarily "skipped for the whole week."

The UI/data model should not imply that.

---

# 20. Friendly explanations must reflect corrected engine facts

Explanations must distinguish:

### "Not today / not this exposure"

from:

### "Cannot be programmed"

Examples of grounded explanation facts:

- last actual exposure date;
- actual exposure count in the relevant window;
- target is not due yet;
- recovery interval not satisfied;
- another exercise already provides required coverage;
- a better variation was selected;
- target is planned for a later exposure.

Do not fabricate future dates unless they are actually present in the planner's projection.

If a future exposure is only simulated, describe it as planned/projected rather than completed.

---

# 21. Ranking must not use weekly deficit as the hidden driver

Existing ranking such as:

```ts
rankTarget(...)
```

must be reviewed.

If it currently uses:

```ts
weekly_exposure_units
weekly_direct_set_reference
```

to decide whether a target needs to be prioritized, replace the weekly-deficit semantics with the corrected exposure/cadence state.

A target should be prioritized because its **next exposure is appropriate**, not because a calendar-week counter says it is behind.

Weekly reference values may still contribute to an objective/priority calculation where semantically appropriate, but they must not create debt.

---

# 22. Actual training drives future programming

After a user completes/logs an exposure:

1. actual exercise/set data becomes authoritative;
2. exposure is calculated from completed sets;
3. future target state is recalculated;
4. the next appropriate exposure may change;
5. the canonical reconciliation path updates the future program.

Do not maintain a second manual "programmer exposure" history.

The existing:

```text
exposureEngine
+
weekProgramReconciliation
+
actual completed session data
```

should remain the foundation.

---

# 23. Reconciliation safety

Preserve the existing protection:

- completed sessions are immutable;
- locked sessions are immutable;
- in-progress sessions are not overwritten incorrectly;
- future sessions may be regenerated/reconciled;
- the planner remains the single source of truth for new programming.

`reconcileAfterActualTraining()` should use the corrected planner semantics.

Do not implement a second reconciliation algorithm specifically for frequency.

---

# 24. Required regression tests

Add or update tests for all of the following.

## A. Frequency 2/week — Monday / Thursday / Sunday

Given a target with frequency:

```text
2/week
```

and actual/eligible exposures:

```text
Monday
Thursday
```

then Sunday must **not** automatically produce a third exposure solely because the minimum interval has elapsed.

---

## B. One compatible session per week across multiple weeks

If a target has frequency:

```text
2/week
```

but the user's actual schedule provides only one compatible target-training session per calendar week:

```text
Week 1: Thursday
Week 2: Thursday
Week 3: Thursday
```

the programmer must not:

- cram two exposures into a Thursday;
- create missed-set debt;
- inflate Thursday's sets;
- mark the target invalid.

It should simply produce one appropriate exposure per actual compatible session.

---

## C. Calendar boundary continuity

An exposure near the end of one calendar week must remain part of the target's actual history in the following week.

Changing:

```text
Sunday → Monday
```

must not reset the exposure state.

---

## D. No catch-up debt

If a target expected two exposures but only one was completed:

```text
completed = 1
expected = 2
```

the next exposure must not automatically become:

```text
double volume
```

or:

```text
two exposures in one session
```

---

## E. Planned exposure is not actual exposure

Generate a future planned exposure.

Do not complete it.

Run the programmer again.

The future planned exposure must not appear in actual exposure history.

---

## F. Actual completion changes future programming

Complete/log an exposure.

Run the programmer again.

The actual exposure must affect the next due/cadence decision.

---

## G. Minimum spacing is not the only frequency gate

Explicitly test a case where:

```text
frequency = 2/week
last exposures = Monday + Thursday
current day = Sunday
```

and verify that the third exposure is not automatically prescribed.

---

## H. Authored-set cap

For every selected Blueprint exercise:

```text
generated sets <= authored sets/session
```

must hold.

Use at least one test where the target reference is larger than a single exercise's authored set count.

---

## I. Blueprint exercise validity

Given an authoritative Blueprint exercise that is not selected today:

- it remains a valid candidate;
- it is not placed in an "invalid/no prescription" category;
- its exclusion has a legitimate programming reason if surfaced.

---

## J. Time invariance

Generate the same program twice while changing only the user's time availability.

The normal generated program must remain unchanged.

---

## K. Equipment invariance

Generate the same program twice while changing only equipment availability.

The normal generated program must remain unchanged.

---

## L. Package aggregation

For a package containing multiple targets, verify that:

```text
package aggregate reference
```

is not automatically duplicated as the complete direct objective for every target.

---

## M. Skip scope

Verify that an exposure-scoped `not_due` decision is not rendered as a repeated week-level skip on every session.

---

## N. Completed/locked protection

Run reconciliation after actual training and verify that:

- completed sessions remain unchanged;
- locked sessions remain unchanged;
- only eligible future programming is updated.

---

# 25. Implementation guidance

Before editing, inspect the current code and identify the exact places where:

- `remainingWeeklySets` is initialized/reset;
- `desiredWeekly` is calculated;
- `weekly_direct_set_reference` affects ranking;
- `isDueToday` is calculated;
- `simulatedLastExposureDate` is updated;
- actual exposure history is read;
- future simulated exposure is distinguished from actual exposure;
- skip scope is assigned;
- exercise prescription validity is determined.

Do not blindly delete existing structures.

Refactor them so that:

```text
weekly reference
```

and

```text
actual exposure state
```

have separate responsibilities.

Prefer deriving state from existing persisted actual training data rather than introducing redundant state.

---

# 26. Important implementation invariant

At no point should the programmer reason:

> "This target needs 8 weekly sets, therefore I must prescribe 8 sets today."

Nor:

> "This target did not receive its weekly sets, therefore I owe it sets."

Nor:

> "Three days have passed, therefore frequency says it is due."

Instead reason:

> "This target's development reference defines the desired development level. Its actual exposure history determines where it is in its cadence. Today is an appropriate opportunity for its next exposure if frequency, recovery, and programming conditions allow it. The selected exercises and their authored sets determine today's actual prescription."

---

# 27. Acceptance criteria

The implementation is complete only when all of the following are true:

- [ ] Frequency is not implemented solely through minimum spacing.
- [ ] Rolling/cadence exposure state uses actual completed training.
- [ ] Calendar-week boundaries do not reset exposure state.
- [ ] Weekly set deficit cannot create catch-up debt.
- [ ] `remainingWeeklySets` is no longer authoritative for exposure decisions.
- [ ] `desiredWeekly` is not used as hidden weekly quota enforcement.
- [ ] `weekly_direct_set_reference` remains a reference/reporting value only where appropriate.
- [ ] Planned/simulated exposures never become actual historical exposures.
- [ ] Actual completed exposures affect future programming.
- [ ] Package aggregate and target objective remain separate.
- [ ] Per-exposure objectives do not duplicate package totals across multiple targets.
- [ ] Authored exercise set counts are never exceeded.
- [ ] Blueprint exercises are never called invalid merely because they were not selected today.
- [ ] Time availability does not alter normal program generation.
- [ ] Equipment availability does not alter normal program generation.
- [ ] Skip scope reflects the real decision scope.
- [ ] Explanations distinguish "not today" from "cannot be programmed."
- [ ] Completed/locked sessions remain protected.
- [ ] Canonical reconciliation remains the only regeneration path.
- [ ] All required regression tests pass.
- [ ] Existing test suite remains green.
- [ ] Typecheck/build/verification remain green.

---

# 28. Deployment safety

After implementation:

1. Run the full test suite.
2. Run typecheck.
3. Run production build.
4. Run the project's verification command(s).
5. Inspect the diff for unintended DB/schema/data changes.
6. Commit and push to GitHub `main`.
7. Deploy from the production VM by pulling GitHub `main`.
8. Do **not** deploy from the local Windows repository.
9. Do **not** reset or replace the production SQLite database.
10. Do **not** run `sync-blueprint` as part of normal deployment.
11. Restart/reload only the application services required by the code change.
12. Verify:
    - systemd service;
    - nginx;
    - HTTP health;
    - SQLite integrity;
    - foreign-key integrity;
    - historical sessions;
    - goals;
    - completed/locked sessions;
    - future programming.

The production database must be preserved.

---

# 29. Final engineering principle

The programmer is a **stateful exposure planner**, not a weekly set quota calculator.

Blueprint development references answer:

> **How much development is appropriate at this development level?**

Actual exposure history answers:

> **Where is the target in its real training cadence?**

Frequency answers:

> **Is another exposure appropriate now?**

Exercise selection answers:

> **Which valid Blueprint variations best construct this exposure?**

Authored exercise sets answer:

> **How much work is actually prescribed for each selected exercise?**

Logged training answers:

> **What actually happened?**

Reconciliation answers:

> **How should future programming respond to what actually happened?**

Keep those layers separate. That separation is the core correctness requirement for this fix.
