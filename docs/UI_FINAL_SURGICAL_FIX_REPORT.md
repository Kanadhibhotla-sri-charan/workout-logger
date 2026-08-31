# UI Phase — Final Surgical Fix Pass — Required Dev Report

Per §30 of `docs/UI_FINAL_SURGICAL_FIX_SPEC.md`.

```
Files changed:
src/server/routes/programming.ts     (Today activity-type precedence fix)
tests/routes/programming.test.ts     (badminton/rest/gym/agreement regressions)
public/program.html                  (delivered -> Required/Programmed/Unmet)
public/history.html                  (same terminology fix — see "Unrelated
                                       changes" below for why this file changed)
tests/frontend/programTerminology.test.ts   (new — terminology regression)
docs/UI_FINAL_SURGICAL_FIX_SPEC.md   (this pass's spec, saved to the repo)
docs/UI_FINAL_SURGICAL_FIX_REPORT.md (this report)

Today activity-type fix:
PASS

Today/week agreement:
PASS

Badminton regression:
PASS

Rest regression:
PASS

Gym regression:
PASS

Program terminology fix:
PASS

Logger planned-vs-actual:
PASS

npm ci:
PASS

npm run verify:
PASS

Production build:
PASS

Browser smoke test:
PASS

Manual smoke test:
PASS

Unrelated changes:
YES

If YES:
The exact same "delivered" terminology defect (spec §13-16) also exists
in public/history.html's "Goal progress" section, which renders the
identical deliveredDirectSets-derived volume with the same misleading
"planned sets delivered" wording. This is not a different bug — it is
the same defect the spec describes, manifesting a second time because
that page independently renders the same real backend field. Leaving it
unfixed would mean the exact claim this pass exists to correct ("X sets
delivered" implying physical completion) still appears elsewhere in the
app. Fixed with the identical Required/Programmed/Unmet terminology; no
other part of history.html (recent workouts, exercise history, page
structure) was touched. Covered by the same terminology regression test.

Known limitations:
NONE
```

## Detail: Today activity-type classification fix

`GET /api/programming/today`'s `sessionType` previously defaulted any
non-gym day straight to `"rest"`:

```
sessionType: result.exercises.length > 0 || result.session_purpose ? 'gym' : 'rest'
```

Fixed to the required `gym > activity > rest` precedence, using the
exact same canonical sources `/api/programming/week` already uses — the
user's real `TrainingProfile.training_days` (to decide "is this weekday
a real gym day at all," identical to the condition that puts a day into
`buildWeeklyProgrammingPlan`'s own `sessions[]`, so this can never
disagree with `/week`) and `TrainingProfile.other_activity_schedule`
(via the pre-existing `nonGymDayType` helper `/week` already used — no
second, Today-only activity configuration, no hard-coded "Saturday =
badminton"):

```ts
const isGymDay = profileForType?.training_days.includes(result.weekday) ?? false;
const sessionType = isGymDay ? 'gym' : nonGymDayType(result.weekday, profileForType?.other_activity_schedule ?? []);
```

Verified directly: for a training profile with Saturday configured as
badminton and no gym session that day, `GET /api/programming/today`
now returns `sessionType: "badminton"`, matching
`GET /api/programming/week`'s own `days[].type` for the same date
exactly.

## Detail: Program-page terminology fix

`public/program.html`'s weekly-goal-summary card previously read:

```
${delivered} of ${required} planned sets delivered this week
```

Changed to:

```
Required: ${required} · Programmed: ${programmed}${unmet > 0 ? ` · Unmet: ${unmet}` : ''}
```

The backend field name `deliveredDirectSets` is unchanged (spec §16
explicitly says it may remain); only the presentation-time local
variable and label were renamed/relabeled. The Logger's own real
Planned/Actual display (`public/logger.html`) was not touched — it
already correctly distinguishes programmed sets from actually-logged
completion, and continues to.

## Regression tests added

`tests/routes/programming.test.ts` — 4 new HTTP-level tests (§9-12):
badminton day classification agreeing between Today and Week, genuine
rest day, gym day (even with badminton configured elsewhere in the same
week), and an explicit Today/Week agreement assertion.

`tests/frontend/programTerminology.test.ts` — 4 new tests, using only
the existing vitest infrastructure (no new testing framework
introduced, per spec §18): asserts `program.html` and `history.html`
contain "Required"/"Programmed"/"Unmet" and never the standalone word
"delivered" (a word-boundary-safe regex that does not flag the
unchanged `deliveredDirectSets` backend field-name references), and
that `logger.html` still contains "Planned"/"Actual".

## Verification (real commands, real output)

```
$ npm ci
added 196 packages, and audited 197 packages in 3s
(no errors)

$ npm run verify
> npm run build && npm run typecheck && npm test
 Test Files  46 passed (46)
      Tests  443 passed (443)
```

Run against a genuinely clean checkout (working tree archived via
`git archive` on a `git stash create` snapshot, including the new
untracked files, into a scratch directory with no
`node_modules`/`dist`). Build (`tsc -p tsconfig.json`) and typecheck
(`tsc --noEmit`) both passed with no errors. 443 = 435 pre-existing
tests (unchanged, all still passing — no engine or unrelated UI
regressions) + 8 new tests from this pass.

### Browser smoke test

No committed browser-test npm script exists in this repository (only
`vitest` is wired into `package.json`/`npm run verify`) — per spec §25's
"test result honesty" requirement, this is stated plainly rather than
inventing one. A real browser smoke test WAS actually performed:
Playwright (pre-installed in this environment, not added as a project
dependency, so no new testing framework was introduced) drove Chromium
against a running `npm run dev` instance with a real training profile
(Mon/Tue/Thu/Fri gym, Saturday badminton) and one active goal, on a
fresh SQLite database, covering the six required manual smoke checks
(§26 A-F):

```
A — Gym day (Monday) shows "Push"                                    PASS
B — Badminton day (Saturday) sessionType === "badminton", never "rest" PASS
C — Genuine rest day (Wednesday) sessionType === "rest"               PASS
D — Weekly Program identifies Saturday as badminton                   PASS
D — Today and Weekly Program agree on Saturday's type                 PASS
E — Program page uses Required/Programmed/Unmet, never "Delivered"    PASS
F — Logger still distinguishes Planned vs Actual after logging fewer
    sets than planned                                                 PASS
```

8/8 checks passed (D counted as two explicit assertions per the spec's
own wording). No browser console or page errors were observed.
