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

/** [SPEC] §16: "Monday must never be generated as a lower-body day."
 * Hard constraint, checked deterministically — see
 * constraintEngine.isBodyFocusAllowedOnDay. */
export const FORBIDDEN_BODY_FOCUS_BY_DAY: Partial<Record<Weekday, readonly string[]>> = {
  monday: ['lower', 'legs'],
};

export const ENGINE_CONFIG = {
  exposureCoefficients: EXPOSURE_COEFFICIENTS,
  maxActiveAestheticGoals: MAX_ACTIVE_AESTHETIC_GOALS,
  assessmentScale: ASSESSMENT_SCALE,
  reviewCadenceDefaultDays: REVIEW_CADENCE_DEFAULT_DAYS,
  progressionIncrements: PROGRESSION_INCREMENTS,
  recoveryThresholds: RECOVERY_THRESHOLDS,
  defaultWeeklySchedule: DEFAULT_WEEKLY_SCHEDULE,
  forbiddenBodyFocusByDay: FORBIDDEN_BODY_FOCUS_BY_DAY,
} as const;
