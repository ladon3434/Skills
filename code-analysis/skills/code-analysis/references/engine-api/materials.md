---
grounded: 2026-08-21
---

# Engine API — materials

## FExpressionInputIterator

`Source/Runtime/Engine/Public/Materials/MaterialExpression.h:684`. `GetInputsView()` carries `UE_DEPRECATED`; iterate `for (FExpressionInputIterator It{Expr}; It; ++It)` and read `It.Input->Expression`.

## UMaterialExpressionCollectionParameter

`Source/Runtime/Engine/Public/Materials/MaterialExpressionCollectionParameter.h:18`. Built in code, the node needs `ParameterId` filled from `UMaterialParameterCollection::GetParameterId(Name)` — an empty one compiles to zero instead of failing.
