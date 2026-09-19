// Central configuration for the deterministic Training Engine — spec §22:
// "These must be configurable values, not scattered magic numbers."
//
// Two categories live here, and this file marks the difference for every
// value:
//
//   [SPEC]      — an exact value the spec itself mandates. Never change
//                 these without a new spec/decision from Charan; they are
//                 not this app's judgment call.
//   [DEFAULT]   — an operational default this app had to pick because the
//                 spec asks for "a configured value" / "a recommended
//                 cadence" / "small increments" without naming an exact
//                 number. Reasonable, clearly labeled, easy to change —
//                 not a claim of methodology precision.
//
// No engine module should hard-code a number that belongs here.

import type { Weekday } from '../contracts/types.js';

/** [SPEC] §7: primary muscle role = 1.00 exposure unit/set, secondary =
 * 0.33. Exact values mandated by the spec's worked example
 * (bench press, 4 sets -> chest 4.00, triceps 1.32, front delts 1.32). */
export const EXPOSURE_COEFFICIENTS = {
  primary: 1.0,
  secondary: 0.33,
} as const;

/** [SPEC] §1.2: max 2 simultaneous active aesthetic growth goals in V1. */
export const MAX_ACTIVE_AESTHETIC_GOALS = 2;

/** [SPEC] §3: dated user assessment scale, 1 (significantly worse) to 5
 * (significantly improved). */
export const ASSESSMENT_SCALE = {
  min: 1,
  max: 5,
  labels: {
    1: 'significantly worse',
    2: 'slightly worse',
    3: 'no meaningful change',
    4: 'improved',
    5: 'significantly improved',
  },
} as const;

/** [DEFAULT] §3: "the system recommends a goal-specific cadence." Spec
 * does not name exact day counts. Aesthetic outcomes are explicitly
 * warned not to react to "a single noisy observation," so the aesthetic
 * default is longer than the functional one (functional/performance
 * "can be evaluated every session," so its recommended check-in cadence
 * is shorter). Both are just the *recommended* starting point — the user
 * can always modify it (§3, §2.1 step 5). */
export const REVIEW_CADENCE_DEFAULT_DAYS = {
  aesthetic: 28,
  functional: 14,
} as const;

/** [DEFAULT] §10: "use small configured increments. Never jump directly
 * to Blueprint maximum." No exact increment size is specified. A small,
 * common, easily-adjusted default. */
export const PROGRESSION_INCREMENTS = {
  loadKg: 2.5,
  reps: 1,
  /** [DEFAULT] §9-10: how many exposure_units/week to add when a
   * justified increase is warranted — small step, not a jump toward
   * Blueprint's upper range. */
  weeklyExposureUnits: 2,
} as const;

/** [DEFAULT] §12: "deload when deterministic criteria support it." No
 * exact thresholds given. Conservative, explicit numbers — a reviewer
 * can tune these without touching engine logic. */
export const RECOVERY_THRESHOLDS = {
  /** Consecutive sessions of declining performance on the same exercise
   * before a deload/modification becomes a live candidate (still gated
   * by the full §12 introspection checklist — this is a necessary, not
   * sufficient, condition). */
  consecutiveDecliningSessions: 3,
  /** A target's rolling-window exposure this many times its weekly
   * average counts as "recent high exposure" for recovery purposes. */
  recentHighExposureMultiplier: 1.5,
} as const;

/** [DEFAULT] Session Realism Cap — Programming Advisor Fix (2026-09-14),
 * revised (2026-09-14, muscle cap raised 4 -> 7 after the pre-deployment
 * validation report found the 4-muscle cap could starve a legitimate
 * top-priority muscle purely on exercise-slot exhaustion, e.g. on an
 * Upper day where up to 18 real targets are eligible at once): an
 * explicit, user-requested override of the Consolidated Fix's own
 * "session size is never limited" default — deliberately, and only for
 * raw exercise/muscle COUNT, never for time or equipment (those remain
 * fully unrestricted, per Consolidated Fix §7/§8, unchanged). A real
 * session must never exceed these two limits, regardless of how much
 * real weekly volume remains to place — any volume that doesn't fit is
 * genuinely deferred (it becomes real `unmetDirectSets`, picked up by
 * the next real exposure this week if one exists, or by the Cross-Week
 * Programming Intelligence Fix's own carryover into next week — never
 * silently dropped, and never crammed in regardless). Applied by
 * `workoutBuilder.ts` for deterministic generation, and enforced as a
 * validation ceiling on AI output by `programmerAdequacyValidator.ts`/
 * `weekReconciliationDomainValidator.ts` — the same two numbers, one
 * source of truth. Raised 7/9 -> 8/10 (2026-09-19), explicit user
 * request: the original 7/9 was set without accounting for
 * `UNIVERSAL_PHYSIQUE_TARGETS` (abs) always being part of
 * expectedCoverageTargetIds on every session purpose — see
 * `ABS_SESSION_EXERCISE_SHARE_MAX`'s own doc comment for the matching
 * abs-specific exercise sub-cap this raise was paired with. */
export const SESSION_REALISM_CAP = {
  maxTargetsPerSession: 8,
  maxExercisesPerSession: 10,
} as const;

/** [DEFAULT] (2026-09-19) On a non-legs session, abs (obliques/
 * rectus-abdominis — see `ABS_PHYSIQUE_TARGETS`) exercises are capped at
 * this many of the session's total exercise budget, regardless of how
 * many abs targets are present — the same "leave real room for the
 * session's actual focus" intent `LEGS_WITH_ABS_SESSION_MAX_EXERCISES`
 * already applies to leg day, mirrored here for every other purpose.
 * Leg day keeps its own existing abs handling
 * (`LEGS_WITH_ABS_SESSION_MAX_EXERCISES`) unchanged — this constant only
 * applies via `sessionRealismCapFor`'s non-legs branch. */
export const ABS_SESSION_EXERCISE_SHARE_MAX = 2;

/** [DEFAULT] Legs-Session Exercise Cap (2026-09-16, tightened
 * 2026-09-19), explicit user request: a leg session's own ceilings are
 * tighter than the general SESSION_REALISM_CAP — both the muscle-count
 * ceiling (5, not 7) and the exercise-count ceiling (5, not 9). Abs
 * (`ABS_PHYSIQUE_TARGETS`) is the only muscle group that pairs with legs
 * (it is universal, already eligible on every session purpose — this is
 * not a new pairing concept, just a leg-day exercise-count exception for
 * when it happens to show up there): when abs work is present alongside
 * legs, the day's total exercise ceiling rises to
 * `LEGS_WITH_ABS_SESSION_MAX_EXERCISES` (8), but leg work itself stays
 * capped at `LEGS_SESSION_MAX_EXERCISES` (5) within that total — the
 * extra room is for abs, never for more leg exercises. Applied
 * everywhere `SESSION_REALISM_CAP` itself is via `sessionRealismCapFor`
 * below: `workoutBuilder.ts` for deterministic generation, and as a
 * validation ceiling on AI output by `programmerAdequacyValidator.ts`/
 * `weekReconciliationDomainValidator.ts` — one source of truth, never
 * four independently-drifting copies of these numbers. Every OTHER
 * session purpose (push/pull/upper) keeps the general 7-target/
 * 9-exercise cap unchanged. */
export const LEGS_SESSION_MAX_TARGETS = 5;
export const LEGS_SESSION_MAX_EXERCISES = 5;
export const LEGS_WITH_ABS_SESSION_MAX_EXERCISES = 8;

/** [DEFAULT] Abs (obliques + rectus-abdominis) — now identical to
 * `UNIVERSAL_PHYSIQUE_TARGETS` (defined below) since neck-thickness was
 * removed from it, but kept as its own named constant (not a re-export)
 * since the two lists mean different things — `sessionRealismCapFor`'s
 * leg+abs and abs-exercise-share checks are specifically about abs, and
 * should keep working unchanged if UNIVERSAL_PHYSIQUE_TARGETS ever grows
 * a genuinely different universal target again. */
export const ABS_PHYSIQUE_TARGETS: readonly string[] = ['obliques', 'rectus-abdominis'];

/** The ONE place every caller (deterministic generation AND both AI
 * output validators) decides this session's real target/exercise
 * ceilings — see LEGS_SESSION_MAX_EXERCISES's own doc comment for the
 * full leg+abs rule. `targetIdsInSession` is every distinct target
 * actually receiving dedicated work in the session being checked (not
 * the eligible/candidate list) — the abs-presence check only fires once
 * abs is genuinely part of THIS session, never merely eligible. */
export function sessionRealismCapFor(
  sessionPurpose: SessionPurpose | null,
  targetIdsInSession: readonly string[]
): { maxTargets: number; maxExercises: number; legExerciseShareMax: number | null; absExerciseShareMax: number | null } {
  if (sessionPurpose !== 'legs') {
    return {
      maxTargets: SESSION_REALISM_CAP.maxTargetsPerSession,
      maxExercises: SESSION_REALISM_CAP.maxExercisesPerSession,
      legExerciseShareMax: null,
      absExerciseShareMax: ABS_SESSION_EXERCISE_SHARE_MAX,
    };
  }
  const hasAbs = targetIdsInSession.some((id) => ABS_PHYSIQUE_TARGETS.includes(id));
  return {
    maxTargets: LEGS_SESSION_MAX_TARGETS,
    maxExercises: hasAbs ? LEGS_WITH_ABS_SESSION_MAX_EXERCISES : LEGS_SESSION_MAX_EXERCISES,
    legExerciseShareMax: LEGS_SESSION_MAX_EXERCISES,
    absExerciseShareMax: null, // leg day's own abs room is already governed by maxExercises/legExerciseShareMax above
  };
}

/** [SPEC] §16: default weekly schedule. Explicitly documented as
 * shiftable (Wednesday's rest may move to Tuesday/Thursday; Saturday or
 * Sunday may become rest) — this is a seed default for a new
 * TrainingProfile, never a hard-coded runtime assumption. The one hard
 * rule (Monday never lower-body) is enforced separately as a constraint
 * check (src/engine/constraintEngine.ts), not by baking a body-part plan
 * into this default. */
export const DEFAULT_WEEKLY_SCHEDULE: Record<Weekday, 'gym' | 'badminton' | 'rest'> = {
  monday: 'gym',
  tuesday: 'gym',
  wednesday: 'rest',
  thursday: 'gym',
  friday: 'gym',
  saturday: 'badminton',
  sunday: 'badminton',
};

/** [DEFAULT] Blueprint's own physique-target `parent_region` values
 * (verified against src/blueprint/snapshot/programming.json) this app
 * classifies as "lower body" for spec §16's Monday rule. Blueprint has
 * no native upper/lower tag of its own — this is a small, exhaustive,
 * uncontroversial grouping of its existing region vocabulary (quads,
 * hamstrings, calves, hips), not an invented anatomical model. `core`,
 * `forearms`, and `neck` are deliberately excluded (neither clearly
 * upper nor lower). See src/engine/constraintEngine.ts's
 * isBodyFocusAllowedOnDay. */
export const LOWER_BODY_PHYSIQUE_REGIONS: readonly string[] = ['quads', 'hamstrings', 'calves', 'hips'];

/** [SPEC] §16: "Monday must never be generated as a lower-body day."
 * Hard constraint, checked deterministically — see
 * constraintEngine.isBodyFocusAllowedOnDay, which resolves a
 * physique_target's parent_region against LOWER_BODY_PHYSIQUE_REGIONS
 * rather than matching against this list's labels directly. */
export const FORBIDDEN_BODY_FOCUS_BY_DAY: Partial<Record<Weekday, readonly string[]>> = {
  monday: LOWER_BODY_PHYSIQUE_REGIONS,
};

/** [SPEC] Final Programming-Engine Pass §5: "The current training
 * structure is PPL + Upper. The planner must understand the purpose of
 * the four gym sessions relative to each other." Blueprint has no
 * session-purpose taxonomy of its own (docs already note
 * TrainingProfile.preferred_split is deliberately a free string, e.g.
 * "push-pull-legs" — this app doesn't invent a closed enum there
 * either) — this is the one place that operationalizes the specific
 * split this user already runs into Blueprint's own physique_target
 * vocabulary, at target-id granularity (not the coarser parent_region
 * LOWER_BODY_PHYSIQUE_REGIONS uses above) because "arms" alone can't
 * distinguish a push muscle (triceps) from a pull muscle (biceps).
 * See src/engine/sessionPurpose.ts for how these are actually assigned
 * to specific weekdays. */
export type SessionPurpose = 'push' | 'pull' | 'legs' | 'upper';

/** [SPEC] The exact rotation order §5's PPL+Upper structure implies —
 * push, then pull, then legs, then upper — applied to the user's
 * actual ordered gym days by src/engine/sessionPurpose.ts. A rotation
 * order is a scheduling convention, not a target-priority weight (spec
 * §7's prohibition is about which MUSCLE gets resources first, never
 * about the well-known, standard order a 4-day PPL+Upper split itself
 * runs in). */
export const SESSION_PURPOSE_ROTATION: readonly SessionPurpose[] = ['push', 'pull', 'legs', 'upper'];

/** [DEFAULT] Blueprint physique_target ids (verified against
 * src/blueprint/snapshot/programming.json's physiqueTargets list) a
 * standard Push session trains: chest, front/side delts (the
 * push-dominant shoulder heads — rear-delt is pull), and triceps. */
export const PUSH_PHYSIQUE_TARGETS: readonly string[] = ['upper-pec', 'mid-pec', 'lower-pec', 'front-delt', 'side-delt', 'triceps', 'triceps-long-head'];

/** [DEFAULT] A standard Pull session trains: back, rear-delt, biceps,
 * and forearms (grip work is conventionally paired with pulling). */
export const PULL_PHYSIQUE_TARGETS: readonly string[] = [
  'lat-width',
  'back-thickness',
  'upper-traps',
  'rear-delt',
  'biceps',
  'brachialis-arm-thickness',
  'forearm-flexors',
  'forearm-extensors',
];

/** [DEFAULT] A standard Legs session — every LOWER_BODY_PHYSIQUE_REGIONS
 * region resolved down to its own target ids, plus the glutes (Blueprint
 * groups them under `hips`, alongside adductors). Deliberately the same
 * "lower body" concept the Monday rule already uses, at target
 * granularity. */
export const LEGS_PHYSIQUE_TARGETS: readonly string[] = ['quads', 'hamstrings', 'gluteus-maximus', 'gluteus-medius-minimus', 'adductors', 'gastrocnemius', 'soleus'];

/** [DEFAULT] Upper is the 4th PPL+Upper day: a genuine second upper-body
 * session, not a distinct muscle set of its own — compatible with every
 * target Push or Pull already trains, since that's literally what
 * "upper body" means in this split. Computed as a union, never
 * duplicated by hand, so PUSH/PULL and UPPER can never silently drift
 * apart. */
export const UPPER_PHYSIQUE_TARGETS: readonly string[] = [...PUSH_PHYSIQUE_TARGETS, ...PULL_PHYSIQUE_TARGETS];

/** [DEFAULT] Targets with no clear push/pull/legs identity (abs) —
 * commonly trained on any session in real programs, so compatible with
 * every session purpose rather than arbitrarily assigned to one.
 * neck-thickness removed (2026-09-19), explicit user request: never a
 * real training target for this user, and it added complexity (a third
 * universal target, on top of abs) with no real use. Blueprint's own
 * snapshot data still defines it — this only stops it from ever being
 * eligible in any session; nothing else references it. */
export const UNIVERSAL_PHYSIQUE_TARGETS: readonly string[] = ['obliques', 'rectus-abdominis'];

/** [DEFAULT] The full session-purpose -> compatible-target-id-list map
 * src/engine/sessionPurpose.ts's eligibility check reads. */
export const SESSION_PURPOSE_TARGETS: Record<SessionPurpose, readonly string[]> = {
  push: PUSH_PHYSIQUE_TARGETS,
  pull: PULL_PHYSIQUE_TARGETS,
  legs: LEGS_PHYSIQUE_TARGETS,
  upper: UPPER_PHYSIQUE_TARGETS,
};

/** [DEFAULT] §2.1: natural-language goal matching needs *some* minimum
 * similarity and result-count cap to avoid presenting noise as a
 * candidate. Not a training-methodology number — a text-matching
 * operational default, centralized here per spec §22 anyway rather than
 * left as a magic number inside the matcher. See
 * src/engine/goalCreation.ts. */
export const GOAL_MATCH = {
  /** Minimum Dice coefficient (2*|intersection| / (|A|+|B|) over
   * normalized word-token sets) for a Blueprint goal to be surfaced as a
   * candidate at all. */
  minScore: 0.2,
  /** Never show more than this many ranked candidates — confirmation
   * requires the user to read and pick, so the list must stay short. */
  maxCandidates: 5,
} as const;

/** [DEFAULT] §19 step 18/§6.2 needs *some* per-exercise minutes estimate
 * to fit a workout to a time budget at all — Blueprint has no per-set
 * duration data (only a coarse setup_time: DemandLevel label this app
 * doesn't yet have an approved way to turn into minutes either), so
 * this is a plain scheduling/logistics estimate, not a training-
 * methodology coefficient. Centralized here (never inline in
 * workoutBuilder) so it's a single, visible, easily-tuned number. See
 * src/engine/workoutBuilder.ts. */
export const TIME_ESTIMATION = {
  /** Time under tension + immediate transition for one working set. */
  secondsPerWorkingSet: 45,
  /** Rest between working sets of the same exercise. */
  restSecondsBetweenSets: 90,
  /** Fixed setup/equipment-transition overhead per exercise in a
   * session (added once per exercise, not per set). */
  setupMinutesPerExercise: 2,
} as const;

/** [DEFAULT] Coaching Depth Batch 3 spec §7: centralized, single-source
 * deload modifier — the ONLY place a deload's numeric reduction is
 * defined (never scattered literal multipliers across the planner). Set-
 * volume reduction is a fraction of the prescribed weekly sets; rep-range
 * bias reuses Batch 1's own `applyRepRangeBias('lower', ...)` rather than
 * inventing a second range-narrowing mechanism — a deload never invents a
 * rep number outside Blueprint's own authored range. */
/** [DEFAULT] Coaching Depth Batch 1's own original default (previously
 * duplicated as a local constant in foundationContext.ts) — the block
 * length used the first time a program's periodization state is ever
 * initialized, AND (Batch 3) the length the automatic calendar rollover
 * falls back to after a manually-declared whole-block deload
 * (`block_kind = 'deload'`) ends, since that block's own length was a
 * deliberate, transient choice that must never become the new normal
 * going forward (see programStateService.ts's `advanceToNextBlockIfDue`).
 * One shared constant, never two competing defaults. */
export const DEFAULT_PROGRAM_BLOCK_LENGTH_WEEKS = 4;

export const DELOAD_POLICY = {
  /** Fraction of the normal (non-deload) recommended weekly sets a deload
   * week keeps — e.g. 0.5 halves the working volume. */
  setVolumeMultiplier: 0.5,
  /** Reuses `MuscleProgrammingProfile['repRangeBias']` — a deload always
   * biases toward the low-fatigue end of Blueprint's own authored range. */
  repRangeBias: 'lower' as const,
  /** §10: a reactive deload cannot run indefinitely without a separate
   * explicit rule — this caps it. */
  maxReactiveDeloadDurationWeeks: 1,
} as const;

/** [DEFAULT] Coaching Depth Batch 3 spec §8-§10: the reactive-deload
 * trend evaluator's own tunable thresholds — one location, never
 * duplicated inline. None of these are training-methodology constants
 * from Blueprint; they are this app's own conservative, documented
 * operational defaults for "how much evidence is enough." */
export const REACTIVE_TRIGGER = {
  /** §8.2: how many real calendar days of history the evaluator looks
   * back over. */
  lookbackDays: 21,
  /** §9.2.1: minimum real completed exposures (across all evaluated
   * targets combined) in the lookback window before evaluation can even
   * run — below this, the evaluator reports insufficient data rather
   * than guessing. */
  minimumSessionsForEvaluation: 6,
  /** §8.3/§9.2.3: minimum number of DIFFERENT targets that must each
   * independently show a genuine decline signal — one target's decline
   * (let alone one session's) is never sufficient on its own. */
  minimumDecliningTargets: 2,
  /** §10: minimum real days after a reactive deload ends before
   * evaluation may trigger a new one — set once, at trigger time, as
   * `reactiveDeloadEndDate + cooldownDays`, never recomputed later. */
  cooldownDays: 14,
  /** §10: only re-run the (potentially expensive) evaluation once per
   * real calendar day — a plain re-read of the same day's context must
   * never re-evaluate or double-log. */
  minimumDaysBetweenEvaluations: 1,
} as const;

/** [DEFAULT] Coaching Depth Batch 4 spec §2/§5: exercise-rotation
 * thresholds — how much recent/family repetition counts against a
 * candidate, and how long "recent" means, before falling back (never
 * eliminating every candidate — see exerciseSelector.ts's own `narrow`
 * primitive) to whichever exercise best satisfies the target anyway. */
export const EXERCISE_ROTATION = {
  /** A target's own most recent exercise, if used this many CONSECUTIVE
   * real exposures in a row, is no longer protected by progression
   * continuity alone — rotation may consider an alternative even though
   * it's still the "current" pick. Counted from `exercise_history`'s
   * own most-recent-first list, never a separately stored counter. */
  maxConsecutiveUsesBeforeRotationConsidered: 6,
  /** How many of a target's most recent real exposures "recent-use"
   * penalization looks at — matches `recent_exercise_ids`'s own existing
   * window size convention (the caller already builds this list; this
   * constant documents its intended depth for a NEW caller). */
  recentUseWindowExposures: 4,
} as const;

/** [DEFAULT] Coaching Depth Batch 4 spec §3/§5: exercise-pairing
 * compatibility thresholds — centralized so no pairing branch invents
 * its own inline number. */
export const EXERCISE_PAIRING = {
  /** Two exercises may not be paired if both carry Blueprint's own
   * `fatigue_cost: 'high'` — spec §3's "fatigue overlap is acceptable"
   * gate, expressed with Blueprint's own existing DemandLevel labels
   * rather than a new invented fatigue score. */
  maxCombinedFatigueRank: 3, // low=0, medium=1, high=2 per exerciseSelector.ts's own FATIGUE_RANK; 3 allows e.g. medium+medium or low+high, blocks high+high
} as const;

/** [DEFAULT] Coaching Depth Batch 5 spec §4.4/§4.6/§4.8: app-level
 * intensity-technique policy layered on top of Blueprint's own real
 * per-technique suitability data (see BlueprintIntensityTechnique) —
 * these numbers are this app's own explicit, documented guardrails, not
 * Blueprint-authored figures (Blueprint's raw catalog has no frequency
 * or experience-gating fields of its own). */
export const INTENSITY_TECHNIQUE_POLICY = {
  /** Spec §4.8: "Disable intensity techniques by default" during any
   * active deload — no technique in this app's catalog is currently
   * flagged as an approved low-stress exception. */
  disabledDuringDeload: true,
  /** Spec §4.6 "technique uses per session" — count-only cap, never a
   * time/equipment one (mirrors SESSION_REALISM_CAP's own count-only
   * philosophy). */
  maxApplicationsPerSession: 1,
  /** Spec §4.6 "technique uses per week" — a whole-plan ceiling so
   * technique use can never silently accumulate into a de facto second
   * volume system. */
  maxApplicationsPerWeek: 2,
  /** Spec §4.4 "the user has sufficient training context, if required":
   * the minimum confirmed TrainingExperienceLevel (see
   * intensityTechniques.ts) each technique requires before it is ever
   * eligible — missing/unconfirmed experience means "insufficient
   * context," never a guessed default (spec §2.2), so the technique is
   * simply never applied rather than assumed novice-safe. Myo-reps
   * requires 'advanced' specifically because Blueprint's own
   * `when_not_to_use` text for it names inaccurate proximity-to-failure
   * judgment as the real risk — a skill this app has no way to verify
   * below advanced self-reported experience. */
  minimumExperienceByTechniqueId: {
    'drop-set': 'intermediate',
    'rest-pause': 'intermediate',
    'myo-reps': 'advanced',
  },
} as const;

/** [DEFAULT] Coaching Depth Batch 5 spec §5.3/§5.4: structural-balance
 * advisory evidence thresholds — deliberately conservative so a single
 * week's noise never produces a strong advisory (spec §5.3: "A single
 * measurement or isolated session should not create a strong advisory"). */
export const STRUCTURAL_ADVISORY_POLICY = {
  /** Spec §5.2 "Push/pull... imbalance": the push-side (or pull-side)
   * share of combined push+pull rolling exposure below which a WATCH
   * advisory fires — evaluated over the target's own existing
   * `rolling_window_days` (never a single week), so this is inherently a
   * sustained-evidence signal, not a snapshot. */
  pushPullWatchShareBelow: 0.4,
  /** Below this share, the advisory escalates to REVIEW. */
  pushPullReviewShareBelow: 0.3,
} as const;

export const ENGINE_CONFIG = {
  exposureCoefficients: EXPOSURE_COEFFICIENTS,
  maxActiveAestheticGoals: MAX_ACTIVE_AESTHETIC_GOALS,
  assessmentScale: ASSESSMENT_SCALE,
  reviewCadenceDefaultDays: REVIEW_CADENCE_DEFAULT_DAYS,
  progressionIncrements: PROGRESSION_INCREMENTS,
  recoveryThresholds: RECOVERY_THRESHOLDS,
  defaultWeeklySchedule: DEFAULT_WEEKLY_SCHEDULE,
  lowerBodyPhysiqueRegions: LOWER_BODY_PHYSIQUE_REGIONS,
  forbiddenBodyFocusByDay: FORBIDDEN_BODY_FOCUS_BY_DAY,
  sessionPurposeRotation: SESSION_PURPOSE_ROTATION,
  sessionPurposeTargets: SESSION_PURPOSE_TARGETS,
  universalPhysiqueTargets: UNIVERSAL_PHYSIQUE_TARGETS,
  goalMatch: GOAL_MATCH,
  timeEstimation: TIME_ESTIMATION,
  deloadPolicy: DELOAD_POLICY,
  reactiveTrigger: REACTIVE_TRIGGER,
  defaultProgramBlockLengthWeeks: DEFAULT_PROGRAM_BLOCK_LENGTH_WEEKS,
  exerciseRotation: EXERCISE_ROTATION,
  exercisePairing: EXERCISE_PAIRING,
  intensityTechniquePolicy: INTENSITY_TECHNIQUE_POLICY,
  structuralAdvisoryPolicy: STRUCTURAL_ADVISORY_POLICY,
} as const;
