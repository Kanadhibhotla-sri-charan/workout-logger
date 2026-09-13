// A plain-JSON description of AIWeekReconciliationOutput's required
// shape, sent to the provider as `outputSchema` — prompting material
// only (same convention as programmerOutputSchema.ts). Real validation
// is validation/weekReconciliationOutputValidator.ts and
// weekReconciliationDomainValidator.ts, which trust nothing about what
// the provider actually returned.

import { AI_WEEK_RECONCILIATION_SCHEMA_VERSION } from './weekReconciliationTypes.js';

const EXERCISE_SCHEMA = {
  type: 'object',
  required: ['exerciseId', 'role', 'targetType', 'targetId', 'classification', 'sets', 'repsMin', 'repsMax', 'rirMin', 'rirMax', 'rationale', 'source'],
  properties: {
    exerciseId: { type: 'string', description: 'Must be an exact id from the supplied validExercises catalogue.' },
    role: { enum: ['primary', 'secondary', 'accessory', 'isolation', 'conditioning'] },
    targetType: { enum: ['physique_target', 'functional_goal'] },
    targetId: { type: 'string', description: 'Must be one of the target IDs supplied in context.targets.' },
    classification: { enum: ['specialization', 'normal_development', 'maintenance'] },
    sets: { type: 'integer', minimum: 1 },
    repsMin: { type: 'integer', minimum: 1 },
    repsMax: { type: 'integer', minimum: 1 },
    rirMin: { type: 'number', minimum: 0 },
    rirMax: { type: 'number', minimum: 0 },
    restSeconds: { type: 'integer', minimum: 0 },
    rationale: { type: 'array', items: { type: 'string' } },
    source: { const: 'blueprint', description: 'Only Blueprint-catalogue exercises are accepted in this milestone.' },
  },
};

export function getWeekReconciliationOutputSchema(): unknown {
  return {
    type: 'object',
    required: ['schemaVersion', 'mode', 'targetDate', 'requestedActivity', 'days', 'reconciliation'],
    properties: {
      schemaVersion: { const: AI_WEEK_RECONCILIATION_SCHEMA_VERSION },
      mode: { const: 'reconcile_week' },
      targetDate: { type: 'string', format: 'date' },
      requestedActivity: { const: 'gym' },
      days: {
        type: 'array',
        minItems: 7,
        maxItems: 7,
        description: 'Exactly 7 entries, Monday through Sunday, covering the full week that contains targetDate. Locked days (see context.lockedDates) MUST be returned with changeType "unchanged" and session content identical to context.existingProgram for that date.',
        items: {
          type: 'object',
          required: ['date', 'weekday', 'activity', 'changeType', 'locked', 'session'],
          properties: {
            date: { type: 'string', format: 'date' },
            weekday: { enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] },
            activity: { enum: ['rest', 'gym', 'badminton', 'both', 'unselected'] },
            changeType: { enum: ['unchanged', 'modified', 'new', 'removed'] },
            locked: { type: 'boolean' },
            session: {
              oneOf: [
                { type: 'null' },
                {
                  type: 'object',
                  required: ['sessionPurpose', 'availableMinutes', 'estimatedMinutes', 'exercises', 'skipped'],
                  properties: {
                    sessionPurpose: { type: ['string', 'null'] },
                    availableMinutes: { type: 'number', minimum: 0 },
                    estimatedMinutes: { type: 'number', minimum: 0 },
                    exercises: { type: 'array', items: EXERCISE_SCHEMA },
                    skipped: { type: 'array', items: { type: 'string' } },
                  },
                },
              ],
            },
          },
        },
      },
      reconciliation: {
        type: 'object',
        required: ['changedDates', 'preservedLockedDates', 'rationale', 'warnings'],
        properties: {
          changedDates: { type: 'array', items: { type: 'string', format: 'date' } },
          preservedLockedDates: { type: 'array', items: { type: 'string', format: 'date' } },
          rationale: { type: 'string' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  };
}
