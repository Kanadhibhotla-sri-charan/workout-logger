// Workout Programmer UI Fix §2/§11.B: source-level regression proving
// logger.html exposes the session note UI (compact, optional, using the
// existing workout_sessions.notes field via PATCH /api/workouts/:id),
// in this repo's established static-markup-assertion style (see
// tests/frontend/dailyActivityUI.test.ts).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '../../public');

function readFile(name: string): string {
  return readFileSync(join(publicDir, name), 'utf8');
}

describe('logger.html: session note UI', () => {
  const html = readFile('logger.html');

  it('has a compact, labeled session note input', () => {
    expect(html).toMatch(/Session note/);
    expect(html).toMatch(/id: 'session-note-input'/);
    expect(html).toMatch(/e\.g\. Rope for pushdowns, EZ bar for curls/);
  });

  it('pre-fills the existing note when reopening the session (never mandatory)', () => {
    expect(html).toMatch(/textarea\.value = session\.notes \|\| ''/);
  });

  it('saves via the existing session PATCH endpoint, not a new one', () => {
    expect(html).toMatch(/buildSessionNoteSection/);
    expect(html).toMatch(/api\(`\/api\/workouts\/\$\{sessionId\}`, \{\s*method: 'PATCH',\s*body: \{ notes: value \},/);
  });

  it('an empty note clears it (sends null, not an empty string)', () => {
    expect(html).toMatch(/textarea\.value\.trim\(\) \|\| null/);
  });

  it('is shown for gym sessions; badminton keeps its own existing notes field instead of a duplicate one', () => {
    expect(html).toMatch(/Badminton already has its own per-session notes field/);
  });
});
