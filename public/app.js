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
    throw new Error(err.error || 'request failed');
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

/** {sets, reps_min, reps_max} -> "4 × 6–8" (or "4 × 8" when min===max). */
function formatSets(sets, repsMin, repsMax) {
  const reps = repsMin === repsMax ? `${repsMin}` : `${repsMin}–${repsMax}`;
  return `${sets} × ${reps}`;
}

/** A GoalType ('aesthetic'|'functional') -> its display label. */
function formatGoalType(goalType) {
  return goalType === 'aesthetic' ? 'Aesthetic' : 'Functional';
}

/** An open SessionType/ActivityType string ('gym'|'badminton'|'rest'|
 * 'other'|anything) -> a Title Case label — never assumes only these
 * values exist (spec §41). */
function formatSessionType(type) {
  if (!type) return 'Other';
  return type.charAt(0).toUpperCase() + type.slice(1);
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
};

/** A status word ('planned'|'in_progress'|'completed'|'rest'|'skipped'|
 * an open activity_type) -> a badge element. Never color-only (spec
 * §45): the label text itself always carries the meaning too. */
function createStatusBadge(status, label) {
  const variant = BADGE_VARIANT[status] || 'badge-activity';
  return el('span', { class: `badge ${variant}` }, [document.createTextNode(label || formatSessionType(status))]);
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
