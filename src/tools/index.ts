import { config } from "../config.js";
import type { ToolDef } from "../types.js";
import { fsTools } from "./fs.js";
import { shellTools } from "./shell.js";
import { buildWebTools } from "./web.js";
import { memoryTools } from "./memory.js";
import { skillTools } from "./skills.js";
import { visionTools } from "./vision.js";
import { loadMcpTools } from "./mcp.js";

export interface Registry {
  all: ToolDef[];
  byName: Map<string, ToolDef>;
  dropped: string[];
}

/**
 * Assembles the tool set. Built-ins come first and MCP tools fill the remaining
 * budget, because the built-ins are the ones the system prompt is written around
 * and losing them silently would be worse than losing an MCP tool.
 */
export async function buildRegistry(
  onLog: (msg: string) => void = () => {},
): Promise<Registry> {
  const builtins: ToolDef[] = [
    ...skillTools,
    ...memoryTools,
    ...fsTools,
    ...visionTools,
    ...shellTools,
    ...buildWebTools(),
  ];
  const mcp = await loadMcpTools(onLog);

  const combined: ToolDef[] = [];
  const seen = new Set<string>();
  const dropped: string[] = [];

  for (const tool of [...builtins, ...mcp]) {
    if (seen.has(tool.name)) {
      dropped.push(`${tool.name} (duplicate name)`);
      continue;
    }
    if (combined.length >= config.maxExposedTools) {
      dropped.push(tool.name);
      continue;
    }
    seen.add(tool.name);
    combined.push(tool);
  }

  if (dropped.length > 0) {
    onLog(
      `[tools] ${combined.length} exposed, ${dropped.length} withheld to stay under ` +
        `the ${config.maxExposedTools}-tool budget: ${dropped.join(", ")}`,
    );
    onLog(
      `[tools] Raise ENIO_MAX_TOOLS, or add a "tools" allowlist per server in mcp.json.`,
    );
  }

  return {
    all: combined,
    byName: new Map(combined.map((t) => [t.name, t])),
    dropped,
  };
}
