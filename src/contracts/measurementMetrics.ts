// Body measurements (2026-10-12): the Goals page offers these presets; any
// other name may be typed. `better` says which way is progress for the
// goal review: bigger arms are progress, a bigger waist is not, and
// bodyweight depends on whether the user is gaining or cutting, so it is
// tracked but never judged.

export type MeasurementDirection = 'higher' | 'lower' | 'neutral';

export interface MeasurementPreset {
  name: string;
  unit: string;
  better: MeasurementDirection;
}

export const MEASUREMENT_PRESETS: readonly MeasurementPreset[] = [
  { name: 'bodyweight', unit: 'kg', better: 'neutral' },
  { name: 'upper arm (relaxed)', unit: 'cm', better: 'higher' },
  { name: 'upper arm (flexed)', unit: 'cm', better: 'higher' },
  { name: 'forearm', unit: 'cm', better: 'higher' },
  { name: 'chest', unit: 'cm', better: 'higher' },
  { name: 'shoulders', unit: 'cm', better: 'higher' },
  { name: 'waist (at navel)', unit: 'cm', better: 'lower' },
  { name: 'thigh', unit: 'cm', better: 'higher' },
  { name: 'calf', unit: 'cm', better: 'higher' },
];

export const MAX_METRIC_NAME = 60;
export const MAX_UNIT = 12;

/** Which way is progress for a measurement. A typed-in name is read by
 * keyword: waist, hips or body fat -> smaller is better; weight -> not
 * judged; any other girth -> bigger is better. */
export function measurementDirection(metricName: string): MeasurementDirection {
  const name = metricName.trim().toLowerCase();
  const preset = MEASUREMENT_PRESETS.find((p) => p.name === name);
  if (preset) return preset.better;
  if (/waist|hip|fat/.test(name)) return 'lower';
  if (/weight/.test(name)) return 'neutral';
  return 'higher';
}
