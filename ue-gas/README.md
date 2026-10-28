# ue-gas

Gameplay Ability System for Unreal Engine 5.x: cheatsheets for writing features, a checklist for reviewing written
code, and a two-level mechanics reference — a working digest and the full GASDocumentation (Tranek) as the primary
source, with corrections for 5.5+ checked against the plugin source. Not tied to any particular project.

## Contents

Paths are relative to the skill folder `skills/ue-gas/`; `.claude-plugin/`, `hooks/hooks.json`, `bin/`, `agents/` live at the plugin root.

| Path | What |
| --- | --- |
| `SKILL.md` | check that GAS is enabled; three modes: write a feature, review code against the checklist, answer a question |
| `references/cheatsheets/01..05_*.md` | ASC and initialisation, attributes and clamping, effects and SetByCaller, abilities and tasks, ExecCalc and tags |
| `references/GAS_WorkingReference.md` | digest of 16 topics with `§N` links into the full document; §15 — diagnosis by symptom |
| `references/GASDocumentation_Tranek.md` | the full GASDocumentation (UE 5.3), read by section number |
| `references/THIRD_PARTY.md` | authorship and MIT licence of GASDocumentation |

Links to other skills are soft: C++ idioms — `ue-cpp-authoring`, engine signatures — `engine-api`
(the `code-analysis` plugin), crash debugging — `code-analysis`.

## Installation

A plugin of the `ue-skills` marketplace (how to add the marketplace — root `README.md`). From the project folder:

```
claude plugin install ue-gas@ue-skills --scope local   :: this project only; the project repository is not changed
claude plugin install ue-gas@ue-skills                 :: every project on the machine
```

Disable — `/plugin` → Installed (space), or `claude plugin disable ue-gas@ue-skills`. After installing —
`/reload-plugins` or a new session. `<skill>` paths below are the plugin's `skills/ue-gas/` folder.

No scripts and no hooks — knowledge only. The full document is large (~330 KB), but only the needed section is
loaded into context.

## Third-party licence

`references/GASDocumentation_Tranek.md` — GASDocumentation, © 2020 Dan Kestranek, MIT licence
(https://github.com/tranek/GASDocumentation); licence text — `references/THIRD_PARTY.md`.
