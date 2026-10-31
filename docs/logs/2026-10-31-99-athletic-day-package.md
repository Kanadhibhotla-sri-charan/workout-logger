# Athletic day as one package, rotating by what was done

Owner 2026-10-31: "On a specific day If I choose it as athletic day, it
should be considered for strength, mobility, endurance, flexibility all
together ... It is not necessary to pick everything on every athletic day.
The choice can be made using other aspects like recovery and badminton
session on previous or next days." Answers to follow-up questions:
1. Leg size matters only where it helps injury-resistant legs that recover
   quickly. 2. One Athletic day a week; add-ons on other days can carry
   athletic leg work, never strength. 3. Put the Legs pause back on.

## Before
- Program page: Leg training "Athletic" or "Size" (either-or).
- Every Athletic day had to hold all five blocks (warm-up, quality,
  strength, conditioning, cool-down); badminton nearby only lowered
  volume; nothing made the next Athletic day cover what was missed.

## Now
- src/athletic/athleticPlan.ts (new):
  - components: strength, resilience (landing, ankles, low jumps),
    endurance, mobility, flexibility
  - `componentsDone`: from completed sets (2+ dynamic drills = mobility,
    2+ holds = flexibility; one warm-up drill or one hold alone do not count)
  - `athleticDayHistory`: past Athletic days (committed Athletic
    proposals, session completed), 70 days back
  - `chooseAthleticComponents`: strength + the two waiting longest (ties:
    resilience, flexibility, endurance, mobility); badminton yesterday or
    tomorrow = light day (no resilience / endurance)
- athleticSession.ts: context v4 with `session.plan`; `blockSizesFor`
  replaces the fixed BLOCK_SIZE; light day caps lifts (RIR 2+, <= 3 sets);
  prompt rules 2, 4, 8 and the athlete profile updated ("recover quickly";
  leg size only where it helps that); the check rejects a block not in the
  plan; the proposal stores `athleticPlan`; the commit re-check uses it.
- program.html: Size / Athletic toggle removed (shows the setting); the
  proposal shows "Today's package: Strength + Resilience + Flexibility" and
  the reasons; block labels renamed (Resilience, Endurance, Flexibility).
- With the current schedule (Mon Push, Tue Pull, Thu Athletic, Fri Upper,
  badminton Sat/Sun) Thursday is a full day; the first one would be
  strength + resilience + flexibility, the next strength + endurance +
  mobility, and so on.

## Legs pause
Turned on in production on owner request (backup
pre-legs-pause-20261031T151208Z.sqlite), via PUT /api/programming/injuries/legs
with note "Leg rehab done in separate sessions (logged in notes)." While it
is on there is no Athletic day, no add-on, no lower-body mobility.

## Checks
- tests/athletic/athleticDay.test.ts: 34 pass (5 new: what counts as done,
  rotation, skipped part waits, light day, plan read from logs, commit
  re-check uses the stored plan; old tests moved to plan-shaped answers).
- Full suite: 247 failures before and after, the same date-dependent set.
