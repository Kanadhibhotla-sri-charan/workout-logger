// Mirrors workout-blueprint's own app/src/types/*.ts (as of the commit
// recorded in snapshot/manifest.json). This file is intentionally a copy of
// shape, not a dependency on workout-blueprint's build: Blueprint is a
// separate, standalone app and this repo does not import its source.
//
// Do NOT hand-edit snapshot/*.json to match a changed shape here — run
// `npm run sync-blueprint` against an updated workout-blueprint checkout
// instead, and update these types to match what it produces.

export type ExerciseType = 'compound' | 'isolation';
export type Laterality = 'bilateral' | 'unilateral' | 'alternating';
export type DemandLevel = 'low' | 'medium' | 'high';
export type ReviewStatus = 'draft' | 'needs-review' | 'reviewed';
export type VideoStatus = 'verified' | 'needs-review' | 'broken';

export interface BlueprintExercise {
  id: string;
  name: string;
  summary: string;
  why_this_exists: string;
  body_regions: string[];
  primary_targets: string[];
  secondary_targets: string[] | null;
  /** Absent entirely (not just null) on ~8% of records — the YAML source
   * omits the key rather than writing `physique_targets: null` when it
   * doesn't apply. Always read via `e.physique_targets ?? null`, never
   * assume the key exists. */
  physique_targets?: string[] | null;
  /** Absent entirely on ~94% of records, same reasoning as
   * physique_targets — read via `e.functional_goals ?? null`. */
  functional_goals?: string[] | null;
  aesthetic_characteristics: string[] | null;
  movement_patterns: string[];
  equipment: string[];
  exercise_type: ExerciseType;
  laterality: Laterality;
  coverage_categories: string[];
  resistance_profile: string;
  stability_demand: DemandLevel;
  skill_demand: DemandLevel;
  setup_time: DemandLevel;
  fatigue_cost: DemandLevel;
  best_used_when: string[];
  less_suitable_when: string[] | null;
  mirror_effect: string;
  advantages: string[] | null;
  limitations: string[];
  technique_cues: string[] | null;
  common_mistakes: string[] | null;
  programming_notes: string[] | null;
  alternatives: string[] | null;
  complements: string[] | null;
  overlaps_with: string[] | null;
  evidence_notes: string[] | null;
  review_status: ReviewStatus;
  video_link?: string | null;
  video_creator?: string | null;
  video_title?: string | null;
  video_status?: VideoStatus | null;
  /** Source YAML filename; not a canonical / stable field. */
  _file: string;
}

export interface BlueprintPhysiqueTarget {
  id: string;
  name: string;
  parent_region: string;
  definition: string;
  physique_outcome: string;
}

export interface BlueprintAestheticOutcome {
  id: string;
  display_name: string;
  region: string;
  viewpoint: string;
  primary_targets: string[];
  /** Optional in the raw Blueprint snapshot data — a real minority of
   * aesthetic outcomes (verified: 22 of ~46 in
   * src/blueprint/snapshot/programming.json) have no supporting_targets
   * field at all, not an empty array. Every reader must treat it as
   * possibly absent (`?? []`), never assume it exists — see
   * src/engine/goalResolver.ts's buildPriorityMap, the one real
   * consumer, and this type's own regression test in
   * tests/blueprintAdapter.test.ts. */
  supporting_targets?: string[];
  technical_explanation: string;
  /** Example phrasings a user might type to describe this outcome
   * (e.g. "My chest looks flat from the side.") — the only
   * natural-language matching input Blueprint provides; see
   * src/engine/goalCreation.ts. Blueprint's functional goals have no
   * equivalent field. */
  common_user_phrasings: string[];
}

export interface BlueprintFunctionalGoal {
  id: string;
  name: string;
  parent_region: string;
  definition: string;
  why_it_matters: string;
}

/**
 * Blueprint's own generic training-methodology guidance — not
 * per-exercise or per-target data, one shared set of principles. This is
 * the closest thing Blueprint provides to an approved volume/progression
 * model; see src/engine/volumeEngine.ts and src/engine/progressionEngine.ts,
 * which build directly on these fields rather than inventing their own
 * numbers. Verified directly against
 * src/blueprint/snapshot/programming.json (was typed `unknown` before —
 * a real, stable field this app was simply not exposing yet).
 */
export interface BlueprintGlobalPrinciples {
  rir: {
    /** [min, max] reps-in-reserve considered usable at all. */
    full_range: [number, number];
    /** [min, max] — where most working sets should sit. */
    typical_working_range: [number, number];
    explanation: string;
    guidance: string;
  };
  weekly_volume: {
    /** [min, max] hard sets/muscle/week — a conservative starting point. */
    starting_point_sets: [number, number];
    /** [min, max] — the broader typical productive range beyond the
     * starting point. */
    practical_range_sets: [number, number];
    /** [min, max] — achievable only with good individual recovery
     * management; not a target to reach for its own sake. */
    higher_recovery_dependent_sets: [number, number];
    explanation: string;
  };
  frequency: {
    /** [min, max] sessions/week a given muscle is typically trained. */
    typical_starting_range_per_week: [number, number];
    explanation: string;
  };
  progression: {
    /** Currently always "double-progression" — see `explanation` for
     * the exact rule: add reps at a fixed load until the top of the
     * target rep range is reached at the target RIR, then increase load
     * and let reps fall back toward the bottom of the range. */
    model: string;
    explanation: string;
    scope_note: string;
  };
  wording_rules: {
    prefer: string[];
    avoid: string[];
    note: string;
  };
}

/** One exercise's role within a BlueprintDevelopmentPackage — real
 * per-exercise sets/reps/RIR prescriptions Blueprint itself authored,
 * not a value this app invented. `reps`/`rir` are ranges as free text
 * (e.g. "6-12", "1-3") — parsed by
 * src/blueprint/developmentPackages.ts's parseRange, never
 * hand-parsed ad hoc by a caller. */
export interface BlueprintDevelopmentPackageExercise {
  exercise_id: string;
  order: number;
  sets: number;
  reps: string;
  rir: string;
  role: string;
  contribution: string;
}

export interface BlueprintDevelopmentPackage {
  id: string;
  muscle_group: string;
  /** Currently always "efficient" or "complete" — the fewer- vs.
   * more-exercise variant for the same muscle_group. */
  level: string;
  display_name: string;
  objective: string;
  exercises: BlueprintDevelopmentPackageExercise[];
  frequency: { sessions_per_week: number };
  rationale: string;
}

export interface BlueprintMuscleGroup {
  id: string;
  name: string;
  /** physique_target ids belonging to this muscle_group — the join key
   * between a Goal's PrioritizedTarget and this muscle_group's
   * development packages. */
  target_ids: string[];
}

export interface BlueprintDevelopmentPackages {
  muscle_groups: BlueprintMuscleGroup[];
  packages: BlueprintDevelopmentPackage[];
}

export interface BlueprintProgramming {
  physiqueTargets: BlueprintPhysiqueTarget[];
  globalPrinciples: BlueprintGlobalPrinciples;
  repRanges: unknown;
  programmingProfiles: unknown;
  intensityTechniques: unknown[];
  aestheticOutcomes: BlueprintAestheticOutcome[];
  functionalGoals: BlueprintFunctionalGoal[];
  developmentPackages: BlueprintDevelopmentPackages;
}

export interface BlueprintManifest {
  source: string;
  sourceCommit: string;
  generatedAt: string;
  exerciseCount: number;
}

/** Equipment has no canonical catalog in Blueprint — it's an open,
 * free-text vocabulary carried only on Exercise.equipment. The adapter
 * derives the set of known values from the exercise list. */
export interface BlueprintEquipment {
  id: string;
  exerciseCount: number;
}
