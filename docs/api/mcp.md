# MCP API

Konteks exposes project memory to AI agents through MCP.

For terms, see the [Glossary](../reference/glossary.md).

## Surfaces

| Surface | What It Does |
| :--- | :--- |
| **Prompts** | Guided workflows for Warm Up -> Build -> Save. |
| **Tools** | Lower-level operations the agent can call while following prompts. |

## Prompts

Prompts are user-invoked workflow templates. They guide the agent through the [Session Lifecycle](../getting-started/lifecycle.md), where a [session](../reference/glossary.md#session) is one continuous agent conversation in a project.

> [!NOTE]
> **Compatibility**: For agents that do not support MCP prompts in their UI, run `konteks install-skills` to install these workflows as native skills. See [Compatibility](cli.md#compatibility-skills).

| Prompt | Lifecycle Phase | Use When |
| :--- | :--- | :--- |
| `konteks-warm-up` | Warm Up | Open a fresh agent session in a project; optionally append a free-form focus for recall after warm up. |
| `konteks-recall` | Build | Supplement a task with context from known modules, constraints, or decisions. |
| `konteks-save` | Save | End of session to persist durable memories with `konteks_save_memories` and one session diary with `konteks_save_diary`. |

## Tools

Tools are lower-level callable operations used by agents and debugging workflows. Canonical tool names use the `konteks_*` prefix so they stay clear when an agent has multiple MCP servers.

| Tool | Capability | Parameters | Use When |
| :--- | :--- | :--- | :--- |
| `konteks_warm_up` | Warm Up | `focus` | Start a fresh agent session with stable project context and optional focused recall. |
| `konteks_recall` | Recall | `focus`, `includeSources` | Retrieve a compact brief, primary targets, memories, graph evidence, history evidence, and a `quality` signal. |
| `konteks_save_memories` | Save Memories | `memories` | Persist structured durable memories for future sessions. |
| `konteks_save_diary` | Save Diary | `summary`, `subject`, `tags` | Persist one compact session diary entry for continuity. |
| `konteks_search` | Search | `query`, `limit` | Inspect memory directly with a query. |
| `konteks_forget` | Forget | `id`, `query`, `mode`, `reason` | Remove or suppress wrong, stale, or sensitive memory using `soft_delete`, `invalidate`, or `hard_delete`. |

MCP tools validate project health silently before doing work. If memory is not initialized or a derived-memory rebuild is required, the tool fails with a short actionable error instead of returning status context.

Save tools return after durable memory is written. Changed-project refresh, embedding generation, and sqlite-vec indexing continue as best-effort background maintenance, so semantic retrieval can lag briefly after a save. Run `konteks rebuild` when you need an explicit full repair pass.

Example durable memory payload:

```json
{
  "memories": [
    {
      "content": "Use the SQLite retrieval document table as the canonical search surface.",
      "importance": 4,
      "kind": "decision",
      "source": "src/database/schema.ts",
      "supersedes": ["obs_previous_decision_id"],
      "tags": ["retrieval", "sqlite"]
    }
  ]
}
```

`supersedes` is optional and intended for `decision` memories. Use it when a new decision replaces older saved decisions so recall can preserve the old graph evidence as historical context.
