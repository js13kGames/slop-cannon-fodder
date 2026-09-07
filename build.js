#!/usr/bin/env node
/**
 * Zero-dependency build for Slop Cannon Fodder.
 *
 * Reads the readable single-file source, minifies the HTML/CSS/JS with a
 * hand-rolled JS tokenizer (no npm packages, no network) and writes the
 * deployable file plus an exact size report.
 *
 * The JS minifier renames every locally declared identifier. That is safe
 * here because renaming is a bijection over names: consistent renaming
 * preserves shadowing. Property names and object-literal keys are never
 * touched, and any identifier that is used but never declared must appear
 * in GLOBALS or the build fails loudly.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = __dirname;
const SRC = path.join(ROOT, "src", "index.html");
const OUT_DIR = path.join(ROOT, "dist");
const OUT = path.join(OUT_DIR, "slop-cannon-fodder.min.html");
const REPORT = path.join(OUT_DIR, "size-report.txt");
const BUDGET = 13 * 1024; // 13312 bytes gzipped

const KEYWORDS = new Set(("break case catch class const continue debugger default delete do else export extends " +
  "finally for function if import in instanceof new return super switch this throw try typeof var void while with " +
  "yield let static async await true false null undefined enum implements interface package private protected public")
  .split(" "));

/* Identifiers that legitimately come from the host environment. */
const GLOBALS = new Set(("window document Math Date JSON console Object Array String Number Boolean Infinity NaN " +
  "undefined parseInt parseFloat isNaN isFinite Uint8Array Uint16Array Uint32Array Int32Array Float32Array " +
  "Float64Array Set Map WeakMap Promise Symbol Error TypeError RangeError Function RegExp AudioContext " +
  "requestAnimationFrame cancelAnimationFrame setTimeout clearTimeout setInterval clearInterval performance " +
  "navigator location localStorage sessionStorage alert Image Audio arguments globalThis self top parent")
  .split(" "));

/* ------------------------------------------------------------------ */
/* JS tokenizer                                                        */
/* ------------------------------------------------------------------ */
const PUNCS = [">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=",
  "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "=>", "++", "--", "+=", "-=", "*=", "/=",
  "%=", "&=", "|=", "^=", "<<", ">>", "**",
  "{", "}", "(", ")", "[", "]", ";", ",", "<", ">", "+", "-", "*", "/", "%", "&", "|", "^",
  "!", "~", "?", ":", "=", ".", "#"];

function isIdStart(c) { return /[A-Za-z_$]/.test(c); }
function isIdChar(c) { return /[A-Za-z0-9_$]/.test(c); }

function regexAllowed(prev) {
  if (!prev) return true;
  if (prev.t === "num" || prev.t === "str" || prev.t === "regex" || prev.t === "tpl") return false;
  if (prev.t === "id") return KEYWORDS.has(prev.v) && ["this", "super", "true", "false", "null", "undefined"].indexOf(prev.v) < 0;
  return [")", "]", "}", "++", "--"].indexOf(prev.v) < 0;
}

function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i + 2) + 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      toks.push({ t: "str", v: src.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    if (c === "`") {
      let j = i + 1, depth = 0;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "`" && depth === 0) break;
        if (src[j] === "$" && src[j + 1] === "{") { depth++; j += 2; continue; }
        if (src[j] === "}" && depth > 0) depth--;
        j++;
      }
      toks.push({ t: "tpl", v: src.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] || ""))) {
      const m = /^(0[xXbBoO][0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/.exec(src.slice(i));
      toks.push({ t: "num", v: m[0] });
      i += m[0].length;
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdChar(src[j])) j++;
      toks.push({ t: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === "/" && regexAllowed(toks[toks.length - 1])) {
      let j = i + 1, cls = false;
      while (j < n) {
        const d = src[j];
        if (d === "\\") { j += 2; continue; }
        if (d === "[") cls = true;
        else if (d === "]") cls = false;
        else if (d === "/" && !cls) break;
        j++;
      }
      j++;
      while (j < n && /[a-z]/.test(src[j])) j++;
      toks.push({ t: "regex", v: src.slice(i, j) });
      i = j;
      continue;
    }
    let hit = null;
    for (let k = 0; k < PUNCS.length; k++) {
      if (src.startsWith(PUNCS[k], i)) { hit = PUNCS[k]; break; }
    }
    if (!hit) throw new Error("unexpected character " + JSON.stringify(c) + " at " + i);
    toks.push({ t: "punc", v: hit });
    i += hit.length;
  }
  return toks;
}

/* ------------------------------------------------------------------ */
/* declaration analysis                                                */
/* ------------------------------------------------------------------ */
function collectDeclared(toks) {
  const declared = new Set();
  const named = function (tok) { return tok && tok.t === "id" && !KEYWORDS.has(tok.v); };

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];

    if (t.t === "id" && (t.v === "var" || t.v === "let" || t.v === "const")) {
      let j = i + 1, depth = 0, expect = true;
      while (j < toks.length) {
        const u = toks[j];
        if (u.t === "punc") {
          if ("([{".indexOf(u.v) >= 0) depth++;
          else if (")]}".indexOf(u.v) >= 0) { if (depth === 0) break; depth--; }
          else if (u.v === ";" && depth === 0) break;
          else if (u.v === "," && depth === 0) expect = true;
        } else if (u.t === "id") {
          if (u.v === "of" || u.v === "in") break;
          if (expect && named(u)) { declared.add(u.v); expect = false; }
        }
        j++;
      }
    }

    if (t.t === "id" && (t.v === "function" || t.v === "class")) {
      let j = i + 1;
      if (named(toks[j])) { declared.add(toks[j].v); j++; }
      if (t.v === "function" && toks[j] && toks[j].v === "(") {
        let depth = 0;
        for (let k = j; k < toks.length; k++) {
          const u = toks[k];
          if (u.t === "punc" && u.v === "(") depth++;
          else if (u.t === "punc" && u.v === ")") { depth--; if (!depth) break; }
          else if (depth === 1 && named(u)) declared.add(u.v);
        }
      }
    }

    if (t.t === "punc" && t.v === "=>") {
      const p = toks[i - 1];
      if (p && p.t === "punc" && p.v === ")") {
        let depth = 0, k = i - 1;
        for (; k >= 0; k--) {
          const u = toks[k];
          if (u.t === "punc" && u.v === ")") depth++;
          else if (u.t === "punc" && u.v === "(") { depth--; if (!depth) break; }
        }
        for (let m = k + 1; m < i - 1; m++) if (named(toks[m])) declared.add(toks[m].v);
      } else if (named(p)) declared.add(p.v);
    }

    if (t.t === "id" && t.v === "catch" && toks[i + 1] && toks[i + 1].v === "(" && named(toks[i + 2])) {
      declared.add(toks[i + 2].v);
    }
  }
  return declared;
}

/* Mark tokens that must keep their spelling: property accesses and
   object-literal keys. Marking is per token, not per name. */
function markProps(toks) {
  const skip = new Array(toks.length).fill(false);
  const objStack = [];
  const OBJ_AFTER = ["=", "(", ",", ":", "[", "?", "&&", "||", "=>"];

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === "punc" && (t.v === "." || t.v === "?.")) {
      if (toks[i + 1] && toks[i + 1].t === "id") skip[i + 1] = true;
    }
    if (t.t === "punc" && t.v === "{") {
      const p = toks[i - 1];
      let isObj = false;
      if (!p) isObj = false;
      else if (p.t === "punc") isObj = OBJ_AFTER.indexOf(p.v) >= 0 && p.v !== "=>";
      else if (p.t === "id") isObj = p.v === "return";
      objStack.push(isObj);
    }
    if (t.t === "punc" && t.v === "}") objStack.pop();
    if (t.t === "id" && toks[i + 1] && toks[i + 1].t === "punc" && toks[i + 1].v === ":" &&
        objStack.length && objStack[objStack.length - 1]) {
      const p = toks[i - 1];
      if (p && p.t === "punc" && (p.v === "{" || p.v === ",")) skip[i] = true;
    }
  }
  return skip;
}

function nameGen(taken) {
  const A = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const B = A + "0123456789_$";
  let n = 0;
  return function next() {
    for (;;) {
      let i = n++;
      let s = A[i % 52];
      i = Math.floor(i / 52);
      while (i > 0) { i--; s += B[i % 64]; i = Math.floor(i / 64); }
      if (!taken.has(s) && !KEYWORDS.has(s)) return s;
    }
  };
}

/* ------------------------------------------------------------------ */
/* emit                                                                */
/* ------------------------------------------------------------------ */
function needsSpace(a, b) {
  const x = a[a.length - 1], y = b[0];
  if (isIdChar(x) && isIdChar(y)) return true;
  if (x === "+" && y === "+") return true;
  if (x === "-" && y === "-") return true;
  if (x === "/" && (y === "/" || y === "*")) return true;
  if (x === "<" && y === "!") return true;
  return false;
}

function minifyJs(src, opts) {
  opts = opts || {};
  const toks = tokenize(src);
  const declared = collectDeclared(toks);
  const skip = markProps(toks);

  const freq = new Map();
  const external = new Set();
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t !== "id" || skip[i] || KEYWORDS.has(t.v)) continue;
    if (declared.has(t.v)) freq.set(t.v, (freq.get(t.v) || 0) + 1);
    else external.add(t.v);
  }

  const unknown = [];
  external.forEach(function (name) { if (!GLOBALS.has(name)) unknown.push(name); });
  if (unknown.length) {
    throw new Error("undeclared identifiers (typo, or add to GLOBALS): " + unknown.sort().join(", "));
  }

  const map = new Map();
  if (opts.mangle !== false) {
    const taken = new Set(external);
    const next = nameGen(taken);
    const order = Array.from(freq.keys()).sort(function (a, b) {
      return (freq.get(b) - freq.get(a)) || (a < b ? -1 : 1);
    });
    for (let i = 0; i < order.length; i++) map.set(order[i], next());
  }

  let out = "";
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    let v = t.v;
    if (t.t === "id" && !skip[i] && map.has(v)) v = map.get(v);
    if (out && needsSpace(out, v)) out += " ";
    out += v;
  }
  return { code: out, renamed: map.size, tokens: toks.length, names: map };
}

function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{}:;,>])\s*/g, "$1")
    .replace(/;}/g, "}")
    .trim();
}

function minifyHtml(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/>\s+</g, "><")
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ */
/* build                                                               */
/* ------------------------------------------------------------------ */
function externalRefs(html) {
  const bad = [];
  const patterns = [
    [/https?:\/\//i, "absolute URL"],
    [/<script[^>]+src=/i, "external script"],
    [/@import/i, "css import"],
    [/\bfetch\s*\(/, "fetch()"],
    [/XMLHttpRequest/, "XMLHttpRequest"],
    [/\bimport\s*\(/, "dynamic import"],
    [/\burl\(\s*["']?(?!data:)/i, "external css url()"]
  ];
  for (let i = 0; i < patterns.length; i++) {
    if (patterns[i][0].test(html)) bad.push(patterns[i][1]);
  }
  /* <link> is only allowed when it points at an inline data: URI */
  const links = html.match(/<link\b[^>]*>/gi) || [];
  for (let i = 0; i < links.length; i++) {
    if (!/href=["']data:/i.test(links[i])) bad.push("external link element");
  }
  return bad;
}

function build(opts) {
  opts = opts || {};
  const raw = fs.readFileSync(SRC, "utf8");

  const styleM = /<style>([\s\S]*?)<\/style>/.exec(raw);
  const scriptM = /<script>([\s\S]*?)<\/script>/.exec(raw);
  if (!styleM || !scriptM) throw new Error("src/index.html must contain one <style> and one <script> block");

  const js = minifyJs(scriptM[1], opts);
  const css = minifyCss(styleM[1]);

  /* fail fast on syntax damage before anything reaches disk */
  new Function(js.code);

  let html = raw
    .replace(styleM[0], "<style>" + css + "</style>")
    .replace(scriptM[0], "<script>" + js.code + "</script>");

  const marker = "<script>" + js.code + "</script>";
  const at = html.indexOf(marker);
  html = minifyHtml(html.slice(0, at)) + marker + minifyHtml(html.slice(at + marker.length));

  const refs = externalRefs(html);
  if (refs.length) throw new Error("output is not self-contained: " + refs.join(", "));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, html);

  const rawBytes = Buffer.byteLength(raw);
  const minBytes = Buffer.byteLength(html);
  const gzBytes = zlib.gzipSync(Buffer.from(html), { level: 9 }).length;
  const brBytes = zlib.brotliCompressSync(Buffer.from(html)).length;

  const report = [
    "Slop Cannon Fodder - size report",
    "generated " + new Date().toISOString(),
    "",
    "readable source   src/index.html                 " + rawBytes + " bytes",
    "production build  dist/slop-cannon-fodder.min.html " + minBytes + " bytes  (minified raw)",
    "gzip -9           dist/slop-cannon-fodder.min.html " + gzBytes + " bytes  (deployable size)",
    "brotli            dist/slop-cannon-fodder.min.html " + brBytes + " bytes  (informational)",
    "",
    "budget            13 KB = 13 * 1024               " + BUDGET + " bytes",
    "remaining         budget - gzip                   " + (BUDGET - gzBytes) + " bytes",
    "used                                              " + (gzBytes / BUDGET * 100).toFixed(2) + "%",
    "",
    "minifier          " + js.renamed + " identifiers renamed, " + js.tokens + " js tokens",
    "compression ratio " + (minBytes / rawBytes * 100).toFixed(1) + "% of source, gzip " +
      (gzBytes / minBytes * 100).toFixed(1) + "% of minified",
    "self-contained    yes (no network requests, no external assets)",
    "status            " + (gzBytes <= BUDGET ? "PASS - under budget" : "FAIL - over budget"),
    ""
  ].join("\n");

  fs.writeFileSync(REPORT, report);
  if (!opts.quiet) process.stdout.write(report);
  if (gzBytes > BUDGET) {
    process.exitCode = 1;
  }
  return { rawBytes: rawBytes, minBytes: minBytes, gzBytes: gzBytes, brBytes: brBytes, budget: BUDGET, html: html };
}

module.exports = { build: build, minifyJs: minifyJs, minifyCss: minifyCss, minifyHtml: minifyHtml, tokenize: tokenize, externalRefs: externalRefs, BUDGET: BUDGET, OUT: OUT, SRC: SRC, REPORT: REPORT };

if (require.main === module) {
  build({ mangle: process.argv.indexOf("--no-mangle") < 0 });
}
