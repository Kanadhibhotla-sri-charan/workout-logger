import { describe, expect, it } from 'vitest';
import { buildWorkout, type TargetBuildContext } from '../../src/engine/workoutBuilder.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';

function baseTarget(overrides: Partial<TargetBuildContext> = {}): TargetBuildContext {
  return {
    target_type: 'physique_target',
    target_id: 'mid-pec',
    tier: 'primary',
    is_specialization: true,
    goal_id: 'goal_1',
    goal_priority: 1,
    current_weekly_primary_sets: 0,
    weekly_secondary_sets: 0,
    weekly_exposure_units: 0,
    rolling_exposure_units: 0,
    rolling_window_days: 14,
    most_recent_assessment: null,
    review_cadence_days: 28,
    days_since_target_last_trained: null,
    last_trained_date: null,
    recent_badminton: null,
    recent_exercise_ids: [],
    current_exercise_id: null,
    exercise_history: {},
    outside_blueprint_exercises: [],
    ...overrides,
  };
}

const CHEST_EQUIPMENT = ['barbell', 'bench', 'rack'];

describe('buildWorkout — spec §19 pipeline (pure)', () => {
  it('produces a real exercise with Blueprint-sourced reps/RIR for a new (zero-exposure) target', () => {
    const result = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: CHEST_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [baseTarget()],
    });

    expect(result.exercises.length).toBe(1);
    const planned = result.exercises[0]!;
    expect(planned.target_id).toBe('mid-pec');
    expect(planned.target_sets).toBeGreaterThan(0);
    expect(planned.target_reps_min).toBeGreaterThan(0);
    expect(planned.target_reps_max).toBeGreaterThanOrEqual(planned.target_reps_min);
    expect(planned.estimated_minutes).toBeGreaterThan(0);
    // The exercise must genuinely be Blueprint's own package data for mid-pec.
    expect(BlueprintAdapter.getExercise(planned.exercise_id)).toBeDefined();
    // No exercise_history was supplied — a first-time prescription has
    // nothing to progress from yet.
    expect(planned.progression_decision).toBeNull();
    expect(planned.previous_performance).toBeNull();
  });

  it('remediation §6: usable exercise history produces a real progression_decision and previous_performance, consumed by the builder', () => {
    const result = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: CHEST_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [
        baseTarget({
          current_exercise_id: 'flat-barbell-bench-press',
          exercise_history: {
            'flat-barbell-bench-press': [
              {
                date: '2026-08-27',
                sets: [
                  { weight: 60, reps: 12, completed: true, rir: 1 },
                  { weight: 60, reps: 12, completed: true, rir: 1 },
                ],
              },
            ],
          },
        }),
      ],
    });

    expect(result.exercises.length).toBe(1);
    const planned = result.exercises[0]!;
    expect(planned.exercise_id).toBe('flat-barbell-bench-press');
    expect(planned.progression_decision).not.toBeNull();
    expect(planned.progression_decision!.exercise_id).toBe('flat-barbell-bench-press');
    expect(planned.previous_performance).toEqual({ date: '2026-08-27', weight: 60, reps: 12 });
  });

  it('remediation §6: a "reduce" progression decision actually reduces the session\'s set count, distinct from weekly volume', () => {
    // Four consecutive sessions all falling short of the bottom of the
    // rep range (well below the ~8-12 Blueprint prescribes for
    // flat-barbell-bench-press) is a genuine multi-session decline
    // pattern progressionEngine recognizes as 'reduce'.
    const decliningSession = {
      date: '2026-08-20',
      sets: [{ weight: 60, reps: 3, completed: true, rir: 0 }],
    };
    // Equipment Filter Fix: current_exercise_id is set on BOTH builds
    // (not just the declining one) so Gate 5's progression-continuity
    // pick lands on the same exercise either way — isolating the
    // reduce-vs-no-reduce comparison to the progression decision itself,
    // rather than to which exercise the full (equipment-unfiltered)
    // candidate pool happens to rank first.
    const withoutDecline = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: CHEST_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [baseTarget({ current_weekly_primary_sets: 12, current_exercise_id: 'flat-barbell-bench-press' })],
    });
    const withDecline = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: CHEST_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [
        baseTarget({
          current_weekly_primary_sets: 12,
          current_exercise_id: 'flat-barbell-bench-press',
          exercise_history: {
            'flat-barbell-bench-press': [decliningSession, decliningSession, decliningSession],
          },
        }),
      ],
    });

    const withoutPlan = withoutDecline.exercises[0]!;
    const withPlan = withDecline.exercises.find((e) => e.exercise_id === 'flat-barbell-bench-press');
    expect(withPlan).toBeDefined();
    expect(withPlan!.progression_decision?.recommendation).toBe('reduce');
    expect(withPlan!.target_sets).toBeLessThan(withoutPlan.target_sets);
  });

  it('Consolidated Fix §7: the time budget has zero effect across multiple targets — estimated_minutes may exceed it, informational only', () => {
    const result = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 10,
      available_equipment: CHEST_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [baseTarget({ target_id: 'mid-pec', goal_priority: 1 }), baseTarget({ target_id: 'upper-pec', goal_priority: 2 })],
    });
    expect(result.exercises.find((e) => e.target_id === 'mid-pec')).toBeDefined();
    expect(result.exercises.find((e) => e.target_id === 'upper-pec')).toBeDefined();
    expect(result.estimated_minutes).toBeGreaterThan(10);
  });

  it('Consolidated Fix §7: both targets keep their own real work even under a scarce budget that would have forced a drop under the old time-fitting mechanism', () => {
    const result = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 6, // enough for roughly one exercise, not two, under the old mechanism
      available_equipment: CHEST_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [baseTarget({ target_id: 'upper-pec', goal_priority: 2 }), baseTarget({ target_id: 'mid-pec', goal_priority: 1 })],
    });
    expect(result.exercises.find((e) => e.target_id === 'mid-pec')).toBeDefined();
    expect(result.exercises.find((e) => e.target_id === 'upper-pec')).toBeDefined();
    expect(result.skipped_targets.some((s) => s.reason.includes('time-fitting'))).toBe(false);
  });

  it('Equipment Filter Fix: a target is never skipped merely because no equipment is available — a real Blueprint exercise still gets selected', () => {
    const result = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: [], // nothing available — must never eliminate candidates during generation
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [baseTarget()],
    });
    expect(result.skipped_targets.find((s) => s.target_id === 'mid-pec')).toBeUndefined();
    expect(result.exercises.length).toBe(1);
    const planned = result.exercises[0]!;
    expect(planned.target_id).toBe('mid-pec');
    expect(BlueprintAdapter.getExercise(planned.exercise_id)).toBeDefined();
  });

  it('skips (avoids) a target already trained today, per recoveryEngine', () => {
    const result = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: CHEST_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [baseTarget({ days_since_target_last_trained: 0 })],
    });
    expect(result.exercises).toEqual([]);
    expect(result.skipped_targets[0]!.reason).toContain('recovery');
  });

  it('a stagnant target never gets an automatic volume increase — maintains at its existing (non-zero) volume instead', () => {
    const result = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: CHEST_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [
        baseTarget({
          current_weekly_primary_sets: 10,
          most_recent_assessment: { rating: 3, date: '2026-08-25' }, // stagnant
        }),
      ],
    });
    // Volume is neither silently increased nor invented — the pipeline
    // maintains at current_weekly_primary_sets (10), distributed across
    // sessions, never jumping because of stagnation.
    if (result.exercises.length === 1) {
      const totalWeeklyImplied = result.exercises[0]!.target_sets;
      expect(totalWeeklyImplied).toBeLessThanOrEqual(10);
    }
    expect(result.reasoning_log.some((l) => l.includes('introspect'))).toBe(true);
  });

  it('never assigns a lower-body target to Monday, even indirectly through this pipeline', () => {
    const result = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: ['barbell', 'rack', 'bench'],
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [baseTarget({ target_id: 'quads', current_weekly_primary_sets: 10 })],
    });
    expect(result.exercises.find((e) => e.target_id === 'quads')).toBeUndefined();
  });

  it('skips a functional_goal target with no Blueprint development-package data, surfacing the exact gap rather than inventing a rep range', () => {
    const functionalGoal = BlueprintAdapter.getFunctionalGoals()[0]!;
    const result = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: ['bodyweight'],
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [
        baseTarget({
          target_type: 'functional_goal',
          target_id: functionalGoal.id,
          current_weekly_primary_sets: 4,
        }),
      ],
    });
    expect(result.exercises.find((e) => e.target_id === functionalGoal.id)).toBeUndefined();
    const skip = result.skipped_targets.find((s) => s.target_id === functionalGoal.id);
    expect(skip).toBeDefined();
  });

  it('remediation §10/§15: an approved outside-Blueprint candidate fills a functional_goal target Blueprint itself cannot prescribe', () => {
    const functionalGoal = BlueprintAdapter.getFunctionalGoals()[0]!;
    const result = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: ['bodyweight', 'kettlebell'],
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [
        baseTarget({
          target_type: 'functional_goal',
          target_id: functionalGoal.id,
          current_weekly_primary_sets: 4,
          outside_blueprint_exercises: [
            { id: 'outside-ex-1', name: 'Turkish Get-Up', role: 'primary', equipment: ['kettlebell'], reps_range: '5-8', rir_range: '2-4' },
          ],
        }),
      ],
    });
    const plan = result.exercises.find((e) => e.target_id === functionalGoal.id);
    expect(plan?.exercise_id).toBe('outside-ex-1');
    expect(plan?.target_reps_min).toBe(5);
    expect(plan?.target_reps_max).toBe(8);
    expect(plan?.target_rir_min).toBe(2);
    expect(plan?.target_rir_max).toBe(4);
    expect(result.skipped_targets.find((s) => s.target_id === functionalGoal.id)).toBeUndefined();
  });

  it('Equipment Filter Fix: an approved outside-Blueprint candidate remains selectable even when its own equipment is unavailable', () => {
    const functionalGoal = BlueprintAdapter.getFunctionalGoals()[0]!;
    const result = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: ['bodyweight'], // does not include 'kettlebell'
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [
        baseTarget({
          target_type: 'functional_goal',
          target_id: functionalGoal.id,
          current_weekly_primary_sets: 4,
          outside_blueprint_exercises: [
            { id: 'outside-ex-1', name: 'Turkish Get-Up', role: 'primary', equipment: ['kettlebell'], reps_range: '5-8', rir_range: '2-4' },
          ],
        }),
      ],
    });
    const plan = result.exercises.find((e) => e.target_id === functionalGoal.id);
    expect(plan).toBeDefined();
    expect(plan!.exercise_id).toBe('outside-ex-1');
    expect(result.skipped_targets.find((s) => s.target_id === functionalGoal.id)).toBeUndefined();
  });

  it('Equipment Filter Fix: the current exercise is kept (never substituted) when only its equipment is unavailable', () => {
    // Only 'cable' equipment is available — flat-barbell-bench-press
    // needs barbell/bench/rack, none of which are listed. Equipment
    // availability must never drive candidate selection during program
    // generation (the user substitutes manually if a specific session's
    // equipment genuinely isn't there); Gate 5's progression-continuity
    // pick keeps the current exercise regardless.
    const result = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: ['cable'],
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [baseTarget({ current_exercise_id: 'flat-barbell-bench-press' })],
    });

    expect(result.exercises.length).toBe(1);
    const planned = result.exercises[0]!;
    expect(planned.exercise_id).toBe('flat-barbell-bench-press');
    expect(planned.decision.selection?.substituted_from).toBeNull();
  });

  it('required test 11: a heavy recent badminton session changes the pipeline\'s recovery-driven reasoning for a stagnant target', () => {
    const stagnantTarget = baseTarget({
      current_weekly_primary_sets: 10,
      most_recent_assessment: { rating: 3, date: '2026-08-25' },
    });

    const withoutBadminton = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: CHEST_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [stagnantTarget],
    });

    const withHeavyBadminton = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: CHEST_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [{ ...stagnantTarget, recent_badminton: { intensity: 'high', post_session_fatigue: null } }],
    });

    // Both stay in "introspect_needed" territory (neither auto-increases —
    // required test 10 territory too), but *why* differs: recovery-flagged
    // vs. plain-stagnation reasoning, because badminton demand actually
    // reached the recovery decision that feeds volumeEngine.
    const withoutReasoning = withoutBadminton.reasoning_log.join(' ');
    const withReasoning = withHeavyBadminton.reasoning_log.join(' ');
    expect(withReasoning).toContain('recovery is flagged');
    expect(withoutReasoning).not.toContain('recovery is flagged');
  });

  it('is deterministic: identical input always produces identical output', () => {
    const input = {
      date: '2026-08-31',
      weekday: 'monday' as const,
      budget_minutes: 60,
      available_equipment: CHEST_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'] as const,
      targets: [baseTarget()],
    };
    expect(buildWorkout(input)).toEqual(buildWorkout(input));
  });

  it('every decision is logged with real reasoning — nothing opaque (spec §20)', () => {
    const result = buildWorkout({
      date: '2026-08-31',
      weekday: 'monday',
      budget_minutes: 60,
      available_equipment: CHEST_EQUIPMENT,
      available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
      targets: [baseTarget()],
    });
    expect(result.reasoning_log.length).toBeGreaterThan(0);
    for (const line of result.reasoning_log) {
      expect(typeof line).toBe('string');
      expect(line.length).toBeGreaterThan(5);
    }
  });

  describe('remediation §16: machine-readable decision explanation object', () => {
    it('a generated exercise carries a fully populated decision object drawn from real per-target data', () => {
      const result = buildWorkout({
        date: '2026-08-31',
        weekday: 'monday',
        budget_minutes: 60,
        available_equipment: CHEST_EQUIPMENT,
        available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
        targets: [
          baseTarget({
            current_weekly_primary_sets: 4,
            weekly_secondary_sets: 2,
            weekly_exposure_units: 5.66,
            rolling_exposure_units: 8,
            days_since_target_last_trained: 3,
            last_trained_date: '2026-08-28',
            recent_exercise_ids: ['flat-barbell-bench-press'],
          }),
        ],
      });

      const planned = result.exercises[0]!;
      expect(planned.decision.classification).toBe(planned.classification);
      expect(planned.decision.weekly_exposure).toEqual({
        primary_sets: 4,
        secondary_sets: 2,
        exposure_units: 5.66,
        rolling_exposure_units: 8,
        rolling_window_days: 14,
      });
      expect(planned.decision.last_trained).toEqual({ date: '2026-08-28', days_since: 3 });
      expect(planned.decision.recent_exercise_ids).toEqual(['flat-barbell-bench-press']);
      expect(planned.decision.badminton_context).toBeNull();
      expect(planned.decision.recovery.priority_adjustment).not.toBe('avoid');
      expect(planned.decision.volume_decision.action).toBeDefined();
      expect(planned.decision.session_purpose).toBe('push');
      expect(planned.decision.weekly_allocation?.eligible_days_this_week).toContain('monday');
      expect(planned.decision.selection?.decisive_gate).toBeDefined();
      expect(Array.isArray(planned.decision.selection?.rejected_candidates)).toBe(true);
    });

    it('a substitution is recorded when selection replaces the target\'s current exercise', () => {
      // 'back-squat' is a real Blueprint exercise, but not one that
      // trains mid-pec at all — it can never win Gate 5's progression-
      // continuity check (which only ever keeps `current_exercise_id`
      // when it's genuinely still in this target's own candidate pool),
      // so a real substitution is guaranteed regardless of equipment
      // (Equipment Filter Fix: equipment is no longer what forces this).
      const result = buildWorkout({
        date: '2026-08-31',
        weekday: 'monday',
        budget_minutes: 60,
        available_equipment: CHEST_EQUIPMENT,
        available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
        targets: [baseTarget({ current_exercise_id: 'back-squat' })],
      });
      const planned = result.exercises[0]!;
      expect(planned.exercise_id).not.toBe('back-squat');
      expect(planned.decision.selection?.substituted_from).toBe('back-squat');
    });

    it('no substitution is recorded when selection keeps the target\'s current exercise (continuity, not a substitution)', () => {
      const result = buildWorkout({
        date: '2026-08-31',
        weekday: 'monday',
        budget_minutes: 60,
        available_equipment: CHEST_EQUIPMENT,
        available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
        targets: [baseTarget({ current_exercise_id: 'flat-barbell-bench-press', recent_exercise_ids: [] })],
      });
      const planned = result.exercises[0]!;
      expect(planned.exercise_id).toBe('flat-barbell-bench-press');
      expect(planned.decision.selection?.substituted_from).toBeNull();
    });

    it('a target skipped before weekly allocation carries recovery but null volume_decision/weekly_allocation/selection — never a fabricated decision', () => {
      const result = buildWorkout({
        date: '2026-08-31',
        weekday: 'monday',
        budget_minutes: 60,
        available_equipment: CHEST_EQUIPMENT,
        available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
        targets: [baseTarget({ days_since_target_last_trained: 0 })], // trained today -> 'avoid'
      });
      const skip = result.skipped_targets.find((s) => s.target_id === 'mid-pec')!;
      expect(skip.decision.recovery.priority_adjustment).toBe('avoid');
      expect(skip.decision.volume_decision).toBeNull();
      expect(skip.decision.weekly_allocation).toBeNull();
      expect(skip.decision.selection).toBeNull();
    });

    it("active_goals lists every real (specialization) goal, excluding the synthetic normal-development bucket", () => {
      const result = buildWorkout({
        date: '2026-08-31',
        weekday: 'monday',
        budget_minutes: 60,
        available_equipment: CHEST_EQUIPMENT,
        available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
        targets: [
          baseTarget({ target_id: 'mid-pec', goal_id: 'goal_A', goal_priority: 1, is_specialization: true }),
          baseTarget({ target_id: 'upper-pec', goal_id: '__normal_development_or_maintenance__', goal_priority: 1000, is_specialization: false }),
        ],
      });
      expect(result.active_goals).toEqual([{ goal_id: 'goal_A', priority: 1, trend: 'insufficient_data' }]);
    });

    it('Consolidated Fix §7: resource_allocation is always empty (time no longer competes for or filters anything); constraints still echo the real input verbatim', () => {
      const result = buildWorkout({
        date: '2026-08-31',
        weekday: 'monday',
        budget_minutes: 45,
        available_equipment: CHEST_EQUIPMENT,
        available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
        targets: [baseTarget()],
      });
      expect(result.resource_allocation).toEqual([]);
      expect(result.constraints).toEqual({ available_equipment: CHEST_EQUIPMENT, budget_minutes: 45 });
    });
  });

  describe('Consolidated Fix §7: session time no longer competes goals against each other for a shared budget (supersedes the former remediation §17 resourceAllocation/time-budget-split tests)', () => {
    it('both goals are served in full regardless of priority ordering or a nominally scarce budget — no goal-level time allocation log line is produced any more', () => {
      const result = buildWorkout({
        date: '2026-08-31',
        weekday: 'monday',
        budget_minutes: 12, // scarce nominal budget — used to leave only goal_A's work under the old mechanism
        available_equipment: CHEST_EQUIPMENT,
        available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
        targets: [
          baseTarget({ target_id: 'mid-pec', goal_id: 'goal_A', goal_priority: 1 }),
          baseTarget({ target_id: 'upper-pec', goal_id: 'goal_B', goal_priority: 2 }),
        ],
      });
      expect(result.exercises.find((e) => e.target_id === 'mid-pec')).toBeDefined();
      expect(result.exercises.find((e) => e.target_id === 'upper-pec')).toBeDefined();
      expect(result.reasoning_log.some((l) => l.includes('Goal-level time allocation'))).toBe(false);
      expect(result.skipped_targets.some((s) => s.reason.includes('time-fitting'))).toBe(false);
    });

    it('a generous budget produces the identical result as a scarce one — the nominal budget value itself has no bearing on what gets generated', () => {
      const generous = buildWorkout({
        date: '2026-08-31',
        weekday: 'monday',
        budget_minutes: 60,
        available_equipment: CHEST_EQUIPMENT,
        available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
        targets: [
          baseTarget({ target_id: 'mid-pec', goal_id: 'goal_A', goal_priority: 1 }),
          baseTarget({ target_id: 'upper-pec', goal_id: 'goal_B', goal_priority: 2 }),
        ],
      });
      const scarce = buildWorkout({
        date: '2026-08-31',
        weekday: 'monday',
        budget_minutes: 6,
        available_equipment: CHEST_EQUIPMENT,
        available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
        targets: [
          baseTarget({ target_id: 'mid-pec', goal_id: 'goal_A', goal_priority: 1 }),
          baseTarget({ target_id: 'upper-pec', goal_id: 'goal_B', goal_priority: 2 }),
        ],
      });
      expect(scarce.exercises.map((e) => e.exercise_id).sort()).toEqual(generous.exercises.map((e) => e.exercise_id).sort());
    });
  });

  describe('remediation §9: badminton actually changes programming, not just explanation text', () => {
    const QUADS_EQUIPMENT = ['barbell', 'rack', 'machine'];

    // Session purposes rotate push/pull/legs/upper across the ordered
    // gym days — tuesday/wednesday/thursday here land as push/pull/legs,
    // so a legs-only target (quads) is only ever eligible on Thursday,
    // with exactly one eligible session remaining once Thursday itself
    // is "today" (matching the single-session-per-week math these tests
    // were originally written against).
    function quadsInput(recentBadminton: TargetBuildContext['recent_badminton']) {
      return {
        date: '2026-09-03', // a Thursday
        weekday: 'thursday' as const,
        budget_minutes: 60,
        available_equipment: QUADS_EQUIPMENT,
        available_training_days: ['tuesday', 'wednesday', 'thursday'] as const,
        targets: [
          baseTarget({
            target_id: 'quads',
            current_weekly_primary_sets: 0, // §9 starting-volume branch: always 'increase', regardless of recovery_ok
            recent_badminton: recentBadminton,
          }),
        ],
      };
    }

    it('trims today\'s session by one set (never the weekly volume) for a lower-body target after heavy badminton', () => {
      const withoutBadminton = buildWorkout(quadsInput(null));
      const withBadminton = buildWorkout(quadsInput({ intensity: 'high', post_session_fatigue: null }));

      const planWithout = withoutBadminton.exercises.find((e) => e.target_id === 'quads')!;
      const planWith = withBadminton.exercises.find((e) => e.target_id === 'quads')!;
      expect(planWithout.target_sets).toBeGreaterThan(1); // baseline must be >1 for the -1 trim to be observable
      expect(planWith.target_sets).toBe(planWithout.target_sets - 1);
      expect(planWith.reasoning).toContain('remediation §9');
    });

    it('prefers a lower Blueprint fatigue_cost exercise for a lower-body target after heavy badminton', () => {
      // back-squat (fatigue_cost high) sorts alphabetically before
      // leg-extension (fatigue_cost low) — without badminton, Gate 6's
      // plain alphabetical tie-break picks back-squat.
      const withoutBadminton = buildWorkout(quadsInput(null));
      const planWithout = withoutBadminton.exercises.find((e) => e.target_id === 'quads')!;
      expect(planWithout.exercise_id).toBe('back-squat');

      const withBadminton = buildWorkout(quadsInput({ intensity: 'high', post_session_fatigue: null }));
      const planWith = withBadminton.exercises.find((e) => e.target_id === 'quads')!;
      expect(planWith.exercise_id).toBe('leg-extension');
      expect(planWith.reasoning).toContain('fatigue_cost');
    });

    it('does not apply the lower-body badminton effects to an upper-body target', () => {
      const result = buildWorkout({
        date: '2026-09-01',
        weekday: 'tuesday',
        budget_minutes: 60,
        available_equipment: CHEST_EQUIPMENT,
        available_training_days: ['tuesday'],
        targets: [
          baseTarget({
            target_id: 'mid-pec',
            current_weekly_primary_sets: 0,
            recent_badminton: { intensity: 'high', post_session_fatigue: null },
          }),
        ],
      });
      const plan = result.exercises.find((e) => e.target_id === 'mid-pec');
      expect(plan?.reasoning).not.toContain('remediation §9');
    });

    it('still never authorizes a weekly volume increase from badminton alone when starting volume is not the reason (recovery_ok stays the only gate volumeEngine sees)', () => {
      // Non-zero current volume + stagnant trend + badminton-caused
      // 'reduce' must fall to introspect_needed, exactly like any other
      // 'reduce' cause — badminton never gets a special volume-level
      // bypass or a special volume-level penalty.
      const result = buildWorkout({
        date: '2026-09-03', // Thursday — the legs day in this rotation (see quadsInput above)
        weekday: 'thursday',
        budget_minutes: 60,
        // Equipment Filter Fix: available_equipment no longer narrows
        // candidates at all, so quads' full real candidate pool (not
        // just back-squat) competes here — the assertion below sums
        // across every quads exercise placed rather than assuming a
        // single one, since this test's real intent (badminton never
        // inflates/deflates weekly volume beyond the legitimate 1-set
        // trim) is independent of how many exercises deliver it.
        available_equipment: ['barbell', 'rack'],
        available_training_days: ['tuesday', 'wednesday', 'thursday'],
        targets: [
          baseTarget({
            target_id: 'quads',
            current_weekly_primary_sets: 6,
            most_recent_assessment: { rating: 3, date: '2026-08-25' }, // stagnant
            recent_badminton: { intensity: 'high', post_session_fatigue: null },
          }),
        ],
      });
      const quadsExercises = result.exercises.filter((e) => e.target_id === 'quads');
      // Weekly volume held at the pre-existing 6 (minus the single
      // session-level trim, since exactly one eligible session remains
      // this week) — never pushed up OR down by badminton itself.
      expect(quadsExercises.reduce((sum, e) => sum + e.target_sets, 0)).toBe(5);
    });
  });
});
