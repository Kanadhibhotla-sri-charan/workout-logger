// Goals page check-in (2026-10-11): the assessments API existed but the page
// had no way to record one. Source-level wiring checks, like the other
// frontend tests.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = readFileSync(join(process.cwd(), 'public', 'index.html'), 'utf8');

describe('index.html: goal check-in', () => {
  it('offers a Check in button on active aesthetic goals', () => {
    expect(html).toMatch(/goal\.active && goal\.goal_type === 'aesthetic'/);
    expect(html).toMatch(/label: 'Check in'/);
  });

  it('posts the date, a 1-5 rating and notes to the assessments API', () => {
    expect(html).toMatch(/api\(`\/api\/goals\/\$\{goal\.id\}\/assessments`, \{ method: 'POST', body: \{ date: dateInput\.value, rating: Number\(chosen\.value\)/);
    for (const label of ['Significantly worse', 'Slightly worse', 'No meaningful change', 'Improved', 'Significantly improved']) expect(html).toContain(label);
  });

  it('shows the last check-in and when the next is due', () => {
    expect(html).toMatch(/Last check-in \$\{formatDate\(last\.date\)\}/);
    expect(html).toMatch(/goal\.review_cadence_days/);
  });
});
