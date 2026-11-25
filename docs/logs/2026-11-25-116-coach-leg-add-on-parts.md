# 116 · Coach leg add-ons: the four parts, picked by the owner

Date: 2026-11-25 · Status: brief live from the next run (skill on main); app side NOT deployed yet

## Request
Owner's 24 Nov session note: "No resilience, mobility workouts for
legs/badminton today, why?" The toggle was "Session + leg add-ons". The coach
gave calf raise, Copenhagen plank and hip abduction, with upper-body
stretches only. Owner: "make the changes to brief and also I don't have the
option to select specific add ons for coach's program".

## Cause
The brief said "you choose which add-on parts fit the day" but never named
the parts. The coach filled the slot with leg strength accessories. The old
app add-on (log 110) had four parts: resilience, conditioning, mobility and
leg flexibility.

## Changes
- Brief (.claude/skills/opus-coach/SKILL.md): "Daily add-ons" names the four
  parts with examples. Strength accessories are extras and never replace a
  part. On an add-ons day: one drill per ticked part (`dayAddOnParts`, all
  four when none were ticked); make a part lighter rather than drop it; drop
  one only for a solid reason, stated in the coach note.
- coach_day_requests.parts_json (migration): the ticked parts. Null with
  add_ons = all four.
- PUT /api/coach/day-request takes `parts` (add_ons only, non-empty, known
  parts; else 400). GET /api/coach/day returns `parts`.
- Coach context: `dayAddOnParts` [{id, label, description}].
- Qwen add-on ticks and generate-session follow the picked parts (toggle
  reading only; the Qwen pipeline is otherwise unchanged).
- Program page: under "Today I want:", picking "Session + leg add-ons" shows
  four checkboxes (all ticked at first). Each change saves; the last part
  can't be unticked (pick "Session only" instead).

## Tests
- tests/coach/opusCoach.test.ts: picks saved in order, in /day, in the
  context and in the Qwen ticks; no pick = all four; refused off add_ons,
  empty or unknown; the page has the checkboxes.
- Full suite: 2396 passed, 10 skipped, 0 failed.
