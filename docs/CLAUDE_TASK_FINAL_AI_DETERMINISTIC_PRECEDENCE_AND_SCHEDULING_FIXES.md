# Final AI–Deterministic Workout Precedence and Scheduling Fixes

## Purpose

This specification addresses the remaining issues identified during the review of the latest Workout Logger / AI Workout Programmer vertical slice.

The goal is to preserve deterministic programming as the authoritative baseline while allowing AI-assisted workout generation and schedule adjustments without creating conflicting prescriptions, duplicate planned workouts, or inconsistent UI state.

---

## 1. Establish a Single Planned Workout per User/Day

### Problem

The AI `fill_existing_gym_day` commit flow can create an AI-generated planned workout while a deterministic `program_sessions` prescription already exists for the same user and date.

The current conflict check primarily examines planned rows in `workout_sessions`. It may therefore fail to detect a deterministic prescription stored separately in `program_sessions`.

This can result in:

- Two workouts being presented for the same day.
- The deterministic prescription and AI-generated workout competing for authority.
- `/today`, `/week`, and the logger displaying different workouts.
- Ambiguous completion and progress attribution.

### Required fix

The system must enforce a single **selected planned workout** for each user/date.

When an AI workout is committed for a date that already has a deterministic prescription, the implementation must explicitly choose one of these supported behaviors:

1. **AI replacement/supersession**
   - The AI-generated workout becomes the selected workout for that date.
   - The deterministic prescription remains stored as the baseline/history if needed.
   - The API/UI must expose only the AI workout as the active planned workout.
   - The relationship should be represented explicitly, for example:
     - `supersedesProgramSessionId`
     - `source = ai`
     - `selected = true`

2. **AI enrichment of deterministic prescription**
   - The AI does not create a competing workout.
   - It fills or modifies the existing deterministic prescription.
   - The resulting workout retains a clear link to the deterministic source.

Do not allow two independent active planned workouts for the same user/date.

### Acceptance criteria

- A date with a deterministic prescription and an AI commit has exactly one selected planned workout.
- `/today` returns the selected workout only.
- `/week` displays the same selected workout.
- The logger opens the same selected workout.
- Completion updates the selected workout and does not accidentally complete a hidden competing workout.
- The original deterministic prescription remains recoverable when the product requires auditability or rollback.

---

## 2. Define Planned-Session Precedence Explicitly

### Problem

The codebase now has multiple possible sources of a workout:

- Deterministic `program_sessions`.
- AI-generated `workout_sessions`.
- Existing/completed workout records.
- Potentially manually adjusted or swapped sessions.

Without an explicit precedence rule, different endpoints may select different records.

### Required fix

Define and implement one shared precedence rule for selecting the workout shown to the user.

Recommended precedence:

1. Completed/in-progress workout for the requested date, when applicable.
2. Explicitly selected AI or manually adjusted planned workout.
3. Deterministic `program_sessions` prescription.
4. Rest day or no planned workout.

The exact ordering may vary if the existing product model requires it, but it must be:

- Documented.
- Centralized.
- Used consistently by `/today`, `/week`, logger initialization, workout detail, and completion flows.

### Required implementation guidance

Create or reuse a single resolver/service, such as:

```text
resolveSelectedSession(userId, date)
```

The resolver should return:

- Selected session ID.
- Session source.
- Activity type.
- Planned/completed/in-progress status.
- Source prescription ID, if applicable.
- Supersession or replacement metadata, if applicable.

Avoid duplicating selection logic independently across routes.

---

## 3. Clarify `prescriptionPolicy: reuse`

### Problem

The current `prescriptionPolicy: reuse` behavior reuses the target day's existing prescription but does not necessarily search the rest of the week for a prescription that could be moved into that day.

For example, moving a Thursday Gym prescription to Wednesday may not be equivalent to reusing Wednesday's prescription.

### Required fix

Document `reuse` precisely:

> `reuse` means use the prescription already assigned to the target date. It does not search for, move, or borrow a prescription from another date.

If the product needs to move a prescription from one date to another, that must use an explicit move/swap operation.

### Acceptance criteria

- `reuse` never silently relocates another day's prescription.
- If the target day has no reusable prescription, the operation returns a clear result.
- The UI does not describe `reuse` as a schedule move.
- Move/swap operations explicitly identify source and target dates.

---

## 4. Distinguish Swap, Move, and Regenerate

### Problem

Schedule adjustment and workout generation are different operations, but the API and UI concepts can become mixed.

### Required definitions

#### Swap

Exchange the scheduled activities or prescriptions of two dates.

Example:

```text
Monday Gym  <->  Wednesday Rest
```

A pure swap must not invoke the LLM or regenerate exercises.

#### Move

Move a specific prescription/activity from one date to another while defining what happens to the source date.

Example:

```text
Move Thursday Gym to Wednesday.
Thursday becomes Rest or receives the displaced Wednesday activity.
```

The source-date behavior must be explicit.

#### Regenerate

Create a new workout prescription or exercise selection for a date.

Regeneration may invoke AI, but it must not be triggered implicitly by a simple schedule swap.

### Acceptance criteria

- Swap is deterministic and does not call the LLM.
- Move has explicit source and target semantics.
- Regenerate is separately identified and auditable.
- API responses identify which operation occurred.
- Logs/telemetry distinguish `swap`, `move`, and `regenerate`.

---

## 5. Define Movable Session Ownership

### Problem

A schedule operation needs to know which record owns the activity being moved or swapped.

Potential sources include:

- Weekly deterministic schedule.
- `program_sessions`.
- AI-created planned sessions.
- Existing completed sessions.
- Manual adjustments.

### Required fix

Define ownership rules.

Recommended rules:

1. Future, unstarted deterministic sessions are movable.
2. Future, unstarted AI/manual planned sessions are movable if they are selected.
3. In-progress sessions are not movable.
4. Completed sessions are not moved retroactively.
5. A date with a completed session may not be silently overwritten by a schedule operation.
6. If a deterministic prescription is superseded by AI, the selected/superseding record owns the user-facing schedule for that date.

### Acceptance criteria

- The operation rejects ambiguous ownership.
- The operation does not move completed or in-progress workouts.
- The response identifies the moved record and its source.
- Historical workout records remain unchanged.

---

## 6. Make the Normal Activity Endpoint's Regeneration Policy Explicit

### Problem

The normal activity/schedule endpoint may accept activity changes, but it is not always clear whether changing an activity:

- Only changes the schedule.
- Reuses an existing prescription.
- Regenerates exercises.
- Invokes AI.
- Creates a new planned session.

### Required fix

Document and enforce the behavior for each mode.

Recommended model:

```text
schedule-only:
  Change activity/date assignment.
  Do not regenerate exercises.

reuse:
  Use an existing target-date prescription.
  Do not generate a new exercise list.

regenerate:
  Create a new prescription/exercise list.
  May invoke AI or deterministic generation according to policy.
```

The endpoint must reject unsupported combinations rather than silently falling back.

### Acceptance criteria

- The API response reports the effective policy.
- `reuse` does not silently become `regenerate`.
- Schedule-only operations do not invoke the LLM.
- Regeneration is explicit and traceable.
- Errors explain why a requested policy cannot be fulfilled.

---

## 7. Preserve Active-Session Safety

The current implementation correctly rejects changing an active planned session away from Gym in protected cases. Keep and expand this behavior.

### Required invariants

- An in-progress workout cannot be converted into Rest.
- An in-progress workout cannot be moved to another date.
- A completed workout cannot be overwritten by a schedule adjustment.
- A selected active workout cannot be replaced without an explicit, supported replacement flow.
- Schedule changes must not alter historical exercise logs, sets, reps, or completion timestamps.

Add regression tests for all protected states.

---

## 8. Align `/today`, `/week`, and Logger Behavior

### Problem

The weekly UI now exposes `plannedSession`, but all views must use the same selection and precedence rules.

### Required fix

Ensure the following surfaces resolve the same selected workout:

- `/today`
- `/week`
- Workout detail
- Logger entry/open flow
- Completion flow
- Daily summary/progress view

The UI should not show:

- Rest in one view and AI Gym in another.
- A deterministic workout in one view and an AI replacement in another.
- A stale workout after a swap or move.
- Two selectable workouts for one date unless the product explicitly supports alternatives.

### Acceptance criteria

For every date:

```text
selected workout in /today
=
selected workout in /week
=
workout opened by logger
=
workout completed by logger
```

When no workout is selected, all views should consistently show Rest or Unplanned.

---

## 9. Simplify User-Facing API Concepts

### Problem

The implementation exposes several related concepts:

- `swap`
- `move`
- `activity`
- `prescriptionPolicy`
- AI intent
- Reuse/regenerate
- Planned-session source

These are useful internally but can become confusing in the UI.

### Required fix

Keep the user-facing actions simple:

- **Swap days**
- **Move workout**
- **Generate workout**
- **Use existing workout**
- **Keep current workout**

Map these actions to explicit internal operations.

Do not make users understand internal database distinctions such as `program_sessions` versus `workout_sessions`.

---

## 10. Normalize Verification and Test Counts

### Problem

The review materials reported inconsistent test totals, including different counts such as 1,096 and 1,084 tests.

This may be caused by:

- Different commands.
- Cached/generated tests.
- Environment differences.
- Test discovery changes.
- Documentation not being updated.

### Required fix

Run verification from a clean environment:

```bash
npm ci
npm run verify
```

If the project uses another canonical command, document it and use it consistently.

Record:

- Exact command.
- Test count.
- Pass/fail result.
- Date of verification.
- Any intentionally excluded suites.

Update README/review notes so all references use the canonical result.

### Acceptance criteria

- One canonical verification command is documented.
- Test counts in documentation match the latest clean run.
- No claim of “all tests passing” is made without specifying the command/environment.

---

## 11. Required Regression Test Matrix

### A. Deterministic and AI precedence

- Deterministic prescription exists; AI commit targets same date.
- AI commit supersedes deterministic prescription.
- AI commit enriches deterministic prescription.
- `/today` returns one selected workout.
- `/week` returns the same selected workout.
- Logger opens the selected workout.
- Completion updates the selected workout only.

### B. Reuse behavior

- `reuse` with an existing target-date prescription.
- `reuse` with no target-date prescription.
- `reuse` when another date has a prescription.
- Confirm that `reuse` does not move another date's prescription.
- Confirm that unsupported fallback to regeneration is rejected.

### C. Swap behavior

- Gym ↔ Rest swap.
- Gym ↔ Gym swap.
- Rest ↔ Rest swap.
- Swap does not invoke LLM.
- Swap preserves exercise lists.
- Swap does not alter completed history.
- Swap rejects in-progress protected sessions.

### D. Move behavior

- Move future deterministic Gym session.
- Move future AI-selected Gym session.
- Move with explicit source-date result.
- Move when target date is occupied.
- Move when source date is completed.
- Move when source date is in progress.
- Move with no unambiguous owner.

### E. Regeneration behavior

- Explicit regeneration invokes the intended generator.
- Regeneration creates one selected workout.
- Regeneration records source and provenance.
- Regeneration does not create duplicate active sessions.
- Regeneration is not triggered by swap or schedule-only operations.

### F. UI consistency

- `/today` and `/week` agree after AI commit.
- `/today` and `/week` agree after swap.
- `/today` and `/week` agree after move.
- Logger and `/today` open the same session.
- Rest/Gym labels remain consistent.
- Stale data is invalidated or refreshed after schedule changes.

---

## 12. Required Invariants

The implementation should enforce these invariants at the service or database level where practical:

1. At most one selected planned workout exists for a user/date.
2. Every selected planned workout has a valid source/provenance.
3. A completed or in-progress workout cannot be silently rescheduled.
4. A pure swap never regenerates exercises.
5. `reuse` never silently means `regenerate`.
6. AI commits cannot create an orphan competing workout.
7. `/today`, `/week`, logger, and completion use the same session resolver.
8. Historical workout logs are immutable through schedule operations.
9. Every move/swap/regenerate operation is auditable.
10. The user-facing schedule always has one unambiguous interpretation.

---

## Definition of Done

This work is complete when:

- The selected-workout precedence rule is documented and centralized.
- AI commits cannot create competing active workouts beside deterministic prescriptions.
- `reuse`, `swap`, `move`, and `regenerate` have explicit semantics.
- Ownership and protected-state rules are enforced.
- `/today`, `/week`, and logger show and operate on the same workout.
- Regression tests cover mixed deterministic/AI cases and schedule changes.
- Verification is run from a clean environment and documented consistently.
- No duplicate selected planned workouts can be produced by supported API flows.
