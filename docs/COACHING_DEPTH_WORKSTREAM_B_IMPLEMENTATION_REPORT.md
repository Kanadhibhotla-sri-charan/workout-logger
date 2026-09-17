# Coaching Depth — Workstream B Implementation Report

Status: implemented, verified, **not committed** (working tree left staged/unstaged per instructions).

This covers Workstream B (the user-facing coaching-depth UI) of
`docs/COACHING_DEPTH_NEXT_STEPS_IMPLEMENTATION_SPEC.md`, built against the
already-completed data contract in
`docs/COACHING_DEPTH_UI_DATA_CONTRACT.md`. Workstream A (test-fixture
fixes) was explicitly out of scope and untouched — see the regression
baseline at the end of this report.

---

## 1. What was built, surface by surface

### B2 — Weekly plan state/explanation (`public/program.html`)

- `loadWeek()` now also calls a new `loadPeriodization()` — a fetch of
  `GET /api/programming/periodization` that is **independent** of the
  `/week` fetch: it is fired before `loadWeek`'s own `await`, has its own
  try/catch, and is never awaited inside `loadWeek`'s try block. A
  periodization failure sets `periodizationData = null` and never throws
  out of `loadWeek` — the weekly plan itself always renders regardless of
  whether periodization succeeded (data contract §1's fallback rule,
  spec §8).
- A new `#state-banner` element (sibling of `#week-container`, not nested
  inside it) is rendered by `renderStateBanner()`/`buildStateBanner()`
  independently of the week grid's own loading/empty/error states, so it
  is never wiped by `showEmpty`/`showError` being called on
  `#week-container`.
- `buildStateBanner()` consumes exactly the data-contract §1 fields:
  `periodizationData.deloadReason` (via the new shared `formatDeloadReason`
  helper), `periodizationData.explanation` (shown **verbatim**, never
  re-derived), and `periodizationData.deloadEndDate` (shown only when
  present). When periodization is unavailable, it shows the exact
  required fallback sentence "You are currently in a normal training
  state." `blockKind`, `reactiveTriggerStatus`, and
  `specializationTargetId` are never referenced.
- Growth-goal summary (`renderGoalSummary`) and the per-day
  "why this week looks like this" explanations (via
  `friendly_reasoning`/`friendly_reason`, already rendered by the
  pre-existing `buildExerciseDetailCard`/day-modal code) were already
  shipped before this batch and are unchanged.

### B3 — Exercise-level explanations (`public/program.html`, `buildExerciseDetailCard`)

- **Pairing**: `item.paired_with_exercise_name` is rendered as a small
  neutral badge ("Paired with `<name>`") only when present — never a
  bare id.
- **Alternative-considered note**: the new shared `wasAlternativeConsidered(item.decision)`
  helper (pure, in `app.js`) derives a boolean from
  `decision.selection.rejected_candidates.length > 0` OR
  `decision.selection.substituted_from !== null`, tolerating a missing
  `decision`/`selection`. Only when true does the card show "An
  alternative was considered based on your preferences." — the raw
  candidate list and `decisive_gate` are never read anywhere in the page.
- **Intensity technique**: a new `buildIntensityTechniqueNote(item.applied_intensity_technique)`
  shows the technique's `name`, `instruction`, `extra_fatigue_note`
  (when present), and `applied_to_working_set_number` when a technique is
  applied, or the exact required sentence "No intensity technique is
  prescribed for this exercise." when it is `null` — deliberately
  distinct wording from Coaching Insights' session-level empty state.

### B4 — Coaching Settings (`public/coaching-settings.html`, new page)

- **Preferences**: `GET /api/programming/preferences` → list, with the
  exact required empty state "You have not added exercise preferences
  yet." Each row shows the exercise name, the preference-kind label +
  wording (via the new shared `formatPreferenceKind`, which distinguishes
  "preferred"/"disliked" — "the program may favor/deprioritize" — from
  "avoided" — "will not prescribe unless removed", per data contract
  §3), `temporaryUntil`/`reason` when present, and a Remove button
  (`DELETE /preferences/:exerciseId`) wrapped in `withSaving`. The list is
  always re-fetched after a successful save/remove (never optimistic).
- **Add/update a preference**: reuses `createBlueprintExercisePicker`
  against `GET /api/blueprint/exercises`, plus a preference-kind
  `<select>` (`preferred`/`disliked`/`avoided`) and optional
  `temporaryUntil`/`reason` inputs → `PUT /preferences/:exerciseId`,
  wrapped in `withSaving`. An unselected exercise is rejected inline
  ("Choose an exercise from the list first.") rather than silently
  submitting garbage.
- **Training experience**: `GET /api/programming/profile-factors`
  filtered to `factorName === 'training_experience'`; a
  novice/intermediate/advanced `<select>` → `PUT /profile-factors/training_experience`
  with `{value, userConfirmed: true}`, and a Clear button →
  `DELETE /profile-factors/training_experience`. Shows the current value,
  its programming effect in one sentence, and its confirmation/source
  state ("Confirmed by you"/"Not yet confirmed" · "Source: …"). Exact
  required empty state "Not set." No generic "any factor name" control
  was built — only `training_experience` is wired, matching
  `SUPPORTED_PROFILE_FACTORS` in `programming.ts`.

### B5 — Coaching Insights (`public/coaching-insights.html`, new page)

- **Recovery/training state**: reuses the same `GET /periodization`
  fields and the same `formatDeloadReason` helper as B2 — no duplicated
  logic, and the same fallback sentence when unavailable.
- **Structural advisories**: `GET /api/programming/structural-advisories`
  → cards showing category (plain-language title), severity (always a
  text label via `formatAdvisorySeverity` **and** a badge — never
  color-only), the resolved affected-target name(s), evidence,
  explanation, and suggested review action. Exact required empty state
  "No structural advisories are active for this plan." Never uses
  clinical/injury/diagnostic language to describe an advisory.
- **Techniques prescribed this week**: derived by the new shared
  `collectWeekAppliedTechniques(week.days)` helper, which scans the
  already-loaded `GET /week` response's
  `plannedWork[].applied_intensity_technique` entries — it never calls
  `GET /intensity-techniques` (that catalog has no scheduling
  information; asking it "is this in use" would be re-deriving an
  eligibility decision the backend already owns, per data contract §5
  point 2). Empty state: "No intensity techniques are prescribed this
  week." (the whole-week-rollup equivalent of the exact per-session
  string, worded consistently in the same plain-language register).

### Shared helpers added to `public/app.js`

All pure, DOM-free, and covered directly by the new test file:

- `formatDeloadReason(deloadReason)` — periodization enum → fixed label,
  safe fallback for unknown values.
- `wasAlternativeConsidered(decision)` — boolean-only derivation, never
  exposes `rejected_candidates`/`decisive_gate`.
- `formatPreferenceKind(preference)` — label + the exact wording
  distinction data contract §3 requires.
- `formatAdvisorySeverity(severity)` — text label, paired with (never
  replacing) a color badge.
- `collectWeekAppliedTechniques(days)` — the week-wide technique scanner.
- `NAV_ITEMS` extended with `/coaching-insights.html` ("Insights") and
  `/coaching-settings.html` ("Coaching"), automatically picked up by
  every page's `renderAppHeader()`.
- `BADGE_VARIANT` extended with `INFO`/`WATCH`/`REVIEW` (structural
  advisory severities), and a new `.badge-danger` CSS class (reusing the
  existing `--danger`/`--danger-bg` tokens) added to `public/style.css`
  for `REVIEW`.

### The one backend change: `affected_target_names` on `/structural-advisories`

Per data contract §5 point 1: `GET /api/programming/structural-advisories`
now also returns `affected_target_names: string[]` (a parallel array to
`affected_targets`), resolved via the exact same `resolveTargetName`
helper every other route in `src/server/routes/programming.ts` already
calls. **Justification for adding this rather than resolving
client-side**: Coaching Insights is a brand-new page with no other
existing reason to load the `GET /api/blueprint/targets` catalog (unlike
`program.html`, which already loads it for other purposes) — per the
data contract's own guidance ("prefer the client-side reuse if the
catalogs are already loaded on this page, only add the backend field if
this page has no other reason to load that catalog"), adding the field
was the right call here. Both real advisory categories
(`push_pull_imbalance`, `persistent_target_coverage_gap`) only ever put
`physique_target` ids into `affected_targets` (verified directly in
`structuralAdvisoryService.ts`), so the route resolves every id via
`resolveTargetName('physique_target', id)` — no new resolution mechanism,
no new persisted state, no new business logic. Verified end-to-end with a
real HTTP smoke test (see §4): a specialization goal on `mid-pec` +
`upper-pec` with zero logged history correctly produces
`affected_target_names: ["Mid Chest"]` / `["Upper Pec"]`.

---

## 2. Files changed

| File | Change |
|---|---|
| `public/app.js` | `NAV_ITEMS` (+2 pages), `BADGE_VARIANT` (+3 severities), 6 new shared coaching-depth pure helpers |
| `public/program.html` | B2 state banner (new `#state-banner` element + `loadPeriodization`/`buildStateBanner`/`renderStateBanner`), B3 exercise-card extensions (pairing badge, alternative-considered note, intensity-technique block) |
| `public/style.css` | `.state-banner`, `.exercise-pairing-note`, `.intensity-technique-note`(`.is-empty`), `.badge-danger` |
| `public/coaching-settings.html` | **New page** — B4 |
| `public/coaching-insights.html` | **New page** — B5 |
| `src/server/routes/programming.ts` | `affected_target_names` added to `GET /structural-advisories` |
| `tests/routes/programming.test.ts` | One new test proving the `affected_target_names` addition resolves real display names, parallel to `affected_targets` |
| `tests/frontend/coachingDepthUI.test.ts` | **New test file** — see §3 |
| `docs/COACHING_DEPTH_WORKSTREAM_B_IMPLEMENTATION_REPORT.md` | This report |

No file under `tests/ai-programmer/` was touched. Neither spec document
(`COACHING_DEPTH_NEXT_STEPS_IMPLEMENTATION_SPEC.md`,
`COACHING_DEPTH_UI_DATA_CONTRACT.md`) was modified.

---

## 3. Tests added and what they prove

### `tests/frontend/coachingDepthUI.test.ts` (50 tests, all passing)

Follows this repo's established extract-and-eval technique (brace-balanced
slicing of real functions/consts out of the shipped `app.js`/`program.html`,
evaluated via `new Function`, then exercised with fixture data) exactly as
modeled on `tests/frontend/aiProposalUI.test.ts` and
`tests/frontend/copyWorkoutText.test.ts`:

- **`formatDeloadReason`** — normal/calendar/reactive/combined/manual
  mapping, never returns an internal state-machine term, degrades unknown
  values safely.
- **`wasAlternativeConsidered`** — every truth-table combination of
  missing/empty/populated `rejected_candidates` and `substituted_from`;
  proves the raw candidate list/`decisive_gate` are never what's returned
  (only a boolean).
- **`formatPreferenceKind`** — proves the exact "may favor"/"may
  deprioritize" vs. "will not prescribe…unless you remove" wording
  distinction, three distinct labels, safe fallback.
- **`formatAdvisorySeverity`** — every known severity maps to a non-raw
  label; unknown severities degrade safely.
- **`collectWeekAppliedTechniques`** — empty week, a week with one
  applied technique (correctly attributed to its real day/exercise),
  tolerance of missing/malformed `days`/`plannedWork`, and a source-level
  check that it never references `/intensity-techniques`.
- **`NAV_ITEMS`** — both new pages are present with non-empty labels.
- **Source-level wiring assertions** against the real shipped
  `program.html`, `coaching-settings.html`, and `coaching-insights.html`
  covering: the independent periodization fetch (never awaited inside
  `loadWeek`'s try block), the exact required fallback/empty-state
  strings, that `blockKind`/`reactiveTriggerStatus`/`specializationTargetId`
  are never referenced, the pairing/alternative-considered/
  intensity-technique wiring in `buildExerciseDetailCard`, every
  preferences/profile-factor endpoint call and its re-fetch-after-save
  behavior, `withSaving` usage, the exclusion of a generic
  "any factor name" control, severity always paired with a text label,
  preference for `affected_target_names` over raw ids, and that
  Coaching Insights' techniques list never queries the separate
  reference catalog.

### `tests/routes/programming.test.ts` (+1 test)

`GET resolves affected_targets ids to real display names via
affected_target_names, parallel to affected_targets` — creates a real
`chest-front-width` aesthetic goal (the same fixture pattern already used
throughout this file) against a fresh in-memory DB with zero logged
history, which the real `coverageGapAdvisories` logic already flags as a
`persistent_target_coverage_gap` advisory for `mid-pec` with zero
additional setup. Asserts `affected_target_names` is an array parallel to
`affected_targets`, that its value is a real resolved name (not the raw
id, not blank). This is a genuine end-to-end exercise of the new route
code through the real Express app, not a mock.

---

## 4. Verification results

| Check | Result |
|---|---|
| `npm run typecheck` | **Pass** — zero errors |
| `npm run build` (`tsc -p tsconfig.build.json`) | **Pass** — zero errors |
| `npx vitest run tests/frontend/` | **195 passed** (10 files), zero failures |
| `npm test -- --run` (full suite) | **1472 passed / 231 failed**, 136 files (122 passed / 14 failed) |
| Pre-existing baseline (per task) | 231 failures across 14 files, all under `tests/ai-programmer/` |
| This diff's effect on that baseline | **Unchanged** — same 14 files, same 231 count, confirmed by listing every `FAIL` line from the full run and diffing against `tests/ai-programmer/*.test.ts` |

Full-suite failing files (all 14, all under `tests/ai-programmer/`,
none touched by this diff):

```
tests/ai-programmer/aiProgrammerRoute.test.ts
tests/ai-programmer/aiProgrammerService.test.ts
tests/ai-programmer/aiProposalRoutes.test.ts
tests/ai-programmer/correctionPass.test.ts
tests/ai-programmer/programmerContextBuilder.test.ts
tests/ai-programmer/programmerDomainValidator.test.ts
tests/ai-programmer/reconciliationContextBuilder.test.ts
tests/ai-programmer/tokenReport.test.ts
tests/ai-programmer/tokenReportCli.test.ts
tests/ai-programmer/tokenReportRoute.test.ts
tests/ai-programmer/weekReconciliationLifecycle.test.ts
tests/ai-programmer/weekReconciliationRoutes.test.ts
tests/ai-programmer/weekReconciliationService.test.ts
tests/ai-programmer/weekReconciliationValidators.test.ts
```

All failures observed are `AIProgrammerError: <date> is not editable:
targetDate is in the past relative to the current date` (a stale
hardcoded historical test date compared against the real current system
date) — exactly the Workstream A root cause already identified and
explicitly out of scope here.

### Manual/HTTP smoke test (real server, real in-memory DB, no mocks)

Ran a real Express app (`createApp`) against a fresh in-memory SQLite DB
and issued real HTTP requests via `fetch` against a live `http.Server` on
an ephemeral port (script written to the session scratchpad, not
committed) to confirm actual end-to-end behavior:

- `GET /api/programming/week`, `GET /api/programming/periodization`,
  `GET /api/programming/structural-advisories` — all 200, correct shapes.
- `GET /api/blueprint/exercises` → `PUT /api/programming/preferences/:id`
  → `GET /api/programming/preferences` — full round trip, preference
  persisted and returned with a resolved `exerciseName`.
- `PUT /api/programming/profile-factors/training_experience` →
  `GET /api/programming/profile-factors` → `DELETE …` → `GET` again —
  full round trip, factor set, listed, then correctly cleared (empty
  list).
- A real specialization goal (`chest-front-width`) with zero logged
  history → `GET /api/programming/structural-advisories` correctly
  returned two `persistent_target_coverage_gap` advisories (`mid-pec`,
  `upper-pec`) each with a correctly resolved `affected_target_names`
  (`["Mid Chest"]`, `["Upper Pec"]`).
- `GET /coaching-settings.html` and `GET /coaching-insights.html` both
  served 200 with real HTML content from the static file server.

I did **not** run a manual browser or Playwright visual smoke test — this
sandbox has no browser automation tool available, so I did not claim
visual verification that didn't happen. The real-HTTP-server check above
is the closest available substitute and does exercise every new/changed
route for real, but it does not verify the rendered DOM/CSS visually.

---

## 5. Deviations from the data contract

- None substantive. The one backend change made (`affected_target_names`)
  is exactly the addition the data contract's §5 point 1 already
  anticipated and pre-approved, made only after confirming (per its own
  explicit instruction) that client-side resolution via an
  already-loaded catalog wasn't available on this particular page.
- The data contract's §5 point 2 ("do not ask `/intensity-techniques`
  for scheduling info") was followed exactly — Coaching Insights never
  calls that endpoint.
- Wording choices (e.g. "No intensity techniques are prescribed this
  week." as the whole-week rollup of the exact per-session string) were
  left to judgement as the spec explicitly allowed ("use your judgement
  on exact wording but keep it in the same plain-language register").

---

## 6. Known limitations

- The "Insights"/"Coaching" nav labels are short to fit the existing
  pill-style nav on mobile; if the product wants longer labels later,
  `NAV_ITEMS` in `app.js` is the single place to change them.
- Coaching Insights re-fetches `GET /week` independently of
  `program.html`'s own load — this is deliberate (per the data contract:
  "cheap, read-only, idempotent") but means a user navigating between the
  two pages triggers a second `/week` request; no caching layer exists in
  this app today, so this matches every other page's behavior.
- `formatPreferenceKind`/`formatAdvisorySeverity`/`formatDeloadReason`
  degrade unknown enum values to a humanized string rather than a
  curated label — this is the explicit, intended fallback behavior per
  spec §6 ("unknown enum value renders as a safe generic label"), not an
  oversight.
- No dedicated Playwright/jsdom visual regression test exists for the two
  new pages, consistent with this repo's established policy (no browser
  test harness) — coverage is via the extract-and-eval technique plus
  source-level wiring assertions, matching every other frontend feature
  in this codebase.

## 7. Deferred / out of scope (confirmed, not silently dropped)

- Workstream A (stale-date test fixtures) — untouched, as instructed.
  The 231/14-file baseline is preserved exactly.
- Any second supported profile factor beyond `training_experience` —
  `SUPPORTED_PROFILE_FACTORS` in `programming.ts` was not changed, and
  Coaching Settings intentionally offers no generic "any factor name"
  control (spec §11 explicitly forbids unsupported profile-factor
  effects).
- An advanced/debug view exposing `decisive_gate`, raw rejected
  candidates, or internal scoring — explicitly out of scope per the data
  contract §2, never built.
- Any new deload/periodization state, preference kind, or
  intensity-technique eligibility rule — none added; every field
  displayed traces to an existing, already-computed backend field.
