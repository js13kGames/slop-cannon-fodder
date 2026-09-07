"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const b = require("../build.js");

const SRC = fs.readFileSync(b.SRC, "utf8");

/* Lift the deterministic terrain code straight out of the readable source so
   the tests exercise exactly what ships, without adding anything to dist. */
function loadGen() {
  const block = SRC.split("/*<gen>*/")[1].split("/*</gen>*/")[0];
  return new Function(block + "\nreturn {hashSeed:hashSeed,mulberry32:mulberry32,buildGrid:buildGrid};")();
}

const GW = 32, GH = 18;

function gridFor(seed) {
  const gen = loadGen();
  return gen.buildGrid(gen.mulberry32(gen.hashSeed(seed)), GW, GH);
}

test("same seed produces an identical grid", function () {
  assert.deepStrictEqual(Array.from(gridFor("20260906")), Array.from(gridFor("20260906")));
  assert.deepStrictEqual(Array.from(gridFor("hello")), Array.from(gridFor("HELLO")));
});

test("different seeds produce different grids", function () {
  const a = Array.from(gridFor("20260906"));
  let different = 0;
  const seeds = ["20260907", "SLOP", "PROD", "A1", "ZZZ9"];
  for (const s of seeds) {
    if (Array.from(gridFor(s)).join("") !== a.join("")) different++;
  }
  assert.strictEqual(different, seeds.length);
});

test("every open cell is reachable and the spawn pad is clear", function () {
  const seeds = ["20260906", "SLOP", "A", "9", "ONCALLUNICORN", "ZZZZ", "42", "PROD1"];
  for (const seed of seeds) {
    const g = gridFor(seed);
    const cx = GW >> 1, cy = GH >> 1;

    for (let y = cy - 1; y <= cy + 1; y++) {
      for (let x = cx - 2; x <= cx + 2; x++) {
        assert.strictEqual(g[x + y * GW], 0, "spawn pad blocked for seed " + seed);
      }
    }

    const seen = new Uint8Array(GW * GH);
    const stack = [cx + cy * GW];
    seen[cx + cy * GW] = 1;
    let reached = 1;
    while (stack.length) {
      const p = stack.pop();
      const px = p % GW, py = (p / GW) | 0;
      const nbr = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (const d of nbr) {
        const nx = px + d[0], ny = py + d[1];
        if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
        const np = nx + ny * GW;
        if (seen[np] || g[np]) continue;
        seen[np] = 1;
        reached++;
        stack.push(np);
      }
    }
    let open = 0;
    for (let i = 0; i < g.length; i++) if (!g[i]) open++;
    assert.strictEqual(reached, open, "unreachable pocket for seed " + seed);
    assert.ok(open > GW * GH * 0.4, "arena too cramped for seed " + seed + " (" + open + " open cells)");
    assert.ok(open < GW * GH * 0.95, "arena has no cover for seed " + seed);

    for (let x = 0; x < GW; x++) assert.strictEqual(g[x], 1);
    for (let y = 0; y < GH; y++) assert.strictEqual(g[y * GW], 1);
  }
});

test("pixel font table is aligned", function () {
  const chars = /const CHARS = "([^"]*)"/.exec(SRC)[1];
  const glyphSrc = SRC.split("const GLYPHS =")[1].split(";")[0];
  const glyphs = glyphSrc.match(/"[0-7]{5}"/g) || [];
  assert.strictEqual(glyphs.length, chars.length, "one 5-row glyph per character");
});

test("minifier preserves behaviour and property names", function () {
  const snippet = [
    "function addUp(firstValue, secondValue) { const total = firstValue + secondValue; return total; }",
    "const config = { alphaKey: 3, betaKey: 4 };",
    "function pick(flagValue) { return flagValue ? config.alphaKey : config.betaKey; }",
    "const label = 'alphaKey';",
    "return [addUp(2, 3), pick(true), pick(false), label, Math.max(1, 2)].join('|');"
  ].join("\n");
  const min = b.minifyJs(snippet).code;
  assert.ok(min.indexOf("alphaKey") >= 0, "object keys and strings survive");
  assert.ok(min.indexOf("firstValue") < 0, "locals are renamed");
  assert.strictEqual(new Function(min)(), new Function(snippet)());
});

test("minifier handles regex, ternaries and division", function () {
  const snippet = [
    "const raw = 'a1-b2!';",
    "const cleaned = raw.replace(/[^a-z0-9]/g, '');",
    "const half = cleaned.length / 2;",
    "const flag = half > 1 ? cleaned : raw;",
    "return cleaned + ':' + half + ':' + flag;"
  ].join("\n");
  const min = b.minifyJs(snippet).code;
  assert.strictEqual(new Function(min)(), new Function(snippet)());
});

test("minifier rejects undeclared identifiers", function () {
  assert.throws(function () { b.minifyJs("var a = notDeclaredAnywhere + 1; return a;"); }, /undeclared/);
});

test("external CSS URLs are rejected without mistaking canvas data export for a URL", function () {
  assert.ok(b.externalRefs('a{background:url("evil.png")}').includes("external css url()"));
  assert.deepEqual(b.externalRefs('canvas.toDataURL("image/png")'),[]);
});

test("build output is self-contained, valid and under budget", function () {
  const res = b.build({ quiet: true });
  const html = fs.readFileSync(b.OUT, "utf8");

  assert.strictEqual(b.externalRefs(html).length, 0);
  assert.ok(html.indexOf("<canvas") >= 0);
  assert.ok(/<script>[\s\S]+<\/script>/.test(html));

  const js = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.doesNotThrow(function () { new Function(js); }, "minified script parses");

  assert.strictEqual(res.gzBytes, zlib.gzipSync(Buffer.from(html), { level: 9 }).length);
  assert.ok(res.gzBytes <= b.BUDGET, "gzip " + res.gzBytes + " must be <= " + b.BUDGET);
  assert.ok(res.minBytes < res.rawBytes, "minified output is smaller than source");

  const report = fs.readFileSync(b.REPORT, "utf8");
  assert.ok(report.indexOf("PASS - under budget") >= 0);
  assert.ok(report.indexOf(String(res.gzBytes)) >= 0);
});

test("shipped game keeps the required behaviours", function () {
  const html = fs.readFileSync(b.OUT, "utf8");
  const needles = [
    "PRODUCTION IS DOWN", "DEPLOY", "RETRY SAME SEED", "NEW SEED",
    "INCIDENT", "UPTIME", "HOTFIX", "SEED", "PAUSED",
    "contextmenu", "AudioContext", "localStorage", "pixelated"
  ];
  for (const n of needles) assert.ok(html.indexOf(n) >= 0, "missing: " + n);
  assert.ok(path.isAbsolute(b.OUT));
});
