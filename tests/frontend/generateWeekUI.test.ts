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

  // Week-batch eligibility fix (2026-09-28): onGenerateWeek() previously
  // sent every non-completed/non-in-progress day straight to
  // generate-session, including a real rest/badminton day or a gym day
  // with no decided session purpose — both structurally doomed to fail
  // (see the forensic investigation this fix resolves). These tests
  // cover the required eligibility matrix, reusing the EXISTING
  // day.type/day.sessionPurpose fields the week response already
  // carries — never a second source of truth.
  describe('eligibility: skips a day before ever calling generate-session', () => {
    it('a non-gym/rest day is skipped with a clear reason, before any API call', () => {
      expect(generateWeekSource).toMatch(/day\.type !== 'gym'/);
      expect(generateWeekSource).toMatch(/Not a gym training day\./);
    });

    it('a badminton day is caught by the SAME day.type check — never a second, badminton-specific rule', () => {
      // day.type for a real badminton day is the literal string
      // 'badminton' (see nonGymDayType/renderWeekDays) — the single
      // `day.type !== 'gym'` guard above already catches it; there is
      // deliberately no separate `=== 'badminton'` branch to duplicate.
      expect(generateWeekSource).not.toMatch(/day\.type === 'badminton'/);
      expect(generateWeekSource).not.toMatch(/day\.activity === 'badminton'/);
    });

    it('a gym day with no decided session purpose is skipped with an actionable message, before any generate-session call', () => {
      expect(generateWeekSource).toMatch(/!day\.sessionPurpose/);
      expect(generateWeekSource).toMatch(/No session purpose set — open this day and choose a specific purpose \(Push, Pull, Legs, or Upper\)\./);
    });

    it('both new eligibility checks run AFTER the existing completed/in-progress check and BEFORE the existing pending-proposal check — order preserved, nothing reordered', () => {
      const completedIdx = generateWeekSource.indexOf("day.status === 'completed'");
      const notGymIdx = generateWeekSource.indexOf("day.type !== 'gym'");
      const noPurposeIdx = generateWeekSource.indexOf('!day.sessionPurpose');
      const pendingIdx = generateWeekSource.indexOf('aiProposalActionsFor(existing');
      expect(completedIdx).toBeGreaterThan(-1);
      expect(notGymIdx).toBeGreaterThan(completedIdx);
      expect(noPurposeIdx).toBeGreaterThan(notGymIdx);
      expect(pendingIdx).toBeGreaterThan(noPurposeIdx);
    });

    it('both new checks `continue` immediately — never fall through to a network call for the same iteration', () => {
      const notGymIfIdx = generateWeekSource.indexOf("if (day.type !== 'gym')");
      const notGymBlock = generateWeekSource.slice(notGymIfIdx, notGymIfIdx + 200);
      expect(notGymIfIdx).toBeGreaterThan(-1);
      expect(notGymBlock).toMatch(/continue;/);
      const noPurposeIfIdx = generateWeekSource.indexOf('if (!day.sessionPurpose)');
      const noPurposeBlock = generateWeekSource.slice(noPurposeIfIdx, noPurposeIfIdx + 260);
      expect(noPurposeIfIdx).toBeGreaterThan(-1);
      expect(noPurposeBlock).toMatch(/continue;/);
    });

    it('a real gym day WITH a decided session purpose falls through both new guards and reaches generate-session — the existing happy path is unchanged', () => {
      // Structural proof: the two new guards are the ONLY new gates
      // added, both scoped to a falsy condition (day.type !== 'gym',
      // !day.sessionPurpose) — a day satisfying neither (a real gym day
      // with a real purpose) necessarily falls through to the
      // pre-existing pending-proposal check and, beyond that, the
      // pre-existing generate-session call — both still present and
      // untouched below the new guards.
      const pendingIdx = generateWeekSource.indexOf('aiProposalActionsFor(existing');
      const generateCallIdx = generateWeekSource.indexOf("aiApi('/api/ai-programmer/generate-session'");
      expect(pendingIdx).toBeGreaterThan(-1);
      expect(generateCallIdx).toBeGreaterThan(pendingIdx);
    });

    it('the completed/in-progress skip behavior is unchanged — still the first check, still using day.status', () => {
      const completedIdx = generateWeekSource.indexOf("day.status === 'completed' || day.status === 'in_progress'");
      const notGymIdx = generateWeekSource.indexOf("day.type !== 'gym'");
      expect(completedIdx).toBeGreaterThan(-1);
      expect(completedIdx).toBeLessThan(notGymIdx);
    });
  });
});
