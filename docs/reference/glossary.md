# Glossary

Short definitions for Konteks product terms.

## Agent

An AI coding assistant connected to the project through an MCP client.

## Build

The second lifecycle phase. Use Build prompts to continue existing tasks or start new ones; Recall can supplement either path when related context is useful.

## Content Block

A logically bounded section of code or text extracted from a project artifact (technically known as a *section*). Content Blocks are the fine-grained units of knowledge used for semantic search.

## Context

Relevant project knowledge given to an agent so it can work without rediscovering the repository from scratch.

## Derived Memory

Knowledge automatically extracted from source code, documentation, and project structure. It is reproducible and can be rebuilt via a `rebuild` operation.

## Diary

A chronological activity record saved by an agent. Diary entries help future sessions avoid repeated work.

## Durable Memory

Intentional knowledge created by users or agents during sessions (e.g., observations, decisions, preferences). It is authoritative and preserved across derived-memory rebuilds.

## Graph Expansion

The process of navigating the [Semantic Graph](#semantic-graph) during recall to uncover hidden dependencies and related context.

## History Evidence

Superseded or invalidated graph relations included in recall when a task asks about prior decisions, replacements, or why something changed.

## Knowledge Curation

The process of turning raw project artifacts and agent findings into durable, retrievable memory.

## Knowledge Journey

The lifecycle of a context signal, evolving from raw source code (Extraction) to consolidated knowledge (Indexing) and finally to synthesized insight (Recall).

## Local-First

Konteks stores all memory in the project's local `.konteks` directory and does not require cloud services.

## Memory

A durable saved fact, decision, constraint, preference, blocker, or code insight.

## Memory Engine

The Konteks system that extracts, stores, retrieves, and updates project memory.

## Module

A high-level project area or architectural grouping identified from project files.

## Quality Label

A signal (`strong`, `partial`, or `weak`) returned during recall to help the agent understand the reliability and relevance of the retrieved context.

## Recall

Task-specific retrieval. Recall synthesizes a compact [Recall Package](#recall-package) for the agent before work begins.

## Recall Package

A token-efficient bundle of context containing a brief, primary targets, relevant memories, graph evidence, history evidence, and a [Quality Label](#quality-label).

## Rebuild

The CLI command that rebuilds all [Derived Memory](#derived-memory) artifacts from scratch for recovery or maintenance.

## Save

The final lifecycle phase. Save persists structured [Durable Memories](#durable-memory) and records one session diary back to Konteks.

## Semantic Graph

The multi-dimensional representation of a project where entities (nodes) are connected by typed relationships (edges).

## Supersession

A decision-memory link where a newer decision replaces an older decision. The older decision remains searchable, while its replaced graph claims become historical evidence.

## Session

One continuous agent conversation inside a project. A session can contain one task or several related tasks.

## Session Boundary

The point where a new agent conversation should start because the next work no longer shares the same goal, files, constraints, or decision chain.

## Storage Substrate

The local persistence layer for Konteks memory, based on SQLite for extracted sections, durable memory, diary entries, retrieval text, and graph metadata.

## Taxonomy

The project-specific ontology used to organize knowledge into logical scopes (e.g., `api`, `ui`, `database`).

## TOON

Token-Oriented Object Notation. A compact, agent-readable text format used for MCP tool output and selected summaries. Read more on [toonformat.dev](https://toonformat.dev/guide/getting-started.html).

## Vector

A numeric representation of text that helps Konteks find related memories by meaning, even when the exact words differ.

## Warm Up

The first lifecycle phase. Warm Up gives a fresh agent session stable project context.
