# Pre-release audit — what each check means

`<skill>\scripts\release-preflight.cmd [--project <dir>] [--platform Windows] [--require-pso] [--only meta,branding,pso,debug]`
Reads files only. Exit 0 — no FAIL (WARN allowed), 1 — at least one FAIL, 2 — no project.

## Metadata — `Config/DefaultGame.ini`, `[/Script/EngineSettings.GeneralProjectSettings]`

| Key | FAIL / WARN when | Why |
| --- | --- | --- |
| `ProjectVersion` | missing or `1.0.0.0` (FAIL) | the template value; crash reports and saves cannot tell builds apart |
| `CompanyName` | missing, `MyCompany`, `Epic Games` (FAIL) | goes into the exe's version info and the save path on some platforms |
| `ProjectDisplayedTitle` | missing (WARN) | window title falls back to the project name |
| `CopyrightNotice` | missing (WARN) | exe version info |

Edit in Project Settings > Project > Description, not by hand: the title is an `NSLOCTEXT` value.

## Branding (Windows)

| File | Read by | Missing |
| --- | --- | --- |
| `Build/Windows/Application.ico` | UBT, embedded into the game exe | FAIL — the exe shows the Unreal icon |
| `Content/Splash/Splash.{png,jpg,bmp}` | `FGenericPlatformSplash` in the game | FAIL — the engine splash shows |
| `Content/Splash/EdSplash.{png,jpg,bmp}` | the same, in the editor | WARN — editor only |

The splash lookup tries `.png`, `.jpg`, then falls back to `.bmp` (UE 5.8 `GenericPlatformSplash.cpp`).
Splash display can be off entirely (`Project Settings > Windows > Splash`); then the files do not matter.

## Debug code in Shipping

Scanned: C++ of every module whose type is not `Editor*`, `UncookedOnly`, `Developer*` or `Program` (from the
`.uproject` and every `.uplugin` under `Plugins/`), skipping `ThirdParty/` and `Tests/` folders.

A line counts as guarded inside `#if` / `#ifdef` branches on `UE_ENABLE_DEBUG_DRAWING`, `ENABLE_DRAW_DEBUG`,
`WITH_EDITOR`, `!UE_BUILD_SHIPPING`, `UE_WITH_CHEAT_MANAGER`, `WITH_(DEV_)AUTOMATION_TESTS`, `UE_BUILD_DEBUG`,
`UE_BUILD_DEVELOPMENT`, `ALLOW_CONSOLE`, `!NO_LOGGING`, `WITH_CHEATS` (and the `#else` of `#if UE_BUILD_SHIPPING`).
The scanner does not evaluate expressions: a guard written another way shows up as a finding — read it, do not
"fix" it blindly.

| Finding | Level | Why |
| --- | --- | --- |
| any `DrawDebug*` unguarded when the project defines `SHIPPING_DRAW_DEBUG_ERROR=1` | FAIL | that define takes the `#else` branch of `DrawDebugHelpers.h` (UE 5.8), which has no stubs at all — Shipping does not compile |
| `DrawDebugLine/Box/Sphere/String/2DDonut/Canvas2D*/…`, `FlushPersistentDebugLines` unguarded (summed per file) | WARN | compiles: with `ENABLE_DRAW_DEBUG` off (`UE_ENABLE_DEBUG_DRAWING` is `!(UE_BUILD_SHIPPING \|\| UE_BUILD_TEST) \|\| WITH_EDITOR`, `EngineDefines.h`) every free function of `DrawDebugHelpers.h` (UE 5.8) gets an empty inline stub. The call does nothing, but its arguments are still computed — a string built for `DrawDebugString`, a trace or a loop that only feeds the drawing. Wrap hot paths in `#if ENABLE_DRAW_DEBUG` |
| `UFUNCTION(Exec)` | WARN | compiled in, but the console is off in Shipping (`ALLOW_CONSOLE_IN_SHIPPING 0`); unreachable unless the project turns it on — then it is a cheat |
| `FAutoConsoleCommand/Variable`, `RegisterConsoleCommand` | WARN | registered in Shipping; still callable from code and config even without a console |
| `AddOnScreenDebugMessage` | WARN | debug text players may see |
| `UCheatManager` subclasses | not reported | `UE_WITH_CHEAT_MANAGER` is `!UE_BUILD_SHIPPING` by default |

Fix: wrap the call (and the variables only it uses) in `#if UE_ENABLE_DEBUG_DRAWING` / `#if !UE_BUILD_SHIPPING`,
then prove it with a Game-target Shipping compile.

## Packaging — fallback command line

Only when the project has no script or launcher profile of its own, and after the owner agrees:

```
"<UE>\Engine\Build\BatchFiles\RunUAT.bat" BuildCookRun -project="<path>\<Project>.uproject" -platform=Win64
  -clientconfig=Shipping -build -cook -stage -pak -iostore -package -archive -archivedirectory="<out>" -nop4 -utf8output
```

Add `-prereqs` to ship the VC++ redistributable installer; `-nodebuginfo` to leave PDBs out of the archive (keep
them elsewhere for crash symbolication).
