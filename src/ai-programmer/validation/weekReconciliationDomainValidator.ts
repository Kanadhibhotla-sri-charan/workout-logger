// AI-Powered Weekly Reconciliation: domain validation for
// `mode: "reconcile_week"` output — mirrors programmerDomainValidator.ts's
// split (schema says "shape is right"; this says "the facts are real").
// Reuses validateExerciseAgainstTargets (the exact per-exercise
// Blueprint/target/authored-cap check the single-session validator
// already has) rather than a second, drifting copy.

import type Database from 'better-sqlite3';
import { LEGS_PHYSIQUE_TARGETS, sessionRealismCapFor } from '../../engine/config.js';
import { todayForUser } from '../../lib/userTimezone.js';
import { WorkoutSessionsRepo } from '../../repositories/workoutSessionsRepo.js';
import type { AIWeekReconciliationOutput } from '../contracts/weekReconciliationTypes.js';
import type { AIReconciliationContext } from '../context/reconciliationContextTypes.js';
import { validateExerciseAgainstTargets } from './programmerDomainValidator.js';

export interface WeekReconciliationDomainValidationResult {
  ok: boolean;
  value?: AIWeekReconciliationOutput;
  errors: string[];
}

/** `db` is optional for the same reason `validateProposalDomain`'s is:
 * tests/callers that already trust `context`'s own lock computation can
 * skip the extra read; callers at commit time (a fresh context is
 * rebuilt there regardless) get it for free. */
export function validateWeekReconciliationDomain(
  output: AIWeekReconciliationOutput,
  context: AIReconciliationContext,
  db?: Database.Database
): WeekReconciliationDomainValidationResult {
  const errors: string[] = [];

  if (output.targetDate !== context.request.targetDate) {
    errors.push(`targetDate: output targets "${output.targetDate}" but the request was for "${context.request.targetDate}"`);
  }

  if (db) {
    const currentToday = todayForUser(db);
    if (context.request.targetDate < currentToday) {
      errors.push(`targetDate: ${context.request.targetDate} is in the past — no longer editable`);
    }
    const sessions = new WorkoutSessionsRepo(db).listSessionsByDate(context.request.targetDate);
    const locking = sessions.find((s) => s.status === 'completed' || s.status === 'in_progress');
    if (locking) {
      errors.push(`targetDate: ${context.request.targetDate} is locked by workout session ${locking.session_id} (status "${locking.status}")`);
    }
  }

  // Exactly the 7 dates of context.existingProgram, in the exact same
  // Monday..Sunday order — never a partial week, never a date outside
  // it (spec: "not change dates outside the requested week").
  const expectedDates = context.existingProgram.map((d) => d.date);
  const actualDates = output.days.map((d) => d.date);
  if (JSON.stringify(actualDates) !== JSON.stringify(expectedDates)) {
    errors.push(`days: expected exactly the 7 dates ${JSON.stringify(expectedDates)} in that order, received ${JSON.stringify(actualDates)}`);
  }

  let targetDayFound = false;
  for (let i = 0; i < output.days.length; i++) {
    const day = output.days[i]!;
    const existing = context.existingProgram.find((d) => d.date === day.date);
    const path = `days[${i}] (${day.date})`;

    if (!existing) {
      // Already reported by the whole-array date check above — skip
      // per-day checks against a day this reconciliation has no business
      // describing at all.
      continue;
    }

    if (day.weekday !== existing.weekday) {
      errors.push(`${path}.weekday: expected "${existing.weekday}" for ${day.date}, received "${day.weekday}"`);
    }

    // Locked-day preservation (spec: "Locked/completed/in-progress days
    // are protected" / "preserve these days exactly") — never trusted
    // from the model's own `locked`/`changeType` claim; re-checked
    // against the context's OWN lock computation.
    if (existing.locked) {
      if (day.changeType !== 'unchanged') {
        errors.push(`${path}: is locked (${existing.lockReason}) — changeType must be "unchanged", received "${day.changeType}"`);
      }
      if (day.activity !== existing.activity) {
        errors.push(`${path}: is locked — activity must remain "${existing.activity}", received "${day.activity}"`);
      }
      continue; // a locked day's session content is never re-checked exercise-by-exercise — it must not change at all.
    }

    if (day.date === context.request.targetDate) {
      targetDayFound = true;
      if (day.activity !== 'gym' && day.activity !== 'both') {
        errors.push(`${path}: this is the requested target date — activity must be "gym" or "both", received "${day.activity}"`);
      }
    }

    if (day.session) {
      const seen = new Set<string>();
      for (const [exIndex, exercise] of day.session.exercises.entries()) {
        validateExerciseAgainstTargets(exercise, context.targets, seen, `${path}.session.exercises[${exIndex}] (${exercise.exerciseId})`, errors);
      }

      // Session Realism Cap (Programming Advisor Fix, 2026-09-14): the
      // same hard exercise/muscle-count ceiling the deterministic engine
      // and the single-session validator enforce — checked here per
      // real (unlocked) day, since a week reconciliation can rewrite
      // several days at once.
      const distinctTargets = new Set(day.session.exercises.map((ex) => `${ex.targetType}:${ex.targetId}`));
      const targetIdsInSession = [...new Set(day.session.exercises.map((ex) => ex.targetId))];
      const purpose = day.session.sessionPurpose;
      const validatedPurpose = purpose === 'push' || purpose === 'pull' || purpose === 'legs' || purpose === 'upper' ? purpose : null;
      const caps = sessionRealismCapFor(validatedPurpose, targetIdsInSession);
      if (distinctTargets.size > caps.maxTargets) {
        errors.push(`${path}.session: ${distinctTargets.size} distinct targets — exceeds the hard cap of ${caps.maxTargets} targets per session`);
      }
      // Legs-Session Exercise Cap (2026-09-16, tightened 2026-09-19),
      // explicit user request: sessionRealismCapFor (config.ts, the one
      // shared source of truth every caller reads) decides the same
      // muscle/exercise ceilings the deterministic engine enforces,
      // including the leg+abs exception.
      if (day.session.exercises.length > caps.maxExercises) {
        errors.push(`${path}.session: ${day.session.exercises.length} total exercises — exceeds the hard cap of ${caps.maxExercises} exercises per session`);
      }
      if (caps.legExerciseShareMax !== null) {
        const legExerciseCount = day.session.exercises.filter((ex) => LEGS_PHYSIQUE_TARGETS.includes(ex.targetId)).length;
        if (legExerciseCount > caps.legExerciseShareMax) {
          errors.push(`${path}.session: ${legExerciseCount} leg exercises — exceeds the leg-day exercise cap of ${caps.legExerciseShareMax} (extra room in an abs-paired leg day is for abs, not more leg work)`);
        }
      }
    }
  }

  if (!targetDayFound && output.days.every((d) => d.date !== context.request.targetDate)) {
    errors.push(`days: the requested targetDate ${context.request.targetDate} is missing from the returned week`);
  }

  // Every day flagged locked in reconciliation.preservedLockedDates must
  // actually be a locked day per context — and every actually-locked
  // date must be reported there (spec: "preservedLockedDates").
  const claimedLocked = new Set(output.reconciliation.preservedLockedDates);
  for (const date of context.lockedDates) {
    if (!claimedLocked.has(date)) {
      errors.push(`reconciliation.preservedLockedDates: missing locked date ${date}`);
    }
  }
  for (const date of claimedLocked) {
    if (!context.lockedDates.includes(date)) {
      errors.push(`reconciliation.preservedLockedDates: "${date}" is not actually a locked date in this context`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, errors: [], value: output };
}
