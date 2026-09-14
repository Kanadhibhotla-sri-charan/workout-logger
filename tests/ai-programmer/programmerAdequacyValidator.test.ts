// Repair: unit tests for validateProposalAdequacy — the new check that
// AI generation produces a programmatically ADEQUATE session, not just
// a structurally/domain-valid one. Deliberately range/bounds-based:
// several tests below use an exercise absent from the Blueprint
// Efficient/Complete packages entirely, to prove exercise-selection
// flexibility is untouched — only aggregate sets per target/session are
// ever inspected, never which exercise delivered them.

import { describe, expect, it } from 'vitest';
import { validateProposalAdequacy } from '../../src/ai-programmer/validation/programmerAdequacyValidator.js';
import type { AIWorkoutExerciseProposal, AIWorkoutSessionProposal } from '../../src/ai-programmer/contracts/programmerTypes.js';
import type { AIProgrammerContext, AIProgrammerMuscleGuidance, AIProgrammerProgrammingBrief } from '../../src/ai-programmer/context/programmerContextTypes.js';

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
    recommendedSessionSets: { min: 8, max: 8 },
    recoveryAdjustment: 'none',
    eligibleForThisSession: true,
    reasoning: 'test fixture',
    ...overrides,
  };
}

function contextWith(brief: AIProgrammerProgrammingBrief): AIProgrammerContext {
  return { programmingBrief: brief } as unknown as AIProgrammerContext;
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
    targetDate: '2026-09-15',
    weekday: 'tuesday',
    sessionFocus: ['test'],
    exercises,
    programmingRationale: [],
    goalAlignment: [],
    recoveryConsiderations: [],
    warnings: [],
  };
}

describe('validateProposalAdequacy', () => {
  it('accepts an adequate proposal using an exercise absent from any Blueprint package (exercise-selection flexibility preserved)', () => {
    const brief: AIProgrammerProgrammingBrief = {
      session: { purpose: 'push', expectedCoverageTargetIds: ['upper-pec', 'side-delt', 'triceps-long-head'] },
      muscles: [
        guidance({ targetId: 'upper-pec', recommendedSessionSets: { min: 6, max: 8 } }),
        guidance({ targetId: 'side-delt', recommendedSessionSets: { min: 6, max: 7 } }),
      ],
      approxSessionSetBudget: 16,
    };
    // "some-novel-machine-press" is not a real Blueprint package
    // exercise — the validator must not care, since it only inspects
    // aggregate sets per target, never exercise identity.
    const p = proposal([
      exercise({ exerciseId: 'some-novel-machine-press', targetId: 'upper-pec', sets: 7 }),
      exercise({ exerciseId: 'some-novel-raise-machine', targetId: 'side-delt', sets: 6 }),
    ]);

    const result = validateProposalAdequacy(p, contextWith(brief));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects a proposal that gives dedicated work to a target incompatible with the session identity (off-purpose)', () => {
    const brief: AIProgrammerProgrammingBrief = {
      session: { purpose: 'push', expectedCoverageTargetIds: ['upper-pec', 'side-delt', 'triceps-long-head'] },
      muscles: [
        guidance({ targetId: 'upper-pec', recommendedSessionSets: { min: 6, max: 8 } }),
        guidance({ targetId: 'side-delt', recommendedSessionSets: { min: 6, max: 7 } }),
        guidance({ targetId: 'brachialis', eligibleForThisSession: false, recommendedSessionSets: { min: 0, max: 0 } }),
      ],
      approxSessionSetBudget: 20,
    };
    const p = proposal([
      exercise({ exerciseId: 'incline-dumbbell-press', targetId: 'upper-pec', sets: 7 }),
      exercise({ exerciseId: 'cable-lateral-raise', targetId: 'side-delt', sets: 6 }),
      exercise({ exerciseId: 'hammer-curl', targetId: 'brachialis', sets: 4 }), // off-purpose, well above the small-supplementary tolerance
    ]);

    const result = validateProposalAdequacy(p, contextWith(brief));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('brachialis') && e.includes('not compatible'))).toBe(true);
  });

  it('rejects a proposal that omits an eligible active-goal target entirely', () => {
    const brief: AIProgrammerProgrammingBrief = {
      session: { purpose: 'push', expectedCoverageTargetIds: ['upper-pec', 'triceps-long-head'] },
      muscles: [
        guidance({ targetId: 'upper-pec', recommendedSessionSets: { min: 6, max: 8 } }),
        guidance({ targetId: 'triceps-long-head', isGoalOriented: true, developmentLevel: 'complete', recommendedSessionSets: { min: 8, max: 12 } }),
      ],
      approxSessionSetBudget: 20,
    };
    const p = proposal([exercise({ exerciseId: 'incline-dumbbell-press', targetId: 'upper-pec', sets: 7 })]); // triceps-long-head omitted entirely

    const result = validateProposalAdequacy(p, contextWith(brief));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('triceps-long-head') && e.includes('no direct work'))).toBe(true);
  });

  it('rejects clearly inadequate (under-prescribed) volume on a covered priority target relative to its own deterministic floor — same case the live Tuesday test actually hit', () => {
    const brief: AIProgrammerProgrammingBrief = {
      session: { purpose: 'push', expectedCoverageTargetIds: ['upper-pec', 'side-delt', 'triceps-long-head'] },
      muscles: [
        guidance({ targetId: 'upper-pec', recommendedSessionSets: { min: 8, max: 8 } }),
        guidance({ targetId: 'side-delt', recommendedSessionSets: { min: 7, max: 7 } }),
        guidance({ targetId: 'triceps-long-head', isGoalOriented: true, developmentLevel: 'complete', recommendedSessionSets: { min: 8, max: 12 } }),
      ],
      approxSessionSetBudget: 22,
    };
    // Mirrors the real diagnosed case: covered, but at 2-3 sets against
    // an ~7-8 set deterministic floor — clearly inadequate, not a
    // reasonable judgment-call deviation.
    const p = proposal([
      exercise({ exerciseId: 'incline-dumbbell-press', targetId: 'upper-pec', sets: 3 }),
      exercise({ exerciseId: 'cable-lateral-raise', targetId: 'side-delt', sets: 2 }),
      exercise({ exerciseId: 'overhead-triceps-extension', targetId: 'triceps-long-head', sets: 2 }),
    ]);

    const result = validateProposalAdequacy(p, contextWith(brief));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('upper-pec') && e.includes('inadequate'))).toBe(true);
  });

  it('accepts a valid Push proposal that allocates sets within the brief\'s ranges for every eligible target (fixture using real production numbers)', () => {
    // Real numbers from the live production brief for Tuesday 2026-09-15
    // (Push): upper-pec efficient 8-8, side-delt efficient 7-7,
    // triceps-long-head complete (active goal) 8-12.
    const brief: AIProgrammerProgrammingBrief = {
      session: { purpose: 'push', expectedCoverageTargetIds: ['upper-pec', 'side-delt', 'triceps-long-head', 'rectus-abdominis'] },
      muscles: [
        guidance({ targetId: 'upper-pec', recommendedSessionSets: { min: 8, max: 8 } }),
        guidance({ targetId: 'side-delt', recommendedSessionSets: { min: 7, max: 7 } }),
        guidance({ targetId: 'triceps-long-head', isGoalOriented: true, developmentLevel: 'complete', directSetsPerExposureCap: 12, recommendedSessionSets: { min: 8, max: 12 } }),
      ],
      approxSessionSetBudget: 26,
    };
    // Deliberately split across exercises not lifted verbatim from any
    // one Blueprint package list, to prove exercise-selection choice
    // stays free while the ALLOCATION lands correctly within range.
    const p = proposal([
      exercise({ exerciseId: 'incline-dumbbell-press', targetId: 'upper-pec', sets: 5 }),
      exercise({ exerciseId: 'incline-barbell-press', targetId: 'upper-pec', sets: 3 }), // 5+3 = 8, exactly the min/max
      exercise({ exerciseId: 'cable-lateral-raise', targetId: 'side-delt', sets: 4 }),
      exercise({ exerciseId: 'dumbbell-lateral-raise', targetId: 'side-delt', sets: 3 }), // 4+3 = 7
      exercise({ exerciseId: 'overhead-triceps-extension', targetId: 'triceps-long-head', sets: 8 }), // within 8-12
    ]);

    const result = validateProposalAdequacy(p, contextWith(brief));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects total session sets that exceed the Blueprint per-exposure cap for one target', () => {
    const brief: AIProgrammerProgrammingBrief = {
      session: { purpose: null, expectedCoverageTargetIds: [] },
      muscles: [guidance({ targetId: 'upper-pec', directSetsPerExposureCap: 8, recommendedSessionSets: { min: 6, max: 8 } })],
      approxSessionSetBudget: 8,
    };
    const p = proposal([exercise({ exerciseId: 'incline-dumbbell-press', targetId: 'upper-pec', sets: 15 })]);

    const result = validateProposalAdequacy(p, contextWith(brief));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('exceed this target\'s Blueprint per-exposure cap'))).toBe(true);
  });

  it('rejects a session where nearly all volume lands on one of 3+ present targets', () => {
    const brief: AIProgrammerProgrammingBrief = {
      session: { purpose: null, expectedCoverageTargetIds: [] },
      muscles: [
        guidance({ targetId: 'upper-pec', directSetsPerExposureCap: 20, recommendedSessionSets: { min: 1, max: 20 } }),
        guidance({ targetId: 'side-delt', directSetsPerExposureCap: 20, recommendedSessionSets: { min: 1, max: 20 } }),
        guidance({ targetId: 'triceps-long-head', directSetsPerExposureCap: 20, recommendedSessionSets: { min: 1, max: 20 } }),
      ],
      approxSessionSetBudget: 20,
    };
    const p = proposal([
      exercise({ exerciseId: 'incline-dumbbell-press', targetId: 'upper-pec', sets: 12 }),
      exercise({ exerciseId: 'cable-lateral-raise', targetId: 'side-delt', sets: 1 }),
      exercise({ exerciseId: 'overhead-triceps-extension', targetId: 'triceps-long-head', sets: 1 }),
    ]);

    const result = validateProposalAdequacy(p, contextWith(brief));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('nearly the entire session'))).toBe(true);
  });

  it('rejects total session volume that is clearly excessive relative to the deterministic time-budget guidance', () => {
    const brief: AIProgrammerProgrammingBrief = {
      session: { purpose: null, expectedCoverageTargetIds: [] },
      muscles: [guidance({ targetId: 'upper-pec', directSetsPerExposureCap: 40, recommendedSessionSets: { min: 1, max: 40 } })],
      approxSessionSetBudget: 8,
    };
    const p = proposal([exercise({ exerciseId: 'incline-dumbbell-press', targetId: 'upper-pec', sets: 20 })]); // > 2x the ~8 set budget

    const result = validateProposalAdequacy(p, contextWith(brief));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('clearly excessive volume'))).toBe(true);
  });

  it('does not require exact Blueprint package matches — an omitted eligible non-goal (Efficient) target is a legitimate choice, never flagged', () => {
    const brief: AIProgrammerProgrammingBrief = {
      session: { purpose: 'push', expectedCoverageTargetIds: ['upper-pec', 'side-delt'] },
      muscles: [
        guidance({ targetId: 'upper-pec', recommendedSessionSets: { min: 6, max: 8 } }),
        guidance({ targetId: 'side-delt', recommendedSessionSets: { min: 6, max: 7 } }), // omitted below — non-goal, must not be forced
      ],
      approxSessionSetBudget: 15,
    };
    // Only upper-pec covered; side-delt entirely skipped. Session-
    // identity coverage requires >= min(2, N) expected targets covered
    // — with only 2 expected targets total and 1 covered, this still
    // passes the coverage floor (min(2,2)=2 would fail — use a larger
    // expectedCoverageTargetIds list so 1-of-many is a legitimate,
    // non-omission choice for a NON-goal target specifically).
    const brief2: AIProgrammerProgrammingBrief = {
      ...brief,
      session: { purpose: 'push', expectedCoverageTargetIds: ['upper-pec', 'side-delt', 'front-delt', 'triceps', 'triceps-long-head'] },
      muscles: [...brief.muscles, guidance({ targetId: 'front-delt', recommendedSessionSets: { min: 4, max: 6 } })],
    };
    const p = proposal([
      exercise({ exerciseId: 'incline-dumbbell-press', targetId: 'upper-pec', sets: 7 }),
      exercise({ exerciseId: 'cable-front-raise', targetId: 'front-delt', sets: 5 }),
    ]);

    const result = validateProposalAdequacy(p, contextWith(brief2));
    expect(result.ok).toBe(true);
  });
});
