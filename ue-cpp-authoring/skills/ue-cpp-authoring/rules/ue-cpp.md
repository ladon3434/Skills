---
paths:
  - "Source/**"
  - "Plugins/**/Source/**"
---

# Unreal C++ — always-on facts

- Writing or changing C++ here: load the `ue-cpp-authoring` skill first (validation, asset slots, modules,
  widgets, refactoring, editor tools). The project's own CLAUDE.md / architecture page wins over it.
- Generated trees are never edited or committed: `Binaries/`, `Intermediate/`, `DerivedDataCache/`, `Saved/`,
  `.vs/`, `*.generated.h`, generated IDE files.
- The contract is documented in the header; a `.cpp` comment is a short non-obvious *why* beside its line.
  Comments in English.
- No `/Game/...` path and no `ConstructorHelpers::FObjectFinder` in code that ships: the cooker cannot see a
  string. Assets come in through typed `UPROPERTY` slots (Blueprint default, settings, data asset).
- Editor-only API in a runtime module stays inside `#if WITH_EDITOR` (`GetDisplayNameText`, `GetToolTipText`,
  `GetMetaData`); only a Game-target (Shipping) compile catches a miss.
- `check(Expr)` is not evaluated in Shipping: no side effects inside it. A lambda that outlives the call captures
  `TWeakObjectPtr`, not `this`; a UObject is touched only on the game thread.
- A UHT `meta` value is at most 1024 characters and cannot be split across adjacent string literals.
- Engine signature: with the code-analysis plugin enabled, `engine-api <Symbol>[::Member]` in Bash;
  a whole engine mechanism is read by a subagent, not inline.
- C++ symbol → assets that use it: `find-asset-refs <Symbol>` in Bash with the ue-content-gates plugin enabled.
  Plain `rg` finds nothing: a package stores `AMyActor` as `MyActor`, and `rg` without `-a` skips binary files.
  Renaming a reflected symbol needs a `[CoreRedirects]` line in `Config/DefaultEngine.ini`.
- `compile_commands.json` stays absent unless a task needs clangd: its background index of a UE tree takes
  tens of GB of commit charge and starves the build.
