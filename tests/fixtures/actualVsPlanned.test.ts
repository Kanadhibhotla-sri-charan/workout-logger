// Fixture G (spec §35, §27): actual vs. planned performance. Planned:
// 3 x 8. Actual: 8 / 8 / 5. Verifies that (1) the plan and the actual
// result are stored as genuinely separate data, (2) exposure/history
// reads the ACTUAL result, never the plan, and (3) an incomplete/short
// set (5 reps against a target of 8) is still stored faithfully — this
// app never silently "corrects" a logged set to match what was planned.

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { ProgramsRepo } from '../../src/repositories/programsRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { calculateExerciseExposure } from '../../src/engine/exposureEngine.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';

let db: Database.Database;

const EXERCISE_ID = BlueprintAdapter.getExercises()[0]!.id;

beforeEach(() => {
  db = openDb(':memory:');
});

describe('fixture G: actual vs. planned performance', () => {
  it('the plan (ProgramSessionExercise) and the actual result (ExercisePerformance/Set) are stored separately', () => {
    const programsRepo = new ProgramsRepo(db);
    const program = programsRepo.createProgram({ name: 'Test Program', goal_ids: [] });
    const programSession = programsRepo.createProgramSession({
      program_id: program.id,
      day_index: 0,
      name: 'Day 1',
      planned_session_type: 'gym',
      exercises: [{ exercise_id: EXERCISE_ID, order: 1, role: 'primary', target_sets: 3, target_reps_min: 8, target_reps_max: 8 }],
    });

    const sessionsRepo = new WorkoutSessionsRepo(db);
    const workoutSession = sessionsRepo.createSession({
      date: '2026-09-03',
      session_type: 'gym',
      program_id: program.id,
      program_session_id: programSession.id,
      status: 'completed',
    });

    // Actual: 8 / 8 / 5 — the third set fell short of the planned 8 reps.
    sessionsRepo.addExercisePerformance(workoutSession.session_id, {
      exercise_id: EXERCISE_ID,
      order: 1,
      role: 'primary',
      sets: [
        { set_number: 1, reps: 8, weight: 50, completed: true },
        { set_number: 2, reps: 8, weight: 50, completed: true },
        { set_number: 3, reps: 5, weight: 50, completed: true },
      ],
    });

    const plan = programsRepo.getProgramSession(programSession.id)!.exercises[0]!;
    const actual = sessionsRepo.getExercisePerformances(workoutSession.session_id)[0]!;

    // The plan is untouched by what actually happened.
    expect(plan).toMatchObject({ target_sets: 3, target_reps_min: 8, target_reps_max: 8 });

    // The actual result is stored exactly as reported — including the
    // short set — never "corrected" toward the plan.
    expect(actual.sets.map((s) => s.reps)).toEqual([8, 8, 5]);
    expect(actual.sets[2]!.reps).not.toBe(plan.target_reps_min); // 5 != 8, and nothing rewrote it
  });

  it('exposure is calculated from the actual completed sets, never the planned set count', () => {
    // Plan says 3 sets; actual only has 2 completed (the third was
    // logged but not completed — e.g. abandoned mid-set).
    const sessionsRepo = new WorkoutSessionsRepo(db);
    const workoutSession = sessionsRepo.createSession({ date: '2026-09-03', session_type: 'gym', status: 'completed' });
    sessionsRepo.addExercisePerformance(workoutSession.session_id, {
      exercise_id: EXERCISE_ID,
      order: 1,
      role: 'primary',
      sets: [
        { set_number: 1, reps: 8, weight: 50, completed: true },
        { set_number: 2, reps: 8, weight: 50, completed: true },
        { set_number: 3, reps: 3, weight: 50, completed: false }, // abandoned
      ],
    });

    const performance = sessionsRepo.getExercisePerformances(workoutSession.session_id)[0]!;
    const { contributions } = calculateExerciseExposure(
      performance.exercise_id,
      performance.sets.map((s) => ({ completed: s.completed }))
    );

    // Exposure reflects 2 completed sets — not the 3 that were planned
    // or logged, and not silently assuming the abandoned set counted.
    expect(contributions.length).toBeGreaterThan(0);
    for (const c of contributions) {
      expect(c.completed_sets).toBe(2);
    }
  });
});
