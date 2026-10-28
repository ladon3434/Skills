# cook-check — reading the result

## What is compared

1. **Expected** — the dependency closure of the roots: maps and assets named on the command line or in
   `cookCheck`, object paths in `DefaultGame.ini` / `DefaultEngine.ini` (settings slots such as
   `GameDefaultMap`, a widget class, a sound list), and the packaging settings' `MapsToCook` /
   `DirectoriesToAlwaysCook`.
   - Offline (default): hard references from each package's import table plus soft references from its
     soft package list, following only references the asset registry marks **used in game**. A World
     Partition map also pulls its `__ExternalActors__` / `__ExternalObjects__` packages. Engine and
     engine-plugin content is followed when the engine is found (`UNREAL_HOME` or the Epic registry
     entry for the project's `EngineAssociation`).
   - `--editor-closure`: the editor's asset registry (`py/cook-closure.py` in
     `UnrealEditor-Cmd -run=pythonscript`). It follows hard + soft references without the game filter,
     so it is a superset of the offline set.
2. **Cooked** — `Saved/Cooked/<Platform>/<Project>/Metadata/ReferencedSet.txt` (a Zen-store cook writes
   no loose package files; this list is lower-case) or, for a loose cook, the `.uasset`/`.umap` files
   under `Saved/Cooked/<Platform>`. `--cooked <dir>` points elsewhere.
3. **Missing** = expected, on disk, not cooked. **Unresolved** = referenced but not on disk even for the
   editor (a deleted or moved asset someone still points to — fix the referencer).

## Reading it

- `WARNING N expected package(s) are newer than the cook` — the cook is stale; every asset added after it
  shows as missing. Recook before believing MISSING.
- `MISSING slot <file> <key>` — a config slot whose asset did not cook. Usually the slot is read only at
  run time by a path the cooker never sees: make it a typed soft reference in a settings class, or list the
  asset/folder in `DirectoriesToAlwaysCook` / the Asset Manager's primary asset rules.
- Missing rows of editor-only classes (`EditorUtilityWidgetBlueprint`, `EditorUtilityBlueprint`, thumbnail
  sources) are expected: the cooker strips editor-only content. Add their prefix to `ignoreMissing`.
- Missing rows reached through a soft reference are the classic loss: the editor loads them on demand, the
  cook skipped them because nothing hard-references them from a cooked root.
- `/Engine/...` content referenced by a map **is** cooked; an `/Engine/` row in MISSING means the engine
  content was not reached from the cook's roots, not that engine content is never packaged.

## Exit codes

`0` OK · `1` FAILED (missing, unresolved, or a root/slot not cooked) · `2` UNKNOWN (no cook present, no
roots, no Python, an editor or a build that is not ours is running). The last stdout line is `RESULT: cook-check <verdict> (exit N)`,
which survives a pipe through `tail`.

## Starting an editor process (`--cook`, `--editor-closure`)

Both run `UnrealEditor-Cmd.exe <uproject> ... -unattended -nosplash -nullrhi -stdout`. The script:
- checks the machine rule first (`scripts/mjs/ue-owner.mjs`, `canLaunch`) and refuses with exit 2 while
  - an editor of this project runs, whoever started it: a second editor process of the same project holds the
    same packages and a person's save fails;
  - an editor of another project runs that this session did not start (one editor per machine);
  - a build that is not ours runs (UnrealBuildTool outside this session's process tree);
- refuses as well when the process query fails — nothing is started blind;
- needs no ownership marker: the commandlet runs inside this call and ends with it.
`--plan` prints the exact command lines without running anything.
