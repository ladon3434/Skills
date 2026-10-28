// loc-check.mjs — localization coverage of a UE project, offline by default.
//
//   node loc-check.mjs [--project <dir>] [--target <Name>] [--gather [--dry-run]] [--code] [--max 20]
//
// Targets: Config/Localization/<Target>_Gather.ini (written by the Localization Dashboard). From it: NativeCulture,
// CulturesToGenerate, DestinationPath, ArchiveName. For every culture but the native one, each archive entry with an
// empty Translation or Translation == Source is a missing translation (the native culture is exempt: there the two
// are equal by design). Archives are JSON, usually UTF-16 LE with BOM.
//
//   --gather   first run the GatherText commandlet with that config (rewrites the manifest and archives under
//              Content/Localization — a project change). Refused while an editor of this project runs.
//   --dry-run  with --gather: print the command, run nothing (the offline check still runs).
//   --code     also scan C++ (Source/, Plugins/*/Source) for FText::FromString("literal") and for files that
//              #define LOCTEXT_NAMESPACE without #undef (or use LOCTEXT without defining it).
//
// Warns when the gather config names an engine install other than the project's (stale paths after an engine
// upgrade make GatherText read the wrong engine manifests).
//
// Exit: 0 every target culture complete, 1 missing translations / unreadable archive / failed gather, 2 usage or no
// localization target, 3 gather refused (editor running).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { editorCmd, findFiles, parseArgs, readIni, resolveProject, runCommandlet } from './release-common.mjs';

const { flags, opts } = parseArgs(process.argv.slice(2), ['project', 'target', 'max']);
if (flags.has('help')) {
	console.log('usage: loc-check [--project <dir>] [--target <Name>] [--gather [--dry-run]] [--code] [--max 20]');
	process.exit(0);
}
const project = resolveProject(opts.get('project'));
const max = Number(opts.get('max') ?? 20);
const rel = (p) => relative(project.root, p).split(sep).join('/');

/** PURE: archive JSON text -> [{ns, source, translation}] over all namespaces. */
export function archiveEntries(data, ns = '') {
	const out = [];
	for (const c of data.Children ?? []) out.push({ ns: ns || '[root]', key: c.Key, source: c.Source?.Text ?? '', translation: c.Translation?.Text ?? '' });
	for (const sub of data.Subnamespaces ?? []) out.push(...archiveEntries(sub, ns ? `${ns}/${sub.Namespace}` : sub.Namespace));
	return out;
}

function readArchive(path) {
	const buf = readFileSync(path);
	let text;
	if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.subarray(2).toString('utf16le');
	else if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) text = buf.subarray(3).toString('utf8');
	else text = buf.toString('utf8');
	return JSON.parse(text);
}

const locConfigDir = join(project.root, 'Config', 'Localization');
const targets = existsSync(locConfigDir)
	? readdirSync(locConfigDir).filter((f) => /_Gather\.ini$/i.test(f)).map((f) => f.replace(/_Gather\.ini$/i, ''))
	: [];
const wanted = opts.get('target');
const chosen = wanted ? targets.filter((t) => t.toLowerCase() === wanted.toLowerCase()) : targets;
if (!chosen.length) {
	console.log(wanted
		? `no Config/Localization/${wanted}_Gather.ini`
		: 'no localization target (Config/Localization/*_Gather.ini) - set one up in Tools > Localization Dashboard: add a target, its cultures and gather paths, then Gather Text once');
	process.exit(2);
}

let bad = 0;
const engine = editorCmd(project);
for (const target of chosen) {
	const cfgPath = join(locConfigDir, `${target}_Gather.ini`);
	const cfg = readIni(cfgPath) ?? {};
	const common = cfg.CommonSettings ?? {};
	const native = common.NativeCulture?.at(-1) ?? 'en';
	const cultures = common.CulturesToGenerate ?? [];
	const dest = join(project.root, common.DestinationPath?.at(-1) ?? `Content/Localization/${target}`);
	const archiveName = common.ArchiveName?.at(-1) ?? `${target}.archive`;
	console.log(`=== target ${target}: native ${native}, cultures ${cultures.join(', ') || '(none)'} ===`);

	if (!engine.error) {
		const ours = engine.unrealHome.replace(/\\/g, '/').toLowerCase();
		const stale = (common.ManifestDependencies ?? []).filter((d) => /Epic Games\/UE_[\d.]+\/Engine/i.test(d) && !d.replace(/\\/g, '/').toLowerCase().includes(ours.split('/').pop()));
		if (stale.length) console.log(`[WARN] ${rel(cfgPath)} names another engine (${stale[0]}) - reopen the Localization Dashboard in this engine and save, so it regenerates the configs`);
	}

	if (flags.has('gather')) {
		const code = runCommandlet(project, ['-run=GatherText', `-config=${rel(cfgPath)}`], { dryRun: flags.has('dry-run'), label: `GatherText ${target}` });
		if (code === 3) process.exit(3);
		if (code !== 0) { console.log(`[FAIL] GatherText exited ${code}`); bad++; continue; }
	}

	for (const culture of cultures) {
		const archive = join(dest, culture, archiveName);
		if (!existsSync(archive)) { console.log(`[FAIL] ${culture}: ${rel(archive)} missing - gather has not run for this culture`); bad++; continue; }
		let entries;
		try { entries = archiveEntries(readArchive(archive)); } catch (e) { console.log(`[FAIL] ${culture}: cannot parse ${rel(archive)} (${e.message})`); bad++; continue; }
		if (culture.toLowerCase() === native.toLowerCase()) { console.log(`[ OK ] ${culture} (native): ${entries.length} entries`); continue; }
		const missing = entries.filter((e) => !e.translation || e.translation === e.source);
		if (!missing.length) { console.log(`[ OK ] ${culture}: ${entries.length}/${entries.length} translated`); continue; }
		bad++;
		console.log(`[FAIL] ${culture}: ${missing.length} of ${entries.length} untranslated`);
		for (const m of missing.slice(0, max)) console.log(`       ${m.ns} ${m.key}: "${m.source}"`);
		if (missing.length > max) console.log(`       ... ${missing.length - max} more (--max N)`);
	}
}

if (flags.has('code')) {
	console.log('=== C++ text ===');
	const roots = [join(project.root, 'Source'), ...findFiles(join(project.root, 'Plugins'), /\.uplugin$/i).map((p) => join(p, '..', 'Source'))];
	let findings = 0;
	for (const root of roots) {
		for (const file of findFiles(root, /\.(h|cpp|inl)$/i)) {
			const text = readFileSync(file, 'utf8');
			const lines = text.split(/\r?\n/);
			lines.forEach((line, i) => {
				if (/FText::FromString\s*\(\s*(TEXT\s*\(\s*)?"/.test(line) && !/^\s*\/\//.test(line)) {
					findings++;
					console.log(`[WARN] ${rel(file)}:${i + 1}: FText::FromString on a literal - not gathered; use LOCTEXT/NSLOCTEXT if a player sees it`);
				}
			});
			const defines = (text.match(/#\s*define\s+LOCTEXT_NAMESPACE\b/g) ?? []).length;
			const undefs = (text.match(/#\s*undef\s+LOCTEXT_NAMESPACE\b/g) ?? []).length;
			if (/\.cpp$/i.test(file) && defines !== undefs) {
				findings++;
				console.log(`[WARN] ${rel(file)}: ${defines} #define LOCTEXT_NAMESPACE vs ${undefs} #undef - a missing #undef leaks the namespace into the next file of a unity blob`);
			}
			if (/\bLOCTEXT\s*\(/.test(text) && !defines && !/\.h$/i.test(file)) {
				findings++;
				console.log(`[WARN] ${rel(file)}: LOCTEXT without #define LOCTEXT_NAMESPACE in this file`);
			}
		}
	}
	if (!findings) console.log('[ OK ] no literal FText::FromString, LOCTEXT_NAMESPACE balanced');
}

console.log(bad ? `\nRESULT: ${bad} problem(s)` : '\nRESULT: complete');
process.exit(bad ? 1 : 0);
