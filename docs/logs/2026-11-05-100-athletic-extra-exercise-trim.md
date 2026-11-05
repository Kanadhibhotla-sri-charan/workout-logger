# Athletic day: an extra drill no longer fails generation

Owner 2026-11-05: first real Athletic day, generation failed with "proposal
could not be validated".

## Cause

Production log, two paid calls (03:44:58 and 03:45:40 UTC, same context):
`warmup: 2 exercise(s); needs 1-1`, and no other issue. The package change
(log 99) cut the warm-up to exactly one drill on a day without mobility,
and the check rejected anything over a block's maximum. The model gave two
warm-up drills both times. That change was only tested with fake model
answers shaped to fit, so it first met the real model today.

## After

- `checkAthleticOutput`: exercises past a block's maximum, or in a block
  not in today's plan, are dropped (the model's first ones kept) and noted
  in `repairs`. The plan still decides the shape, and a dropped warm-up
  drill keeps mobility from being counted as done.
- Too few in a block still fails: nothing can be invented to fill it.
- Commit re-check is as strict as before: any repair there is an error.
- Prompt rule 2 says a block with min and max of 1 means exactly one.

## Tests

`tests/athletic/athleticDay.test.ts`: 34 pass; an unplanned block is now
dropped rather than rejected; new case for two warm-up drills. No real
provider call was made; the owner's next generation is the first real test.
The contextHash is unchanged, so that attempt meets the retry gate once.

## Deploy

Deployed 2026-11-05 09:28 IST (aa4bcc0). Backup
pre-aa4bcc0-20261105T035812Z.sqlite, integrity ok. Health ok, service active.

## Data fix, same day

Owner did the wall calf stretch on 2026-11-05 but its set was not ticked,
and a finished session is read-only in the logger. At the owner's request
that one set was marked completed directly in the production DB. Backup
pre-calf-stretch-tick-20261105T055515Z.sqlite, integrity ok, 1 row changed.
That day now counts as strength + flexibility; the next plan reads
strength + resilience + endurance.
