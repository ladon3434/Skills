// clean-clangd.mjs — drop the clangd compile databases and index caches, in the project AND beside the engine.
//
//   node clean-clangd.mjs [--project <dir>] [--dry-run|-n]
//
// WHY: a clangd that finds compile_commands.json background-indexes the whole of UE and eats tens of GB of
// commit charge; UBA then sees "Low on memory", kills and retries actions forever, and builds never finish.
// Policy: the database is ABSENT while nobody needs it — generate-clang-database, use it, clean-clangd.
//
// TWO DATABASES: the project root one (what generate-clang-database writes) and <engine>/compile_commands.json,
// which an editor LSP pointed at the engine (--compile-commands-dir) picks. Cleaning only the first and printing
// "done" leaves the expensive one armed.
//
// `.clangd` is NOT cleaned: it is the tracked parse configuration (MSVC driver mode, flag removals), tiny, and
// deleting it only makes the next session drown in phantom diagnostics.

import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { projectInfo, resolveEngine } from './ue-engine.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
	console.log('usage: clean-clangd [--project <dir>] [--dry-run]');
	process.exit(0);
}
const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const dryRun = argv.includes('--dry-run') || argv.includes('-n');

const project = projectInfo(argOf('--project') ?? process.cwd());
if (!project) {
	console.log('ERROR: no .uproject above the current directory (pass --project <dir>)');
	process.exit(1);
}
const engine = resolveEngine(process.env, project.root);

let deleted = 0;
function drop(path, label) {
	if (!existsSync(path)) {
		console.log(`  ${label}: not found`);
		return;
	}
	const isDir = statSync(path).isDirectory();
	if (dryRun) {
		console.log(`  WOULD DELETE ${label}${isDir ? ' (directory)' : ''} -> ${path}`);
		return;
	}
	rmSync(path, { recursive: true, force: true });
	deleted++;
	console.log(`  deleted ${label} -> ${path}`);
}

console.log(`Cleaning clangd databases and index caches${dryRun ? ' (dry run)' : ''}...`);
drop(join(project.root, 'compile_commands.json'), 'compile_commands.json (project)');
drop(join(project.root, '.cache', 'clangd'), '.cache/clangd (project)');
if (engine.unrealHome) {
	drop(join(engine.unrealHome, 'compile_commands.json'), 'compile_commands.json (engine)');
	drop(join(engine.unrealHome, '.cache', 'clangd'), '.cache/clangd (engine)');
} else {
	console.log(`  ENGINE SIDE NOT CHECKED - ${engine.error}`);
}
console.log(dryRun ? 'Dry run - nothing deleted.' : deleted ? 'clangd cleanup done.' : 'Nothing to clean.');
