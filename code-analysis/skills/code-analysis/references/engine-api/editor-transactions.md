---
grounded: 2026-08-12
---

# Engine API — editor transactions (undo buffer)

## UTransBuffer::Cancel

`Source/Editor/UnrealEd/Private/EditorTransaction.cpp:1411`. A nested `BeginTransaction` creates no transaction of its own, and `Cancel` from a nested scope pops the single shared transaction — destroying the outer one's undo records. An MCP tool that can run inside an open transaction checks `UEditorEngine::IsTransactionActive()` first and opens none when one is already open; `End` is nesting-safe.
