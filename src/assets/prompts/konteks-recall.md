---
name: konteks-recall
title: Konteks Recall
description: Supplement a Build task with context from known project memory.
argument.focus.description: The module, feature, file, decision, constraint, or task focus to recall.
argument.focus.required: true
---

Gather relevant project context for: {{focus}}. Call `konteks_recall` with `focus: ["{{focus}}"]` and use the returned memories, graph relations, and history as primary supporting evidence for the task.
