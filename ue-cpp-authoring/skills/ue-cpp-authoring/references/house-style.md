# House style (optional taste, not engine requirement)

Use only when the project has no style of its own. The project's `.clang-format` and its documents win.

- Formatting: Allman braces, 4 spaces, long line limit; include order manual (`SortIncludes: false`) —
  the module's own header first in its `.cpp`, then engine headers, then the `.generated.h` last in headers.
- Locals: `auto` / `const auto` where the type is evident from the right-hand side; spell out `auto*` only
  when the project wants pointer-ness visible.
- Loop indices with meaning: `SlotNdx`, `LayerIdx`, not `i`.
- `#pragma region` sections in long `.cpp` files (lifecycle, input, save, debug).
- Settings classes (`UDeveloperSettings`) get a `DisplayName` that sorts them together in Project Settings
  (a common prefix), and a `Category` per area.
- Booleans `b`-prefixed, `UPROPERTY` with `Category`, `ToolTip` (units in the tooltip: cm, s, deg),
  `ClampMin`/`ClampMax` where a range exists, and a default that makes a fresh instance valid.
- A new actor or component class can come with its editor icon (an SVG/PNG registered through a Slate style
  set as `ClassIcon.<ClassName>` / `ClassThumbnail.<ClassName>`) in the same change.
