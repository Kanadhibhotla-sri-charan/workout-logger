# 111 · Completion swaps an exercise when the session is full

Date: 2026-11-13 · Status: deployed 2026-11-13

## Request
Owner: "could you check today's proposal i tried to generate, it failed".

## Cause
Fri 13 Nov (Upper, last gym day of the week) was rejected twice at
adequacy (contextHash 0e41b658...):
- brachialis-arm-thickness 6 of 9 sets (the week's remaining goal sets;
  the three hammer curls at 3 sets each are the only way to 9)
- triceps-long-head 2 of 3 (second attempt also rear-delt 2 of 2.5)

The plan was sound: a proposal that follows it exactly passes. The AI
filled the 10-exercise cap with a plain biceps curl and a pushdown, and
deterministic completion could only add exercises, so it stopped at
the cap ("could not fully close ... session-wide cap").
Reproduced on a copy of the production DB with the same two errors.

## Change (src/ai-programmer/validation/programmerAdequacyCompletion.ts)
Step 3 of completeOneTarget: when the session is at its exercise cap,
swap ONE exercise for the short target's unused plan-legal candidate,
only if afterwards
- every target in the brief keeps at least min(its sets before, its
  adequacy floor), stays within its per-exposure cap, and keeps some
  work if it had any;
- the exercise, target, abs-share and leg-share caps still hold;
- the removed exercise's target is one the brief knows.
The swapped-in exercise takes the larger of the shortfall and the
removed sets, within its own ceiling. Fewest-sets exercise first, then
by id. The adequacy validator is unchanged and still decides.

Friday's case: incline curl -> cross-body hammer curl (brachialis 9,
biceps still 3 of 2), pushdown -> leaning cable overhead extension
(long head 4, triceps 7 of 6).

## Tests
- programmerAdequacyCompletion.test.ts 18: swap happens when safe; no
  swap when the removed exercise holds another target's floor.
- planConformance "2-set hamstrings" Legs case caught the leg-share cap
  (an abs exercise swapped for a 6th leg exercise); now checked.
- Full suite: 2359 passed, 13 failed, 10 skipped. The 13 fail identically
  without this change (deleteAndDiscardAiPrograms,
  proposalDiscoveryAfterScheduleMove: fixed fixture dates now in the past,
  409; same date rot as log 109).
