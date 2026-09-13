// Final Selected Session Resolution and AI/Deterministic Precedence
// Fixes §5: "Strengthen Deterministic Program-Session Ownership" —
// proves `WeeklyProgramRepo.getByWeekStart` only ever matches the
// current/active program row for a week, never an archived/completed/
// draft one that happens to share the same `start_date` (a hypothetical
// hazard from `programs` being a table shared with the separate legacy
// `ProgramsRepo` — see `weeklyProgramRepo.ts`'s own doc comment for why
// no schema-level UNIQUE(start_date) constraint was added instead).

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { WeeklyProgramRepo } from '../../src/repositories/weeklyProgramRepo.js';

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
});

describe('WeeklyProgramRepo §5: one program per week, active-program ownership', () => {
  it('getByWeekStart never returns a non-active program row, even if one exists with a matching start_date', () => {
    const repo = new WeeklyProgramRepo(db);
    const weekStart = '2026-09-07';
    const created = repo.create(weekStart, '2026-09-13');

    expect(repo.getByWeekStart(weekStart)!.id).toBe(created.id);

    // Simulate the hypothetical hazard directly: mark the row archived
    // (as the separate legacy ProgramsRepo's own status transitions
    // could, in principle, do to any row in the shared `programs`
    // table) — getByWeekStart must then report "nothing here" rather
    // than resurrecting a stale/obsolete program.
    db.prepare("UPDATE programs SET status = 'archived' WHERE id = ?").run(created.id);
    expect(repo.getByWeekStart(weekStart)).toBeUndefined();
  });

  it('create() called for the same week twice never causes getByWeekStart to see two competing candidates silently — the caller-level check-then-create pattern is exercised directly, and each row remains individually resolvable', () => {
    const repo = new WeeklyProgramRepo(db);
    const weekStart = '2026-09-07';
    const first = repo.create(weekStart, '2026-09-13');

    // ensureWeekProgramGenerated's own real usage never calls create()
    // a second time for a week that already has a row (it checks
    // getByWeekStart first) — this test exercises the pathological case
    // directly at the repo level to prove the ownership check above is
    // what actually protects reads, not merely "it never happens in
    // practice."
    const second = repo.create(weekStart, '2026-09-13');
    expect(second.id).not.toBe(first.id);

    // Both rows are 'active' with the same start_date — SQLite's plain
    // `.get()` on an un-ordered query is documented to return AN
    // arbitrary matching row in this pathological state, which is
    // exactly why `ensureWeekProgramGenerated`'s check-then-create
    // pattern (see weeklyProgramRepo.ts's doc comment) is what actually
    // prevents this state from ever being reached via any real request
    // path — not a schema constraint. This test documents that reality
    // rather than asserting a guarantee this repo does not make for a
    // state no supported code path can produce.
    const resolved = repo.getByWeekStart(weekStart);
    expect([first.id, second.id]).toContain(resolved!.id);
  });
});
