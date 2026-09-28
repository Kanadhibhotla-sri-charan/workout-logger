// AI Weekly Programmer — generate_week: domain validation. Mirrors
// weekReconciliationDomainValidator.ts's split (schema says "shape is
// right"; this says "the facts are real"), minus every locked-day/
// existing-week-diff concept that does not apply to a from-scratch week
// (there is no prior week to preserve). Reuses
// validateExerciseAgainstTargets (the exact per-exercise Blueprint/
// target/authored-cap check the single-session and reconcile_week
// validators already share) rather than a second, drifting copy.

import { ABS_PHYSIQUE_TARGETS, LEGS_PHYSIQUE_TARGETS, sessionRealismCapFor } from '../../engine/config.js';
import { WEEKDAYS } from '../../contracts/types.js';
import { addDays } from '../../engine/dateMath.js';
import type { AIGenerateWeekOutput } from '../contracts/generateWeekTypes.js';
import type { AIGenerateWeekContext } from '../context/generateWeekContextTypes.js';
import { validateExerciseAgainstTargets } from './programmerDomainValidator.js';
import { directSetsPerExposureCapFor } from './setCaps.js';

export interface GenerateWeekDomainValidationResult {
  ok: boolean;
  value?: AIGenerateWeekOutput;
  errors: string[];
  warnings: string[];
}

export function validateGenerateWeekDomain(output: AIGenerateWeekOutput, context: AIGenerateWeekContext): GenerateWeekDomainValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (output.weekStart !== context.weekStart) {
    errors.push(`weekStart: output targets "${output.weekStart}" but the request was for "${context.weekStart}"`);
  }

  // Exactly the 7 dates of this week, in the exact same Monday..Sunday
  // order — never a partial week, never a date outside it. Unlike
  // reconcile_week there is no context.existingProgram to compare
  // against; the expected dates are derived directly from weekStart.
  const expectedDates = WEEKDAYS.map((_, i) => addDays(context.weekStart, i));
  const actualDates = output.days.map((d) => d.date);
  if (JSON.stringify(actualDates) !== JSON.stringify(expectedDates)) {
    errors.push(`days: expected exactly the 7 dates ${JSON.stringify(expectedDates)} in that order, received ${JSON.stringify(actualDates)}`);
  }

  for (let i = 0; i < output.days.length; i++) {
    const day = output.days[i]!;
    const expectedWeekday = WEEKDAYS[i];
    const path = `days[${i}] (${day.date})`;

    if (expectedWeekday && day.weekday !== expectedWeekday) {
      errors.push(`${path}.weekday: expected "${expectedWeekday}", received "${day.weekday}"`);
    }

    const routineDay = context.routine.week.find((d) => d.date === day.date);
    if (routineDay && day.activity !== routineDay.activity) {
      errors.push(`${path}.activity: expected "${routineDay.activity}" (this week's own effective activity for this day), received "${day.activity}"`);
    }

    if (day.session) {
      const seen = new Set<string>();
      for (const [exIndex, exercise] of day.session.exercises.entries()) {
        const exerciseTarget = context.targets.find((t) => t.targetType === exercise.targetType && t.targetId === exercise.targetId);
        const setCap = exerciseTarget ? directSetsPerExposureCapFor(exerciseTarget) : null;
        validateExerciseAgainstTargets(exercise, context.targets, seen, `${path}.session.exercises[${exIndex}] (${exercise.exerciseId})`, errors, warnings, setCap ?? undefined);
      }

      // Session Realism Cap — the same hard exercise/muscle-count
      // ceiling every other AI output mode enforces (config.ts's one
      // shared source of truth).
      const distinctTargets = new Set(day.session.exercises.map((ex) => `${ex.targetType}:${ex.targetId}`));
      const targetIdsInSession = [...new Set(day.session.exercises.map((ex) => ex.targetId))];
      const purpose = day.session.sessionPurpose;
      const validatedPurpose = purpose === 'push' || purpose === 'pull' || purpose === 'legs' || purpose === 'upper' ? purpose : null;
      const caps = sessionRealismCapFor(validatedPurpose, targetIdsInSession);
      if (distinctTargets.size > caps.maxTargets) {
        errors.push(`${path}.session: ${distinctTargets.size} distinct targets — exceeds the hard cap of ${caps.maxTargets} targets per session`);
      }
      if (day.session.exercises.length > caps.maxExercises) {
        errors.push(`${path}.session: ${day.session.exercises.length} total exercises — exceeds the hard cap of ${caps.maxExercises} exercises per session`);
      }
      if (caps.legExerciseShareMax !== null) {
        const legExerciseCount = day.session.exercises.filter((ex) => LEGS_PHYSIQUE_TARGETS.includes(ex.targetId)).length;
        if (legExerciseCount > caps.legExerciseShareMax) {
          errors.push(`${path}.session: ${legExerciseCount} leg exercises — exceeds the leg-day exercise cap of ${caps.legExerciseShareMax}`);
        }
      }
      if (caps.absExerciseShareMax !== null) {
        const absExerciseCount = day.session.exercises.filter((ex) => ABS_PHYSIQUE_TARGETS.includes(ex.targetId)).length;
        if (absExerciseCount > caps.absExerciseShareMax) {
          errors.push(`${path}.session: ${absExerciseCount} abs exercises — exceeds the abs-exercise share cap of ${caps.absExerciseShareMax} for this session`);
        }
      }
    } else if (day.activity === 'gym' || day.activity === 'both') {
      errors.push(`${path}: activity is "${day.activity}" but session is null — a gym day must have a session`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }
  return { ok: true, errors: [], warnings, value: output };
}
