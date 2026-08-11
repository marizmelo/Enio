import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Browser state persistence: the file that makes "logged in once" survive a
 * restart. The quiet failure this guards against is a corrupt state file — it
 * would otherwise throw inside newContext, which presents as "the browser is
 * broken" with the actual cause a truncated JSON write ago.
 */
const scratch = mkdtempSync(join(tmpdir(), "enio-browser-state-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
mkdirSync(process.env.ENIO_DATA_DIR, { recursive: true });

const { browserStatePath, storageStateArg, persistBrowserState, getSession, closeBrowser, playwrightAvailable } =
  await import("./tools/browser.js");

after(async () => {
  await closeBrowser();
  rmSync(scratch, { recursive: true, force: true });
});

describe("browser state on disk", () => {
  test("no file means a fresh context, not an error", () => {
    assert.equal(storageStateArg(), undefined);
  });

  test("a corrupt file is ignored rather than fatal", () => {
    // Half-written JSON must cost at most a login: newContext would throw on
    // it, and a browser that cannot open is a far worse trade than a cookie
    // jar that starts over.
    writeFileSync(browserStatePath(), "{ half a save");
    assert.equal(storageStateArg(), undefined);
    rmSync(browserStatePath());
  });

  test("a valid file is offered to the context", () => {
    writeFileSync(browserStatePath(), JSON.stringify({ cookies: [], origins: [] }));
    assert.equal(storageStateArg(), browserStatePath());
    rmSync(browserStatePath());
  });

  test(
    "a session cookie round-trips to disk, owner-readable only",
    { skip: !playwrightAvailable() },
    async () => {
      // The one test that launches Chromium — offline throughout: the cookie
      // is planted directly on the context, no page is ever loaded.
      const page = await getSession("state-test");
      await page.context().addCookies([
        { name: "enio_probe", value: "kept", domain: "example.com", path: "/" },
      ]);
      await persistBrowserState();

      assert.ok(existsSync(browserStatePath()), "state file was not written");
      const saved = JSON.parse(readFileSync(browserStatePath(), "utf8"));
      assert.ok(
        saved.cookies?.some((c: any) => c.name === "enio_probe" && c.value === "kept"),
        "the cookie did not survive the save",
      );
      // Cookies are credentials; the file must be private to the owner.
      assert.equal(statSync(browserStatePath()).mode & 0o777, 0o600);
      // And what was saved is what a fresh context would be offered.
      assert.equal(storageStateArg(), browserStatePath());
    },
  );
});
