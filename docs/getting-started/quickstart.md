# Quickstart

Set up Konteks once, then use the same [session](../reference/glossary.md#session) flow whenever you open your coding agent.

> [!TIP]
> **Using an AI coding agent?** See [AI-Assisted Installation](../../README.md#-ai-assisted-installation) for a copy-ready prompt that asks the agent to install Konteks, configure MCP, and verify setup for you.

## Prerequisite: Project Setup

Run setup commands from your project root. Konteks requires **Node.js 22.13+** or **Bun 1.3+**.

Use `npx -y konteks-cli` by default for one-off setup unless you prefer another package runner.

### 1. Initialize Memory

Run one command from your project root:

```bash
npx -y konteks-cli init

# or your preferred package manager:
bunx konteks-cli init
pnpm dlx konteks-cli init
yarn dlx konteks-cli init
```

**What happens?**

* Creates a `.konteks/` directory for local memory storage.
* Initializes the `memory.sqlite` substrate.
* Adds `.konteks/` to your `.gitignore`.
* Extracts and indexes the current project state.

Do not commit `.konteks/`; initialization adds it to `.gitignore` so project memory stays local.

### 2. Set Up MCP

Install Konteks before configuring MCP. MCP clients expect the server process to start quickly, while one-off runners such as `npx`, `bunx`, `pnpm dlx`, and `yarn dlx` may spend time resolving or downloading packages before the server starts.

```bash
npm install -g konteks-cli

# or, with Bun:
bun add -g konteks-cli
```

Add Konteks to your MCP-compatible coding agent configuration before opening the agent.

> [!TIP]
> **Global Registration**: Register Konteks globally in your agent's config so you don't have to repeat this setup for every project.

```json
{
  "mcpServers": {
    "konteks": {
      "command": "konteks-cli",
      "args": ["mcp"]
    }
  }
}
```

MCP configuration locations are agent-specific. Prefer a global registration when your agent supports it, and restart or reload the agent after changing its MCP configuration.

> [!IMPORTANT]
> Konteks exposes its lifecycle workflows as [MCP Prompts](https://modelcontextprotocol.io/docs/concepts/prompts). If your agent does not show MCP Prompts in its autocomplete UI, run `konteks-cli install-skills --global` once after installation to use the lifecycle prompts as native skills. See [Compatibility](../api/cli.md#compatibility-skills).

## From This Point On

Use this flow whenever you open a fresh coding-agent session in the project.
For the full model behind this loop, read the [Warm Up -> Build -> Save lifecycle](lifecycle.md).

### 3. Open Your Agent

Open your coding agent from the root of your project after the MCP server is configured.

### 4. Warm Up

Run the Warm Up prompt at the start of a fresh agent session. The focus is optional: leave it blank for general project context, or add a free-form focus to shape the memories loaded during Warm Up.

```text
/konteks-warm-up
```

For focused context:

```text
/konteks-warm-up security, authentication, and authorization
```

### 5. Build

Give your agent the task directly. **RECALL IS OPTIONAL**; use it when the work benefits from remembered modules, constraints, prior decisions, or historical context:

```text
/konteks-recall last attack, vulnerability, prevention and mitigation
```

### 6. Save

When the session is complete or worth preserving:

```text
/konteks-save
```

The prompt tells your agent to save future-useful durable memories first, then one compact session diary. You do not need to manually summarize or split the work yourself.
