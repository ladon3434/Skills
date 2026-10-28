---
grounded: 2026-07-20
---

# Engine API — Core: asset metadata (UE 5.8)

## UPackage::GetMetaData

`Source/Runtime/CoreUObject/Public/UObject/Package.h:1149`. In 5.8 returns `FMetaData&` by reference; older engines returned `UMetaData*`, and pointer-form code does not compile.
