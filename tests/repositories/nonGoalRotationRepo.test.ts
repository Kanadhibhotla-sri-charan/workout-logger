// Non-Goal Muscle Rotation Fix (2026-09-16): proves the repo's own
// per-week stability contract directly — a regeneration of the SAME
// week must reproduce the exact cursor its first generation used, while
// a genuinely different week always keeps rolling forward from where
// the previous one left off, never resetting to 0. This is what makes
// computeFreshWeek safe to call repeatedly for the same week (activity
// overrides, actual-training reconciliation) without an unaffected
// day's own non-goal composition silently drifting — see
// weekProgramReconciliation.ts's corePrescriptionEqual and this repo's
// own doc comment for the full "why not a single rolling counter"
// rationale.

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { NonGoalRotationRepo } from '../../src/repositories/nonGoalRotationRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';

let db: Database.Database;
let USER_ID: string;

beforeEach(() => {
  db = openDb(':memory:');
  // A real user row is required — user_id is a real foreign key into
  // users(id) (this app is single-user, so getOrCreateDefault() is the
  // one real way every other repo also obtains a valid id).
  USER_ID = new UsersRepo(db).getOrCreateDefault().id;
});

describe('NonGoalRotationRepo — per-week rotation cursor stability', () => {
  it('a user with no recorded generation yet reads cursor 0 for any week', () => {
    const repo = new NonGoalRotationRepo(db);
    expect(repo.cursorFor(USER_ID, '2026-08-31')).toBe(0);
    expect(repo.cursorFor(USER_ID, '2026-09-07')).toBe(0);
  });

  it('a genuinely NEW week reads the PRIOR week\'s cursorAfter, never resetting to 0', () => {
    const repo = new NonGoalRotationRepo(db);
    repo.recordGeneration(USER_ID, '2026-08-31', 0, 2);
    expect(repo.cursorFor(USER_ID, '2026-09-07')).toBe(2);
  });

  it('regenerating the SAME week reads back the EXACT cursor that week\'s first generation used, not whatever cursorAfter it produced', () => {
    const repo = new NonGoalRotationRepo(db);
    repo.recordGeneration(USER_ID, '2026-08-31', 0, 2);
    // A regeneration of this same week (an activity-override
    // reconciliation, an actual-training adaptation pass) must see the
    // SAME cursorUsed (0) it originally saw — never the cursorAfter (2)
    // that generation itself produced, which would silently re-rank
    // every unaffected day's non-goal tie-break differently.
    expect(repo.cursorFor(USER_ID, '2026-08-31')).toBe(0);
  });

  it('the rotation genuinely advances across three consecutive real weeks, matching the A,B -> C,A -> B,C -> repeat example\'s own cadence', () => {
    const repo = new NonGoalRotationRepo(db);
    const week1 = '2026-08-31';
    const week2 = '2026-09-07';
    const week3 = '2026-09-14';

    // Week 1: first ever generation, starts at 0, a 2-target generation
    // advances to 2 (matching "A,B" in the example).
    expect(repo.cursorFor(USER_ID, week1)).toBe(0);
    repo.recordGeneration(USER_ID, week1, 0, 2);

    // Week 2: a genuinely new week reads 2 ("C,A" starts at 2), advances
    // to 1 after another 2-target generation ((2+2) % 3 = 1).
    expect(repo.cursorFor(USER_ID, week2)).toBe(2);
    repo.recordGeneration(USER_ID, week2, 2, 1);

    // Week 3: reads 1 ("B,C" starts at 1).
    expect(repo.cursorFor(USER_ID, week3)).toBe(1);
    repo.recordGeneration(USER_ID, week3, 1, 0);
  });

  it('KNOWN, DELIBERATE LIMITATION: only the single MOST RECENTLY generated week is remembered — regenerating an OLDER week after a NEWER one already exists is treated as "new" and rolls forward from the newer week\'s own cursorAfter, not that older week\'s original value', () => {
    // This is the one real gap the "simple rotation approach" (no
    // backlog/history table, per explicit design) leaves open: it only
    // ever remembers ONE week's own frozen cursor at a time. In normal
    // usage this never matters (a week is generated once, then only
    // ever regenerated relative to itself before the next real week
    // begins), but a genuinely out-of-order regeneration — editing an
    // older week's activity AFTER a newer week has already been
    // generated — sees this narrower, documented behavior rather than
    // that older week's own original ordering.
    const repo = new NonGoalRotationRepo(db);
    repo.recordGeneration(USER_ID, '2026-08-31', 0, 2);
    repo.recordGeneration(USER_ID, '2026-09-07', 2, 1);
    expect(repo.cursorFor(USER_ID, '2026-08-31')).toBe(1); // NOT 0, its own original cursorUsed
  });

  it('get() returns the full persisted state, or the null/zero default when nothing has ever been recorded', () => {
    const repo = new NonGoalRotationRepo(db);
    expect(repo.get(USER_ID)).toEqual({ weekStart: null, cursorUsed: 0, cursorAfter: 0 });

    repo.recordGeneration(USER_ID, '2026-08-31', 0, 2);
    expect(repo.get(USER_ID)).toEqual({ weekStart: '2026-08-31', cursorUsed: 0, cursorAfter: 2 });
  });
});
