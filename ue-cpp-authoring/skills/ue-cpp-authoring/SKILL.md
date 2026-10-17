---
name: ue-cpp-authoring
description: >
  How to write C++ for Unreal Engine 5.x: gameplay, components, subsystems, settings,
  widgets and CommonUI, editor modules and editor tool plugins (MCP, utilities).
  Use before the first line of code and when choosing an idiom — "write a class", "add a
  component", "make a widget", "CommonUI screen", "move to settings", "add a UPROPERTY",
  "make an editor tool", "MCP tool", "need a manager / singleton", "make a subsystem",
  "move balance into a data asset", "write an asset validator", "port a Blueprint to C++",
  "remove LogTemp", "check or ensure", "UHT complains", "engine upgraded — does not build";
  and for behaviour-preserving refactoring — "rename a class", "clean up dead code",
  "unify", "extract common code". Russian: «напиши класс», «добавь компонент», «сделай
  виджет», «нужен менеджер / синглтон», «сделай сабсистему», «перенеси блупринт в C++»,
  «убери LogTemp», «переименуй класс», «почисти мёртвый код».
---

# ue-cpp-authoring — C++ for UE

Paths are relative to the skill folder (`<skill>`). The rules below are the engine and general
engineering; the project has its own modules, log categories, helpers and style — they win and
live in its `CLAUDE.md` or the architecture page it links to. Read them before the first line of
code in a repository you have not written to in this session.

## Before code

- **Scope** — build what was asked. If a requirement looks unnecessary, say so and build it
  anyway.
- **Unfamiliar engine API — ground it, do not recall it.** With the code-analysis plugin enabled —
  `engine-api <Symbol>[::Member] [--module <M>]` in Bash (the plugin's command; declaration and
  `file:line`, fine in the main context). Without it — `rg` over `<engine>/Engine/Source` and
  `Engine/Plugins` from a subagent. `FVector::X` is declared as `TVector::X`: a miss on an alias is
  not proof of absence. How a whole mechanism works — a subagent, not reading the engine in the
  main context.
- **Format hook.** If the project runs clang-format after every edit (a PostToolUse hook), the
  next `Edit` built on the old text may not match — re-read the region. `#include` order is often
  manual (`SortIncludes: false`) — do not reorder.

## Validation

- A property the designer must set — a check in `IsDataValid(FDataValidationContext&) const`
  under `#if WITH_EDITOR` (the project's validation helpers, if any). The check runs on
  Tools → Validate Project Data and on asset save; the Play button does not run it. A new
  required value must be reachable from this check.
- At runtime a missing value — an error log naming the slot and the owner, and a safe exit.
  `check()` — only for an established invariant, not for designer data. An optional value —
  a branch plus a warning.
- Do not throw away a reader's result: `ParseVector(Json, Out);` without a check leaves `Out`
  untouched while the tool answers "success". Check the tree — `<skill>/scripts/discarded-verdict-lint.cmd`
  (details in `references/editor-tool-plugins.md`).
- A check across assets (every weapon in the level has a config) — an external validator
  `UEditorValidatorBase`, in an Editor module only: `references/subsystems-data.md`.

## Assertions, threads, UHT

- In Shipping `check(Expr)` is not evaluated at all, `ensure` is evaluated and stays silent, `verify`
  is evaluated. No side effects inside `check()`. The per-configuration table —
  `references/assertions-threading-uht.md`.
- `UObject` — only from the game thread; a lambda that outlives the call (delegate, timer,
  async load) captures `TWeakObjectPtr`, not `this`; timers are cleared in
  `EndPlay` / `Deinitialize`.
- Same file: decoding UHT and link errors, `LoadSynchronous` into a local variable,
  unused Blueprint API (not a defect; the defect is API unusable by design) and an engine change:
  `DefaultBuildSettings` / `IncludeOrderVersion` in `*.Target.cs` and the refusal "modifies the values
  of properties … build products in common with UnrealEditor".

## Pointers and strings

- A `UObject` field is a `UPROPERTY` holding `TObjectPtr` (GC sees it, serialization keeps it); a non-owning
  reference that must not keep the object alive — `TWeakObjectPtr`; an owned non-UObject resource —
  `TUniquePtr` / `TSharedPtr`. A raw `UObject*` field without `UPROPERTY` is a dangling pointer after the next GC.
- `FName` for identifiers, map keys and tags (case-insensitive, compared as an index); `FText` for everything a
  player reads — it is what localization gathers, an `FString` shown in UI is never translated; `FString` only
  for building and parsing text, paths and logs.

## New class, manager, data

- A class skeleton and porting Blueprint logic to C++ (Delay → timer, Timeline →
  `UTimelineComponent` with a curve, cosmetics stay in `BlueprintImplementableEvent`) —
  `references/bp-to-cpp.md`.
- "Manager", "singleton", "global class" — a subsystem (`UGameInstanceSubsystem`,
  `UWorldSubsystem` …), not a hand-written singleton. Balance numbers and asset references — in
  `UDataAsset` / `UPrimaryDataAsset` with `EditDefaultsOnly` and `ClampMin`/`ClampMax`.
  Choice and templates — `references/subsystems-data.md`.

## Asset references

- Code that ships has no `/Game/...` paths: no `LoadObject(TEXT("/Game/..."))`,
  no default `FSoftObjectPath(TEXT("/Game/..."))`, no `ConstructorHelpers::FObjectFinder`.
  The cooker cannot see a string in code: the asset lives in the editor and vanishes from the build.
  The slot is a typed `UPROPERTY` (`TSoftObjectPtr`/`TSubclassOf`/`TObjectPtr`) on a Blueprint,
  in `UDeveloperSettings` (config) or in a data asset; each slot has one home.
- Code does not overwrite what a Blueprint or a placed actor set (`BeginPlay`
  with `SetMesh(DefaultMesh)` on top of the value from Details).
- Tests may load by path. Check — ue-content-gates `asset-path-lint.cmd`, if
  installed.

## Modules and editor-only

- A runtime module does not depend on Editor modules (`UnrealEd`, `*Editor`). Editor code —
  in a separate module of `Type: Editor` (or `UncookedOnly` for graph nodes).
- Editor-only API in a runtime module — inside `#if WITH_EDITOR` (`GetDisplayNameText`,
  `GetToolTipText`, `GetMetaData`/`HasMetaData`, `GetAuthoredNameForField`, `PostEditChangeProperty`);
  editor-only fields — `#if WITH_EDITORONLY_DATA`. The Editor build does not show these errors;
  only compiling the game target catches them (`<Project> Win64 Shipping`, no cook, C2039).
  Touched such code — build the game target.
- A type or function another module needs — with `<MODULE>_API`. A dependency visible
  in public headers — in `PublicDependencyModuleNames`, the rest — in `Private`.
- UHT: a `meta` value is at most 1024 characters and is not concatenated from adjacent literals;
  clang-format splits a long string — keep it shorter or move it into per-field `ToolTip`.

## Widgets and CommonUI

Behaviour in C++ (`UCLASS(Abstract)`), `WBP_*` — only the look. Required `BindWidget`
are checked with `check()` in `NativeConstruct`; `BindWidgetOptional` — only for what is
optional by design. A CommonUI screen declares `GetDesiredInputConfig`, and a screen that
returns to the game restores input itself on close. Details and why —
`references/ui-widgets.md`.

## Logs

One category per module (or `DEFINE_LOG_CATEGORY_STATIC` per class), one category per
file, diagnostics behind a console switch that is off by default; errors and
warnings — always. `LogTemp` does not ship: replace it with one question to the user
about names for all files at once. Template and order — `references/logging.md`; category and
switch names are the project's.

## Refactoring, renaming, deletion

Refactoring preserves behaviour. Before renaming or deleting — impact analysis in C++ and
in content; renaming a reflected symbol — with `CoreRedirects`; deletion — only when
both searches are empty. Order and commands — `references/refactoring.md`.

## Comments and style

- Comments in English. The contract is in the header; a comment in `.cpp` is short and
  explains a non-obvious "why" next to its line, never "what".
- Generated files are not edited or committed: `Binaries/`, `Intermediate/`,
  `DerivedDataCache/`, `Saved/`, `.vs/`, generated IDE files, `*.generated.h`.
- Code style — by `.clang-format` and the project's rules. A set of taste rules, if the
  project has none of its own — `references/house-style.md` (taste, not an engine requirement).
- Blueprint surface — only where a designer or a `WBP_*` actually uses it;
  do not trim existing surface without a request.

## Editor tools

A plugin that changes content on call (MCP tool, utility, commandlet) follows the
contract in `references/editor-tool-plugins.md`: declared effect, repeat and rollback, dry-run
for destructive ones, cleanup of what was created on error, verification against the world, not the arguments.

## Done when

It builds the way the project prescribes (or its build skill), it is formatted,
and after touching editor-only surface in a runtime module the game target is built too.
