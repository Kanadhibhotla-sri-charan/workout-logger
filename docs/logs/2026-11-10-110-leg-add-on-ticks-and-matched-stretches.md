# 110 · Leg add-on ticks; stretches follow the day's muscles

Date: 2026-11-10 · Status: deployed 2026-11-10 (9b77061, backup pre-9b77061-20261110T035457Z.sqlite); Tue 10 Nov pending proposal 13fe8df4 discarded so the day is generated again with ticks

## Request
Owner, after generating Tue 10 Nov (Pull): Monday was light on the legs and
Wednesday is rest, yet Tuesday had no athletic leg work, only a few
upper-body stretches.
- "not having add-ons/leg work on 2 consecutive days should not be a hard
  rule, it should be contextual. if yesterday was heavy on legs then
  omitting today completely would be fine. else if tomorrow is badminton
  omitting today would be fine"
- "it should be what can be allowed like mobility, conditioning,
  resilience, flexibility..etc Depending my fatigue, soreness and recovery
  I will choose"
- "the stretches that the program is giving out post session is random
  now ... lat stretches on pull day would be more meaningful than on push
  day"

## Cause
- athleticAddOn.ts treated a day as "hard" when it had any jump or
  conditioning drill, so Monday's small add-on removed Tuesday's entirely
  (the 2026-10-18 "never two active days in a row" rule).
- flexibility.ts picked, for each weekly goal behind (upper body, lower
  body, wrist and forearm, full body), the least recently done drill,
  whatever the day trained.

## Changes
Leg add-on (src/athletic/athleticAddOn.ts)
- Four parts, one drill each: resilience (ankle / landing), conditioning,
  mobility (dynamic hip / ankle range), leg flexibility (lower-body hold).
- Suggested ticks: all four, except next to a day heavy on the legs, where
  none are suggested: yesterday badminton, the Athletic day or a Legs
  day; tomorrow badminton or the Athletic day. A small add-on yesterday
  no longer counts.
- `GET /api/ai-programmer/add-on-options?targetDate[&purpose]` returns the
  parts, the suggestion and why. `POST /generate-session` takes
  `addOnParts` (array; `[]` = no leg work today; omitted = the suggestion,
  as week generation does).
- A ticked add-on is never dropped by the session time budget
  (sessionTime.ts `addOnChosen`); a suggested one still gives way first.
- Program page: under "What should Tuesday focus on?", one checkbox per
  part with the suggestion pre-ticked and its reason. Shown on Push, Pull
  and Upper with athletic leg training, not during the Legs pause.

Stretches (src/athletic/flexibility.ts)
- Only drills whose Blueprint primary / secondary targets match the day
  (STRETCH_KEYWORDS): Push chest, front shoulder, triceps; Pull lats, rear
  shoulder, upper back, wrists and forearms; Upper both; Legs hips,
  quads, hamstrings, glutes, adductors, calves.
- A weekly goal counts today only when a drill aimed squarely (primary
  target) at today's muscles carries it, so Push/Pull no longer take
  lower-body stretches; those minutes come from Legs and Athletic days and
  the add-on's flexibility part.
- Still least recently done first, then the closer fit, so a Push day
  rotates through the pec, pass-through, prayer and open-book stretches.

Example (test fixture, nothing done this week): Pull gets the bench
thoracic prayer (lats), wrist flexor/extensor and child's pose side reach;
Push the doorway pec stretch; Legs the world's greatest stretch and
adductor rock-back.

## Tests
- tests/athletic/athleticDay.test.ts: suggestions (badminton / Athletic
  day / tomorrow badminton), yesterday's add-on no longer blocks, ticked
  parts built one drill each, [] = none, route + validation, brief marks
  chosen, stretches per day.
- tests/ai-programmer/goalCapacityAndTime.test.ts: a ticked add-on stays,
  flexibility shrinks instead.
- tests/frontend/aiProposalUI.test.ts: the request carries the ticks.
- Full suite: 2370 passed, 10 skipped, 0 failed.
