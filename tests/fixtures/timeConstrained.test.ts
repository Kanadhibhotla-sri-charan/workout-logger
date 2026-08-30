// Fixture D (spec §35, §17): time constrained (30-40 minute budget).
//
// Scope, stated explicitly per the spec's own instruction: the engine
// "must prioritize the goal rather than blindly truncating." Prioritizing
// which work to keep under a tight budget is workoutBuilder's job
// (blocked — see docs/TRAINING_ENGINE_DESIGN.md §11, §16), so this
// fixture proves what IS implemented: the time budget itself behaves as
// a hard constraint (constraintEngine), not that a full workout gets
// intelligently trimmed (it can't — nothing generates one yet).

import { describe, expect, it } from 'vitest';
import { fitsWithinBudget, remainingBudgetMinutes } from '../../src/engine/constraintEngine.js';

describe('fixture D: time constrained (30-40 minutes)', () => {
  it('a 30-minute budget is a hard ceiling — work that would exceed it does not fit', () => {
    const budget = 30;
    let elapsed = 0;

    // Simulate adding three 12-minute blocks of work.
    expect(fitsWithinBudget(budget, elapsed, 12)).toBe(true);
    elapsed += 12;
    expect(fitsWithinBudget(budget, elapsed, 12)).toBe(true);
    elapsed += 12;
    // 24 elapsed + 12 more = 36 > 30 — must not fit.
    expect(fitsWithinBudget(budget, elapsed, 12)).toBe(false);
    expect(remainingBudgetMinutes(budget, elapsed)).toBe(6);
  });

  it('a 40-minute budget accepts more work than a 30-minute one for the same items', () => {
    const items = [12, 12, 12]; // three 12-minute blocks, 36 total

    let elapsed30 = 0;
    let fitCount30 = 0;
    for (const m of items) {
      if (fitsWithinBudget(30, elapsed30, m)) {
        elapsed30 += m;
        fitCount30++;
      }
    }

    let elapsed40 = 0;
    let fitCount40 = 0;
    for (const m of items) {
      if (fitsWithinBudget(40, elapsed40, m)) {
        elapsed40 += m;
        fitCount40++;
      }
    }

    expect(fitCount30).toBeLessThan(fitCount40);
  });

  it('the budget is never silently exceeded, even by a small amount', () => {
    expect(fitsWithinBudget(30, 29, 2)).toBe(false); // would be 31
    expect(fitsWithinBudget(30, 29, 1)).toBe(true); // exactly 30, allowed
  });
});
