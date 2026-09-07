#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const build = require("../build.js");

function baseURL(value) {
  if (!value || value.length > 2048) throw Error("Supply your public HTTP(S) base URL.");
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw Error("Base URL must be HTTP(S), without credentials, query or hash.");
  }
  return url.href.replace(/\/?$/, "/");
}
function escapeHTML(value) {
  return value.replace(/[&<>"']/g, function (c) { return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; });
}
function metadata(value, page = "") {
  const base = baseURL(value);
  const canonical = escapeHTML(new URL(page,base).href);
  const image = escapeHTML(new URL("preview.png",base).href);
  return `<link rel="canonical" href="${canonical}">
<meta name="description" content="How long can you keep production alive? A unicorn arena shooter in 13 KB.">
<meta property="og:type" content="website"><meta property="og:title" content="Slop Cannon Fodder">
<meta property="og:description" content="How long can you keep production alive?">
<meta property="og:url" content="${canonical}"><meta property="og:image" content="${image}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Pink on-call unicorn defending a pixel arena">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="Slop Cannon Fodder">
<meta name="twitter:description" content="How long can you keep production alive?">
<meta name="twitter:image" content="${image}">`;
}
function landing(value) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Slop Cannon Fodder</title><link rel="icon" href="data:,">
${metadata(value)}
<style>body{margin:2em auto;padding:0 1em;max-width:60em;background:#0d0d18;color:#ffd9f2;font:18px/1.6 monospace}img{width:100%;height:auto}a{color:#ff8ad2;display:inline-block;padding:1em}h1{color:#ff8ad2}</style>
</head><body><h1>Slop Cannon Fodder</h1><p>How long can you keep production alive?</p>
<img src="preview.png" width="1200" height="630" alt="On-call unicorn versus production slop">
<p>A complete zero-dependency arena shooter in under 13 KB gzipped. Art, sound, terrain and fonts generated from code. No tracking, no accounts.</p>
<a id="play" href="play.html">Deploy →</a><a href="play.html" download="slop-cannon-fodder.html">Download offline game</a>
<p>Daily UTC seeds. Three upgrade drafts. Instant retries. Share an unverified score challenge with a friend.</p>
<script>const hash=location.hash;if(hash.length<=100&&/^#v=1&r=[0-9]+&s=[A-Z0-9]{1,14}&t=[0-9]{1,16}&c=[0-9]{1,6}$/.test(hash))document.getElementById("play").href="play.html"+hash;</script>
</body></html>`;
}
function generate(value) {
  const html = landing(value);
  const result = build.build({quiet:true});
  if (result.gzBytes > build.BUDGET) throw Error("Game exceeds 13 KB.");
  const root = path.join(__dirname,".."), out = path.join(root,"dist","hosted");
  const preview = fs.readFileSync(path.join(root,"assets","preview.png"));
  fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,"index.html"),html);
  fs.writeFileSync(path.join(out,"preview.png"),preview);
  const game = fs.readFileSync(build.OUT,"utf8");
  fs.writeFileSync(path.join(out,"play.html"),game.replace("</head>",metadata(value,"play.html") + "</head>"));
  console.log("Generated dist/hosted only. Nothing published.");
}
module.exports = {baseURL, landing, escapeHTML, generate};
if (require.main === module) generate(process.argv[2] || process.env.PUBLIC_BASE_URL);
