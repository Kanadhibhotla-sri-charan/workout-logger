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
import { BlueprintAdapter } from '../blueprint/adapter.js';

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
 * real Goal's own name reference (never a raw internal target id, never
 * "Goal 1"-style positional labels, which aren't a goal NAME). Null when
 * this work isn't tied to a real user Goal at all.
 *
 * Final Copy/Explanation Fixes §7: the caller (programming.ts's
 * resolveGoalNameRef) already substitutes the real Blueprint
 * functionalGoal name (e.g. "Rotator Cuff") when one exists, since
 * Blueprint's functionalGoals do carry a genuine clean title — verified
 * against src/blueprint/snapshot/programming.json. Aesthetic outcomes
 * have no equivalent (their only name-like field, display_name, is a
 * first-person problem statement like "Arms look thin from the side",
 * not a title), so their raw blueprint_ref slug still arrives here and
 * humanizeSlug remains the correct, spec-sanctioned fallback for it.
 * humanizeSlug is idempotent on an already-clean title (no hyphens to
 * replace), so this one call handles both cases correctly. */
function goalPhrase(goalNameRef: string | null): string | null {
  return goalNameRef ? humanizeSlug(goalNameRef) : null;
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
export function buildFriendlyPlannedReasoning(work: FriendlyPlannedInput, goalNameRef: string | null): string {
  const goal = goalPhrase(goalNameRef);
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

  // Final Copy/Explanation Fixes §6: decision.weekly_exposure.primary_sets
  // is genuinely ACTUAL training exposure, never a planned/prescribed
  // count — traced to src/engine/trainingState.ts's buildTrainingState,
  // which builds it from workoutSessionsRepo.getExercisePerformances
  // (real logged sets) for every real session this week, and
  // src/engine/exposureEngine.ts's calculateExerciseExposure, which
  // explicitly excludes any set not marked completed (rule D — see
  // tests/engine/exposureEngine.test.ts's "excludes uncompleted sets
  // entirely"). A merely-planned, not-yet-performed session contributes
  // nothing here. "You had ... so far this week" is therefore accurate
  // as written — it never overstates unperformed/planned work as done.
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

/** One-Pass Dev Spec v2 §18/§19 (superseding Consolidated Fix §9/§10/
 * §11's slightly different naming): the discriminated skip category
 * `workoutBuilder.ts`'s `SkippedTarget.reason_code` already assigns at
 * the exact site that decided it. Mirrors that type exactly so this
 * function can switch on it directly. */
type SkipReasonCode = 'recovery' | 'not_current_exposure' | 'adequately_covered' | 'no_volume_recommended' | 'blueprint_data_integrity';

interface FriendlySkipInput {
  target_type: TargetType;
  target_id: BlueprintId;
  target_name: string;
  reason_code: SkipReasonCode;
  reason: string;
  decision: {
    recovery: { priority_adjustment: string };
    volume_decision: { action: string } | null;
    /** Post-v2 Corrective Fix §22/§43: the real, per-day exposure-cycle
     * facts (never a calendar-week eligibility list) used to build the
     * `not_current_exposure` explanation — only ever present when the
     * engine actually reached that decision. */
    exposure_decision: {
      last_exposure_date: string | null;
      days_since_last_exposure: number | null;
      expected_exposure_interval_days: number;
      /** Post-v2 Corrective Fix v2 §3/§20: when present alongside
       * `frequency_reference_per_week`, distinguishes "not yet due by
       * spacing" from "already had its full frequency reference's worth
       * of exposures within the trailing window" — a grounded fact worth
       * surfacing distinctly (spec §20's own example: "actual exposure
       * count in the relevant window"). Optional so a caller supplying
       * only the older 3-field shape (tests, older callers) keeps
       * working unchanged. */
      actual_exposure_count_in_reference_window?: number;
      frequency_reference_per_week?: number;
    } | null;
    selection: unknown;
    last_trained: { date: string | null; days_since: number | null };
    recent_exercise_ids: readonly BlueprintId[];
    weekly_exposure: { exposure_units: number };
  };
}

/** Real exercise names for whichever of a target's `recent_exercise_ids`
 * Blueprint actually recognizes — used to name the ACTUAL exercise(s)
 * providing coverage (spec §10's "covered today by Back Squats and Leg
 * Extensions" style), never a generic "compound work" placeholder. */
function coveringExerciseNames(ids: readonly BlueprintId[]): string[] {
  return ids.map((id) => BlueprintAdapter.getExercise(id)?.name).filter((name): name is string => name != null);
}

function joinNaturally(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/** Builds the plain-language explanation for a target that received no
 * work this session. Switches exclusively on the structured
 * `reason_code` `workoutBuilder.ts` already assigned at the exact site
 * that decided this skip (One-Pass Dev Spec v2 §18/§19) — never by
 * string-matching `reason`, so an unhandled/future code is a compile
 * error here, not a silent fall-through to a generic "not prescribable"
 * bucket. `blueprint_data_integrity` is surfaced as a genuine Blueprint
 * data-integrity gap (spec §11/§18/§23), explicitly distinct from the
 * ordinary "valid but not selected today" categories — never described
 * as the target/exercise itself being invalid. */
export function buildFriendlySkipReasoning(skip: FriendlySkipInput): string {
  switch (skip.reason_code) {
    case 'recovery': {
      // Spec §11/§22: only mention the date when the engine actually
      // knows it — days_since === 0 reads better as "earlier today" than
      // a duplicated date string.
      const { date, days_since } = skip.decision.last_trained;
      if (date && days_since === 0) {
        return `${skip.target_name} was already trained earlier today, so there isn't enough recovery for another direct session.`;
      }
      if (date) {
        return `${skip.target_name} was trained directly on ${date}, so there isn't enough recovery for another direct session today.`;
      }
      return `${skip.target_name} needs more recovery time before its next real session, so no work was added today.`;
    }
    case 'not_current_exposure': {
      // Post-v2 Corrective Fix §22: "isn't due for this exposure," never
      // framed as "not this week" — distinguishes a genuinely valid
      // target that simply hasn't reached its own expected exposure
      // interval (or has no compatible training day at all) from an
      // invalid one. It remains available for the next appropriate
      // target-training session, which may fall in a later calendar
      // week — never a permanent exclusion, and never implying the
      // calendar week itself is what's being waited on.
      const exposure = skip.decision.exposure_decision;
      // Post-v2 Corrective Fix v2 §3/§20: minimum spacing satisfied is
      // not, by itself, proof of due-ness — when the actual reason is
      // the separate maximum-frequency gate (already had its full
      // reference's worth of exposures within the trailing window), say
      // so distinctly rather than implying a plain spacing wait.
      if (
        exposure?.actual_exposure_count_in_reference_window !== undefined &&
        exposure.frequency_reference_per_week !== undefined &&
        exposure.actual_exposure_count_in_reference_window >= exposure.frequency_reference_per_week
      ) {
        return `${skip.target_name} isn't due for this exposure — it's already had ${exposure.actual_exposure_count_in_reference_window} real exposure(s) within its own frequency reference (~${exposure.frequency_reference_per_week}/week). It remains available for the next appropriate target-training session.`;
      }
      if (exposure?.last_exposure_date) {
        return `${skip.target_name} isn't due for this exposure yet — it was trained directly on ${exposure.last_exposure_date}. It remains available for the next appropriate target-training session.`;
      }
      return `${skip.target_name} isn't due for this exposure — no training day fits it right now. It remains available for the next appropriate target-training session.`;
    }
    case 'adequately_covered': {
      const covering = coveringExerciseNames(skip.decision.recent_exercise_ids);
      return covering.length > 0
        ? `${skip.target_name} is already covered today by ${joinNaturally(covering)}, so another direct exercise isn't needed in this session.`
        : `${skip.target_name} is already getting enough real training this week from other exercises, so no extra direct work was needed.`;
    }
    case 'no_volume_recommended': {
      return `${skip.target_name} doesn't have a weekly training target yet.`;
    }
    case 'blueprint_data_integrity': {
      // Spec §9/§11/§18/§22/§23: a genuine Blueprint data gap — never
      // framed as "not prescribable"/"invalid," which would misleadingly
      // imply this target/exercise itself is wrong rather than the
      // underlying data being incomplete.
      return `The Blueprint data for ${skip.target_name} is incomplete, so the programmer cannot safely use it until that data is fixed — this is a data gap to fix, not a normal training decision.`;
    }
  }
}

/** One-Pass Dev Spec v2 §18/§22/§31.13: the plain-language explanation
 * for one valid candidate exercise that was NOT selected for today's
 * session, built entirely from the same structured facts every placed
 * exercise's `decision.selection` already carries (`rejected_candidates`
 * + `decisive_gate` from `exerciseSelector.selectExercise` — see
 * workoutBuilder.ts). This is deliberately never surfaced through
 * `SkippedTarget`/`skipped_targets` — a rejected candidate is not a
 * skipped target (the target itself was successfully programmed, just
 * with a different exercise), so conflating the two would violate §23's
 * "not selected" vs "invalid" distinction. Callers/UI may use this for
 * any exercise id present in a placed exercise's own
 * `decision.selection.rejected_candidates`. `decisive_gate` selects
 * between the "redundant today" framing (Gate 3 — the rejected candidate
 * was already claimed for a different target this session) and the
 * general "better variation" framing (every other gate) per spec §18's
 * `redundant_today`/`better_variation_selected` categories — both real,
 * distinct facts already produced by the selector, never invented here. */
export function buildFriendlyRejectedCandidateReasoning(input: {
  rejected_exercise_name: string;
  selected_exercise_name: string;
  decisive_gate: 'gate2_goal_relevance' | 'gate3_programming_need' | 'gate4_historical_context' | 'gate5_progression_continuity' | 'gate6_tie_break';
}): string {
  if (input.decisive_gate === 'gate3_programming_need') {
    return (
      `${input.rejected_exercise_name} is a valid exercise for this target, but ${input.selected_exercise_name} was chosen instead ` +
      `because ${input.rejected_exercise_name} is already doing work for a different target in this same session — ` +
      `${input.rejected_exercise_name} remains available for another session.`
    );
  }
  return (
    `A different valid variation (${input.selected_exercise_name}) was selected because it provides the better fit for today's ` +
    `programming objective. ${input.rejected_exercise_name} is still a valid exercise and remains available for another session.`
  );
}
