// Workout Programmer UI Fix §4-§10: human-readable programming
// explanations, built entirely from the engine's own STRUCTURED
// DecisionExplanation data (never by string-parsing the internal
// `reasoning`/`reason` text, and never inventing a fact the structured
// data doesn't actually contain). This is a presentation layer only —
// the internal `reasoning`/`reason` strings and the full `decision`
// object are never deleted; they simply aren't what the normal UI
// renders any more (see logger.html/today.html/program.html, which now
// render `friendly_reasoning`/`friendly_reason` instead of the raw
// jargon-laden strings, while the underlying JSON payload still carries
// the original fields for anyone who needs them).

import type { TargetType } from '../engine/goalResolver.js';
import type { BlueprintId } from '../contracts/types.js';

/** "arm-side-thickness" -> "arm side thickness". The only generic,
 * always-available humanization of a Blueprint slug this app can do
 * without inventing a name Blueprint never authored — used only when
 * no better human-readable representation exists (spec §5). */
export function humanizeSlug(id: string): string {
  return id.replace(/[-_]+/g, ' ').trim();
}

function pluralSets(n: number): string {
  return `${n} set${n === 1 ? '' : 's'}`;
}

/** The user's own goal phrasing — "your <goal> goal" — derived from the
 * real Goal's own Blueprint reference id (never a raw internal target
 * id, never "Goal 1"-style positional labels, which aren't a goal
 * NAME). Null when this work isn't tied to a real user Goal at all. */
function goalPhrase(goalBlueprintRef: string | null): string | null {
  return goalBlueprintRef ? humanizeSlug(goalBlueprintRef) : null;
}

interface FriendlyPlannedInput {
  target_name: string;
  exercise_name: string;
  role: string;
  classification: 'specialization' | 'normal_development' | 'maintenance';
  sets: number;
  reps_min: number;
  reps_max: number;
  rir_min: number;
  rir_max: number;
  progression_decision: { recommendation: string } | null;
  decision: { weekly_exposure: { primary_sets: number } };
}

/** Builds the plain-language explanation for one placed exercise,
 * answering exactly the four questions spec §4 asks for: why added,
 * what muscle it trains, how that relates to the user's active goal,
 * and how much this target has already been trained this week. */
export function buildFriendlyPlannedReasoning(work: FriendlyPlannedInput, goalBlueprintRef: string | null): string {
  const goal = goalPhrase(goalBlueprintRef);
  const isSecondary = work.role === 'secondary';
  const sentences: string[] = [];

  if (isSecondary) {
    sentences.push(goal ? `Supports your ${goal} goal.` : 'Supports your overall physique development.');
    sentences.push(`${work.exercise_name} trains the ${work.target_name} as a secondary muscle, adding useful additional work without requiring another dedicated exercise.`);
  } else if (work.classification === 'specialization' && goal) {
    sentences.push(`Added for your ${goal} goal.`);
    sentences.push(`${work.exercise_name} primarily trains the ${work.target_name}, helping build the development you're targeting.`);
  } else if (work.classification === 'maintenance') {
    sentences.push('Added to maintain your current development.');
    sentences.push(`${work.exercise_name} primarily trains the ${work.target_name}.`);
  } else {
    sentences.push('Added for overall physique development.');
    sentences.push(`${work.exercise_name} develops your ${work.target_name}, which is not currently an active goal but still needs regular development to keep your overall physique balanced.`);
  }

  const priorSets = work.decision.weekly_exposure.primary_sets;
  sentences.push(
    priorSets > 0
      ? `You had ${pluralSets(priorSets)} for this target so far this week, so this session adds another ${pluralSets(work.sets)} toward the weekly development target.`
      : "You haven't trained this target yet this week, so it was prioritized here."
  );

  const reps = work.reps_min === work.reps_max ? `${work.reps_min}` : `${work.reps_min}–${work.reps_max}`;
  const rir = work.rir_min === work.rir_max ? `${work.rir_min}` : `${work.rir_min}–${work.rir_max}`;
  sentences.push(`Use ${reps} reps and finish with roughly ${rir} rep(s) in reserve.`);

  if (work.progression_decision) {
    if (work.progression_decision.recommendation === 'reduce') {
      sentences.push('Recent sessions of this exercise have been falling short, so this session is scaled back a little to help you recover.');
    } else if (work.progression_decision.recommendation === 'increase') {
      sentences.push("Based on your previous performance, it's time to push a bit further this session.");
    } else {
      sentences.push('Based on your previous performance, this continues your progression from the last time you used this variation.');
    }
  } else {
    sentences.push('First time using this variation in your logged history, so start with a weight that lets you stay within the prescribed rep range with good form.');
  }

  return sentences.join(' ');
}

interface FriendlySkipInput {
  target_type: TargetType;
  target_id: BlueprintId;
  target_name: string;
  reason: string;
  decision: {
    recovery: { priority_adjustment: string };
    volume_decision: { action: string } | null;
    weekly_allocation: { eligible_days_this_week: readonly string[] } | null;
    selection: unknown;
  };
}

/** Builds the plain-language explanation for a target that received no
 * work this session. Picks the category primarily from real, already-
 * computed structured signals; where no dedicated structured field
 * distinguishes a case (e.g. "already adequately exposed" vs "no
 * resolvable prescription"), this matches on the same stable,
 * workoutBuilder.ts-own-generated `reason` substrings
 * weekProgramReconciliation.ts's classifyDeviationReason already relies
 * on for the identical reason (see its own doc comment) — never a
 * third-party or user-authored string. */
export function buildFriendlySkipReasoning(skip: FriendlySkipInput): string {
  if (skip.decision.recovery.priority_adjustment !== 'none') {
    return `${skip.target_name} needs more recovery time before its next real session, so no work was added today.`;
  }
  if (skip.decision.weekly_allocation && skip.decision.weekly_allocation.eligible_days_this_week.length === 0) {
    return `${skip.target_name} isn't scheduled on any of your training days this week.`;
  }
  if (skip.reason.includes('adequately exposed')) {
    return `${skip.target_name} is already getting enough real training this week from other exercises, so no extra direct work was needed.`;
  }
  if (skip.reason.includes('No weekly volume recommended')) {
    return `${skip.target_name} doesn't have a weekly training target yet.`;
  }
  return `We don't have a confidently prescribable exercise for ${skip.target_name} right now, so it was left out rather than guessed at.`;
}
