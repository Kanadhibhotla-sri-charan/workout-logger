# Workout Programmer — Implementation Specification
## Features: Full Blueprint Exercise Picker + Per-Day Training Activity

**Target:** Latest uploaded `workout-logger-main.zip`
**Audience:** Claude / development agent
**Status:** Implementation specification — do not deploy until verification is complete.

---

## 1. Objective

Implement two related product improvements without disturbing the working program-generation and substitution behavior:

1. **Fix "Add unplanned exercise"**
   - Replace the current fragile native `<datalist>`-based picker with a proper searchable Blueprint exercise selector.
   - The selector must search the **entire Blueprint exercise library**, with no relevance filtering.
   - The user must explicitly select a real Blueprint exercise.
   - Keep backend Blueprint-ID validation.
   - **Do not modify the existing Substitute flow.**

2. **Make daily training activity explicit**
   - Each weekday can be:
     - `Gym`
     - `Badminton`
     - `Both`
     - `Unselected` = rest
   - The user must be able to change any day between these states.
   - The generated/current weekly program must understand badminton as a first-class activity rather than treating every selected training day as a gym day.
   - Changing a day after generation must update/reconcile the existing week without requiring a full user-initiated regeneration.
   - Completed/logged workout history must never be overwritten or rewritten.

---

## 2. Important scope boundaries

### MUST NOT change

- The existing exercise substitution/candidate flow.
- The existing Blueprint source-of-truth validation.
- Core goal/profile concepts unless required by the new daily-activity model.
- Logged/completed workout history.
- Existing progression/history data.
- Existing working APIs unless required for the two features.
- The overall Node.js + Express + SQLite architecture.
- Deployment architecture.

### Specifically do NOT do

- Do not make arbitrary exercise names valid merely because the user typed them.
- Do not filter Add Unplanned Exercise by muscle relevance, program relevance, goal, session, or equipment.
- Do not make the Substitute feature use the unrestricted exercise picker.
- Do not solve badminton by telling the user to add it manually as an unplanned exercise.
- Do not regenerate the entire week unnecessarily when a daily activity is changed.
- Do not delete historical workout records when changing a future/current day.

---

# 3. Feature A — Add Unplanned Exercise

## Current problem

The current UI uses an input plus native HTML `<datalist>` for Blueprint exercises.

The current validation correctly requires a valid Blueprint exercise ID, but the browser-native picker does not reliably provide selectable search results. Consequently:

1. User types an exercise.
2. No dropdown appears.
3. User types the whole name manually.
4. Save/add rejects it because it was never resolved to a Blueprint exercise ID.

The validation is not the problem. The selection UX is the problem.

## Required behavior

When the user chooses **Add unplanned exercise**:

1. Open the exercise selector.
2. Show a search field.
3. As the user types, show matching Blueprint exercises in a real dropdown/list.
4. Search the **complete Blueprint exercise library**.
5. Matching should primarily be based on exercise name/text search.
6. No program-relevance filtering.
7. No muscle-group filtering.
8. No goal filtering.
9. No requirement that the exercise be a sensible substitute for the skipped exercise.
10. User explicitly selects one result.
11. The UI stores the corresponding Blueprint exercise ID.
12. Submit the Blueprint ID to the existing backend/API.
13. Backend continues to validate that the ID belongs to Blueprint.

### Empty search

With an empty search field, the UI may show a useful initial set or the full library if practical, but do not create a giant unusable DOM list. A reasonable implementation may show the first N results and allow search to narrow them.

### No match

Show a clear "No Blueprint exercises found" state.

Do not allow arbitrary text submission.

### Selection state

After selecting an exercise, visibly show the selected exercise name and make it clear that it is a Blueprint exercise.

The submit button should be disabled or otherwise prevented until a valid Blueprint exercise is selected.

---

## API/data expectations

Reuse the existing Blueprint exercise source/API where possible.

Do not duplicate the Blueprint database in a new table merely to implement the picker.

If the current `/api/blueprint/exercises` endpoint already returns the required library, use it.

If pagination/search is required for performance, implement it in a backward-compatible way, but do not introduce relevance ranking.

The selected value must ultimately be a real Blueprint exercise ID.

---

## Testing — Feature A

Add/maintain tests for:

- Blueprint exercise list loads.
- Search returns matching exercises.
- Search is case-insensitive.
- Search does not filter by program relevance.
- A valid result can be selected.
- Selected Blueprint ID is submitted.
- Arbitrary typed text without selection is rejected.
- Invalid Blueprint ID is rejected.
- No-match state works.
- Existing Substitute flow remains unchanged.

---

# 4. Feature B — Per-Day Training Activity

## Desired model

For every weekday:

| State | Meaning |
|---|---|
| Gym | Gym session is planned/available |
| Badminton | Badminton is the training activity |
| Both | Gym + badminton |
| Unselected | Rest |

There must NOT be a separate "Rest" selection. An unselected day already means rest.

Example:

| Day | Activity |
|---|---|
| Monday | Gym |
| Tuesday | Gym |
| Wednesday | Unselected |
| Thursday | Gym |
| Friday | Gym |
| Saturday | Badminton |
| Sunday | Both |

---

# 5. Training Profile UI

Replace/extend the current concept of selecting gym training days so that the user can specify the activity for each day.

The UI should make it easy to change any day.

Preferred interaction:

- Each weekday has a compact selector/toggle.
- Available values: `Gym`, `Badminton`, `Both`, and an unselected state.
- Existing profile values should be migrated/translated safely.

### Backward compatibility

Existing profiles where `training_days` says a day is active should map to:

> active gym day → `Gym`

Existing unselected days should map to:

> `Unselected`

Do not silently convert existing badminton information into a different activity unless the data clearly supports it.

If existing `other_activity_schedule` data contains recurring badminton information, preserve it during migration. Do not delete old data.

---

# 6. Data model

Introduce a first-class per-weekday activity representation.

Use the existing project conventions for SQLite migrations/schema initialization.

A suitable conceptual representation is:

```text
weekday
activity
```

where activity is one of:

```text
gym
badminton
both
```

and absence of a row/value means rest/unselected.

Do not introduce a separate `rest` enum/value unless the existing architecture makes that unavoidable.

If the project already has a suitable table/JSON structure that can represent this cleanly, reuse it rather than adding redundant storage.

The final model must support independent changes to each weekday.

---

# 7. Program generation semantics

The planner must no longer interpret every selected training day as a gym opportunity.

Instead:

```text
Gym day       → gym programming opportunity
Badminton day → badminton activity, no automatic gym session
Both day      → badminton + gym programming opportunity
Unselected    → rest
```

This is the key behavioral correction.

Example:

```text
Mon Gym
Tue Gym
Wed Rest
Thu Gym
Fri Gym
Sat Badminton
Sun Badminton
```

must result in four gym opportunities plus two badminton days, **not six gym sessions**.

The existing badminton/recovery awareness may continue to influence gym exercise/session allocation, but it must not be the mechanism that determines whether a day is a gym day in the first place.

---

# 8. "Both" semantics

A `Both` day contains:

- badminton activity
- a gym programming opportunity

The programmer should account for badminton when making gym programming decisions on that day.

Do not simply treat `Both` as an ordinary gym day with an unrelated note.

Existing recovery/fatigue logic should be reused where appropriate.

---

# 9. Existing weekly program editing

The user must be able to change activity for a day **after the program has already been generated**.

Examples:

```text
Gym → Badminton
Badminton → Gym
Gym → Both
Both → Gym
Both → Badminton
Badminton → Both
Unselected → Gym
Unselected → Badminton
Unselected → Both
Gym → Unselected
Badminton → Unselected
Both → Unselected
```

All transitions must work.

The user should not be forced to regenerate the entire program manually.

---

# 10. Reconciliation rules

Changing an activity is a planning change, not a request to erase and rebuild the user's week.

When a day changes:

1. Preserve all completed/logged workout history.
2. Preserve historical records.
3. Preserve already completed exercises/sets.
4. Preserve unaffected future sessions where possible.
5. Reconcile only the uncompleted portion of the plan as necessary.
6. Maintain weekly balance and the existing programming constraints.
7. If removing a gym day creates an allocation problem, redistribute required gym work across remaining gym-capable days rather than silently losing required programming.
8. If adding a gym day creates capacity, use the existing programming logic to determine an appropriate session.
9. If a day becomes Badminton, it must not retain an uncompleted gym session merely because it existed before the activity change.
10. If a day becomes Both, add/retain an appropriate gym component while retaining badminton.
11. If a day becomes Rest/unselected, remove uncompleted planned activity for that day without deleting historical records.

### Important

Do NOT call the same top-level "generate an entirely new program" operation blindly on every activity change if that would replace unrelated future sessions.

The reconciliation should be as minimally destructive as practical.

---

# 11. UI location for changing activity

The exact UI can follow the current app design, but the user must have an obvious way to change the activity for an individual day from the existing weekly program.

A suitable interaction is:

```text
Saturday
Badminton

[ Change activity ]
```

Opening it:

```text
Gym
Badminton
Both
Rest / clear
```

The UI may display "Rest" or "Clear" as an action for removing the selection, even though `Rest` is not stored as a training activity.

The change should take effect without requiring the user to regenerate the entire program manually.

---

# 12. Interaction with Add Unplanned Exercise

These are separate concepts.

### Add Unplanned Exercise

Means:

> "I am choosing an exercise that isn't currently in the planned session."

It searches the entire Blueprint library.

### Activity change

Means:

> "I am changing what kind of training I am doing on this day."

Changing a day to Badminton should NOT require the user to add badminton as an unplanned exercise.

---

# 13. Interaction with Substitute

Keep these separate.

### Substitute

- Existing candidate/relevance/equipment-aware logic.
- Existing UI and behavior should remain intact.

### Add Unplanned Exercise

- Entire Blueprint library.
- No relevance filtering.
- Explicit Blueprint selection.

Do not merge these two flows.

---

# 14. API expectations

Add/update APIs only as necessary.

The API should support:

- reading daily activity assignments
- updating one day's activity
- obtaining the current week's activity state
- reconciling the current/future weekly plan after an activity change

Use the project's existing Express/SQLite patterns.

Prefer small, focused endpoints over a large generic mutation endpoint.

All input must be validated server-side.

---

# 15. Persistence and refresh behavior

After changing a day's activity:

- persist it
- update the current UI immediately after successful response
- refresh/reload safely without losing the state
- reopening the app must show the persisted activity
- VM/app restart must not lose the activity

---

# 16. Tests — Feature B

Add tests covering at minimum:

### Profile/state

- Existing gym day loads as Gym.
- Unselected day loads as rest/unselected.
- Badminton can be selected.
- Both can be selected.
- State persists.

### Transitions

- Gym → Badminton
- Badminton → Gym
- Gym → Both
- Both → Gym
- Badminton → Both
- Both → Badminton
- Unselected → Gym
- Unselected → Badminton
- Unselected → Both
- Gym → Unselected
- Badminton → Unselected
- Both → Unselected

### Planner behavior

- Badminton-only day does not receive an automatic gym session.
- Gym-only day receives gym programming.
- Both day can receive gym programming while retaining badminton.
- Unselected day receives no new planned training activity.
- Six selected days with Saturday/Sunday badminton do not become six gym sessions.
- Existing badminton/recovery logic still functions.

### History safety

- Changing a future day does not delete completed workouts.
- Changing a day after a workout has been logged does not rewrite that historical workout.
- Existing exercise/set history remains intact.

---

# 17. Regression testing

Run:

```bash
npm run verify
```

Also manually verify:

1. Generate a normal gym program.
2. Substitute an exercise.
3. Add an unplanned exercise from the full Blueprint library.
4. Change a day from Gym to Badminton.
5. Change another day to Both.
6. Change a rest day to Gym.
7. Change a day back to rest/unselected.
8. Log a workout.
9. Change a future activity.
10. Confirm the logged workout remains untouched.

Do not consider the work complete if the existing substitution behavior regresses.

---

# 18. Acceptance criteria

The implementation is complete only when all of these are true:

- [ ] Add Unplanned Exercise has a functioning searchable dropdown.
- [ ] It searches the complete Blueprint library.
- [ ] Any valid Blueprint exercise can be selected.
- [ ] Arbitrary text cannot bypass Blueprint validation.
- [ ] Substitute behavior is unchanged.
- [ ] Each weekday supports Gym, Badminton, Both, or unselected.
- [ ] Unselected means rest; no stored Rest activity is required.
- [ ] A badminton-only day is not automatically converted into a gym day.
- [ ] Both means badminton + gym opportunity.
- [ ] Any day's activity can be changed after program generation.
- [ ] The current plan reconciles without unnecessary full regeneration.
- [ ] Completed/logged history is never destroyed.
- [ ] State persists across reload/restart.
- [ ] Existing tests pass.
- [ ] New tests cover the above behavior.
- [ ] No deployment occurs until the implementation is reviewed and verified.

---

# 19. Implementation discipline

Before coding:

1. Inspect the existing schema, API routes, planner, and UI.
2. Reuse existing abstractions where they fit.
3. Identify exactly where the current `training_days` semantics are consumed.
4. Identify exactly how current weekly plans are persisted.
5. Design the smallest migration/change that supports the new model.
6. Do not modify unrelated architecture.

After coding:

1. Run tests.
2. Run typecheck/build.
3. Review the diff for unrelated changes.
4. Manually exercise the acceptance scenarios.
5. Report any unresolved ambiguity rather than inventing behavior.

**Do not deploy from the development environment as part of this implementation task.**
