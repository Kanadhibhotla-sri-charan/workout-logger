// Volume Engine — spec §21-22. NOT IMPLEMENTED: personalizing Blueprint's
// generic volume-range guidance (e.g. "18-20 sets/week") into an
// individual target, and allocating it against remaining weekly capacity,
// both require a mathematical model this app has no approved rule for —
// see docs/TRAINING_ENGINE_DESIGN.md §21-22 and docs/open-decisions.md.
// The interface below establishes the module boundary and its inputs/
// outputs (§30-31) without inventing the formula.

import type { BlueprintId, TrainingExposure } from '../contracts/types.js';
import type { TargetType } from './goalResolver.js';
import { NotApprovedError } from './errors.js';

export interface VolumeAllocationInput {
  target_type: TargetType;
  target_id: BlueprintId;
  /** Blueprint's own generic guidance for this target/profile — e.g. a
   * weekly-sets range from data/programming/global-principles.yaml. Left
   * untyped here (the shape Blueprint provides, not reinterpreted). */
  blueprint_volume_guidance: unknown;
  current_exposure: TrainingExposure;
  goal_priority: number;
}

export interface VolumeAllocation {
  target_type: TargetType;
  target_id: BlueprintId;
  recommended_weekly_exposure_units: number;
  reasoning: string;
}

/** Always throws NotApprovedError — see this file's header. */
export function allocateVolume(_input: VolumeAllocationInput): VolumeAllocation {
  throw new NotApprovedError(
    'volumeEngine',
    'hypertrophy-volume-model',
    'Needs an approved rule for personalizing Blueprint\'s generic volume range against individual context (current exposure, goal priority, recovery, frequency) — see docs/TRAINING_ENGINE_DESIGN.md §21-22.'
  );
}
