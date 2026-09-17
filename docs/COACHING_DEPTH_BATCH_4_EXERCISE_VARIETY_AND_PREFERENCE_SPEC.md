# Batch 4 — Exercise Variety & Preference

## Scope

Batch 4 combines:

- **Phase 6a — Exercise Rotation**
- **Phase 6b — Exercise Pairing**
- **Phase 9 — Exercise Preference and Avoidance**

These features belong in the exercise-selection layer, primarily `exerciseSelector.ts` or its equivalent. Phase 9 is bundled because preferences and avoidance directly constrain the candidate pool used by rotation and pairing.

## Objective

The system must:

1. Rotate eligible exercises over time without unnecessary repetition.
2. Pair exercises only when the pairing is compatible and useful.
3. Respect explicit user preferences and avoidance rules.
4. Preserve productive exercise continuity when appropriate.
5. Remain deterministic, explainable, and compatible with existing Blueprint rules.

## Non-Negotiable Priorities

Selection priority must remain:

1. Safety and explicit restrictions
2. Locked session or exercise requirements
3. Required muscle and movement coverage
4. Active goal priorities
5. Exercise eligibility and equipment constraints
6. Explicit avoidance
7. Programming quality and fatigue compatibility
8. Rotation and variety
9. Soft preferences
10. Deterministic tie-breaker

Variety or preference must never override safety, required coverage, active goals, locked sessions, or existing session constraints.

## Included

- History-aware exercise rotation
- Exercise-family repetition handling
- Rotation cooldown or repetition penalties
- Exercise pairing and compatibility checks
- Preference, dislike, avoidance, and temporary-exclusion rules
- Candidate ranking and conflict resolution
- Selection explanations
- Persistence/API/UI changes where required
- Tests, migration, and documentation

## Excluded

- Rebuilding the exercise library
- Redefining Blueprint muscle ownership
- Changing authored rep ranges
- Replacing the fatigue model
- Automatic goal creation
- Automatic specialization selection
- Medical or injury diagnosis
- Uncontrolled random selection
- Forcing rotation during locked sessions
- Replacing the entire workout planner

## 1. Preference and Avoidance Model

Support these conceptual categories:

| Category | Effect |
|---|---|
| Preferred | Positive ranking influence |
| Neutral | Normal ranking |
| Disliked | Negative ranking influence |
| Avoided | Excluded from normal selection |
| Temporarily unavailable | Excluded until expiry |
| Equipment unavailable | Excluded in the current environment |
| Locked | Preserved unless explicitly changed |

### Rules

- Explicitly avoided exercises must not enter normal candidate pools.
- Temporary exclusions must support expiration or clearing.
- Avoidance must not be bypassed by fallback or pairing logic.
- Preferences influence ranking only when the exercise remains eligible.
- A preference cannot override safety, required coverage, active goals, or locked state.
- If constraints make a target impossible, return a clear diagnostic rather than silently violating a rule.
- Do not infer explicit avoidance from one skipped exercise.

## 2. Exercise Rotation

### Rotation objective

Reduce unnecessary repetition while preserving productive continuity.

Rotation must avoid:

- Selecting the same exercise every session when suitable alternatives exist.
- Switching exercises so frequently that progression becomes difficult.
- Rotating away from an exercise required for an active goal.
- Treating every variation as entirely unrelated when it belongs to the same exercise family.
- Forcing a weaker alternative solely for novelty.

### Rotation inputs

Consider:

- Exact exercise and exercise family
- Target muscles and movement pattern
- Recent completed-session history
- Consecutive appearances
- Sessions since last use
- Current block or phase
- Progression status
- Active goals
- Preferences and avoidance
- Equipment availability
- Locked or required status

### Rotation process

1. Build the eligible candidate pool.
2. Apply safety, equipment, availability, and avoidance filters.
3. Preserve locked and required exercises.
4. Evaluate target and movement-pattern coverage.
5. Protect exercises with important progression continuity.
6. Apply recent-use and exercise-family repetition penalties.
7. Apply preference ranking.
8. Select deterministically.
9. Record the reason and any cooldown bypass.

Rotation cooldowns must be configurable, context-aware, and bypassed when no valid alternative exists.

## 3. Exercise Pairing

### Pairing objective

Pair exercises only when doing so improves session organization or time efficiency without compromising performance, fatigue management, or coverage.

### Pairing inputs

Consider:

- Primary and secondary muscle targets
- Movement pattern
- Compound/isolation classification
- Fatigue overlap
- Exercise order
- Required rest
- Equipment practicality
- Session goals
- User preferences and avoidance
- Whether the exercise is already assigned to another pair

### Compatibility requirements

A pair is valid only when:

- Both exercises are individually eligible.
- Neither is explicitly avoided.
- The pair does not violate session limits.
- Fatigue overlap is acceptable.
- The pair does not compromise a priority exercise.
- Equipment requirements are compatible.
- The pairing type is supported.
- The exercises are not duplicates.
- Required muscle coverage remains intact.

### Pairing priority

1. Explicit user-requested pairing
2. Required session structure
3. Compatible complementary or antagonist relationship
4. Low interference and manageable fatigue overlap
5. Equipment practicality
6. Preference compatibility
7. Variety benefit
8. Deterministic tie-breaker

If no valid pair exists, leave exercises unpaired. Never force an incompatible pair.

## 4. Combined Selection Pipeline

Use this order:

1. Resolve session and target requirements.
2. Build eligible candidates.
3. Apply safety, equipment, and availability filters.
4. Apply explicit avoidance filters.
5. Preserve locked and required exercises.
6. Evaluate muscle and movement-pattern coverage.
7. Apply progression-continuity protection.
8. Apply rotation penalties or cooldown logic.
9. Apply preference ranking.
10. Select exercises deterministically.
11. Evaluate pairing opportunities.
12. Validate the final session.
13. Produce explanation metadata.

Pairing must operate only on individually eligible selections.

## 5. Scoring and Tie-Breaking

If scoring is used, centralize and document it.

| Factor | Effect |
|---|---|
| Eligibility and safety | Mandatory gate |
| Required coverage | Strong positive |
| Active goal relevance | Strong positive |
| Locked/required status | Mandatory preservation |
| Progression continuity | Positive when appropriate |
| Recent repetition | Negative when alternatives exist |
| Exercise-family repetition | Moderate negative |
| Explicit preference | Positive |
| Soft dislike | Negative |
| Pairing compatibility | Positive during pairing |
| Equipment practicality | Positive |
| Deterministic tie-breaker | Final ordering |

Avoid unexplained magic numbers distributed across selector branches.

## 6. Persistence and Migration

Reuse existing workout history wherever possible.

Potential persisted data:

- Exercise preference records
- Avoidance records
- Temporary exclusion records
- Preference source/reason
- Expiration date
- Selection history metadata, only if not derivable from workout logs

For existing users:

- Default unspecified exercises to neutral.
- Do not infer explicit preferences from historical omissions.
- Initialize new fields safely and idempotently.
- Do not duplicate existing exercise history unnecessarily.

## 7. API and UI

Where required, support:

- Add/remove preference
- Add/remove avoidance
- Set/clear temporary exclusion
- List active rules
- Explain why an exercise was selected
- Explain why an exercise was excluded
- Explain why rotation or pairing was skipped

The UI should let users manage preferences clearly and understand when a preference could not be honored because of a higher-priority constraint.

Example explanations:

> This exercise was selected because it satisfies the target, remains eligible, and has not been used recently.

> Your preferred exercise was not selected because it would repeat the same movement pattern too frequently.

> Pairing was skipped because the remaining exercises would create excessive fatigue overlap.

## 8. Blueprint and Planner Integration

The implementation must preserve:

- Blueprint-authored muscle targets
- Existing muscle-impact and fatigue accounting
- Active goal priorities
- Functional-goal protection
- Session exercise and target limits
- Locked sessions
- Exercise eligibility
- Authored rep ranges
- Existing safety and equipment rules

Rotation must not remove required coverage. Avoidance must not silently create uncovered targets. If coverage becomes impossible, return a diagnostic.

## 9. Testing Requirements

### Preference tests

- Preferred exercises rank higher when eligible.
- Avoided exercises are excluded.
- Temporary exclusions expire correctly.
- Avoided exercises cannot reappear through fallback or pairing.
- Conflicts resolve deterministically.
- Preferences cannot override safety or required coverage.

### Rotation tests

- Recent repetition is penalized when alternatives exist.
- No rotation occurs when no valid alternative exists.
- Required and locked exercises are protected.
- Progression continuity can outweigh variety.
- Exercise-family repetition is handled correctly.
- Cooldown behavior is deterministic.
- Missing or incomplete history is handled safely.
- Identical inputs produce identical output.

### Pairing tests

- Compatible pairs are formed.
- Incompatible pairs are rejected.
- Excessive fatigue overlap blocks pairing.
- Equipment incompatibility blocks pairing.
- Avoided exercises cannot enter a pair.
- Exercises are not paired more than once.
- Pairing does not violate session limits.
- No valid pair leaves exercises unpaired.

### Regression tests

Verify that neutral users retain existing behavior and that Blueprint, goal, fatigue, volume, safety, locked-session, and session-limit rules remain intact.

## 10. Observability

For each selection, expose or log where practical:

- Target requirement
- Candidate pool size
- Excluded candidates and reasons
- Recent-use information
- Rotation adjustment
- Preference adjustment
- Progression-continuity adjustment
- Pairing evaluation
- Final selection reason
- Fallback or bypass reason

This must make it possible to explain why an exercise was selected, excluded, rotated, or left unpaired.

## 11. Acceptance Criteria

- [ ] Phases 6a, 6b, and 9 are implemented as one coherent selection-layer enhancement.
- [ ] Selection is deterministic.
- [ ] Explicit avoidance is respected.
- [ ] Preferences influence ranking without overriding higher-priority rules.
- [ ] Rotation reduces unnecessary repetition without forcing inferior substitutions.
- [ ] Required, locked, and goal-critical exercises are protected.
- [ ] Exercise-family repetition is handled intentionally.
- [ ] Pairing is compatibility- and fatigue-aware.
- [ ] Incompatible pairs are never forced.
- [ ] Rotation and pairing preserve Blueprint coverage.
- [ ] Existing goal, safety, fatigue, volume, and session constraints remain intact.
- [ ] Preference management and explanations are available where required.
- [ ] Migration is safe and idempotent.
- [ ] Full regression tests pass.
- [ ] Documentation is updated.

## 12. Implementation Order

1. Inspect `exerciseSelector.ts` and related selection code.
2. Identify existing history, preference, exclusion, pairing, and constraint structures.
3. Define the preference and avoidance model.
4. Implement candidate filtering and conflict resolution.
5. Implement history-aware rotation.
6. Implement progression-continuity protection.
7. Implement pairing compatibility and fallback.
8. Integrate preference ranking with rotation.
9. Integrate the selector with the planner.
10. Add explanations and debugging metadata.
11. Add persistence/API/UI changes.
12. Add unit, integration, and regression tests.
13. Update documentation and provide a verification report.

## Deliverables

Claude should provide:

1. Updated exercise-selection logic.
2. Rotation and history integration.
3. Pairing compatibility and fallback logic.
4. Preference and avoidance support.
5. Persistence/migration changes.
6. API/UI changes where required.
7. Explanation and debugging metadata.
8. Tests covering the acceptance criteria.
9. Updated documentation.
10. A report listing changed files, rules implemented, tests run, and known limitations.
