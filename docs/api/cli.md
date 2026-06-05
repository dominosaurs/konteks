# CLI API

The Konteks CLI manages local project memory. It can run through `npx`, `bunx`, `pnpm dlx`, or `yarn dlx` for one-off commands, but MCP server registration should use an installed `konteks-cli` executable for fast startup.

For terms, see the [Glossary](../reference/glossary.md).

> [!INFO]
> The examples below use `konteks`, the CLI display name. When running through a package runner, use the published package name, for example `npx -y konteks-cli <command>`.

## Commands

| Command | Capability | Use When |
| :--- | :--- | :--- |
| `konteks init` | Initialize | Prepare a project for local memory storage. |
| `konteks rebuild` | Rebuild | Rebuild derived project memory artifacts from scratch while preserving durable memories and diary entries. |
| `konteks status` | Status | Check memory health and freshness. |
| `konteks memory export <file>` | Export | Write portable durable memories and diary entries to JSON. |
| `konteks memory import <file>` | Import | Merge portable durable memories and diary entries from JSON. |
| `konteks backup <file>` | Backup | Create a full `.konteks` `.tar.gz` archive. |
| `konteks restore <file>` | Restore | Restore a full `.konteks` archive. |
| `konteks mcp` | Serve | Start the MCP server for an agent client. |
| `konteks install-skills` | Compatibility | Install Konteks skills for agents without MCP prompt support. |

> [!IMPORTANT]
> Configure MCP clients with an installed command such as `"command": "konteks-cli", "args": ["mcp"]`. Avoid one-off runners for MCP server startup because package resolution or downloads can exceed the client startup timeout.

## Memory Portability

Durable memory export/import is the portable path. It includes saved observations and diary entries, then rebuilds local retrieval indexes on import:

```bash
konteks memory export memories.konteks.json
konteks memory import memories.konteks.json
```

By default, export includes only active durable memory. Use `--include-inactive` to include soft-deleted or suppressed records. Use `konteks memory import --dry-run <file>` to validate and preview import counts without writing.

## Full Backups

Full backups are exact operational snapshots of the project memory directory:

```bash
konteks backup konteks-backup.tar.gz
konteks restore konteks-backup.tar.gz
```

Restore refuses to replace a non-empty memory directory unless `--force` is provided. Forced restore creates a safety backup archive before replacing existing memory.

## MCP Debugging

These commands inspect MCP behavior from the terminal without registering an agent.

| Command | Shows |
| :--- | :--- |
| `konteks mcp tools` | Choose an MCP tool interactively, review its schema, enter input values, and run it. |
| `konteks mcp tools <tool>` | Review and run one MCP tool by name. |
| `konteks mcp tools --json <tool>` | Print the tool result as JSON. |

> [!IMPORTANT]
> `konteks mcp tools` runs the selected MCP tool after confirmation. Optional text, number, and JSON fields can be left blank to omit them. Complex fields such as arrays and objects are entered as JSON text.

## Compatibility Skills

If your agent supports MCP but does not show MCP prompts in its autocomplete UI (e.g. [Codex](https://github.com/openai/codex/issues/5059)), you can install native skills as a workaround:

```bash
konteks install-skills [--global]
```

This writes the Konteks lifecycle prompts (`warm-up`, `recall`, `save`) as native skills into `.agents/skills` (local) or `~/.agents/skills` (global).
