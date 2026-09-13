// Shared frontend helpers — spec §6/§46/§70: formatting, DOM
// construction, loading/error/empty state rendering, and simple local UI
// state ONLY. Nothing here computes a programming decision (volume,
// exposure, goal priority, exercise selection, weekly allocation,
// progression, calories) — every number/label rendered by these helpers
// is a value already decided by the backend, just formatted for
// display.

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const error = new Error(err.error || 'request failed');
    // Fix 7 (Activity Scheduling and AI Alignment Fixes): some error
    // bodies carry structured fields beyond `error` (e.g.
    // `generationRequired`, `conflictingSessionId`) that a caller may
    // need to react to differently — attached here, additively, so
    // every existing message-only caller is unaffected.
    error.body = err;
    throw error;
  }
  return res.status === 204 ? null : res.json();
}

// Never innerHTML for API/user text (spec §69) — every child is either a
// DOM node or set via textContent (the 'text' attr below).
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else if (v === false || v === null || v === undefined) continue;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children) node.appendChild(child);
  return node;
}

// Local calendar date (YYYY-MM-DD) in the BROWSER's own timezone — never
// toISOString(), which is always UTC regardless of where the browser is.
// This is a convenience default for pre-filling forms; the server is the
// source of truth for "today" and resolves it from the user's configured
// TrainingProfile.timezone (see src/lib/timezone.ts), not from this value.
function todayIso() {
  const d = new Date();
  return d.toLocaleDateString('en-CA'); // en-CA formats as YYYY-MM-DD
}

// ---------- Navigation (spec §4/§5) ----------

const NAV_ITEMS = [
  { href: '/today.html', label: 'Today' },
  { href: '/program.html', label: 'Program' },
  { href: '/index.html', label: 'Goals' },
  { href: '/history.html', label: 'History' },
  { href: '/profile.html', label: 'Profile' },
];

/** Renders the shared <header><nav>...</nav></header> structure into the
 * page's #app-header placeholder. `activeHref` marks the current page
 * (aria-current) — call once, near the top of each page's script. */
function renderAppHeader(activeHref) {
  const header = document.getElementById('app-header');
  if (!header) return;
  header.innerHTML = '';
  header.appendChild(el('a', { class: 'app-name', href: '/today.html', text: 'Workout Programmer' }));
  const nav = el('nav', { class: 'app-nav', 'aria-label': 'Primary' });
  for (const item of NAV_ITEMS) {
    const a = el('a', { href: item.href, text: item.label });
    if (item.href === activeHref) a.setAttribute('aria-current', 'page');
    nav.appendChild(a);
  }
  header.appendChild(nav);
}

// ---------- Loading / error / empty states (spec §7/§66-68) ----------

/** Replaces `container`'s content with a visible loading indicator. Every
 * async page load must show this before its data arrives — never a
 * blank page (spec §7). */
function showLoading(container, message = 'Loading…') {
  container.innerHTML = '';
  container.appendChild(
    el('div', { class: 'state-block state-loading', role: 'status', 'aria-live': 'polite' }, [
      el('span', { class: 'spinner', 'aria-hidden': 'true' }),
      el('span', { text: message }),
    ])
  );
}

/** Replaces `container`'s content with a visible error + Retry — never
 * alert() for a normal API failure (spec §7/§68). `retryAction`, if
 * given, is called when Retry is clicked. */
function showError(container, message, retryAction) {
  container.innerHTML = '';
  const block = el('div', { class: 'state-block state-error', role: 'alert' }, [el('p', { text: message })]);
  if (retryAction) {
    const retry = createButton({ label: 'Retry', variant: 'secondary', onClick: retryAction });
    block.appendChild(retry);
  }
  container.appendChild(block);
}

/** Replaces `container`'s content with an empty-state message and an
 * optional call-to-action element (spec §67). */
function showEmpty(container, message, actionEl) {
  container.innerHTML = '';
  const block = el('div', { class: 'state-block' }, [el('p', { text: message })]);
  if (actionEl) block.appendChild(actionEl);
  container.appendChild(block);
}

/** Shows an inline (never alert()) success/error message after a save,
 * auto-clearing on the next call. Returns nothing; call again to update. */
function showInlineStatus(container, kind, message) {
  container.innerHTML = '';
  if (!message) return;
  container.appendChild(el('div', { class: `inline-status status-${kind}`, role: kind === 'error' ? 'alert' : 'status', text: message }));
}

// ---------- Formatting (spec §6; display only — never a computed decision) ----------

const WEEKDAY_DISPLAY = {
  monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday', thursday: 'Thursday',
  friday: 'Friday', saturday: 'Saturday', sunday: 'Sunday',
};

/** "2026-08-31" -> "Mon, Aug 31". Pure string/date formatting — the
 * calendar date itself always comes from the backend. */
function formatDate(dateIso, opts = {}) {
  if (!dateIso) return '';
  const [y, m, d] = dateIso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString('en-US', { weekday: opts.weekday || 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function formatWeekday(weekday) {
  return WEEKDAY_DISPLAY[weekday] || weekday;
}

/** Minutes (a plain number) -> "62 min" / "1h 5m". */
function formatDuration(minutes) {
  if (minutes === null || minutes === undefined) return '—';
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

/** A closed [min, max] range -> "6" (when min===max) or "6–8" — the one
 * place this collapsing rule lives, shared by every range-shaped
 * prescription field (reps, RIR, ...). */
function formatRange(min, max) {
  return min === max ? `${min}` : `${min}–${max}`;
}

/** {sets, reps_min, reps_max} -> "4 × 6–8" (or "4 × 8" when min===max). */
function formatSets(sets, repsMin, repsMax) {
  return `${sets} × ${formatRange(repsMin, repsMax)}`;
}

/** AI Programmer Proposal Review UI: an exercise proposal's rirMin/
 * rirMax -> "RIR 1–3" (or "RIR 2" when min===max) — the RIR analogue of
 * formatSets, reusing the exact same range-collapsing rule. */
function formatRirRange(rirMin, rirMax) {
  return `RIR ${formatRange(rirMin, rirMax)}`;
}

/** AI Programmer Proposal Review UI: an exercise proposal's optional
 * restSeconds -> "90s rest" / "1m 30s rest" / "2m rest". Returns null
 * (never a fabricated "0s"/"—") when restSeconds is absent — the
 * caller is expected to simply omit the line rather than show a
 * placeholder for a field the proposal itself didn't include. */
function formatRestSeconds(seconds) {
  if (seconds === null || seconds === undefined) return null;
  if (seconds < 60) return `${seconds}s rest`;
  const m = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem === 0 ? `${m}m rest` : `${m}m ${rem}s rest`;
}

/** An ISO instant (e.g. a proposal's createdAt) -> "Sep 13, 4:15 PM" in
 * the browser's own local time. Returns '' for a missing/invalid value
 * — callers should skip the line entirely rather than show it. */
function formatTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Any non-empty word -> the same word with its first letter
 * capitalized ("primary" -> "Primary"). The single shared
 * implementation formatSessionType also uses. */
function capitalize(word) {
  if (!word) return '';
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** A GoalType ('aesthetic'|'functional') -> its display label. */
function formatGoalType(goalType) {
  return goalType === 'aesthetic' ? 'Aesthetic' : 'Functional';
}

/** An open SessionType/ActivityType string ('gym'|'badminton'|'rest'|
 * 'other'|anything) -> a Title Case label — never assumes only these
 * values exist (spec §41). */
function formatSessionType(type) {
  return type ? capitalize(type) : 'Other';
}

const CLASSIFICATION_LABEL = {
  specialization: 'Goal-focused work',
  normal_development: 'Whole-physique development',
  maintenance: 'Maintenance work',
};

/** A TargetClassification enum value -> its already-decided display
 * label — a fixed 3-entry lookup table, not a computed decision (the
 * classification itself was decided by the backend). */
function formatClassification(classification) {
  return CLASSIFICATION_LABEL[classification] || classification;
}

const PROGRESSION_LABEL = {
  increase_load: 'Progressing — load increasing',
  increase_reps: 'Progressing — reps increasing',
  maintain: 'Holding steady',
  reduce: 'Easing back',
  unknown: null,
};

function formatProgression(recommendation) {
  return PROGRESSION_LABEL[recommendation] ?? null;
}

/** A short, plain-English one-liner for one planned/logged exercise,
 * built ONLY from fields the backend already resolved/decided
 * (target_name, classification, goal_label, progression recommendation)
 * — string templating, never a re-derivation of why the engine chose
 * this exercise or how many sets it needs (spec §65/§70). The engine's
 * own full `reasoning` string is always available alongside this as the
 * "full detail" expansion — see createExerciseCard. */
function describeWork(item) {
  const parts = [];
  const focus = item.goal_label && item.goal_label.startsWith('Goal') ? `${item.goal_label} — ${item.target_name}` : `${formatClassification(item.classification)} — ${item.target_name}`;
  parts.push(focus + '.');
  const progressionText = item.progression_decision ? formatProgression(item.progression_decision.recommendation) : null;
  if (progressionText) parts.push(progressionText + '.');
  return parts.join(' ');
}

// ---------- DOM builders ----------

function createButton({ label, onClick, variant = 'primary', type = 'button', disabled = false, ariaLabel } = {}) {
  const classes = ['btn'];
  if (variant === 'secondary') classes.push('btn-secondary');
  if (variant === 'ghost') classes.push('btn-ghost');
  if (variant === 'danger') classes.push('btn-danger');
  const attrs = { type, class: classes.join(' ') };
  if (disabled) attrs.disabled = true;
  if (ariaLabel) attrs['aria-label'] = ariaLabel;
  const btn = el('button', attrs, [document.createTextNode(label)]);
  if (onClick) btn.addEventListener('click', onClick);
  return btn;
}

function createCard(children = [], opts = {}) {
  const attrs = { class: opts.clickable ? 'card card-clickable' : 'card' };
  if (opts.clickable) {
    attrs.tabindex = '0';
    attrs.role = 'button';
  }
  const card = el('div', attrs, children);
  if (opts.onClick) {
    card.addEventListener('click', opts.onClick);
    if (opts.clickable) {
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          opts.onClick(e);
        }
      });
    }
  }
  return card;
}

const BADGE_VARIANT = {
  planned: 'badge-neutral',
  in_progress: 'badge-progress',
  completed: 'badge-success',
  skipped: 'badge-warning',
  rest: 'badge-rest',
  badminton: 'badge-activity',
  // AI Programmer Proposal Review UI: proposal lifecycle statuses.
  pending: 'badge-warning',
  approved: 'badge-progress',
  committed: 'badge-success',
  expired: 'badge-neutral',
  rejected: 'badge-neutral',
};

/** A status word ('planned'|'in_progress'|'completed'|'rest'|'skipped'|
 * an open activity_type) -> a badge element. Never color-only (spec
 * §45): the label text itself always carries the meaning too. */
function createStatusBadge(status, label) {
  const variant = BADGE_VARIANT[status] || 'badge-activity';
  return el('span', { class: `badge ${variant}` }, [document.createTextNode(label || formatSessionType(status))]);
}

// ---------- Blueprint exercise picker (spec: Blueprint Picker/Daily Activity §3) ----------

/** A searchable dropdown over the COMPLETE Blueprint exercise library —
 * plain case-insensitive name substring search only, deliberately no
 * relevance/muscle-group/goal/equipment filtering (that filtering
 * belongs only to the separate, unchanged Substitute picker — see
 * openSubstitutePicker in logger.html, which this function is never
 * used by). The caller must explicitly click a result; typed text alone
 * is never a valid selection, so it can never bypass backend Blueprint-
 * ID validation.
 *
 * Returns { root, getSelected, reset }:
 *   - root: the DOM subtree to insert wherever the picker belongs.
 *   - getSelected(): the currently selected { id, name }, or null.
 *   - reset(): clears the search text and selection (e.g. after a
 *     successful "Add exercise" submit).
 */
function createBlueprintExercisePicker(exercises, { onChange } = {}) {
  const MAX_RESULTS = 50;
  let selected = null;

  const search = el('input', {
    type: 'text',
    placeholder: 'Search Blueprint exercises…',
    'aria-label': 'Search Blueprint exercises',
    autocomplete: 'off',
  });
  const results = el('div', { class: 'exercise-picker-results', role: 'listbox' });
  const selectedIndicator = el('div', { class: 'exercise-picker-selected' });
  const root = el('div', { class: 'exercise-picker' }, [search, results, selectedIndicator]);

  function renderResults() {
    results.innerHTML = '';
    const query = search.value.trim().toLowerCase();
    // Plain substring match on name only — the entire library when the
    // search is empty (capped, per spec: "do not create a giant
    // unusable DOM list"), narrowed as the user types. No ranking: the
    // result order is always the library's own order.
    const matches = exercises.filter((ex) => ex.name.toLowerCase().includes(query)).slice(0, MAX_RESULTS);
    if (matches.length === 0) {
      results.appendChild(el('div', { class: 'exercise-picker-empty', text: 'No Blueprint exercises found.' }));
      return;
    }
    for (const ex of matches) {
      const item = el('button', { type: 'button', class: 'exercise-picker-item', role: 'option' }, [document.createTextNode(ex.name)]);
      item.addEventListener('click', () => {
        selected = { id: ex.id, name: ex.name };
        search.value = ex.name;
        renderSelected();
        results.innerHTML = '';
        results.hidden = true;
        if (onChange) onChange(selected);
      });
      results.appendChild(item);
    }
  }

  function renderSelected() {
    selectedIndicator.innerHTML = '';
    if (selected) {
      selectedIndicator.appendChild(el('span', { class: 'badge badge-success', text: `Selected: ${selected.name} (Blueprint)` }));
    }
  }

  search.addEventListener('input', () => {
    // Typing after a selection invalidates it — the only way to select
    // is to explicitly click a result again (spec: "arbitrary typed text
    // without selection is rejected").
    if (selected && search.value !== selected.name) {
      selected = null;
      renderSelected();
      if (onChange) onChange(null);
    }
    results.hidden = false;
    renderResults();
  });
  search.addEventListener('focus', () => {
    results.hidden = false;
    renderResults();
  });
  document.addEventListener('click', (e) => {
    if (!root.contains(e.target)) results.hidden = true;
  });

  results.hidden = true;

  return {
    root,
    getSelected: () => selected,
    reset: () => {
      selected = null;
      search.value = '';
      renderSelected();
      results.innerHTML = '';
      results.hidden = true;
    },
  };
}

// ---------- AI Programmer proposal review (Proposal Review UI spec) ----------

/** Every backend AI Programmer error code this app knows how to
 * translate into a short, safe, user-facing sentence — spec §5's
 * required mapping. Deliberately a closed lookup table: an unmapped
 * code (a future backend error this table hasn't been updated for)
 * falls through to mapAiErrorCode's generic fallback rather than ever
 * showing the raw code or the backend's own `message`/`details`
 * fields, which may contain more technical detail than is safe to
 * render directly. */
const AI_ERROR_MESSAGES = {
  AI_PROGRAMMER_DISABLED: 'AI Programmer is disabled.',
  AI_TARGET_NOT_EDITABLE: "This date can't be edited — it already has a workout logged, or it's in the past.",
  AI_PROVIDER_CONFIGURATION_ERROR: 'The AI provider is temporarily unavailable. Please try again in a moment.',
  AI_PROVIDER_AUTHENTICATION_ERROR: 'The AI provider is temporarily unavailable. Please try again in a moment.',
  AI_PROVIDER_TIMEOUT: 'The AI provider is temporarily unavailable. Please try again in a moment.',
  AI_PROVIDER_RATE_LIMITED: 'The AI provider is temporarily unavailable. Please try again in a moment.',
  AI_PROVIDER_UNAVAILABLE: 'The AI provider is temporarily unavailable. Please try again in a moment.',
  AI_PROVIDER_INVALID_RESPONSE: 'The proposal could not be validated. Please try generating again.',
  AI_OUTPUT_SCHEMA_INVALID: 'The proposal could not be validated. Please try generating again.',
  AI_OUTPUT_DOMAIN_INVALID: 'The proposal could not be validated. Please try generating again.',
  AI_CONTEXT_INCOMPLETE: 'Your training profile is incomplete. Please finish setup on the Profile page first.',
  AI_PROPOSAL_NOT_FOUND: 'This proposal could not be found. It may have expired or been removed.',
  AI_PROPOSAL_INVALID_STATE: "This proposal's status no longer allows that action.",
  AI_PROPOSAL_EXPIRED: 'This proposal expired. Please generate a new one.',
  AI_PROPOSAL_CONFLICT: 'A planned workout already exists for this date.',
  AI_PROPOSAL_STALE: 'This proposal is out of date and must be regenerated.',
  AI_PROPOSAL_VALIDATION_FAILED: 'The proposal could not be validated. Please try generating again.',
  AI_PROPOSAL_COMMIT_FAILED: 'This proposal could not be committed. Please try again.',
};

function mapAiErrorCode(code) {
  return AI_ERROR_MESSAGES[code] || 'Something went wrong. Please try again.';
}

/** A dedicated fetch wrapper for the AI Programmer endpoints — NOT the
 * shared `api()` helper, because these routes return a richer
 * `{ok, error, message, details}` envelope (see src/server/routes/
 * aiProgrammer.ts) whose `message`/`details` fields may legitimately
 * contain more technical detail than is safe to show a user (they are
 * meant for logs/debugging, not display). Every error this throws has
 * already been mapped to one of AI_ERROR_MESSAGES (or the generic
 * fallback) — callers can always show `err.message` directly without
 * re-checking what kind of error it was. `err.code` carries the raw
 * backend code too, for callers that need to branch on it (e.g. to
 * decide whether to re-fetch current state). */
async function aiApi(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new Error('Something went wrong. Please try again.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    const err = new Error(mapAiErrorCode(body.error));
    err.code = body.error || null;
    throw err;
  }
  return body;
}

/** Pure lifecycle-representation logic (Proposal Review UI spec §3):
 * given a proposal's current status (or `null` before one has been
 * generated yet), which of the four actions should the UI offer right
 * now? Kept separate from any DOM code specifically so the lifecycle
 * rules themselves — "approval is a separate action from commit",
 * "commit is never available before approval", "a committed/expired/
 * rejected proposal offers only 'generate a new one'" — are a single,
 * directly testable source of truth, not something re-derived ad hoc
 * wherever a button happens to be rendered. */
function aiProposalActionsFor(status) {
  return {
    canGenerate: status === null || status === undefined || status === 'expired' || status === 'rejected',
    canApprove: status === 'pending',
    canCommit: status === 'approved',
    isCommitted: status === 'committed',
  };
}

/** Discovery/Rehydration spec §4's "expired/rejected proposal found"
 * case: a small, non-blocking note explaining why a previously-active
 * proposal is no longer shown as such — never a reason to block
 * generation (aiProposalActionsFor already reports canGenerate: true
 * for both statuses). Returns null for every other status, meaning
 * "show no notice". Pure and DOM-free so the exact set of statuses that
 * trigger this message is directly testable, matching
 * aiProposalActionsFor's own pattern. */
function aiProposalNoticeFor(status) {
  if (status === 'expired' || status === 'rejected') {
    return 'The previous proposal is no longer active. You can generate a new one.';
  }
  return null;
}

// ---------- Save-in-flight helper (spec §8) ----------

/** Wraps a save button: disables it (preventing duplicate POST/PATCH),
 * runs `fn`, shows inline success/error via `statusContainer`, and
 * re-enables the button — the entered form values are left untouched on
 * failure (spec §8/§61). Returns fn's result, or throws. */
async function withSaving(button, statusContainer, fn, successMessage) {
  button.disabled = true;
  showInlineStatus(statusContainer, 'saving', 'Saving…');
  try {
    const result = await fn();
    showInlineStatus(statusContainer, 'success', successMessage || 'Saved.');
    return result;
  } catch (err) {
    showInlineStatus(statusContainer, 'error', err.message || 'Something went wrong.');
    throw err;
  } finally {
    button.disabled = false;
  }
}
