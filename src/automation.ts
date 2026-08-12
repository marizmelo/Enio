import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

/**
 * Whether a vouched-for recipe may run without asking again.
 *
 * Two switches, deliberately, because they answer different questions.
 * ENIO_DESKTOP asks *can this act at all*; auto-run asks *may it act without
 * stopping to ask*. Collapsing them would mean turning on the ability to
 * change the machine and the ability to do it unattended in the same gesture,
 * which is exactly the kind of bundled consent this codebase already refused
 * once for reads and writes.
 *
 * The line that matters, and it is not negotiable by any setting: auto-run
 * applies **only to recipes a person explicitly marked safe**. A plan the
 * model has just composed always goes to the approval sheet, however this is
 * set. Auto is a statement about a specific script someone read and vouched
 * for, never about the model's judgement in general.
 *
 * Persisted machine-wide, next to the model choice, for the same reason: a
 * decision about how this machine behaves has to outlive the process that
 * made it, and it is not per-data-directory.
 */

const SETTING_FILE = "automation.json";

export function autoRunEnabled(): boolean {
  const env = process.env.ENIO_AUTO_RUN ?? process.env.MAPLE_AUTO_RUN;
  if (env != null) return env === "1" || env.toLowerCase() === "true";
  try {
    const raw = readFileSync(join(config.machineStateDir, SETTING_FILE), "utf8");
    return (JSON.parse(raw) as { autoRun?: boolean }).autoRun === true;
  } catch {
    // Off is the correct default for a setting that removes a question.
    return false;
  }
}

export function setAutoRun(on: boolean): void {
  writeFileSync(
    join(config.machineStateDir, SETTING_FILE),
    JSON.stringify({ autoRun: on }, null, 2) + "\n",
  );
}

/**
 * Whether desktop control is enabled by a recorded user click, as the
 * user-shaped equivalent of ENIO_DESKTOP=1.
 *
 * The env var is developer UX; the launcher's "Enable desktop control"
 * button writes this instead — one deliberate act, persisted machine-wide
 * like the model choice, still followed by macOS's own per-app Automation
 * and Screen Recording prompts. Consent stays a user act either way; only
 * the shell it requires changed. The env var wins when present, same rule
 * as every other machine setting, so a one-off ENIO_DESKTOP=0 run can
 * force it off without erasing the recorded choice.
 *
 * Deliberately NOT offered for ENIO_BROWSER_ACT: that flag gates a security
 * boundary (a reader immune to a page's instructions becoming clicks in a
 * logged-in session), and lowering it should stay a step harder than one
 * click on the surface the page's own text can talk the user toward.
 */

const DESKTOP_FILE = "desktop-control.json";

export function desktopControlStored(): boolean {
  try {
    const raw = readFileSync(join(config.machineStateDir, DESKTOP_FILE), "utf8");
    return (JSON.parse(raw) as { enabled?: boolean }).enabled === true;
  } catch {
    return false;
  }
}

export function setDesktopControl(on: boolean): void {
  // Self-sufficient on purpose: consent recorded from a fresh client must
  // not depend on anything else having created the directory first.
  mkdirSync(config.machineStateDir, { recursive: true });
  writeFileSync(
    join(config.machineStateDir, DESKTOP_FILE),
    JSON.stringify({ enabled: on }, null, 2) + "\n",
  );
}
