---
name: konteks-warm-up
title: Konteks Warm Up
description: Open a fresh Konteks session with project context.
argument.focus.description: Optional free-form module, file, behavior, decision, task, or memory focus for targeted recall after warm up.
argument.focus.required: false
---

Warm up this session by calling `konteks_warm_up`.

Optional focus: {{focus}}

If the optional focus is non-empty, pass it to `konteks_warm_up` as a single item in the `focus` array. If it is empty, omit `focus`.

If the warm-up result includes an `update` object, mention the available Konteks update and its command before the ready message. If no `update` object is present, do not mention updates.

After context is loaded, do not summarize or re-explain what you found unless the user explicitly asks. Reply only: `Konteks is warmed up and ready for the task.` no further action is required.
