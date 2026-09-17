# Batch 5 — Programming Enrichment

## Scope

Batch 5 combines:

- **Phase 5 — Intensity Techniques**
- **Phase 7 — Structural Balance Advisories**
- **Phase 8 — Individual Profile Factors**

These features do not share one primary mechanism, but they are bundled to reduce implementation batch count. They must remain modular internally, with clear boundaries between prescription enrichment, structural analysis, and individual-context adjustments.

The implementation must enhance programming without replacing the existing Blueprint, goal-priority, exercise-selection, fatigue, volume, safety, or session-constraint systems.

---

## 1. Objective

Add three controlled enrichment layers:

1. **Intensity techniques** for appropriate exercises and goals.
2. **Structural balance advisories** that identify meaningful imbalances or coverage concerns.
3. **Individual profile factors** that allow relevant user-specific characteristics to influence programming within safe, explainable limits.

The output must remain deterministic, explainable, and subordinate to existing programming constraints.

---

## 2. Design Principles

### 2.1 Enrichment, not replacement

These features enrich the existing prescription pipeline. They must not replace:

- Blueprint-authored muscle targets
- Active growth-goal priorities
- Existing exercise eligibility
- Existing fatigue and muscle-impact accounting
- Existing volume limits
- Existing session constraints
- Locked sessions
- Functional-goal protection
- User safety restrictions

### 2.2 Conservative defaults

If the system lacks sufficient evidence or user-specific information:

- Use the standard prescription.
- Do not infer a condition or limitation.
- Do not apply an intensity technique.
- Do not issue a strong structural warning.
- Do not alter programming based on uncertain profile data.

### 2.3 Explainability

Every enrichment decision should be traceable:

- What rule was evaluated?
- What data supported it?
- What change was made?
- Why was the change allowed?
- Why was a possible change rejected?

### 2.4 Separate advisory from prescription behavior

Structural balance analysis should primarily produce advisories. It must not silently rewrite the program unless a specific, documented rule authorizes the change.

Individual profile factors may influence ranking, dosage, exercise suitability, or advisory language only through explicit rules.

---

## 3. Functional Scope

### Included

- Intensity-technique eligibility and prescription
- Technique-specific guardrails
- Structural balance analysis
- Structural advisory generation
- Individual profile-factor model
- Profile-factor validation and precedence
- Planner integration
- API/UI visibility
- Persistence and migration where needed
- Tests, documentation, and debugging metadata

### Excluded

- Automatic diagnosis of injuries or medical conditions
- Medical treatment recommendations
- Automatic specialization selection
- Rewriting the Blueprint
- Unbounded intensity-technique use
- Automatic major program changes from a single measurement
- Unverified biomechanical claims
- Replacing the fatigue or volume model
- Making profile assumptions from stereotypes or missing data

---

## 4. Phase 5 — Intensity Techniques

### 4.1 Objective

Allow selected intensity techniques to be prescribed when they are appropriate for the exercise, target, training context, and user configuration.

Intensity techniques must be treated as optional programming tools, not default requirements.

### 4.2 Technique model

Represent an intensity technique explicitly.

Potential conceptual fields:

| Field | Purpose |
|---|---|
| `technique_id` | Stable identifier |
| `name` | User-facing name |
| `category` | Technique category |
| `eligible_exercise_types` | Allowed exercise categories |
| `eligible_muscles` | Optional target restrictions |
| `minimum_training_context` | Required experience or program state |
| `fatigue_cost` | Relative fatigue classification |
| `risk_level` | Internal safety classification |
| `default_frequency_limit` | Maximum use frequency |
| `required_equipment` | Equipment requirements |
| `contraindications` | Explicit exclusions |
| `progression_behavior` | How progression is handled |
| `explanation_template` | User-facing rationale |

Use the project's existing terminology and data structures where available.

### 4.3 Candidate techniques

Only implement techniques explicitly supported by the roadmap and current application design.

Examples may include, if approved by the existing specification:

- Drop sets
- Rest-pause sets
- Myo-reps
- Mechanical drop sets
- Other controlled advanced-set methods

Do not add techniques merely because they are common in bodybuilding literature.

### 4.4 Eligibility rules

A technique may be considered only when:

- The exercise is individually eligible.
- The exercise is technically suitable for the technique.
- The target is appropriate.
- The user has sufficient training context, if required.
- The technique does not conflict with the current block or deload state.
- The technique does not violate fatigue or session limits.
- The technique is not prohibited by user restrictions.
- The technique has not exceeded its frequency or fatigue budget.
- The exercise is not locked in a way that prevents modification.

### 4.5 Exercise suitability

Prefer techniques for exercises where fatigue and execution can be controlled.

Avoid automatically applying advanced techniques to:

- Exercises where failure or extended fatigue creates disproportionate safety concerns
- Exercises requiring high technical precision under fatigue
- Exercises currently used for important progression tracking unless explicitly allowed
- Exercises restricted by the user
- Exercises during deloads unless the policy explicitly permits a reduced technique form

### 4.6 Frequency and fatigue limits

Intensity techniques must have centralized limits.

The system should track, where needed:

- Technique uses per session
- Technique uses per week
- Technique uses per muscle
- Technique uses per exercise
- Recent technique exposure
- Additional fatigue cost
- Interaction with current block and deload state

Do not allow intensity techniques to cause hidden volume or fatigue inflation.

### 4.7 Prescription representation

The output must clearly distinguish:

- Standard working sets
- Technique-modified sets
- Additional reps or mini-sets
- Rest instructions
- Termination conditions
- Progression rules

The technique must not be represented as ordinary sets if that would distort volume, fatigue, or muscle-impact accounting.

### 4.8 Deload interaction

During scheduled or reactive deloads:

- Disable intensity techniques by default.
- Allow only explicitly approved low-stress exceptions.
- Ensure the deload reduction is not negated by technique use.
- Explain when a technique was suppressed because of deload state.

---

## 5. Phase 7 — Structural Balance Advisories

### 5.1 Objective

Identify meaningful structural or programming-balance concerns using available training data, measurements, and Blueprint relationships.

The feature should provide useful advisories without presenting uncertain conclusions as facts.

### 5.2 Advisory categories

Potential categories include:

- Muscle-group development imbalance
- Push/pull or movement-pattern imbalance
- Excessive emphasis relative to maintenance coverage
- Underrepresented muscle or movement pattern
- Repeated omission of a target
- Asymmetry requiring user review
- Measurement trend requiring attention

Only categories supported by the project roadmap and available data should be implemented.

### 5.3 Evidence requirements

An advisory should require sufficient evidence, such as:

- Repeated training-history patterns
- Consistent measurement differences
- Persistent coverage gaps
- Multiple review points
- User-reported observations
- Relevant Blueprint relationships

A single measurement or isolated session should not create a strong advisory.

### 5.4 Advisory severity

Use descriptive levels rather than a simplistic overall score.

Possible levels:

- `INFO`
- `WATCH`
- `REVIEW`

Avoid presenting an advisory as a diagnosis or definitive physical conclusion.

### 5.5 Advisory output

Each advisory should include:

- Advisory ID
- Category
- Severity
- Evidence used
- Time window
- Confidence or evidence strength, if supported
- Affected muscles or movement patterns
- Explanation
- Suggested review action
- Whether the advisory affects prescription
- Timestamp

### 5.6 Prescription interaction

By default, advisories should not directly alter the program.

If a documented rule permits an adjustment:

1. Validate it against Blueprint coverage.
2. Validate it against active goals.
3. Validate it against fatigue and volume limits.
4. Validate it against session constraints.
5. Record the adjustment and rationale.
6. Ensure the user can understand the change.

Do not automatically convert every advisory into extra volume.

---

## 6. Phase 8 — Individual Profile Factors

### 6.1 Objective

Allow relevant individual characteristics to influence programming when the user has explicitly provided reliable information or when the application has a clearly supported source.

### 6.2 Profile-factor categories

Potential categories include:

- Training experience
- Available equipment
- Schedule and session duration
- Exercise preferences
- Movement restrictions
- Recovery constraints
- Experience with advanced techniques
- Goal context
- User-confirmed limitations
- Relevant anthropometric information

Only use factors that are supported by the current product requirements and data model.

### 6.3 Data quality

Each profile factor should have:

- Factor name
- Value
- Source
- User-confirmed status
- Created/updated date
- Optional confidence or reliability status
- Expiration/review date where appropriate

Do not treat inferred or stale information as equivalent to a current user-confirmed restriction.

### 6.4 Precedence

Profile factors must follow this precedence:

1. Safety and explicit restrictions
2. Locked sessions or exercises
3. Required coverage and active goals
4. Equipment and availability
5. User-confirmed profile factors
6. Programming-quality rules
7. Soft preferences
8. Variety and tie-breakers

A profile factor cannot silently override a higher-priority constraint.

### 6.5 Profile-factor effects

A factor may affect:

- Exercise eligibility
- Exercise ranking
- Technique eligibility
- Session duration decisions
- Rest or density recommendations
- Advisory wording
- Progression context
- Review cadence

Effects must be explicit and bounded.

### 6.6 No unsupported inference

Do not infer:

- Medical conditions
- Injury diagnoses
- Hormonal status
- Genetic traits
- Recovery capacity as a fixed biological fact
- Exercise unsuitability from body measurements alone
- Psychological characteristics

When information is missing, use neutral defaults.

---

## 7. Combined Integration Architecture

Keep the three phases modular:

1. **Base planner** generates the normal Blueprint-constrained prescription.
2. **Profile context layer** supplies validated individual factors.
3. **Structural analysis layer** evaluates training and measurement data and produces advisories.
4. **Intensity-technique layer** evaluates eligible exercises and applies approved techniques.
5. **Final validation layer** checks all existing constraints again.
6. **Explanation layer** reports every enrichment decision.

Do not embed all three feature sets directly into one large conditional branch.

---

## 8. Ordering and Conflict Resolution

Recommended order:

1. Resolve user, program, goal, and session context.
2. Load validated profile factors.
3. Generate the standard Blueprint-constrained prescription.
4. Evaluate structural advisories independently.
5. Evaluate intensity-technique eligibility.
6. Apply approved technique modifications.
7. Recalculate affected fatigue, volume, and muscle impact.
8. Apply any explicitly permitted profile-factor adjustments.
9. Revalidate all constraints.
10. Produce user-facing explanations and diagnostics.

Structural advisories should remain independent from intensity-technique selection unless a documented rule explicitly connects them.

---

## 9. API and UI Requirements

### API

Expose, where required:

- Available intensity techniques
- Technique eligibility and selection reason
- Current technique exposure and limits
- Structural advisories
- Advisory evidence and severity
- Profile factors
- Profile-factor source and confirmation state
- User controls to add, update, review, or remove supported profile factors

### UI

The user should be able to:

- Understand when an intensity technique was used.
- See why it was selected.
- See when a technique was suppressed.
- Review structural advisories without being presented with unsupported certainty.
- Review and edit relevant profile factors.
- Understand which factors are user-confirmed.
- See when a profile factor affects programming.

Avoid alarming language for structural advisories.

---

## 10. Persistence and Migration

Reuse existing structures where possible.

Potential persisted data:

- Intensity-technique configuration
- Technique exposure history, if not derivable
- Structural advisory records or snapshots
- Profile-factor records
- Source and confirmation metadata
- Review/expiration dates

Migration requirements:

- Existing users receive safe defaults.
- No intensity techniques are automatically enabled without an explicit policy.
- Existing users are not assigned inferred medical or physical restrictions.
- Missing profile data must not block workout generation.
- Initialization must be idempotent.
- Historical data must not be duplicated unnecessarily.

---

## 11. Testing Requirements

### 11.1 Intensity-technique tests

Test:

- Eligible exercises can receive supported techniques.
- Ineligible exercises never receive them.
- Frequency and fatigue limits are enforced.
- Techniques are disabled during deloads by default.
- Technique use does not violate session limits.
- Technique-modified sets are represented correctly.
- Fatigue and volume accounting remains accurate.
- Locked exercises are not modified improperly.
- Repeated planner calls do not duplicate technique application.
- Selection is deterministic.

### 11.2 Structural-advisory tests

Test:

- Insufficient evidence produces no strong advisory.
- A single measurement does not trigger a strong warning.
- Persistent coverage gaps can produce an advisory.
- Evidence windows are correct.
- Missing data is not treated as negative evidence.
- Advisory severity is deterministic.
- Advisories do not silently alter programming.
- Any permitted adjustment is fully revalidated.
- Advisory explanations include supporting evidence.

### 11.3 Profile-factor tests

Test:

- User-confirmed factors are loaded correctly.
- Stale or expired factors are handled correctly.
- Explicit restrictions take precedence.
- Profile factors do not override required coverage or locked sessions.
- Missing factors use safe defaults.
- Unsupported inferences are not created.
- Profile-factor effects are bounded and explainable.

### 11.4 Integration tests

Test:

- Intensity techniques interact correctly with periodization and deload state.
- Structural advisories coexist with normal programming.
- Profile factors influence only supported parts of the pipeline.
- Fatigue, volume, and muscle-impact accounting remain consistent.
- Existing Blueprint and goal-priority behavior remains intact.
- Existing exercise-selection behavior remains intact unless an enrichment rule applies.

### 11.5 Regression tests

Run the full existing test suite and verify that existing users with neutral/default settings receive unchanged programming outside the new features.

---

## 12. Observability and Debugging

For each enrichment decision, capture where practical:

- Feature and rule evaluated
- Input data/source
- Eligibility result
- Applied or rejected change
- Constraint that allowed or blocked it
- Resulting prescription impact
- User-facing explanation
- Timestamp and program/block context

Debugging must make it possible to answer:

- Why was an intensity technique used?
- Why was it suppressed?
- Why was an advisory generated?
- Why was an advisory not generated?
- Which profile factor affected the result?
- Was fatigue/volume accounting updated correctly?
- Did final validation reject an enrichment?

---

## 13. Acceptance Criteria

- [ ] Phases 5, 7, and 8 are implemented as modular enrichment layers.
- [ ] Intensity techniques are optional, bounded, and eligibility-driven.
- [ ] Intensity techniques are disabled by default during deloads.
- [ ] Technique use does not distort volume or fatigue accounting.
- [ ] Structural advisories require sufficient evidence.
- [ ] Advisories are descriptive and do not imply medical diagnosis.
- [ ] Advisories do not silently rewrite the program.
- [ ] Profile factors require supported, validated data.
- [ ] Explicit restrictions and higher-priority programming rules remain authoritative.
- [ ] Unsupported inferences are not created.
- [ ] All enrichment decisions are deterministic and explainable.
- [ ] API/UI surfaces expose relevant state and explanations.
- [ ] Migration is safe and idempotent.
- [ ] Full regression tests pass.
- [ ] Documentation is updated.

---

## 14. Implementation Order

1. Inspect existing planner, fatigue, volume, profile, measurement, and advisory structures.
2. Define the shared enrichment interfaces and precedence rules.
3. Implement validated profile-factor loading.
4. Implement structural analysis and advisory generation.
5. Implement intensity-technique definitions and eligibility checks.
6. Implement technique exposure and fatigue safeguards.
7. Integrate approved enrichment into the planner.
8. Recalculate affected accounting and run final validation.
9. Add API/UI visibility and explanations.
10. Add persistence and migration.
11. Add unit, integration, and regression tests.
12. Update documentation and provide a verification report.

---

## 15. Non-Negotiable Constraints

- Do not treat intensity techniques as mandatory.
- Do not apply advanced techniques during deloads by default.
- Do not hide technique-induced fatigue or volume.
- Do not generate strong structural conclusions from weak evidence.
- Do not present advisories as medical diagnoses.
- Do not silently convert advisories into extra volume.
- Do not infer unsupported individual characteristics.
- Do not allow profile factors to override safety, goals, Blueprint boundaries, or locked sessions.
- Do not alter authored rep ranges without an explicit approved rule.
- Do not create duplicate sources of truth for history, measurements, or profile data.

---

## 16. Deliverables

Claude should deliver:

1. Intensity-technique model and eligibility logic.
2. Technique exposure and fatigue safeguards.
3. Structural balance analysis and advisory system.
4. Validated individual profile-factor model.
5. Planner integration and final validation.
6. Persistence/migration changes.
7. API/UI changes where required.
8. Explanation and debugging metadata.
9. Tests covering all acceptance criteria.
10. Updated documentation.
11. A concise implementation report listing:
   - Files changed
   - Intensity-technique rules
   - Structural-advisory rules
   - Profile-factor rules
   - Precedence and conflict handling
   - Migration details
   - Tests run
   - Known limitations
