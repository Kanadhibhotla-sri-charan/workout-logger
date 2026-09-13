// AI-Powered Weekly Reconciliation: structural schema validation for
// `mode: "reconcile_week"` output. Checks shape/types/enums/ranges only
// (domain checks — locked-day preservation, real exercise/target IDs,
// authored-cap enforcement — are weekReconciliationDomainValidator.ts's
// job, exactly mirroring the single-session split). Reuses
// validateExercise (the exact per-exercise core-field check
// programmerOutputValidator.ts already has) rather than a second,
// drifting copy.

import { WEEKDAYS } from '../../contracts/types.js';
import { containsDangerousContent, isIsoDate, isNonNegativeNumber, isStringArray, validateExercise } from './programmerOutputValidator.js';
import {
  AI_WEEK_RECONCILIATION_SCHEMA_VERSION,
  type AIWeekReconciliationDay,
  type AIWeekReconciliationDaySession,
  type AIWeekReconciliationExerciseProposal,
  type AIWeekReconciliationOutput,
} from '../contracts/weekReconciliationTypes.js';

const CLASSIFICATIONS = ['specialization', 'normal_development', 'maintenance'] as const;
const ACTIVITIES = ['rest', 'gym', 'badminton', 'both', 'unselected'] as const;
const CHANGE_TYPES = ['unchanged', 'modified', 'new', 'removed'] as const;

export interface WeekReconciliationSchemaValidationResult {
  ok: boolean;
  value?: AIWeekReconciliationOutput;
  errors: string[];
}

function validateReconciliationExercise(raw: unknown, path: string, errors: string[]): AIWeekReconciliationExerciseProposal | null {
  const base = validateExercise(raw, path, errors);
  const e = raw as Record<string, unknown> | null;
  const classification = e && typeof e === 'object' ? e.classification : undefined;
  if (typeof classification !== 'string' || !(CLASSIFICATIONS as readonly string[]).includes(classification)) {
    errors.push(`${path}.classification: expected one of ${CLASSIFICATIONS.join('|')}`);
    return null;
  }
  if (!base) return null;
  return { ...base, classification: classification as AIWeekReconciliationExerciseProposal['classification'] };
}

function validateDaySession(raw: unknown, path: string, errors: string[]): AIWeekReconciliationDaySession | null {
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

  let exercises: AIWeekReconciliationExerciseProposal[] | null = null;
  if (!Array.isArray(s.exercises)) {
    errors.push(`${path}.exercises: expected an array`);
    valid = false;
  } else {
    const validated = s.exercises.map((e, i) => validateReconciliationExercise(e, `${path}.exercises[${i}]`, errors));
    exercises = validated.every((e): e is AIWeekReconciliationExerciseProposal => e !== null) ? (validated as AIWeekReconciliationExerciseProposal[]) : null;
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

function validateDay(raw: unknown, index: number, errors: string[]): AIWeekReconciliationDay | null {
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
  if (typeof d.changeType !== 'string' || !(CHANGE_TYPES as readonly string[]).includes(d.changeType)) {
    errors.push(`${path}.changeType: expected one of ${CHANGE_TYPES.join('|')}`);
    valid = false;
  }
  if (typeof d.locked !== 'boolean') {
    errors.push(`${path}.locked: expected a boolean`);
    valid = false;
  }

  const session = validateDaySession(d.session ?? null, `${path}.session`, errors);
  // `session` legitimately being null is valid (rest/badminton days,
  // or a gym day the model deliberately left unpopulated) — only a
  // malformed non-null session object is an error, already pushed above.
  if (d.session !== null && d.session !== undefined && session === null && errors.length === 0) valid = false;

  if (!valid) return null;
  return {
    date: d.date as string,
    weekday: d.weekday as AIWeekReconciliationDay['weekday'],
    activity: d.activity as AIWeekReconciliationDay['activity'],
    changeType: d.changeType as AIWeekReconciliationDay['changeType'],
    locked: d.locked as boolean,
    session,
  };
}

export function validateWeekReconciliationSchema(raw: unknown): WeekReconciliationSchemaValidationResult {
  const errors: string[] = [];

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['response: expected a JSON object'] };
  }
  const obj = raw as Record<string, unknown>;

  if (obj.schemaVersion !== AI_WEEK_RECONCILIATION_SCHEMA_VERSION) {
    errors.push(`schemaVersion: expected "${AI_WEEK_RECONCILIATION_SCHEMA_VERSION}", received ${JSON.stringify(obj.schemaVersion)}`);
  }
  if (obj.proposalId !== undefined && typeof obj.proposalId !== 'string') {
    errors.push('proposalId: expected a string when present');
  }
  if (obj.mode !== 'reconcile_week') {
    errors.push(`mode: expected "reconcile_week", received ${JSON.stringify(obj.mode)}`);
  }
  if (!isIsoDate(obj.targetDate)) {
    errors.push('targetDate: expected an ISO date string (YYYY-MM-DD)');
  }
  if (obj.requestedActivity !== 'gym') {
    errors.push(`requestedActivity: expected "gym", received ${JSON.stringify(obj.requestedActivity)}`);
  }

  let days: AIWeekReconciliationDay[] | null = null;
  if (!Array.isArray(obj.days)) {
    errors.push('days: expected an array');
  } else if (obj.days.length !== 7) {
    errors.push(`days: expected exactly 7 entries (Monday..Sunday), received ${obj.days.length}`);
  } else {
    const validated = obj.days.map((d, i) => validateDay(d, i, errors));
    days = validated.every((d): d is AIWeekReconciliationDay => d !== null) ? (validated as AIWeekReconciliationDay[]) : null;
  }

  let reconciliation: AIWeekReconciliationOutput['reconciliation'] | null = null;
  if (typeof obj.reconciliation !== 'object' || obj.reconciliation === null) {
    errors.push('reconciliation: expected an object');
  } else {
    const r = obj.reconciliation as Record<string, unknown>;
    const changedDates = isStringArray(r.changedDates) && r.changedDates.every(isIsoDate) ? r.changedDates : null;
    if (!changedDates) errors.push('reconciliation.changedDates: expected an array of ISO date strings');
    const preservedLockedDates = isStringArray(r.preservedLockedDates) && r.preservedLockedDates.every(isIsoDate) ? r.preservedLockedDates : null;
    if (!preservedLockedDates) errors.push('reconciliation.preservedLockedDates: expected an array of ISO date strings');
    const rationale = typeof r.rationale === 'string' && !containsDangerousContent(r.rationale) ? r.rationale : null;
    if (rationale === null) errors.push('reconciliation.rationale: expected a safe, non-empty string');
    const warnings = isStringArray(r.warnings) ? r.warnings : null;
    if (!warnings) errors.push('reconciliation.warnings: expected an array of strings');
    if (changedDates && preservedLockedDates && rationale !== null && warnings) {
      reconciliation = { changedDates, preservedLockedDates, rationale, warnings };
    }
  }

  if (errors.length > 0 || !days || !reconciliation) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    errors: [],
    value: {
      schemaVersion: AI_WEEK_RECONCILIATION_SCHEMA_VERSION,
      proposalId: typeof obj.proposalId === 'string' ? obj.proposalId : '', // overwritten by the service with an app-generated ID regardless
      mode: 'reconcile_week',
      targetDate: obj.targetDate as string,
      requestedActivity: 'gym',
      days,
      reconciliation,
    },
  };
}
