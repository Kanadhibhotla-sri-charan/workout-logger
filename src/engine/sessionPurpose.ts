// Session Purpose — Final Programming-Engine Pass §5, §9, §10.
//
// "The planner must understand the purpose of the four gym sessions
// relative to each other. It must not treat four gym days as four
// interchangeable buckets." This module owns exactly two real
// decisions: which PPL+Upper purpose each of the week's actual gym
// days gets (deterministic rotation, never spreadDays' even
// mathematical spreading — see workoutBuilder.ts's weekly allocator for
// how the resulting purposes actually gate which target trains on
// which day), and whether a given physique_target is compatible with
// a given purpose at all (config.ts's SESSION_PURPOSE_TARGETS, a real
// Blueprint-target-id classification, never index/alphabetical order).

import type { BlueprintId, Weekday } from '../contracts/types.js';
import { ATHLETIC_SESSION_PURPOSE_ROTATION, SESSION_PURPOSE_ROTATION, SESSION_PURPOSE_TARGETS, UNIVERSAL_PHYSIQUE_TARGETS, type SessionPurpose } from './config.js';
import { ATHLETIC_GOAL_IDS } from '../blueprint/athletic.js';
import type { TargetType } from './goalResolver.js';

export type { SessionPurpose };

/**
 * True iff `targetId` (a physique_target) is trainable on a session of
 * `purpose` — either it's one of that purpose's own real Blueprint
 * target ids, or it's a universal target (abs/neck) compatible with
 * every purpose. A functional_goal is never region-based, so it is
 * always compatible with any gym session — the PPL+Upper split only
 * concerns physique_targets (§5's own framing: "four GYM sessions,"
 * not functional work).
 */
export function isTargetCompatibleWithPurpose(targetType: TargetType, targetId: BlueprintId, purpose: SessionPurpose): boolean {
  // Athletic goals belong to the Athletic day only, and the Athletic day
  // trains nothing else (2026-10-18).
  const athleticGoal = targetType === 'functional_goal' && (ATHLETIC_GOAL_IDS as readonly string[]).includes(targetId);
  if (purpose === 'athletic') return athleticGoal;
  if (targetType === 'functional_goal') return !athleticGoal;
  return SESSION_PURPOSE_TARGETS[purpose].includes(targetId) || UNIVERSAL_PHYSIQUE_TARGETS.includes(targetId);
}

/** The lower-body slot of the rotation: 'legs', or 'athletic' when leg
 * training is athletic. Both follow the same day rules (never Monday,
 * kept off badminton days when possible). */
const isLowerBodySlot = (purpose: SessionPurpose | undefined) => purpose === 'legs' || purpose === 'athletic';

export interface SessionPurposeAssignment {
  purposes: ReadonlyMap<Weekday, SessionPurpose>;
  reasoning: string;
}

/**
 * Assigns a PPL+Upper purpose to every one of the week's actual gym
 * days (already ordered Monday-first by the caller), by rotating
 * SESSION_PURPOSE_ROTATION across them in order — the standard,
 * well-known sequencing a 4-day PPL+Upper split runs in, not an
 * invented methodology, and not a target-priority mechanism (spec
 * §7's prohibition concerns which MUSCLE gets resources first, never
 * which day-label a session receives).
 *
 * Two deterministic, best-effort-then-hard swap passes keep 'legs' off
 * days it must never land on:
 *  1. Soft: if 'legs' lands on Monday OR a recurring badminton day and
 *     an unconstrained day exists, swap purposes with it — remediation
 *     §9's "day-moving" badminton effect, now expressed as a purpose
 *     swap instead of a per-target day swap.
 *  2. Hard: if 'legs' is STILL on Monday afterward (e.g. every other
 *     day was also constrained), force a swap with any other day
 *     regardless of badminton — spec §5's "Monday is never Lower Body"
 *     is absolute; badminton-avoidance is only ever soft.
 */
export function assignSessionPurposes(
  orderedGymDays: readonly Weekday[],
  recurringBadmintonDays: readonly Weekday[] = [],
  legTraining: 'hypertrophy' | 'athletic' = 'hypertrophy'
): SessionPurposeAssignment {
  const rotation = legTraining === 'athletic' ? ATHLETIC_SESSION_PURPOSE_ROTATION : SESSION_PURPOSE_ROTATION;
  const lower: SessionPurpose = legTraining === 'athletic' ? 'athletic' : 'legs';
  const purposes = new Map<Weekday, SessionPurpose>();
  orderedGymDays.forEach((day, i) => purposes.set(day, rotation[i % rotation.length]!));

  const isSoftConstrained = (day: Weekday) => day === 'monday' || recurringBadmintonDays.includes(day);
  const swappedForBadminton: Weekday[] = [];
  for (const day of orderedGymDays) {
    if (!isLowerBodySlot(purposes.get(day)) || !isSoftConstrained(day)) continue;
    const alt = orderedGymDays.find((d) => d !== day && !isLowerBodySlot(purposes.get(d)) && !isSoftConstrained(d));
    if (!alt) continue;
    const altPurpose = purposes.get(alt)!;
    purposes.set(alt, lower);
    purposes.set(day, altPurpose);
    if (day !== 'monday') swappedForBadminton.push(day);
  }

  // Hard guarantee: Monday must never end up with the lower-body slot,
  // regardless of whether the soft pass above found an unconstrained alternative.
  let forcedMondaySwap = false;
  if (isLowerBodySlot(purposes.get('monday'))) {
    const alt = orderedGymDays.find((d) => d !== 'monday' && !isLowerBodySlot(purposes.get(d)));
    if (alt) {
      const altPurpose = purposes.get(alt)!;
      purposes.set(alt, lower);
      purposes.set('monday', altPurpose);
      forcedMondaySwap = true;
    }
  }

  const summary = orderedGymDays.map((d) => `${d}=${purposes.get(d)}`).join(', ');
  const reasoning =
    `Session purposes rotated ${rotation.join('/')} across this week's gym days in order: ${summary}.` +
    (swappedForBadminton.length > 0 ? ` Moved ${lower} off recurring badminton day(s) ${swappedForBadminton.join(', ')} onto a feasible alternative.` : '') +
    (forcedMondaySwap ? ` Monday-never-${lower} (§5) enforced by a forced swap.` : orderedGymDays.includes('monday') ? ` Monday-never-${lower} (§5) checked and respected.` : '');

  return { purposes, reasoning };
}
