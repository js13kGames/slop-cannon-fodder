"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");

const b = require("../build.js");

const SRC = fs.readFileSync(b.SRC, "utf8");
const GAME_JS = /<script>([\s\S]*?)<\/script>/.exec(SRC)[1];

const W = 480, H = 270, CS = 15, GW = 32, GH = 18;

/* ------------------------------------------------------------------
   Just enough DOM/canvas to run the real simulation headlessly. Every
   drawing call is swallowed, so only gameplay state is exercised.
   ------------------------------------------------------------------ */
function stubCtx() {
  const store = {};
  return new Proxy(store, {
    get: function (t, k) {
      if (typeof k === "symbol") return undefined;
      if (!(k in t)) t[k] = function () {};
      return t[k];
    },
    set: function (t, k, v) { t[k] = v; return true; }
  });
}

function stubEl() {
  return {
    value: "", textContent: "", innerHTML: "", width: 0, height: 0,
    style: {},
    classList: { add: function () {}, remove: function () {} },
    addEventListener: function () {},
    getContext: function () { return stubCtx(); },
    getBoundingClientRect: function () { return { left: 0, top: 0, width: W, height: H }; }
  };
}

/* `visual` is the constant handed to Math.random: gameplay must ignore it. */
function loadGame(visual) {
  const els = {};
  const document = {
    getElementById: function (id) { return (els[id] = els[id] || stubEl()); },
    createElement: function () { return stubEl(); }
  };
  const window = {
    innerWidth: W * 2, innerHeight: H * 2,
    addEventListener: function () {},
    requestAnimationFrame: function () { return 0; },
    localStorage: { getItem: function () { return null; }, setItem: function () {} }
  };
  const M = Object.create(Math);
  M.random = function () { return visual; };

  const expose = [
    "return {",
    "  TYPES: TYPES,",
    "  initWorld: initWorld, startGame: startGame, update: update,",
    "  updateBullets: updateBullets, spawnEnemy: spawnEnemy, blocked: blocked,",
    "  openSpot: openSpot, mouse: mouse, keys: keys,",
    "  hurtEnemy: hurtEnemy, player: function () { return player; },",
    "  grenade: function () { wantGrenade = true; },",
    "  invincible: function () { player.hp = 1e9; },",
    "  grid: function () { return Array.from(grid); },",
    "  enemies: function () { return enemies; },",
    "  bullets: function () { return bullets; },",
    "  snapshot: function () {",
    "    return {",
    "      state: state, seed: seedText, score: score, kills: kills, wave: wave,",
    "      spawnTimer: spawnTimer, breakTimer: breakTimer, pickTimer: pickTimer,",
    "      queue: queue.slice(),",
    "      player: [player.x, player.y, player.hp, player.gren, player.bloom, player.aim],",
    "      enemies: enemies.map(function (e) {",
    "        return [e.kind, e.x, e.y, e.vx, e.vy, e.hp, e.side, e.t, e.born];",
    "      }),",
    "      bullets: bullets.map(function (u) { return [u.x, u.y, u.vx, u.vy, u.t]; }),",
    "      pickups: pickups.map(function (u) { return [u.kind, u.x, u.y]; })",
    "    };",
    "  }",
    "};"
  ].join("\n");

  return new Function("window", "document", "Math", GAME_JS + "\n" + expose)(window, document, M);
}

/* Drive the real update loop with a fixed timestep and scripted input. */
function play(g, frames) {
  g.mouse.x = 380;
  g.mouse.y = 70;
  g.mouse.fire = true;
  for (let i = 0; i < frames; i++) {
    if (i % 137 === 0) g.grenade();
    if (i % 211 === 0) g.mouse.fire = !g.mouse.fire;
    g.mouse.x = 40 + (i * 7) % 400;
    g.update(1 / 60);
  }
  return g.snapshot();
}

/* Independent overlap check: no cell touched by the body may be solid. */
function overlapsSolid(grid, x, y, r) {
  for (let cy = Math.floor((y - r) / CS); cy <= Math.floor((y + r) / CS); cy++) {
    for (let cx = Math.floor((x - r) / CS); cx <= Math.floor((x + r) / CS); cx++) {
      if (cx < 0 || cy < 0 || cx >= GW || cy >= GH) return true;
      if (grid[cx + cy * GW] === 1) return true;
    }
  }
  return false;
}

test("gameplay is identical for one seed regardless of cosmetic randomness", function () {
  const a = loadGame(0.1);
  const c = loadGame(0.87);
  a.startGame("DETERMINISM");
  c.startGame("DETERMINISM");
  const sa = play(a, 900);
  const sc = play(c, 900);

  assert.ok(sa.enemies.length + sa.kills > 0, "the run actually simulated something");
  assert.deepStrictEqual(sa, sc);
});

test("restarting the same seed resets terrain and the gameplay RNG", function () {
  const g = loadGame(0.42);
  g.startGame("RESTART1");
  const first = play(g, 420);
  const firstGrid = g.grid();

  g.startGame("RESTART1");
  const second = play(g, 420);

  assert.deepStrictEqual(second, first);
  assert.deepStrictEqual(g.grid(), firstGrid);

  g.startGame("RESTART2");
  const other = play(g, 420);
  assert.notDeepStrictEqual(other, first);
});

test("enemies never spawn overlapping walls or borders, monoliths included", function () {
  const g = loadGame(0.5);
  const seeds = ["20260906", "SLOP", "PROD", "MONOLITH", "ZZZZ", "42", "A1", "ONCALLUNICORN"];
  let spawned = 0;
  for (const seed of seeds) {
    g.initWorld(seed);
    const grid = g.grid();
    for (let kind = 0; kind < g.TYPES.length; kind++) {
      for (let i = 0; i < 60; i++) g.spawnEnemy(kind);
    }
    const list = g.enemies();
    assert.strictEqual(list.length, g.TYPES.length * 60);
    for (const e of list) {
      assert.strictEqual(e.r, g.TYPES[e.kind].r);
      assert.ok(!overlapsSolid(grid, e.x, e.y, e.r),
        "seed " + seed + ": kind " + e.kind + " (r" + e.r + ") spawned in a wall at " + e.x + "," + e.y);
      assert.ok(!g.blocked(e.x, e.y, e.r), "blocked() disagrees for seed " + seed);
      spawned++;
    }
  }
  assert.strictEqual(spawned, seeds.length * g.TYPES.length * 60);
});

test("blocked() sees a solid cell the body straddles, not just its corners", function () {
  const g = loadGame(0.5);
  g.initWorld("20260906");
  const grid = g.grid();
  let checked = 0;
  /* a lone pillar with open cells on both sides fits between the box corners of a r=10 body */
  for (let cy = 1; cy < GH - 1; cy++) {
    for (let cx = 1; cx < GW - 1; cx++) {
      if (!grid[cx + cy * GW]) continue;
      const x = cx * CS + CS / 2, y = cy * CS + CS / 2;
      assert.ok(g.blocked(x, y, 10), "solid cell " + cx + "," + cy + " must block a r=10 body");
      assert.ok(g.blocked(x, y, 1), "solid cell " + cx + "," + cy + " must block a small body");
      checked++;
    }
  }
  assert.ok(checked > 0);
  /* the arena border is solid from any side */
  assert.ok(g.blocked(CS / 2, H / 2, 10));
  assert.ok(g.blocked(W - CS / 2, H / 2, 10));
  assert.ok(g.blocked(W / 2, CS / 2, 10));
  assert.ok(g.blocked(W / 2, H - CS / 2, 10));
});

/* Find a solid cell with open cells to its left and right. */
function wallRun(grid) {
  for (let cy = 1; cy < GH - 1; cy++) {
    for (let cx = 2; cx < GW - 2; cx++) {
      if (grid[cx + cy * GW] === 1 && !grid[cx - 1 + cy * GW] && !grid[cx + 1 + cy * GW]) {
        return { cx: cx, cy: cy };
      }
    }
  }
  return null;
}

test("a fast bullet cannot tunnel through a wall", function () {
  const g = loadGame(0.5);
  g.startGame("TUNNEL");
  const spot = wallRun(g.grid());
  assert.ok(spot, "seed TUNNEL needs a one-cell wall with open sides");

  const y = spot.cy * CS + CS / 2;
  const enemies = g.enemies();
  enemies.length = 0;
  /* the victim sits just past the wall, exactly where an untested endpoint lands */
  enemies.push({ x: (spot.cx + 1) * CS + 2, y: y, vx: 0, vy: 0, r: 4.5, kind: 1, hp: 2, max: 2, flash: 0, t: 0, side: 1, born: 0 });

  const bullets = g.bullets();
  bullets.length = 0;
  bullets.push({ x: spot.cx * CS - 1, y: y, vx: 330, vy: 0, t: 0.9 });

  const before = g.snapshot().score;
  g.updateBullets(0.05);   // 16.5px of travel across a 15px wall

  assert.strictEqual(bullets.length, 0, "the bullet must stop at the wall");
  assert.strictEqual(enemies.length, 1, "nothing behind the wall may be hit");
  assert.strictEqual(enemies[0].hp, 2);
  assert.strictEqual(g.snapshot().score, before);
});

test("a fast bullet cannot skip a small enemy, and the nearest one is hit first", function () {
  const g = loadGame(0.5);
  g.startGame("TUNNEL");
  const y = (GH >> 1) * CS + CS / 2;
  const x0 = ((GW >> 1) - 2) * CS + 2;   // inside the guaranteed spawn pad

  const enemies = g.enemies();
  enemies.length = 0;
  const near = { x: x0 + 8.25, y: y, vx: 0, vy: 0, r: 4.5, kind: 1, hp: 2, max: 2, flash: 0, t: 0, side: 1, born: 0 };
  const far = { x: x0 + 15, y: y, vx: 0, vy: 0, r: 4.5, kind: 1, hp: 2, max: 2, flash: 0, t: 0, side: 1, born: 0 };
  enemies.push(near, far);

  const bullets = g.bullets();
  bullets.length = 0;
  bullets.push({ x: x0, y: y, vx: 330, vy: 0, t: 0.9 });

  g.updateBullets(0.05);   // endpoint alone lands 8.25px past the near enemy

  assert.strictEqual(bullets.length, 0, "the bullet must be consumed by the hit");
  assert.strictEqual(near.hp, 1, "the nearest enemy takes the hit");
  assert.strictEqual(far.hp, 2, "the enemy behind it is untouched");
});

test("bullets keep their reach, lifetime and kill scoring", function () {
  const g = loadGame(0.5);
  g.startGame("TUNNEL");
  const y = (GH >> 1) * CS + CS / 2;
  const x0 = ((GW >> 1) - 2) * CS + 1;

  const enemies = g.enemies();
  enemies.length = 0;
  const bullets = g.bullets();
  bullets.length = 0;

  /* clear air: one step of travel must not eat the bullet */
  bullets.push({ x: x0, y: y, vx: 330, vy: 0, t: 0.9 });
  g.updateBullets(1 / 60);
  assert.strictEqual(bullets.length, 1);
  assert.ok(Math.abs(bullets[0].x - (x0 + 330 / 60)) < 1e-6, "travel distance is unchanged");
  assert.ok(Math.abs(bullets[0].t - (0.9 - 1 / 60)) < 1e-9);

  /* an expired bullet is dropped without moving or hitting anything */
  bullets.length = 0;
  enemies.push({ x: x0 + 4, y: y, vx: 0, vy: 0, r: 4.5, kind: 1, hp: 1, max: 2, flash: 0, t: 0, side: 1, born: 0 });
  bullets.push({ x: x0, y: y, vx: 330, vy: 0, t: 0.01 });
  g.updateBullets(0.05);
  assert.strictEqual(bullets.length, 0);
  assert.strictEqual(enemies.length, 1, "a dead bullet deals no damage");

  /* a killing hit still scores */
  const before = g.snapshot();
  bullets.push({ x: x0, y: y, vx: 330, vy: 0, t: 0.9 });
  g.updateBullets(0.05);
  const after = g.snapshot();
  assert.strictEqual(enemies.length, 0, "the enemy dies");
  assert.strictEqual(after.kills, before.kills + 1);
  assert.strictEqual(after.score, before.score + g.TYPES[1].pts);
});

test("no body is ever accepted while overlapping a wall", function () {
  const g = loadGame(0.5);
  let frames = 0, monoliths = 0;
  for (const seed of ["LONGRUN", "SLOP", "20260906"]) {
    g.startGame(seed);
    g.mouse.fire = true;
    const grid = g.grid();
    for (let i = 0; i < 3600; i++) {
      g.invincible();                       // survive long enough to meet monoliths
      g.mouse.x = 40 + (i * 11) % 400;
      g.mouse.y = 20 + (i * 5) % 230;
      g.keys.d = i % 240 < 120;
      g.keys.a = i % 240 >= 120;
      g.keys.w = i % 400 < 200;
      g.keys.s = i % 400 >= 200;
      if (i % 180 === 0) g.grenade();
      g.update(1 / 60);
      for (const e of g.enemies()) {
        frames++;
        if (e.kind === 2) monoliths++;
        assert.ok(!overlapsSolid(grid, e.x, e.y, e.r),
          "seed " + seed + " frame " + i + ": kind " + e.kind + " ended up in a wall");
      }
    }
    for (const k of Object.keys(g.keys)) g.keys[k] = false;
    g.mouse.fire = false;
  }
  assert.ok(frames > 10000, "the long run simulated " + frames + " body frames");
  assert.ok(monoliths > 0, "monoliths (radius 10) took part");
});

/* Put a lone regression at x,y, kill it, and hand back whatever it split into. */
function killRegressionAt(g, x, y) {
  const list = g.enemies();
  list.length = 0;
  const parent = {
    x: x, y: y, vx: 0, vy: 0, r: g.TYPES[3].r, kind: 3,
    hp: 1, max: 1, flash: 0, t: 0, side: 1, born: 0
  };
  list.push(parent);
  g.hurtEnemy(parent, 99, false);
  assert.ok(list.indexOf(parent) < 0, "the parent regression died");
  return list.slice();
}

/* True when the cell has a wall (or the arena border) as one of its 8 neighbours. */
function hugsWall(grid, cx, cy) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) return true;
      if (grid[nx + ny * GW] === 1) return true;
    }
  }
  return false;
}

test("regression children never split into a wall, however tight the corpse sits", function () {
  const g = loadGame(0.5);
  const seeds = ["20260906", "SLOP", "PROD", "ZZZZ", "42", "ONCALLUNICORN"];
  let splits = 0;
  for (const seed of seeds) {
    g.startGame(seed);
    const grid = g.grid();
    const pr = g.TYPES[3].r, cr = g.TYPES[1].r;
    const nudge = CS / 2 - pr - 0.1;    // as flush against a neighbouring cell as r=7 fits
    for (let cy = 1; cy < GH - 1; cy++) {
      for (let cx = 1; cx < GW - 1; cx++) {
        if (grid[cx + cy * GW] === 1 || !hugsWall(grid, cx, cy)) continue;
        const bx = cx * CS + CS / 2, by = cy * CS + CS / 2;
        for (const ox of [0, nudge, -nudge]) {
          for (const oy of [0, nudge, -nudge]) {
            const x = bx + ox, y = by + oy;
            assert.ok(!g.blocked(x, y, pr), "the parent regression itself must be a legal body");
            const kids = killRegressionAt(g, x, y);
            assert.strictEqual(kids.length, 2,
              "seed " + seed + ": a regression at " + x + "," + y + " must split in two");
            for (const k of kids) {
              assert.strictEqual(k.kind, 1);
              assert.strictEqual(k.r, cr);
              const where = "seed " + seed + ": child at " + k.x + "," + k.y +
                " from a corpse at " + x + "," + y;
              assert.ok(!overlapsSolid(grid, k.x, k.y, k.r), where + " overlaps a wall");
              assert.ok(!g.blocked(k.x, k.y, k.r), where + " is blocked");
              assert.ok(Math.hypot(k.x - x, k.y - y) <= 4 * CS, where + " was flung across the arena");
            }
            splits++;
          }
        }
      }
    }
  }
  assert.ok(splits > 500, "only " + splits + " wall-hugging splits were exercised");
});

test("children of a wall-hugging regression stay mobile, so the incident can close", function () {
  const g = loadGame(0.5);
  for (const seed of ["TUNNEL", "SLOP"]) {
    g.startGame(seed);
    const grid = g.grid();
    const wall = wallRun(grid);
    assert.ok(wall, "seed " + seed + " needs a one-cell wall with open sides");

    const pr = g.TYPES[3].r;
    /* the corpse is pressed flat against the wall's left face */
    const x = wall.cx * CS - pr - 0.1, y = wall.cy * CS + CS / 2;
    assert.ok(!g.blocked(x, y, pr), "the corpse position is a legal body");

    const kids = killRegressionAt(g, x, y);
    assert.strictEqual(kids.length, 2);
    const start = kids.map(function (k) { return { x: k.x, y: k.y }; });

    g.mouse.fire = false;
    for (let i = 0; i < 240; i++) {
      g.invincible();
      g.update(1 / 60);
      for (const k of kids) {
        assert.ok(!overlapsSolid(grid, k.x, k.y, k.r),
          "seed " + seed + " frame " + i + ": a split child ended up inside a wall");
      }
    }
    kids.forEach(function (k, i) {
      assert.ok(Math.hypot(k.x - start[i].x, k.y - start[i].y) > CS,
        "seed " + seed + ": child " + i + " never left its spawn point, so it is wedged");
    });
  }
});

test("only cosmetic randomness may call Math.random", function () {
  const js = GAME_JS.replace(/\/\*[\s\S]*?\*\//g, "");
  const gameplay = ["spawnEnemy", "hurtEnemy", "steerAngle", "buildQueue", "nextWave", "shoot", "openSpot", "nearSpot", "update"];
  for (const name of gameplay) {
    const body = js.split("function " + name + "(")[1];
    assert.ok(body, "missing function " + name);
    const src = body.split("\nfunction ")[0];
    assert.ok(src.indexOf("Math.random") < 0, name + "() must not use Math.random");
    assert.ok(!/[^g]rand\(/.test(src), name + "() must use the seeded grand()");
  }
});
