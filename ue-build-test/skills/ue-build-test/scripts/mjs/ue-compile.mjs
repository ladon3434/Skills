// ue-compile — incremental build of the project's EDITOR target (<Name>Editor <Platform> Development).
// Refuses (DEFERRED) while an editor of this project is open: its DLLs are locked. See ue-build-flow.mjs.
// Usage: ue-compile.cmd [--project p] [--target T] [--config C] [--wait s] [--dry-run] [-- extra UBT args]
// The exits are in ue-build-flow.mjs, every one through exitWith().
import { runBuild } from './ue-build-flow.mjs';

await runBuild('compile', process.argv.slice(2)); // exitWith( inside
