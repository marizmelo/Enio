// Builds the Electron renderer into renderer/dist/ as one JS bundle plus one
// CSS file. Same shape as ui/build.mjs on purpose: no dev server, no watch, no
// framework CLI. The window loads files off disk, so a bundle is all it needs.
//
// Two steps, because Tailwind v4 scans source files for class names and esbuild
// knows nothing about that. Tailwind runs first and writes plain CSS; esbuild
// then only has to deal with JS.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(__dirname, "renderer", "src");
const outdir = path.join(__dirname, "renderer", "dist");

mkdirSync(outdir, { recursive: true });

function runTailwind() {
  const bin = path.join(__dirname, "node_modules", ".bin", "tailwindcss");
  const result = spawnSync(
    bin,
    [
      "--input", path.join(src, "styles", "globals.css"),
      "--output", path.join(outdir, "styles.css"),
      "--minify",
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error("Tailwind build failed.");
  }
}

async function run() {
  runTailwind();

  const result = await build({
    entryPoints: [path.join(src, "main.jsx")],
    bundle: true,
    minify: true,
    sourcemap: false,
    target: "es2022",
    format: "iife",
    outfile: path.join(outdir, "bundle.js"),
    jsx: "automatic",
    loader: {
      ".js": "jsx",
      ".jsx": "jsx",
      // Text, not dataurl. As a data URI in an <img>, the mark is rasterised
      // at the SVG's own 59x112 and then scaled to fit, which on a 1x display
      // leaves its hairline outlines visibly stepped. Inlined into the DOM it
      // stays vector and is rendered at whatever the display actually is.
      ".svg": "text",
    },
    // shadcn components import through the "@/..." alias its CLI writes. This
    // is the only place that alias is resolved -- jsconfig.json exists solely
    // so editors agree with the bundler.
    alias: { "@": src },
    define: { "process.env.NODE_ENV": '"production"' },
    metafile: true,
    logLevel: "info",
  });

  copyFileSync(path.join(src, "index.html"), path.join(outdir, "index.html"));

  if (result.metafile) {
    for (const [file, info] of Object.entries(result.metafile.outputs)) {
      console.log(`${file}: ${(info.bytes / 1024).toFixed(1)} KiB`);
    }
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
