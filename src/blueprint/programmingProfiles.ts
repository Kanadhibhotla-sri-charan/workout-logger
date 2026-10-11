// Blueprint Programming Profiles (programming-profiles.yaml upstream): the
// deterministic exercise -> profile classification Blueprint's own
// programmingEngine.ts (resolveProgrammingProfile / resolveRepRange) uses,
// ported as a load step only — first matching rule wins, in file order,
// over exercise_type / coverage_categories / stability_demand. Blueprint's
// development packages copy their `reps` from exactly this lookup
// (development-packages.yaml header), so a rep range resolved here never
// contradicts an authored package prescription for the same exercise
// (tests/blueprint/programmingProfiles.test.ts checks that).

import { BlueprintAdapter } from './adapter.js';
import type { BlueprintExercise, BlueprintProgrammingProfileMatch, DemandLevel } from './types.js';

const DEMAND_LEVELS: readonly DemandLevel[] = ['low', 'medium', 'high'];

/** Blueprint's own fallback for an exercise matching no rule (impossible with
 * today's compound/isolation catch-all rules, kept for parity). */
const FALLBACK_PRIMARY_RANGE: [number, number] = [8, 15];

function matchesProfileRule(exercise: BlueprintExercise, match: BlueprintProgrammingProfileMatch): boolean {
  if (match.exercise_type && exercise.exercise_type !== match.exercise_type) return false;
  if (match.coverage_categories_any && !match.coverage_categories_any.some((c) => exercise.coverage_categories.includes(c))) return false;
  if (match.stability_demand_at_least && DEMAND_LEVELS.indexOf(exercise.stability_demand) < DEMAND_LEVELS.indexOf(match.stability_demand_at_least)) return false;
  return true;
}

/** The resolved profile's primary rep range for an exercise, after
 * Blueprint's exercise-specific rep-range overrides (empty today). */
export function resolvePrimaryRepRange(exercise: BlueprintExercise): [number, number] {
  const override = BlueprintAdapter.getRepRangeOverrides().find((o) => o.exercise_id === exercise.id);
  if (override) return override.primary_range;
  const { profiles, classification } = BlueprintAdapter.getProgrammingProfiles();
  const rule = classification.defaults.find((r) => matchesProfileRule(exercise, r.match));
  const profile = rule ? profiles.find((p) => p.id === rule.profile_id) : undefined;
  return profile?.primary_range ?? FALLBACK_PRIMARY_RANGE;
}

/** Sets for an exercise with no package prescription: 3 for a compound, 2
 * for an isolation — the split every compound (15/15) and most isolation
 * (26/31) entries in Blueprint's development packages already follow. */
export const DEFAULT_COMPOUND_SETS = 3;
export const DEFAULT_ISOLATION_SETS = 2;

export interface DefaultPrescription {
  sets: number;
  reps: { min: number; max: number };
  rir: { min: number; max: number };
}

/** The prescription a non-package exercise gets in the wide exercise pool:
 * Blueprint profile reps, Blueprint's global working RIR range, and the
 * package-consistent set split. Null for an unknown exercise. */
export function defaultPrescriptionFor(exerciseId: string): DefaultPrescription | null {
  const exercise = BlueprintAdapter.getExercise(exerciseId);
  if (!exercise) return null;
  const [repsMin, repsMax] = resolvePrimaryRepRange(exercise);
  const [rirMin, rirMax] = BlueprintAdapter.getGlobalPrinciples().rir.typical_working_range;
  return {
    sets: exercise.exercise_type === 'compound' ? DEFAULT_COMPOUND_SETS : DEFAULT_ISOLATION_SETS,
    reps: { min: repsMin, max: repsMax },
    rir: { min: rirMin, max: rirMax },
  };
}
