// Dry-run report for a possible future import of Calorie Tracker's
// historical workout_log.csv into workout-logger's schema. See
// docs/MIGRATION_PLAN.md for the full plan this implements step 1-6 of.
//
// This script NEVER writes to workout-logger's database and NEVER
// performs an import — it only reads a CSV and produces a report of what
// an import would need to resolve first (exercise-name matches requiring
// human confirmation, unparseable numeric fields, columns with no
// equivalent in the new schema). Step 7 (the actual import) is a
// separate, not-yet-built tool that would consume a human-reviewed
// mapping file this report's output feeds into.
//
// Usage:
//   npx tsx scripts/migrate-workout-log-dry-run.mts <path-to-workout_log.csv> [--out report.json]
//
// Expected input columns (from food_and_workout_tracker's schema):
//   date, session_type, workout_name, set_number, equipment, weight, reps,
//   hours, games, format, tdee_final, comment

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BlueprintAdapter } from '../src/blueprint/adapter.js';

export interface CsvRow {
  date: string;
  session_type: string;
  workout_name: string;
  set_number: string;
  equipment: string;
  weight: string;
  reps: string;
  hours: string;
  games: string;
  format: string;
  tdee_final: string;
  comment: string;
}

export function parseCsv(text: string): CsvRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = splitCsvLine(lines[0]!);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row: Record<string, string> = {};
    header.forEach((col, i) => {
      row[col.trim()] = (cells[i] ?? '').trim();
    });
    return row as unknown as CsvRow;
  });
}

// Minimal CSV splitter: handles quoted fields with embedded commas, not a
// full RFC 4180 parser. Good enough for a dry-run report; the real import
// tool (not built here) should use a proper CSV library.
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Simple token-overlap similarity — deliberately not a "smart" fuzzy
// matcher. This is meant to surface CANDIDATES for a human to confirm,
// never to auto-decide a mapping. See docs/MIGRATION_PLAN.md §4.
function similarity(a: string, b: string): number {
  const tokensA = new Set(normalize(a).split(' ').filter(Boolean));
  const tokensB = new Set(normalize(b).split(' ').filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let shared = 0;
  for (const t of tokensA) if (tokensB.has(t)) shared++;
  return shared / Math.max(tokensA.size, tokensB.size);
}

function candidateMatches(workoutName: string, limit = 3) {
  const exercises = BlueprintAdapter.getExercises();
  return exercises
    .map((e) => ({ exercise_id: e.id, exercise_name: e.name, score: similarity(workoutName, e.name) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function isParseableNumber(value: string): boolean {
  if (value.trim() === '') return true; // blank is fine (rest day / badminton rows)
  return /^-?\d+(\.\d+)?$/.test(value.trim());
}

export interface MigrationReport {
  source_file: string;
  generated_at: string;
  total_rows: number;
  rows_by_session_type: Record<string, number>;
  unique_workout_names: number;
  exercise_name_candidates: Array<{
    workout_name: string;
    occurrences: number;
    candidates: Array<{ exercise_id: string; exercise_name: string; score: number }>;
  }>;
  unparseable_weight_rows: number;
  unparseable_reps_rows: number;
  columns_with_no_schema_equivalent: string[];
  notes: string[];
}

export function buildReport(rows: CsvRow[], sourceFile: string): MigrationReport {
  const rowsBySessionType: Record<string, number> = {};
  const workoutNameCounts = new Map<string, number>();
  let unparseableWeight = 0;
  let unparseableReps = 0;

  for (const row of rows) {
    rowsBySessionType[row.session_type] = (rowsBySessionType[row.session_type] ?? 0) + 1;
    if (row.workout_name && row.workout_name.toLowerCase() !== 'rest day') {
      workoutNameCounts.set(row.workout_name, (workoutNameCounts.get(row.workout_name) ?? 0) + 1);
    }
    if (!isParseableNumber(row.weight)) unparseableWeight++;
    if (!isParseableNumber(row.reps)) unparseableReps++;
  }

  const exerciseNameCandidates = [...workoutNameCounts.entries()]
    .map(([workout_name, occurrences]) => ({
      workout_name,
      occurrences,
      candidates: candidateMatches(workout_name),
    }))
    .sort((a, b) => b.occurrences - a.occurrences);

  return {
    source_file: sourceFile,
    generated_at: new Date().toISOString(),
    total_rows: rows.length,
    rows_by_session_type: rowsBySessionType,
    unique_workout_names: workoutNameCounts.size,
    exercise_name_candidates: exerciseNameCandidates,
    unparseable_weight_rows: unparseableWeight,
    unparseable_reps_rows: unparseableReps,
    columns_with_no_schema_equivalent: ['games', 'format', 'tdee_final'],
    notes: [
      'This is a DRY RUN. No data was imported. Nothing in workout-logger\'s database was touched.',
      'exercise_name_candidates must be manually reviewed and confirmed into a mapping file before any import tool is built or run.',
      '"games" and "format" (badminton-specific) have no equivalent field in the current schema — recommend preserving as free text in WorkoutSession.notes if imported.',
      '"tdee_final" is Calorie Tracker\'s own nightly-job output and is out of scope for workout-logger\'s schema entirely — never migrate it.',
      '"equipment" (free text) is not migrated as structured data — Blueprint\'s Exercise.equipment is derived from the matched exercise_id, not this column. It may help disambiguate a fuzzy match by hand.',
    ],
  };
}

export function main() {
  const args = process.argv.slice(2);
  const csvPath = args[0];
  if (!csvPath) {
    console.error('Usage: npx tsx scripts/migrate-workout-log-dry-run.mts <path-to-workout_log.csv> [--out report.json]');
    process.exit(1);
  }
  const outIndex = args.indexOf('--out');
  const outPath = outIndex !== -1 ? args[outIndex + 1] : undefined;

  const rows = parseCsv(readFileSync(csvPath, 'utf8'));
  const report = buildReport(rows, csvPath);

  const json = JSON.stringify(report, null, 2);
  if (outPath) {
    writeFileSync(outPath, json + '\n');
    console.log(`Wrote dry-run migration report to ${outPath}`);
  } else {
    console.log(json);
  }
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  main();
}
