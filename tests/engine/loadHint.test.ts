import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { loadHintFor } from '../../src/engine/loadHint.js';

type S = [number, number, boolean?];
function setup() {
  const db = openDb(':memory:');
  const repo = new WorkoutSessionsRepo(db);
  const log = (date: string, exercise_id: string, sets: S[], extra: Record<string, unknown> = {}, status: 'completed' | 'planned' = 'completed') => {
    const s = repo.createSession({ date, session_type: 'gym', status });
    return repo.addExercisePerformance(s.session_id, {
      exercise_id, order: 0, role: 'primary', target_sets: sets.length, target_reps_min: 10, target_reps_max: 15, ...extra,
      sets: sets.map(([weight, reps, done = true], i) => ({ set_number: i + 1, weight, reps, completed: done })),
    } as any);
  };
  return { db, log };
}
const today = (log: ReturnType<typeof setup>['log'], extra: Record<string, unknown> = {}) => log('2026-11-02', 'lying-triceps-extension-skull-crusher', [[0, 0, false]], extra, 'planned');

describe('loadHintFor', () => {
  it('top of the range at the heaviest weight -> go heavier (ramp sets ignored), with the stuck count', () => {
    const { db, log } = setup();
    log('2026-10-12', 'lying-triceps-extension-skull-crusher', [[7.5, 15], [12.5, 15]]);
    log('2026-10-22', 'lying-triceps-extension-skull-crusher', [[7.5, 15], [12.5, 14]]);
    log('2026-10-29', 'lying-triceps-extension-skull-crusher', [[7.5, 15], [12.5, 15]]);
    const hint = loadHintFor(db, today(log), '2026-11-02')!;
    expect(hint).toMatchObject({ kind: 'heavier', lastWeight: 12.5, lastReps: 15, weight: 15, reps: 10, sameWeightSessions: 3, lastDate: '2026-10-29' });
    expect(hint.text).toContain('3 sessions at 12.5 kg');
  });

  it('dumbbells go up to the next pair', () => {
    const { db, log } = setup();
    log('2026-10-27', 'hammer-curl', [[12, 12], [14, 15]]);
    expect(loadHintFor(db, log('2026-11-02', 'hammer-curl', [[0, 0, false]], {}, 'planned'), '2026-11-02')).toMatchObject({ kind: 'heavier', weight: 16 });
  });

  it('within the range -> same weight, one more rep; below -> hold', () => {
    const { db, log } = setup();
    log('2026-10-29', 'cable-overhead-extension-leaning-forward', [[27, 15], [42.5, 12]]);
    const perf = log('2026-11-02', 'cable-overhead-extension-leaning-forward', [[0, 0, false]], {}, 'planned');
    expect(loadHintFor(db, perf, '2026-11-02')).toMatchObject({ kind: 'reps', weight: 42.5, reps: 13 });
    log('2026-10-30', 'cable-pushdown', [[30, 8]]);
    const push = log('2026-11-02', 'cable-pushdown', [[0, 0, false]], {}, 'planned');
    expect(loadHintFor(db, push, '2026-11-02')).toMatchObject({ kind: 'hold', weight: 30, reps: 10 });
  });

  it('compares only the same attachment; skips unfinished sessions, non-rep units and no history', () => {
    const { db, log } = setup();
    log('2026-10-26', 'cable-pushdown', [[30, 15]], { attachment: 'rope' });
    log('2026-10-27', 'cable-pushdown', [[40, 15]], {}, 'planned');
    expect(loadHintFor(db, log('2026-11-02', 'cable-pushdown', [[0, 0, false]], { attachment: 'v-bar' }, 'planned'), '2026-11-02')).toBeNull();
    expect(loadHintFor(db, log('2026-11-02', 'cable-pushdown', [[0, 0, false]], { attachment: 'rope' }, 'planned'), '2026-11-02')).toMatchObject({ lastWeight: 30, kind: 'heavier' });
    expect(loadHintFor(db, log('2026-11-02', 'cable-pushdown', [[0, 0, false]], { attachment: 'rope', rep_unit: 'seconds' }, 'planned'), '2026-11-02')).toBeNull();
    expect(loadHintFor(db, log('2026-11-02', 'hammer-curl', [[0, 0, false]], {}, 'planned'), '2026-11-02')).toBeNull();
  });
});
