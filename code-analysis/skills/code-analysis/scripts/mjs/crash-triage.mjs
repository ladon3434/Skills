// crash-triage.mjs — an Unreal crash folder (or a bare minidump) to a readable, symbolicated callstack + the error,
// without the Crash Reporter window. Windows, Node 18+, stdlib only.
//
//   node crash-triage.mjs [<crash folder> | <.dmp> | <CrashContext.runtime-xml>] [options]
//   node crash-triage.mjs --list                 every crash folder of the project, newest first, one line each
//   node crash-triage.mjs --selftest             offline checks on built-in fixtures
//
// Options:
//   --project <dir>      the project to take crashes from (default: the .uproject above cwd / CLAUDE_PROJECT_DIR)
//   --top <N>            frames to show (default 25)
//   --symbolicate        run Step B (cdb on the minidump) even when the stack is already symbolicated
//   --no-symbolicate     never run Step B
//   --symbols <dir>      extra PDB folder (a packaged build's symbols), repeatable
//   --ms-symbols         add srv*<cache>*https://msdl.microsoft.com/download/symbols (OS modules; downloads)
//   --cdb <path>         cdb.exe to use (else CDB_EXE, PATH, Windows Kits, the WinDbg app)
//   --timeout <sec>      cdb time limit (default 300)
//   --json               machine output
//
// No argument: the newest crash folder under <project>/Saved/Crashes and %LOCALAPPDATA%\<Project>\Saved\Crashes.
//
// Step A (always): CrashContext.runtime-xml + the crash folder's log. Element names are the engine's own:
//   Runtime/Core/Private/GenericPlatform/GenericPlatformCrashContext.cpp — CrashVersion/CrashType/ErrorMessage
//   (SerializeContentToBuffer), ExecutableName/BuildConfiguration/EngineVersion/BuildVersion (SerializeSessionContext),
//   <CallStack> (empty in-process), <PCallStack> "module 0xBASE + offset" lines (AppendPortableCallstack),
//   <Threads>, <EnabledPlugins>; the Crash Report Client then fills CallStack/Modules/SourceContext/TimeOfCrash
//   (Runtime/CrashReportCore/Private/CrashDescription.cpp, GenericErrorReport.cpp) with frames in the format of
//   FGenericPlatformStackWalk::SymbolInfoToHumanReadableStringEx: "Module!Function() [File:Line]" or a bare
//   "Module" when the PDB was missing at crash time.
// Step B (stack unsymbolicated, or --symbolicate): cdb -lines -z <dmp> -y <symbols> -i <images> -c ".ecxr;kn 50;q".
// The command is printed so a person can rerun it.
//
// Exit: 0 a stack was produced · 1 nothing usable (no frames) · 2 setup error (no crash, no project, no cdb when
// --symbolicate was asked, bad arguments). Last line: RESULT: crash <type> at <frame>.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectInfo, resolveEngine } from './ue-engine.mjs';

const XmlName = 'CrashContext.runtime-xml';
const DumpName = 'UEMinidump.dmp';
const DefaultTop = 25;
const CdbFrames = 50;

// ---------------------------------------------------------------- xml

/** PURE: the XML escapes the engine writes (AppendEscapedXMLString) back to text. */
export function unescapeXml(s) {
	return String(s ?? '')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&nl;/g, '\n')
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
		.replace(/&amp;/g, '&');
}

/** PURE: the text of the first <Tag>…</Tag> inside `xml` (null when absent; '' for <Tag />). */
export function element(xml, tag) {
	if (!xml) return null;
	const t = tag.replace(/[.]/g, '\\.');
	const m = xml.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>|<${t}\\s*/>`));
	if (!m) return null;
	return m[1] === undefined ? '' : unescapeXml(m[1]);
}

/** PURE: the fields of a CrashContext.runtime-xml that the digest needs. */
export function parseCrashXml(xml) {
	const rt = xml.match(/<RuntimeProperties>([\s\S]*?)<\/RuntimeProperties>/)?.[1] ?? xml;
	// The crashing thread's stack is the CallStack that is a direct child of RuntimeProperties, not one under Threads.
	const top = rt.replace(/<Threads>[\s\S]*?<\/Threads>/, '');
	const get = (tag) => element(top, tag);
	const threads = [...rt.matchAll(/<Thread>([\s\S]*?)<\/Thread>/g)].map((m) => ({
		name: element(m[1], 'ThreadName') ?? '',
		id: element(m[1], 'ThreadID') ?? '',
		crashed: (element(m[1], 'IsCrashed') ?? '').toLowerCase() === 'true',
		callStack: element(m[1], 'CallStack') ?? '',
	}));
	const engineData = {};
	const ed = xml.match(/<EngineData>([\s\S]*?)<\/EngineData>/)?.[1] ?? '';
	for (const m of ed.matchAll(/<([A-Za-z0-9_.]+)>([\s\S]*?)<\/\1>/g)) engineData[m[1]] = unescapeXml(m[2]);
	const modules = (get('Modules') ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
	const plugins = (xml.match(/<EnabledPlugins>([\s\S]*?)<\/EnabledPlugins>/)?.[1] ?? '').match(/<Plugin>/g)?.length ?? 0;
	return {
		crashVersion: get('CrashVersion'),
		crashGuid: get('CrashGUID'),
		crashType: get('CrashType') || (get('IsAssert') === 'true' ? 'Assert' : get('IsEnsure') === 'true' ? 'Ensure' : get('IsStall') === 'true' ? 'Stall' : 'Crash'),
		// An ensure's message carries its own "Stack:" + address lines (AssertionMacros.cpp); the stack is CallStack's job.
		errorMessage: (get('ErrorMessage') ?? '').split(/\r?\n\s*Stack:\s*(?:\r?\n|$)/)[0].replace(/\s+$/, ''),
		gameName: get('GameName'),
		executableName: get('ExecutableName'),
		buildConfiguration: get('BuildConfiguration'),
		platformName: get('PlatformName'),
		engineMode: get('EngineMode'),
		engineVersion: get('EngineVersion'),
		buildVersion: get('BuildVersion'),
		isWithDebugInfo: get('IsWithDebugInfo'),
		commandLine: get('CommandLine'),
		baseDir: get('BaseDir'),
		rootDir: get('RootDir'),
		secondsSinceStart: get('SecondsSinceStart'),
		timeOfCrash: ticksToIso(get('TimeOfCrash')),
		sourceContext: get('SourceContext') ?? '',
		callStack: get('CallStack') ?? '',
		pCallStack: get('PCallStack') ?? '',
		pCallStackHash: get('PCallStackHash'),
		modules,
		threads,
		engineData,
		plugins,
		gpuBreadcrumbs: /<GPUBreadcrumbs>/.test(rt),
	};
}

/** PURE: .NET ticks (TimeOfCrash, CrashDescription.cpp) to an ISO date; null when not a number. */
export function ticksToIso(ticks) {
	if (!ticks || !/^\d{15,}$/.test(ticks)) return null;
	const ms = Number((BigInt(ticks) - 621355968000000000n) / 10000n);
	return new Date(ms).toISOString();
}

// ---------------------------------------------------------------- frames

/**
 * PURE: one callstack line to a frame {module, function, offset, file, line, address, symbolicated}, or null.
 * Formats: the Crash Report Client's "Module!Function() [File:Line]" / bare "Module"; the in-process log's
 * "0xADDR Module.dll!Function [File:Line]" / "…!UnknownFunction []"; PCallStack "Module 0xBASE + offset".
 */
export function parseFrameLine(raw) {
	let s = String(raw).replace(/^\s*(\[[^\]]*\])*\s*(Log\w+:\s*Error:\s*)?\[Callstack\]\s*/, '').trim();
	if (!s) return null;
	let m = s.match(/^(\S+)\s+0x([0-9a-f]+)\s+\+\s+([0-9a-f]+)\s*$/i);
	if (m) return { module: m[1], function: null, offset: '0x' + m[3].toLowerCase(), file: null, line: null, address: null, symbolicated: false };
	let address = null;
	m = s.match(/^0x([0-9a-f]+)\s+(.*)$/i);
	if (m) {
		address = '0x' + m[1].toLowerCase();
		s = m[2];
	}
	let file = null;
	let line = null;
	m = s.match(/^(.*?)\s*\[([^\]]*)\]\s*$/);
	if (m) {
		s = m[1];
		const fl = m[2].match(/^(.*):(\d+)$/);
		if (fl) {
			file = fl[1];
			line = Number(fl[2]);
		}
	}
	let mod = s;
	let fn = null;
	const bang = s.indexOf('!');
	if (bang >= 0) {
		mod = s.slice(0, bang);
		fn = s.slice(bang + 1).trim() || null;
	}
	mod = mod.trim().replace(/\.(dll|exe)$/i, '');
	if (fn === 'UnknownFunction') fn = null;
	if (!mod && !fn) return null;
	return { module: mod || '?', function: fn, offset: null, file, line, address, symbolicated: Boolean(fn) };
}

export function parseFrames(text) {
	return String(text ?? '')
		.split(/\r?\n/)
		.map(parseFrameLine)
		.filter(Boolean);
}

/** PURE: cdb `kn` output to frames. Lines: "NN Child-SP RetAddr Call Site", inline frames "(Inline Function) --------`--------". */
export function parseCdbOutput(text) {
	const frames = [];
	const warnings = new Set();
	for (const rawLine of String(text ?? '').split(/\r?\n/)) {
		const l = rawLine.replace(/\s+$/, '');
		if (/^\*\*\* (WARNING|ERROR)|^WARNING:|Unable to load image|Symbol file could not be found|Stack unwind information not available/.test(l)) {
			warnings.add(l.replace(/^\*+\s*/, '').trim());
			continue;
		}
		const m = l.match(/^\s*([0-9a-f]{2,})\s+(?:\(Inline Function\)\s+\S+|[0-9a-f`]{8,}\s+[0-9a-f`]{8,})\s+(.+)$/i);
		if (!m) continue;
		const site = m[2].trim();
		const fr = { index: parseInt(m[1], 16), module: null, function: null, offset: null, file: null, line: null, address: null, inline: /\(Inline Function\)/.test(l), symbolicated: false };
		let rest = site;
		const src = rest.match(/^(.*?)\s+\[(.+) @ (\d+)\]\s*$/);
		if (src) {
			rest = src[1];
			fr.file = src[2];
			fr.line = Number(src[3]);
		}
		const off = rest.match(/^(.*?)\+(0x[0-9a-f`]+)$/i);
		if (off) {
			rest = off[1];
			fr.offset = off[2].replace(/`/g, '').toLowerCase();
		}
		if (/^0x[0-9a-f`]+$/i.test(rest)) {
			fr.module = '?';
			fr.address = rest.replace(/`/g, '');
		} else {
			const bang = rest.indexOf('!');
			fr.module = bang >= 0 ? rest.slice(0, bang) : rest;
			fr.function = bang >= 0 ? rest.slice(bang + 1) : null;
		}
		fr.symbolicated = Boolean(fr.function);
		frames.push(fr);
	}
	return { frames, warnings: [...warnings] };
}

// ---------------------------------------------------------------- classification

const SystemModule = /^(ntdll|kernel32|kernelbase|ucrtbase|ucrtbased|msvcp\d+\w*|vcruntime\d+\w*|concrt\d+|user32|win32u|gdi32\w*|combase|ole32|oleaut32|rpcrt4|sechost|advapi32|shell32|shcore|ws2_32|bcrypt\w*|crypt32|dbghelp|dbgcore|apphelp|textinputframework|coremessaging|uxtheme|dwmapi|d3d1[0-2]\w*|d3d12core|dxgi|dxcore|d3dcompiler_\d+|nvwgf2umx\w*|nvoglv64|nvapi64|nvldumdx|nvgpucomp64|amdxc64|amdxx64|atidxx64|amd_ags_x64|igd\w+|igc\w+|intelcontrollib|gfsdk_\w+|nvrtc\w*|tbbmalloc\w*|python3\d*|libcef\w*|xinput\w*|xaudio\w*|mfplat|wintrust|winmm\w*|hid|setupapi|cfgmgr32|ntoskrnl|wow64\w*|clr|coreclr|mscorlib|\?)$/i;
const MachineryFn = /^`?(FDebug::|FMRSWRecursiveAccessDetector::|FRWRecursiveAccessDetector::|FRWAccessDetector::|AssertFailedImplV|CheckVerifyFailedImpl|ReportAssert|ReportEnsure|ReportCrash|ReportGPUCrash|UE::Assert::|StaticFailDebug|FGenericPlatformMisc::RaiseException|FWindowsPlatformMisc::RaiseException|FWindowsPlatformCrashContext::|FGenericCrashContext::|LowLevelFatalErrorHandler|FWindowsErrorOutputDevice|FOutputDeviceError|FMsg::Logf|UE::Logging::Private::|`FDebug|DispatchCheckVerify|NewReportEnsure|EnsureFailed|FGenericPlatformMemory::OnOutOfMemory|FPlatformMemory::OnOutOfMemory|FMalloc\w*::(OutOfMemory|Malloc|Realloc)|FMemory::Malloc|FMemory::Realloc|UE::Core::Private::OnInvalid|UE::Core::Private::Fatal|CheckFailed)/;
const EngineFile = /[\\/]Engine[\\/](Source|Plugins|Shaders|Intermediate|Platforms)[\\/]|\+\+UE5|[\\/]build[\\/]\+\+/i;

const normPath = (p) => String(p ?? '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
/** PURE: a module name as dbghelp/cdb spell it, without the UnrealEditor- prefix, lowercase: UnrealEditor-My.Game.dll → my_game. */
export function moduleKey(name) {
	return String(name ?? '')
		.replace(/^.*[\\/]/, '')
		.replace(/\.(dll|exe)$/i, '')
		.replace(/[-.]/g, '_')
		.replace(/^(unrealeditor|unrealgame|unrealserver|unrealclient)_/i, '')
		.toLowerCase();
}

/** Project module names (.uproject Modules + project plugins' .uplugin Modules) as moduleKey()s. */
export function projectModules(project) {
	const keys = new Set();
	if (!project) return keys;
	const add = (file) => {
		try {
			for (const m of JSON.parse(readFileSync(file, 'utf8')).Modules ?? []) if (m?.Name) keys.add(moduleKey(m.Name));
		} catch {
			// an unreadable descriptor adds nothing
		}
	};
	add(project.uproject);
	const walk = (dir, depth) => {
		if (depth > 4) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.isDirectory()) {
				if (!/^(Binaries|Intermediate|Content|Resources|Source|Saved|\.git)$/i.test(e.name)) walk(join(dir, e.name), depth + 1);
			} else if (e.name.toLowerCase().endsWith('.uplugin')) add(join(dir, e.name));
		}
	};
	walk(join(project.root, 'Plugins'), 0);
	return keys;
}

/** PURE: 'project' | 'engine' | 'system' for one frame. ctx: {projectRoot, projectKeys:Set, monolithicKeys:Set}. */
export function classifyFrame(fr, ctx = {}) {
	const key = moduleKey(fr.module);
	if (SystemModule.test(key) || SystemModule.test(String(fr.module ?? ''))) return 'system';
	const root = ctx.projectRoot ? normPath(ctx.projectRoot) + '\\' : null;
	const file = fr.file ? normPath(fr.file) : null;
	if (file && root && file.startsWith(root) && !/\\plugins\\.*\\engine\\/.test(file)) return 'project';
	// A monolithic packaged game: one module holds everything — the file decides.
	if (ctx.monolithicKeys?.has(key)) return file && !EngineFile.test(file) ? 'project' : 'engine';
	if (ctx.projectKeys?.has(key)) return 'project';
	if (!ctx.projectKeys?.size && !root && file && !EngineFile.test(file)) return 'project';
	return 'engine';
}

const isMachinery = (fr) => fr.function && MachineryFn.test(fr.function);

/** PURE: whether a stack needs Step B — no frames, or an engine/project frame (not OS) without a function name. */
export function needsSymbols(frames, ctx) {
	if (!frames.length) return { needed: true, missing: [], why: 'no callstack frames in the crash context' };
	const missing = new Set();
	for (const fr of frames.slice(0, 30)) if (!fr.symbolicated && classifyFrame(fr, ctx) !== 'system') missing.add(fr.module);
	return missing.size
		? { needed: true, missing: [...missing], why: `frames without symbols in ${[...missing].join(', ')}` }
		: { needed: false, missing: [], why: '' };
}

/** PURE: a frame as text: module!function+offset [file:line]. */
export function frameText(fr, { short = false } = {}) {
	let s = fr.module ?? '?';
	if (fr.function) s += '!' + fr.function;
	else if (fr.address) s += ' ' + fr.address;
	if (fr.offset) s += '+' + fr.offset;
	if (fr.file) s += ` [${short ? basename(fr.file.replace(/\\/g, '/')) : fr.file}:${fr.line}]`;
	return s;
}

/** PURE: the frames to show — project frames, the first meaningful ones and their neighbours; the rest collapsed. */
export function digestFrames(frames, ctx, top = DefaultTop, alsoKeep = []) {
	const shown = frames.slice(0, top).map((fr, i) => ({ ...fr, i, kind: classifyFrame(fr, ctx) }));
	const firstReal = shown.findIndex((f) => !isMachinery(f) && f.kind !== 'system');
	const keep = new Set([0, ...alsoKeep]);
	let leading = 0;
	for (const f of shown) {
		if (f.kind === 'project') [f.i - 1, f.i, f.i + 1].forEach((k) => keep.add(k));
		// the first few non-OS frames from the first meaningful one: the engine path into the crash
		if (firstReal >= 0 && f.i >= firstReal && f.kind !== 'system' && leading < 4) {
			keep.add(f.i);
			leading++;
		}
	}
	const rows = [];
	let run = [];
	const flush = () => {
		if (!run.length) return;
		const mods = [...new Set(run.map((f) => f.module))];
		rows.push({ collapsed: run.length, modules: mods.slice(0, 4), more: Math.max(0, mods.length - 4), from: run[0].i, to: run[run.length - 1].i });
		run = [];
	};
	for (const f of shown) {
		if (keep.has(f.i) && !(f.kind === 'system' && f.i !== 0)) {
			flush();
			rows.push(f);
		} else run.push(f);
	}
	flush();
	if (frames.length > top) rows.push({ collapsed: frames.length - top, modules: ['(below --top)'], more: 0, from: top, to: frames.length - 1 });
	return rows;
}

/** PURE: the frame to name in the verdict and to open: the first project frame with a project-side file, else the
 * first project frame, else the first frame that is not assert/report machinery or the OS. */
export function keyFrame(frames, ctx) {
	const tagged = frames.map((fr, i) => ({ fr, i, kind: classifyFrame(fr, ctx) }));
	const root = ctx.projectRoot ? normPath(ctx.projectRoot) + '\\' : null;
	const openable = (fr) => fr.file && (root ? normPath(fr.file).startsWith(root) : !EngineFile.test(fr.file));
	return (
		tagged.find((t) => t.kind === 'project' && openable(t.fr)) ??
		tagged.find((t) => t.kind === 'project') ??
		tagged.find((t) => !isMachinery(t.fr) && t.kind !== 'system') ??
		tagged[0] ??
		null
	);
}

// ---------------------------------------------------------------- error message and hint

/** PURE: {kind, condition, file, line, text} out of an ErrorMessage (AssertionMacros.cpp formats). */
export function parseError(msg) {
	const first = String(msg ?? '').split(/\r?\n/)[0].trim();
	const out = { kind: 'other', condition: null, file: null, line: null, text: first, detail: '' };
	const rest = String(msg ?? '').split(/\r?\n/).slice(1).map((s) => s.trim()).filter(Boolean).join(' ');
	out.detail = rest;
	const fl = first.match(/\[File:([^\]]+)\]\s*\[Line:\s*(\d+)\]/);
	if (fl) {
		out.file = fl[1].trim();
		out.line = Number(fl[2]);
	}
	let m;
	if ((m = first.match(/^(?:.*?)Assertion failed:\s*(.*?)\s*\[File:/))) Object.assign(out, { kind: 'assert', condition: m[1] });
	else if ((m = first.match(/^(?:.*?)Ensure condition failed:\s*(.*?)\s*\[File:/))) Object.assign(out, { kind: 'ensure', condition: m[1] });
	else if (/^(?:.*?)Fatal error:/.test(first)) out.kind = 'fatal';
	else if ((m = first.match(/Unhandled Exception:\s*(EXCEPTION_\w+)(?:\s+(reading|writing|executing)\s+address)?\s*(0x[0-9a-f]+)?/i))) {
		Object.assign(out, { kind: 'exception', exception: m[1], access: m[2] ?? null, address: m[3] ?? null });
	}
	return out;
}

/** PURE: what an access-violation address says (references/debug.md table). */
export function addressMeaning(addr) {
	if (!addr) return null;
	const a = BigInt(addr);
	const hex = addr.toLowerCase().replace(/^0x0*/, '');
	if (a < 0x10000n) return `nullptr dereference (a member at offset ${addr.replace(/^0x0+(?=.)/, '0x')} of a null pointer)`;
	if (/^(dd)+$/.test(hex) || /^dddd/.test(hex)) return 'freed memory (use-after-free)';
	if (/^(feee)+$/.test(hex)) return 'freed Windows heap';
	if (/^(cd)+$/.test(hex) || /^(cc)+$/.test(hex)) return 'uninitialised heap/stack value used as a pointer';
	if (/^(fd)+$/.test(hex)) return 'buffer overrun guard bytes';
	if (/^f{16}$/.test(hex) || a >= 0xffff800000000000n) return 'garbage / kernel-range pointer (uninitialised or destroyed object, INDEX_NONE used as a pointer)';
	if (a > 0x00007fffffffffffn) return 'non-canonical pointer (corrupted or stale data read as a pointer)';
	return 'a user-space address that is not mapped: a dangling pointer to a destroyed object or a corrupted one';
}

/** PURE: the function repeated most in the stack (stack overflow → recursion), or null. */
export function recursion(frames) {
	const count = new Map();
	for (const fr of frames) if (fr.function) count.set(fr.module + '!' + fr.function, (count.get(fr.module + '!' + fr.function) ?? 0) + 1);
	const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
	return best && best[1] >= 3 ? { frame: best[0], times: best[1] } : null;
}

/** PURE: an engine build-machine path (D:\build\++UE5\Sync\Engine\…) mapped under the local engine root. */
export function localEnginePath(file, rootDir) {
	if (!file || !rootDir) return file;
	const m = file.match(/^.*?[\\/](Engine[\\/](?:Source|Plugins|Shaders)[\\/].*)$/i);
	if (!m || !EngineFile.test(file) || normPath(file).startsWith(normPath(rootDir))) return file;
	return join(rootDir, m[1]).replace(/\//g, '\\');
}

/** PURE: a GPU crash (device removed / hung) — the CPU stack is then only the thread that noticed it. */
export function isGpuCrash(crashType, frames, xml) {
	return crashType === 'GPUCrash' || Object.keys(xml?.engineData ?? {}).some((k) => k.startsWith('GPUCrash.')) || frames.slice(0, 12).some((f) => /OnGPUCrash|TerminateOnGPUCrash|DeviceRemoved/.test(f.function ?? ''));
}

export function hint({ err, crashType, frames, key, ctx, xml }) {
	const lines = [];
	const gpu = isGpuCrash(crashType, frames, xml);
	if (gpu) lines.push('GPU crash: the CPU stack is only the thread that noticed it - read the GPU breadcrumbs (crash log tail / <GPUBreadcrumbs>); the .nvdbg beside the dump is an Aftermath GPU dump for Nsight Graphics');
	const open = key?.fr?.file ? `${localEnginePath(key.fr.file, xml?.rootDir)}:${key.fr.line}` : null;
	const isProject = key?.kind === 'project';
	if (err.kind === 'assert' || err.kind === 'ensure') {
		lines.push(`${err.kind === 'assert' ? 'check()' : 'ensure()'} failed: \`${err.condition}\` at ${localEnginePath(err.file, xml?.rootDir)}:${err.line}${err.detail ? ` - ${err.detail}` : ''}`);
		if (open && isProject) lines.push(`open ${open} - the caller that broke the invariant`);
	} else if (err.kind === 'fatal') {
		lines.push(`fatal error raised at ${localEnginePath(err.file, xml?.rootDir) ?? '?'}:${err.line ?? '?'}${err.detail ? ` - ${err.detail}` : ''}`);
		if (open && isProject) lines.push(`open ${open}`);
	} else if (err.kind === 'exception') {
		if (err.exception === 'EXCEPTION_STACK_OVERFLOW') {
			const r = recursion(frames);
			lines.push(r ? `stack overflow: ${r.frame} repeats ${r.times}x in the stack - infinite recursion; the cycle is where that function re-enters itself` : 'stack overflow: infinite recursion or a huge stack array');
		} else if (err.exception === 'EXCEPTION_ACCESS_VIOLATION') {
			lines.push(`${gpu ? '(inside the GPU-crash reporter, a symptom) ' : ''}access violation${err.access ? ` ${err.access}` : ''}${err.address ? ` ${err.address}` : ''}: ${addressMeaning(err.address) ?? 'bad pointer'}`);
		} else lines.push(`${err.exception}`);
		if (open) lines.push(`open ${open}${isProject ? '' : ' (engine frame: the cause is usually a caller or an earlier owner of the pointer)'}`);
	} else if (open) lines.push(`open ${open}`);
	if (crashType === 'OutOfMemory') lines.push('out of memory: read LogMemory / the memory stats in the crash log tail; the stack is only the allocation that failed');
	if (crashType === 'Hang' || crashType === 'Stall') lines.push('hang: the GameThread stack under <Threads> shows where it waits');
	if (!isProject && key) lines.push('no project frame in the stack: the full path of references/debug.md (evidence -> cause -> breakpoints/instrumentation)');
	return lines;
}

// ---------------------------------------------------------------- log

const LogKinds = /Fatal error|Assertion failed|Ensure condition failed|Unhandled Exception|=== Critical error ===|appError called|LogWindows: Error|EXCEPTION_[A-Z_]+|LogOutOfMemory|Ran out of memory|GPU crash|Device Removed|DXGI_ERROR_DEVICE_/;

/** PURE: the crash-relevant lines of a log (no [Callstack] frames), repeats collapsed, the last `cap` kept. */
export function crashLogLines(text, cap = 10) {
	const out = [];
	const seen = new Map();
	String(text ?? '')
		.split(/\r?\n/)
		.forEach((l, i) => {
			if (!LogKinds.test(l) || /\[Callstack\]/.test(l) || /Failed to load '.*\.dll'/.test(l)) return;
			const norm = l.replace(/^\[[^\]]*\]\[\s*\d+\]/, '').trim();
			if (seen.has(norm)) {
				seen.get(norm).count++;
				return;
			}
			const row = { line: i + 1, text: norm.length > 300 ? norm.slice(0, 300) + '…' : norm, count: 1 };
			seen.set(norm, row);
			out.push(row);
		});
	return out.slice(-cap);
}

// ---------------------------------------------------------------- crash folders

/** Crash folders of the project, newest first: <project>/Saved/Crashes and %LOCALAPPDATA%\<Project>\Saved\Crashes. */
export function crashFolders(project, env = process.env) {
	const bases = [];
	if (project) {
		bases.push(join(project.root, 'Saved', 'Crashes'));
		if (env.LOCALAPPDATA) bases.push(join(env.LOCALAPPDATA, project.name, 'Saved', 'Crashes'));
	}
	const out = [];
	for (const b of bases) {
		let entries;
		try {
			entries = readdirSync(b, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (!e.isDirectory()) continue;
			const dir = join(b, e.name);
			if (!existsSync(join(dir, XmlName)) && !existsSync(join(dir, DumpName))) continue;
			let mtime = 0;
			try {
				mtime = statSync(dir).mtimeMs;
			} catch {
				// unreadable: keep it last
			}
			out.push({ dir, mtime });
		}
	}
	return out.sort((a, b) => b.mtime - a.mtime);
}

/** {dir, xmlPath, dumpPath, logPaths} from a folder, a .dmp or a .runtime-xml path; null when it holds none. */
export function resolveInput(p) {
	const abs = resolve(p);
	if (!existsSync(abs)) return null;
	const isDir = statSync(abs).isDirectory();
	const dir = isDir ? abs : dirname(abs);
	let files = [];
	try {
		files = readdirSync(dir);
	} catch {
		// nothing readable
	}
	const xmlPath = !isDir && abs.toLowerCase().endsWith('.runtime-xml') ? abs : files.includes(XmlName) ? join(dir, XmlName) : null;
	const dmp = !isDir && extname(abs).toLowerCase() === '.dmp' ? abs : files.find((f) => f.toLowerCase().endsWith('.dmp'));
	const dumpPath = dmp ? resolve(dir, dmp) : null;
	const logPaths = files.filter((f) => f.toLowerCase().endsWith('.log')).map((f) => join(dir, f));
	if (!xmlPath && !dumpPath) return null;
	return { dir, xmlPath, dumpPath, logPaths };
}

/** The project of a crash folder: the given one, else <folder>/../../.. when it holds a .uproject, else from the
 * xml's CommandLine (the editor's first argument is the .uproject). */
function projectOf(input, xml, given) {
	if (given) return given;
	const up = resolve(input.dir, '..', '..', '..');
	try {
		const u = readdirSync(up).find((f) => f.toLowerCase().endsWith('.uproject'));
		if (u) return { uproject: join(up, u), root: up, name: u.replace(/\.uproject$/i, '') };
	} catch {
		// not a project layout
	}
	const cl = xml?.commandLine?.match(/"?([A-Za-z]:[^"]*?\.uproject)"?/i)?.[1];
	if (cl && existsSync(cl)) return { uproject: cl, root: dirname(cl), name: basename(cl).replace(/\.uproject$/i, '') };
	return null;
}

// ---------------------------------------------------------------- cdb

/** Where cdb.exe is: --cdb / CDB_EXE, PATH, the Windows SDK Debugging Tools, the WinDbg app package.
 * @returns {{exe: string|null, looked: string[]}} */
export function findCdb(env = process.env, explicit = null) {
	const looked = [];
	const tryPath = (p) => {
		if (!p) return null;
		if (!looked.includes(p)) looked.push(p);
		return existsSync(p) ? p : null;
	};
	if (explicit) return { exe: tryPath(explicit), looked };
	if (env.CDB_EXE) {
		const hit = tryPath(env.CDB_EXE);
		if (hit) return { exe: hit, looked };
	}
	try {
		const where = execFileSync('where', ['cdb.exe'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).split(/\r?\n/)[0].trim();
		looked.push('PATH');
		if (where && existsSync(where)) return { exe: where, looked };
	} catch {
		looked.push('PATH');
	}
	for (const pf of [env['ProgramFiles(x86)'], env.ProgramFiles, 'C:\\Program Files (x86)', 'C:\\Program Files']) {
		if (!pf) continue;
		const hit = tryPath(join(pf, 'Windows Kits', '10', 'Debuggers', 'x64', 'cdb.exe'));
		if (hit) return { exe: hit, looked };
	}
	// The WinDbg app (winget Microsoft.WinDbg / the Store) is an MSIX package under Program Files\WindowsApps, which a
	// normal user cannot list; Get-AppxPackage names its folder. Its cdb.exe sits in the architecture subfolder.
	const pkgDirs = [];
	try {
		const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '(Get-AppxPackage -Name Microsoft.WinDbg).InstallLocation'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			windowsHide: true,
			timeout: 20000,
		});
		pkgDirs.push(...out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
	} catch {
		// no PowerShell or no package
	}
	try {
		const wa = join(env.ProgramFiles || 'C:\\Program Files', 'WindowsApps');
		for (const d of readdirSync(wa)) if (/^Microsoft\.WinDbg_.*_(x64|neutral)__/i.test(d)) pkgDirs.push(join(wa, d));
	} catch {
		looked.push(`${join(env.ProgramFiles || 'C:\\Program Files', 'WindowsApps')} (not listable without admin)`);
	}
	for (const d of pkgDirs) {
		for (const sub of ['amd64', 'x64', '']) {
			const hit = tryPath(join(d, sub, 'cdb.exe'));
			if (hit) return { exe: hit, looked };
		}
	}
	if (!pkgDirs.length) looked.push('Get-AppxPackage Microsoft.WinDbg (not installed)');
	return { exe: null, looked };
}

/** The doctor-style message for a missing cdb. */
export function cdbMissingMessage(looked, env = process.env) {
	const kits = join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'Debuggers', 'x64');
	const partial = existsSync(kits) ? ` (${kits} exists but holds no cdb.exe: the SDK put only dbghelp/symsrv there, the "Debugging Tools for Windows" feature is not installed)` : '';
	return [
		`cdb MISSING - symbolicating the minidump needs the Windows console debugger${partial}.`,
		'  winget install Microsoft.WinDbg     (the WinDbg app; cdb.exe is inside its package folder, found automatically)',
		'  or: Windows SDK installer -> Modify -> "Debugging Tools for Windows" (-> Windows Kits\\10\\Debuggers\\x64\\cdb.exe)',
		'  or: --cdb <path to cdb.exe> / set CDB_EXE',
		`  looked in: ${looked.join('; ')}`,
	].join('\n');
}

/** Binaries folders that can hold the PDBs/images of a crash: the folders of the xml's modules that appear in the
 * stack (`need`: module keys of the frames; an editor loads hundreds of modules and their folders together overflow
 * the command line), the project's and the engine's Binaries/Win64; without a module list, every Binaries/Win64 of
 * the project, its plugins and the engine. */
export function symbolDirs({ xml, project, unrealHome, extra = [], need = null }) {
	const dirs = [];
	const add = (d) => {
		if (d && !dirs.some((x) => normPath(x) === normPath(d)) && existsSync(d)) dirs.push(d);
	};
	extra.forEach(add);
	const listed = (xml?.modules ?? []).filter((m) => !need || !need.size || need.has(moduleKey(m)));
	const fromXml = listed.map((m) => dirname(m.replace(/\//g, '\\'))).filter((d) => !/^[a-z]:\\windows\\/i.test(d));
	fromXml.forEach(add);
	if (xml?.modules?.length) {
		if (project) add(join(project.root, 'Binaries', 'Win64'));
		if (unrealHome) add(join(unrealHome, 'Engine', 'Binaries', 'Win64'));
	} else {
		const binDirs = (root, depth) => {
			let entries;
			try {
				entries = readdirSync(root, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of entries) {
				if (!e.isDirectory()) continue;
				const p = join(root, e.name);
				if (e.name === 'Binaries') add(join(p, 'Win64'));
				else if (depth < 5 && !/^(Source|Content|Intermediate|Resources|Saved|Shaders|Config|Docs|Extras)$/i.test(e.name)) binDirs(p, depth + 1);
			}
		};
		if (project) {
			add(join(project.root, 'Binaries', 'Win64'));
			binDirs(join(project.root, 'Plugins'), 0);
		}
		if (unrealHome) {
			add(join(unrealHome, 'Engine', 'Binaries', 'Win64'));
			binDirs(join(unrealHome, 'Engine', 'Plugins'), 0);
		}
	}
	return dirs;
}

/** PURE: the cdb argument list and a printable command line. */
export function cdbCommand({ cdb, dump, dirs, msSymbols = false, cache = null, ntSymbolPath = '' }) {
	const sym = [...dirs];
	if (msSymbols) sym.push(`srv*${cache}*https://msdl.microsoft.com/download/symbols`);
	if (ntSymbolPath) sym.push(ntSymbolPath);
	const script = `.ecxr;kn ${CdbFrames};q`;
	const args = ['-lines', '-z', dump, '-y', sym.join(';'), '-i', dirs.join(';'), '-c', script];
	const q = (a) => (/[\s;&()^"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
	return { args, printable: [q(cdb), ...args.map(q)].join(' ') };
}

function runCdb(cdb, args, timeoutSec) {
	const r = spawnSync(cdb, args, { encoding: 'utf8', windowsHide: true, timeout: timeoutSec * 1000, maxBuffer: 64 * 1024 * 1024 });
	if (r.error) return { ok: false, error: r.error.code === 'ETIMEDOUT' ? `cdb timed out after ${timeoutSec}s` : r.error.message, out: r.stdout ?? '' };
	return { ok: true, out: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
}

// ---------------------------------------------------------------- analysis

/** Steps A and B on one resolved input. Returns the report object (also the --json shape). */
export function analyze(input, opts = {}) {
	const top = opts.top ?? DefaultTop;
	const rep = { folder: input.dir, xml: input.xmlPath, dump: input.dumpPath, logs: input.logPaths, notes: [] };
	let xml = null;
	if (input.xmlPath) {
		try {
			xml = parseCrashXml(readFileSync(input.xmlPath, 'utf8'));
		} catch (e) {
			rep.notes.push(`${XmlName} unreadable: ${e.message}`);
		}
	} else rep.notes.push(`no ${XmlName} - only the minidump`);
	const project = projectOf(input, xml, opts.project ?? null);
	const projectKeys = projectModules(project);
	const monolithicKeys = new Set();
	if (xml?.executableName && !/^UnrealEditor/i.test(xml.executableName)) monolithicKeys.add(moduleKey(xml.executableName));
	if (project) monolithicKeys.add(moduleKey(project.name));
	if (project) for (const m of xml?.modules ?? []) if (normPath(m).startsWith(normPath(project.root) + '\\')) projectKeys.add(moduleKey(m));
	for (const k of monolithicKeys) projectKeys.delete(k);
	const ctx = { projectRoot: project?.root ?? null, projectKeys, monolithicKeys };
	rep.project = project?.uproject ?? null;

	// Step A
	let frames = parseFrames(xml?.callStack);
	rep.source = frames.length ? 'CallStack' : null;
	if (!frames.length && xml?.pCallStack) {
		frames = parseFrames(xml.pCallStack);
		rep.source = frames.length ? 'PCallStack' : null;
	}
	const sym = needsSymbols(frames, ctx);
	rep.symbolicated = frames.length > 0 && !sym.needed;
	if (sym.needed && frames.length) rep.notes.push(`stack is unsymbolicated: ${sym.why} (no PDB beside those modules when it crashed)`);
	// Per file: a crash folder can hold several logs (a packaged program copies its helpers' logs too).
	rep.logLines = input.logPaths
		.flatMap((p) => {
			try {
				return crashLogLines(readFileSync(p, 'utf8')).map((l) => ({ file: basename(p), ...l }));
			} catch {
				return [];
			}
		})
		.slice(-10);

	// Step B
	const wantB = !opts.noSymbolicate && (opts.symbolicate || sym.needed);
	rep.cdb = null;
	if (wantB) {
		if (!input.dumpPath) rep.notes.push('no .dmp in the folder - nothing to symbolicate');
		else {
			const found = findCdb(process.env, opts.cdbPath ?? null);
			if (!found.exe) {
				rep.cdb = { error: 'missing', message: cdbMissingMessage(found.looked) };
				rep.setupError = Boolean(opts.symbolicate) || !frames.length;
			} else {
				const eng = (() => {
					try {
						const e = resolveEngine(process.env, project?.root ?? process.cwd());
						return e.unrealHome ?? (xml?.rootDir && existsSync(xml.rootDir) ? xml.rootDir : null);
					} catch {
						return null;
					}
				})();
				const need = new Set(frames.map((f) => moduleKey(f.module)).filter(Boolean));
				const dirs = symbolDirs({ xml, project, unrealHome: eng, extra: opts.symbols ?? [], need });
				const cache = join(process.env.LOCALAPPDATA || tmpdir(), 'SymbolCache');
				const cmd = cdbCommand({ cdb: found.exe, dump: input.dumpPath, dirs, msSymbols: opts.msSymbols, cache, ntSymbolPath: process.env._NT_SYMBOL_PATH ?? '' });
				rep.cdb = { exe: found.exe, command: cmd.printable };
				const run = (opts.runCdb ?? runCdb)(found.exe, cmd.args, opts.timeout ?? 300);
				if (!run.ok) rep.cdb.error = run.error;
				const parsed = parseCdbOutput(run.out);
				rep.cdb.warnings = parsed.warnings.slice(0, 8);
				const good = parsed.frames.filter((f) => f.symbolicated).length;
				rep.cdb.frames = parsed.frames.length;
				rep.cdb.symbolicatedFrames = good;
				if (parsed.frames.length && good >= frames.filter((f) => f.symbolicated).length) {
					frames = parsed.frames;
					rep.source = 'cdb';
					rep.symbolicated = !needsSymbols(frames, ctx).needed;
				} else if (!parsed.frames.length) rep.notes.push('cdb printed no frames - see the command above and rerun it by hand');
			}
		}
	}

	rep.crashType = xml?.crashType ?? 'Crash';
	rep.error = xml?.errorMessage ?? '';
	rep.meta = xml
		? { engineVersion: xml.engineVersion, buildVersion: xml.buildVersion, buildConfiguration: xml.buildConfiguration, executable: xml.executableName, platform: xml.platformName, gameName: xml.gameName, timeOfCrash: xml.timeOfCrash, secondsSinceStart: xml.secondsSinceStart, modules: xml.modules.length, threads: xml.threads.length, pCallStackHash: xml.pCallStackHash }
		: null;
	rep.frames = frames.map((f, i) => ({ ...f, index: i, kind: classifyFrame(f, ctx) }));
	const err = parseError(rep.error || rep.logLines.find((l) => /Assertion failed|Ensure condition failed|Fatal error|Unhandled Exception/.test(l.text))?.text);
	let key = keyFrame(frames, ctx);
	if (err.exception === 'EXCEPTION_STACK_OVERFLOW' && key?.kind !== 'project') {
		// A stack overflow: the frame to name is the recursing one, not the allocator that ran out of stack.
		const r = recursion(frames);
		const i = r ? frames.findIndex((f) => f.function && f.module + '!' + f.function === r.frame) : -1;
		if (i >= 0) key = { fr: frames[i], i, kind: classifyFrame(frames[i], ctx) };
	}
	rep.digest = digestFrames(frames, ctx, top, key ? [key.i] : []);
	rep.keyFrame = key ? { index: key.i, kind: key.kind, text: frameText(key.fr) } : null;
	rep.hint = hint({ err, crashType: rep.crashType, frames, key, ctx, xml });
	if (xml?.sourceContext && key?.i === 0) rep.sourceContext = xml.sourceContext;
	rep.exitCode = rep.setupError ? 2 : frames.length ? 0 : rep.cdb?.error === 'missing' ? 2 : 1;
	rep.result = frames.length
		? `RESULT: crash ${rep.crashType}${rep.crashType !== 'GPUCrash' && isGpuCrash(rep.crashType, frames, xml) ? ' (GPU)' : ''} at ${key ? frameText(key.fr, { short: true }) : 'unknown frame'}`
		: `RESULT: crash ${rep.crashType} at <no stack>`;
	return rep;
}

// ---------------------------------------------------------------- output

function printReport(rep, top) {
	const out = [];
	out.push(`crash-triage: ${rep.folder}`);
	if (rep.meta) {
		const m = rep.meta;
		out.push(`  ${m.executable ?? '?'} ${m.buildConfiguration ?? '?'} · ${m.engineVersion ?? '?'} · ${m.platform ?? '?'}${m.timeOfCrash ? ` · ${m.timeOfCrash.replace('T', ' ').slice(0, 19)} UTC` : ''}${m.secondsSinceStart ? ` · ${m.secondsSinceStart}s after start` : ''}`);
	}
	out.push(`type:  ${rep.crashType}`);
	const errLines = String(rep.error || '(no ErrorMessage)').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
	out.push(`error: ${errLines[0]}`);
	for (const l of errLines.slice(1, 4)) out.push(`       ${l.length > 240 ? l.slice(0, 240) + '…' : l}`);
	for (const n of rep.notes) out.push(`note:  ${n}`);
	out.push('');
	out.push(`stack (${rep.source ?? 'none'}${rep.frames.length ? `, ${rep.frames.length} frames${rep.symbolicated ? '' : ', UNSYMBOLICATED'}` : ''}):`);
	for (const r of rep.digest) {
		if (r.collapsed) out.push(`        · ${r.collapsed} frame${r.collapsed > 1 ? 's' : ''}: ${r.modules.join(', ')}${r.more ? ` +${r.more}` : ''}`);
		else {
			const mark = rep.keyFrame && r.i === rep.keyFrame.index ? '>>' : '  ';
			out.push(`  ${mark}#${String(r.i).padStart(2, '0')} ${r.kind === 'project' ? '[project] ' : ''}${frameText(r)}`);
		}
	}
	if (!rep.frames.length) out.push('  (no frames)');
	if (rep.cdb) {
		out.push('');
		if (rep.cdb.error === 'missing') out.push(rep.cdb.message);
		else {
			out.push(`cdb: ${rep.cdb.command}`);
			if (rep.cdb.error) out.push(`cdb error: ${rep.cdb.error}`);
			out.push(`cdb: ${rep.cdb.frames ?? 0} frames, ${rep.cdb.symbolicatedFrames ?? 0} with symbols`);
			for (const w of rep.cdb.warnings ?? []) out.push(`  ${w.length > 200 ? w.slice(0, 200) + '…' : w}`);
		}
	}
	if (rep.logLines.length) {
		out.push('');
		out.push('log:');
		for (const l of rep.logLines) out.push(`  ${l.file}:${l.line}: ${l.text}${l.count > 1 ? ` (x${l.count})` : ''}`);
	}
	if (rep.sourceContext) {
		out.push('');
		out.push('source at the top frame (SourceContext):');
		// The Crash Report Client marks the crashing line with ***** in a ~30-line window; show it with 3 lines around.
		const src = rep.sourceContext.split(/\r?\n/);
		const at = src.findIndex((l) => /\*\*\*\*\*/.test(l));
		for (const l of at >= 0 ? src.slice(Math.max(0, at - 3), at + 4) : []) out.push(`  ${l.replace(/\t/g, '  ').replace(/\s+$/, '')}`);
	}
	if (rep.hint.length) {
		out.push('');
		out.push('next:');
		for (const h of rep.hint) out.push(`  - ${h}`);
	}
	out.push('');
	out.push(rep.result);
	console.log(out.join('\n'));
}

function usage(code) {
	console.log('usage: crash-triage [<crash folder> | <.dmp> | <CrashContext.runtime-xml>] [--project <dir>] [--top N] [--symbolicate | --no-symbolicate]\n' +
		'                    [--symbols <pdb dir>]... [--ms-symbols] [--cdb <cdb.exe>] [--timeout <sec>] [--json] | --list | --selftest');
	process.exit(code);
}

function main(argv) {
	if (argv.includes('--help') || argv.includes('-h')) usage(0);
	if (argv.includes('--selftest')) process.exit(selftest());
	const valueFlags = new Set(['--project', '--top', '--symbols', '--cdb', '--timeout']);
	const opts = { symbols: [] };
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (valueFlags.has(a)) {
			const v = argv[++i];
			if (v === undefined) usage(2);
			if (a === '--symbols') opts.symbols.push(resolve(v));
			else if (a === '--project') opts.projectDir = v;
			else if (a === '--top') opts.top = Math.max(1, Number(v) || DefaultTop);
			else if (a === '--cdb') opts.cdbPath = v;
			else if (a === '--timeout') opts.timeout = Math.max(10, Number(v) || 300);
		} else if (a === '--symbolicate') opts.symbolicate = true;
		else if (a === '--no-symbolicate') opts.noSymbolicate = true;
		else if (a === '--ms-symbols') opts.msSymbols = true;
		else if (a === '--json') opts.json = true;
		else if (a === '--list') opts.list = true;
		else if (a.startsWith('--')) {
			console.error(`crash-triage: unknown option ${a}`);
			usage(2);
		} else positional.push(a);
	}
	const fail = (msg) => {
		if (opts.json) console.log(JSON.stringify({ error: msg, exitCode: 2 }, null, 2));
		else console.error(msg);
		process.exit(2);
	};
	const project = projectInfo(opts.projectDir ?? process.cwd());
	if (opts.projectDir && !project) fail(`crash-triage: no .uproject at or above ${opts.projectDir}`);
	if (opts.list) {
		if (!project) fail('crash-triage: no .uproject above the current directory (or CLAUDE_PROJECT_DIR) - pass --project <dir>');
		const all = crashFolders(project);
		for (const c of all) {
			let t = '';
			try {
				const x = readFileSync(join(c.dir, XmlName), 'utf8');
				t = `${element(x, 'CrashType') ?? '?'}  ${(element(x, 'ErrorMessage') ?? '').split(/\r?\n/)[0].slice(0, 140)}`;
			} catch {
				t = '(no crash context)';
			}
			console.log(`${new Date(c.mtime).toISOString().slice(0, 16).replace('T', ' ')}  ${c.dir}  ${t}`);
		}
		if (!all.length) console.log(`no crash folders under ${join(project.root, 'Saved', 'Crashes')} or %LOCALAPPDATA%\\${project.name}\\Saved\\Crashes`);
		process.exit(all.length ? 0 : 1);
	}
	let input;
	if (positional[0]) {
		input = resolveInput(positional[0]);
		if (!input) fail(`crash-triage: ${positional[0]} is not a crash folder, a .dmp or a ${XmlName}`);
	} else {
		if (!project) fail('crash-triage: no .uproject above the current directory (or CLAUDE_PROJECT_DIR) - pass a crash folder or --project <dir>');
		const newest = crashFolders(project)[0];
		if (!newest) fail(`crash-triage: no crash folders under ${join(project.root, 'Saved', 'Crashes')} or %LOCALAPPDATA%\\${project.name}\\Saved\\Crashes`);
		input = resolveInput(newest.dir);
	}
	const rep = analyze(input, { ...opts, project: opts.projectDir ? project : null });
	if (opts.json) console.log(JSON.stringify(rep, null, 2));
	else printReport(rep, opts.top ?? DefaultTop);
	process.exit(rep.exitCode);
}

// ---------------------------------------------------------------- selftest

// A runtime-xml in the shape GenericPlatformCrashContext.cpp writes and the Crash Report Client completes.
// Constructed by hand: names, paths and addresses are invented.
const FixtureXml = `<?xml version="1.0" encoding="UTF-8"?>
<FGenericCrashContext>
	<RuntimeProperties>
		<CrashVersion>3</CrashVersion>
		<ExecutionGuid>00000000000000000000000000000001</ExecutionGuid>
		<CrashGUID>UECC-Windows-00000000000000000000000000000001_0000</CrashGUID>
		<IsEnsure>false</IsEnsure>
		<IsStall>false</IsStall>
		<IsAssert>true</IsAssert>
		<CrashType>Assert</CrashType>
		<ErrorMessage>Assertion failed: Owner != nullptr [File:C:\\Work\\Demo\\Source\\Demo\\Private\\DemoPickup.cpp] [Line: 41]
Pickup &apos;BP_Key_C_0&apos; has no owner &amp; cannot attach


</ErrorMessage>
		<CrashReporterMessage />
		<ProcessId>4242</ProcessId>
		<SecondsSinceStart>17</SecondsSinceStart>
		<IsWithDebugInfo>true</IsWithDebugInfo>
		<GameName>UE-Demo</GameName>
		<ExecutableName>UnrealEditor</ExecutableName>
		<BuildConfiguration>Development</BuildConfiguration>
		<PlatformName>WindowsEditor</PlatformName>
		<EngineVersion>5.8.3-00000000+++UE5+Release-5.8</EngineVersion>
		<CommandLine>C:\\Work\\Demo\\Demo.uproject -game</CommandLine>
		<BuildVersion>++UE5+Release-5.8-CL-00000000</BuildVersion>
		<BaseDir>C:/Engines/UE_5.8/Engine/Binaries/Win64/</BaseDir>
		<RootDir>C:/Engines/UE_5.8/</RootDir>
		<SourceContext />
		<NumMinidumpFramesToIgnore>0</NumMinidumpFramesToIgnore>
		<CallStack>UnrealEditor_Core!FDebug::CheckVerifyFailedImpl2() [D:\\build\\++UE5\\Sync\\Engine\\Source\\Runtime\\Core\\Private\\Misc\\AssertionMacros.cpp:797]
UnrealEditor_Demo!UDemoPickupComponent::Attach() [C:\\Work\\Demo\\Source\\Demo\\Private\\DemoPickup.cpp:41]
UnrealEditor_Demo!TArray&lt;int,TSizedDefaultAllocator&lt;32&gt; &gt;::Add() [C:\\Engines\\UE_5.8\\Engine\\Source\\Runtime\\Core\\Public\\Containers\\Array.h:2300]
UnrealEditor_Demo!ADemoPickup::BeginPlay() [C:\\Work\\Demo\\Source\\Demo\\Private\\DemoPickup.cpp:88]
UnrealEditor_Engine!AActor::DispatchBeginPlay() [D:\\build\\++UE5\\Sync\\Engine\\Source\\Runtime\\Engine\\Private\\Actor.cpp:4784]
UnrealEditor_Engine!AActor::PostActorConstruction() [D:\\build\\++UE5\\Sync\\Engine\\Source\\Runtime\\Engine\\Private\\Actor.cpp:4529]
UnrealEditor_Engine!UWorld::SpawnActor() [D:\\build\\++UE5\\Sync\\Engine\\Source\\Runtime\\Engine\\Private\\LevelActor.cpp:758]
UnrealEditor_Engine!UGameEngine::Tick() [D:\\build\\++UE5\\Sync\\Engine\\Source\\Runtime\\Engine\\Private\\GameEngine.cpp:1900]
UnrealEditor!FEngineLoop::Tick() [D:\\build\\++UE5\\Sync\\Engine\\Source\\Runtime\\Launch\\Private\\LaunchEngineLoop.cpp:5600]
UnrealEditor!GuardedMain() [D:\\build\\++UE5\\Sync\\Engine\\Source\\Runtime\\Launch\\Private\\Launch.cpp:187]
kernel32
ntdll</CallStack>
		<PCallStack>

UnrealEditor-Core   0x00007ff900000000 + 1234
UnrealEditor-Demo   0x00007ff910000000 + 2bfa
kernel32            0x00007ffa00000000 + 1259d
</PCallStack>
		<PCallStackHash>0000000000000000000000000000000000000000</PCallStackHash>
		<Threads>
			<Thread>
				<CallStack>ntdll 0x00007ffa10000000 + a0e84
</CallStack>
				<IsCrashed>false</IsCrashed>
				<Registers />
				<ThreadID>100</ThreadID>
				<ThreadName>RenderThread 1</ThreadName>
			</Thread>
		</Threads>
		<TimeOfCrash>639262161859200000</TimeOfCrash>
		<Modules>C:\\Engines\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor-Core.dll
C:\\Engines\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor-Engine.dll
C:\\Work\\Demo\\Binaries\\Win64\\UnrealEditor-Demo.dll
C:\\WINDOWS\\SYSTEM32\\ntdll.dll</Modules>
	</RuntimeProperties>
	<PlatformProperties>
		<PlatformIsRunningWindows>1</PlatformIsRunningWindows>
		<CrashTrigger>0</CrashTrigger>
	</PlatformProperties>
	<EngineData>
		<RHI.RHIName>D3D12</RHI.RHIName>
	</EngineData>
	<GameData>
	</GameData>
	<EnabledPlugins>
		<Plugin>{&quot;Version&quot;: 1}</Plugin>
	</EnabledPlugins>
</FGenericCrashContext>
`;

// The same crash with no PDBs at crash time: the Crash Report Client writes bare module names.
const FixtureXmlUnsym = FixtureXml.replace(/<CallStack>UnrealEditor_Core[\s\S]*?<\/CallStack>/, `<CallStack>UnrealEditor_Core
UnrealEditor_Demo
UnrealEditor_Demo
UnrealEditor_Engine
kernel32
ntdll</CallStack>`);

// cdb -lines -z … -c ".ecxr;kn 50;q" output, x64, with an inline frame, a module without symbols and the usual noise.
const FixtureCdb = `
Microsoft (R) Windows Debugger Version 10.0.26100.1 AMD64
Copyright (c) Microsoft Corporation. All rights reserved.

Loading Dump File [C:\\Work\\Demo\\Saved\\Crashes\\UECC-Windows-X_0000\\UEMinidump.dmp]
User Mini Dump File: Only registers, stack and portions of memory are available

Symbol search path is: C:\\Work\\Demo\\Binaries\\Win64;C:\\Engines\\UE_5.8\\Engine\\Binaries\\Win64
Executable search path is: C:\\Work\\Demo\\Binaries\\Win64;C:\\Engines\\UE_5.8\\Engine\\Binaries\\Win64
*** WARNING: Unable to verify checksum for UnrealEditor-Demo.dll
0:000> .ecxr;kn 50;q
rax=0000000000000000 rbx=000000a12b3fe9a0 rcx=0000000000000000
rip=00007ff91000ab3a rsp=000000a12b3fe8f0 rbp=0000000000000000
UnrealEditor_Demo!UDemoPickupComponent::Attach+0x3a:
00007ff9\`1000ab3a 8b4810          mov     ecx,dword ptr [rax+10h] ds:00000000\`00000010=????????
 # Child-SP          RetAddr               Call Site
00 000000a1\`2b3fe8f0 00007ff9\`1000c1d4     UnrealEditor_Demo!UDemoPickupComponent::Attach+0x3a [C:\\Work\\Demo\\Source\\Demo\\Private\\DemoPickup.cpp @ 41]
01 (Inline Function) --------\`--------     UnrealEditor_Demo!ADemoPickup::AttachAll+0x12 [C:\\Work\\Demo\\Source\\Demo\\Private\\DemoPickup.cpp @ 77]
02 000000a1\`2b3fe960 00007ff9\`20001b2c     UnrealEditor_Demo!ADemoPickup::BeginPlay+0x84 [C:\\Work\\Demo\\Source\\Demo\\Private\\DemoPickup.cpp @ 88]
03 000000a1\`2b3fe9c0 00007ff9\`20002c4d     UnrealEditor_Engine!AActor::DispatchBeginPlay+0x1b2 [D:\\build\\++UE5\\Sync\\Engine\\Source\\Runtime\\Engine\\Private\\Actor.cpp @ 4784]
04 000000a1\`2b3fea30 00007ff9\`3000aaaa     UnrealEditor_ThirdPartyThing+0x1d2c4
05 000000a1\`2b3feaa0 00007ffa\`0001259d     0x00007ff9\`40001234
06 000000a1\`2b3feb00 00000000\`00000000     KERNEL32!BaseThreadInitThunk+0x1d
quit:
`;

function selftest() {
	let failed = 0;
	const check = (what, got, want) => {
		const ok = JSON.stringify(got) === JSON.stringify(want);
		if (!ok) {
			failed++;
			console.error(`FAIL ${what}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
		}
	};
	const ctxDemo = { projectRoot: 'C:\\Work\\Demo', projectKeys: new Set(['demo']), monolithicKeys: new Set() };

	// xml
	const x = parseCrashXml(FixtureXml);
	check('xml: crash type', x.crashType, 'Assert');
	check('xml: error unescaped, multi-line', x.errorMessage.split('\n')[1], "Pickup 'BP_Key_C_0' has no owner & cannot attach");
	check('xml: version/config/exe', [x.engineVersion, x.buildConfiguration, x.executableName, x.crashVersion], ['5.8.3-00000000+++UE5+Release-5.8', 'Development', 'UnrealEditor', '3']);
	check('xml: crashing CallStack, not a thread one', parseFrames(x.callStack).length, 12);
	check('xml: threads', x.threads.map((t) => t.name), ['RenderThread 1']);
	check('xml: modules', x.modules.length, 4);
	check('xml: plugins', x.plugins, 1);
	check('xml: TimeOfCrash ticks', x.timeOfCrash?.slice(0, 10), '2026-09-28');
	check('xml: empty element', element('<a><SourceContext /></a>', 'SourceContext'), '');
	check('xml: dotted element', element('<Misc.CPUBrand>X</Misc.CPUBrand>', 'Misc.CPUBrand'), 'X');

	// frames
	check('frame: CRC symbolicated', parseFrameLine('UnrealEditor_Demo!ADemoPickup::BeginPlay() [C:\\Work\\Demo\\Source\\Demo\\Private\\DemoPickup.cpp:88]'), {
		module: 'UnrealEditor_Demo', function: 'ADemoPickup::BeginPlay()', offset: null, file: 'C:\\Work\\Demo\\Source\\Demo\\Private\\DemoPickup.cpp', line: 88, address: null, symbolicated: true,
	});
	check('frame: CRC bare module', parseFrameLine('GFSDK_Aftermath_Lib_x64').symbolicated, false);
	check('frame: in-process UnknownFunction', parseFrameLine('[2026.01.01-00.00.00:000][  0]LogWindows: Error: [Callstack] 0x00007ff91000ab3a UnrealEditor-Demo.dll!UnknownFunction []'), {
		module: 'UnrealEditor-Demo', function: null, offset: null, file: null, line: null, address: '0x00007ff91000ab3a', symbolicated: false,
	});
	check('frame: PCallStack', parseFrameLine('UnrealEditor-Demo   0x00007ff910000000 + 2bfa   '), { module: 'UnrealEditor-Demo', function: null, offset: '0x2bfa', file: null, line: null, address: null, symbolicated: false });
	check('frame: template with spaces', parseFrameLine('UnrealEditor_Demo!TArray<int,TSizedDefaultAllocator<32> >::Add() [C:\\E\\Array.h:2300]').function, 'TArray<int,TSizedDefaultAllocator<32> >::Add()');

	// classification
	const fr = parseFrames(x.callStack);
	check('classify', fr.map((f) => classifyFrame(f, ctxDemo)), ['engine', 'project', 'project', 'project', 'engine', 'engine', 'engine', 'engine', 'engine', 'engine', 'system', 'system']);
	check('moduleKey', [moduleKey('UnrealEditor-My.Game.dll'), moduleKey('UnrealEditor_Demo'), moduleKey('C:\\x\\Demo.exe')], ['my_game', 'demo', 'demo']);
	const mono = { projectRoot: null, projectKeys: new Set(), monolithicKeys: new Set(['demo']) };
	check('classify: monolithic by file', [classifyFrame({ module: 'Demo', file: 'C:\\Work\\Demo\\Source\\A.cpp' }, mono), classifyFrame({ module: 'Demo', file: 'D:\\build\\++UE5\\Sync\\Engine\\Source\\B.cpp' }, mono)], ['project', 'engine']);
	check('symbols: symbolicated stack', needsSymbols(fr, ctxDemo).needed, false);
	const unsym = parseFrames(parseCrashXml(FixtureXmlUnsym).callStack);
	check('symbols: bare modules need Step B, OS ignored', needsSymbols(unsym, ctxDemo).missing, ['UnrealEditor_Core', 'UnrealEditor_Demo', 'UnrealEditor_Engine']);
	const k = keyFrame(fr, ctxDemo);
	check('key frame: first project frame with a project file', [k.i, k.kind], [1, 'project']);
	check('verdict text', frameText(k.fr, { short: true }), 'UnrealEditor_Demo!UDemoPickupComponent::Attach() [DemoPickup.cpp:41]');
	const dig = digestFrames(fr, ctxDemo, 25);
	check('digest: shown frame indices', dig.filter((r) => !r.collapsed).map((r) => r.i), [0, 1, 2, 3, 4]);
	check('digest: collapsed runs', dig.filter((r) => r.collapsed).map((r) => r.collapsed), [7]);

	// error and hint
	const e = parseError(x.errorMessage);
	check('error: assert parts', [e.kind, e.condition, e.line], ['assert', 'Owner != nullptr', 41]);
	check('error: ensure', parseError('Ensure condition failed: bValidTime [File:D:\\a\\AnimPose.cpp] [Line: 687] ').condition, 'bValidTime');
	check('error: fatal', parseError('Fatal error: [File:D:\\a\\UObjectGlobals.cpp] [Line: 4880] \nNewObject with empty name').detail, 'NewObject with empty name');
	const av = parseError('Unhandled Exception: EXCEPTION_ACCESS_VIOLATION reading address 0x0000000000000010');
	check('error: access violation', [av.kind, av.access, av.address], ['exception', 'reading', '0x0000000000000010']);
	check('address: null + offset', addressMeaning('0x0000000000000010').startsWith('nullptr dereference'), true);
	check('address: all ones', addressMeaning('0xffffffffffffffff').startsWith('garbage'), true);
	check('address: freed', addressMeaning('0xdddddddddddddddd'), 'freed memory (use-after-free)');
	check('recursion', recursion([...Array(5)].map(() => ({ module: 'M', function: 'F()' }))), { frame: 'M!F()', times: 5 });
	check('engine path mapped locally', localEnginePath('D:\\build\\++UE5\\Sync\\Engine\\Source\\Runtime\\X.cpp', 'C:/Engines/UE_5.8/'), join('C:/Engines/UE_5.8/', 'Engine\\Source\\Runtime\\X.cpp').replace(/\//g, '\\'));
	const h = hint({ err: e, crashType: 'Assert', frames: fr, key: k, ctx: ctxDemo, xml: x });
	check('hint: condition and file to open', [h[0].startsWith('check() failed: `Owner != nullptr`'), h[1]], [true, 'open C:\\Work\\Demo\\Source\\Demo\\Private\\DemoPickup.cpp:41 - the caller that broke the invariant']);

	// cdb
	const c = parseCdbOutput(FixtureCdb);
	check('cdb: frame count', c.frames.length, 7);
	check('cdb: top frame', frameText(c.frames[0]), 'UnrealEditor_Demo!UDemoPickupComponent::Attach+0x3a [C:\\Work\\Demo\\Source\\Demo\\Private\\DemoPickup.cpp:41]');
	check('cdb: inline frame', [c.frames[1].inline, c.frames[1].function, c.frames[1].line], [true, 'ADemoPickup::AttachAll', 77]);
	check('cdb: no symbols', [c.frames[4].module, c.frames[4].function, c.frames[4].offset, c.frames[4].symbolicated], ['UnrealEditor_ThirdPartyThing', null, '0x1d2c4', false]);
	check('cdb: raw address', [c.frames[5].module, c.frames[5].address], ['?', '0x00007ff940001234']);
	check('cdb: kernel frame', classifyFrame(c.frames[6], ctxDemo), 'system');
	check('cdb: warnings kept', c.warnings.some((w) => /Unable to verify checksum/.test(w)), true);
	const cmd = cdbCommand({ cdb: 'C:\\Debuggers\\cdb.exe', dump: 'C:\\c d\\UEMinidump.dmp', dirs: ['C:\\A', 'C:\\B'], msSymbols: true, cache: 'C:\\SymCache' });
	check('cdb: args', cmd.args, ['-lines', '-z', 'C:\\c d\\UEMinidump.dmp', '-y', 'C:\\A;C:\\B;srv*C:\\SymCache*https://msdl.microsoft.com/download/symbols', '-i', 'C:\\A;C:\\B', '-c', '.ecxr;kn 50;q']);
	check('cdb: printable', cmd.printable, 'C:\\Debuggers\\cdb.exe -lines -z "C:\\c d\\UEMinidump.dmp" -y "C:\\A;C:\\B;srv*C:\\SymCache*https://msdl.microsoft.com/download/symbols" -i "C:\\A;C:\\B" -c ".ecxr;kn 50;q"');
	check('cdb: missing message names the installs', /winget install Microsoft\.WinDbg/.test(cdbMissingMessage(['PATH'])), true);

	// log
	const log = [
		'[2026.01.01-00.00.00:000][  0]LogInit: Display: Starting',
		'LogWindows: Failed to load \'aqProf.dll\' (GetLastError=126)',
		'[2026.01.01-00.00.01:000][ 42]LogWindows: Error: appError called: Assertion failed: Owner != nullptr [File:C:\\Work\\Demo\\Source\\Demo\\Private\\DemoPickup.cpp] [Line: 41]',
		'[2026.01.01-00.00.01:000][ 42]LogWindows: Error: [Callstack] 0x00007ff91000ab3a UnrealEditor-Demo.dll!UDemoPickupComponent::Attach() [C:\\Work\\Demo\\Source\\Demo\\Private\\DemoPickup.cpp:41]',
		'[2026.01.01-00.00.01:000][ 42]LogWindows: Error: === Critical error: ===',
	].join('\n');
	check('log: crash lines without frames and dll noise', crashLogLines(log).map((l) => l.line), [3, 5]);

	// end to end on a temp project: newest folder, Step A only
	const tmp = mkdtempSync(join(tmpdir(), 'crash-triage-'));
	try {
		const root = join(tmp, 'Demo');
		mkdirSync(join(root, 'Saved', 'Crashes', 'UECC-Windows-OLD_0000'), { recursive: true });
		mkdirSync(join(root, 'Saved', 'Crashes', 'UECC-Windows-NEW_0000'), { recursive: true });
		writeFileSync(join(root, 'Demo.uproject'), JSON.stringify({ EngineAssociation: '5.8', Modules: [{ Name: 'Demo', Type: 'Runtime' }] }));
		writeFileSync(join(root, 'Saved', 'Crashes', 'UECC-Windows-OLD_0000', XmlName), FixtureXmlUnsym);
		writeFileSync(join(root, 'Saved', 'Crashes', 'UECC-Windows-NEW_0000', XmlName), FixtureXml.replace(/C:\\Work\\Demo/g, root));
		writeFileSync(join(root, 'Saved', 'Crashes', 'UECC-Windows-NEW_0000', 'Demo.log'), log);
		const old = Date.now() / 1000 - 3600;
		utimesSync(join(root, 'Saved', 'Crashes', 'UECC-Windows-OLD_0000'), old, old);
		const project = { uproject: join(root, 'Demo.uproject'), root, name: 'Demo' };
		const folders = crashFolders(project, {});
		check('folders: newest first', folders.map((f) => basename(f.dir)), ['UECC-Windows-NEW_0000', 'UECC-Windows-OLD_0000']);
		const rep = analyze(resolveInput(folders[0].dir), { noSymbolicate: true });
		check('analyze: symbolicated, project found from the folder', [rep.symbolicated, rep.source, rep.project], [true, 'CallStack', join(root, 'Demo.uproject')]);
		check('analyze: verdict', rep.result, 'RESULT: crash Assert at UnrealEditor_Demo!UDemoPickupComponent::Attach() [DemoPickup.cpp:41]');
		check('analyze: log lines', rep.logLines.length, 2);
		check('analyze: exit 0', rep.exitCode, 0);
		const rep2 = analyze(resolveInput(folders[1].dir), { noSymbolicate: true });
		check('analyze: unsymbolicated noted', [rep2.symbolicated, rep2.notes.some((n) => /unsymbolicated/.test(n))], [false, true]);
		const rep3 = analyze(resolveInput(folders[1].dir), {});
		check('analyze: Step B without a dump says so, keeps Step A', [rep3.notes.some((n) => /no \.dmp/.test(n)), rep3.exitCode], [true, 0]);
		// Step B wiring with a stand-in debugger: an unsymbolicated folder with a dump gets cdb's frames.
		const oldDir = folders[1].dir;
		writeFileSync(join(oldDir, DumpName), 'not a real dump');
		let seenArgs = null;
		const fakeCdb = (exe, args) => {
			seenArgs = args;
			return { ok: true, out: FixtureCdb.replace(/C:\\Work\\Demo/g, root), status: 0 };
		};
		const rep4 = analyze(resolveInput(oldDir), { cdbPath: join(oldDir, XmlName), runCdb: fakeCdb });
		check('analyze: Step B ran on the dump', [seenArgs?.[0], seenArgs?.[2], rep4.source, rep4.symbolicated], ['-lines', join(oldDir, DumpName), 'cdb', false]);
		check('analyze: Step B key frame', rep4.result, 'RESULT: crash Assert at UnrealEditor_Demo!UDemoPickupComponent::Attach+0x3a [DemoPickup.cpp:41]');
		check('analyze: printable command kept', /-c "\.ecxr;kn 50;q"$/.test(rep4.cdb.command), true);
		const rep5 = analyze(resolveInput(oldDir), { cdbPath: join(oldDir, 'no-such-cdb.exe'), symbolicate: true });
		check('analyze: --symbolicate without cdb is a setup error', [rep5.cdb.error, rep5.exitCode], ['missing', 2]);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}

	console.log(failed ? `crash-triage selftest: ${failed} FAILED` : 'crash-triage selftest: ok');
	return failed ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
