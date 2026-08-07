import { readFile } from "node:fs/promises";
import { config } from "../config.js";
import type { JsonSchema, ToolDef } from "../types.js";

/**
 * MCP client.
 *
 * Config file matches Claude Desktop's shape, so existing server configs can be
 * copied across unchanged, with one addition: an optional per-server `tools`
 * allowlist.
 *
 *   {
 *     "mcpServers": {
 *       "filesystem": {
 *         "command": "npx",
 *         "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/notes"],
 *         "tools": ["read_file", "list_directory"]
 *       }
 *     }
 *   }
 *
 * That allowlist is not a nicety. A typical MCP server exposes 10-30 tools; two
 * or three servers will blow past what a ~1B-active model can choose between,
 * and the failure mode is not an error — it's the model quietly picking wrong
 * tools. Filtering to the handful you actually want is the difference between
 * this working and not.
 */

interface ServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  tools?: string[];
  disabled?: boolean;
}

interface McpFile {
  mcpServers?: Record<string, ServerConfig>;
}

interface Connection {
  name: string;
  close(): Promise<void>;
}

const connections: Connection[] = [];

/** Function names on the wire must match ^[a-zA-Z0-9_-]{1,64}$. */
function wireName(server: string, tool: string): string {
  const clean = `${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  return clean.slice(0, 64);
}

export async function loadMcpTools(
  onLog: (msg: string) => void = () => {},
): Promise<ToolDef[]> {
  let parsed: McpFile;
  try {
    parsed = JSON.parse(await readFile(config.mcpConfigPath, "utf8")) as McpFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      onLog(`[mcp] Could not read ${config.mcpConfigPath}: ${(err as Error).message}`);
    }
    return [];
  }

  const servers = Object.entries(parsed.mcpServers ?? {}).filter(
    ([, cfg]) => !cfg.disabled,
  );
  if (servers.length === 0) return [];

  let Client: any;
  let StdioClientTransport: any;
  try {
    ({ Client } = await import("@modelcontextprotocol/sdk/client/index.js"));
    ({ StdioClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/stdio.js"
    ));
  } catch {
    onLog("[mcp] SDK not installed; skipping MCP servers.");
    return [];
  }

  const tools: ToolDef[] = [];

  // Connect in parallel — a slow server shouldn't hold up the others, and one
  // that fails entirely shouldn't stop the agent from starting.
  await Promise.all(
    servers.map(async ([name, cfg]) => {
      try {
        const transport = new StdioClientTransport({
          command: cfg.command,
          args: cfg.args ?? [],
          env: { ...process.env, ...(cfg.env ?? {}) },
        });
        const client = new Client(
          { name: "maple-agent", version: "0.1.0" },
          { capabilities: {} },
        );
        await client.connect(transport);
        connections.push({ name, close: () => client.close() });

        const listed = await client.listTools();
        const allow = cfg.tools ? new Set(cfg.tools) : null;
        let exposed = 0;

        for (const t of listed.tools ?? []) {
          if (allow && !allow.has(t.name)) continue;
          tools.push({
            name: wireName(name, t.name),
            description: (t.description ?? `${t.name} (via ${name})`).slice(0, 500),
            parameters: normaliseSchema(t.inputSchema),
            origin: "mcp",
            server: name,
            async run(args) {
              try {
                const res = await client.callTool({ name: t.name, arguments: args });
                return renderContent(res);
              } catch (err) {
                return `MCP call failed: ${(err as Error).message}`;
              }
            },
          });
          exposed++;
        }

        const skipped = (listed.tools?.length ?? 0) - exposed;
        onLog(
          `[mcp] ${name}: ${exposed} tool${exposed === 1 ? "" : "s"}` +
            (skipped > 0 ? ` (${skipped} filtered out)` : ""),
        );
      } catch (err) {
        onLog(`[mcp] ${name} failed to start: ${(err as Error).message}`);
      }
    }),
  );

  return tools;
}

/** MCP servers are loose about schemas; the model needs a well-formed object. */
function normaliseSchema(schema: unknown): JsonSchema {
  const s = schema as any;
  if (!s || typeof s !== "object" || s.type !== "object") {
    return { type: "object", properties: {}, required: [] };
  }
  return {
    type: "object",
    properties: s.properties ?? {},
    required: Array.isArray(s.required) ? s.required : [],
  };
}

function renderContent(result: any): string {
  const blocks = result?.content;
  if (!Array.isArray(blocks)) return JSON.stringify(result ?? {}).slice(0, 4000);
  const text = blocks
    .map((b: any) => {
      if (b?.type === "text") return b.text ?? "";
      if (b?.type === "image") return "[image omitted]";
      if (b?.type === "resource") return b.resource?.text ?? "[resource]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
  return text || "(empty result)";
}

export async function closeMcp(): Promise<void> {
  await Promise.all(
    connections.map((c) => c.close().catch(() => {})),
  );
  connections.length = 0;
}
