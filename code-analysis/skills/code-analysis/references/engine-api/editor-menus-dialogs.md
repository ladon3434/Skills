---
grounded: 2026-09-06
---

# Engine API — modal dialogs (UE 5.8)

## SGenericDialogWidget::OpenDialog

`Source/Editor/UnrealEd/Public/Dialogs/Dialogs.h:242`. Only an OK button: a window closed by its cross runs no delegate. `STextEntryPopup` is not an alternative — it lives in a menu stack and is not modal.
