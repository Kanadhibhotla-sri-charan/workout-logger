// Session time budget (step 3, 2026-11-09). Owner rules: sessions aim at
// the profile's default length (60 min) and never pass its maximum (90);
// durability work must not compromise the aesthetic goals. When a session
// runs long, things give way in this order (owner, 2026-11-09):
//   1. the athletic add-on is dropped
//   2. the flexibility block shrinks, down to FLEXIBILITY_BLOCK_MIN_SECONDS
//   3. "can wait" muscles get no sets today (a later day covers them)
//   4. only past the maximum: "must" sets of non-goal muscles are trimmed
// Goal-muscle sets are never cut, and neither is shoulder care (a few
// minutes of injury insurance, src/athletic/shoulderCare.ts).
//
// Lift time is counted per planned set at MINUTES_PER_SET, calibrated on
// the owner's logged sessions (2026-10-22 to 11-09: 2.9-4.7 min per set,
// rest and changeovers included; most near 3.5). Pure.

import { FLEXIBILITY_BLOCK_MIN_SECONDS } from '../../athletic/flexibility.js';

export const MINUTES_PER_SET = 3.5;

export interface SessionTimeInput {
  aimMinutes: number;
  maxMinutes: number;
  /** Sets of goal muscles due today (never cut). */
  goalSets: number;
  /** Sets of non-goal muscles that cannot wait for a later day. */
  otherMustSets: number;
  flexibilityMinutes: number;
  addOnMinutes: number;
  /** Minutes that are never cut (shoulder care). */
  fixedMinutes?: number;
}

export interface SessionTimePlan {
  schemaVersion: 'session-time.v1';
  aimMinutes: number;
  maxMinutes: number;
  minutesPerSet: number;
  /** 0 when the add-on is dropped. */
  addOnMinutes: number;
  flexibilityMinutes: number;
  /** Sets the "can wait" muscles may still take today. */
  canWaitSets: number;
  /** Sets to take off non-goal "must" muscles to stay under the maximum. */
  otherMustSetsToCut: number;
  /** Planned sets the session may hold: due sets after cuts, plus canWaitSets. */
  liftSetBudget: number;
  /** Estimated minutes once the plan's cuts are made. */
  estimatedMinutes: number;
  /** What gave way, in order, in plain words. */
  cuts: string[];
}

export function planSessionTime(input: SessionTimeInput): SessionTimePlan {
  const cuts: string[] = [];
  const liftMinutes = (input.goalSets + input.otherMustSets) * MINUTES_PER_SET + (input.fixedMinutes ?? 0);
  let addOn = input.addOnMinutes;
  let flex = input.flexibilityMinutes;
  const total = () => liftMinutes + addOn + flex;
  if (addOn > 0 && total() > input.aimMinutes) {
    cuts.push(`athletic add-on dropped (${addOn} min)`);
    addOn = 0;
  }
  const flexFloor = Math.min(flex, FLEXIBILITY_BLOCK_MIN_SECONDS / 60);
  if (flex > flexFloor && total() > input.aimMinutes) {
    const to = Math.max(flexFloor, Math.ceil(flex - (total() - input.aimMinutes)));
    cuts.push(`flexibility shortened from ${flex} to ${to} min`);
    flex = to;
  }
  const spare = input.aimMinutes - total();
  const canWaitSets = Math.max(0, Math.floor(spare / MINUTES_PER_SET));
  if (spare < MINUTES_PER_SET) cuts.push('muscles that can wait get no sets today');
  const over = total() - input.maxMinutes;
  const otherMustSetsToCut = over > 0 ? Math.min(input.otherMustSets, Math.ceil(over / MINUTES_PER_SET)) : 0;
  if (otherMustSetsToCut > 0) cuts.push(`${otherMustSetsToCut} set(s) taken off other muscles to stay under ${input.maxMinutes} min`);
  const estimatedMinutes = Math.round(total() - otherMustSetsToCut * MINUTES_PER_SET + canWaitSets * MINUTES_PER_SET);
  return {
    schemaVersion: 'session-time.v1',
    aimMinutes: input.aimMinutes,
    maxMinutes: input.maxMinutes,
    minutesPerSet: MINUTES_PER_SET,
    addOnMinutes: addOn,
    flexibilityMinutes: flex,
    canWaitSets,
    otherMustSetsToCut,
    liftSetBudget: input.goalSets + input.otherMustSets - otherMustSetsToCut + canWaitSets,
    estimatedMinutes,
    cuts,
  };
}
