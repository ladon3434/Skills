---
grounded: 2026-08-09
---

# Engine API cache — packages, asset relocation and worlds on disk (UE 5.8)

Grounded against the UE 5.8 source; the grounding floor is the `grounded:` field above. Paths relative to `Engine/`. Read by
`engine-api.cmd`; a heading is the lookup key, so it must be the bare symbol name.

---

## UPackage::ContainsMap

`Source/Runtime/CoreUObject/Public/UObject/Package.h:744`

```cpp
bool ContainsMap() const;               // PKG_ContainsMap
void ThisContainsMap();                 // :734 — sets the flag
```

`PKG_ContainsMap` is set on a duplicated world by `UWorld::PostDuplicate`
(`Source/Runtime/Engine/Private/World.cpp:1373`) for every non-PIE duplication, so a package that
came out of `DuplicateAsset` already answers `true` — calling `ThisContainsMap()` after a
duplication is dead code. This is the flag to branch on when picking a save extension.

## FPackageName::GetMapPackageExtension

`Source/Runtime/CoreUObject/Public/Misc/PackageName.h:590`

```cpp
static COREUOBJECT_API const FString& GetMapPackageExtension();     // ".umap"
static COREUOBJECT_API const FString& GetAssetPackageExtension();   // ".uasset"
```

`UPackage::SavePackage` writes to whatever filename it is handed and never checks the extension
against `ContainsMap` — a world saved through `LongPackageNameToFilename(Name,
GetAssetPackageExtension())` lands as a valid but `.uasset`-suffixed map. The engine's own save
flow picks the extension from the content instead (`bIsMapPackage ? GetMapPackageExtension() :
GetAssetPackageExtension()`, `Source/Editor/UnrealEd/Private/FileHelpers.cpp:3775`). Any code
calling `SavePackage` directly must make that choice itself.

What a `.uasset`-suffixed world costs: `FEditorFileUtils::IsValidMapFilename`
(`FileHelpers.cpp:2951`) rejects it outright, and the Open Level pickers build their filename with
`GetMapPackageExtension()` hardcoded (`FileHelpers.cpp:670, 968, 1474, 5845`), so the map is
invisible to them. Registry-driven flows still find it — `FPackageName::IsPackageExtension`
accepts both extensions (`Source/Runtime/CoreUObject/Private/Misc/PackageName.cpp:3091`).

## FPackageName::LongPackageNameToFilename

`Source/Runtime/CoreUObject/Public/Misc/PackageName.h:167`

```cpp
static COREUOBJECT_API FString LongPackageNameToFilename(const FString& InLongPackageName,
    const FString& InExtension = TEXT(""));
```

Appends the caller's extension literally, with no validation. With the default empty extension it
yields the absolute path without a suffix — the form to feed `FPaths::GetPath` /
`FPaths::GetCleanFilename` when you need the directory and the leaf separately.

## FPackageName::DoesPackageExist

`Source/Runtime/CoreUObject/Public/Misc/PackageName.h:450` / `:461`

```cpp
static COREUOBJECT_API bool DoesPackageExist(const FString& LongPackageName,
    FString* OutFilename = nullptr, bool InAllowTextFormats = true);
static COREUOBJECT_API bool DoesPackageExist(const FPackagePath& PackagePath,
    bool bMatchCaseOnDisk = false, FPackagePath* OutPackagePath = nullptr);
```

Finds a package under either extension. **`bMatchCaseOnDisk = true` with a null `OutPackagePath` is
not a case test at all** — `TryMatchCaseOnDisk` sets its boolean the moment any case-INsensitive
match exists (`Source/Runtime/CoreUObject/Private/UObject/PackageResourceManagerFile.cpp:322`), and the
case recovery runs only when the out-param is non-null (`:324-332`); even then it never fails on a
mismatch, it just reports the true on-disk case (`PackagePath.cpp:490-544`). So the flag silently
degrades to `false` in the common call shape. To ask whether a file really carries a requested case,
enumerate the directory and compare the leaf case-sensitively.

And the leaf is not enough: the directory components carry a case of their own, so the check has to walk
the whole chain from the mount root down, folder by folder.

`DoesPackageExist` also answers behind the asset registry's bookkeeping: after removing a package
file directly with `IFileManager::Delete` it keeps returning `true` until the folder is rescanned.
Rescan first, probe second — in that order.

## IAssetTools::RenameAssets

`Source/Developer/AssetTools/Public/IAssetTools.h:473`

```cpp
virtual bool RenameAssets(const TArray<FAssetRenameData>& AssetsAndNames) = 0;
```

A case-only rename is detected in `FAssetRenameManager::FixReferencesAndRename`
(`Source/Developer/AssetTools/Private/AssetRenameManager.cpp:1800`) by comparing
`OldPackage->GetFName() == FName(PGN.PackageName)` — `FName` equality is case-insensitive
(`Source/Runtime/Core/Public/UObject/NameTypes.h:629`), so an equal-ignoring-case pair lands in
that branch and is renamed through a temporary name (`:1802-1862`). Two caveats: the branch is
guarded by `!OldPackage->IsRooted()`, and with UE revision control enabled it is refused outright
(`ErrorCaseChangeRenameWithSourceControl`, `:1819-1832`). Return value is `true` unless a rename
actually failed.

## ObjectTools::DeleteAssets

`Source/Editor/UnrealEd/Private/ObjectTools.cpp:2757`, cleanup at `:2501`

`CleanupAfterSuccessfulDelete` removes the package file with `IFileManager::Delete`
(`:2651/2670/2707`) and notifies the registry (`:2599`). It never touches the containing
directory: a folder emptied by deleting or moving its last asset stays on disk. Removing one is a
separate call — `UEditorAssetSubsystem::DeleteDirectory` →
`UE::EditorAssetUtils::DeleteEmptyDirectoryFromDisk`
(`Source/Editor/UnrealEd/Private/Subsystems/EditorAssetSubsystem.cpp:214`). This is why a
case-only rename of a FOLDER cannot be done by moving its assets twice: the old-case directory
survives empty, and the second move lands back inside it.

## UPackageTools::UnloadPackages

`Source/Editor/UnrealEd/Public/PackageTools.h:96`

```cpp
static UNREALED_API bool UnloadPackages(const TArray<UPackage*>& PackagesToUnload,
    FText& OutErrorMessage, bool bUnloadDirtyPackages = false);
```

The lever for the "a live-held package does not delete" trap (`hazards.cmd umap`): a world just
read by `LoadObject` is still in memory, and `DeleteAsset` leaves its file on disk. Unload the
package, then delete the file. It collects garbage, so any `UObject*` into an unloaded package
dangles afterwards — re-`LoadObject` anything you still need.

## UWorld::FindWorldInPackage

`Source/Runtime/Engine/Classes/Engine/World.h:4459`

```cpp
static UE_API UWorld* FindWorldInPackage(UPackage* Package);
```

Reads a level's actors without making it the editor's current level: `LoadPackage` then
`FindWorldInPackage`, and iterate `World->PersistentLevel->Actors` (a `TActorIterator` wants an
initialized world). A world read this way stays in memory — unload its package
(`UPackageTools::UnloadPackages`) when `FindPackage` showed it was NOT already resident; when it was,
it belongs to whoever loaded it.

The failure mode this guards against is fatal, not wrong-answer, and it surfaces at the NEXT map load:
`UEditorEngine::Map_Load` aborts the process with «World Memory Leaks: N leaks objects and packages»
whenever a previous world is still reachable. The log names the culprit — `(standalone) World /Game/…
is not currently reachable but it does have some of GARBAGE_COLLECTION_KEEPFLAGS set`.

## UEditorLoadingAndSavingUtils::SaveMap

`Source/Editor/UnrealEd/Public/FileHelpers.h:75`

```cpp
static UNREALED_API bool SaveMap(UWorld* World, const FString& AssetPath);
```

Save-As for a level, and the ONLY sane way to copy one: load the source as the current level, then
`SaveMap` it under the new package path — the editor's current world becomes the copy and the source
stays on disk untouched. `UEditorAssetLibrary::DuplicateAsset` also produces a `.umap`, but it leaves
the duplicate world resident with `RF_Standalone`, and the next `Map_Load` dies on it (above);
unloading that package afterwards does not reliably clear it. A level-from-template tool
is built on `SaveMap` for exactly this reason.

## IFileManager::FindFiles

`Source/Runtime/Core/Public/HAL/FileManager.h:131` / `:143`

```cpp
virtual void FindFiles(TArray<FString>& FileNames, const TCHAR* Filename, bool Files, bool Directories) = 0;
virtual void FindFiles(TArray<FString>& FoundFiles, const TCHAR* Directory, const TCHAR* FileExtension = nullptr) = 0;
```

Both return bare names, not paths. The second overload with a null extension lists every file in a
directory — the way to read the real on-disk spelling of a name, which no package-name API exposes.
`FString::operator==` is case-insensitive, so a case-sensitive lookup needs
`Equals(..., ESearchCase::CaseSensitive)`, never `TArray::Contains`.

The first overload is the DIRECTORY form: `FindFiles(Out, *(Parent / TEXT("*")), /*Files*/ false,
/*Directories*/ true)` lists a directory's sub-directories under their true spelling — the only way to
test a folder's on-disk case.

## IFileManager::FindFilesRecursive

`Source/Runtime/Core/Public/HAL/FileManager.h:146`.

```cpp
virtual void FindFilesRecursive(TArray<FString>& FileNames, const TCHAR* StartDirectory,
    const TCHAR* Filename, bool Files, bool Directories, bool bClearFileNames = true) = 0;
```

Unlike the two `FindFiles` overloads this returns full paths. `Filename` is a wildcard (`TEXT("*")`).
The cheap way to assert a directory tree really is empty before removing it.

## IFileManager::DirectoryExists

`Source/Runtime/Core/Public/HAL/FileManager.h:119`.

```cpp
virtual bool DirectoryExists(const TCHAR* InDirectory) = 0;
```

## IFileManager::DeleteDirectory

`Source/Runtime/Core/Public/HAL/FileManager.h:125`.

```cpp
virtual bool DeleteDirectory(const TCHAR* Path, bool RequireExists = 0, bool Tree = 0) = 0;
```

`Tree = true` deletes the contents too — it is not an "empty directories only" mode, so anything relying
on the directory being empty must check that itself first. The editor-side alternative
`UEditorAssetSubsystem::DeleteDirectory(const FString&)`
(`Source/Editor/UnrealEd/Public/Subsystems/EditorAssetSubsystem.h:167`) also deletes the ASSETS in the
directory; it is not the tool for removing a directory that was emptied by moving its assets away.

## FPackageName::TryConvertLongPackageNameToFilename

`Source/Runtime/CoreUObject/Public/Misc/PackageName.h:142`.

```cpp
static COREUOBJECT_API bool TryConvertLongPackageNameToFilename(const FString& InLongPackageName,
    FString& OutFilename, const FString& InExtension = TEXT(""));
```

The FOLDER counterpart of `LongPackageNameToFilename`: it maps a package DIRECTORY (`/Game/UI/Keys`) to
its disk directory and returns `false` when the path is not under a mounted root — so it doubles as the
"is this a real content path" test that `LongPackageNameToFilename` (which never validates) is not.

## FAssetData::GetObjectPathString

`Source/Runtime/CoreUObject/Public/AssetRegistry/AssetData.h:352`.

```cpp
FString GetObjectPathString() const;
```

The accessor for a registry row's full object path — `/Game/Path/Name.Name` — as a string, and the one to
call: the `ObjectPath` FName field beside it (`:184`) carries a deprecation marker. This is what a walk over
`GetAssetsByPath` hands to any tool whose argument is an object path; the row's `PackageName` is the package,
one dot short of it.

## IAssetRegistry::RemovePath

`Source/Runtime/AssetRegistry/Public/AssetRegistry/IAssetRegistry.h:782`.

```cpp
virtual bool RemovePath(const FString& PathToRemove) = 0;
```

Drops a FOLDER from the registry's path tree. Deleting every asset under a folder does not remove the folder
itself — the Content Browser keeps drawing it — so a directory emptied on disk needs this call as well, or
the registry keeps a phantom path that later scans re-report.

## IAssetRegistry::GetAssetsByPath

`Source/Runtime/AssetRegistry/Public/AssetRegistry/IAssetRegistry.h:311`.

```cpp
virtual bool GetAssetsByPath(FName PackagePath, TArray<FAssetData>& OutAssetData,
    bool bRecursive = false, bool bIncludeOnlyOnDiskAssets = false) const = 0;
```

`PackagePath` is an `FName`, so the lookup is case-INSENSITIVE: asking for `/Game/…/Keys` returns the
assets registered under `/Game/…/KEYS` too, spelled the way the registry holds them. Never treat a
returned `PackageName` as evidence of the on-disk case.

## FAssetData::IsRedirector

`Source/Runtime/CoreUObject/Public/AssetRegistry/AssetData.h:452`.

```cpp
bool IsRedirector() const;
static bool IsRedirector(UObject* Object);
```

The filter any bulk move needs: `LoadObject` on a redirector's path FOLLOWS it and hands back the
target, so a loop that moves "every asset under this folder" would relocate the wrong assets unless
redirectors are excluded first.
