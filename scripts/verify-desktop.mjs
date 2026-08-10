#!/usr/bin/env node
/**
 * Try the accessibility tier against a real machine.
 *
 * CLAUDE.md's rule for these scripts is that they are run somewhere real before
 * being trusted, never written to look correct. osacompile in the test suite
 * proves only that a script parses; whether "entire contents of window 1"
 * actually finds the Save button is a question no offline test can answer.
 * This is that check, made repeatable.
 *
 *   node scripts/verify-desktop.mjs                 # read-only, uses Finder
 *   node scripts/verify-desktop.mjs TextEdit        # read-only, another app
 *   ENIO_DESKTOP=1 node scripts/verify-desktop.mjs TextEdit --menu "File > New"
 *   ENIO_DESKTOP=1 node scripts/verify-desktop.mjs Finder --click "Save"
 *
 * Reading needs only Accessibility permission. Acting additionally needs
 * ENIO_DESKTOP=1, exactly as in the running agent -- the point is to exercise
 * the real gates, not to route around them.
 *
 * Uses a throwaway database, so a verification run never leaves proposals in
 * ~/.enio.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) {
    flags[argv[i].slice(2)] = argv[++i] ?? "";
  } else {
    positional.push(argv[i]);
  }
}
const app = positional[0] ?? "Finder";
const wantClick = flags.click;
const wantMenu = flags.menu;

const scratch = mkdtempSync(join(tmpdir(), "enio-verify-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "workspace");

const rule = (title) => console.log(`\n\x1b[1m${title}\x1b[0m\n${"─".repeat(64)}`);
const short = (text, lines = 12) => {
  const all = String(text).split("\n");
  return all.length <= lines
    ? String(text)
    : `${all.slice(0, lines).join("\n")}\n… and ${all.length - lines} more`;
};

async function main() {
  const { probeAssistiveAccess } = await import("../dist/tools/ax.js");
  const { desktopTools } = await import("../dist/tools/desktop.js");
  const { approvePlan, getPlan } = await import("../dist/plans.js");

  const recipe = desktopTools.find((t) => t.name === "mac_recipe");
  const propose = desktopTools.find((t) => t.name === "propose_plan");
  if (!recipe) {
    console.log("mac_recipe is not available — this is macOS only.");
    return 1;
  }

  rule("1. Accessibility permission");
  if (!(await probeAssistiveAccess())) {
    console.log(
      "NOT granted.\n\n" +
        "System Settings → Privacy & Security → Accessibility, then add whatever is\n" +
        "running this: your terminal for this script, Enio.app for the desktop app.\n" +
        "If it is already listed, toggle it off and on — a stale grant looks exactly\n" +
        "like no grant at all.\n\n" +
        "Until then the reads below stay withheld rather than being offered and failing.",
    );
    return 1;
  }
  console.log("granted — the accessibility tree can be read");

  rule("2. running_apps");
  console.log(short(await recipe.run({ recipe: "running_apps" }), 4));

  rule(`3. window_controls — ${app}`);
  console.log(short(await recipe.run({ recipe: "window_controls", app })));

  rule(`4. menu_items — ${app}`);
  console.log(short(await recipe.run({ recipe: "menu_items", app })));

  if (!propose) {
    rule("5. acting");
    console.log("propose_plan is withheld. Re-run with ENIO_DESKTOP=1 to exercise it.");
    return 0;
  }

  if (!wantClick && !wantMenu) {
    rule("5. what a click would run (nothing is clicked)");
    const out = await propose.run({
      summary: "Verification: the script a click compiles to",
      app,
      steps: [{ summary: "click Save", click: "Save" }],
    });
    console.log(
      typeof out === "string" ? out : out.widget.steps.map((s) => s.script).join("\n\n"),
    );
    console.log(
      `\nTo actually run one:\n` +
        `  ENIO_DESKTOP=1 node scripts/verify-desktop.mjs ${app} --menu "File > New"`,
    );
    return 0;
  }

  rule("5. proposing, then approving, a real action");
  const step = wantMenu
    ? { summary: `menu ${wantMenu}`, menu: wantMenu }
    : { summary: `click ${wantClick}`, click: wantClick };

  const proposed = await propose.run({ summary: "Verification action", app, steps: [step] });
  if (typeof proposed === "string") {
    console.log(proposed);
    return 1;
  }

  console.log(`${proposed.widget.steps[0].script}\n\nrunning it now…\n`);
  const outcome = await approvePlan(getPlan(proposed.widget.id));
  console.log(`status: ${outcome.status}\n${outcome.output}`);
  return outcome.status === "failed" ? 1 : 0;
}

// Cleanup deliberately sits outside the run: process.exit() skips finally
// blocks, so an exit inside main() would leak the scratch directory.
let code = 1;
try {
  code = await main();
} catch (err) {
  console.error(`\nverification threw: ${err?.stack ?? err}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(code);
