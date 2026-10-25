# Dark athletic UI and Training volume card

Commit `987f0b2` (main), deployed 2026-10-25. Owner: the UI was bland;
chose "Dark athletic" from three options.

## What
- `public/style.css` rewritten: dark charcoal surfaces, electric-lime
  accent, Barlow Condensed headings + Inter body (Google Fonts), pill
  buttons, glow on focus/progress, card entrance and set-done animations
  (all off under prefers-reduced-motion). Every class name unchanged; the
  pages only read tokens. Phone fixes: the nav shrinks and scrolls, the
  app name collapses to its icon under 520 px.
- `GET /api/insights/volume` (read-only): the weekly volume ledger
  overview (`volumeOverview` in `weeklyLedger.ts`), counting work logged
  through today; paused/athletic leg targets left out.
- Today page: Training volume card. Goal muscles this week with a progress
  ring; other muscles per 14-day cycle, sorted furthest behind first;
  bars turn green when reached, amber when behind, red when overdue.
- `calorieTrackerSync.ts`: same-instant sessions ordered by insertion
  (rowid), fixing a flaky test.

## Checks
Headless Chrome screenshots on a demo database (fake data) at 390 px and
1280 px: Today, Program, logger. Full suite: no new failures; new route
test in `tests/ai-programmer/weeklyLedger.test.ts`.

## Deployed
2026-10-25, code and static files only (no data change; backup
`pre-0df109d-20261025T174258Z.sqlite` from earlier the same day). Live
volume on deploy: triceps 16.3/24, long head 5/8, brachialis 6.7/8 this
week.
