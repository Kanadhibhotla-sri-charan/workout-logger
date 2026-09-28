// Coaching Depth Batch 5 spec §4 (Phase 5, Intensity Techniques).
//
// This module never selects an exercise (exerciseSelector.ts's job) and
// never changes a target's sets/reps/RIR or its real primary/secondary
// exposure contribution — spec §4.7/§4.6: "The technique must not be
// represented as ordinary sets if that would distort volume, fatigue, or
// muscle-impact accounting" / "Do not allow intensity techniques to
// cause hidden volume or fatigue inflation." An applied technique is
// purely an additive annotation on an already-fully-prescribed exercise.
//
// The technique catalog itself is never invented here — it is read
// straight from Blueprint's own real, vendored `intensityTechniques`
// data (BlueprintAdapter.listIntensityTechniques()) and matched against
// Blueprint's own real per-exercise `exercise_type`/`fatigue_cost`/
// `skill_demand`/`stability_demand` fields. Only the experience-gating
// and frequency-limit POLICY layered on top (config.ts's
// INTENSITY_TECHNIQUE_POLICY) is this app's own, since Blueprint's raw
// catalog carries no such fields.

import { BlueprintAdapter } from '../blueprint/adapter.js';
import type { BlueprintIntensityTechnique, DemandLevel } from '../blueprint/types.js';
import { INTENSITY_TECHNIQUE_POLICY } from './config.js';
import type { BlueprintId } from '../contracts/types.js';
import type { TargetType } from './goalResolver.js';
import type { ExercisePreferenceLevel } from './exerciseSelector.js';

/** Coaching Depth Batch 5 spec §6.2 "Training experience": the one
 * profile factor this batch wires into a real programming effect (see
 * `ProfileFactorsRepo` — the factor name is `'training_experience'`).
 * Never inferred; only ever set by an explicit user-confirmed record. */
export type TrainingExperienceLevel = 'novice' | 'intermediate' | 'advanced';

const EXPERIENCE_RANK: Record<TrainingExperienceLevel, number> = { novice: 0, intermediate: 1, advanced: 2 };
const DEMAND_RANK: Record<DemandLevel, number> = { low: 0, medium: 1, high: 2 };

export interface AppliedIntensityTechnique {
  technique_id: string;
  name: string;
  /** Blueprint's own real explanatory text (`what`) — never an
   * app-invented instruction. */
  instruction: string;
  /** Blueprint's own real `fatigue_time_implications` text — surfaced so
   * the extra fatigue this technique adds is visible (spec §4.6: never
   * hidden), even though it is deliberately never folded into the
   * numeric fatigue/volume model (spec §4.7). */
  extra_fatigue_note: string;
  /** Which of this exercise's own prescribed working sets the technique
   * is applied to — always the LAST one (spec's own examples describe
   * a technique as a hard-stopping-point extension of a final set, never
   * a mid-session one). */
  applied_to_working_set_number: number;
}

/** Spec §12 "why was it suppressed?" — present on every technique-
 * eligible-in-principle exercise (a real Blueprint one, on a
 * physique_target), whether or not a technique was actually applied. */
export interface IntensityTechniqueEvaluation {
  /** False only when this exercise/target combination is structurally
   * outside intensity-technique scope at all (a functional_goal target,
   * or an outside-Blueprint exercise with no real Blueprint demand
   * fields to evaluate against) — spec 2.1's "functional-goal
   * protection." */
  considered: boolean;
  applied_technique_id: string | null;
  /** Null when a technique WAS applied, or when `considered` is false.
   * Otherwise the real, specific reason no technique was applied. */
  suppressed_reason: string | null;
}

export interface TechniqueCandidateItem {
  exercise_id: BlueprintId;
  target_type: TargetType;
  /** Progression-continuity protection (spec §4.5: "Exercises currently
   * used for important progression tracking unless explicitly allowed")
   * — true when `progression_decision !== null`, i.e. this is NOT the
   * exercise's first-ever prescription in this user's logged history.
   * A technique is only ever applied once genuine progression history
   * already exists for the exercise, so a brand-new variation's own
   * baseline performance is never confounded by a technique on session
   * one. */
  has_progression_history: boolean;
  preference: ExercisePreferenceLevel;
}

export interface AssignWeeklyIntensityTechniquesContext {
  /** Null when no live, user-confirmed, non-expired
   * `training_experience` profile factor exists — every technique in
   * `minimumExperienceByTechniqueId` is then ineligible (spec §2.2:
   * insufficient context, never a guessed default). */
  trainingExperience: TrainingExperienceLevel | null;
  /** Coaching Depth Batch 3's own real periodization signal
   * (`PeriodizationContext.deloadActive`) — reused directly, never a
   * second deload-detection mechanism. */
  deloadActive: boolean;
}

/** Exported for the AI Programmer context builder (rule 6 fix,
 * 2026-09-19): the exact same Blueprint-authored suitability check
 * (exercise type + fatigue/skill/stability demand ceilings), reused
 * rather than re-implemented, so "what techniques are plausible for
 * this exercise" can never drift between the deterministic engine and
 * what the AI is told. */
export function isExerciseSuitable(exerciseId: BlueprintId, technique: BlueprintIntensityTechnique): boolean {
  const exercise = BlueprintAdapter.getExercise(exerciseId);
  if (!exercise) return false; // Outside-Blueprint exercise: no real demand fields to evaluate against.
  if (!technique.suitable_exercise_types.includes(exercise.exercise_type)) return false;
  if (DEMAND_RANK[exercise.fatigue_cost] > DEMAND_RANK[technique.suitable_when_fatigue_cost_at_most]) return false;
  if (DEMAND_RANK[exercise.skill_demand] > DEMAND_RANK[technique.suitable_when_skill_demand_at_most]) return false;
  if (DEMAND_RANK[exercise.stability_demand] > DEMAND_RANK[technique.suitable_when_stability_demand_at_most]) return false;
  return true;
}

/** One real exercise's own technique eligibility, independent of any
 * weekly/session frequency budget (that is `assignWeeklyIntensityTechniques`'s
 * own job, since it is cross-exercise state). Deterministic: Blueprint's
 * own catalog order is the only tie-break. */
function evaluateEligibilityForExercise(
  item: TechniqueCandidateItem,
  context: AssignWeeklyIntensityTechniquesContext
): { technique: BlueprintIntensityTechnique | null; suppressed_reason: string | null } {
  if (item.target_type !== 'physique_target') {
    return { technique: null, suppressed_reason: null }; // `considered` is false for this case — caller handles it.
  }
  if (item.preference === 'avoided') {
    return { technique: null, suppressed_reason: 'This exercise is marked avoided in your preferences.' };
  }
  if (context.deloadActive && INTENSITY_TECHNIQUE_POLICY.disabledDuringDeload) {
    return { technique: null, suppressed_reason: 'Intensity techniques are suppressed while a deload is active.' };
  }
  if (!item.has_progression_history) {
    return { technique: null, suppressed_reason: 'No prior logged performance of this exact exercise yet — establishing a real baseline first.' };
  }

  for (const technique of BlueprintAdapter.listIntensityTechniques()) {
    if (!isExerciseSuitable(item.exercise_id, technique)) continue;
    const minimumExperience = (INTENSITY_TECHNIQUE_POLICY.minimumExperienceByTechniqueId as Record<string, TrainingExperienceLevel>)[technique.id];
    if (minimumExperience) {
      if (context.trainingExperience === null) {
        continue; // Insufficient confirmed training context — spec §2.2, never assumed.
      }
      if (EXPERIENCE_RANK[context.trainingExperience] < EXPERIENCE_RANK[minimumExperience]) continue;
    }
    return { technique, suppressed_reason: null };
  }
  return { technique: null, suppressed_reason: 'No eligible intensity technique for this exercise given its Blueprint demand profile and your confirmed training experience.' };
}

function toApplied(technique: BlueprintIntensityTechnique, workingSetNumber: number): AppliedIntensityTechnique {
  return {
    technique_id: technique.id,
    name: technique.name,
    instruction: technique.what,
    extra_fatigue_note: technique.fatigue_time_implications,
    applied_to_working_set_number: workingSetNumber,
  };
}

export interface DayTechniqueCandidates {
  date: string;
  /** Same order as the day's real final `plannedWork` — the working-set
   * count for the item at this index is supplied separately by the
   * caller via `workingSetCountByKey` so this module never needs to know
   * `PlannedWorkItem`'s own shape (mirrors exercisePairing.ts's own
   * decoupling from workoutBuilder.ts's types). */
  items: readonly TechniqueCandidateItem[];
}

/**
 * Batch 5 spec §4.4/§4.6/§4.8 + §8 step 5/6: evaluates every real
 * exercise across the whole already-finalized weekly plan for intensity-
 * technique eligibility, and applies at most
 * `INTENSITY_TECHNIQUE_POLICY.maxApplicationsPerSession` per day and
 * `maxApplicationsPerWeek` total — deterministic (days/items processed
 * in the order given, first eligible candidate each day wins), and never
 * re-applies to the same exercise twice in one week. Returns both the
 * applied techniques and every exercise's own evaluation (for the
 * `considered`/`suppressed_reason` explanation — spec §12), keyed by
 * `${date}::${exercise_id}`.
 */
export function assignWeeklyIntensityTechniques(
  days: readonly DayTechniqueCandidates[],
  workingSetCountByKey: ReadonlyMap<string, number>,
  context: AssignWeeklyIntensityTechniquesContext
): { applied: ReadonlyMap<string, AppliedIntensityTechnique>; evaluations: ReadonlyMap<string, IntensityTechniqueEvaluation> } {
  const applied = new Map<string, AppliedIntensityTechnique>();
  const evaluations = new Map<string, IntensityTechniqueEvaluation>();
  const exercisesUsedThisWeek = new Set<BlueprintId>();
  let totalApplicationsThisWeek = 0;

  for (const day of days) {
    let applicationsThisSession = 0;
    for (const item of day.items) {
      const key = `${day.date}::${item.exercise_id}`;
      if (item.target_type !== 'physique_target') {
        evaluations.set(key, { considered: false, applied_technique_id: null, suppressed_reason: null });
        continue;
      }

      const { technique, suppressed_reason } = evaluateEligibilityForExercise(item, context);

      const budgetExhausted = applicationsThisSession >= INTENSITY_TECHNIQUE_POLICY.maxApplicationsPerSession || totalApplicationsThisWeek >= INTENSITY_TECHNIQUE_POLICY.maxApplicationsPerWeek;
      const alreadyUsedThisWeek = exercisesUsedThisWeek.has(item.exercise_id);

      if (technique && !budgetExhausted && !alreadyUsedThisWeek) {
        const workingSets = workingSetCountByKey.get(key) ?? 1;
        applied.set(key, toApplied(technique, workingSets));
        evaluations.set(key, { considered: true, applied_technique_id: technique.id, suppressed_reason: null });
        applicationsThisSession += 1;
        totalApplicationsThisWeek += 1;
        exercisesUsedThisWeek.add(item.exercise_id);
      } else if (technique && (budgetExhausted || alreadyUsedThisWeek)) {
        evaluations.set(key, {
          considered: true,
          applied_technique_id: null,
          suppressed_reason: alreadyUsedThisWeek
            ? 'This exercise already received an intensity technique earlier this week.'
            : `This session/week already reached its intensity-technique limit (${INTENSITY_TECHNIQUE_POLICY.maxApplicationsPerSession}/session, ${INTENSITY_TECHNIQUE_POLICY.maxApplicationsPerWeek}/week).`,
        });
      } else {
        evaluations.set(key, { considered: true, applied_technique_id: null, suppressed_reason });
      }
    }
  }

  return { applied, evaluations };
}
