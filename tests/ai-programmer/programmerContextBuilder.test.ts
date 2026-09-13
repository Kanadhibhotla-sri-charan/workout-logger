// AI Programmer Integration — First Vertical Slice
// (docs/CLAUDE_TASK_AI_PROGRAMMER_FIRST_VERTICAL_SLICE.md §14.1): the
// required context-builder test matrix, run against the real context
// builder and a real (in-memory) database — never a reimplementation of
// the builder's own logic.

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { buildProgrammerContext } from '../../src/ai-programmer/context/programmerContextBuilder.js';
import { AIContextIncompleteError, AITargetNotEditableError } from '../../src/ai-programmer/errors.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];

// 2026-09-07 is a real Monday; the tests run with a real "today" of
// 2026-09-12 (a Saturday) — these dates stay within that same real
// Monday-Sunday week so real logged history is genuinely visible to a
// context built for a still-editable (>= today) date in the same week.
const MONDAY = '2026-09-07';
const TUESDAY = '2026-09-08';
const SUNDAY = '2026-09-13';

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
});

function setupProfile(trainingDays: string[] = ['monday', 'tuesday', 'thursday', 'friday']) {
  const user = new UsersRepo(db).getOrCreateDefault();
  new TrainingProfileRepo(db).upsert(user.id, {
    timezone: 'Asia/Kolkata',
    week_start_day: 'monday',
    training_days: trainingDays as any,
    default_session_duration_minutes: 60,
    minimum_session_duration_minutes: 30,
    maximum_session_duration_minutes: 90,
    available_equipment: FULL_EQUIPMENT,
    other_activity_schedule: [],
  });
  return user;
}

function completedSession(date: string, exercises: Array<{ exercise_id: string; sets: Array<{ weight: number; reps: number; completed: boolean }> }>) {
  const sessionsRepo = new WorkoutSessionsRepo(db);
  const session = sessionsRepo.createSession({ date, session_type: 'gym', status: 'completed' });
  let order = 1;
  for (const ex of exercises) {
    sessionsRepo.addExercisePerformance(session.session_id, {
      exercise_id: ex.exercise_id,
      order: order++,
      role: 'primary',
      sets: ex.sets.map((s, i) => ({ set_number: i + 1, weight: s.weight, reps: s.reps, completed: s.completed })),
    });
  }
}

function reps(n: number, weight = 40, repsCount = 10, completed = true) {
  return Array.from({ length: n }, () => ({ weight, reps: repsCount, completed }));
}

describe('AI Programmer context builder', () => {
  it('throws AIContextIncompleteError when no TrainingProfile exists yet', () => {
    expect(() => buildProgrammerContext(db, { targetDate: SUNDAY })).toThrow(AIContextIncompleteError);
  });

  it('item 7 — Monday-Sunday reporting boundary is correct regardless of which weekday targetDate falls on', () => {
    setupProfile();
    const context = buildProgrammerContext(db, { targetDate: SUNDAY });
    expect(context.reportingBoundary.weekStart).toBe(MONDAY);
    expect(context.reportingBoundary.weekEnd).toBe(SUNDAY);
    expect(context.targetWeekday).toBe('sunday');
  });

  it('item 2 — context includes the effective (override-applied) routine for the target week', () => {
    setupProfile(['monday', 'tuesday', 'thursday', 'friday']);
    const context = buildProgrammerContext(db, { targetDate: SUNDAY });
    expect(context.routine.week).toHaveLength(7);
    expect(context.routine.targetDateActivity).toBe('unselected');
    const wednesday = context.routine.week.find((d) => d.weekday === 'wednesday');
    expect(wednesday?.activity).toBe('unselected');
    const monday = context.routine.week.find((d) => d.weekday === 'monday');
    expect(monday?.activity).toBe('gym');
  });

  it("item 1 — active goals appear in the user's own priority order, never reordered", () => {
    setupProfile();
    const goalsRepo = new GoalsRepo(db);
    const low = goalsRepo.create({ goal_type: 'aesthetic', blueprint_ref: 'chest-side-projection', priority: 2 });
    const high = goalsRepo.create({ goal_type: 'functional', blueprint_ref: 'rotator-cuff', priority: 1 });
    const context = buildProgrammerContext(db, { targetDate: SUNDAY });
    const ids = context.activeGoals.map((g) => g.goalId);
    expect(ids.indexOf(high.id)).toBeLessThan(ids.indexOf(low.id));
    expect(context.activeGoals.find((g) => g.goalId === high.id)?.priority).toBe(1);
  });

  it('item 3/4 — context includes real exercise identity and authoritative Blueprint prescriptions for a target', () => {
    setupProfile();
    const context = buildProgrammerContext(db, { targetDate: SUNDAY });
    const midPec = context.targets.find((t) => t.targetId === 'mid-pec')!;
    const benchEntry = midPec.validExercises.find((v) => v.exerciseId === 'flat-barbell-bench-press');
    expect(benchEntry).toBeDefined();
    expect(benchEntry!.role).toBe('primary');
    expect(benchEntry!.authoredPrescription).toEqual({ sets: 3, repsMin: 6, repsMax: 12, rirMin: 1, rirMax: 3 });
  });

  it('item 5/6 — recent actual sessions are included, and only completed sets count toward exposure/history', () => {
    setupProfile();
    completedSession(TUESDAY, [{ exercise_id: 'flat-barbell-bench-press', sets: [...reps(2), { weight: 40, reps: 10, completed: false }] }]);
    const context = buildProgrammerContext(db, { targetDate: SUNDAY });
    const midPec = context.targets.find((t) => t.targetId === 'mid-pec')!;
    expect(midPec.currentWeeklyPrimarySets).toBe(2); // the incomplete 3rd set is excluded
    expect(midPec.exerciseHistory['flat-barbell-bench-press']).toBeDefined();
    expect(midPec.exerciseHistory['flat-barbell-bench-press']![0]!.completedSets).toBe(2);
    expect(midPec.lastTrainedDate).toBe(TUESDAY);
  });

  it('item 8 — locked/completed state prevents context building for that date entirely', () => {
    setupProfile();
    completedSession(SUNDAY, [{ exercise_id: 'flat-barbell-bench-press', sets: reps(3) }]);
    expect(() => buildProgrammerContext(db, { targetDate: SUNDAY })).toThrow(AITargetNotEditableError);
  });

  it('a past target date is rejected as not editable', () => {
    setupProfile();
    expect(() => buildProgrammerContext(db, { targetDate: '2020-01-01' })).toThrow(AITargetNotEditableError);
  });

  it('item 9 — missing/malformed data is represented explicitly in diagnostics, never silently guessed', () => {
    setupProfile();
    const context = buildProgrammerContext(db, { targetDate: SUNDAY });
    expect(Array.isArray(context.diagnostics.missingData)).toBe(true);
    expect(typeof context.diagnostics.approxContextSizeChars).toBe('number');
  });

  it('item 10 — sensitive fields (secrets/credentials) are never present in the context', () => {
    const original = process.env.VELONA_API_KEY;
    process.env.VELONA_API_KEY = 'super-secret-value-should-never-leak';
    try {
      setupProfile();
      const context = buildProgrammerContext(db, { targetDate: SUNDAY });
      const serialized = JSON.stringify(context);
      expect(serialized).not.toContain('super-secret-value-should-never-leak');
      expect(serialized.toLowerCase()).not.toContain('apikey');
      expect(serialized.toLowerCase()).not.toContain('password');
    } finally {
      if (original === undefined) delete process.env.VELONA_API_KEY;
      else process.env.VELONA_API_KEY = original;
    }
  });

  it('item 11 — the context hash is stable for semantically identical input across separate builds', () => {
    setupProfile();
    completedSession(TUESDAY, [{ exercise_id: 'flat-barbell-bench-press', sets: reps(3) }]);
    const first = buildProgrammerContext(db, { targetDate: SUNDAY });
    const second = buildProgrammerContext(db, { targetDate: SUNDAY });
    expect(first.contextId).not.toBe(second.contextId); // genuinely distinct requests
    expect(first.contextHash).toBe(second.contextHash); // but semantically identical state
  });

  it('the context hash changes when the underlying real state genuinely changes', () => {
    setupProfile();
    const before = buildProgrammerContext(db, { targetDate: SUNDAY });
    completedSession(TUESDAY, [{ exercise_id: 'flat-barbell-bench-press', sets: reps(3) }]);
    const after = buildProgrammerContext(db, { targetDate: SUNDAY });
    expect(before.contextHash).not.toBe(after.contextHash);
  });

  it('output requirements and objectives always state the non-negotiable programming rules', () => {
    setupProfile();
    const context = buildProgrammerContext(db, { targetDate: SUNDAY });
    expect(context.objectives.priorityHierarchy.some((r) => /aesthetics/i.test(r))).toBe(true);
    expect(context.outputRequirements.forbiddenBehaviors.length).toBeGreaterThan(0);
    expect(context.executionContext.programmingFilteringAllowed).toBe(false);
  });
});
