# Upper day failed: brachialis and long head below their minimums

Owner 2026-11-06: generating Friday's Upper day failed.

## Cause

Two paid calls (03:24:46 and 03:25:05 UTC, same context) were rejected by
the adequacy check:
- brachialis-arm-thickness: 2 sets, minimum 4
- triceps-long-head: 2 sets, minimum 3

The plan was feasible. Brachialis shares 2 exercise slots with biceps, and
its candidates (hammer curl, cross-body hammer curl) allow at most 2 sets
each, so it needs both. The long head needs both of its overhead extensions
inside the 4 triceps slots. The model kept each group's exercise count but
used one exercise for each of these targets. It was told minimumSets and
each exercise's maxSets, but not how many exercises that takes.

## After

- Each planned target now carries `minimumExercises`: the planner's own
  reservation (exercises that count toward it, its own candidates or
  another target's whose alsoCredits names it).
- Rule 6 says a target needs at least that many, with an example (4 sets
  from candidates of maxSets 2 needs two).
- Rule 6a now says the flexibility drills come after the session (log 101).
- The context changes, so its hash changes and the retry gate does not
  block the next attempt.

## Tests

`tests/ai-programmer/plannedContext.test.ts`: minimumExercises equals the
reservation, and the best crediting candidates reach minimumSets. Planner,
planned-context and athletic tests pass (97). Full suite: the same 246
known failures as before. No real provider call; the owner's next
generation is the real test.

## Deploy

Deployed 2026-11-06 09:00 IST (1b90a86, with 8ec9f4d). Backup
pre-1b90a86-20261106T033001Z.sqlite, integrity ok. Health ok, service active.
