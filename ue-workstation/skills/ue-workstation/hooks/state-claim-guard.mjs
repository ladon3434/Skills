// state-claim-guard.mjs — a word about the state of the project stands on a check made in the same turn, never on a
// result read earlier, a subagent's report or an inference.
//
// WHY. Agents say "it builds", "the tests pass", "the task is done", "that file is busy, we wait" after a turn that
// ran no command at all: a subagent's notice in, its words out — and the person acts on it. A build log of an hour
// ago, a record of who holds a task, a subagent's summary: each is a snapshot that lags the work.
//
// Stop                       the reply is judged (the client's last_assistant_message, else the last text of the
//                            turn in the transcript).
// PreToolUse AskUserQuestion the question and its options are judged: a card's premise is a claim too.
//
// THE RULE. Two kinds of claim, each with the checks that back it:
//   - build / test: "it builds", "compiles cleanly", "the build passed", "tests pass", "all tests green",
//     «собирается», «сборка прошла», «тесты проходят» — backed only by a build or test run of this turn
//     (Build.bat / RunUAT / UBT, the ue-build-test scripts, increment-compile, compile.cmd, run-tests, msbuild,
//     dotnet / npm / cargo / go build|test, cmake --build, ctest, pytest, node --test, a selftest…);
//   - done: a word that the work is finished (done, not done, ready; «сделано», «не сделано», «сдано», «готово») paired
//     with a subject — a task id (ABC-123), a window, a map (L_…), a proper name in mid-sentence, a name of
//     UE_WS_STATE_NAMES; a generic subject (tasks, steps, branch, map…) only with "now / already / still" beside it —
//     backed by any check of this turn: a git read (log, fetch, show, status, diff, blame, rev-parse), `gh … view|list
//     |status`, or a build / test run.
// UE_WS_STATE_CHECKS adds a project's own check commands (a regular expression, case-insensitive) to both kinds.
//
// No claim: quoted words and code (someone's words, a name), a condition («если…», "if / when / once …", how the
// machine works), waiting on the person («жду твоего ответа», "your call"), a sentence that says it is unverified
// ("not checked", «не знаю», «не проверял»).
//
// Who holds what, what is committed or pushed, what we wait for: no claim here. Such words came back on every report
// of a git state and cost a round each; a done-claim and a build-claim are the ones a person acts on.
//
// THE TURN starts at the person's last message. A background task's notice, a subagent's report and a hook's
// feedback arrive as user entries too, but they do not start a turn: a build started in the background and reported
// by a notice still backs the reply. A transcript without the origin field (an older client) falls back to: any
// user text that is not meta starts the turn.
//
// A bounce, not a wall: the second Stop of the same turn passes (the client's stop_hook_active), and for a card the
// same text asked again passes. Off with UE_WS_STATE_GUARD=0. Fails open on an unreadable payload or transcript.
// UE_WS_STATE_GUARD_LOG=1 prints every decision to stderr.

import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPayload } from './hook-io.mjs';

const log = (m) => { if (process.env.UE_WS_STATE_GUARD_LOG === '1') process.stderr.write(`[state-claim-guard] ${m}\n`); };

// `\b` is ASCII-only even under /u: a Cyrillic word ends where no letter follows (E), starts where none precedes (B).
const E = String.raw`(?![\p{L}\p{N}])`;
const B = String.raw`(?<![\p{L}\p{N}])`;

/** A claim that the project builds or its tests pass — self-contained, no subject needed. */
const BUILD_CLAIM = new RegExp([
	String.raw`\b(it|that|this|everything|all|now|still|the (project|code|game|editor|module|plugin|target|branch)s?)\s+(builds|compiles)\b`,
	String.raw`\b(builds|compiles)\s+(fine|cleanly|clean|ok|successfully|without (errors|warnings))\b`,
	String.raw`\b(build|compile|compilation|rebuild)\s+(passes|passed|succeeds|succeeded|is green|was green|is clean|went through|works)\b`,
	String.raw`\b(builds?|compiles?)\s+(is |are )?green\b`,
	String.raw`\btests?\s+(all\s+)?(pass|passes|passed|succeed|succeeded|are green|is green|were green)\b`,
	String.raw`\b(all|every)\s+(the\s+)?tests?\s+(pass|passed|green)\b`,
	String.raw`\bgreen tests?\b`,
	String.raw`${B}(собира(ется|ются)|компилиру(ется|ются)|скомпилир(овалось|овался|овалась|овались|уется)|собрал(ось|ся|ась|ись)?)${E}`,
	String.raw`${B}(сборка|билд|компиляция)\s+(прош(ла|ёл|ел)|проходит|зел[её]н(ая|ый)|успешн(а|ая|ый)|чист(ая|ый))${E}`,
	String.raw`${B}тест\p{L}*\s+(все\s+)?(проход(ит|ят)|прош(ли|ёл|ел)|зел[её]н\p{L}*|успешн\p{L}*)`,
	String.raw`${B}(все|оба)\s+тест\p{L}*\s+(проход|прош|зел[её]н)`,
	String.raw`${B}прогон\s+(тестов\s+)?(прош[её]л|зел[её]ный|чистый)${E}`,
].join('|'), 'iu');

/** A word that the work is finished. A claim only with a subject. */
const STATE = new RegExp(String.raw`(сделан[аоы]?${E}|не сделан|сдан[аоы]?${E}|готов[аоы]?${E}|\bis done\b|\bnot done\b|\bis ready\b)`, 'iu');
// A claim names WHAT it is about. A concrete subject — a task id, a window, a map, a proper name in mid-sentence
// (a level, a person) — is enough; a generic one («задачи», "steps") only with "now" beside it («все задачи сейчас
// на…»). How the machine works — «шаг сделан, когда…», "if the task was taken…" — is no claim.
const SPECIFIC = new RegExp(String.raw`(\b[A-Z][A-Za-z]{1,9}-\d{2,6}\b|окн[оаеу]${E}|\bwindow\b|\bL_[A-Za-z]|(?<=[\p{L}\p{N},;:»)]\s+)\p{Lu}\p{Ll}{2,})`, 'u');
const GENERIC = new RegExp(String.raw`(задач|комнат|шаг|карт[аыуе]${E}|уровень|ветк|\btasks?\b|\brecords?\b|\bsteps?\b|\brooms?\b|\bmaps?\b|\blevels?\b|\bbranch(es)?\b|\btickets?\b)`, 'iu');
const NOW = new RegExp(String.raw`(сейчас|уже${E}|пока${E}|ещё не|до сих пор|\bnow\b|\bcurrently\b|\bstill\b|\balready\b)`, 'iu');
const CONDITIONAL = new RegExp(String.raw`^[\s\-*•\d.)]*(\*\*[^*]*\*\*[\s:—-]*)?(если|когда|пока не|\bif\b|\bwhen\b|\bonce\b|\bbefore\b|\bunless\b)${E}`, 'iu');
/** Waiting on the person is a question, not a claim about the project. */
const PERSON_WAIT = /(тво(его|ей|й|ё|им)\s+(ответ|слов|решени|выбор)|жду\s+(ответ|слова|решения)|your (answer|word|call|choice|decision))/iu;
/** A sentence that says it is not verified claims nothing. */
const UNVERIFIED = new RegExp(String.raw`(не знаю|не провер|непровер|не собира(л|ли)${E}|не запуска|не прогон|\bnot (yet )?(checked|verified|built|run|tested)\b|\b(did not|didn't|have not|haven't) (check|verify|build|run|test)|\bunverified\b|\bunknown\b|\bI don't know\b)`, 'iu');

/** A build or test run. */
export const BUILD_CHECK = new RegExp([
	String.raw`\bBuild\.(bat|sh)\b`, String.raw`\bRunUAT\b`, String.raw`\bUnrealBuildTool\b`, String.raw`\bUBT\b`,
	String.raw`\bue-(compile|rebuild|game-build|build|test|test-suites|check-blueprints|validate-data|selftest)\b`,
	String.raw`increment-compile`, String.raw`(^|[\\/\s"'])compile\.(cmd|bat|sh)\b`,
	String.raw`run-tests`, String.raw`hooks-test`, String.raw`--selftest\b`, String.raw`\bselftest\b`,
	String.raw`check-blueprints`, String.raw`Automation\s+RunTests`, String.raw`-ExecCmds=["']?Automation`,
	String.raw`\bmsbuild\b`, String.raw`\bdevenv(\.com|\.exe)?\b.*\/(build|rebuild)\b`,
	String.raw`\bdotnet\s+(build|test)\b`, String.raw`\b(npm|pnpm|yarn)\s+(run\s+)?(build|test)\b`, String.raw`\bnpx\s+(tsc|jest|vitest)\b`,
	String.raw`\bcargo\s+(build|test|check)\b`, String.raw`\bgo\s+(build|test|vet)\b`, String.raw`\bcmake\s+--build\b`, String.raw`\bctest\b`,
	String.raw`\b(n?make|ninja)\b`, String.raw`\bpytest\b`, String.raw`python3?\s+-m\s+(pytest|unittest)\b`, String.raw`\bnode\s+--test\b`,
	String.raw`\bgradlew?\s+\S*(build|test)`, String.raw`\bmvn\s+\S*(package|test|verify)`, String.raw`\btsc\b`,
].join('|'), 'i');
/** A fresh read of the work's state: git, or the forge. */
export const STATE_CHECK = /(\bgit\b(\s+-C\s+\S+)?(\s+-c\s+\S+)*\s+(log|fetch|show|status|diff|blame|rev-parse|branch|ls-remote|shortlog)\b|\bgh\s+(pr|issue|run|api)\b|\bglab\s+(mr|issue|ci)\b)/i;

/** Extra project checks: UE_WS_STATE_CHECKS, a case-insensitive regular expression; null when unset or invalid. */
export function extraChecks(env = process.env) {
	const raw = env.UE_WS_STATE_CHECKS;
	if (!raw) return null;
	try { return new RegExp(raw, 'i'); } catch { return null; }
}

/** The names of people / rooms that count as a subject: UE_WS_STATE_NAMES, separated by `;`. */
export function namesFrom(env = process.env) {
	return String(env.UE_WS_STATE_NAMES ?? '').split(';').map((s) => s.trim()).filter(Boolean);
}

/** PURE: the claims of `text`, as [{sentence, kind: 'build' | 'state'}]. */
export function stateClaims(text, names = []) {
	const person = names.length ? new RegExp(names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'u') : null;
	const out = [];
	const sentences = String(text ?? '')
		// Quoted words are someone's words, code is a name: neither is the agent saying the state.
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/«[^«»\n]*»|"[^"\n]*"|“[^”\n]*”|`[^`\n]*`/g, ' … ')
		.split(/(?<=[.!?…])\s+|\n+/)
		.map((s) => s.trim())
		.filter((s) => s && !PERSON_WAIT.test(s) && !CONDITIONAL.test(s) && !UNVERIFIED.test(s));
	for (const s of sentences) {
		if (BUILD_CLAIM.test(s)) out.push({ sentence: s, kind: 'build' });
		else if (STATE.test(s) && (SPECIFIC.test(s) || (person?.test(s) ?? false) || (GENERIC.test(s) && NOW.test(s)))) out.push({ sentence: s, kind: 'state' });
	}
	return out;
}

/** PURE: the claims that no command of this turn backs. A build claim needs a build or test run; a state claim any check. */
export function unbacked(claims, commands, extra = null) {
	const ran = (re) => commands.some((c) => re.test(c));
	const custom = extra ? ran(extra) : false;
	const built = custom || ran(BUILD_CHECK);
	const read = built || ran(STATE_CHECK);
	return claims.filter((c) => (c.kind === 'build' ? !built : !read));
}

/** PURE: the current turn of a transcript — the commands run since the last prompt, and the last reply text. */
export function currentTurn(jsonl) {
	const entries = [];
	for (const line of String(jsonl).split(/\r?\n/)) {
		if (!line.trim()) continue;
		try { entries.push(JSON.parse(line)); } catch { /* a torn line */ }
	}
	let start = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e?.type !== 'user' || e.isMeta || e.isSidechain || e.toolUseResult) continue;
		// A notice or a report is a user entry the person did not type: it does not start a turn.
		if (e.origin?.kind && e.origin.kind !== 'human') continue;
		const c = e.message?.content;
		const prompt = typeof c === 'string' || (Array.isArray(c) && c.some((p) => p?.type === 'text'));
		if (prompt) { start = i + 1; break; }
	}
	const commands = [];
	let reply = '';
	for (const e of entries.slice(start)) {
		if (e?.type !== 'assistant' || e.isSidechain) continue;
		for (const p of e.message?.content ?? []) {
			if (p?.type === 'tool_use') commands.push(String(p.input?.command ?? ''));
			if (p?.type === 'text') reply = String(p.text);
		}
	}
	return { commands, reply };
}

/** PURE: the text of an AskUserQuestion card — every question and every option. */
export function cardText(toolInput) {
	const qs = Array.isArray(toolInput?.questions) ? toolInput.questions : [];
	return qs.map((q) => [q?.question ?? '', ...(q?.options ?? []).map((o) => `${o?.label ?? ''}. ${o?.description ?? ''}`)].join('\n')).join('\n');
}

export function reason(claims, where) {
	const build = claims.some((c) => c.kind === 'build');
	return `STATE CLAIM WITHOUT A FRESH CHECK — ${where} says the state of the project, and nothing in this turn checked it:\n`
		+ claims.slice(0, 3).map((c) => `  "${c.sentence.length > 160 ? c.sentence.slice(0, 157) + '…' : c.sentence}"`).join('\n')
		+ '\nA build log of an earlier turn, a record of who holds what, a subagent\'s report: each is a snapshot that lags the work. '
		+ (build ? 'Run the build or the tests the project prescribes (ue-build-test) in this turn' : 'Check first — git log / git status, the build, the tests')
		+ ', then say it naming what you checked ("by the build of this turn: …"), or say plainly that it is not verified. '
		+ 'Nothing to check and not a claim? Send it again as it is; this comes back once. (Off: UE_WS_STATE_GUARD=0.)';
}

const TailBytes = 8 * 1024 * 1024;

/** The last TailBytes of the transcript ('' when unreadable). A cut first line is skipped by currentTurn. */
function readTranscript(path) {
	if (!path || !existsSync(path)) return '';
	let fd;
	try {
		fd = openSync(path, 'r');
		const size = fstatSync(fd).size;
		const len = Math.min(size, TailBytes);
		const buf = Buffer.alloc(len);
		readSync(fd, buf, 0, len, size - len);
		return buf.toString('utf8');
	} catch {
		return '';
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function main() {
	if (process.env.UE_WS_STATE_GUARD === '0') return;
	const p = readPayload();
	if (!p) { log('unreadable payload: pass'); return; }
	const ev = p.hook_event_name;
	const isStop = ev === 'Stop';
	const isCard = ev === 'PreToolUse' && p.tool_name === 'AskUserQuestion';
	if (!isStop && !isCard) return;
	if (isStop && p.stop_hook_active) { log('second stop of the turn: pass'); return; }
	const names = namesFrom();
	const turn = currentTurn(readTranscript(p.transcript_path));
	const text = isStop ? (p.last_assistant_message ?? turn.reply) : cardText(p.tool_input);
	const left = unbacked(stateClaims(text, names), turn.commands, extraChecks());
	log(`${isStop ? 'stop' : 'card'}: ${left.length} unbacked claim(s), ${turn.commands.length} command(s)`);
	if (!left.length) return;
	if (isCard) {
		// Once per card text: the same card asked again passes.
		const dir = join(tmpdir(), 'ue-workstation-state-claim');
		const sid = String(p.session_id ?? 'x').replace(/[^\w-]/g, '');
		const mark = join(dir, `${sid}-${createHash('sha1').update(text).digest('hex').slice(0, 12)}`);
		if (existsSync(mark)) { log('the same card again: pass'); return; }
		try { mkdirSync(dir, { recursive: true }); writeFileSync(mark, ''); } catch { /* no mark: it bounces again, still passes on a check */ }
	}
	process.stderr.write(reason(left, isStop ? 'Your reply' : 'This question') + '\n');
	process.exit(2);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	try {
		main();
	} catch (e) {
		log(`internal error, passing (${e?.message ?? e})`);
	}
}
