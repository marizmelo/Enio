import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import type { ServerConfig } from "./tools/mcp.js";

/**
 * The editor for ~/.enio/mcp.json; tools/mcp.ts stays the loader.
 *
 * Edits go through read-modify-write of the WHOLE parsed file, so fields
 * this code does not know about — a future SDK option, a comment key,
 * another client's extension — survive a round-trip untouched. The write is
 * tmp+rename because a half-written config would take every connection down
 * on the next load, which is a worse failure than the edit simply not
 * landing.
 *
 * Only the user reaches this module: authed HTTP routes and the CLI. No
 * tool touches it, so the model can never add itself a server — the same
 * invariant that keeps projects and attachments user-granted. Adding a
 * server does mean its command runs on the next reload; that is identical
 * to hand-editing the file, which is the only way this ever worked.
 */

// Servers become part of wire tool names (server__tool, 64-char cap), so the
// name has to be a safe prefix and short enough to leave room for the tool.
const NAME = /^[a-z0-9][a-z0-9_-]*$/i;
const NAME_MAX = 40;

export function readMcpConfig(): {
  raw: Record<string, unknown>;
  servers: Record<string, ServerConfig>;
} {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(config.mcpConfigPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed;
  } catch {
    // Missing or malformed reads as empty; a malformed file is only ever
    // replaced by an explicit write below, never silently on read.
  }
  const servers = (raw.mcpServers ?? {}) as Record<string, ServerConfig>;
  return { raw, servers };
}

export function writeMcpConfig(raw: Record<string, unknown>): void {
  mkdirSync(dirname(config.mcpConfigPath), { recursive: true });
  const tmp = `${config.mcpConfigPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n");
  renameSync(tmp, config.mcpConfigPath);
}

export function addServer(name: string, cfg: ServerConfig): void {
  const trimmed = name.trim();
  if (!NAME.test(trimmed) || trimmed.length > NAME_MAX) {
    throw new Error(
      `Invalid server name "${trimmed}" — letters, digits, - and _, up to ${NAME_MAX} characters.`,
    );
  }
  if (!cfg.command?.trim()) throw new Error("A server needs a command.");
  const { raw, servers } = readMcpConfig();
  if (servers[trimmed]) {
    throw new Error(`A server named "${trimmed}" already exists.`);
  }
  raw.mcpServers = { ...servers, [trimmed]: cfg };
  writeMcpConfig(raw);
}

export function removeServer(name: string): void {
  const { raw, servers } = readMcpConfig();
  if (!servers[name]) throw new Error(`No server named "${name}".`);
  const next = { ...servers };
  delete next[name];
  raw.mcpServers = next;
  writeMcpConfig(raw);
}

export function setServerDisabled(name: string, disabled: boolean): void {
  const { raw, servers } = readMcpConfig();
  if (!servers[name]) throw new Error(`No server named "${name}".`);
  raw.mcpServers = { ...servers, [name]: { ...servers[name]!, disabled } };
  writeMcpConfig(raw);
}

export function mcpConfigExists(): boolean {
  return existsSync(config.mcpConfigPath);
}
