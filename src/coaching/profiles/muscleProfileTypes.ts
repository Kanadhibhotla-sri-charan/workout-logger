// Coaching Depth Batch 1 spec §4: muscle-specific programming profiles.
// A profile is a REFERENCE, never a guarantee — real scheduled/completed
// frequency is a separate, independently-observed fact (see
// muscleProfileService.ts's getActualScheduledFrequency/
// getActualCompletedFrequency). Nothing here invents a rep number
// outside Blueprint's own authored range for a chosen exercise —
// `repRangeBias` only ever picks which end of an ALREADY-authored range
// to lean toward.

export type RepRangeBias = 'lower' | 'standard' | 'higher';

export interface MuscleProgrammingProfile {
  /** Canonical Blueprint physique-target id (e.g. `BlueprintAdapter
   * .getTarget(id)`'s own id) — never a duplicate/invented identifier. */
  targetId: string;
  preferredFrequencyPerWeek?: number;
  minimumFrequencyPerWeek?: number;
  maximumFrequencyPerWeek?: number;
  repRangeBias?: RepRangeBias;
  /** 'blueprint_profile' for one of this module's curated initial
   * profiles; 'default' for the safe, no-override fallback
   * `getProfile` returns for any target with no curated profile. */
  source: 'blueprint_profile' | 'default';
}

/** Thrown by `validateMuscleProgrammingProfile` for a profile whose
 * fields are internally inconsistent — an invalid profile fails
 * validation rather than being silently corrected (spec §4.1). */
export class InvalidMuscleProgrammingProfileError extends Error {
  constructor(targetId: string, reason: string) {
    super(`Invalid muscle programming profile for target "${targetId}": ${reason}`);
    this.name = 'InvalidMuscleProgrammingProfileError';
  }
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/** Validates one profile's internal consistency: every supplied
 * frequency is a positive integer, and minimum <= preferred <= maximum
 * across whichever of those three fields are actually present (a
 * profile need not supply all three). Throws
 * `InvalidMuscleProgrammingProfileError` rather than silently
 * correcting anything (spec §4.1's explicit requirement). */
export function validateMuscleProgrammingProfile(profile: MuscleProgrammingProfile): void {
  const { targetId, preferredFrequencyPerWeek, minimumFrequencyPerWeek, maximumFrequencyPerWeek } = profile;

  for (const [label, value] of [
    ['preferredFrequencyPerWeek', preferredFrequencyPerWeek],
    ['minimumFrequencyPerWeek', minimumFrequencyPerWeek],
    ['maximumFrequencyPerWeek', maximumFrequencyPerWeek],
  ] as const) {
    if (value !== undefined && !isPositiveInteger(value)) {
      throw new InvalidMuscleProgrammingProfileError(targetId, `${label} must be a positive integer, got ${value}`);
    }
  }

  if (minimumFrequencyPerWeek !== undefined && preferredFrequencyPerWeek !== undefined && minimumFrequencyPerWeek > preferredFrequencyPerWeek) {
    throw new InvalidMuscleProgrammingProfileError(targetId, `minimumFrequencyPerWeek (${minimumFrequencyPerWeek}) must be <= preferredFrequencyPerWeek (${preferredFrequencyPerWeek})`);
  }
  if (preferredFrequencyPerWeek !== undefined && maximumFrequencyPerWeek !== undefined && preferredFrequencyPerWeek > maximumFrequencyPerWeek) {
    throw new InvalidMuscleProgrammingProfileError(targetId, `preferredFrequencyPerWeek (${preferredFrequencyPerWeek}) must be <= maximumFrequencyPerWeek (${maximumFrequencyPerWeek})`);
  }
  if (minimumFrequencyPerWeek !== undefined && maximumFrequencyPerWeek !== undefined && minimumFrequencyPerWeek > maximumFrequencyPerWeek) {
    throw new InvalidMuscleProgrammingProfileError(targetId, `minimumFrequencyPerWeek (${minimumFrequencyPerWeek}) must be <= maximumFrequencyPerWeek (${maximumFrequencyPerWeek})`);
  }
}

/** The safe, no-override default returned for any target with no
 * curated profile (spec §4.3: "unknown targets use safe defaults") —
 * deliberately carries no frequency/bias fields at all, so a caller
 * falls through to Blueprint's own existing defaults rather than being
 * handed an invented number. */
export function defaultProfileFor(targetId: string): MuscleProgrammingProfile {
  return { targetId, source: 'default' };
}
