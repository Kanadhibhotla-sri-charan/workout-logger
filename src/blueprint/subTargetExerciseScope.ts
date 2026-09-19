// Some Blueprint muscle_groups group MULTIPLE physique_target ids under
// one shared development package — e.g. "triceps": [triceps,
// triceps-long-head], or "chest": [upper-pec, mid-pec, lower-pec] (chest
// has no "general" member at all; all three are co-equal slices of one
// package). A single package's exercises collectively build the whole
// muscle_group, but a goal can target only ONE of those ids (e.g. a goal
// whose real emphasis is specifically triceps-long-head, or specifically
// upper-pec). Blueprint's package sets/reps numbers are authored
// assuming the whole package is trained together; naively summing every
// package exercise's sets for one sub-id's own weekly/per-exposure
// reference over-counts it by the sets of exercises that don't
// meaningfully train that specific sub-id.
//
// This is a one-time, human-reasoned tagging of which package exercises
// actually count toward which target_id(s) — read directly from each
// exercise's own Blueprint-authored `contribution` text
// (data/programming/development-packages.yaml). It is not an invented
// number and not a live per-session judgment call: every tag traces to a
// specific real sentence in that exercise's own contribution field
// (quoted in the comments below). developmentReferenceEngine.ts uses
// getSubTargetExerciseIds to filter which exercises count toward a given
// sub-id's direct_sets_per_exposure/weekly_direct_set_reference, instead
// of always summing the whole package.
//
// A package with no entry here (shoulders, back, forearms, core today) is
// unfiltered: getSubTargetExerciseIds returns null and callers use the full
// package sum exactly as before this module existed. An exercise tagged
// `[]` is deliberately counted toward NO target (see the leg groups below).
//
// Generalizes automatically: any FUTURE goal whose target is one of the
// ids already tagged here (or a currently-untagged sub-id of an
// already-tagged package) is scoped correctly with no further per-goal
// special-casing. Only a genuinely new package, or a new sub-id added to
// an already-shared muscle_group, needs a new entry here.

/** exercise_id -> the target_id(s), among this package's muscle_group's
 * target_ids, that this specific exercise's sets meaningfully count
 * toward per its own Blueprint-authored `contribution` text. */
type SubTargetExerciseScope = Readonly<Record<string, readonly string[]>>;

/** Keyed by development-package id (e.g. "triceps-complete"). Only
 * packages whose muscle_group has more than one target_id appear here —
 * every exercise in each of these packages is tagged (never left
 * implicit), so filtering is always exact, never a partial guess. */
const SUB_TARGET_EXERCISE_SCOPE: Readonly<Record<string, SubTargetExerciseScope>> = {
  // --- Triceps group: [triceps, triceps-long-head] ---
  // "triceps" = general/whole-muscle development (every exercise here
  // counts). "triceps-long-head" = only the exercises whose own
  // contribution text specifically names the long head / overhead
  // position (the only way to meaningfully stretch-load it — the long
  // head is the one head that crosses the shoulder joint).
  'triceps-efficient': {
    'close-grip-bench-press': ['triceps'],
    'overhead-triceps-extension': ['triceps', 'triceps-long-head'], // "Long-head-specific stretch work — the overhead position most other triceps exercises miss..."
    'cable-pushdown': ['triceps'],
  },
  'triceps-complete': {
    'close-grip-bench-press': ['triceps'],
    'overhead-triceps-extension': ['triceps', 'triceps-long-head'], // "Long-head-specific stretch work via the overhead position."
    'cable-pushdown': ['triceps'],
    'dip-triceps-biased': ['triceps'],
    'cable-overhead-extension-leaning-forward': ['triceps', 'triceps-long-head'], // "A cable variant of the long-head stretch position..."
  },

  // --- Chest group: [upper-pec, mid-pec, lower-pec] --- Blueprint's own
  // target list has no plain "chest" id; every exercise is tagged to
  // whichever specific region(s) its own contribution text names.
  'chest-efficient': {
    'incline-barbell-press': ['upper-pec'], // "Upper-chest shelf and the fullness that closes the gap below the collarbone."
    'flat-barbell-bench-press': ['mid-pec'], // "The main slab of chest mass and front-on thickness."
    'cable-fly': ['upper-pec', 'mid-pec', 'lower-pec'], // "Constant-tension stretch work across the whole pec — including the lower/outer sweep..."
  },
  'chest-complete': {
    'incline-barbell-press': ['upper-pec'],
    'flat-barbell-bench-press': ['mid-pec'],
    'dip-chest-biased': ['lower-pec'], // "Direct lower-chest loading and the transition-line definition near the ribs..."
    'cable-fly': ['upper-pec', 'mid-pec', 'lower-pec'],
    'incline-dumbbell-fly': ['upper-pec'], // "Extra stretch-emphasis detail work isolated to the upper-chest shelf..."
  },

  // --- Leg groups (2026-09-19, one leg day/week + Saturday badminton) ---
  // Two purposes here. (1) glutes/calves share one package across two
  // targets, so they get the same per-target scoping as chest/triceps.
  // (2) quads/hamstrings/glutes/calves: SECONDARY-role exercises are
  // tagged `[]` — deliberately excluded from every target's reference. With a single
  // leg day and a 5-exercise leg cap there is no slot for them, and they
  // are the most eccentric/unilateral work (reverse nordic, Bulgarian
  // split squat, lying curl), the worst fit right before weekend
  // badminton. This is a coaching judgment, not Blueprint data; the
  // exercises still exist in the package for selection, they just don't
  // inflate the reference. single-leg-calf-raise is the one secondary
  // kept (standing, low-eccentric).
  'quads-efficient': {
    'back-squat': ['quads'],
    'leg-press': ['quads'],
    'leg-extension': ['quads'],
  },
  'quads-complete': {
    'back-squat': ['quads'],
    'leg-press': ['quads'],
    'leg-extension': ['quads'],
    'bulgarian-split-squat-knee-dominant': [],
    'reverse-nordic-curl': [],
  },
  'hamstrings-efficient': {
    'romanian-deadlift': ['hamstrings'],
    'seated-leg-curl': ['hamstrings'],
  },
  'hamstrings-complete': {
    'romanian-deadlift': ['hamstrings'],
    'seated-leg-curl': ['hamstrings'],
    'lying-leg-curl': [],
  },
  'glutes-efficient': {
    'hip-thrust': ['gluteus-maximus'], // "Primary glute-roundness builder."
    'bulgarian-split-squat-hip-dominant': ['gluteus-maximus'], // "Unilateral, hip-dominant glute loading."
    'hip-abduction': ['gluteus-medius-minimus'], // "Side-of-hip target most other movements only work as a stabilizer."
  },
  'glutes-complete': {
    'hip-thrust': ['gluteus-maximus'],
    'bulgarian-split-squat-hip-dominant': ['gluteus-maximus'],
    'hip-abduction': ['gluteus-medius-minimus'],
    'cable-kickback-glute': [],
  },
  'calves-efficient': {
    'standing-calf-raise': ['gastrocnemius'], // "Primary calf width/shape builder." (straight-knee = gastrocnemius)
    'seated-calf-raise': ['soleus'], // "Bent-knee soleus isolation."
  },
  'calves-complete': {
    'standing-calf-raise': ['gastrocnemius'],
    'seated-calf-raise': ['soleus'],
    'single-leg-calf-raise': ['gastrocnemius'], // standing unilateral; text is generic, tagged gastrocnemius as a judgment call
  },

  // --- Biceps group: [biceps, brachialis-arm-thickness] ---
  'biceps-efficient': {
    'barbell-ez-bar-curl': ['biceps'],
    'hammer-curl': ['biceps', 'brachialis-arm-thickness'], // "Brachialis thickness that sits under the biceps and pushes it outward..."
  },
  'biceps-complete': {
    'barbell-ez-bar-curl': ['biceps'],
    'hammer-curl': ['biceps', 'brachialis-arm-thickness'],
    'incline-dumbbell-curl': ['biceps'], // "Stretch-position biceps work the standing curl's resistance curve under-loads."
    'cross-body-hammer-curl': ['biceps', 'brachialis-arm-thickness'], // "A different brachialis loading angle..."
  },
};

/** The exercise_ids within `packageId` whose sets count toward
 * `targetId`, or null when this package isn't in the scope map at all —
 * meaning its muscle_group has only one target_id, and the caller should
 * use every exercise (the original, unfiltered behaviour). */
export function getSubTargetExerciseIds(packageId: string, targetId: string): readonly string[] | null {
  const scope = SUB_TARGET_EXERCISE_SCOPE[packageId];
  if (!scope) return null;
  return Object.entries(scope)
    .filter(([, targetIds]) => targetIds.includes(targetId))
    .map(([exerciseId]) => exerciseId);
}
