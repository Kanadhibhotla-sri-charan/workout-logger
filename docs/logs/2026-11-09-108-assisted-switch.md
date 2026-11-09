# 108 · Assisted switch for pull-ups, chin-ups and dips

Date: 2026-11-09 · Status: committed, not deployed

## Request
Owner asked how to log assisted pull-ups, chin-ups and dips; then "add
assisted switch".

## Change
- Assistance is stored as a negative weight (20 kg of help = -20), so a
  bigger number is still progress: -20, -15, 0, then +5 on a belt.
- Logger: the four exercises (pull-up-pronated, chin-up-supinated,
  dip-chest-biased, dip-triceps-biased) get an "Assisted machine" switch.
  On: type the machine's number; it is saved negative. The switch starts
  on when last time or this entry was assisted. Works for planned,
  preloaded and added exercises.
- Shown as "20 kg assist" in the logger, history and copied text.
- Load hint: the least help is the top set; at the top of the rep range it
  says "Less help: about 17.5 kg assist", never past bodyweight.
- Weight x reps strength trends (coaching history, goal phases) leave
  assisted sets out; Insights already counted positive loads only.
