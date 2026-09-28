// AI Weekly Programmer — generate_week: structural schema validation.
// Checks shape/types/enums/ranges only (domain checks — real exercise/
// target IDs, authored-cap enforcement, session caps — are
// generateWeekDomainValidator.ts's job, mirroring the single-session and
// reconcile_week split). Reuses validateExercise (the exact per-exercise
// core-field check programmerOutputValidator.ts already has) rather than
// a second, drifting copy.

import { WEEKDAYS } from '../../contracts/types.js';
import { containsDangerousContent, isIsoDate, isNonNegativeNumber, isStringArray, validateExercise } from './programmerOutputValidator.js';
import {
  AI_GENERATE_WEEK_SCHEMA_VERSION,
  type AIGenerateWeekDay,
  type AIGenerateWeekDaySession,
  type AIGenerateWeekExerciseProposal,
  type AIGenerateWeekOutput,
} from '../contracts/generateWeekTypes.js';

const CLASSIFICATIONS = ['specialization', 'normal_development', 'maintenance'] as const;
const ACTIVITIES = ['rest', 'gym', 'badminton', 'both', 'unselected'] as const;

export interface GenerateWeekSchemaValidationResult {
  ok: boolean;
  value?: AIGenerateWeekOutput;
  errors: string[];
}

function validateGenerateWeekExercise(raw: unknown, path: string, errors: string[]): AIGenerateWeekExerciseProposal | null {
  const base = validateExercise(raw, path, errors);
  const e = raw as Record<string, unknown> | null;
  const classification = e && typeof e === 'object' ? e.classification : undefined;
  if (typeof classification !== 'string' || !(CLASSIFICATIONS as readonly string[]).includes(classification)) {
    errors.push(`${path}.classification: expected one of ${CLASSIFICATIONS.join('|')}`);
    return null;
  }
  if (!base) return null;
  return { ...base, classification: classification as AIGenerateWeekExerciseProposal['classification'] };
}

function validateDaySession(raw: unknown, path: string, errors: string[]): AIGenerateWeekDaySession | null {
  if (raw === null) return null;
  if (typeof raw !== 'object') {
    errors.push(`${path}: expected an object or null`);
    return null;
  }
  const s = raw as Record<string, unknown>;
  let valid = true;

  if (s.sessionPurpose !== null && typeof s.sessionPurpose !== 'string') {
    errors.push(`${path}.sessionPurpose: expected a string or null`);
    valid = false;
  }
  if (!isNonNegativeNumber(s.availableMinutes)) {
    errors.push(`${path}.availableMinutes: expected a non-negative number`);
    valid = false;
  }
  if (!isNonNegativeNumber(s.estimatedMinutes)) {
    errors.push(`${path}.estimatedMinutes: expected a non-negative number`);
    valid = false;
  }

  let exercises: AIGenerateWeekExerciseProposal[] | null = null;
  if (!Array.isArray(s.exercises)) {
    errors.push(`${path}.exercises: expected an array`);
    valid = false;
  } else {
    const validated = s.exercises.map((e, i) => validateGenerateWeekExercise(e, `${path}.exercises[${i}]`, errors));
    exercises = validated.every((e): e is AIGenerateWeekExerciseProposal => e !== null) ? (validated as AIGenerateWeekExerciseProposal[]) : null;
    if (!exercises) valid = false;
  }

  let skipped: string[] | null = null;
  if (!isStringArray(s.skipped)) {
    errors.push(`${path}.skipped: expected an array of strings`);
    valid = false;
  } else if (s.skipped.some(containsDangerousContent)) {
    errors.push(`${path}.skipped: contains disallowed content (script/SQL-like text)`);
    valid = false;
  } else {
    skipped = s.skipped;
  }

  if (!valid || exercises === null || skipped === null) return null;
  return {
    sessionPurpose: (s.sessionPurpose as string | null) ?? null,
    availableMinutes: s.availableMinutes as number,
    estimatedMinutes: s.estimatedMinutes as number,
    exercises,
    skipped,
  };
}

function validateDay(raw: unknown, index: number, errors: string[]): AIGenerateWeekDay | null {
  const path = `days[${index}]`;
  if (typeof raw !== 'object' || raw === null) {
    errors.push(`${path}: expected an object`);
    return null;
  }
  const d = raw as Record<string, unknown>;
  let valid = true;

  if (!isIsoDate(d.date)) {
    errors.push(`${path}.date: expected an ISO date string (YYYY-MM-DD)`);
    valid = false;
  }
  if (typeof d.weekday !== 'string' || !(WEEKDAYS as readonly string[]).includes(d.weekday)) {
    errors.push(`${path}.weekday: expected one of ${WEEKDAYS.join('|')}`);
    valid = false;
  }
  if (typeof d.activity !== 'string' || !(ACTIVITIES as readonly string[]).includes(d.activity)) {
    errors.push(`${path}.activity: expected one of ${ACTIVITIES.join('|')}`);
    valid = false;
  }

  const session = validateDaySession(d.session ?? null, `${path}.session`, errors);
  if (d.session !== null && d.session !== undefined && session === null && errors.length === 0) valid = false;

  if (!valid) return null;
  return {
    date: d.date as string,
    weekday: d.weekday as AIGenerateWeekDay['weekday'],
    activity: d.activity as AIGenerateWeekDay['activity'],
    session,
  };
}

export function validateGenerateWeekSchema(raw: unknown): GenerateWeekSchemaValidationResult {
  const errors: string[] = [];

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['response: expected a JSON object'] };
  }
  const obj = raw as Record<string, unknown>;

  if (obj.schemaVersion !== AI_GENERATE_WEEK_SCHEMA_VERSION) {
    errors.push(`schemaVersion: expected "${AI_GENERATE_WEEK_SCHEMA_VERSION}", received ${JSON.stringify(obj.schemaVersion)}`);
  }
  if (obj.proposalId !== undefined && typeof obj.proposalId !== 'string') {
    errors.push('proposalId: expected a string when present');
  }
  if (obj.mode !== 'generate_week') {
    errors.push(`mode: expected "generate_week", received ${JSON.stringify(obj.mode)}`);
  }
  if (!isIsoDate(obj.weekStart)) {
    errors.push('weekStart: expected an ISO date string (YYYY-MM-DD)');
  }

  let days: AIGenerateWeekDay[] | null = null;
  if (!Array.isArray(obj.days)) {
    errors.push('days: expected an array');
  } else if (obj.days.length !== 7) {
    errors.push(`days: expected exactly 7 entries (Monday..Sunday), received ${obj.days.length}`);
  } else {
    const validated = obj.days.map((d, i) => validateDay(d, i, errors));
    days = validated.every((d): d is AIGenerateWeekDay => d !== null) ? (validated as AIGenerateWeekDay[]) : null;
  }

  const weekRationale = typeof obj.weekRationale === 'string' && !containsDangerousContent(obj.weekRationale) ? obj.weekRationale : null;
  if (weekRationale === null) errors.push('weekRationale: expected a safe string');

  const warnings = isStringArray(obj.warnings) ? obj.warnings : null;
  if (!warnings) errors.push('warnings: expected an array of strings');

  if (errors.length > 0 || !days || weekRationale === null || !warnings) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    errors: [],
    value: {
      schemaVersion: AI_GENERATE_WEEK_SCHEMA_VERSION,
      proposalId: typeof obj.proposalId === 'string' ? obj.proposalId : '',
      mode: 'generate_week',
      weekStart: obj.weekStart as string,
      days,
      weekRationale,
      warnings,
    },
  };
}
