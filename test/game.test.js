"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");

const b = require("../build.js");

const SRC = fs.readFileSync(b.SRC, "utf8");
const GAME_JS = /<script>([\s\S]*?)<\/script>/.exec(SRC)[1];

const W = 480, H = 270, CS = 15, GW = 32, GH = 18;

test("feature harness executes the exact shipped minified JavaScript", function () {
  const shipped = /<script>([\s\S]*?)<\/script>/.exec(fs.readFileSync(b.OUT,"utf8"))[1];
  assert.equal(b.minifyJs(GAME_JS).code,shipped);
});

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
    listeners: {},
    dispatch: function (type, e) { (this.listeners[type] || []).forEach(function (fn) { fn(Object.assign({key:"", target:null, preventDefault:function(){}}, e)); }); },
    value: "", textContent: "", innerHTML: "", width: 0, height: 0,
    style: {},
    click: function () { this.dispatch("click", {}); },
    toDataURL: function () { return "data:image/png;base64,AA=="; },
    classList: { add: function () {}, remove: function () {} },
    addEventListener: function (type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    setPointerCapture: function () {}, releasePointerCapture: function () {}, hasPointerCapture: function () { return true; },
    getContext: function () { return stubCtx(); },
    getBoundingClientRect: function () { return { left: 0, top: 0, width: W, height: H }; }
  };
}

/* `visual` is the constant handed to Math.random: gameplay must ignore it. */
function loadGame(visual, minified, storage, env) {
  const els = {};
  const document = {
    addEventListener: function (type, fn) { window.addEventListener(type, fn); },
    getElementById: function (id) { return (els[id] = els[id] || stubEl()); },
    createElement: function () { return stubEl(); }
  };
  const window = {
    listeners: {},
    dispatch: stubEl().dispatch,
    location: {hash:"", protocol:"file:", href:"file:///game.html"},
    innerWidth: W * 2, innerHeight: H * 2,
    addEventListener: stubEl().addEventListener,
    requestAnimationFrame: function () { return 0; },
    localStorage: storage || { getItem: function () { return null; }, setItem: function () {} }
  };
  Object.assign(window, env);
  const M = Object.create(Math);
  M.random = function () { return visual; };

  const expose = [
    "return {",
    "window:window, document:document, els:els,",
    "hurtPlayer:hurtPlayer, utcSeed:utcSeed, parseChallenge:parseChallenge, challengeText:challengeText, upgradeOrder:upgradeOrder, chooseUpgrade:chooseUpgrade,",
    "info:function(){return {cause:damageCause, closed:closedWaves, result:result, upgrades:upgrades.slice(), best:best, rifle:rifle, speed:speed, armor:armor};},",
    "set:function(s){if(s.wave!==undefined)wave=s.wave;if(s.score!==undefined)score=s.score;if(s.deadAt!==undefined)deadAt=s.deadAt;},",
    "clearWave:function(){enemies=[];queue=[];breakTimer=0;update(.01);},",
    "pickups:function(){return pickups;},",
    "nextWave:nextWave, buildQueue:buildQueue, reportCanvas:reportCanvas, shareText:shareText,",
    "rng:function(){return gameRng();},",
    "touch:function(){return [touchX,touchY,moveTouch,aimTouch,wantGrenade];},",
    "  canvas: cv, toWorld: toWorld,",
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

  const api = expose.replace("els:els", 'els:function(id){return document.getElementById(id);}');
  let js = GAME_JS + "\n" + api;
  if (minified) {
    const min = b.minifyJs(GAME_JS);
    const tokens = b.tokenize(api);
    const mapped = tokens.map(function(t,i) {
      const prev = tokens[i-1], next = tokens[i+1];
      return t.t === "id" && min.names.has(t.v) && !(prev && prev.v === ".") && !(next && next.v === ":") ? min.names.get(t.v) : t.v;
    }).join(" ");
    js = min.code + "\n" + mapped;
  }
  return new Function("window", "document", "Math", js)(window, document, M);
}

for (const minified of [false, true]) {
  test("results, UTC, draft, challenge and registered input (" + minified + ")", function () {
    const g = loadGame(.5, minified);
    assert.equal(g.utcSeed(new Date("2026-09-07T00:30:00Z")), "20260907");
    g.startGame("sample");
    g.hurtPlayer(10, "FLAKE");
    g.hurtPlayer(999, "OWN HOTFIX");
    assert.equal(g.info().cause, "FLAKE");
    assert.equal(g.player().hp, 90);
    g.set({wave:2});
    g.clearWave();
    assert.equal(g.snapshot().state, "draft");
    assert.equal(g.info().closed, 1);
    const frozen = g.snapshot();
    g.update(1);
    assert.deepEqual(g.snapshot(), frozen);
    const order = g.upgradeOrder(2);
    assert.equal(new Set(order).size, 3);
    g.chooseUpgrade(0);
    g.chooseUpgrade(0);
    assert.equal(g.info().upgrades.length, 1);
    assert.equal(g.snapshot().wave, 3);
    g.player().inv = 0;
    g.hurtPlayer(999, "MONOLITH");
    assert.equal(g.info().result.cause, "MONOLITH");
    assert.equal(g.info().result.closed, 1);
    g.set({deadAt:-1000});
    g.window.dispatch("keydown", {key:"Enter", repeat:true});
    assert.equal(g.snapshot().state, "dead");
    g.window.dispatch("keydown", {key:"Enter", target:{tagName:"BUTTON"}});
    assert.equal(g.snapshot().state, "dead");
    g.window.dispatch("keyup", {key:"Enter"});
    g.window.dispatch("keydown", {key:"Enter"});
    assert.equal(g.snapshot().state, "play");
    assert.deepEqual(g.parseChallenge("#v=1&r=2&s=ABC&t=1200&c=4"), {seed:"ABC",score:1200,closed:4});
    for (const hash of ["#v=1&r=1&s=ABC&t=0&c=0", "#v=1&r=2&s=%&t=0&c=0", "#v=1&r=2&s=abc&t=0&c=0", "#v=1&r=2&s=ABC&t=-1&c=0", "#v=1&r=2&s=ABC&t=0&c=0&c=1", "#v=1&r=2&s=ABC&t=9007199254740992&c=0"]) {
      assert.throws(function(){g.parseChallenge(hash);});
    }
    g.canvas.dispatch("pointerdown", {pointerId:1,pointerType:"touch",clientX:80,clientY:130});
    g.canvas.dispatch("pointermove", {pointerId:1,pointerType:"touch",clientX:110,clientY:160});
    g.canvas.dispatch("pointerdown", {pointerId:2,pointerType:"touch",clientX:400,clientY:130});
    assert.equal(g.mouse.fire,true);
    g.window.dispatch("blur", {});
    assert.equal(g.mouse.fire,false);
    assert.equal(g.snapshot().state,"pause");
  });
}

test("lethal contact cannot heal, score or clear afterwards", function () {
  const g = loadGame(.5);
  g.startGame("DEATH");
  g.player().hp = 1;
  g.spawnEnemy(0);
  Object.assign(g.enemies()[0], {x:g.player().x,y:g.player().y,born:0});
  g.pickups().push({x:g.player().x,y:g.player().y,kind:1,t:0});
  g.update(.01);
  assert.equal(g.player().hp,0);
  assert.equal(g.info().result.score,g.snapshot().score);
  assert.equal(g.pickups().length,1);
});

test("per-seed validated best, near miss and storage fallback", function () {
  const values = {};
  const g = loadGame(.5, false, {getItem:function(k){return values[k] || null;},setItem:function(k,v){values[k]=v;}});
  g.startGame("A");g.set({score:100});g.hurtPlayer(999,"SLOP");
  g.startGame("A");g.set({score:90});g.hurtPlayer(999,"SLOP");
  assert.match(g.info().result.comparison,/10.*short/);
  g.startGame("B");assert.equal(g.info().best,0);
  const f = loadGame(.5, false, {getItem:function(){throw Error();},setItem:function(){throw Error();}});
  f.startGame("A");f.set({score:123});f.hurtPlayer(999,"SLOP");f.startGame("A");
  assert.equal(f.info().best,123);
  assert.match(f.els("notice").textContent,/session/i);
});

for (const minified of [false,true]) {
  test("draft RNG, guaranteed early enemies, stacking and breaks (" + minified + ")", function () {
    const a = loadGame(.1,minified), c = loadGame(.9,minified);
    a.startGame("STAGES");c.startGame("STAGES");
    a.upgradeOrder(2);a.upgradeOrder(4);a.upgradeOrder(6);
    assert.equal(a.rng(),c.rng(),"UI consumes no gameplay random numbers");
    for (let wave=2;wave<=4;wave++) assert.equal(a.buildQueue(wave).pop(),wave-1);
    a.startGame("STAGES");
    a.clearWave();
    assert.equal(a.snapshot().breakTimer,1.8);
    a.window.dispatch("keydown",{key:"n"});
    assert.equal(a.snapshot().wave,2);
    for (const wave of [2,4,6]) {
      a.set({wave});a.clearWave();
      a.window.dispatch("keydown",{key:"n"});
      assert.equal(a.snapshot().state,"draft");
      const hardened = a.upgradeOrder(wave).indexOf(2);
      a.els("up"+hardened).dispatch("click",{});
      assert.equal(a.snapshot().wave,wave+1);
    }
    assert.equal(a.info().upgrades.length,3);
    assert.equal(a.info().armor,.75**3);
    assert.ok(Math.abs(a.info().rifle-1.15**3)<1e-12);
    a.hurtPlayer(10,"SLOP");
    assert.equal(a.player().hp,96,"damage is rounded once after stacking");
    a.player().inv=0;a.hurtPlayer(.1,"FLAKE");
    assert.equal(a.player().hp,95,"minimum one damage");
    a.set({wave:8});a.clearWave();
    assert.equal(a.snapshot().state,"play","no fourth draft");
  });

  test("pointer ownership, cancellation, hybrid mouse and lifecycle cleanup (" + minified + ")", function () {
    const g = loadGame(.5,minified);
    const cv=g.canvas;
    const p=function(id,x,y,type) {return {pointerId:id,clientX:x,clientY:y,pointerType:type||"touch",button:0};};
    let blurred = false;
    g.document.activeElement = {blur:function(){blurred=true;}};
    g.startGame("TOUCH");
    assert.equal(blurred,true,"hidden action buttons must not swallow gameplay keys");
    cv.dispatch("pointerdown",p(1,50,120));cv.dispatch("pointermove",p(1,54,124));
    assert.deepEqual(g.touch().slice(0,2),[0,0],"dead zone");
    cv.dispatch("pointermove",p(1,150,220));
    assert.ok(Math.abs(Math.hypot(...g.touch().slice(0,2))-1)<1e-8,"normalized diagonal");
    cv.dispatch("pointerdown",p(2,400,100));cv.dispatch("pointerdown",p(3,450,200));
    assert.equal(g.touch()[3],2,"third pointer cannot steal aim");
    g.els("hotfixBtn").dispatch("pointerdown",p(3,450,240));
    assert.equal(g.touch()[4],true);
    cv.dispatch("pointercancel",p(1,150,220));
    assert.deepEqual(g.touch().slice(0,3),[0,0,null]);
    assert.equal(g.mouse.fire,true,"movement cancellation retains independent aim");
    cv.dispatch("lostpointercapture",p(2,400,100));
    assert.equal(g.mouse.fire,false);
    cv.dispatch("pointerdown",p(4,400,100,"mouse"));
    cv.dispatch("pointermove",Object.assign(p(4,400,100,"mouse"),{button:2,buttons:3}));
    assert.equal(g.mouse.fire,true,"right click while holding left retains rifle");
    assert.equal(g.touch()[4],true,"right click while firing throws a hotfix");
    cv.dispatch("pointermove",Object.assign(p(4,400,100,"mouse"),{button:0,buttons:2}));
    assert.equal(g.mouse.fire,false,"left release while holding right stops rifle");
    cv.dispatch("pointerdown",Object.assign(p(4,400,100,"mouse"),{button:2}));
    assert.equal(g.touch()[4],true,"hybrid right click");
    g.window.dispatch("resize",{});
    assert.deepEqual(g.touch(),[0,0,null,null,false]);
    assert.equal(g.snapshot().state,"pause");
    g.els("pauseBtn").dispatch("click",{});
    cv.dispatch("pointermove",Object.assign(p(4,400,100,"mouse"),{buttons:1}));
    assert.equal(g.mouse.fire,false,"held mouse cannot survive pause cleanup");
    g.document.hidden=true;g.window.dispatch("visibilitychange",{});
    assert.equal(g.snapshot().state,"pause");
    assert.equal(cv.listeners.mousedown,undefined,"no duplicate synthetic mouse handlers");
  });

  test("best zero/tie/record, invalid values and Enter guards (" + minified + ")", function () {
    const values={},storage={getItem:function(k){return values[k]===undefined?null:values[k];},setItem:function(k,v){values[k]=v;}};
    const g=loadGame(.5,minified,storage);
    g.startGame("ZERO");g.hurtPlayer(999,"SLOP");
    assert.match(g.info().result.comparison,/First/);
    g.startGame("zero");g.hurtPlayer(999,"SLOP");
    assert.match(g.info().result.comparison,/Tied/);
    g.startGame("ZERO");g.set({score:10});g.hurtPlayer(999,"SLOP");
    assert.match(g.info().result.comparison,/New.*previous 0/);
    for (const val of ["Infinity","NaN","-1","12oops","1.5","9007199254740992"]) {
      values["scf.2.BAD"]=val;g.startGame("BAD");assert.equal(g.info().best,0);
    }
    g.window.dispatch("keydown",{key:"Enter"});
    g.hurtPlayer(999,"SLOP");g.set({deadAt:-1000});
    g.window.dispatch("keydown",{key:"Enter"});
    assert.equal(g.snapshot().state,"dead","held pre-death Enter is rejected");
    g.window.dispatch("keyup",{key:"Enter"});
    g.set({deadAt:performance.now()});
    g.window.dispatch("keydown",{key:"Enter"});
    assert.equal(g.snapshot().state,"dead","350ms guard");
    g.window.dispatch("keyup",{key:"Enter"});
    g.set({deadAt:-1000});
    g.window.dispatch("keydown",{key:"Enter",target:{isContentEditable:true}});
    assert.equal(g.snapshot().state,"dead","editable target");
  });

  test("challenge report, file fallback, explicit sharing and PNG do not alter simulation (" + minified + ")", async function () {
    let writes=0;
    const g=loadGame(.5,minified,null,{location:{hash:"#v=1&r=2&s=ABC&t=100&c=2",protocol:"https:",href:"https://example.test/game.html?secret=1#old"},navigator:{clipboard:{writeText:function(){writes++;return Promise.reject({name:"NotAllowedError"});}}}});
    assert.match(g.els("bestLine").textContent,/Unverified challenge/);
    g.startGame("ABC");g.set({score:90});g.hurtPlayer(999,"OWN HOTFIX");
    assert.equal(writes,0,"no API without explicit click");
    assert.match(g.shareText(),/https:\/\/example.test\/game.html#v=1&r=2&s=ABC&t=90&c=0/);
    assert.doesNotMatch(g.shareText(),/secret/);
    assert.match(g.shareText(),/Unverified challenge.*10 short/);
    assert.match(g.shareText(),/First run/,"imported target is not a personal best");
    const before=g.snapshot();g.reportCanvas();assert.deepEqual(g.snapshot(),before);
    g.els("shareBtn").dispatch("click",{});await Promise.resolve();
    assert.equal(writes,1);assert.match(g.els("notice").textContent,/copy/i);
    g.window.location.protocol="file:";
    assert.doesNotMatch(g.shareText(),/https:/);
    assert.match(g.shareText(),/Offline.*seed/);
    g.window.navigator={share:function(){return Promise.reject({name:"AbortError"});}};
    g.els("shareBtn").dispatch("click",{});await Promise.resolve();
    assert.match(g.els("notice").textContent,/Cancelled/);
    g.window.navigator={};g.els("shareBtn").dispatch("click",{});
    assert.match(g.els("reportText").value,/SLOP CANNON FODDER/);
    const bad=loadGame(.5,minified,null,{location:{hash:"#v=1&r=1&s=ABC&t=1&c=0"}});
    assert.match(bad.els("notice").textContent,/incompatible/);
  });
}

test("gameplay canvas fills the viewport without a decorative frame", function () {
  const css = /<style>([\s\S]*?)<\/style>/.exec(SRC)[1];
  const stage = /#stage\s*\{([^}]+)\}/.exec(css)[1];
  const canvas = /canvas\s*\{([^}]+)\}/.exec(css)[1];
  assert.match(stage, /position:\s*fixed/);
  assert.match(stage, /inset:\s*0/);
  assert.doesNotMatch(stage, /gradient/);
  assert.match(canvas, /width:\s*100%/);
  assert.match(canvas, /height:\s*100%/);
  assert.doesNotMatch(canvas, /box-shadow/);
  const g = loadGame(0.5);
  assert.strictEqual(g.canvas.style.width, undefined, "no inline width overrides viewport sizing");
  assert.strictEqual(g.canvas.style.height, undefined, "no inline height overrides viewport sizing");
});

test("aim maps the full canvas to the arena at any viewport aspect ratio", function () {
  const g = loadGame(0.5);
  for (const [width, height] of [[1440, 900], [2560, 1080], [390, 844]]) {
    g.canvas.getBoundingClientRect = function () { return { left: 0, top: 0, width: width, height: height }; };
    g.toWorld({ clientX: width / 2, clientY: height / 2 });
    assert.strictEqual(g.mouse.x, W / 2);
    assert.strictEqual(g.mouse.y, H / 2);
    g.toWorld({ clientX: width, clientY: height });
    assert.strictEqual(g.mouse.x, W - 1);
    assert.strictEqual(g.mouse.y, H - 1);
    g.toWorld({ clientX: 0, clientY: 0 });
    assert.strictEqual(g.mouse.x, 0);
    assert.strictEqual(g.mouse.y, 0);
  }
});

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
      if (g.snapshot().state === "draft") { g.chooseUpgrade(0); g.mouse.fire = true; }
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
