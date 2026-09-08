# Workout Programmer — Remove Equipment Filtering + Session Notes + Copyable Daily Log + Human-Friendly Explanations

## Objective

Make four related improvements to the workout programmer:

1. **Remove equipment-feasibility filtering from program generation.**
2. Add a small **session note/comment box for every day's session**.
3. Add a **Copy** button to completed day's performed-workout/variation table so the entire day's log can be copied as plain text for manual entry into the food-tracker workflow.
4. Replace internal/developer-oriented programming explanations with **short, human-understandable explanations**.

These changes must preserve the existing deterministic programming architecture and the Step 12 goal-focused programming behavior.

---

# 1. Remove Equipment Feasibility Filtering From Program Generation

## Decision

The programmer should **not filter Blueprint exercises out of the candidate pool based on equipment availability/reachability while generating the program.**

The user will handle occasional equipment unavailability manually by substituting the exercise.

The Blueprint is already expected to contain exercises that are generally reachable for this user, and even if an occasional exercise is unavailable, it is preferable to expose a good programming variation rather than have the candidate-selection system discard it prematurely.

## Required behavior

Candidate generation should work approximately as:

```text
Full Blueprint exercise library
        ↓
target / muscle relevance
        ↓
legitimate programming constraints
        ↓
exercise selection
        ↓
prescription resolution
```

It should NOT be:

```text
Full Blueprint exercise library
        ↓
equipment feasibility filter
        ↓
candidate pool
        ↓
exercise selection
```

## Important scope

Remove equipment feasibility as a **candidate-elimination rule during program generation**.

Do NOT remove unrelated equipment information from the application if it is useful elsewhere.

For example, equipment information may still be retained for:

- displaying exercise information
- future substitution tooling
- user reference
- logging
- analytics

The specific requirement is:

> **Equipment availability must not cause an otherwise valid Blueprint exercise to be omitted from the generated program.**

## Do not replace it with another hidden equipment gate

After removing the obvious equipment filter, audit the entire candidate-selection path for equivalent logic such as:

```text
equipment feasible
equipment reachable
available equipment
user equipment
equipment compatibility
equipment constraints
machine availability
```

If any such condition rejects an otherwise valid candidate during program generation, remove that rejection behavior.

Do not simply rename the same filter.

## Preserve exercise quality filtering

Removing equipment filtering does NOT mean removing all candidate-selection intelligence.

Continue applying legitimate programming logic such as:

- target/muscle relevance
- direct vs indirect exposure
- goal priority
- development requirement
- recovery/rolling exposure
- session context
- exercise role
- exercise variation logic
- prescription availability
- other established deterministic programming rules

---

# 2. Session Notes / Comments UI

## Goal

Each day's session should have a small free-text note/comment field.

This is a lightweight personal training note, NOT another programming instruction system.

Examples of useful notes:

```text
Cable pushdown: used rope today.
```

```text
Cable pushdown: used V-bar.
```

```text
Barbell curls: used EZ bar instead of straight bar.
```

```text
Leg press machine was occupied, used the other leg press.
```

```text
Felt stronger than last week.
```

The user should be able to write whatever short note is useful for that day's session.

## UI requirements

For every session/day:

- Show a compact note/comment input.
- Make it visually subordinate to the workout itself.
- Provide an obvious save/update mechanism if the application does not already autosave text fields.
- Preserve the note when navigating away and returning.
- Show the existing note when reopening the session.
- Allow the user to edit or clear it.
- Do not make the note mandatory.

A suitable label could be:

> **Session note**

or:

> **Notes for today**

Placeholder example:

> `e.g. Rope for pushdowns, EZ bar for curls...`

Keep the UI small and unobtrusive.

## Persistence

Persist the note against the specific workout/session/date so that it is not lost when:

- the page is refreshed
- the user leaves and returns
- the week is regenerated/reconciled where the existing session identity is preserved
- the workout is marked completed

Do not store the note only in transient frontend state.

Use the application's existing persistence/API architecture where possible.

## Data-model guidance

Inspect the existing workout/session schema before adding a new table.

Prefer the smallest clean change consistent with the existing architecture.

A session note belongs to the individual session/day, not to:

- the recurring profile
- the Blueprint
- a goal
- the exercise definition

If an appropriate session-level note column already exists, reuse it rather than creating duplicate storage.

If a migration is required, make it additive and non-destructive.

---

# 3. Copy Completed Day's Workout

## Goal

The completed workout screen already shows the performed exercise variations in a table.

Add a **Copy** button above or beside that table.

The purpose is manual transfer into the food-tracker workflow.

## Required behavior

When the user clicks **Copy**:

- copy the entire day's displayed performed-workout information to the clipboard
- use plain text that pastes cleanly into another app
- do not require the user to manually select the table
- show a short success state such as:
  - `Copied`
  - `Copied to clipboard`
- return to the normal button state after a short period

Use the browser Clipboard API where supported.

Handle clipboard failure gracefully with a useful fallback/error message rather than silently doing nothing.

## What should be copied

The copied text should represent the **entire displayed performed workout for that day**, not just one selected exercise.

Include enough context to identify the day, for example:

```text
Workout — Tuesday, 8 Sep 2026

Exercise                  Sets    Reps / Performance
Hammer Curl               2       ...
Chest-Supported Row       3       ...
Lat Pulldown              3       ...
Shrug                     2       ...
EZ-Bar Curl               3       ...
Reverse Wrist Curl        2       ...
Wrist Curl                2       ...
```

However, do NOT invent fields that the existing table does not actually display.

The implementation should generate the copy text from the same underlying data used to render the visible performed-workout table so the two cannot drift apart.

## Important: copy what the user actually performed

If the UI distinguishes prescribed vs performed exercise/variation, the Copy action should prioritize the **performed** data.

For example, if the program said:

```text
Cable Pushdown
```

but the user logged:

```text
Cable Pushdown — Rope
```

the copied result must contain the performed variation (`Rope`) if that is what the completed-workout table displays.

The session note should also be included in the copied text if the note is visible/meaningful on the completed-day view.

Suggested format:

```text
Workout — Tuesday, 8 Sep 2026

[performed workout rows]

Session note: Cable pushdown — used rope. EZ-bar curl — used EZ bar.
```

Do not duplicate the note if it is already represented elsewhere in the copied content.

## Food-tracker compatibility

The copied format should be:

- plain text
- readable
- compact
- predictable
- easy to paste into the food-tracker input

Avoid:

- JSON
- internal database IDs
- developer metadata
- Blueprint IDs
- target IDs
- gate numbers
- raw serialized objects

The copy output is a user-facing handoff format.

---

# 4. Human-Friendly Programming Explanations

## Problem

Current explanations expose internal implementation details such as:

```text
Selected Hammer Curl for physique_target "brachialis-arm-thickness" (primary tier): Blueprint muscle-role for this target is "primary" (direct target); decisive gate: gate3_programming_need. 2 sets on 2026-09-08 (exercise 1 of this target's own real weekly plan) (8 desired weekly, 2 session(s)/week: tuesday, friday — session-by-session, not divided evenly, per Surgical Fix Pass §2/§6). Reps 10-20, RIR 1-3 per Blueprint's development package. First-time prescription — no prior performance of this exact exercise to progress from.
```

This is technically detailed but is not appropriate as the normal user-facing explanation.

The user wants to understand **why the exercise was included**, not how the programmer's internal decision engine is implemented.

## Required style

Explanations should be:

- concise
- human-readable
- useful
- specific to the user's goals
- free of internal implementation terminology

Avoid mentioning:

- `physique_target` IDs
- `gate1`, `gate2`, etc.
- `decisive gate`
- `Surgical Fix Pass`
- section numbers
- internal package names such as `Complete` / `Efficient` unless there is a genuine user-facing reason
- "session-by-session, not divided evenly"
- database IDs
- JSON
- internal ranking terminology
- implementation details
- developer/debug language

## Preferred explanation pattern

The explanation should answer:

1. **Why was this exercise added?**
2. **What muscle does it primarily help develop?**
3. **How does that relate to the user's active goal?**
4. **Was that target already trained this week, and if so, how much?**

For example:

> **Added for your arm-thickness goal.** Hammer curls primarily train the brachialis, which helps build the thickness of your upper arm. You had 2 sets for this target so far this week, so this session adds another 2 sets toward the weekly development target.

Another example:

> **Added for your triceps/back-depth goal.** This exercise primarily trains the triceps, helping build the arm size and depth you're targeting. You haven't trained this target yet this week, so it was prioritized here.

For a non-goal target:

> **Added for overall physique development.** This exercise develops your quads, which are not currently an active goal but still need regular development to keep your overall physique balanced.

For a target receiving indirect contribution:

> **Supports your arm development.** This movement trains the triceps as a secondary muscle, adding useful additional work without requiring another dedicated exercise.

## Do not over-explain

Do NOT produce paragraphs about the programming engine.

The user does not need to know:

```text
Gate 3 won.
Candidate score = X.
Package reference = Y.
Exercise rank = Z.
```

The UI should explain the **training reason**, not the implementation.

---

# 5. Goal Terminology in Explanations

Where possible, use the user's actual goal wording rather than internal target IDs.

Instead of:

```text
physique_target "brachialis-arm-thickness"
```

say:

> **your arm-thickness goal**

Instead of:

```text
triceps-back-depth
```

say:

> **your triceps/back-depth goal**

If the application already has a human-readable goal title, use that.

If a target is part of a goal, phrase the relationship naturally:

> This primarily trains the brachialis, supporting your arm-thickness goal.

Do not expose internal slug names unless no human-readable representation exists and there is no reasonable alternative.

---

# 6. Weekly Exposure Language

The system should still use actual weekly exposure internally.

The UI can communicate the useful part of that information.

Good:

> You have 4 sets for this target so far this week.

Good:

> This adds 3 more sets toward the weekly development target.

Good:

> This target hasn't received direct work yet this week, so it was prioritized today.

Avoid:

> `2 session(s)/week: tuesday, friday — session-by-session, not divided evenly`

Avoid:

> `exercise 1 of this target's own real weekly plan`

Avoid:

> `rolling exposure state`

The user needs the training implication, not the algorithmic bookkeeping.

---

# 7. Prescription Information

Rep ranges and RIR can remain visible where useful because they are actionable training information.

For example:

> **10–20 reps · 1–3 RIR**

is useful.

But phrase the surrounding explanation naturally:

> Use 10–20 reps and finish with roughly 1–3 reps in reserve.

Do not say:

> `Reps 10-20, RIR 1-3 per Blueprint's development package.`

The Blueprint package is an implementation/reference concept, not something the user needs to understand in normal program explanations.

---

# 8. First-Time / Progression Explanations

If the system currently explains that an exercise has no prior performance history, translate it into normal language.

Instead of:

> `First-time prescription — no prior performance of this exact exercise to progress from.`

say:

> **First time using this variation in the logged history, so start with a weight that lets you stay within the prescribed rep range with good form.**

If prior performance exists:

> **Based on your previous performance, this continues your progression from the last time you used this variation.**

Only show this when it is useful to the user.

---

# 9. Keep Internal Debugging Available Separately

Do not delete useful diagnostic information from the codebase merely because it is inappropriate for the normal UI.

If internal diagnostics are useful for development, keep them in:

- logs
- developer/debug mode
- structured internal data

But the normal user-facing explanation must remain human-friendly.

Do not mix developer diagnostics into the user-facing explanation string.

This is an important separation:

```text
Internal programming diagnostics
        ≠
User-facing explanation
```

---

# 10. UI Consistency

Apply the human-readable explanation rule consistently wherever programming explanations appear.

Audit:

- weekly program
- today's workout
- exercise details
- goal-related explanations
- workout completion
- programming rationale
- substitution/recommendation messages

Do not fix only the Hammer Curl example.

Search for and eliminate user-facing strings containing implementation terminology such as:

```text
physique_target
decisive gate
gate1
gate2
gate3
gate4
Surgical Fix
package prescription
exercise X of this target's own real weekly plan
session-by-session
not divided evenly
```

Replace them with useful training language.

---

# 11. Tests Required

Add/update tests for all four changes.

## A. Equipment filtering

Create a regression test proving that a valid Blueprint exercise remains a candidate even when it would previously have failed the equipment-feasibility check.

Expected:

```text
valid Blueprint exercise
+
valid target
+
valid prescription
+
otherwise valid programming context
=
candidate remains selectable
```

Do not merely test that an equipment filter function returns true.

Test the actual candidate-selection/program-generation behavior.

Also verify that no hidden equipment gate remains elsewhere in the candidate-selection path.

---

## B. Session notes

Test that:

1. A session note can be created.
2. The note persists.
3. The note can be retrieved when the session is reopened.
4. The note can be edited.
5. The note can be cleared.
6. Refresh/navigation does not lose the note.
7. Existing sessions without notes continue to work.
8. Adding a note does not alter workout programming or workout history.

If a DB migration is added, test that existing data remains intact.

---

## C. Copy button

Test the underlying copy-text formatter separately from the browser clipboard where practical.

Verify that:

- all displayed performed rows are included
- the date/session context is included
- performed variations are used
- the session note is included when appropriate
- internal IDs/debug fields are absent
- JSON is not produced
- output is deterministic
- no displayed row is silently omitted

If browser clipboard testing is impractical in the current test setup, test the formatter and keep the UI clipboard call very small.

---

## D. Human-readable explanations

Add tests around representative explanations.

For example, the output should contain useful language such as:

```text
Added for your arm-thickness goal.
```

and:

```text
primarily trains the brachialis
```

while NOT containing:

```text
physique_target
decisive gate
gate3_programming_need
Surgical Fix Pass
session-by-session
not divided evenly
```

Do not make tests excessively dependent on exact punctuation or an entire long paragraph.

Test the semantic requirements and important forbidden implementation terminology.

---

# 12. Backward Compatibility / Data Safety

This work must be additive and non-destructive.

Do NOT:

- reset SQLite
- delete workout history
- recreate the database
- regenerate historical workouts
- modify historical performed data
- modify goals
- modify Blueprint source data
- add exercises to Efficient/Complete packages merely to satisfy candidate selection
- introduce AI/LLM dependencies

Existing workout/session IDs should remain stable.

If a session-note database migration is required:

- make it additive
- preserve all existing rows
- provide a safe default (`NULL`/empty)
- verify SQLite integrity
- verify existing row counts

---

# 13. Verification

Run the normal project verification suite:

```text
npm ci
npm run typecheck
npm test
npm run build
npm run verify
```

Use the project's actual available scripts if the names differ.

Also perform focused checks for:

### Candidate generation

Confirm a valid Blueprint exercise can be selected even when equipment metadata would previously have rejected it.

### Session notes

Create/edit/reload a note and verify persistence.

### Copy

Complete a test day and verify the copied text matches the visible performed-workout table.

### Explanations

Inspect several goal and non-goal exercises and confirm the UI reads naturally.

---

# 14. Acceptance Criteria

## Equipment

- [ ] Equipment feasibility no longer filters exercises during program generation.
- [ ] No renamed/duplicate hidden equipment gate remains.
- [ ] Full Blueprint exercise candidates are available to the programmer.
- [ ] Legitimate programming constraints remain intact.
- [ ] Manual substitution remains possible.

## Session notes

- [ ] Every session/day has a small note field.
- [ ] Notes persist.
- [ ] Notes can be edited and cleared.
- [ ] Notes are optional.
- [ ] Notes do not affect programming decisions unless a separate future feature explicitly adds that behavior.

## Copy

- [ ] Completed-day performed-workout table has a Copy button.
- [ ] Copy captures the entire day's displayed performed workout.
- [ ] Performed variations are preserved.
- [ ] Session note is included appropriately.
- [ ] Output is clean plain text.
- [ ] No internal IDs/debug data appear.
- [ ] Copy success/failure is communicated clearly.

## Explanations

- [ ] User-facing programming explanations are human understandable.
- [ ] Goal relationships are explained in natural language.
- [ ] Weekly exposure is communicated simply where useful.
- [ ] Rep/RIR information remains actionable.
- [ ] Internal gates, section references, package names, IDs, and implementation terminology are removed from normal explanations.
- [ ] Developer diagnostics remain available separately if needed.

## Safety

- [ ] Existing workout history is preserved.
- [ ] Existing goals are preserved.
- [ ] No destructive DB migration.
- [ ] No Blueprint package contamination.
- [ ] No AI/LLM dependency introduced.

---

# 15. Final Report Required

After implementation, report:

## Equipment Filter
- Where the old equipment gate existed.
- What was removed.
- Confirmation that candidate selection now uses the full Blueprint exercise library without equipment-based elimination.

## Session Notes
- UI location.
- Persistence mechanism.
- API/database changes, if any.

## Copy
- UI location.
- Exact high-level format of the copied text.
- Whether performed variations and session notes are included.

## Explanations
- Before/after examples.
- Confirmation that internal programming terminology is no longer exposed in normal UI.

## Tests
- New/updated tests.
- Total test results.
- Typecheck/build results.

## Safety
Confirm:
- no DB reset
- no historical workout modification
- no goal modification
- no package modification to work around candidate selection
- no AI/LLM dependency
