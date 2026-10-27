// Blueprint schema 2 volume data (2026-10-27): weekly credited-set
// numbers per target (volume-targets.yaml), the sub-region hierarchy
// (physique-targets.yaml parent / volume_share / min_share) and each
// exercise's target_credit. The logger reads these numbers directly
// and never derives weekly volume from development packages.
//
// Owner decision 2026-10-27: Blueprint's min_hours_between is not
// applied (consecutive training days are normal for the owner).

import { BlueprintAdapter } from './adapter.js';
import type { BlueprintVolumeLevel, BlueprintVolumeTarget } from './types.js';

export interface VolumeNumbers {
  /** Target, volume group or goal id the numbers are authored on. */
  id: string;
  weekly: Record<BlueprintVolumeLevel, number>;
  perSessionMax: number | null;
  indirectOnly: boolean;
}

export interface VolumeChild {
  id: string;
  parent: string;
  volumeShare: number | null;
  minShare: number | null;
}

const entryId = (e: BlueprintVolumeTarget) => e.target_id ?? e.goal_id ?? '';

/** Every entry that carries its own weekly numbers (children excluded). */
export function listVolumeNumbers(): VolumeNumbers[] {
  return BlueprintAdapter.listVolumeTargets()
    .filter((e) => e.weekly_sets)
    .map((e) => ({ id: entryId(e), weekly: e.weekly_sets!, perSessionMax: e.per_session_max ?? null, indirectOnly: e.indirect_only === true }));
}

export function getVolumeNumbers(id: string): VolumeNumbers | null {
  return listVolumeNumbers().find((v) => v.id === id) ?? null;
}

/** Sub-region targets of a parent (chest -> upper/mid/lower pec). */
export function volumeChildren(parentId: string): VolumeChild[] {
  return BlueprintAdapter.getTargets()
    .filter((t) => t.parent === parentId)
    .map((t) => ({ id: t.id, parent: parentId, volumeShare: t.volume_share ?? null, minShare: t.min_share ?? null }));
}

/** The volume parent of a sub-region target, else the id itself. */
export function volumeParentOf(id: string): string {
  return BlueprintAdapter.getTarget(id)?.parent ?? id;
}

/** Credited sets per hard set for an exercise (variant ids
 * `<exercise>.<equipment>` share their record's credit); null when the
 * exercise is unknown or credits nothing (mobility, drills). */
export function getTargetCredit(exerciseId: string): Readonly<Record<string, number>> | null {
  const exercise = BlueprintAdapter.getExercise(exerciseId) ?? BlueprintAdapter.getExercise(exerciseId.split('.')[0] ?? exerciseId);
  return exercise?.target_credit ?? null;
}

/** The volume level per id for a set of aesthetic outcomes: the highest
 * level any of them gives ('priority' beats 'efficient'); 'bias' marks a
 * child whose parent carries the level. */
export function outcomeVolumeLevels(outcomeIds: readonly string[]): Map<string, 'priority' | 'efficient' | 'bias'> {
  const rank = { bias: 0, efficient: 1, priority: 2 } as const;
  const out = new Map<string, 'priority' | 'efficient' | 'bias'>();
  for (const id of outcomeIds) {
    for (const { target_id, level } of BlueprintAdapter.getAestheticGoal(id)?.volume_levels ?? []) {
      const current = out.get(target_id);
      if (!current || rank[level] > rank[current]) out.set(target_id, level);
    }
  }
  return out;
}
