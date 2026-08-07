import { createRequire } from "node:module";
import { config } from "../config.js";

/**
 * Headless Chromium via Playwright, used only for pages that need JavaScript.
 *
 * Playwright is an OPTIONAL dependency. It pulls ~150MB of browser binary, and
 * most fetches never need it, so installing it is opt-in:
 *
 *     npm install playwright && npx playwright install chromium
 *
 * Everything here degrades to "tool not offered" when it's absent, rather than
 * failing at call time — exposing a tool that always errors just burns the
 * model's limited attention on a dead end.
 */

let browserPromise: Promise<any> | null = null;
let available: boolean | null = null;

/** Synchronous check used at registry-build time to decide whether to expose
 *  the tool at all. Resolves the module path without loading the browser. */
export function playwrightAvailable(): boolean {
  if (available !== null) return available;
  if (process.env.MAPLE_DISABLE_BROWSER === "1") {
    available = false;
    return false;
  }
  try {
    // Throws if the package isn't installed; does not launch anything.
    createRequire(import.meta.url).resolve("playwright");
    available = true;
  } catch {
    available = false;
  }
  return available;
}

async function getBrowser(): Promise<any> {
  if (!browserPromise) {
    browserPromise = (async () => {
      // Non-literal specifier on purpose: playwright is an optional dependency,
      // and a literal import() would make tsc demand its types at build time
      // even though the code path never runs without it installed.
      const specifier = "playwright";
      const { chromium } = (await import(specifier)) as any;
      return chromium.launch({ headless: true });
    })();
  }
  return browserPromise;
}

export interface RenderOptions {
  waitFor?: string;
  timeoutMs?: number;
}

/**
 * Loads a page and returns its HTML after scripts have run.
 *
 * Waits for `networkidle` rather than `load`, because SPAs finish loading long
 * before they finish rendering. Resource types that never contribute text —
 * images, fonts, media — are aborted at the network layer, which is a large
 * speedup on heavy pages and costs nothing for our purposes.
 */
export async function renderPage(url: string, opts: RenderOptions = {}): Promise<string> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
    javaScriptEnabled: true,
  });

  try {
    const page = await context.newPage();

    await page.route("**/*", (route: any) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "media" || type === "font") return route.abort();
      return route.continue();
    });

    const timeout = opts.timeoutMs ?? config.browserTimeoutMs;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });

    if (opts.waitFor) {
      // A missing selector shouldn't lose the page we already have.
      await page.waitForSelector(opts.waitFor, { timeout: 8000 }).catch(() => {});
    } else {
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    }

    return (await page.content()) as string;
  } finally {
    await context.close().catch(() => {});
  }
}

/** Chromium lingers as a child process otherwise. */
export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  try {
    const browser = await browserPromise;
    await browser.close();
  } catch {
    /* already gone */
  }
  browserPromise = null;
}
