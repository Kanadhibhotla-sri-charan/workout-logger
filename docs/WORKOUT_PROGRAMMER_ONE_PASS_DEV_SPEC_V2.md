# Workout Programmer — One-Pass Implementation Specification
## Source: current `workout-logger.zip` repository + established programming decisions

> **Developer instruction:** Treat this document as the implementation contract for the next Workout Programmer change. Do not implement only the visible symptom. Audit the existing architecture first, then make the coherent model change, add regression coverage, run the complete verification suite, and only then deploy.
>
> The objective is to finish this class of programmer issues in **one implementation iteration**. If an existing implementation conflicts with this document, change the implementation rather than weakening the requirement.

---

# 0. Why this specification exists

Previous iterations fixed individual symptoms but left parts of the underlying model unchanged.

The current repository already contains several "fix pass" implementations and comments that claim to implement parts of the desired behavior, but the actual architecture still contains calendar-week allocation and prescription-resolution paths that conflict with the final model.

Therefore:

**Do not treat comments such as `Consolidated Fix`, `Surgical Fix Pass`, or `Final Pass` in the current source as proof that the behavior is already correct. The executable code and tests are authoritative.**

The implementation must be based on the behavioral contract below and the actual current code paths.

---

# 1. Current repository findings that MUST be addressed

The uploaded repository is not a blank starting point. The following current structures are especially important.

## 1.1 `src/engine/workoutBuilder.ts` is still weekly-allocation driven

The current builder contains and uses concepts including:

```text
desiredWeekly
remainingWeeklySets
compatibleDaysThisWeek
sessionsRemainingThisWeek
eligibleDaysThisWeek
eligible_days_this_week
sessions_remaining_this_week
requiredDirectSetsByTarget
weekly_direct_set_reference
```

The builder currently describes its mechanism as distributing a target's weekly requirement across the target's eligible days in the current calendar week.

It then maintains:

```text
remainingWeeklySets
```

while iterating through:

```text
eligibleDaysThisWeek
```

and uses that value to determine what later sessions receive.

### Required action

Do **not** merely change the arithmetic around `remainingWeeklySets`.

The implementation must remove/rework the conceptual dependency that makes a calendar week the authoritative exposure container.

A variable called `remainingWeeklySets` is acceptable only if its meaning has genuinely become a non-calendar-week exposure-cycle state. Do not retain a weekly-debt mechanism under a different name.

---

## 1.2 `src/engine/frequencyEngine.ts` is intrinsically calendar-week oriented

Current public structures include:

```ts
sessions_per_week
assigned_days
```

and the implementation reads:

```ts
BlueprintAdapter.getGlobalPrinciples().frequency.typical_starting_range_per_week
```

then determines:

```text
sessionsPerWeek
assignedDays
```

and spreads those sessions across the available days of the current week.

The current comments explicitly describe this as weekly session allocation.

### Required action

Audit all callers of `allocateFrequency()`.

Do not assume that changing `workoutBuilder.ts` alone solves the exposure-cycle requirement.

If `allocateFrequency()` is fundamentally a calendar-week allocator, redesign its output/role so that:

- Blueprint frequency remains useful as a **typical exposure frequency/reference**;
- actual programming tracks **real target-training exposures**;
- the calendar week does not become a mandatory container for completing the frequency;
- fewer compatible sessions in one calendar week do not cause compression/debt;
- the next appropriate target-training session can continue the exposure cycle in the next calendar week.

You may preserve a weekly display representation for UI/reporting, but that representation must not become the programming state that forces volume into a week.

---

## 1.3 `src/engine/developmentReferenceEngine.ts` currently calculates package totals as weekly direct-set references

Current implementation:

```text
sum(package exercise sets) × package.frequency.sessions_per_week
```

and returns:

```ts
weekly_direct_set_reference
```

The current module documentation explicitly calls this a target's weekly direct-set reference.

### Required action

Audit whether that number is semantically a:

1. package-level development reference;
2. target-level reference;
3. exercise-level prescription;
4. exposure-cycle reference.

Do not assume these are interchangeable.

The implementation must preserve the Blueprint's authored meaning.

### Critical rule

If a package contains multiple targets/exercises, do not automatically assign the package's entire aggregate set total to every individual target.

For example, conceptually:

```text
package:
  exercise A → target X
  exercise B → target Y
  exercise C → target X
```

does **not** automatically mean:

```text
target X = A+B+C total
target Y = A+B+C total
```

unless the Blueprint data model explicitly defines that semantic.

The developer must trace the target mapping and determine the correct target-level reference.

---

## 1.4 `src/engine/volumeEngine.ts` currently consumes `weekly_direct_set_reference`

The current flow includes:

```text
developmentReference.weekly_direct_set_reference
→ referenceRangeFor()
→ decideVolume()
→ recommended_weekly_primary_sets
```

and, when current direct volume is zero, the current implementation can use:

```text
min(global starting_point_sets[0], packageRef)
```

as the starting weekly amount.

### Required action

Do not simply change the numeric result.

Separate:

```text
development reference
target volume objective
exercise prescription
actual exposure
```

The volume engine must not produce a target-volume number that later causes an individual exercise to receive more sets than that exercise's Blueprint prescription.

The engine may use development references as programming guidance, but those references must not become exercise-level prescriptions.

---

## 1.5 `src/blueprint/developmentPackages.ts` currently has package-dependent prescription lookup

Current functions include:

```text
lookupExercisePrescription()
lookupExercisePrescriptionAnyLevel()
```

`lookupExercisePrescription()` only finds an exercise if it appears in the selected package level.

`lookupExercisePrescriptionAnyLevel()` searches Efficient and Complete for that target's muscle-group package.

The current builder still has paths where a failed prescription lookup can result in:

```text
no_resolvable_prescription
```

and a candidate being removed.

### Required action

For Blueprint exercises, package membership must **never** be an eligibility gate.

A Blueprint exercise variation is valid because it exists in the authoritative Blueprint exercise library.

Therefore:

```text
Blueprint exercise exists
→ valid programming candidate
```

must hold independently of:

- Efficient vs Complete package membership;
- current goal level;
- whether it appears in the selected package;
- whether another package level contains its prescription.

The developer must establish a deterministic exercise-level prescription source from the authoritative Blueprint data.

If a Blueprint exercise genuinely lacks the required prescription data in the authoritative source, that is a **Blueprint/data-integrity defect**.

It is not a normal programming skip.

---

## 1.6 `src/engine/exerciseSelector.ts` currently describes feasibility as upstream

The current selector comments state that Gate 1 feasibility is handled upstream and reference:

```text
constraintEngine.fitToTimeBudget
constraintEngine.isBodyFocusAllowedOnDay
exerciseUniverse
```

Equipment filtering has already been removed from normal generation, but time is still present in the architecture as a concept that has historically filtered candidates.

### Required action

Ensure that the selector receives the **programming candidate universe**, not an execution-filtered universe.

The selector may use legitimate programming gates such as:

- target relevance;
- direct vs secondary role;
- today's existing coverage;
- recent historical use;
- progression continuity;
- fatigue considerations where already established and justified.

It must not use:

- equipment availability;
- session duration;
- estimated exercise minutes

to decide whether a valid Blueprint exercise may be generated.

---

## 1.7 `src/engine/constraintEngine.ts` still contains `fitToTimeBudget()`

This utility can remain as a utility if other non-generation code/tests require it.

But it must not be used to remove exercises from normal workout generation.

Search all callers.

The existence of the function is not itself a problem.

Its use as a generation-stage candidate/program filter is the problem.

---

## 1.8 `src/server/routes/programming.ts` still uses equipment filtering for substitutions

The repository contains:

```text
filterEquipmentFeasible(...)
```

in the programming route's substitution path.

This is correct to preserve.

### Required distinction

Normal program generation:

```text
equipment = irrelevant to generated prescription
```

User-driven substitution:

```text
equipment = relevant because user is asking for an executable alternative
```

Do not remove equipment filtering from substitution merely because it is forbidden during generation.

---

## 1.9 `src/server/friendlyExplanation.ts` still has prescription-data reason codes

Current `SkipReasonCode` includes:

```text
no_candidates
no_resolvable_prescription
```

and both currently produce a friendly message saying the Blueprint data needed to safely prescribe the target is missing.

This is appropriate only for a genuine Blueprint/data-integrity defect.

It must never be reached merely because:

- an exercise was absent from Efficient;
- the preferred exercise was not selected;
- a different exercise was ranked higher;
- a target was already covered;
- the target was not part of today's exposure;
- recovery prevented another direct exposure.

---

## 1.10 `weekLevelSkips` are currently surfaced on every session

`WeeklyPlanSession` currently contains:

```ts
skipped: weekLevelSkips
```

and comments explicitly say the week-level skips are intentionally surfaced on every session.

That produces repeated cards for the same global decision and can make the UI look as though the target was independently skipped on every day.

### Required action

Fix the underlying scope.

Do not merely deduplicate identical text.

A decision must have an explicit scope such as:

```text
exposure-cycle
target-programming
session
data-integrity
```

and be surfaced at the appropriate level.

A global/exposure-level decision must not be represented as a separate daily skip event on every session.

---

# 2. Final programming model

The following is the authoritative behavior.

## 2.1 Hierarchy

```text
BLUEPRINT
What is valid?
        ↓
PROGRAMMING ENGINE
What is useful now?
        ↓
GENERATED SESSION
What is prescribed?
        ↓
USER
What can I physically/practically execute?
```

The responsibilities must not cross those boundaries.

---

# 3. Blueprint validity

## 3.1 Every Blueprint variation is valid

Hard invariant:

> **Every exercise variation that exists in the authoritative Blueprint exercise library is already a valid prescribed variation.**

Therefore never:

```text
exercise exists in Blueprint
→ not found in selected package
→ reject exercise
```

Never:

```text
exercise exists in Blueprint
→ preferred package lookup returns null
→ reject exercise
```

Never:

```text
exercise exists in Blueprint
→ not enough metadata for a package lookup
→ call it "No valid prescription"
```

## 3.2 Package references are not exercise eligibility

Development packages define programming objectives/reference information.

They do not define the entire exercise universe.

An exercise may be:

- in Efficient;
- only in Complete;
- in a different valid package level;
- valid in the Blueprint exercise library but not listed in the package currently being used as the development reference.

None of these facts makes the exercise invalid.

## 3.3 No "No valid prescription" for a valid Blueprint exercise

This phrase/category must disappear from normal programming behavior.

If the exercise is valid and simply not selected today, explain **why it was not selected today**.

If the Blueprint itself is malformed, surface a data-integrity issue rather than pretending the exercise is not valid.

---

# 4. Exercise-level prescription is authoritative

When a Blueprint exercise is selected, use its authoritative exercise-level prescription:

```text
sets
reps_min / reps_max
RIR_min / RIR_max
```

Do not invent a new prescription because a target-volume calculation asks for more work.

Do not infer:

```text
remaining target sets = 8
exercise authored sets = 2
→ exercise gets 8
```

Correct:

```text
exercise authored sets = 2
→ this exercise can deliver at most 2 sets in this session
```

---

# 5. Generic authored-set cap

This must be a global invariant.

For every generated Blueprint exercise:

```text
generated_sets <= authoritative_per_session_sets
```

This must apply to:

- goal exercises;
- normal-development exercises;
- maintenance exercises;
- primary exercises;
- secondary exercises;
- first-time exercises;
- continuing exercises;
- last exercise on a session;
- the only remaining candidate;
- the last session in an exposure cycle.

No special case may bypass it.

### Do not implement:

```ts
if (exerciseId === 'hip-abduction') maxSets = 2;
```

Implement the generic rule.

---

# 6. Target/package volume must never inflate an exercise

Target-level volume is an objective/reference.

Exercise-level prescription is a limit on that specific exercise's session prescription.

If the target has remaining work:

```text
remaining target objective = 8
```

and the available valid exercise has:

```text
authored session prescription = 2
```

then:

```text
deliver <= 2
```

Do not force the remaining 6 into that exercise.

The remaining objective may be addressed through:

- another valid variation;
- another appropriate exposure;
- future programming;
- a later cycle.

Never violate the exercise prescription to make a volume number look complete.

---

# 7. Exposure-cycle model

This is the most important architectural correction.

## 7.1 Calendar weeks are reporting boundaries

A calendar week can be used for:

- displaying a weekly program;
- reporting;
- summarization;
- persistence organization.

It must not be the authoritative unit for target exposure completion.

## 7.2 Frequency means actual exposures

If Blueprint guidance says:

```text
frequency = 2 exposures
```

that means the programming system should seek two appropriate **real target-training exposures**.

It does NOT mean:

```text
Monday-Sunday must contain exactly two exposures
```

when the user's actual schedule cannot provide them.

## 7.3 Example

Suppose:

```text
Blueprint frequency = 2
Week 1:
  only one compatible leg-training session

Week 2:
  one compatible leg-training session
```

Correct:

```text
Week 1 Leg Session → exposure 1
Week 2 Leg Session → exposure 2
```

Incorrect:

```text
Week 1 Leg Session
→ exposure 1 + exposure 2 crammed together
```

## 7.4 No missed-set debt

Do not implement:

```text
missed 8 sets
→ add 8 next week
```

or:

```text
missed exposure
→ double next session
```

or any equivalent hidden debt.

Actual completed training is the state.

If an exposure did not happen, it did not happen.

The next appropriate exposure is scheduled when the target is actually trained again.

## 7.5 No week-boundary reset

Do not reset exposure state simply because:

```text
Monday arrived
```

Historical actual exposure remains relevant across calendar weeks according to the established rolling/recovery logic.

---

# 8. What should remain week-based

Not everything needs to disappear.

It is acceptable to have a weekly object such as:

```text
WeeklyProgrammingPlan
```

because the UI and persistence layer need a week-shaped view.

But:

> **The weekly object must be a view/container of the programming result, not the state machine that forces target volume/exposure into the calendar week.**

This distinction is mandatory.

---

# 9. Frequency engine redesign requirements

Audit:

```text
src/engine/frequencyEngine.ts
```

and every caller.

The implementation must answer:

1. What is the target's intended exposure frequency?
2. Which actual future training sessions are appropriate?
3. Has the target already received the current exposure?
4. Is the target recovered enough?
5. If the calendar week ends before the next exposure occurs, how is the state carried forward?
6. How does actual completed training advance the cycle?

Do not encode the answer only as:

```text
sessions_per_week
assigned_days
```

if doing so makes the calendar week authoritative.

A weekly UI projection may still expose those fields, but the underlying programming state must represent actual exposure progression.

---

# 10. Actual training is authoritative

Future programming must be based on actual logged training.

If the user performed:

```text
Back Squat — 3 sets
```

that actual work counts.

If the old program said:

```text
Back Squat — 3 sets
```

but the user never performed it, it does not count as actual exposure.

Use actual:

- logged exercises;
- logged sets;
- actual dates;
- actual target mappings;
- actual goal-linked work;
- actual secondary exposure.

Do not manufacture completed exposure from intended programming.

---

# 11. Recovery remains a programming consideration

Recovery is legitimate programming logic.

It may prevent today's direct work when evidence supports it.

For example:

> “This muscle was trained directly on September 7, so there isn't enough recovery for another direct session today.”

Only state the date when the engine actually knows it.

Recovery must not be conflated with:

```text
unprescribable
```

or:

```text
invalid
```

A recovered-later valid exercise remains valid.

---

# 12. Goals and specialization

Preserve the established goal model.

## Active goals

- receive priority/development emphasis;
- use Complete-level development references where appropriate;
- do not force rigid exercise quotas;
- do not override exercise-level authored set caps;
- do not create weekly debt;
- actual completed work advances the goal's exposure state.

## Non-goal targets

- use Efficient-level development references where appropriate;
- maintain overall physique;
- remain subject to recovery, coverage, redundancy, and exposure-cycle logic.

## Goal phase

Goal phases are roadmaps/development phases.

They are not:

```text
every week must contain the entire package
```

and not:

```text
every package exercise must appear this week
```

---

# 13. Direct and indirect exposure

Preserve the established direct/indirect methodology.

A compound exercise may provide meaningful secondary exposure to another target.

That can legitimately reduce the need for another direct exercise.

However:

- secondary exposure must use the existing authoritative mapping;
- it must be based on actual/planned exercises;
- it must not invalidate a Blueprint exercise;
- it must not create an invented prescription;
- the UI should identify actual covering exercises when possible.

---

# 14. Exercise selection rules

Valid candidates should be filtered/ranked only by legitimate programming criteria.

Examples:

- target relevance;
- goal priority;
- current programming need;
- existing coverage;
- redundancy;
- recent exercise history;
- progression continuity;
- recovery;
- exposure-cycle position;
- fatigue considerations already established by the current architecture.

Do not introduce an arbitrary numerical score to replace one removed elsewhere.

Do not let:

- alphabetical order;
- equipment availability;
- time availability

become hidden programming priorities.

Stable ID ordering is acceptable only as a final deterministic tie-break after real programming criteria are equal.

---

# 15. No equipment filtering during generation

Hard invariant:

```text
equipment availability has ZERO effect on normal generation.
```

This means no effect on:

- candidate eligibility;
- candidate ranking;
- target allocation;
- exercise selection;
- number of exercises;
- exercise sets;
- post-selection filtering;
- skip reasons.

The user will manually substitute/skip if necessary.

## Preserve substitution filtering

`src/server/routes/programming.ts` may continue using:

```text
filterEquipmentFeasible(...)
```

for the explicit substitution workflow.

That is a different responsibility.

---

# 16. No time filtering during generation

Hard invariant:

```text
time availability has ZERO effect on normal generation.
```

This means no effect on:

- candidate eligibility;
- candidate ranking;
- target allocation;
- exercise selection;
- number of exercises;
- exercise sets;
- post-selection filtering;
- skip reasons.

`fitToTimeBudget()` may remain as a utility if required elsewhere, but it must not be called as part of normal workout generation to decide what the user is prescribed.

Estimated session duration may remain informational.

It must never determine the generated program.

---

# 17. No execution-constraint workaround

Do not satisfy the time/equipment rules cosmetically.

These are all insufficient fixes:

```text
remove the time-fitting text
but still drop the exercise
```

```text
keep equipment filtering
but hide the reason from the UI
```

```text
select the exercise
then remove it later during post-processing
```

```text
leave the candidate out before selection
because equipment/time is checked somewhere else
```

The final generated exercise list must be invariant to time/equipment inputs.

---

# 18. Skip/exclusion model

Every exclusion must have a real reason.

Recommended conceptual categories:

### `recovery`
Valid target/exercise; today's direct work is prevented by recovery state.

### `not_current_exposure`
Valid target/exercise; this target is not due for this exposure.

### `adequately_covered`
Valid target; today's actual/planned work already provides sufficient relevant coverage.

### `better_variation_selected`
Valid exercise; another valid variation is more useful today.

### `redundant_today`
Valid exercise; another exercise already covers the needed movement/target contribution.

### `goal_priority_allocation`
Valid target/exercise; current session resources/programming priority went elsewhere.

Only use categories that correspond to real engine facts.

### Data-integrity categories

A separate category may exist for:

```text
blueprint_data_integrity
```

but it must mean an actual malformed/missing authoritative Blueprint record.

It must not mean:

```text
exercise not in current package
```

or:

```text
preferred candidate lost a ranking gate
```

---

# 19. Skip scope

The system must distinguish:

```text
session-level
exposure-cycle-level
week/reporting-level
data-integrity
```

Do not inject a global skip into every day's `skipped` array simply because the weekly UI needs somewhere to display it.

If a decision applies to an exposure cycle, attach it to that exposure-cycle decision.

If it applies to today's session, attach it to today's session.

If it is a data-integrity problem, make that explicit.

---

# 20. No contradictory program state

A target/exercise cannot be:

```text
generated successfully today
```

and simultaneously:

```text
unprescribable today
```

because two different internal paths produced conflicting records.

Before returning a session, reconcile/validate:

```text
programmed exercises
vs
excluded/skipped exercises/targets
```

and ensure there is no semantic contradiction.

---

# 21. Friendly explanations

The explanation layer must consume structured engine facts.

Do not infer reasons from arbitrary prose.

Where needed, structured decision data should include facts such as:

```text
reason_code
scope
target_type
target_id
exercise_id
last_direct_exposure_date
days_since_last_exposure
current_session_coverage
covering_exercises
selected_alternative
previous_exercise
exposure_cycle_position
next_expected_exposure
goal_context
```

Only populate fields when the engine actually knows them.

Never fabricate facts.

---

# 22. Required user-facing explanation behavior

## Recovery

Good:

> “This muscle was trained directly on September 7, so there isn't enough recovery for another direct session today.”

Bad:

> “Not recovered.”

## Existing coverage

Good:

> “This target is already covered today by Back Squats and Leg Extensions, so another direct quad exercise isn't needed in this session.”

Bad:

> “Adequately exposed.”

## Better variation

Good:

> “A different valid variation was selected because it provides the better fit for today's programming objective. This variation remains available for another session.”

## Future exposure

Good:

> “This variation is valid, but it isn't needed in this exposure. A different variation was selected for today's target coverage; this one remains available for a later exposure.”

## Not today's exposure

Good:

> “This target is not part of today's exposure cycle. It will be considered at the next appropriate target-training session.”

Only make a future promise when the engine can establish it.

## Data integrity

If the Blueprint itself is genuinely malformed:

> “The Blueprint data for this target is incomplete, so the programmer cannot safely use it until that data is fixed.”

Do not say:

> “No valid prescription.”

---

# 23. Do not confuse "not selected" with "invalid"

These are different states.

```text
VALID + NOT SELECTED TODAY
```

means the exercise remains available for future programming.

```text
INVALID/MISSING BLUEPRINT DATA
```

means there is a source-data defect.

The UI and engine must preserve this distinction.

---

# 24. Package-level vs target-level vs exercise-level model

The implementation must explicitly preserve this separation.

## Package

Answers:

> What does this development level broadly cover?

May include:
- exercise set references;
- frequency;
- coverage;
- development level.

## Target

Answers:

> How much/what kind of development attention does this target currently warrant?

Depends on:
- goal state;
- development level;
- actual exposure;
- recovery;
- progress;
- current phase.

## Exercise

Answers:

> What is the prescription for this particular valid variation if selected?

Uses:
- authored sets;
- reps;
- RIR;
- role.

## Actual exposure

Answers:

> What did the user actually train?

Uses:
- logged sets;
- logged exercise;
- actual date;
- target mapping.

Never collapse these four layers.

---

# 25. Concrete volume example that MUST work

Suppose Blueprint says:

```text
Hip Abduction:
  2 sets/session
  10–20 reps
```

and the target engine calculates:

```text
target objective = 8 sets
```

The result must NOT be:

```text
Hip Abduction × 8
```

It must be something like:

```text
Hip Abduction × 2
```

plus other valid variations/exposures as justified.

If no legitimate combination can deliver all 8 without violating authored exercise caps or the exposure-cycle model:

```text
do not cram
do not inflate
do not create debt
```

Leave the objective to future appropriate programming.

---

# 26. Concrete frequency example that MUST work

Suppose:

```text
target frequency = 2
```

and:

```text
Week 1:
  one compatible target-training session

Week 2:
  one compatible target-training session
```

The engine must not generate two exposures in Week 1.

It must carry the exposure state forward:

```text
Week 1 session → exposure 1
Week 2 session → exposure 2
```

If Week 1's session is not completed, actual state remains:

```text
exposure 0 completed
```

and Week 2 should not receive an artificial "debt" multiplier merely because the calendar changed.

---

# 27. Concrete time/equipment invariance tests

Given identical programming state:

```text
budget_minutes = 1
available_equipment = []
```

versus:

```text
budget_minutes = 300
available_equipment = [all equipment]
```

the generated programming prescription must be the same with respect to:

- selected exercises;
- target allocation;
- sets;
- reps;
- RIR;
- inclusion/exclusion decisions.

Only informational constraint fields may differ.

---

# 28. Required code audit before implementation

Search the entire repository for:

```text
desiredWeekly
remainingWeeklySets
sessionsRemainingThisWeek
eligibleDaysThisWeek
compatibleDaysThisWeek
weekly_direct_set_reference
sessions_per_week
assigned_days
fitToTimeBudget
time-fitting
filterEquipmentFeasible
isExerciseEquipmentFeasible
equipment
budget_minutes
availableMinutes
no_resolvable_prescription
no_candidates
lookupExercisePrescription
lookupExercisePrescriptionAnyLevel
weekLevelSkips
sessionSkipped
skipped
recommended_weekly_primary_sets
starting_point_sets
developmentReference
development package
reconcile
ensureWeekProgramGenerated
reconcileAfterActualTraining
```

Also search semantically for equivalent concepts that use different names.

Do not assume the listed identifiers are exhaustive.

---

# 29. Required audit flow

Trace this complete path:

```text
Blueprint snapshot
    ↓
BlueprintAdapter
    ↓
exercise universe
    ↓
development package/reference
    ↓
target-level volume/objective
    ↓
goal allocation
    ↓
actual exposure history
    ↓
recovery
    ↓
exposure-cycle state
    ↓
candidate universe
    ↓
exercise selection
    ↓
exercise-level prescription
    ↓
session construction
    ↓
time/equipment processing
    ↓
skip/exclusion state
    ↓
friendly explanation
    ↓
API
    ↓
UI
    ↓
persistence/reconciliation
```

At every arrow, verify that information is not being used outside its intended responsibility.

---

# 30. Anti-workaround rules

These are mandatory.

## Do not:

### A. Rename a bad reason

Changing:

```text
no_resolvable_prescription
```

to:

```text
not_today
```

without changing why the candidate was removed is not a fix.

### B. Hide the skip

Removing a card from the UI while the backend still treats the exercise as invalid is not a fix.

### C. Change only Hip Abduction

Adding:

```text
hip-abduction → max 2
```

is not a fix.

The generic authored-cap invariant must be implemented.

### D. Change only `developmentReferenceEngine.ts` numbers

A different numeric reference does not fix package-vs-target semantic conflation.

### E. Change only weekly arithmetic

Changing:

```text
desiredWeekly / sessionsRemainingThisWeek
```

to another formula is not sufficient if the calendar week remains the authoritative exposure state.

### F. Keep time filtering under another name

Do not replace:

```text
fitToTimeBudget
```

with:

```text
sessionCapacityFilter
```

or any equivalent mechanism.

### G. Keep equipment filtering under another name

Do not use equipment in candidate ranking/eligibility and simply remove the word "equipment" from the explanation.

### H. Deduplicate bad skips instead of fixing scope

Do not merely make repeated skip cards appear once if the underlying state still says the target was independently skipped on every day.

### I. Weaken tests to fit the implementation

If a meaningful regression test fails, investigate the implementation.

Do not remove the test simply because the current architecture cannot satisfy it.

---

# 31. Regression tests — mandatory

Add or update tests in the existing test architecture.

## 31.1 Generic authored set cap

For every generated Blueprint exercise:

```text
generated sets <= authoritative authored session sets
```

Test multiple targets/exercises.

## 31.2 Hip Abduction regression

Specifically verify:

```text
Hip Abduction authored = 2
target objective >= 8
generated Hip Abduction <= 2/session
```

## 31.3 Package membership does not invalidate Blueprint variation

Use a variation that is present in Complete but absent from Efficient.

Assert:
- it remains a valid candidate;
- it can be selected when programming criteria favor it;
- if not selected, it receives a programming reason;
- it never becomes `no_resolvable_prescription`.

## 31.4 No valid Blueprint exercise reaches `no_resolvable_prescription`

Create a test over the authoritative Blueprint exercise universe.

For every valid Blueprint exercise candidate reaching normal generation:

```text
must not be rejected because package-level prescription lookup returned null
```

If the repository needs a special malformed fixture, test that separately as data integrity.

## 31.5 Genuine malformed Blueprint data

Create a deliberately malformed fixture.

Assert:
- data-integrity state is produced;
- it is not represented as a normal programming decision;
- it does not contaminate valid Blueprint exercises.

## 31.6 Time invariance

Run the same programming state with:
- tiny budget;
- large budget.

Assert the prescription is identical.

Also assert:
- no time-fitting skip exists;
- no candidate disappears.

## 31.7 Equipment invariance

Run the same programming state with:
- empty equipment;
- full equipment.

Assert the prescription is identical.

## 31.8 Frequency across calendar weeks

Construct:
- frequency = 2;
- one compatible target session in week 1;
- one compatible target session in week 2.

Assert:
- one exposure in week 1;
- one exposure in week 2;
- no doubled week-1 prescription;
- no week-2 debt multiplier.

## 31.9 Missed exposure creates no debt

Generate an intended exposure but do not mark it completed.

Then generate the next appropriate session.

Assert:
- actual exposure remains zero;
- next session is not inflated as repayment;
- exposure cycle progresses only from actual training.

## 31.10 Actual completed training changes future state

Log/complete actual work.

Reconcile.

Assert:
- completed exposure affects future programming;
- locked/completed session is not rewritten;
- later unlocked programming adapts from actual history.

## 31.11 Recovery explanation

Given known previous exposure date:

Assert:
- actual date is included;
- no fabricated date.

## 31.12 Coverage explanation

Given actual covering exercises:

Assert:
- actual covering exercise names are used;
- generic "adequately exposed" alone is not used.

## 31.13 Better variation explanation

Given two valid variations and a valid selection reason:

Assert:
- unselected variation remains valid;
- reason says it was not selected because another valid option was better;
- no prescription failure is emitted.

## 31.14 Not-current-exposure explanation

Assert:
- valid target can be deferred;
- explanation distinguishes "not today's exposure" from invalidity.

## 31.15 Skip scope

Given an exposure-level decision:

Assert:
- it is not emitted as a separate independent daily skip for every session;
- scope is preserved.

## 31.16 No contradictory state

For every generated session:

```text
programmed exercise/target
∩
unprescribable exercise/target
= empty
```

---

# 32. Existing test suite to inspect and extend

The current repository already contains relevant tests including:

```text
tests/engine/blueprintCandidateGating.test.ts
tests/engine/consolidatedFixRequiredTests.test.ts
tests/engine/frequencyEngine.test.ts
tests/engine/workoutBuilder.test.ts
tests/engine/developmentReferenceEngine.test.ts
tests/engine/volumeEngine.test.ts
tests/engine/volumeEngineBlueprintFallbackGuard.test.ts
tests/engine/exerciseSelector.test.ts
tests/engine/exposureEngine.test.ts
tests/engine/explanationEngine.test.ts
tests/engine/surgicalFixWeeklyPlanTests.test.ts
tests/engine/finalPassRequiredTests.test.ts
tests/engine/strictBugFixRequiredTests.test.ts
tests/engine/assembleAndBuildWorkout.test.ts
tests/routes/actualTrainingAdaptation.test.ts
tests/routes/programming.test.ts
tests/frontend/programTerminology.test.ts
tests/frontend/sessionNoteUI.test.ts
tests/frontend/copyWorkoutText.test.ts
```

Do not blindly duplicate tests.

Inspect what each already proves.

Where an existing test encodes the old weekly semantics, update it to the final exposure-cycle model rather than preserving contradictory behavior just to keep the test green.

---

# 33. Important existing-test warning

The current repository already contains tests claiming that:

```text
weekly_direct_set_reference
```

is:

```text
sum(package sets) × package frequency
```

and tests claiming that frequency returns:

```text
sessions_per_week
assigned_days
```

Those tests reflect the **current implementation**, not automatically the final desired model.

If the architectural audit shows those semantics are wrong for the final programming model, update the tests to assert the correct semantic contract.

Do not let an old test definition prevent the required architectural correction.

---

# 34. Persistence/reconciliation requirements

Use the existing canonical path:

```text
computeFresh
→ reconcileWeekProgram
```

and:

```text
reconcileAfterActualTraining
```

where appropriate.

Do not create an alternate regeneration mechanism.

## Locked days

The current reconciliation uses `isDayLocked()` and treats completed/in-progress workout sessions as locked.

Preserve the established safety behavior:

> **Do not rewrite completed/locked sessions merely because the programmer changed.**

## Unlocked/future days

Only these may be regenerated when the canonical reconciliation logic determines they should change.

---

# 35. Production data safety

Before production regeneration:

1. Back up the actual SQLite DB.
2. Determine the actual DB path from the running deployment/configuration.
3. Do not assume an old runbook path.
4. Preserve completed/locked sessions.
5. Preserve historical workout data.
6. Preserve goals and goal events.
7. Preserve badminton records.
8. Preserve training profile.
9. Use canonical application reconciliation.
10. Do not use raw SQL to reconstruct workouts.
11. Verify DB integrity after regeneration.

The current deployment documentation/report establishes that the actual production DB is:

```text
/home/ubuntu/workout-logger/data/workout-logger.sqlite
```

and that the production app is deployed from GitHub `main` on the Oracle VM. Preserve that operational reality unless the repository itself has since changed it.

---

# 36. Deployment requirements

Authoritative repository:

```text
https://github.com/Kanadhibhotla-sri-charan/workout-logger.git
```

Production branch:

```text
main
```

Production VM:

```text
68.233.97.63
```

Deployment source must be:

```text
GitHub main → Oracle VM
```

**Do not use the Windows local repository as the deployment source.**

Do not read/copy:

```text
D:\workout-logger
C:\Users\...
```

for production deployment.

The VM should obtain the code from GitHub directly.

---

# 37. Blueprint synchronization

Do not run:

```text
npm run sync-blueprint
```

as an ordinary side effect of this deployment unless the implementation explicitly changes the Blueprint snapshot and requires synchronization.

The runtime Blueprint snapshot is part of the application.

Do not introduce a live dependency on another Blueprint repository.

---

# 38. Required verification sequence

Before deployment:

```text
1. inspect implementation
2. run targeted tests
3. run full test suite
4. typecheck
5. build
6. verify
7. inspect generated output
8. inspect API output
9. only then deploy
```

After deployment:

```text
1. service status
2. nginx status/config test
3. Node listener
4. local health endpoint
5. nginx health endpoint
6. external HTTP
7. API programming endpoint
8. SQLite integrity_check
9. foreign_key_check
10. verify historical/locked data
11. verify newly generated future sessions
```

Do not declare success merely because:

```text
npm test
```

passes.

---

# 39. Mandatory generated-output inspection

Inspect at least one realistic lower-body session and one upper-body session.

For the lower-body session specifically inspect:

- quads;
- glutes;
- calves;
- exercise set counts;
- whether valid Blueprint variations are being excluded;
- whether any target appears both programmed and skipped;
- whether equipment/time influenced the list;
- whether package-level volume was incorrectly copied to an individual target.

The Hip Abduction scenario must be explicitly checked.

---

# 40. Success criteria

The change is complete only when all of the following are true.

## Blueprint

- Every Blueprint variation is considered valid.
- Package membership is not an eligibility gate.
- No valid Blueprint variation is classified as "No valid prescription".
- Genuine Blueprint data defects are distinguishable from programming decisions.

## Exercise prescription

- Selected Blueprint exercises use authoritative prescriptions.
- No exercise exceeds its authored per-session set cap.
- Target/package volume cannot inflate an exercise.

## Exposure

- Frequency is interpreted through actual target-training exposures.
- Calendar weeks are reporting boundaries, not mandatory exposure containers.
- A frequency of 2 does not mean two sessions must occur in the same calendar week when only one compatible session exists.
- No missed-set debt exists.
- Actual completed work advances exposure state.

## Programming

- Goals retain priority.
- Recovery remains a valid programming constraint.
- Coverage/redundancy remain valid programming criteria.
- Valid exercises may be reserved for future exposure.
- No arbitrary numeric scoring is introduced.

## Equipment

- Equipment does not affect normal generation.
- Equipment may still affect explicit substitution.

## Time

- Time does not affect normal generation.
- Estimated time is informational only.
- No time-fitting skip is generated.

## Explanations

- Every normal exclusion has a concrete programming reason.
- Recovery can identify actual previous exposure dates.
- Coverage can identify actual covering exercises.
- Valid-but-unselected exercises are explained as not needed/selected today.
- No valid Blueprint exercise is described as unprescribable.

## Skip state

- Scope is correct.
- Global/exposure decisions are not duplicated as daily discoveries.
- Programmed and skipped/unprescribable states cannot contradict each other.

## Safety

- Completed/locked sessions remain unchanged.
- Historical data remains unchanged.
- Goals remain unchanged unless the requested programming change legitimately updates future state.
- Future unlocked programming is regenerated through canonical reconciliation.
- No ad-hoc SQL regeneration.

---

# 41. Final implementation rule

The most important distinction to preserve is:

```text
BLUEPRINT VALIDITY
    ≠
PACKAGE MEMBERSHIP
    ≠
TARGET VOLUME
    ≠
EXERCISE PRESCRIPTION
    ≠
ACTUAL EXPOSURE
    ≠
USER EXECUTION CONSTRAINT
```

And:

```text
Blueprint
    tells the programmer what is valid.

Programming engine
    decides what is useful now.

User
    decides what can actually be performed.
```

### Final governing principle

> **Only legitimate programming considerations may dictate inclusion/exclusion. Execution constraints such as equipment and time must not.**

"Results" here means the actual programming objective and state: goals, exposure, recovery, coverage, redundancy, progression, and the current exposure cycle.

Do not allow:
- equipment;
- time;
- package membership;
- missing package lookup;
- calendar-week boundaries;
- arbitrary candidate ordering

to masquerade as programming outcomes.

---

# 42. One-pass developer checklist

Before committing, the developer should be able to answer **YES** to every item:

- [ ] Did I audit `workoutBuilder.ts` rather than patch only the UI symptom?
- [ ] Did I audit `frequencyEngine.ts` and remove/rework calendar-week authority?
- [ ] Did I audit `developmentReferenceEngine.ts` for package-vs-target semantic conflation?
- [ ] Did I audit `volumeEngine.ts` for target-volume → exercise-prescription inflation?
- [ ] Did I remove Blueprint exercise rejection caused by package prescription lookup?
- [ ] Can every valid Blueprint exercise remain a candidate regardless of package level?
- [ ] Can any generated Blueprint exercise exceed its authored per-session sets? **It must be impossible.**
- [ ] Can time change the generated exercise list? **It must be impossible.**
- [ ] Can equipment change the generated exercise list? **It must be impossible.**
- [ ] Can a missed calendar-week exposure create set debt? **It must be impossible.**
- [ ] Can a target receive two intended exposures in one session merely because the week had only one compatible day? **It must be impossible.**
- [ ] Does actual completed training drive future programming?
- [ ] Are recovery decisions based on actual exposure?
- [ ] Are coverage explanations based on actual covering exercises?
- [ ] Can a valid but unselected exercise be clearly distinguished from invalid Blueprint data?
- [ ] Can a valid Blueprint exercise reach `no_resolvable_prescription` through normal package lookup? **It must be impossible.**
- [ ] Are week/exposure/session skip scopes correct?
- [ ] Can a programmed exercise also appear as unprescribable? **It must be impossible.**
- [ ] Did I add generic regression tests rather than exercise-specific patches?
- [ ] Did I run the full test suite?
- [ ] Did I run typecheck?
- [ ] Did I run build?
- [ ] Did I run verify?
- [ ] Did I inspect realistic generated output?
- [ ] Did I protect completed/locked production sessions?
- [ ] Did I regenerate only future/unlocked programming?
- [ ] Did I use canonical reconciliation rather than raw SQL?
- [ ] Will deployment pull from GitHub `main` directly on the Oracle VM?
- [ ] Did I avoid the Windows local repository during deployment?

If any answer is NO, the implementation is not complete.
