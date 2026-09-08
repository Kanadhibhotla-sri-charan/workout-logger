# Fix: Blueprint Exercise Candidate Selection Must Not Be Gated by Development Packages

## Objective

Fix the workout-programming candidate-selection bug where valid Blueprint exercises can be rejected because they are not members of an `Efficient` or `Complete` development package, or because the package does not contain the expected rep/RIR prescription.

The programmer must treat Blueprint development packages as **development-volume/reference data only**. They must not function as exercise menus, exercise eligibility lists, or prescription-existence gates.

The full Blueprint exercise library must remain the source of truth for which exercises are available to the programmer.

---

## Non-Negotiable Rules

### 1. Efficient / Complete packages are NOT exercise menus

The `Efficient` and `Complete` development references answer:

> How much development volume/coverage should be programmed for a target?

They do **not** answer:

> Which exercises may be selected?

Do not copy exercises from these packages into the generated workout merely because they appear there.

Do not require an exercise to belong to either package before it can be selected.

### 2. Full Blueprint exercise library determines exercise eligibility

For a programming target such as rear delts, candidate discovery must search the full Blueprint exercise library and then apply the actual programming constraints, including as applicable:

- target/muscle relevance
- exercise role
- equipment feasibility
- movement/variation requirements
- user constraints
- recovery/context
- session/day requirements
- any other legitimate deterministic programming rules

A valid Blueprint exercise must not be discarded solely because it is absent from an Efficient/Complete package.

### 3. Package membership must never be a prescription-existence gate

Do NOT implement logic equivalent to:

```text
exercise must be in Efficient/Complete package
    -> otherwise no candidate
```

or:

```text
exercise must have a package-listed rep/RIR prescription
    -> otherwise no candidate
```

That interpretation is incorrect.

An exercise can be a valid Blueprint exercise even when it is not listed in a development package.

### 4. Separate exercise selection from training prescription

These are two different decisions:

**Exercise selection**
- Which Blueprint exercise is appropriate?

**Training prescription**
- How should that selected exercise be trained?

The development package provides the development-volume reference, not the exercise menu.

When a selected exercise needs a prescription, first resolve the prescription from the exercise's own valid Blueprint definition or another explicitly valid Blueprint prescription source.

If no valid prescription exists anywhere in the Blueprint data, treat that as a **data-quality gap** and surface it clearly.

Do NOT manufacture arbitrary rep/RIR values merely to make the candidate pass.

Do NOT use absence from a development package as proof that the exercise has no prescription.

### 5. Do not "fix" this by adding exercises to packages

Do not add rear-delt rows, rear-delt flies, or other exercises to Efficient/Complete packages simply to make the programmer select them.

That would corrupt the meaning of the package data.

The fix belongs in candidate discovery/eligibility/prescription resolution.

### 6. Keep the programmer deterministic

Do not introduce an AI/LLM dependency.

The desired behavior must be implemented through deterministic rules over:

```text
Blueprint knowledge
        ↓
candidate discovery
        ↓
eligibility filtering
        ↓
exercise selection
        ↓
prescription resolution
        ↓
session design
        ↓
actual-training feedback
```

---

# Implementation Requirements

## A. Trace the complete candidate-selection path

Find the code responsible for generating exercise candidates for a target and trace it through:

1. Blueprint exercise lookup
2. target/muscle matching
3. package lookup
4. prescription lookup
5. equipment filtering
6. candidate rejection
7. final exercise selection

Identify every place where Efficient/Complete package membership is being used as an eligibility condition.

Remove that dependency from eligibility.

### Important

Do not only patch the rear-delt branch.

Search for the underlying generic rule so the same defect cannot affect:

- rear delts
- side delts
- biceps
- triceps
- quads
- hamstrings
- glutes
- calves
- forearms
- traps
- back
- chest
- any other Blueprint target

The architectural rule must be generic.

---

## B. Preserve package usage for volume/development calculation

The fix must NOT remove package usage altogether.

Packages still matter for determining development-volume/reference requirements.

Maintain the distinction:

```text
Development package
    → development-volume/reference requirement

Full Blueprint exercise library
    → candidate exercise universe

Programming constraints/context
    → candidate eligibility

Exercise-level Blueprint prescription
    → sets/reps/RIR/training instructions
```

The implementation must preserve the existing goal/non-goal development logic.

In particular:

- goal-linked targets continue to use the intended Complete/development reference
- non-goal targets continue to use the intended Efficient/development reference
- package values remain programming objectives/reference points
- package values must not become rigid exercise quotas or exact generated exercise lists

---

## C. Fix prescription resolution

Inspect the current code that produces errors/messages equivalent to:

> no equipment-feasible candidates have a Blueprint development-package rep/RIR prescription

or any equivalent condition.

Determine why a candidate is being considered invalid merely because its package entry is missing.

Change the flow so that:

1. Candidate is discovered from the full Blueprint exercise library.
2. Candidate is checked for legitimate exercise eligibility.
3. Candidate's own Blueprint prescription is resolved where available.
4. Package data is used for development-volume/reference calculations, not candidate existence.
5. Only a genuine absence of any valid prescription should produce a prescription/data-gap failure.

Do not silently invent a prescription.

---

## D. Rear-delt regression coverage

Add explicit regression tests for the original failure mode.

The test data/setup should represent a rear-delt target where:

- the Blueprint contains valid rear-delt exercises such as rear-delt rows and/or rear-delt flies
- the exercise is NOT present in the relevant Efficient/Complete development package
- the exercise has a valid exercise-level Blueprint prescription
- the equipment constraints allow the exercise

Expected result:

**The exercise remains an eligible candidate.**

It must not be rejected merely because it is absent from the package.

Add at least one test for:

- rear-delt row
- rear-delt fly

where practical based on the actual Blueprint snapshot.

---

## E. Generic package-gating regression test

Add a regression test proving the rule is generic rather than rear-delt-specific.

Construct a candidate that:

- exists in the full Blueprint exercise library
- is valid for its target
- satisfies equipment/other constraints
- is absent from the Efficient/Complete package
- has a valid exercise-level prescription

Expected result:

```text
eligible === true
```

The test should fail if package membership becomes an eligibility gate again.

---

## F. Negative test: genuine prescription gap

Add/retain a test demonstrating the opposite case.

If an exercise:

- exists in the Blueprint
- is otherwise eligible
- but has no valid prescription in any supported Blueprint prescription source

then the system should:

- reject it for the legitimate reason that it cannot be safely/programmatically prescribed, OR
- surface the explicit data-quality gap according to the existing error-handling design

It must NOT:

- invent arbitrary rep/RIR values
- incorrectly claim the exercise is invalid because it is absent from Efficient/Complete
- silently add the exercise to a development package

This confirms that prescription validation still exists, but is independent of package membership.

---

# Search / Audit Requirements

Before changing code, search the repository for logic involving concepts such as:

```text
Efficient
Complete
development package
package prescription
rep/RIR
prescription
candidate
eligibility
exercise candidates
Blueprint package
package membership
```

Also search for direct checks comparing an exercise ID/name against package exercise lists.

Look for patterns equivalent to:

```ts
packageExercises.includes(exercise)
```

```ts
if (!packagePrescription) rejectCandidate()
```

```ts
if (!efficientPackage.has(exercise)) ...
```

```ts
if (!completePackage.has(exercise)) ...
```

The exact implementation may use different names, so audit semantically rather than relying only on these strings.

Document the actual offending rule in the implementation notes.

---

# Do Not Change These Behaviors

Do not change unrelated programming behavior.

Specifically preserve:

- active-goal prioritization
- maximum active-goal rules
- Complete vs Efficient development-volume intent
- direct/indirect exposure accounting
- rolling exposure/recovery adaptation
- actual-training feedback
- goal phases/reviews
- session/day constraints
- equipment constraints
- user exercise constraints
- existing workout history
- existing database contents

This task is a candidate-selection/data-interpretation fix.

---

# Verification

Run the repository's normal validation suite after implementation.

At minimum, run the existing commands used by the project for:

1. Type checking
2. Unit/integration tests
3. Production build
4. Any existing Blueprint/programming verification scripts

The final report must include:

- number of tests before/after if available
- number passed
- number failed
- number skipped
- exact failing tests, if any
- confirmation that the rear-delt regression tests pass
- confirmation that package membership is no longer an eligibility gate

Also perform a focused manual/code-level verification showing the final candidate-selection flow.

---

# Acceptance Criteria

The fix is complete only when ALL of the following are true:

- [ ] Efficient/Complete packages are used only as development-volume/reference data.
- [ ] Efficient/Complete package membership is not required for exercise eligibility.
- [ ] Full Blueprint exercise library is used to discover exercise candidates.
- [ ] A valid rear-delt exercise in the Blueprint can be selected even if it is absent from a development package.
- [ ] Rear-delt row regression test passes.
- [ ] Rear-delt fly regression test passes where supported by the Blueprint snapshot.
- [ ] A generic non-rear-delt regression test proves package membership is not an eligibility gate.
- [ ] Exercise-level Blueprint prescription resolution remains intact.
- [ ] A genuine absence of prescription is still surfaced as a data-quality/programming issue.
- [ ] No arbitrary rep/RIR prescription is fabricated.
- [ ] No exercises are added to Efficient/Complete packages merely to solve the bug.
- [ ] Goal/non-goal volume-reference behavior remains unchanged.
- [ ] Direct/indirect exposure behavior remains unchanged.
- [ ] Rolling exposure/recovery adaptation remains unchanged.
- [ ] Existing tests continue to pass.
- [ ] No AI/LLM dependency is introduced.
- [ ] No production database reset or destructive migration is performed.

---

# Production Safety

This task is code-only unless a separate deployment instruction is explicitly given.

Do NOT:

- reset the SQLite database
- delete workout history
- recreate the database
- modify production workout records
- modify user goals
- regenerate the production week automatically
- add package entries just to bypass the bug
- alter nginx/systemd configuration

After implementation, report the code changes and test results.

Deployment should happen separately using the project's established GitHub → production deployment process.

---

# Final Report Required

When finished, provide:

## Root Cause

A concise explanation of the exact rule that incorrectly rejected valid Blueprint exercises.

## Code Changes

List the files/functions changed and explain the new candidate-selection flow.

## Prescription Resolution

Explain where the exercise-level prescription now comes from and how a genuine prescription gap is handled.

## Tests

List the new/updated regression tests, especially the rear-delt tests.

## Verification

Report typecheck, test, build, and any relevant programming verification results.

## Safety

Confirm:

- no database reset
- no production data modification
- no package contamination
- no AI/LLM dependency added
