import { readFileSync, writeFileSync } from "node:fs";
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
