# `.claude/content-gates.json` — project configuration of the gates

Optional. Lives at `<project>/.claude/content-gates.json`. Every key is optional.

```json
{
  "forbiddenRefs": [
    { "prefix": "/Game/Developers/", "why": "per-user sandbox" },
    { "prefix": "/Game/_Quarantine/", "why": "gitignored and deletable" },
    {
      "prefix": "/Engine/",
      "kinds": ["map"],
      "allow": ["/Engine/EditorResources/", "/Engine/EngineMaterials/", "/Engine/EngineSky/",
                "/Engine/EngineResources/LandscapeVisibilityLayerInfo"],
      "gameOnly": true,
      "why": "levels use our own meshes, not engine sample content"
    }
  ],
  "cookCheck": {
    "maps": ["/Game/Maps/Title", "/Game/Maps/Level_0"],
    "assets": ["/Game/Core/DA_GameData"],
    "dirs": ["/Game/UI/Fonts/"],
    "configFiles": ["DefaultGame.ini", "DefaultEngine.ini"],
    "ignoreMissing": ["/Game/Developers/", "/Engine/EditorResources/"]
  }
}
```

## `forbiddenRefs` (ref-lint)

| Key | Meaning |
| --- | --- |
| `prefix` | A package whose name starts with it may not be referenced (case-blind). Required. |
| `allow` | Prefixes under `prefix` that are allowed after all. |
| `from` | Judge only packages whose own name starts with one of these (default: every package). |
| `kinds` | `["map"]` or `["asset"]`: judge only levels or only non-level packages. |
| `gameOnly` | `true`: ignore references the asset registry marks editor-only (they are not cooked). Default `false`: any reference counts. |
| `why` | Printed with each finding. |

A package that itself lives under `prefix` is never judged by that rule. No file, or no
`forbiddenRefs` key: one built-in rule, `/Game/Developers/`. Command-line `--forbid` replaces the
file's rules for that run; `--print-config` shows what is in force.

Engine content (`/Engine/...`) that a level references IS cooked: forbidding it is a project's
policy (own art only, or size), not an engine requirement. Editor-only engine references
(`EditorResources` sprites, the `WorldGridMaterial` fallback) show as `editor-only` in the output.

## `cookCheck` (cook-check)

| Key | Meaning |
| --- | --- |
| `maps`, `assets` | Reference roots, in addition to `--map` / `--asset`. |
| `dirs` | Folders whose every package is a root (like `DirectoriesToAlwaysCook`). |
| `configFiles` | Config files under `Config/` whose object paths are roots. Default `DefaultGame.ini`, `DefaultEngine.ini` — the files a cooked game reads its settings from. `ProjectPackagingSettings` `MapsToCook` / `DirectoriesToAlwaysCook` there are roots too. |
| `ignoreMissing` | Package prefixes never reported as missing or unresolved. |

`DefaultEditor.ini` is the editor's own file (its asset-viewer profiles are never cooked) and is not a
default root file.
