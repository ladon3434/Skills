# Logging and diagnostics — the pattern

The names (categories, switches, settings) are the project's. The shape is generic.

## One category per module

```cpp
// MyGame.h (module header, included by the module's sources)
DECLARE_LOG_CATEGORY_EXTERN(LogMyGame, Log, All);

// MyGame.cpp
DEFINE_LOG_CATEGORY(LogMyGame);
```

A plugin module logs through its own category, never through the game's. A category per feature is fine
when the feature needs its own verbosity control (`log LogMyGameSave Verbose` at the console).

A category local to one class — `DEFINE_LOG_CATEGORY_STATIC(LogMyClass, Log, All);` at the top of its `.cpp`,
after the includes. It pollutes no header; use `DECLARE_LOG_CATEGORY_EXTERN` only for a category several files
share (a module, or a feature whose output must be filtered as one, e.g. a test harness).

One file, one category: once a `.cpp` has its category, every `UE_LOG` in it uses that one.

## `LogTemp` cleanup

`LogTemp` does not ship. Replacing it:

1. Collect first: `rg -n "UE_LOG\(LogTemp" Source Plugins` — grouped by file.
2. A file that already has its own category — replace silently, nothing to ask.
3. Otherwise the category name is the user's call: propose names (`LogMyClass` from the class) for all files
   **in one message**, not file by file; a line that was only debug noise may be removed instead — ask.
4. Make every change, then build once at the end (a category swap inside one `.cpp` breaks nothing but typos).

## Always-on lines

Errors and warnings are logged regardless of any switch: a missing required asset, a refused action, an
unexpected state. The line names the object (`GetNameSafe(this)` / the owning actor), the slot or argument,
and the reason — enough to act on without a debugger.

```cpp
UE_LOG(LogMyGame, Error, TEXT("%s: ImpactSound is not set - no sound on hit"), *GetNameSafe(this));
```

`UE_LOGFMT` (`Logging/StructuredLog.h`, 5.2+) is the structured alternative:
`UE_LOGFMT(LogMyGame, Warning, "{Owner}: slot {Slot} empty", GetNameSafe(this), SlotName);`

## Diagnostic lines behind a switch

Part of "done", not an extra: every mechanic logs the numbers a run needs to be diagnosed without a human
describing what happened — inputs, chosen branch, computed values, the reason for a refusal (`focus Door_3 at
212 cm, max 150 - refused`, not `interaction failed`). Those lines sit behind a switch that is off by default and
is turned on from the console; code without them is not finished. Per-frame or per-event tracing is off by
default and costs nothing when off:

```cpp
// One console variable per area, off by default.
static TAutoConsoleVariable<bool> CVarLogInteraction(
    TEXT("mygame.log.interaction"), false, TEXT("Log every focus / press / refusal of the interaction system."));

// The macro evaluates its arguments only while the switch is on.
#define MYGAME_LOG(CVar, Verbosity, Format, ...) \
    do { if (CVar.GetValueOnGameThread()) { UE_LOG(LogMyGame, Verbosity, Format, ##__VA_ARGS__); } } while (0)

MYGAME_LOG(CVarLogInteraction, Log, TEXT("focus %s at %.0f cm"), *GetNameSafe(Target), Distance);
```

Which form of switch depends on the module:
- **runtime module** — read a plain bool where it logs (the macro above reads the console variable; a
  `UDeveloperSettings` field mirrored into a bool works too). Do not lean on a console-variable change callback:
  a Shipping build has no console to fire it from;
- **editor module** — one console variable per module whose change callback raises the module's category to
  `Verbose`; the module writes its numbers at `Verbose`, so a run with the switch on keeps them and a run without
  it stays quiet:

```cpp
// The category is declared with default verbosity Log, compile-time All: DECLARE_LOG_CATEGORY_EXTERN(LogMyTools, Log, All).
static TAutoConsoleVariable<bool> CVarMyToolsLog(TEXT("mytools.log"), false,
    TEXT("Log the numbers of every MyTools run. Off by default; 1 raises LogMyTools to Verbose."),
    FConsoleVariableDelegate::CreateLambda([](IConsoleVariable* Var)
    { LogMyTools.SetVerbosity(Var->GetBool() ? ELogVerbosity::Verbose : ELogVerbosity::Log); }));

UE_LOG(LogMyTools, Verbose, TEXT("%s: %d asset(s) scanned, %d rewritten"), *ToolName, Scanned, Rewritten);
```

Variants that work well:
- the switches also as checkboxes in a `UDeveloperSettings` page (mirrored into the console variables), so a
  designer can turn them on without the console;
- a `.draw.` twin for debug drawing (`mygame.draw.interaction`) next to each `.log.` switch;
- a periodic summary line (frame time every few seconds) to compare before and after a change.

## Reading logs

The editor writes `Saved/Logs/<Project>.log`; a second editor instance of the same project writes
`<Project>_2.log`. A headless run should pass its own `-ABSLOG=<path>` so it never collides with the GUI
editor's file.
