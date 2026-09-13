// A plain-JSON description of AIWorkoutSessionProposal's required
// shape, sent to the provider as `outputSchema` (spec §8's
// AIProgrammerProviderRequest.outputSchema) so the model knows exactly
// what to return. This is prompting material only — it is NOT the
// runtime validator. Real validation happens in
// validation/programmerOutputValidator.ts and
// validation/programmerDomainValidator.ts, which trust nothing about
// what the provider actually returned.

import { AI_WORKOUT_SESSION_PROPOSAL_SCHEMA_VERSION } from './programmerTypes.js';

export function getProgrammerOutputSchema(): unknown {
  return {
    type: 'object',
    required: [
      'schemaVersion',
      'mode',
      'targetDate',
      'weekday',
      'sessionFocus',
      'exercises',
      'programmingRationale',
      'goalAlignment',
      'recoveryConsiderations',
      'warnings',
    ],
    properties: {
      schemaVersion: { const: AI_WORKOUT_SESSION_PROPOSAL_SCHEMA_VERSION },
      mode: { const: 'generate_session' },
      targetDate: { type: 'string', format: 'date', description: 'Must equal the requested targetDate exactly.' },
      weekday: { type: 'string', description: 'Must equal the real weekday of targetDate (lowercase, e.g. "monday").' },
      sessionFocus: { type: 'array', items: { type: 'string' } },
      exercises: {
        type: 'array',
        items: {
          type: 'object',
          required: ['exerciseId', 'role', 'targetType', 'targetId', 'sets', 'repsMin', 'repsMax', 'rirMin', 'rirMax', 'rationale', 'source'],
          properties: {
            exerciseId: { type: 'string', description: 'Must be an exact id from the supplied validExercises catalogue.' },
            role: { enum: ['primary', 'secondary', 'accessory', 'isolation', 'conditioning'] },
            targetType: { enum: ['physique_target', 'functional_goal'] },
            targetId: { type: 'string', description: 'Must be one of the target IDs supplied in context.targets.' },
            sets: { type: 'integer', minimum: 1 },
            repsMin: { type: 'integer', minimum: 1 },
            repsMax: { type: 'integer', minimum: 1 },
            rirMin: { type: 'number', minimum: 0 },
            rirMax: { type: 'number', minimum: 0 },
            restSeconds: { type: 'integer', minimum: 0 },
            rationale: { type: 'array', items: { type: 'string' } },
            source: { const: 'blueprint', description: 'Only Blueprint-catalogue exercises are accepted in this milestone.' },
          },
        },
      },
      programmingRationale: { type: 'array', items: { type: 'string' } },
      goalAlignment: { type: 'array', items: { type: 'string' } },
      recoveryConsiderations: { type: 'array', items: { type: 'string' } },
      warnings: { type: 'array', items: { type: 'string' } },
    },
  };
}
