// Final Selected Session Resolution and AI/Deterministic Precedence
// Fixes §6/§11.G: today.html must resolve "the" gym session for its
// status card from the SAME authoritative source /today's own
// `plannedSession` field already carries, never by independently
// re-deriving "the first gym session" from `loggedSessions` — the exact
// row-order-dependent anti-pattern the backend's old
// `findRealGymSession()` had. Static markup/script text assertions, in
// the same style as tests/frontend/exercisePicker.test.ts — this
// codebase's existing pattern for testing logic embedded in a page's
// inline <script>, no browser/jsdom framework. A real browser smoke test
// covers the actual dynamic behavior — see the implementation report.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '../../public');

function readFile(name: string): string {
  return readFileSync(join(publicDir, name), 'utf8');
}

describe('today.html: resolves "the" gym session from plannedSession, not an independent re-derivation', () => {
  const html = readFile('today.html');

  it('no longer independently picks the first gym session out of loggedSessions', () => {
    expect(html).not.toMatch(/loggedSessions\.find\(\s*\(s\)\s*=>\s*s\.session_type === 'gym'\s*\)/);
  });

  it('looks the display session up by the id plannedSession already resolved', () => {
    expect(html).toMatch(/todayData\.plannedSession\s*\?\s*todayData\.loggedSessions\.find\(\(s\) => s\.session_id === todayData\.plannedSession\.id\)/);
  });
});
