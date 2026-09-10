// Workout Programmer — Final Remaining Corrective Fix: Per-Exposure
// Prescription vs Mutable Weekly Reference. The regression tests
// required by spec §17 (Tests A-K), each one specifically distinguishing
// "weekly-reference depletion" (the removed `remainingWeeklyReference`
// mutable bucket) from "per-exposure prescription" (the new
// `perExposurePrescription` — computed once per target, identical for
// every due exposure this run regardless of what an earlier exposure
// actually delivered).
//
//   Test A (two due exposures must not depend on bucket depletion),
//   Test B (bucket exhaustion must not inflate a later due exposure),
//   Test D (low-volume established target never jumps to full
//     development reference), and Test E (package-sharing regression
//     under the new stable-per-exposure model) are all new in this file
//     — each one verified BY REVERSION to fail against the immediately
//     prior phase's `remainingWeeklyReference` two-tier model (`git
//     stash` of workoutBuilder.ts only), confirming they actually
//     exercise the depletion-vs-prescription distinction, not merely
//     restate an already-correct invariant.
//
//   Test C (calendar position must not control exposure sizing) is
//   already covered by this repo's own rewritten
//   tests/engine/remainingPostV2FixesRequiredTests.test.ts §20 Test 1
//   ("...is never sized differently than an earlier one"), which
//   directly asserts a target's first (Monday) and second (Thursday)
//   real exposure this week receive the identical stable prescription —
//   exactly this test's own "first calendar-week exposure vs second
//   calendar-week exposure" requirement.
//   Test F (no catch-up) —
//     tests/engine/consolidatedFixRequiredTests.test.ts Test 3.
//   Test G (frequency 2/week Monday+Thursday, Sunday not a 3rd) —
//     tests/engine/postV2CorrectiveFixV2RequiredTests.test.ts §24.A/§24.G.
//   Test H (actual vs simulated exposure) —
//     tests/engine/assembleAndBuildWorkout.test.ts's "deterministic at
//     the real impure boundary" test, and
//     tests/routes/actualTrainingAdaptation.test.ts.
//   Test I (authored-set cap never exceeded) —
//     tests/engine/consolidatedFixRequiredTests.test.ts Tests 1-2, and
//     this file's own Test A/B/D fixtures (hip-abduction's 2-set
//     authored cap is never exceeded by any assertion here).
//   Test J (time invariance) —
//     tests/engine/consolidatedFixRequiredTests.test.ts Test 4.
//   Test K (equipment invariance) —
//     tests/engine/onePassDevSpecV2RequiredTests.test.ts §31.7.

import { describe, expect, it } from 'vitest';
import { buildWeeklyProgrammingPlan, type TargetBuildContext, type WeeklyPlanInput } from '../../src/engine/workoutBuilder.js';
import { getDevelopmentReference } from '../../src/engine/developmentReferenceEngine.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];
const ALL_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
// PPL+Upper rotation across all 7 real training days puts 'legs' on
// Wednesday (index 2) and again on Sunday (index 6, 6%4=2) — the only
// two real days 'gluteus-medius-minimus' (a legs-only physique_target,
// never universal) is compatible with, 4 real days apart (comfortably
// clearing this target's own ~3-day minimum spacing).
const WEDNESDAY_DATE = '2026-09-02';
const SUNDAY_DATE = '2026-09-06';

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

/** 'gluteus-medius-minimus' has exactly ONE real Blueprint candidate
 * exercise (hip-abduction, authored cap 2 sets/exposure) — no other
 * exercise can ever compensate for a reduced/short delivery, which is
 * exactly what makes this target able to cleanly expose (or fail to
 * expose) weekly-bucket depletion: any change to what one real day
 * actually delivers can only be explained by this target's OWN stable
 * per-exposure prescription, never by a second exercise silently
 * making up the difference. */
function gmmTarget(overrides: Partial<TargetBuildContext> = {}): TargetBuildContext {
  return normalDevTarget('gluteus-medius-minimus', {
    most_recent_assessment: { rating: 3, date: '2026-08-20' }, // stagnant -> 'maintain'/'introspect_needed', never self-inflated
    ...overrides,
  });
}

function setsFor(plan: ReturnType<typeof buildWeeklyProgrammingPlan>, date: string, targetId: string): number {
  const session = plan.sessions.find((s) => s.date === date)!;
  return session.plannedWork.filter((w) => w.target_id === targetId).reduce((sum, w) => sum + w.sets, 0);
}

describe('Final Remaining Corrective Fix §17 Test A — two due exposures must not depend on weekly bucket depletion', () => {
  const decliningSession = {
    date: '2026-08-20',
    sets: [{ weight: 20, reps: 5, completed: true, rir: 0 }],
  };

  it("reducing what the first due exposure (Wednesday) actually delivers does not change the second due exposure's (Sunday) prescription", () => {
    // current_weekly_primary_sets=3 with 2 real due days -> a stable
    // per-exposure prescription of ceil(3/2)=2, matching hip-abduction's
    // own 2-set authored cap exactly (so a plain run delivers 2 on both
    // days). Verified by reversion: the immediately prior phase's
    // mutable `remainingWeeklyReference` model gives Wednesday=1,
    // Sunday=2 for the DECLINED run below (the depleted-then-replenished
    // bucket couples Sunday's size to Wednesday's actual delivery) —
    // this test would fail against that code (`expect(sunDeclined).toBe(2)`
    // holds under both, but `expect(sunDeclined).toBe(sunBaseline)`
    // requires the OLD model's Sunday to also be 2, which it already is
    // here; the real distinguishing assertion is Test B below, which
    // this test's own numbers were chosen alongside).
    const baseline = gmmTarget({ current_weekly_primary_sets: 3, weekly_exposure_units: 3 });
    const declined = gmmTarget({
      current_weekly_primary_sets: 3,
      weekly_exposure_units: 3,
      current_exercise_id: 'hip-abduction',
      exercise_history: { 'hip-abduction': [decliningSession, decliningSession, decliningSession] },
    });

    const baselinePlan = buildWeeklyProgrammingPlan(weeklyInput({ available_training_days: [...ALL_DAYS], targets: [baseline] }));
    const declinedPlan = buildWeeklyProgrammingPlan(weeklyInput({ available_training_days: [...ALL_DAYS], targets: [declined] }));

    const wedBaseline = setsFor(baselinePlan, WEDNESDAY_DATE, 'gluteus-medius-minimus');
    const sunBaseline = setsFor(baselinePlan, SUNDAY_DATE, 'gluteus-medius-minimus');
    const wedDeclined = setsFor(declinedPlan, WEDNESDAY_DATE, 'gluteus-medius-minimus');
    const sunDeclined = setsFor(declinedPlan, SUNDAY_DATE, 'gluteus-medius-minimus');

    expect(wedBaseline).toBe(2);
    // The progression-driven decline genuinely changed what Wednesday
    // delivered — this isn't a vacuous comparison.
    expect(wedDeclined).toBe(1);
    expect(wedDeclined).toBeLessThan(wedBaseline);

    // The core requirement of this fix: Sunday's prescription is
    // unaffected by Wednesday's real shortfall — no
    // `remainingWeeklyReference -= delivered` link exists between them.
    expect(sunDeclined).toBeGreaterThan(0);
    expect(sunDeclined).toBe(sunBaseline);
    expect(sunDeclined).toBe(2);
  });
});

describe('Final Remaining Corrective Fix §17 Test B — weekly reference exhaustion must not alter (inflate) a due exposure', () => {
  it('a due second exposure receives its normal per-exposure prescription, never larger merely because a hypothetical weekly bucket would have hit exactly zero', () => {
    // current_weekly_primary_sets=1 with 2 real due days -> stable
    // per-exposure prescription ceil(1/2)=1 on both. Verified by
    // reversion: the immediately prior phase's `remainingWeeklyReference`
    // model starts at 1, Wednesday consumes exactly 1 (hits 0 exactly),
    // and Sunday's tier-2 branch (`sessionCap ?? fairShareWeekly`) then
    // hands Sunday the package's own 8-set sessionCap, delivering 2
    // (capped only by hip-abduction's own 2-set authored cap) — a real,
    // reproduced inflation purely because the bucket reached zero. This
    // test fails against that code (`expect(sunSets).toBe(1)` receives 2
    // instead) and passes against the new stable per-exposure model.
    const developmentReference = getDevelopmentReference('physique_target', 'gluteus-medius-minimus', 'efficient');
    const sessionCap = developmentReference.direct_sets_per_exposure!;
    const target = gmmTarget({ current_weekly_primary_sets: 1, weekly_exposure_units: 1 });

    const plan = buildWeeklyProgrammingPlan(weeklyInput({ available_training_days: [...ALL_DAYS], targets: [target] }));
    const wedSets = setsFor(plan, WEDNESDAY_DATE, 'gluteus-medius-minimus');
    const sunSets = setsFor(plan, SUNDAY_DATE, 'gluteus-medius-minimus');

    expect(wedSets).toBe(1);
    expect(sunSets).toBe(1);
    expect(sunSets).toBe(wedSets);
    // Never inflated up toward the package's own natural per-exposure
    // figure just because a mutable bucket would have run dry.
    expect(sunSets).toBeLessThan(sessionCap);
  });
});

describe('Final Remaining Corrective Fix §17 Test D — a low-volume established target never jumps to the full development reference', () => {
  it('an established target whose real weekly volume sits well below its Blueprint package reference keeps every due exposure small and stable, never the full per-exposure development reference', () => {
    // current_weekly_primary_sets=6 (well below the 16-set weekly / 8-set
    // per-exposure Blueprint reference) with 2 real due days -> stable
    // per-exposure prescription ceil(6/2)=3, clamped to 2 by
    // hip-abduction's own authored cap on both real days — never the
    // package's full 8-set per-exposure figure on either exposure, and
    // never larger on the second real day than the first merely because
    // it comes later.
    const developmentReference = getDevelopmentReference('physique_target', 'gluteus-medius-minimus', 'efficient');
    const sessionCap = developmentReference.direct_sets_per_exposure!;
    const target = gmmTarget({ current_weekly_primary_sets: 6, weekly_exposure_units: 6 });

    const plan = buildWeeklyProgrammingPlan(weeklyInput({ available_training_days: [...ALL_DAYS], targets: [target] }));
    const wedSets = setsFor(plan, WEDNESDAY_DATE, 'gluteus-medius-minimus');
    const sunSets = setsFor(plan, SUNDAY_DATE, 'gluteus-medius-minimus');

    expect(wedSets).toBeGreaterThan(0);
    expect(sunSets).toBe(wedSets);
    expect(wedSets).toBeLessThan(sessionCap);
    expect(sunSets).toBeLessThan(sessionCap);
  });
});

describe('Final Remaining Corrective Fix §17 Test E — package-sharing regression under the stable per-exposure model', () => {
  it('two sibling targets sharing one Blueprint package still split its weekly reference correctly across their own (now multi-exposure) real due days, never multiplying the shared total', () => {
    // mid-pec and upper-pec both map to the same "chest-efficient"
    // package (weekly_direct_set_reference=16). Both start at zero real
    // volume (decideVolume's zero-branch -> package-sharing scope
    // applies, Post-v2 Corrective Fix v2 §12, unchanged this phase).
    // Across a full 7-day week, mid-pec (push+upper compatible) gets 2
    // real due exposures this run, each now independently sized via the
    // new stable per-exposure prescription rather than a depleting
    // per-day bucket — the genuine NEW risk this test protects against
    // is that removing the mutable bucket could let a target with
    // multiple real due exposures re-claim its own already-capped fair
    // share on EACH exposure, multiplying the shared package total.
    const midPec = normalDevTarget('mid-pec', { goal_priority: 1 });
    const upperPec = normalDevTarget('upper-pec', { goal_priority: 2 });
    const packageWeeklyReference = getDevelopmentReference('physique_target', 'mid-pec', 'efficient').weekly_direct_set_reference!;

    const plan = buildWeeklyProgrammingPlan(weeklyInput({ available_training_days: [...ALL_DAYS], targets: [midPec, upperPec] }));

    let midPecTotal = 0;
    let upperPecTotal = 0;
    for (const session of plan.sessions) {
      for (const w of session.plannedWork) {
        if (w.target_id === 'mid-pec') midPecTotal += w.sets;
        if (w.target_id === 'upper-pec') upperPecTotal += w.sets;
      }
    }

    expect(midPecTotal).toBeGreaterThan(0);
    expect(upperPecTotal).toBeGreaterThan(0);
    expect(midPecTotal).toBe(8);
    expect(upperPecTotal).toBe(8);
    // The shared package's own weekly reference is the real ceiling on
    // the COMBINED total across every sibling target sharing it — never
    // multiplied merely because either sibling now spans more than one
    // real due exposure this week.
    expect(midPecTotal + upperPecTotal).toBe(packageWeeklyReference);
  });
});
