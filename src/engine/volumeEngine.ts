// Volume Engine — Next Phase spec §8-13.
//
// §8: Blueprint's weekly-volume guidance is a reference range, never an
// automatic prescription. §9: starting volume builds up gradually
// ("build up rather than jump to the Blueprint upper range") regardless
// of priority — priority is explicitly NOT a volume multiplier (§2.2:
// "priority... does not directly determine volume"); its role is
// resource allocation (src/engine/resourceAllocation.ts), not sets math.
// §10: maintain is the default; an increase requires the current
// workload to have been tolerated, recovery to be acceptable, the goal
// to not be progressing sufficiently, AND every other explanation from
// §11's checklist to have been ruled out. §11: stagnation always
// introspects before adding volume — this module CANNOT verify most of
// that checklist itself (exercise selection quality, redundancy,
// compound overlap, time/equipment fit — those live in exerciseSelector,
// constraintEngine, frequencyEngine), so it never authorizes an increase
// from stagnation alone; the caller must explicitly confirm the
// checklist was walked (`introspection_confirmed_no_other_explanation`).
// §12: declining progress + poor recovery never triggers an automatic
// reduction — this module surfaces 'introspect_needed', it never
// returns a reduction on its own initiative. §13: aesthetic outcome
// (not performance) drives the decision.
//
// "Direct/primary sets" (TrainingExposure.primary_sets), never
// exposure_units or total_sets, is what gets compared against
// Blueprint's weekly_volume ranges — see docs/VOLUME_ENGINE.md for why.

import { BlueprintAdapter } from '../blueprint/adapter.js';
import type { BlueprintId } from '../contracts/types.js';
import type { TargetType } from './goalResolver.js';
import { PROGRESSION_INCREMENTS } from './config.js';
import { daysBetween } from './dateMath.js';
import type { DevelopmentReference } from './developmentReferenceEngine.js';

export type AestheticProgressTrend = 'improving' | 'stagnant' | 'declining' | 'insufficient_data';

/**
 * Spec §3: a dated 1-5 assessment IS already a directional signal
 * (1/2 = worse, 3 = no meaningful change, 4/5 = improved) — this app's
 * own ASSESSMENT_SCALE labels, not a new interpretation invented here.
 * Returns 'insufficient_data' when there is no assessment, or the most
 * recent one is stale (more than twice the goal's own recommended
 * review_cadence_days old — a [DEFAULT] staleness margin, since §3
 * warns against reacting to "a single noisy observation" and a stale
 * reading is exactly that).
 */
export function classifyAestheticTrend(
  mostRecentAssessment: { rating: 1 | 2 | 3 | 4 | 5; date: string } | null,
  asOfDate: string,
  reviewCadenceDays: number
): AestheticProgressTrend {
  if (!mostRecentAssessment) return 'insufficient_data';
  if (daysBetween(mostRecentAssessment.date, asOfDate) > reviewCadenceDays * 2) return 'insufficient_data';
  if (mostRecentAssessment.rating >= 4) return 'improving';
  if (mostRecentAssessment.rating === 3) return 'stagnant';
  return 'declining';
}

export type VolumeAction = 'maintain' | 'increase' | 'introspect_needed';

export interface VolumeDecisionInput {
  target_type: TargetType;
  target_id: BlueprintId;
  /** Surfaced only for reasoning/explainability — never used
   * arithmetically here (§2.2: priority does not directly determine
   * volume; see resourceAllocation.ts for where priority actually
   * matters). */
  goal_priority: number;
  /** This target's current weekly direct/primary completed sets — see
   * TrainingExposure.primary_sets. */
  current_weekly_primary_sets: number;
  aesthetic_progress_trend: AestheticProgressTrend;
  /** Whether recoveryEngine has flagged this target with a 'reduce' or
   * 'avoid' signal recently — the caller aggregates that, this module
   * just consumes the conclusion. */
  recovery_ok: boolean;
  /** Only relevant when aesthetic_progress_trend === 'stagnant'. Set
   * true only after the caller has actually walked the §11 checklist
   * (exercise selection, redundancy, execution evidence, frequency,
   * compound overlap, time/equipment constraints) and confirmed none of
   * them explain the stagnation. This module has no way to verify that
   * itself — it doesn't have exerciseSelector's, frequencyEngine's, or
   * constraintEngine's data — so it never authorizes an increase from
   * stagnation alone without this being explicitly asserted true
   * (§11, §25: "do not automatically increase volume"). */
  introspection_confirmed_no_other_explanation?: boolean;
  /** Programming Redesign (Step 12) §3-§5: this target's own Blueprint
   * development-package weekly direct-set reference (Complete for an
   * active-goal/specialization target, Efficient otherwise — see
   * developmentReferenceEngine.ts). When present with a non-null
   * `weekly_direct_set_reference`, this REPLACES the universal
   * global-principles bands below as both the initial build-up target
   * and the ceiling on further increases — a muscle-specific reference
   * point, never a rigid quota (§1 rules #7-#8: still just informs the
   * decision, never dictates it). Null/absent falls back to the
   * pre-existing universal bands unchanged (e.g. every functional_goal,
   * which has no Blueprint development package at all).
   */
  development_reference?: DevelopmentReference | null;
}

export interface VolumeDecision {
  target_type: TargetType;
  target_id: BlueprintId;
  action: VolumeAction;
  recommended_weekly_primary_sets: number;
  blueprint_reference_range: {
    min: number;
    max: number;
    label: 'starting_point' | 'practical_range' | 'higher_recovery_dependent' | 'blueprint_package_reference' | 'missing_physique_package';
  };
  /** Populated only when action === 'introspect_needed' — the exact
   * §11 (stagnation) or §12 (decline/recovery) checklist item names,
   * for a caller/UI to walk and then set
   * introspection_confirmed_no_other_explanation. */
  introspection_checklist: string[] | null;
  reasoning: string;
}

const STAGNATION_CHECKLIST = [
  'exercise selection',
  'relevant exposure',
  'redundancy',
  'execution/progression evidence',
  'frequency',
  'compound overlap/dominance',
  'time/equipment constraints',
  'recovery',
  'whether current volume is actually insufficient',
];

const DECLINE_CHECKLIST = [
  'recent load',
  'recent volume',
  'overlap',
  'frequency',
  'badminton workload',
  'session intensity',
  'schedule',
  'time',
  'recovery indicators',
  'repeated performance decline',
];

/** Programming Redesign (Step 12) §3-§5: when `developmentReference`
 * carries a real, target-specific weekly_direct_set_reference, THAT
 * number (this exact muscle's own Blueprint package data) is the
 * reference range — replacing the universal starting_point/
 * practical_range/higher_recovery_dependent bands, which are the same
 * three numbers for every muscle regardless of which one it is. Falls
 * back to those universal bands unchanged when no target-resolution
 * context exists at all, or for a functional_goal (which has no
 * Blueprint development package BY DESIGN — see
 * developmentReferenceEngine.ts).
 *
 * Recovery+Fallback Fix §2: a physique_target is different — Blueprint
 * simply not having grouped it into a muscle_group yet is a genuinely
 * MISSING package, not a legitimate "no package expected" case like a
 * functional_goal. The universal bands are still the only numbers this
 * module has to offer here (no redesign of the volume system), but they
 * are never silently labeled as if they were this target's own
 * development reference — the distinct 'missing_physique_package' label
 * makes that explicit for any caller/route/test that inspects it. */
function referenceRangeFor(currentSets: number, developmentReference?: DevelopmentReference | null): VolumeDecision['blueprint_reference_range'] {
  if (developmentReference?.weekly_direct_set_reference != null) {
    const r = developmentReference.weekly_direct_set_reference;
    return { min: r, max: r, label: 'blueprint_package_reference' };
  }

  const { starting_point_sets, practical_range_sets, higher_recovery_dependent_sets } = BlueprintAdapter.getGlobalPrinciples().weekly_volume;
  const isMissingPhysiquePackage = developmentReference?.target_type === 'physique_target';
  if (currentSets < practical_range_sets[0]) {
    return { min: starting_point_sets[0], max: starting_point_sets[1], label: isMissingPhysiquePackage ? 'missing_physique_package' : 'starting_point' };
  }
  if (currentSets <= practical_range_sets[1]) {
    return { min: practical_range_sets[0], max: practical_range_sets[1], label: isMissingPhysiquePackage ? 'missing_physique_package' : 'practical_range' };
  }
  return {
    min: higher_recovery_dependent_sets[0],
    max: higher_recovery_dependent_sets[1],
    label: isMissingPhysiquePackage ? 'missing_physique_package' : 'higher_recovery_dependent',
  };
}

/**
 * The §8-13 weekly-volume decision for one target. Never invents a
 * number outside Blueprint's own weekly_volume ranges and this app's
 * already-configured PROGRESSION_INCREMENTS; never authorizes an
 * increase without either "no existing volume yet" (§9's build-up case)
 * or an explicit introspection confirmation (§11); never itself returns
 * a reduction (§12) — only 'introspect_needed', because picking the
 * actual modification (reduce/redistribute/change exercise/deload/...)
 * needs data this module doesn't have.
 */
export function decideVolume(input: VolumeDecisionInput): VolumeDecision {
  const referenceRange = referenceRangeFor(input.current_weekly_primary_sets, input.development_reference);
  const { starting_point_sets } = BlueprintAdapter.getGlobalPrinciples().weekly_volume;

  // §9: starting volume. No existing direct work on this target yet —
  // build up gradually to the conservative low end, never jump to the
  // upper range, regardless of goal priority (§2.2). Programming
  // Redesign (Step 12) §3: when this target has its own Blueprint
  // package reference, the starting point is never higher than that
  // muscle's own reference either — never Blueprint's universal number
  // for a muscle whose own package recommends starting lower.
  if (input.current_weekly_primary_sets === 0) {
    const packageRef = input.development_reference?.weekly_direct_set_reference;
    const startingSets = packageRef != null ? Math.min(starting_point_sets[0], packageRef) : starting_point_sets[0];
    return {
      target_type: input.target_type,
      target_id: input.target_id,
      action: 'increase',
      recommended_weekly_primary_sets: startingSets,
      blueprint_reference_range: referenceRange,
      introspection_checklist: null,
      reasoning:
        packageRef != null
          ? `No existing direct weekly volume for this target — starting at ${startingSets} sets/week (the lower of Blueprint's ` +
            `conservative universal starting point and this target's own ${input.development_reference!.level} package reference of ` +
            `${packageRef} sets/week), never jumping to the upper range regardless of goal priority (spec §9).`
          : `No existing direct weekly volume for this target — starting at Blueprint's conservative starting point ` +
            `(${starting_point_sets[0]} sets/week), never jumping to the upper range regardless of goal priority (spec §9).`,
    };
  }

  // §13: aesthetic outcome is the top-level signal.
  if (input.aesthetic_progress_trend === 'improving' || input.aesthetic_progress_trend === 'insufficient_data') {
    return {
      target_type: input.target_type,
      target_id: input.target_id,
      action: 'maintain',
      recommended_weekly_primary_sets: input.current_weekly_primary_sets,
      blueprint_reference_range: referenceRange,
      introspection_checklist: null,
      reasoning:
        input.aesthetic_progress_trend === 'improving'
          ? 'Aesthetic progress is improving — maintain is the default even when performance data alone might suggest more (§10, §13).'
          : 'No recent (or no non-stale) aesthetic assessment to justify a change — maintaining current volume rather than acting on insufficient evidence.',
    };
  }

  if (input.aesthetic_progress_trend === 'declining') {
    return {
      target_type: input.target_type,
      target_id: input.target_id,
      action: 'introspect_needed',
      recommended_weekly_primary_sets: input.current_weekly_primary_sets,
      blueprint_reference_range: referenceRange,
      introspection_checklist: DECLINE_CHECKLIST,
      reasoning:
        'Aesthetic progress is declining — spec §12 requires inspecting recent load/volume/overlap/frequency/badminton workload/' +
        'session intensity/schedule/time/recovery indicators/repeated decline BEFORE any modification; this module does not ' +
        'auto-reduce volume, it surfaces the checklist for the caller (or a human) to walk.',
    };
  }

  // aesthetic_progress_trend === 'stagnant'
  if (!input.recovery_ok) {
    return {
      target_type: input.target_type,
      target_id: input.target_id,
      action: 'introspect_needed',
      recommended_weekly_primary_sets: input.current_weekly_primary_sets,
      blueprint_reference_range: referenceRange,
      introspection_checklist: DECLINE_CHECKLIST,
      reasoning: 'Aesthetic progress is stagnant AND recovery is flagged — cannot justify adding volume when recovery signals are unfavorable (§12).',
    };
  }

  if (!input.introspection_confirmed_no_other_explanation) {
    return {
      target_type: input.target_type,
      target_id: input.target_id,
      action: 'introspect_needed',
      recommended_weekly_primary_sets: input.current_weekly_primary_sets,
      blueprint_reference_range: referenceRange,
      introspection_checklist: STAGNATION_CHECKLIST,
      reasoning:
        'Aesthetic progress is stagnant — spec §11 requires ruling out exercise selection, redundancy, execution evidence, frequency, ' +
        'compound overlap, and time/equipment constraints before adding volume. This module cannot verify those itself; increase is ' +
        'withheld until introspection_confirmed_no_other_explanation is explicitly set true.',
    };
  }

  const recommended = Math.min(input.current_weekly_primary_sets + PROGRESSION_INCREMENTS.weeklyExposureUnits, referenceRange.max);
  return {
    target_type: input.target_type,
    target_id: input.target_id,
    action: 'increase',
    recommended_weekly_primary_sets: recommended,
    blueprint_reference_range: referenceRange,
    introspection_checklist: null,
    reasoning:
      `Stagnation confirmed not explained by other factors, recovery is acceptable — small configured increase of ` +
      `${PROGRESSION_INCREMENTS.weeklyExposureUnits} sets/week (never jumping to Blueprint's maximum, capped at the ` +
      `current reference range's upper bound of ${referenceRange.max}), per §10-11.`,
  };
}
