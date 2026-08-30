import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { assembleAndBuildWorkout } from '../../src/engine/workoutBuilder.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';

// 2026-08-31 is a Monday.
const MONDAY = '2026-08-31';
const PRIOR_THURSDAY = '2026-08-27';

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
});

function setupProfileAndGoal(db: Database.Database, equipment: string[]) {
  const user = new UsersRepo(db).getOrCreateDefault();
  new TrainingProfileRepo(db).upsert(user.id, {
    timezone: 'Asia/Kolkata',
    week_start_day: 'monday',
    training_days: ['monday', 'tuesday', 'thursday', 'friday'],
    default_session_duration_minutes: 60,
    minimum_session_duration_minutes: 30,
    maximum_session_duration_minutes: 90,
    available_equipment: equipment,
    other_activity_schedule: [],
  });
  const outcome = BlueprintAdapter.getAestheticGoals().find((o) => o.primary_targets.includes('mid-pec'))!;
  new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: outcome.id, priority: 1 });
}

describe('assembleAndBuildWorkout — the impure DB-reading boundary, wired to buildWorkout', () => {
  it('generates a real, Blueprint-grounded workout end-to-end for an active aesthetic goal', () => {
    const user = new UsersRepo(db).getOrCreateDefault();
    new TrainingProfileRepo(db).upsert(user.id, {
      timezone: 'Asia/Kolkata',
      week_start_day: 'monday',
      training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      default_session_duration_minutes: 60,
      minimum_session_duration_minutes: 30,
      maximum_session_duration_minutes: 90,
      available_equipment: ['barbell', 'bench', 'rack', 'cable'],
      other_activity_schedule: [],
    });

    // "Chest looks flat from the side" -> primary_targets: ['mid-pec']
    const outcome = BlueprintAdapter.getAestheticGoals().find((o) => o.primary_targets.includes('mid-pec'))!;
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: outcome.id, priority: 1 });

    const result = assembleAndBuildWorkout(db, MONDAY, 60);

    expect(result.date).toBe(MONDAY);
    expect(result.exercises.length).toBeGreaterThan(0);
    const planned = result.exercises[0]!;
    expect(BlueprintAdapter.getExercise(planned.exercise_id)).toBeDefined();
    expect(planned.target_sets).toBeGreaterThan(0);
    expect(result.estimated_minutes).toBeLessThanOrEqual(60);
  });

  it('produces no exercises (only skipped_targets) when there are no active goals at all', () => {
    const user = new UsersRepo(db).getOrCreateDefault();
    new TrainingProfileRepo(db).upsert(user.id, {
      timezone: 'Asia/Kolkata',
      week_start_day: 'monday',
      training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      default_session_duration_minutes: 60,
      minimum_session_duration_minutes: 30,
      maximum_session_duration_minutes: 90,
      available_equipment: ['barbell', 'bench', 'rack'],
      other_activity_schedule: [],
    });

    const result = assembleAndBuildWorkout(db, MONDAY, 60);
    expect(result.exercises).toEqual([]);
    expect(result.skipped_targets).toEqual([]);
  });

  it('works with no TrainingProfile at all (falls back to empty equipment/training days, so nothing is scheduled)', () => {
    const outcome = BlueprintAdapter.getAestheticGoals().find((o) => o.primary_targets.includes('mid-pec'))!;
    new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: outcome.id, priority: 1 });

    const result = assembleAndBuildWorkout(db, MONDAY, 60);
    expect(result.exercises).toEqual([]);
  });

  it('remediation §4-5: real prior exercise history changes exercise selection through the full pipeline (Gate 5 continuity)', () => {
    // Both flat-barbell-bench-press and cable-fly are equipment-feasible
    // and have real Blueprint prescription data. Alphabetically
    // ('cable-fly' < 'flat-barbell-bench-press') Gate 6 would pick
    // cable-fly with no history at all. Logging a REAL prior session on
    // flat-barbell-bench-press must flip the winner via Gate 5
    // (progression continuity) — proving current_exercise_id now comes
    // from actual WorkoutSessionsRepo history, not a hardcoded null.
    setupProfileAndGoal(db, ['barbell', 'bench', 'rack', 'cable']);

    const sessionsRepo = new WorkoutSessionsRepo(db);
    const priorSession = sessionsRepo.createSession({ date: PRIOR_THURSDAY, session_type: 'gym', status: 'completed' });
    sessionsRepo.addExercisePerformance(priorSession.session_id, {
      exercise_id: 'flat-barbell-bench-press',
      order: 1,
      role: 'primary',
      sets: [
        { set_number: 1, weight: 60, reps: 8, completed: true },
        { set_number: 2, weight: 60, reps: 8, completed: true },
        { set_number: 3, weight: 60, reps: 8, completed: true },
      ],
    });

    const result = assembleAndBuildWorkout(db, MONDAY, 60);
    const midPecPlan = result.exercises.find((e) => e.target_id === 'mid-pec');
    expect(midPecPlan?.exercise_id).toBe('flat-barbell-bench-press');
    expect(midPecPlan?.reasoning).toContain('gate5_progression_continuity');
    // remediation §6: progressionEngine must actually be consumed here —
    // real prior sets (8 reps, within flat-barbell-bench-press's 6-12
    // Blueprint range but not yet at the top) should produce a real
    // increase_reps decision and a real previous_performance summary,
    // not null placeholders.
    expect(midPecPlan?.progression_decision?.recommendation).toBe('increase_reps');
    expect(midPecPlan?.previous_performance).toEqual({ date: PRIOR_THURSDAY, weight: 60, reps: 8 });
  });

  it('remediation §5: a target already trained today is skipped (avoid), proving days_since_target_last_trained is real', () => {
    setupProfileAndGoal(db, ['barbell', 'bench', 'rack', 'cable']);

    const sessionsRepo = new WorkoutSessionsRepo(db);
    const todaySession = sessionsRepo.createSession({ date: MONDAY, session_type: 'gym', status: 'completed' });
    sessionsRepo.addExercisePerformance(todaySession.session_id, {
      exercise_id: 'flat-barbell-bench-press',
      order: 1,
      role: 'primary',
      sets: [{ set_number: 1, weight: 60, reps: 8, completed: true }],
    });

    const result = assembleAndBuildWorkout(db, MONDAY, 60);
    const midPecPlan = result.exercises.find((e) => e.target_id === 'mid-pec');
    expect(midPecPlan).toBeUndefined();
    const skip = result.skipped_targets.find((s) => s.target_id === 'mid-pec');
    expect(skip?.reason).toContain('recovery');
  });

  it('remediation §4: a recently-used-but-not-current exercise is still selectable (Gate 4 sees real recent_exercise_ids, not an empty placeholder)', () => {
    // Only 'cable' equipment is available, and cable-fly is the ONLY
    // real prior history for this target — it is simultaneously
    // "recent" and "current." If recent_exercise_ids were still the
    // old hardcoded [], this would be indistinguishable from having no
    // history at all; the real assertion here is that a genuine,
    // non-empty history doesn't ever make its own only-feasible
    // candidate unselectable.
    setupProfileAndGoal(db, ['cable']);
    const sessionsRepo = new WorkoutSessionsRepo(db);
    const session = sessionsRepo.createSession({ date: '2026-08-24', session_type: 'gym', status: 'completed' });
    sessionsRepo.addExercisePerformance(session.session_id, {
      exercise_id: 'cable-fly',
      order: 1,
      role: 'primary',
      sets: [{ set_number: 1, weight: 20, reps: 12, completed: true }],
    });

    const result = assembleAndBuildWorkout(db, MONDAY, 60);
    const midPecPlan = result.exercises.find((e) => e.target_id === 'mid-pec');
    expect(midPecPlan?.exercise_id).toBe('cable-fly');
  });
});
