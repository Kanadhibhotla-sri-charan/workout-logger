// Workout Programmer UI Fix §3/§11.C — the completed-day Copy button's
// underlying text formatter (logger.html's buildCopyText), tested as
// real executable logic rather than static markup matching (this
// repo's usual frontend-test style, e.g. tests/frontend/exercisePicker
// .test.ts, only checks for string presence — that isn't enough to
// prove buildCopyText's actual output is correct, which the spec's
// own §11.C explicitly asks for). Since this app has no browser/jsdom
// test harness, the exact pure functions buildCopyText depends on
// (itself, exerciseDisplayName from logger.html, formatDate from
// app.js — none of them touch the DOM) are extracted from the real
// source files by brace-balanced slicing and evaluated together via
// `new Function`, then called directly with fixture data. This proves
// the real shipped source, not a reimplementation of it.

import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '../../public');

function readFile(name: string): string {
  return readFileSync(join(publicDir, name), 'utf8');
}

/** Slices out exactly one top-level `function <name>(...) { ... }`
 * declaration from `source`, by counting braces from the function's
 * own opening `{` — robust to nested braces/strings containing braces
 * in the body, unlike a naive non-greedy regex. */
function extractFunction(source: string, name: string): string {
  const startMatch = source.match(new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`));
  if (!startMatch || startMatch.index === undefined) throw new Error(`function ${name} not found`);
  const bodyStart = startMatch.index + startMatch[0].length;
  let depth = 1;
  let i = bodyStart;
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
  }
  return source.slice(startMatch.index, i);
}

let buildCopyText: (session: any, generated: any) => string;

beforeAll(() => {
  const appJs = readFile('app.js');
  const loggerHtml = readFile('logger.html');

  const formatDateSrc = extractFunction(appJs, 'formatDate');
  const exerciseDisplayNameSrc = extractFunction(loggerHtml, 'exerciseDisplayName');
  const buildCopyTextSrc = extractFunction(loggerHtml, 'buildCopyText');

  // eslint-disable-next-line no-new-func
  const factory = new Function(`
    ${formatDateSrc}
    ${exerciseDisplayNameSrc}
    ${buildCopyTextSrc}
    return buildCopyText;
  `);
  buildCopyText = factory();
});

function perf(exerciseId: string, sets: Array<{ weight: number | null; reps: number | null; completed: boolean }>) {
  return { exercise_id: exerciseId, sets: sets.map((s, i) => ({ set_number: i + 1, ...s })) };
}

describe('logger.html buildCopyText — real executable formatter, not just markup', () => {
  it('includes the date/session context as the first line', () => {
    const text = buildCopyText({ date: '2026-09-08', notes: null, exercises: [] }, null);
    expect(text.split('\n')[0]).toContain('Workout —');
    expect(text).toContain('Tuesday'); // real weekday, not a placeholder
    expect(text).toContain('Sep 8'); // real date (same format formatDate uses app-wide)
  });

  it('includes every performed exercise row with its real logged sets — none silently omitted', () => {
    const session = {
      date: '2026-09-08',
      notes: null,
      exercises: [
        perf('hammer-curl', [{ weight: 20, reps: 10, completed: true }, { weight: 20, reps: 8, completed: true }]),
        perf('chest-supported-row', [{ weight: 40, reps: 10, completed: true }]),
      ],
    };
    const generated = {
      exercises: [
        { exercise_id: 'hammer-curl', exercise_name: 'Hammer Curl' },
        { exercise_id: 'chest-supported-row', exercise_name: 'Chest-Supported Row' },
      ],
    };
    const text = buildCopyText(session, generated);
    expect(text).toContain('Hammer Curl');
    expect(text).toContain('Chest-Supported Row');
    expect(text).toContain('20×10');
    expect(text).toContain('20×8');
    expect(text).toContain('40×10');
  });

  it('uses the PERFORMED exercise variation, not the originally prescribed one, when they differ (spec: copy what was actually performed)', () => {
    // The program prescribed cable-pushdown; the logged performance is
    // for a genuinely different exercise id — exactly the "Cable
    // Pushdown -> Rope" substitution scenario the spec describes,
    // modeled here as the exercise the user actually performed.
    const session = { date: '2026-09-08', notes: null, exercises: [perf('cable-pushdown-rope', [{ weight: 25, reps: 12, completed: true }])] };
    const generated = { exercises: [{ exercise_id: 'cable-pushdown', exercise_name: 'Cable Pushdown' }, { exercise_id: 'cable-pushdown-rope', exercise_name: 'Cable Pushdown (Rope)' }] };
    const text = buildCopyText(session, generated);
    expect(text).toContain('Cable Pushdown (Rope)');
    expect(text).not.toMatch(/Cable Pushdown \(\d+ set/); // the plain prescribed name never stands in for the performed one
  });

  it('includes an incomplete/skipped set faithfully, never fabricating a completed one', () => {
    const session = { date: '2026-09-08', notes: null, exercises: [perf('shrug', [{ weight: 60, reps: 8, completed: false }])] };
    const text = buildCopyText(session, null);
    expect(text).toContain('(skipped)');
  });

  it('includes the session note exactly once when present, and omits the section entirely when absent', () => {
    const withNote = buildCopyText({ date: '2026-09-08', notes: 'Used rope for pushdowns.', exercises: [] }, null);
    expect(withNote.match(/Session note:/g)?.length).toBe(1);
    expect(withNote).toContain('Session note: Used rope for pushdowns.');

    const withoutNote = buildCopyText({ date: '2026-09-08', notes: null, exercises: [] }, null);
    expect(withoutNote).not.toContain('Session note:');
  });

  it('never emits JSON, database ids, or debug fields — a clean handoff format', () => {
    const session = {
      date: '2026-09-08',
      notes: 'Felt strong today.',
      exercises: [perf('ez-bar-curl', [{ weight: 30, reps: 10, completed: true }])],
    };
    const generated = { exercises: [{ exercise_id: 'ez-bar-curl', exercise_name: 'EZ-Bar Curl' }] };
    const text = buildCopyText(session, generated);
    expect(text).not.toMatch(/[{}[\]]/); // no JSON/object punctuation anywhere
    expect(text).not.toMatch(/wsession_|physique_target|target_id|decisive_gate/);
  });

  it('is deterministic — identical input always produces identical output', () => {
    const session = { date: '2026-09-08', notes: 'note', exercises: [perf('hammer-curl', [{ weight: 20, reps: 10, completed: true }])] };
    const generated = { exercises: [{ exercise_id: 'hammer-curl', exercise_name: 'Hammer Curl' }] };
    expect(buildCopyText(session, generated)).toBe(buildCopyText(session, generated));
  });
});

describe('logger.html: Copy button wiring (source-level)', () => {
  const html = readFile('logger.html');

  it('has a Copy button on the completed-day footer using the Clipboard API', () => {
    expect(html).toMatch(/label:\s*'Copy'/);
    expect(html).toMatch(/navigator\.clipboard\.writeText\(text\)/);
  });

  it('shows a success state and a graceful fallback message on failure, not silence', () => {
    expect(html).toMatch(/Copied to clipboard/);
    expect(html).toMatch(/Couldn't copy automatically/);
  });

  it('the button is skipped for badminton sessions, which have no performed-exercise table to copy', () => {
    expect(html).toMatch(/session\.session_type !== 'badminton'/);
  });
});
