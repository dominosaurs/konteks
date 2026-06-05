# Konteks for Agents

This page is for AI coding agents that are helping a developer add Konteks to an existing codebase.

Treat this page as the installation playbook for the current session. Keep the setup moving, make safe defaults, and only ask the user for decisions that materially affect their local machine or agent configuration.

## Goal

Leave the developer with:

* Konteks initialized in the project.
* The Konteks MCP server registered in their coding agent when possible.
* Compatibility skills installed when the agent cannot expose MCP prompts.
* A clear Warm Up -> Build -> Save workflow for future sessions.

Do not create a new application. Konteks is added to the project the user already has open.

## How to Proceed

1. Confirm the current directory is the project root, or move to the nearest repository root if it is obvious.
2. Check whether Konteks is already initialized by looking for `.konteks/config.json`.
3. If it is already initialized, skip initialization and continue to MCP setup and workflow verification.
4. Verify that either Node.js 22.13 or newer, or Bun 1.3 or newer, is available.
5. Select the command mode that matches the user's runtime preference.
6. Install `konteks-cli` globally with the selected package manager.
7. Run the selected initialization command.
8. Configure the user's MCP-compatible agent with the selected MCP server definition.
9. Install compatibility skills only when the agent supports MCP tools but does not show MCP prompts.
10. Run a quick verification command.
11. Explain the exact next prompt the user should run at the start of future sessions.

## Prerequisite Checks

Run quick checks from the project root:

```bash
pwd
test -f .konteks/config.json && echo "Konteks is already initialized"
node -v
npm -v
bun --version
```

Select the package manager and command mode from the user's environment:

* Use Bun mode when the user requested Bun, the project uses Bun, or Bun is the only supported runtime available.
* Use npm mode when the user requested npm/Node, the project uses npm, or Node.js with npm is the only supported runtime available.
* If both are available and there is no user or project signal, ask the user which package manager they prefer before installing globally.

If neither supported runtime is available, stop and ask the user to install Node.js 22.13+ or Bun 1.3+ before continuing. Do not install system runtimes unless the user explicitly asks you to do that.

## Install Konteks Globally

Install Konteks globally before running setup or configuring MCP. MCP clients expect the server process to start quickly, so choose the command form that matches the user's runtime.

With Bun:

```bash
bun add -g konteks-cli
```

With npm:

```bash
npm install -g konteks-cli
```

If global package installation requires network access, package downloads, or elevated approval, ask the user for approval with the exact command before continuing.

## Initialize Konteks

Run one initialization command from the project root:

```bash
# Bun mode:
bunx --bun konteks-cli init

# npm mode:
konteks-cli init
```

Initialization should:

* Create `.konteks/` for project-local memory.
* Initialize the local SQLite memory store.
* Add `.konteks/` to `.gitignore`.
* Extract and index the current project state.

If initialization reports that the project is already initialized, treat that as success and continue.

## Set Up MCP

Add Konteks to the user's MCP-compatible coding agent configuration. Prefer a global MCP registration when the agent supports it so the user does not repeat this setup for every project.

Use this MCP server definition:

```json
{
  "mcpServers": {
    "konteks": {
      "command": "bunx",
      "args": ["--bun", "konteks-cli", "mcp"]
    }
  }
}
```

Use that MCP server definition in Bun mode. `--bun` forces Bun to run the CLI.

In npm mode, use this MCP server definition:

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

If you know the active agent's MCP config location and can edit it safely, update it. If you cannot identify the config location, show the relevant JSON snippet and tell the user where to paste it for their agent.

After changing MCP configuration, the user may need to restart or reload the agent before the `konteks` server appears.

## Install Compatibility Skills

Konteks exposes its lifecycle workflows as MCP prompts:

* `konteks-warm-up`
* `konteks-recall`
* `konteks-save`

If the current agent does not show MCP prompts in its prompt or command UI, install the same lifecycle workflows as native skills:

```bash
# Bun mode:
bunx --bun konteks-cli install-skills --global

# npm mode:
konteks-cli install-skills --global
```

Use `--global` for agent compatibility skills, because these prompts are useful across projects.

## Verify Setup

Run:

```bash
# Bun mode:
bunx --bun konteks-cli status

# npm mode:
konteks-cli status
```

Successful setup means the status command can find the project root, memory directory, and indexed project memory. If status says memory is not initialized, return to the project root and run the selected initialization command again.

## First Session Workflow

Once MCP is configured or compatibility skills are installed, tell the user to start fresh agent sessions with:

```text
/konteks-warm-up
```

They can add an optional focus when the next task needs focused context:

```text
/konteks-warm-up authentication, billing, or deployment
```

During development, the user can ask for recall when a task needs remembered modules, constraints, or prior decisions:

```text
/konteks-recall summarize the current task and likely related code
```

When the session is complete or worth preserving, tell the user to run:

```text
/konteks-save
```

The save prompt should persist compact durable memories first, then one session diary.

## Guidance

* Ask before making broad edits to global agent configuration.
* Do not commit `.konteks/`; initialization should add it to `.gitignore`.
* Do not add Konteks as an application dependency unless the user explicitly asks for that.
* Do not invent custom memory directories; Konteks uses `.konteks/` in the project root.
* Do not configure MCP to launch Konteks through `npx`, plain `bunx`, `pnpm dlx`, or `yarn dlx`. Use `bunx --bun konteks-cli mcp` for Bun users and direct `konteks-cli mcp` for Node users.
* Keep installation output brief. Report what was initialized, how MCP was configured, whether compatibility skills were installed, and the first prompt to run.
* If network access, package downloads, or global config writes require approval, ask for approval with the exact command you need to run.

## Example Outcome

When everything is ready, leave the user with a short message like:

```text
Konteks is initialized for this project. I configured the MCP server with the selected global command mode, installed global compatibility skills because this agent does not expose MCP prompts, and verified setup with the status command.

For future fresh sessions, start with `/konteks-warm-up`. Use `/konteks-recall <focus>` when you need focused project memory, and run `/konteks-save` before ending a meaningful session.
```
