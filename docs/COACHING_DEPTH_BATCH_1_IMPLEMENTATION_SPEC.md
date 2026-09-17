# Coaching Depth — Batch 1 Implementation Specification

**Project:** Workout Logger / Workout Programmer  
**Batch:** 1 — Coaching Foundation  
**Phases:** Muscle-specific profiles, program-state foundation, historical trend foundation.

## 1. Objective

Upgrade the application from a primarily week-by-week workout generator into a system that can evolve programming over time.

Batch 1 establishes:

```text
Muscle Profile → Program State → Historical Observation → Future Decisions
```

This batch must not implement full periodization, automatic deloads, specialization blocks, intensity techniques, exercise rotation, supersets, or automatic programming changes based on trends.

## 2. Non-negotiable principles

1. **Blueprint remains authoritative.** Reuse canonical target IDs, exercise IDs, authored rep ranges, set guidance, development references, and package references.
2. **Reference values are not guarantees.** Preferred frequency must remain separate from actual scheduled and completed frequency.
3. **Deterministic behavior.** Frequency, rep transformations, week indices, summaries, and trend states must be calculated by code, not by an LLM.
4. **No silent data loss.** Do not drop allocations, carryover, unmet volume, completed work, or historical records.
5. **Backward compatibility.** Existing plans and users must continue to load. New fields require safe defaults.
6. **No destructive migration** unless the existing migration system requires a backward-compatible migration.

# 3. Architecture

Create three logically separate modules, adapting names to existing repository conventions:

```text
src/coaching/
  profiles/
    muscleProfileTypes
    muscleProfiles
    muscleProfileService
  programState/
    programStateTypes
    programStateService
  history/
    historicalTypes
    historicalService
    trendCalculations
```

Do not create duplicate identity, plan, or history systems.

# 4. Phase 1 — Muscle-specific programming profiles

## 4.1 Required model

Implement an equivalent of:

```ts
type RepRangeBias = "lower" | "standard" | "higher";

type MuscleProgrammingProfile = {
  targetId: string;
  preferredFrequencyPerWeek?: number;
  minimumFrequencyPerWeek?: number;
  maximumFrequencyPerWeek?: number;
  repRangeBias?: RepRangeBias;
  source: "blueprint_profile" | "default";
};
```

Use the repository’s canonical target identifier. Do not invent duplicate IDs.

Validate:

- All supplied frequencies are positive integers.
- Minimum ≤ preferred ≤ maximum.
- Invalid profiles fail validation rather than being silently corrected.

## 4.2 Initial profiles

Map these names to existing canonical target IDs:

| Target | Preferred frequency | Minimum | Maximum | Rep bias |
|---|---:|---:|---:|---|
| Rectus abdominis | 4 | 2 | 5 | higher |
| Obliques | 4 | 2 | 5 | higher |
| Gastrocnemius | 4 | 2 | 5 | higher |
| Soleus | 4 | 2 | 5 | higher |
| Forearms | 3 | 2 | 4 | standard |

If a canonical target cannot be found, report the mapping gap. Do not create a duplicate target.

## 4.3 Required functions

Implement equivalents of:

```text
getProfile(targetId)
getPreferredFrequencyReference(targetId)
getMinimumFrequencyReference(targetId)
getMaximumFrequencyReference(targetId)
getActualScheduledFrequency(targetId, plan)
getActualCompletedFrequency(targetId, history)
applyRepRangeBias(authoredMin, authoredMax, bias)
```

Rules:

- Unknown targets use safe defaults.
- No history returns `null`/unknown, not zero.
- Actual scheduled frequency comes from generated plan sessions.
- Actual completed frequency comes only from completed records.
- Preferred frequency never masquerades as actual frequency.

## 4.4 Frequency integration

Expose profile references to the existing programming/reference context.

Do not:

- Create extra training days automatically.
- Force impossible frequencies.
- Bypass session-realism caps.
- Increase actual volume solely to satisfy a reference.
- Claim four exposures when the plan contains only three.

If the current planner cannot safely consume the preference, expose it as structured context and leave scheduling unchanged. Document that limitation.

## 4.5 Rep-range bias

Rep bias must stay inside the exercise’s Blueprint-authored range.

Initial behavior:

- `standard`: preserve the authored range.
- `lower`: use the lower two-thirds of the authored range.
- `higher`: use the upper two-thirds.
- Rounding must be deterministic.
- Ranges smaller than three integer values remain unchanged.
- Never produce a value outside the authored range.
- Exercise-specific authored constraints take precedence over generic muscle bias.
- Do not apply the bias twice.

Example:

```text
Authored: 8–15
lower:    8–12
standard: 8–15
higher:   11–15
```

Document the exact formula in code and test it.

## 4.6 Precedence

Use:

1. Safety and user constraints
2. Exercise-level authored prescription
3. Target-specific authored prescription
4. Muscle profile preference
5. Generic Blueprint default

# 5. Phase 2 — Program-state foundation

## 5.1 Purpose

Create explicit persistent state for the program’s position in time, preparing the system for future periodization.

Implement an equivalent of:

```ts
type ProgramBlockKind = "base" | "development" | "deload";

type ProgramState = {
  programId: string;
  blockId: string;
  blockKind: ProgramBlockKind;
  blockStartDate: string;
  blockLengthWeeks: number;
  weekIndex: number;
  isDeload: boolean;
  stateVersion: number;
  createdAt: string;
  updatedAt: string;
};
```

Reuse existing program/plan IDs.

## 5.2 Required functions

```text
getActiveProgramState(programId)
createInitialProgramState(input)
calculateWeekIndex(blockStartDate, referenceDate, weekBoundary)
advanceProgramState(...)
resetProgramStateForNewProgram(...)
```

## 5.3 Rules

- `weekIndex` is 1-based.
- Week index is calculated from the explicit block start date.
- App-open time must not determine the week.
- Regeneration must not reset the block or week.
- `blockId` remains stable within a block.
- New programs begin at week 1, block kind `base`, and `isDeload = false`.
- Deload state is stored only; no automatic deload trigger is implemented.
- Dates must use the repository’s canonical format.
- Avoid timezone-induced date drift.

Test Sunday/Monday boundaries, month/year boundaries, timezone offsets, and regeneration on a later date.

# 6. Phase 3 — Historical trend foundation

## 6.1 Purpose

Create a read-only observation layer over completed training data. It must not automatically change programming.

## 6.2 Normalized exposure model

Implement an equivalent of:

```ts
type HistoricalExerciseExposure = {
  date: string;
  programId?: string;
  targetId: string;
  exerciseId: string;
  prescribedSets?: number;
  completedSets?: number;
  prescribedRepsMin?: number;
  prescribedRepsMax?: number;
  completedReps?: number[];
  load?: number;
  rir?: number;
  completionStatus: "completed" | "partial" | "missed" | "unknown";
};

type TargetHistoricalSummary = {
  targetId: string;
  windowStart: string;
  windowEnd: string;
  exposureCount: number;
  completedExposureCount: number;
  scheduledExposureCount: number;
  prescribedSets?: number;
  completedSets?: number;
  averageLoad?: number;
  latestExposureDate?: string;
  dataQuality: "sufficient" | "limited" | "insufficient";
};
```

Adapt names to existing domain types.

## 6.3 Missing-data rules

Missing data is not zero:

- Missing load ≠ zero load.
- Missing RIR ≠ RIR 0.
- Missing completed reps ≠ zero reps.
- Missing session ≠ missed session unless explicitly recorded.

## 6.4 Required functions

```text
getTargetHistory(targetId, startDate, endDate)
getTargetSummary(targetId, startDate, endDate)
getExerciseHistory(exerciseId, startDate, endDate)
```

Calculate:

- Scheduled exposure count
- Completed exposure count
- Prescribed sets
- Completed sets
- Completion ratio only when both values are known and prescribed sets > 0
- Latest exposure date
- Latest and previous comparable load/reps where comparison is valid

Do not combine incomparable exercises, substitutions, equipment variants, units, or unrelated rep prescriptions as one performance trend.

## 6.5 Trend states

Use:

```ts
type TrendDataQuality = "insufficient" | "limited" | "sufficient";
type BasicTrendDirection = "up" | "down" | "stable" | "unknown";
```

For Batch 1:

- `unknown` is valid.
- One bad session must not imply decline.
- Missing data must not imply stagnation.
- No trend may trigger a deload, specialization, volume change, frequency change, or exercise rotation.

Do not hard-code a 14-day window into the core service. Accept explicit date windows; a UI may choose a default later.

# 7. Integrated foundation context

Create a serializable context equivalent to:

```ts
type CoachingFoundationContext = {
  programState: ProgramState;
  targetProfiles: Record<string, MuscleProgrammingProfile>;
  scheduledFrequency: Record<string, number>;
  historicalSummaries: Record<string, TargetHistoricalSummary>;
};
```

Build it from:

1. Active program state
2. Canonical targets
3. Profile registry
4. Current generated plan
5. Historical workout records

The context must be deterministic and versionable.

Expose it to the existing AI context layer as read-only. AI must not authoritatively mutate profiles, state, frequencies, or historical metrics. Server-side values remain authoritative.

# 8. Migration strategy

- Prefer configuration/static data for the five initial profiles unless runtime editing already exists.
- Reuse existing persistence for program state.
- Add nullable/defaulted fields for old programs.
- Do not rewrite historical records.
- Do not fabricate missing historical values.
- Use adapters to map existing records into normalized exposure objects.

# 9. Exact build order

## Step 0 — Reconnaissance

Locate and document:

- Canonical target/muscle identity
- Blueprint rep and development-reference data
- Program/plan identity
- Regeneration logic
- Workout completion records
- Existing date/week calculations
- Existing AI context builder
- Any existing program-state representation

## Step 1 — Shared contracts

Add types, validation, defaults, and unit tests.

## Step 2 — Profiles

Add mappings, lookup, frequency semantics, scheduled/completed frequency, rep bias, and tests.

## Step 3 — Program state

Add creation, retrieval, week calculation, persistence, regeneration integration, and date tests.

## Step 4 — Historical adapter

Normalize records, preserve missing values, filter date windows, calculate summaries, and test data quality.

## Step 5 — Context integration

Combine profiles, state, current plan, and history. Expose read-only structured context to AI.

## Step 6 — Regression

Run typecheck, lint, unit tests, integration tests, full suite, build, and application smoke tests. Compare against a clean baseline.

# 10. Required tests

## Profiles

- Unknown target uses defaults.
- Known target returns profile.
- Invalid frequency ordering is rejected.
- Preferred frequency is not actual frequency.
- Scheduled frequency is calculated from plan sessions.
- Completed frequency uses completed records only.
- No history returns unknown/null.
- Rep bias stays within authored range.
- Small ranges remain unchanged.
- Standard preserves the range.
- Lower and higher bias are deterministic.
- Exercise-level prescription overrides profile bias.

## Program state

- New program starts at week 1.
- IDs remain stable during regeneration.
- Week index is 1-based.
- App-open time does not affect week.
- Date boundaries are deterministic.
- Timezone conversion does not shift the week.
- Old programs receive safe defaults.
- Deload state is stored but never automatically triggered.

## History

- Completed, partial, missed, and unknown records normalize correctly.
- Missing values remain missing.
- Set totals are correct.
- Completion ratio requires sufficient data.
- Date windows are correct.
- Latest exposure is correct.
- Incomparable exercises are not merged into a false trend.
- Insufficient data returns unknown.

## Integration

- Context contains all three components.
- Identical inputs produce identical context.
- Context serializes successfully.
- Regeneration preserves state.
- Existing generation behavior remains unchanged unless explicitly consuming a profile.
- Existing session-realism caps remain enforced.
- Existing allocation/carryover accounting remains unchanged.
- AI receives read-only foundation data.

# 11. Acceptance criteria

- [ ] Canonical IDs confirmed for all initial profiles.
- [ ] Profile lookup and safe defaults work.
- [ ] Reference, scheduled, and completed frequency are separate.
- [ ] Rep bias is deterministic and stays within authored ranges.
- [ ] Stable program/block identity exists.
- [ ] Week index is deterministic and regeneration-safe.
- [ ] Deload state is stored only.
- [ ] Historical records normalize without fabricated values.
- [ ] Basic summaries and data-quality states work.
- [ ] No automatic programming changes are driven by history.
- [ ] Unified foundation context exists.
- [ ] Existing tests pass apart from documented baseline failures.
- [ ] No destructive migration or unrelated feature is introduced.

# 12. Explicit non-goals

Do not implement:

- Ramping or periodization cycles
- Automatic or reactive deloads
- Specialization blocks
- Trend-driven volume/frequency changes
- Exercise rotation
- Intensity techniques
- Drop sets, rest-pause, or myo-reps
- Supersets/pairing
- Structural-balance corrections
- Training-age multipliers
- Injury inference
- Automatic goal changes
- Automatic schedule expansion
- LLM-generated numerical programming decisions

# 13. Required completion report

Report:

1. Every file added/modified.
2. Existing architecture reused.
3. Exact canonical IDs for all five profiles.
4. Where program state is stored.
5. Week-index and regeneration behavior.
6. Historical source records and missing-data behavior.
7. Comparable-exposure rules.
8. Typecheck, build, unit, integration, and full-suite results.
9. Baseline versus new failures.
10. Explicit confirmation that no automatic periodization, deload, volume change, rotation, or fabricated data was introduced.
