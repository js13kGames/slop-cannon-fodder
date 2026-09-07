/* Run with Playwright's browser_run_code_unsafe (filename) while the repository
   is served on localhost:8765. Uses the game's actual renderer, not stock art. */
async function renderAssets(page) {
  await page.goto("http://127.0.0.1:8765/src/index.html");
  const images = await page.evaluate(function () {
    startGame("ONCALL");
    state = "pause";
    clock = 8; banner = 0; shake = 0;
    player.x = 248; player.y = 145; player.aim = -.2;
    for (let kind = 0; kind < 4; kind++) {
      spawnEnemy(kind);
      enemies[enemies.length - 1].born = 0;
    }
    state = "play"; draw(); state = "pause";
    const image = document.createElement("canvas");
    image.width = 1200; image.height = 630;
    const paint = image.getContext("2d");
    paint.imageSmoothingEnabled = false;
    paint.drawImage(cv,0,0,1200,630);
    paint.fillStyle = "#0d0d18e8"; paint.fillRect(0,0,1200,168);
    paint.fillStyle = "#ff8ad2"; paint.font = "bold 58px monospace";
    paint.fillText("SLOP CANNON FODDER",42,76);
    paint.fillStyle = "#ffd9f2"; paint.font = "26px monospace";
    paint.fillText("How long can you keep production alive?",42,125);
    paint.fillStyle = "#0d0d18e8"; paint.fillRect(0,558,1200,72);
    paint.fillStyle = "#7ee0a0"; paint.font = "24px monospace";
    paint.fillText("ONE UNICORN. ZERO DEPENDENCIES. UNDER 13 KB.",42,604);
    /* Enlarge the same pixel unicorn over the arena without changing game state. */
    ctx.save(); ctx.clearRect(0,0,480,270);
    drawUnicorn({x:24,y:28,walk:0,face:1,aim:-.2,inv:0,recoil:0,muzzle:0});
    ctx.restore();
    paint.drawImage(cv,5,4,42,38,478,262,210,190);
    const preview = image.toDataURL("image/png");
    state = "play"; score = 1250; kills = 42; closedWaves = 4; wave = 5;
    upgrades = ["Overclock","Runner"]; player.hp = 1; hurtPlayer(12,"OWN HOTFIX");
    shake = 0; hitFlash = 0; draw();
    return {preview:preview,report:reportCanvas().toDataURL("image/png")};
  });
  for (const kind of ["preview","report"]) {
    const download = page.waitForEvent("download");
    await page.evaluate(function (data) {
      const link = document.createElement("a");
      link.href = data; link.download = "image.png"; link.click();
    },images[kind]);
    await (await download).saveAs(kind === "preview" ? "assets/preview.png" : "assets/incident-example.png");
  }
  return {preview:"assets/preview.png",report:"assets/incident-example.png"};
}
