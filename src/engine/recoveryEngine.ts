// Recovery Engine — spec §15. NOT IMPLEMENTED: a training-readiness
// constraint from recent exposure, spacing, and other activities needs an
// approved conservative rule this app does not have yet — see
// docs/TRAINING_ENGINE_DESIGN.md §15. This module does not attempt to
// calculate biological recovery; it would only ever gate/adjust priority
// once a rule is approved.

import type { ActivityType, BlueprintId } from '../contracts/types.js';
import type { TargetType } from './goalResolver.js';
import type { TrainingExposure } from '../contracts/types.js';
import { NotApprovedError } from './errors.js';

export interface RecoveryConstraintInput {
  target_type: TargetType;
  target_id: BlueprintId;
  rolling_exposure: TrainingExposure;
  days_since_target_last_trained: number | null;
  other_activity_today: readonly ActivityType[];
}

export interface RecoveryConstraintResult {
  target_type: TargetType;
  target_id: BlueprintId;
  priority_adjustment: 'none' | 'reduce' | 'avoid';
  reasoning: string;
}

/** Always throws NotApprovedError — see this file's header. */
export function applyRecoveryConstraint(_input: RecoveryConstraintInput): RecoveryConstraintResult {
  throw new NotApprovedError(
    'recoveryEngine',
    'recovery-methodology',
    'Needs an approved conservative training-readiness rule (recent exposure + spacing + other activities -> priority adjustment) — see docs/TRAINING_ENGINE_DESIGN.md §15.'
  );
}
