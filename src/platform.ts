import { arch, platform } from "node:os";

/**
 * Platform differences, in one place.
 *
 * The split that matters: the *agent* is portable — Node, SQLite, ONNX
 * embeddings, Playwright and MCP all run everywhere. The *Maple runtime* is not,
 * because MLX is Apple-only and always will be.
 *
 * So enio runs anywhere; Maple requires Apple Silicon. Everywhere else the model
 * comes from Ollama or another OpenAI-compatible server, and nothing above the
 * model layer changes.
 */

export type PlatformId = "macos-arm64" | "macos-intel" | "linux" | "windows" | "unknown";

export function detectPlatform(): PlatformId {
  const os = platform();
  if (os === "darwin") return arch() === "arm64" ? "macos-arm64" : "macos-intel";
  if (os === "linux") return "linux";
  if (os === "win32") return "windows";
  return "unknown";
}

export const isWindows = () => platform() === "win32";

/** MLX requires Apple Silicon. Nothing else can run the Maple runtime locally. */
export function canRunMaple(id: PlatformId = detectPlatform()): boolean {
  return id === "macos-arm64";
}

/**
 * Defaulting to the Maple backend on a machine that cannot run it produces a
 * confusing connection error on first use. Everywhere else, Ollama is the
 * overwhelmingly likely local server, so that's the better default — and an
 * explicit ENIO_BACKEND always wins over this.
 */
export function defaultBackendId(id: PlatformId = detectPlatform()): string {
  return canRunMaple(id) ? "maple" : "ollama";
}

/**
 * The shell to run tool commands through.
 *
 * POSIX gets bash. Windows gets cmd via ComSpec — PowerShell would be the nicer
 * shell, but its quoting rules differ enough from POSIX that the model's
 * commands would break in ways it can't diagnose, and cmd is closer to what a
 * model trained mostly on POSIX shell expects to work.
 */
export function shellFor(command: string): { file: string; args: string[] } {
  if (isWindows()) {
    return { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  return { file: "bash", args: ["-c", command] };
}

/** Windows has no coreutils; these are the rough equivalents. */
export const WINDOWS_COMMANDS = [
  "dir", "type", "findstr", "where", "more", "cd", "copy", "move",
  "del", "mkdir", "rmdir", "tree", "powershell", "pwsh",
];

export function platformLabel(id: PlatformId = detectPlatform()): string {
  switch (id) {
    case "macos-arm64": return "macOS (Apple Silicon)";
    case "macos-intel": return "macOS (Intel)";
    case "linux": return "Linux";
    case "windows": return "Windows";
    default: return "unknown platform";
  }
}

/** Explains, in one sentence, why the local Maple runtime isn't an option here. */
export function whyNoMaple(id: PlatformId = detectPlatform()): string {
  switch (id) {
    case "macos-intel":
      return "Maple runs through MLX, which needs Apple Silicon — this Mac is Intel.";
    case "linux":
      return "Maple runs through MLX, which is macOS-only.";
    case "windows":
      return "Maple runs through MLX, which is macOS-only.";
    default:
      return "Maple runs through MLX, which needs Apple Silicon.";
  }
}
