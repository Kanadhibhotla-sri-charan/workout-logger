# Workout Programmer — Consolidated Fix Specification

## Purpose

Implement the programmer corrections below as **one coherent change**, not a sequence of narrow patches.

The goal is to make the Workout Programmer obey the established model:

> **The Blueprint defines what is valid. The programming engine decides what is useful now. The user decides what is physically/practically executable.**

The implementation must be precise enough to avoid follow-up iterations. Treat every requirement and invariant below as acceptance criteria.

---

# 1. Core Contract

### Blueprint
Defines:
- valid targets;
- valid exercise variations;
- exercise-level prescriptions;
- development-package/reference information;
- target relationships and authored programming metadata.

### Programming engine
Determines:
- what is useful in the current session;
- how valid work is distributed across actual exposures;
- whether recovery permits another direct exposure;
- whether a target is already covered;
- whether another valid variation is better today;
- how goal priority affects selection;
- when a valid variation should be reserved for another exposure;
- how actual completed training changes future programming.

### User
Determines:
- whether equipment is available;
- whether the session can actually be completed;
- whether an exercise must be skipped/substituted in practice.

**Equipment and time are execution constraints, not programming constraints.**

---

# 2. Every Blueprint Variation Is Valid

Hard rule:

> **If an exercise variation exists in the authoritative Blueprint exercise library, it is a valid prescribed variation by definition.**

Therefore:
- package membership must never be an eligibility gate;
- absence from Efficient must not invalidate an exercise that exists in Complete;
- a failed package-level prescription lookup must not reject a Blueprint exercise;
- no valid Blueprint variation may be shown to the user as “No valid prescription”;
- do not fabricate prescriptions;
- when selected, use the exercise's authoritative Blueprint prescription;
- when not selected, classify it as a programming decision, never a prescription-validity failure.

If current code does:

```text
candidate exists
→ package lookup fails
→ candidate rejected as unprescribable
```

remove that behavior for Blueprint exercises.

## Prescription source

For a selected Blueprint exercise:
1. resolve its authoritative exercise-level Blueprint prescription;
2. use its authored per-session set prescription/cap;
3. use its authored rep range;
4. use its authored RIR range.

Do not derive an invented prescription merely because a package reference exists.

If the Blueprint record itself is malformed/missing required prescription data, treat that as a **data-integrity problem**, not as an ordinary “skipped muscle” reason.

---

# 3. Never Inflate Exercise Sets

Hard rule:

> **Target/package volume is an allocation/reference objective. Exercise prescription is exercise-specific. The former must never inflate the latter.**

Example:

```text
Hip Abduction authored prescription = 2 sets/session
target remaining volume = 8 sets
```

Correct:

```text
Hip Abduction ≤ 2 sets in this session
```

Incorrect:

```text
Hip Abduction = 8 sets
```

because 8 sets remain.

The generic invariant is:

```text
generated_sets <= authoritative_per_session_sets
```

for every generated Blueprint exercise.

Do not add an exercise-specific special case such as `if exercise == hip-abduction`.

If more target volume remains:
- select other legitimate Blueprint variations where appropriate;
- distribute work across valid exposures;
- if the remaining reference cannot be delivered without violating authored exercise caps or exposure-cycle rules, do **not** cram it into one exercise.

---

# 4. Audit Package-Reference Semantics

Trace the complete path:

```text
Blueprint development package
→ developmentReferenceEngine
→ volumeEngine
→ target allocation
→ exercise construction
```

The current architecture appears to calculate a package reference from the sum of package exercise sets × package frequency. That can be valid as a **package-level development reference**, but it must not automatically become the full direct-set requirement for every individual target represented in that package.

Determine exactly where package-level values become target-level values.

Preserve the Blueprint's intended meaning and explicitly distinguish:
- package-level development reference;
- target-level volume objective/reference;
- exercise-level per-session prescription;
- actual completed exposure.

Hard invariant:

> A package total must not be assigned in full to every target in the package unless the data model explicitly defines that meaning.

Do not fix this by introducing a new universal hardcoded volume rule.

---

# 5. Session/Exposure-Cycle Model — Not Calendar-Week Debt

The calendar week is a reporting/display boundary, **not** a mandatory programming reset.

Frequency must be interpreted through actual appropriate target-training exposures.

Example:

```text
Blueprint frequency = 2 exposures
user has one compatible leg session in week 1
user has one compatible leg session in week 2
```

Correct:

```text
Week 1 leg session → exposure 1
Week 2 leg session → exposure 2
```

Incorrect:

```text
Week 1 one leg session
→ cram exposure 1 + exposure 2 into that session
```

Do not:
- double a session because a calendar week contains fewer opportunities;
- accumulate missed-set debt;
- force repayment of “missing” sets the following week;
- reset exposure state solely because the calendar week changed.

Actual completed training is the state.

If an intended exposure did not occur, the next appropriate target-training session can provide that exposure.

---

# 6. Actual Training Drives Future Programming

Completed logged work is authoritative evidence of actual exposure.

Future reconciliation must use:
- actual completed exercises;
- actual completed sets;
- actual dates/exposures;
- actual goal-linked work.

Do not use an old generated prescription as though it were completed training.

Completed/locked sessions must not be rewritten by ordinary regeneration.

Use the application's existing canonical reconciliation/generation path. Do not create a second ad-hoc regeneration system.

---

# 7. Remove Time Filtering From Normal Generation

Hard rule:

> **Session time availability must have zero effect on normal program generation.**

Therefore:
- do not use `fitToTimeBudget` to remove generated exercises;
- do not drop exercises because estimated duration exceeds available minutes;
- do not reduce target allocation because of time;
- do not rank candidates down because of time;
- do not create “dropped by time-fitting” skip records;
- do not use time as candidate eligibility.

Estimated time may remain informational in the UI, but it must not alter:
- candidate eligibility;
- target allocation;
- exercise selection;
- exercise count;
- exercise set count;
- generated program contents.

Audit the **entire** generation path for time-based filtering, not only `fitToTimeBudget`.

---

# 8. Remove Equipment Filtering From Normal Generation

Hard rule:

> **Equipment availability must have zero effect on normal program generation.**

Therefore:
- no equipment-based candidate exclusion;
- no equipment-based ranking penalty;
- no equipment-based replacement;
- no equipment-based target allocation change;
- no equipment-based exercise removal.

The user will manually skip/substitute when executing the workout.

The existing equipment filtering for a **user-driven substitution endpoint/workflow** may remain. Do not remove substitution functionality merely because generation no longer filters equipment.

Audit all generation-stage paths for equipment checks.

---

# 9. Remove Misleading “No Prescription” Paths

The current friendly-explanation layer has a generic fallback equivalent to:

```text
We don't have a confidently prescribable exercise for X right now...
```

This is unsafe because unrelated internal skip reasons can fall through to it.

After this change:
- valid Blueprint exercises must never be described as unprescribable;
- normal programming exclusions must map to concrete programming explanations;
- unknown/unhandled engine reasons should be treated as developer/data-quality issues rather than silently mapped to “No valid prescription”.

There should be **no normal user-facing category called “No valid prescription” for a Blueprint variation.**

---

# 10. User-Facing Explanations

The UI should answer:

> **Why wasn't this included today?**

Avoid bare labels such as:
- “No valid prescription”
- “Not recovered”
- “Maintenance”
- “Adequately exposed”
- “Skipped”
- “No eligible method”

Instead, use actual structured facts.

### Recovery

Prefer:

> “This muscle was trained directly on September 7, so there isn't enough recovery for another direct session today.”

Only mention the date when the engine actually knows it.

### Existing coverage

Prefer:

> “This target is already covered today by Back Squats and Leg Extensions, so another direct quad exercise isn't needed in this session.”

Only name exercises that actually contributed the relevant coverage.

### Better valid option

> “A different valid variation was selected because it provides the better fit for today's programming objective. This variation remains available for another session.”

### Future exposure

> “This variation is valid, but it isn't needed in this exposure. A different variation was selected for today's target coverage; this one remains available for a later exposure.”

### Not today's exposure

> “This target is not part of today's exposure cycle. It will be considered at the next appropriate target-training session.”

Only promise the next session when the engine can establish that.

## Structured reasoning

Do not make the UI infer reasons from vague strings.

Where necessary, expose structured fields such as:

```text
reason_code
scope
target
target_id
exercise_id
last_direct_exposure_date
current_session_coverage
covering_exercises
next_expected_exposure
selected_alternative
goal_context
```

Exact schema may follow the existing architecture, but the rule is mandatory:

> **Friendly explanations must be generated from structured engine facts, never guessed.**

---

# 11. “Not Today” vs “Cannot Be Programmed”

The system must distinguish:

### Valid but not selected today
Reasons may include:
- current coverage;
- better variation selected;
- recovery;
- exposure-cycle scheduling;
- goal/priority allocation;
- redundancy;
- future exposure.

### Genuine data/integrity problem
The Blueprint itself is malformed/missing required data.

These must not share the same user-facing category.

A valid Blueprint variation can be excluded from today's workout without becoming invalid.

---

# 12. Skip/Exclusion Scope

Audit how `weekLevelSkips` and `sessionSkipped` are combined.

The current architecture appears to do:

```text
skipped = [...weekLevelSkips, ...sessionSkipped]
```

which can repeat a global/week-level decision on every session.

Correct this so that:
- global/exposure-level decisions are not presented as independent daily discoveries;
- session-specific exclusions remain associated with their session;
- equivalent facts are deduplicated;
- scope is explicit;
- a target is not shown as both programmed and unprescribable because of unrelated skip records.

The UI may choose the presentation, but the underlying data must be semantically correct.

---

# 13. Preserve Direct/Indirect Coverage Rules

Keep the established direct/indirect exposure methodology.

If a compound exercise meaningfully provides secondary exposure, that can affect whether another direct exercise is necessary.

But:
- secondary exposure must use the existing authoritative rules;
- it must never be used to claim an exercise is invalid;
- it must never create an invented prescription;
- explanations should identify actual covering exercises where available.

---

# 14. Goals and Specialization

Preserve the established goal behavior:
- active goals receive priority/development emphasis;
- overall physique is maintained;
- goal allocations guide programming rather than becoming rigid exercise quotas;
- goal-linked allocations cannot override exercise-level Blueprint set caps;
- actual training exposure drives future goal programming;
- goal phases are development roadmaps, not endless weekly quotas.

Do not introduce universal hardcoded volume merely to satisfy one scenario.

---

# 15. Generation Invariants

These must hold globally.

### A — Blueprint validity

```text
Blueprint exercise exists
=> valid candidate
```

Package absence does not invalidate it.

### B — Exercise prescription

```text
generated_sets <= authored_per_session_sets
```

for every selected Blueprint exercise.

### C — No execution filtering

```text
equipment availability has no effect on generation
time availability has no effect on generation
```

### D — No calendar compression

Frequency does not force multiple intended exposures into one session because of a calendar boundary.

### E — No debt

Missed sessions do not create accumulating set debt.

### F — Actual exposure

Completed logged work drives future exposure decisions.

### G — Explanation correctness

Every normal exclusion has a truthful programming reason.

No valid Blueprint exercise can fall through to “No valid prescription”.

### H — No contradiction

An exercise/target cannot be both successfully programmed today and shown as unprescribable today because of different internal records.

---

# 16. Required Regression Tests

Add deterministic tests for all cases below.

## Test 1 — Hip Abduction cap

Given:

```text
Hip Abduction = 2 authored sets/session
```

Assert:

```text
generated Hip Abduction <= 2 sets/session
```

even if target remaining volume is 8 or more.

## Test 2 — Generic authored-cap invariant

Across generated programs:

```text
for every Blueprint exercise:
    generated sets <= authored per-session sets
```

This must be generic, not exercise-specific.

## Test 3 — Frequency across actual exposures

Scenario:
- frequency = 2;
- only one compatible target-training session in calendar week 1;
- another compatible session in calendar week 2.

Assert:
- week 1 receives one exposure;
- week 2 receives the next;
- week 1 does not receive double exposure;
- no set debt is created.

## Test 4 — Time cannot remove exercises

Use an extremely small/zero time budget.

Assert:
- programming output remains unaffected;
- no exercise is dropped;
- no time-fitting skip is created.

## Test 5 — Equipment cannot remove exercises

Use a session with no available equipment.

Assert:
- normal generation still selects exercises according to programming;
- equipment does not change candidate eligibility or exercise selection.

Keep substitution filtering separately tested where applicable.

## Test 6 — Package absence does not invalidate Blueprint variation

Example:
- a rear-delt variation exists in Complete but not Efficient.

Assert:
- it remains a valid candidate;
- absence from Efficient does not create “no prescription”;
- if not selected, it has a programming reason.

## Test 7 — Genuine Blueprint data gap

Create a deliberately malformed fixture with missing authoritative prescription data.

Assert:
- it is identified as data integrity failure;
- it is not converted into an ordinary programming skip;
- it cannot misleadingly classify a valid Blueprint variation as unprescribable.

## Test 8 — Recovery explanation

Given a known previous direct exposure date, assert:
- the explanation contains that actual date;
- no fabricated date is possible.

## Test 9 — Coverage explanation

Given actual coverage by named exercises, assert:
- explanation identifies the actual covering exercise(s);
- it does not merely say “adequately exposed”.

## Test 10 — Valid but unselected variation

Given two valid Blueprint variations where one is selected:
- the other remains a valid candidate;
- its reason is programming-based;
- it is not classified as unprescribable.

## Test 11 — Global skip deduplication

Given a week/exposure-level exclusion:
- it is not repeated as separate daily skips;
- its scope remains identifiable.

## Test 12 — No contradictory state

Assert that no generated session contains an exercise/target that is simultaneously:
- included in the workout;
- shown as unprescribable.

---

# 17. Required Code Audit

Before editing, trace the full flow:

```text
Blueprint snapshot
→ development packages
→ exercise prescription resolution
→ development reference
→ volume recommendation/allocation
→ goal allocation
→ exposure/recovery state
→ candidate selection/ranking
→ exercise construction
→ time/equipment filtering
→ skip/exclusion creation
→ friendly explanation
→ API response
→ UI rendering
```

Search the repository for all occurrences/equivalents of:

```text
fitToTimeBudget
time-fitting
equipment
equipment availability
prescription
developmentReference
development package
package membership
recommended_weekly
starting_point_sets
weekLevelSkips
sessionSkipped
skipped
friendlyExplanation
No valid prescription
not prescribable
adequately exposed
not recovered
maintenance
reconcile
ensureWeekProgramGenerated
```

Do not assume the currently known functions are the only paths.

---

# 18. Preserve Existing Architecture

Do not rewrite unrelated systems.

Preserve:
- Blueprint snapshot architecture;
- goals;
- actual workout logging;
- canonical reconciliation;
- substitution workflow;
- session notes;
- copy functionality;
- existing friendly explanation framework where useful;
- established direct/indirect exposure rules unless explicitly corrected above.

Do not:
- add an AI/LLM dependency;
- introduce exercise-specific hardcoded caps;
- create a second generation system;
- use package membership as a candidate gate.

---

# 19. Production/Data Safety

Before changing production programming:

1. Back up the actual production SQLite database.
2. Determine the DB path from the running service/configuration; do not assume an obsolete runbook path.
3. Preserve all completed/locked sessions.
4. Preserve historical logs.
5. Preserve goals and goal progress.
6. Regenerate only unlocked/future programming through canonical reconciliation.
7. Verify the resulting program and history.
8. Do not use ad-hoc raw SQL to reconstruct or regenerate workouts.

If a session is completed/locked, changing programmer logic must not rewrite it.

---

# 20. Deployment Rules

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

Deployment must use the GitHub repository on the Oracle VM.

**Do not access or copy from the user's Windows local repository for deployment.**

Never use `D:\workout-logger` or another Windows checkout as the deployment source.

Required flow:

```text
GitHub main
→ Oracle VM checkout
→ install/build/test
→ backup DB
→ deploy
→ verify service/application
```

Do not run `npm run sync-blueprint` during ordinary deployment unless the change explicitly requires changing the Blueprint snapshot.

---

# 21. Verification Before Success

Do not declare success after only targeted tests.

Run:
1. full test suite;
2. typecheck;
3. production build;
4. existing verification command(s);
5. all targeted regression tests above;
6. database integrity checks;
7. service health check;
8. HTTP/application health check;
9. verify completed/locked history is unchanged;
10. inspect at least one newly generated future session.

The inspected future session must confirm:
- no time-based omissions;
- no equipment-based omissions;
- no exercise exceeds authored Blueprint sets;
- no valid Blueprint variation is described as “No valid prescription”;
- exposure-cycle behavior is sensible;
- exclusion explanations are concrete.

If a test fails, fix the underlying model. Do not weaken a meaningful invariant merely to get green tests.

---

# 22. One-Pass Implementation Requirement

Do not implement this as:

```text
fix visible symptom
→ deploy
→ wait for screenshot
→ discover next symptom
→ patch
```

Instead:

```text
1. Audit the complete flow.
2. Identify all violations of this specification.
3. Implement the coherent model.
4. Add regression tests for every invariant.
5. Run the complete suite.
6. Inspect generated output.
7. Fix any remaining model-level inconsistency.
8. Only then deploy.
```

Proactively test edge cases likely to expose the same bug class.

In particular:
- do not merely make Hip Abduction show 2 sets; verify the generic authored-cap invariant;
- do not merely remove one time-fitting call; audit every generation-stage time exclusion;
- do not merely remove one equipment filter; audit eligibility, ranking, allocation, and post-processing;
- do not merely replace one string; ensure no valid Blueprint exercise can reach the unprescribable semantic state;
- do not merely patch one package; verify package-level vs target-level semantics globally.

---

# 23. Final Programming Principle

The final system must enforce this hierarchy:

```text
BLUEPRINT
What is valid?
        ↓
PROGRAMMING ENGINE
What is useful now,
given goals, exposure, recovery,
coverage, redundancy, and the
current development cycle?
        ↓
GENERATED PROGRAM
The prescription for the session.
        ↓
USER
What can I physically/practically execute?
```

The governing rule is:

> **Results are the only thing that should dictate inclusion or exclusion during programming.**

Therefore:
- equipment is not a programming exclusion;
- time is not a programming exclusion;
- absence from one development package is not invalidity;
- a valid exercise not selected today is not a prescription failure;
- a missed calendar-week exposure is not debt;
- an authored exercise prescription cannot be inflated to satisfy a target-volume number.

The implementation must make these distinctions explicit in code, tests, and user-facing explanations.
