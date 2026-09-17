# Batch 3 — Periodization System

## Scope

**Batch 3 combines:**

- **Phase 2 — Periodization Waves & Block Structure**
- **Phase 4 — Reactive Deloads & Specialization Blocks**

These phases must be implemented together as one periodization and block-state mechanism.

Phase 4 is not treated as an independent subsystem. It is an upgrade to the same period/block state introduced by Phase 2: calendar-based deloads establish the baseline behavior, while historical trend analysis can recommend or trigger an earlier reactive deload when sustained evidence justifies it.

---

## 1. Objective

Introduce a persistent, deterministic periodization system that can:

1. Track the user's current training block and week.
2. Advance blocks according to calendar boundaries.
3. Apply scheduled calendar deloads.
4. Evaluate historical training trends for signs of accumulated fatigue or declining performance.
5. Trigger a reactive deload only when predefined evidence thresholds are met.
6. Preserve the existing Blueprint, goal-priority, exercise-selection, volume, and session-constraint rules.
7. Keep periodization state explainable, inspectable, and safe.

The system must modify training prescription through controlled block-state adjustments rather than replacing the existing workout-generation architecture.

---

## 2. Design Principles

### 2.1 One block-state mechanism

Phase 2 and Phase 4 must use the same persisted periodization record.

The system should not create separate tables or competing sources of truth for:

- Current block
- Current week
- Block start date
- Scheduled deload status
- Reactive deload status
- Deload reason
- Block progression state

### 2.2 Calendar behavior is the baseline

The default periodization behavior is calendar-driven.

The system should support a predictable block structure, such as:

- Accumulation or productive training weeks
- A scheduled deload week
- A new block after the deload

The exact block length and default schedule must follow the existing roadmap and project decisions. Do not hard-code assumptions in multiple places.

### 2.3 Reactive behavior is evidence-driven

A reactive deload must not be triggered by:

- One poor workout
- One missed session
- One low-performance set
- A single subjective fatigue report
- A single low readiness value
- A temporary scheduling disruption

Reactive deload logic must require sustained, multi-signal evidence over a defined lookback period.

### 2.4 No automatic specialization selection

This batch may support the state and scheduling infrastructure required for specialization blocks, but the system must not automatically decide which muscle should be specialized.

Specialization requires explicit user intent or a confirmed active goal.

### 2.5 Preserve existing programming boundaries

Periodization must not bypass:

- Blueprint-authored exercise and muscle coverage boundaries
- Active growth-goal limits and priority ordering
- Session exercise limits
- Distinct-target limits
- Existing volume and fatigue accounting
- Functional-goal protection
- Locked-session behavior
- Existing exercise eligibility and safety rules

---

## 3. Functional Scope

### Included

- Persistent block-state model
- Calendar-based block advancement
- Scheduled deload state
- Deload prescription modifiers
- Historical trend aggregation
- Reactive deload evaluation
- Reactive deload state and cooldown
- Block transition handling
- Planner integration
- API and UI visibility
- Tests and migration
- AI-context exposure for explanations

### Excluded

- Full machine-learning prediction
- Automatic specialization-muscle selection
- Automatic goal creation
- Automatic changes to Blueprint package definitions
- Rewriting the exercise selector
- Replacing existing fatigue accounting
- Readiness-based daily workout generation
- Unbounded volume escalation
- Automatic changes to exercise technique or exercise safety rules
- Medical diagnosis or injury assessment

---

## 4. Periodization State Model

Create or extend one canonical periodization/block-state record.

### Required conceptual fields

| Field | Purpose |
|---|---|
| `user_id` | Owner of the periodization state |
| `program_id` | Program or active plan associated with the state |
| `block_id` | Stable identifier for the current block |
| `block_number` | Sequential block number |
| `block_start_date` | Date the current block began |
| `block_end_date` | Expected end date, if applicable |
| `block_length_weeks` | Configured length of the block |
| `current_week` | Current week within the block |
| `block_phase` | Accumulation, deload, transition, or specialization-related state |
| `scheduled_deload_week` | Week assigned for the calendar deload |
| `state` | Active, scheduled-deload, reactive-deload, transition, or completed |
| `deload_reason` | Calendar, reactive, manual, or combined |
| `reactive_trigger_status` | Not-evaluated, clear, warning, triggered, completed, or cooldown |
| `reactive_triggered_at` | Timestamp/date of reactive trigger |
| `reactive_deload_start_date` | Start date of reactive deload |
| `reactive_deload_end_date` | End date of reactive deload |
| `cooldown_until` | Prevents repeated immediate triggering |
| `last_evaluated_at` | Last trend evaluation timestamp |
| `created_at` | Record creation timestamp |
| `updated_at` | Last update timestamp |

Use the project's existing naming conventions and persistence patterns. Do not create duplicate representations of the same state.

---

## 5. State Machine

The periodization system should use explicit state transitions.

### Primary states

1. `ACTIVE`
2. `SCHEDULED_DELOAD`
3. `REACTIVE_DELOAD`
4. `TRANSITION`
5. `COMPLETED` or archived state, if required by the existing architecture

### Valid transitions

```text
ACTIVE
  ├── calendar boundary reached ──> SCHEDULED_DELOAD
  ├── reactive evidence threshold met ──> REACTIVE_DELOAD
  └── block end reached ──> TRANSITION

SCHEDULED_DELOAD
  └── deload period completed ──> TRANSITION

REACTIVE_DELOAD
  └── reactive deload completed ──> TRANSITION

TRANSITION
  └── next block initialized ──> ACTIVE
```

### Combined condition

If a reactive trigger occurs close to a scheduled deload:

- Do not create two consecutive independent deload mechanisms unless explicitly required.
- Merge the state into one deload period where safe.
- Preserve the reason as `combined` or retain both reason flags.
- Avoid extending the deload indefinitely.
- Record why the deload was extended or merged.

---

## 6. Calendar-Based Periodization

### 6.1 Block creation

When a program begins:

1. Create the initial periodization state.
2. Set the block start date.
3. Calculate the configured block length.
4. Calculate the scheduled deload week.
5. Set the current week based on calendar dates, not number of app openings.
6. Persist the state.

### 6.2 Calendar advancement

Block advancement must be based on actual dates.

The system must not advance a week merely because:

- The user opened the app.
- A workout was generated.
- A workout was viewed.
- A session was started but not completed.

Week calculation should use the configured program timezone and a consistent calendar-week interpretation.

### 6.3 Scheduled deload

When the current date enters the scheduled deload week:

1. Mark the block as `SCHEDULED_DELOAD`.
2. Apply the deload prescription modifier.
3. Keep the underlying Blueprint and exercise eligibility intact.
4. Preserve goal priorities and muscle coverage.
5. Avoid generating normal accumulation-level workload during the deload.
6. Record the calendar reason.

### 6.4 Block transition

At the end of the block:

1. Finalize the current block.
2. Preserve historical block metadata.
3. Create or activate the next block.
4. Reset week-relative state.
5. Clear completed deload flags.
6. Retain relevant historical trends for future reactive evaluation.
7. Do not erase the user's goals, preferences, or progression history.

---

## 7. Deload Prescription Behavior

The deload system should modify workload conservatively and consistently.

### Required behavior

- Reduce training stress relative to the preceding productive week.
- Preserve movement patterns and important muscle exposure where practical.
- Avoid introducing unfamiliar exercises solely because it is a deload.
- Avoid interpreting reduced deload performance as a failure.
- Maintain functional-goal protection unless a safety issue requires otherwise.
- Respect locked sessions and explicit user constraints.

### Modifier design

Use a centralized, configurable deload policy rather than scattering numeric reductions throughout the planner.

The policy may define:

- Set-volume reduction
- Optional intensity/load reduction
- Effort/RIR adjustment
- Exercise-count adjustment
- Rep-range emphasis
- Minimum exposure safeguards
- Maximum deload duration

The default values must be defined in one configuration location and documented. Do not duplicate literal multipliers across planner components.

### Rep-range handling

Blueprint-authored rep ranges remain the numerical boundary.

A deload may bias prescriptions toward the less-fatiguing portion of an existing authored range, but it must not invent rep ranges outside the Blueprint's permitted range.

---

## 8. Historical Trend Engine

Phase 4 requires a historical trend layer that evaluates existing workout and performance data.

### 8.1 Data sources

Use existing persisted data wherever possible, including:

- Completed workout sessions
- Exercise-level performance
- Set completion
- Repetitions
- Load or resistance
- RIR/RPE, if available
- Session duration, if available
- User-reported fatigue or readiness, if available
- Missed or aborted sessions
- Muscle-level workload and performance summaries
- Recent deload history

Do not create duplicate history storage if the existing workout logs already contain the required information.

### 8.2 Lookback window

The trend evaluator must use a defined lookback window.

The window should be configurable and should account for:

- Training frequency
- Available completed sessions
- Current block age
- Missing data
- Recent deloads
- Exercise substitutions

The evaluator must not treat absent data as negative evidence.

### 8.3 Trend signals

Potential signals include:

- Repeated performance decline on comparable exercises
- Repeated failure to meet expected repetitions or effort targets
- Increasing session difficulty at similar workload
- Increasing missed or aborted sessions
- Sustained high subjective fatigue
- Persistent reduction in performance across multiple sessions
- Worsening recovery indicators when consistently recorded
- Declining performance across more than one relevant movement or muscle group

A single signal should generally be insufficient on its own unless the roadmap explicitly defines otherwise.

### 8.4 Comparability requirements

Performance comparisons must account for:

- Exercise identity or valid exercise family
- Load and rep differences
- Exercise substitutions
- Changes in equipment
- Changes in rep range
- Deload weeks
- Incomplete sessions
- Long gaps between sessions

Do not compare unrelated exercises as though they were identical performance tests.

---

## 9. Reactive Deload Trigger

### 9.1 Trigger philosophy

Reactive deloading is a protective response to sustained evidence that current training stress may be exceeding recoverability.

It is not a punishment, performance ranking, or automatic response to normal fluctuation.

### 9.2 Trigger requirements

A reactive deload should require a combination of:

1. A minimum amount of usable recent data.
2. A sustained lookback period.
3. Evidence from multiple sessions.
4. Preferably more than one signal category.
5. No active cooldown or recently completed deload.
6. No stronger explanation such as missing data, exercise substitution, injury restriction, or intentional program change.

### 9.3 Suggested evidence structure

Implement the trigger as a transparent rule evaluation, not an opaque score.

The evaluator should produce:

- `triggered: boolean`
- `confidence` or evidence strength, if supported
- `signals`
- `sessions_considered`
- `lookback_start`
- `lookback_end`
- `excluded_sessions`
- `blocking_reasons`
- `recommended_action`
- `evaluation_timestamp`

### 9.4 Trigger levels

Use explicit levels if useful:

- `CLEAR`: no meaningful sustained concern
- `WATCH`: early warning; no deload yet
- `TRIGGERED`: threshold met; initiate reactive deload
- `COOLDOWN`: recently deloaded; suppress repeat trigger unless an exceptional override exists

A `WATCH` state must not automatically alter the workout prescription unless explicitly designed and documented.

### 9.5 Trigger action

When the threshold is met:

1. Persist the trigger evidence.
2. Transition the block to `REACTIVE_DELOAD`.
3. Set the reactive deload start and end dates.
4. Apply the centralized deload policy.
5. Record the reason and supporting signals.
6. Expose an understandable explanation to the user.
7. Prevent duplicate triggers during the same reactive deload.
8. Start the cooldown after completion.

---

## 10. Cooldown and Anti-Thrashing Rules

The system must prevent repeated deload triggering.

### Required safeguards

- Do not retrigger while already in a deload.
- Do not retrigger immediately after a deload using the same evidence.
- Require a minimum post-deload training period before normal reactive evaluation resumes.
- Mark evidence used for a trigger or associate it with the triggering period.
- Avoid counting deload sessions as evidence of normal productive performance.
- Do not extend a reactive deload indefinitely without a separate explicit rule.
- If symptoms or pain are reported, surface a safety-oriented message rather than treating the issue solely as training fatigue.

---

## 11. Specialization Block Support

This batch may provide the block-state support needed for specialization, but specialization must remain explicit.

### Required behavior

- A specialization block can be represented as a block type or block configuration.
- It must reference an already confirmed active growth goal or explicit user selection.
- It must not automatically choose a muscle based only on trend data.
- It must respect the maximum active growth-goal policy.
- It must preserve non-specialized muscle maintenance.
- It must not override safety, functional-goal protection, or session constraints.
- It must be visible in the periodization state and planner context.

If the existing roadmap defines the actual specialization prescription rules elsewhere, this batch should expose the state/interface without duplicating those rules.

---

## 12. Planner Integration

The periodization layer should sit above prescription generation and provide a clear context object to the planner.

### Planner inputs

The planner should receive:

- Current block type
- Current week
- Whether the current week is a scheduled deload
- Whether the current state is a reactive deload
- Deload reason
- Deload policy/modifiers
- Active specialization configuration, if explicitly enabled
- Relevant trend summary
- Any state restrictions

### Planner responsibilities

The planner should:

1. Generate the normal Blueprint-constrained prescription.
2. Apply periodization modifiers through a centralized step.
3. Preserve muscle coverage and goal priorities.
4. Revalidate all session constraints after modification.
5. Avoid applying deload reduction twice.
6. Produce explanation metadata describing the periodization effect.

### Avoid

- Embedding trend calculations inside exercise selection.
- Embedding calendar calculations inside individual muscle planners.
- Applying deload modifiers separately in multiple layers.
- Allowing reactive state to bypass existing prescription validation.

---

## 13. API and UI Requirements

### API

Expose periodization information through the existing API conventions.

The response should make available:

- Current block
- Current week
- Block dates
- Current state
- Scheduled deload information
- Reactive evaluation status
- Deload reason
- Specialization state, if applicable
- Human-readable explanation
- Next expected transition

### UI

The user should be able to understand:

- Which block they are in
- Whether they are in a normal week or deload
- Why a deload is scheduled or reactive
- When the deload ends
- What evidence contributed to a reactive trigger
- Whether a specialization block is active and what goal it serves

Avoid exposing raw internal scores without explanation.

### Reactive explanation example

> A recovery deload was scheduled because performance has declined across several recent comparable sessions, alongside consistently elevated fatigue reports. This is a temporary reduction in training stress, not a change to your long-term goals.

The final wording should match the application's tone and existing explanation system.

---

## 14. Persistence and Migration

### Requirements

- Reuse existing persistence conventions.
- Add a migration for new periodization fields or tables if required.
- Provide safe defaults for existing users with no periodization state.
- Make initialization idempotent.
- Ensure repeated planner calls do not create duplicate blocks or transitions.
- Preserve existing workout history.
- Preserve existing active goals and preferences.
- Ensure old records remain readable if new fields are absent.

### Backward compatibility

For users upgrading from the pre-periodization system:

1. Initialize a current block from the user's existing program start or the first safe available date.
2. Avoid retroactively triggering a reactive deload immediately after migration.
3. Mark historical trend data as available only where sufficient and comparable.
4. Clearly distinguish inferred state from user-confirmed state if the UI exposes it.

---

## 15. Testing Requirements

### 15.1 State and calendar tests

Test:

- Initial block creation
- Correct week calculation
- Calendar boundary advancement
- Scheduled deload entry
- Deload completion
- Block transition
- Timezone consistency
- Repeated calls being idempotent
- Missed sessions not falsely advancing the block
- App reopening not duplicating transitions

### 15.2 Deload prescription tests

Test:

- Deload modifiers are applied exactly once
- Deload reductions remain within configured bounds
- Blueprint rep ranges are not violated
- Minimum muscle exposure is preserved
- Session exercise and target limits remain valid
- Goal priorities remain unchanged
- Locked sessions are respected
- Functional goals are not silently removed
- Normal weeks remain unaffected

### 15.3 Trend-engine tests

Test:

- Insufficient data does not trigger
- Missing data is not treated as decline
- One poor session does not trigger
- Sustained comparable decline can trigger
- Unrelated exercise comparisons are excluded
- Exercise substitutions are handled safely
- Deload sessions are excluded or treated appropriately
- Recent deloads suppress immediate retriggering
- Multiple signal categories are evaluated correctly
- Evidence output is deterministic and explainable

### 15.4 Reactive state tests

Test:

- Reactive trigger transitions state correctly
- Duplicate triggers are prevented
- Reactive deload dates are persisted
- Completion transitions correctly
- Cooldown is applied
- Combined scheduled/reactive conditions do not create overlapping deloads
- Manual state changes are validated
- API and UI display the correct reason

### 15.5 Specialization tests

Test:

- Specialization requires explicit configuration or confirmed goal
- Trend data alone cannot select a specialization target
- Specialization does not exceed active-goal limits
- Maintenance coverage remains present
- Session constraints remain valid

### 15.6 Regression tests

Run the full existing test suite and verify that:

- Existing workout generation remains stable outside periodization states.
- Existing Blueprint rules remain intact.
- Existing goal-priority behavior remains intact.
- Existing exercise selection remains unchanged unless periodization modifiers are active.
- Existing locked-session behavior remains intact.

---

## 16. Observability and Debugging

Persist or expose enough information to diagnose periodization decisions.

For every transition or reactive evaluation, capture:

- Previous state
- New state
- Trigger type
- Evaluation date
- Block/week
- Evidence summary
- Applied policy
- Resulting prescription modifier
- Reason for suppression, if no trigger occurred

Avoid logging sensitive information unnecessarily.

A developer/debug view should make it possible to answer:

- Why did the system enter deload?
- Was it calendar-driven or reactive?
- Which sessions were considered?
- Which sessions were excluded?
- Which rule threshold was met?
- Why did it not trigger?
- Was the deload modifier applied once or multiple times?

---

## 17. Acceptance Criteria

Batch 3 is complete when all of the following are true:

- [ ] One canonical periodization/block-state mechanism exists.
- [ ] Calendar-based blocks and scheduled deloads work from actual dates.
- [ ] Reactive trend evaluation uses existing historical data.
- [ ] Reactive deloads require sustained, explainable evidence.
- [ ] A single poor workout cannot trigger a reactive deload.
- [ ] Reactive and scheduled deloads do not conflict or stack incorrectly.
- [ ] Deload modifiers are centralized and applied exactly once.
- [ ] Blueprint-authored boundaries remain respected.
- [ ] Existing goals, preferences, constraints, and locked sessions remain respected.
- [ ] Specialization cannot be selected automatically from trend data.
- [ ] State, reason, and explanation are visible through the appropriate API/UI surfaces.
- [ ] Migration is safe and idempotent.
- [ ] Full regression tests pass.
- [ ] Documentation reflects the combined Phase 2 + Phase 4 architecture.
- [ ] Debugging information is sufficient to trace every periodization decision.

---

## 18. Implementation Order

Implement in this order:

1. Inspect the current architecture and identify the existing block, program, workout-history, and planner structures.
2. Define the canonical periodization state and migration.
3. Implement calendar-based block creation and advancement.
4. Implement scheduled deload state and centralized deload policy.
5. Implement historical trend aggregation using existing data.
6. Implement transparent reactive-trigger evaluation.
7. Integrate reactive state transitions and cooldown rules.
8. Integrate periodization context into the planner.
9. Add API/UI visibility and explanations.
10. Add specialization state support only where required by the existing roadmap.
11. Add unit, integration, state-machine, and regression tests.
12. Update documentation and provide a verification report.

---

## 19. Non-Negotiable Constraints

- Do not build Phase 2 and Phase 4 as unrelated systems.
- Do not create competing block-state sources of truth.
- Do not trigger reactive deloads from one bad session.
- Do not use opaque or unexplained AI judgment for deload decisions.
- Do not automatically select a specialization muscle.
- Do not violate Blueprint-authored rep ranges or existing programming constraints.
- Do not apply deload reductions twice.
- Do not erase or duplicate historical workout data.
- Do not silently alter active goals or user preferences.
- Do not treat a deload as a medical or injury-management system.

---

## 20. Deliverables

Claude should deliver:

1. Updated periodization/block-state implementation.
2. Database migration or persistence changes.
3. Calendar deload behavior.
4. Historical trend evaluator.
5. Reactive deload trigger and cooldown mechanism.
6. Planner integration.
7. API/UI updates.
8. Tests covering all acceptance criteria.
9. Updated documentation.
10. A concise implementation report listing:
   - Files changed
   - State model
   - Trigger rules
   - Deload policy
   - Migration details
   - Tests run
   - Known limitations
