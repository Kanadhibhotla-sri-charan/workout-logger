# Logger: one-line rows, pinned progress strip, sections

Owner 2026-10-30: too much scrolling on the phone in the gym to find an
exercise and see what is done; the listed order is not the order the
exercises are done in (so no "next" / "previous"). Suggestions 1-4 approved.

## What (public/logger.html, public/style.css; no server change)
- Every exercise is a one-line row (status circle, name, planned
  prescription or what was logged) that opens on tap; several can be open
  at once (supersets).
- Pinned progress strip under the app header: exercises done, sets done,
  a meter, and one chip per exercise (done / unsaved / pending / skipped)
  that opens and jumps to it. The title block scrolls away.
- Sections: Warm-up (drills before the first lift), Main session, After the
  session (drills after the last lift), each with "x / y done".
- Saving collapses that row as done and keeps the page where it was; open
  rows and unsaved entries in other exercises survive the rebuild (before,
  a save in one exercise dropped unsaved entries in the others).
- The finish bar is no longer pinned to the bottom (it took about a quarter
  of the screen); it sits after the list.
- Fixed labels: an AI-planned exercise no longer shows "Unplanned exercise";
  an exercise not yet started shows "Not started" instead of "0 completed,
  3 skipped".

## Checks
Demo database (fake data) at phone width (390 px) through Chrome DevTools:
chip jump, unsaved state, save flow (counts 2 to 3 exercises, 6 to 9 sets;
saved row collapsed; another exercise's unsaved 30 kg kept; scroll
unchanged). Full suite: 246 failures, all date-dependent (233 before, plus
13 whose fixed target date 2026-10-28 is now in the past); none from this
change (HTML/CSS only).

## Deployed
2026-10-30 03:45 UTC (09:15 IST). Backup `deployment-backups/pre-a1c181e-20261030T034500Z.sqlite`. Health ok; the new logger page is served.
