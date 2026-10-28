# Key remapping, CommonUI and input modes (UE 5.8)

## 1. Player-mappable keys — `UEnhancedInputUserSettings`

`UPlayerMappableInputConfig` is deprecated since 5.3; the current path is the user-settings object that the
local-player subsystem owns. It is created (or loaded from its save slot) when the player's controller changes,
if `bEnableUserSettings` is on (default **true** in 5.8). Access:
`Subsystem->GetUserSettings()` (or `GetUserSettings<UMyUserSettings>()` for a project subclass set in
`UserSettingsClass`).

### Make a mapping remappable
1. Give the Input Action a `PlayerMappableKeySettings` object with a **unique** `Name` (that becomes the
   *mapping name*), `DisplayName`, `DisplayCategory`. Or, per mapping in the IMC, set the setting behaviour to
   `OverrideSettings` with its own settings; `IgnoreSettings` makes that mapping fixed.
2. **Register the context with the user settings**, otherwise the profile has no row for it and
   `MapPlayerKey` fails with `InputUserSettings.FailureReasons.NoMappingRowFound`. Any of:
   - `AddMappingContext(IMC, Priority, Options)` with `Options.bNotifyUserSettings = true` (also unregisters on
     remove);
   - `DefaultMappingContexts` entry with `bRegisterWithUserSettings`;
   - `UserSettings->RegisterInputMappingContext(IMC)` — e.g. for a settings screen that lists keys of contexts
     not currently applied.
   Only mappings that are player-mappable create rows.

### Remap, reset, save
```cpp
UEnhancedInputUserSettings* Settings = Subsystem->GetUserSettings();
FMapPlayerKeyArgs Args;
Args.MappingName = TEXT("Jump");               // PlayerMappableKeySettings->Name
Args.Slot = EPlayerMappableKeySlot::First;     // First, Second, ...
Args.NewKey = EKeys::F;
FGameplayTagContainer Failure;
Settings->MapPlayerKey(Args, Failure);
if (!Failure.IsEmpty()) { /* report: InvalidMappingName / NoKeyProfile / NoMappingRowFound ... */ }
Settings->SaveSettings();                      // or AsyncSaveSettings(); nothing is saved automatically
```

- `MapPlayerKey` broadcasts `OnSettingsChanged` (immediately, or next tick with
  `bDeferOnSettingsChangedBroadcast`); the subsystem listens and requests a mapping rebuild — no manual
  re-add of contexts.
- `UnMapPlayerKey`, `ResetAllPlayerKeysInRow`, `UEnhancedPlayerMappableKeyProfile::ResetToDefault()`,
  `ResetKeyProfileIdToDefault(ProfileId, Failure)`.
- Reading for UI: `Settings->GetActiveKeyProfile()->GetPlayerMappingRows()` → `FKeyMappingRow::Mappings` →
  `FPlayerKeyMapping::GetCurrentKey()/GetDefaultKey()/GetDisplayName()/GetSlot()/IsCustomized()`.
- Conflicts are **not** prevented by `MapPlayerKey`. Check before mapping: `Profile->GetMappingNamesForKey(Key, Out)`
  or the subsystem's `QueryMapKeyInActiveContextSet` (reports hidden/hiding mappings and type
  promotion/demotion).
- Save slot: `InputSettingsSaveSlotName` (default `EnhancedInputUserSettings`) via `UGameplayStatics::SaveGameToSlot`
  with the local player index. To keep it inside your own save system, serialize the object yourself (the class
  is a `USaveGame`).
- Key profiles: `CreateNewKeyProfile`, `SetActiveKeyProfile(Id)`; a mapping can be limited to profiles via
  `SupportedKeyProfileIds`.
- In the rebuild, player-mapped keys replace the IMC's default key for that mapping only when user settings
  are enabled and a profile is active.

## 2. CommonUI interplay

CommonUI and Enhanced Input meet in three places; all of them are off or partial by default.

1. **CommonInput setting `bEnableEnhancedInputSupport`** (default false, Project Settings → Common Input).
   With it on, `UCommonActivatableWidget` shows `InputMapping` + `InputMappingPriority`: the context is added
   on activation and removed on deactivation by the widget itself. Buttons and action widgets can then take a
   `UInputAction` (`TriggeringEnhancedInputAction`, `EnhancedInputAction`) and CommonUI displays its key.
2. **Input config / mode** — `GetDesiredInputConfig()` on the active widget returns `FUIInputConfig` with
   `ECommonInputMode` `Menu` (UI only), `Game` (game only) or `All`. In `Menu` the action router reports
   "block game input" — the blocking is done by **`UCommonGameViewportClient`** rerouting keys before the game
   sees them, so the project's `GameViewportClientClass` must be `CommonGameViewportClient` (or a subclass).
   Exception: in Menu mode game input still passes while the game viewport has mouse capture.
   On a switch to Menu the router also flushes pressed keys (next tick) when `bAutoFlushPressedKeys` is set.
3. **Input-mode tags** — on every mode change the router removes the old and appends the new tags to the
   Enhanced Input input mode: `InputMode.Game`, `InputMode.Menu` (both for `All`). Contexts can react to that
   through their input-mode query (below). This works without `bEnableEnhancedInputSupport`.

Practical pattern for a screen: gameplay context stays applied; the screen's context (back, tab, confirm) comes
through the activatable widget's `InputMapping` at a higher priority; `GetDesiredInputConfig` returns `Menu` so
gameplay keys do not leak. A screen that returns to the game restores the input config itself on deactivation
(`ue-cpp-authoring` covers CommonUI screens).

## 3. Enhanced Input input modes (`bEnableInputModeFiltering`)

- The player input holds a tag container — the *current input mode*, initialised from
  `DefaultInputMode` (`EnhancedInput.Modes.Default` in `BaseInput.ini`).
- Each IMC has `InputModeFilterOptions`: `UseProjectDefaultQuery` (default; the project query in
  `BaseInput.ini` is "all tags match `EnhancedInput.Modes.Default`"), `UseCustomQuery`
  (`InputModeQueryOverride`), `DoNotFilter`.
- During the rebuild a context whose query does not match the current mode is skipped entirely.
- API: `SetInputMode` (**replaces** the container), `AppendTagsToInputMode`, `AddTagToInputMode`,
  `RemoveTagsFromInputMode`, `RemoveTagFromInputMode`, `GetInputMode`. Each requests a rebuild.
- Trap: `SetInputMode(MenuTags)` without `EnhancedInput.Modes.Default` turns off every context on the default
  query. Append/remove, or give contexts explicit custom queries.
- Example: a gameplay IMC with custom query "any of `InputMode.Game`" goes silent while CommonUI is in Menu mode
  and comes back on Game — with no add/remove code. CommonUI pushes no tags before its first input config, so
  also put `InputMode.Game` into `DefaultInputMode`, or that IMC is silent from the start (the first switch
  treats the previous mode as `All` and removes both CommonUI tags, so the default does not linger).

## Verified at

- `UPlayerMappableInputConfig` deprecated 5.3 — `EnhancedInput/Public/PlayerMappableInputConfig.h:23`
- Settings created on controller change; `bEnableUserSettings` default true —
  `EnhancedInput/Private/EnhancedInputSubsystems.cpp:43-50,91-133`, `EnhancedInputDeveloperSettings.cpp:17`
- Mappable = has `PlayerMappableKeySettings`; mapping name from it — `EnhancedInput/Private/EnhancedActionKeyMapping.cpp:48-58,78-81`;
  setting behaviours — `EnhancedInput/Public/EnhancedActionKeyMapping.h:20-28`
- Non-mappable mappings skipped on registration — `Private/UserSettings/EnhancedInputUserSettings.cpp:1692`
- `bNotifyUserSettings` registers/unregisters — `EnhancedInputSubsystemInterface.cpp:292-298,340-346`;
  option default false — `EnhancedInputSubsystemInterface.h:51-55,92-103`
- `MapPlayerKey` failures and `OnSettingsChanged` broadcast — `EnhancedInputUserSettings.cpp:1133-1247`;
  subsystem rebuilds on change — `EnhancedInputSubsystemInterface.cpp:112-126`
- Save/load slot — `EnhancedInputUserSettings.cpp:664-670,756-767`; slot name default —
  `EnhancedInput/Public/EnhancedInputDeveloperSettings.h:95`
- Player keys used in rebuild — `EnhancedInputSubsystemInterface.cpp:995-1016`
- Mapping-query issues — `EnhancedInputSubsystemInterface.cpp:464-565`
- `bEnableEnhancedInputSupport` default false — `Plugins/Runtime/CommonUI/Source/CommonInput/Public/CommonInputSettings.h:114`
- Activatable widget context add/remove — `CommonUI/Public/CommonActivatableWidget.h:229-235`,
  `CommonUI/Private/CommonActivatableWidget.cpp:319-345`
- `ECommonInputMode` — `CommonInput/Public/CommonInputModeTypes.h:11-18`
- Menu blocks via router + viewport client; mouse-capture exception — `CommonUI/Private/Input/CommonUIActionRouterBase.cpp:667,1540-1550`,
  `CommonUI/Private/CommonGameViewportClient.cpp:26-61,122-140`
- Flush on Menu switch — `CommonUIActionRouterBase.cpp:1901-1906`
- Mode tags pushed to Enhanced Input — `CommonUIActionRouterBase.cpp:92-93,1192-1213,2005-2011`; previous mode
  before any config is `All` — `CommonUIActionRouterBase.cpp:876-879,1874`, `CommonUI/Public/Input/CommonUIActionRouterBase.h:94`
- Input mode default and query — `Engine/Config/BaseInput.ini:258-260`; filter options —
  `EnhancedInput/Public/InputMappingContext.h:20-41,131-142`, `Private/InputMappingContext.cpp:69-93`;
  filtering in rebuild — `EnhancedInputSubsystemInterface.cpp:976-986`; `SetInputMode` replaces —
  `EnhancedInputSubsystemInterface.cpp:366-382`; initial mode — `EnhancedPlayerInput.cpp:105`
