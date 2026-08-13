import { config } from "../config.js";
import type { ToolDef } from "../types.js";
import { fsTools } from "./fs.js";
import { searchTools } from "./search.js";
import { shellTools } from "./shell.js";
import { buildWebTools } from "./web.js";
import { browseTools } from "./browse.js";
import { memoryTools } from "./memory.js";
import { libraryTools } from "./library.js";
import { skillTools } from "./skills.js";
import { visionTools } from "./vision.js";
import { emailTools } from "./email.js";
import { mailTools } from "./mail.js";
import { buildDesktopTools, recipesEnabled } from "./desktop.js";
import { buildPipelineTools } from "../pipelines.js";
import { probeAssistiveAccess, probeAxBridge } from "./ax.js";
import { timeTools } from "./time.js";
import { weatherTools } from "./weather.js";
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
  // Filled just before returning; the run_pipeline tool dereferences it at
  // call time, when it is guaranteed to be set.
  const registryBox: { value: Registry | null } = { value: null };
  // Asked once, before the descriptions are read: whether macOS will let this
  // process read the accessibility tree decides which recipes mac_recipe
  // offers, and offering one that can only fail wastes the model's attention.
  if (recipesEnabled()) {
    // Both probed together: one decides whether the tree can be read at all,
    // the other which door it is read through.
    const [ax, bridge] = await Promise.all([probeAssistiveAccess(), probeAxBridge()]);
    if (!ax) {
      onLog(
        `[tools] No Accessibility access, so reading windows and clicking by name are ` +
          `withheld. Grant it in System Settings → Privacy & Security → Accessibility.`,
      );
    } else if (!bridge) {
      onLog(
        `[tools] Accessibility bridge unavailable, falling back to AppleScript — ` +
          `apps that hide their windows from System Events will not be clickable. ` +
          `Re-run install.sh to add it.`,
      );
    }
  }

  /**
   * The ceiling protects the *model*, which is why routing changes where it
   * belongs.
   *
   * Past ~16 tool definitions a small model picks at random -- but with
   * routing on it never sees the registry, only one specialist's ≤6. Capping
   * the registry as well meant the two limits stacked: adding open_app pushed
   * the total past 16 and silently truncated the *end* of the list, which is
   * where the web tools live, leaving the researcher with no web access at
   * all. The per-specialist limit is the one that governs a prompt, and there
   * is a test asserting it.
   *
   * Single-agent mode still caps, because there the registry is what the
   * model sees.
   */
  const ceiling = config.routingEnabled
    ? Math.max(config.maxExposedTools, 64)
    : config.maxExposedTools;

  const builtins: ToolDef[] = [
    ...skillTools,
    ...timeTools,
    ...weatherTools,
    ...memoryTools,
    ...fsTools,
    ...visionTools,
    ...emailTools,
    ...mailTools,
    ...buildDesktopTools(),
    // The tool needs the registry the TURN will run with; a getter defers
    // the reference until run() time, sidestepping the chicken-and-egg of
    // registering a tool that itself drives turns.
    ...buildPipelineTools(() => registryBox.value!),
    ...shellTools,
    ...searchTools,
    ...buildWebTools(),
    ...browseTools,
    // Last on purpose: this order is the priority list single-agent mode
    // truncates against, and slotting library_search higher pushed web_search
    // past the 16-tool ceiling -- a silent capability loss the pipelines
    // suite caught as "web-search ability does not exist". Routed mode keeps
    // every tool (the librarian owns this one); an unrouted agent keeps its
    // web reach and loses the library instead.
    ...libraryTools,
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
    if (combined.length >= ceiling) {
      dropped.push(tool.name);
      continue;
    }
    seen.add(tool.name);
    combined.push(tool);
  }

  if (dropped.length > 0) {
    onLog(
      `[tools] ${combined.length} exposed, ${dropped.length} withheld to stay under ` +
        `the ${ceiling}-tool budget: ${dropped.join(", ")}`,
    );
    onLog(
      `[tools] Raise ENIO_MAX_TOOLS, or add a "tools" allowlist per server in mcp.json.`,
    );
  }

  const registry: Registry = {
    all: combined,
    byName: new Map(combined.map((t) => [t.name, t])),
    dropped,
  };
  registryBox.value = registry;
  return registry;
}
