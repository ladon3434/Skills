---
grounded: 2026-07-31
---

# Engine API — physics & body/prop interaction

Grounded signatures, each with its `file:line` in the UE 5.8 engine tree; the grounding floor is the `grounded:` field above. A line
number is a hint, not a contract — if an entry no longer points at its symbol, re-ground and correct
the entry in the same pass.

## UPrimitiveComponent::SetMassOverrideInKg

```cpp
UFUNCTION(BlueprintCallable, Category = "Physics")
ENGINE_API virtual void SetMassOverrideInKg(FName BoneName = NAME_None, float MassInKg = 1.f, bool bOverrideMass = true);
```

`Source/Runtime/Engine/Classes/Components/PrimitiveComponent.h:2857`

## UCharacterMovementComponent::ApplyImpactPhysicsForces — when the body pushes a prop

```cpp
void UCharacterMovementComponent::ApplyImpactPhysicsForces(const FHitResult& Impact, const FVector& ImpactAcceleration, const FVector& ImpactVelocity)
{
    if (bEnablePhysicsInteraction && Impact.bBlockingHit)
    {
        if (UPrimitiveComponent* ImpactComponent = Impact.GetComponent())
        {
            ...
            FBodyInstance* BI = ImpactComponent->GetBodyInstance(Impact.BoneName);
            if (BI != nullptr && BI->IsInstanceSimulatingPhysics())
```

`Source/Runtime/Engine/Private/Components/CharacterMovementComponent.cpp:7814`

**The contract, for anyone asking "why did my prop not move":** three conditions, all required —
`bEnablePhysicsInteraction` (true by engine default; this project sets it nowhere, so it is on), a
**blocking** hit (the capsule must actually collide, so the Pawn↔PhysicsBody response matters), and the
impacted body must be **simulating physics**. Reached only via `HandleImpact`
(`CharacterMovementComponent.cpp:7784`) off a real move — teleporting the capsule into a prop proves
nothing about the shipped path.

## UCharacterMovementComponent — moving an UNPOSSESSED character (test worlds)

```cpp
const bool bShouldPerformControlledCharMove = CharacterOwner->IsLocallyControlled()
                                              || (!CharacterOwner->GetController() && bRunPhysicsWithNoController)
                                              || (!CharacterOwner->GetController() && CharacterOwner->IsPlayingRootMotion());
```

`Source/Runtime/Engine/Private/Components/CharacterMovementComponent.cpp:1751`

With no controller, `ControlledCharacterMove` (and therefore `AddMovementInput` consumption, gravity and
`CheckJumpInput`) runs **only** under `bRunPhysicsWithNoController`. `PhysWalking` has the mirror guard at
`:5662`. This is why every headless character test sets the flag before driving the character.

## USceneComponent::SetUsingAbsoluteScale — a child that ignores its parent's scale

```cpp
ENGINE_API void SetUsingAbsoluteScale(const bool bInAbsoluteRotation);
```

`Engine/Source/Runtime/Engine/Classes/Components/SceneComponent.h:1629`

Scale only. Relative LOCATION is still multiplied by the parent's scale, so a child that must keep
its own size on a non-uniformly scaled parent needs this call AND a location offset divided by the
parent's `GetComponentScale()`. (The parameter name in the engine header says `Rotation`; the
function sets the absolute-scale flag.)

## FChaosWheelSetup::BoneName

```cpp
UPROPERTY(EditAnywhere, Category = Setup)
FName BoneName;
```

`Engine/Plugins/Experimental/ChaosVehiclesPlugin/Source/ChaosVehicles/Public/ChaosWheeledVehicleMovementComponent.h:527`

Mandatory even on a non-skeletal chassis: `UChaosWheeledVehicleMovementComponent::CanCreateVehicle()`
refuses to create the vehicle when any setup's `BoneName` is `NAME_None`
(`Private/ChaosWheeledVehicleMovementComponent.cpp:1309`). With a `UBoxComponent`/`UStaticMeshComponent`
chassis the name is otherwise inert — the bone lookup below is skipped.

## UChaosVehicleMovementComponent::LocateBoneOffset

`Private/ChaosVehicleMovementComponent.cpp:1529` — adds the bone's ref-pose position (via
`GetComposedRefPoseMatrix`) to the wheel offset, but only when `GetMesh()` casts to
`USkinnedMeshComponent` (line 1535). So on a skeletal chassis the wheel's resting position is
`WheelClass->Offset + WheelSetup.AdditionalOffset + bone ref-pose`; on a non-skeletal one the bone term
is simply absent.

## UVehicleAnimationInstance / FAnimNode_WheelController

`ChaosVehicles/Public/VehicleAnimationInstance.h:22` · `Public/AnimNode_WheelController.h:17`

The ONLY thing that moves wheel bones. `FVehicleAnimationInstanceProxy::PreUpdate`
(`Private/VehicleAnimationInstance.cpp:77`) reads `GetRotationAngle`/`GetSteerAngle`/`GetSuspensionOffset`
off the physics output, and `FAnimNode_WheelController::EvaluateSkeletalControl_AnyThread`
(`Private/AnimNode_WheelController.cpp:46`) writes the bone transforms. The movement component never
writes a bone itself — it only looks up an existing anim instance and feeds it
(`Private/ChaosWheeledVehicleMovementComponent.cpp:1335`). No AnimBP with the WheelController node ⇒
wheels stay in ref pose.

`FixupSkeletalMesh` (`Private/ChaosWheeledVehicleMovementComponent.cpp:1205`) is gated on a
`USkeletalMeshComponent` chassis; it is what creates the per-wheel suspension CONSTRAINTS and disables
the physics-asset wheel bodies. Raycast suspension does not need it.

## UChaosVehicleWheel — the per-wheel tunables

`Engine/Plugins/Experimental/ChaosVehiclesPlugin/Source/ChaosVehicles/Public/ChaosVehicleWheel.h`

```cpp
float WheelRadius; float WheelWidth; float WheelMass;
float CorneringStiffness; float FrictionForceMultiplier;
float SuspensionMaxRaise; float SuspensionMaxDrop; float SuspensionDampingRatio;
float WheelLoadRatio; float SpringRate; float SpringPreload;
float MaxBrakeTorque; float MaxHandBrakeTorque;
```

Spring and damping live on the WHEEL class, not on the movement component — a front/rear difference in
spring rate is therefore two wheel classes, not two fields. Chaos reads the wheel-class CDO when the
vehicle is created, which is why a per-instance radius has to be pushed into the live sim
(`SetWheelRadius`) instead of set on the class.

## Changing a wheel's grip at runtime — the two setters, only one of which always works

```cpp
UFUNCTION(BlueprintCallable, Category = "Game|Components|ChaosWheeledVehicleMovement")
void SetWheelFrictionMultiplier(int WheelIndex, float Friction);

UFUNCTION(BlueprintCallable, Category = "Game|Components|ChaosWheeledVehicleMovement")
void SetWheelSlipGraphMultiplier(int WheelIndex, float Multiplier);
```

`Engine/Plugins/Experimental/ChaosVehiclesPlugin/Source/ChaosVehicles/Public/ChaosWheeledVehicleMovementComponent.h:835,838`

`SetWheelSlipGraphMultiplier` IS SILENTLY DEAD ON A WHEEL WITH NO SLIP CURVE. It writes
`FSimpleWheelSim::LateralSlipGraphMultiplier`, and the sim reads that field in exactly one branch —
`WheelSystem.cpp:153` takes `Setup().LateralSlipGraph.IsEmpty()` and computes the lateral force from
`CorneringStiffness` alone, never touching the multiplier; only the else at `:161` applies it. The config
graph is filled in `ChaosVehicleWheel.h:365` from the wheel class's `FRuntimeFloatCurve LateralSlipGraph`
and stays empty unless that curve has keys past X=0. So a project whose wheel classes set no curve gets a
setter that returns cleanly, changes a field, and alters nothing.

`SetWheelFrictionMultiplier` has no such precondition: it writes `FSimpleWheelSim::FrictionMultiplier`,
which is the radius of the friction circle itself — `AvailableGrip = ForceIntoSurface * SurfaceFriction *
FrictionMultiplier` (`WheelSystem.cpp:84`), clipping longitudinal and lateral alike. It OVERWRITES rather
than scales, so restoring a wheel means writing the wheel class's own `FrictionForceMultiplier` back, not
`1.0`.

Two facts that decide which one a drift handbrake wants, both measured on a `AWheeledVehiclePawn` subclass:

- Giving a wheel a curve to switch it onto the graph branch costs nothing in feel if the curve is DERIVED:
  the two branches are identical at multiplier 1 when `Curve.Eval(deg) = DegreesToRadians(deg) *
  CorneringStiffness`, because the config graph is stored as `Curve.Eval(X) * 10000` and the default branch
  uses `CorneringStiffness * 10000`. `CalculateSlipAngle` returns `FMath::Abs(Atan2(...))` folded into
  `[0, HALF_PI]` (`VehicleUtility.h:146`), so the slip angle is never negative and a curve sampled over
  `X >= 0` covers the whole domain — the asymmetry the sampling loop looks like it would cause cannot happen.
- Cutting ONLY the lateral half does not produce a slide on a strong handbrake. With `MaxHandBrakeTorque`
  at 6000 the car stops in about two seconds, and a stopped car cannot drift: the widest slip angle tops
  out at 24.9 deg even at zero lateral grip, while the friction circle at 0.25 reaches 53 deg. The friction
  circle is one radius for both axes, so «still stops the car hard» and «lets the tail go» are the same
  quantity — pick which one the mechanic is for rather than looking for a lever that gives both.
