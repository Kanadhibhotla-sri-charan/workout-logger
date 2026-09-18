// Repair pass (2026-09-18): unit tests for repairProposal — the real
// model eval (Option B, GLM/DeepSeek/Mistral/Qwen3) found every
// responding model inflated at least one authored-prescription
// exercise's sets, and declared an ambiguous "role" the app already
// knows deterministically. This proves the three mechanical fixes
// (role, authored-value clamp, cap trim preferring non-goal exercises)
// work without ever touching a genuinely non-mechanical issue.

import { describe, expect, it } from 'vitest';
import { repairProposal } from '../../src/ai-programmer/validation/programmerProposalRepair.js';
import type { AIWorkoutExerciseProposal, AIWorkoutSessionProposal } from '../../src/ai-programmer/contracts/programmerTypes.js';
import type { AIProgrammerContext, AIProgrammerMuscleGuidance, AIProgrammerProgrammingBrief, AIProgrammerTargetContext, AIProgrammerValidExerciseContext } from '../../src/ai-programmer/context/programmerContextTypes.js';

function validExercise(overrides: Partial<AIProgrammerValidExerciseContext> & Pick<AIProgrammerValidExerciseContext, 'exerciseId' | 'role'>): AIProgrammerValidExerciseContext {
  return {
    name: overrides.exerciseId,
    equipment: [],
    authoredPrescription: null,
    plausibleIntensityTechniques: [],
    recentConsecutiveSessionsUsed: 0,
    ...overrides,
  };
}

function target(overrides: Partial<AIProgrammerTargetContext> & Pick<AIProgrammerTargetContext, 'targetId' | 'validExercises'>): AIProgrammerTargetContext {
  return {
    targetType: 'physique_target',
    displayName: overrides.targetId,
    parentRegion: null,
    isSpecialization: false,
    goalId: null,
    currentWeeklyPrimarySets: 0,
    weeklySecondarySets: 0,
    weeklyExposureUnits: 0,
    rollingExposureUnits: 0,
    rollingWindowDays: 14,
    lastTrainedDate: null,
    daysSinceLastTrainedAsOfTargetDate: null,
    exerciseHistory: {},
    recovery: { target_type: 'physique_target', target_id: overrides.targetId, priority_adjustment: 'none', reasoning: 'test', badminton_triggered: false },
    ...overrides,
  } as AIProgrammerTargetContext;
}

function guidance(overrides: Partial<AIProgrammerMuscleGuidance> & Pick<AIProgrammerMuscleGuidance, 'targetId'>): AIProgrammerMuscleGuidance {
  return {
    targetType: 'physique_target',
    developmentLevel: 'efficient',
    isGoalOriented: false,
    weeklyDevelopmentReference: 16,
    directSetsPerExposureCap: 8,
    currentWeeklyDirectSets: 0,
    currentWeeklySecondarySets: 0,
    volumeAction: 'increase',
    recommendedWeeklyPrimarySets: 8,
    recommendedSessionSets: { min: 2, max: 8 },
    recoveryAdjustment: 'none',
    eligibleForThisSession: true,
    reasoning: 'test fixture',
    antagonistGroup: null,
    ...overrides,
  };
}

function exercise(overrides: Partial<AIWorkoutExerciseProposal> & Pick<AIWorkoutExerciseProposal, 'exerciseId' | 'targetId' | 'sets'>): AIWorkoutExerciseProposal {
  return {
    role: 'primary',
    targetType: 'physique_target',
    repsMin: 8,
    repsMax: 12,
    rirMin: 1,
    rirMax: 3,
    rationale: ['test'],
    source: 'blueprint',
    ...overrides,
  };
}

function proposal(exercises: AIWorkoutExerciseProposal[]): AIWorkoutSessionProposal {
  return {
    schemaVersion: 'ai-workout-session-proposal.v1',
    proposalId: 'p-1',
    mode: 'generate_session',
    targetDate: '2026-09-21',
    weekday: 'monday',
    sessionFocus: ['test'],
    exercises,
    programmingRationale: [],
    goalAlignment: [],
    recoveryConsiderations: [],
    warnings: [],
  };
}

function contextWith(targets: AIProgrammerTargetContext[], brief: AIProgrammerProgrammingBrief): AIProgrammerContext {
  return { targets, programmingBrief: brief } as unknown as AIProgrammerContext;
}

describe('repairProposal', () => {
  it('clamps sets/reps/rir back to the authored value regardless of the model\'s own reasoning', () => {
    const context = contextWith(
      [target({ targetId: 'triceps', validExercises: [validExercise({ exerciseId: 'cable-pushdown', role: 'primary', authoredPrescription: { sets: 2, repsMin: 10, repsMax: 16, rirMin: 1, rirMax: 3 } })] })],
      { session: { purpose: null, expectedCoverageTargetIds: [] }, muscles: [guidance({ targetId: 'triceps', isGoalOriented: true })], approxSessionSetBudget: 20 }
    );
    const p = proposal([exercise({ exerciseId: 'cable-pushdown', targetId: 'triceps', sets: 7, repsMin: 10, repsMax: 16, rirMin: 1, rirMax: 3 })]);

    const repaired = repairProposal(p, context);
    expect(repaired.exercises[0]!.sets).toBe(2);
  });

  it('sets role from Blueprint\'s own truth, overwriting whatever the model declared', () => {
    const context = contextWith(
      [target({ targetId: 'obliques', validExercises: [validExercise({ exerciseId: 'cable-woodchop', role: 'primary' })] })],
      { session: { purpose: null, expectedCoverageTargetIds: [] }, muscles: [guidance({ targetId: 'obliques' })], approxSessionSetBudget: 20 }
    );
    const p = proposal([exercise({ exerciseId: 'cable-woodchop', targetId: 'obliques', sets: 2, role: 'secondary' })]);

    const repaired = repairProposal(p, context);
    expect(repaired.exercises[0]!.role).toBe('primary');
  });

  it('leaves an unknown exercise/target pair untouched — not this repair\'s job, domain validation still rejects it', () => {
    const context = contextWith(
      [target({ targetId: 'triceps', validExercises: [validExercise({ exerciseId: 'cable-pushdown', role: 'primary' })] })],
      { session: { purpose: null, expectedCoverageTargetIds: [] }, muscles: [guidance({ targetId: 'triceps' })], approxSessionSetBudget: 20 }
    );
    const p = proposal([exercise({ exerciseId: 'invented-exercise', targetId: 'triceps', sets: 9 })]);

    const repaired = repairProposal(p, context);
    expect(repaired.exercises[0]!.sets).toBe(9); // unchanged
    expect(repaired.exercises[0]!.exerciseId).toBe('invented-exercise');
  });

  it('trims non-goal targets first when the repaired session exceeds the muscle-count cap, never removing the goal-oriented one', () => {
    const targets: AIProgrammerTargetContext[] = [];
    const guidances: AIProgrammerMuscleGuidance[] = [];
    const exercises: AIWorkoutExerciseProposal[] = [];
    // 1 goal-oriented target + 9 non-goal targets = 10 distinct targets,
    // over the default (non-legs) muscle-count cap of 7.
    for (let i = 0; i < 10; i++) {
      const targetId = i === 0 ? 'goal-target' : `filler-${i}`;
      targets.push(target({ targetId, validExercises: [validExercise({ exerciseId: `ex-${i}`, role: 'primary' })] }));
      guidances.push(guidance({ targetId, isGoalOriented: i === 0 }));
      exercises.push(exercise({ exerciseId: `ex-${i}`, targetId, sets: 2 }));
    }
    const context = contextWith(targets, { session: { purpose: null, expectedCoverageTargetIds: [] }, muscles: guidances, approxSessionSetBudget: 40 });
    const p = proposal(exercises);

    const repaired = repairProposal(p, context);
    expect(new Set(repaired.exercises.map((e) => e.targetId)).size).toBe(7);
    expect(repaired.exercises.some((e) => e.targetId === 'goal-target')).toBe(true);
  });

  it('trims non-goal exercises first when the repaired session exceeds the exercise-count cap, with the muscle-count cap not itself binding', () => {
    // 2 targets only (well under the muscle cap of 7), but 10 exercises
    // total (over the exercise cap of 9) — isolates the exercise-count
    // branch specifically.
    const goalExercises = Array.from({ length: 3 }, (_, i) => exercise({ exerciseId: `goal-ex-${i}`, targetId: 'goal-target', sets: 2 }));
    const fillerExercises = Array.from({ length: 7 }, (_, i) => exercise({ exerciseId: `filler-ex-${i}`, targetId: 'filler-target', sets: 2 }));
    const context = contextWith(
      [
        target({ targetId: 'goal-target', validExercises: goalExercises.map((e) => validExercise({ exerciseId: e.exerciseId, role: 'primary' })) }),
        target({ targetId: 'filler-target', validExercises: fillerExercises.map((e) => validExercise({ exerciseId: e.exerciseId, role: 'primary' })) }),
      ],
      {
        session: { purpose: null, expectedCoverageTargetIds: [] },
        muscles: [guidance({ targetId: 'goal-target', isGoalOriented: true }), guidance({ targetId: 'filler-target', isGoalOriented: false })],
        approxSessionSetBudget: 40,
      }
    );
    const p = proposal([...goalExercises, ...fillerExercises]);

    const repaired = repairProposal(p, context);
    expect(repaired.exercises.length).toBe(9);
    expect(repaired.exercises.filter((e) => e.targetId === 'goal-target').length).toBe(3); // every goal exercise kept
  });
});
