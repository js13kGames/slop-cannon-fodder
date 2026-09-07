"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {landing, baseURL, generate} = require("../scripts/build-hosted.js");
const fs = require("node:fs");
const path = require("node:path");
const build = require("../build.js");
const zlib = require("node:zlib");

test("renderer-generated promotional PNGs have the advertised dimensions", function () {
  for (const [name,width,height] of [["preview.png",1200,630],["incident-example.png",960,760]]) {
    const png = fs.readFileSync(path.join(__dirname,"..","assets",name));
    assert.equal(png.subarray(0,8).toString("hex"),"89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16),width);
    assert.equal(png.readUInt32BE(20),height);
  }
});

test("hosted base is explicit, canonical HTTP(S), without credentials, query or hash", function () {
  for (const value of ["", "file:///game", "javascript:alert(1)", "https://a.test/?x=1", "https://u:p@a.test/", "https://a.test/#x", "//a.test/"]) {
    assert.throws(function () { baseURL(value); });
  }
  assert.equal(baseURL("https://example.test/my-game"), "https://example.test/my-game/");
});
test("landing has escaped absolute social metadata, local links and bounded forwarding", function () {
  const html = landing('https://example.test/a"b/');
  assert.match(html, /property="og:image" content="https:\/\/example.test\/a%22b\/preview.png"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  assert.match(html, /rel="canonical"/);
  assert.match(html, /href="play.html"/);
  assert.doesNotMatch(html, /analytics|fetch\(/);
  const js = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  function forwarded(hash) {
    const link = {href:"play.html"};
    new Function("location", "document", js)({hash}, {getElementById:function(){return link;}});
    return link.href;
  }
  assert.equal(forwarded("#v=1&r=2&s=ABC&t=123&c=4"),"play.html#v=1&r=2&s=ABC&t=123&c=4");
  assert.equal(forwarded("#" + "a".repeat(101)),"play.html");
  assert.equal(forwarded('#s="><script>'),"play.html");
});

test("generated challenge target has escaped social metadata without changing the standalone", function (t) {
  const out = path.join(__dirname,"..","dist","hosted");
  const existed = fs.existsSync(out);
  const saved = ["index.html","play.html","preview.png"].map(function (name) {
    const file = path.join(out,name);
    return [file, fs.existsSync(file) ? fs.readFileSync(file) : null];
  });
  t.after(function () {
    for (const [file, content] of saved) {
      if (content === null) fs.rmSync(file,{force:true});
      else fs.writeFileSync(file,content);
    }
    if (!existed && fs.existsSync(out)) fs.rmdirSync(out);
  });
  // Keep standalone build I/O in memory: other test files rebuild it in parallel.
  const artifacts = new Map();
  const readFile = fs.readFileSync, writeFile = fs.writeFileSync;
  t.mock.method(fs,"writeFileSync",function (file, content, ...options) {
    if (file === build.OUT || file === build.REPORT) artifacts.set(file,content);
    else return writeFile(file,content,...options);
  });
  t.mock.method(fs,"readFileSync",function (file, ...options) {
    return artifacts.has(file) ? artifacts.get(file) : readFile(file,...options);
  });
  const standalone = build.build({quiet:true}).html;
  const source = fs.readFileSync(build.SRC,"utf8");
  const base = 'https://example.test/games/a"&b\'/';
  const escapedBase = "https://example.test/games/a%22&amp;b&#39;/";
  generate(base);
  const index = fs.readFileSync(path.join(out,"index.html"),"utf8");
  const playLink = /id="play" href="([^"]+)"/.exec(index)[1];
  const pageURL = new URL(playLink,base);
  const shareFunction = /function shareText\(\) \{[\s\S]*?\n\}/.exec(source)[0];
  const share = new Function("window","report","RULES","seedText","result",shareFunction + "\nreturn shareText();");
  const challenge = new URL(share({location:pageURL},function () { return ""; },2,"ABC",{score:123,closed:4}).trim());
  assert.equal(challenge.href,pageURL.href + "#v=1&r=2&s=ABC&t=123&c=4");
  const play = fs.readFileSync(path.join(out,path.posix.basename(challenge.pathname)),"utf8");
  for (const [html, page] of [[play,"play.html"],[index,""]]) {
    const head = /<head>([\s\S]*?)<\/head>/.exec(html)[1];
    assert.equal((head.match(/<title>/g) || []).length,1);
    assert.ok(head.includes("<title>Slop Cannon Fodder</title>"));
    assert.ok(head.includes(`<link rel="canonical" href="${escapedBase}${page}">`));
    for (const [attr, key, value] of [
      ["name","description","How long can you keep production alive? A unicorn arena shooter in 13 KB."],
      ["property","og:type","website"],
      ["property","og:title","Slop Cannon Fodder"],
      ["property","og:description","How long can you keep production alive?"],
      ["property","og:url",escapedBase + page],
      ["property","og:image",escapedBase + "preview.png"],
      ["property","og:image:width","1200"],
      ["property","og:image:height","630"],
      ["property","og:image:alt","Pink on-call unicorn defending a pixel arena"],
      ["name","twitter:card","summary_large_image"],
      ["name","twitter:title","Slop Cannon Fodder"],
      ["name","twitter:description","How long can you keep production alive?"],
      ["name","twitter:image",escapedBase + "preview.png"]
    ]) assert.ok(head.includes(`<meta ${attr}="${key}" content="${value}">`),`${page || "index.html"}: ${key}`);
    assert.doesNotMatch(html,/analytics|fetch\(|sendBeacon|<script[^>]+src=/);
  }
  assert.deepEqual(fs.readFileSync(path.join(out,"preview.png")),fs.readFileSync(path.join(__dirname,"..","assets","preview.png")));
  assert.equal(play.slice(play.indexOf("</head>")),standalone.slice(standalone.indexOf("</head>")));
  assert.equal(fs.readFileSync(build.OUT,"utf8"),standalone);
  assert.equal(fs.readFileSync(build.SRC,"utf8"),source);
  assert.deepEqual(build.externalRefs(standalone),[]);
  assert.doesNotMatch(standalone,/og:image|twitter:|rel="canonical"|example\.test/);
  assert.ok(zlib.gzipSync(standalone,{level:9}).length <= build.BUDGET);
});
