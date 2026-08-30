# Secondary-target mapping — a documented, exposed Blueprint dependency gap

## Why this document exists

The Next Phase spec (§7) requires computing compound-exercise exposure
with a primary/secondary muscle-role split (primary = 1.00 exposure
unit/set, secondary = 0.33) and gives a worked example requiring exactly
that split (flat barbell bench press → chest, triceps, front delts).

**Blueprint does not provide a canonical, id-resolvable secondary-target
field.** This was verified directly against the raw YAML source
(`data/exercises/chest.yaml` in `workout-blueprint`, commit
`b018abc1049cb578e13ece8af442852af1dfacfe`), not assumed:

```yaml
- id: flat-barbell-bench-press
  primary_targets:
    - chest (commonly cited as mid/sternal-biased)
  secondary_targets:
    - anterior deltoids
    - triceps
  physique_targets:
    - mid-pec
```

`physique_targets` (canonical, id-resolvable via `BlueprintAdapter
.getTarget()`) has exactly **one** entry here — `mid-pec`. There is no
`secondary_physique_targets` field, no per-target role tag, nothing
beyond the flat `physique_targets` list this app already treats as
"what this exercise directly trains" (see `docs/TRAINING_EXPOSURE_MODEL.md`
§A). `secondary_targets` exists only as free text authored for human
readers, not for programmatic id resolution.

Per spec §25: *"If an existing Blueprint field required by this
specification is unavailable, expose the exact missing dependency in
implementation/test output rather than inventing a substitute."* This
document is that disclosure. What follows is not a workaround that
pretends the gap doesn't exist — it's an explicit, small, fully
enumerated, human-reviewable table, built from Blueprint's own actual
(closed) vocabulary, with every ambiguous case left unmapped rather than
guessed. It is not fuzzy text matching (no similarity scoring, no partial
matches) — it is a literal dictionary lookup after a fixed normalization
step (stripping parenthetical asides and trailing clauses), and its
entire contents are below, in full, for review.

**The correct long-term fix is Strategy B from `docs/TRAINING_EXPOSURE_MODEL.md`
§B: Blueprint itself should grow a canonical secondary-target field.**
This table is a stopgap the spec explicitly asked for, living entirely in
`src/blueprint/secondaryTargetMapping.ts`, never hidden inside exposure
logic — see that file for the runtime implementation.

## How primary exposure is resolved (no mapping needed)

Primary exposure (coefficient 1.00) uses `Exercise.physique_targets` /
`Exercise.functional_goals` directly — this is already canonical,
already implemented (`docs/TRAINING_EXPOSURE_MODEL.md` §A), and requires
no text mapping at all. The bench-press worked example's "chest" *is*
`mid-pec` — Blueprint's own canonical entry for that exercise. Displaying
it as "chest" in explanations is just resolving `mid-pec`'s human-readable
`name` ("Mid Chest") for output, not a different data path.

**Consequence, stated plainly**: primary exposure is exactly as precise
as Blueprint's own `physique_targets` field already is — including its
gaps. 10 of 123 exercises have no `physique_targets` entry at all (7 of
those also have no `functional_goals`), so they currently register **zero
primary exposure** — not a bug, a faithful reflection of what Blueprint
canonically states:

```text
back-extension-45-spinal-dominant   (primary_targets text: spinal erectors — no canonical target exists)
conventional-deadlift               (primary_targets text: spinal erectors, glutes, hamstrings — no canonical target)
farmers-carry                       (primary_targets text: grip, forearms — no canonical target)
isometric-neck-hold                 (primary_targets text: neck flexors/extensors/lateral flexors — no canonical target)
lateral-neck-flexion                (primary_targets text: lateral neck flexors — no canonical target)
pronation-supination-work           (primary_targets text: pronators, supinators — no canonical target)
tibialis-raise                      (primary_targets text: tibialis anterior — no canonical target)
```

(The other 3 — `cable-band-external-rotation`, `push-up-plus`,
`standing-cable-hip-flexion` — have no `physique_targets` but do have a
`functional_goals` entry, so they still register functional primary
exposure correctly.) This gap is Blueprint's, not this app's invention to
fix — flagging it here satisfies §25 rather than silently working around
it with a guess (e.g. inventing that `conventional-deadlift`'s primary
target is `hamstrings`, which nothing in Blueprint's canonical data
actually states).

## The secondary-target mapping (full contents)

Built by normalizing every `secondary_targets` entry across all 123
exercises (strip `(...)` asides and anything after an em dash/semicolon,
lowercase) and enumerating every resulting unique phrase — 32 total, no
sampling. `src/blueprint/secondaryTargetMapping.ts` is this exact table
in code form.

### Mapped (confident, unambiguous)

| Normalized phrase | Maps to | Target type |
|---|---|---|
| `adductors` | `adductors` | physique_target |
| `anterior deltoids` | `front-delt` | physique_target |
| `biceps` | `biceps` | physique_target |
| `brachialis` | `brachialis-arm-thickness` | physique_target |
| `gastrocnemius` | `gastrocnemius` | physique_target |
| `hamstrings` | `hamstrings` | physique_target |
| `hip flexors` | `hip-flexors` | functional_goal |
| `hip stabilizers` | `hip-stability` | functional_goal |
| `lats` | `lat-width` | physique_target |
| `mid-back` | `back-thickness` | physique_target |
| `obliques` | `obliques` | physique_target |
| `quads` | `quads` | physique_target |
| `rectus abdominis` | `rectus-abdominis` | physique_target |
| `serratus anterior` | `scapular-stability` | functional_goal |
| `soleus` | `soleus` | physique_target |
| `traps` | `upper-traps` | physique_target |
| `triceps` | `triceps` | physique_target |
| `upper chest` | `upper-pec` | physique_target |
| `upper trapezius` | `upper-traps` | physique_target |
| `wrist extensors` | `forearm-extensors` | physique_target |
| `external rotators` | `rotator-cuff` | functional_goal |
| `glutes` | `gluteus-maximus` | physique_target (see note) |
| `grip` | `forearm-flexors` | physique_target (see note) |

**Notes on the two judgment calls above** (everything else in this table
is a direct or near-exact name match, not a judgment call):
- `glutes` → `gluteus-maximus`: Blueprint has two glute targets
  (`gluteus-maximus`, `gluteus-medius-minimus`). Unqualified "glutes" is
  mapped to the larger, standard colloquial referent
  (`gluteus-maximus`) rather than left unmapped, because every
  exercise using bare "glutes" in Blueprint's own text is a
  hip-extension-dominant movement (squats, deadEnter variants, hip
  thrusts) where `gluteus-maximus` is unambiguously the intended
  muscle — `gluteus-medius-minimus` is Blueprint's own separate target
  for ABduction-pattern work (hip abduction), which is never what
  "glutes" refers to in this exercise pool.
- `grip` → `forearm-flexors`: grip strength is produced by the forearm
  flexor group; Blueprint has no separate "grip" target.

### Explicitly left UNMAPPED (too generic or genuinely no canonical target)

| Normalized phrase | Why unmapped |
|---|---|
| `brachioradialis` | No canonical target precise enough; not clearly `forearm-extensors` vs. its own thing. |
| `calves` | Ambiguous between `gastrocnemius` and `soleus` — Blueprint distinguishes them, generic text doesn't say which. |
| `chest` | Ambiguous between `upper-pec`/`mid-pec`/`lower-pec`. |
| `elbow flexors` | Ambiguous between `biceps` and `brachialis-arm-thickness`. |
| `erectors` / `spinal erectors` | No canonical physique target for spinal erectors exists in Blueprint at all. |
| `forearms` | Ambiguous between `forearm-flexors` and `forearm-extensors`. |
| `hip musculature` | Too generic — could be several targets. |
| `shoulders` | Ambiguous between `front-delt`/`side-delt`/`rear-delt`. |
| `tensor fasciae latae` | No canonical target. |
| `trunk musculature` | Too generic — could be `obliques`, `rectus-abdominis`, or spinal erectors (which itself has no target). |

An unmapped phrase contributes **zero secondary exposure**, but is not
silently dropped — `calculateExerciseExposure`'s output records it as an
explicit unmapped entry (see `src/engine/exposureEngine.ts`) so
explanations can say "secondary target 'chest' noted by Blueprint but not
exposure-tracked (ambiguous canonical mapping)" rather than just omitting
it with no trace.

## Maintenance

If Blueprint's exercise data changes (new exercises, edited
`secondary_targets` text), re-run the enumeration this table was built
from and check for new unique phrases:

```bash
python3 -c "
import json, re
ex = json.load(open('src/blueprint/snapshot/exercises.json'))
def normalize(s):
    s = re.sub(r'\s*\([^)]*\)', '', s)
    s = re.split(r'\s*—\s*|\s*;\s*', s)[0]
    return s.strip().lower()
phrases = set()
for e in ex:
    for s in e.get('secondary_targets') or []:
        phrases.add(normalize(s))
print(sorted(phrases))
"
```

Compare the output against the keys in
`src/blueprint/secondaryTargetMapping.ts` — any new phrase needs an
explicit decision (mapped or deliberately left unmapped), never a silent
default.
