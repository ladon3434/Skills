# ue-systems

Unreal Engine 5.8 gameplay frameworks, one skill each: how to set them up, write C++ for them, review that code and
avoid their traps. Knowledge skills without scripts; every non-obvious claim was checked against the 5.8 engine
source, and each reference ends with a "Verified at" list (file:line). Not tied to any particular project.

## Skills

Paths are relative to `skills/<skill>/`.

| Skill | What |
| --- | --- |
| `enhanced-input` | Enhanced Input in 5.8 C++: contexts and possession timing, BindAction and ETriggerEvent semantics, triggers/modifiers, key remapping, CommonUI routing, debugging and input injection for tests, review checklist |
| `state-tree` | StateTree in 5.8: schemas, states, transitions, bindings, events; C++ tasks, conditions and evaluators; running it on an actor or AI controller; Rewind Debugger, logs; review checklist and traps |
| `pcg` | PCG in 5.8: components, graphs, data, triggers and runtime generation, partition/HiGen, seeds, custom C++/Blueprint nodes, GPU and cache, debugging, review checklist and editor-vs-build traps |

Links to other skills are soft: C++ idioms — `ue-cpp-authoring`, engine signatures — `engine-api` (the
`code-analysis` plugin), tests — `ue-build-test`.

## Installation

A plugin of the `ue-skills` marketplace (how to add the marketplace — root `README.md`). From the project folder:

```
claude plugin install ue-systems@ue-skills --scope local   :: this project only; the project repository is not changed
claude plugin install ue-systems@ue-skills                 :: every project on the machine
```

The three skills load only by their descriptions: a project without StateTree or PCG pays only for the description
lines (about 700 tokens for all three).
