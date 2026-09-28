// One place that answers "what is the most sets one exercise may receive
// for this target in one session" so the single-session path (which gets it
// from the programming brief) and the whole-week path (which has no brief)
// can never disagree. It is the smaller of the exercise's own authored sets
// and the target's per-exposure development cap; the second half is what this
// module supplies.

import { developmentPackageLevelFor, getDevelopmentReference } from '../../engine/developmentReferenceEngine.js';
import type { TargetType } from '../../engine/goalResolver.js';

export interface SetCapTarget {
  targetType: string;
  targetId: string;
  isSpecialization: boolean;
}

/** The target's `direct_sets_per_exposure`, or null when it has none
 * (a functional goal, or a physique target with no development package). */
export function directSetsPerExposureCapFor(target: SetCapTarget): number | null {
  if (target.targetType !== 'physique_target') return null;
  return getDevelopmentReference(target.targetType as TargetType, target.targetId, developmentPackageLevelFor(target.isSpecialization)).direct_sets_per_exposure;
}
