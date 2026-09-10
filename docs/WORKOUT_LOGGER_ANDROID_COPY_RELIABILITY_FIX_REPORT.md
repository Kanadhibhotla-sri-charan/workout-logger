# Workout Logger — Android Copy Button Reliability Fix: Implementation Report

Corresponds to `docs/WORKOUT_LOGGER_ANDROID_COPY_RELIABILITY_FIX.md`, implemented on the same
branch as all prior Workout Programmer work (`workout-programmer-ui-and-equipment-filter-fix`).
This spec is explicitly an **isolated UI/clipboard fix** — it required no change to the Workout
Programmer, exposure/frequency logic, prescription logic, reconciliation logic, Blueprint data,
workout generation, or database behavior, and none of those were touched.

## Audit (spec §2)

Located in `public/logger.html`:

- The completed-workout Copy button and its click handler: inside `buildCompletedFooter()`.
- The canonical workout-text formatter: `buildCopyText(session, generated)` — a pure function,
  untouched by this fix, already covered by its own existing test suite
  (`tests/frontend/copyWorkoutText.test.ts`).
- `navigator.clipboard.writeText(text)`: the sole copy mechanism, with no fallback at all.
- The existing success message: `'Copied to clipboard'`.
- The existing failure message: `"Couldn't copy automatically — please select and copy the text
  manually."` — shown on ANY rejection, but with no actual selectable text ever rendered, despite
  the wording implying one exists.
- No textarea/contenteditable/manual-copy fallback existed at all — the failure message was purely
  informational with nothing to act on.
- Existing tests: `tests/frontend/copyWorkoutText.test.ts`'s "Copy button wiring (source-level)"
  describe block, three markup-presence assertions, no behavioral coverage of the clipboard logic
  itself.

The production application is served over HTTPS already (per the existing deployment contract
referenced in the spec); no HTTPS-related change was needed or made (spec §10).

## What changed

All changes are confined to `public/logger.html` (plus its test file). `buildCopyText` itself —
the canonical formatter — was not touched.

1. **`copyTextToClipboard(text)`** (new, top-level, async): a progressive fallback.
   - Attempts `navigator.clipboard.writeText(text)` first when the API is present, feature-detected
     (`navigator.clipboard && navigator.clipboard.writeText`) — never browser/device sniffed.
   - Any rejection or thrown exception falls through (not shown to the user) to a traditional
     `document.execCommand('copy')` fallback via a temporary, off-screen (`position: fixed;
     top/left: -9999px`, never visible) `<textarea>`, removed immediately after the attempt.
   - Resolves `true` only when a mechanism actually reported success; `false` otherwise. Never
     assumes success.

2. **`createCopyController(copyFn)`** (new, top-level): a factory producing a stale-attempt-safe
   `attemptCopy(text, callbacks)` function. A monotonically increasing internal counter ensures an
   older, slower attempt's async result can never overwrite a newer attempt's UI state (spec §11)
   — e.g. a first tap's fallback resolving late must not revert a second tap's already-applied
   success. Exposes four callbacks (`onStart`, `onSuccess`, `onFailure`, `onClear`) so the DOM
   wiring stays a thin adapter, and the race-safety logic itself is unit-testable in isolation.

3. **`buildCompletedFooter()`** rewired: the Copy button's `onClick` now calls
   `attemptCopy(text, { onStart, onSuccess, onFailure, onClear })` instead of a bare
   try/catch around `writeText`. A new manual-fallback UI element (a `readonly`, pre-selected
   `<textarea>` inside a `.manual-copy-box`, hidden by default via the `hidden` attribute) is
   shown only in `onFailure` — i.e. only when BOTH the modern API and the execCommand fallback
   failed — pre-filled with the exact same canonical text and auto-selected so the user can
   immediately use the OS's own copy action. `onSuccess` shows `'Copied to clipboard'`
   (unchanged); `onFailure` shows `'Automatic copy failed. Select the workout text below and copy
   it manually.'` (spec §8's suggested wording, replacing the old message that promised a manual
   option nothing actually provided). No raw browser exception (e.g. `NotAllowedError`) is ever
   surfaced (spec §17).

Nothing else in `logger.html` changed: no UI redesign, no styling rewrite, the button label,
placement, and the 3-second status-message auto-clear behavior are all unchanged (spec §15).

## Tests

`tests/frontend/copyWorkoutText.test.ts` extends the existing extraction-and-eval technique (the
real `copyTextToClipboard` and `createCopyController` source is extracted from `logger.html` by
brace-balanced slicing and evaluated against controllable fake `navigator`/`document` objects —
proving the real shipped logic, never a reimplementation) with the spec's required Tests A-G:

- **Test A**: modern API resolves → result `true`, `writeText` called once with the exact text,
  no fallback textarea ever created.
- **Test B**: modern API rejects, `execCommand` succeeds → result `true`, the modern API was
  genuinely attempted first, the fallback textarea's value is the exact same text.
- **Test C**: `navigator.clipboard` absent entirely → skips straight to the fallback, succeeds.
- **Test D**: both mechanisms fail (`execCommand` returns `false`, and separately, `execCommand`
  throws) → result `false` in both cases — never a false success.
- **Test E**: the exact same string is captured from a `writeText` call and, in a separate run
  forcing the fallback, from the fallback textarea's `value` — asserted identical.
- **Test F**: three race scenarios via `createCopyController`, using fake timers and manually
  sequenced promise resolution — (1) an older failing attempt resolving after a newer succeeding
  one must not overwrite the success; (2) the reverse (older success arriving late must not
  overwrite a newer failure); (3) a superseded attempt's own 3-second `onClear` timeout must never
  fire.
- **Test G**: source-level check that neither `copyTextToClipboard` nor `createCopyController`
  reference the app's `api()` helper or `fetch` — confirming by construction that no copy attempt
  can mutate workout data.

The pre-existing "Copy button wiring (source-level)" tests were updated to match the new failure
wording and extended with two new checks: no raw exception name is ever displayed, and the
extracted `copyTextToClipboard` source contains no `Android`/`Chrome`/`userAgent` string (spec
§16's no-device-sniffing requirement).

Verified by reversion (`git stash` of `public/logger.html` only): the entire new/updated test file
fails immediately against the pre-fix source (`copyTextToClipboard` doesn't exist yet — `Error:
function copyTextToClipboard not found`), confirming every new test genuinely exercises the fix
rather than passing vacuously.

Full suite: **83 test files, 783 tests, 0 failures** (12 net new tests). `npm run typecheck` and
`npm run build` pass cleanly; `npm run verify` (build + typecheck + test) passes cleanly.

Diff scope confirmed: only `public/logger.html` and `tests/frontend/copyWorkoutText.test.ts`
changed — no file under `src/engine/`, `src/blueprint/`, `src/db/`, or any Blueprint snapshot was
touched. `buildCopyText` itself is byte-for-byte unchanged in the diff.

## Live verification

A real headless Chromium browser (Playwright, launched against the real HTTP server and a
disposable scratch SQLite DB, using the real, built `public/logger.html`) drove a real completed
workout session end to end:

1. **Modern Clipboard API succeeds** (granted clipboard permissions): tapped Copy, the real OS
   clipboard (read back via `navigator.clipboard.readText()`) contained the exact expected text
   ("Flat Barbell Bench Press — 2 set(s): 60×10, 60×8"), and the "Copied to clipboard" message
   appeared.
2. **Modern API rejects** (the real Android/Chrome bug, reproduced by overriding
   `navigator.clipboard.writeText` to reject with a `NotAllowedError`, matching the production
   screenshot): tapped Copy, the page fell back to `execCommand('copy')` (confirmed genuinely
   invoked), showed "Copied to clipboard", and never showed the failure/manual message.
3. **Both mechanisms fail** (`writeText` rejects and `execCommand` returns `false`): tapped Copy,
   the manual selectable-text fallback box appeared, pre-filled with the exact real workout text,
   and no false success message was shown.
4. Re-fetching the session's persisted state after all three attempts confirmed the workout's
   `status` remained `completed` and no data was altered by any copy attempt (Test G, live).

## Production Safety

- No database reset, recreation, or migration.
- No historical workout data was altered — the live browser test used a disposable scratch SQLite
  file created and destroyed in the session's own scratchpad directory, never the real database.
- No goal, Blueprint package content, exercise data, or workout-generation logic was touched —
  this fix is confined to `public/logger.html`'s Copy button.
- No systemd/nginx configuration was touched. No HTTPS/deployment change made (already correctly
  configured, per spec §10).
- No AI/LLM dependency was introduced.
- No deployment performed. Per the standing rule for this project (GitHub `main` → Oracle VM
  only, no Windows local checkout, backup DB before any live regeneration, no raw SQL against
  production), this work remains on the `workout-programmer-ui-and-equipment-filter-fix` branch,
  not merged to `main`, exactly as every prior phase in this session has done.
