// ue-trace.mjs — read an Unreal Insights trace (.utrace) without the Insights window: export it headless to CSV,
// then reduce the CSVs to a short text digest an agent can reason about.
//
// WHY. The Insights GUI is for eyes; an agent needs numbers. UnrealInsights.exe can open a trace, run export
// commands when the analysis is complete and quit (-OpenTraceFile / -ExecOnAnalysisCompleteCmd / -AutoQuit / -NoUI,
// the same switches Epic's own tests use: TraceInsights/.../Tests/FunctionalTests/ExportCommandsTests.cpp:86).
// The CSVs it writes are large; this prints only what answers "why is it slow".
//
//   ue-trace find [--project DIR]                    the .utrace files of the project and of the trace store, newest first
//   ue-trace analyze <file.utrace | --latest> [opts] export (Insights, 1-2 runs) + digest
//   ue-trace digest <csv dir> [--top N]              digest of CSVs exported earlier (no engine)
//   ue-trace --selftest                              the pure reducer on synthetic CSVs, offline
//
// analyze options:
//   --out DIR          where the CSVs go (default <tmp>/ue-trace/<trace name>); our CSVs there are replaced
//   --threads LIST     CPU thread patterns, comma-separated, * and ? wildcards (default GameThread,RenderThread*,RHIThread)
//   --top N            timers per thread (default 12)
//   --worst K          worst game frames to break down (default 5; 0 = one Insights run only)
//   --start S --end S  a time window in seconds of session time (as the frame CSV prints it)
//   --region PATTERN   also timer statistics per TRACE_BEGIN_REGION / Trace.RegionBegin region (wildcards)
//   --insights EXE     UnrealInsights.exe (default <engine>/Engine/Binaries/Win64/UnrealInsights.exe)
//   --timeout SEC      per Insights run (default 900)
//
// Ends with one line: RESULT: trace <OK|NO-DATA|FAILED> (exit N) - <summary>
// Exit: 0 digest printed · 1 Insights failed or the trace has no timing data · 2 bad arguments / no trace / no Insights.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectInfo, resolveEngine } from './ue-engine.mjs';

const DefaultThreads = ['GameThread', 'RenderThread*', 'RHIThread'];
const NoCpuThread = '__ue_trace_no_cpu_thread__'; // matches no thread: the statistics then hold the GPU timelines only
const WaitRe = /wait|idle|sleep|stall|sync|flush|block|EventWait|Yield/i;

// ---------------------------------------------------------------------------------------------------------------
// PURE: CSV
// ---------------------------------------------------------------------------------------------------------------

/** RFC-4180-ish CSV: quoted fields with "" escapes, CRLF or LF, a UTF-8 BOM. Returns rows of strings. */
export function parseCsv(text) {
	const rows = [];
	let row = [];
	let field = '';
	let q = false;
	const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (q) {
			if (c === '"') {
				if (s[i + 1] === '"') {
					field += '"';
					i++;
				} else q = false;
			} else field += c;
		} else if (c === '"') q = true;
		else if (c === ',') {
			row.push(field);
			field = '';
		} else if (c === '\n' || c === '\r') {
			if (c === '\r' && s[i + 1] === '\n') i++;
			row.push(field);
			if (row.length > 1 || row[0] !== '') rows.push(row);
			row = [];
			field = '';
		} else field += c;
	}
	if (field !== '' || row.length) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

/** CSV text -> array of {column: value} objects keyed by the header row. */
export function csvObjects(text) {
	const [head, ...rows] = parseCsv(text);
	if (!head) return [];
	return rows.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ''])));
}

// ---------------------------------------------------------------------------------------------------------------
// PURE: numbers
// ---------------------------------------------------------------------------------------------------------------

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted, p) {
	if (!sorted.length) return NaN;
	const rank = Math.ceil((p / 100) * sorted.length);
	return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

const ms = (sec) => sec * 1000;
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '-');
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '-');

/** Frame duration stats (seconds in, milliseconds out). A hitch is a frame longer than twice the median. */
export function frameStats(durations) {
	const d = durations.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
	if (!d.length) return null;
	const sum = d.reduce((a, b) => a + b, 0);
	const p50 = percentile(d, 50);
	return {
		n: d.length,
		avgMs: ms(sum / d.length),
		p50Ms: ms(p50),
		p95Ms: ms(percentile(d, 95)),
		p99Ms: ms(percentile(d, 99)),
		maxMs: ms(d[d.length - 1]),
		over33: d.filter((x) => x > 1 / 30).length,
		over50: d.filter((x) => x > 0.05).length,
		over100: d.filter((x) => x > 0.1).length,
		hitches: d.filter((x) => x > 2 * p50).length,
	};
}

// ---------------------------------------------------------------------------------------------------------------
// PURE: Insights CSV readers
// ---------------------------------------------------------------------------------------------------------------

/** frames.csv (ExportTimingEvents on "Game Frames,Rendering Frames") -> {game:[...], rendering:[...]} of
 * {index, start, end, dur} in seconds. TimerName is "<Type> Frame <index>" (FrameTimingTrack.cpp:584). */
export function parseFrames(text) {
	const out = { game: [], rendering: [] };
	for (const r of csvObjects(text)) {
		const kind = /^Game/i.test(r.ThreadName) ? 'game' : /^Rendering/i.test(r.ThreadName) ? 'rendering' : null;
		if (!kind) continue;
		const start = Number(r.StartTime);
		const end = Number(r.EndTime);
		const dur = r.Duration !== undefined && r.Duration !== '' ? Number(r.Duration) : end - start;
		const index = Number((r.TimerName.match(/(\d+)\s*$/) ?? [])[1] ?? NaN);
		if (Number.isFinite(start) && Number.isFinite(end)) out[kind].push({ index, start, end, dur });
	}
	return out;
}

/** ExportTimerStatistics CSV (TraceServices Table2Csv: Name,Count,C.Avg,Incl,I.Min,I.Max,I.Avg,I.Med,Excl,...;
 * times in seconds) -> Map name -> {count, incl, excl, iMax, eMax}. Duplicate names are summed. */
export function parseStats(text) {
	const m = new Map();
	for (const r of csvObjects(text)) {
		const name = r.Name;
		if (!name) continue;
		const row = { count: Number(r.Count) || 0, incl: Number(r.Incl) || 0, excl: Number(r.Excl) || 0, iMax: Number(r['I.Max']) || 0, eMax: Number(r['E.Max']) || 0 };
		const prev = m.get(name);
		if (prev) {
			prev.count += row.count;
			prev.incl += row.incl;
			prev.excl += row.excl;
			prev.iMax = Math.max(prev.iMax, row.iMax);
			prev.eMax = Math.max(prev.eMax, row.eMax);
		} else m.set(name, row);
	}
	return m;
}

/** ExportTimerStatistics always aggregates every GPU timeline next to the chosen CPU threads
 * (TimingExporter.cpp CreateAggregationParams: bIncludeOldGpu1/2, GpuQueueFilter = all). Subtract the GPU-only table
 * to get the CPU thread alone. Totals subtract exactly; a max shared with a GPU timer of the same name is unknown. */
export function subtractGpu(threadStats, gpuStats) {
	const rows = [];
	for (const [name, t] of threadStats) {
		const g = gpuStats.get(name);
		const count = t.count - (g?.count ?? 0);
		if (count <= 0) continue;
		rows.push({
			name,
			count,
			incl: Math.max(0, t.incl - (g?.incl ?? 0)),
			excl: Math.max(0, t.excl - (g?.excl ?? 0)),
			iMax: g ? NaN : t.iMax,
		});
	}
	return rows;
}

export const topByExcl = (rows, n) => [...rows].sort((a, b) => b.excl - a.excl || b.incl - a.incl).slice(0, n);

/** Timing events of one window (ExportTimingEvents -columns=ThreadName,TimerName,StartTime,EndTime,Depth) ->
 * Map thread -> {busy, timers: Map name -> exclusive seconds}, every event clamped to [winStart, winEnd].
 * Events come per thread timeline, parents before children (TimingExporter.cpp ExportTimingEvents_WriteEvents),
 * so a stack indexed by Depth finds each parent. busy = the clamped length of depth-0 events. */
export function exclusiveByThread(text, winStart, winEnd) {
	const out = new Map();
	let thread = null;
	let stack = [];
	const flush = () => {
		for (const e of stack) if (e) e.close();
		stack = [];
	};
	for (const r of csvObjects(text)) {
		if (r.ThreadName !== thread) {
			flush();
			thread = r.ThreadName;
			if (!out.has(thread)) out.set(thread, { busy: 0, timers: new Map() });
		}
		const t = out.get(thread);
		const depth = Number(r.Depth) || 0;
		const a = Math.max(winStart, Number(r.StartTime));
		const b = Math.min(winEnd, Number(r.EndTime));
		const len = Math.max(0, b - a);
		// close the open events at this depth and deeper
		while (stack.length > depth) {
			const e = stack.pop();
			if (e) e.close();
		}
		const parent = depth > 0 ? stack[depth - 1] : null;
		if (parent) parent.child += len;
		if (depth === 0) t.busy += len;
		const ev = {
			child: 0,
			close() {
				t.timers.set(r.TimerName, (t.timers.get(r.TimerName) ?? 0) + Math.max(0, len - this.child));
			},
		};
		stack[depth] = ev;
	}
	flush();
	return out;
}

/** The K longest game frames, longest first. */
export const worstFrames = (frames, k) => [...frames].sort((a, b) => b.dur - a.dur).slice(0, Math.max(0, k));

// ---------------------------------------------------------------------------------------------------------------
// PURE: Insights response files (one command per line, InsightsManager.cpp:1104 HandleResponseFileCmd)
// ---------------------------------------------------------------------------------------------------------------

// The export commands read the file name with FParse::Token(Cmd, bUseEscape = true): inside quotes a backslash is an
// escape and disappears (Parse.cpp:947-958). Forward slashes only.
const fwd = (p) => p.replace(/\\/g, '/');
const q = (p) => `"${fwd(p)}"`;
const windowArgs = ({ start, end }) => `${Number.isFinite(start) ? ` -startTime=${start}` : ''}${Number.isFinite(end) ? ` -endTime=${end}` : ''}`;

/** Pass 1: threads, frames, GPU-only statistics, statistics per CPU thread pattern, optional regions. */
export function pass1Commands(dir, { threads = DefaultThreads, start, end, region } = {}) {
	const w = windowArgs({ start, end });
	const lines = [
		`TimingInsights.ExportThreads ${q(join(dir, 'threads.csv'))}`,
		`TimingInsights.ExportTimingEvents ${q(join(dir, 'frames.csv'))} -threads="Game Frames,Rendering Frames" -columns=ThreadName,TimerName,StartTime,EndTime,Duration${w}`,
		`TimingInsights.ExportTimerStatistics ${q(join(dir, 'stats_gpu.csv'))} -threads=${NoCpuThread}${w}`,
	];
	threads.forEach((t, i) => lines.push(`TimingInsights.ExportTimerStatistics ${q(join(dir, `stats_t${i}.csv`))} -threads="${t}"${w}`));
	if (region) {
		lines.push(`TimingInsights.ExportTimerStatistics ${q(join(dir, 'region_gpu_{region}.csv'))} -threads=${NoCpuThread} -region="${region}"`);
		threads.forEach((t, i) => lines.push(`TimingInsights.ExportTimerStatistics ${q(join(dir, `region_t${i}_{region}.csv`))} -threads="${t}" -region="${region}"`));
	}
	return lines;
}

/** Pass 2: the timing events of each worst frame on the chosen CPU threads. */
export function pass2Commands(dir, frames, { threads = DefaultThreads } = {}) {
	return frames.map(
		(f, i) =>
			`TimingInsights.ExportTimingEvents ${q(join(dir, `worst_${i}.csv`))} -threads="${threads.join(',')}" -columns=ThreadName,TimerName,StartTime,EndTime,Depth -startTime=${f.start} -endTime=${f.end}`,
	);
}

// ---------------------------------------------------------------------------------------------------------------
// PURE: the digest
// ---------------------------------------------------------------------------------------------------------------

const tag = (name) => (WaitRe.test(name) ? `${name}  [wait]` : name);

/** A scope that wraps most of the thread's time (the per-frame root): its exclusive time is time inside it that no
 * child scope covers - unscoped code, not a hotspot. A leaf (no children: excl ~ incl) is never a root. */
export const isRoot = (r, rows) => r.excl < 0.9 * r.incl && r.incl >= 0.5 * rows.reduce((a, x) => a + x.excl, 0);
const label = (r, rows) => (!WaitRe.test(r.name) && isRoot(r, rows) ? `${r.name}  [root: unscoped time inside]` : tag(r.name));

function frameLine(label, s) {
	if (!s) return `${label}: none in the trace (the "frame" channel was off?)`;
	const pct = (x) => `${((100 * x) / s.n).toFixed(1)}%`;
	return (
		`${label}: ${s.n} frames, avg ${f1(s.avgMs)} ms (~${f1(1000 / s.avgMs)} fps) | p50 ${f1(s.p50Ms)}  p95 ${f1(s.p95Ms)}  p99 ${f1(s.p99Ms)}  max ${f1(s.maxMs)} ms | ` +
		`>33.3 ms: ${s.over33} (${pct(s.over33)})  >50: ${s.over50}  >100: ${s.over100} | hitches (>2x p50): ${s.hitches}`
	);
}

function timerTable(rows, { top, frames, span }) {
	const out = [];
	const busy = rows.reduce((a, r) => a + r.excl, 0);
	out.push(`    self-time total ${f1(ms(busy))} ms${span > 0 ? ` = ${((100 * busy) / span).toFixed(1)}% of ${f1(span)} s` : ''}${frames ? `, ${f2(ms(busy / frames))} ms/frame` : ''}`);
	out.push(`    ${'excl ms'.padStart(10)} ${'ms/frame'.padStart(9)} ${'incl ms'.padStart(10)} ${'count'.padStart(8)} ${'max incl'.padStart(9)}  timer`);
	for (const r of topByExcl(rows, top)) {
		out.push(
			`    ${f1(ms(r.excl)).padStart(10)} ${(frames ? f2(ms(r.excl / frames)) : '-').padStart(9)} ${f1(ms(r.incl)).padStart(10)} ${String(r.count).padStart(8)} ${(Number.isFinite(r.iMax) ? f1(ms(r.iMax)) : '?').padStart(9)}  ${label(r, rows)}`,
		);
	}
	return out;
}

/**
 * input: {trace, threads:[pattern], resolved:{pattern:[names]}, frames:{game,rendering}, gpu: Map, perThread:[Map],
 *         worst:[{frame, byThread: Map}], regions:[{name, perThread:[Map], gpu: Map}], top, window:{start,end}}
 * -> {lines, outcome, summary}
 */
export function buildDigest(input) {
	const { trace = '(csv)', threads = DefaultThreads, resolved = {}, frames = { game: [], rendering: [] }, gpu = new Map(), perThread = [], worst = [], regions = [], top = 12, window = {} } = input;
	const lines = [];
	const game = frameStats(frames.game.map((f) => f.dur));
	const rendering = frameStats(frames.rendering.map((f) => f.dur));
	const all = [...frames.game, ...frames.rendering];
	const t0 = all.length ? Math.min(...all.map((f) => f.start)) : window.start;
	const t1 = all.length ? Math.max(...all.map((f) => f.end)) : window.end;
	const span = Number.isFinite(t0) && Number.isFinite(t1) ? t1 - t0 : NaN;
	const nFrames = game?.n ?? 0;

	lines.push(`ue-trace digest: ${trace}`);
	lines.push(
		`window: ${Number.isFinite(window.start) || Number.isFinite(window.end) ? `--start ${window.start ?? '-inf'} --end ${window.end ?? '+inf'}` : 'whole session'}` +
			(Number.isFinite(span) ? ` (frames cover ${f2(t0)} .. ${f2(t1)} s = ${f1(span)} s)` : ''),
	);
	lines.push('');
	lines.push('== Frames ==');
	lines.push(frameLine('Game', game));
	lines.push(frameLine('Rendering', rendering));

	const cpuTops = [];
	threads.forEach((pattern, i) => {
		const rows = subtractGpu(perThread[i] ?? new Map(), gpu);
		const names = resolved[pattern];
		lines.push('');
		lines.push(`== CPU ${pattern}${names?.length ? ` (${names.join(', ')})` : ''}: top ${top} by exclusive time ==`);
		if (!rows.length) {
			lines.push(`    no timing events${names && !names.length ? ' - no thread matches this pattern' : ''}`);
			return;
		}
		lines.push(...timerTable(rows, { top, frames: nFrames, span }));
		const best = topByExcl(rows.filter((r) => !WaitRe.test(r.name) && !isRoot(r, rows)), 1)[0];
		if (best) cpuTops.push({ pattern, best });
	});

	const gpuRows = [...gpu].map(([name, r]) => ({ name, ...r }));
	lines.push('');
	lines.push(`== GPU (every queue together): top ${top} by exclusive time ==`);
	if (gpuRows.length) lines.push(...timerTable(gpuRows, { top, frames: nFrames, span }));
	else lines.push('    no GPU timing (the "gpu" channel was off, or a null RHI)');

	if (worst.length) {
		lines.push('');
		lines.push(`== Worst game frames (exclusive time inside the frame, top 4 per thread) ==`);
		for (const w of worst) {
			lines.push(`  Game Frame ${w.frame.index} at ${f2(w.frame.start)} s: ${f1(ms(w.frame.dur))} ms${game ? ` (${f1(ms(w.frame.dur) / game.p50Ms)}x p50)` : ''}`);
			if (!w.byThread || !w.byThread.size) {
				lines.push('    (no events exported for this frame)');
				continue;
			}
			for (const [thread, t] of w.byThread) {
				const topT = [...t.timers].sort((a, b) => b[1] - a[1]).slice(0, 4);
				lines.push(`    ${thread} busy ${f1(ms(t.busy))} ms: ${topT.map(([n, v]) => `${tag(n)} ${f1(ms(v))}`).join(' | ')}`);
			}
		}
	}

	for (const r of regions) {
		lines.push('');
		lines.push(`== Region ${r.name} ==`);
		threads.forEach((pattern, i) => {
			const rows = subtractGpu(r.perThread[i] ?? new Map(), r.gpu ?? new Map());
			lines.push(`  ${pattern}:${rows.length ? '' : ' no timing events'}`);
			if (rows.length) lines.push(...timerTable(rows, { top: Math.min(top, 8), frames: 0, span: NaN }));
		});
	}

	const hasData = Boolean(game || rendering || gpuRows.length || cpuTops.length);
	const parts = [];
	if (game) parts.push(`game frames p50 ${f1(game.p50Ms)} / p95 ${f1(game.p95Ms)} / max ${f1(game.maxMs)} ms, ${game.hitches} hitch(es)`);
	for (const { pattern, best } of cpuTops.slice(0, 2)) parts.push(`${pattern} top self ${best.name} ${nFrames ? `${f2(ms(best.excl / nFrames))} ms/frame` : `${f1(ms(best.excl))} ms`}`);
	const gpuTop = topByExcl(gpuRows.filter((r) => !isRoot(r, gpuRows)), 1)[0];
	if (gpuTop) parts.push(`GPU top ${gpuTop.name} ${nFrames ? `${f2(ms(gpuTop.excl / nFrames))} ms/frame` : `${f1(ms(gpuTop.excl))} ms`}`);
	return { lines, outcome: hasData ? 'OK' : 'NO-DATA', summary: hasData ? parts.join('; ') : 'no frames and no timers in the exported CSVs' };
}

export const verdictLine = (outcome, code, summary) => `RESULT: trace ${outcome} (exit ${code}) - ${summary}`;

// ---------------------------------------------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------------------------------------------

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

/** Read a CSV folder written by pass 1 (+ pass 2) and build the digest. */
export function digestDir(dir, { threads, top = 12, window = {}, trace } = {}) {
	const threadRows = csvObjects(read(join(dir, 'threads.csv')));
	const files = existsSync(dir) ? readdirSync(dir) : [];
	const meta = existsSync(join(dir, 'ue-trace.json')) ? JSON.parse(read(join(dir, 'ue-trace.json'))) : {};
	threads = threads ?? meta.threads ?? DefaultThreads;
	const resolved = {};
	if (threadRows.length) {
		const toRe = (p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
		for (const p of threads) resolved[p] = threadRows.filter((r) => r.Group !== 'GPU' && r.Group !== 'Frame Tracks' && toRe(p).test(r.Name)).map((r) => r.Name);
	}
	const frames = parseFrames(read(join(dir, 'frames.csv')));
	const worst = (meta.worst ?? [])
		.map((f, i) => ({ frame: f, file: join(dir, `worst_${i}.csv`) }))
		.filter((w) => existsSync(w.file))
		.map((w) => ({ frame: w.frame, byThread: exclusiveByThread(read(w.file), w.frame.start, w.frame.end) }));
	const regionKeys = files.map((f) => f.match(/^region_gpu_(.+)\.csv$/)?.[1]).filter(Boolean);
	const regions = regionKeys.map((k) => ({
		name: k,
		gpu: parseStats(read(join(dir, `region_gpu_${k}.csv`))),
		perThread: threads.map((_, i) => parseStats(read(join(dir, `region_t${i}_${k}.csv`)))),
	}));
	return buildDigest({
		trace: trace ?? meta.trace ?? dir,
		threads,
		resolved,
		frames,
		gpu: parseStats(read(join(dir, 'stats_gpu.csv'))),
		perThread: threads.map((_, i) => parseStats(read(join(dir, `stats_t${i}.csv`)))),
		worst,
		regions,
		top,
		window: meta.window ?? window,
	});
}

/** Every .utrace of the project (Saved/Profiling, where -tracefile / Trace.File put relative paths) and of the local
 * trace store (where -tracehost / a running Insights put them), newest first. */
export function findTraces(env = process.env, at = process.cwd()) {
	const roots = [];
	const p = projectInfo(at, env);
	if (p) roots.push(join(p.root, 'Saved', 'Profiling'));
	if (env.LOCALAPPDATA) roots.push(join(env.LOCALAPPDATA, 'UnrealEngine', 'Common', 'UnrealTrace', 'Store'));
	const out = [];
	const walk = (d, depth) => {
		let es;
		try {
			es = readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of es) {
			const f = join(d, e.name);
			if (e.isDirectory() && depth < 3) walk(f, depth + 1);
			else if (/\.utrace$/i.test(e.name)) {
				const st = statSync(f);
				out.push({ path: f, size: st.size, mtime: st.mtimeMs });
			}
		}
	};
	for (const r of roots) walk(r, 0);
	return out.sort((a, b) => b.mtime - a.mtime);
}

function insightsExe(explicit) {
	if (explicit) return existsSync(explicit) ? { exe: explicit } : { error: `--insights ${explicit} does not exist` };
	const eng = resolveEngine();
	if (eng.error) return { error: eng.error };
	const exe = join(eng.unrealHome, 'Engine', 'Binaries', 'Win64', 'UnrealInsights.exe');
	return existsSync(exe)
		? { exe }
		: { error: `${exe} is missing. Launcher installs ship it; a source build builds the "UnrealInsights" program target (Win64 Development), or pass --insights <exe>.` };
}

/** One headless Insights run: open the trace, execute the response file when the analysis completes, quit. */
function runInsights(exe, trace, rspPath, logPath, timeoutSec) {
	// Built verbatim: UE reads -Key="value with spaces" itself, Node's own quoting would wrap the whole argument.
	const cmd = `-OpenTraceFile="${trace}" -ABSLOG="${logPath}" -AutoQuit -NoUI -ExecOnAnalysisCompleteCmd="@=${fwd(rspPath)}" -log`;
	const t = Date.now();
	const r = spawnSync(exe, [cmd], { windowsVerbatimArguments: true, windowsHide: true, timeout: timeoutSec * 1000, stdio: 'ignore' });
	const log = read(logPath);
	return {
		secs: (Date.now() - t) / 1000,
		timedOut: r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM',
		spawnError: r.error && r.error.code !== 'ETIMEDOUT' ? r.error.message : null,
		ran: /Executing commands on analysis completed/.test(log),
		errors: log.split(/\r?\n/).filter((l) => /Failed to export|Cannot write the export file|Unable to find any region|Failed to open the response file|Unknown Cmd Param/i.test(l)),
	};
}

function parseArgs(argv) {
	const o = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--latest' || a === '--selftest' || a === '--help') o[a.slice(2)] = true;
		else if (a.startsWith('--')) o[a.slice(2)] = argv[++i];
		else o._.push(a);
	}
	return o;
}

function exitWith(outcome, code, summary) {
	console.log(`\n${verdictLine(outcome, code, summary)}`);
	process.exitCode = code;
}

function analyze(o) {
	let trace = o._[1];
	if (o.latest || !trace) {
		const all = findTraces(process.env, o.project ?? process.cwd());
		if (!o.latest || !all.length) return exitWith('FAILED', 2, trace ? 'no trace' : 'give a .utrace or --latest (ue-trace find lists them)');
		trace = all[0].path;
	}
	trace = resolve(trace);
	if (!existsSync(trace)) return exitWith('FAILED', 2, `${trace} does not exist`);
	const ins = insightsExe(o.insights);
	if (ins.error) return exitWith('FAILED', 2, ins.error);
	const threads = o.threads ? o.threads.split(',').map((s) => s.trim()).filter(Boolean) : DefaultThreads;
	const top = Number(o.top ?? 12);
	const worstK = Number(o.worst ?? 5);
	const timeout = Number(o.timeout ?? 900);
	const window = { start: o.start !== undefined ? Number(o.start) : undefined, end: o.end !== undefined ? Number(o.end) : undefined };
	const dir = resolve(o.out ?? join(tmpdir(), 'ue-trace', basename(trace).replace(/\.utrace$/i, '')));
	mkdirSync(dir, { recursive: true });
	for (const f of readdirSync(dir)) if (/^(threads|frames|stats_.*|worst_\d+|region_.*)\.csv$|^pass\d\.(rsp|log)$|^ue-trace\.json$/.test(f)) rmSync(join(dir, f), { force: true });

	const age = (Date.now() - statSync(trace).mtimeMs) / 1000;
	if (age < 10) console.log(`warning: ${basename(trace)} was written ${age.toFixed(0)} s ago - if the game still traces, stop it first (Trace.Stop)`);
	console.log(`trace   : ${trace} (${(statSync(trace).size / 1048576).toFixed(1)} MB)`);
	console.log(`insights: ${ins.exe}`);
	console.log(`csv dir : ${dir}`);

	const rsp1 = join(dir, 'pass1.rsp');
	writeFileSync(rsp1, pass1Commands(dir, { threads, ...window, region: o.region }).join('\n') + '\n', 'utf8');
	const r1 = runInsights(ins.exe, trace, rsp1, join(dir, 'pass1.log'), timeout);
	console.log(`pass 1  : ${r1.secs.toFixed(1)} s${r1.timedOut ? ' (TIMED OUT)' : ''}`);
	for (const e of r1.errors) console.log(`  insights: ${e.trim()}`);
	if (r1.spawnError) return exitWith('FAILED', 1, `could not start Insights: ${r1.spawnError}`);
	if (!r1.ran || !existsSync(join(dir, 'frames.csv'))) {
		return exitWith('FAILED', 1, `${r1.timedOut ? `timed out after ${timeout} s` : 'the export did not run'} - read ${join(dir, 'pass1.log')}`);
	}

	const frames = parseFrames(read(join(dir, 'frames.csv')));
	const worst = worstFrames(frames.game, worstK);
	writeFileSync(join(dir, 'ue-trace.json'), JSON.stringify({ trace, threads, window, worst }, null, 1), 'utf8');
	if (worst.length) {
		const rsp2 = join(dir, 'pass2.rsp');
		writeFileSync(rsp2, pass2Commands(dir, worst, { threads }).join('\n') + '\n', 'utf8');
		const r2 = runInsights(ins.exe, trace, rsp2, join(dir, 'pass2.log'), timeout);
		console.log(`pass 2  : ${r2.secs.toFixed(1)} s (${worst.length} worst frames)${r2.timedOut ? ' (TIMED OUT)' : ''}`);
		for (const e of r2.errors) console.log(`  insights: ${e.trim()}`);
	}
	console.log('');
	const d = digestDir(dir, { threads, top, window, trace: basename(trace) });
	for (const l of d.lines) console.log(l);
	exitWith(d.outcome, d.outcome === 'OK' ? 0 : 1, d.summary);
}

// ---------------------------------------------------------------------------------------------------------------
// self-test: synthetic CSVs shaped like Insights' own output (captured from a real 5.8 export)
// ---------------------------------------------------------------------------------------------------------------

export function selftest() {
	const fail = [];
	const eq = (a, b, m) => {
		if (JSON.stringify(a) !== JSON.stringify(b)) fail.push(`${m}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);
	};
	const near = (a, b, m, eps = 1e-9) => {
		if (!(Math.abs(a - b) <= eps)) fail.push(`${m}: got ${a} expected ${b}`);
	};

	eq(parseCsv('a,"b,c","d""e"\r\n1,2,3\n'), [['a', 'b,c', 'd"e'], ['1', '2', '3']], 'csv quoting and CRLF');
	eq(parseCsv('\ufeffx\n'), [['x']], 'csv BOM');
	eq(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10, 'nearest-rank p95');
	eq(percentile([1, 2, 3, 4], 50), 2, 'nearest-rank p50');

	const framesCsv = [
		'ThreadName,TimerName,StartTime,EndTime,Duration',
		...Array.from({ length: 18 }, (_, i) => `Game Frames,Game Frame ${i},${(i * 0.02).toFixed(2)},${(i * 0.02 + 0.016).toFixed(3)},0.016000000`),
		'Game Frames,Game Frame 18,0.36,0.46,0.100000000',
		'Game Frames,Game Frame 19,0.46,0.5,0.040000000',
		'Rendering Frames,Rendering Frame 0,0.01,0.025,0.015000000',
	].join('\n');
	const fr = parseFrames(framesCsv);
	eq([fr.game.length, fr.rendering.length], [20, 1], 'frames split by track');
	eq(fr.game[18].index, 18, 'frame index from "Game Frame N"');
	const fs = frameStats(fr.game.map((f) => f.dur));
	near(fs.p50Ms, 16, 'p50 ms', 1e-6);
	near(fs.maxMs, 100, 'max ms', 1e-6);
	eq([fs.over33, fs.over50, fs.over100, fs.hitches], [2, 1, 0, 2], 'frame thresholds and hitches');
	eq(worstFrames(fr.game, 2).map((f) => f.index), [18, 19], 'worst frames longest first');

	const head = 'Name,Count,C.Avg,Incl,I.Min,I.Max,I.Avg,I.Med,Excl,E.Min,E.Max,E.Avg,E.Med';
	const gpuCsv = [head, 'BasePass,20,20.000000,0.100000,0,0.01,0.005,0.005,0.080000,0,0.01,0.004,0.004', 'Frame,20,20.000000,0.300000,0,0.02,0.015,0.015,0.020000,0,0.002,0.001,0.001'].join('\n');
	const gtCsv = [
		head,
		'BasePass,20,20.000000,0.100000,0,0.01,0.005,0.005,0.080000,0,0.01,0.004,0.004',
		'Frame,25,25.000000,0.310000,0,0.02,0.015,0.015,0.025000,0,0.002,0.001,0.001',
		'UWorld_Tick,20,20.000000,0.200000,0,0.03,0.01,0.01,0.050000,0,0.01,0.002,0.002',
		'Tick AMyActor,400,400.000000,0.150000,0,0.002,0.0004,0.0003,0.150000,0,0.002,0.0004,0.0003',
		'FEngineLoop_Tick,20,20.000000,0.400000,0,0.11,0.02,0.016,0.010000,0,0.001,0.0005,0.0005',
		'WaitForTasks,20,20.000000,0.120000,0,0.03,0.006,0.006,0.120000,0,0.03,0.006,0.006',
	].join('\n');
	const rows = subtractGpu(parseStats(gtCsv), parseStats(gpuCsv));
	eq(rows.map((r) => r.name).sort(), ['FEngineLoop_Tick', 'Frame', 'Tick AMyActor', 'UWorld_Tick', 'WaitForTasks'], 'GPU-only timers drop out, a shared name keeps the CPU remainder');
	const frame = rows.find((r) => r.name === 'Frame');
	eq(frame.count, 5, 'shared name: count difference');
	near(frame.excl, 0.005, 'shared name: excl difference', 1e-9);
	eq(Number.isNaN(frame.iMax), true, 'shared name: max is unknown');
	eq(topByExcl(rows, 2).map((r) => r.name), ['Tick AMyActor', 'WaitForTasks'], 'top by exclusive');

	// Events of one 0.100 s frame window [1.0, 1.1]: a root that started earlier (clamped), children, a grandchild.
	const evCsv = [
		'ThreadName,TimerName,StartTime,EndTime,Depth',
		'GameThread,FEngineLoop_Tick,0.99,1.1,0',
		'GameThread,UWorld_Tick,1.0,1.08,1',
		'GameThread,Tick AMyActor,1.01,1.07,2',
		'GameThread,Slate,1.08,1.09,1',
		'RenderThread 0,FRenderingThread_Wait,1.0,1.05,0',
	].join('\n');
	const ex = exclusiveByThread(evCsv, 1.0, 1.1);
	const gt = ex.get('GameThread');
	near(gt.busy, 0.1, 'busy is the clamped root length');
	near(gt.timers.get('FEngineLoop_Tick'), 0.01, 'root exclusive = clamped length - children');
	near(gt.timers.get('UWorld_Tick'), 0.02, 'child exclusive');
	near(gt.timers.get('Tick AMyActor'), 0.06, 'grandchild exclusive');
	near(gt.timers.get('Slate'), 0.01, 'sibling after a deeper branch');
	near(ex.get('RenderThread 0').busy, 0.05, 'second thread kept apart');

	const p1 = pass1Commands('C:\\x y\\out', { threads: ['GameThread'], start: 10, end: 20, region: 'Load*' });
	eq(p1.some((l) => l.includes('\\')), false, 'response file lines carry no backslash (FParse::Token eats it)');
	eq(p1[1].includes('-threads="Game Frames,Rendering Frames"') && p1[1].includes(' -startTime=10 -endTime=20'), true, 'frames command with window');
	eq(p1.filter((l) => l.includes('{region}')).length, 2, 'region commands: GPU-only + one per thread');
	eq(pass2Commands('C:/o', [{ start: 1.5, end: 1.6 }])[0].endsWith('-startTime=1.5 -endTime=1.6'), true, 'pass 2 window');

	const d = buildDigest({
		trace: 'synthetic',
		threads: ['GameThread', 'NoSuchThread'],
		resolved: { GameThread: ['GameThread'], NoSuchThread: [] },
		frames: fr,
		gpu: parseStats(gpuCsv),
		perThread: [parseStats(gtCsv), parseStats(gpuCsv)],
		worst: [{ frame: fr.game[18], byThread: ex }],
		top: 3,
	});
	const text = d.lines.join('\n');
	eq(d.outcome, 'OK', 'digest outcome');
	eq(/Game: 20 frames/.test(text), true, 'digest frame line');
	eq(/no thread matches this pattern/.test(text), true, 'digest names an unmatched thread pattern');
	eq(/WaitForTasks {2}\[wait\]/.test(text), true, 'wait timers are tagged');
	eq(/Game Frame 18 at 0\.36 s: 100\.0 ms/.test(text), true, 'worst frame line');
	eq(d.summary.includes('GameThread top self Tick AMyActor'), true, 'summary skips wait timers');
	const rootText = buildDigest({ threads: ['GameThread'], perThread: [parseStats(gtCsv)], top: 10 }).lines.join('\n');
	eq(rootText.includes('FEngineLoop_Tick  [root: unscoped time inside]'), true, 'a root scope is tagged');
	eq(isRoot({ incl: 0.4, excl: 0.01 }, rows) && !isRoot({ incl: 0.1, excl: 0.01 }, rows) && !isRoot({ incl: 0.4, excl: 0.4 }, rows), true, 'root = has children and inclusive over half the thread self-time');
	eq(verdictLine('OK', 0, 's'), 'RESULT: trace OK (exit 0) - s', 'verdict line format');
	eq(buildDigest({}).outcome, 'NO-DATA', 'empty input is NO-DATA, not OK');
	return fail;
}

// ---------------------------------------------------------------------------------------------------------------

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	const o = parseArgs(process.argv.slice(2));
	const cmd = o._[0];
	if (o.selftest) {
		const fail = selftest();
		for (const f of fail) console.log(`  FAIL ${f}`);
		console.log(fail.length ? `ue-trace selftest: ${fail.length} failed` : 'ue-trace selftest: ok');
		process.exitCode = fail.length ? 1 : 0;
	} else if (cmd === 'find') {
		const all = findTraces(process.env, o.project ?? process.cwd());
		for (const t of all.slice(0, 20)) console.log(`${new Date(t.mtime).toISOString().slice(0, 16).replace('T', ' ')}  ${(t.size / 1048576).toFixed(1).padStart(8)} MB  ${t.path}`);
		exitWith(all.length ? 'OK' : 'NO-DATA', all.length ? 0 : 1, `${all.length} trace(s) in Saved/Profiling and the trace store`);
	} else if (cmd === 'analyze') {
		analyze(o);
	} else if (cmd === 'digest' && o._[1]) {
		const d = digestDir(resolve(o._[1]), { top: Number(o.top ?? 12) });
		for (const l of d.lines) console.log(l);
		exitWith(d.outcome, d.outcome === 'OK' ? 0 : 1, d.summary);
	} else {
		console.log('usage: ue-trace find [--project DIR] | analyze <file.utrace|--latest> [--out DIR] [--threads A,B*] [--top N] [--worst K] [--start S --end S] [--region P] [--insights EXE] [--timeout SEC] | digest <csv dir> [--top N] | --selftest');
		exitWith('FAILED', 2, 'bad arguments');
	}
}
