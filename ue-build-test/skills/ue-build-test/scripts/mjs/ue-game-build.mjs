// ue-game-build — compiles the GAME target (<Name> <Platform> Shipping by default), no cook, no stage.
//
// Why: the everyday loop only compiles the EDITOR target, where WITH_EDITOR is 1 and editor modules link in.
// An editor-only API used in a runtime module (UClass::GetDisplayNameText, anything under #if WITH_EDITOR,
// an Editor-type module dependency) compiles green there and breaks the packaged game with C2039 / LNK2019
// nobody sees until a release attempt. Shipping additionally catches `#if !UE_BUILD_SHIPPING` breakage.
// The compile alone catches the whole class at a fraction of BuildCookRun's cost.
//
// Writes Saved/ue-build-test/game-build-<stamp>.log (last 14 kept) and game-build-status.json.
// An open editor does not block it: the game target builds separate binaries.
// Usage: ue-game-build.cmd [--project p] [--target T] [--config Shipping|Development] [--wait s] [--dry-run]
import { runBuild } from './ue-build-flow.mjs';

await runBuild('game', process.argv.slice(2)); // exitWith( inside
