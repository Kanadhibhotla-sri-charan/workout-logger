// Generate-whole-week button: program.html must expose a single action
// that asks the AI Programmer for a proposal on every eligible day of
// the week, reusing the exact same per-day endpoints
// (GET /proposals/latest, POST /generate-session) and the exact same
// aiProposalActionsFor eligibility rule the per-day "AI Workout
// Proposal" section (buildAiProposalSection) already uses — never a
// second, invented batch endpoint or eligibility rule.

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

/** The buildGenerateWeekControl() function's own source text, extracted
 * so assertions are scoped to that function — never accidentally
 * matching an unrelated occurrence of the same string elsewhere on this
 * large page (e.g. "generate-session" also appears in the per-day AI
 * proposal section). */
const generateWeekSource = (() => {
  const start = html.indexOf('function buildGenerateWeekControl');
  if (start === -1) return '';
  const returnIdx = html.indexOf('return section;', start);
  const closeIdx = html.indexOf('\n    }', returnIdx); // the function's own closing brace, 4-space indent
  return html.slice(start, closeIdx === -1 ? undefined : closeIdx + '\n    }'.length);
})();

describe('program.html: generate-whole-week control', () => {
  it('has a visible Generate-week control on the weekly schedule', () => {
    expect(html).toMatch(/buildGenerateWeekControl/);
    expect(html).toMatch(/Generate AI proposals for the week/);
  });

  it('is rendered into the week view', () => {
    expect(html).toMatch(/container\.appendChild\(buildGenerateWeekControl\(\)\)/);
  });

  it('actually captured the buildGenerateWeekControl function body (sanity check for the extraction above)', () => {
    expect(generateWeekSource.length).toBeGreaterThan(200);
    expect(generateWeekSource).toMatch(/return section;/);
  });

  it('reuses the existing single-day generate and discovery endpoints, never a batch endpoint', () => {
    expect(generateWeekSource).toMatch(/\/api\/ai-programmer\/generate-session/);
    expect(generateWeekSource).toMatch(/\/api\/ai-programmer\/proposals\/latest/);
    expect(generateWeekSource).not.toMatch(/generate-week|batch-generate|generate-all/);
  });

  it('reuses aiProposalActionsFor as the single eligibility source, never a second rule', () => {
    expect(generateWeekSource).toMatch(/aiProposalActionsFor\(existing \? existing\.status : null\)\.canGenerate/);
  });

  it('skips a day with a completed/in-progress workout without ever calling the API for it', () => {
    expect(generateWeekSource).toMatch(/day\.status === 'completed' \|\| day\.status === 'in_progress'/);
  });

  it('processes days sequentially (awaits each iteration), never firing all requests in parallel', () => {
    expect(generateWeekSource).toMatch(/for \(let i = 0; i < days\.length; i\+\+\)/);
    expect(generateWeekSource).not.toMatch(/Promise\.all/);
  });

  it('never commits or approves anything itself — only creates proposals for later review', () => {
    expect(generateWeekSource).not.toMatch(/aiApi\(`?\/api\/ai-programmer\/proposals\/[^`]*\/(approve|commit)/);
    expect(generateWeekSource).toMatch(/open this day to review it/);
  });

  it('shows a per-day outcome summary via the shared inline-status helper, never alert()', () => {
    expect(generateWeekSource).toMatch(/showInlineStatus\(/);
    expect(generateWeekSource).not.toMatch(/alert\(/);
  });

  it('derives the day list from the real current week, never a hardcoded weekday set', () => {
    expect(generateWeekSource).toMatch(/const days = weekData\.days;/);
  });
});
