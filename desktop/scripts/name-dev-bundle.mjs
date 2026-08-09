#!/usr/bin/env node
/**
 * Make an unpackaged `npm start` call itself Enio.
 *
 * macOS takes the dock label, the menu bar title and the force-quit entry from
 * the running bundle's Info.plist — not from anything the app says at runtime.
 * app.setName() and a hand-built menu cannot override it, because the first
 * menu's title is replaced by the bundle name before the app is even asked.
 * Unpackaged, the bundle is Electron's own, so the app is called Electron.
 *
 * Packaged builds have no such problem: electron-builder writes productName
 * into a real bundle. This exists purely so development does not look like a
 * different application.
 *
 * Scoped to this project's node_modules, idempotent, and undone by any
 * reinstall of electron — which is the correct blast radius for renaming
 * someone else's binary.
 */
import { execFileSync } from "node:child_process";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const plist = join(
  here,
  "..",
  "node_modules",
  "electron",
  "dist",
  "Electron.app",
  "Contents",
  "Info.plist",
);

if (process.platform !== "darwin" || !existsSync(plist)) {
  process.exit(0);
}

const read = (key) => {
  try {
    return execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], {
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
};

const set = (key, value) => {
  try {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist]);
  } catch {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, plist]);
  }
};

const macos = join(dirname(plist), "MacOS");
const pathTxt = join(here, "..", "node_modules", "electron", "path.txt");

if (read("CFBundleName") === "Enio" && existsSync(join(macos, "Enio"))) {
  process.exit(0);
}

try {
  set("CFBundleName", "Enio");
  set("CFBundleDisplayName", "Enio");

  // The plist alone is not enough: the dock label falls back to the executable
  // name, which is why this still said Electron with CFBundleName already set.
  // The npm launcher resolves its binary through path.txt, so renaming the
  // executable and rewriting that one line keeps `electron .` working.
  if (existsSync(join(macos, "Electron")) && !existsSync(join(macos, "Enio"))) {
    renameSync(join(macos, "Electron"), join(macos, "Enio"));
  }
  set("CFBundleExecutable", "Enio");
  writeFileSync(pathTxt, "Electron.app/Contents/MacOS/Enio");

  // LaunchServices caches bundle identity, so a rename it has already seen is
  // ignored until the bundle looks new.
  try {
    execFileSync(
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
      ["-f", join(here, "..", "node_modules", "electron", "dist", "Electron.app")],
      { stdio: "ignore" },
    );
  } catch {
    /* Not fatal; the name updates on the next login at worst. */
  }

  console.log("named the dev bundle Enio");
} catch (err) {
  // Cosmetic. A read-only node_modules or a missing PlistBuddy must not stop
  // the app from starting.
  console.log(`could not rename the dev bundle (${err.message})`);
}
