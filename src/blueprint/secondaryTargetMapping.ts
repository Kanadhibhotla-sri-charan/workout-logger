// Workout Programmer's OWN curated mapping from Blueprint's free-text
// Exercise.secondary_targets vocabulary to Blueprint's canonical target
// ids. This is NOT Blueprint data and NOT part of BlueprintAdapter's
// canonical surface — it exists only because the spec that requested
// primary/secondary exposure (see src/engine/exposureEngine.ts) requires
// it and Blueprint itself has no canonical secondary-target field.
//
// Full rationale, the complete enumerated vocabulary (including every
// entry deliberately left unmapped), and why each judgment call was made:
// docs/SECONDARY_TARGET_MAPPING.md. Read that before changing this file.
//
// This is a plain, closed dictionary lookup after normalization — never
// fuzzy/similarity matching. An unmapped phrase returns `null`, not a
// guess.

import type { TargetType } from '../engine/goalResolver.js';

export interface MappedTarget {
  target_type: TargetType;
  target_id: string;
}

/** Strips a Blueprint free-text target phrase down to its base form:
 * removes parenthetical asides and anything after an em dash/semicolon,
 * lowercases. Deterministic string processing, not fuzzy matching. */
export function normalizeTargetPhrase(phrase: string): string {
  return phrase
    .replace(/\s*\([^)]*\)/g, '')
    .split(/\s*—\s*|\s*;\s*/)[0]!
    .trim()
    .toLowerCase();
}

// Keys are normalized phrases (see normalizeTargetPhrase). Every mapped
// entry and every deliberate omission is documented in
// docs/SECONDARY_TARGET_MAPPING.md — do not add an entry here without
// adding it there too.
const SECONDARY_TARGET_MAP: Record<string, MappedTarget> = {
  adductors: { target_type: 'physique_target', target_id: 'adductors' },
  'anterior deltoids': { target_type: 'physique_target', target_id: 'front-delt' },
  biceps: { target_type: 'physique_target', target_id: 'biceps' },
  brachialis: { target_type: 'physique_target', target_id: 'brachialis-arm-thickness' },
  gastrocnemius: { target_type: 'physique_target', target_id: 'gastrocnemius' },
  glutes: { target_type: 'physique_target', target_id: 'gluteus-maximus' },
  grip: { target_type: 'physique_target', target_id: 'forearm-flexors' },
  hamstrings: { target_type: 'physique_target', target_id: 'hamstrings' },
  'hip flexors': { target_type: 'functional_goal', target_id: 'hip-flexors' },
  'hip stabilizers': { target_type: 'functional_goal', target_id: 'hip-stability' },
  lats: { target_type: 'physique_target', target_id: 'lat-width' },
  'mid-back': { target_type: 'physique_target', target_id: 'back-thickness' },
  obliques: { target_type: 'physique_target', target_id: 'obliques' },
  quads: { target_type: 'physique_target', target_id: 'quads' },
  'rectus abdominis': { target_type: 'physique_target', target_id: 'rectus-abdominis' },
  'serratus anterior': { target_type: 'functional_goal', target_id: 'scapular-stability' },
  soleus: { target_type: 'physique_target', target_id: 'soleus' },
  traps: { target_type: 'physique_target', target_id: 'upper-traps' },
  triceps: { target_type: 'physique_target', target_id: 'triceps' },
  'upper chest': { target_type: 'physique_target', target_id: 'upper-pec' },
  'upper trapezius': { target_type: 'physique_target', target_id: 'upper-traps' },
  'wrist extensors': { target_type: 'physique_target', target_id: 'forearm-extensors' },
  'external rotators': { target_type: 'functional_goal', target_id: 'rotator-cuff' },

  // Deliberately UNMAPPED (documented in docs/SECONDARY_TARGET_MAPPING.md):
  // brachioradialis, calves, chest, elbow flexors, erectors,
  // spinal erectors, forearms, hip musculature, shoulders,
  // tensor fasciae latae, trunk musculature.
  // Absent from this object entirely — see resolveSecondaryTarget below.
};

/** Resolves one Blueprint secondary_targets phrase to a canonical target,
 * or null if it's one of the deliberately-unmapped, too-ambiguous
 * phrases (see docs/SECONDARY_TARGET_MAPPING.md). Never guesses. */
export function resolveSecondaryTarget(phrase: string): MappedTarget | null {
  return SECONDARY_TARGET_MAP[normalizeTargetPhrase(phrase)] ?? null;
}
