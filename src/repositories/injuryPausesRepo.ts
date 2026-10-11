import type Database from 'better-sqlite3';
import { BlueprintAdapter } from '../blueprint/adapter.js';
import { nowIso } from './ids.js';

/** Body areas the user can pause for injury, each the Blueprint physique
 * targets whose parent_region falls in it. */
export const INJURY_AREAS = {
  chest: { label: 'Chest', regions: ['chest'] },
  shoulders: { label: 'Shoulders', regions: ['shoulders'] },
  back: { label: 'Back', regions: ['back'] },
  arms: { label: 'Arms', regions: ['arms', 'forearms'] },
  core: { label: 'Core', regions: ['core'] },
  legs: { label: 'Legs', regions: ['quads', 'hamstrings', 'hips', 'calves'] },
  neck: { label: 'Neck', regions: ['neck'] },
} as const;

export type InjuryArea = keyof typeof INJURY_AREAS;
export const INJURY_AREA_IDS = Object.keys(INJURY_AREAS) as InjuryArea[];

export interface InjuryPause {
  area: InjuryArea;
  note: string | null;
  since: string;
}

/** The physique target ids an area covers. */
export function targetIdsForArea(area: InjuryArea): string[] {
  const regions: readonly string[] = INJURY_AREAS[area].regions;
  return BlueprintAdapter.getTargets()
    .filter((t) => regions.includes(t.parent_region))
    .map((t) => t.id);
}

/** Injury pauses: which body areas are currently paused. */
export class InjuryPausesRepo {
  constructor(private db: Database.Database) {}

  list(): InjuryPause[] {
    return this.db.prepare('SELECT area, note, since FROM injury_pauses ORDER BY area').all() as InjuryPause[];
  }

  pause(area: InjuryArea, since: string, note: string | null): void {
    this.db
      .prepare(
        `INSERT INTO injury_pauses (area, note, since, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (area) DO UPDATE SET note = excluded.note`
      )
      .run(area, note, since, nowIso());
  }

  resume(area: InjuryArea): void {
    this.db.prepare('DELETE FROM injury_pauses WHERE area = ?').run(area);
  }

  /** Every physique target id currently paused. */
  pausedTargetIds(): Set<string> {
    return new Set(this.list().flatMap((p) => targetIdsForArea(p.area)));
  }
}
