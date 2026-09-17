// Coaching Depth Workstream B
// (docs/COACHING_DEPTH_NEXT_STEPS_IMPLEMENTATION_SPEC.md §9,
// docs/COACHING_DEPTH_UI_DATA_CONTRACT.md): this app has no browser/jsdom
// test harness, so the real pure mapping/derivation functions the new
// coaching-depth UI depends on (deload-state labeling, the "alternative
// considered" boolean derivation, preference-kind wording, advisory
// severity labeling, and the "techniques prescribed this week" scanner)
// are extracted from the real shipped app.js by brace-balanced slicing
// and evaluated via `new Function`, then exercised directly with fixture
// data — the same technique tests/frontend/aiProposalUI.test.ts and
// tests/frontend/copyWorkoutText.test.ts already established for this
// repo. DOM wiring that isn't meaningfully testable this way (which
// endpoint each control calls, which empty-state string renders) is
// instead covered by source-level assertions against the real shipped
// public/*.html files, matching this repo's existing convention (e.g.
// tests/frontend/dailyActivityUI.test.ts).

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

/** Slices out exactly one top-level `const <name> = [ ... ];` array
 * literal declaration, by the same brace-counting technique but tracking
 * `[`/`]` instead of `{`/`}`. */
function extractArrayConst(source: string, name: string): string {
  const startMatch = source.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[`));
  if (!startMatch || startMatch.index === undefined) throw new Error(`const ${name} (array) not found`);
  const bodyStart = startMatch.index + startMatch[0].length;
  let depth = 1;
  let i = bodyStart;
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === '[') depth++;
    else if (source[i] === ']') depth--;
  }
  while (i < source.length && source[i] !== ';') i++;
  return source.slice(startMatch.index, i + 1);
}

interface CoachingHelpers {
  formatDeloadReason: (reason: string | null | undefined) => string;
  wasAlternativeConsidered: (decision: any) => boolean;
  formatPreferenceKind: (preference: string | null | undefined) => { label: string; description: string };
  formatAdvisorySeverity: (severity: string | null | undefined) => string;
  collectWeekAppliedTechniques: (days: any[]) => Array<{ weekday: string; date: string; exercise_name: string; technique: any }>;
  NAV_ITEMS: Array<{ href: string; label: string }>;
}

let makeCoachingHelpers: () => CoachingHelpers;

beforeAll(() => {
  const appJs = readFile('app.js');

  const capitalizeSrc = extractFunction(appJs, 'capitalize');
  const deloadLabelSrc = extractConst(appJs, 'DELOAD_REASON_LABEL');
  const formatDeloadReasonSrc = extractFunction(appJs, 'formatDeloadReason');
  const wasAlternativeConsideredSrc = extractFunction(appJs, 'wasAlternativeConsidered');
  const preferenceKindCopySrc = extractConst(appJs, 'PREFERENCE_KIND_COPY');
  const formatPreferenceKindSrc = extractFunction(appJs, 'formatPreferenceKind');
  const advisorySeverityLabelSrc = extractConst(appJs, 'ADVISORY_SEVERITY_LABEL');
  const formatAdvisorySeveritySrc = extractFunction(appJs, 'formatAdvisorySeverity');
  const collectWeekAppliedTechniquesSrc = extractFunction(appJs, 'collectWeekAppliedTechniques');
  const navItemsSrc = extractArrayConst(appJs, 'NAV_ITEMS');

  // eslint-disable-next-line no-new-func
  const factory = new Function(
    `
    ${capitalizeSrc}
    ${deloadLabelSrc}
    ${formatDeloadReasonSrc}
    ${wasAlternativeConsideredSrc}
    ${preferenceKindCopySrc}
    ${formatPreferenceKindSrc}
    ${advisorySeverityLabelSrc}
    ${formatAdvisorySeveritySrc}
    ${collectWeekAppliedTechniquesSrc}
    ${navItemsSrc}
    return { formatDeloadReason, wasAlternativeConsidered, formatPreferenceKind, formatAdvisorySeverity, collectWeekAppliedTechniques, NAV_ITEMS };
    `
  );
  makeCoachingHelpers = factory as any;
});

// ---------- formatDeloadReason ----------

describe('formatDeloadReason: deloadReason -> the fixed plain-language state labels (data contract §1)', () => {
  it('maps null/undefined to "Normal training" — never blank', () => {
    const { formatDeloadReason } = makeCoachingHelpers();
    expect(formatDeloadReason(null)).toBe('Normal training');
    expect(formatDeloadReason(undefined)).toBe('Normal training');
  });

  it('maps calendar/reactive/combined/manual to their documented labels', () => {
    const { formatDeloadReason } = makeCoachingHelpers();
    expect(formatDeloadReason('calendar')).toMatch(/planned/i);
    expect(formatDeloadReason('reactive')).toMatch(/reactive/i);
    expect(formatDeloadReason('combined')).toMatch(/reactive/i);
    expect(formatDeloadReason('manual')).toMatch(/manual/i);
  });

  it('never returns an internal state-machine term (spec §6.1)', () => {
    const { formatDeloadReason } = makeCoachingHelpers();
    for (const reason of [null, 'calendar', 'reactive', 'combined', 'manual']) {
      const label = formatDeloadReason(reason);
      expect(label).not.toMatch(/state.machine|resolver|gate/i);
    }
  });

  it('degrades an unknown/legacy enum value to a humanized label rather than throwing or rendering blank', () => {
    const { formatDeloadReason } = makeCoachingHelpers();
    const label = formatDeloadReason('some_future_reason');
    expect(typeof label).toBe('string');
    expect(label.length).toBeGreaterThan(0);
  });
});

// ---------- wasAlternativeConsidered ----------

describe('wasAlternativeConsidered: a boolean-only derivation from decision.selection (data contract §2)', () => {
  it('false when decision/selection is missing entirely', () => {
    const { wasAlternativeConsidered } = makeCoachingHelpers();
    expect(wasAlternativeConsidered(null)).toBe(false);
    expect(wasAlternativeConsidered(undefined)).toBe(false);
    expect(wasAlternativeConsidered({ selection: null })).toBe(false);
  });

  it('false when selection has no rejected candidates and no substitution', () => {
    const { wasAlternativeConsidered } = makeCoachingHelpers();
    expect(wasAlternativeConsidered({ selection: { rejected_candidates: [], substituted_from: null } })).toBe(false);
  });

  it('true when rejected_candidates is non-empty', () => {
    const { wasAlternativeConsidered } = makeCoachingHelpers();
    expect(wasAlternativeConsidered({ selection: { rejected_candidates: ['bench-press'], substituted_from: null } })).toBe(true);
  });

  it('true when substituted_from is a real exercise id', () => {
    const { wasAlternativeConsidered } = makeCoachingHelpers();
    expect(wasAlternativeConsidered({ selection: { rejected_candidates: [], substituted_from: 'incline-press' } })).toBe(true);
  });

  it('never returns the raw candidate list or decisive_gate — only a boolean', () => {
    const { wasAlternativeConsidered } = makeCoachingHelpers();
    const result = wasAlternativeConsidered({ selection: { decisive_gate: 'AVOIDANCE_RULE', rejected_candidates: ['x'], substituted_from: null } });
    expect(result).toBe(true);
    expect(typeof result).toBe('boolean');
  });
});

// ---------- formatPreferenceKind ----------

describe('formatPreferenceKind: preferred/disliked phrased as "may", avoided phrased as a hard rule (data contract §3)', () => {
  it('preferred/disliked use "may favor"/"may deprioritize" wording', () => {
    const { formatPreferenceKind } = makeCoachingHelpers();
    expect(formatPreferenceKind('preferred').description).toMatch(/may favor/i);
    expect(formatPreferenceKind('disliked').description).toMatch(/may deprioritize/i);
  });

  it('avoided uses "will not prescribe...unless removed" wording — never the same phrasing as preferred/disliked', () => {
    const { formatPreferenceKind } = makeCoachingHelpers();
    const avoided = formatPreferenceKind('avoided');
    expect(avoided.description).toMatch(/will not prescribe/i);
    expect(avoided.description).toMatch(/unless you remove/i);
  });

  it('every kind has a distinct label', () => {
    const { formatPreferenceKind } = makeCoachingHelpers();
    const labels = ['preferred', 'disliked', 'avoided'].map((k) => formatPreferenceKind(k).label);
    expect(new Set(labels).size).toBe(3);
  });

  it('degrades an unrecognized value to a humanized label rather than throwing', () => {
    const { formatPreferenceKind } = makeCoachingHelpers();
    const result = formatPreferenceKind('some_future_kind');
    expect(typeof result.label).toBe('string');
    expect(typeof result.description).toBe('string');
  });
});

// ---------- formatAdvisorySeverity ----------

describe('formatAdvisorySeverity: severity -> a plain-language text label, always present alongside any color (spec §6.4)', () => {
  it('maps every known severity to a non-empty, non-raw label', () => {
    const { formatAdvisorySeverity } = makeCoachingHelpers();
    for (const severity of ['INFO', 'WATCH', 'REVIEW']) {
      const label = formatAdvisorySeverity(severity);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe(severity);
    }
  });

  it('degrades an unrecognized severity to a humanized label rather than blank', () => {
    const { formatAdvisorySeverity } = makeCoachingHelpers();
    const label = formatAdvisorySeverity('URGENT');
    expect(typeof label).toBe('string');
    expect(label.length).toBeGreaterThan(0);
  });
});

// ---------- collectWeekAppliedTechniques ----------

describe('collectWeekAppliedTechniques: scans /week days[].plannedWork[].applied_intensity_technique only (data contract §5 point 2)', () => {
  it('returns an empty array for a week with no applied techniques', () => {
    const { collectWeekAppliedTechniques } = makeCoachingHelpers();
    const days = [
      { weekday: 'monday', date: '2026-09-14', plannedWork: [{ exercise_name: 'Bench Press', applied_intensity_technique: null }] },
      { weekday: 'tuesday', date: '2026-09-15', plannedWork: [] },
    ];
    expect(collectWeekAppliedTechniques(days)).toEqual([]);
  });

  it('collects every applied technique across the week, naming its real day and exercise', () => {
    const { collectWeekAppliedTechniques } = makeCoachingHelpers();
    const technique = { technique_id: 'myo-reps', name: 'Myo-reps', instruction: 'Do it.', extra_fatigue_note: 'Adds fatigue.', applied_to_working_set_number: 3 };
    const days = [
      { weekday: 'monday', date: '2026-09-14', plannedWork: [{ exercise_name: 'Leg Press', applied_intensity_technique: technique }] },
      { weekday: 'wednesday', date: '2026-09-16', plannedWork: [{ exercise_name: 'Lat Pulldown', applied_intensity_technique: null }] },
    ];
    const result = collectWeekAppliedTechniques(days);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ weekday: 'monday', date: '2026-09-14', exercise_name: 'Leg Press', technique });
  });

  it('tolerates missing/empty days and plannedWork arrays without throwing', () => {
    const { collectWeekAppliedTechniques } = makeCoachingHelpers();
    expect(collectWeekAppliedTechniques([])).toEqual([]);
    expect(collectWeekAppliedTechniques(undefined as any)).toEqual([]);
    expect(collectWeekAppliedTechniques([{ weekday: 'monday', date: '2026-09-14' }])).toEqual([]);
  });

  it('never asks the separate /intensity-techniques catalog — only ever reads the already-loaded /week shape', () => {
    const appJs = readFile('app.js');
    const src = extractFunction(appJs, 'collectWeekAppliedTechniques');
    expect(src).not.toMatch(/intensity-techniques/);
  });
});

// ---------- NAV_ITEMS ----------

describe('NAV_ITEMS: Coaching Settings and Coaching Insights are real navigable pages', () => {
  it('includes the two new coaching-depth pages', () => {
    const { NAV_ITEMS } = makeCoachingHelpers();
    expect(NAV_ITEMS.some((item) => item.href === '/coaching-settings.html')).toBe(true);
    expect(NAV_ITEMS.some((item) => item.href === '/coaching-insights.html')).toBe(true);
  });

  it('every nav item still has a non-empty label', () => {
    const { NAV_ITEMS } = makeCoachingHelpers();
    for (const item of NAV_ITEMS) expect(item.label.length).toBeGreaterThan(0);
  });
});

// ---------- program.html: B2/B3 source-level wiring ----------

describe('program.html: weekly-plan state banner wiring (B2)', () => {
  const html = readFile('program.html');

  it('fetches periodization independently of the week fetch — never awaited inside the same try/catch', () => {
    expect(html).toMatch(/api\('\/api\/programming\/periodization'\)/);
    // loadWeek's own try body only awaits the /week call, not periodization.
    const loadWeekBody = html.slice(html.indexOf('async function loadWeek()'), html.indexOf('async function loadPeriodization()'));
    expect(loadWeekBody).toMatch(/await api\('\/api\/programming\/week'\)/);
    expect(loadWeekBody).not.toMatch(/await loadPeriodization\(\)/);
  });

  it('a periodization failure degrades to null rather than throwing out of loadPeriodization', () => {
    const body = html.slice(html.indexOf('async function loadPeriodization()'), html.indexOf('function buildStateBanner()'));
    expect(body).toMatch(/catch\s*\{\s*periodizationData = null;/);
  });

  it('always renders something in the state banner — the exact required fallback sentence when data is unavailable', () => {
    expect(html).toMatch(/You are currently in a normal training state\./);
    const bannerBody = html.slice(html.indexOf('function buildStateBanner()'), html.indexOf('function renderStateBanner()'));
    expect(bannerBody).toMatch(/if \(!periodizationData\)/);
  });

  it('uses the backend explanation verbatim rather than re-deriving it', () => {
    expect(html).toMatch(/periodizationData\.explanation \|\| NORMAL_STATE_FALLBACK/);
  });

  it('never exposes blockKind, reactiveTriggerStatus, or specializationTargetId in the default view', () => {
    const bannerBody = html.slice(html.indexOf('function buildStateBanner()'), html.indexOf('function renderStateBanner()'));
    expect(bannerBody).not.toMatch(/blockKind|reactiveTriggerStatus|specializationTargetId/);
  });

  it('shows the deload end date only when present', () => {
    expect(html).toMatch(/if \(periodizationData\.deloadEndDate\)/);
  });
});

describe('program.html: exercise-level explanations (B3)', () => {
  const html = readFile('program.html');

  it('shows the pairing badge only when paired_with_exercise_name is present', () => {
    expect(html).toMatch(/if \(item\.paired_with_exercise_name\)/);
    expect(html).toMatch(/Paired with \$\{item\.paired_with_exercise_name\}/);
  });

  it('shows the "alternative considered" note only via the shared boolean derivation, never a raw candidate list', () => {
    expect(html).toMatch(/if \(wasAlternativeConsidered\(item\.decision\)\)/);
    expect(html).toMatch(/An alternative was considered based on your preferences\./);
    expect(html).not.toMatch(/rejected_candidates/);
    expect(html).not.toMatch(/decisive_gate/);
  });

  it('renders the component-level intensity-technique note with the exact required empty-state sentence', () => {
    expect(html).toMatch(/function buildIntensityTechniqueNote\(technique\)/);
    expect(html).toMatch(/No intensity technique is prescribed for this exercise\./);
    expect(html).toMatch(/buildIntensityTechniqueNote\(item\.applied_intensity_technique\)/);
  });

  it('shows the applied technique\'s name, instruction, extra fatigue note, and working set — never inventing a field', () => {
    const body = html.slice(html.indexOf('function buildIntensityTechniqueNote('), html.indexOf('// ---------- AI Programmer Proposal Review UI'));
    expect(body).toMatch(/technique\.name/);
    expect(body).toMatch(/technique\.instruction/);
    expect(body).toMatch(/technique\.extra_fatigue_note/);
    expect(body).toMatch(/technique\.applied_to_working_set_number/);
  });
});

// ---------- coaching-settings.html: B4 source-level wiring ----------

describe('coaching-settings.html: preferences and training-experience wiring (B4)', () => {
  const html = readFile('coaching-settings.html');

  it('uses the exact required empty-state string for no preferences', () => {
    expect(html).toMatch(/You have not added exercise preferences yet\./);
  });

  it('uses the exact required "Not set" string for an unset training experience', () => {
    expect(html).toMatch(/'Not set\.'/);
  });

  it('reuses the shared Blueprint exercise picker rather than a second implementation', () => {
    expect(html).toMatch(/createBlueprintExercisePicker\(exerciseCatalog/);
  });

  it('reads and writes the real preferences endpoints', () => {
    expect(html).toMatch(/api\('\/api\/programming\/preferences'\)/);
    expect(html).toMatch(/method: 'PUT',\s*\n\s*body: \{ preference, temporaryUntil, reason \}/);
    expect(html).toMatch(/method: 'DELETE' /);
  });

  it('re-fetches the preference list after a save/remove rather than an optimistic local mutation', () => {
    const saveBody = html.slice(html.indexOf("getElementById('save-preference-btn')"), html.indexOf("// ---------- Training experience"));
    expect(saveBody).toMatch(/await loadPreferences\(\);/);
    const cardFnBody = html.slice(html.indexOf('function buildPreferenceCard('), html.indexOf("getElementById('save-preference-btn')"));
    expect(cardFnBody).toMatch(/await loadPreferences\(\);/);
  });

  it('every save action is wrapped in withSaving (spec §8: no duplicate submissions, clear success/error state)', () => {
    const matches = html.match(/withSaving\(/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(3); // preference save, preference remove, experience save (clear uses it too)
  });

  it('reads and writes the real training_experience profile-factor endpoints, restricted to the one supported factor', () => {
    expect(html).toMatch(/api\('\/api\/programming\/profile-factors'\)/);
    expect(html).toMatch(/f\.factorName === 'training_experience'/);
    expect(html).toMatch(/api\('\/api\/programming\/profile-factors\/training_experience', \{ method: 'PUT', body: \{ value, userConfirmed: true \} \}\)/);
    expect(html).toMatch(/api\('\/api\/programming\/profile-factors\/training_experience', \{ method: 'DELETE' \}\)/);
  });

  it('never offers a generic "any factor name" control — only training_experience is wired', () => {
    expect(html).not.toMatch(/factor-name-input|arbitrary factor|custom factor/i);
  });

  it('renders the confirmation/source state, distinguishing user-entered from other sources', () => {
    expect(html).toMatch(/factor\.userConfirmed \? 'Confirmed by you' : 'Not yet confirmed'/);
    expect(html).toMatch(/factor\.source \|\| 'User-entered'/);
  });

  it('is reachable from the shared nav', () => {
    expect(html).toMatch(/renderAppHeader\('\/coaching-settings\.html'\)/);
  });
});

// ---------- coaching-insights.html: B5 source-level wiring ----------

describe('coaching-insights.html: advisories, recovery state, and prescribed techniques (B5)', () => {
  const html = readFile('coaching-insights.html');

  it('uses the exact required empty-state string for no structural advisories', () => {
    expect(html).toMatch(/No structural advisories are active for this plan\./);
  });

  it('uses a plain-language, appropriately-pluralized empty state for zero techniques prescribed this week', () => {
    expect(html).toMatch(/No intensity techniques are prescribed this week\./);
  });

  it('reads the real structural-advisories endpoint and never recomputes severity/category client-side', () => {
    expect(html).toMatch(/api\('\/api\/programming\/structural-advisories'\)/);
    expect(html).toMatch(/formatAdvisorySeverity\(advisory\.severity\)/);
  });

  it('severity is always paired with a text label via createStatusBadge — never color alone', () => {
    expect(html).toMatch(/createStatusBadge\(advisory\.severity, formatAdvisorySeverity\(advisory\.severity\)\)/);
  });

  it('prefers affected_target_names, falling back to raw affected_targets only if absent', () => {
    expect(html).toMatch(/advisory\.affected_target_names && advisory\.affected_target_names\.length > 0 \? advisory\.affected_target_names : advisory\.affected_targets/);
  });

  it('never presents an advisory as a diagnosis (spec §4E wording check — no clinical/injury language)', () => {
    expect(html).not.toMatch(/injury|pathology|medical condition/i);
  });

  it('derives prescribed techniques from the already-loaded /week response, never the separate reference catalog', () => {
    expect(html).toMatch(/collectWeekAppliedTechniques\(week\.days\)/);
    expect(html).not.toMatch(/\/api\/programming\/intensity-techniques/);
  });

  it('reuses the same periodization fields as the weekly-plan state banner rather than duplicating logic', () => {
    expect(html).toMatch(/api\('\/api\/programming\/periodization'\)/);
    expect(html).toMatch(/formatDeloadReason\(data\.deloadReason\)/);
  });

  it('is reachable from the shared nav', () => {
    expect(html).toMatch(/renderAppHeader\('\/coaching-insights\.html'\)/);
  });
});
