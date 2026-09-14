// Two-Day Schedule Swap: program.html must expose a visible way to
// swap any two days' complete schedule assignment, calling the
// existing, already-tested POST /api/programming/week/swap
// (src/engine/scheduleOperations.ts's swapDayActivities) — never AI
// generation, never reconciliation, never a hardcoded weekday pair.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '../../public');

function readFile(name: string): string {
  return readFileSync(join(publicDir, name), 'utf8');
}

const html = readFile('program.html');

/** The buildSwapControl() function's own source text, extracted so
 * assertions about what it does/doesn't call are scoped to that
 * function — never accidentally matching an unrelated occurrence of the
 * same string elsewhere on this large page (e.g. "generate-session"
 * appears legitimately in the AI proposal section far below). */
const swapControlSource = (() => {
  const start = html.indexOf('function buildSwapControl');
  if (start === -1) return '';
  const returnIdx = html.indexOf('return section;', start);
  const closeIdx = html.indexOf('\n    }', returnIdx); // the function's own closing brace, 4-space indent
  return html.slice(start, closeIdx === -1 ? undefined : closeIdx + '\n    }'.length);
})();

describe('program.html: two-day schedule swap control', () => {
  it('has a visible Swap control on the weekly schedule', () => {
    expect(html).toMatch(/buildSwapControl/);
    expect(html).toMatch(/Swap two days/);
  });

  it('actually captured the buildSwapControl function body (sanity check for the extraction above)', () => {
    expect(swapControlSource.length).toBeGreaterThan(200);
    expect(swapControlSource).toMatch(/return section;/);
  });

  it('calls the existing deterministic swap endpoint, never AI generate/reconcile', () => {
    expect(swapControlSource).toMatch(/\/api\/programming\/week\/swap/);
    expect(swapControlSource).not.toMatch(/generate-session/);
    expect(swapControlSource).not.toMatch(/reconcile-week/);
  });

  it('sends whichever two days the user picked, never a hardcoded weekday pair', () => {
    expect(swapControlSource).toMatch(/body:\s*{\s*dayA:\s*daySelectA\.value,\s*dayB:\s*daySelectB\.value\s*}/);
    // The option list is built from the real week data, not a fixed
    // Mon/Tue/Wed literal array.
    expect(swapControlSource).toMatch(/weekData\.days\.map\(\(d\) => el\('option'/);
  });

  it('rejects picking the same day twice before ever calling the API', () => {
    expect(swapControlSource).toMatch(/daySelectA\.value === daySelectB\.value/);
    expect(swapControlSource).toMatch(/Choose two different days to swap/);
  });

  it('refreshes the weekly schedule after a successful swap', () => {
    expect(swapControlSource).toMatch(/await loadWeek\(\)/);
  });

  it('shows a clear inline success/error message via the shared helper, never alert()', () => {
    expect(swapControlSource).toMatch(/withSaving\(/);
    expect(swapControlSource).not.toMatch(/alert\(/);
  });

  it('documents that completed/in-progress workouts are never moved by this control', () => {
    expect(swapControlSource).toMatch(/Completed or in-progress workouts are never moved/);
  });
});
