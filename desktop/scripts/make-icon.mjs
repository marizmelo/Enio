#!/usr/bin/env node
/**
 * Build the app icon from assets/enio-logo.svg.
 *
 * Run with Electron, not node:
 *   npx electron scripts/make-icon.mjs
 *
 * Electron is the rasteriser because it is already a dependency and it is the
 * only one here that renders SVG with a real alpha channel. qlmanage flattens
 * onto white — which is what put square white corners on the first icon — and
 * rsvg-convert, ImageMagick, Inkscape and cairosvg are all absent.
 *
 * The mark is the icon, with nothing behind it. That looked risky — it is
 * two-tone, five black paths and four white, so the obvious worry is that half
 * of it disappears depending on what is behind the dock. It does not: the white
 * faces are outlined in black and the black faces read as shadow, so the
 * silhouette survives on both. Checked at 128px against white and against
 * #1c1e24 before choosing it, because that is the size an icon is read at.
 *
 * `--card` puts it back on a rounded square if that ever stops being true.
 */
import { app, BrowserWindow } from "electron";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, "..", "assets");

const SIZE = 1024;
const INSET = 100; // macOS artwork sits inside ~824 of 1024
const RADIUS = 185;
const MARK_HEIGHT = 0.46; // of the full canvas, so the mark breathes

/** `npm run icon -- --card` renders the mark on a rounded square instead. */
const BARE = !process.argv.includes("--card");
const MARK_HEIGHT_BARE = 0.8; // no card to sit inside, so it can fill more

const svg = readFileSync(join(assets, "enio-logo.svg"), "utf8");

const page = BARE
  ? `
<style>
  html, body { margin: 0; background: transparent; }
  #card {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
  }
  #card svg { height: ${Math.round(SIZE * MARK_HEIGHT_BARE)}px; width: auto; display: block; }
</style>
<div id="card">${svg}</div>
`
  : `
<style>
  html, body { margin: 0; background: transparent; }
  #card {
    position: absolute;
    left: ${INSET}px; top: ${INSET}px;
    width: ${SIZE - INSET * 2}px; height: ${SIZE - INSET * 2}px;
    border-radius: ${RADIUS}px;
    background: linear-gradient(160deg, #2b3240 0%, #12151c 100%);
    display: flex; align-items: center; justify-content: center;
  }
  /* Height-driven so the tall mark keeps its proportions whatever it is. */
  #card svg { height: ${Math.round(SIZE * MARK_HEIGHT)}px; width: auto; display: block; }
</style>
<div id="card">${svg}</div>
`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    // Transparent so the corners outside the rounded square stay empty rather
    // than picking up a background colour.
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: { offscreen: true },
  });

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  // One frame to settle: capturing immediately can catch the page before the
  // gradient and the SVG have painted.
  await new Promise((r) => setTimeout(r, 400));

  const image = await win.webContents.capturePage();
  writeFileSync(join(assets, "icon.png"), image.toPNG());

  console.log(`wrote icon.png at ${SIZE}x${SIZE}`);

  // The .icns is what a packaged build ships and what Finder shows. Built here
  // rather than by hand so the two can never drift: every size comes from the
  // PNG that was just rendered.
  const iconset = join(mkdtempSync(join(tmpdir(), "enio-icon-")), "icon.iconset");
  execFileSync("/bin/mkdir", ["-p", iconset]);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const [suffix, px] of [["", size], ["@2x", size * 2]]) {
      execFileSync("/usr/bin/sips", [
        "-z", String(px), String(px),
        join(assets, "icon.png"),
        "--out", join(iconset, `icon_${size}x${size}${suffix}.png`),
      ], { stdio: "ignore" });
    }
  }
  execFileSync("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", join(assets, "icon.icns")]);
  rmSync(dirname(iconset), { recursive: true, force: true });
  console.log("wrote icon.icns");

  app.exit(0);
});
