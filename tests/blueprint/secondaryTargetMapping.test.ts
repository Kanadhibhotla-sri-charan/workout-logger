import { describe, expect, it } from 'vitest';
import { normalizeTargetPhrase, resolveSecondaryTarget } from '../../src/blueprint/secondaryTargetMapping.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';

describe('normalizeTargetPhrase', () => {
  it('strips parenthetical asides', () => {
    expect(normalizeTargetPhrase('chest (commonly cited as mid/sternal-biased)')).toBe('chest');
  });

  it('strips trailing em-dash clauses', () => {
    expect(normalizeTargetPhrase('triceps — all three heads, no lateral bias')).toBe('triceps');
  });

  it('strips trailing semicolon clauses', () => {
    expect(normalizeTargetPhrase('triceps; see evidence_notes')).toBe('triceps');
  });

  it('lowercases', () => {
    expect(normalizeTargetPhrase('Anterior Deltoids')).toBe('anterior deltoids');
  });
});

describe('resolveSecondaryTarget — the bench-press worked example', () => {
  it('maps "anterior deltoids" to the real Blueprint front-delt target', () => {
    const resolved = resolveSecondaryTarget('anterior deltoids');
    expect(resolved).toEqual({ target_type: 'physique_target', target_id: 'front-delt' });
    expect(BlueprintAdapter.getTarget('front-delt')).toBeDefined();
  });

  it('maps "triceps" to the real Blueprint triceps target', () => {
    const resolved = resolveSecondaryTarget('triceps');
    expect(resolved).toEqual({ target_type: 'physique_target', target_id: 'triceps' });
    expect(BlueprintAdapter.getTarget('triceps')).toBeDefined();
  });
});

describe('resolveSecondaryTarget — every mapped entry resolves to a real Blueprint id', () => {
  const MAPPED_PHRASES = [
    'adductors',
    'anterior deltoids',
    'biceps',
    'brachialis',
    'gastrocnemius',
    'glutes',
    'grip',
    'hamstrings',
    'hip flexors',
    'hip stabilizers',
    'lats',
    'mid-back',
    'obliques',
    'quads',
    'rectus abdominis',
    'serratus anterior',
    'soleus',
    'traps',
    'triceps',
    'upper chest',
    'upper trapezius',
    'wrist extensors',
    'external rotators',
  ];

  it.each(MAPPED_PHRASES)('%s resolves to a real, resolvable Blueprint target', (phrase) => {
    const resolved = resolveSecondaryTarget(phrase);
    expect(resolved).not.toBeNull();
    const real =
      resolved!.target_type === 'physique_target'
        ? BlueprintAdapter.getTarget(resolved!.target_id)
        : BlueprintAdapter.getFunctionalGoal(resolved!.target_id);
    expect(real, `${phrase} -> ${resolved!.target_id} must resolve via BlueprintAdapter`).toBeDefined();
  });
});

describe('resolveSecondaryTarget — deliberately unmapped phrases return null, never a guess', () => {
  const UNMAPPED_PHRASES = [
    'brachioradialis',
    'calves',
    'chest',
    'elbow flexors',
    'erectors',
    'spinal erectors',
    'forearms',
    'hip musculature',
    'shoulders',
    'tensor fasciae latae',
    'trunk musculature',
  ];

  it.each(UNMAPPED_PHRASES)('%s is unmapped (null), not silently guessed', (phrase) => {
    expect(resolveSecondaryTarget(phrase)).toBeNull();
  });
});

describe('mapping completeness — no new, undocumented phrase silently falls through', () => {
  function normalizeAll(phrases: readonly string[] | null | undefined): string[] {
    return (phrases ?? []).map(normalizeTargetPhrase);
  }

  const KNOWN_PHRASES = new Set([
    // mapped
    'adductors', 'anterior deltoids', 'biceps', 'brachialis', 'gastrocnemius', 'glutes', 'grip',
    'hamstrings', 'hip flexors', 'hip stabilizers', 'lats', 'mid-back', 'obliques', 'quads',
    'rectus abdominis', 'serratus anterior', 'soleus', 'traps', 'triceps', 'upper chest',
    'upper trapezius', 'wrist extensors', 'external rotators',
    // deliberately unmapped
    'brachioradialis', 'calves', 'chest', 'elbow flexors', 'erectors', 'spinal erectors',
    'forearms', 'hip musculature', 'shoulders', 'tensor fasciae latae', 'trunk musculature',
  ]);

  it('every secondary_targets phrase across the real Blueprint snapshot is either mapped or documented as unmapped', () => {
    const exercises = BlueprintAdapter.getExercises();
    const unknown = new Set<string>();
    for (const e of exercises) {
      for (const phrase of normalizeAll(e.secondary_targets)) {
        if (!KNOWN_PHRASES.has(phrase)) unknown.add(phrase);
      }
    }
    expect(
      [...unknown],
      'Blueprint data introduced a new secondary_targets phrase not covered by docs/SECONDARY_TARGET_MAPPING.md — it needs an explicit mapped-or-unmapped decision, not a silent default.'
    ).toEqual([]);
  });
});
