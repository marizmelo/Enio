import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { panelRequest } from "./panels.js";

describe("requests to open a part of the app", () => {
  test("setting up an account opens Accounts on the connect flow", () => {
    for (const t of ["lets setup a new email account", "set up a new email account", "connect my gmail", "add another google account", "I want to connect my email account"]) {
      const r = panelRequest(t);
      assert.equal(r?.panel, "accounts", t);
      assert.equal(r?.view, "add", t);
      assert.match(r!.reply, /whose account it is/);
    }
  });
  test("open <panel> resolves aliases, settings and integrations mean Connections", () => {
    assert.equal(panelRequest("open accounts")?.panel, "accounts");
    assert.equal(panelRequest("open settings")?.panel, "connections");
    assert.equal(panelRequest("show my integrations")?.panel, "connections");
    assert.equal(panelRequest("take me to automations.")?.panel, "automations");
    assert.equal(panelRequest("open the memory panel")?.panel, "memory");
    assert.equal(panelRequest("open models")?.panel, "models");
    assert.equal(panelRequest("add an mcp server")?.panel, "connections");
    assert.equal(panelRequest("add an mcp server")?.view, "add");
  });
  test("a request about something else is not a panel", () => {
    assert.equal(panelRequest("check my email"), null);
    assert.equal(panelRequest("open the readme"), null, "a file, not a panel");
    assert.equal(panelRequest("what projects am I working on"), null);
    assert.equal(panelRequest("my accountant sent the files, open them and summarise the account statements in detail please, all of them from last year"), null, "too long to be a command");
  });
});
