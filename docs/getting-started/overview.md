<img width="1672" height="941" alt="Overview Illustration" src="https://github.com/user-attachments/assets/fa7d859e-41d9-41cf-b735-440cc86d6b5c" />

# Overview

**Konteks** is a local context graph for AI coding agents. It acts as a **memory engine** for your repository, performing autonomous **knowledge curation** to ensure you **never re-explain your project** to an AI agent.

## Why Konteks?

Traditional Retrieval-Augmented Generation (RAG) often fails in coding because it treats code as plain text. It searches for keywords but misses the *structure*.

Konteks is built specifically for code. It uses language-aware extraction (via Tree-sitter) and a hybrid graph-search model to understand the *meaning* and *relationships* within your project. By using Konteks, you move from "reading files" to "sharing a brain" with your AI agent.

## The Vision

In a typical agentic workflow, every new [session](../reference/glossary.md#session) is a "blank slate." The agent has to rediscover your architecture, your decisions, and your progress from scratch. This "context amnesia" leads to wasted tokens, redundant questions, and architectural drift.

Our vision is a world where project context is durable and portable. Konteks provides a queryable memory that lives directly inside your repository, bridging the gap between raw file reading and human-level project understanding.

## Core Philosophy

### 1. Local-First & Privacy-Centric

Konteks stores memory artifacts inside your repository, typically in a `.konteks/` directory with a local SQLite database.

* **Your data stays with your code.**
* No cloud services, no external accounts, and no telemetry.
* Memory is as portable as your repo.

### 2. Zero-Friction Setup

We believe that setup should not be a barrier. Konteks can be tried and initialized through the JavaScript package ecosystem without a global install.

* Use one-off runners such as `npx` or `bunx` for setup and trial commands.
* For MCP server startup, use the command form that matches your runtime: Bun users can use `bunx --bun konteks-cli mcp`, while Node users can use the installed `konteks-cli mcp` command.
* No separate database service or external account required.
* Works anywhere Node.js or Bun is available.

### 3. Agent-Native & MCP-First

Konteks is built from the ground up for the **Model Context Protocol (MCP)**.

* It doesn't just return "search results"; it provides **Recall**—a ranked, token-efficient package of context tailored for LLM consumption.
* It follows a structured [Session Lifecycle](lifecycle.md) (Warm Up -> Build -> Save) to keep the agent-human collaboration focused.

### 4. High Signal, Low Noise

Konteks focuses on **curated context**. Instead of logging every raw conversation, it prioritizes:

* **Durable Decisions**: Why you chose X over Y.
* **Structural Relationships**: How modules actually connect beyond simple imports.
* **Session Progress**: What was attempted, what failed, and what's next.

---

**Ready to get started?** Follow the [Quickstart](quickstart.md) to set up your project memory in minutes.

**Using an AI coding agent?** Use the [AI-Assisted Installation](../../README.md#-ai-assisted-installation) prompt to have your agent install Konteks, configure MCP, and verify setup.

**Want to see the technical details?** Check out the [Architecture Overview](../core-concepts/overview.md) to see how Konteks is built under the hood.

**Need terminology?** Use the [Glossary](../reference/glossary.md) for short definitions of Konteks concepts.
