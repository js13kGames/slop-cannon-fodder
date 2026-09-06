# Slop Cannon Fodder

A single-file, dependency-free pixel arena shooter. The pipeline shipped slop straight to
production and you are the on-call unicorn: hold the line, purge the slop, keep uptime above zero.

The whole game — art, audio, terrain, fonts — is generated from code. No images, no audio files,
no web fonts, no frameworks, **no network requests at all**. The deployable is one HTML file that
fits comfortably inside a 13 KB gzipped budget.

```
dist/slop-cannon-fodder.min.html   25,131 bytes raw   ->   10,217 bytes gzipped
budget 13 * 1024 = 13,312 bytes    ->   3,095 bytes remaining (77% used)
```

Exact, freshly generated numbers always live in [`dist/size-report.txt`](dist/size-report.txt).

## Play

Open `dist/slop-cannon-fodder.min.html` in any modern browser — double-click it, drop it on a
tab, or serve it from anywhere. It is completely standalone.

```bash
npm run play    # opens the production build
npm run dev     # opens the readable source, which is equally playable
```

### Controls

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` / arrow keys | move (fully independent of aim) |
| mouse | aim |
| hold left mouse | automatic rifle, unlimited ammo |
| right mouse **or** `Space` | throw a hotfix grenade toward the cursor |
| `P` / `Esc` | pause |
| `M` | mute |

### Rules of the incident

* **Uptime** is your health. At 0%, `PRODUCTION IS DOWN`.
* **Hotfixes** are grenades, capped at 5. They arm a 1.15 s fuse, paint a blinking danger ring at
  their blast radius, bounce off terrain, and hurt *you* as well as the slop. Catching three or
  more in one blast pays a `MULTI PATCH` bonus.
* **Incidents** are waves. Each one drips in more slop, faster, with a countdown and a quip
  between them. Clearing an incident pays a bonus and hands you a spare hotfix.
* Crates drop from kills and appear on a timer: green `H` is a hotfix, blue `R` is a rollback that
  restores uptime.

### The slop

| Type | Behaviour |
| --- | --- |
| Slop | the baseline blob: steady, plentiful, mildly damp |
| Flake | fast, erratic, dies quickly — an intermittent test failure with legs |
| Monolith | slow, enormous health pool, hits like a migration |
| Regression | splits into two Flakes when killed, because of course it does |

Flakes join at incident 2, Monoliths at 3, Regressions at 5.

## Seeds

Every run is generated from a text seed. The title screen is pre-filled with today's date in the
player's **local** timezone as `YYYYMMDD` — that is the daily challenge. Type anything else for a
custom run. The active seed is always visible in the bottom-right of the HUD and on the defeat
screen, so a good run can be shared and replayed exactly.

The seed drives an FNV-1a hash into three independent `mulberry32` streams: one lays out the
legacy-code blocks, one paints the terrain, and one — reset by `initWorld` on every start and
restart — drives everything that can change the outcome of a run (wave composition, spawn points,
enemy steering bias, weapon spread, drops and their timing). `Math.random` is reserved for purely
cosmetic work such as particles, goo splats and screen shake, so the same seed always plays out
the same way. Seeds are case-insensitive and stripped to `A-Z0-9`, so `slop` and `SLOP` are the
same arena.

Terrain generation guarantees a playable arena: the spawn pad at the centre is always cleared, and
after the blocks are placed a flood fill from the spawn seals any pocket it cannot reach. That
makes every open cell reachable by construction — no retry loop, no unreachable pickups. Enemies
and crates only ever spawn on open cells with room for their body, and enemies are placed at least
120 px away from you.

## Build

No dependencies, no install step, no network access. `build.js` is a self-contained minifier.

```bash
npm run build   # writes dist/slop-cannon-fodder.min.html and dist/size-report.txt
npm test        # builds, then runs the checks in test/
```

`build.js --no-mangle` produces the same output with readable identifiers, which is handy when
debugging a suspected minifier problem.

### How the minifier works

The build tokenizes the JavaScript properly (strings, template literals, regex literals,
comments, numbers, punctuators) rather than running regexes over source text, then:

1. collects every locally declared name (`var`/`let`/`const`, function names and parameters,
   arrow parameters, `catch` bindings);
2. marks tokens that must keep their spelling — anything after `.`/`?.` and object-literal keys —
   per token, never per name, so a property `hp` and a variable `hp` are treated separately;
3. renames declared names by descending frequency to `a`, `b`, `c`, … Consistent renaming is a
   bijection over names, so shadowing is preserved and no scope analysis is needed;
4. **fails the build** if any identifier is used but never declared and is not a known host global
   — that catches typos and accidental implicit globals before they ship;
5. emits tokens with the minimum separator needed, syntax-checks the result with `new Function`,
   and refuses to write output that references anything external.

CSS and HTML get a lighter, conservative squeeze (comments out, whitespace collapsed, inter-tag
gaps removed) that preserves the spaces between words in prose.

## Tests

`npm test` runs `node --test`, with no test framework to install:

* the same seed produces a byte-identical grid; different seeds do not; lower/upper case match
* every open cell is reachable from the spawn pad, the pad is clear, the border is solid, and the
  arena is neither empty nor cramped, across a spread of seeds
* the pixel font table has exactly one 5-row glyph per character
* the minifier preserves behaviour (minified and original snippets are executed and compared),
  keeps property names and strings intact, survives regex/ternary/division ambiguity, and rejects
  undeclared identifiers
* the build output parses, is self-contained, matches the reported gzip size, and is under budget
* the shipped HTML still contains the required strings (`PRODUCTION IS DOWN`, HUD labels,
  `contextmenu`, `AudioContext`, `pixelated`, …)
* a full run of the real simulation replays identically for one seed even when `Math.random`
  returns a different constant, restarting a seed reproduces both the terrain and the run, and a
  different seed diverges
* no enemy — including the radius-10 Monolith — ever spawns overlapping a block or the border,
  and a body's box test catches every cell it overlaps, not just its corners
* a bullet moving 16.5 px in one frame cannot tunnel through a 15 px wall or skip a small enemy,
  the nearest enemy on the path is hit first, and reach, lifetime and kill scoring are unchanged

The terrain tests lift the generator straight out of `src/index.html` between `/*<gen>*/` markers;
the gameplay tests run the real `<script>` block against a stub DOM/canvas. Nothing test-only is
added to the deployed file.

Beyond the automated checks, the build was exercised in a real browser: title → DEPLOY → movement
on WASD and arrows, held-fire cadence, grenades on both `Space` and right mouse, pause/resume,
defeat, `RETRY SAME SEED` and `NEW SEED` restarts with no page reload, zero console errors, no
`AudioContext` before the first interaction, and identical rendered terrain for a repeated seed.

## Layout

```
src/index.html                    readable source, the thing you edit
build.js                          dependency-free minifier + size report
test/build.test.js                node --test checks for terrain, minifier and budget
test/game.test.js                 node --test checks for the simulation itself
dist/slop-cannon-fodder.min.html  the deployable
dist/size-report.txt              generated, exact byte counts
```

## Implementation notes

* Fixed 480x270 internal canvas, integer-scaled to the viewport with `image-rendering: pixelated`.
* Terrain is painted once per seed into an offscreen canvas; goo splats are burned into it as the
  fight goes on, so the arena accumulates damage for free.
* All HUD text uses a 3x5 bitmap font stored as five octal digits per glyph, which keeps text
  crisp at low resolution instead of blurring like scaled canvas fonts.
* Enemies steer with a compact fan of probe angles around the direct line to the player, picking
  the first unobstructed one, plus light separation so a swarm stays readable.
* Audio is synthesized on demand (oscillator + noise buffer + filter envelopes) and the
  `AudioContext` is only created after the first real interaction, per browser autoplay rules.
* Touch controls are deliberately out of scope; this is a mouse-and-keyboard game.

## Licence

MIT.
