// Blueprint Picker/Daily Activity spec §5/§9/§11/§18: source-level
// regressions proving the old "Training days" multi-select + free-text
// "Recurring activities" list are gone from profile.html, replaced by
// one Gym/Badminton/Both/Rest control per weekday, and that
// program.html exposes an obvious way to change a day's activity from
// the existing weekly program (never requiring a full regenerate).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '../../public');

function readFile(name: string): string {
  return readFileSync(join(publicDir, name), 'utf8');
}

describe('profile.html: unified per-day Gym/Badminton/Both/Rest schedule', () => {
  const html = readFile('profile.html');

  it('no longer has the old "Training days" multi-select', () => {
    expect(html).not.toMatch(/id="training-days"/);
  });

  it('no longer has the old free-text "Recurring activities" list', () => {
    expect(html).not.toMatch(/id="activity-list"/);
    expect(html).not.toMatch(/id="add-activity"/);
  });

  it('has the new unified weekly schedule control', () => {
    expect(html).toMatch(/id="daily-activity-list"/);
    expect(html).toMatch(/Weekly training schedule/);
  });

  it('offers exactly Gym/Badminton/Both/Rest, with no separate stored "rest" enum', () => {
    expect(html).toMatch(/DAILY_ACTIVITY_OPTIONS/);
    expect(html).toMatch(/value: 'gym', text: 'Gym'/);
    expect(html).toMatch(/value: 'badminton', text: 'Badminton'/);
    expect(html).toMatch(/value: 'both', text: 'Both'/);
    expect(html).toMatch(/value: 'unselected', text: 'Rest'/);
  });

  it('preserves non-badminton recurring activities and existing badminton notes on Save (spec §5: do not delete old data)', () => {
    expect(html).toMatch(/preservedNonBadmintonActivities/);
    expect(html).toMatch(/originalBadmintonNotesByDay/);
  });
});

describe('program.html: an obvious way to change a day\'s activity from the existing weekly program', () => {
  const html = readFile('program.html');

  it('has a Change Activity control in the day modal', () => {
    expect(html).toMatch(/buildChangeActivitySection/);
    expect(html).toMatch(/Change activity/);
  });

  it('writes through the small, focused current-week endpoint — never the recurring-profile endpoint (Current-Week Reconciliation Fix §11/§13)', () => {
    expect(html).toMatch(/\/api\/programming\/week\/days\/\$\{day\.weekday\}\/activity/);
    expect(html).not.toMatch(/\/api\/training-profile\/daily-activities/);
  });

  it('tells the user this changes only the current week, not the recurring Training Profile default (spec §13)', () => {
    expect(html).toMatch(/only the current week/i);
  });

  it('reloads the week after a successful change instead of requiring a manual refresh', () => {
    expect(html).toMatch(/await loadWeek\(\)/);
  });

  it('surfaces a "Both" day\'s badminton component on the week grid card, not just inside the modal', () => {
    expect(html).toMatch(/day\.activity === 'both'/);
  });
});
