# 104 · Past days can be changed from the app

Date: 2026-11-09 · Status: committed, not deployed

## Request
Owner: "yes build the past-day edit option" (after change log 103: Sunday 8 Nov
had to be set to rest in the database because the app only edits the
current week).

## What changed
- New routes (src/server/routes/pastDays.ts):
  - `GET /api/programming/past-days`: last week's Monday through yesterday,
    newest first, each with its activity, any workout, and what it can
    become.
  - `PUT /api/programming/past-days/:date/activity { activity }`.
- What a past day can become depends on what was logged there:
  - completed workout: Gym, or Gym + badminton
  - nothing logged: Rest, or Badminton
  - planned or in-progress workout: blocked (log, finish or delete it first)
- The change writes only that day's week override, the same row the week
  view writes. It never runs the planner and never touches sessions, plans
  or other days: a past day is a record, and re-planning the rest of the
  week because of it would surprise the owner.
- Weekly program page: a new "Past days" section, one row per day with a
  drop-down that saves on change.

## Tests
- tests/routes/pastDays.test.ts: 6 pass (window, Sunday rest writes one
  override only, completed-workout and empty-day rules, planned workout
  blocks, today / future / older / invalid dates refused).
- Full suite: 234 failures, identical with and without this change. They
  are date rot: fixtures dated e.g. 2026-09-13 are now "in the past" for
  buildProgrammerContext. Not fixed here.
