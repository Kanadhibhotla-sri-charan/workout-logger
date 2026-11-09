# 103 · Sunday 8 Nov marked as rest (data fix)

Date: 2026-11-09 · Type: production data change, no code · Status: applied

## Request
Owner: "mark 8th Nov as rest day. as today is 9th I do not have the option to do it from the app"

## Why the app could not do it
`PUT /api/programming/week/days/:day/activity` takes a weekday and always
applies it to the current week (from today). On Monday 9 Nov, "sunday"
means 15 Nov, so a past week's day cannot be changed from the app.

## What was done
- Backup: `deployment-backups/pre-rest-2026-11-08-20261109T035049Z.sqlite` (integrity ok).
- Inserted one `week_activity_overrides` row, the same shape `setOverride`
  writes and the same as the owner's earlier Sunday rest overrides
  (weeks of 2026-10-05 and 2026-10-19):
  week_start 2026-11-02, day sunday, activity unselected. 1 row changed.
- No workout session existed on 2026-11-08; nothing else touched.
- Checked: `GET /api/programming/week?date=2026-11-08` shows 2026-11-08 as rest.

## Open
Changing a past day from the app is not supported. Offered to the owner as
a small change (a date-based variant of the activity route); not built.
