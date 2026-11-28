import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { anyBrowser, browsersNamed, chooseBrowser, isBrowser, saysBrowser } from "./browsers.js";

const INSTALLED = ["Google Chrome", "Safari", "Firefox", "Notes", "Chrome Remote Desktop Host Uninstaller"];
const choose = (asked: string, message: string | null, running: string[] = [], dflt: string | null = "Google Chrome") =>
  chooseBrowser({ asked, message, running, installed: INSTALLED, dflt });

describe("which browser is the browser", () => {
  test("the words that mean a browser, and the ones that name one", () => {
    for (const word of ["browser", "the browser", "my browser", "web browser", "default browser", "my web browser"]) {
      assert.equal(anyBrowser(word), true, word);
    }
    for (const word of ["Safari", "Chrome", "browser tab", "Notes"]) assert.equal(anyBrowser(word), false, word);
    assert.equal(isBrowser("safari"), true);
    assert.equal(isBrowser("Notes"), false);
    assert.equal(saysBrowser("check my email on browser and give me a summary"), true);
    assert.deepEqual(browsersNamed("try again on chrome"), ["Google Chrome"]);
    assert.deepEqual(browsersNamed("open it in Safari or Firefox"), ["Safari", "Firefox"]);
    // Another program's name is not the browser being named.
    assert.deepEqual(browsersNamed("is chrome remote desktop still installed?"), []);
    assert.deepEqual(browsersNamed("check my email"), []);
    // Six browsers are named with ordinary words, and those count only
    // where a browser is being spoken of.
    for (const plain of [
      "be brave and open my inbox",
      "move it to the left edge of the screen",
      "the story arc is weak",
      "book the opera tickets",
      "a zen garden",
      "where is orion tonight",
    ]) {
      assert.deepEqual(browsersNamed(plain), [], plain);
    }
    assert.deepEqual(browsersNamed("open it in brave"), ["Brave Browser"]);
    assert.deepEqual(browsersNamed("try again on edge"), ["Microsoft Edge"]);
    assert.deepEqual(browsersNamed("use arc"), ["Arc"]);
    assert.deepEqual(browsersNamed("the zen browser"), ["Zen"]);
    assert.deepEqual(browsersNamed("is microsoft edge installed"), ["Microsoft Edge"]);
  });

  test("the person said 'browser': theirs, not the model's pick", () => {
    // The turn this was written for. The model asked for Safari; the
    // default browser was Chrome and nothing was open.
    const message = "check my email on browser and see last 5 unread messages and give me a summary";
    assert.deepEqual(choose("Safari", message), { name: "Google Chrome", why: "your default browser" });
    // One browser already open is the one they mean, default or not.
    assert.deepEqual(choose("Safari", message, ["Firefox", "Notes"]), { name: "Firefox", why: "the browser you have open" });
    assert.deepEqual(choose("browser", message, ["Safari"]), { name: "Safari", why: "the browser you have open" });
    // Several open: the default, when it is one of them; else a question.
    assert.deepEqual(choose("Safari", message, ["Safari", "Google Chrome"]), { name: "Google Chrome", why: "your default browser, which is open" });
    const asks = choose("Safari", message, ["Safari", "Firefox"]);
    assert.equal(asks.name, null);
    assert.match(asks.why, /Safari and Firefox are both open\. Which one/);
    // No default to be had and nothing open: asked, not guessed.
    assert.equal(choose("browser", message, [], null).name, null);
  });

  test("the person named one: that one, whatever the model asked for", () => {
    assert.deepEqual(choose("Safari", "try again on chrome"), { name: "Google Chrome", why: "the browser you named" });
    assert.deepEqual(choose("Chrome", "open chrome"), { name: "Google Chrome", why: "the browser you named" });
    assert.deepEqual(choose("Safari", "open safari", ["Google Chrome"]), { name: "Safari", why: "" });
    // Two named, and the model's is one of them.
    assert.deepEqual(choose("Firefox", "compare the page in safari and firefox"), { name: "Firefox", why: "" });
    // A browser they named that is not on this machine names nothing.
    assert.deepEqual(choose("Safari", "open it in brave"), { name: "Safari", why: "" });
    // A default browser this list has never heard of is still a browser,
    // and is matched to the running list whatever the case.
    assert.deepEqual(
      chooseBrowser({ asked: "browser", message: "open the browser", running: ["dia", "Safari"], installed: [...INSTALLED, "Dia"], dflt: "Dia" }),
      { name: "Dia", why: "your default browser, which is open" },
    );
    // The running list is the system's spelling, whatever its case.
    assert.deepEqual(
      chooseBrowser({ asked: "browser", message: "open the browser", running: ["firefox"], installed: INSTALLED, dflt: "Google Chrome" }),
      { name: "firefox", why: "the browser you have open" },
    );
  });

  test("nothing in their words about a browser: the model's pick stands", () => {
    // A skill or a plan may say Safari for a reason; only the person's own
    // word "browser" or another browser's name overrides it.
    assert.deepEqual(choose("Safari", "what's on apple.com today?"), { name: "Safari", why: "" });
    // No message at all: an automation step, a tool run outside a turn.
    assert.deepEqual(choose("Safari", null), { name: "Safari", why: "" });
    // But a generic word still needs an answer, message or not.
    assert.deepEqual(choose("browser", null), { name: "Google Chrome", why: "your default browser" });
    assert.deepEqual(choose("the browser", "open the browser for me"), { name: "Google Chrome", why: "your default browser" });
  });
});
