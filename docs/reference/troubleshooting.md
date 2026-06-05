# Troubleshooting Konteks

This guide helps you resolve common issues encountered while setting up or using Konteks.

<details>
<summary><strong>Konteks memory is not initialized</strong></summary>

<blockquote>
The `.konteks` directory or `config.json` is missing in your project root.

Run `konteks init` to initialize the project.
</blockquote>
</details>

<details>
<summary><strong>MCP Tool timeout or connection error</strong></summary>

<blockquote>
The server crashed, timed out scanning a massive project, was launched through a slow package runner, or the direct `konteks-cli` command cannot find Node.js on your `PATH`.

* **Install globally:** Run `bun add -g konteks-cli` (Bun users) or `npm install -g konteks-cli` (Node users).
* **Configure your MCP client:**
  * *Bun:* Use `"command": "bunx"` and `"args": ["--bun", "konteks-cli", "mcp"]`.
  * *Node:* Use `"command": "konteks-cli"` and `"args": ["mcp"]`.
* **Check memory freshness:** Run `bunx --bun konteks-cli status` (Bun) or `konteks-cli status` (Node).
* **Verify runtime:** Ensure you are using Bun 1.3+ or Node 22.13+. If configuring MCP with the direct `konteks-cli` command, Node must be on your `PATH`.
* **Check logs:** Inspect `.konteks/errors.log` for internal errors, and check your AI agent's logs for connection issues.

</blockquote>
</details>

<details>
<summary><strong>Konteks MCP tool failed due to an internal error</strong></summary>

<blockquote>
An unexpected internal error occurred. Detailed stack traces are hidden from MCP clients by default to prevent leaking internal context.

Open `.konteks/errors.log` in your project root to view the timestamp, surface, metadata, and full stack trace for diagnosis. The log is local and redacted best-effort, but should be treated as diagnostic data.
</blockquote>
</details>

<details>
<summary><strong>Recall returns a 'weak' or 'partial' quality signal</strong></summary>

<blockquote>
Konteks could not find strong, direct implementation matches for your query.

* **Refine your task:** Be specific and name the exact file or module.
* **Rebuild the index:** Run `konteks rebuild` to scan recent changes and rebuild the [Derived Memory](glossary.md#derived-memory).
* **Check ignore rules:** Verify the target files aren't being excluded by `.gitignore` or `.konteksignore`.

</blockquote>
</details>

<details>
<summary><strong>Durable memory is missing after a rebuild</strong></summary>

<blockquote>
You are either in the wrong project root, or the `.konteks/memory.sqlite` file was manually deleted. Running a rebuild only resets derived data (sections, entities); it does not touch durable data (like diary entries or observations).

Verify your current directory. If the file was deleted, restore `.konteks/memory.sqlite` from a backup.
</blockquote>
</details>

<details>
<summary><strong>Secrets or sensitive data appear in recall</strong></summary>

<blockquote>
Konteks indexed an unignored file containing sensitive information.

1. Immediately add the file to `.gitignore` or `.konteksignore`.
2. Have your MCP agent call `konteks_forget` with the targeted query and appropriate forget mode.
3. Run `konteks rebuild` to completely wipe the stale index.

</blockquote>
</details>
