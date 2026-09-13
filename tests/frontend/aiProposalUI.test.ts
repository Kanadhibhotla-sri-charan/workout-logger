// AI Programmer Proposal Review UI
// (docs/CLAUDE_TASK_AI_PROGRAMMER_PROPOSAL_REVIEW_UI.md §7): this app
// has no browser/jsdom test harness, so the real pure logic the new UI
// depends on (error-code mapping, the fetch wrapper's safety guarantee,
// the lifecycle button-gating decision, and the formatting helpers) is
// extracted from the real shipped app.js by brace-balanced slicing and
// evaluated via `new Function`, then exercised directly with fixture
// data — the same technique tests/frontend/copyWorkoutText.test.ts
// established for buildCopyText/copyTextToClipboard. DOM wiring that
// isn't meaningfully testable this way (which button renders for which
// status, which endpoint each action calls) is instead covered by
// source-level assertions against public/program.html, matching this
// repo's other frontend tests (e.g. tests/frontend/dailyActivityUI
// .test.ts).

import { describe, expect, it, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '../../public');

function readFile(name: string): string {
  return readFileSync(join(publicDir, name), 'utf8');
}

/** Slices out exactly one top-level `function <name>(...) { ... }`
 * declaration, by counting braces from its own opening `{` — see
 * copyWorkoutText.test.ts for the original of this helper. */
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

/** Slices out exactly one top-level `const <name> = { ... };` object
 * literal declaration, by the same brace-counting technique. */
function extractConst(source: string, name: string): string {
  const startMatch = source.match(new RegExp(`const\\s+${name}\\s*=\\s*\\{`));
  if (!startMatch || startMatch.index === undefined) throw new Error(`const ${name} not found`);
  const bodyStart = startMatch.index + startMatch[0].length;
  let depth = 1;
  let i = bodyStart;
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
  }
  while (i < source.length && source[i] !== ';') i++;
  return source.slice(startMatch.index, i + 1);
}

interface AiHelpers {
  mapAiErrorCode: (code?: string | null) => string;
  aiApi: (path: string, options?: { method?: string; body?: unknown; headers?: Record<string, string> }) => Promise<any>;
  aiProposalActionsFor: (status: string | null | undefined) => { canGenerate: boolean; canApprove: boolean; canCommit: boolean; isCommitted: boolean };
  formatRirRange: (min: number, max: number) => string;
  formatRestSeconds: (seconds: number | null | undefined) => string | null;
  capitalize: (word: string) => string;
  formatTimestamp: (iso: string | null | undefined) => string;
}

let makeAiHelpers: (fetchMock: unknown) => AiHelpers;

beforeAll(() => {
  const appJs = readFile('app.js');

  const aiErrorMessagesSrc = extractConst(appJs, 'AI_ERROR_MESSAGES');
  const mapAiErrorCodeSrc = extractFunction(appJs, 'mapAiErrorCode');
  // extractFunction anchors on the literal `function` keyword, so the
  // real source's leading `async` is re-added here rather than
  // captured (same technique copyWorkoutText.test.ts uses for
  // copyTextToClipboard).
  const aiApiSrc = `async ${extractFunction(appJs, 'aiApi')}`;
  const aiProposalActionsForSrc = extractFunction(appJs, 'aiProposalActionsFor');
  const formatRangeSrc = extractFunction(appJs, 'formatRange');
  const formatRirRangeSrc = extractFunction(appJs, 'formatRirRange');
  const formatRestSecondsSrc = extractFunction(appJs, 'formatRestSeconds');
  const capitalizeSrc = extractFunction(appJs, 'capitalize');
  const formatTimestampSrc = extractFunction(appJs, 'formatTimestamp');

  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'fetch',
    `
    ${aiErrorMessagesSrc}
    ${mapAiErrorCodeSrc}
    ${aiApiSrc}
    ${aiProposalActionsForSrc}
    ${formatRangeSrc}
    ${formatRirRangeSrc}
    ${formatRestSecondsSrc}
    ${capitalizeSrc}
    ${formatTimestampSrc}
    return { mapAiErrorCode, aiApi, aiProposalActionsFor, formatRirRange, formatRestSeconds, capitalize, formatTimestamp };
    `
  );
  makeAiHelpers = factory as any;
});

function fakeResponse(ok: boolean, body: unknown) {
  return { ok, json: async () => body };
}

// ---------- mapAiErrorCode / AI_ERROR_MESSAGES ----------

describe('mapAiErrorCode: every documented backend error code maps to a safe, concise message', () => {
  it('maps disabled/expired/conflict/stale/invalid-state/not-editable to their documented safe messages', () => {
    const helpers = makeAiHelpers(vi.fn());
    expect(helpers.mapAiErrorCode('AI_PROGRAMMER_DISABLED')).toMatch(/disabled/i);
    expect(helpers.mapAiErrorCode('AI_TARGET_NOT_EDITABLE')).toMatch(/can't be edited/i);
    expect(helpers.mapAiErrorCode('AI_PROPOSAL_EXPIRED')).toMatch(/expired/i);
    expect(helpers.mapAiErrorCode('AI_PROPOSAL_CONFLICT')).toMatch(/planned workout already exists/i);
    expect(helpers.mapAiErrorCode('AI_PROPOSAL_STALE')).toMatch(/out of date/i);
    expect(helpers.mapAiErrorCode('AI_PROPOSAL_INVALID_STATE')).toMatch(/status/i);
    expect(helpers.mapAiErrorCode('AI_PROVIDER_UNAVAILABLE')).toMatch(/temporarily unavailable/i);
  });

  it('never returns the raw code itself as the message', () => {
    const helpers = makeAiHelpers(vi.fn());
    for (const code of ['AI_PROGRAMMER_DISABLED', 'AI_PROPOSAL_EXPIRED', 'AI_PROPOSAL_CONFLICT', 'AI_OUTPUT_SCHEMA_INVALID']) {
      expect(helpers.mapAiErrorCode(code)).not.toBe(code);
    }
  });

  it('falls back to a generic safe message for an unknown or missing code', () => {
    const helpers = makeAiHelpers(vi.fn());
    expect(helpers.mapAiErrorCode('SOME_FUTURE_CODE_NOT_YET_MAPPED')).toBe('Something went wrong. Please try again.');
    expect(helpers.mapAiErrorCode(undefined)).toBe('Something went wrong. Please try again.');
    expect(helpers.mapAiErrorCode(null)).toBe('Something went wrong. Please try again.');
  });
});

// ---------- aiApi: the safety-guaranteeing fetch wrapper ----------

describe('aiApi: never surfaces raw backend message/details/stack text, always throws a pre-mapped safe error', () => {
  it('returns the parsed body on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(true, { ok: true, proposalId: 'p-1', status: 'pending' }));
    const { aiApi } = makeAiHelpers(fetchMock);
    const result = await aiApi('/api/ai-programmer/proposals/p-1');
    expect(result).toEqual({ ok: true, proposalId: 'p-1', status: 'pending' });
  });

  it('sends a JSON body and content-type header for a POST call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(true, { ok: true }));
    const { aiApi } = makeAiHelpers(fetchMock);
    await aiApi('/api/ai-programmer/generate-session', { method: 'POST', body: { targetDate: '2026-09-20' } });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/ai-programmer/generate-session',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ targetDate: '2026-09-20' }),
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      })
    );
  });

  it('a structured backend error (with a distinctive internal message/details) throws only the mapped safe text', async () => {
    const DISTINCTIVE = 'SQLITE_CONSTRAINT: FOREIGN KEY on internal_table_xyz; column proposal_json';
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse(false, {
        ok: false,
        error: 'AI_TARGET_NOT_EDITABLE',
        message: DISTINCTIVE,
        details: { internalColumn: 'xyz', proposalId: 'p-1' },
      })
    );
    const { aiApi } = makeAiHelpers(fetchMock);
    await expect(aiApi('/api/ai-programmer/generate-session', { method: 'POST', body: {} })).rejects.toMatchObject({
      message: expect.stringMatching(/can't be edited/i),
      code: 'AI_TARGET_NOT_EDITABLE',
    });
    // Re-run and inspect the actual thrown message text directly.
    try {
      await aiApi('/api/ai-programmer/generate-session', { method: 'POST', body: {} });
      throw new Error('expected aiApi to throw');
    } catch (err: any) {
      expect(err.message).not.toContain(DISTINCTIVE);
      expect(err.message).not.toContain('internalColumn');
      expect(err.message).not.toContain('SQLITE_CONSTRAINT');
    }
  });

  it('an ok:false body even with HTTP 200 still throws a mapped error (defense in depth)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(true, { ok: false, error: 'AI_PROPOSAL_EXPIRED', message: 'internal detail' }));
    const { aiApi } = makeAiHelpers(fetchMock);
    await expect(aiApi('/x')).rejects.toMatchObject({ message: expect.stringMatching(/expired/i) });
  });

  it('a non-JSON/malformed response body never throws a raw parse error — falls back to the generic safe message', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => { throw new SyntaxError('Unexpected token < in JSON'); } });
    const { aiApi } = makeAiHelpers(fetchMock);
    await expect(aiApi('/x')).rejects.toMatchObject({ message: 'Something went wrong. Please try again.' });
  });

  it('a network-level fetch failure never surfaces the raw browser/network error text', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch: net::ERR_CONNECTION_REFUSED'));
    const { aiApi } = makeAiHelpers(fetchMock);
    await expect(aiApi('/x')).rejects.toMatchObject({ message: 'Something went wrong. Please try again.' });
  });
});

// ---------- aiProposalActionsFor: the lifecycle button-gating rule ----------

describe('aiProposalActionsFor: exactly one action is available per lifecycle status (the actual "which button shows" rule)', () => {
  let aiProposalActionsFor: AiHelpers['aiProposalActionsFor'];
  beforeAll(() => {
    ({ aiProposalActionsFor } = makeAiHelpers(vi.fn()));
  });

  it('offers only Generate before any proposal exists', () => {
    expect(aiProposalActionsFor(null)).toEqual({ canGenerate: true, canApprove: false, canCommit: false, isCommitted: false });
  });

  it('offers only Approve for a pending proposal — never Commit', () => {
    const actions = aiProposalActionsFor('pending');
    expect(actions.canApprove).toBe(true);
    expect(actions.canCommit).toBe(false);
    expect(actions.canGenerate).toBe(false);
  });

  it('offers only Commit for an approved proposal — never Approve again', () => {
    const actions = aiProposalActionsFor('approved');
    expect(actions.canCommit).toBe(true);
    expect(actions.canApprove).toBe(false);
    expect(actions.canGenerate).toBe(false);
  });

  it('a committed proposal offers neither Approve nor Commit nor a fresh Generate action', () => {
    const actions = aiProposalActionsFor('committed');
    expect(actions.isCommitted).toBe(true);
    expect(actions.canApprove).toBe(false);
    expect(actions.canCommit).toBe(false);
    expect(actions.canGenerate).toBe(false);
  });

  it('an expired or rejected proposal offers only a fresh Generate — never Approve/Commit on the dead proposal', () => {
    for (const status of ['expired', 'rejected']) {
      const actions = aiProposalActionsFor(status);
      expect(actions.canGenerate).toBe(true);
      expect(actions.canApprove).toBe(false);
      expect(actions.canCommit).toBe(false);
    }
  });

  it('exactly one of the four flags is true for every real status (mutual exclusivity)', () => {
    for (const status of [null, 'pending', 'approved', 'committed', 'expired', 'rejected']) {
      const actions = aiProposalActionsFor(status);
      const trueCount = [actions.canGenerate, actions.canApprove, actions.canCommit, actions.isCommitted].filter(Boolean).length;
      expect(trueCount).toBe(1);
    }
  });
});

// ---------- Formatting helpers ----------

describe('formatRirRange / formatRestSeconds / capitalize / formatTimestamp — real executable output', () => {
  let helpers: AiHelpers;
  beforeAll(() => {
    helpers = makeAiHelpers(vi.fn());
  });

  it('formatRirRange collapses an equal min/max, otherwise shows the range', () => {
    const { formatRirRange } = helpers;
    expect(formatRirRange(1, 3)).toBe('RIR 1–3');
    expect(formatRirRange(2, 2)).toBe('RIR 2');
  });

  it('formatRestSeconds renders seconds/minutes correctly and omits entirely when absent', () => {
    const { formatRestSeconds } = helpers;
    expect(formatRestSeconds(45)).toBe('45s rest');
    expect(formatRestSeconds(90)).toBe('1m 30s rest');
    expect(formatRestSeconds(120)).toBe('2m rest');
    expect(formatRestSeconds(undefined)).toBeNull();
    expect(formatRestSeconds(null)).toBeNull();
  });

  it('capitalize title-cases the first letter only, and handles empty input', () => {
    const { capitalize } = helpers;
    expect(capitalize('primary')).toBe('Primary');
    expect(capitalize('')).toBe('');
  });

  it('formatTimestamp returns an empty string for missing/invalid input, a real string for a valid ISO instant', () => {
    const { formatTimestamp } = helpers;
    expect(formatTimestamp(null)).toBe('');
    expect(formatTimestamp('not-a-date')).toBe('');
    expect(formatTimestamp('2026-09-20T14:15:00.000Z').length).toBeGreaterThan(0);
  });
});

// ---------- Source-level wiring (this repo's existing frontend-test style) ----------

describe('program.html: AI Workout Proposal section wiring', () => {
  const html = readFile('program.html');

  it('calls the real generate/retrieve/approve/commit endpoints, in the retrieve-after-generate pattern', () => {
    expect(html).toMatch(/aiApi\('\/api\/ai-programmer\/generate-session', \{ method: 'POST', body: \{ targetDate: day\.date \} \}\)/);
    expect(html).toMatch(/aiApi\(`\/api\/ai-programmer\/proposals\/\$\{generated\.proposalId\}`\)/);
    expect(html).toMatch(/aiApi\(`\/api\/ai-programmer\/proposals\/\$\{state\.proposalId\}\/approve`, \{ method: 'POST' \}\)/);
    expect(html).toMatch(/aiApi\(`\/api\/ai-programmer\/proposals\/\$\{state\.proposalId\}\/commit`, \{ method: 'POST' \}\)/);
  });

  it('approve and commit are two distinct functions/actions, never combined into one', () => {
    expect(html).toMatch(/async function onApprove\(\)/);
    expect(html).toMatch(/async function onCommit\(\)/);
    // onApprove's own body never also calls the commit endpoint.
    const approveBody = html.slice(html.indexOf('async function onApprove()'), html.indexOf('async function onCommit()'));
    expect(approveBody).not.toMatch(/\/commit`/);
  });

  it('does not allow AI proposal generation for a completed or in-progress day', () => {
    expect(html).toMatch(/day\.status === 'completed' \|\| day\.status === 'in_progress'/);
  });

  it('guards every action against duplicate/overlapping submissions', () => {
    const matches = html.match(/if \(inFlight/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(3); // generate, approve, commit
  });

  it('renders the full prescription (sets/reps/RIR/rest) using the real proposal fields, never inventing any', () => {
    expect(html).toMatch(/formatSets\(item\.sets, item\.repsMin, item\.repsMax\)/);
    expect(html).toMatch(/formatRirRange\(item\.rirMin, item\.rirMax\)/);
    expect(html).toMatch(/formatRestSeconds\(item\.restSeconds\)/);
  });

  it('displays the committed session as an actionable reference, not just a bare id', () => {
    expect(html).toMatch(/href: `\/logger\.html\?session=\$\{state\.committedSessionId\}`/);
  });

  it('never renders a raw error field beyond the pre-mapped err.message (no err.details/err.stack/err.code shown to the user)', () => {
    expect(html).not.toMatch(/err\.details/);
    expect(html).not.toMatch(/err\.stack/);
    // err.code is read (for internal branching only, if ever) but must
    // never be interpolated into visible text via showInlineStatus.
    expect(html).not.toMatch(/showInlineStatus\([^)]*err\.code/);
  });

  it('makes clear this is an AI-generated proposal awaiting review, not an automatic commit', () => {
    expect(html).toMatch(/Nothing is added to your program until you explicitly approve and commit it\./);
  });

  it('never auto-approves or auto-commits after generation', () => {
    const generateBody = html.slice(html.indexOf('async function onGenerate()'), html.indexOf('async function onApprove()'));
    expect(generateBody).not.toMatch(/\/approve`/);
    expect(generateBody).not.toMatch(/\/commit`/);
  });
});
