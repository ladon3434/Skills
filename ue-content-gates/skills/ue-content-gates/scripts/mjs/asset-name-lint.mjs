// asset-name-lint — asset names and folders follow the project's convention; offline, no editor.
//
// For every package under the project's Content/ and every project plugin's Content/, it reads the main asset's
// class from the package header (the asset-registry block, as `uasset.mjs` / `py/uasset.py` read it) and judges:
//   prefix      the name starts with the prefix the convention gives the class (SM_, T_, BP_, ...)
//   characters  no space and nothing outside printable ASCII in the name or any folder of its path
//   placement   classes the config pins to folders live under one of them (no default rule)
// A class the convention does not know is INFO (counted, not a problem). Exit 0 clean · 1 problems · 2 setup error.
//
// Usage: asset-name-lint.cmd [<file or folder>...]   default: every package of the project
//        asset-name-lint.cmd --changed [<git ref>]   only packages changed against the ref (default HEAD),
//                                                    plus untracked ones; deleted ones are skipped
//        --root <dir>       project root (default: nearest .uproject up from cwd, else CLAUDE_PROJECT_DIR)
//        --config <file>    the convention file (default <project>/.claude/asset-names.json)
//        --no-plugins       only /Game/
//        --json             machine output
//        --verbose          list every asset of an unknown class, not three per class
//        --print-config     the table in force (defaults merged with the file) and exit
//        --selftest
//
// HOW THE CLASS IS FOUND. The asset-registry block of an editor package lists each asset's object path and class
// path (`/Script/Engine.StaticMesh`); the main asset is the one named like the file. The class's ancestry then
// decides which rule applies — the first class in the chain the table knows wins:
//   - a native class: the package's import type hierarchy when the engine wrote one; else a built-in parent map of
//     engine classes (PrimaryDataAsset → DataAsset, AnimMontage → AnimSequenceBase, ...); else the project's own
//     C++ headers (`class UCardItem : public UItemBase` under Source/ and Plugins/*/Source/) — so a project
//     PrimaryDataAsset subclass is judged as DataAsset;
//   - a Blueprint class (`/Game/X/BP_Cfg.BP_Cfg_C`, an instance of a Blueprint data asset): the Blueprint package is
//     read for its ParentClass / NativeParentClass tag, recursively;
//   - a Blueprint-family asset (it has a NativeParentClass tag): its parent chain is also known, and keys of the
//     form `<AssetClass>:<ParentClass>` are tried first (`Blueprint:GameplayEffect` → GE_). The BlueprintType tag
//     adds the virtual parents `Interface`, `FunctionLibrary`, `MacroLibrary`. A Blueprint-family class the table
//     does not name falls back to `Blueprint`.
// World Partition's `__ExternalActors__` / `__ExternalObjects__` packages are not assets and are never walked.
//
// THE CONVENTION FILE — `<project>/.claude/asset-names.json`, every key optional:
//   {
//     "prefixes": {                       merged over the defaults (see `--print-config`)
//       "AnimSequence": "A_",             a class (short name, no U/A prefix) → the prefix
//       "SoundWave": ["S_", "SW_"],       several accepted prefixes
//       "World": null,                    null: this class is not judged
//       "Blueprint:Character": "BP_Char_",  <asset class>:<parent class in the chain>
//       "Blueprint:BP_EnemyBase": "BP_Enemy_"  a Blueprint parent is named without _C
//     },
//     "replaceDefaults": false,           true: the file's prefixes replace the default table
//     "ignore": ["/Game/Marketplace/", "/Game/**/Demo/"],   package-path prefixes; `*` = one folder level, `**` = any
//     "exceptions": ["/Game/Maps/Entry"], packages (or globs) whose prefix rule is waived; characters still count
//     "placement": { "World": ["/Game/Maps/"] },  class (same lookup as prefixes) → allowed folders
//     "plugins": true                     false: only /Game/
//   }
// Default ignore: `/Game/Developers/`, `/Game/Collections/` (kept unless the file sets "ignore").
//
// THE DEFAULT TABLE is the Allar / Epic style the community uses, with one choice where they differ: AnimSequence
// AS_ (Epic, Lyra; Allar writes A_), SoundWave S_ / SoundCue SC_ (Allar writes A_ for both), World L_ (Lyra; Allar
// gives levels no prefix). A project that follows the other form says so in the file.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';

import { findUproject } from './ue-engine.mjs';
import { buildPackage, classPackage, mainAsset, PackageError, readPackage, shortClass } from './uasset.mjs';

export const DefaultPrefixes = {
	// Blueprints and their kinds
	Blueprint: 'BP_',
	'Blueprint:Interface': 'BPI_',
	'Blueprint:FunctionLibrary': 'BPFL_',
	'Blueprint:BlueprintFunctionLibrary': 'BPFL_',
	'Blueprint:MacroLibrary': 'BPML_',
	'Blueprint:GameplayAbility': 'GA_',
	'Blueprint:GameplayEffect': 'GE_',
	'Blueprint:GameplayCueNotify_Static': 'GCN_',
	'Blueprint:GameplayCueNotify_Actor': 'GCN_',
	'Blueprint:AnimNotify': 'AN_',
	'Blueprint:AnimNotifyState': 'ANS_',
	WidgetBlueprint: 'WBP_',
	AnimBlueprint: 'ABP_',
	EditorUtilityBlueprint: 'EUB_',
	EditorUtilityWidgetBlueprint: 'EUW_',
	ControlRigBlueprint: 'CR_',
	UserDefinedEnum: 'E_',
	UserDefinedStruct: 'F_',
	// meshes and animation
	StaticMesh: 'SM_',
	SkeletalMesh: 'SK_',
	Skeleton: 'SKEL_',
	PhysicsAsset: 'PHYS_',
	AnimSequence: 'AS_',
	AnimMontage: 'AM_',
	AnimComposite: 'AC_',
	BlendSpace: 'BS_',
	AimOffsetBlendSpace: 'AO_',
	AimOffsetBlendSpace1D: 'AO_',
	PoseAsset: 'PA_',
	IKRigDefinition: 'IK_',
	IKRetargeter: 'RTG_',
	GeometryCollection: 'GC_',
	LevelSequence: 'LS_',
	// materials and textures
	Material: 'M_',
	MaterialInstanceConstant: 'MI_',
	MaterialFunction: 'MF_',
	MaterialFunctionInstance: 'MFI_',
	MaterialFunctionMaterialLayer: 'ML_',
	MaterialFunctionMaterialLayerBlend: 'MLB_',
	MaterialFunctionMaterialLayerInstance: 'MLI_',
	MaterialFunctionMaterialLayerBlendInstance: 'MLBI_',
	MaterialParameterCollection: 'MPC_',
	PhysicalMaterial: 'PM_',
	SubsurfaceProfile: 'SP_',
	Texture2D: 'T_',
	TextureCube: 'TC_',
	TextureRenderTarget2D: 'RT_',
	TextureRenderTargetCube: 'RTC_',
	// effects
	NiagaraSystem: 'NS_',
	NiagaraEmitter: 'NE_',
	NiagaraParameterCollection: 'NPC_',
	ParticleSystem: 'PS_',
	// audio
	SoundWave: 'S_',
	SoundCue: 'SC_',
	MetaSoundSource: 'MSS_',
	MetaSoundPatch: 'MSP_',
	SoundAttenuation: 'ATT_',
	SoundClass: 'SCL_',
	SoundMix: 'Mix_',
	SoundConcurrency: 'SCON_',
	ReverbEffect: 'Reverb_',
	// data
	DataAsset: 'DA_',
	DataTable: 'DT_',
	CurveTable: 'CT_',
	CurveFloat: 'Curve_',
	CurveVector: 'Curve_',
	CurveLinearColor: 'Curve_',
	// input, AI, world, UI
	InputAction: 'IA_',
	InputMappingContext: 'IMC_',
	BehaviorTree: 'BT_',
	BlackboardData: 'BB_',
	EnvQuery: 'EQS_',
	StateTree: 'ST_',
	PCGGraph: 'PCG_',
	World: 'L_',
	Font: 'Font_',
	ForceFeedbackEffect: 'FFE_',
	// not assets a person names
	ObjectRedirector: null,
};

export const DefaultIgnore = ['/Game/Developers/', '/Game/Collections/'];

// Engine class → parent (short names), where the parent is what a convention keys on. Project classes come from
// the project's headers; this covers the engine classes a project class or an asset class derives from.
const BuiltinParents = {
	PrimaryDataAsset: 'DataAsset',
	AnimMontage: 'AnimCompositeBase', AnimComposite: 'AnimCompositeBase', AnimCompositeBase: 'AnimSequenceBase',
	AnimSequence: 'AnimSequenceBase', AnimStreamable: 'AnimSequenceBase',
	BlendSpace1D: 'BlendSpace', AimOffsetBlendSpace: 'BlendSpace', AimOffsetBlendSpace1D: 'BlendSpace1D',
	BaseWidgetBlueprint: 'Blueprint', WidgetBlueprint: 'BaseWidgetBlueprint', AnimBlueprint: 'Blueprint',
	EditorUtilityBlueprint: 'Blueprint', EditorUtilityWidgetBlueprint: 'WidgetBlueprint',
	GameplayAbilityBlueprint: 'Blueprint', RigVMBlueprint: 'Blueprint', ControlRigBlueprint: 'RigVMBlueprint',
	MaterialFunctionMaterialLayer: 'MaterialFunction', MaterialFunctionMaterialLayerBlend: 'MaterialFunction',
	MaterialFunctionMaterialLayerInstance: 'MaterialFunctionInstance',
	MaterialFunctionMaterialLayerBlendInstance: 'MaterialFunctionInstance',
	MaterialInstanceConstant: 'MaterialInstance',
	TextureRenderTarget2D: 'TextureRenderTarget', TextureRenderTargetCube: 'TextureRenderTarget',
	CurveFloat: 'CurveBase', CurveVector: 'CurveBase', CurveLinearColor: 'CurveBase',
	SoundWave: 'SoundBase', SoundCue: 'SoundBase',
	GameplayCueNotify_Static: 'Object', GameplayCueNotify_Actor: 'Actor',
	Character: 'Pawn', DefaultPawn: 'Pawn', Pawn: 'Actor', PlayerController: 'Controller', AIController: 'Controller',
	Controller: 'Actor', GameModeBase: 'Info', GameMode: 'GameModeBase', GameStateBase: 'Info', GameState: 'GameStateBase',
	PlayerState: 'Info', HUD: 'Actor', Info: 'Actor',
	SceneComponent: 'ActorComponent', PrimitiveComponent: 'SceneComponent',
	AnimNotifyState: 'Object', AnimNotify: 'Object', UserWidget: 'Widget',
};

const BlueprintTypeParent = { BPTYPE_Interface: 'Interface', BPTYPE_FunctionLibrary: 'FunctionLibrary', BPTYPE_MacroLibrary: 'MacroLibrary' };
const PackageExt = new Set(['.uasset', '.umap']);
const NotAssets = new Set(['__ExternalActors__', '__ExternalObjects__']);
const BadChar = /[^\x21-\x7E]/;

class SetupError extends Error {}

// ---- configuration --------------------------------------------------------------------------------------------

/** The convention in force: the defaults merged with the file (or replaced by it). Throws SetupError on a file
 *  that does not parse or has the wrong shape — a gate that cannot read its rules must not answer «clean». */
export function loadConfig(file) {
	const cfg = { prefixes: { ...DefaultPrefixes }, ignore: [...DefaultIgnore], exceptions: [], placement: {}, plugins: true, file: null };
	if (!file || !existsSync(file)) return cfg;
	let json;
	try {
		json = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
	} catch (e) {
		throw new SetupError(`${file}: not valid JSON (${e.message})`);
	}
	if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new SetupError(`${file}: the top level must be an object`);
	const known = new Set(['prefixes', 'replaceDefaults', 'ignore', 'exceptions', 'placement', 'plugins', '$comment']);
	for (const key of Object.keys(json)) if (!known.has(key)) throw new SetupError(`${file}: unknown key "${key}"`);
	const prefixes = json.prefixes ?? {};
	for (const [k, v] of Object.entries(prefixes)) {
		const ok = v === null || typeof v === 'string' || (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string'));
		if (!ok) throw new SetupError(`${file}: prefixes.${k} must be a string, an array of strings or null`);
	}
	cfg.prefixes = json.replaceDefaults ? { ...prefixes } : { ...cfg.prefixes, ...prefixes };
	const list = (key) => {
		const v = json[key];
		if (v === undefined) return null;
		if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new SetupError(`${file}: ${key} must be an array of strings`);
		return v;
	};
	cfg.ignore = list('ignore') ?? cfg.ignore;
	cfg.exceptions = list('exceptions') ?? [];
	if (json.placement !== undefined) {
		if (typeof json.placement !== 'object' || Array.isArray(json.placement)) throw new SetupError(`${file}: placement must be an object`);
		for (const [k, v] of Object.entries(json.placement)) {
			if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new SetupError(`${file}: placement.${k} must be an array of folders`);
		}
		cfg.placement = json.placement;
	}
	if (json.plugins !== undefined) cfg.plugins = Boolean(json.plugins);
	cfg.file = file;
	return cfg;
}

/** A package-path pattern: a prefix, or a glob (`*` one folder level, `**` any depth) matched from the start.
 *  Case-blind, like the engine's package names. */
export function pathMatcher(pattern) {
	if (!pattern.includes('*')) {
		const p = pattern.toLowerCase();
		return (path) => path.toLowerCase().startsWith(p);
	}
	const rx = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
	const re = new RegExp(`^${rx}`, 'i');
	return (path) => re.test(path);
}

// ---- project layout -------------------------------------------------------------------------------------------

/** [{mount, dir}]: `/Game/` and, unless `withPlugins` is false, `/<Plugin>/` for every plugin under Plugins/ with
 *  a Content folder. */
export function contentMounts(root, withPlugins = true) {
	const mounts = [{ mount: '/Game/', dir: join(root, 'Content') }];
	if (!withPlugins) return mounts;
	const walk = (dir, depth) => {
		let entries;
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			if (e.isFile() && e.name.toLowerCase().endsWith('.uplugin')) {
				const content = join(dir, 'Content');
				if (existsSync(content)) mounts.push({ mount: `/${basename(e.name, extname(e.name))}/`, dir: content });
				return;
			}
		}
		if (depth <= 0) return;
		for (const e of entries) if (e.isDirectory() && !['Binaries', 'Intermediate', 'Content', 'Source'].includes(e.name)) walk(join(dir, e.name), depth - 1);
	};
	walk(join(root, 'Plugins'), 4);
	return mounts;
}

export function packageNameOf(file, mounts) {
	const f = resolve(file);
	for (const { mount, dir } of mounts) {
		const rel = relative(resolve(dir), f);
		if (rel && !rel.startsWith('..') && !rel.includes(':')) {
			return mount + rel.slice(0, rel.length - extname(rel).length).split(sep).join('/');
		}
	}
	return null;
}

function fileOf(pkg, mounts) {
	for (const { mount, dir } of mounts) {
		if (!pkg.toLowerCase().startsWith(mount.toLowerCase())) continue;
		const rest = pkg.slice(mount.length);
		for (const ext of PackageExt) {
			const f = join(dir, rest + ext);
			if (existsSync(f)) return f;
		}
	}
	return null;
}

function walkPackages(dir, out) {
	let entries;
	try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
	for (const e of entries) {
		const f = join(dir, e.name);
		if (e.isDirectory()) { if (!NotAssets.has(e.name)) walkPackages(f, out); } else if (PackageExt.has(extname(e.name).toLowerCase())) out.push(f);
	}
	return out;
}

/** Child → parent (short names) for every `class X : public Y` of the project's C++ headers. */
export function sourceParents(root) {
	const parents = new Map();
	const rx = /^\s*class\s+(?:[A-Z0-9_]+_API\s+)?([UA][A-Z]\w*)\s*(?:final\s*)?:\s*public\s+([UA][A-Z]\w*)/gm;
	const scanText = (text) => { for (const m of text.matchAll(rx)) parents.set(m[1].slice(1), m[2].slice(1)); };
	const walk = (dir, depth) => {
		let entries;
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			const f = join(dir, e.name);
			if (e.isDirectory()) {
				if (depth > 0 && !['Binaries', 'Intermediate', 'Content', 'ThirdParty', '.git'].includes(e.name)) walk(f, depth - 1);
			} else if (e.name.endsWith('.h')) {
				try { scanText(readFileSync(f, 'utf8')); } catch { /* unreadable header: no parent from it */ }
			}
		}
	};
	walk(join(root, 'Source'), 12);
	walk(join(root, 'Plugins'), 16);
	return { parents, scanText };
}

// ---- classification -------------------------------------------------------------------------------------------

/** Classifier over a project: `classify(pkg)` → {cls, chain, parentChain}. Packages of Blueprint classes are read
 *  on demand and cached. */
export function makeClassifier(mounts, parents) {
	const bpCache = new Map();

	const nativeChain = (name, hierarchy) => {
		const chain = [name];
		if (hierarchy) chain.push(...hierarchy);
		let cur = chain[chain.length - 1];
		for (let guard = 0; guard < 40; guard++) {
			const up = BuiltinParents[cur] ?? parents.get(cur);
			if (!up || chain.includes(up)) break;
			chain.push(up);
			cur = up;
		}
		return chain;
	};

	// The chain of a class path: native (/Script/...) or a Blueprint generated class (/Game/.../BP_X.BP_X_C).
	const classChain = (path, depth = 0) => {
		const name = shortClass(path);
		const pkg = classPackage(path);
		if (!name) return [];
		if (!pkg || pkg.startsWith('/Script/') || !name.endsWith('_C')) return nativeChain(name);
		const own = name.slice(0, -2);
		if (depth > 20) return [own];
		if (!bpCache.has(pkg)) {
			let tags = null;
			const file = fileOf(pkg, mounts);
			if (file) {
				try { tags = mainAsset(readPackage(file))?.tags ?? null; } catch { tags = null; }
			}
			bpCache.set(pkg, tags);
		}
		const tags = bpCache.get(pkg);
		if (!tags) return [own];
		const up = tags.ParentClass ?? tags.NativeParentClass;
		const chain = [own, ...(up ? classChain(up, depth + 1) : [])];
		if (tags.NativeParentClass) for (const c of nativeChain(shortClass(tags.NativeParentClass))) if (!chain.includes(c)) chain.push(c);
		return chain;
	};

	return function classify(p) {
		const main = mainAsset(p);
		if (!main) return { cls: null, chain: [], parentChain: [] };
		const name = shortClass(main.class);
		const imp = p.imports.findIndex((i) => i.objectName === name);
		const hierarchy = imp >= 0 ? p.typeHierarchies.get(imp)?.map((t) => t.type) : null;
		const chain = hierarchy ? nativeChain(name, hierarchy) : classChain(main.class);
		const parentChain = [];
		const tags = main.tags;
		if (tags.NativeParentClass || tags.ParentClass) {
			const virtual = BlueprintTypeParent[tags.BlueprintType];
			if (virtual) parentChain.push(virtual);
			for (const c of classChain(tags.ParentClass ?? tags.NativeParentClass)) if (!parentChain.includes(c)) parentChain.push(c);
			if (tags.NativeParentClass) for (const c of nativeChain(shortClass(tags.NativeParentClass))) if (!parentChain.includes(c)) parentChain.push(c);
			if (!chain.includes('Blueprint')) chain.push('Blueprint');
		}
		return { cls: name, chain, parentChain };
	};
}

/** The table entry for a class: for each class of the chain, `<class>:<parent>` keys first, then the class. */
export function lookup(table, chain, parentChain) {
	for (const c of chain) {
		for (const parent of parentChain) {
			const key = `${c}:${parent}`;
			if (Object.hasOwn(table, key)) return { key, value: table[key] };
		}
		if (Object.hasOwn(table, c)) return { key: c, value: table[c] };
	}
	return null;
}

// ---- the lint -------------------------------------------------------------------------------------------------

/**
 * Judge packages. `files` — package files to judge (null: every package of the mounts). Returns
 * {checked, problems: [{rule, path, file, cls, expected, got}], unknown: Map(class → [paths]), skipped, ignored}.
 */
export function lint({ root, cfg, files = null, parents = null }) {
	const mounts = contentMounts(root, cfg.plugins);
	const classify = makeClassifier(mounts, parents ?? sourceParents(root).parents);
	const ignore = cfg.ignore.map(pathMatcher);
	const exceptions = cfg.exceptions.map(pathMatcher);
	const all = files ?? mounts.flatMap((m) => walkPackages(m.dir, []));
	const result = { checked: 0, problems: [], unknown: new Map(), skipped: 0, ignored: 0, outside: [] };
	for (const file of all.sort()) {
		if (file.split(/[\\/]/).some((seg) => NotAssets.has(seg))) continue;
		const path = packageNameOf(file, mounts);
		if (!path) { result.outside.push(file); continue; }
		if (ignore.some((m) => m(path))) { result.ignored++; continue; }
		const say = (rule, cls, expected, got) => result.problems.push({ rule, path, file, cls, expected, got });
		let p;
		try {
			p = readPackage(file);
		} catch (e) {
			if (!(e instanceof PackageError) && !e.code) throw e;
			say('unreadable', '?', 'an editor package', e.message.replace(`${file}: `, ''));
			continue;
		}
		const { cls, chain, parentChain } = classify(p);
		const name = path.split('/').pop();
		const segments = path.split('/').filter(Boolean);
		const bad = segments.find((s) => BadChar.test(s));
		if (bad !== undefined) say('characters', cls ?? '?', 'printable ASCII, no spaces', bad);
		const rule = cls ? lookup(cfg.prefixes, chain, parentChain) : null;
		if (!rule) {
			const key = cls ?? '(no asset in the registry block)';
			if (!result.unknown.has(key)) result.unknown.set(key, []);
			result.unknown.get(key).push(path);
			continue;
		}
		if (rule.value === null) { result.skipped++; continue; }
		result.checked++;
		const want = Array.isArray(rule.value) ? rule.value : [rule.value];
		if (!want.some((w) => name.startsWith(w)) && !exceptions.some((m) => m(path))) {
			const under = name.indexOf('_');
			say('prefix', rule.key === cls ? cls : `${cls}(${rule.key})`, want.join('|'), under > 0 ? name.slice(0, under + 1) : name);
		}
		const place = lookup(cfg.placement, chain, parentChain);
		if (place && place.value.length && !place.value.some((d) => pathMatcher(d)(path))) {
			say('placement', cls, place.value.join('|'), path.slice(0, path.length - name.length));
		}
	}
	return result;
}

/** Package files changed against `ref` (+ untracked), from `git diff --name-only` run in the project root. */
export function changedFiles(root, ref) {
	const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
	let lines;
	try {
		lines = git(['-c', 'core.quotepath=off', 'diff', '--name-only', '--relative', '--diff-filter=ACMR', ref, '--']).split('\n');
		lines.push(...git(['-c', 'core.quotepath=off', 'ls-files', '--others', '--exclude-standard']).split('\n'));
	} catch (e) {
		throw new SetupError(`git failed in ${root}: ${(e.stderr || e.message).toString().trim()}`);
	}
	return [...new Set(lines.map((l) => l.trim()).filter((l) => PackageExt.has(extname(l).toLowerCase())))]
		.map((l) => join(root, l)).filter((f) => existsSync(f));
}

function report(result, { json, verbose, root, cfg }) {
	const assets = new Set(result.problems.map((p) => p.path)).size;
	const unknownCount = [...result.unknown.values()].reduce((n, v) => n + v.length, 0);
	if (json) {
		console.log(JSON.stringify({
			root, config: cfg.file, checked: result.checked, skipped: result.skipped, ignored: result.ignored,
			problems: result.problems.map(({ rule, path, file, cls, expected, got }) => ({ rule, path, file: relative(root, file).split(sep).join('/'), class: cls, expected, got })),
			unknown: Object.fromEntries([...result.unknown].map(([k, v]) => [k, v])),
			outside: result.outside,
			result: { problems: result.problems.length, assets },
		}, null, 2));
		return;
	}
	for (const rule of ['unreadable', 'characters', 'prefix', 'placement']) {
		const group = result.problems.filter((p) => p.rule === rule);
		if (!group.length) continue;
		console.log(`== ${rule} (${group.length})`);
		for (const p of group) console.log(`${p.path} ${p.cls} ${p.expected} ${p.got}`);
	}
	if (result.unknown.size) {
		console.log(`INFO ${unknownCount} assets of ${result.unknown.size} classes the convention does not name (not judged; add them to prefixes, or null):`);
		for (const [cls, paths] of [...result.unknown].sort((a, b) => b[1].length - a[1].length)) {
			const shown = verbose ? paths : paths.slice(0, 3);
			console.log(`  ${cls} ${paths.length}: ${shown.join(' ')}${shown.length < paths.length ? ' ...' : ''}`);
		}
	}
	if (result.outside.length) console.log(`INFO ${result.outside.length} files outside every content mount, not judged: ${result.outside.slice(0, 3).join(' ')}`);
	console.log(`RESULT: ${result.problems.length} problems in ${assets} assets (${result.checked} judged, ${unknownCount} unknown class, ${result.skipped} not judged by rule, ${result.ignored} ignored)`);
}

// ---- selftest -------------------------------------------------------------------------------------------------

function selftest() {
	let failed = 0;
	const eq = (actual, expected, what) => {
		const a = JSON.stringify(actual), b = JSON.stringify(expected);
		if (a !== b) { console.error(`FAIL: ${what}\n  expected ${b}\n  got      ${a}`); failed++; }
	};
	const dir = mkdtempSync(join(tmpdir(), 'asset-name-lint-'));
	try {
		const put = (rel, buf) => { const f = join(dir, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, buf); return f; };
		const asset = (rel, cls, tags = {}, extra = {}) => {
			const name = basename(rel, extname(rel));
			const pkg = '/' + rel.replace(/^Content\//, 'Game/').replace(/\.(uasset|umap)$/, '');
			return put(rel, buildPackage({ assets: [{ objectPath: `${pkg}.${name}`, class: cls, tags }], ...extra }));
		};
		const parentTag = (c) => `/Script/CoreUObject.Class'${c}'`;
		put('Proj.uproject', '{}');
		put('Source/Proj/Public/Items.h', 'UCLASS()\nclass PROJ_API UCardItem : public UItemBase\n{};\nUCLASS()\nclass UItemBase final : public UPrimaryDataAsset {};\n');
		put('Plugins/Kit/Kit.uplugin', '{}');

		asset('Content/Props/SM_Rock.uasset', '/Script/Engine.StaticMesh');
		asset('Content/Props/Rock2.uasset', '/Script/Engine.StaticMesh');
		asset('Content/Props/SM_Ström.uasset', '/Script/Engine.StaticMesh');
		asset('Content/Props/SM Rock.uasset', '/Script/Engine.StaticMesh');
		asset('Content/Legacy/T_Old.uasset', 'Texture2D');
		asset('Content/BP/BP_Door.uasset', '/Script/Engine.Blueprint', { NativeParentClass: parentTag('/Script/Engine.Actor'), BlueprintType: 'BPTYPE_Normal' });
		asset('Content/BP/BPI_Usable.uasset', '/Script/Engine.Blueprint', { NativeParentClass: parentTag('/Script/CoreUObject.Interface'), BlueprintType: 'BPTYPE_Interface' });
		asset('Content/BP/I_Usable.uasset', '/Script/Engine.Blueprint', { NativeParentClass: parentTag('/Script/CoreUObject.Interface'), BlueprintType: 'BPTYPE_Interface' });
		asset('Content/BP/BFL_Utils.uasset', '/Script/Engine.Blueprint', { NativeParentClass: parentTag('/Script/Engine.BlueprintFunctionLibrary'), BlueprintType: 'BPTYPE_FunctionLibrary' });
		asset('Content/BP/GA_Jump.uasset', '/Script/GameplayAbilities.GameplayAbilityBlueprint', { NativeParentClass: parentTag('/Script/GameplayAbilities.GameplayAbility') });
		asset('Content/BP/Jump2.uasset', '/Script/Engine.Blueprint', { NativeParentClass: parentTag('/Script/GameplayAbilities.GameplayAbility') });
		asset('Content/UI/W_Menu.uasset', '/Script/UMGEditor.WidgetBlueprint', { NativeParentClass: parentTag('/Script/UMG.UserWidget') });
		asset('Content/Flow/FB_Node.uasset', '/Script/Flow.FlowNodeBlueprint', { NativeParentClass: parentTag('/Script/Flow.FlowNode') });
		asset('Content/Data/DA_Card1.uasset', '/Script/Proj.CardItem');
		asset('Content/Data/Card2.uasset', '/Script/Proj.CardItem');
		asset('Content/Data/BP_EnemyCfg.uasset', '/Script/Engine.Blueprint', { NativeParentClass: parentTag('/Script/Engine.PrimaryDataAsset'), ParentClass: parentTag('/Script/Engine.PrimaryDataAsset') });
		asset('Content/Data/Cfg_Boss.uasset', '/Game/Data/BP_EnemyCfg.BP_EnemyCfg_C');
		asset('Content/Data/Mystery1.uasset', '/Script/Other.MysteryAsset', {}, {
			names: ['None', '/Script/Other', 'Class', 'MysteryAsset', 'DataAsset'],
			imports: [{ classPackage: '/Script/Other', className: 'Class', objectName: 'MysteryAsset' }],
			hierarchies: [{ importIndex: 0, supers: ['DataAsset'] }],
		});
		asset('Content/Flow/FA_Quest.uasset', '/Script/Flow.FlowAsset');
		asset('Content/Developers/me/Junk.uasset', '/Script/Engine.StaticMesh');
		asset('Content/Maps/__ExternalActors__/Level1/0/AB/XYZ.uasset', '/Script/Engine.StaticMeshActor');
		asset('Content/Maps/Level1.umap', '/Script/Engine.World');
		asset('Content/Old/Redirect.uasset', '/Script/CoreUObject.ObjectRedirector');
		put('Content/Broken.uasset', Buffer.from('not a package at all, just text padding....'));
		put('Plugins/Kit/Content/Mesh.uasset', buildPackage({ assets: [{ objectPath: '/Kit/Mesh.Mesh', class: '/Script/Engine.StaticMesh', tags: {} }] }));

		// the reader and the classification
		const p = readPackage(join(dir, 'Content/Data/Mystery1.uasset'));
		eq([p.imports[0].objectName, [...p.typeHierarchies]], ['MysteryAsset', [[0, [{ type: 'DataAsset', package: 'None' }]]]], 'imports and the import type hierarchy are read');
		eq([shortClass("/Script/CoreUObject.Class'/Script/Engine.Actor'"), shortClass('/Game/A/BP_X.BP_X_C'), classPackage('/Game/A/BP_X.BP_X_C')], ['Actor', 'BP_X_C', '/Game/A/BP_X'], 'class path helpers');
		const { parents } = sourceParents(dir);
		eq([parents.get('CardItem'), parents.get('ItemBase')], ['ItemBase', 'PrimaryDataAsset'], 'project class parents from headers');
		const mounts = contentMounts(dir);
		eq(mounts.map((m) => m.mount), ['/Game/', '/Kit/'], 'plugin content is a mount');
		const classify = makeClassifier(mounts, parents);
		const cl = (rel) => classify(readPackage(join(dir, rel)));
		eq(cl('Content/Data/Card2.uasset').chain, ['CardItem', 'ItemBase', 'PrimaryDataAsset', 'DataAsset'], 'a project data asset class climbs to DataAsset');
		eq(cl('Content/Data/Cfg_Boss.uasset').chain, ['BP_EnemyCfg', 'PrimaryDataAsset', 'DataAsset'], 'an instance of a Blueprint class climbs through the Blueprint package');
		eq(cl('Content/BP/I_Usable.uasset').parentChain[0], 'Interface', 'BlueprintType gives the virtual parent');
		eq(cl('Content/Flow/FB_Node.uasset').chain, ['FlowNodeBlueprint', 'Blueprint'], 'an unknown Blueprint kind falls back to Blueprint');
		eq(cl('Content/Data/Mystery1.uasset').chain, ['MysteryAsset', 'DataAsset'], 'a type hierarchy in the package wins');
		eq(lookup({ Blueprint: 'BP_', 'Blueprint:Interface': 'BPI_' }, ['Blueprint'], ['Interface', 'Object']).value, 'BPI_', 'a class:parent key beats the class');
		eq([pathMatcher('/Game/**/Demo/')('/Game/A/B/Demo/X'), pathMatcher('/Game/*/Demo/')('/Game/A/B/Demo/X'), pathMatcher('/game/dev/')('/Game/Dev/X')], [true, false, true], 'ignore patterns: prefix, *, **, case-blind');

		// the whole lint with the defaults
		const r = lint({ root: dir, cfg: loadConfig(null) });
		const got = r.problems.map((x) => `${x.rule} ${x.path} ${x.expected} ${x.got}`).sort();
		eq(got, [
			'characters /Game/Props/SM Rock printable ASCII, no spaces SM Rock',
			'characters /Game/Props/SM_Ström printable ASCII, no spaces SM_Ström',
			'prefix /Game/BP/BFL_Utils BPFL_ BFL_',
			'prefix /Game/BP/I_Usable BPI_ I_',
			'prefix /Game/BP/Jump2 GA_ Jump2',
			'prefix /Game/Data/Card2 DA_ Card2',
			'prefix /Game/Data/Cfg_Boss DA_ Cfg_',
			'prefix /Game/Data/Mystery1 DA_ Mystery1',
			'prefix /Game/Flow/FB_Node BP_ FB_',
			'prefix /Game/Maps/Level1 L_ Level1',
			'prefix /Game/Props/Rock2 SM_ Rock2',
			'prefix /Game/Props/SM Rock SM_ SM Rock',
			'prefix /Game/UI/W_Menu WBP_ W_',
			'prefix /Kit/Mesh SM_ Mesh',
			'unreadable /Game/Broken an editor package not a package (bad tag)',
		], 'default convention findings');
		eq([...r.unknown.keys()], ['FlowAsset'], 'an unknown class is info, not a problem');
		eq([r.ignored, r.skipped], [1, 1], 'Developers ignored, redirector not judged, external actors never walked');

		// the convention file
		const cfgFile = put('.claude/asset-names.json', JSON.stringify({
			prefixes: { World: null, WidgetBlueprint: ['WBP_', 'W_'], FlowAsset: 'FA_' },
			ignore: ['/Game/Developers/', '/Game/Props/', '/Game/**/Old/'],
			exceptions: ['/Game/BP/I_*'],
			placement: { DataAsset: ['/Game/Data/'], StaticMesh: ['/Game/Meshes/'] },
			plugins: false,
		}));
		const cfg = loadConfig(cfgFile);
		const r2 = lint({ root: dir, cfg });
		const got2 = r2.problems.filter((x) => x.rule !== 'unreadable').map((x) => `${x.rule} ${x.path} ${x.expected} ${x.got}`).sort();
		eq(got2, [
			'prefix /Game/BP/BFL_Utils BPFL_ BFL_',
			'prefix /Game/BP/Jump2 GA_ Jump2',
			'prefix /Game/Data/Card2 DA_ Card2',
			'prefix /Game/Data/Cfg_Boss DA_ Cfg_',
			'prefix /Game/Data/Mystery1 DA_ Mystery1',
			'prefix /Game/Flow/FB_Node BP_ FB_',
		], 'the file: merged prefixes, arrays, null, ignore globs, exceptions, plugins off');
		eq(r2.unknown.size, 0, 'a class named in the file is no longer unknown');
		const r3 = lint({ root: dir, cfg: { ...cfg, ignore: [], placement: { StaticMesh: ['/Game/Meshes/'] } }, files: [join(dir, 'Content/Props/SM_Rock.uasset')] });
		eq(r3.problems.map((x) => `${x.rule} ${x.expected} ${x.got}`), ['placement /Game/Meshes/ /Game/Props/'], 'placement pins a class to folders');
		eq(loadConfig(cfgFile).prefixes.StaticMesh, 'SM_', 'defaults survive a merge');
		const bad = put('.claude/bad.json', '{"prefixes": {"StaticMesh": 5}}');
		let threw = '';
		try { loadConfig(bad); } catch (e) { threw = e instanceof SetupError ? 'setup' : 'other'; }
		eq(threw, 'setup', 'a malformed convention file is a setup error');
		eq(packageNameOf(join(dir, 'Content/A/B.uasset'), mounts), '/Game/A/B', 'file → package name');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	if (failed) { console.error(`asset-name-lint selftest: ${failed} failure(s)`); return 1; }
	console.log('asset-name-lint selftest: ok');
	return 0;
}

// ---- main -----------------------------------------------------------------------------------------------------

function main(args) {
	if (args.includes('--selftest')) return selftest();
	const take = (flag) => {
		const i = args.indexOf(flag);
		if (i < 0) return undefined;
		const v = args[i + 1];
		args.splice(i, v !== undefined && !v.startsWith('--') ? 2 : 1);
		return v !== undefined && !v.startsWith('--') ? v : null;
	};
	const rootArg = take('--root');
	const configArg = take('--config');
	const changedAt = args.indexOf('--changed');
	let changedRef;
	if (changedAt >= 0) {
		const v = args[changedAt + 1];
		const isRef = v !== undefined && !v.startsWith('--') && !existsSync(v);
		changedRef = isRef ? v : 'HEAD';
		args.splice(changedAt, isRef ? 2 : 1);
	}
	const flags = new Set(args.filter((a) => a.startsWith('--')));
	const known = new Set(['--json', '--verbose', '--print-config', '--no-plugins', '--help', '-h']);
	for (const f of flags) if (!known.has(f)) throw new SetupError(`unknown option ${f}`);
	if (flags.has('--help')) { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n\n')[0].replace(/^\/\/ ?/gm, '')); return 0; }
	const uproject = rootArg ? null : findUproject(process.env.CLAUDE_PROJECT_DIR && !findUproject(process.cwd()) ? process.env.CLAUDE_PROJECT_DIR : process.cwd());
	const root = rootArg ? resolve(rootArg) : uproject ? dirname(uproject) : null;
	if (!root || !existsSync(join(root, 'Content'))) throw new SetupError(`no Unreal project here (${root ?? process.cwd()}): run from the project root or pass --root`);
	const cfg = loadConfig(configArg ? resolve(configArg) : join(root, '.claude', 'asset-names.json'));
	if (configArg && !cfg.file) throw new SetupError(`config ${configArg} not found`);
	if (flags.has('--no-plugins')) cfg.plugins = false;
	if (flags.has('--print-config')) { console.log(JSON.stringify(cfg, null, 2)); return 0; }

	let files = null;
	const targets = args.filter((a) => !a.startsWith('--'));
	if (changedRef !== undefined) files = changedFiles(root, changedRef);
	if (targets.length) {
		const picked = [];
		for (const t of targets) {
			const f = resolve(t);
			if (!existsSync(f)) throw new SetupError(`not found: ${t}`);
			if (statSync(f).isDirectory()) walkPackages(f, picked); else picked.push(f);
		}
		files = files ? files.filter((f) => picked.includes(f)) : picked;
	}
	const result = lint({ root, cfg, files });
	report(result, { json: flags.has('--json'), verbose: flags.has('--verbose'), root, cfg });
	return result.problems.length ? 1 : 0;
}

try {
	process.exitCode = main(process.argv.slice(2));
} catch (e) {
	console.error(`asset-name-lint: ${e instanceof SetupError ? e.message : e.stack}`);
	console.log('RESULT: the check could not run (this is NOT clean)');
	process.exitCode = 2;
}
