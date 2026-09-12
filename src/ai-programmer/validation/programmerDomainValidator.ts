// CLAUDE_TASK_AI_PROGRAMMER_FIRST_VERTICAL_SLICE.md §10.2: domain
// validation. A proposal that passes schema validation
// (programmerOutputValidator.ts) still says nothing about whether its
// IDs are real, whether an exercise is actually eligible for its
// claimed target, whether its sets respect Blueprint's own authored
// cap, or whether its target date is still editable. This module
// checks exactly those facts against BlueprintAdapter and the same
// AIProgrammerContext the provider was given — never re-running the
// deterministic engine's own selection logic (that stays this
// milestone's explicit non-goal).

import type Database from 'better-sqlite3';
import { BlueprintAdapter } from '../../blueprint/adapter.js';
import { WorkoutSessionsRepo } from '../../repositories/workoutSessionsRepo.js';
import { todayForUser } from '../../lib/userTimezone.js';
import type { AIWorkoutExerciseProposal, AIWorkoutSessionProposal } from '../contracts/programmerTypes.js';
import type { AIProgrammerContext, AIProgrammerTargetContext, AIProgrammerValidExerciseContext } from '../context/programmerContextTypes.js';

/** A generic application-level safety ceiling for an exercise with no
 * Blueprint-authored per-session cap for the claimed target (spec
 * §10.2 requires SOME cap enforcement even then — never an unbounded
 * AI-chosen set count). Documented, not a Blueprint value. */
const MAX_SETS_WITHOUT_AUTHORED_CAP = 6;
const MAX_REPS = 30;
const MAX_RIR = 10;
const MAX_REST_SECONDS = 600;

export interface DomainValidationResult {
  ok: boolean;
  value?: AIWorkoutSessionProposal;
  errors: string[];
}

function findTarget(context: AIProgrammerContext, targetType: string, targetId: string): AIProgrammerTargetContext | undefined {
  return context.targets.find((t) => t.targetType === targetType && t.targetId === targetId);
}

/** Correction pass §2: when an exercise has a Blueprint-authored
 * prescription for its claimed target, EVERY authored field (sets,
 * repsMin, repsMax, rirMin, rirMax) is authoritative and must match
 * exactly — not merely stay under a broad global ceiling. A model must
 * not narrow, widen, or otherwise "improve" an authored prescription
 * just because its own chosen values remain individually plausible. */
function validateAuthoredPrescription(
  exercise: AIWorkoutExerciseProposal,
  authoredPrescription: NonNullable<AIProgrammerValidExerciseContext['authoredPrescription']>,
  path: string,
  errors: string[]
): void {
  const fields: Array<[keyof AIWorkoutExerciseProposal, keyof typeof authoredPrescription]> = [
    ['sets', 'sets'],
    ['repsMin', 'repsMin'],
    ['repsMax', 'repsMax'],
    ['rirMin', 'rirMin'],
    ['rirMax', 'rirMax'],
  ];
  for (const [proposalField, authoredField] of fields) {
    const expected = authoredPrescription[authoredField];
    const received = exercise[proposalField];
    if (received !== expected) {
      errors.push(`${path}.${proposalField} must equal Blueprint-authored value ${expected}; received ${received}`);
    }
  }
}

/** `db` is optional so tests/callers that already trust `context`'s own
 * `currentProgram.targetDateLocked` (computed at context-build time)
 * can skip the extra read; when supplied, this re-checks lock state
 * fresh against the database to guard the race where a session was
 * completed/started between context build and this validation call. */
export function validateProposalDomain(proposal: AIWorkoutSessionProposal, context: AIProgrammerContext, db?: Database.Database): DomainValidationResult {
  const errors: string[] = [];

  if (proposal.targetDate !== context.targetDate) {
    errors.push(`targetDate: proposal targets "${proposal.targetDate}" but the request was for "${context.targetDate}"`);
  }
  if (proposal.weekday !== context.targetWeekday) {
    errors.push(`weekday: proposal says "${proposal.weekday}" but ${context.targetDate} is actually "${context.targetWeekday}"`);
  }

  if (db) {
    const currentToday = todayForUser(db);
    if (context.targetDate < currentToday) {
      errors.push(`targetDate: ${context.targetDate} is in the past — no longer editable`);
    }
    const sessions = new WorkoutSessionsRepo(db).listSessionsByDate(context.targetDate);
    const locking = sessions.find((s) => s.status === 'completed' || s.status === 'in_progress');
    if (locking) {
      errors.push(`targetDate: ${context.targetDate} is locked by workout session ${locking.session_id} (status "${locking.status}")`);
    }
  }

  const seenExerciseIds = new Set<string>();
  for (const [index, exercise] of proposal.exercises.entries()) {
    const path = `exercises[${index}] (${exercise.exerciseId})`;

    if (seenExerciseIds.has(exercise.exerciseId)) {
      errors.push(`${path}: duplicate exerciseId within this proposal`);
    }
    seenExerciseIds.add(exercise.exerciseId);

    if (!BlueprintAdapter.isKnownExercise(exercise.exerciseId)) {
      errors.push(`${path}: "${exercise.exerciseId}" is not a known Blueprint exercise (outside-Blueprint exercises are not accepted in this milestone)`);
      continue;
    }

    const target = findTarget(context, exercise.targetType, exercise.targetId);
    if (!target) {
      errors.push(`${path}: target ${exercise.targetType}:${exercise.targetId} was not among the targets supplied in context`);
      continue;
    }

    const catalogueEntry = target.validExercises.find((v) => v.exerciseId === exercise.exerciseId);
    if (!catalogueEntry) {
      errors.push(`${path}: this exercise does not train target ${exercise.targetType}:${exercise.targetId} (not in its valid exercise library)`);
      continue;
    }

    if ((exercise.role === 'primary' || exercise.role === 'secondary') && exercise.role !== catalogueEntry.role) {
      errors.push(
        `${path}: declared role "${exercise.role}" does not match Blueprint's own primary/secondary role ("${catalogueEntry.role}") for this exercise/target pair`
      );
    }

    if (catalogueEntry.authoredPrescription) {
      // Correction pass §2: every authored field is authoritative and
      // must match exactly — not merely stay under a broad ceiling.
      validateAuthoredPrescription(exercise, catalogueEntry.authoredPrescription, path, errors);
    } else if (exercise.sets > MAX_SETS_WITHOUT_AUTHORED_CAP) {
      errors.push(`${path}: sets (${exercise.sets}) exceed the application-configured cap of ${MAX_SETS_WITHOUT_AUTHORED_CAP} (no Blueprint-authored prescription exists for this exercise/target pair)`);
    }

    if (exercise.repsMax > MAX_REPS) {
      errors.push(`${path}: repsMax (${exercise.repsMax}) exceeds the application safety ceiling of ${MAX_REPS}`);
    }
    if (exercise.rirMax > MAX_RIR) {
      errors.push(`${path}: rirMax (${exercise.rirMax}) exceeds the application safety ceiling of ${MAX_RIR}`);
    }
    if (exercise.restSeconds !== undefined && exercise.restSeconds > MAX_REST_SECONDS) {
      errors.push(`${path}: restSeconds (${exercise.restSeconds}) exceeds the application safety ceiling of ${MAX_REST_SECONDS}`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, errors: [], value: proposal };
}
