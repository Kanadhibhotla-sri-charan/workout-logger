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
  physique_targets: string[] | null;
  functional_goals: string[] | null;
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
  supporting_targets: string[];
  technical_explanation: string;
}

export interface BlueprintFunctionalGoal {
  id: string;
  name: string;
  parent_region: string;
  definition: string;
  why_it_matters: string;
}

export interface BlueprintProgramming {
  physiqueTargets: BlueprintPhysiqueTarget[];
  globalPrinciples: unknown;
  repRanges: unknown;
  programmingProfiles: unknown;
  intensityTechniques: unknown[];
  aestheticOutcomes: BlueprintAestheticOutcome[];
  functionalGoals: BlueprintFunctionalGoal[];
  developmentPackages: unknown;
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
