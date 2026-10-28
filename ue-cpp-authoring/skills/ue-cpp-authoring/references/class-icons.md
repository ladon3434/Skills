# Class icons from SVG files — an editor module

A small Editor module that gives the project's C++ classes their own icons in the Outliner, Place Actors and the
components list, with no code per class: drop `Resources/ClassIcons/<ClassNameWithoutPrefix>.svg` into the project
or a plugin, restart the editor (or run the rescan command), and the class is drawn with it.

## How the editor finds a class icon

`FSlateIconFinder::FindIconForClass` (SlateCore) builds the key `ClassIcon.<Name>` from the class name without its
C++ prefix (`AMyCheckpoint` → `ClassIcon.MyCheckpoint`) and asks every registered Slate style set for a brush under
it; when none has one, it walks up to the parent class and tries again. Place Actors and the Content Browser ask
for `ClassThumbnail.<Name>` the same way (`FClassIconFinder::FindThumbnailForClass`). So:

- one style set holding `ClassIcon.<Name>` (16 px) and `ClassThumbnail.<Name>` (64 px) brushes, registered with
  `FSlateStyleRegistry`, is all it takes — no customisation per class;
- a Blueprint or C++ child without an icon of its own shows its nearest drawn parent's icon;
- style sets are searched in registry order, so a name that an engine style already uses is not a reliable
  override — name the file after a class of your own.

## The module

The scan reads `Resources/ClassIcons/` (subfolders included) of the project first, then of every enabled plugin;
the first file for a name wins, so the game can redraw a plugin's icon under the same file name.

`.uproject` or `.uplugin` entry — `Type: Editor`, loaded after the engine and Slate are up:

```json
{ "Name": "MyClassIcons", "Type": "Editor", "LoadingPhase": "PostEngineInit" }
```

`MyClassIcons.Build.cs`:

```csharp
PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject" });
PrivateDependencyModuleNames.AddRange(new[] { "Projects", "Slate", "SlateCore" });   // Projects: IPluginManager
```

`MyClassIconsModule.h`:

```cpp
#pragma once

#include "CoreMinimal.h"
#include "Modules/ModuleInterface.h"

class FSlateStyleSet;

/**
 * Every Resources/ClassIcons/<ClassNameWithoutPrefix>.svg of the project and of each enabled plugin becomes that
 * class's icon (ClassIcon.<Name>, 16 px) and thumbnail (ClassThumbnail.<Name>, 64 px). The project is read first,
 * so it can redraw a plugin's icon. New icon: drop the SVG and restart the editor, or run myproject.classicons.rescan.
 */
class FMyClassIconsModule : public IModuleInterface
{
public:
    virtual void StartupModule() override { Register(); }
    virtual void ShutdownModule() override { Unregister(); }

    /** Rebuilds the style set from disk; answers how many icons it registered. */
    static int32 Rescan();

    /** Class name without prefix -> the SVG it is drawn from (for tests). */
    static const TMap<FString, FString>& Icons() { return Registered; }

private:
    static void Register();
    static void Unregister();

    static TSharedPtr<FSlateStyleSet> Style;
    static TMap<FString, FString> Registered;
};
```

`MyClassIconsModule.cpp`:

```cpp
#include "MyClassIconsModule.h"

#include "Brushes/SlateImageBrush.h"
#include "HAL/FileManager.h"
#include "HAL/IConsoleManager.h"
#include "Interfaces/IPluginManager.h"
#include "Misc/App.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"
#include "Styling/SlateStyle.h"
#include "Styling/SlateStyleRegistry.h"

DEFINE_LOG_CATEGORY_STATIC(LogMyClassIcons, Log, All);

TSharedPtr<FSlateStyleSet> FMyClassIconsModule::Style;
TMap<FString, FString> FMyClassIconsModule::Registered;

namespace MyClassIcons
{
const TCHAR* Folder = TEXT("Resources/ClassIcons");

FAutoConsoleCommand RescanCommand(TEXT("myproject.classicons.rescan"),
    TEXT("Re-reads every Resources/ClassIcons folder of the project and the enabled plugins and re-registers the icons."),
    FConsoleCommandDelegate::CreateLambda([]() { FMyClassIconsModule::Rescan(); }));

/** Icon folders in lookup order: the project first, so it can redraw a plugin's icon under the same name. */
TArray<FString> IconFolders()
{
    TArray<FString> Folders;
    Folders.Add(FPaths::ConvertRelativePathToFull(FPaths::ProjectDir() / Folder));
    for (const TSharedRef<IPlugin>& Plugin : IPluginManager::Get().GetEnabledPlugins())
    {
        Folders.Add(FPaths::ConvertRelativePathToFull(Plugin->GetBaseDir() / Folder));
    }
    return Folders;
}
}

int32 FMyClassIconsModule::Rescan()
{
    Unregister();
    Register();
    return Registered.Num();
}

void FMyClassIconsModule::Register()
{
    if (Style.IsValid())
    {
        return;
    }
    Style = MakeShared<FSlateStyleSet>(TEXT("MyClassIconsStyle"));
    Registered.Reset();

    for (const FString& Dir : MyClassIcons::IconFolders())
    {
        if (!IFileManager::Get().DirectoryExists(*Dir))
        {
            continue;
        }
        TArray<FString> Files;
        IFileManager::Get().FindFilesRecursive(Files, *Dir, TEXT("*.svg"), /*Files*/ true, /*Directories*/ false);
        Files.Sort();
        for (const FString& File : Files)
        {
            const FString ClassName = FPaths::GetBaseFilename(File);
            if (Registered.Contains(ClassName))
            {
                continue;   // an earlier folder (the project) already draws it
            }
            Registered.Add(ClassName, File);
            Style->Set(*(TEXT("ClassIcon.") + ClassName), new FSlateVectorImageBrush(File, FVector2D(16.0, 16.0)));
            Style->Set(*(TEXT("ClassThumbnail.") + ClassName), new FSlateVectorImageBrush(File, FVector2D(64.0, 64.0)));
        }
    }

    FSlateStyleRegistry::RegisterSlateStyle(*Style);
    UE_LOG(LogMyClassIcons, Log, TEXT("%d class icon(s) registered"), Registered.Num());
}

void FMyClassIconsModule::Unregister()
{
    if (Style.IsValid())
    {
        FSlateStyleRegistry::UnRegisterSlateStyle(*Style);
        Style.Reset();
        Registered.Reset();
    }
}

IMPLEMENT_MODULE(FMyClassIconsModule, MyClassIcons)
```

The per-file trace (folder scanned, icon registered, name already drawn by an earlier folder) goes behind the
module's log switch — `references/logging.md`.

## A placeable class comes with its icon

A new actor or component class a designer places or adds comes with its
`Resources/ClassIcons/<ClassNameWithoutPrefix>.svg` in the same change, in the module's plugin or in the project.
An abstract base that only groups children may carry the icon for all of them instead.

## SVG style

One look for the whole set keeps the Outliner readable at 16 px. A style that works:

- a `0 0 64 64` viewBox, outline only: `fill="none"`, `stroke-width="4"`, `stroke-linecap="round"`,
  `stroke-linejoin="round"`;
- one stroke colour per group of classes, so the group reads before the shape. The groups are the project's;
  an example palette (Monokai) — save points `#A6E22E`, devices `#E6DB74`, signals and receivers `#66D9EF`,
  hazards `#F92672`, characters `#AE81FF`, interaction `#FD971F`, notes `#F8F8F2`;
- few strokes: detail below 4 px of the 64 px canvas vanishes at 16 px.

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" stroke="#E6DB74"
     stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
  <rect x="12" y="20" width="40" height="32" rx="4"/>
  <path d="M22 20v-6a10 10 0 0 1 20 0v6"/>
</svg>
```

## Test

Two checks keep the convention honest (CQTest, editor-only, in a test module or under `Private/Tests`):

- every registered file names a loaded class, and `FSlateIconFinder::FindIconForClass` answers our style set and
  `ClassIcon.<Name>` for it — a misspelt file name is an icon the editor never asks for;
- every placeable class of the project's modules (an `AActor` child without `CLASS_Abstract` /
  `CLASS_NotPlaceable`, a `UActorComponent` child with `BlueprintSpawnableComponent`, whose package is
  `/Script/<OneOfOurModules>`) is drawn by our style set — its own icon, or an inherited one where the rule above
  allows it.

```cpp
#if WITH_AUTOMATION_TESTS && WITH_EDITOR
#include "CQTest.h"
#include "MyClassIconsModule.h"
#include "Styling/SlateIconFinder.h"

TEST_CLASS(ClassIcons, "MyProject.Editor.ClassIcons")
{
    TEST_METHOD(EveryFileHasItsClass)
    {
        for (const TPair<FString, FString>& Icon : FMyClassIconsModule::Icons())
        {
            const UClass* Class = FindFirstObject<UClass>(*Icon.Key, EFindFirstObjectOptions::NativeFirst);
            if (!Assert.IsNotNull(Class, *FString::Printf(TEXT("%s names a class"), *Icon.Value)))
            {
                continue;
            }
            const FSlateIcon Found = FSlateIconFinder::FindIconForClass(Class);
            (void)Assert.AreEqual(FName(TEXT("MyClassIconsStyle")), Found.GetStyleSetName());
            (void)Assert.AreEqual(FName(*(TEXT("ClassIcon.") + Icon.Key)), Found.GetStyleName());
        }
    }
};
#endif
```

The test module adds `CQTest` (and `Slate`/`SlateCore`) to its dependencies under `Target.bBuildEditor`.
