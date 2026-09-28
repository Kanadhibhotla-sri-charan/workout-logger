// Eval-only. Never called by the app.
//
// The brief normally tells the model to aim for the volume decision's own
// figure for the week (build-up, or hold the current volume). This override
// instead tells the model that each GOAL muscle's target for the week is its
// full package reference, to test whether a model can plan a demanding goal
// week (or defer honestly when it cannot). It changes only what the brief says;
// nothing the app persists or sends in production.

import { isTargetCompatibleWithPurpose, type SessionPurpose } from '../../engine/sessionPurpose.js';
import type { AIProgrammerMuscleGuidance, AIProgrammerProgrammingBrief } from './programmerContextTypes.js';

function isSessionPurpose(value: string | null): value is SessionPurpose {
  return value === 'push' || value === 'pull' || value === 'legs' || value === 'upper';
}

/** Returns a copy of `brief` where every goal muscle's weekly target is its
 * package reference, capped at what the week can deliver (per-exposure cap x
 * compatible sessions), with a session range that matches. Non-goal muscles are
 * untouched. `sessionPurposes` is one entry per gym day of the week. */
export function withGoalReferenceTargets(brief: AIProgrammerProgrammingBrief, sessionPurposes: readonly (string | null)[]): AIProgrammerProgrammingBrief {
  const muscles = brief.muscles.map((muscle): AIProgrammerMuscleGuidance => {
    if (!muscle.isGoalOriented || muscle.weeklyDevelopmentReference == null) return muscle;

    const compatibleSessions = Math.max(
      1,
      sessionPurposes.filter((purpose) => isSessionPurpose(purpose) && isTargetCompatibleWithPurpose(muscle.targetType, muscle.targetId, purpose)).length
    );
    const cap = muscle.directSetsPerExposureCap;
    const weekly = cap == null ? muscle.weeklyDevelopmentReference : Math.min(muscle.weeklyDevelopmentReference, cap * compatibleSessions);
    const perSession = Math.ceil(weekly / compatibleSessions);

    return {
      ...muscle,
      volumeAction: 'increase',
      recommendedWeeklyPrimarySets: weekly,
      recommendedSessionSets: { min: cap == null ? perSession : Math.min(perSession, cap), max: cap ?? Math.max(perSession, weekly) },
      reasoning: `EVAL OVERRIDE: this goal muscle's target for the week is its full package reference (${weekly} sets), not the build-up/hold figure. ${muscle.reasoning}`,
    };
  });
  return { ...brief, muscles };
}
