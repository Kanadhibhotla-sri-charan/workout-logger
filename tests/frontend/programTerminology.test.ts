// Final Surgical Fix Pass §18: the smallest practical regression proving
// the Program (and History goal-progress) UI presents programmed volume
// as "Programmed" (with "Required"/"Unmet"), never as "delivered" —
// using only the existing test infrastructure (vitest), never a new
// frontend/browser testing framework. This is a source-level assertion
// on the static markup/script text, deliberately scoped to the exact
// defect (the DISPLAY word "delivered") — it does not touch the backend
// field name `deliveredDirectSets`, which spec §16 explicitly says may
// remain unchanged (and which this regex is careful not to flag: a
// `\bdelivered\b` word-boundary match never fires inside the camelCase
// identifier "deliveredDirectSets").

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '../../public');

function readPage(name: string): string {
  return readFileSync(join(publicDir, name), 'utf8');
}

describe('Program page volume terminology', () => {
  const html = readPage('program.html');

  it('describes programmed volume as "Required"/"Programmed"/"Unmet"', () => {
    expect(html).toMatch(/Required/);
    expect(html).toMatch(/Programmed/);
    expect(html).toMatch(/Unmet/);
  });

  it('never presents programmed volume to the user as "delivered" (the backend field name deliveredDirectSets may remain)', () => {
    expect(html).not.toMatch(/\bdelivered\b/i);
  });
});

describe('History page goal-progress volume terminology', () => {
  const html = readPage('history.html');

  it('describes programmed volume as "Required"/"Programmed", never "delivered"', () => {
    expect(html).toMatch(/Required/);
    expect(html).toMatch(/Programmed/);
    expect(html).not.toMatch(/\bdelivered\b/i);
  });
});

describe('Logger page keeps Planned vs Actual separate from programming terminology', () => {
  const html = readPage('logger.html');

  it('still distinguishes Planned from Actual (real workout completion, not a programming concept)', () => {
    expect(html).toMatch(/Planned/);
    expect(html).toMatch(/Actual/);
  });
});
