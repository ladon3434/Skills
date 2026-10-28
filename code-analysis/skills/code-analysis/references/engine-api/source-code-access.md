---
grounded: 2026-08-06
---

# Engine API — source code access

## USourceCodeAccessSettings::PreferredAccessor

`Source/Developer/SourceCodeAccess/Private/SourceCodeAccessSettings.h:17`. A free `FString` matched against accessors' `GetFName()`. UnrealBuildTool's own name→format map only picks the default `-projectfiles` format; an unknown name there silently changes nothing.
