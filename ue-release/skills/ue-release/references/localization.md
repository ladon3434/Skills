# Localization coverage

`<skill>\scripts\loc-check.cmd [--project <dir>] [--target <Name>] [--gather [--dry-run]] [--code] [--max 20]`
Exit 0 — every target culture complete, 1 — missing translations / unreadable archive / failed gather,
2 — no localization target, 3 — gather refused (an editor of this project runs).

## Where things are

| What | Where |
| --- | --- |
| Targets (dashboard) | `[/Script/Localization.LocalizationSettings]` in `DefaultEditor.ini` / `DefaultGame.ini` |
| Generated configs | `Config/Localization/<Target>_Gather.ini` (+ `_Compile`, `_Export`, `_Import`, …) — "generated, do not edit" |
| Native culture, cultures | `[CommonSettings] NativeCulture=`, `CulturesToGenerate=` in `<Target>_Gather.ini` |
| Manifest / archives | `Content/Localization/<Target>/<Target>.manifest`, `<culture>/<Target>.archive` (JSON, usually UTF-16 LE + BOM) |
| Compiled text | `<culture>/<Target>.locres` — what ships |

An archive entry is `{Source:{Text}, Translation:{Text}, Key}` under `Children`, nested in `Subnamespaces`. For a
target culture an empty translation or one equal to the source is untranslated; the native culture is exempt.
Equal-to-source can be legitimate (proper names, numbers) — the owner decides, the check only lists them.

## Gather

`--gather` runs `UnrealEditor-Cmd <uproject> -run=GatherText -config=Config/Localization/<Target>_Gather.ini`. It
rewrites the manifest and archives (a project change, commit it with the translations) and does not compile
`.locres` — the dashboard's *Compile Text* or the `_Compile.ini` config does. The configs hold absolute-ish paths to
the engine's own manifests (`ManifestDependencies=`): after an engine upgrade reopen the dashboard and save, or
gather reads the old engine's manifests.

## C++ rules

- Player-facing text: `LOCTEXT("Key", "Text")` with `#define LOCTEXT_NAMESPACE "Area"` near the top of the `.cpp`
  and `#undef LOCTEXT_NAMESPACE` at the end; or `NSLOCTEXT("Namespace", "Key", "Text")` anywhere (headers, config
  classes). A missing `#undef` leaks the namespace into the next file of a unity blob — wrong keys, or a
  redefinition warning.
- `FText::FromString("literal")` is never gathered: fine for debug and editor-only text, a localization bug for
  anything a player reads. `FText::Format` with a `LOCTEXT` pattern for composed text; `FText::AsNumber`/`AsPercent`
  for numbers.
- String tables (`LOCTABLE`, `.csv` string tables) are gathered too — prefer them for text designers edit.

`--code` reports literal `FText::FromString`, unbalanced `LOCTEXT_NAMESPACE` define/undef in a `.cpp`, and
`LOCTEXT` in a `.cpp` with no namespace defined. It does not know which text a player sees — read each finding.
