// Fixture from the Phase 1.5 remediation spec: "My arms look thin from the
// side." Proves the goal-resolution chain works end to end against real
// Blueprint data, WITHOUT requiring a final generated exercise program —
// that's explicitly out of scope until the Training Engine exists (see
// docs/TRAINING_EXPOSURE_MODEL.md). This only proves:
//   1. the user goal is stored;
//   2. the Blueprint reference resolves;
//   3. the relevant target information is retrievable;
//   4. the training state (a logged workout) can later be evaluated
//      against that goal, by walking the same id chain.

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';

const USER_GOAL_PHRASING = 'My arms look thin from the side.';
const BLUEPRINT_OUTCOME_ID = 'arm-side-thickness';

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
});

describe('fixture: "arms look thin from side"', () => {
  it('the Blueprint outcome behind the user phrasing exists and matches the expected primary/supporting targets', () => {
    const outcome = BlueprintAdapter.getAestheticGoal(BLUEPRINT_OUTCOME_ID);

    expect(outcome).toBeDefined();
    expect(outcome!.display_name.toLowerCase()).toContain('thin from the side');
    expect(outcome!.primary_targets).toEqual(['brachialis-arm-thickness']);
    expect(outcome!.supporting_targets).toEqual(['triceps']);
  });

  it('1. the user goal is stored', () => {
    const repo = new GoalsRepo(db);
    const goal = repo.create({
      goal_type: 'aesthetic',
      blueprint_ref: BLUEPRINT_OUTCOME_ID,
      priority: 1,
      notes: USER_GOAL_PHRASING,
    });

    expect(repo.get(goal.id)).toEqual(goal);
  });

  it('2. the Blueprint reference resolves', () => {
    const repo = new GoalsRepo(db);
    const goal = repo.create({ goal_type: 'aesthetic', blueprint_ref: BLUEPRINT_OUTCOME_ID, priority: 1 });

    const resolved = repo.resolveBlueprint(goal.id);

    expect(resolved?.id).toBe(BLUEPRINT_OUTCOME_ID);
  });

  it('3. the relevant target information can be retrieved (primary: brachialis, supporting: triceps)', () => {
    const repo = new GoalsRepo(db);
    const goal = repo.create({ goal_type: 'aesthetic', blueprint_ref: BLUEPRINT_OUTCOME_ID, priority: 1 });
    const outcome = repo.resolveBlueprint(goal.id)!;

    expect('primary_targets' in outcome).toBe(true);
    const aestheticOutcome = outcome as import('../../src/blueprint/adapter.js').BlueprintAestheticOutcome;

    const primary = BlueprintAdapter.getTarget(aestheticOutcome.primary_targets[0]!);
    const supporting = BlueprintAdapter.getTarget((aestheticOutcome.supporting_targets ?? [])[0]!);

    expect(primary?.id).toBe('brachialis-arm-thickness');
    expect(primary?.name.toLowerCase()).toContain('brachialis');
    expect(supporting?.id).toBe('triceps');
  });

  it('4. training state can later be evaluated against the goal (a logged exercise traces back to the same targets)', () => {
    const goalsRepo = new GoalsRepo(db);
    const goal = goalsRepo.create({ goal_type: 'aesthetic', blueprint_ref: BLUEPRINT_OUTCOME_ID, priority: 1 });
    const outcome = goalsRepo.resolveBlueprint(goal.id)! as import('../../src/blueprint/adapter.js').BlueprintAestheticOutcome;
    const relevantTargets = new Set([...outcome.primary_targets, ...(outcome.supporting_targets ?? [])]);

    // Find a real exercise whose physique_targets overlap this goal —
    // proof the chain is walkable, not a hand-picked/hard-coded id.
    const exercise = BlueprintAdapter.getExercises().find((e) =>
      (e.physique_targets ?? []).some((t) => relevantTargets.has(t))
    );
    expect(exercise).toBeDefined();

    const sessionsRepo = new WorkoutSessionsRepo(db);
    const session = sessionsRepo.createSession({
      date: '2026-08-29',
      session_type: 'gym',
      goal_context: { goal_type: 'aesthetic', goal_id: goal.id, priority: 1, program_phase: null },
    });
    sessionsRepo.addExercisePerformance(session.session_id, {
      exercise_id: exercise!.id,
      order: 1,
      role: 'primary',
      sets: [{ set_number: 1, weight: 20, reps: 12, completed: true }],
    });

    // Evaluate: does what was actually performed touch this goal's targets?
    const performances = sessionsRepo.getExercisePerformances(session.session_id);
    const performedTargets = performances.flatMap((p) => BlueprintAdapter.getExercise(p.exercise_id)?.physique_targets ?? []);
    const overlap = performedTargets.filter((t) => relevantTargets.has(t));

    expect(overlap.length).toBeGreaterThan(0);
  });
});
