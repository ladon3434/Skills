---
grounded: 2026-09-08
---

# Engine API — core math

Look math members up under their template name: `FVector`/`FRotator` are aliases of `UE::Math::TVector<T>` / `TRotator<T>`, so `engine-api.cmd FVector::Size2D` finds nothing and reads as «no such member» — ask for `TVector::Size2D`. These members return `double`; a value going into `float` state is cast at the call site.
