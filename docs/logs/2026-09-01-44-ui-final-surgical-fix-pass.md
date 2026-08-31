# 2026-09-01 — UI Phase Final Surgical Fix Pass

## What changed

Fixed exactly the two defects identified in
`docs/UI_FINAL_SURGICAL_FIX_SPEC.md`.

**1. `GET /api/programming/today` activity-type classification.** The
route previously defaulted any non-gym day straight to `sessionType:
"rest"`, ignoring a real configured recurring activity (e.g. Saturday
badminton). Fixed to the required `gym > activity > rest` precedence,
reading the exact same canonical sources `GET /api/programming/week`
already reads — `TrainingProfile.training_days` (whether the weekday is
a real gym day, matching `buildWeeklyProgrammingPlan`'s own
`sessions[]` membership exactly) and `TrainingProfile
.other_activity_schedule` via the already-existing `nonGymDayType`
helper. No second activity configuration, no hard-coded "Saturday =
badminton". Today and Week now provably agree on every day's canonical
type.

**2. Program-page "delivered" terminology.** `public/program.html`'s
weekly-goal-summary described `deliveredDirectSets` (a programming
concept — what survived resource/time fitting into the final program)
as "X of Y planned sets delivered", which reads as a claim about actual
physical workout completion. Relabeled to `Required: X · Programmed: Y
· Unmet: Z`. The backend field name is unchanged; only the
presentation-time label changed. The identical defect also existed in
`public/history.html`'s Goal-progress section (same field, same
misleading wording) and was fixed identically — documented as an
in-scope "same defect, second location" change, not scope creep. The
Logger's own real Planned/Actual display was untouched and re-verified
intact.

## New tests

`tests/routes/programming.test.ts` — 4 new HTTP-level regressions:
badminton-day classification (Today === Week), genuine rest day, gym
day (even alongside a configured badminton day elsewhere in the week),
and an explicit Today/Week agreement assertion.

`tests/frontend/programTerminology.test.ts` — new file, 4 tests, using
only the existing vitest infrastructure: asserts `program.html` and
`history.html` use Required/Programmed/Unmet and never the standalone
word "delivered" (word-boundary-safe, so the unchanged
`deliveredDirectSets` field name is never falsely flagged), and that
`logger.html` still distinguishes Planned from Actual.

## Verification (real commands, real output)

```
$ npm ci
added 196 packages, and audited 197 packages in 3s

$ npm run verify
> npm run build && npm run typecheck && npm test
 Test Files  46 passed (46)
      Tests  443 passed (443)
```

Run against a genuinely clean checkout. 443 = 435 pre-existing tests
(unchanged, still passing) + 8 new.

A real Playwright-driven browser smoke test (Chromium, against a
running `npm run dev` instance, fresh database) covered all six
required manual checks (§26 A-F): gym day shows Push, badminton day
shows "badminton" (never "rest"), a genuine rest day shows "rest",
Weekly Program and Today agree on Saturday's type, the Program page
shows Required/Programmed/Unmet and never "Delivered", and the Logger
still distinguishes Planned from Actual after logging fewer sets than
planned. 8/8 passed. Full details and the exact required PASS/FAIL
report in `docs/UI_FINAL_SURGICAL_FIX_REPORT.md`.

## Stop condition

Every item in the spec's acceptance gate (§27) passes. Per the spec's
own directive, this UI phase is done — no further UI or programming
work was started in this pass.
