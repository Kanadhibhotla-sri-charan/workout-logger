// Blueprint Picker/Daily Activity spec §3: source-level regressions for
// the Add Unplanned Exercise picker, in the same style as
// tests/frontend/programTerminology.test.ts (this repo's existing
// frontend-testing infrastructure — static markup/script text
// assertions, no browser/jsdom framework). A real browser smoke test
// covers the actual dynamic behavior (search/select/submit) — see the
// implementation report.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '../../public');

function readFile(name: string): string {
  return readFileSync(join(publicDir, name), 'utf8');
}

describe('logger.html: Add Unplanned Exercise no longer uses the native datalist picker', () => {
  const html = readFile('logger.html');

  it('has no <datalist> for the unplanned-exercise search', () => {
    expect(html).not.toMatch(/<datalist/i);
    expect(html).not.toMatch(/unplanned-exercise-options/);
  });

  it('fetches the complete Blueprint exercise library with no query params (no server-side relevance filtering)', () => {
    expect(html).toMatch(/api\('\/api\/blueprint\/exercises'\)/);
  });

  it('uses the shared searchable picker component', () => {
    expect(html).toMatch(/createBlueprintExercisePicker/);
  });

  it('gates the Add exercise button on an explicit selection (getSelected), not on raw input text', () => {
    expect(html).toMatch(/getSelected\(\)/);
    expect(html).toMatch(/disabled: true/);
  });
});

describe('logger.html: Substitute flow is untouched (spec: MUST NOT change)', () => {
  const html = readFile('logger.html');

  it('still calls the equipment/target-aware substitutes endpoint', () => {
    expect(html).toMatch(/\/api\/programming\/substitutes\?target_type=/);
  });

  it('still has the dedicated openSubstitutePicker function, separate from the new exercise picker', () => {
    expect(html).toMatch(/function openSubstitutePicker/);
    expect(html).toMatch(/Substitute for \$\{g\.exercise_name\}/);
  });
});

describe('app.js: createBlueprintExercisePicker is a plain substring search, no relevance ranking', () => {
  const js = readFile('app.js');

  it('defines the picker function', () => {
    expect(js).toMatch(/function createBlueprintExercisePicker/);
  });

  it('matches case-insensitively via substring, not a scored/ranked algorithm', () => {
    expect(js).toMatch(/toLowerCase\(\)\.includes\(query\)/);
  });

  it('caps the rendered result list rather than dumping the whole library into the DOM at once', () => {
    expect(js).toMatch(/MAX_RESULTS/);
    expect(js).toMatch(/\.slice\(0, MAX_RESULTS\)/);
  });

  it('shows an explicit no-match state', () => {
    expect(js).toMatch(/No Blueprint exercises found\./);
  });

  it('shows a distinct "selected" indicator naming it a Blueprint exercise', () => {
    expect(js).toMatch(/Selected: \$\{selected\.name\} \(Blueprint\)/);
  });

  it('clears the selection when the user types again after selecting (forces an explicit re-selection)', () => {
    expect(js).toMatch(/selected && search\.value !== selected\.name/);
  });
});
