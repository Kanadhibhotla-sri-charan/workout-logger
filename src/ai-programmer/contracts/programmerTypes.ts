// AI Programmer Integration — First Vertical Slice
// (docs/CLAUDE_TASK_AI_PROGRAMMER_FIRST_VERTICAL_SLICE.md §7/§8): the
// narrow structured output contract for a single future-session
// proposal, and the provider-independent interface the application
// service depends on. Deliberately NOT the full multi-day
// Programme/Reconciliation contract described in the broader
// docs/AI_PROGRAMMER_OUTPUT_SCHEMA.md — this milestone is scoped to one
// `generate_session` proposal, per the task's explicit "do not attempt
// full-week AI generation... in this task."

import type { BlueprintId } from '../../contracts/types.js';
import type { TargetType } from '../../engine/goalResolver.js';

export const AI_WORKOUT_SESSION_PROPOSAL_SCHEMA_VERSION = 'ai-workout-session-proposal.v1' as const;

export type AIWorkoutExerciseRole = 'primary' | 'secondary' | 'accessory' | 'isolation' | 'conditioning';

/** One AI-proposed exercise within a single future session. ID-based
 * (never name-based — spec §7), explicit about source and target, and
 * strictly JSON-serializable. `source: 'blueprint'` is the only value
 * this milestone accepts (spec §10.2: "for this first milestone, prefer
 * Blueprint exercises only"). */
export interface AIWorkoutExerciseProposal {
  exerciseId: BlueprintId;
  role: AIWorkoutExerciseRole;
  targetType: TargetType;
  targetId: BlueprintId;
  sets: number;
  repsMin: number;
  repsMax: number;
  rirMin: number;
  rirMax: number;
  restSeconds?: number;
  rationale: string[];
  source: 'blueprint';
}

/** The complete AI output for `mode: "generate_session"`. A proposal
 * until it passes schema + domain validation (§10) — never persisted or
 * trusted before that. */
export interface AIWorkoutSessionProposal {
  schemaVersion: typeof AI_WORKOUT_SESSION_PROPOSAL_SCHEMA_VERSION;
  proposalId: string;
  mode: 'generate_session';
  targetDate: string;
  weekday: string;
  sessionFocus: string[];
  exercises: AIWorkoutExerciseProposal[];
  programmingRationale: string[];
  goalAlignment: string[];
  recoveryConsiderations: string[];
  warnings: string[];
}
