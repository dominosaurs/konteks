<img width="1536" height="1024" alt="Banner" src="https://github.com/user-attachments/assets/37e29d10-ed23-409d-92b2-2c6fab854f72" />

# Konteks

**Konteks** is a memory engine for AI coding agents.

It builds a project-local context graph through autonomous **knowledge curation**, ensuring you **never re-explain your project** to an AI agent.

Memory artifacts are stored directly inside your repository, exposing compact, task-specific recall through an MCP server without cloud dependencies.

## 🚀 Key Features

* **Language-Aware**: Understands code structure across [various file types](src/assets/grammar-registry.ts).
* **Local-First**: Your project memory stays in your repo—no cloud, no accounts.
* **Token-Efficient**: High-fidelity context synthesis designed for LLM economy.

## 🧠 How It Works

Konteks treats a repository as a local memory system for agent workflows. It builds searchable project artifacts from source files, retrieves task-relevant evidence, and expands related context through a lightweight graph of entities and relations when available.

For a deep dive into the philosophy, architecture, and usage, see the [Full Documentation](docs/README.md).

* [Overview](docs/getting-started/overview.md): Vision, Philosophy, and the "Why."
* [Session Lifecycle](docs/getting-started/lifecycle.md): How to work with Konteks (Warm Up -> Build -> Save).
* [Architecture Overview](docs/core-concepts/overview.md): How the memory engine works under the hood.
* [Glossary](docs/reference/glossary.md): Short definitions for Konteks terms.

## ⚡ Quickstart

Konteks runs on **Node.js (>=22.13)** or **Bun**. Start by initializing memory from your project root:

```bash
npx -y konteks-cli init
```

Continue with the [Quickstart](docs/getting-started/quickstart.md) for MCP setup and the Warm Up -> Build -> Save flow.

### 🤖 AI-Assisted Installation

If you are using an AI coding agent such as Claude Code, Codex, or OpenCode, let the agent handle the setup from your project root.

Paste this prompt into your agent. It points the agent to the Konteks installation playbook, asks it to follow project defaults, and keeps MCP setup, verification, and lifecycle guidance in one flow:

```text
I want to add Konteks to this project.

Read and follow https://raw.githubusercontent.com/konteks/cli/refs/heads/main/docs/for-agents/installation.md. Treat that Markdown as the source of truth for installing Konteks, configuring MCP, verifying setup, and explaining the Warm Up -> Build -> Save workflow.
```

The agent should read the instructions, make safe defaults, ask only when a local-machine or agent-configuration decision is required, and leave you with a verified Konteks setup.

## 📂 Local Storage

Konteks writes local memory under `.konteks/`. It uses SQLite for extracted content, durable memories, diary entries, retrieval indexes, embeddings, and graph metadata; extraction manifests and project config live beside the database.

## ⚖️ License

MIT Licensed. See [LICENSE](LICENSE) for details.
