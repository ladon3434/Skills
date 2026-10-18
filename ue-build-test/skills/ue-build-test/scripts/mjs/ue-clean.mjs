// ue-clean — removes the generated build trees of the nearest project. DESTRUCTIVE, so:
//   - anchored to the folder of the resolved .uproject, never the cwd;
//   - refuses while an editor of this project runs, or one that cannot be attributed (it holds files below:
//     the delete would stop half-way on «file in use»);
//   - plugin Binaries are removed only for plugins that have Source (a binary-only plugin cannot be rebuilt),
//     and Binaries/ThirdParty (vendor libraries no build makes) always survives;
//   - Saved/ (logs, autosaves, the restore list, local config, save games) stays unless --saved;
//   - Build/ is project content (icons, platform files) and is never touched.
//
// Usage: ue-clean.cmd [--project p] [--saved] [--dry-run]
//   then rebuild: ue-compile.cmd (the first build after a clean is a full one).

import { existsSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gate } from './ue-gate.mjs';
import { describeEditors, editorsOfProject } from './ue-proc.mjs';
import { locateProject, parseArgs } from './ue-tools.mjs';

export const ProjectDirs = ['Binaries', 'Intermediate', 'DerivedDataCache', '.vs'];
export const PluginDirs = ['Binaries', 'Intermediate'];
export const KeptBinaries = 'ThirdParty';

/** Every path the clean would delete, for a project folder. Pure over the file system (reads only). */
export function cleanPlan(projectDir, { saved = false } = {}) {
	const plan = [];
	for (const d of [...ProjectDirs, ...(saved ? ['Saved'] : [])]) if (existsSync(join(projectDir, d))) plan.push(join(projectDir, d));
	for (const f of readdirSync(projectDir)) if (/\.(sln|slnx)$/i.test(f) || f === '.vsconfig.generated') plan.push(join(projectDir, f));
	const plugins = join(projectDir, 'Plugins');
	if (existsSync(plugins)) {
		let entries = [];
		try {
			entries = readdirSync(plugins, { recursive: true, encoding: 'utf8' });
		} catch {
			entries = [];
		}
		for (const rel of entries) {
			if (!/\.uplugin$/i.test(rel)) continue;
			const pdir = join(plugins, dirname(rel));
			if (!existsSync(join(pdir, 'Source'))) continue; // binary-only plugin: its Binaries are its content
			for (const g of PluginDirs) {
				const p = join(pdir, g);
				if (!existsSync(p)) continue;
				if (g === 'Binaries' && existsSync(join(p, KeptBinaries))) {
					for (const e of readdirSync(p)) if (e !== KeptBinaries) plan.push(join(p, e));
				} else plan.push(p);
			}
		}
	}
	return plan;
}

function main() {
	const args = parseArgs(process.argv.slice(2), { project: {}, saved: { type: 'bool' }, 'dry-run': { type: 'bool' }, help: { type: 'bool' } });
	if (args.help) {
		console.log('usage: ue-clean.cmd [--project p] [--saved] [--dry-run]');
		return 0;
	}
	const loc = locateProject({ project: args.project });
	if (loc.error) {
		console.log(loc.error);
		return 1;
	}
	const projectDir = dirname(loc.uproject);
	const plan = cleanPlan(projectDir, { saved: args.saved });
	console.log(`Project: ${loc.uproject}`);
	const e = editorsOfProject(projectDir);
	const busy = e.pids.length || e.opaque || !e.precise;

	if (args['dry-run']) {
		if (busy) console.log(`WOULD REFUSE: ${describeEditors(e)}`);
		console.log(plan.length ? 'Would delete:' : 'Nothing to delete.');
		for (const p of plan) console.log(`  ${relative(projectDir, p)}${statSync(p).isDirectory() ? '\\' : ''}`);
		return 0;
	}
	if (busy) {
		console.log(`REFUSED: ${describeEditors(e)} - it holds files in the trees below. Close it first if this session started it (ue-stop-editor.cmd); otherwise wait for its owner.`);
		return 2;
	}
	const owner = gate('build', projectDir, { wait: 60, editorTarget: true });
	if (!owner.ok) {
		console.log(`DEFERRED: ${owner.reason}`);
		return 1;
	}
	let failed = 0;
	for (const p of plan) {
		try {
			if (statSync(p).isDirectory()) rmSync(p, { recursive: true, force: true });
			else unlinkSync(p);
		} catch {
			/* checked below */
		}
		if (existsSync(p)) {
			console.log(`  ERROR: could not delete ${relative(projectDir, p)} (file in use?)`);
			failed++;
		} else console.log(`  deleted ${relative(projectDir, p)}`);
	}
	console.log(failed ? `Clean incomplete: ${failed} path(s) survived.` : `Clean done (${plan.length} path(s)).`);
	return failed ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exit(main());
