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

export const TRAINING_MODES = ['power', 'agility', 'movement-strength', 'mobility-hold', 'mobility-dynamic', 'conditioning', 'soft-tissue'] as const;
export type TrainingMode = (typeof TRAINING_MODES)[number];

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
  /** Athletic drill mode (Blueprint 89dd2d6). Absent = hypertrophy-oriented
   * record. A drill is recommended only for the functional goals it carries. */
  training_mode?: TrainingMode | null;
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
  /** Schema 2: credited sets per hard set, per target / volume group /
   * goal id (weights in (0, 1]). Absent on non-strength records. */
  target_credit?: Record<string, number>;
  /** Schema 2: time cost per exercise (request 2.2). */
  time?: BlueprintExerciseTime;
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
  /** Schema 2: a sub-region's volume parent (a target or volume group). */
  parent?: string;
  volume_share?: number;
  min_share?: number;
}

export interface BlueprintExerciseTime {
  setup_minutes: number;
  seconds_per_set: number;
  rest_seconds: [number, number];
  per_side: boolean;
  superset_friendly: boolean;
}

export type BlueprintVolumeLevel = 'minimum' | 'efficient' | 'priority';

/** Schema 2 volume-targets.yaml entry: credited hard sets per 7 days.
 * A child (sub-region) carries volume_from_parent instead of numbers. */
export interface BlueprintVolumeTarget {
  target_id?: string;
  goal_id?: string;
  weekly_sets?: Record<BlueprintVolumeLevel, number>;
  per_session_max?: number;
  indirect_only?: boolean;
  sessions_per_week?: [number, number];
  min_hours_between?: number;
  volume_from_parent?: string;
  rationale?: string;
}

/** Schema 2 mobility target: weekly minutes for a mobility goal. */
export interface BlueprintMobilityTarget {
  goal_id: string;
  weekly_minutes: number;
  sessions_per_week: [number, number];
}

export interface BlueprintVolumeGroup {
  id: string;
  name: string;
  parent_region: string;
  definition: string;
}

export interface BlueprintAestheticOutcome {
  id: string;
  display_name: string;
  region: string;
  viewpoint: string;
  primary_targets: string[];
  /** Schema 2: the volume level each target gets for this outcome; a
   * child's level is given to its parent and the child marked 'bias'. */
  volume_levels?: Array<{ target_id: string; level: 'priority' | 'efficient' | 'bias' }>;
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

/** Coaching Depth Batch 5 (Phase 5): Blueprint's own authoritative
 * intensity-technique catalog — real, vendored data (see
 * snapshot/programming.json's `intensityTechniques`), never an
 * app-invented list. `suitable_when_*_at_most` are real Blueprint
 * `DemandLevel` ceilings expressed against Exercise's own
 * `fatigue_cost`/`skill_demand`/`stability_demand` fields — the same
 * demand vocabulary Blueprint already uses everywhere else. */
export interface BlueprintIntensityTechnique {
  id: string;
  name: string;
  what: string;
  when_it_may_help: string;
  when_not_to_use: string;
  fatigue_time_implications: string;
  suitable_exercise_types: ExerciseType[];
  suitable_when_fatigue_cost_at_most: DemandLevel;
  suitable_when_skill_demand_at_most: DemandLevel;
  suitable_when_stability_demand_at_most: DemandLevel;
}

/** One programming-profiles.yaml classification rule's match clause: every
 * present field must hold (first matching rule wins, in file order). */
export interface BlueprintProgrammingProfileMatch {
  exercise_type?: ExerciseType;
  coverage_categories_any?: string[];
  stability_demand_at_least?: DemandLevel;
  training_mode?: TrainingMode;
}

export interface BlueprintProgrammingProfile {
  id: string;
  name: string;
  primary_range: [number, number];
  acceptable_range: [number, number];
  /** Athletic-mode profiles only (Blueprint 89dd2d6); hypertrophy profiles omit these. */
  training_mode?: TrainingMode;
  /** What primary_range counts. Absent = reps. */
  unit?: 'reps' | 'seconds';
  sets?: [number, number];
  rest_seconds?: [number, number];
  effort?: string;
  frequency_per_week?: [number, number];
}

export interface BlueprintProgrammingProfiles {
  profiles: BlueprintProgrammingProfile[];
  classification: { defaults: Array<{ profile_id: string; match: BlueprintProgrammingProfileMatch }> };
}

export interface BlueprintRepRangeOverride {
  exercise_id: string;
  primary_range: [number, number];
  acceptable_range: [number, number];
}

export interface BlueprintProgramming {
  physiqueTargets: BlueprintPhysiqueTarget[];
  globalPrinciples: BlueprintGlobalPrinciples;
  repRanges: unknown;
  programmingProfiles: unknown;
  intensityTechniques: BlueprintIntensityTechnique[];
  aestheticOutcomes: BlueprintAestheticOutcome[];
  functionalGoals: BlueprintFunctionalGoal[];
  developmentPackages: BlueprintDevelopmentPackages;
  /** Schema 2 (Blueprint 2026-10-27); absent in older snapshots. */
  schemaVersion?: number;
  volumeGroups?: BlueprintVolumeGroup[];
  volumeTargets?: BlueprintVolumeTarget[];
  mobilityTargets?: BlueprintMobilityTarget[];
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
