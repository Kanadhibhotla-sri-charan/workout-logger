# AI Programmer Output Contract and Validation Specification

**Document:** `AI_PROGRAMMER_OUTPUT_SCHEMA.md`  
**Status:** V1 design contract  
**Purpose:** Define the only acceptable structured output from the AI workout programmer and the validation rules required before any proposal can affect persisted programming.

---

## 1. Purpose

The AI is the workout-programming authority. It decides:

- Which valid Blueprint exercises to prescribe
- Which sessions belong on each gym day
- Exercise order
- Sets, repetitions, rep ranges, RIR, rest, and other prescription details
- How current goals, historical training, recovery, and weekly routine influence the programme
- How future programming should reconcile with completed training and user changes

The application remains responsible for:

- Supplying authoritative context
- Validating the AI response
- Rejecting malformed or unsafe proposals
- Confirming all referenced Blueprint entities exist
- Enforcing immutable historical and locked-session rules
- Applying persistence and transaction boundaries
- Recording an audit trail
- Never allowing the AI to write directly to the database

The AI output is a **proposal** until it passes application validation.

---

## 2. Contract principles

1. The response must be valid JSON.
2. The response must conform to the declared schema version.
3. Every exercise and variation must reference an authoritative Blueprint ID.
4. Names are descriptive only; IDs are authoritative.
5. A Blueprint variation is valid by definition when present in the authoritative catalogue.
6. Package membership is a reference to development and coverage, not an eligibility gate.
7. The AI must never return `no_valid_prescription` merely because an exercise is not in a package or because a package list is not an exact match.
8. Authored Blueprint prescriptions and per-session set caps must not be exceeded.
9. Completed, in-progress, locked, or explicitly protected sessions are immutable.
10. Reconciliation may propose changes only to editable future/unlocked sessions.
11. The AI must not apply equipment or time-availability filters during normal programming.
12. The AI must not create missed-set debt or carry automatic volume debt across calendar weeks.
13. Unknown IDs, invalid values, duplicate entities, and contradictory lock changes must cause rejection.
14. The application must validate before persistence.
15. The output must be deterministic in structure even though the programming decision is model-generated.

---

## 3. Top-level response envelope

The response must have this shape:

```json
{
  "schema_version": "ai-programmer-output.v1",
  "response_id": "string",
  "mode": "generate",
  "programme": {},
  "decisions": [],
  "warnings": [],
  "validation_hints": {}
}
```

### Required top-level fields

| Field | Type | Required | Description |
|---|---|---:|---|
| `schema_version` | string | Yes | Must equal `ai-programmer-output.v1` |
| `response_id` | string | Yes | Unique model-generated or provider-generated response identifier |
| `mode` | enum | Yes | `generate` or `reconcile` |
| `programme` | object | Yes | Proposed weekly programme |
| `decisions` | array | Yes | Human-readable programming decisions |
| `warnings` | array | Yes | Non-fatal warnings or uncertainty disclosures |
| `validation_hints` | object | Yes | Machine-readable summary to assist validation and auditing |

The application must not trust `validation_hints` as proof of validity. It independently validates the complete response.

---

## 4. Mode semantics

### 4.1 Generate mode

`mode: "generate"` means:

- Produce a complete proposed programme for the requested planning window.
- Include all relevant gym days in the target week.
- Include non-gym days as explicit day records where the context requires them.
- Preserve any sessions marked immutable by the input context.
- For an existing programme, generation still cannot overwrite completed, in-progress, or protected sessions.
- The output should contain a complete replacement proposal for editable future days.

### 4.2 Reconcile mode

`mode: "reconcile"` means:

- Evaluate the existing programme against actual completed training, skips, substitutions, additions, removals, goal changes, and the remaining weekly routine.
- Preserve immutable days exactly.
- Return only changes required or recommended for editable future days.
- Do not regenerate completed or in-progress sessions.
- Do not reinterpret a calendar week as a volume-reset or missed-volume-debt boundary.
- Do not create automatic make-up sessions unless explicitly supported by the supplied routine and programming rules.

In reconcile mode, the output must include a `reconciliation` object.

---

## 5. Programme object

```json
{
  "programme_id": "optional-existing-or-new-id",
  "programme_version": 1,
  "week_start": "2026-09-07",
  "week_end": "2026-09-13",
  "timezone": "Asia/Kolkata",
  "objective_summary": "string",
  "days": [],
  "weekly_summary": {}
}
```

### Fields

| Field | Type | Required | Rules |
|---|---|---:|---|
| `programme_id` | string/null | No | Existing ID when reconciling an existing programme |
| `programme_version` | integer | Yes | Non-negative integer |
| `week_start` | ISO date | Yes | Must match request context |
| `week_end` | ISO date | Yes | Must match request context |
| `timezone` | IANA timezone | Yes | Must match request context |
| `objective_summary` | string | Yes | Brief explanation of the week’s emphasis |
| `days` | array | Yes | One record per relevant day |
| `weekly_summary` | object | Yes | Summary of intended exposure and programming logic |

The application must reject a programme whose week dates differ from the requested target week.

---

## 6. Day object

```json
{
  "day_id": "2026-09-07",
  "date": "2026-09-07",
  "day_of_week": "monday",
  "activity_type": "gym",
  "status": "proposed",
  "session_title": "Upper Push",
  "focus": ["chest", "front_delts", "triceps"],
  "exercises": [],
  "day_rationale": "string",
  "preserved_from_existing": false,
  "change_reason": null
}
```

### Allowed `activity_type`

- `gym`
- `badminton`
- `rest`
- `other`
- `unavailable`

### Allowed `status`

- `proposed`
- `preserved_locked`
- `preserved_completed`
- `preserved_in_progress`
- `preserved_user_modified`
- `not_programmed`

### Rules

- A `gym` day may contain exercises.
- A `badminton`, `rest`, `other`, or `unavailable` day must not contain resistance-training exercises unless the input explicitly defines that activity as a gym-compatible session.
- A preserved day must match the immutable input record exactly, subject to canonical serialization.
- The AI cannot change a day from `preserved_*` to `proposed`.
- `preserved_locked`, `preserved_completed`, `preserved_in_progress`, and `preserved_user_modified` are application-controlled states. The AI may report them but cannot create or remove their protection.

---

## 7. Exercise prescription object

```json
{
  "prescription_id": "string",
  "exercise_id": "blueprint-exercise-id",
  "variation_id": "blueprint-variation-id",
  "display_name": "Incline Dumbbell Press",
  "order": 1,
  "role": "primary_compound",
  "target_muscles": [
    {
      "muscle_id": "upper_chest",
      "relationship": "primary",
      "emphasis": "high"
    }
  ],
  "sets": 3,
  "rep_range": {
    "min": 8,
    "max": 12
  },
  "rir": {
    "min": 1,
    "max": 3
  },
  "rest_seconds": 150,
  "tempo": null,
  "set_cap_source": "blueprint_authored",
  "goal_contributions": [
    {
      "goal_id": "goal-123",
      "contribution": "direct",
      "reason": "Provides high-quality upper-chest hypertrophy exposure."
    }
  ],
  "rationale": "string",
  "substitution_policy": "user_managed"
}
```

### Required fields

| Field | Type | Required |
|---|---|---:|
| `prescription_id` | string | Yes |
| `exercise_id` | string | Yes |
| `variation_id` | string | Yes |
| `display_name` | string | Yes |
| `order` | positive integer | Yes |
| `role` | enum | Yes |
| `target_muscles` | non-empty array | Yes |
| `sets` | positive integer | Yes |
| `rep_range` | object | Yes |
| `rir` | object | Yes |
| `rest_seconds` | non-negative integer | Yes |
| `set_cap_source` | enum | Yes |
| `goal_contributions` | array | Yes |
| `rationale` | string | Yes |
| `substitution_policy` | enum | Yes |

### Allowed exercise roles

- `primary_compound`
- `secondary_compound`
- `isolation`
- `accessory`
- `prehab`
- `skill`
- `conditioning`
- `carry`
- `core`

The role must be compatible with the authoritative Blueprint metadata where such metadata exists.

### Prescription rules

- `exercise_id` must exist in the Blueprint catalogue.
- `variation_id` must exist and belong to the referenced exercise.
- The variation must be valid according to the Blueprint catalogue.
- `display_name` must match the canonical display name after normalization, or the application must replace it with the canonical value.
- `order` values must be unique within a day and form a sequential ordering after normalization.
- `sets` must be greater than zero.
- `rep_range.min` must be less than or equal to `rep_range.max`.
- Both rep values must be positive integers.
- `rir.min` and `rir.max` must be valid non-negative values, with `rir.min <= rir.max`.
- `rest_seconds` must be within the application’s configured safe upper bound.
- `set_cap_source` must accurately identify the source of the cap.
- AI output cannot claim a Blueprint-authored cap if the authoritative catalogue does not contain one.
- The application must compare requested sets with the authoritative authored per-session cap.
- The AI must not inflate authored sets to satisfy a package target or weekly target.
- A selected exercise may be omitted from other sessions for legitimate programming reasons; omission does not imply invalidity.

---

## 8. Rep range object

```json
{
  "min": 8,
  "max": 12
}
```

Rules:

- Integer values only.
- `min >= 1`.
- `max >= min`.
- The application may enforce configurable global bounds, such as a maximum rep range, but must not silently alter the AI’s prescription. It should reject or normalize according to the configured policy.
- If the Blueprint defines an authoritative rep prescription, the AI output must remain compatible with it.

---

## 9. RIR object

```json
{
  "min": 1,
  "max": 3
}
```

Rules:

- Numeric values only.
- `min >= 0`.
- `max >= min`.
- Values must be compatible with the exercise’s authored prescription and global safety rules.
- RIR is a target, not a guarantee of actual performance.

---

## 10. Muscle target object

```json
{
  "muscle_id": "upper_chest",
  "relationship": "primary",
  "emphasis": "high"
}
```

### Allowed relationships

- `primary`
- `secondary`
- `stabilizer`
- `indirect`

### Allowed emphasis values

- `low`
- `moderate`
- `high`

Rules:

- `muscle_id` must exist in the normalized Blueprint muscle taxonomy.
- The relationship must agree with authoritative exercise metadata where available.
- The AI cannot label an anatomically unsupported muscle as primary merely to satisfy a goal.
- Secondary exposure may be meaningful and should not be discarded from weekly coverage calculations.

---

## 11. Goal contribution object

```json
{
  "goal_id": "goal-123",
  "contribution": "direct",
  "reason": "Provides direct lateral-delt hypertrophy exposure."
}
```

### Allowed contribution values

- `direct`
- `secondary`
- `supporting`
- `maintenance`
- `none`

Rules:

- Every referenced `goal_id` must exist in the supplied goal context.
- A goal contribution is explanatory metadata; it does not override exercise validity or volume limits.
- The AI must not invent goals.
- The AI should identify the contribution of priority exercises to active goals where relevant.

---

## 12. Weekly summary object

```json
{
  "intended_muscle_exposure": [
    {
      "muscle_id": "chest",
      "direct_sets": 10,
      "secondary_sets": 4,
      "exposure_sessions": 2,
      "classification": "growth"
    }
  ],
  "goal_emphasis": [
    {
      "goal_id": "goal-123",
      "priority_rank": 1,
      "emphasis_level": "high",
      "summary": "Additional direct exposure distributed across two sessions."
    }
  ],
  "recovery_notes": [
    "Heavy pressing is separated from the next direct pressing exposure."
  ],
  "tradeoffs": [
    "A lower-priority isolation movement was omitted to control redundancy."
  ]
}
```

### Rules

- Summary values are advisory and must be recomputed by the application where possible.
- The application must not trust AI-reported set totals without independently calculating them from `days[].exercises[]`.
- `classification` may be:
  - `growth`
  - `maintenance`
  - `support`
  - `not_emphasized`
- The AI must distinguish direct sets from secondary/indirect exposure.
- The summary must not imply that all secondary sets are equivalent to direct sets unless the application’s coverage model explicitly supports that conversion.

---

## 13. Decision object

```json
{
  "decision_id": "decision-1",
  "category": "exercise_selection",
  "scope": {
    "day_id": "2026-09-07",
    "exercise_id": "blueprint-exercise-id",
    "goal_id": null
  },
  "decision": "Selected incline dumbbell press instead of another valid pressing variation.",
  "reason": "Provides the required chest stimulus while reducing redundancy with the other pressing movement.",
  "confidence": "high"
}
```

### Allowed categories

- `weekly_split`
- `frequency`
- `exercise_selection`
- `volume`
- `intensity`
- `exercise_order`
- `recovery`
- `goal_emphasis`
- `maintenance`
- `reconciliation`
- `preservation`
- `warning`

### Allowed confidence values

- `high`
- `medium`
- `low`

Rules:

- Decisions must describe actual output choices.
- They must not claim unsupported facts.
- They should be concrete rather than generic.
- They must not expose hidden chain-of-thought. They should provide concise user-facing rationale, not private reasoning traces.

---

## 14. Warning object

```json
{
  "code": "limited_recent_history",
  "severity": "info",
  "message": "Recent training history is limited, so volume decisions use the available evidence and conservative progression.",
  "affected_scope": {
    "day_id": null,
    "exercise_id": null,
    "goal_id": null
  }
}
```

### Allowed severity values

- `info`
- `warning`
- `critical`

Rules:

- `critical` warnings should generally cause the application to reject persistence unless the configured policy explicitly permits a safe degraded mode.
- Warnings must not be used to bypass validation.
- Missing required authoritative Blueprint data should be a validation error, not merely an informational warning.

---

## 15. Validation hints object

```json
{
  "referenced_exercise_count": 8,
  "referenced_variation_count": 8,
  "preserved_day_count": 2,
  "editable_day_count": 5,
  "claimed_total_sets": 24,
  "requires_reconciliation_apply": false,
  "contains_uncertainty": true
}
```

The application may use these fields for diagnostics, but it must recompute all counts independently.

---

## 16. Reconciliation object

Required when `mode` is `reconcile`.

```json
{
  "base_programme_version": 12,
  "reconciliation_status": "changes_proposed",
  "preserve_days": [
    {
      "day_id": "2026-09-07",
      "reason": "Day is completed and immutable."
    }
  ],
  "editable_day_changes": [
    {
      "day_id": "2026-09-10",
      "action": "replace",
      "reason": "The prior session is still future and current goal emphasis changed.",
      "replacement_day": {}
    }
  ],
  "no_change_days": [
    {
      "day_id": "2026-09-11",
      "reason": "Existing prescription remains appropriate."
    }
  ],
  "deviations_considered": [
    {
      "type": "exercise_skipped",
      "day_id": "2026-09-07",
      "exercise_id": "blueprint-exercise-id",
      "effect_on_future_programming": "No automatic missed-set debt created."
    }
  ]
}
```

### Allowed reconciliation statuses

- `no_changes`
- `changes_proposed`
- `blocked`
- `insufficient_context`

### Allowed change actions

- `keep`
- `replace`
- `add`
- `remove`
- `modify_prescription`

Rules:

- `replace`, `add`, `remove`, and `modify_prescription` are allowed only for editable future days.
- A change targeting a completed, in-progress, locked, or user-protected day must be rejected.
- The AI cannot unlock a day.
- The AI cannot rewrite actual historical performance.
- The AI cannot convert skipped work into completed work.
- The AI cannot create automatic debt merely because planned work was missed.
- If a future day is changed, the output must include the complete resulting day record, not a vague instruction.
- The application must compare `base_programme_version` with the currently persisted version to prevent stale writes.

---

## 17. Immutable preservation rules

The input context may mark days with one of these states:

- `completed`
- `in_progress`
- `locked`
- `user_modified`
- `protected`

The output must preserve:

- Day identity
- Date
- Activity type
- Exercise identity
- Variation identity
- Exercise order
- Planned set count
- Planned rep range
- Planned RIR
- Rest
- User modifications
- Completion and lock metadata

The AI may provide a rationale for preservation but cannot alter the underlying values.

If the AI returns a changed version of an immutable day, the application must:

1. Reject the changed portion.
2. Never persist the AI’s replacement.
3. Either reject the complete response or safely discard the invalid proposal according to the configured transaction policy.
4. Record the violation in the audit log.

Recommended V1 behavior: reject the complete response and request a fresh proposal with the correct immutable context.

---

## 18. Blueprint validation rules

The application must validate every prescription against the normalized authoritative Blueprint catalogue.

### Required checks

- Exercise ID exists.
- Variation ID exists.
- Variation belongs to exercise.
- Variation is valid and selectable.
- Target muscles are valid.
- Authored set cap exists where required.
- Requested sets do not exceed authored per-session cap.
- Rep range is compatible with authored prescription.
- RIR is compatible with authored prescription.
- Any required equipment metadata is descriptive only and must not be used as a normal-generation eligibility filter.
- Package references do not act as eligibility gates.
- No valid Blueprint variation may be rejected merely because it is absent from a package’s example list.

### Invalid examples

```json
{
  "exercise_id": "does-not-exist",
  "variation_id": "unknown-variation"
}
```

Reason for rejection: unknown authoritative IDs.

```json
{
  "exercise_id": "valid-exercise",
  "variation_id": "valid-variation",
  "sets": 8
}
```

Reason for rejection: requested sets exceed the authored per-session cap.

```json
{
  "exercise_id": "valid-exercise",
  "variation_id": "valid-variation",
  "sets": 3,
  "reason": "No valid prescription because this variation is not in the package."
}
```

Reason for rejection: invalid programming rationale. Package membership is not an eligibility gate.

---

## 19. Structural validation rules

The application must reject responses that contain:

- Invalid JSON
- Missing required fields
- Additional unsupported top-level modes
- Wrong schema version
- Wrong target week
- Duplicate day IDs
- Duplicate exercise IDs within a day unless the Blueprint explicitly permits repeated exposure
- Duplicate prescription IDs
- Non-sequential exercise order
- Empty gym days without an explicit valid reason
- Exercises on rest/badminton days without contextual authorization
- Unknown enum values
- Negative sets, reps, RIR, or rest
- Non-integer values where integers are required
- Invalid dates
- Invalid timezone
- Excessive string lengths
- Null values in required fields
- Unsupported direct database instructions
- Requests to bypass application validation
- Any attempt to alter immutable days

---

## 20. Semantic validation rules

Structural validity is not sufficient. The application or a deterministic post-validator must also check:

### Weekly consistency

- The programme covers the requested week.
- Gym sessions align with the resolved weekly routine.
- Badminton and rest days are respected.
- No duplicate gym session is created for the same day.
- Weekly summaries match independently calculated totals within accepted rounding rules.

### Prescription consistency

- Selected exercises use valid Blueprint variations.
- Authored caps are respected.
- Rep and RIR values are compatible with the Blueprint.
- No exercise is prescribed with contradictory metadata.
- Exercise order is coherent enough for persistence and display.

### Goal consistency

- Active goals referenced by the AI exist.
- At most the configured number of active growth goals is treated as growth-priority context.
- Goal priority is respected.
- Maintenance areas are not accidentally treated as growth priorities.
- Goal contribution explanations match the selected exercises and target mappings.

### Recovery consistency

- The proposal does not create obvious repeated high-fatigue exposure without rationale.
- Recovery checks must use authoritative training history and the application’s configured rules.
- The validator should flag suspicious patterns rather than pretending to infer medical safety.

### Reconciliation consistency

- Actual history is not changed.
- Completed and in-progress sessions are preserved.
- Future-only changes are enforced.
- Base programme version matches the persisted version.
- No missed-set debt is introduced automatically.
- Calendar-week boundaries are not treated as mandatory volume-reset boundaries.

---

## 21. Example valid Generate response

```json
{
  "schema_version": "ai-programmer-output.v1",
  "response_id": "resp-20260907-001",
  "mode": "generate",
  "programme": {
    "programme_id": null,
    "programme_version": 1,
    "week_start": "2026-09-07",
    "week_end": "2026-09-13",
    "timezone": "Asia/Kolkata",
    "objective_summary": "Prioritize hypertrophy for the active goals while maintaining balanced whole-physique exposure and accommodating badminton.",
    "days": [
      {
        "day_id": "2026-09-07",
        "date": "2026-09-07",
        "day_of_week": "monday",
        "activity_type": "gym",
        "status": "proposed",
        "session_title": "Push",
        "focus": ["chest", "side_delts", "triceps"],
        "exercises": [
          {
            "prescription_id": "p-20260907-01",
            "exercise_id": "bp-incline-db-press",
            "variation_id": "bp-incline-db-press-standard",
            "display_name": "Incline Dumbbell Press",
            "order": 1,
            "role": "primary_compound",
            "target_muscles": [
              {
                "muscle_id": "upper_chest",
                "relationship": "primary",
                "emphasis": "high"
              },
              {
                "muscle_id": "front_delts",
                "relationship": "secondary",
                "emphasis": "moderate"
              },
              {
                "muscle_id": "triceps",
                "relationship": "secondary",
                "emphasis": "moderate"
              }
            ],
            "sets": 3,
            "rep_range": {
              "min": 8,
              "max": 12
            },
            "rir": {
              "min": 1,
              "max": 3
            },
            "rest_seconds": 150,
            "tempo": null,
            "set_cap_source": "blueprint_authored",
            "goal_contributions": [
              {
                "goal_id": "goal-upper-chest",
                "contribution": "direct",
                "reason": "Provides direct upper-chest exposure."
              }
            ],
            "rationale": "Selected as the primary press for high-quality chest stimulus with manageable overlap.",
            "substitution_policy": "user_managed"
          }
        ],
        "day_rationale": "A focused push session with direct chest and shoulder work while controlling redundant pressing fatigue.",
        "preserved_from_existing": false,
        "change_reason": null
      },
      {
        "day_id": "2026-09-08",
        "date": "2026-09-08",
        "day_of_week": "tuesday",
        "activity_type": "rest",
        "status": "not_programmed",
        "session_title": null,
        "focus": [],
        "exercises": [],
        "day_rationale": "Recovery day according to the supplied routine.",
        "preserved_from_existing": false,
        "change_reason": null
      }
    ],
    "weekly_summary": {
      "intended_muscle_exposure": [],
      "goal_emphasis": [],
      "recovery_notes": [],
      "tradeoffs": []
    }
  },
  "decisions": [
    {
      "decision_id": "decision-1",
      "category": "exercise_selection",
      "scope": {
        "day_id": "2026-09-07",
        "exercise_id": "bp-incline-db-press-standard",
        "goal_id": "goal-upper-chest"
      },
      "decision": "Selected the incline dumbbell press as the primary chest movement.",
      "reason": "It provides direct target exposure while fitting the week’s fatigue distribution.",
      "confidence": "high"
    }
  ],
  "warnings": [],
  "validation_hints": {
    "referenced_exercise_count": 1,
    "referenced_variation_count": 1,
    "preserved_day_count": 0,
    "editable_day_count": 7,
    "claimed_total_sets": 3,
    "requires_reconciliation_apply": false,
    "contains_uncertainty": false
  }
}
```

This is illustrative only. IDs and prescription values must come from the actual Blueprint catalogue at runtime.

---

## 22. Example valid Reconcile response

```json
{
  "schema_version": "ai-programmer-output.v1",
  "response_id": "resp-reconcile-20260910-001",
  "mode": "reconcile",
  "programme": {
    "programme_id": "programme-42",
    "programme_version": 13,
    "week_start": "2026-09-07",
    "week_end": "2026-09-13",
    "timezone": "Asia/Kolkata",
    "objective_summary": "Preserve completed work and adjust only remaining editable sessions based on actual training.",
    "days": [
      {
        "day_id": "2026-09-07",
        "date": "2026-09-07",
        "day_of_week": "monday",
        "activity_type": "gym",
        "status": "preserved_completed",
        "session_title": "Push",
        "focus": ["chest", "side_delts", "triceps"],
        "exercises": [],
        "day_rationale": "Preserved exactly because the session is completed.",
        "preserved_from_existing": true,
        "change_reason": null
      }
    ],
    "weekly_summary": {
      "intended_muscle_exposure": [],
      "goal_emphasis": [],
      "recovery_notes": [],
      "tradeoffs": []
    }
  },
  "decisions": [
    {
      "decision_id": "decision-preserve-1",
      "category": "preservation",
      "scope": {
        "day_id": "2026-09-07",
        "exercise_id": null,
        "goal_id": null
      },
      "decision": "Preserved the completed Monday session.",
      "reason": "Completed sessions are immutable.",
      "confidence": "high"
    }
  ],
  "warnings": [],
  "reconciliation": {
    "base_programme_version": 12,
    "reconciliation_status": "no_changes",
    "preserve_days": [
      {
        "day_id": "2026-09-07",
        "reason": "Day is completed and immutable."
      }
    ],
    "editable_day_changes": [],
    "no_change_days": [],
    "deviations_considered": [
      {
        "type": "exercise_skipped",
        "day_id": "2026-09-07",
        "exercise_id": "bp-incline-db-press-standard",
        "effect_on_future_programming": "Recorded as actual deviation; no automatic missed-set debt created."
      }
    ]
  },
  "validation_hints": {
    "referenced_exercise_count": 0,
    "referenced_variation_count": 0,
    "preserved_day_count": 1,
    "editable_day_count": 6,
    "claimed_total_sets": 0,
    "requires_reconciliation_apply": false,
    "contains_uncertainty": false
  }
}
```

---

## 23. Application-side validation pipeline

The server should validate in this order:

```text
Provider response received
        ↓
Parse JSON
        ↓
Validate top-level schema
        ↓
Validate mode and requested week
        ↓
Validate day structure
        ↓
Validate exercise/variation IDs
        ↓
Validate Blueprint prescriptions and authored caps
        ↓
Validate goals and muscle references
        ↓
Validate weekly/routine consistency
        ↓
Validate immutable/locked-session preservation
        ↓
Validate reconciliation base version
        ↓
Recompute summaries and compare
        ↓
Create normalized internal proposal
        ↓
Persist inside transaction
        ↓
Write audit record
```

A failure at any mandatory stage must prevent programme persistence.

---

## 24. Normalization policy

Before persistence, the application may normalize:

- Canonical display names from the Blueprint
- Exercise order
- Optional null fields
- Date formatting
- Enum formatting
- Whitespace
- Independently computed summary totals

The application must not silently normalize substantive programming decisions such as:

- Increasing or decreasing sets
- Changing exercise identity
- Changing variation identity
- Changing rep range
- Changing RIR
- Moving a session to another day
- Modifying an immutable day

Substantive differences must be rejected or explicitly handled by a defined repair flow.

---

## 25. Repair policy

V1 should not allow the model to self-repair through an open-ended agent loop.

Recommended behavior:

1. Make one provider request.
2. Parse and validate the response.
3. If invalid, record the validation errors.
4. Optionally make one bounded retry with a concise machine-generated correction message.
5. Validate again.
6. If still invalid, fail safely and leave persisted programming unchanged.

No recursive repair loops, tool-use loops, or autonomous agent behavior should be introduced in V1.

---

## 26. Error categories

Suggested application error codes:

| Code | Meaning |
|---|---|
| `AI_INVALID_JSON` | Provider returned non-JSON output |
| `AI_SCHEMA_MISMATCH` | Output does not conform to schema |
| `AI_WRONG_MODE` | Output mode differs from requested mode |
| `AI_WRONG_WEEK` | Output dates differ from requested week |
| `AI_UNKNOWN_EXERCISE` | Exercise ID not in Blueprint |
| `AI_UNKNOWN_VARIATION` | Variation ID not in Blueprint |
| `AI_VARIATION_OWNERSHIP_MISMATCH` | Variation does not belong to exercise |
| `AI_INVALID_PRESCRIPTION` | Prescription values are invalid |
| `AI_AUTHORED_SET_CAP_EXCEEDED` | Sets exceed authoritative Blueprint cap |
| `AI_INVALID_MUSCLE_REFERENCE` | Unknown or unsupported muscle ID |
| `AI_INVALID_GOAL_REFERENCE` | Unknown goal ID |
| `AI_IMMUTABLE_DAY_CHANGED` | Locked/completed/protected day changed |
| `AI_STALE_PROGRAMME_VERSION` | Reconciliation based on outdated programme |
| `AI_ROUTINE_CONFLICT` | Proposal conflicts with supplied routine |
| `AI_SUMMARY_MISMATCH` | Claimed summary conflicts with computed data |
| `AI_CRITICAL_WARNING` | Output contains a blocking critical warning |
| `AI_PROVIDER_TIMEOUT` | Provider timed out |
| `AI_PROVIDER_FAILURE` | Provider returned an upstream failure |

---

## 27. Audit requirements

Every accepted or rejected response should record:

- Request ID
- Response ID
- User/profile ID
- Mode
- Target week
- Provider name
- Model name
- Schema version
- Context version
- Programme base version
- Request timestamp
- Response timestamp
- Latency
- Token usage if available
- Validation result
- Validation error codes
- Hash of the context payload
- Hash of the raw response
- Whether persistence occurred
- Whether a retry occurred

Do not store API keys or other secrets in the audit record.

---

## 28. Security and trust boundaries

The AI response is untrusted external data.

The application must:

- Treat all strings as data
- Never execute code from the response
- Never execute SQL from the response
- Never allow the response to select arbitrary database tables
- Never allow the response to change user permissions
- Never allow the response to bypass lock checks
- Never allow the response to override fixed programming instructions
- Limit response size
- Apply request timeouts
- Redact secrets from logs
- Avoid including unnecessary personal or sensitive data in context

User-entered notes and historical text must also be treated as data. They cannot override the fixed constitution or validation rules.

---

## 29. V1 implementation recommendation

Use a runtime schema validator such as Zod or the project’s established validation library.

Recommended separation:

```text
AI provider response
        ↓
Raw JSON parser
        ↓
External AI output schema
        ↓
Semantic Blueprint validator
        ↓
Immutable-programme validator
        ↓
Normalized internal proposal
        ↓
Persistence adapter
```

Do not let repository persistence functions accept raw AI JSON directly. They should accept only a validated internal proposal type.

---

## 30. Definition of done

The output contract is implemented when:

- Generate and Reconcile have distinct mode semantics.
- A formal versioned schema exists.
- All required fields and enums are validated.
- Blueprint IDs and variation ownership are validated.
- Authored set caps are enforced.
- Package membership is not used as an eligibility gate.
- Completed, in-progress, locked, and protected sessions cannot be changed.
- Reconciliation rejects stale programme versions.
- Actual history cannot be modified by AI output.
- Invalid output never reaches persistence.
- At most one bounded repair attempt is possible.
- Accepted and rejected responses are auditable.
- Tests cover structural, semantic, Blueprint, lock, reconciliation, and provider-failure cases.
