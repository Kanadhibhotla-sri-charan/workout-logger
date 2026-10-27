# Telemetry console UI

Owner request 2026-10-27: make the UI more advanced and high tech.
Replaces the 2026-10-25 dark athletic theme (change log 92); every class
name unchanged, pages only read tokens.

## What
- `public/style.css`: navy ink background with a faint 28 px measurement
  grid; panels with cyan corner reticles; chamfered buttons and set
  toggles; nav as a segmented strip with a lit underline; hexagonal goal
  rank badge; title scale-rule. Chakra Petch (headings, numbers) and IBM
  Plex Sans (text); sentence case throughout (no all-caps labels);
  tabular numbers.
- Colour roles: ice-cyan signal, coral for goal muscles, mint done, amber
  behind, red errors.
- Training volume card: segmented meters (coral for goal muscles, cyan
  for the rest) and a ticked gauge for the weekly goal total. Share rows
  (long head, upper/mid chest) sit under their parent; numbers rounded to
  one decimal.
- Card entrance stagger and hover lifts removed (one fade only).

## Checks
Headless Chrome screenshots on a fake demo database: Today (1280 px and
390 px), Program, logger (390 px). Reduced motion still respected.
