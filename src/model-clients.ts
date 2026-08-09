import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

/**
 * Who is currently relying on the model server.
 *
 * The server is shared on purpose -- a second copy is five gigabytes and a
 * 24GB machine cannot hold two -- so the CLI attaches to whatever the desktop
 * started, and vice versa. What was missing is the other half of sharing:
 * whoever started it also stopped it on exit, which killed the model out from
 * under everyone else. Quitting the desktop while `enio chat` was mid-answer
 * took the CLI's model with it.
 *
 * So ownership is replaced by a count. Every process that needs the model puts
 * its pid here and takes it out on the way out, and the last one to leave is
 * the one that shuts the server down. That also fixes the manual case: a
 * server started by hand with `enio up` is registered like anything else, so
 * an `enio chat` that ends first leaves it alone.
 *
 * Liveness is checked on read rather than cleaned up on write, which is what
 * makes a crash harmless: a pid that no longer exists is ignored and dropped
 * the next time anyone writes. There is no cleanup path to get wrong, because
 * there is no cleanup path.
 */
function registryPath(): string {
  return join(config.dataDir, "model-clients");
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 tests for existence and permission without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function read(): number[] {
  try {
    return readFileSync(registryPath(), "utf8")
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function write(pids: number[]): void {
  try {
    writeFileSync(registryPath(), [...new Set(pids)].join("\n") + "\n");
  } catch {
    // A registry we cannot write degrades to the old behaviour rather than
    // failing a turn. Losing the count is annoying; refusing to start is not
    // acceptable.
  }
}

/** Declare that this process needs the model server. */
export function registerModelClient(pid: number = process.pid): void {
  write([...read().filter(isAlive), pid]);
}

/** Give up the claim. Returns the other live claims that remain. */
export function unregisterModelClient(pid: number = process.pid): number[] {
  const others = read().filter((p) => p !== pid && isAlive(p));
  write(others);
  return others;
}

/** Live claims other than the given pids, without changing anything. */
export function otherModelClients(...ignore: number[]): number[] {
  return read().filter((pid) => !ignore.includes(pid) && isAlive(pid));
}
