# No warm-up block

Owner 2026-11-05, after the first Athletic day (calf raises, split squats,
lunges, with one ankle drill as the warm-up): a warm-up block should cover
every muscle worked that day or not exist, leaving the choice to them; "I'd
rather warm-up block removed completely".

## Before

- Athletic day: one warm-up drill on a day without mobility; the mobility
  component was that same block, grown to 2-3 drills, first in the session.
- Push / Pull / Upper: the flexibility block put its dynamic drills before
  the session (usually cat-cow and adductor rock-back).

## After

- Athletic day: no warm-up. A day with mobility holds 2-3 dynamic drills
  after the main work, shown as "Mobility". Order: resilience, strength,
  endurance, mobility, flexibility. The block keeps the internal id
  `warmup` because drills and stored proposals carry it.
- Push / Pull / Upper: the whole flexibility block goes after the session,
  dynamic drills first, so the weekly Blueprint minutes are unchanged.
  `flexibilityBlock.warmup` is always empty; old proposals still display.
- A warm-up drill the model adds anyway is dropped (log 100).
- Logger: leading drills are labelled "Before the lifts", since Athletic
  resilience drills now open the session.

## Tests

`tests/athletic/athleticDay.test.ts`: 34 pass, updated for the above.
Typecheck clean. No real provider call.

## Deploy

Not deployed yet.
