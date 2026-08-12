---
title: MCP servers
layout: default
nav_order: 12
---

# MCP servers

Third-party tools over the Model Context Protocol. Use these for **capability**
Enio does not have; use a [skill](skills.md) for know-how.

```sh
enio mcp-init        # writes a starter ~/.enio/mcp.json
enio tools           # everything currently exposed, built-in and MCP
```

```json
{
  "servers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "..." },
      "tools": ["search_repositories", "get_file_contents"]
    }
  }
}
```

The `tools` allowlist is the field worth knowing about. A server offering thirty
tools will exhaust the budget on its own, and the failure is silent — the model
starts picking at random rather than erroring. Naming the two or three you
actually use keeps the count sane.

Assign a server to an agent by name so its tools only appear where they belong,
or reach it for a single turn with `@github what changed this week`.

A server that fails to start is reported and skipped. It never blocks the rest.
