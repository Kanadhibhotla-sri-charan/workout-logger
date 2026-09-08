# Final Fixes — Copy Performed Variations + Explanation Accuracy

## Objective

Apply the final corrections identified during review of the current implementation.

The broader feature implementation is **already directionally correct** and should be preserved:

- Equipment filtering has been removed from initial program generation.
- Equipment information remains available where useful, especially for substitutions.
- Session notes are persisted at the session level.
- A completed-workout Copy button exists.
- User-facing programming explanations have been separated from internal programming diagnostics.

**Do not rewrite these features from scratch. Fix only the issues below.**

---

# 1. Fix Copy Output for Real Persisted Substitutions

## Problem

The current copy formatter can depend on the current generated program when resolving the human-readable name of a performed exercise.

That is unsafe for substitutions.

Example:

### Original generated program

```text
Cable Pushdown
```

### User actually performs

```text
Cable Pushdown — Rope
```

The performed exercise is persisted under the substitute exercise's ID.

After a page reload, the temporary frontend substitution map may no longer exist.

The Copy function must still be able to produce the correct performed exercise name/variation from persisted data.

## Required behavior

The copied workout must represent **what the user actually performed**, not merely what was originally prescribed.

The human-readable performed exercise/variation must be resolvable after:

- page refresh
- reopening the completed workout
- navigating away and back
- application restart

Do NOT depend on transient frontend state such as an in-memory substitution Map.

## Required implementation

Inspect the existing completed-workout rendering path and the persisted performed-exercise data.

Use the same reliable identity-resolution mechanism already used by the completed workout UI where possible.

The preferred flow is conceptually:

```text
performed exercise ID
        ↓
persisted Blueprint exercise definition / reliable exercise lookup
        ↓
human-readable performed exercise name
        ↓
copy output
```

If the application already persists a performed-exercise name/variation explicitly, use that authoritative value.

If it stores only the exercise ID, resolve the ID through the Blueprint exercise library.

The generated program may be used as contextual fallback, but it must NOT be the only way to resolve a performed substitute.

## Important

Do not solve this by adding the substitute to the generated program.

The program should continue representing the prescribed program.

The completed workout should represent what was actually performed.

---

# 2. Add a Real Regression Test for Persisted Substitution

The existing copy test is not sufficient if it places the substituted exercise directly into `generated.exercises`.

Create a regression test that models the real situation:

```text
Generated program:
    original prescribed exercise

Persisted performed workout:
    substituted exercise ID

Current frontend substitution state:
    absent / empty

Expected copied text:
    human-readable substituted exercise name
```

For example:

```text
Generated:
    Cable Pushdown

Performed:
    Cable Pushdown — Rope
```

Then assert that the copied text contains the performed variation/name.

The test should continue to pass after a simulated reload where transient substitution state is unavailable.

## Do not weaken the test

Do NOT make the test pass by:

- adding the substitute to `generated.exercises`
- injecting a temporary substitution map
- changing the expected output to an internal ID

The purpose of the regression test is specifically to prove that persisted performed data is sufficient.

---

# 3. Keep Copy Output Focused on the Performed Workout

The Copy feature does NOT need to copy every piece of metadata visible on the completed workout screen.

The intended output is a clean manual logging format for transfer into the food-tracker.

Include:

- workout/day/date
- every performed exercise
- performed variation/name
- performed set information already shown in the completed workout
- session note, when present

Do NOT include:

- database IDs
- target IDs
- Blueprint IDs
- gate information
- internal programming reasoning
- JSON
- developer metadata

The existing compact plain-text format is acceptable.

Do not unnecessarily expand it into a dump of every UI field.

---

# 4. Verify Session Note Inclusion

The copied text should include the day's session note when one exists.

Example:

```text
Workout — Tuesday, Sep 8

Hammer Curl — 2 sets: 20×10, 20×8
Cable Pushdown — Rope — 3 sets: 25×12, 25×11, 25×10

Session note: Used rope for pushdowns and EZ bar for curls.
```

If there is no note, do not output an empty `Session note:` line.

Avoid duplicating the same information if it is already represented as part of the performed exercise variation.

---

# 5. Verify Human-Friendly Explanation Exposure

Keep the existing `friendlyExplanation` separation.

Do not remove the detailed internal reasoning used for debugging/program verification.

The normal UI should show only the friendly explanation.

## Required style

Prefer:

> **Added for your arm-thickness goal.** Hammer curls primarily train the brachialis, helping build upper-arm thickness. You had 2 sets for this target so far this week, so this session adds another 2 sets.

or:

> **Added for your arm-thickness goal.** You haven't trained this target yet this week, so it was prioritized today.

For normal-development work:

> **Added for overall physique development.** This helps develop your quads, which are not currently an active goal but still need regular development for balanced physique development.

For secondary/indirect contribution:

> **Supports your arm development.** This movement also trains the triceps, adding useful additional work.

## Never expose normal users to:

```text
physique_target
decisive gate
gate1
gate2
gate3
gate4
Surgical Fix Pass
section numbers
session-by-session
not divided evenly
internal IDs
database IDs
raw JSON
development-package implementation terminology
```

---

# 6. Verify Weekly Exposure Means Actual Training Exposure

Before finalizing the friendly explanation that says:

> "You had X sets for this target so far this week."

Trace the source of:

```text
decision.weekly_exposure.primary_sets
```

Confirm whether it represents:

- actual performed/completed exposure,
- planned exposure,
- or a defined combination.

Do not guess.

If it represents actual training exposure, the current wording is appropriate.

If it represents planned rather than actual exposure, change the wording so the UI does not falsely tell the user they performed sets they only had programmed.

For example:

### Actual exposure

> You had 4 sets for this target so far this week.

### Planned exposure

> You already have 4 sets planned for this target this week.

Use the terminology that accurately reflects the underlying data.

---

# 7. Use the Best Available Human-Readable Goal Name

Inspect the existing goal model/data.

If the active goal already has a human-readable title/name, use that in the friendly explanation.

Prefer:

> **Added for your Arm Side Thickness goal.**

over:

> Added for your arm side thickness goal.

Do not expose raw target slugs such as:

```text
arm-side-thickness
brachialis-arm-thickness
triceps-back-depth
```

unless there is genuinely no human-readable goal representation available.

If only a target slug exists, the current humanization fallback is acceptable.

Do not introduce a new goal naming system solely for this fix.

---

# 8. Preserve the Equipment Decision

Do NOT undo the previously implemented removal of equipment filtering from program generation.

The intended architecture remains:

```text
Full Blueprint exercise library
        ↓
target/muscle relevance
        ↓
programming rules
        ↓
exercise selection
        ↓
prescription resolution
```

NOT:

```text
Blueprint exercises
        ↓
equipment feasibility filter
        ↓
candidate pool
```

Equipment availability may still be used for:

- substitutions
- displaying information
- future tooling

but must not eliminate otherwise valid Blueprint candidates during initial program generation.

---

# 9. Do Not Change the Core Programming Model

Preserve all previously established behavior:

- Efficient/Complete packages are development-volume references only.
- Package membership is not an exercise eligibility gate.
- Full Blueprint exercise library is the candidate universe.
- Exercise prescription is resolved separately.
- Goal-linked targets receive specialization/development priority.
- Non-goal targets continue receiving normal development.
- Direct/indirect exposure logic remains intact.
- Rolling exposure/recovery logic remains intact.
- Goal phases/reviews remain intact.
- Actual training continues feeding back into programming.
- No AI/LLM dependency is introduced.

This task is a final correction pass, not a redesign.

---

# 10. Tests Required

At minimum, ensure the following tests exist and pass.

## Copy

- [ ] Copy formatter includes all performed exercises.
- [ ] Copy formatter uses performed exercise identity.
- [ ] Real persisted substitution case works without transient substitution state.
- [ ] Session note is included when present.
- [ ] Empty session note is omitted.
- [ ] No internal IDs/debug data are included.

## Explanations

- [ ] Goal explanation is human-readable.
- [ ] Normal-development explanation is human-readable.
- [ ] Indirect-support explanation is human-readable.
- [ ] Internal gate terminology is not exposed.
- [ ] Weekly-exposure wording matches the actual meaning of the underlying data.
- [ ] Human-readable goal title is used when available.

## Equipment

- [ ] Valid Blueprint exercises remain selectable without equipment filtering.
- [ ] Existing substitution behavior remains functional.

## Existing regression coverage

- [ ] Rear-delt package-gating regression remains passing.
- [ ] Generic package-membership regression remains passing.
- [ ] Existing 11 goal-linked stability recalibrations remain conceptually intact.

---

# 11. Verification

Run the project's normal validation suite:

```text
npm ci
npm run typecheck
npm test
npm run build
npm run verify
```

Use the actual project script names if they differ.

Do not report success based solely on static inspection.

Report the actual results:

```text
Typecheck: PASS/FAIL
Tests: X passed / Y failed / Z skipped
Build: PASS/FAIL
Verify: PASS/FAIL
```

Also perform a focused test of the persisted substitution copy case.

---

# 12. Production Safety

This is a code/UI/test fix.

Do NOT:

- reset the database
- delete workout history
- recreate the database
- alter historical workouts
- alter goals
- modify Blueprint package contents
- regenerate production workouts
- modify systemd/nginx configuration
- introduce an AI/LLM dependency

If a code change requires a database migration for an existing feature, use only a safe additive migration and preserve all existing data.

---

# Final Report

Provide:

## Copy Fix
- exact cause of the persisted-substitution problem
- how performed exercise identity is now resolved
- example of copied output

## Tests
- persisted substitution regression test
- session-note copy test
- explanation tests
- full test results

## Explanation Fix
- confirm weekly exposure semantics
- confirm human-readable goal naming
- provide 2–3 before/after examples

## Equipment
- confirm program-generation equipment filtering remains removed
- confirm substitution equipment filtering remains available if applicable

## Safety
Confirm no database reset, historical data modification, goal modification, Blueprint package modification, or AI/LLM dependency.
