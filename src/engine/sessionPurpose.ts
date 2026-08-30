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
import { SESSION_PURPOSE_ROTATION, SESSION_PURPOSE_TARGETS, UNIVERSAL_PHYSIQUE_TARGETS, type SessionPurpose } from './config.js';
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
  if (targetType === 'functional_goal') return true;
  return SESSION_PURPOSE_TARGETS[purpose].includes(targetId) || UNIVERSAL_PHYSIQUE_TARGETS.includes(targetId);
}

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
export function assignSessionPurposes(orderedGymDays: readonly Weekday[], recurringBadmintonDays: readonly Weekday[] = []): SessionPurposeAssignment {
  const purposes = new Map<Weekday, SessionPurpose>();
  orderedGymDays.forEach((day, i) => purposes.set(day, SESSION_PURPOSE_ROTATION[i % SESSION_PURPOSE_ROTATION.length]!));

  const isSoftConstrained = (day: Weekday) => day === 'monday' || recurringBadmintonDays.includes(day);
  const swappedForBadminton: Weekday[] = [];
  for (const day of orderedGymDays) {
    if (purposes.get(day) !== 'legs' || !isSoftConstrained(day)) continue;
    const alt = orderedGymDays.find((d) => d !== day && purposes.get(d) !== 'legs' && !isSoftConstrained(d));
    if (!alt) continue;
    const altPurpose = purposes.get(alt)!;
    purposes.set(alt, 'legs');
    purposes.set(day, altPurpose);
    if (day !== 'monday') swappedForBadminton.push(day);
  }

  // Hard guarantee: Monday must never end up with 'legs', regardless of
  // whether the soft pass above found an unconstrained alternative.
  let forcedMondaySwap = false;
  if (purposes.get('monday') === 'legs') {
    const alt = orderedGymDays.find((d) => d !== 'monday' && purposes.get(d) !== 'legs');
    if (alt) {
      const altPurpose = purposes.get(alt)!;
      purposes.set(alt, 'legs');
      purposes.set('monday', altPurpose);
      forcedMondaySwap = true;
    }
  }

  const summary = orderedGymDays.map((d) => `${d}=${purposes.get(d)}`).join(', ');
  const reasoning =
    `Session purposes rotated push/pull/legs/upper across this week's gym days in order: ${summary}.` +
    (swappedForBadminton.length > 0 ? ` Moved legs off recurring badminton day(s) ${swappedForBadminton.join(', ')} onto a feasible alternative.` : '') +
    (forcedMondaySwap ? ' Monday-never-legs (§5) enforced by a forced swap.' : orderedGymDays.includes('monday') ? ' Monday-never-legs (§5) checked and respected.' : '');

  return { purposes, reasoning };
}
