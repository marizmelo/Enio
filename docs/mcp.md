---
title: MCP servers
layout: default
nav_order: 13
---

# MCP servers

Third-party tools over the Model Context Protocol. Use these for **capability**
Enio does not have; use a [skill](skills.md) for know-how.

In the desktop app: **+ menu → Connection → Manage connections…** lists every
server with its live status — a green dot and tool count when connected, the
actual error string when it failed — and adding, disabling or removing one
reconnects immediately, no restart. The same file drives everything, so the
CLI edits are equivalent:

```sh
enio mcp                 # list connections
enio mcp add github npx -y @modelcontextprotocol/server-github --tools search_repositories,get_file_contents
enio mcp disable github  # keep the config, drop the tools
enio mcp rm github
enio mcp-init            # writes a starter ~/.enio/mcp.json
enio tools               # everything currently exposed, built-in and MCP
```

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "..." },
      "tools": ["search_repositories", "get_file_contents"]
    }
  }
}
```

One honest caveat: adding a server means its command runs on your machine the
moment it connects — same as it always did when you edited the file by hand.
Only add servers you trust.

The `tools` allowlist is the field worth knowing about. A server offering thirty
tools will exhaust the budget on its own, and the failure is silent — the model
starts picking at random rather than erroring. Naming the two or three you
actually use keeps the count sane.

Assign a server to an agent by name so its tools only appear where they belong,
or reach it for a single turn with `@github what changed this week`. Pipeline
steps inherit automatically: an ability that declares a server need (home
automation → Home Assistant) gets that server's tools in its step, which makes
the allowlist doubly load-bearing — an unfiltered server floods every step
that inherits it.

A server that fails to start is reported and skipped. It never blocks the rest.
