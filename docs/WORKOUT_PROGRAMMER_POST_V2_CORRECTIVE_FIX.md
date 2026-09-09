# Workout Programmer — Post-v2 Corrective Fix
## One-pass implementation specification for the CURRENT repository state

**Status:** This specification supersedes the previous v2 implementation specification for the next development pass.

**Important:** The repository supplied with this task is the repository **after v2 was implemented**. Do not assume v2 requirements are still unimplemented. The purpose of this document is to inspect the post-v2 implementation, preserve the parts that are now correct, and fix the remaining architectural/model problems without regressing the successful v2 changes.

---

# 1. Objective

The current application has already implemented several v2 corrections:

- normal generation no longer filters by equipment;
- normal generation no longer uses time fitting;
- selected exercises respect their own authored set counts;
- package membership is no longer used as the pre-ranking candidate gate for physique targets;
- friendly explanations use structured reason codes;
- contradictory programmed/skipped state is guarded;
- substitution can still use equipment filtering separately.

Those changes must be preserved.

However, the current post-v2 code still has a deeper issue:

> **The programmer is still fundamentally allocating target work inside a calendar-week state machine.**

The next fix must address that underlying model rather than patching another visible symptom.

The desired model is:

```text
BLUEPRINT
    defines valid exercises and authored exercise prescriptions
        ↓
PROGRAMMING STATE
    determines what target/exposure is due now
    using goals, actual exposure, recovery, coverage,
    redundancy, progression, and other legitimate
    programming considerations
        ↓
SESSION
    receives the prescription for this actual exposure
        ↓
USER
    decides whether/how to execute it
        ↓
ACTUAL LOGGED TRAINING
    becomes authoritative state for future programming
```

The calendar week may remain as a reporting/persistence container, but it must not be the authoritative unit that creates weekly volume obligations or exposure debt.

---

# 2. Current post-v2 state — preserve these successful changes

Before changing anything, understand that the current repository is **already after the previous v2 fix**.

Do not regress the following.

## 2.1 Equipment

`workoutBuilder.ts` currently constructs the normal candidate universe without equipment filtering.

This is correct.

Normal generation must remain invariant to:

```text
available_equipment
```

The user handles execution/substitution.

The substitution route may continue using:

```text
filterEquipmentFeasible
```

because that is an explicit user-driven substitution operation.

## 2.2 Time

`workoutBuilder.ts` currently does not call `fitToTimeBudget()` as part of normal generation.

This is correct.

The session's:

```text
availableMinutes
estimatedMinutes
```

may remain informational.

They must not affect generated programming.

## 2.3 Exercise-level set cap

The current builder uses the selected exercise's own prescription sets when determining requested delivery.

This is directionally correct and must be preserved.

The generic invariant remains:

```text
generated_sets <= authoritative_per_session_sets
```

for every generated Blueprint exercise.

## 2.4 Package candidate gate

The current builder no longer pre-filters physique candidates by package-listed prescription before ranking.

This is correct.

Efficient/Complete package membership is not the exercise universe.

## 2.5 Friendly explanations

The current `friendlyExplanation.ts` has structured reasons including:

```text
recovery
not_current_exposure
adequately_covered
no_volume_recommended
blueprint_data_integrity
```

Preserve the structured explanation architecture.

The next change should make its facts more accurate for the new exposure-cycle model rather than replacing it with ad-hoc strings.

---

# 3. CRITICAL: Current weekly allocation is NOT the final exposure-cycle model

The current `src/engine/workoutBuilder.ts` still contains:

```text
desiredWeekly
remainingWeeklySets
compatibleDaysThisWeek
eligibleDaysThisWeek
sessionsRemainingThisWeek
weekly_direct_set_reference
```

The current comments say this mechanism replaced a prior `desiredWeekly / sessionsRemainingThisWeek` division.

That improvement is useful, but it does **not** mean the final model is exposure-cycle based.

The current algorithm still effectively does:

```text
calculate target's weekly requirement
        ↓
find compatible days in THIS calendar week
        ↓
cap those days using weekly frequency
        ↓
carry remainingWeeklySets through those days
        ↓
finish the week
```

The desired model is different:

```text
determine whether the target is due for an exposure
        ↓
identify the next appropriate actual target-training session
        ↓
prescribe one exposure
        ↓
actual completion becomes exposure history
        ↓
future target-training session advances the cycle
```

This distinction is mandatory.

---

# 4. Do NOT preserve the weekly state machine under a different name

The following are specifically prohibited as "fixes":

```text
rename remainingWeeklySets → remainingExposureSets
```

while still resetting it each calendar week;

or:

```text
change desiredWeekly arithmetic
```

while still requiring the target to consume its allocation before Sunday;

or:

```text
increase the weekly window
```

to simulate a multi-week exposure cycle;

or:

```text
carry an integer "debt" forward
```

and call it exposure state.

The underlying state transition must actually be based on **completed/required exposures**, not calendar-week set repayment.

---

# 5. Required exposure-cycle semantics

## 5.1 Frequency is an exposure-frequency reference

If Blueprint/reference information says:

```text
frequency = 2
```

this should be interpreted as an intended exposure frequency/reference, not:

```text
exactly 2 target sessions inside every Monday-Sunday calendar week
```

## 5.2 Example

User schedule:

```text
Week 1:
  Monday gym
  Thursday gym

Week 2:
  Monday gym
  Thursday gym
```

Suppose a target can appropriately be trained only on Thursday.

Then:

```text
Week 1 Thursday → target exposure 1
Week 2 Thursday → target exposure 2
```

Do not attempt:

```text
Week 1 Thursday → exposure 1 + exposure 2
```

merely because there was only one compatible day in week 1.

## 5.3 No missed-set debt

If the target was intended to be exposed but the user did not actually train it:

```text
actual completed exposure = 0
```

It must not become:

```text
next exposure = 2x volume
```

or:

```text
weekly debt = previous missing sets
```

The next appropriate target-training session should simply continue from the actual state.

## 5.4 Calendar boundary

When Monday arrives:

```text
do not reset exposure state
do not erase recent exposure
do not create new volume debt
```

Historical actual training remains part of the rolling programming state.

---

# 6. What "exposure" means

Use the application's established actual-training/exposure concepts where possible.

An exposure is a meaningful target-training occurrence, determined by the existing direct/secondary exposure methodology.

Do not define exposure as:

```text
calendar week contains target
```

and do not define it as:

```text
program generated for target
```

when the user did not actually complete that training.

Where the existing system already has:

```text
actual logged sets
actual target exposure
weekly_exposure_units
```

audit how those values are used and determine whether they represent actual exposure or only a weekly aggregate.

Do not blindly rename them.

---

# 7. Actual training is authoritative

The following distinction must remain absolute:

```text
PLANNED
    ≠
COMPLETED
```

If the generated program contains:

```text
Back Squat × 3
```

but the user never completes/logs it:

```text
actual exposure = 0 from that exercise
```

If the user completes:

```text
Back Squat × 3
```

that actual work must feed future programming.

Use the existing:

```text
reconcileAfterActualTraining
```

and canonical reconciliation flow.

Do not create a parallel state update mechanism.

---

# 8. Calendar-week objects may remain

This requirement does NOT mean removing weekly UI/persistence objects.

It is acceptable to retain:

```text
WeeklyPlan
WeeklyPlanSession
weekStart
weekEnd
```

and to generate a displayable week.

The requirement is:

> **The week is a view/container, not the authoritative target-exposure state machine.**

The same target exposure state must remain meaningful when the next appropriate session occurs in a different calendar week.

---

# 9. Required transformation of `workoutBuilder.ts`

The current code around the target loop must be audited as a whole.

Especially inspect:

```text
requiredDirectSetsByTarget
desiredWeekly
weeklyAllocation
compatibleDaysThisWeek
sessionsRemainingThisWeek
eligibleDaysThisWeek
remainingWeeklySets
sessionCap
```

## 9.1 Do not simply delete the variables

Some equivalent concept may still be needed.

The requirement is semantic:

- no calendar-week volume debt;
- no forced completion of a weekly target;
- no exposure compression;
- actual exposures drive state.

## 9.2 Current last-day logic is not sufficient

The current code correctly added:

```text
sessionCap =
    developmentReference?.direct_sets_per_exposure
```

and prevents the final day from absorbing an entire weekly remainder.

That is a useful guard.

But it is still embedded in:

```text
for each eligible day THIS WEEK
    consume remainingWeeklySets
```

Therefore it prevents one form of compression but does not create the correct exposure-cycle model.

Do not mistake the `sessionCap` fix for completion of this requirement.

---

# 10. Required transformation of frequency/allocation logic

There is **no separate `frequencyEngine.ts` in the current post-v2 repository**.

Do not invent or reference one.

The relevant frequency/allocation logic is embedded in `workoutBuilder.ts`, including the existing `allocateFrequency()`-style logic and the use of:

```text
sessions_per_week
assigned_days
compatibleDaysThisWeek
eligibleDaysThisWeek
sessionsRemainingThisWeek
```

The developer must audit that actual implementation.

If a helper is extracted during the fix, that is fine, but do not create an unnecessary second architecture.

The resulting frequency logic must answer:

```text
How often should this target normally be exposed?
Is the target due for an exposure now?
Which actual future training session is the next appropriate exposure?
What actual exposure has already occurred?
```

It must not answer only:

```text
How many times can I fit this target into Monday-Sunday?
```

---

# 11. Package-level development reference semantics

Audit:

```text
src/engine/developmentReferenceEngine.ts
src/engine/volumeEngine.ts
src/engine/workoutBuilder.ts
```

The current development reference still calculates:

```text
sum(package exercise sets)
×
package.frequency.sessions_per_week
```

as:

```text
weekly_direct_set_reference
```

and also provides:

```text
direct_sets_per_exposure
```

## 11.1 Preserve the distinction

These are not interchangeable.

### Package-level reference

Describes the authored development package.

### Target-level objective

Describes what the individual target currently needs from the programming state.

### Exercise-level prescription

Describes what a specific exercise variation prescribes when selected.

### Actual exposure

Describes what the user actually trained.

These must remain separate.

---

# 12. Critical package/target issue

Do not automatically do:

```text
package total
→ assign entire package total to target A
```

when the package represents several targets/exercises.

Trace the actual target mapping in the Blueprint.

For every development package, determine:

```text
package
    → exercise
        → target
            → authored sets/role
```

Then determine what reference belongs to the individual target.

If the current data model genuinely defines the package aggregate as a target-level reference, document why from the Blueprint schema before retaining it.

Do not assume it merely because the current test expects it.

---

# 13. `direct_sets_per_exposure` is a reference, not a mandatory quota

The current code uses:

```text
developmentReference.direct_sets_per_exposure
```

as a session cap.

Preserve the protective behavior, but ensure its semantic meaning is correct.

It must not become:

```text
every exposure must deliver exactly N sets
```

unless the authoritative Blueprint explicitly says so.

It is acceptable to use it as a natural development reference/capacity.

It is not acceptable to use it to create a hidden quota/debt system.

---

# 14. Exercise-level prescription resolution

Current `workoutBuilder.ts` still uses:

```text
lookupExercisePrescriptionAnyLevel(...)
```

when resolving the selected Blueprint exercise.

This function searches development package levels.

The current pre-ranking package gate has been removed, which is good.

However, the final model requires a stronger separation:

> **Package lookup must not determine whether a Blueprint exercise is valid.**

For every Blueprint exercise:

```text
exists in authoritative Blueprint exercise library
→ valid exercise variation
```

If selected:

```text
resolve its authoritative exercise prescription
```

The developer must inspect the actual Blueprint snapshot/schema to determine the authoritative source.

Do not fabricate a prescription.

Do not classify a real Blueprint exercise as a normal programming skip merely because:

```text
lookupExercisePrescriptionAnyLevel() === null
```

If the authoritative Blueprint record is genuinely missing required prescription information, treat that as:

```text
blueprint_data_integrity
```

and fix/report the source-data problem rather than converting it into a normal "not selected today" reason.

---

# 15. Important distinction for outside-Blueprint exercises

The current code has special handling for approved outside-Blueprint exercises.

Preserve the existing rule for them.

Do not accidentally make:

```text
outside-Blueprint exercise
```

equivalent to:

```text
Blueprint exercise
```

with respect to validity.

The hard "every variation is valid" rule applies to **authoritative Blueprint variations**.

Approved outside-Blueprint exercises must continue to use their explicit approved prescription/data requirements.

---

# 16. Exercise selection must remain programming-driven

Valid Blueprint candidates can be excluded today for legitimate programming reasons such as:

- target not due for this exposure;
- recovery insufficient;
- target already adequately covered;
- redundant with today's work;
- another valid variation is better for today's objective;
- goal priority allocated the session elsewhere;
- variation reserved for another exposure;
- progression/history makes another valid option preferable.

These are programming decisions.

They must not be converted into:

```text
unprescribable
invalid
no valid prescription
```

---

# 17. No time filtering

Hard invariant:

```text
time availability has ZERO effect on normal generation
```

Audit the complete generation path for:

```text
fitToTimeBudget
availableMinutes
budgetMinutes
estimatedMinutes
session duration
time fitting
resource allocation
```

The current builder already no longer calls `fitToTimeBudget()` in normal generation.

Preserve that.

Do not introduce another equivalent time filter.

### Required test

Same programming state:

```text
budget = 1 minute
```

and:

```text
budget = 300 minutes
```

must produce the same:

```text
targets
exercises
sets
reps
RIR
inclusion/exclusion decisions
```

Only informational duration fields may differ.

---

# 18. No equipment filtering

Hard invariant:

```text
equipment availability has ZERO effect on normal generation
```

The current generation candidate universe should remain the full valid Blueprint exercise universe plus approved outside-Blueprint candidates.

Do not use equipment for:

- candidate eligibility;
- ranking;
- allocation;
- target selection;
- exercise count;
- exercise sets;
- post-selection filtering.

Preserve equipment filtering for explicit substitution requests.

### Required test

Same programming state:

```text
available equipment = []
```

and:

```text
available equipment = all
```

must generate the same programming result.

---

# 19. No exercise inflation

Global invariant:

```text
generated_sets <= authoritative_per_session_sets
```

for every Blueprint exercise.

This must hold regardless of:

- remaining target objective;
- goal allocation;
- development package;
- current exposure;
- last day of a week;
- last exercise in a session;
- number of remaining candidates;
- whether it is the only candidate.

The Hip Abduction case remains a mandatory regression:

```text
Hip Abduction authored = 2 sets/session
target objective = 8+
```

must never produce:

```text
Hip Abduction = 8
```

---

# 20. Do not solve target volume by inflating one exercise

Correct:

```text
target objective = 8
exercise A authored = 2
exercise B authored = 2
exercise C authored = 2
exercise D authored = 2

→ potentially distribute across legitimate variations/exposures
```

Incorrect:

```text
target objective = 8
only exercise A available
→ A = 8
```

If the objective cannot be delivered without violating:

- exercise prescriptions;
- exposure-cycle boundaries;
- recovery;
- legitimate programming constraints,

do not force it.

The unmet amount is not debt.

---

# 21. Skip scope must be fixed at the data-model level

Current `workoutBuilder.ts` creates:

```text
weekLevelSkips
```

with:

```text
scope: 'week'
```

and then assigns:

```text
skipped: weekLevelSkips
```

to every generated session.

This is not the desired representation.

## Required behavior

A decision must have an appropriate scope:

```text
session
exposure
program/week-view
data-integrity
```

A target that is not due for an exposure should not appear as though the engine independently rediscovered and skipped it on every day.

Do not merely deduplicate identical cards in the UI.

Fix the underlying scope.

---

# 22. "Not current exposure" must no longer mean "not this week"

The current explanation contains language equivalent to:

```text
Not part of this week's exposure cycle
```

That is still calendar-week semantics.

Change the underlying state and explanation to something like:

> “This target is not due for this exposure. It remains available for the next appropriate target-training session.”

Only mention a specific future session/date if the engine can establish it.

---

# 23. Friendly explanations must reflect actual state

Preserve `src/server/friendlyExplanation.ts`.

Update its inputs/reasoning as required.

## Recovery

Use:

```text
last_direct_exposure_date
days_since_last_exposure
```

when known.

Example:

> “This muscle was trained directly on September 7, so there isn't enough recovery for another direct session today.”

## Coverage

Use actual covering exercises.

Example:

> “This target is already covered today by Back Squats and Leg Extensions, so another direct quad exercise isn't needed in this session.”

## Better variation

Example:

> “A different valid variation was selected because it provides the better fit for today's programming objective. This variation remains available for another exposure.”

## Future exposure

Example:

> “This variation is valid, but it isn't needed in this exposure. It remains available for a later appropriate exposure.”

## Data integrity

Only for genuine Blueprint data defects:

> “The Blueprint data for this target is incomplete, so the programmer cannot safely use it until that data is fixed.”

Never use data-integrity wording for:

- package absence;
- ranking;
- redundancy;
- recovery;
- time;
- equipment;
- current-exposure scheduling.

---

# 24. No generic fall-through explanation

Every normal exclusion reason must map to a known structured reason.

Do not do:

```text
unknown reason
→ "No valid prescription"
```

Do not do:

```text
unknown reason
→ "Skipped"
```

If a new reason is introduced, add:

1. structured reason code;
2. required facts;
3. friendly explanation;
4. regression test.

Unknown engine states should be visible during development/test rather than silently misrepresented to the user.

---

# 25. Current vs future exercise validity

If:

```text
Exercise A = valid Blueprint exercise
Exercise B = valid Blueprint exercise
```

and today's programming selects A:

```text
A = selected today
B = valid but not selected today
```

Do not turn B into:

```text
B = invalid
```

B remains available to the future candidate universe.

The explanation may say:

> “A different valid variation was selected for today's objective. This variation remains available for another exposure.”

---

# 26. Candidate selection and current-day coverage

A target may already be sufficiently covered today.

For example:

```text
Back Squat
Leg Extension
```

may already provide the relevant quad coverage.

Then another direct quad exercise may legitimately not be selected.

But the excluded exercise remains valid.

The engine should record:

```text
adequately_covered
```

with structured evidence:

```text
covering_exercises = [...]
```

not:

```text
no_prescription
```

---

# 27. Goal priority

Preserve the established goal behavior.

Active goals:
- receive development priority;
- influence target allocation;
- may use Complete development references;
- remain subject to recovery and exposure state;
- cannot override authored exercise set caps;
- cannot create weekly debt.

Non-goal targets:
- continue to receive appropriate development/maintenance attention;
- use Efficient references where applicable;
- remain subject to recovery, coverage, and exposure state.

Do not introduce a universal volume multiplier to compensate for architectural changes.

---

# 28. Badminton/competing workload

Preserve the existing competing-workload logic where it is genuinely part of the programming model.

However:

> A badminton-related reduction must not be implemented as a hidden calendar-week debt mechanism.

If badminton reduces lower-body programming, it should reduce the appropriate actual exposure/target allocation according to the existing rule.

It must not cause later sessions to backfill the reduction automatically.

---

# 29. Required architecture for future programming

The developer must ensure that future programming can be reasoned about as:

```text
For each target:

1. What is the current development/goal state?
2. What actual target exposure has occurred recently?
3. Is the target recovered?
4. Is the target due for another exposure?
5. What is the next appropriate actual training session?
6. What amount is appropriate for THIS exposure?
7. Which valid Blueprint variations best serve THIS exposure?
8. What is each selected exercise's own authored prescription?
9. What actual training will advance the state afterward?
```

Not:

```text
1. What is this week's target volume?
2. How many compatible days remain this week?
3. How many sets are left?
4. How do I finish the number before Sunday?
```

---

# 30. Reconciliation behavior

Use the existing canonical reconciliation mechanisms.

Known existing flow includes:

```text
computeFresh
→ reconcileWeekProgram
```

and:

```text
reconcileAfterActualTraining
```

Preserve these.

Do not add:

```text
generateExposureDebt()
```

or:

```text
catchUpMissedSets()
```

or any equivalent secondary mechanism.

---

# 31. Locked/completed sessions

Completed/locked sessions must remain protected.

A programmer fix must not rewrite history simply because the new algorithm produces a different result.

Use the existing locking rules.

Historical actual training remains authoritative.

Future/unlocked sessions may be regenerated through canonical reconciliation.

---

# 32. Persistence safety

Before any production regeneration:

1. back up the actual production SQLite database;
2. determine the DB path from the running service/configuration;
3. do not assume an obsolete path;
4. preserve completed sessions;
5. preserve historical logs;
6. preserve goals;
7. preserve actual training;
8. regenerate only unlocked/future programming;
9. verify database integrity;
10. verify application behavior.

Do not use raw SQL to reconstruct workout plans.

---

# 33. Deployment source

Production deployment must use:

```text
GitHub main
→ Oracle VM
```

Repository:

```text
https://github.com/Kanadhibhotla-sri-charan/workout-logger.git
```

Production VM:

```text
68.233.97.63
```

Do not use the user's Windows local repository as a deployment source.

Do not copy from:

```text
D:\workout-logger
```

or other local Windows checkouts.

The authoritative deployment source is GitHub `main` on the VM.

---

# 34. Blueprint synchronization

Do not run:

```text
npm run sync-blueprint
```

as an automatic part of ordinary deployment.

Only synchronize the Blueprint when the actual Blueprint source has intentionally changed and the resulting snapshot is explicitly part of the change.

Do not create a live dependency on another Blueprint repository.

---

# 35. Required regression tests

Add or modify tests in the current repository.

Do not merely add tests that reproduce the current implementation.

Tests must encode the desired model.

## Test A — Authored exercise cap

For every generated Blueprint exercise:

```text
generated_sets <= authored_per_session_sets
```

Include Hip Abduction explicitly.

## Test B — Target volume cannot inflate exercise

Fixture:

```text
target objective = 8
exercise authored = 2
```

Assert:

```text
exercise <= 2
```

## Test C — Frequency across calendar boundary

Fixture:

```text
frequency = 2
one compatible target-training session in week 1
one compatible target-training session in week 2
```

Assert:

```text
week 1 → one exposure
week 2 → next exposure
```

Never:

```text
week 1 → two exposures
```

## Test D — Missed exposure creates no debt

Generate an intended exposure but do not complete it.

Next appropriate target-training session:

Assert:
- actual exposure remains zero;
- next session is not doubled;
- no debt variable is accumulated.

## Test E — Completed exposure advances state

Complete/log the target training.

Reconcile.

Assert:
- actual exposure affects future programming;
- completed session remains locked;
- future session adapts from actual history.

## Test F — Calendar Monday does not reset exposure

Create an actual exposure immediately before a calendar boundary.

Generate the next appropriate session after the boundary.

Assert:
- recent actual exposure remains known;
- the target is not treated as though it was never trained merely because the week changed.

## Test G — Time invariance

Generate identical programming state with:

```text
1 minute
```

and:

```text
300 minutes
```

Assert identical programming prescription.

## Test H — Equipment invariance

Generate identical programming state with:

```text
no equipment
```

and:

```text
all equipment
```

Assert identical programming prescription.

## Test I — Package absence does not invalidate Blueprint exercise

Use a Blueprint variation that exists outside the selected development package.

Assert:
- valid candidate;
- no package-gating rejection;
- no unprescribable reason.

## Test J — Genuine Blueprint data defect

Use a deliberately malformed Blueprint fixture.

Assert:
- data-integrity error;
- not a normal programming skip;
- valid Blueprint exercises remain unaffected.

## Test K — Recovery explanation

Known prior exposure date.

Assert:
- actual date appears;
- no fabricated date.

## Test L — Coverage explanation

Known covering exercises.

Assert:
- actual exercise names appear;
- no bare "adequately covered".

## Test M — Valid but unselected variation

Two valid variations.

Select one.

Assert:
- other remains valid;
- reason is programming-based;
- no prescription failure.

## Test N — Skip scope

Create an exposure-level exclusion.

Assert:
- not copied as independent daily skip records;
- correct scope is preserved.

## Test O — No contradictory state

Assert:

```text
programmed ∩ unprescribable = empty
```

for every session.

## Test P — Package aggregate is not duplicated across targets

Create a package with multiple target mappings.

Assert:
- package aggregate is not silently assigned in full to every target unless the Blueprint schema explicitly requires it.

---

# 36. Required invariance tests

The following should be treated as global properties.

### Property 1

```text
time input changes
→ programming output does not
```

### Property 2

```text
equipment input changes
→ programming output does not
```

### Property 3

```text
calendar week changes
without actual target exposure
→ actual exposure state does not reset
```

### Property 4

```text
target objective increases
→ exercise authored prescription does not increase
```

### Property 5

```text
package level changes
→ Blueprint exercise validity does not disappear
```

### Property 6

```text
exercise not selected today
→ exercise remains valid for future candidate selection
```

---

# 37. Required source audit

Before modifying code, inspect at minimum:

```text
src/engine/workoutBuilder.ts
src/engine/developmentReferenceEngine.ts
src/engine/volumeEngine.ts
src/blueprint/developmentPackages.ts
src/engine/exerciseSelector.ts
src/engine/exposureEngine.ts
src/server/friendlyExplanation.ts
src/server/routes/programming.ts
```

Also inspect:

```text
tests/engine/workoutBuilder.test.ts
tests/engine/developmentReferenceEngine.test.ts
tests/engine/developmentReferenceIntegration.test.ts
tests/engine/volumeEngine.test.ts
tests/engine/volumeEngineBlueprintFallbackGuard.test.ts
tests/engine/exerciseSelector.test.ts
tests/engine/exposureEngine.test.ts
tests/friendlyExplanation.test.ts
tests/routes/actualTrainingAdaptation.test.ts
tests/routes/programming.test.ts
```

Search for:

```text
desiredWeekly
remainingWeeklySets
requiredDirectSetsByTarget
weeklyAllocation
compatibleDaysThisWeek
eligibleDaysThisWeek
sessionsRemainingThisWeek
weekly_direct_set_reference
direct_sets_per_exposure
weekly_exposure_units
fitToTimeBudget
filterEquipmentFeasible
availableMinutes
available_equipment
lookupExercisePrescription
lookupExercisePrescriptionAnyLevel
no_resolvable_prescription
blueprint_data_integrity
weekLevelSkips
sessionSkipped
not_current_exposure
adequately_covered
reconcileAfterActualTraining
reconcileWeekProgram
computeFresh
ensureWeekProgramGenerated
```

Search semantic equivalents too.

---

# 38. Do not blindly preserve old tests

Some current tests may be asserting the behavior introduced by earlier fixes rather than the final model.

For example, tests that assert:

```text
weekly_direct_set_reference
sessions_per_week
eligible_days_this_week
```

may need to be updated if those values are currently being used as authoritative programming state.

Do not remove tests casually.

For each affected test, determine:

```text
Does this test protect a real invariant?
or
Does it merely snapshot an implementation detail that conflicts with the final model?
```

Keep the first.

Update the second.

---

# 39. Do not create a universal hardcoded volume rule

Do not fix this by saying:

```text
every target = 8 sets
```

or:

```text
every exposure = N sets
```

or:

```text
all muscles use the same frequency
```

The programmer must continue using:

- Blueprint development references;
- goal state;
- target classification;
- actual exposure;
- recovery;
- coverage;
- progression;
- established programming rules.

The required change is the **state model**, not a replacement with a simpler hardcoded volume model.

---

# 40. Do not turn every Blueprint exercise into today's workout

The rule:

> Every Blueprint variation is valid.

does **not** mean:

> Every Blueprint variation must be generated today.

The programmer must still choose.

The distinction is:

```text
valid candidate
≠
selected today
```

This is crucial.

---

# 41. Do not turn development packages into exercise menus

The package tells the programmer about development level/reference/coverage.

It does not mean:

```text
Complete package
→ these are the only valid exercises
```

and it does not mean:

```text
Efficient package
→ all other Blueprint exercises are invalid
```

The full Blueprint exercise universe remains available.

---

# 42. Do not use equipment/time as hidden ranking signals

Even if the final candidate list is unchanged, the selection order must not be secretly altered by:

```text
equipment
time
estimated duration
```

because that still changes the generated prescription.

The result must be invariant, not merely the candidate universe.

---

# 43. Required explanation facts

Where a reason requires facts, expose them from the engine rather than reconstructing them in the UI.

Minimum useful fields include:

```text
reason_code
scope
target_type
target_id
exercise_id
classification
goal_id
goal_priority
last_direct_exposure_date
days_since_last_exposure
current_exposure_index
expected_frequency
current_session_coverage
covering_exercises
selected_alternative
next_appropriate_exposure
```

Only provide values that are actually known.

Do not fabricate future dates.

---

# 44. Friendly explanation examples

Use these as behavioral examples, not mandatory exact wording.

### Recovery

> This muscle was trained directly on September 7, so there isn't enough recovery for another direct session today.

### Covered

> This target is already covered today by Back Squats and Leg Extensions, so another direct quad exercise isn't needed in this session.

### Better option

> A different valid variation was selected because it provides the better fit for today's programming objective. This variation remains available for another exposure.

### Not due

> This target isn't due for this exposure. It remains available for the next appropriate target-training session.

### Data problem

> The Blueprint data for this target is incomplete, so the programmer cannot safely use it until that data is fixed.

Avoid:

> No valid prescription.

for a valid Blueprint variation.

---

# 45. API/UI consistency

Inspect the complete path:

```text
engine decision
→ API serialization
→ session skipped/excluded data
→ friendly explanation
→ UI card
```

The API must not transform:

```text
valid-but-not-selected
```

into:

```text
invalid
```

The UI must not transform:

```text
not_current_exposure
```

into:

```text
No valid prescription
```

The scope must survive serialization.

---

# 46. Programmed-vs-skipped reconciliation

Before returning the final program, validate:

```text
plannedWork
vs
skipped/excluded
```

for every target/exercise.

No entity should appear in contradictory semantic states.

If a target has:

```text
planned direct work
```

and:

```text
adequately_covered
```

the explanation must refer to another candidate/coverage decision rather than claiming the target itself was unneeded.

Do not suppress contradictions in the UI.

Fix the state.

---

# 47. Required logging/debug information

During development/test, the engine should make it possible to inspect:

```text
target
current exposure state
last actual exposure
frequency/reference
whether due
reason for not due
session selected for exposure
target objective for this exposure
selected exercises
each exercise's authored sets
delivered sets
remaining objective, if any
```

Do not log sensitive user data unnecessarily.

The purpose is deterministic debugging of the programming state.

---

# 48. One-pass implementation sequence

Follow this sequence.

## Phase 1 — Audit

Trace the actual current code.

Do not edit immediately.

Identify:
- where calendar-week state enters;
- where package totals become target numbers;
- where exercise prescriptions are resolved;
- where actual exposure enters;
- where candidate selection occurs;
- where skips are created;
- where API/UI transforms reasons.

## Phase 2 — Model correction

Implement the exposure-cycle semantics.

Do not start with explanation strings.

## Phase 3 — Volume/prescription correction

Ensure:
- target/package references remain distinct;
- authored exercise prescriptions remain authoritative;
- no exercise inflation is possible.

## Phase 4 — Skip/explanation correction

Make reasons and scopes accurately describe the corrected state.

## Phase 5 — Regression suite

Add all required invariants.

## Phase 6 — Full verification

Run the full suite, typecheck, build, and verify.

## Phase 7 — Generated-output inspection

Inspect realistic generated workouts.

Only after all of this should production be changed.

---

# 49. Anti-workaround checklist

The following do NOT count as completing this specification:

- [ ] Renaming `remainingWeeklySets`.
- [ ] Changing the weekly arithmetic while keeping the week authoritative.
- [ ] Hiding repeated skip cards without fixing skip scope.
- [ ] Replacing “No valid prescription” with another vague label.
- [ ] Adding a Hip Abduction-specific set cap.
- [ ] Changing only the package reference number.
- [ ] Removing one time-filter call while leaving another generation-stage time filter.
- [ ] Removing one equipment-filter call while retaining equipment-based ranking.
- [ ] Treating planned work as actual exposure.
- [ ] Creating missed-set debt under a different name.
- [ ] Making every Blueprint variation appear in every workout.
- [ ] Removing all programming selection logic in favor of the full Blueprint menu.
- [ ] Weakening tests to preserve old implementation behavior.
- [ ] Fixing only the UI while backend state remains wrong.

---

# 50. Production deployment safety

Before deployment:

```text
1. confirm tests pass
2. confirm typecheck passes
3. confirm build passes
4. confirm verification passes
5. inspect generated output
6. back up production DB
7. deploy from GitHub main on Oracle VM
8. restart/reload only as required
9. verify service
10. verify HTTP
11. verify API
12. verify SQLite integrity
13. verify locked/history data
14. regenerate future/unlocked programming through canonical reconciliation
15. inspect resulting future sessions
```

Do not manually rewrite the SQLite program tables with SQL.

---

# 51. Final acceptance criteria

The implementation is complete only if all are true.

## Blueprint validity

- Every authoritative Blueprint exercise variation is valid.
- Package membership cannot invalidate it.
- Efficient/Complete membership cannot act as an exercise eligibility gate.
- A valid Blueprint variation cannot receive a normal "No valid prescription" state.

## Prescription

- Selected Blueprint exercises use authoritative exercise-level prescriptions.
- Generated sets never exceed authored per-session sets.
- Target/package volume never inflates exercise sets.
- No exercise-specific hardcoded workaround is used.

## Exposure

- Frequency is handled through actual target-training exposures.
- Calendar week is not the authoritative exposure state.
- A target with frequency 2 can have exposure 1 in one calendar week and exposure 2 in the next.
- A single compatible session does not receive two compressed exposures.
- Missed training does not create set debt.
- Calendar boundaries do not reset actual exposure state.
- Actual completed training drives future programming.

## Programming

- Goals remain prioritized.
- Recovery remains a legitimate constraint.
- Coverage/redundancy remain legitimate constraints.
- Valid alternatives can be reserved for future exposure.
- The programmer does not require every valid Blueprint exercise to appear today.

## Execution constraints

- Time has zero effect on normal generation.
- Equipment has zero effect on normal generation.
- Time/equipment may remain relevant to explicit user substitution.
- No hidden time/equipment ranking remains.

## Explanations

- Reasons are structured.
- Reasons are evidence-based.
- Recovery can reference actual prior exposure.
- Coverage can reference actual covering exercises.
- "Not due" is distinct from "invalid".
- Data-integrity problems are distinct from programming decisions.
- No vague fallback mislabels a valid exercise.

## Skip scope

- Session decisions are session-scoped.
- Exposure decisions are exposure-scoped.
- Reporting/week decisions are not copied into every session as independent skips.
- Programmed and unprescribable states cannot contradict each other.

## Safety

- Completed/locked history is preserved.
- Actual training history is preserved.
- Goals are preserved.
- Future/unlocked programming is the only programming changed by normal reconciliation.
- No ad-hoc SQL regeneration is used.

---

# 52. Final principle

The programmer must ultimately behave like this:

```text
                    BLUEPRINT
                       │
                       │
          "What is valid?"
                       │
                       ▼
              PROGRAMMING STATE
                       │
       ┌───────────────┼────────────────┐
       │               │                │
     Goals          Exposure          Recovery
       │               │                │
       └───────────────┼────────────────┘
                       │
                 Coverage /
                 Redundancy /
                 Progression
                       │
                       ▼
             "What is useful now?"
                       │
                       ▼
              GENERATED SESSION
                       │
                       ▼
                     USER
                       │
                       ▼
              ACTUAL TRAINING
                       │
                       └──────────► future programming
```

The critical separations are:

```text
Blueprint validity
    ≠ package membership

Package reference
    ≠ target quota

Target objective
    ≠ exercise prescription

Exercise prescription
    ≠ actual completed exposure

Calendar week
    ≠ exposure cycle

Valid candidate
    ≠ selected today

User execution constraint
    ≠ programming decision
```

And the governing rule is:

> **Only legitimate programming considerations may determine what is included or excluded.**

Equipment and time are execution concerns.

Package membership is not validity.

A valid exercise that is not selected today is still valid.

A missed calendar-week exposure is not debt.

An exercise's authored prescription is not negotiable.

Actual completed training is what advances the programming state.

**Implement the underlying model, not merely the symptoms visible in the UI.**
