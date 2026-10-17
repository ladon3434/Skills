# Reviewing replication and networking (UE 5.8 C++)

The networking pass of a review (`review.md`) or of a networked-mechanic audit: replicated
properties, RPCs, ownership, subobjects, prediction. Only for a project that runs networked — in a
single-player game missing replication is not a finding. A diff — the sections it touches; an audit — all of them.
Each item: what to look for in the code — why it breaks → the fix. Engine facts were read in the 5.8 source;
the less obvious ones carry a reference in «Verified at» below.

## Authority and roles

- **`HasAuthority()` read as «am I the server».** It is `GetLocalRole() == ROLE_Authority`; an actor
  spawned on a client (any class, replicated or not) is Authority there too → «server only» is
  `GetNetMode() != NM_Client` or a server-spawned replicated actor; `HasAuthority()` answers «do I own this copy».
- **Role checks in the constructor.** Every actor is constructed with `ROLE_Authority`; roles are swapped
  only in `PostSpawnInitialize` for actors that came from the network → `HasAuthority()` in a constructor is
  always true. Branch in `BeginPlay` or later. In the constructor set `bReplicates = true`, not
  `SetReplicates` (it changes `RemoteRole` earlier than normal).
- **`IsLocallyControlled()` in a pawn's `BeginPlay`.** It is `Controller && Controller->IsLocalController()`;
  on the owning client the Controller arrives by replication, maybe after `BeginPlay`, and simulated proxies
  never have one (controllers are `bOnlyRelevantToOwner`) → local-player setup goes into
  `NotifyControllerChanged` / `PawnClientRestart`; `PossessedBy` runs on the server only.
- **`GetGameMode()` used in code that also runs on clients.** The GameMode exists only on the server
  (`bNetLoadOnClient = false`) → null on clients; shared state lives in GameState / PlayerState.
- **`if (HasAuthority()) { logic } else { cosmetics }`.** A listen-server host is both authority and a local
  player, so it never gets the cosmetics → ask two questions: authority for game state,
  `IsLocallyControlled()` / `GetNetMode() != NM_DedicatedServer` for presentation.

## Replicated properties

- **`UPROPERTY(Replicated…)` with no `DOREPLIFETIME`, or `GetLifetimeReplicatedProps` without `Super::`.**
  The engine ensures «was not registered in GetLifetimeReplicatedProps. This property will not be replicated»
  → register every one; deliberately off — `DISABLE_REPLICATED_PROPERTY`.
- **Component replication.** A replicated component needs `SetIsReplicatedByDefault(true)` in its
  constructor (runtime `SetIsReplicated` ensures during construction) and a replicating owner actor.
- **Condition chosen for the writer, not the reader.** `COND_OwnerOnly` on data other players render,
  `COND_InitialOnly` on a value that later changes (sent in the initial bunch only), `COND_SkipOwner` on
  something the owner does not predict → choose by who reads it; a runtime toggle is `COND_Custom` +
  `DOREPLIFETIME_ACTIVE_OVERRIDE` in `PreReplication`.
- **C++ OnRep relied on to run on the server.** A C++ `ReplicatedUsing` fires only where the value is
  received; only a Blueprint-declared RepNotify is also called by the Blueprint Set node → after setting the
  value the server calls the OnRep (or the shared «apply» function) itself, or a listen-server host never
  updates.
- **OnRep expected for the initial value.** The sender's shadow starts from the archetype, so a value equal
  to the class default is never sent; the receiver calls the OnRep only if the value differs from its local
  one (`REPNOTIFY_OnChanged`) → apply the default state in `BeginPlay` too; a notify that is an event
  (or a client that predicted the same value) needs `REPNOTIFY_Always` via `DOREPLIFETIME_CONDITION_NOTIFY`.
- **OnRep that assumes `BeginPlay` ran.** For an actor that just arrived on a client, the initial bunch's
  OnReps run before `PostNetInit` → `BeginPlay` → a member set in `BeginPlay` is still null there; guard it and
  re-apply from `BeginPlay`.
- **OnRep of an object reference.** A reference to an actor the client does not have yet arrives null, and
  the OnRep fires again when it resolves → handle null as «not yet», not as «cleared».
- **Manual «previous value» bookkeeping.** An OnRep with one parameter of the property's type receives the
  previous value. All properties of one received bunch are applied before its OnReps run, so a sibling
  property of the same update is already current; another actor's state has no such guarantee.
- **Push model: `bIsPushBased = true` with a write that skips `MARK_PROPERTY_DIRTY_FROM_NAME`.** With push
  model on, a push property is compared only when dirty → the change is never sent. In 5.8
  `Net.IsPushModelEnabled` defaults to 0 and `WITH_PUSH_MODEL` is compiled only into Editor targets unless
  the target sets `bWithPushModel = true` → the same code works in one build and not in another. Fix: the
  field is private and every write goes through one setter that marks it dirty.
- **A large replicated `TArray` of structs changed often.** Compared and resent element-wise every update,
  no add/remove events → Fast Array Serializer (below).
- **Update rate.** Direct `NetUpdateFrequency` access is deprecated since 5.5 (`SetNetUpdateFrequency`).
  `APlayerState` runs at 1 Hz by default, so anything hung on it (an ASC) lags → raise it or `ForceNetUpdate()`
  after an important change.

## RPCs

- **Server RPC on an actor the client does not own** (a door, a pickup, another player's pawn). The owning
  connection is found through the `Owner` chain up to a PlayerController; with none the call is dropped with
  only a log warning «No owning connection for actor … will not be processed» → route the request through
  the player's PlayerController / pawn / a component on them, or `SetOwner` on the server.
- **NetMulticast called on a client.** It runs locally only → the client asks with a Server RPC, the server
  multicasts. Likewise a Server RPC called on the server and a Client RPC on a server actor with no player
  owner (AI) just run locally — «works in standalone» proves nothing.
- **Multicast used for state.** A multicast reaches only connections where the actor is relevant now (a
  reliable one also reaches open channels); unreliable multicasts are queued until the actor's next update
  → late joiners and distant clients never see it; persistent state is a replicated property with an OnRep,
  multicast only for one-shot cosmetics.
- **`Reliable` on frequent RPCs** (per-tick input, aim, cosmetic effects). Overflowing the reliable buffer
  closes the connection («Outgoing reliable buffer overflow») → `Unreliable` for frequent or cosmetic calls,
  `Reliable` for rare gameplay-critical ones.
- **`WithValidation` used for ordinary bad input.** A `_Validate` returning false closes the client's
  connection → reserve it for proof of cheating; reject lag-induced nonsense softly inside `_Implementation`.
  A Server RPC that accepts a client-computed outcome (damage, hit, position) without a plausibility check on
  the server is a cheat vector.
- **RPCs on a replicated `UObject` subobject.** `UObject::GetFunctionCallspace` returns Local and
  `CallRemoteFunction` returns false → override both to route through the owning actor's net driver, or put
  the RPC on the actor/component.

## Ownership and relevancy

- **`SetOwner` on a client.** `Owner` replicates from the server; a client-side change does not give that
  client an owning connection → set it on the server.
- **Relevancy settings.** `NetCullDistanceSquared` defaults to 225000000 (150 m): further away the actor
  stops being relevant and its channel to that client closes. `bAlwaysRelevant` on many actors costs bandwidth; `bOnlyRelevantToOwner` hides
  the actor from everyone else; attachments (a held weapon) want `bNetUseOwnerRelevancy`.
- **Dormancy.** A changed property of a dormant actor (`DORM_DormantAll`, `DORM_Initial`) is not sent until
  `FlushNetDormancy()`. The Blueprint Set node flushes automatically for replicated properties, C++ does not
  → call `FlushNetDormancy()` before the change, or `SetNetDormancy(DORM_Awake)` while it changes often.

## Subobjects and components

- **Two subobject mechanisms mixed.** In 5.8 `net.SubObjects.DefaultUseSubObjectReplicationList` is 0, so the
  legacy `ReplicateSubobjects` override is still the default; with `bReplicateUsingRegisteredSubObjectList =
  true` that override is not called at all → pick one per actor; with the list —
  `AddReplicatedSubObject` on creation, `RemoveReplicatedSubObject` before destruction (or
  `DestroyReplicatedSubObjectOnRemotePeers`).
- **A runtime `NewObject` subobject that never appears on clients.** `UObject::IsSupportedForNetworking`
  defaults to «name is stable», which a runtime object is not → override it to true, outer it to the owning
  actor/component, implement its `GetLifetimeReplicatedProps`.

## Fast Array Serializer

- **Item changed without `MarkItemDirty`, removed without `MarkArrayDirty`.** Not replicated; the receiver may
  log «missing a MarkArrayDirty on element add/remove?» → mark after every mutation, through helper methods.
- **No `TStructOpsTypeTraits<…>::WithNetDeltaSerializer = true` or no `NetDeltaSerialize`.** The array goes as
  a plain one and the callbacks never run.
- **Index-based client logic.** Order is not guaranteed identical between client and server → key by an id in
  the item. `PreReplicatedRemove` / `PostReplicatedAdd` / `PostReplicatedChange` run on the receiving side
  only; the server applies its own effects.

## Struct net serialization

- **Custom `NetSerialize` (`WithNetSerializer`) with members that are not `UPROPERTY`.** Change detection
  compares the struct by its `UPROPERTY` members (or by `Identical` with `WithIdentical`) → a change only in a
  non-reflected member is never sent; make them `UPROPERTY` or add `WithIdentical`.
- **`NetSerialize` hygiene.** Set `bOutSuccess`, return true; a `TArray` inside goes through
  `SafeNetSerializeTArray_*<MaxNum>` — a raw `Ar << Array` lets a malformed packet allocate any amount.
- **Quantization picked by habit.** `FVector_NetQuantize` keeps 0 decimals (±1,048,576),
  `…NetQuantize10` 1, `…NetQuantize100` 2, `…NetQuantizeNormal` 16 bits in −1..+1 → whole-unit positions jitter
  on slow movement; a non-unit vector in `NetQuantizeNormal` is out of range.

## Client prediction

- **CharacterMovement state changed on one side.** `MaxWalkSpeed` for a sprint set only on the client, or
  through a lagging Server RPC → server and client simulate differently, corrections (rubber-banding,
  visible with `p.NetShowCorrections 1`) → carry the input in the saved move (`FSavedMove_Character`,
  `GetCompressedFlags`, `FLAG_Custom_0..3`) so both sides simulate it.
- **GAS prediction window.** It is the initial callstack of `ActivateAbility`; a timer or latent node ends it →
  side effects after a `WaitDelay` are not predicted; open a new window (`WaitNetSync`,
  `FScopedPredictionWindow`) or do them server-only.
- **GAS replication mode.** `Minimal` does not work for an owned ASC → `Mixed` for player ASCs; an ASC on the
  PlayerState inherits its 1 Hz update rate. The rest — the `ue-gas` checklist.

## Iris (5.8)

Compiled in but off: `net.Iris.UseIrisReplication` defaults to 0 (`-UseIrisReplication=1` on the command line
turns it on). A project on Iris needs the registered subobject list on every actor that has subobjects — without
it Iris ensures «does not replicate subobjects using the registered SubObjectsLists, SubObjects will not replicate
properly»; legacy `ReplicateSubobjects` overrides are dead code there.

## Testing — say what ran

- **PIE**: Number of Players ≥ 2, once «Play As Listen Server» (catches the host that never gets OnReps or
  cosmetics), once «Play As Client» (dedicated server: ownership, server-only GameMode). «Run Under One
  Process» shares process-wide state between clients — a static or singleton can hide a desync; repeat a
  suspicious result with it off.
- **Latency and loss**: `NetEmulation.PktEmulationProfile Average|Bad`, or `NetEmulation.PktLag <ms>`,
  `NetEmulation.PktLoss <%>`, `NetEmulation.PktLagVariance`; `NetEmulation.DropAnyUnreliable` for logic that
  silently needs unreliable RPCs; `NetEmulation.Off`. At 0 ms OnRep-order and RPC-before-replication bugs hide.
- **Corrections**: `p.NetShowCorrections 1` (non-Shipping).
- **Networking Insights**: run with `-NetTrace=1 -trace=net` (non-Shipping), open the trace in Unreal Insights →
  per-property and per-RPC bandwidth, what actually went on the wire.

## Verified at

Paths under `Engine/Source` of 5.8 (`Engine/Plugins` for GAS, `Engine/Config` for the ini).

- Constructor role / swap: `Runtime/Engine/Private/Actor.cpp:287` (`SetRole(ROLE_Authority)`), `:4296` (`ExchangeNetRoles` in `PostSpawnInitialize`), `:4562` (`bReplicates` vs `SetReplicates` before init).
- `IsLocallyControlled`: `Runtime/Engine/Private/Pawn.cpp:272`; controllers owner-only: `Runtime/Engine/Private/Controller.cpp:67`; `PossessedBy` server-only: `Runtime/Engine/Classes/GameFramework/Pawn.h:371`; GameMode not on clients: `Runtime/Engine/Private/GameModeBase.cpp:67`.
- Unregistered property ensure: `Runtime/Engine/Private/RepLayout.cpp:6242`; component construction ensure: `Runtime/Engine/Private/Components/ActorComponent.cpp:2992`.
- Blueprint-only local RepNotify: `Editor/BlueprintGraph/Private/K2Node_VariableSet.cpp:66`; BP auto-flush of dormancy: same file `:355`.
- Shadow from archetype: `RepLayout.cpp:7297`, `Runtime/Engine/Private/DataReplication.cpp:555`; OnChanged/Always on receive: `RepLayout.cpp:3385`; OnRep re-fired on mapped reference: `RepLayout.cpp:4447`; one-parameter OnRep gets the old value: `RepLayout.cpp:4716`; OnReps after the whole bunch: `DataReplication.cpp:1609`.
- Initial OnReps before `BeginPlay`: `Runtime/Engine/Private/DataChannel.cpp:3518` (`PostReceivedBunch`) then `:3537` (`PostNetInit`) → `Actor.cpp:4699` (`DispatchBeginPlay`).
- Push model: dirty-only compare `RepLayout.cpp:1506`; cvar default `Runtime/Net/Core/Private/Net/Core/PushModel/PushModel.cpp:434`; Editor-only compile default `Programs/UnrealBuildTool/Configuration/Rules/TargetRules.cs:1524`.
- `NetUpdateFrequency` deprecation: `Runtime/Engine/Classes/GameFramework/Actor.h:903`; PlayerState 1 Hz: `Runtime/Engine/Private/PlayerState.cpp:28`; cull distance default: `Actor.cpp:312`.
- Owning connection via Owner: `Actor.cpp:1965`; dropped RPC warning: `Runtime/Engine/Private/NetDriver.cpp:8274`; local execution of multicast on client / server-on-server / client RPC without owner: `Actor.cpp:5572`, `:5585`, `:5627`.
- Multicast relevancy: `NetDriver.cpp:8232`–`8244`, cvar `:541`; unreliable multicast queued: `NetDriver.cpp:3400`.
- Reliable overflow closes the connection: `DataChannel.cpp:1440`; failed `_Validate` closes it: `DataReplication.cpp:1465` → `DataChannel.cpp:3472`.
- UObject RPC defaults: `Runtime/CoreUObject/Public/UObject/Object.h:1500`, `:1514`; `IsSupportedForNetworking`: `Runtime/CoreUObject/Private/UObject/Obj.cpp:6121`.
- Subobject list default 0: `ActorComponent.cpp:115`; override skipped with the list: `Runtime/Engine/Classes/Components/ActorComponent.h:645`; Iris ensure: `Runtime/Engine/Private/Net/Iris/ReplicationSystem/EngineReplicationBridge.cpp:393`; Iris off: `Runtime/Net/Iris/Private/Iris/IrisConfig.cpp:15`, `:36`.
- Fast array: order note `Runtime/Net/Core/Classes/Net/Serialization/FastArraySerializer.h:54`, rules `:122`, warning `:834`.
- NetSerialize compare: `RepLayout.cpp:745` → `Runtime/CoreUObject/Private/UObject/Class.cpp:3672`; quantize ranges `Runtime/Engine/Classes/Engine/NetSerialization.h:398`–`540`; safe arrays `:580`.
- CMC: `p.NetShowCorrections` `Runtime/Engine/Private/Components/CharacterMovementComponent.cpp:422`; compressed flags `Runtime/Engine/Classes/GameFramework/CharacterMovementComponent.h:3117`, `:3136`.
- GAS: prediction window `Runtime/GameplayAbilities/Source/GameplayAbilities/Public/GameplayPrediction.h:76`; Minimal vs owned ASC `…/Public/AbilitySystemComponent.h:83`.
- Testing: emulation commands `Runtime/Engine/Private/Net/NetEmulationHelper.cpp:49`, `:353`–`359`; profiles `Engine/Config/BaseEngine.ini:3541`; `-NetTrace=` `Runtime/Engine/Private/UnrealEngine.cpp:2661`, `Net` trace channel `Runtime/Net/Core/Private/Net/Core/Trace/Reporters/NetTraceReporter.cpp:17`, non-Shipping `Runtime/Net/Core/Public/Net/Core/Trace/NetTraceConfig.h:11`; PIE modes `Editor/UnrealEd/Classes/Settings/LevelEditorPlaySettings.h:98`, `:390`.
