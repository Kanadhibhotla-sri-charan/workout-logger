# 107 · Fixed Athletic day; shoulder care on Push and Upper

Date: 2026-11-09 · Status: committed, not deployed

## Athletic day
Owner approved the week layout (Thu: strength + resilience + endurance
every week, plus 2-3 holds) and left mobility vs resilience to the coach.
- Normal day: strength, resilience, endurance, flexibility (2-3 holds).
- Light day (badminton yesterday or tomorrow): unchanged; easy strength,
  mobility, flexibility.
- Why resilience every week rather than taking turns with mobility:
  landing, low-jump and ankle-control work has the strongest evidence for
  reducing leg injuries; mobility alone does little for injury risk and is
  already covered by the gym days' dynamic drills.
- athleticPlan.ts: NORMAL_DAY / LIGHT_DAY replace "strength + 2 waiting
  longest"; "last done" is still shown in the reasons. Program page text
  updated.

## Shoulder care
Blueprint's two shoulder-health exercises (cable/band external rotation:
rotator cuff; push-up plus: serratus) were never planned. Now every Push
and Upper session gets one after the main exercises: the least recently
done, 2 easy sets (RIR 2+), Blueprint reps and rest
(src/athletic/shoulderCare.ts). Outside the AI output, like the add-on;
the model is told to leave it out; commit writes it right after the main
exercises; the program page shows "Shoulder care · about N min". About
4-6 min, counted in the time budget and never cut.
