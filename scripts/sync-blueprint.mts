// Regenerates the vendored Blueprint snapshot consumed by src/blueprint/adapter.ts.
//
// workout-blueprint is a static Vite app; its generated JSON
// (app/src/data/*.generated.json) is gitignored there, so there is nothing
// to fetch directly. Instead this script reads the same canonical YAML
// sources (data/exercises/*.yaml, data/programming/*.yaml) that
// workout-blueprint's own app/scripts/generate-data.mjs reads, and performs
// the identical mechanical reshape. It does not re-implement any of
// Blueprint's decision/programming logic — only the load step.
//
// Usage:
//   BLUEPRINT_REPO_PATH=/path/to/workout-blueprint npm run sync-blueprint
// If BLUEPRINT_REPO_PATH is unset, a shallow clone is made into a scratch
// dir. Run this manually whenever Blueprint's data changes; the resulting
// snapshot is committed to this repo (see docs/architecture.md).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SNAPSHOT_DIR = join(__dirname, '..', 'src', 'blueprint', 'snapshot');
const BLUEPRINT_REMOTE = 'https://github.com/Kanadhibhotla-sri-charan/workout-blueprint';

function resolveBlueprintRepoPath(): string {
  const configured = process.env.BLUEPRINT_REPO_PATH;
  if (configured) {
    if (!existsSync(configured)) {
      throw new Error(`BLUEPRINT_REPO_PATH=${configured} does not exist`);
    }
    return configured;
  }
  const scratch = mkdtempSync(join(tmpdir(), 'workout-blueprint-'));
  console.log(`Cloning ${BLUEPRINT_REMOTE} (shallow) into ${scratch} ...`);
  execFileSync('git', ['clone', '--depth', '1', BLUEPRINT_REMOTE, scratch], { stdio: 'inherit' });
  return scratch;
}

function loadExercises(repoPath: string): Record<string, unknown>[] {
  const dir = join(repoPath, 'data', 'exercises');
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort();
  const records: Record<string, unknown>[] = [];
  for (const file of files) {
    const raw = yaml.load(readFileSync(join(dir, file), 'utf8'));
    if (raw === null || raw === undefined) continue;
    if (!Array.isArray(raw)) {
      throw new Error(`${file}: expected a top-level YAML list, got ${typeof raw}`);
    }
    for (const record of raw) {
      if (typeof record !== 'object' || record === null || Array.isArray(record)) {
        throw new Error(`${file}: found a non-object record`);
      }
      records.push({ ...(record as Record<string, unknown>), _file: file });
    }
  }
  records.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const seen = new Set<string>();
  for (const r of records) {
    const id = String(r.id);
    if (seen.has(id)) {
      throw new Error(`Duplicate exercise id found in Blueprint source: ${id}`);
    }
    seen.add(id);
  }
  return records;
}

function loadProgramming(repoPath: string) {
  const dir = join(repoPath, 'data', 'programming');
  const loadYaml = (filename: string) => yaml.load(readFileSync(join(dir, filename), 'utf8')) as any;
  return {
    physiqueTargets: loadYaml('physique-targets.yaml').targets,
    globalPrinciples: loadYaml('global-principles.yaml'),
    repRanges: loadYaml('rep-ranges.yaml'),
    programmingProfiles: loadYaml('programming-profiles.yaml'),
    intensityTechniques: loadYaml('intensity-techniques.yaml').techniques,
    aestheticOutcomes: loadYaml('aesthetic-outcomes.yaml').outcomes,
    functionalGoals: loadYaml('functional-goals.yaml').goals,
    developmentPackages: loadYaml('development-packages.yaml'),
  };
}

function gitRevParse(repoPath: string): string {
  try {
    return execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function main() {
  const repoPath = resolveBlueprintRepoPath();

  const exercises = loadExercises(repoPath).map((r) => ({ ...r, _file: basename(String(r._file)) }));
  const programming = loadProgramming(repoPath);
  const sourceCommit = gitRevParse(repoPath);

  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  writeFileSync(join(SNAPSHOT_DIR, 'exercises.json'), JSON.stringify(exercises, null, 2) + '\n');
  writeFileSync(join(SNAPSHOT_DIR, 'programming.json'), JSON.stringify(programming, null, 2) + '\n');
  writeFileSync(
    join(SNAPSHOT_DIR, 'manifest.json'),
    JSON.stringify(
      {
        source: BLUEPRINT_REMOTE,
        sourceCommit,
        generatedAt: new Date().toISOString(),
        exerciseCount: exercises.length,
      },
      null,
      2
    ) + '\n'
  );

  console.log(`Wrote ${exercises.length} exercises and programming reference data to ${SNAPSHOT_DIR}`);
  console.log(`Source commit: ${sourceCommit}`);
}

main();
