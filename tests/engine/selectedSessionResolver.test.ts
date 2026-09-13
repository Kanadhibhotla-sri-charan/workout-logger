// Final Actionable vs Historical Session Resolution Fixes
// (docs/CLAUDE_TASK_FINAL_ACTIONABLE_VS_HISTORICAL_SESSION_FIXES.md):
// direct unit tests for `resolveSelectedSession` and
// `findActiveGymSessionConflict` — the ONE authoritative resolver, now
// returning a structured `SelectedSessionResolution` that separates a
// HISTORICAL session (completed/in-progress) from an ACTIONABLE
// `selectedPlannedWorkout`, and surfaces a `selectionConflict` rather
// than silently picking one of several simultaneously-active planned
// sessions by recency. Pure-function tests: no DB, no HTTP — every
// required case from the spec's own resolver test list is exercised
// directly against hand-built WorkoutSession fixtures, including in a
// DELIBERATELY SHUFFLED array order to prove the resolver truly does
// not depend on repository row order.

import { describe, expect, it } from 'vitest';
import type { WorkoutSession, WorkoutSessionSourceType, WorkoutSessionStatus } from '../../src/contracts/types.js';
import { findActiveGymSessionConflict, resolveSelectedSession } from '../../src/engine/selectedSessionResolver.js';

let counter = 0;
function session(overrides: Partial<WorkoutSession> & { status: WorkoutSessionStatus }): WorkoutSession {
  counter += 1;
  return {
    session_id: overrides.session_id ?? `session_${counter}`,
    date: '2026-09-10',
    start_time: null,
    end_time: null,
    duration_minutes: null,
    session_type: 'gym',
    program_id: null,
    program_session_id: null,
    goal_context: null,
    notes: null,
    created_at: overrides.created_at ?? `2026-09-10T00:00:0${counter}.000Z`,
    source_type: 'deterministic' as WorkoutSessionSourceType,
    supersedes_program_session_id: null,
    ...overrides,
  };
}

function shuffled<T>(items: T[]): T[] {
  // Deterministic "shuffle" (reverse) — good enough to prove order-
  // independence without a randomness dependency in a test.
  return [...items].reverse();
}

describe('resolveSelectedSession — required resolver cases', () => {
  it('1. no session -> everything null, source "none"', () => {
    const r = resolveSelectedSession([]);
    expect(r).toEqual({ historicalSession: null, selectedPlannedWorkout: null, selectionConflict: null, source: 'none' });
  });

  it('2. one deterministic planned session -> selectedPlannedWorkout, source "deterministic"', () => {
    const s = session({ status: 'planned', source_type: 'deterministic' });
    const r = resolveSelectedSession([s]);
    expect(r.selectedPlannedWorkout).toBe(s);
    expect(r.historicalSession).toBeNull();
    expect(r.selectionConflict).toBeNull();
    expect(r.source).toBe('deterministic');
  });

  it('3. one AI planned session -> selectedPlannedWorkout, source "ai"', () => {
    const s = session({ status: 'planned', source_type: 'ai' });
    const r = resolveSelectedSession([s]);
    expect(r.selectedPlannedWorkout).toBe(s);
    expect(r.source).toBe('ai');
  });

  it('4. AI planned plus deterministic planned -> AI wins, deterministic is excluded (not superseded-and-shown)', () => {
    const det = session({ status: 'planned', source_type: 'deterministic', created_at: '2026-09-10T00:00:01.000Z' });
    const ai = session({ status: 'planned', source_type: 'ai', created_at: '2026-09-10T00:00:02.000Z' });
    const r1 = resolveSelectedSession([det, ai]);
    const r2 = resolveSelectedSession(shuffled([det, ai]));
    for (const r of [r1, r2]) {
      expect(r.selectedPlannedWorkout).toBe(ai);
      expect(r.historicalSession).toBeNull();
      expect(r.selectionConflict).toBeNull();
      expect(r.source).toBe('ai');
    }
  });

  it('5. one completed session -> historicalSession, never selectedPlannedWorkout', () => {
    const s = session({ status: 'completed' });
    const r = resolveSelectedSession([s]);
    expect(r.historicalSession).toBe(s);
    expect(r.selectedPlannedWorkout).toBeNull();
    expect(r.selectionConflict).toBeNull();
    expect(r.source).toBe('completed');
  });

  it('6. one in-progress session -> historicalSession, never a new planned workout', () => {
    const s = session({ status: 'in_progress' });
    const r = resolveSelectedSession([s]);
    expect(r.historicalSession).toBe(s);
    expect(r.selectedPlannedWorkout).toBeNull();
    expect(r.source).toBe('in_progress');
  });

  it('7. completed plus a LATER planned session -> the planned session is blocked/excluded, not silently selected', () => {
    const completed = session({ status: 'completed', created_at: '2026-09-10T00:00:01.000Z' });
    const plannedLater = session({ status: 'planned', source_type: 'ai', created_at: '2026-09-10T00:00:09.000Z' });
    const r1 = resolveSelectedSession([completed, plannedLater]);
    const r2 = resolveSelectedSession(shuffled([completed, plannedLater]));
    for (const r of [r1, r2]) {
      expect(r.historicalSession).toBe(completed);
      expect(r.selectedPlannedWorkout).toBeNull();
      expect(r.source).toBe('completed');
    }
  });

  it('8. in-progress plus a planned session -> the planned session is blocked/excluded', () => {
    const inProgress = session({ status: 'in_progress', created_at: '2026-09-10T00:00:01.000Z' });
    const plannedLater = session({ status: 'planned', source_type: 'ai', created_at: '2026-09-10T00:00:09.000Z' });
    const r1 = resolveSelectedSession([inProgress, plannedLater]);
    const r2 = resolveSelectedSession(shuffled([inProgress, plannedLater]));
    for (const r of [r1, r2]) {
      expect(r.historicalSession).toBe(inProgress);
      expect(r.selectedPlannedWorkout).toBeNull();
      expect(r.source).toBe('in_progress');
    }
  });

  it('9. multiple active AI planned sessions -> a conflict is returned, not a silent recency pick', () => {
    const older = session({ status: 'planned', source_type: 'ai', created_at: '2026-09-10T00:00:01.000Z' });
    const newer = session({ status: 'planned', source_type: 'ai', created_at: '2026-09-10T00:00:05.000Z' });
    const r = resolveSelectedSession([older, newer]);
    expect(r.selectionConflict).not.toBeNull();
    expect(r.selectionConflict!.code).toBe('MULTIPLE_ACTIVE_PLANNED_SESSIONS');
    expect(r.selectionConflict!.sessionIds.sort()).toEqual([older.session_id, newer.session_id].sort());
    expect(r.source).toBe('conflict');
    // A deterministic recovery candidate is still exposed, but the
    // conflict marker means it must not be trusted unconditionally.
    expect(r.selectedPlannedWorkout).toBe(newer);
  });

  it('10. multiple active deterministic planned sessions -> conflict, same explicit invariant', () => {
    const a = session({ status: 'planned', source_type: 'deterministic', created_at: '2026-09-10T00:00:01.000Z' });
    const b = session({ status: 'planned', source_type: 'deterministic', created_at: '2026-09-10T00:00:05.000Z' });
    const r = resolveSelectedSession([a, b]);
    expect(r.selectionConflict).not.toBeNull();
    expect(r.selectionConflict!.code).toBe('MULTIPLE_ACTIVE_PLANNED_SESSIONS');
    expect(r.source).toBe('conflict');
  });

  it('11. superseded/cancelled sessions are excluded from active selection (a "skipped" status is never selectable)', () => {
    const skipped = session({ status: 'skipped', source_type: 'ai' });
    const r = resolveSelectedSession([skipped]);
    expect(r).toEqual({ historicalSession: null, selectedPlannedWorkout: null, selectionConflict: null, source: 'none' });
  });

  it('12. non-gym sessions never participate in gym-day resolution (ownership/scope boundary — a same-day badminton session is irrelevant)', () => {
    const badminton = session({ status: 'in_progress', session_type: 'badminton' });
    const gym = session({ status: 'planned', session_type: 'gym', source_type: 'deterministic' });
    const r = resolveSelectedSession([badminton, gym]);
    expect(r.selectedPlannedWorkout).toBe(gym);
    expect(r.historicalSession).toBeNull();
  });

  it('13. tie-breaking (most-recently-created) is used only WITHIN an already-conflicted tier to keep a read endpoint usable — it is never a substitute for reporting the conflict itself', () => {
    const older = session({ status: 'planned', source_type: 'ai', created_at: '2026-09-10T00:00:01.000Z' });
    const newer = session({ status: 'planned', source_type: 'ai', created_at: '2026-09-10T00:00:05.000Z' });
    const r = resolveSelectedSession([older, newer]);
    expect(r.selectionConflict).not.toBeNull(); // the conflict is always reported
    expect(r.selectedPlannedWorkout).toBe(newer); // AND a usable candidate is still exposed
  });

  it('does not depend on repository row order for any tier (fuzz across several permutations)', () => {
    const a = session({ status: 'planned', source_type: 'deterministic', created_at: '2026-09-10T00:00:01.000Z' });
    const b = session({ status: 'planned', source_type: 'ai', created_at: '2026-09-10T00:00:02.000Z' });
    const c = session({ status: 'planned', source_type: 'manual', created_at: '2026-09-10T00:00:03.000Z' });
    const permutations = [
      [a, b, c],
      [c, b, a],
      [b, a, c],
      [c, a, b],
    ];
    for (const perm of permutations) {
      // b and c are both non-deterministic and 'planned' -> conflict tier; c is more recent.
      const r = resolveSelectedSession(perm);
      expect(r.selectionConflict).not.toBeNull();
      expect(r.selectedPlannedWorkout).toBe(c);
    }
  });

  it('completed beats in-progress when, unusually, both exist for one date (documented tie-break, matches this codebase\'s pre-existing status-priority convention)', () => {
    const completed = session({ status: 'completed', created_at: '2026-09-10T00:00:01.000Z' });
    const inProgress = session({ status: 'in_progress', created_at: '2026-09-10T00:00:05.000Z' });
    expect(resolveSelectedSession([completed, inProgress]).historicalSession).toBe(completed);
    expect(resolveSelectedSession([inProgress, completed]).historicalSession).toBe(completed);
  });
});

describe('findActiveGymSessionConflict — write-time guard (now includes completed)', () => {
  it('reports a planned gym session as a conflict', () => {
    const s = session({ status: 'planned' });
    expect(findActiveGymSessionConflict([s])).toBe(s);
  });

  it('reports an in-progress gym session as a conflict', () => {
    const s = session({ status: 'in_progress' });
    expect(findActiveGymSessionConflict([s])).toBe(s);
  });

  it('a completed gym session IS now a conflict — same-day makeup sessions are out of scope for this fix', () => {
    const s = session({ status: 'completed' });
    expect(findActiveGymSessionConflict([s])).toBe(s);
  });

  it('a badminton session, of any status, is never a gym-session conflict', () => {
    const s = session({ status: 'planned', session_type: 'badminton' });
    expect(findActiveGymSessionConflict([s])).toBeUndefined();
  });

  it('no sessions -> no conflict', () => {
    expect(findActiveGymSessionConflict([])).toBeUndefined();
  });
});
