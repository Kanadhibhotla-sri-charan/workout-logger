// Final Selected Session Resolution and AI/Deterministic Precedence
// Fixes §6/§11.G, extended by the Actionable vs Historical Session
// Resolution Fixes §10: today.html must resolve "the" gym session for
// its status card from the SAME authoritative fields /today's own
// response already carries (`historicalSession`, `selectedPlannedWorkout`,
// `selectionConflict`), never by independently re-deriving "the first
// gym session" from `loggedSessions` by type — the exact row-order-
// dependent anti-pattern the backend's old `findRealGymSession()` had.
// Static markup/script text assertions, in the same style as
// tests/frontend/exercisePicker.test.ts — this codebase's existing
// pattern for testing logic embedded in a page's inline <script>, no
// browser/jsdom framework. A real browser smoke test covers the actual
// dynamic behavior — see the implementation report.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '../../public');

function readFile(name: string): string {
  return readFileSync(join(publicDir, name), 'utf8');
}

describe('today.html: resolves the gym session from historicalSession/selectedPlannedWorkout, not an unqualified .find()', () => {
  const html = readFile('today.html');

  it('no longer independently picks the first gym session out of loggedSessions', () => {
    expect(html).not.toMatch(/loggedSessions\.find\(\s*\(s\)\s*=>\s*s\.session_type === 'gym'\s*\)/);
  });

  it('looks up each resolved session by its exact id (a qualified lookup, never a type/recency-based pick)', () => {
    expect(html).toMatch(/todayData\.loggedSessions\.find\(\(s\) => s\.session_id === ref\.id\)/);
  });

  it('branches on historicalSession explicitly (never presents a completed/in-progress session as a new planned workout)', () => {
    expect(html).toMatch(/todayData\.historicalSession/);
    expect(html).toMatch(/historicalSession\.status === 'completed'/);
  });

  it('branches on selectedPlannedWorkout explicitly for the actionable case', () => {
    expect(html).toMatch(/todayData\.selectedPlannedWorkout/);
  });

  it('checks selectionConflict FIRST and shows a recovery/error state instead of opening any session', () => {
    const conflictBranchIndex = html.indexOf('todayData.selectionConflict');
    const historicalBranchIndex = html.indexOf('historicalSession) {');
    expect(conflictBranchIndex).toBeGreaterThan(-1);
    expect(conflictBranchIndex).toBeLessThan(historicalBranchIndex);
    // The conflict branch never builds a /logger.html link.
    const conflictBlock = html.slice(html.indexOf('if (todayData.selectionConflict)'), html.indexOf('} else if (historicalSession)'));
    expect(conflictBlock).not.toMatch(/logger\.html\?session=/);
  });

  it('the actionable branch opens the logger by the exact resolved session id, never a fallback', () => {
    const actionableBranch = html.slice(html.indexOf('} else if (actionableSession) {'), html.indexOf('} else if (todayData.sessionType'));
    expect(actionableBranch).toMatch(/logger\.html\?session=\$\{actionableSession\.session_id\}/);
  });
});

describe('program.html: surfaces selectionConflict rather than opening an arbitrary session', () => {
  const html = readFile('program.html');

  it('flags a conflicted day in the week-grid meta text', () => {
    expect(html).toMatch(/day\.selectionConflict/);
  });

  it('the day-modal conflict branch never renders an "Open planned workout" link', () => {
    const start = html.indexOf('if (day.selectionConflict)');
    const end = html.indexOf('} else if (day.plannedWork.length === 0 && day.plannedSession)');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const conflictBlock = html.slice(start, end);
    expect(conflictBlock).not.toMatch(/logger\.html\?session=/);
  });
});
