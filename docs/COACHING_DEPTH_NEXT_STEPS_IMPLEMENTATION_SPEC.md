# Coaching Depth — Next Steps Implementation Specification

## Document Status

- **Status:** Approved for implementation
- **Scope:** Post-coaching-depth productization and verification
- **Included work:**
  1. Fix stale baseline test fixtures and date-dependent tests.
  2. Build user-facing UI for the completed coaching-depth features.
- **Excluded from this document:** New coaching-depth algorithms, new programming rules, live deployment validation, and additional coaching-depth enhancements.

---

# 1. Objectives

The coaching-depth backend and planner implementation is approved for the agreed scope.

The next phase should make the implementation:

- Reproducibly verifiable.
- Safe to maintain.
- Understandable and useful to end users.
- Exposed through the application UI without duplicating planner logic.
- Clear about what is informational, configurable, and automatically applied.

The implementation must preserve the existing deterministic programming architecture.

---

# 2. Guiding Decisions

## 2.1 Fix the test baseline before expanding functionality

The current full-suite failures are associated with stale hardcoded historical dates and date-dependent fixtures.

These failures must be separated from genuine regressions.

**Decision:** Replace brittle historical-date assumptions with controlled, explicit test dates or a test clock.

Do not weaken assertions merely to make the tests pass.

## 2.2 UI must consume existing backend/planner outputs

The frontend must not independently recreate:

- Deload decisions.
- Exercise rotation decisions.
- Structural-balance calculations.
- Intensity-technique eligibility.
- Training-experience gating.
- Weekly programming decisions.

**Decision:** The backend remains the single source of truth. The UI displays, explains, and—where explicitly supported—configures existing backend behavior.

## 2.3 Prefer progressive disclosure

Coaching-depth information can be complex.

The default UI should show:

- The practical recommendation.
- A short explanation.
- Relevant details only when expanded.

Avoid exposing internal implementation terms such as scoring, penalty weights, resolver precedence, or internal state-machine details unless they are needed for debugging.

## 2.4 Do not create configuration controls without functional wiring

A setting should not appear in the UI unless:

1. It is persisted or has a defined source of truth.
2. The backend consumes it.
3. Its effect can be tested.
4. The UI clearly communicates what it changes.

---

# 3. Workstream A — Fix Stale Baseline Test Fixtures

## 3.1 Goal

Make the test suite deterministic, reproducible, and independent of the current calendar date.

The final result should distinguish:

- Genuine implementation failures.
- Intentional legacy failures, if any remain.
- Environment or dependency failures.

The target is not merely a green test command. The target is a trustworthy regression baseline.

## 3.2 Investigation

Claude should first identify all failures in the current full suite and classify them.

For each failing test, record:

- Test file and test name.
- Failure reason.
- Whether the failure depends on the current date or time.
- Whether the expected value is hardcoded.
- Whether the test relies on `Date.now()`, `new Date()`, local timezone behavior, or implicit system time.
- Whether the failure is a genuine product defect or a fixture problem.
- Proposed correction.

Create a short failure inventory before changing tests.

## 3.3 Required implementation approach

Use one consistent approach across the test suite.

Preferred order:

1. **Inject a clock or date provider** where production code already supports dependency injection.
2. **Freeze time in tests** using the project's existing test framework facilities.
3. **Use explicit relative-date fixtures** generated from a fixed test reference date.
4. Avoid direct dependence on the machine's current date, timezone, or execution time.

Do not introduce multiple competing date-mocking approaches without a strong reason.

## 3.4 Date-fixture rules

All date-dependent tests must:

- Define their reference date explicitly.
- Use the same reference date throughout the test.
- Avoid assumptions about the actual day the test is executed.
- Avoid ambiguous date strings such as `09/10/26`.
- Prefer ISO-style dates or the project's canonical date representation.
- Explicitly define timezone behavior where timestamps are involved.
- Avoid crossing daylight-saving boundaries accidentally in tests intended to be timezone-neutral.

Where a test is specifically testing timezone behavior, the timezone must be part of the test setup and assertion.

## 3.5 Regression-baseline procedure

Claude must run and record:

1. Clean dependency installation.
2. Typecheck.
3. Production build.
4. Full test suite.
5. Focused coaching-depth test suite.

The final report must include:

| Category | Result |
|---|---|
| Typecheck | Pass/fail |
| Build | Pass/fail |
| Full test suite | Passed/failed counts |
| Coaching-depth suite | Passed/failed counts |
| Remaining failures | Exact list |
| Confirmed pre-existing failures | Exact list |
| New regressions | Exact list |

If failures remain, they must be explicitly explained. Do not label failures as pre-existing without evidence.

## 3.6 Tests to add or strengthen

Add coverage for:

- Running date-dependent tests on different reference dates.
- Running tests near month boundaries.
- Running tests near year boundaries.
- Weekly schedule calculations across Sunday/Monday boundaries.
- Deload or block-state transitions across date boundaries.
- Historical workout dates versus current date.
- Timezone-sensitive timestamps, where relevant.
- Empty, missing, or malformed date fields, where supported.
- Stable behavior when the system clock changes during execution.

## 3.7 Acceptance criteria — Workstream A

- No coaching-depth test depends on the machine's current date.
- Date-dependent tests use an explicit controlled reference date or clock.
- Full-suite failures are classified and documented.
- No assertions were weakened solely to suppress failures.
- Typecheck passes.
- Build passes.
- Focused coaching-depth tests pass.
- The full suite has either:
  - No failures, or
  - A documented, reproducible list of genuine remaining failures with owners and follow-up tasks.
- A future date change must not recreate the same stale-fixture failures.

---

# 4. Workstream B — User-Facing Coaching-Depth UI

## 4.1 Goal

Expose the completed coaching-depth functionality in the application in a clear, useful, and non-technical way.

The UI should help users understand:

- Why a workout or exercise was selected.
- What the program is prioritizing.
- When recovery or deload guidance is relevant.
- Which exercise preferences and avoidances are active.
- Which structural advisories apply.
- When intensity techniques are used and why.
- Which user profile factors influence programming.

The UI is an explanation and interaction layer over existing backend behavior—not a second programming engine.

## 4.2 UI scope

The first UI pass should cover the following areas.

### A. Program overview / weekly plan

Display:

- Current training block or phase, if available.
- Whether the user is in a normal, deload, or reactive-adjustment state.
- A concise explanation of the current state.
- Active growth goals and their priority.
- A short “Why this week looks like this” explanation.

If no special state is active, show a normal-state explanation rather than an empty area.

### B. Exercise-level explanation

For each prescribed exercise, provide an expandable explanation containing relevant information such as:

- Primary target muscle(s).
- Secondary exposure, where meaningful.
- Role in the session.
- Why it was selected.
- Whether it supports a growth goal, coverage requirement, structural need, or preference.
- Whether an alternative was considered or used because of an avoidance/preference rule.

Do not expose internal scoring or implementation penalties by default.

### C. Preferences and exercise avoidance

Provide a user-facing management area for:

- Preferred exercises.
- Disliked exercises.
- Exercises to avoid.
- Relevant equipment or movement constraints, if already supported.
- Optional preference strength, only if the backend supports it.

Clearly distinguish:

- Preference: the system may favor an option.
- Avoidance: the system should not prescribe the option unless explicitly overridden by the user or required by a defined emergency/fallback rule.

Every editable field must be wired to the backend source of truth.

### D. Recovery, deload, and training-state explanation

Display:

- Current state.
- Trigger or reason in user-friendly language.
- What changes in the program because of that state.
- Expected duration or review point, if supported.
- Any user action required.

For example, distinguish between:

- Planned calendar deload.
- Reactive deload or recovery adjustment.
- Normal training with no deload active.

Do not expose raw internal trigger thresholds unless intentionally designed as an advanced-detail view.

### E. Structural-balance advisories

Display applicable advisories in a non-alarmist format:

- Advisory title.
- Affected area or relationship.
- Short explanation.
- Practical programming response.
- Severity or priority only if the backend provides a meaningful, user-safe representation.

Use wording such as “The program is adjusting…” or “Consider giving additional attention to…” rather than presenting an advisory as a medical diagnosis.

The UI must not imply injury, pathology, or clinical assessment.

### F. Intensity-technique indicators

When an intensity technique is prescribed, display:

- Technique name.
- Exercise/set context.
- A short explanation of its purpose.
- Any relevant instruction or limitation.
- A clear indication when the technique is not used.

Do not present intensity techniques as universally better. Explain them as a deliberate programming choice.

The UI should avoid encouraging users to add techniques manually beyond the prescribed plan.

### G. Individual profile factors

Display the profile information that genuinely affects programming, such as supported training-experience information.

For each active factor, show:

- Factor name.
- Current value.
- How it influences programming.
- Whether the value is user-entered, imported, or inferred.
- How to update it, if editing is supported.

Do not display unsupported profile factors as if they currently change programming.

If a factor is stored but has no current programming effect, label it clearly as informational or defer exposing it until it is functional.

---

# 5. Recommended UI Structure

Use a small number of coherent surfaces rather than many disconnected pages.

## 5.1 Recommended structure

### 1. Weekly Plan / Program Overview

Contains:

- Current block/state.
- Growth-goal summary.
- Weekly explanation.
- Recovery or deload notice.
- Link to detailed coaching information.

### 2. Exercise Details Drawer or Modal

Contains:

- Exercise role.
- Target muscles.
- Selection explanation.
- Relevant preference or constraint note.
- Intensity-technique details, if applicable.

### 3. Coaching Settings

Contains:

- Exercise preferences.
- Avoidances.
- Supported profile factors.
- Clear save/update behavior.

### 4. Coaching Insights

Contains:

- Structural-balance advisories.
- Recovery/program-state explanation.
- Programming adjustments.
- Optional advanced details.

The exact routing may follow the existing application navigation, but the concepts should remain grouped.

---

# 6. UX and Content Rules

## 6.1 Language

Use plain language.

Prefer:

- “Planned recovery week”
- “The program reduced training stress because recovery indicators met the adjustment rule”
- “This exercise was selected to improve chest coverage”
- “This movement is avoided based on your preferences”

Avoid:

- “State-machine transition”
- “Penalty resolver”
- “Prescribability failure”
- “Optimization score”
- “Fatigue vector,” unless shown in an advanced technical view.

## 6.2 Empty states

Every coaching-depth section needs a useful empty state.

Examples:

- No active advisories: “No structural advisories are active for this plan.”
- No intensity techniques: “No intensity techniques are prescribed in this session.”
- No preferences configured: “You have not added exercise preferences yet.”
- No deload active: “You are currently in a normal training state.”

## 6.3 Transparency

The UI should not claim that the system knows more than it does.

Use clear distinctions between:

- User-provided information.
- Planner-derived recommendations.
- Informational explanations.
- Optional suggestions.

## 6.4 Accessibility and responsiveness

The UI must:

- Work on desktop and mobile layouts.
- Use readable text and adequate contrast.
- Support keyboard navigation where applicable.
- Avoid relying only on color to communicate severity or state.
- Keep expanded explanations manageable on small screens.

---

# 7. Backend/API Integration Requirements

Before building each UI surface, Claude must identify the existing API or planner output that supplies the data.

For each displayed field, document:

| UI field | Backend source | Read/write | Required fallback |
|---|---|---|---|
| Current training state | Existing planner/state output | Read | Normal state |
| Deload reason | Existing periodization output | Read | No active reason |
| Exercise explanation | Existing prescription metadata | Read | Generic role explanation |
| Preferences | Existing preference API/model | Read/write | Empty preferences |
| Structural advisory | Existing advisory output | Read | No active advisory |
| Intensity technique | Existing prescription metadata | Read | No technique |
| Training experience | Existing profile model | Read/write if supported | Not set |

Do not create duplicate calculations in frontend code.

If an existing backend output lacks the information needed for a user-facing explanation, add a small presentation-oriented field or endpoint rather than reproducing the logic in the frontend.

---

# 8. Persistence and Error Handling

The UI must handle:

- Loading states.
- Save/update states.
- Failed API requests.
- Stale data.
- Missing optional fields.
- Unsupported legacy plans.
- Empty arrays.
- Unknown enum values.

For preference updates:

- Do not silently discard failed saves.
- Show a clear success or error state.
- Avoid optimistic updates unless rollback is implemented.
- Prevent duplicate submissions where relevant.

For planner explanations:

- If explanation metadata is unavailable, show a safe generic explanation.
- Never block the entire weekly plan because optional coaching metadata is missing.

---

# 9. Testing Requirements — Workstream B

## 9.1 Unit tests

Test:

- Mapping backend coaching-depth data to UI view models.
- Normal, deload, and reactive-adjustment states.
- Empty advisory/intensity/preference states.
- Unknown or missing optional values.
- Preference versus avoidance display semantics.
- Profile-factor display and edit behavior.
- Error-state mapping.

## 9.2 Component tests

Test:

- Weekly state banner.
- Exercise explanation drawer/modal.
- Preference management form.
- Structural-advisory card.
- Intensity-technique display.
- Profile-factor editor/display.
- Loading, empty, error, and success states.

## 9.3 Integration tests

Test:

- Loading a weekly plan with coaching-depth metadata.
- Opening exercise explanations from the actual plan.
- Saving preferences and confirming the updated backend state.
- Refreshing the page and retaining saved preferences.
- Displaying a deload/recovery state from planner output.
- Rendering a plan when optional coaching metadata is absent.

## 9.4 Regression tests

Confirm that:

- Existing workout generation remains unchanged.
- Existing plan display remains usable without coaching-depth metadata.
- Preferences do not bypass hard safety or programming constraints.
- UI changes do not introduce a second exercise-selection implementation.
- Existing API contracts remain backward-compatible where possible.

---

# 10. Recommended Implementation Order

## Phase B1 — Data contract and view models

1. Inventory existing planner/API outputs.
2. Define the UI-facing coaching-depth data contract.
3. Add presentation fields or endpoints only where necessary.
4. Add fallback behavior for missing metadata.
5. Add mapping tests.

## Phase B2 — Weekly plan state and explanation

1. Add current-state display.
2. Add normal/deload/reactive explanations.
3. Add growth-goal summary.
4. Add weekly “why this plan” explanation.
5. Test all states.

## Phase B3 — Exercise-level explanations

1. Add exercise details interaction.
2. Display role, target, and selection explanation.
3. Display relevant preference, avoidance, and intensity information.
4. Add loading and fallback behavior.
5. Test representative exercises and missing metadata.

## Phase B4 — Preferences and profile settings

1. Build preference-management UI.
2. Connect it to existing backend APIs.
3. Add validation and save/error states.
4. Expose only profile factors with real supported effects.
5. Test persistence and refresh behavior.

## Phase B5 — Insights and advisories

1. Add structural-balance advisory display.
2. Add intensity-technique details where not already shown.
3. Add coaching insights grouping.
4. Add empty states and plain-language explanations.
5. Test severity, absence, and unknown-value handling.

## Phase B6 — Polish and release verification

1. Responsive layout review.
2. Accessibility review.
3. Full typecheck.
4. Production build.
5. Focused UI tests.
6. Full regression suite.
7. Manual end-to-end verification using realistic user data.

---

# 11. Non-Goals

This work must not:

- Add new coaching-depth algorithms.
- Change exercise-selection rules without a separate design decision.
- Change deload thresholds or periodization behavior.
- Add unsupported profile-factor effects.
- Add medical or injury diagnoses.
- Make the UI responsible for planner decisions.
- Introduce a new AI dependency for explanations.
- Expose internal scores or implementation details by default.
- Add configuration controls that are not fully wired.
- Treat optional UI metadata as required for workout generation.

---

# 12. Final Acceptance Criteria

The next phase is complete when:

## Test baseline

- Date-dependent tests are deterministic.
- Stale historical-date failures are fixed.
- The full suite has a documented, trustworthy result.
- No new coaching-depth regressions are present.
- Typecheck and build pass.

## User-facing UI

- Users can view the current training state.
- Users can understand why the weekly plan was generated.
- Users can inspect exercise-level explanations.
- Users can manage supported exercise preferences and avoidances.
- Users can view applicable recovery/deload information.
- Users can view structural advisories in plain language.
- Users can see prescribed intensity techniques and their purpose.
- Users can view and update supported programming-relevant profile factors.
- Missing optional metadata does not break the plan.
- All editable settings are connected to real backend behavior.
- Responsive and accessibility checks are completed.

## Documentation

- The roadmap is updated from “proposed” to the correct implementation status.
- Deferred UI or backend items are listed explicitly.
- Test results and remaining failures are documented.
- Claude provides a file-by-file implementation summary.

---

# 13. Required Deliverables from Claude

1. Date-fixture failure inventory.
2. Updated deterministic test infrastructure/fixtures.
3. Updated full-suite verification report.
4. UI data-contract documentation.
5. Implemented coaching-depth UI surfaces.
6. Unit, component, and integration tests.
7. Updated roadmap and completion status.
8. Final implementation report covering:
   - Files changed.
   - Features completed.
   - Tests run and results.
   - Known limitations.
   - Deferred work.
   - Any follow-up risks.
