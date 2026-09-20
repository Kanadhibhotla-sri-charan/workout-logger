// Whole-week volume audit: how many direct sets each target really receives
// across a generated week, compared with what that target can actually be
// given. Used by the eval harness; kept in src so it is unit-tested and reads
// the SAME scope and reference functions the engine does (no second copy).
//
// Two rules that matter for correctness:
//  1. Shared exercises credit every target they train. An overhead triceps
//     extension counts toward both `triceps` and `triceps-long-head`,
//     exactly as the reference engine's sub-target scope defines it. An
//     exercise the scope deliberately leaves untagged (`[]`), or one whose
//     package has no scope entry, credits the target the model assigned it to.
//  2. The comparison figure is what the week can deliver, not the raw weekly
//     reference: min(weekly reference, per-exposure cap x this week's
//     compatible sessions). One leg day cannot deliver a reference written for
//     two, so it is not reported as a shortfall.

import { getSubTargetExerciseIds } from '../../blueprint/subTargetExerciseScope.js';
import { developmentPackageLevelFor, getDevelopmentReference } from '../../engine/developmentReferenceEngine.js';
import type { TargetType } from '../../engine/goalResolver.js';
import { isTargetCompatibleWithPurpose } from '../../engine/sessionPurpose.js';
import type { AIProgrammerTargetContext } from '../context/programmerContextTypes.js';

export interface AuditExercise {
  exerciseId: string;
  targetType: string;
  targetId: string;
  sets: number;
}

export interface AuditWeek {
  days?: readonly { date: string; session?: { exercises?: readonly AuditExercise[] } | null }[];
}

export interface AuditContext {
  targets: readonly AIProgrammerTargetContext[];
  existingProgram: readonly { date: string; sessionPurpose: string | null }[];
}

export interface WeeklyVolumeRow {
  targetType: string;
  targetId: string;
  /** The development package's own weekly reference. */
  reference: number;
  /** What this week's real schedule can deliver: min(reference, cap x compatible sessions). */
  deliverable: number;
  compatibleSessions: number;
  generatedDirectSets: number;
  /** deliverable - generated, never negative. */
  shortfall: number;
  goal: boolean;
}

export interface WeeklyVolumeAudit {
  rows: WeeklyVolumeRow[];
  goalShortfalls: WeeklyVolumeRow[];
  normalShortfalls: WeeklyVolumeRow[];
}

export function isGoalTarget(target: Pick<AIProgrammerTargetContext, 'goalId' | 'isSpecialization'> | undefined): boolean {
  return Boolean(target?.goalId) || Boolean(target?.isSpecialization);
}

const keyOf = (targetType: string, targetId: string) => `${targetType}:${targetId}`;

function referenceFor(target: AIProgrammerTargetContext) {
  return getDevelopmentReference(target.targetType as TargetType, target.targetId, developmentPackageLevelFor(target.isSpecialization));
}

/** Every target whose own scoped exercise list contains `exerciseId`; the
 * assigned target when none does. */
function creditedTargetKeys(exercise: AuditExercise, targets: readonly AIProgrammerTargetContext[]): string[] {
  const credited: string[] = [];
  for (const target of targets) {
    if (target.targetType !== 'physique_target') continue;
    const packageId = referenceFor(target).package_id;
    if (!packageId) continue;
    if (getSubTargetExerciseIds(packageId, target.targetId)?.includes(exercise.exerciseId)) credited.push(keyOf(target.targetType, target.targetId));
  }
  return credited.length > 0 ? credited : [keyOf(exercise.targetType, exercise.targetId)];
}

export function auditWeeklyVolume(week: AuditWeek, context: AuditContext): WeeklyVolumeAudit {
  const totals = new Map<string, number>();
  for (const day of week.days ?? []) {
    for (const exercise of day.session?.exercises ?? []) {
      for (const key of creditedTargetKeys(exercise, context.targets)) totals.set(key, (totals.get(key) ?? 0) + exercise.sets);
    }
  }

  const rows: WeeklyVolumeRow[] = [];
  for (const target of context.targets) {
    if (target.targetType !== 'physique_target') continue;
    const reference = referenceFor(target);
    if (reference.weekly_direct_set_reference == null) continue;
    const compatibleSessions = context.existingProgram.filter((d) => {
      const purpose = d.sessionPurpose;
      return (purpose === 'push' || purpose === 'pull' || purpose === 'legs' || purpose === 'upper') && isTargetCompatibleWithPurpose(target.targetType as TargetType, target.targetId, purpose);
    }).length;
    const cap = reference.direct_sets_per_exposure;
    const deliverable = cap == null ? reference.weekly_direct_set_reference : Math.min(reference.weekly_direct_set_reference, cap * compatibleSessions);
    const generated = totals.get(keyOf(target.targetType, target.targetId)) ?? 0;
    rows.push({
      targetType: target.targetType,
      targetId: target.targetId,
      reference: reference.weekly_direct_set_reference,
      deliverable,
      compatibleSessions,
      generatedDirectSets: generated,
      shortfall: Math.max(0, deliverable - generated),
      goal: isGoalTarget(target),
    });
  }

  const short = rows.filter((r) => r.shortfall > 0);
  return { rows, goalShortfalls: short.filter((r) => r.goal), normalShortfalls: short.filter((r) => !r.goal) };
}

export interface AuditDeferral {
  targetId: string;
  reasonCode: string;
}

const GOAL_DEFERRAL_REASONS = ['recovery', 'recent_overexposure'];

/** A goal target may be short only with a recovery / recent-overexposure
 * deferral. The deferral itself is the record that the volume is carried
 * forward; there is no separate carryover field. Returns error strings. */
export function auditGoalDeferrals(audit: WeeklyVolumeAudit, deferrals: readonly AuditDeferral[], targets: readonly AIProgrammerTargetContext[]): string[] {
  const errors: string[] = [];
  const goalTargetIds = new Set(targets.filter(isGoalTarget).map((t) => t.targetId));
  for (const d of deferrals) {
    if (goalTargetIds.has(d.targetId) && !GOAL_DEFERRAL_REASONS.includes(d.reasonCode)) {
      errors.push(`goal target ${d.targetId} has an invalid deferral reasonCode ${d.reasonCode}`);
    }
  }
  for (const row of audit.goalShortfalls) {
    if (!deferrals.some((d) => d.targetId === row.targetId && GOAL_DEFERRAL_REASONS.includes(d.reasonCode))) {
      errors.push(`goal target ${row.targetId} is short by ${row.shortfall} set(s) (generated ${row.generatedDirectSets} of ${row.deliverable} deliverable); a recovery or recent_overexposure deferral is required`);
    }
  }
  return errors;
}
