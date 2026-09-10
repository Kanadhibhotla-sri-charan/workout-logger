# Workout Programmer — Final Remaining Corrective Fix
## Per-Exposure Prescription vs Mutable Weekly Reference

### Purpose

This is the **remaining-issues-only** corrective specification for the current post-v2 Workout Programmer implementation.

The previous corrective work successfully removed the old weekly-reference **hard stop** and preserved the corrected rolling-frequency architecture.

The remaining defect is narrower:

> A mutable weekly reference is still being consumed during generation and is still influencing the size of later due exposures.

The current implementation contains logic equivalent to:

```ts
let remainingWeeklyReference = fairShareWeekly;
```

followed by logic equivalent to:

```ts
let sessionRemaining =
  remainingWeeklyReference > 0
    ? Math.min(remainingWeeklyReference, sessionCap)
    : (sessionCap ?? fairShareWeekly);
```

and then:

```ts
remainingWeeklyReference -= delivered;
```

This means the weekly reference is no longer preventing a due exposure, but it still acts as a **mutable prescription-sizing bucket**.

That remaining behavior must be corrected.

---

# 1. Do NOT regress the already-correct implementation

The following behavior has already been successfully implemented and must remain intact:

- actual exposure history drives cadence;
- rolling 7-day frequency counting is present;
- minimum spacing is not the sole frequency gate;
- Monday → Thursday → Sunday must not automatically produce a third exposure for frequency 2/week;
- calendar-week boundaries do not reset exposure state;
- planned/simulated exposure is separate from actual completed exposure;
- there is no weekly catch-up debt;
- the old `remainingWeeklySets <= 0` hard stop has been removed;
- package-sharing behavior prevents sibling targets from independently consuming the same package aggregate incorrectly;
- authored Blueprint exercise set counts remain authoritative;
- authoritative Blueprint exercises remain valid candidates;
- normal generation remains invariant to equipment availability;
- normal generation remains invariant to time availability;
- skip reasons/scopes remain structured;
- canonical reconciliation remains the regeneration path;
- completed/locked sessions remain protected.

**Do not replace the current frequency implementation with a simpler one.**

---

# 2. The exact remaining defect

The problem is no longer:

> "The weekly reference prevents a target from receiving another exposure."

That was fixed.

The remaining problem is:

> **The weekly reference is still being consumed across calendar days and therefore changes the prescription amount of later exposures.**

Current conceptual behavior:

```text
weekly reference
      ↓
remainingWeeklyReference
      ↓
Exposure 1 consumes some reference
      ↓
remaining reference becomes smaller
      ↓
Exposure 2 gets a different amount because of that depletion
```

This is still a weekly-budget mechanism.

The target's prescription for an exposure must not depend on how much of a mutable weekly reference happened to be consumed by earlier sessions in the calendar week.

---

# 3. Required architectural separation

The final implementation must separate these concepts:

## A. Development reference

Answers:

> What development level is appropriate for this target?

Examples:

```text
Efficient
Complete
weekly_direct_set_reference
```

This remains Blueprint/reference information.

---

## B. Exposure cadence

Answers:

> Is this target's next exposure appropriate today?

Use the existing actual exposure history + rolling frequency + spacing/recovery logic.

---

## C. Per-exposure prescription

Answers:

> How much work should THIS exposure contain?

This is the remaining piece that must be made independent of a mutable weekly reference bucket.

---

## D. Exercise prescription

Answers:

> Which valid Blueprint exercises construct this exposure, and how many authored sets does each contribute?

Authored exercise sets remain authoritative.

---

# 4. Remove mutable weekly-reference sizing

Inspect all code paths involving:

```ts
remainingWeeklyReference
fairShareWeekly
sessionRemaining
remainingWeeklyReference -= delivered
```

Do not automatically delete package-sharing logic just because these variables are nearby.

The required change is:

> **A mutable calendar-week reference must not determine or cap the size of a later due exposure.**

A target being due must produce an exposure-sized prescription derived from the target's actual programming state and legitimate per-exposure reference information.

It must not produce:

```text
"whatever remains of this week's bucket."
```

---

# 5. Do NOT simply replace everything with `sessionCap`

Do not implement the simplistic fix:

```ts
sessionRemaining = sessionCap;
```

for every due exposure.

That can regress established behavior for:

- low-volume maintenance targets;
- targets whose actual established volume is below the development reference;
- package sharing;
- target-specific development state;
- existing programming behavior already covered by passing tests.

The correct solution must preserve those behaviors.

---

# 6. Determine the appropriate per-exposure prescription

Before changing the implementation, inspect the existing data/model to determine what information is already available for calculating an exposure-level amount.

Relevant inputs may include:

- target development level;
- Efficient/Complete reference;
- package frequency;
- package structure;
- target-to-package/exercise relationship;
- target's actual recent direct exposure;
- actual established training volume;
- current adaptation/progression state if already represented;
- package-sharing requirements;
- exercise authored set limits;
- legitimate programming constraints.

Use existing authoritative semantics where available.

**Do not invent an arbitrary universal percentage or fixed set count merely to remove the weekly counter.**

---

# 7. Per-exposure reference must not be a weekly bucket

If a Blueprint reference can legitimately be converted to an exposure-level reference, derive it once as a reference.

Conceptually:

```text
weekly development reference
        ÷
reference frequency
        =
per-exposure development reference
```

But only perform this derivation at the correct semantic level.

If a package contains multiple targets, do **not** automatically assign the entire package aggregate to every target.

The resulting value should be a reference for an individual exposure, not:

```text
remaining amount in this calendar week
```

---

# 8. Package-sharing must be preserved

The current implementation contains package-level sharing behavior intended to prevent multiple sibling targets from each independently consuming the same package aggregate.

Preserve that behavior.

However, distinguish:

```text
package allocation/reference
```

from:

```text
target exposure prescription
```

and from:

```text
calendar-week depletion
```

A package may legitimately influence how multiple targets share development work.

That does **not** mean the programmer should maintain a mutable weekly target bucket and use it to size subsequent exposures.

---

# 9. Actual training volume must remain meaningful

Do not discard the existing behavior that accounts for actual training/adaptation.

If a target is currently established at a lower training volume than the Blueprint development reference, the programmer must not suddenly force the full development reference into every exposure simply because the weekly bucket was removed.

Likewise, if the target legitimately needs more development work, the programmer must be able to prescribe appropriate work without relying on a calendar-week remainder.

The exact existing adaptation/volume model should be inspected and preserved where it is semantically correct.

---

# 10. Frequency remains completely separate

Do not modify the already-correct frequency architecture except where necessary to integrate the new per-exposure prescription.

The sequence must remain:

```text
actual exposure history
        ↓
frequency/cadence decision
        ↓
due / not due
        ↓
if due:
    determine this exposure's prescription
        ↓
    select exercises
```

Not:

```text
weekly reference remaining
        ↓
decide exposure size
        ↓
frequency check
```

And not:

```text
weekly reference remaining
        ↓
decide whether target is needed
```

---

# 11. No weekly catch-up

The final implementation must continue to satisfy:

If a target receives less work than its nominal weekly development reference:

```text
do not create debt
```

Therefore:

```text
Week 1:
one exposure
```

does not imply:

```text
Week 2:
extra exposure
```

or:

```text
Week 2:
extra sets because Week 1 was short
```

The next exposure is prescribed normally according to actual state and cadence.

---

# 12. Calendar-week independence

The prescription for an exposure must not change merely because it is:

```text
the first exposure of a calendar week
```

versus:

```text
the second exposure of a calendar week
```

unless some legitimate existing programming/adaptation rule explicitly makes that distinction.

The calendar week itself must not be the reason the exposure is larger or smaller.

---

# 13. Simulation must remain temporary

The current:

```ts
simulatedLastExposureDate
exposureDatesThisRun
```

behavior should remain.

If a future exposure is simulated during generation, that simulated exposure may influence later decisions **inside that same planning pass** so that the generated week is internally coherent.

But it must never:

- become actual training history;
- decrement any persisted actual volume;
- advance permanent cadence state;
- be written as completed exposure.

---

# 14. Authored-set caps remain hard limits

For every selected exercise:

```text
generated sets <= Blueprint authored sets/session
```

This remains non-negotiable.

If the per-exposure objective is larger than one exercise's authored sets:

- use other valid Blueprint variations where appropriate;
- rotate exercises where appropriate;
- construct the exposure from legitimate combinations.

Never inflate an authored exercise.

---

# 15. Blueprint exercise validity remains separate from selection

Do not introduce:

```text
not selected today = invalid
```

or:

```text
not selected today = no valid prescription
```

An authoritative Blueprint exercise remains valid even when another exercise is selected for the current exposure.

Only a genuine Blueprint/source-data defect may produce a data-integrity failure.

---

# 16. Time/equipment invariance remains unchanged

Do not use the new per-exposure prescription fix as a reason to reintroduce:

- equipment filtering;
- time-budget filtering;

into normal program generation.

Normal generation must remain invariant to those user execution constraints.

Explicit substitution/feasibility operations may continue using them.

---

# 17. Required regression tests for this final fix

Add tests that specifically distinguish **weekly-reference depletion** from **per-exposure prescription**.

## Test A — Two due exposures must not depend on weekly bucket depletion

Create a target for which two exposures are genuinely due within the applicable cadence.

Generate the week.

Verify that the second exposure's prescription is determined by the target's per-exposure programming state/reference and **not by the amount remaining in a mutable weekly bucket**.

The test must fail if changing the first exposure's delivered amount merely changes the second exposure's prescribed amount through:

```text
remainingWeeklyReference
```

---

## Test B — Weekly reference exhaustion must not alter a due exposure

Construct a case where:

```text
remaining weekly reference = 0
```

but another exposure is genuinely due.

Verify that the due exposure receives its normal appropriate per-exposure prescription.

Also verify that the prescription is not larger merely because the weekly bucket reached zero.

---

## Test C — Calendar position must not control exposure sizing

Compare equivalent due exposures occurring:

```text
first calendar-week exposure
```

versus:

```text
second calendar-week exposure
```

with the same actual target state.

The calendar-week position itself must not change the prescription.

---

## Test D — Low-volume established target

Use an established target whose actual programming volume is below its Complete/Efficient reference.

Verify that removing the weekly bucket does not cause every due exposure to jump automatically to the full development reference.

This protects existing maintenance/low-volume behavior.

---

## Test E — Package-sharing regression

Use a package containing multiple targets.

Verify that:

- package-level sharing remains correct;
- the package aggregate is not duplicated across targets;
- one target's exposure does not incorrectly consume another target's independent objective;
- removing the mutable weekly prescription bucket does not cause package totals to multiply.

---

## Test F — No catch-up

Underfill a calendar week.

Then generate the following week.

Verify:

- no extra exposure;
- no doubled sets;
- no additional exercise solely because the previous week was below reference.

---

## Test G — Frequency regression

Retain/verify:

```text
frequency 2/week
Monday + Thursday
Sunday
```

Expected:

```text
Sunday is not automatically prescribed as a third exposure.
```

Do not regress the existing rolling-frequency correction while changing prescription sizing.

---

## Test H — Actual vs simulated

Generate a future exposure without completing it.

Regenerate.

Verify actual exposure history is unchanged.

Then complete the exposure and verify that actual history changes and future programming responds.

---

## Test I — Authored-set cap

For every generated exercise:

```text
generated sets <= authored sets/session
```

---

## Test J — Time invariance

Changing only time availability must not alter normal generation.

---

## Test K — Equipment invariance

Changing only equipment availability must not alter normal generation.

---

# 18. Required code audit

Before declaring completion, search the repository for:

```text
remainingWeeklyReference
fairShareWeekly
sessionRemaining
remainingWeeklySets
desiredWeekly
weekly_exposure_units
needDeficit
weekly_direct_set_reference
```

For each remaining occurrence, determine whether it is:

```text
A. Blueprint/reference data
B. reporting/diagnostic data
C. package-sharing/reference allocation
D. actual exposure state
E. temporary planning state
F. obsolete mutable weekly prescription state
```

Category F must be removed.

Category A/B/C may remain if semantically correct.

Do not remove legitimate package/reference calculations simply because they contain "weekly."

---

# 19. Final planner invariant

After this fix, the following statement must be true:

> **The amount prescribed for a target's current exposure is not determined by how much of a mutable weekly reference has already been consumed in the calendar week.**

Instead:

```text
Development reference
    +
actual target state
    +
frequency/cadence
    +
per-exposure programming rules
    +
package-sharing rules where applicable
    +
valid exercise selection
    +
authored exercise-set limits
    =
current exposure prescription
```

The calendar week may organize and report the program, but it must not act as a consumable prescription budget.

---

# 20. Acceptance criteria

The fix is complete only when:

- [ ] The old weekly hard-stop remains removed.
- [ ] Rolling actual-exposure frequency remains intact.
- [ ] Minimum spacing remains a supporting constraint, not the sole frequency rule.
- [ ] Calendar boundaries do not reset cadence.
- [ ] Simulated exposure remains temporary.
- [ ] Weekly underfill creates no debt.
- [ ] A mutable weekly reference no longer controls exposure eligibility.
- [ ] A mutable weekly reference no longer controls/caps the size of a later due exposure.
- [ ] Due-exposure sizing is derived from legitimate per-exposure programming state.
- [ ] The simplistic "always use sessionCap" fix is not used if it regresses established low-volume behavior.
- [ ] Package-sharing behavior remains correct.
- [ ] Package aggregates are not duplicated across sibling targets.
- [ ] Authored exercise sets are never exceeded.
- [ ] Blueprint exercises remain valid candidates.
- [ ] Normal generation remains time-invariant.
- [ ] Normal generation remains equipment-invariant.
- [ ] Skip scope/reasons remain correct.
- [ ] Canonical reconciliation remains the only regeneration path.
- [ ] Completed/locked sessions remain protected.
- [ ] Existing tests remain green.
- [ ] New regression tests pass.
- [ ] Typecheck passes.
- [ ] Production build passes.
- [ ] Verification passes.

---

# 21. Deployment safety

After implementation:

1. Run the complete test suite.
2. Run typecheck.
3. Run the production build.
4. Run all repository verification checks.
5. Inspect the diff for unintended database/schema/data changes.
6. Commit and push to GitHub `main`.
7. Deploy from the production VM by pulling GitHub `main`.
8. Do not deploy from the local Windows repository.
9. Do not reset, replace, or recreate the production SQLite database.
10. Do not run `sync-blueprint` as part of normal deployment.
11. Verify application service, nginx, HTTP health, SQLite integrity, and foreign-key integrity.
12. Verify historical sessions, goals, completed/locked sessions, and future programming.

---

# 22. Final engineering principle

The programmer must no longer behave like:

```text
weekly reference
    ↓
consume budget
    ↓
change next exposure based on remaining budget
```

It must behave like:

```text
development reference
    ↓
actual exposure/cadence state
    ↓
is the target due?
    ↓
what is appropriate for THIS exposure?
    ↓
which valid Blueprint exercises construct it?
    ↓
respect authored sets
```

**Do not solve this by deleting useful development/package references. Solve it by removing their mutable weekly-budget role in prescription sizing.**
