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
//  2. What a target is REQUIRED to receive is what the app's own volume
//     decision told the model to aim for (the brief's recommended weekly sets:
//     the build-up rule, or hold-current), capped at what the week can deliver,
//     min(weekly reference, per-exposure cap x this week's compatible sessions).
//     The full package reference is a long-term target reached by progression,
//     and is reported for context, not enforced; enforcing it would fail a week
//     that followed the brief exactly. With no brief supplied, the deliverable
//     figure is used.

import { developmentPackageLevelFor, getDevelopmentReference } from '../../engine/developmentReferenceEngine.js';
import type { TargetType } from '../../engine/goalResolver.js';
import { isTargetCompatibleWithPurpose } from '../../engine/sessionPurpose.js';
import type { AIProgrammerMuscleGuidance, AIProgrammerTargetContext } from '../context/programmerContextTypes.js';
import { creditedTargetKeys, keyOf } from './sharedCredit.js';

export interface AuditExercise {
  exerciseId: string;
  targetType: string;
  targetId: string;
  sets: number;
}

export interface AuditWeek {
  /** sessionPurpose is optional so existing week-only fixtures (no purpose
   * of their own) keep falling back to context.existingProgram's purpose
   * unchanged — see auditWeeklyVolume's own comment on why this is the
   * preferred source when present. */
  days?: readonly { date: string; session?: { sessionPurpose?: string | null; exercises?: readonly AuditExercise[] } | null }[];
}

export interface AuditContext {
  targets: readonly AIProgrammerTargetContext[];
  existingProgram: readonly { date: string; sessionPurpose: string | null }[];
  /** The brief the model was given; supplies each target's recommended weekly sets. */
  programmingBrief?: { muscles: readonly { targetType: string; targetId: string; recommendedWeeklyPrimarySets: number }[] };
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
  /** The brief's recommended weekly sets for this target, when a brief was supplied. */
  briefRecommendedWeeklySets: number | null;
  /** What this target must receive: min(brief recommendation, deliverable), or deliverable with no brief. */
  required: number;
  /** required - generated, never negative. */
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

function referenceFor(target: AIProgrammerTargetContext) {
  return getDevelopmentReference(target.targetType as TargetType, target.targetId, developmentPackageLevelFor(target.isSpecialization));
}

export function auditWeeklyVolume(week: AuditWeek, context: AuditContext): WeeklyVolumeAudit {
  const totals = new Map<string, number>();
  for (const day of week.days ?? []) {
    for (const exercise of day.session?.exercises ?? []) {
      for (const key of creditedTargetKeys(exercise, context.targets)) totals.set(key, (totals.get(key) ?? 0) + exercise.sets);
    }
  }

  // compatibleSessions must reflect the sessions the planner is actually
  // expected to program, not merely what context.existingProgram's
  // PRE-reconciliation snapshot happened to say. A genuinely blank future
  // week (every day's own recurring purpose still unassigned) has
  // sessionPurpose: null on every existingProgram entry even though two of
  // those days are real, plannable push/upper sessions — reading only that
  // snapshot silently collapses compatibleSessions (and therefore
  // deliverable/required) to 0, making weekAdequacy.ok=true regardless of
  // how little the model actually programmed (confirmed live, 2026-09-23
  // fresh-slate eval: deliverable:0 for a target with two real compatible
  // sessions in the week actually being audited). `week` — the same
  // days/session data the caller is already auditing for generated sets —
  // is the real, current source of truth for what each day IS being
  // programmed as; it is preferred here, falling back to
  // context.existingProgram's purpose only for a day this audit's own
  // `week` argument says nothing about.
  const weekPurposeByDate = new Map<string, string>();
  for (const day of week.days ?? []) {
    const purpose = day.session?.sessionPurpose;
    if (purpose) weekPurposeByDate.set(day.date, purpose);
  }

  const rows: WeeklyVolumeRow[] = [];
  for (const target of context.targets) {
    if (target.targetType !== 'physique_target') continue;
    const reference = referenceFor(target);
    if (reference.weekly_direct_set_reference == null) continue;
    const compatibleSessions = context.existingProgram.filter((d) => {
      const purpose = weekPurposeByDate.get(d.date) ?? d.sessionPurpose;
      return (purpose === 'push' || purpose === 'pull' || purpose === 'legs' || purpose === 'upper') && isTargetCompatibleWithPurpose(target.targetType as TargetType, target.targetId, purpose);
    }).length;
    const cap = reference.direct_sets_per_exposure;
    const deliverable = cap == null ? reference.weekly_direct_set_reference : Math.min(reference.weekly_direct_set_reference, cap * compatibleSessions);
    const generated = totals.get(keyOf(target.targetType, target.targetId)) ?? 0;
    const briefRecommended = context.programmingBrief?.muscles.find((m) => m.targetType === target.targetType && m.targetId === target.targetId)?.recommendedWeeklyPrimarySets ?? null;
    const required = briefRecommended === null ? deliverable : Math.min(deliverable, briefRecommended);
    rows.push({
      targetType: target.targetType,
      targetId: target.targetId,
      reference: reference.weekly_direct_set_reference,
      deliverable,
      compatibleSessions,
      generatedDirectSets: generated,
      briefRecommendedWeeklySets: briefRecommended,
      required,
      shortfall: Math.max(0, required - generated),
      goal: isGoalTarget(target),
    });
  }

  const short = rows.filter((r) => r.shortfall > 0);
  return { rows, goalShortfalls: short.filter((r) => r.goal), normalShortfalls: short.filter((r) => !r.goal) };
}

export interface AuditDeferral {
  targetId: string;
  /** What the model itself declares the remaining shortfall to be.
   * Never corrected to the audited figure before this check runs — see
   * auditGoalDeferrals's own doc comment for why. */
  unmetSets: number;
  reasonCode: string;
}

const GOAL_DEFERRAL_REASONS = ['recovery', 'recent_overexposure'];

/** A goal target may be short only with a TRUTHFUL recovery /
 * recent-overexposure deferral: a real reason, and a declared `unmetSets`
 * that matches this audit's own computed shortfall exactly. Callers must
 * pass the model's own declared `unmetSets` through unchanged — silently
 * overwriting it with the audited figure before calling this (as the eval
 * harness once did) hides exactly the dishonesty this check exists to
 * catch: a model could declare `unmetSets: 0` (or any smaller number) on
 * a real 15-set shortfall and have it quietly corrected into a valid-
 * looking deferral instead of being rejected. A mismatch is reported
 * here as its own failure, never silently fixed up. The deferral itself
 * is the record that the volume is carried forward; there is no separate
 * carryover field. Returns error strings. */
export function auditGoalDeferrals(audit: WeeklyVolumeAudit, deferrals: readonly AuditDeferral[], targets: readonly AIProgrammerTargetContext[]): string[] {
  const errors: string[] = [];
  const goalTargetIds = new Set(targets.filter(isGoalTarget).map((t) => t.targetId));
  for (const d of deferrals) {
    if (goalTargetIds.has(d.targetId) && !GOAL_DEFERRAL_REASONS.includes(d.reasonCode)) {
      errors.push(`goal target ${d.targetId} has an invalid deferral reasonCode ${d.reasonCode}`);
    }
  }
  for (const row of audit.goalShortfalls) {
    const deferral = deferrals.find((d) => d.targetId === row.targetId);
    if (!deferral) {
      errors.push(`goal target ${row.targetId} is short by ${row.shortfall} set(s) (generated ${row.generatedDirectSets} of ${row.required} required); a recovery or recent_overexposure deferral is required`);
      continue;
    }
    if (!GOAL_DEFERRAL_REASONS.includes(deferral.reasonCode)) continue; // already reported above
    if (!Number.isFinite(deferral.unmetSets) || deferral.unmetSets <= 0) {
      errors.push(`goal target ${row.targetId} deferral declares unmetSets ${deferral.unmetSets}, but the audited shortfall is ${row.shortfall} set(s) — a real shortfall must be declared as a positive number, never zero, negative, or missing`);
    } else if (deferral.unmetSets !== row.shortfall) {
      errors.push(`goal target ${row.targetId} deferral declares unmetSets ${deferral.unmetSets}, but the audited shortfall is ${row.shortfall} set(s) (generated ${row.generatedDirectSets} of ${row.required} required) — the declared shortfall must match the audited one exactly`);
    }
  }
  return errors;
}

export type GoalBriefVerdict = 'below_brief' | 'meets_brief_below_reference' | 'meets_reference';

export interface GoalBriefRow {
  targetId: string;
  generatedDirectSets: number;
  /** What the app's own volume decision told the model to aim for this week. */
  briefRecommendedWeeklySets: number;
  briefSessionRange: { min: number; max: number };
  briefVolumeAction: string;
  briefReasoning: string;
  /** The package's full weekly reference, and what the week can deliver. */
  weeklyReference: number | null;
  deliverable: number | null;
  verdict: GoalBriefVerdict;
}

/** For each goal muscle: did the generated week meet what the brief asked for,
 * and how does that compare with the full reference the audit reports? This
 * separates 'the model ignored the brief' from 'the audit benchmark is stricter
 * than the brief the model was given'. */
export function goalBriefVsGenerated(audit: WeeklyVolumeAudit, muscles: readonly AIProgrammerMuscleGuidance[]): GoalBriefRow[] {
  const rows: GoalBriefRow[] = [];
  for (const muscle of muscles) {
    if (!muscle.isGoalOriented) continue;
    const audited = audit.rows.find((r) => r.targetType === muscle.targetType && r.targetId === muscle.targetId);
    const generated = audited?.generatedDirectSets ?? 0;
    const deliverable = audited?.deliverable ?? null;
    const verdict: GoalBriefVerdict =
      generated < muscle.recommendedWeeklyPrimarySets ? 'below_brief' : deliverable !== null && generated < deliverable ? 'meets_brief_below_reference' : 'meets_reference';
    rows.push({
      targetId: muscle.targetId,
      generatedDirectSets: generated,
      briefRecommendedWeeklySets: muscle.recommendedWeeklyPrimarySets,
      briefSessionRange: muscle.recommendedSessionSets,
      briefVolumeAction: muscle.volumeAction,
      briefReasoning: muscle.reasoning,
      weeklyReference: audited?.reference ?? null,
      deliverable,
      verdict,
    });
  }
  return rows;
}
