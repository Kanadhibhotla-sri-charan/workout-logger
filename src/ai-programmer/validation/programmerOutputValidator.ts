// CLAUDE_TASK_AI_PROGRAMMER_FIRST_VERTICAL_SLICE.md §10.1: structural
// schema validation. Checks shape, types, enums, and ranges only — it
// knows nothing about Blueprint, goals, or lock state (that is
// programmerDomainValidator.ts's job). No validation library is
// installed in this repo (see package.json) — this hand-written
// validator follows the same plain typeof/Array.isArray convention
// already used throughout src/server/routes/*.ts for external input.

import { WEEKDAYS } from '../../contracts/types.js';
import {
  AI_WORKOUT_SESSION_PROPOSAL_SCHEMA_VERSION,
  type AIWorkoutExerciseProposal,
  type AIWorkoutExerciseRole,
  type AIWorkoutSessionProposal,
} from '../contracts/programmerTypes.js';

const EXERCISE_ROLES: readonly AIWorkoutExerciseRole[] = ['primary', 'secondary', 'accessory', 'isolation', 'conditioning'];
const TARGET_TYPES = ['physique_target', 'functional_goal'] as const;

/** Never expected in a rationale/warning string — spec §7: "do not
 * allow the AI to return raw HTML, executable code, SQL, or arbitrary
 * database operations." This is a defense-in-depth content check on
 * strings that are only ever displayed as text, not a security
 * boundary by itself (nothing here is ever executed). */
const DANGEROUS_CONTENT_PATTERNS = [/<script/i, /<\/script/i, /\bdrop\s+table\b/i, /\bdelete\s+from\b/i, /\bunion\s+select\b/i, /;\s*--/];

function containsDangerousContent(value: string): boolean {
  return DANGEROUS_CONTENT_PATTERNS.some((pattern) => pattern.test(value));
}

export interface SchemaValidationResult {
  ok: boolean;
  value?: AIWorkoutSessionProposal;
  errors: string[];
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validateExercise(raw: unknown, index: number, errors: string[]): AIWorkoutExerciseProposal | null {
  const path = `exercises[${index}]`;
  if (typeof raw !== 'object' || raw === null) {
    errors.push(`${path}: expected an object`);
    return null;
  }
  const e = raw as Record<string, unknown>;
  let valid = true;

  if (typeof e.exerciseId !== 'string' || e.exerciseId.trim() === '') {
    errors.push(`${path}.exerciseId: expected a non-empty string`);
    valid = false;
  }
  if (typeof e.role !== 'string' || !EXERCISE_ROLES.includes(e.role as AIWorkoutExerciseRole)) {
    errors.push(`${path}.role: expected one of ${EXERCISE_ROLES.join('|')}`);
    valid = false;
  }
  if (typeof e.targetType !== 'string' || !TARGET_TYPES.includes(e.targetType as (typeof TARGET_TYPES)[number])) {
    errors.push(`${path}.targetType: expected one of ${TARGET_TYPES.join('|')}`);
    valid = false;
  }
  if (typeof e.targetId !== 'string' || e.targetId.trim() === '') {
    errors.push(`${path}.targetId: expected a non-empty string`);
    valid = false;
  }
  if (!isPositiveInt(e.sets)) {
    errors.push(`${path}.sets: expected a positive integer`);
    valid = false;
  }
  if (!isPositiveInt(e.repsMin)) {
    errors.push(`${path}.repsMin: expected a positive integer`);
    valid = false;
  }
  if (!isPositiveInt(e.repsMax)) {
    errors.push(`${path}.repsMax: expected a positive integer`);
    valid = false;
  }
  if (isPositiveInt(e.repsMin) && isPositiveInt(e.repsMax) && (e.repsMin as number) > (e.repsMax as number)) {
    errors.push(`${path}: repsMin must be <= repsMax`);
    valid = false;
  }
  if (!isNonNegativeNumber(e.rirMin)) {
    errors.push(`${path}.rirMin: expected a non-negative number`);
    valid = false;
  }
  if (!isNonNegativeNumber(e.rirMax)) {
    errors.push(`${path}.rirMax: expected a non-negative number`);
    valid = false;
  }
  if (isNonNegativeNumber(e.rirMin) && isNonNegativeNumber(e.rirMax) && (e.rirMin as number) > (e.rirMax as number)) {
    errors.push(`${path}: rirMin must be <= rirMax`);
    valid = false;
  }
  if (e.restSeconds !== undefined && !isNonNegativeNumber(e.restSeconds)) {
    errors.push(`${path}.restSeconds: expected a non-negative number when present`);
    valid = false;
  }
  if (!isStringArray(e.rationale)) {
    errors.push(`${path}.rationale: expected an array of strings`);
    valid = false;
  } else if (e.rationale.some(containsDangerousContent)) {
    errors.push(`${path}.rationale: contains disallowed content (script/SQL-like text)`);
    valid = false;
  }
  if (e.source !== 'blueprint') {
    errors.push(`${path}.source: only "blueprint" is accepted in this milestone (received ${JSON.stringify(e.source)})`);
    valid = false;
  }

  return valid ? (e as unknown as AIWorkoutExerciseProposal) : null;
}

function validateStringArrayField(raw: Record<string, unknown>, field: string, errors: string[]): string[] | null {
  const value = raw[field];
  if (!isStringArray(value)) {
    errors.push(`${field}: expected an array of strings`);
    return null;
  }
  if (value.some(containsDangerousContent)) {
    errors.push(`${field}: contains disallowed content (script/SQL-like text)`);
    return null;
  }
  return value;
}

/** Validates the raw parsed-JSON provider output against
 * AIWorkoutSessionProposal's structural shape. Never trusts anything
 * about IDs actually existing in Blueprint or targeting an editable day
 * — see programmerDomainValidator.ts for that. */
export function validateProposalSchema(raw: unknown): SchemaValidationResult {
  const errors: string[] = [];

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['response: expected a JSON object'] };
  }
  const obj = raw as Record<string, unknown>;

  if (obj.schemaVersion !== AI_WORKOUT_SESSION_PROPOSAL_SCHEMA_VERSION) {
    errors.push(`schemaVersion: expected "${AI_WORKOUT_SESSION_PROPOSAL_SCHEMA_VERSION}", received ${JSON.stringify(obj.schemaVersion)}`);
  }
  // Correction pass §7: proposalId is application-owned — the service
  // always overwrites whatever the model returned with a freshly
  // generated UUID, so this is validated only loosely (a string, when
  // present) rather than required.
  if (obj.proposalId !== undefined && typeof obj.proposalId !== 'string') {
    errors.push('proposalId: expected a string when present');
  }
  if (obj.mode !== 'generate_session') {
    errors.push(`mode: expected "generate_session", received ${JSON.stringify(obj.mode)}`);
  }
  if (!isIsoDate(obj.targetDate)) {
    errors.push('targetDate: expected an ISO date string (YYYY-MM-DD)');
  }
  if (typeof obj.weekday !== 'string' || !(WEEKDAYS as readonly string[]).includes(obj.weekday)) {
    errors.push(`weekday: expected one of ${WEEKDAYS.join('|')}`);
  }

  const sessionFocus = validateStringArrayField(obj, 'sessionFocus', errors);

  let exercises: AIWorkoutExerciseProposal[] | null = null;
  if (!Array.isArray(obj.exercises)) {
    errors.push('exercises: expected an array');
  } else {
    const validated = obj.exercises.map((e, i) => validateExercise(e, i, errors));
    exercises = validated.every((e): e is AIWorkoutExerciseProposal => e !== null) ? (validated as AIWorkoutExerciseProposal[]) : null;

    const seen = new Set<string>();
    for (const e of obj.exercises as Array<Record<string, unknown>>) {
      const id = typeof e.exerciseId === 'string' ? e.exerciseId : undefined;
      if (id) {
        if (seen.has(id)) errors.push(`exercises: duplicate exerciseId "${id}"`);
        seen.add(id);
      }
    }
  }

  const programmingRationale = validateStringArrayField(obj, 'programmingRationale', errors);
  const goalAlignment = validateStringArrayField(obj, 'goalAlignment', errors);
  const recoveryConsiderations = validateStringArrayField(obj, 'recoveryConsiderations', errors);
  const warnings = validateStringArrayField(obj, 'warnings', errors);

  if (errors.length > 0 || !exercises || !sessionFocus || !programmingRationale || !goalAlignment || !recoveryConsiderations || !warnings) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    errors: [],
    value: {
      schemaVersion: AI_WORKOUT_SESSION_PROPOSAL_SCHEMA_VERSION,
      proposalId: typeof obj.proposalId === 'string' ? obj.proposalId : '', // overwritten by the service with an app-generated ID regardless
      mode: 'generate_session',
      targetDate: obj.targetDate as string,
      weekday: obj.weekday as string,
      sessionFocus,
      exercises,
      programmingRationale,
      goalAlignment,
      recoveryConsiderations,
      warnings,
    },
  };
}
