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
//
// Android Copy Button Reliability Fix §14 — the same extraction
// technique is used for copyTextToClipboard (the progressive
// Clipboard-API -> execCommand fallback) and createCopyController (the
// stale-attempt guard), each evaluated against controllable fake
// `navigator`/`document` objects so every required regression test
// (A-G) exercises the real shipped fallback logic, not a
// reimplementation of it.

import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from 'vitest';
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

let rawBuildCopyText: (initialNames: Array<[string, string]>) => (session: any, generated: any) => string;

/** Calls the real buildCopyText with a given PERSISTED exercise-name
 * catalog (Blueprint + approved outside-Blueprint, as loadExerciseNames
 * populates it in the real page) — the reliable identity-resolution
 * mechanism §1 requires. `namesById` defaults to empty, matching a
 * fetch that hasn't completed / returned nothing, so tests that don't
 * care about name resolution can omit it. */
function buildCopyText(session: any, generated: any, namesById: Array<[string, string]> = []): string {
  return rawBuildCopyText(namesById)(session, generated);
}

beforeAll(() => {
  const appJs = readFile('app.js');
  const loggerHtml = readFile('logger.html');

  const formatDateSrc = extractFunction(appJs, 'formatDate');
  const exerciseDisplayNameSrc = extractFunction(loggerHtml, 'exerciseDisplayName');
  const buildCopyTextSrc = extractFunction(loggerHtml, 'buildCopyText');

  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'initialNames',
    `
    let exerciseNamesById = new Map(initialNames);
    ${formatDateSrc}
    ${exerciseDisplayNameSrc}
    ${buildCopyTextSrc}
    return buildCopyText;
  `
  );
  rawBuildCopyText = factory as any;
});

// ---------- Android Copy Button Reliability Fix: fallback logic ----------

type CopyTextToClipboard = (text: string) => Promise<boolean>;
type CopyController = (
  text: string,
  callbacks: { onStart: () => void; onSuccess: () => void; onFailure: (text: string) => void; onClear: () => void }
) => Promise<void>;

let makeCopyTextToClipboard: (navigatorMock: any, documentMock: any) => CopyTextToClipboard;
let makeCopyController: (copyFn: CopyTextToClipboard) => CopyController;

beforeAll(() => {
  const loggerHtml = readFile('logger.html');
  // extractFunction's regex anchors on the literal `function` keyword, so
  // the real source's leading `async` (needed for `await` inside the
  // extracted body to be valid) is re-added here rather than captured.
  const copyTextToClipboardSrc = `async ${extractFunction(loggerHtml, 'copyTextToClipboard')}`;
  const createCopyControllerSrc = extractFunction(loggerHtml, 'createCopyController');

  // eslint-disable-next-line no-new-func
  const copyTextToClipboardFactory = new Function(
    'navigatorMock',
    'documentMock',
    `
    const navigator = navigatorMock;
    const document = documentMock;
    ${copyTextToClipboardSrc}
    return copyTextToClipboard;
  `
  );
  makeCopyTextToClipboard = copyTextToClipboardFactory as any;

  // eslint-disable-next-line no-new-func
  const createCopyControllerFactory = new Function(`${createCopyControllerSrc}\nreturn createCopyController;`);
  makeCopyController = createCopyControllerFactory() as any;
});

/** A fake DOM `document` sufficient for copyTextToClipboard's
 * execCommand fallback path: records every `<textarea>` it "creates" (so
 * a test can inspect exactly what value/selection the fallback set) and
 * lets a test control whether `execCommand('copy')` reports success. */
function makeDocumentMock(execCommandResult: boolean | (() => boolean) = true) {
  const created: Array<{ value: string; attached: boolean }> = [];
  const doc = {
    createElement: (_tag: string) => {
      const node: any = {
        value: '',
        style: {},
        attached: false,
        setAttribute: () => {},
        focus: () => {},
        select: () => {},
        setSelectionRange: () => {},
      };
      created.push(node);
      return node;
    },
    body: {
      appendChild: (node: any) => { node.attached = true; },
      removeChild: (node: any) => { node.attached = false; },
    },
    execCommand: (_name: string) => (typeof execCommandResult === 'function' ? execCommandResult() : execCommandResult),
    created,
  };
  return doc;
}

function makeNavigatorMock(writeText?: (text: string) => Promise<void>) {
  return writeText ? { clipboard: { writeText } } : {};
}

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
    // Pushdown -> Rope" substitution scenario the spec describes. The
    // persisted name catalog (not `generated`) resolves it.
    const session = { date: '2026-09-08', notes: null, exercises: [perf('cable-pushdown-rope', [{ weight: 25, reps: 12, completed: true }])] };
    const generated = { exercises: [{ exercise_id: 'cable-pushdown', exercise_name: 'Cable Pushdown' }, { exercise_id: 'cable-pushdown-rope', exercise_name: 'Cable Pushdown (Rope)' }] };
    const text = buildCopyText(session, generated, [
      ['cable-pushdown', 'Cable Pushdown'],
      ['cable-pushdown-rope', 'Cable Pushdown (Rope)'],
    ]);
    expect(text).toContain('Cable Pushdown (Rope)');
    expect(text).not.toMatch(/Cable Pushdown \(\d+ set/); // the plain prescribed name never stands in for the performed one
  });

  describe('Final Copy/Explanation Fixes §1/§2: real persisted-substitution regression (no transient substitution state)', () => {
    // Final Fixes §2's exact required scenario: `generated.exercises`
    // contains ONLY the originally-prescribed exercise (the program
    // itself is never mutated to include the substitute); the
    // performed session was logged under the substitute's own real
    // exercise id; there is no substitutions Map at all (buildCopyText
    // never receives one, matching a fresh page load/reload where the
    // in-memory Map from the original session is long gone). The ONLY
    // way this resolves correctly is through the persisted exercise
    // catalog (`namesById`, simulating the real /api/blueprint/exercises
    // + /api/outside-blueprint-exercises fetch) — never generated,
    // never a substitution map, never the raw id.
    const generatedPrescribedOnly = { exercises: [{ exercise_id: 'cable-pushdown', exercise_name: 'Cable Pushdown' }] };
    const persistedNames: Array<[string, string]> = [
      ['cable-pushdown', 'Cable Pushdown'],
      ['cable-pushdown-rope', 'Cable Pushdown (Rope)'],
    ];

    it('resolves the human-readable performed (substituted) name from the persisted catalog alone', () => {
      const session = { date: '2026-09-08', notes: null, exercises: [perf('cable-pushdown-rope', [{ weight: 25, reps: 12, completed: true }])] };
      const text = buildCopyText(session, generatedPrescribedOnly, persistedNames);
      expect(text).toContain('Cable Pushdown (Rope)');
      expect(text).not.toContain('cable-pushdown-rope'); // never the raw id
      // The plain prescribed name is not what got copied — this is the
      // performed variation, not the original prescription.
      expect(text).not.toMatch(/Cable Pushdown — \d+ set/);
    });

    it('still resolves correctly with generated entirely absent — the exact "reopened after reload/app restart" case', () => {
      const session = { date: '2026-09-08', notes: null, exercises: [perf('cable-pushdown-rope', [{ weight: 25, reps: 12, completed: true }])] };
      const text = buildCopyText(session, null, persistedNames);
      expect(text).toContain('Cable Pushdown (Rope)');
    });
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

  it('has a Copy button on the completed-day footer using the Clipboard API as the preferred mechanism', () => {
    expect(html).toMatch(/label:\s*'Copy'/);
    expect(html).toMatch(/navigator\.clipboard\.writeText\(text\)/);
  });

  it('shows a success state and a graceful manual-fallback message on failure, not silence', () => {
    expect(html).toMatch(/Copied to clipboard/);
    expect(html).toMatch(/Automatic copy failed\. Select the workout text below and copy it manually\./);
  });

  it('the button is skipped for badminton sessions, which have no performed-exercise table to copy', () => {
    expect(html).toMatch(/session\.session_type !== 'badminton'/);
  });

  it('never surfaces a raw browser exception to the user (spec §17)', () => {
    expect(html).not.toMatch(/NotAllowedError/);
  });

  it('feature-detects the Clipboard API rather than browser/device sniffing (spec §16)', () => {
    const copyTextToClipboardSrc = extractFunction(html, 'copyTextToClipboard');
    expect(copyTextToClipboardSrc).not.toMatch(/Android|Chrome|userAgent/i);
  });
});

describe('Android Copy Button Reliability Fix §14 Test A — modern Clipboard API succeeds', () => {
  it('copies via the modern API alone, with no fallback attempted, passing the exact canonical text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const documentMock = makeDocumentMock(true);
    const copy = makeCopyTextToClipboard(makeNavigatorMock(writeText), documentMock);

    const result = await copy('Workout — Tuesday\n\nHammer Curl — 2 set(s): 20×10, 20×8');

    expect(result).toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('Workout — Tuesday\n\nHammer Curl — 2 set(s): 20×10, 20×8');
    expect(documentMock.created.length).toBe(0); // no fallback textarea ever created
  });
});

describe('Android Copy Button Reliability Fix §14 Test B — modern API rejects, fallback succeeds', () => {
  it('attempts the execCommand fallback and reports success, copying the exact same text', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError: Failed to execute 'writeText'"));
    const documentMock = makeDocumentMock(true);
    const copy = makeCopyTextToClipboard(makeNavigatorMock(writeText), documentMock);
    const text = 'Workout — Tuesday\n\nHammer Curl — 1 set(s): 20×10';

    const result = await copy(text);

    expect(writeText).toHaveBeenCalledTimes(1); // the modern API really was attempted first
    expect(result).toBe(true); // this is the important regression: final state is success
    expect(documentMock.created.length).toBe(1); // the fallback really was attempted
    expect(documentMock.created[0]!.value).toBe(text); // the exact same canonical text
  });
});

describe('Android Copy Button Reliability Fix §14 Test C — Clipboard API unavailable, fallback succeeds', () => {
  it('skips straight to the fallback when navigator.clipboard does not exist, and succeeds', async () => {
    const documentMock = makeDocumentMock(true);
    const copy = makeCopyTextToClipboard(makeNavigatorMock(undefined), documentMock);

    const result = await copy('Workout — Tuesday\n\nHammer Curl — 1 set(s): 20×10');

    expect(result).toBe(true);
    expect(documentMock.created.length).toBe(1);
  });
});

describe('Android Copy Button Reliability Fix §14 Test D — both automatic mechanisms fail', () => {
  it('reports failure (never a false "Copied" state) when the modern API rejects and execCommand also fails', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    const documentMock = makeDocumentMock(false);
    const copy = makeCopyTextToClipboard(makeNavigatorMock(writeText), documentMock);

    const result = await copy('Workout — Tuesday\n\nHammer Curl — 1 set(s): 20×10');

    expect(result).toBe(false);
  });

  it('also reports failure when the fallback mechanism itself throws', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    const documentMock = makeDocumentMock(() => { throw new Error('execCommand unsupported'); });
    const copy = makeCopyTextToClipboard(makeNavigatorMock(writeText), documentMock);

    const result = await copy('Workout — Tuesday\n\nHammer Curl — 1 set(s): 20×10');

    expect(result).toBe(false);
  });
});

describe('Android Copy Button Reliability Fix §14 Test E — exact output preservation', () => {
  it('passes byte-identical text to both the modern API and the execCommand fallback — never a separately generated string', async () => {
    const text = buildCopyText(
      { date: '2026-09-08', notes: 'Used rope for pushdowns.', exercises: [perf('hammer-curl', [{ weight: 20, reps: 10, completed: true }])] },
      { exercises: [{ exercise_id: 'hammer-curl', exercise_name: 'Hammer Curl' }] }
    );

    const modernWriteText = vi.fn().mockResolvedValue(undefined);
    await makeCopyTextToClipboard(makeNavigatorMock(modernWriteText), makeDocumentMock(true))(text);
    const [modernText] = modernWriteText.mock.calls[0]!;

    const fallbackDocumentMock = makeDocumentMock(true);
    await makeCopyTextToClipboard(makeNavigatorMock(vi.fn().mockRejectedValue(new Error('denied'))), fallbackDocumentMock)(text);
    const fallbackText = fallbackDocumentMock.created[0]!.value;

    expect(modernText).toBe(text);
    expect(fallbackText).toBe(text);
    expect(modernText).toBe(fallbackText);
  });
});

describe('Android Copy Button Reliability Fix §14 Test F — repeated/overlapping copy attempts', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a slower first attempt that fails must not overwrite a faster second attempt that succeeded', async () => {
    let resolveFirst!: (v: boolean) => void;
    let resolveSecond!: (v: boolean) => void;
    const copyFn = vi
      .fn()
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveSecond = resolve; }));
    const attemptCopy = makeCopyController(copyFn);

    const first = { onStart: vi.fn(), onSuccess: vi.fn(), onFailure: vi.fn(), onClear: vi.fn() };
    const second = { onStart: vi.fn(), onSuccess: vi.fn(), onFailure: vi.fn(), onClear: vi.fn() };
    const p1 = attemptCopy('text', first);
    const p2 = attemptCopy('text', second);

    // Second attempt resolves (succeeds) BEFORE the first (which fails) —
    // exactly the race the stale-attempt guard exists for.
    resolveSecond(true);
    await p2;
    resolveFirst(false);
    await p1;

    expect(second.onSuccess).toHaveBeenCalledTimes(1);
    expect(first.onFailure).not.toHaveBeenCalled(); // the stale attempt's result was discarded
  });

  it('the reverse: a slower first attempt that succeeds must not overwrite a faster second attempt that failed', async () => {
    let resolveFirst!: (v: boolean) => void;
    let resolveSecond!: (v: boolean) => void;
    const copyFn = vi
      .fn()
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveSecond = resolve; }));
    const attemptCopy = makeCopyController(copyFn);

    const first = { onStart: vi.fn(), onSuccess: vi.fn(), onFailure: vi.fn(), onClear: vi.fn() };
    const second = { onStart: vi.fn(), onSuccess: vi.fn(), onFailure: vi.fn(), onClear: vi.fn() };
    const p1 = attemptCopy('text', first);
    const p2 = attemptCopy('text', second);

    resolveSecond(false);
    await p2;
    resolveFirst(true);
    await p1;

    expect(second.onFailure).toHaveBeenCalledTimes(1);
    expect(first.onSuccess).not.toHaveBeenCalled();
  });

  it('a superseded (stale) attempt never fires its own onClear timeout', async () => {
    let resolveOlder!: (v: boolean) => void;
    const copyFn = vi
      .fn()
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveOlder = resolve; }))
      .mockImplementationOnce(() => Promise.resolve(true));
    const attemptCopy = makeCopyController(copyFn);

    const older = { onStart: vi.fn(), onSuccess: vi.fn(), onFailure: vi.fn(), onClear: vi.fn() };
    const newer = { onStart: vi.fn(), onSuccess: vi.fn(), onFailure: vi.fn(), onClear: vi.fn() };
    const pOlder = attemptCopy('text', older); // attempt 1, left pending
    const pNewer = attemptCopy('text', newer); // attempt 2, resolves immediately
    await pNewer;
    resolveOlder(false); // attempt 1 finally resolves AFTER attempt 2 already won
    await pOlder;

    await vi.advanceTimersByTimeAsync(3000);
    expect(newer.onClear).toHaveBeenCalledTimes(1); // the genuinely current attempt clears normally
    expect(older.onClear).not.toHaveBeenCalled(); // the superseded attempt never even schedules one
  });
});

describe('Android Copy Button Reliability Fix §14 Test G — completed workout data is never touched by the copy path', () => {
  it('neither copyTextToClipboard nor createCopyController reference any workout-mutating API call', () => {
    const loggerHtml = readFile('logger.html');
    const copyTextToClipboardSrc = extractFunction(loggerHtml, 'copyTextToClipboard');
    const createCopyControllerSrc = extractFunction(loggerHtml, 'createCopyController');
    for (const src of [copyTextToClipboardSrc, createCopyControllerSrc]) {
      expect(src).not.toMatch(/api\(/); // never calls the app's own API helper
      expect(src).not.toMatch(/fetch\(/);
    }
  });
});
