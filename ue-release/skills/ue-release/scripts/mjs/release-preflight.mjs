// release-preflight.mjs — offline pre-release audit of a UE project. Reads files only; starts nothing.
//
//   node release-preflight.mjs [--project <dir>] [--platform Windows] [--require-pso] [--only meta,branding,pso,debug]
//
// Checks (each prints [ OK ] / [WARN] / [FAIL] lines):
//   meta      Config/DefaultGame.ini [/Script/EngineSettings.GeneralProjectSettings]: ProjectVersion not the
//             template 1.0.0.0, CompanyName not empty / MyCompany / Epic Games, ProjectDisplayedTitle, CopyrightNotice.
//   branding  Build/Windows/Application.ico (UBT embeds it into the exe; else the Unreal icon),
//             Content/Splash/Splash.{png,jpg,bmp} (else the engine splash), EdSplash (editor only -> WARN).
//   pso       a bundled PSO cache where the 5.8 cooker looks for it:
//             Build/<Platform>/PipelineCaches/*<Project>_<ShaderFormat>.{spc,stablepc.csv[.compressed]} for every
//             D3D12/D3D11/Vulkan targeted shader format in DefaultEngine.ini. Missing -> WARN (FAIL with
//             --require-pso). A cache under Content/PipelineCaches is in the wrong place (the cooker deletes an
//             uncooked .upipelinecache there and never reads a .csv there) -> WARN.
//   debug     runtime-module sources (Editor/Developer/UncookedOnly modules skipped), outside a
//             `#if UE_ENABLE_DEBUG_DRAWING` / ENABLE_DRAW_DEBUG / !UE_BUILD_SHIPPING / WITH_EDITOR guard:
//             any DrawDebug* under SHIPPING_DRAW_DEBUG_ERROR -> FAIL (Shipping compile error); otherwise
//             DrawDebug* -> WARN per file (empty stubs, arguments still computed);
//             UFUNCTION(Exec), console commands, AddOnScreenDebugMessage -> WARN.
//
// Exit: 0 no FAIL (WARN allowed), 1 at least one FAIL, 2 usage / no project.

import { existsSync, readFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { findFiles, iniValue, parseArgs, readIni, resolveProject } from './release-common.mjs';

const { flags, opts } = parseArgs(process.argv.slice(2), ['project', 'platform', 'only']);
if (flags.has('help')) {
	console.log('usage: release-preflight [--project <dir>] [--platform Windows] [--require-pso] [--only meta,branding,pso,debug]');
	process.exit(0);
}
const project = resolveProject(opts.get('project'));
const platform = opts.get('platform') ?? 'Windows';
const only = new Set((opts.get('only') ?? 'meta,branding,pso,debug').split(',').map((s) => s.trim()));

let fails = 0;
let warns = 0;
const ok = (m) => console.log(`[ OK ] ${m}`);
const warn = (m) => { warns++; console.log(`[WARN] ${m}`); };
const fail = (m) => { fails++; console.log(`[FAIL] ${m}`); };
const rel = (p) => relative(project.root, p).split(sep).join('/');

console.log(`=== release preflight: ${project.uproject} (${platform}) ===`);

// -- meta --------------------------------------------------------------------------------------------------------
if (only.has('meta')) {
	const game = readIni(join(project.root, 'Config', 'DefaultGame.ini'));
	const S = '/Script/EngineSettings.GeneralProjectSettings';
	if (!game) fail('Config/DefaultGame.ini missing');
	else {
		const version = iniValue(game, S, 'ProjectVersion');
		const company = iniValue(game, S, 'CompanyName');
		const title = iniValue(game, S, 'ProjectDisplayedTitle');
		const copyright = iniValue(game, S, 'CopyrightNotice');
		if (!version || version === '1.0.0.0') fail(`ProjectVersion ${version ? 'is the template 1.0.0.0' : 'not set'} - Project Settings > Description`);
		else ok(`ProjectVersion ${version}`);
		if (!company || /^(MyCompany|Epic Games)$/i.test(company)) fail(`CompanyName ${company ? `is "${company}"` : 'not set'}`);
		else ok(`CompanyName ${company}`);
		if (title) ok(`ProjectDisplayedTitle set`);
		else warn('ProjectDisplayedTitle not set - the window title falls back to the project name');
		if (copyright) ok('CopyrightNotice set');
		else warn('CopyrightNotice not set');
	}
}

// -- branding ----------------------------------------------------------------------------------------------------
if (only.has('branding')) {
	const ico = join(project.root, 'Build', 'Windows', 'Application.ico');
	if (existsSync(ico)) ok('Build/Windows/Application.ico');
	else fail('Build/Windows/Application.ico missing - the packaged exe gets the Unreal icon');
	const splash = (name) => ['png', 'jpg', 'bmp'].map((e) => join(project.root, 'Content', 'Splash', `${name}.${e}`)).find(existsSync);
	const game = splash('Splash');
	if (game) ok(rel(game));
	else fail('Content/Splash/Splash.{png,jpg,bmp} missing - the game shows the engine splash');
	const ed = splash('EdSplash');
	if (ed) ok(rel(ed));
	else warn('Content/Splash/EdSplash.{png,jpg,bmp} missing - editor only, the engine splash is used');
}

// -- pso ---------------------------------------------------------------------------------------------------------
if (only.has('pso')) {
	const eng = readIni(join(project.root, 'Config', 'DefaultEngine.ini')) ?? {};
	const W = '/Script/WindowsTargetPlatform.WindowsTargetSettings';
	const formats = platform === 'Windows'
		? [...new Set(['D3D12TargetedShaderFormats', 'D3D11TargetedShaderFormats', 'VulkanTargetedShaderFormats'].flatMap((k) => eng[W]?.[k] ?? []))]
		: [];
	if (platform === 'Windows' && !formats.length) formats.push('PCD3D_SM6');
	const dir = join(project.root, 'Build', platform, 'PipelineCaches');
	const all = findFiles(dir, /\.(spc|stablepc\.csv(\.compressed)?)$/i);
	if (!formats.length) {
		if (all.length) ok(`${all.length} stable PSO file(s) in ${rel(dir)}`);
		else (flags.has('require-pso') ? fail : warn)(`no stable PSO cache in ${rel(dir)} (platform ${platform}: name the shader formats yourself)`);
	}
	for (const sf of formats) {
		const tail = `${project.name}_${sf}`.toLowerCase();
		const hit = all.filter((f) => basename(f).toLowerCase().replace(/\.(spc|stablepc\.csv(\.compressed)?)$/, '').endsWith(tail));
		if (hit.length) ok(`PSO cache for ${sf}: ${hit.map(rel).join(', ')}`);
		else (flags.has('require-pso') ? fail : warn)(`no bundled PSO cache for ${sf}: expected ${rel(dir)}/*${project.name}_${sf}.spc (or .stablepc.csv) - see references/pso-cache.md; PSO precaching (r.PSOPrecaching=1, default) still runs`);
	}
	const wrong = findFiles(join(project.root, 'Content', 'PipelineCaches'), /\.(spc|stablepc\.csv(\.compressed)?|upipelinecache)$/i);
	for (const f of wrong) warn(`${rel(f)} - wrong place: the cooker reads stable caches from Build/<Platform>/PipelineCaches only`);
}

// -- debug -------------------------------------------------------------------------------------------------------
const NonShippingGuard = /UE_ENABLE_DEBUG_DRAWING|ENABLE_DRAW_DEBUG|WITH_EDITOR|!\s*UE_BUILD_SHIPPING|UE_WITH_CHEAT_MANAGER|WITH_(DEV_)?AUTOMATION_TESTS|UE_BUILD_DEBUG|UE_BUILD_DEVELOPMENT|ALLOW_CONSOLE|!\s*NO_LOGGING|WITH_CHEATS/;
// The free functions of DrawDebugHelpers.h (UE 5.8). With ENABLE_DRAW_DEBUG off (Shipping/Test game builds,
// UE_ENABLE_DEBUG_DRAWING in EngineDefines.h) the header gives every one of them an empty inline stub - the call
// compiles and does nothing, though its arguments are still evaluated. A project that defines
// SHIPPING_DRAW_DEBUG_ERROR drops all the stubs: then every unguarded call is a Shipping compile error.
// A member call `X.DrawCircle(` or a project method named DrawDebugShape is not one of them.
const DebugDraw = /(?<![\w.>:])(DrawCentripetalCatmullRomSpline|DrawCircle|DrawDebug(?:2DDonut|AltCone|Box|Camera|Canvas2DBox|Canvas2DCircle|Canvas2DLine|CanvasCapsule|CanvasCircle|CanvasHalfCircle|CanvasLine|CanvasWireBox|CanvasWireCone|CanvasWireSphere|Capsule|Circle|CircleArc|Cone|CoordinateSystem|Crosshairs|Cylinder|DirectionalArrow|FloatHistory|Frustum|Line|Mesh|Point|SolidBox|SolidPlane|Sphere|String)|FlushDebugStrings|FlushPersistentDebugLines)\s*\(/;
const ShippingOnly = /^\s*\(?\s*UE_BUILD_SHIPPING\s*\)?\s*$/;

/** PURE: per-line «inside a non-Shipping preprocessor branch» for C++ text. */
export function guardedLines(text) {
	const stack = [];
	const out = [];
	for (const line of text.split(/\r?\n/)) {
		const pp = line.match(/^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b(.*)$/);
		if (pp) {
			const [, kw, rest] = pp;
			const cond = kw === 'ifndef' ? `!${rest.trim()}` : rest.replace(/\/\/.*$/, '').trim();
			if (kw === 'if' || kw === 'ifdef' || kw === 'ifndef') stack.push({ cond, inElse: false });
			else if (kw === 'elif' && stack.length) stack[stack.length - 1] = { cond, inElse: false };
			else if (kw === 'else' && stack.length) stack[stack.length - 1].inElse = true;
			else if (kw === 'endif') stack.pop();
		}
		out.push(stack.some((f) => (!f.inElse && NonShippingGuard.test(f.cond)) || (f.inElse && ShippingOnly.test(f.cond))));
	}
	return out;
}

function runtimeSourceRoots() {
	const skip = /^(Editor|EditorNoCommandlet|EditorAndProgram|UncookedOnly|Developer|DeveloperTool|Program)$/i;
	const roots = [];
	const add = (descriptorPath, base) => {
		let d;
		try { d = JSON.parse(readFileSync(descriptorPath, 'utf8')); } catch { return; }
		for (const m of d.Modules ?? []) if (!skip.test(m.Type ?? '')) roots.push(join(base, 'Source', m.Name));
	};
	add(project.uproject, project.root);
	for (const up of findFiles(join(project.root, 'Plugins'), /\.uplugin$/i)) add(up, join(up, '..'));
	return roots.filter(existsSync);
}

if (only.has('debug')) {
	const roots = runtimeSourceRoots();
	if (!roots.length) warn('no runtime C++ modules found - debug scan skipped');
	const findings = { fail: [], warn: [] };
	const stubless = [...findFiles(join(project.root, 'Source'), /\.(Target|Build)\.cs$/i)].some((f) => {
		try { return /SHIPPING_DRAW_DEBUG_ERROR\s*=\s*1/.test(readFileSync(f, 'utf8')); } catch { return false; }
	});
	const noOps = new Map(); // file -> count of unguarded calls that are empty stubs in Shipping
	for (const root of roots) {
		for (const file of findFiles(root, /\.(h|hpp|inl|cpp)$/i)) {
			if (/[\\/](ThirdParty|Tests?)[\\/]/i.test(file)) continue;
			const text = readFileSync(file, 'utf8');
			const guarded = guardedLines(text);
			text.split(/\r?\n/).forEach((line, i) => {
				if (guarded[i] || /^\s*\/\//.test(line)) return;
				const at = `${rel(file)}:${i + 1}`;
				if (DebugDraw.test(line) && !/#\s*include/.test(line)) {
					if (stubless) findings.fail.push(`${at}: ${line.trim()}`);
					else noOps.set(rel(file), (noOps.get(rel(file)) ?? 0) + 1);
				}
				else if (/UFUNCTION\s*\([^)]*\bExec\b/.test(line)) findings.warn.push(`${at}: Exec function (console is off in Shipping unless ALLOW_CONSOLE_IN_SHIPPING)`);
				else if (/FAutoConsole(Command|Variable)\w*|RegisterConsole(Command|Variable)/.test(line)) findings.warn.push(`${at}: console command/variable registered in Shipping`);
				else if (/AddOnScreenDebugMessage\s*\(/.test(line)) findings.warn.push(`${at}: on-screen debug message`);
			});
		}
	}
	for (const f of findings.fail) fail(`unguarded debug draw (Shipping compile error: SHIPPING_DRAW_DEBUG_ERROR drops the stubs): ${f}`);
	for (const [file, n] of noOps) findings.warn.push(`${file}: ${n} unguarded debug draw call(s) - empty stubs in Shipping, but their arguments are still computed; wrap hot paths in #if ENABLE_DRAW_DEBUG`);
	for (const w of findings.warn) warn(w);
	if (roots.length && !findings.fail.length && !findings.warn.length) ok(`debug scan: ${roots.length} runtime module(s) clean`);
}

console.log(`\nRESULT: ${fails} FAIL, ${warns} WARN`);
process.exit(fails ? 1 : 0);
