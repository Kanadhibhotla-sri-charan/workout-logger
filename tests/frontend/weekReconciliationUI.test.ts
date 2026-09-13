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

  it('is reached only from the deterministic "generationRequired" fallback, and only when the requested activity is exactly "gym"', () => {
    const clickBody = html.slice(html.indexOf("const saveBtn = createButton({ label: 'Change activity"), html.indexOf('const row = el(', html.indexOf("const saveBtn = createButton({ label: 'Change activity")));
    expect(clickBody).toMatch(/if \(err\.body && err\.body\.generationRequired\)/);
    expect(clickBody).toMatch(/if \(select\.value === 'gym'\) \{\s*\n\s*statusEl\.appendChild\(buildWeekReconciliationSection\(day\)\);/);
    // The prior purely-deterministic path stays available for "both",
    // which the reconcile-week route does not support.
    expect(clickBody).toMatch(/label: 'Generate a new workout for this day'/);
  });

  it('calls the real reconcile-week/approve/commit endpoints — never a deterministic regenerate relabeled as AI', () => {
    const sectionBody = html.slice(html.indexOf('function buildWeekReconciliationSection('), html.indexOf('const GROUP_ORDER'));
    expect(sectionBody).toMatch(/aiApi\('\/api\/ai-programmer\/reconcile-week', \{ method: 'POST', body: \{ targetDate: day\.date, requestedActivity: 'gym' \} \}\)/);
    expect(sectionBody).toMatch(/aiApi\(`\/api\/ai-programmer\/week-reconciliations\/\$\{state\.reconciliationId\}\/approve`, \{ method: 'POST' \}\)/);
    expect(sectionBody).toMatch(/aiApi\(`\/api\/ai-programmer\/week-reconciliations\/\$\{state\.reconciliationId\}\/commit`, \{ method: 'POST' \}\)/);
  });

  it('approve and commit are two distinct functions, never combined into one', () => {
    const sectionBody = html.slice(html.indexOf('function buildWeekReconciliationSection('), html.indexOf('const GROUP_ORDER'));
    expect(sectionBody).toMatch(/async function onApprove\(\)/);
    expect(sectionBody).toMatch(/async function onCommit\(\)/);
    const approveBody = sectionBody.slice(sectionBody.indexOf('async function onApprove()'), sectionBody.indexOf('async function onCommit()'));
    expect(approveBody).not.toMatch(/\/commit`/);
  });

  it('never auto-approves or auto-commits right after asking the AI', () => {
    const sectionBody = html.slice(html.indexOf('function buildWeekReconciliationSection('), html.indexOf('const GROUP_ORDER'));
    const generateBody = sectionBody.slice(sectionBody.indexOf('async function onGenerate()'), sectionBody.indexOf('async function onApprove()'));
    expect(generateBody).not.toMatch(/\/approve`/);
    expect(generateBody).not.toMatch(/\/commit`/);
  });

  it('makes clear nothing changes until the user explicitly approves and applies it', () => {
    expect(html).toMatch(/Ask the AI Programmer to generate a workout for this day and reorganize the rest of the week around it\. Nothing changes until you approve and apply it\./);
  });

  it('guards every action against duplicate/overlapping submissions', () => {
    const sectionBody = html.slice(html.indexOf('function buildWeekReconciliationSection('), html.indexOf('const GROUP_ORDER'));
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
    const sectionBody = html.slice(html.indexOf('function buildWeekReconciliationSection('), html.indexOf('const GROUP_ORDER'));
    expect(sectionBody).not.toMatch(/err\.details/);
    expect(sectionBody).not.toMatch(/err\.stack/);
  });

  it('closes the modal and reloads the week only after a successful commit', () => {
    const sectionBody = html.slice(html.indexOf('function buildWeekReconciliationSection('), html.indexOf('const GROUP_ORDER'));
    const commitBody = sectionBody.slice(sectionBody.indexOf('async function onCommit()'), sectionBody.indexOf('renderActions();\n      return wrap;'));
    expect(commitBody).toMatch(/closeDayModal\(\);\s*\n\s*await loadWeek\(\);/);
  });
});
