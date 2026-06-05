# Troubleshooting Konteks

This guide helps you resolve common issues encountered while setting up or using Konteks.

## Common Issues & Solutions

### 1. "Konteks memory is not initialized"

**Symptoms**: Any command returns an error about missing initialization.
**Cause**: The `.konteks` directory or `config.json` is missing in your project root.
**Solution**: Run `konteks init` to initialize the project.

### 2. Understanding Recall Quality Signals

**Symptoms**: Recall returns a `weak` or `partial` quality label.
**Cause**: Konteks provides an honest signal about the relevance of retrieved context.

* **Weak**: No direct implementation matches or authoritative facts were found.
* **Partial**: Some signals were found (e.g., related modules or historical diary entries), but no direct implementation hits.

**Solution**:

1. **Refine your Task**: Be more specific in your recall request (e.g., mention a specific file or module).
2. **Rebuild the Index**: Run `konteks rebuild` to scan recent changes and rebuild the [Derived Memory](glossary.md#derived-memory).
3. **Check Ignore Rules**: Ensure the files you expect are not being excluded by `.gitignore` or `.konteksignore`.

### 3. Durable memory is missing after a rebuild

**Symptoms**: Your saved observations or diary entries are gone.
**Cause**: `konteks rebuild` only rebuilds **derived** data (sections, entities). **Durable** data (observations, diary) should be preserved.
**Solution**: If durable data is truly missing, check if you are in the correct project root or if the `.konteks/memory.sqlite` file was manually deleted.

### 4. "MCP Tool timeout or connection error"

**Symptoms**: Your AI agent reports that it cannot connect to the Konteks server or the tool timed out.
**Cause**: The MCP server process may have crashed, is taking too long to process a large project, is being launched through a slow package runner, or the direct `konteks-cli` command cannot find Node.js on `PATH`.
**Solution**:

1. Install Konteks globally with the runtime you use: `bun add -g konteks-cli` for Bun users, or `npm install -g konteks-cli` for Node users.
2. With Bun, configure your MCP client with `"command": "bunx"` and `"args": ["--bun", "konteks-cli", "mcp"]`. With Node, configure it with `"command": "konteks-cli"` and `"args": ["mcp"]`.
3. Run `bunx --bun konteks-cli status` for Bun installs or `konteks-cli status` for npm installs to check project memory freshness.
4. Ensure you are using a supported runtime (Bun 1.3+ or Node 22.13+). If you configure MCP with direct `konteks-cli`, Node must be on `PATH`.
5. Check `.konteks/errors.log` for recent internal Konteks errors.
6. Check the logs of your AI agent/host for connection-level errors.

### 5. "Secrets or sensitive data in recall"

**Symptoms**: Recall returns content containing API keys, passwords, or other sensitive information.
**Cause**: Konteks indexed a file containing secrets that wasn't properly ignored.
**Solution**:

1. Immediately add the sensitive file to your `.gitignore` or `.konteksignore`.
2. Ask your MCP agent to call `konteks_forget` with a targeted `query` and the appropriate forget `mode`.
3. Use `konteks rebuild` to ensure the stale index is cleared.

### 6. "Konteks MCP tool failed due to an internal error"

**Symptoms**: An MCP tool returns a sanitized internal-error message without stack details.
**Cause**: Konteks hides unexpected internal details from MCP clients by default.
**Solution**: Inspect `.konteks/errors.log` in the project root. Each line is a JSON error entry with timestamp, surface, tool or prompt metadata, message, and stack trace when available. The log is local and redacted best-effort, but treat it as diagnostic data.
