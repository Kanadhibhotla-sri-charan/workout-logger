// Final Selected Session Resolution and AI/Deterministic Precedence
// Fixes §1/§2/§11.A: direct unit tests for `resolveSelectedSession` and
// `findActiveGymSessionConflict` — the ONE authoritative rule for "which
// real gym session, if any, is selected for a date," and the shared
// write-time conflict check every session-creation path now uses.
// Pure-function tests: no DB, no HTTP — every required case from spec
// §11.A is exercised directly against hand-built WorkoutSession fixtures,
// including in a DELIBERATELY SHUFFLED array order to prove the resolver
// truly does not depend on repository row order.

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
  // Deterministic "shuffle" (reverse + rotate) — good enough to prove
  // order-independence without a randomness dependency in a test.
  return [...items].reverse();
}

describe('resolveSelectedSession — §11.A required resolver cases', () => {
  it('no session; deterministic prescription exists elsewhere (not a workout_session) -> undefined', () => {
    expect(resolveSelectedSession([])).toBeUndefined();
  });

  it('deterministic session only -> that session', () => {
    const s = session({ status: 'planned', source_type: 'deterministic' });
    expect(resolveSelectedSession([s])).toBe(s);
  });

  it('AI session supersedes deterministic session (both planned) -> the AI one, regardless of array order', () => {
    const det = session({ status: 'planned', source_type: 'deterministic', created_at: '2026-09-10T00:00:01.000Z' });
    const ai = session({ status: 'planned', source_type: 'ai', created_at: '2026-09-10T00:00:02.000Z' });
    expect(resolveSelectedSession([det, ai])).toBe(ai);
    expect(resolveSelectedSession(shuffled([det, ai]))).toBe(ai);
  });

  it('manual session supersedes deterministic session (both planned)', () => {
    const det = session({ status: 'planned', source_type: 'deterministic' });
    const manual = session({ status: 'planned', source_type: 'manual' });
    expect(resolveSelectedSession([det, manual])).toBe(manual);
    expect(resolveSelectedSession(shuffled([det, manual]))).toBe(manual);
  });

  it('AI and manual sessions coexist (both planned) -> the most recently created one wins, not array position', () => {
    const ai = session({ status: 'planned', source_type: 'ai', created_at: '2026-09-10T00:00:01.000Z' });
    const manual = session({ status: 'planned', source_type: 'manual', created_at: '2026-09-10T00:00:02.000Z' });
    expect(resolveSelectedSession([ai, manual])).toBe(manual);
    expect(resolveSelectedSession([manual, ai])).toBe(manual);
  });

  it('multiple AI sessions exist -> the most recently created one wins', () => {
    const older = session({ status: 'planned', source_type: 'ai', created_at: '2026-09-10T00:00:01.000Z' });
    const newer = session({ status: 'planned', source_type: 'ai', created_at: '2026-09-10T00:00:05.000Z' });
    expect(resolveSelectedSession([older, newer])).toBe(newer);
    expect(resolveSelectedSession([newer, older])).toBe(newer);
  });

  it('completed session plus planned replacement -> the completed one remains authoritative', () => {
    const completed = session({ status: 'completed', source_type: 'deterministic', created_at: '2026-09-10T00:00:01.000Z' });
    const plannedReplacement = session({ status: 'planned', source_type: 'ai', created_at: '2026-09-10T00:00:09.000Z' });
    expect(resolveSelectedSession([completed, plannedReplacement])).toBe(completed);
    expect(resolveSelectedSession(shuffled([completed, plannedReplacement]))).toBe(completed);
  });

  it('in-progress session plus planned replacement -> the in-progress one remains authoritative', () => {
    const inProgress = session({ status: 'in_progress', source_type: 'deterministic', created_at: '2026-09-10T00:00:01.000Z' });
    const plannedReplacement = session({ status: 'planned', source_type: 'ai', created_at: '2026-09-10T00:00:09.000Z' });
    expect(resolveSelectedSession([inProgress, plannedReplacement])).toBe(inProgress);
    expect(resolveSelectedSession(shuffled([inProgress, plannedReplacement]))).toBe(inProgress);
  });

  it('completed beats in-progress when, unusually, both exist for one date', () => {
    const completed = session({ status: 'completed', created_at: '2026-09-10T00:00:01.000Z' });
    const inProgress = session({ status: 'in_progress', created_at: '2026-09-10T00:00:05.000Z' });
    expect(resolveSelectedSession([completed, inProgress])).toBe(completed);
    expect(resolveSelectedSession([inProgress, completed])).toBe(completed);
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
      expect(resolveSelectedSession(perm)).toBe(c); // most recent, non-deterministic
    }
  });

  it('returns source, id, and status via the resolved session object itself', () => {
    const s = session({ status: 'in_progress', source_type: 'manual' });
    const resolved = resolveSelectedSession([s])!;
    expect(resolved.session_id).toBe(s.session_id);
    expect(resolved.source_type).toBe('manual');
    expect(resolved.status).toBe('in_progress');
  });

  it('ignores non-gym sessions entirely (e.g. a same-day badminton session never becomes "the" selected gym workout)', () => {
    const badminton = session({ status: 'in_progress', session_type: 'badminton' });
    const gym = session({ status: 'planned', session_type: 'gym', source_type: 'deterministic' });
    expect(resolveSelectedSession([badminton, gym])).toBe(gym);
  });
});

describe('findActiveGymSessionConflict — §3/§10 shared write-time guard', () => {
  it('reports a planned gym session as a conflict', () => {
    const s = session({ status: 'planned' });
    expect(findActiveGymSessionConflict([s])).toBe(s);
  });

  it('reports an in-progress gym session as a conflict', () => {
    const s = session({ status: 'in_progress' });
    expect(findActiveGymSessionConflict([s])).toBe(s);
  });

  it('a completed gym session is NEVER a conflict — a same-day makeup session is legitimate', () => {
    const s = session({ status: 'completed' });
    expect(findActiveGymSessionConflict([s])).toBeUndefined();
  });

  it('a badminton session, of any status, is never a gym-session conflict', () => {
    const s = session({ status: 'planned', session_type: 'badminton' });
    expect(findActiveGymSessionConflict([s])).toBeUndefined();
  });

  it('no sessions -> no conflict', () => {
    expect(findActiveGymSessionConflict([])).toBeUndefined();
  });
});
