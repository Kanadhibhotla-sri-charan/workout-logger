# 2026-09-21 — Weekly goal-volume shortfall in the full-reference eval: analysis and suggested solutions

Analysis only. No source code was changed. Branch: `ai-weekly-eval-validation` (reviewed at commit `c806917`).

## Issue

With `EVAL_GOAL_TARGET=reference` (commit `c806917`), Qwen (`qwen/qwen3-next-80b-a3b-instruct`) planned a whole week that passed domain validation (0 errors; one warning: missing rationale on a reduced flat-barbell-bench-press) but failed the weekly adequacy check:

| Goal target | Generated | Brief asked | Deliverable | Verdict |
|---|---|---|---|---|
| triceps | 9 | 24 (session range 12 to 12) | 24 | below_brief |
| triceps-long-head | 4 | 8 (session range 4 to 4) | 8 | below_brief |

Adequacy errors: both goals short with no `recovery` or `recent_overexposure` deferral. This was a single run; the model's own reasoning and deferrals were not inspected. Normal-brief mode (triceps 8, action increase, after the advanced-trainee fix) has not been rerun.

## Findings (why the model cannot easily deliver the number)

### 1. The exercise list makes 12 per session a "use everything" demand
Sets per exercise are a hard maximum, and one exercise cannot repeat in a session. The triceps-complete package (2 sessions per week) is:

| Exercise | Max sets | Counts toward |
|---|---|---|
| close-grip-bench-press | 3 | triceps |
| dip-triceps-biased | 3 | triceps |
| overhead-triceps-extension | 2 | triceps, triceps-long-head |
| cable-pushdown | 2 | triceps |
| cable-overhead-extension-leaning-forward | 2 | triceps, triceps-long-head |

3+3+2+2+2 = 12 per session, so 24 per week requires all five exercises at full sets in both push and upper sessions. 4x3 or 3x4 is impossible (no exercise allows 4 sets; only two allow 3). Long-head 8 per week is the two overhead exercises at 2 sets in both sessions (same exercises, counted for both targets). Any skipped exercise or trimmed set makes the session total unreachable.

### 2. Push and upper days cannot hold the goal plus everyone else
Session limits: 10 exercises, 8 distinct muscle targets, at most 2 abs exercises.

Push day (non-goal = Efficient level):

| Muscle | Exercises (max sets) | Per-session by target |
|---|---|---|
| Chest | incline-barbell-press 3 (upper-pec), flat-barbell-bench-press 3 (mid-pec), cable-fly 2 (all three) | upper-pec 5, mid-pec 5, lower-pec 2 |
| Side delts | dumbbell-lateral-raise 3, cable-lateral-raise 2 | 5 |
| Abs (any day) | cable-crunch 3, hanging-knee-leg-raise 3, pallof-press 2 | up to 6 (max 2 exercises) |

Face-pull (2) is in the shoulders package but trains rear-delt, a pull-day target. Front-delt has no exercise of its own. Push day at full: triceps 5 slots + chest 3 + side delts 2 = 10 slots (25 sets), leaving no room for abs.

Upper day (push and pull muscles, 17 targets available):

| Muscle | Exercises (max sets) | Slots | Sets |
|---|---|---|---|
| Triceps (goal) | 5 exercises above | 5 | 12 |
| Chest | as above | 3 | 8 |
| Side delts | as above | 2 | 5 |
| Back | lat-pulldown-wide-pronated 3, chest-supported-row 3, barbell-dumbbell-shrug 2 | 3 | 8 |
| Rear delts | face-pull 2 | 1 | 2 |
| Biceps | barbell-ez-bar-curl 3, hammer-curl 2 | 2 | 5 |
| Forearms | wrist-curl 2, reverse-wrist-curl 2 | 2 | 4 |
| Abs | as above | max 2 | up to 6 |
| Total | | 20 | about 50 |

The full list needs about 20 slots and about 15 to 16 targets against limits of 10 and 8. With triceps taking 5 slots and 2 targets, 5 slots and 6 targets remain for 14 non-goal targets. Example that fits (illustrative, not what the model chose): flat bench, lat pulldown, chest-supported row, lateral raise, EZ-bar curl (7 targets).

Knock-on effect: chest, shoulders, back and biceps each have only two compatible sessions per week (push and upper, or pull and upper). If upper skips a muscle, it can reach at most about half its weekly reference.

### 3. Implementation gaps in the instructions and checker
1. The week rulebook (`buildWeekReconciliationSystemInstruction`, `aiProgrammerService.ts`) never tells the model to hit `programmingBrief` weekly numbers. The reasoning instruction in `scripts/modelEvalWholeWeekTwoStep.mjs` also does not, and the commit instruction mentions the brief only as how the harness computes the shortfall. The rulebook says several times that falling short is fine: package numbers are "not rigid quotas", "prioritize quality over filling every eligible target", deferred volume is "picked up automatically". The checker then fails the week for falling short.
2. Week rulebook rule 7 still says authored sets must be copied exactly and never reduced. The code treats authored sets and `directSetsPerExposureCap` as a ceiling and expects a rationale for a cut. The single-session rulebook was fixed; the week one was not. The week rulebook also never mentions the per-exposure cap (repair clamps it silently).
3. The only accepted reasons for a goal shortfall are `recovery` and `recent_overexposure` (`weeklyVolumeAudit.ts`, `GOAL_DEFERRAL_REASONS`). A capacity reason (no slots, session limits) has no accepted code. The schema's allowed reason codes were not checked.
4. `withGoalReferenceTargets` rewrites the target and session range but leaves `recoveryAdjustment` untouched, so the brief may say "increase to 24" and "recovery: reduce" together. The seeded values were not checked. The seeded history has triceps trained on Sep 15 and Sep 18.
5. The shared-exercise audit credits overhead extensions to both triceps and long-head, so the 9 likely includes about 4 long-head sets. The run's exercise list was not inspected.

## Coaching assessment (product decision input)

- 24 over a two-week window is 12 per week, the same dose the user already ran (8 to 12 sets per week) without the results they wanted. Changing the window alone gives no new stimulus.
- 12 direct sets in one session is more than late-session quality supports (roughly 6 to 8 hard sets per muscle per session before quality drops).
- The user's own history is the best evidence and has not been analysed. Candidate causes, in order of likelihood: effort (sets 3 to 4 reps short of failure), no progressive overload, only two exposures per week, calorie or sleep limits, too short a time frame (arms often need 8 to 12 weeks).

## Suggested solutions

Prompt-side changes are listed for completeness, but the earlier log's advice still stands: do not loosen the goal rule or add prompt rules based on a few Qwen iterations. Gather more data first (item A).

A. Gather data before changing rules:
   1. Inspect the reasoning and deferrals from the c806917 run to see what Qwen said about the shortfall.
   2. Rerun in normal brief mode (triceps 8, increase) and compare with reference mode. Run several iterations per mode and, if possible, a second model.
   3. Check the schema's deferral reason codes and the seeded `recoveryAdjustment` for the goal muscles.
B. Analyse the user's triceps history in the app (effort, load and rep progression, frequency, recent sessions) to identify which causes apply before choosing a target.
C. If the goal is a higher dose without junk sets: about 16 to 20 direct sets per week over 3 exposures of 5 to 7 sets, at least half on overhead (stretched-position) work, every hard set at 0 to 2 reps in reserve, track progression for 6 weeks and compare with logs. This needs a design change: triceps currently only appear on push and upper (`PUSH_PHYSIQUE_TARGETS` and `UPPER_PHYSIQUE_TARGETS` in `src/engine/config.ts`); a third exposure would need a short triceps slot on pull day.
D. Instruction and checker fixes (decision pending):
   1. Tell the week model explicitly to aim for `programmingBrief` weekly numbers, and to explain any shortfall.
   2. Align week rule 7 with the ceiling rule (sets are a maximum, reduction needs a short reason) and mention the per-exposure cap.
   3. Decide whether "session capacity" is a valid reason for a goal shortfall. Policy call: two coaches could disagree.
   4. Make the eval override consistent about recovery, or state clearly in the log that it is left as is.
E. If a longer window is wanted anyway: keep a per-week floor and ceiling (for example 8 to 16 for triceps) so an average does not hide one heavy and one thin week, and carry shortfalls forward across weeks as the app already does for legs.

## Not verified

- The model's actual output for the run (reasoning, deferrals, exercise list).
- That the running app does not adjust per-exercise maximums elsewhere (for example during a deload).
- Exercise-to-muscle mapping for shoulders, abs, back, biceps and forearms was read from the exercise data, not through the running app.
- Weekly figures assume weekly = per-session x 2, which matches log 64's numbers (checked for chest and triceps only).
- No tests were run. The 231 baseline failures were not re-verified.
