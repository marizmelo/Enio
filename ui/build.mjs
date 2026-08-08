// Builds the enio inspector UI into ui/dist/ as a single JS bundle plus one
// CSS file, using esbuild's JS API. No dev server — the enio Node backend
// serves ui/dist/ as static files.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(__dirname, "dist");

mkdirSync(outdir, { recursive: true });

// Tailwind runs as its own step because esbuild cannot resolve
// `@import "tailwindcss"`. Its output is linked before bundle.css in
// index.html, so the inspector's hand-written rules still win where the two
// overlap.
function runTailwind() {
  const bin = path.join(__dirname, "node_modules", ".bin", "tailwindcss");
  const result = spawnSync(
    bin,
    [
      "--input", path.join(__dirname, "src", "styles", "globals.css"),
      "--output", path.join(outdir, "tailwind.css"),
      "--minify",
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error("Tailwind build failed.");
}

async function run() {
  runTailwind();

  const result = await build({
    entryPoints: [path.join(__dirname, "src", "main.jsx")],
    bundle: true,
    minify: true,
    sourcemap: false,
    target: "es2020",
    format: "iife",
    outfile: path.join(outdir, "bundle.js"),
    loader: {
      ".js": "jsx",
      ".jsx": "jsx",
    },
    jsx: "automatic",
    // shadcn components import through "@/..." -- resolved here, with
    // jsconfig.json mirroring it so editors and the shadcn CLI agree.
    alias: { "@": path.join(__dirname, "src") },
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    metafile: true,
    logLevel: "info",
  });

  // bundle.css is emitted automatically by esbuild because src/main.jsx and
  // src/components/GraphView.jsx import CSS files — no manual copy needed.

  const htmlSrc = path.join(__dirname, "src", "index.html");
  const htmlDest = path.join(outdir, "index.html");
  copyFileSync(htmlSrc, htmlDest);

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
