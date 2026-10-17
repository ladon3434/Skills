---
grounded: 2026-07-23
---

# Engine API — camera & audio

## UComboBoxString::SetSelectedOption

`Source/Runtime/UMG/Public/Components/ComboBoxString.h:139`. Fires `OnSelectionChanged` on a direct set (unlike `USlider::SetValue` / `UCheckBox::SetIsChecked`, which stay silent) — data→UI sync must guard the echo.
