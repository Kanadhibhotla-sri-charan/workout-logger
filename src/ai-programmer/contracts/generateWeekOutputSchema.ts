// A plain-JSON description of AIGenerateWeekOutput's required shape,
// sent to the provider as `outputSchema` — prompting material only, same
// convention as programmerOutputSchema.ts / weekReconciliationOutputSchema.ts.
// Real validation is validation/generateWeekOutputValidator.ts and
// generateWeekDomainValidator.ts, which trust nothing about what the
// provider actually returned.

import { AI_GENERATE_WEEK_SCHEMA_VERSION } from './generateWeekTypes.js';

const EXERCISE_SCHEMA = {
  type: 'object',
  required: ['exerciseId', 'targetType', 'targetId', 'classification', 'sets', 'repsMin', 'repsMax', 'rirMin', 'rirMax', 'rationale', 'source'],
  properties: {
    exerciseId: { type: 'string', description: 'Must be an exact id from the supplied validExercises catalogue.' },
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
    source: { const: 'blueprint', description: 'Only Blueprint-catalogue exercises are accepted.' },
  },
};

export function getGenerateWeekOutputSchema(): unknown {
  return {
    type: 'object',
    required: ['schemaVersion', 'mode', 'weekStart', 'days', 'weekRationale', 'warnings'],
    properties: {
      schemaVersion: { const: AI_GENERATE_WEEK_SCHEMA_VERSION },
      mode: { const: 'generate_week' },
      weekStart: { type: 'string', format: 'date', description: 'Must exactly equal context.reportingBoundary.weekStart (this week\'s own Monday).' },
      days: {
        type: 'array',
        minItems: 7,
        maxItems: 7,
        description: 'Exactly 7 entries, Monday through Sunday, covering the complete week starting at weekStart. There is no existing week to fall back on for any day you omit.',
        items: {
          type: 'object',
          required: ['date', 'weekday', 'activity', 'session'],
          properties: {
            date: { type: 'string', format: 'date' },
            weekday: { enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] },
            activity: { enum: ['rest', 'gym', 'badminton', 'both', 'unselected'] },
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
      weekRationale: { type: 'string' },
      warnings: { type: 'array', items: { type: 'string' } },
    },
  };
}
