# Where to look outside the project

For research (`references/research.md`) and the `engine-reader` agent. Findings are cited in the report,
never copied into this file. Every web finding carries an engine version or a date stamp: much of the web
is UE4-era, and an answer without a stamp is not evidence for the engine the project uses.

## Official

- `dev.epicgames.com/documentation/en-us/unreal-engine`, `dev.epicgames.com/community`, the release notes of
  each engine version, the public roadmap. Experimental and Beta features are named in the release notes; read
  their maturity there.
- Engine source — `<engine>/Engine/Source` and `Engine/Plugins` (the root from
  `node <skill>/scripts/mjs/ue-engine.mjs`); the engine's own templates ship in `<engine>/Templates`.
- Known engine bugs — `issues.unrealengine.com`; the shared and the project's hazards — `hazards.cmd <words>`.

## Epic samples

Runnable sample projects, read from `UE_SAMPLES_ROOT` (one folder per sample; unset — no samples on this
machine). Read them through `engine-reader`, not in the main context.

| Sample | Reference for |
| --- | --- |
| Lyra | GAS, Enhanced Input, equipment and inventory, Game Features, CommonUI; multiplayer-first — say so when that shapes the answer |
| Content Examples | one example map per subsystem: Niagara, animation, materials and Substrate, PCG, audio; StateTree and EQS templates |
| City Sample | Chaos vehicles and traffic, World Partition, HLOD, Mass crowds; very large (~95 GB), and its Fab listing may stop at an older engine version — read it as source |
| Electric Dreams | a PCG-driven environment |
| Cropout | CommonUI menus and HUD, the save flow |
| Game Animation Sample | Motion Matching, traversal (mantle, vault) |
| Project Titan | an open-world environment under the Fab Standard licence, usable commercially |

Rejected as references: VehicleGame, ShooterGame, ActionRPG (UE4-era), Stack-O-Bot, Valley of the Ancient.
Before copying a pattern out of a sample, check its licence; a sample not listed here is proposed to the
person, who downloads it, and then it gets a row.

## Community and experts

- `forums.unrealengine.com`, Unreal Slackers, `r/unrealengine`, Stack Overflow / GameDev StackExchange.
- `tomlooman.com` (C++, GAS), `benui.ca` (UMG and Slate, specifiers), `unrealcommunity.wiki`, GDC and
  Unreal Fest talks (note the year).
- Other engines and papers only when UE material is thin, marked as cross-domain.
- A site that answers 403 to a fetch tool (gameuidatabase.com, for one) often opens with `curl` given a
  browser User-Agent and a referer.
