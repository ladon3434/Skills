// pso-cache.mjs — the bundled PSO cache (UE 5.8): what is recorded, what the cook produced, what ships.
//
//   node pso-cache.mjs [status] [--project <dir>] [--platform Windows] [--recordings <dir>]
//   node pso-cache.mjs expand --sf PCD3D_SM6 [--recordings <dir>] [--shk <dir>] [--out <file>] [--dry-run]
//
// The chain (verified against UE 5.8 source, see references/pso-cache.md):
//   1. cook + package the game; the cook writes stable shader keys
//      Saved/Cooked/<Platform>/<Project>/Metadata/PipelineCaches/ShaderStableInfo-<Project>-<SF>.shk
//   2. run the PACKAGED game with -logPSO; it records
//      <build>/<Project>/Saved/CollectedPSOs/*-<Project>_<SF>_<guid>.rec.upipelinecache   (the build's Saved, not
//      the project's — point --recordings there; default: the project's Saved/CollectedPSOs)
//   3. expand: UnrealEditor-Cmd <uproject> -run=ShaderPipelineCacheTools Expand <recs...> <shks...> <out>
//      default out: Build/<Platform>/PipelineCaches/<Project>_<SF>.spc — the folder and name pattern the cooker
//      globs (*<Project>_<SF>.spc / .stablepc.csv); .stablepc.csv still works but the tool warns it is deprecated
//   4. the next cook bakes it into the build (Content/PipelineCaches/<Platform>/<Project>_<SF>.stable.upipelinecache
//      inside the cooked output — never put files there by hand).
//
// status: lists recordings, key files and shipped caches per shader format; says which step is missing and
// whether recordings are newer than the cache. Reads only.
// expand: runs step 3 for one shader format (refused while an editor of this project runs; --dry-run prints it).
//
// Exit: 0 ok, 1 nothing to expand / commandlet failed / status found no shipped cache, 2 usage, 3 refused.

import { mkdirSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { findFiles, mtime, parseArgs, readIni, resolveProject, runCommandlet } from './release-common.mjs';

const { flags, opts, rest } = parseArgs(process.argv.slice(2), ['project', 'platform', 'recordings', 'shk', 'sf', 'out']);
const mode = rest[0] ?? 'status';
if (flags.has('help') || !['status', 'expand'].includes(mode)) {
	console.log('usage: pso-cache [status] [--project <dir>] [--platform Windows] [--recordings <dir>]\n'
		+ '       pso-cache expand --sf <ShaderFormat> [--recordings <dir>] [--shk <dir>] [--out <file>] [--dry-run]');
	process.exit(flags.has('help') ? 0 : 2);
}
const project = resolveProject(opts.get('project'));
const platform = opts.get('platform') ?? 'Windows';
const rel = (p) => { const r = relative(project.root, p); return r.startsWith('..') ? p : r.split(sep).join('/'); };

const recDir = resolve(opts.get('recordings') ?? join(project.root, 'Saved', 'CollectedPSOs'));
const shkDir = resolve(opts.get('shk') ?? join(project.root, 'Saved', 'Cooked', platform, project.name, 'Metadata', 'PipelineCaches'));
const stableDir = join(project.root, 'Build', platform, 'PipelineCaches');

function shaderFormats() {
	const eng = readIni(join(project.root, 'Config', 'DefaultEngine.ini')) ?? {};
	const W = eng['/Script/WindowsTargetPlatform.WindowsTargetSettings'] ?? {};
	const sf = [...new Set(['D3D12TargetedShaderFormats', 'D3D11TargetedShaderFormats', 'VulkanTargetedShaderFormats'].flatMap((k) => W[k] ?? []))];
	return platform === 'Windows' && !sf.length ? ['PCD3D_SM6'] : sf;
}

const lc = (s) => s.toLowerCase();
const recsFor = (sf) => findFiles(recDir, /\.rec\.upipelinecache$/i).filter((f) => lc(basename(f)).includes(lc(`_${sf}_`)));
const shksFor = (sf) => findFiles(shkDir, /\.shk$/i).filter((f) => lc(basename(f)).endsWith(lc(`-${sf}.shk`)));
const stableFor = (sf) => findFiles(stableDir, /\.(spc|stablepc\.csv(\.compressed)?)$/i)
	.filter((f) => lc(basename(f)).replace(/\.(spc|stablepc\.csv(\.compressed)?)$/, '').endsWith(lc(`${project.name}_${sf}`)));

if (mode === 'status') {
	console.log(`=== PSO cache: ${project.name} (${platform}) ===`);
	console.log(`recordings: ${rel(recDir)}\nstable keys: ${rel(shkDir)}\nshipped:    ${rel(stableDir)}\n`);
	let missingShipped = 0;
	for (const sf of shaderFormats()) {
		const recs = recsFor(sf);
		const shks = shksFor(sf);
		const stable = stableFor(sf);
		console.log(`${sf}: ${recs.length} recording(s), ${shks.length} key file(s), ${stable.length} shipped cache(s)`);
		if (stable.length) {
			const newest = Math.max(...stable.map(mtime));
			const newer = recs.filter((r) => mtime(r) > newest).length;
			console.log(`  [ OK ] ${stable.map(rel).join(', ')}${newer ? ` - ${newer} recording(s) are newer: re-expand` : ''}`);
		} else {
			missingShipped++;
			if (!shks.length) console.log('  [WARN] no stable keys: cook/package the game first (step 1)');
			else if (!recs.length) console.log('  [WARN] no recordings: run the packaged game with -logPSO and play it through (step 2); pass its Saved/CollectedPSOs as --recordings');
			else console.log(`  [WARN] ready to expand: pso-cache expand --sf ${sf}${opts.has('recordings') ? ` --recordings "${recDir}"` : ''}`);
		}
	}
	const wrong = findFiles(join(project.root, 'Content', 'PipelineCaches'), /\.(spc|stablepc\.csv(\.compressed)?|upipelinecache)$/i);
	for (const f of wrong) console.log(`[WARN] ${rel(f)} - wrong place: the cooker reads Build/${platform}/PipelineCaches`);
	process.exit(missingShipped ? 1 : 0);
}

// expand
const sf = opts.get('sf');
if (!sf) { console.error('expand needs --sf <ShaderFormat> (e.g. PCD3D_SM6; status lists the project\'s formats)'); process.exit(2); }
const recs = recsFor(sf);
const shks = shksFor(sf);
if (!recs.length || !shks.length) {
	console.error(`nothing to expand for ${sf}: ${recs.length} recording(s) in ${recDir}, ${shks.length} key file(s) in ${shkDir}`);
	process.exit(1);
}
const out = resolve(opts.get('out') ?? join(stableDir, `${project.name}_${sf}.spc`));
if (!flags.has('dry-run')) mkdirSync(join(out, '..'), { recursive: true });
const code = runCommandlet(project, ['-run=ShaderPipelineCacheTools', 'Expand', ...recs, ...shks, out], { dryRun: flags.has('dry-run'), label: `PSO expand ${sf}` });
if (code === 0 && !flags.has('dry-run')) console.log(`stable PSO cache: ${rel(out)} - commit it; the next cook bundles it`);
process.exit(code);
