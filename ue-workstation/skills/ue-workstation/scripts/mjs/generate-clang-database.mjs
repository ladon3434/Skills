// generate-clang-database.mjs — compile_commands.json for clangd / an LSP tool, through UBT GenerateClangDatabase.
//
//   node generate-clang-database.mjs [--project <dir>] [--target <Name>Editor] [--config Development] [--dry-run]
//
// WARNING (clangd eats commit charge): with the database present, clangd background-indexes the whole of UE and
// takes tens of GB of commit charge; UBA then kills and retries actions in a "Low on memory" loop. Generate it
// for the task that needs it, then drop it: clean-clangd. The script prints that reminder every time.
//
// UBT is machine-wide: while a build that is not this session's runs (ue-owner.mjs canBuild), the script refuses
// instead of queueing behind (or racing) it. The database needs no closed editor, so an open one does not matter.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { hostPlatform, projectInfo, resolveEngine, ubtPath } from './ue-engine.mjs';
import { canBuild, snapshot, whoAmI } from './ue-owner.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
	console.log('usage: generate-clang-database [--project <dir>] [--target <Target>] [--config <Config>] [--dry-run]');
	process.exit(0);
}
const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const die = (m) => { console.log(`ERROR: ${m}`); process.exit(1); };

const project = projectInfo(argOf('--project') ?? process.cwd());
if (!project) die('no .uproject above the current directory (pass --project <dir>)');
const engine = resolveEngine(process.env, project.root);
if (!engine.unrealHome) die(engine.error);
const ubt = ubtPath(engine.unrealHome);
const args = ['-Mode=GenerateClangDatabase', argOf('--target') ?? `${project.name}Editor`, hostPlatform(), argOf('--config') ?? 'Development',
	`-Project=${project.uproject}`, `-OutputDir=${project.root}`, '-WaitMutex'];

if (argv.includes('--dry-run')) {
	console.log(`would run: "${ubt}" ${args.join(' ')}`);
	process.exit(0);
}
if (!existsSync(ubt)) die(`UnrealBuildTool not found at ${ubt}`);

const snap = snapshot();
if (snap) {
	const v = canBuild(snap, whoAmI(snap), project.root, { editorTarget: false });
	if (!v.ok) die(`${v.reason}. Run again when it is done.`);
}

console.log('Generating the clang compile database (UBT)...');
const r = spawnSync(ubt, args, { stdio: 'inherit', windowsHide: true });
if (r.status !== 0) die('GenerateClangDatabase failed');
const db = join(project.root, 'compile_commands.json');
if (!existsSync(db)) die('compile_commands.json was not generated in the project root');
console.log(`\nReady: ${db}`);
console.log('REMEMBER: clangd indexing UE eats tens of GB of commit charge and starves builds. When done: clean-clangd.cmd');
