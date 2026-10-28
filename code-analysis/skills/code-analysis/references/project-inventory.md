# Whole-project analysis: inventory and measures

For an analysis whose subject is the whole project (`SKILL.md`, "A large subject"). The inventory comes
first and sets the fan-out; the directions below add what the code axes do not see. Every command only
reads and runs from the project root in Git Bash; every finding carries a count, a path or a commit and is
scored on the 0–3 scale of `SKILL.md`.

Measuring notes:

- `rg` over `.uasset`/`.umap` needs `-a --no-config` (`-a`: the files are binary; `--no-config`: a user
  ripgrep config can hide every match). A hit is a candidate, not proof: a count a score rests on is
  confirmed by the full name, a second marker, or in the editor.
- Merge each person's git aliases (name and e-mail variants; bots out) before counting people, areas or
  shares. List the variants with `git shortlog -sne --no-merges HEAD`, write the merges into a mailmap file
  OUTSIDE the repository, and count with `git -c mailmap.file=<that file> …` (`%aN`/`%aE` and `shortlog`
  follow it).
- People appear only as facts about areas (who holds what); no finding ranks or blames a person.

## Inventory

- **Engine** — `rg -o '"EngineAssociation":\s*"[^"]*"' *.uproject`. A version string (`5.8`) is a launcher
  build; a GUID or a path is a source or forked engine: find out what was changed in it and who can account
  for it (`ue-engine.mjs` resolves such an engine only through `UNREAL_HOME`).
- **Plugins and modules** — the `Plugins` and `Modules` lists of the `.uproject`, the `Plugins/` folder,
  the dependencies of `Source/*/*.Build.cs`.
- **Code size** — `rg --files -0 -g "*.h" -g "*.cpp" Source Plugins | xargs -0 cat | wc -l`; the largest
  files (god-class candidates) — `rg --files -0 -g "*.cpp" Source | xargs -0 wc -l | sort -rn | head -20`.
- **Content** — files `rg --files -g "*.uasset" -g "*.umap" Content | wc -l`, weight `du -sh Content`.
- **History** — commits `git rev-list --count HEAD`; span `git log --reverse --format=%ad --date=short | head -1`
  and `git log -1 --format=%ad --date=short`; contributors `git shortlog -sn --no-merges HEAD | wc -l`
  (after merging aliases).
- **Version control** — git LFS (`.gitattributes`, `git lfs ls-files | wc -l`) or Perforce / Plastic; the
  history commands below adapt to it.

## Content taxonomy

- **Structure** — `ls Content`: shared roots by meaning (characters, environment, UI, maps, shared) or bought
  packs left at the root as they came; a root folder named like a marketplace pack is a finding.
- **Root clutter** — assets lying directly in `Content/`: `rg --files --max-depth 1 -g "*.uasset" -g "*.umap" Content | wc -l`.
- **Duplicates** — skeletons and master materials doing the same job. Skeletons by class marker:
  `rg -a --no-config -l "/Script/Engine.Skeleton" Content -g "*.uasset"`; masters against instances:
  `rg -a --no-config -l "MaterialInstanceConstant" Content -g "*.uasset" | wc -l` against the files whose
  class is `Material` (read the class with a `.uasset` header reader — `ue-content-gates` — since the bare
  word `Material` matches every instance too).
- **Default and throwaway names** — `NewMaterial_3`, `BP_Enemy_Test2`, `Untitled_1.umap`:
  `rg --files -g "*.uasset" -g "*.umap" Content | rg -i "new|copy|test|untitled|_old|final|\d\.u(asset|map)$"`.
  Prefix conventions as a whole — `ue-content-gates`.
- **Dead weight** — leftover redirectors (`rg -a --no-config -l "ObjectRedirector" Content -g "*.uasset"`),
  broken references after moves, assets nothing references; an unreferenced-asset list is a size read, not
  a delete list — confirm in the editor.

## Code measures

The UE-trap and home-grown-system checks are in `SKILL.md`; their counts:

- standard engine systems present or not — `rg -n "GameplayAbilities|StateTreeModule|EnhancedInput|CommonUI|PoseSearch|MotionWarping|SmartObjects|MassEntity" -g "*.Build.cs" Source`;
  hand-rolled state machines — `rg -n "enum class E\w*State\b" Source`;
- `Tick` and casts — `rg -c "bCanEverTick\s*=\s*true" Source`, `rg -c "Cast<" Source`;
- automated tests — `rg -l "IMPLEMENT_(SIMPLE|COMPLEX)_AUTOMATION_TEST|BEGIN_DEFINE_SPEC|TEST_CLASS|AFunctionalTest" Source Plugins`,
  set against the key mechanics;
- **committed binaries** — `git ls-files | rg -i "\.(exe|dll|pdb|lib|so|dylib)$|^(Binaries|Intermediate|Saved|DerivedDataCache)/"`
  (a plugin's shipped `Binaries/` may be deliberate — name it, do not assume).

Blueprints for the keep / move / delete sort — Blueprint classes
`rg -a --no-config -l "BlueprintGeneratedClass" Content -g "*.uasset" | wc -l`, Widget Blueprints
(`WidgetBlueprintGeneratedClass`), Anim Blueprints (`AnimBlueprintGeneratedClass`); graph size proxy — the
heaviest ones, `rg --files -0 -g "*.uasset" Content | xargs -0 ls -s | sort -rn | head -30`.

## Process

- **Rhythm** — commits per month: `git log --no-merges --format=%ad --date=format:%Y-%m | sort | uniq -c`.
- **Revert and fix share** — against the total `git log --no-merges --oneline | wc -l`:
  `git log --no-merges --oneline -i --grep=revert | wc -l`,
  `git log --no-merges --oneline -i -E --grep="fix|bug|hotfix" | wc -l`. A fix share that grows over time is
  the signature of "a new feature breaks the old ones"; hot spots by history are in `SKILL.md`.
- **Bus factor per area** — how many people ever touched each top-level folder:
  `for d in Source/*/ Plugins/*/ Content/*/; do echo "$(git log --no-merges --format=%aN -- "$d" | sort -u | wc -l) $d"; done | sort -n | head -20`.
  An area one person knows is a finding; it is reported per area, never as a ranking of people.
- **Infrastructure** — commit hooks (`core.hooksPath`, `.githooks/`), CI (`.github/workflows`, `.gitlab-ci.yml`,
  `Jenkinsfile`, BuildGraph `.xml`), whether tests run anywhere but on a person's machine, task ids in commit
  messages.

## Design against implementation

The compliance axis of `SKILL.md`, at the scale of features: every feature of the design gets one status —
absent · partial · works · works not as designed — from the code and content it needs, with a `file:line`,
an asset or a named absence. Then the share done, the list of places where code and design say different
things, the design documents that contradict each other or describe what is gone, and where the project
stands against the whole game (prototype, vertical slice, content production).
