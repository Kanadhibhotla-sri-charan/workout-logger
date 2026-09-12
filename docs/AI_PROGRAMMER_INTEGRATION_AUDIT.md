# AI Workout Programmer Integration Audit

**Snapshot basis**

- Workout application: `workout-logger-main.zip`
- Food Tracker application: `food_and_workout_tracker-claude-new-session-7bo2dm.zip`
- Audit date: 2026-09-12
- Scope: establish the first implementation boundary for replacing deterministic workout-programming judgment with a controlled AI programmer.

## 1. Executive conclusion

The Food Tracker already contains a reusable, production-oriented OpenRouter integration based on an OpenAI-compatible chat-completion request with a forced tool/function schema. The Workout Logger, by contrast, still performs programming decisions through a large deterministic engine.

The recommended architecture is:

```text
Programming request
  -> load authoritative application data
  -> assemble a bounded ProgrammerContext
  -> call one AI programmer using fixed instructions and structured output
  -> validate structure/references/invariants
  -> preserve locked and user-owned sessions
  -> persist through existing repositories
```

The AI must be the sole owner of programming judgment: exercise selection, distribution, sets, reps, RIR, progression decisions, and explanations. Deterministic code must remain responsible for application mechanics, data access, validation, locking, and persistence.

Do not insert an AI recommendation into the existing `workoutBuilder` and then allow the old engine to reselect, resize, redistribute, or reject it. That would create two competing programmers.

## 2. Workout Logger current architecture

### 2.1 Programming route

Primary file:

```text
src/server/routes/programming.ts
```

Observed responsibilities include:

- Loading the database from `req.app.locals.db`
- Resolving Blueprint exercise and target names
- Loading goals and training profile
- Applying recurring and week-specific activity overrides
- Computing a fresh week through `computeFreshWeek(...)`
- Reading or creating persisted weekly programs
- Rendering/enriching day and exercise responses
- Exposing the current week and today views
- Handling per-day activity changes
- Exposing exercise substitutions

Relevant route functions and flow:

```text
GET /week
  -> ensureWeekProgramGenerated(...)
  -> computeFreshWeek(...)

GET /today
  -> ensureWeekProgramGenerated(...)
  -> computeFreshWeek(...)

PUT /week/days/:day/activity
  -> update week activity override
  -> computeFreshWeek(...)
  -> reconcile/persist resulting week
```

The exact route-level flow should be preserved as the external API contract where possible, while the internal `computeFreshWeek` programming implementation is replaced by the AI-programmer orchestration.

### 2.2 Current deterministic programming engine

Primary file:

```text
src/engine/workoutBuilder.ts
```

The file describes itself as a multi-step deterministic daily/weekly generation pipeline. It currently imports and coordinates:

- `frequencyEngine` functionality
- `volumeEngine`
- `exerciseSelector`
- `exposureEngine`
- `progressionEngine`
- `recoveryEngine`
- `developmentReferenceEngine`
- `sessionPurpose`
- `trainingState`
- `constraintEngine`
- Blueprint development-package prescription lookup
- Historical workout repositories
- Badminton details and activity overrides

The current engine still contains calendar-week and target-allocation concepts, including:

- `desiredWeekly`
- `remainingWeeklySets`
- `compatibleDaysThisWeek`
- `sessionsRemainingThisWeek`
- `eligibleDaysThisWeek`
- `developmentThreshold`
- `liveNeedDeficit`
- weekly allocation and chronological day assignment

Even if some comments state that time and equipment do not affect generation, the architecture remains a deterministic weekly allocator. It should not remain downstream of the AI programmer.

### 2.3 Current prescription gate

`workoutBuilder.ts` imports:

```text
lookupExercisePrescriptionAnyLevel
parseRange
```

The current flow attempts to resolve an exercise prescription and can remove candidates when no matching prescription is found. It can produce a `no_resolvable_prescription`/similar skip outcome.

This conflicts with the agreed contract:

- Every valid Blueprint variation is a valid programming option.
- Package membership is not an eligibility gate.
- A valid Blueprint exercise must not be classified as impossible to prescribe merely because it is absent from a selected package.
- The AI must receive authoritative exercise-level prescription data rather than being forced to infer or fabricate it.

The AI-facing Blueprint export must therefore distinguish:

1. exercise validity;
2. package/reference membership;
3. authored exercise prescription;
4. development-reference information.

These must not be collapsed into one candidate-eligibility test.

### 2.4 Reconciliation module

Primary file:

```text
src/engine/weekProgramReconciliation.ts
```

Current responsibilities:

- Compare freshly computed day snapshots with persisted weekly-program days.
- Preserve days with an actual workout session whose status is `completed` or `in_progress`.
- Avoid rewriting unchanged unlocked days.
- Persist only changed unlocked days.
- Classify reconciliation deviations.

Important current types:

```text
FreshDayInput
WeekAggregates
ReconciliationTrigger
DeviationReason
```

The module currently assumes that a fresh deterministic planner has already produced the replacement week. For AI integration, its persistence/locking responsibilities are reusable, but its input contract should be revised to accept an AI-generated proposal plus explicit lock/user-ownership metadata.

The current `DeviationReason` union includes:

```text
time_constraint
recovery
sufficient_secondary_exposure
goal_priority_tradeoff
equipment_constraint
exercise_redundancy
actual_user_modification
session_capacity
adherence_pattern
```

`time_constraint` and `equipment_constraint` must not be used as reasons for normal AI programming exclusion because the agreed rules prohibit time/equipment filtering during generation. They may remain relevant only to explicit user-execution/substitution workflows if those workflows need them.

## 3. Current persistence/data model

Primary file:

```text
src/db/schema.sql
```

Relevant persisted concepts include:

- `users`
- `training_profiles`
- `training_profile_activities`
- `week_activity_overrides`
- `goals`
- `goal_events`
- workout-session and workout-exercise/set tables
- weekly program persistence tables

The schema explicitly separates user-owned training state from Blueprint knowledge. Blueprint entities are referenced by IDs rather than copied into the database.

This is appropriate for AI integration. The AI should receive a serialized, read-only context assembled from:

- Blueprint snapshot;
- user profile;
- goals;
- routine;
- history;
- current planned program;
- actual modifications;
- lock state.

The AI should never receive database credentials or direct database access.

## 4. Required session-state semantics

Before implementation, the application must make these states explicit:

### Locked

A day/session is locked when:

- an actual workout session exists with status `completed`; or
- an actual workout session exists with status `in_progress`.

Locked data must never be replaced by a generated AI plan.

### User-owned future modification

A future planned day that the user manually edits should be marked as user-owned or otherwise represented in the context. Reconciliation should preserve it unless the user explicitly asks to regenerate that day.

### Editable future day

A future day with no completed/in-progress workout and no protected user modification may be reconsidered by Reconcile.

### Actual training

Actual logged exercises, sets, reps, loads, RIR, skips, additions, and removals are historical evidence. They are not merely comments attached to the generated plan.

## 5. Food Tracker AI integration to reuse

### 5.1 Shared client

Primary file:

```text
scripts/openrouter_client.py
```

Observed characteristics:

- OpenRouter HTTP chat-completion client
- OpenAI-compatible request format
- Forced single tool/function schema
- Structured tool-call argument extraction
- No API key in returned values
- Explicit timeout handling
- Network error classification
- Authentication error classification
- Model-not-found classification
- Rate-limit classification
- Provider-error classification
- Invalid-output/content-error classification
- Bounded retry for 429 and 5xx responses
- No retry for authentication, model-not-found, or malformed/content failures

The workout application should reproduce or port this behavior into its TypeScript conventions, or share a common implementation if the projects are eventually consolidated. Do not create an untested ad-hoc `fetch` call with no structured-output/error contract.

### 5.2 Provider adapter

Primary file:

```text
scripts/ai_provider.py
```

Observed characteristics:

- Central provider selection
- `AI_PROVIDER` configuration
- OpenRouter as the canonical provider
- `AI_MODEL` override
- `OPENROUTER_API_KEY`
- Default model currently defined as:
  `nvidia/nemotron-3-ultra-550b-a55b:free`
- One provider/model resolution path
- Tool schema supplied by the higher-level AI operation
- Canonical reference data inserted into the prompt/context rather than expecting the model to memorize it

The exact model should not be hardcoded into Workout Logger until a deliberate choice is made. The integration should use environment configuration and store the selected model identifier in generation metadata.

### 5.3 Testing pattern

Food Tracker tests include:

```text
tests/test_openrouter_client.py
tests/test_ai_provider.py
```

They test:

- Missing API key
- HTTP status classification
- Retry behavior
- Backoff behavior
- Successful forced tool call
- Missing/invalid tool-call content
- Provider behavior

Workout Logger should adopt equivalent tests in Vitest/TypeScript.

## 6. Fixed Programmer Constitution

The AI must receive fixed instructions on every call. The constitution should include:

### Overall mission

The user's long-term objective is to build and maintain a muscular, aesthetically balanced physique, improve body composition by building muscle while managing excess fat, and develop useful athletic capability and endurance, including movement quality and badminton-related capacity.

### Priority hierarchy

1. Aesthetic physique development is the primary programming objective.
2. Athletic and functional development is important and should support the physique objective.
3. Explicit user-selected active goals determine where additional development emphasis is placed.
4. The rest of the physique must still be maintained.
5. A functional/athletic objective can become primary only when the user explicitly prioritizes it.

### Programming principles

- Use actual training history and observed response.
- Do not impose arbitrary universal weekly-volume quotas.
- Do not create missed-set debt.
- Do not force all programming into a Monday-Sunday volume-reset model.
- Treat calendar weeks as reporting/request boundaries, not as mandatory physiological cycles.
- Use the supplied routine, including gym, rest, badminton, and combined-activity days.
- Do not filter normal programming by available equipment.
- Do not filter normal programming by time availability.
- The user can manually skip or substitute an exercise.
- Do not invent exercises, Blueprint data, prescriptions, or performance history.

### Blueprint principles

- Every valid Blueprint variation is a valid programming option.
- Package references describe development level and coverage; they are not rigid exercise menus or quotas.
- Efficient and Complete references are reference points, not mandatory exact weekly templates.
- Package membership is not an exercise-eligibility gate.
- Use authoritative exercise-level prescription data where available.
- Never inflate authored per-session sets to satisfy a numerical target.
- Do not classify a valid Blueprint variation as unprescribable because it is not present in a selected package.
- If required authoritative data is genuinely missing, report the data gap rather than fabricate a value.

### Reconciliation principles

- Completed and in-progress sessions are immutable.
- Actual training takes precedence over the original plan as historical evidence.
- Preserve user-owned future modifications unless explicit regeneration is requested.
- Reconsider only editable future programming.
- Explain meaningful changes using actual evidence from the supplied context.
- Do not use generic unsupported claims such as “not recovered,” “adequately exposed,” or “maintenance” without concrete evidence.

## 7. Proposed AI boundary

```text
Route/controller
  -> context loader
  -> ProgrammerContext builder
  -> AI programmer service
  -> structured-output validator
  -> lock/user-modification application
  -> repository persistence
  -> response renderer
```

### Application-owned responsibilities

- Load data from repositories.
- Serialize the relevant Blueprint.
- Load goals and priorities.
- Load routine and week overrides.
- Load historical workouts.
- Load current program.
- Determine locked/editable/user-owned days.
- Call the AI.
- Validate the returned structure and references.
- Reject malformed or unsafe output.
- Preserve locked sessions.
- Persist accepted data.
- Record model/prompt/version metadata.
- Handle failures without deleting the existing program.

### AI-owned responsibilities

- Interpret the overall mission.
- Interpret active goal priorities.
- Select exercises.
- Determine exercise order.
- Determine sets, rep ranges, and RIR.
- Distribute work across available training days.
- Account for actual training exposure and performance.
- Make recovery/trade-off judgments from supplied evidence.
- Produce explanations.
- Reconcile remaining editable days after actual changes.

### AI must never

- Access or write to the database directly.
- Browse the internet.
- Search external sources.
- Modify the Blueprint.
- Rewrite completed history.
- Invent unknown exercise IDs.
- Invent missing prescriptions.
- Apply hidden time/equipment filters.
- Call autonomous tools or monitor anything.

## 8. Proposed modes

### Generate mode

Input:

- Target week
- Fixed constitution
- Blueprint context
- Goals and ranking
- Long-term objective
- Weekly routine
- Historical training context
- Existing program and lock state, if applicable
- User preferences and relevant restrictions

Output:

- Seven date-keyed day objects
- Day activity classification
- Focus/purpose
- Exercises
- Sets
- Rep range
- RIR
- Exercise rationale
- Day explanation
- Program-level summary
- Explicit omissions/trade-offs where useful

Generate semantics must be clarified in implementation:

- Generate next/future week: produce the requested week's editable program.
- Generate during an active week: preserve locked days and only fill/revise editable days unless the user explicitly requests full replacement of unlocked content.

### Reconcile mode

Input:

- Original/current program
- Actual completed/in-progress sessions
- Manual future edits
- Updated routine/activity overrides
- Historical context
- Goals
- Blueprint
- Remaining dates
- Lock and ownership state
- Trigger description

Output:

- Revised editable future days
- Explicit preserved-day references
- Changes and reasons
- No replacement content for locked days

A future day manually modified by the user should not be silently overwritten. The app should either exclude it from the AI's editable set or mark it as protected in the prompt.

## 9. Proposed structured output

This is a starting contract; final fields must be aligned with existing repository/UI shapes.

```json
{
  "mode": "generate",
  "week_start": "2026-09-14",
  "days": [
    {
      "date": "2026-09-14",
      "activity": "gym",
      "focus": "push",
      "exercises": [
        {
          "exercise_id": "incline-dumbbell-press",
          "sets": 3,
          "rep_range": {
            "min": 8,
            "max": 12
          },
          "rir": 2,
          "reason": "..."
        }
      ],
      "explanation": "..."
    }
  ],
  "program_summary": "...",
  "changes": []
}
```

Required validation categories:

- JSON/schema validity
- Correct mode
- Correct target week
- Exactly one valid day object per requested date
- Activity/day alignment
- Exercise IDs exist in the supplied Blueprint or approved outside-Blueprint catalogue
- Positive integer sets
- Valid rep and RIR ranges
- No malformed duplicate entries
- No invented targets
- Authored prescription/cap compliance where authoritative caps exist
- Locked-day preservation
- Protected user-edit preservation
- No destructive persistence on failed generation

Validation must not become a replacement programming engine. It should check structure, identity, safety, and contract compliance—not re-run the old deterministic selection logic.

## 10. Files likely to be added

Names are provisional and should follow project conventions:

```text
src/ai/openRouterClient.ts
src/ai/aiProvider.ts
src/ai/programmerContext.ts
src/ai/workoutProgrammer.ts
src/ai/programmerSchema.ts
src/ai/programmerPrompts.ts
src/ai/programmerTypes.ts
```

Potentially:

```text
src/engine/aiProgramApplication.ts
src/repositories/programGenerationMetaRepo.ts
```

Do not add these blindly. First map the current TypeScript repository conventions and determine whether metadata can fit the existing weekly-program persistence model.

## 11. Existing components to preserve or retire

### Preserve or adapt

- Blueprint adapter and snapshot loading
- Repository data access
- Goal loading
- Training profile/routine loading
- Activity override loading
- Workout history queries
- Session lock detection
- Weekly program persistence
- Substitution endpoint
- Date/timezone utilities
- API response shapes where practical
- Database transaction/error-handling patterns

### Bypass or retire as programming authorities

- Deterministic weekly target allocation
- Deterministic exercise selection
- Package-driven candidate eligibility
- Calendar-week frequency allocation as the central programmer
- Deterministic exercise construction
- Deterministic programming explanations
- Any old path that rejects valid Blueprint variations as unprescribable
- Any normal-generation time/equipment filter

The old engine may remain temporarily for comparison tests or migration support, but it must not silently modify AI output in production.

## 12. Implementation sequence

1. Finish exact route and repository audit.
2. Export and inspect the complete AI-facing Blueprint catalogue.
3. Confirm the actual database shape for planned days, exercises, actual sessions, and manual edits.
4. Confirm how the Food Tracker's OpenRouter behavior will be ported or shared.
5. Write the fixed Programmer Constitution.
6. Define `ProgrammerContext`.
7. Define the strict output schema.
8. Implement the AI client/provider layer with timeout, retry, error, and structured-output handling.
9. Implement Generate mode behind a feature flag or isolated route.
10. Implement structural validation and locked-day application.
11. Persist generation metadata and accepted program output.
12. Implement Reconcile mode.
13. Add regression tests and failure-path tests.
14. Run the full verification suite.
15. Deploy only after preserving existing database/history behavior is verified.

## 13. Blocking questions/gaps to resolve before coding

1. Does the current Blueprint snapshot expose authoritative per-exercise rep/RIR/set prescriptions for every valid variation, or must an AI-facing normalized catalogue be created?
2. What exact table/repository stores weekly planned exercises and their explanations?
3. How are manual edits to future planned sessions represented, and can they be marked protected?
4. Does the current UI have separate Generate and Reconcile actions, or must they be added?
5. Should Generate during an active week preserve all locked days and regenerate only editable days?
6. What model should be used in production, and should it be configurable via `AI_MODEL`?
7. Should AI generation metadata be stored in the weekly-program record or a new append-only table?
8. What is the maximum acceptable latency and timeout for a generation request?
9. What should the UI show when AI generation fails or returns invalid output?
10. Are outside-Blueprint exercises allowed in the generated program, and if so, what approved catalogue/metadata supplies their prescriptions?

## 14. Immediate next deliverable

The next document after this audit should be a detailed implementation specification, but only after the above gaps—especially Blueprint prescription completeness and manual-edit persistence—are resolved.

The implementation specification should contain exact file/function changes, prompt text, schema definitions, migration requirements, test cases, and deployment instructions.
