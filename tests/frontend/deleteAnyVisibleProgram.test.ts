// "Delete any visible program" fix (2026-09-23): reported live —
// "irrespective of what program it is... I need a delete button for any
// and every program that's visible in the app." Source-level assertions
// (this repo has no browser/jsdom harness) for the one remaining gap:
// the plain deterministic plan itself. A real committed session already
// had its own delete (renderSessionActions -> DELETE /api/workouts/:id)
// and a pending/approved AI proposal already had its own /reject —
// covered by tests/frontend/aiProposalUI.test.ts and
// weekReconciliationUI.test.ts respectively.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '../../public');

function readFile(name: string): string {
  return readFileSync(join(publicDir, name), 'utf8');
}

describe('program.html: renderPlanDeleteAction — deletes a day\'s deterministic plan', () => {
  const html = readFile('program.html');
  const fnBody = html.slice(html.indexOf('function renderPlanDeleteAction('), html.indexOf('/** Read-only preview of a real, already-committed session'));

  it('never renders for a day with nothing persisted, or a locked (completed/in-progress) day', () => {
    expect(fnBody).toMatch(/if \(day\.plannedWork\.length === 0\) return;/);
    expect(fnBody).toMatch(/if \(day\.status === 'completed' \|\| day\.status === 'in_progress'\) return;/);
  });

  it('calls the real DELETE /api/programming/week/days/:day/plan endpoint', () => {
    expect(fnBody).toMatch(/api\(`\/api\/programming\/week\/days\/\$\{day\.weekday\}\/plan`, \{ method: 'DELETE' \}\)/);
  });

  it('closes the modal and reloads the week on success, mirroring every other mutating action on this page', () => {
    expect(fnBody).toMatch(/closeDayModal\(\);\s*\n\s*await loadWeek\(\);/);
  });

  it('is wired into the day modal, right where the plan\'s own exercises are rendered', () => {
    expect(html).toMatch(/renderPlanDeleteAction\(day, planDeleteEl, planDeleteStatusEl\)/);
  });
});
