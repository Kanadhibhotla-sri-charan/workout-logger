// Frequency Engine — spec §23-24. NOT IMPLEMENTED: distributing a desired
// weekly exposure across a user's actual available training days (e.g.
// the 4-day PPL+Upper fixture) requires a rule this app has no approved
// methodology for yet — see docs/TRAINING_ENGINE_DESIGN.md §23-24.

import type { BlueprintId } from '../contracts/types.js';
import type { Weekday } from '../contracts/types.js';
import type { TargetType } from './goalResolver.js';
import { NotApprovedError } from './errors.js';

export interface FrequencyAllocationInput {
  target_type: TargetType;
  target_id: BlueprintId;
  desired_weekly_exposure_units: number;
  available_training_days: readonly Weekday[];
}

export interface FrequencyAllocation {
  target_type: TargetType;
  target_id: BlueprintId;
  sessions_per_week: number;
  assigned_days: Weekday[];
  reasoning: string;
}

/** Always throws NotApprovedError — see this file's header. */
export function allocateFrequency(_input: FrequencyAllocationInput): FrequencyAllocation {
  throw new NotApprovedError(
    'frequencyEngine',
    'frequency-allocation-model',
    'Needs an approved rule for distributing desired weekly exposure across available training days without assuming all work fits in one session — see docs/TRAINING_ENGINE_DESIGN.md §23-24.'
  );
}
