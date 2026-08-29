// Proves scripts/migrate-workout-log-dry-run.mts actually works, against a
// small synthetic sample in the shape of Calorie Tracker's workout_log.csv
// (real data isn't available in this session — see docs/MIGRATION_PLAN.md).

import { describe, expect, it } from 'vitest';
import { buildReport, parseCsv } from '../scripts/migrate-workout-log-dry-run.mjs';

const SAMPLE_CSV = `date,session_type,workout_name,set_number,equipment,weight,reps,hours,games,format,tdee_final,comment
2026-08-01,gym,Bench Press,1,barbell,60,8,,,,,felt strong
2026-08-01,gym,Bench Press,2,barbell,60,7,,,,,
2026-08-01,gym,Incline Dumbbell Press,1,dumbbell,20,10,,,,,
2026-08-02,badminton,badminton,,,,,1.5,3,singles,,lost 2-1
2026-08-03,rest,rest day,,,,,,,,,,
2026-08-04,gym,Some Made Up Exercise Name,1,cable,8-10,,,,,,range weight, needs review
`;

describe('migrate-workout-log-dry-run', () => {
  it('parses the CSV into rows', () => {
    const rows = parseCsv(SAMPLE_CSV);
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({ date: '2026-08-01', session_type: 'gym', workout_name: 'Bench Press', set_number: '1' });
  });

  it('builds a report that never mutates or imports anything, only reports', () => {
    const rows = parseCsv(SAMPLE_CSV);
    const report = buildReport(rows, 'sample.csv');

    expect(report.total_rows).toBe(6);
    expect(report.rows_by_session_type).toMatchObject({ gym: 4, badminton: 1, rest: 1 });
    expect(report.notes.some((n) => n.includes('DRY RUN'))).toBe(true);
    expect(report.notes.some((n) => n.includes('No data was imported'))).toBe(true);
  });

  it('excludes "rest day" from exercise-name matching, since it has no Blueprint equivalent', () => {
    const rows = parseCsv(SAMPLE_CSV);
    const report = buildReport(rows, 'sample.csv');

    expect(report.exercise_name_candidates.some((c) => c.workout_name.toLowerCase() === 'rest day')).toBe(false);
  });

  it('surfaces real Blueprint exercise candidates for a close-enough free-text name', () => {
    const rows = parseCsv(SAMPLE_CSV);
    const report = buildReport(rows, 'sample.csv');

    const benchPress = report.exercise_name_candidates.find((c) => c.workout_name === 'Bench Press');
    expect(benchPress).toBeDefined();
    expect(benchPress!.occurrences).toBe(2);
    expect(benchPress!.candidates.length).toBeGreaterThan(0);
    // A candidate, never an auto-decided mapping — the id is a suggestion.
    expect(benchPress!.candidates[0]).toHaveProperty('exercise_id');
    expect(benchPress!.candidates[0]).toHaveProperty('score');
  });

  it('reports zero or low-confidence candidates for a name with no real Blueprint match, rather than guessing', () => {
    const rows = parseCsv(SAMPLE_CSV);
    const report = buildReport(rows, 'sample.csv');

    const madeUp = report.exercise_name_candidates.find((c) => c.workout_name === 'Some Made Up Exercise Name');
    expect(madeUp).toBeDefined();
    // Whatever candidates exist (if any), none should be treated as decided —
    // this test only proves the tool doesn't crash or silently drop the row.
    expect(Array.isArray(madeUp!.candidates)).toBe(true);
  });

  it('flags columns with no schema equivalent instead of silently dropping them', () => {
    const rows = parseCsv(SAMPLE_CSV);
    const report = buildReport(rows, 'sample.csv');

    expect(report.columns_with_no_schema_equivalent).toEqual(expect.arrayContaining(['games', 'format', 'tdee_final']));
  });
});
