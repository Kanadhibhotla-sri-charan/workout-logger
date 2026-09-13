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
  aiProposalNoticeFor: (status: string | null | undefined) => string | null;
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
  const aiProposalNoticeForSrc = extractFunction(appJs, 'aiProposalNoticeFor');
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
    ${aiProposalNoticeForSrc}
    ${formatRangeSrc}
    ${formatRirRangeSrc}
    ${formatRestSecondsSrc}
    ${capitalizeSrc}
    ${formatTimestampSrc}
    return { mapAiErrorCode, aiApi, aiProposalActionsFor, aiProposalNoticeFor, formatRirRange, formatRestSeconds, capitalize, formatTimestamp };
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

// ---------- aiProposalNoticeFor: the "no longer active" informational note ----------

describe('aiProposalNoticeFor: expired/rejected get a non-blocking notice, every other status gets none', () => {
  let aiProposalNoticeFor: AiHelpers['aiProposalNoticeFor'];
  beforeAll(() => {
    ({ aiProposalNoticeFor } = makeAiHelpers(vi.fn()));
  });

  it('returns the "no longer active" note for expired and rejected', () => {
    expect(aiProposalNoticeFor('expired')).toMatch(/no longer active/i);
    expect(aiProposalNoticeFor('rejected')).toMatch(/no longer active/i);
  });

  it('returns null (no notice) for every other status, including no proposal at all', () => {
    for (const status of [null, undefined, 'pending', 'approved', 'committed']) {
      expect(aiProposalNoticeFor(status)).toBeNull();
    }
  });

  it('never says the user is blocked from generating — it is purely informational (spec §4: "does not block generation")', () => {
    expect(aiProposalNoticeFor('expired')).not.toMatch(/cannot|can't|unable|blocked/i);
    expect(aiProposalNoticeFor('rejected')).not.toMatch(/cannot|can't|unable|blocked/i);
  });
});

// ---------- isModalTokenCurrent / bumpModalToken: the stale-discovery guard ----------
//
// Discovery/Rehydration spec §5 ("prevent overlapping discovery
// requests from causing an older response to overwrite a newer
// selected date"): extracted directly from program.html — a genuinely
// pure, DOM-free pair of functions sharing one module-level counter, so
// the exact staleness semantics are testable without a browser/DOM.

describe('isModalTokenCurrent / bumpModalToken: a token is only "current" until the next open/close bumps it', () => {
  let tokenHelpers: { bumpModalToken: () => number; isModalTokenCurrent: (token: number) => boolean };

  beforeAll(() => {
    const programHtml = readFile('program.html');
    const bumpModalTokenSrc = extractFunction(programHtml, 'bumpModalToken');
    const isModalTokenCurrentSrc = extractFunction(programHtml, 'isModalTokenCurrent');
    // eslint-disable-next-line no-new-func
    const factory = new Function(
      `
      let currentModalToken = 0;
      ${bumpModalTokenSrc}
      ${isModalTokenCurrentSrc}
      return { bumpModalToken, isModalTokenCurrent };
      `
    );
    tokenHelpers = factory();
  });

  it('a freshly bumped token is current', () => {
    const { bumpModalToken, isModalTokenCurrent } = tokenHelpers;
    const token = bumpModalToken();
    expect(isModalTokenCurrent(token)).toBe(true);
  });

  it('an older token is no longer current once the token is bumped again (switching to a different day)', () => {
    const { bumpModalToken, isModalTokenCurrent } = tokenHelpers;
    const staleToken = bumpModalToken(); // e.g. day A's modal opens
    bumpModalToken(); // e.g. day B's modal opens before day A's discovery resolved
    expect(isModalTokenCurrent(staleToken)).toBe(false);
  });

  it('a token also stops being current once bumped by a close (not only by switching days)', () => {
    const { bumpModalToken, isModalTokenCurrent } = tokenHelpers;
    const openToken = bumpModalToken(); // modal opens
    bumpModalToken(); // modal closes
    expect(isModalTokenCurrent(openToken)).toBe(false);
  });

  it('an older response can never be mistaken for current after a newer one has already been issued', () => {
    const { bumpModalToken, isModalTokenCurrent } = tokenHelpers;
    const first = bumpModalToken();
    const second = bumpModalToken();
    const third = bumpModalToken();
    // Even if the earliest request's response arrives LAST (the classic
    // out-of-order network scenario), it is never reported current once
    // a newer one has already superseded it.
    expect(isModalTokenCurrent(first)).toBe(false);
    expect(isModalTokenCurrent(second)).toBe(false);
    expect(isModalTokenCurrent(third)).toBe(true);
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
    expect(html).toMatch(/aiApi\(`\/api\/ai-programmer\/proposals\/\$\{state\.proposalId\}\/commit`, \{/);
    expect(html).toMatch(/method: 'POST',\s*\n\s*body: \{ intent: isGymDay \? 'fill_existing_gym_day' : 'replace_day_activity' \},/);
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

// ---------- Discovery/Rehydration wiring ----------
//
// (docs/CLAUDE_TASK_AI_PROGRAMMER_PROPOSAL_DISCOVERY_REHYDRATION.md):
// the DOM-building side of discovery (buildAiProposalSection calling
// `el()`/appendChild) has no jsdom harness to execute against in this
// repo, so — matching the existing convention just above — the actual
// pure logic pieces (aiProposalActionsFor, aiProposalNoticeFor,
// isModalTokenCurrent/bumpModalToken) are extracted and executed for
// real above, and the DOM-wiring claims below are proven as source-level
// assertions against the shipped program.html text.
describe('program.html: AI Programmer proposal discovery/rehydration wiring', () => {
  const html = readFile('program.html');

  it('discovers before deciding which action to show — GET /proposals/latest?targetDate=<day> is called on section build', () => {
    expect(html).toMatch(/aiApi\(`\/api\/ai-programmer\/proposals\/latest\?targetDate=\$\{encodeURIComponent\(day\.date\)\}`\)/);
    // Called from a function named discover(), invoked once when the
    // section is built (never inside a loop/retry).
    expect(html).toMatch(/async function discover\(\)/);
    expect(html).toMatch(/discover\(\);\s*\n\s*return section;/);
  });

  it('seeds state from the discovery result — found:false means "no known proposal", found:true means the returned record', () => {
    expect(html).toMatch(/state = result\.found \? result : null;/);
  });

  it('every action (Generate/Approve/Commit/Open link) is still decided by the SAME aiProposalActionsFor call used before this task — discovery only seeds `state` earlier, it never duplicates the decision logic', () => {
    const sectionBody = html.slice(html.indexOf('function buildAiProposalSection('), html.indexOf('const GROUP_ORDER'));
    const matches = sectionBody.match(/aiProposalActionsFor\(state \? state\.status : null\)/g) || [];
    expect(matches.length).toBe(1); // one render path, reused for both the discovered and the freshly-generated/approved/committed state
  });

  it('gates every action behind discovery completing — never offers Generate (or anything else) while it is still unknown whether an active proposal already exists', () => {
    const renderActionsBody = html.slice(html.indexOf('function renderActions()'), html.indexOf('function discover()'));
    expect(renderActionsBody).toMatch(/if \(!discoveryDone\)/);
    expect(renderActionsBody).toMatch(/Checking for an existing proposal/);
    // discoveryDone only ever flips to true from inside discover() itself.
    expect(html).toMatch(/discoveryDone = true;/);
    const discoveryDoneAssignments = html.match(/discoveryDone = true;/g) || [];
    expect(discoveryDoneAssignments.length).toBe(1);
  });

  it('shows the "no longer active" notice via aiProposalNoticeFor, never inline duplicated logic, and never blocks Generate', () => {
    expect(html).toMatch(/function renderNotice\(\) \{/);
    const renderNoticeBody = html.slice(html.indexOf('function renderNotice()'), html.indexOf('function renderActions()'));
    expect(renderNoticeBody).toMatch(/aiProposalNoticeFor\(state \? state\.status : null\)/);
    // renderNotice never itself decides canGenerate — that stays solely
    // aiProposalActionsFor's job (checked in the test above).
    expect(renderNoticeBody).not.toMatch(/canGenerate/);
  });

  it('AI Activity Alignment Part 3: commit intent is computed from day.activity, not invented or inferred elsewhere', () => {
    expect(html).toMatch(/const isGymDay = day\.activity === 'gym' \|\| day\.activity === 'both';/);
    // Computed exactly once per section build, from the real /week
    // response field — never re-derived from day.type/day.status, which
    // describe something different (the deterministic plan/session
    // status, not the authoritative weekly activity).
    const matches = html.match(/const isGymDay = day\.activity/g) || [];
    expect(matches.length).toBe(1);
  });

  it('warns the user before committing onto a non-gym day that doing so replaces the day\'s activity', () => {
    const sectionBody = html.slice(html.indexOf('function buildAiProposalSection('), html.indexOf('const GROUP_ORDER'));
    expect(sectionBody).toMatch(/if \(!isGymDay\) \{/);
    expect(sectionBody).toMatch(/Committing will replace \$\{formatWeekday\(day\.weekday\)\}'s current activity/);
  });

  it('every async continuation (discover/generate/approve/commit) checks isCurrent() before applying its result — the stale-response guard', () => {
    expect(html).toMatch(/function isCurrent\(\) \{\s*\n\s*return isModalTokenCurrent\(modalToken\);\s*\n\s*\}/);
    const guardCalls = html.match(/if \(!isCurrent\(\)\) return;/g) || [];
    // discover(): try + catch + finally = 3; onGenerate/onApprove/onCommit:
    // success + finally each = 2 apiece = 6. 9 total call sites guard a
    // result from being applied to a superseded modal/day.
    expect(guardCalls.length).toBeGreaterThanOrEqual(9);
  });

  it('openDayModal captures a fresh token via bumpModalToken() and passes it into buildAiProposalSection', () => {
    expect(html).toMatch(/const modalToken = bumpModalToken\(\);/);
    expect(html).toMatch(/buildAiProposalSection\(day, modalToken\)/);
  });

  it('closeDayModal also bumps the token — closing the modal invalidates in-flight requests too, not only switching days', () => {
    const closeStart = html.indexOf('function closeDayModal()');
    const closeBody = html.slice(closeStart, html.indexOf('\n    }\n', closeStart));
    expect(closeBody).toMatch(/bumpModalToken\(\);/);
  });

  it('a discovery failure degrades to "no known proposal" and a safe inline error — never blocks the day or throws unhandled', () => {
    const discoverBody = html.slice(html.indexOf('async function discover()'), html.indexOf('async function resyncState()'));
    expect(discoverBody).toMatch(/state = null;/);
    expect(discoverBody).toMatch(/showInlineStatus\(statusEl, 'error', err\.message\)/);
    expect(discoverBody).not.toMatch(/err\.details/);
    expect(discoverBody).not.toMatch(/err\.stack/);
  });
});
