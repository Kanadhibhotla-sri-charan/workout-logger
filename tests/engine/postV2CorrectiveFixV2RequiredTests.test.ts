// Workout Programmer — Post-v2 Corrective Fix v2: the regression tests
// required by spec §24 that are NOT already covered by existing suites.
//
//   §24.D (no catch-up debt) — tests/engine/consolidatedFixRequiredTests.test.ts
//     Test 3 ("frequency across calendar boundary" / no debt).
//   §24.E (planned exposure is not actual exposure) — this pipeline is
//     pure (buildWeeklyProgrammingPlan/buildWorkout never touch the
//     database), and tests/engine/assembleAndBuildWorkout.test.ts's own
//     "remediation §17/§25: deterministic at the real impure boundary
//     too — identical DB state produces byte-identical output on repeat
//     calls" already proves a repeat call never accumulates state from
//     a prior (uncompleted) call's own projection.
//   §24.F (actual completion changes future programming) —
//     tests/routes/actualTrainingAdaptation.test.ts,
//     tests/routes/weekProgramPersistence.test.ts.
//   §24.H (authored-set cap) — tests/engine/consolidatedFixRequiredTests.test.ts
//     Test 1-2, tests/engine/strictBugFixRequiredTests.test.ts.
//   §24.I (Blueprint exercise validity) —
//     tests/engine/blueprintCandidateGating.test.ts.
//   §24.J/§24.K (time/equipment invariance) —
//     tests/engine/consolidatedFixRequiredTests.test.ts Test 4,
//     tests/engine/onePassDevSpecV2RequiredTests.test.ts §31.7.
//   §24.M (skip scope) — tests/engine/consolidatedFixRequiredTests.test.ts
//     Tests 11-12, tests/engine/onePassDevSpecV2RequiredTests.test.ts §31.14.
//   §24.N (completed/locked protection) —
//     tests/engine/weekProgramReconciliation.test.ts,
//     tests/routes/actualTrainingAdaptation.test.ts.
//
// This file adds the four genuinely new required cases: §24.A/§24.G
// (minimum spacing is not the sole frequency gate), §24.B (one
// compatible session per week across multiple real weeks, no cramming/
// debt), §24.C (a real exposure near a calendar boundary remains real
// history the very next day, never resetting), and §24.L (a shared
// Blueprint package's aggregate is never duplicated as each covered
// target's own complete objective).

import { describe, expect, it } from 'vitest';
import { buildWorkout, buildWeeklyProgrammingPlan, type TargetBuildContext, type WeeklyPlanInput } from '../../src/engine/workoutBuilder.js';
import { getDevelopmentReference } from '../../src/engine/developmentReferenceEngine.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];

function normalDevTarget(targetId: string, overrides: Partial<TargetBuildContext> = {}): TargetBuildContext {
  return {
    target_type: 'physique_target',
    target_id: targetId,
    tier: 'supporting',
    is_specialization: false,
    goal_id: '__normal_development_or_maintenance__',
    goal_priority: 1000,
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

function weeklyInput(overrides: Partial<WeeklyPlanInput> = {}): WeeklyPlanInput {
  return {
    weekStart: '2026-08-31',
    today: '2026-08-31',
    todayWeekday: 'monday',
    todayBudgetMinutes: 300,
    defaultSessionMinutes: 300,
    available_equipment: FULL_EQUIPMENT,
    available_training_days: ['monday'],
    targets: [],
    ...overrides,
  };
}

describe('Post-v2 Corrective Fix v2 §24.A/§24.G — minimum spacing is NOT the sole frequency gate', () => {
  it('a 4/week target with real exposures 1 day apart (Mon-Thu) never gets a 5th exposure 1 day later (Friday) merely because spacing alone would allow it', () => {
    // 'obliques' is compatible with every session purpose (push/pull/
    // legs/upper), so purpose-compatibility itself never explains what
    // this test checks — only the frequency reference does. A large
    // real weekly requirement (never exhausted after one exposure) lets
    // the day-construction loop actually reach every real day this run
    // considers, rather than stopping early once the first exposure
    // consumes the whole weekly total.
    //
    // Coaching Depth Batch 2 wires obliques' own curated preferred
    // frequency (Batch 1: 4/week) into this reference, so its expected
    // exposure interval is now only 1 day (floor(7/4)) — this test's
    // day spacing is scaled accordingly (5 consecutive real training
    // days, not 3 spread across a week) to keep exercising the same
    // real mechanism: minimum spacing alone would allow every one of
    // these 5 days, but the separate rolling-window frequency gate must
    // still block the 5th once 4 real exposures already sit inside the
    // trailing 7-day window.
    const developmentReference = getDevelopmentReference('physique_target', 'obliques', 'efficient');
    expect(developmentReference.sessions_per_week_reference).toBe(4);
    const sessionCap = developmentReference.direct_sets_per_exposure!;

    const target = normalDevTarget('obliques', { current_weekly_primary_sets: sessionCap * 5, weekly_exposure_units: sessionCap * 5 });
    // Monday-Friday, each 1 day apart — every gap individually satisfies
    // obliques' own 1-day expected interval, so minimum spacing ALONE
    // would permit all five. The separate maximum-frequency gate must
    // still block the fifth.
    const plan = buildWeeklyProgrammingPlan(
      weeklyInput({ available_training_days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], targets: [target] })
    );

    const byDate = new Map(plan.sessions.map((s) => [s.date, s.plannedWork.filter((w) => w.target_id === 'obliques')]));
    const monday = byDate.get('2026-08-31') ?? [];
    const tuesday = byDate.get('2026-09-01') ?? [];
    const wednesday = byDate.get('2026-09-02') ?? [];
    const thursday = byDate.get('2026-09-03') ?? [];
    const friday = byDate.get('2026-09-04') ?? [];

    expect(monday.length).toBeGreaterThan(0);
    expect(tuesday.length).toBeGreaterThan(0);
    expect(wednesday.length).toBeGreaterThan(0);
    expect(thursday.length).toBeGreaterThan(0);
    // The core requirement: the fifth real day gets nothing, even though
    // its own minimum-spacing check (1 day since Thursday) would pass.
    expect(friday.length).toBe(0);

    // Abs Session Exercise Share Cap (2026-09-19): on a non-legs day,
    // obliques' own exercises are capped at ABS_SESSION_EXERCISE_SHARE_MAX
    // (2), so a real single exposure now delivers less than sessionCap
    // (the raw, uncapped Blueprint per-exposure reference) on push/pull/
    // upper days — but NOT on a legs day, which has its own separate,
    // uncapped abs handling. Monday(push)/Tuesday(pull)/Thursday(upper)
    // are all non-legs and must match each other; Wednesday(legs) is
    // deliberately excluded from that comparison since it's genuinely
    // allowed to differ. Verified against the real Monday exposure
    // itself rather than hardcoded, so this stays correct regardless of
    // exactly how many sets those 2 exercises carry.
    const mondaySets = monday.reduce((sum, e) => sum + e.sets, 0);
    expect(mondaySets).toBeLessThan(sessionCap); // confirms the abs cap, not Blueprint's own reference, is now binding here on this non-legs day
    for (const day of [tuesday, thursday]) {
      expect(day.reduce((sum, e) => sum + e.sets, 0)).toBe(mondaySets);
    }

    const allocation = plan.targetAllocations.find((a) => a.target_id === 'obliques')!;
    // Exactly the sum of the four real exposures delivered (Monday-
    // Thursday; Wednesday's own legs-day amount included as-is, since
    // it's genuinely allowed to differ from the other three), never a
    // fifth crammed in — and never silently written off as "unmet"
    // either, since the target simply isn't due yet for it.
    const wednesdaySets = wednesday.reduce((sum, e) => sum + e.sets, 0);
    expect(allocation.deliveredDirectSets).toBe(mondaySets * 3 + wednesdaySets);
  });
});

describe('Post-v2 Corrective Fix v2 §24.B — one real compatible session per calendar week, across several real weeks, never cramming or debt', () => {
  it('week 1 Thursday, week 2 Thursday, week 3 Thursday (only Thursday ever available) each deliver exactly one honest exposure, never doubled and never carrying debt forward', () => {
    let lastExposureDate: string | null = null;
    let history: string[] = [];
    const thursdays = ['2026-09-03', '2026-09-10', '2026-09-17']; // three real, separate calendar weeks
    // Abs Session Exercise Share Cap (2026-09-19): the real per-exposure
    // delivered amount is now capped by ABS_SESSION_EXERCISE_SHARE_MAX
    // (2 exercises), not Blueprint's own raw per-exposure reference —
    // captured from week 1's own real result below rather than hardcoded,
    // so this test verifies what actually matters here (every week
    // delivers the SAME honest amount, never doubled, never debt-
    // inflated) without depending on the cap's exact numeric effect.
    let referenceSets: number | null = null;

    for (const date of thursdays) {
      const result = buildWorkout({
        date,
        weekday: 'thursday',
        budget_minutes: 300,
        available_equipment: FULL_EQUIPMENT,
        available_training_days: ['thursday'],
        targets: [normalDevTarget('obliques', { last_trained_date: lastExposureDate, recent_direct_exposure_dates: history })],
      });
      const placed = result.exercises.filter((e) => e.target_id === 'obliques');
      expect(placed.length).toBeGreaterThan(0);
      const totalSets = placed.reduce((sum, e) => sum + e.target_sets, 0);
      // Exactly one exposure's worth every single real week — never
      // doubled to "make up" for the other 6 days having no compatible
      // session, and never a debt-inflated amount.
      if (referenceSets === null) {
        referenceSets = totalSets;
      } else {
        expect(totalSets).toBe(referenceSets);
      }
      lastExposureDate = date;
      history = [...history, date];
    }
  });
});

describe('Post-v2 Corrective Fix v2 §24.C — a real exposure near a calendar-week boundary remains real history the very next day', () => {
  it('an exposure on the last day of one calendar week (Sunday) is correctly read as real, recent history when generating the very next calendar day (Monday of the new week) — never treated as "never trained"', () => {
    const result = buildWorkout({
      date: '2026-08-31', // Monday — the day immediately after the Sunday exposure below
      weekday: 'monday',
      budget_minutes: 300,
      available_equipment: FULL_EQUIPMENT,
      available_training_days: ['monday'],
      // 'mid-pec', not 'obliques' — obliques' own curated preferred
      // frequency (Coaching Depth Batch 1/2: 4/week) now gives it a
      // 1-day expected interval, which would make it correctly DUE
      // after 1 day (not the "not yet due" case this test needs).
      // mid-pec is unprofiled, keeping the original 2/week (3-day
      // interval) this scenario is built around.
      targets: [normalDevTarget('mid-pec', { last_trained_date: '2026-08-30', recent_direct_exposure_dates: ['2026-08-30'], days_since_target_last_trained: 1 })],
    });
    // Correctly NOT due (only 1 real day since Sunday's exposure) — the
    // real invariant this test protects is WHY: the engine must cite the
    // real Sunday date and a real 1-day gap, never null/"never trained,"
    // which is what a calendar-boundary reset bug would produce instead.
    const skip = result.skipped_targets.find((s) => s.target_id === 'mid-pec');
    expect(skip).toBeDefined();
    expect(skip!.reason_code).toBe('not_current_exposure');
    const exposureDecision = skip!.decision.exposure_decision;
    expect(exposureDecision?.last_exposure_date).toBe('2026-08-30');
    expect(exposureDecision?.days_since_last_exposure).toBe(1);
  });
});

describe("Post-v2 Corrective Fix v2 §24.L — a shared Blueprint package's aggregate is never duplicated as every covered target's own complete objective", () => {
  it('three chest sub-targets (upper-pec/mid-pec/lower-pec) sharing the same "chest-efficient" package never together deliver more than that package\'s own real weekly aggregate', () => {
    const packageRef = getDevelopmentReference('physique_target', 'mid-pec', 'efficient');
    expect(packageRef.package_id).toBe('chest-efficient');
    const targetIds = ['upper-pec', 'mid-pec', 'lower-pec'];

    const plan = buildWeeklyProgrammingPlan(
      weeklyInput({
        available_training_days: ['monday', 'tuesday', 'thursday', 'friday'],
        targets: targetIds.map((id, i) => normalDevTarget(id, { goal_priority: 1000 + i })),
      })
    );

    const totalDelivered = targetIds.reduce((sum, id) => sum + (plan.targetAllocations.find((a) => a.target_id === id)?.deliveredDirectSets ?? 0), 0);
    // The core invariant: three sibling targets sharing one package never
    // combine to exceed that package's own real weekly reference — never
    // 3x (or even 2x) the package's own intended total, which is exactly
    // what independently duplicating the full aggregate to each target
    // would produce.
    expect(totalDelivered).toBeLessThanOrEqual(packageRef.weekly_direct_set_reference!);
    expect(totalDelivered).toBeGreaterThan(0);

    // At least one sibling is honestly reported as covered by its
    // package-mates' own work, rather than silently receiving nothing
    // with no explanation, or being mislabeled a data-integrity gap.
    const packageSharingSkips = plan.sessions.flatMap((s) => s.skipped).filter((s) => targetIds.includes(s.target_id) && s.reason_code === 'adequately_covered');
    expect(packageSharingSkips.length).toBeGreaterThan(0);
    for (const skip of packageSharingSkips) {
      expect(skip.reason).toContain('chest-efficient');
      expect(skip.scope).toBe('exposure');
    }
  });

  it('a target with genuinely maintained real volume above its own package reference is never suppressed by the package-sharing cap when it has no active sibling this run', () => {
    // §11/§13: the package-sharing fix must never become a backdoor
    // ceiling on a target's own real, already-maintained volume — only
    // on the RECOMMENDED starting figure multiple simultaneously-
    // untrained siblings would otherwise each independently adopt.
    const developmentReference = getDevelopmentReference('physique_target', 'triceps', 'efficient');
    const sessionCap = developmentReference.direct_sets_per_exposure!;
    const target = normalDevTarget('triceps', { current_weekly_primary_sets: sessionCap * 3, weekly_exposure_units: sessionCap * 3 });
    const plan = buildWeeklyProgrammingPlan(weeklyInput({ available_training_days: ['monday', 'tuesday', 'thursday', 'friday'], targets: [target] }));
    const allocation = plan.targetAllocations.find((a) => a.target_id === 'triceps')!;
    // requiredDirectSets must still reflect the target's own real
    // maintained figure (sessionCap * 3), never silently capped down to
    // the package's own smaller baseline weekly reference.
    expect(allocation.requiredDirectSets).toBe(sessionCap * 3);
  });
});
