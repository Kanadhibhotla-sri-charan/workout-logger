// AI-Powered Weekly Reconciliation frontend UI: same extraction-and-
// execute technique tests/frontend/aiProposalUI.test.ts already
// established (this repo has no browser/jsdom harness) for the real
// pure logic (error-code mapping, the lifecycle button-gating rule),
// plus source-level assertions against the shipped program.html for the
// DOM-wiring claims that technique can't reach.

import { describe, expect, it, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '../../public');

function readFile(name: string): string {
  return readFileSync(join(publicDir, name), 'utf8');
}

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

interface Helpers {
  mapAiErrorCode: (code?: string | null) => string;
  aiProposalActionsFor: (status: string | null | undefined) => { canGenerate: boolean; canApprove: boolean; canCommit: boolean; isCommitted: boolean };
  aiWeekReconciliationActionsFor: (status: string | null | undefined) => { canGenerate: boolean; canApprove: boolean; canCommit: boolean; isCommitted: boolean };
}

let makeHelpers: () => Helpers;

beforeAll(() => {
  const appJs = readFile('app.js');
  const aiErrorMessagesSrc = extractConst(appJs, 'AI_ERROR_MESSAGES');
  const mapAiErrorCodeSrc = extractFunction(appJs, 'mapAiErrorCode');
  const aiProposalActionsForSrc = extractFunction(appJs, 'aiProposalActionsFor');
  const aiWeekReconciliationActionsForSrc = extractFunction(appJs, 'aiWeekReconciliationActionsFor');

  // eslint-disable-next-line no-new-func
  const factory = new Function(
    `
    ${aiErrorMessagesSrc}
    ${mapAiErrorCodeSrc}
    ${aiProposalActionsForSrc}
    ${aiWeekReconciliationActionsForSrc}
    return { mapAiErrorCode, aiProposalActionsFor, aiWeekReconciliationActionsFor };
    `
  );
  makeHelpers = factory as any;
});

describe('mapAiErrorCode: every documented week-reconciliation error code maps to a safe, concise message', () => {
  it('maps every AI_WEEK_RECONCILIATION_* code to a non-raw, on-topic message', () => {
    const { mapAiErrorCode } = makeHelpers();
    expect(mapAiErrorCode('AI_WEEK_RECONCILIATION_NOT_FOUND')).toMatch(/could not be found/i);
    expect(mapAiErrorCode('AI_WEEK_RECONCILIATION_INVALID_STATE')).toMatch(/status/i);
    expect(mapAiErrorCode('AI_WEEK_RECONCILIATION_EXPIRED')).toMatch(/expired/i);
    expect(mapAiErrorCode('AI_WEEK_RECONCILIATION_CONFLICT')).toMatch(/planned workout already exists/i);
    expect(mapAiErrorCode('AI_WEEK_RECONCILIATION_STALE')).toMatch(/out of date/i);
    expect(mapAiErrorCode('AI_WEEK_RECONCILIATION_VALIDATION_FAILED')).toMatch(/could not be validated/i);
    expect(mapAiErrorCode('AI_WEEK_RECONCILIATION_COMMIT_FAILED')).toMatch(/could not be committed/i);
    expect(mapAiErrorCode('AI_WEEK_RECONCILIATION_OUTPUT_SCHEMA_INVALID')).toMatch(/could not be validated/i);
    expect(mapAiErrorCode('AI_WEEK_RECONCILIATION_OUTPUT_DOMAIN_INVALID')).toMatch(/could not be validated/i);
  });

  it('never returns the raw code itself as the message', () => {
    const { mapAiErrorCode } = makeHelpers();
    for (const code of [
      'AI_WEEK_RECONCILIATION_NOT_FOUND',
      'AI_WEEK_RECONCILIATION_CONFLICT',
      'AI_WEEK_RECONCILIATION_STALE',
      'AI_WEEK_RECONCILIATION_COMMIT_FAILED',
    ]) {
      expect(mapAiErrorCode(code)).not.toBe(code);
    }
  });
});

describe('aiWeekReconciliationActionsFor: the exact same pending -> approved -> committed gating as single-session proposals', () => {
  it('matches aiProposalActionsFor exactly, status for status', () => {
    const { aiProposalActionsFor, aiWeekReconciliationActionsFor } = makeHelpers();
    for (const status of [null, undefined, 'pending', 'approved', 'committed', 'expired', 'rejected']) {
      expect(aiWeekReconciliationActionsFor(status)).toEqual(aiProposalActionsFor(status));
    }
  });

  it('offers only Generate before any reconciliation exists', () => {
    const { aiWeekReconciliationActionsFor } = makeHelpers();
    expect(aiWeekReconciliationActionsFor(null)).toEqual({ canGenerate: true, canApprove: false, canCommit: false, isCommitted: false });
  });

  it('offers only Approve for a pending reconciliation, only Commit for an approved one', () => {
    const { aiWeekReconciliationActionsFor } = makeHelpers();
    expect(aiWeekReconciliationActionsFor('pending')).toMatchObject({ canApprove: true, canCommit: false, canGenerate: false });
    expect(aiWeekReconciliationActionsFor('approved')).toMatchObject({ canCommit: true, canApprove: false, canGenerate: false });
  });

  it('a committed reconciliation offers no further action', () => {
    const { aiWeekReconciliationActionsFor } = makeHelpers();
    const actions = aiWeekReconciliationActionsFor('committed');
    expect(actions.isCommitted).toBe(true);
    expect(actions.canApprove).toBe(false);
    expect(actions.canCommit).toBe(false);
    expect(actions.canGenerate).toBe(false);
  });
});

describe('program.html: AI Week Reorganization section wiring', () => {
  const html = readFile('program.html');
  const sectionBody = html.slice(html.indexOf('function buildWeekReconciliationSection('), html.indexOf('const GROUP_ORDER'));

  it('is built at modal-open time (not only reactively) and passed the modal token, exactly like buildAiProposalSection', () => {
    expect(html).toMatch(/const weekReconciliation = buildWeekReconciliationSection\(day, modalToken\);/);
    expect(html).toMatch(/buildChangeActivitySection\(day, weekReconciliation\)/);
    expect(html).toMatch(/panel\.appendChild\(weekReconciliation\.element\);/);
  });

  it('reveals itself from the deterministic "generationRequired" fallback only when the requested activity is exactly "gym"', () => {
    const clickBody = html.slice(html.indexOf("const saveBtn = createButton({ label: 'Change activity"), html.indexOf('const row = el(', html.indexOf("const saveBtn = createButton({ label: 'Change activity")));
    expect(clickBody).toMatch(/if \(err\.body && err\.body\.generationRequired\)/);
    expect(clickBody).toMatch(/if \(select\.value === 'gym'\) \{\s*\n\s*weekReconciliation\.revealForSwapFailure\(\);/);
    // The prior purely-deterministic path stays available for "both",
    // which the reconcile-week route does not support.
    expect(clickBody).toMatch(/label: 'Generate a new workout for this day'/);
  });

  it('calls the real reconcile-week/approve/commit endpoints — never a deterministic regenerate relabeled as AI', () => {
    expect(sectionBody).toMatch(/aiApi\('\/api\/ai-programmer\/reconcile-week', \{ method: 'POST', body: \{ targetDate: day\.date, requestedActivity: 'gym' \} \}\)/);
    expect(sectionBody).toMatch(/aiApi\(`\/api\/ai-programmer\/week-reconciliations\/\$\{state\.reconciliationId\}\/approve`, \{ method: 'POST' \}\)/);
    expect(sectionBody).toMatch(/aiApi\(`\/api\/ai-programmer\/week-reconciliations\/\$\{state\.reconciliationId\}\/commit`, \{ method: 'POST' \}\)/);
  });

  it('approve and commit are two distinct functions, never combined into one', () => {
    expect(sectionBody).toMatch(/async function onApprove\(\)/);
    expect(sectionBody).toMatch(/async function onCommit\(\)/);
    const approveBody = sectionBody.slice(sectionBody.indexOf('async function onApprove()'), sectionBody.indexOf('async function onCommit()'));
    expect(approveBody).not.toMatch(/\/commit`/);
  });

  it('never auto-approves or auto-commits right after asking the AI', () => {
    const generateBody = sectionBody.slice(sectionBody.indexOf('async function onGenerate()'), sectionBody.indexOf('async function onApprove()'));
    expect(generateBody).not.toMatch(/\/approve`/);
    expect(generateBody).not.toMatch(/\/commit`/);
  });

  it('makes clear nothing changes until the user explicitly approves and applies it', () => {
    // Phase 5 (2026-09-23): reworded to name the specific day and state
    // the locked-day guarantee explicitly (Part 7) — same "nothing
    // changes until approve+apply" guarantee, stronger scope statement.
    expect(html).toMatch(/Generates \$\{formatWeekday\(day\.weekday\)\}'s workout and reorganizes the rest of this week around it\. Completed and in-progress days are never touched\. Nothing changes until you approve and apply it\./);
  });

  it('guards every action against duplicate/overlapping submissions', () => {
    const matches = sectionBody.match(/if \(inFlight/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(3); // generate, approve, commit
  });

  it('renders the target day\'s new exercises using the same buildAiExerciseCard the single-session review uses — no duplicated rendering logic', () => {
    const reviewBody = html.slice(html.indexOf('function buildWeekReconciliationReview('), html.indexOf('function buildWeekReconciliationSection('));
    expect(reviewBody).toMatch(/buildAiExerciseCard\(ex, pendingReview\)/);
  });

  it('shows which other days changed, from the real output.days field only', () => {
    const reviewBody = html.slice(html.indexOf('function buildWeekReconciliationReview('), html.indexOf('function buildWeekReconciliationSection('));
    expect(reviewBody).toMatch(/output\.days\.filter\(\(d\) => d\.changeType !== 'unchanged'\)/);
  });

  it('never renders a raw error field beyond the pre-mapped err.message', () => {
    expect(sectionBody).not.toMatch(/err\.details/);
    expect(sectionBody).not.toMatch(/err\.stack/);
  });

  it('closes the modal and reloads the week only after a successful commit', () => {
    const commitBody = sectionBody.slice(sectionBody.indexOf('async function onCommit()'), sectionBody.indexOf('renderActions(); // shows'));
    expect(commitBody).toMatch(/closeDayModal\(\);\s*\n\s*await loadWeek\(\);/);
  });
});

// ---------- Discovery/Rehydration wiring (Fix AI Weekly Reconciliation
// Review, Finding 3) ----------
//
// The DOM-building side of discovery has no jsdom harness to execute
// against in this repo (matching aiProposalUI.test.ts's own established
// convention) — so the pure logic (aiWeekReconciliationActionsFor,
// isModalTokenCurrent/bumpModalToken) is proven executable elsewhere in
// this file / aiProposalUI.test.ts, and every DOM-wiring claim below is
// a source-level assertion against the shipped program.html.
describe('program.html: week-reconciliation discovery/rehydration wiring', () => {
  const html = readFile('program.html');
  const sectionBody = html.slice(html.indexOf('function buildWeekReconciliationSection('), html.indexOf('const GROUP_ORDER'));

  it('discovers before deciding what to show — GET /week-reconciliations/latest?targetDate=<day> is called on section build, unconditionally', () => {
    expect(sectionBody).toMatch(/aiApi\(`\/api\/ai-programmer\/week-reconciliations\/latest\?targetDate=\$\{encodeURIComponent\(day\.date\)\}`\)/);
    expect(sectionBody).toMatch(/async function discover\(\)/);
    // Called once, unconditionally, right where the section is built —
    // never gated behind the swap-failure reveal, so a day reopened with
    // an existing reconciliation is discovered whether or not the user
    // ever touches the deterministic swap control this session.
    expect(sectionBody).toMatch(/renderActions\(\); \/\/ shows the "Checking…" placeholder immediately once revealed\s*\n\s*discover\(\);/);
  });

  it('seeds state from the discovery result — found:false means "no known reconciliation", found:true means the returned record (reopening a day with no reconciliation vs. one with a pending/approved/committed one)', () => {
    expect(sectionBody).toMatch(/state = result\.found \? result : null;/);
  });

  it('a reopened day with an existing reconciliation is shown immediately — visibility is driven by discovery, not only by a swap failure this session', () => {
    expect(sectionBody).toMatch(/function updateVisibility\(\) \{/);
    const visibilityBody = sectionBody.slice(sectionBody.indexOf('function updateVisibility()'), sectionBody.indexOf('function renderReview()'));
    expect(visibilityBody).toMatch(/wrap\.hidden = !\(swapFailed \|\| state !== null\);/);
    // Called from inside discover()'s own finally block — so a found
    // record reveals the section without any swap ever being attempted.
    const discoverBody = sectionBody.slice(sectionBody.indexOf('async function discover()'), sectionBody.indexOf('async function resyncState()'));
    expect(discoverBody).toMatch(/updateVisibility\(\);/);
  });

  it('reopening a DIFFERENT target date never hydrates the wrong record — a fresh section (and its own discover()) is built per day.date, never a shared/global reconciliation variable', () => {
    // buildWeekReconciliationSection is a factory called fresh with the
    // specific `day` for the currently-open modal (see openDayModal's
    // own call site) — `day.date` is baked into the discovery URL at
    // call time, so a different day literally cannot share this state.
    expect(html).toMatch(/const weekReconciliation = buildWeekReconciliationSection\(day, modalToken\);/);
    expect(sectionBody).toMatch(/week-reconciliations\/latest\?targetDate=\$\{encodeURIComponent\(day\.date\)\}/);
  });

  it('reopening the modal never triggers a new AI call by itself — discover() only ever reads (GET), onGenerate (the only POST to /reconcile-week) is never invoked from discover()', () => {
    const discoverBody = sectionBody.slice(sectionBody.indexOf('async function discover()'), sectionBody.indexOf('async function resyncState()'));
    expect(discoverBody).not.toMatch(/reconcile-week/);
    expect(discoverBody).not.toMatch(/onGenerate\(\)/);
  });

  it('gates every action behind discovery completing — never offers "Ask AI" (or anything else) while it is still unknown whether a reconciliation already exists', () => {
    const renderActionsBody = sectionBody.slice(sectionBody.indexOf('function renderActions()'), sectionBody.indexOf('async function discover()'));
    expect(renderActionsBody).toMatch(/if \(!discoveryDone\)/);
    const discoveryDoneAssignments = sectionBody.match(/discoveryDone = true;/g) || [];
    expect(discoveryDoneAssignments.length).toBe(1); // only discover() itself ever sets this
  });

  it('a failed/expired reconciliation renders a retry state — aiWeekReconciliationActionsFor treats it the same as "no reconciliation", offering a fresh "Ask AI" rather than a dead end', () => {
    expect(sectionBody).toMatch(/aiWeekReconciliationActionsFor\(state \? state\.status : null\)/);
    // aiWeekReconciliationActionsFor delegates to aiProposalActionsFor,
    // whose own canGenerate rule already covers expired/rejected —
    // verified executable in the "aiWeekReconciliationActionsFor" describe
    // block above; this only proves the section actually calls it.
  });

  it('every async continuation (discover/generate/approve/commit) checks isCurrent() before applying its result — the stale-response guard, shared with buildAiProposalSection\'s own modalToken', () => {
    expect(sectionBody).toMatch(/function isCurrent\(\) \{\s*\n\s*return isModalTokenCurrent\(modalToken\);\s*\n\s*\}/);
    const guardCalls = sectionBody.match(/if \(!isCurrent\(\)\) return;/g) || [];
    expect(guardCalls.length).toBeGreaterThanOrEqual(9); // discover (3), onGenerate (3), onApprove (2), onCommit (2)+
  });

  it('a failed approve/commit resyncs canonical state from the backend rather than trusting only local optimistic state', () => {
    expect(sectionBody).toMatch(/async function resyncState\(\)/);
    const approveBody = sectionBody.slice(sectionBody.indexOf('async function onApprove()'), sectionBody.indexOf('async function onCommit()'));
    expect(approveBody).toMatch(/await resyncState\(\);/);
    const commitBody = sectionBody.slice(sectionBody.indexOf('async function onCommit()'), sectionBody.indexOf('renderActions(); // shows'));
    expect(commitBody).toMatch(/await resyncState\(\);/);
  });

  it('a discovery failure degrades to "no known reconciliation" rather than throwing unhandled or blocking the day', () => {
    const discoverBody = sectionBody.slice(sectionBody.indexOf('async function discover()'), sectionBody.indexOf('async function resyncState()'));
    expect(discoverBody).toMatch(/state = null;/);
  });
});
