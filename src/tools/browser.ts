import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

/** The model reads untrusted page content, and that content can tell it to
 *  fetch things. Loopback, private ranges and cloud metadata stay unreachable. */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0") return true;
  if (h === "169.254.169.254" || h === "metadata.google.internal") return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h === "::1") return true;
  return false;
}

/**
 * The network-layer guard shared by every page.
 *
 * Two jobs in one place: drop the bytes that never become text (images,
 * media, fonts), and refuse any request to a local or internal host. The host
 * check belongs here rather than only at navigation time because it fires on
 * every redirect hop and every subresource -- a permitted page that 302s to
 * the cloud-metadata address, or embeds an iframe pointing at it, is stopped
 * before the response is ever received, which URL-checking the navigation
 * target alone cannot do.
 */
function routeGuard(route: any): unknown {
  const req = route.request();
  const type = req.resourceType();
  if (type === "image" || type === "media" || type === "font") return route.abort();
  try {
    if (isBlockedHost(new URL(req.url()).hostname)) return route.abort();
  } catch {
    /* a URL that will not parse cannot resolve to a private host */
  }
  return route.continue();
}

let browserPromise: Promise<any> | null = null;
let available: boolean | null = null;

/** Synchronous check used at registry-build time to decide whether to expose
 *  the tool at all. Resolves the module path without loading the browser. */
export function playwrightAvailable(): boolean {
  if (available !== null) return available;
  if (process.env.ENIO_DISABLE_BROWSER === "1") {
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
/** The rendered HTML and the status that came with it. The status is returned
 *  rather than acted on: whether a 404's body is worth reading is the caller's
 *  decision, not the renderer's. */
export interface RenderedPage {
  html: string;
  status: number;
}

export async function renderPage(
  url: string,
  opts: RenderOptions = {},
): Promise<RenderedPage> {
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

    await page.route("**/*", routeGuard);

    const timeout = opts.timeoutMs ?? config.browserTimeoutMs;
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    // Returned alongside the HTML rather than acted on here: this function's
    // job is to render, and whether a 404's body is worth anything is the
    // caller's call.
    const status: number = response?.status?.() ?? 0;

    if (opts.waitFor) {
      // A missing selector shouldn't lose the page we already have.
      await page.waitForSelector(opts.waitFor, { timeout: 8000 }).catch(() => {});
    } else {
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    }

    return { html: (await page.content()) as string, status };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * One page, kept open, so navigation is a path rather than a series of
 * unrelated visits.
 *
 * renderPage deliberately throws its context away each call — a stateless
 * fetch should carry nothing between URLs. This is the opposite: cookies,
 * redirects and whatever a site set on the way in all persist, which is what
 * makes "search, open the third result, follow its docs link" one journey.
 *
 * It is also the seam an authenticated browser would grow from: a context
 * that survives is a context that could have been logged into. Nothing here
 * does that yet, and nothing here should until mutations go through the
 * approval sheet.
 */
/**
 * One profile, one tab per conversation.
 *
 * The shape a browser already has, and the reason is that both halves are
 * load-bearing. The *context* is shared, so cookies and logins are one
 * identity across the app -- which is what stage three needs, since being
 * logged in once should not mean logged in only in the conversation where you
 * did it. The *page* is per conversation, because two conversations browsing
 * at once would otherwise navigate the same tab and read each other's pages:
 * A calls goto, B calls goto, A reads B's result.
 *
 * Tabs are capped and evicted oldest-first. A page holds a live renderer, so
 * an unbounded map of them is an unbounded memory leak, and a conversation
 * nobody has touched in a while is the cheapest one to lose -- the next call
 * simply opens a fresh tab.
 */
const MAX_TABS = 6;
const tabs = new Map<string, Promise<any>>();
let contextPromise: Promise<any> | null = null;

/**
 * Where the shared context's cookies and localStorage live between runs.
 *
 * A storage-state file rather than launchPersistentContext, for two reasons.
 * A persistent context is a second Chromium beside the one renderPage's
 * throwaway contexts come from — double the memory for the same pages — and
 * its profile directory takes an exclusive lock, so the CLI login flow and a
 * running agent would fight over it. A JSON file has neither problem: both
 * sides read it at context creation and write it after changes, last writer
 * wins, and a stateless renderPage stays stateless because it simply never
 * loads the file.
 */
export function browserStatePath(): string {
  return join(config.dataDir, "browser-state.json");
}

/**
 * The storageState to give a new context: the saved file when it exists and
 * parses, nothing otherwise. Corrupt or missing state must cost at most a
 * login — never the browser.
 */
export function storageStateArg(): string | undefined {
  if (!config.browserPersist) return undefined;
  const path = browserStatePath();
  if (!existsSync(path)) return undefined;
  try {
    JSON.parse(readFileSync(path, "utf8"));
    return path;
  } catch {
    return undefined;
  }
}

async function writeState(context: any): Promise<void> {
  const path = browserStatePath();
  mkdirSync(dirname(path), { recursive: true });
  await context.storageState({ path });
  // Cookies are credentials. Owner-only, like a private key.
  chmodSync(path, 0o600);
}

let persisting: Promise<void> | null = null;

/**
 * Save the shared context's cookies and localStorage to disk, fire-and-forget.
 *
 * Called after every page the session browser settles on, because there is no
 * "cookies changed" event to subscribe to and a process can die without
 * warning. Coalesced so a burst of reads is one write, and errors are
 * swallowed: losing a save costs a login, and must never cost the turn.
 */
export async function persistBrowserState(): Promise<void> {
  if (!config.browserPersist || !contextPromise) return;
  if (persisting) return persisting;
  persisting = (async () => {
    try {
      await writeState(await contextPromise);
    } catch {
      /* losing a save costs a login, never a turn */
    } finally {
      persisting = null;
    }
  })();
  return persisting;
}

async function getContext(): Promise<any> {
  if (!contextPromise) {
    contextPromise = (async () => {
      const browser = await getBrowser();
      return browser.newContext({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        viewport: { width: 1280, height: 900 },
        // Yesterday's logins, if any were saved. undefined means fresh.
        storageState: storageStateArg(),
      });
    })();
  }
  return contextPromise;
}

/**
 * A visible window for the user to log in — the only path by which the agent's
 * browser acquires credentials.
 *
 * Chosen over importing cookies from the user's daily browser, which would
 * mean decrypting Chrome's cookie store via the keychain: invasive, fragile,
 * and it hands the agent every login the user has rather than the one they
 * chose. Here the user types their password into a page they navigated to, in
 * a window they control; enio never sees the password, only the cookies the
 * site set, and only for sites the user deliberately logged into this way.
 *
 * No route guard and no image-blocking in this window: those defend against
 * model-driven requests, and here the human is driving — logging into a router
 * on 192.168.1.1 is legitimate when it is the user doing it. The *agent's*
 * pages still refuse blocked hosts, cookies or not.
 *
 * Saved on a heartbeat while the window is open, because the flow ends with
 * the user closing the window — and once Chromium is gone there is nothing
 * left to ask for its cookies.
 */
export async function loginBrowser(url: string): Promise<void> {
  const specifier = "playwright";
  const { chromium } = (await import(specifier)) as any;
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: storageStateArg(),
    viewport: null,
  });
  const page = await context.newPage();
  await page
    .goto(url, { waitUntil: "domcontentloaded", timeout: config.browserTimeoutMs })
    .catch(() => {});

  const save = () => writeState(context).catch(() => {});
  const timer = setInterval(save, 2000);
  await new Promise<void>((resolve) => {
    page.on("close", () => resolve());
    context.on("close", () => resolve());
  });
  clearInterval(timer);
  await save();
  await browser.close().catch(() => {});
}

export async function getSession(key = "default"): Promise<any> {
  const existing = tabs.get(key);
  if (existing) {
    // Re-inserted so Map iteration order stays least-recently-used first.
    tabs.delete(key);
    tabs.set(key, existing);
    return existing;
  }

  const created = (async () => {
    const context = await getContext();
    const page = await context.newPage();
    await page.route("**/*", routeGuard);
    return page;
  })();
  tabs.set(key, created);

  while (tabs.size > MAX_TABS) {
    const [oldestKey, oldest] = tabs.entries().next().value as [string, Promise<any>];
    tabs.delete(oldestKey);
    oldest.then((p) => p.close()).catch(() => {});
  }
  return created;
}

/** Forget one conversation's tab, so a discarded thread does not hold a
 *  renderer open for the life of the process. */
export async function closeSession(key: string): Promise<void> {
  const page = tabs.get(key);
  if (!page) return;
  tabs.delete(key);
  await page.then((p) => p.close()).catch(() => {});
}

/** Chromium lingers as a child process otherwise. */
export async function closeBrowser(): Promise<void> {
  // A last save before the context goes away — the in-flight one may have
  // been coalesced past whatever the final page set.
  await persistBrowserState().catch(() => {});
  tabs.clear();
  contextPromise = null;
  if (!browserPromise) return;
  try {
    const browser = await browserPromise;
    await browser.close();
  } catch {
    /* already gone */
  }
  browserPromise = null;
}
