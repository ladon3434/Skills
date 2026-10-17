---
grounded: 2026-09-05
---

# Engine API — world & gameplay framework

## UWorld::SetGameMode

`Source/Runtime/Engine/Classes/Engine/World.h:3951`. A headless test world has no game mode, so `GetAuthGameMode()` is empty; a test that needs it sets `DefaultGameMode` and calls `SetGameMode`.
