// ue-rebuild — full rebuild of the EDITOR target: UBT clean, then build with -DisableUnity.
// -DisableUnity compiles every .cpp on its own, so a missing #include that a unity blob hid becomes an error.
// Refuses while any editor of this project runs, or one that cannot be attributed (the clean deletes binaries).
// Usage: ue-rebuild.cmd [--project p] [--target T] [--config C] [--wait s] [--dry-run] [-- extra UBT args]
import { runBuild } from './ue-build-flow.mjs';

await runBuild('rebuild', process.argv.slice(2)); // exitWith( inside
