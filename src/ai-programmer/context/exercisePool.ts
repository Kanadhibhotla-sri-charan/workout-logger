// Exercise pool and rotation shortlist (2026-10-09, AI_EXERCISE_POOL_MODE=wide).
//
// Problem it fixes: with only development-package exercises prescribable,
// most targets had 1-3 candidates and push/pull days repeated the same
// exercises session after session. In wide mode buildTargetContexts
// prescribes every exercise whose Blueprint primary target this is (via the
// Blueprint profile default, programmingProfiles.ts); this module then cuts
// each target's prescribed exercises down to a short, deterministic
// rotation shortlist:
//
//   - anchor: the Blueprint primary-target compound the target has most
//     recently been trained with stays on the list, so the main lift (and
//     its progression) stays stable through the block. Development packages
//     play no part in the choice (owner decision 2026-10-11: packages
//     supply volume numbers only);
//   - accessories: everything else, minus any used in both of the last two
//     comparable sessions (when an alternative exists), least recently used
//     first;
//   - at most EXERCISE_SHORTLIST_CAP per target, widened only when the
//     shortlist alone could not reach a floor the full pool could.
//
// Every downstream consumer (session planner, repair, completion,
// feasibility) already reads only exercises with an authoredPrescription,
// so clearing it on the exercises left off the shortlist makes all of them
// use the same list. Which shortlisted accessory to use stays the AI's call.
//
// It also replaces the consecutive-run repeat signal with real usage across
// the last comparable sessions (recentSameTypeUsage). Pure: returns copies.

import { BlueprintAdapter } from '../../blueprint/adapter.js';
import { LEGS_PHYSIQUE_TARGETS, PULL_PHYSIQUE_TARGETS, PUSH_PHYSIQUE_TARGETS, SESSION_PURPOSE_TARGETS, UNIVERSAL_PHYSIQUE_TARGETS } from '../../engine/config.js';
import type { SessionPurpose } from '../../engine/sessionPurpose.js';
import type { TargetBuildContext } from '../../engine/workoutBuilder.js';
import { adequacyToleranceFor } from '../validation/programmerAdequacyValidator.js';
import type { AIProgrammerContext, AIProgrammerMuscleGuidance, AIProgrammerTargetContext, AIProgrammerValidExerciseContext } from './programmerContextTypes.js';
import { computeTargetFeasibility } from './targetFeasibility.js';

/** Most exercises a target offers per session (anchors included). */
export const EXERCISE_SHORTLIST_CAP = 4;
/** How many of the most recent comparable sessions the rotation looks at. */
export const ROTATION_SESSIONS = 2;

/** True for a context built with the wide exercise pool's rotation shortlist
 * (every physique target's exercises carry recentSameTypeUsage). */
export function isWidePoolContext(context: Pick<AIProgrammerContext, 'targets'>): boolean {
  return context.targets.some((t) => t.validExercises.some((v) => v.recentSameTypeUsage !== undefined));
}

/** A past training date's session type, from the targets it directly trained:
 * legs when leg targets lead; upper when it hit at least 2 push and 2 pull
 * targets; otherwise whichever of push/pull it hit more. Dates that trained
 * only universal (abs) targets have no type. */
export function classifyTrainingDates(history: readonly TargetBuildContext[], beforeDate: string): Map<string, SessionPurpose> {
  const counts = new Map<string, { push: number; pull: number; legs: number }>();
  for (const t of history) {
    if (t.target_type !== 'physique_target') continue;
    const group = PUSH_PHYSIQUE_TARGETS.includes(t.target_id) ? 'push' : PULL_PHYSIQUE_TARGETS.includes(t.target_id) ? 'pull' : LEGS_PHYSIQUE_TARGETS.includes(t.target_id) ? 'legs' : null;
    if (!group) continue;
    for (const date of t.recent_direct_exposure_dates ?? []) {
      if (date >= beforeDate) continue;
      const c = counts.get(date) ?? { push: 0, pull: 0, legs: 0 };
      c[group]++;
      counts.set(date, c);
    }
  }
  const types = new Map<string, SessionPurpose>();
  for (const [date, c] of counts) {
    if (c.legs > 0 && c.legs >= c.push && c.legs >= c.pull) types.set(date, 'legs');
    else if (Math.min(c.push, c.pull) >= 2) types.set(date, 'upper');
    else types.set(date, c.push >= c.pull ? 'push' : 'pull');
  }
  return types;
}

/** Whether a past session of type `pastType` is comparable, for `targetId`,
 * to the session being planned (`purpose`): it must be able to train the
 * target, and be the same type — with upper counting as both push and pull. */
function isComparable(pastType: SessionPurpose, purpose: SessionPurpose, targetId: string): boolean {
  const trainsTarget = SESSION_PURPOSE_TARGETS[pastType].includes(targetId) || UNIVERSAL_PHYSIQUE_TARGETS.includes(targetId);
  if (!trainsTarget) return false;
  if (pastType === purpose) return true;
  const upperPair = (a: SessionPurpose, b: SessionPurpose) => a === 'upper' && (b === 'push' || b === 'pull');
  return upperPair(pastType, purpose) || upperPair(purpose, pastType);
}

export interface ExercisePoolInput {
  /** Real (plus projected) per-target history, as assembled for this context. */
  history: readonly TargetBuildContext[];
  targetDate: string;
  sessionPurpose: SessionPurpose | null;
  /** Programming-brief guidance computed over the FULL pool, used only to keep each shortlist as feasible as the full pool. */
  guidance: readonly AIProgrammerMuscleGuidance[];
}

/** Applies the rotation shortlist and the recent-usage signal to every
 * physique target. Functional-goal targets are returned unchanged. */
export function applyExerciseShortlist(targets: readonly AIProgrammerTargetContext[], input: ExercisePoolInput): AIProgrammerTargetContext[] {
  const dateTypes = classifyTrainingDates(input.history, input.targetDate);

  // Every exercise used on each date (a date's exercise list is spread over the targets it touched).
  const usedOn = new Map<string, Set<string>>();
  for (const t of input.history) {
    for (const [exerciseId, entries] of Object.entries(t.exercise_history)) {
      for (const e of entries) {
        if (e.date >= input.targetDate) continue;
        (usedOn.get(exerciseId) ?? usedOn.set(exerciseId, new Set()).get(exerciseId)!).add(e.date);
      }
    }
  }
  const datesDescending = [...dateTypes.keys()].sort((a, b) => b.localeCompare(a));
  const directDatesOf = (targetId: string) =>
    [...(input.history.find((h) => h.target_type === 'physique_target' && h.target_id === targetId)?.recent_direct_exposure_dates ?? [])]
      .filter((d) => d < input.targetDate)
      .sort((a, b) => b.localeCompare(a));

  return targets.map((target) => {
    if (target.targetType !== 'physique_target') return target;
    const considered = (
      input.sessionPurpose === null
        ? directDatesOf(target.targetId)
        : datesDescending.filter((d) => isComparable(dateTypes.get(d)!, input.sessionPurpose!, target.targetId))
    ).slice(0, ROTATION_SESSIONS);

    const usage = (exerciseId: string) => {
      const dates = usedOn.get(exerciseId) ?? new Set<string>();
      const lastUsedDate = [...dates].sort((a, b) => b.localeCompare(a))[0] ?? null;
      return { sessionsUsed: considered.filter((d) => dates.has(d)).length, sessionsConsidered: considered.length, lastUsedDate };
    };
    const withSignal: AIProgrammerValidExerciseContext[] = target.validExercises.map((v) => {
      const { recentConsecutiveSessionsUsed: _replaced, ...rest } = v;
      return { ...rest, recentSameTypeUsage: usage(v.exerciseId) };
    });

    const prescribed = withSignal.filter((v) => v.authoredPrescription !== null);
    // The anchor: the Blueprint primary-target compound this target has
    // most recently been trained with (most recent date, then most use in
    // the comparable sessions, then id). None until one has been used.
    const lastUsed = (v: AIProgrammerValidExerciseContext) => v.recentSameTypeUsage!.lastUsedDate;
    const anchorCandidates = prescribed
      .filter((v) => v.role === 'primary' && BlueprintAdapter.getExercise(v.exerciseId)?.exercise_type === 'compound' && lastUsed(v) !== null)
      .sort(
        (a, b) =>
          lastUsed(b)!.localeCompare(lastUsed(a)!) ||
          b.recentSameTypeUsage!.sessionsUsed - a.recentSameTypeUsage!.sessionsUsed ||
          a.exerciseId.localeCompare(b.exerciseId)
      );
    const anchors = anchorCandidates.slice(0, 1);
    const isAnchor = (v: AIProgrammerValidExerciseContext) => anchors.includes(v);
    const accessories = prescribed.filter((v) => !isAnchor(v));
    const usedInEveryConsidered = (v: AIProgrammerValidExerciseContext) =>
      considered.length === ROTATION_SESSIONS && v.recentSameTypeUsage!.sessionsUsed === ROTATION_SESSIONS;
    const rested = accessories.filter((v) => !usedInEveryConsidered(v));
    const eligible = rested.length > 0 ? rested : accessories;
    const order = (a: AIProgrammerValidExerciseContext, b: AIProgrammerValidExerciseContext) =>
      a.recentSameTypeUsage!.sessionsUsed - b.recentSameTypeUsage!.sessionsUsed ||
      (a.recentSameTypeUsage!.lastUsedDate ?? '').localeCompare(b.recentSameTypeUsage!.lastUsedDate ?? '') ||
      Number(b.role === 'primary') - Number(a.role === 'primary') ||
      prescribed.indexOf(a) - prescribed.indexOf(b);
    const ranked = [...eligible].sort(order);
    const shortlist = [...anchors, ...ranked].slice(0, Math.max(EXERCISE_SHORTLIST_CAP, anchors.length));

    // Never less feasible than the full pool: widen, in rotation order and then
    // with the rested exercises, until the shortlist reaches what the pool reaches.
    const guidance = input.guidance.find((g) => g.targetType === target.targetType && g.targetId === target.targetId);
    if (guidance) {
      const feasibleWith = (list: readonly AIProgrammerValidExerciseContext[]) =>
        computeTargetFeasibility(restrictTo(target, withSignal, list), targets, guidance.recommendedSessionSets.min, guidance.directSetsPerExposureCap, adequacyToleranceFor(guidance)).isFeasible;
      if (feasibleWith(prescribed)) {
        const reserve = [...ranked, ...accessories.filter((v) => !eligible.includes(v)).sort(order)].filter((v) => !shortlist.includes(v));
        while (!feasibleWith(shortlist) && reserve.length > 0) shortlist.push(reserve.shift()!);
      }
    }

    return { ...target, validExercises: restrictTo(target, withSignal, shortlist).validExercises };
  });
}

/** The target with only `shortlist` keeping its prescription, shortlisted
 * exercises first in shortlist order, the rest after in their original order. */
function restrictTo(
  target: AIProgrammerTargetContext,
  all: readonly AIProgrammerValidExerciseContext[],
  shortlist: readonly AIProgrammerValidExerciseContext[]
): AIProgrammerTargetContext {
  const kept = new Set(shortlist.map((v) => v.exerciseId));
  const rest = all.filter((v) => !kept.has(v.exerciseId)).map(({ prescriptionSource: _dropped, ...v }) => ({ ...v, authoredPrescription: null }));
  return { ...target, validExercises: [...shortlist, ...rest] };
}
