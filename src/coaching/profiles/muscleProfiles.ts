// Coaching Depth Batch 1 spec §4.2: the five initial curated muscle
// programming profiles, mapped to Blueprint's own canonical
// physique-target ids (`BlueprintAdapter.getTarget(id)`) — never a
// duplicate/invented id.
//
// "Forearms" in the spec's own table is not itself a single canonical
// Blueprint target: Blueprint splits the forearm into two real,
// separately-trainable targets, `forearm-flexors` and
// `forearm-extensors` (src/blueprint/snapshot/programming.json), each
// with its own exercises. Rather than inventing a combined "forearms"
// id (explicitly forbidden — spec §4.2: "do not create a duplicate
// target"), this module applies the spec's single "Forearms" row's
// numbers to BOTH real canonical targets. This is a documented mapping
// choice, not a gap: both ids exist in Blueprint's current snapshot,
// confirmed via `BlueprintAdapter.getTarget`.

import { BlueprintAdapter } from '../../blueprint/adapter.js';
import { defaultProfileFor, validateMuscleProgrammingProfile, type MuscleProgrammingProfile } from './muscleProfileTypes.js';

interface CuratedProfileInput {
  /** The spec's own human-readable row label — kept only for mapping-gap
   * reporting, never used as an id. */
  label: string;
  targetId: string;
  preferredFrequencyPerWeek: number;
  minimumFrequencyPerWeek: number;
  maximumFrequencyPerWeek: number;
  repRangeBias: MuscleProgrammingProfile['repRangeBias'];
}

const CURATED_PROFILE_INPUTS: readonly CuratedProfileInput[] = [
  { label: 'Rectus abdominis', targetId: 'rectus-abdominis', preferredFrequencyPerWeek: 4, minimumFrequencyPerWeek: 2, maximumFrequencyPerWeek: 5, repRangeBias: 'higher' },
  { label: 'Obliques', targetId: 'obliques', preferredFrequencyPerWeek: 4, minimumFrequencyPerWeek: 2, maximumFrequencyPerWeek: 5, repRangeBias: 'higher' },
  { label: 'Gastrocnemius', targetId: 'gastrocnemius', preferredFrequencyPerWeek: 4, minimumFrequencyPerWeek: 2, maximumFrequencyPerWeek: 5, repRangeBias: 'higher' },
  { label: 'Soleus', targetId: 'soleus', preferredFrequencyPerWeek: 4, minimumFrequencyPerWeek: 2, maximumFrequencyPerWeek: 5, repRangeBias: 'higher' },
  { label: 'Forearms (forearm-flexors)', targetId: 'forearm-flexors', preferredFrequencyPerWeek: 3, minimumFrequencyPerWeek: 2, maximumFrequencyPerWeek: 4, repRangeBias: 'standard' },
  { label: 'Forearms (forearm-extensors)', targetId: 'forearm-extensors', preferredFrequencyPerWeek: 3, minimumFrequencyPerWeek: 2, maximumFrequencyPerWeek: 4, repRangeBias: 'standard' },
];

export interface MuscleProfileMappingGap {
  label: string;
  attemptedTargetId: string;
}

/** Any curated row above whose `targetId` does not exist in the
 * currently-vendored Blueprint snapshot — populated at module load,
 * never thrown (a missing target must not crash the app; it is
 * reported, per spec §4.2: "report the mapping gap. Do not create a
 * duplicate target"). Empty in normal operation; a non-empty result
 * here means Blueprint's own data changed underneath this mapping. */
export const MUSCLE_PROFILE_MAPPING_GAPS: readonly MuscleProfileMappingGap[] = CURATED_PROFILE_INPUTS.filter(
  (input) => BlueprintAdapter.getTarget(input.targetId) === undefined
).map((input) => ({ label: input.label, attemptedTargetId: input.targetId }));

/** The five (six real target-id) curated profiles — every entry
 * validated at module load (spec §4.1: invalid profiles fail validation
 * rather than being silently corrected) and every target id confirmed
 * to exist in Blueprint's own snapshot (entries whose target id does not
 * exist are excluded here and surfaced via `MUSCLE_PROFILE_MAPPING_GAPS`
 * instead). */
export const MUSCLE_PROGRAMMING_PROFILES: readonly MuscleProgrammingProfile[] = CURATED_PROFILE_INPUTS.filter(
  (input) => BlueprintAdapter.getTarget(input.targetId) !== undefined
).map((input) => {
  const profile: MuscleProgrammingProfile = {
    targetId: input.targetId,
    preferredFrequencyPerWeek: input.preferredFrequencyPerWeek,
    minimumFrequencyPerWeek: input.minimumFrequencyPerWeek,
    maximumFrequencyPerWeek: input.maximumFrequencyPerWeek,
    repRangeBias: input.repRangeBias,
    source: 'blueprint_profile',
  };
  validateMuscleProgrammingProfile(profile);
  return profile;
});

/** The curated profile for `targetId`, or the safe no-override default
 * (spec §4.3) when no curated profile exists for it. Never throws for
 * an unknown target. */
export function getProfile(targetId: string): MuscleProgrammingProfile {
  return MUSCLE_PROGRAMMING_PROFILES.find((p) => p.targetId === targetId) ?? defaultProfileFor(targetId);
}
