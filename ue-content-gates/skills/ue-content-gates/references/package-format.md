# Editor package format (UE 5.x) — what `py/uasset.py` (and its node port `mjs/uasset.mjs`) reads

Verified against UE 5.8 source: `CoreUObject/Private/UObject/PackageFileSummary.cpp`,
`CoreUObject/Private/UObject/ObjectResource.cpp` (`FObjectImport`), `AssetRegistry/Private/PackageReader.cpp`
(`ReadPackageDataMain`, the dependency flags), `AssetRegistry/Private/PackageDependencyData.cpp`.

## Summary order (loading an editor package, LegacyFileVersion -9)

Tag `0x9E2A83C1` · LegacyFileVersion · LegacyUE3Version (unless -4) · FileVersionUE4 · FileVersionUE5
(legacy <= -8) · Licensee · **[UE5 >= 1016 PACKAGE_SAVED_HASH: FIoHash(20) + TotalHeaderSize]** · custom
versions (count + 20 bytes each) · [older: TotalHeaderSize] · PackageName (FString, deprecated) ·
PackageFlags · NameCount/Offset · [>= 1008 SoftObjectPaths count/offset] · LocalizationId (FString) ·
GatherableText count/offset · Export count/offset · Import count/offset · [>= 1015 cell export/import
count/offset] · [>= 1014 MetaDataOffset] · DependsOffset · SoftPackageReferences count/offset ·
SearchableNamesOffset · ThumbnailTableOffset · [>= 1018 ImportTypeHierarchies count/offset] · [< 1016 Guid] ·
PersistentGuid · Generations (count + 8 bytes each) · SavedByEngineVersion and CompatibleWithEngineVersion
(u16 ×3, u32, FString) · CompressionFlags · CompressedChunks (must be empty) · PackageSource ·
AdditionalPackagesToCook (FString array) · AssetRegistryDataOffset · …

The 5.8 trap: from `PACKAGE_SAVED_HASH` the hash and TotalHeaderSize come **before** the custom versions. A
parser written for 5.0–5.3 reads the hash's first four bytes as the custom-version count and walks off.

## Tables

- **Name table** — FString + two 16-bit hashes per entry. FName references elsewhere are `(index, number)`;
  `number > 0` means the name is `<base>_<number-1>`.
- **Import** — ClassPackage, ClassName, OuterIndex, ObjectName, PackageName (UE4 >= 520), bImportOptional
  (UE5 >= 1003). The package of an import is its PackageName when set, else the ObjectName of the outermost
  import in the outer chain. Those packages are the **hard** dependencies.
- **Soft package references** — FName per entry (UE5) — the **soft** dependencies.
- **Asset registry block** (at AssetRegistryDataOffset) — int64 dependency-data offset (UE4 >= 521), object
  count, then per object: ObjectPath, ObjectClassName, tag count, tags (FString key/value). Tags include
  `NativeParentClass` / `ParentClass` for Blueprints. The dependency data holds two bit arrays (int32 bit count,
  then 32-bit words): **ImportUsedInGame** and **SoftPackageUsedInGame** — the game / editor-only flag of every
  import and soft reference, which is what lets an offline closure follow only what the cooker follows.

## Not supported

Cooked packages (`PKG_FilterEditorOnly`, unversioned): the layout differs and the tools refuse them with an
error. Legacy custom-version formats older than -6. Compressed packages.

## Facts worth knowing

- A reflected C++ type is stored without its prefix: `AMyActor` → `MyActor`, `UMyComp` → `MyComp`,
  `FMyRow` → `MyRow`; enums keep `E`. The module appears as `/Script/<Module>`.
- `rg` treats a file with a NUL byte as binary and stops searching it: `rg -l Name Content/` finds nothing in
  packages; `rg -la` does (and still misses the prefix rule above).
- The import table lists every referenced class — a cast, a variable type and the parent look alike there.
