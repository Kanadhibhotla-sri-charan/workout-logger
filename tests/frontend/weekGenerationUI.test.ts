// Explicit week generation UI (2026-10-01): program.html's week view shows
// the backend's own `generation` state (GET /api/programming/week) and
// offers ONE action, POST /api/ai-programmer/generate-week. The display
// mapping (weekGenerationView, app.js) is pure and exercised directly; the
// control's wiring is checked against program.html's source, like the
// other frontend tests here.

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(__dirname, '../..', rel), 'utf8');
const appJs = read('public/app.js');
const html = read('public/program.html');
const backend = read('src/ai-programmer/service/weekGeneration.ts');

function extractBlock(source: string, pattern: RegExp): string {
  const m = source.match(pattern);
  if (!m || m.index === undefined) throw new Error(`${pattern} not found`);
  let depth = 1;
  let i = m.index + m[0].length;
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
  }
  if (/^const/.test(m[0])) while (i < source.length && source[i] !== ';') i++;
  return source.slice(m.index, i + (/^const/.test(m[0]) ? 1 : 0));
}
const fn = (src: string, name: string) => extractBlock(src, new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`));
const constObj = (src: string, name: string) => extractBlock(src, new RegExp(`const\\s+${name}\\s*=\\s*\\{`));

interface View {
  status: string;
  headline: string;
  isGenerating: boolean;
  canStart: boolean;
  notice: string | null;
  retryAfter: string | null;
  days: Array<{ date: string; weekday: string; purpose: string | null; label: string; tone: string }>;
}
let weekGenerationView: (g: unknown) => View;
let maps: { headlines: Record<string, string>; reasons: Record<string, string>; dayStatus: Record<string, { label: string; tone: string }>; errors: Record<string, string> };

beforeAll(() => {
  const src = [
    constObj(appJs, 'WEEK_GENERATION_HEADLINES'),
    constObj(appJs, 'WEEK_GENERATION_REASONS'),
    constObj(appJs, 'WEEK_GENERATION_DAY_STATUS'),
    constObj(appJs, 'AI_ERROR_MESSAGES'),
    fn(appJs, 'weekGenerationView'),
    'return { weekGenerationView, maps: { headlines: WEEK_GENERATION_HEADLINES, reasons: WEEK_GENERATION_REASONS, dayStatus: WEEK_GENERATION_DAY_STATUS, errors: AI_ERROR_MESSAGES } };',
  ].join('\n');
  const loaded = new Function(src)();
  weekGenerationView = loaded.weekGenerationView;
  maps = loaded.maps;
});

const day = (status: string, extra: Record<string, unknown> = {}) => ({ date: '2026-10-05', weekday: 'monday', purpose: 'push', status, ...extra });

describe('weekGenerationView — pure mapping of the backend state', () => {
  it('not_generated + canGenerate → the action is offered', () => {
    const v = weekGenerationView({ status: 'not_generated', canGenerate: true, perDay: [day('not_generated')] });
    expect(v).toMatchObject({ status: 'not_generated', canStart: true, isGenerating: false, notice: null, retryAfter: null });
    expect(v.headline).toMatch(/haven't been generated yet/);
    expect(v.days).toEqual([{ date: '2026-10-05', weekday: 'monday', purpose: 'push', label: 'Not generated', tone: 'neutral' }]);
  });

  it('generating → in progress, never startable (no duplicate starts), even if canGenerate were true', () => {
    const v = weekGenerationView({ status: 'generating', canGenerate: true, reason: 'in_progress', runId: 'r', perDay: [day('proposal_pending'), day('generating')] });
    expect(v).toMatchObject({ isGenerating: true, canStart: false });
    expect(v.notice).toMatch(/in progress/);
    expect(v.days.map((d) => d.label)).toEqual(['Proposal ready — open the day to review', 'Generating…']);
  });

  it('partially_generated / generated / failed each have their own headline', () => {
    expect(weekGenerationView({ status: 'partially_generated', canGenerate: true }).headline).toMatch(/Some of this week/);
    expect(weekGenerationView({ status: 'generated', canGenerate: false, reason: 'nothing_to_generate' }).headline).toMatch(/ready to review/);
    expect(weekGenerationView({ status: 'failed', canGenerate: true }).headline).toMatch(/failed/);
  });

  it('provider unavailable / backoff → the backend reason and its retry time; not startable', () => {
    const v = weekGenerationView({ status: 'failed', canGenerate: false, reason: 'provider_unavailable', retryAfter: '2026-10-03T03:30:04.823Z', perDay: [day('failed_provider', { code: 'AI_PROVIDER_AUTHENTICATION_ERROR' })] });
    expect(v).toMatchObject({ canStart: false, retryAfter: '2026-10-03T03:30:04.823Z' });
    expect(v.notice).toMatch(/provider is unavailable/);
    expect(v.days[0]).toMatchObject({ label: 'AI provider unavailable', tone: 'danger' });
  });

  it('canStart follows the backend only — never true when canGenerate is false', () => {
    for (const reason of ['outside_window', 'nothing_to_generate', 'disabled', 'in_progress', 'provider_unavailable']) {
      expect(weekGenerationView({ status: 'not_generated', canGenerate: false, reason }).canStart, reason).toBe(false);
    }
  });

  it('an unknown future status degrades to a neutral label, never a raw code', () => {
    const v = weekGenerationView({ status: 'something_new', perDay: [day('something_new')] });
    expect(v.days[0]!.label).toBe('Not generated');
    expect(v.headline).toBe(maps.headlines.not_generated);
    expect(weekGenerationView(undefined).days).toEqual([]);
  });
});

describe('UI vocabulary covers the backend contract exactly', () => {
  const unionMembers = (typeName: string) => {
    const m = backend.match(new RegExp(`export type ${typeName} =([\\s\\S]*?);`));
    if (!m) throw new Error(`${typeName} not found`);
    return [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!).sort();
  };
  const stateInterface = (() => {
    const start = backend.indexOf('export interface WeekGenerationState {');
    return backend.slice(start, backend.indexOf('\n}', start));
  })();
  const fieldUnion = (field: string) => {
    const m = stateInterface.match(new RegExp(`\\n  ${field}\\??: ([^;]+);`));
    if (!m) throw new Error(`${field} not found`);
    return [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!).sort();
  };

  it('every per-day status the backend can report has a label', () => {
    expect(Object.keys(maps.dayStatus).sort()).toEqual(unionMembers('WeekDayGenerationStatus'));
  });
  it('every week status and reason the backend can report has text', () => {
    expect(Object.keys(maps.headlines).sort()).toEqual(fieldUnion('status'));
    expect(Object.keys(maps.reasons).sort()).toEqual(fieldUnion('reason'));
  });
  it('every week-generation error code is mapped to a safe sentence', () => {
    for (const code of ['AI_WEEK_GENERATION_DISABLED', 'AI_WEEK_GENERATION_NOT_ALLOWED', 'AI_WEEK_GENERATION_NOTHING_TO_DO', 'AI_WEEK_GENERATION_BACKOFF', 'AI_WEEK_GENERATION_IN_PROGRESS']) {
      expect(maps.errors[code], code).toBeTruthy();
      expect(maps.errors[code]).not.toMatch(/AI_WEEK/);
    }
  });
  it('tones are existing badge styles', () => {
    const css = read('public/style.css');
    for (const { tone } of Object.values(maps.dayStatus)) expect(css, tone).toMatch(new RegExp(`\\.badge-${tone}\\b`));
  });
});

describe('program.html — the week generation control', () => {
  const control = fn(html, 'buildWeekGenerationControl');
  const refresh = fn(html, 'refreshWeekGenerationState');
  const schedule = fn(html, 'scheduleWeekGenerationRefresh');
  const legacy = fn(html, 'buildGenerateWeekControl');

  it('is used only when the backend reports a generation state; legacy keeps the old control', () => {
    expect(legacy).toMatch(/if \(weekData\.generation\) return buildWeekGenerationControl\(weekData\.generation\);/);
    expect(legacy).toMatch(/Generate AI proposals for the week/); // legacy path untouched
  });

  it("offers exactly one action — POST /generate-week for this week — labelled \"Generate this week's AI sessions\"", () => {
    expect(control).toMatch(/Generate this week's AI sessions/);
    expect(control).toMatch(/aiApi\('\/api\/ai-programmer\/generate-week', \{ method: 'POST', body: \{ weekStart: weekData\.weekStart \} \}\)/);
    expect(control).not.toMatch(/generate-session|proposals\/latest|reconcile-week/);
  });

  it('prevents duplicate starts: disabled unless the backend allows it, and an in-flight guard', () => {
    expect(control).toMatch(/disabled: !view\.canStart/);
    expect(control).toMatch(/if \(inFlight \|\| !view\.canStart\) return;/);
    expect(control).toMatch(/btn\.disabled = true;/);
  });

  it('follows a run only through the backend state: refreshes GET /week while it says generating, one timer at a time', () => {
    expect(control).toMatch(/if \(view\.isGenerating\) scheduleWeekGenerationRefresh\(\);/);
    expect(refresh).toMatch(/weekData = await api\('\/api\/programming\/week'\);/);
    expect(refresh).toMatch(/renderWeek\(\);/);
    expect(schedule).toMatch(/if \(weekGenerationRefreshTimer\) return;/);
    expect(refresh + schedule).not.toMatch(/generate-week|generate-session/);
  });

  it('shows per-day status from the backend only, and sends the user to the existing per-day review', () => {
    expect(control).toMatch(/for \(const d of view\.days\)/);
    expect(control).toMatch(/badge badge-\$\{d\.tone\}/);
    expect(control).toMatch(/open a day and approve and commit/);
    expect(control).not.toMatch(/plannedWork|exercises/); // never a second copy of the workouts
  });

  it('surfaces errors through the existing mapped messages and the backend retry time', () => {
    expect(control).toMatch(/showInlineStatus\(statusEl, 'error', err\.message\)/);
    expect(control).toMatch(/You can try again after \$\{formatTimestamp\(view\.retryAfter\)\}/);
  });
});
