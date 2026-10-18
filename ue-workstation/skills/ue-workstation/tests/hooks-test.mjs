// Fixture tests for the hooks in ../hooks — decision bugs no schema check can see. Offline and hermetic: temp git
// repositories, a synthetic process list (UE_WS_PROC_FIXTURE) in place of a live editor, a fake clang-format.
// Run: node tests/hooks-test.mjs   (or scripts\hooks-test.cmd). Non-zero exit on any mismatch.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitCalls, treeWriter } from '../hooks/no-tree-git-editor-open.mjs';
import { decide } from '../hooks/project-writes.mjs';
import { dropBodies, violation } from '../hooks/git-policy.mjs';
import { isProjectCpp } from '../hooks/format-after-edit.mjs';
import { GuiEditor, HeadlessEditor } from '../scripts/mjs/ue-proc.mjs';
import { classify } from '../hooks/editor-guard.mjs';
import { wire } from '../scripts/mjs/install-editor-guard.mjs';
import { staleModules } from '../hooks/session-state.mjs';
import { lintProject } from '../scripts/mjs/skill-lint.mjs';

const Hooks = join(dirname(dirname(fileURLToPath(import.meta.url))), 'hooks');
let pass = 0;
const fails = [];
const check = (got, want, label) => {
	if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${label}`); }
	else { fails.push(label); console.log(`  FAIL ${label} (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`); }
};

/** Run one hook with a payload (object or raw string); returns {code, stdout, stderr}. */
function runHook(name, payload, env = {}) {
	const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
	const r = spawnSync(process.execPath, [join(Hooks, name)], {
		input, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env },
	});
	return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const tmp = mkdtempSync(join(tmpdir(), 'uews-hooks-'));
// A git hook running this suite exports GIT_DIR & co.; the fixture repositories must not inherit them.
const gitEnv = { ...process.env };
for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_PREFIX']) delete gitEnv[k];
const git = (...args) => spawnSync('git', args, { encoding: 'utf8', windowsHide: true, env: gitEnv });
try {
	// ---- no-tree-git-editor-open: pure parser ------------------------------------------------------------------
	console.log('\n--- no-tree-git-editor-open: parser ---');
	const writers = (cmd) => gitCalls(cmd).map(treeWriter).filter(Boolean);
	check(writers('git pull --rebase'), ['pull'], 'pull');
	check(writers('git commit -m "no git pull; here"'), [], 'the words inside a quoted message are not a call');
	check(writers('git fetch && git pull'), ['pull'], 'a pull after another command');
	check(writers('& git -c core.x=y pull'), ['pull'], 'PowerShell call operator and -c option');
	check(writers('git status\ngit pull'), ['pull'], 'a multi-line command');
	check(writers('git reset HEAD~1'), [], 'a plain reset passes');
	check(writers('git reset --hard origin/main'), ['reset --hard'], 'reset --hard');
	check(writers('git stash'), ['stash'], 'a bare stash');
	check(writers('git stash list'), [], 'stash list passes');
	check(writers('git stash pop'), ['stash pop'], 'stash pop');
	check(writers('git restore --staged a.cpp'), [], 'restore --staged touches the index only');
	check(writers('git restore a.cpp'), ['restore'], 'restore of a file');
	check(writers('git submodule update --init'), ['submodule update'], 'submodule update');
	check(writers('git log --oneline -3; git diff --stat'), [], 'log and diff pass');
	check(writers('"C:\\Program Files\\Git\\cmd\\git.exe" checkout main'), ['checkout'], 'full path to git.exe');
	check(gitCalls('git -C "D:/My Proj" pull')[0]?.dir, 'D:/My Proj', '-C with a quoted path');
	check(writers('git checkout -b topic; git switch -c other'), [], 'a new branch at HEAD writes no file');
	check(writers('git checkout -b topic origin/main'), ['checkout'], 'a new branch from another start point rewrites the tree');
	check(writers('git switch -C topic main'), ['switch'], 'switch -C with a start point');

	// ---- no-tree-git-editor-open: end to end over temp repos ---------------------------------------------------
	console.log('\n--- no-tree-git-editor-open: end to end ---');
	const open = join(tmp, 'open'), closed = join(tmp, 'closed'), plugsrc = join(tmp, 'plugsrc');
	for (const d of [open, closed, plugsrc]) { mkdirSync(d, { recursive: true }); git('init', '-q', d); }
	git('-C', plugsrc, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
	git('-C', open, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', plugsrc, 'Plug');
	const fixture = join(tmp, 'procs.json');
	writeFileSync(fixture, JSON.stringify([
		{ image: GuiEditor, pid: 4242, cmd: `"C:\\UE\\Engine\\Binaries\\Win64\\${GuiEditor}" "${join(open, 'Fake.uproject')}"` },
		{ image: HeadlessEditor, pid: 4343, cmd: null },
	]));
	const headlessFixture = join(tmp, 'procs-headless.json');
	writeFileSync(headlessFixture, JSON.stringify([
		{ image: HeadlessEditor, pid: 5151, cmd: `${HeadlessEditor} ${join(open, 'Fake.uproject')} -unattended` },
	]));
	const ng = (cmd, cwd, env = { UE_WS_PROC_FIXTURE: fixture }) => {
		const r = runHook('no-tree-git-editor-open.mjs', { tool_input: { command: cmd }, cwd }, env);
		return r.code === 2 ? 'block' : r.code === 0 ? 'allow' : `exit ${r.code}`;
	};
	check(ng('git pull --rebase', open), 'block', 'pull in a project whose GUI editor is open');
	check(ng(`git -C "${open}" pull --ff-only`, closed), 'block', 'pull -C into that project');
	check(ng('git pull', closed), 'allow', 'pull in a project with no editor');
	check(ng('git status', open), 'allow', 'status passes');
	check(ng('git fetch origin', open), 'allow', 'fetch passes');
	check(ng('git status && git checkout main', open), 'block', 'a reader first, a writer after');
	check(ng(`git -C "${join(open, 'Plug')}" reset --hard`, closed), 'block', 'reset --hard in its submodule');
	check(ng('git reset --hard', open, { UE_WS_PROC_FIXTURE: headlessFixture }), 'block', 'a headless editor of the project blocks too');
	check(ng('git reset --hard', open, { UE_WS_PROC_FIXTURE: join(tmp, 'missing.json') }), 'allow', 'a failed process query fails open');
	check(ng('git pull', join(tmp, 'not-a-repo')), 'allow', 'not a repository fails open');
	check(runHook('no-tree-git-editor-open.mjs', 'not json').code, 0, 'an unreadable payload fails open');
	const msg = runHook('no-tree-git-editor-open.mjs', { tool_input: { command: 'git pull' }, cwd: open }, { UE_WS_PROC_FIXTURE: fixture }).stderr;
	check(/GUI editor pid 4242/.test(msg) && /ask them to close it/.test(msg), true, 'the refusal names the editor and the way out');

	// ---- git-policy ----------------------------------------------------------------------------------------------
	console.log('\n--- git-policy ---');
	const bad = (cmd) => gitCalls(dropBodies(cmd)).map(violation).filter(Boolean).length > 0;
	check(bad('git add Source/A.cpp Source/A.h'), false, 'add of named paths passes');
	check(bad('git add -A'), true, 'add -A');
	check(bad('git add .'), true, 'add .');
	check(bad('git add -- .'), true, 'add -- .');
	check(bad('git add -u'), true, 'add -u without paths');
	check(bad('git add -u Source/A.cpp'), false, 'add -u with a path passes');
	check(bad('git commit -F msg.txt -- Source/A.cpp'), false, 'commit -F with paths passes');
	check(bad('git commit -am "x"'), true, 'commit -am');
	check(bad('git commit --amend --no-edit'), true, 'commit --amend');
	check(bad('git commit -n -m x'), true, 'commit -n skips hooks');
	check(bad('git commit --no-verify -m x'), true, '--no-verify');
	check(bad('git push'), false, 'a plain push passes');
	check(bad('git push -n origin main'), false, 'push -n is a dry run, passes');
	check(bad('git push --force-with-lease'), true, 'force-with-lease');
	check(bad('git push -f origin main'), true, 'push -f');
	check(bad('git push origin +main'), true, '+refspec');
	check(bad('git push origin :old'), true, 'delete refspec');
	check(bad('git push --delete origin old'), true, 'push --delete');
	check(bad('git reset --hard HEAD'), true, 'reset --hard');
	check(bad('git reset HEAD~1'), false, 'a plain reset passes');
	check(bad('git clean -fd'), true, 'clean -fd');
	check(bad('git checkout -- .'), true, 'checkout of the whole tree');
	check(bad('git checkout main'), false, 'checkout of a branch passes');
	check(bad('git restore .'), true, 'restore .');
	check(bad('git restore Source/A.cpp'), false, 'restore of one file passes');
	check(bad('git branch -D topic'), true, 'branch -D');
	check(bad('git branch -d topic'), false, 'branch -d passes');
	check(bad('git stash clear'), true, 'stash clear');
	check(bad('git commit -F - <<EOF\nnever git add . here\nEOF'), false, 'a heredoc body is text, not a call');
	const gpol = (env) => runHook('git-policy.mjs', { tool_input: { command: 'git add -A' } }, env);
	check(gpol({ UE_WS_GIT_POLICY: '' }).code, 0, 'switched off without UE_WS_GIT_POLICY=1 (plugin default)');
	const on = gpol({ UE_WS_GIT_POLICY: '1' });
	check(on.code === 2 && /! <command>/.test(on.stderr), true, 'on: blocks with the way out');
	check(runHook('git-policy.mjs', 'not json', { UE_WS_GIT_POLICY: '1' }).code, 0, 'an unreadable payload fails open');

	// ---- format-after-edit ---------------------------------------------------------------------------------------
	console.log('\n--- format-after-edit ---');
	check(isProjectCpp('C:/P/Source/Game/A.cpp'), true, 'a project source');
	check(isProjectCpp('C:/P/Plugins/X/Source/X/Public/A.h'), true, 'a plugin source');
	check(isProjectCpp('C:/P/Intermediate/Source/A.cpp'), false, 'a generated tree is skipped');
	check(isProjectCpp('C:/P/Source/ThirdParty/lib/a.h'), false, 'vendored ThirdParty is skipped');
	check(isProjectCpp('C:/P/Source/Game/Game.Build.cs'), false, 'not C++');
	const src = join(tmp, 'proj', 'Source', 'X.cpp');
	mkdirSync(dirname(src), { recursive: true });
	const rewriting = join(tmp, 'fmt-rewrite.mjs'), noop = join(tmp, 'fmt-noop.mjs');
	writeFileSync(rewriting, "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv.at(-1), 'int main() {}\\n');\n");
	writeFileSync(noop, '// already formatted\n');
	writeFileSync(src, 'int  main(){}\n');
	let r = runHook('format-after-edit.mjs', { tool_input: { file_path: src } }, { UE_WS_CLANG_FORMAT: rewriting });
	check([r.code, /STALE/.test(r.stdout) && /"additionalContext"/.test(r.stdout)], [0, true], 'formatter rewrote the file -> notice as additionalContext');
	check(readFileSync(src, 'utf8'), 'int main() {}\n', 'and the file is formatted');
	r = runHook('format-after-edit.mjs', { tool_input: { file_path: src } }, { UE_WS_CLANG_FORMAT: noop });
	check([r.code, r.stdout], [0, ''], 'already formatted -> silent');
	r = runHook('format-after-edit.mjs', { tool_input: { file_path: src } }, { UE_WS_CLANG_FORMAT: join(tmp, 'no-such-formatter.exe') });
	check([r.code, r.stdout], [0, ''], 'no formatter -> fails open, silent');
	const argsLog = join(tmp, 'fmt-args.txt'), recording = join(tmp, 'fmt-record.mjs');
	writeFileSync(recording, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)));
`);
	runHook('format-after-edit.mjs', { tool_input: { file_path: src } }, { UE_WS_CLANG_FORMAT: recording });
	check(JSON.parse(readFileSync(argsLog, 'utf8')).includes('--fallback-style=none'), true, 'no .clang-format -> no LLVM fallback (--fallback-style=none)');

	// ---- project-writes ------------------------------------------------------------------------------------------
	console.log('\n--- project-writes ---');
	const ctx = { project: 'C:\\Projects\\Game', configDir: 'C:/Users/me/.claude', extraRoots: ['F:/Library'] };
	check(decide('C:\\Projects\\Game\\Source\\A.cpp', ctx), 'allow', 'inside the project');
	check(decide('Docs/probe.md', ctx), 'allow', 'a relative path inside the project');
	check(decide('C:/Windows/Temp/x.md', ctx), 'ask', 'outside the project asks');
	check(decide('C:/Projects/Game/../Other/x.md', ctx), 'ask', 'a ..-escape asks');
	check(decide('C:/Projects/Game2/x.md', ctx), 'ask', 'a sibling whose name extends the project asks');
	check(decide('C:/Projects/Game/Binaries/Win64/x.dll', ctx), null, 'a generated tree gets no decision');
	check(decide('/c/Users/me/.claude/skills/x/SKILL.md', ctx), 'allow', 'the Claude config dir (msys spelling)');
	check(decide('C:/Users/me/AppData/Local/Temp/claude/abc/scratch.txt', ctx), 'allow', 'an agent scratch folder');
	check(decide('F:/Library/Pack/readme.txt', ctx), 'allow', 'an extra root from UE_WS_WRITE_ROOTS');
	const pw = (file, event) => runHook('project-writes.mjs', { hook_event_name: event, tool_input: { file_path: file } },
		{ CLAUDE_PROJECT_DIR: 'C:\\Projects\\Game', UE_WS_WRITE_ROOTS: '', UE_WS_PROJECT_WRITES: '1' }).stdout;
	const pwOff = runHook('project-writes.mjs', { hook_event_name: 'PreToolUse', tool_input: { file_path: 'C:/Projects/Game/a.txt' } },
		{ CLAUDE_PROJECT_DIR: 'C:\\Projects\\Game', UE_WS_PROJECT_WRITES: '' }).stdout;
	check(pwOff, '', 'switched off without UE_WS_PROJECT_WRITES=1 (plugin default)');
	check(/"permissionDecision":"allow"/.test(pw('C:/Projects/Game/a.txt', 'PreToolUse')), true, 'PreToolUse allow JSON');
	check(/"permissionDecision":"ask"/.test(pw('C:/Elsewhere/a.txt', 'PreToolUse')), true, 'PreToolUse ask JSON');
	check(/"behavior":"allow"/.test(pw('C:/Projects/Game/.claude/settings.json', 'PermissionRequest')), true, 'PermissionRequest allow inside .claude');
	check(pw('C:/Elsewhere/a.txt', 'PermissionRequest'), '', 'PermissionRequest outside says nothing (the dialog shows)');

	// ---- subagent-engine-root ------------------------------------------------------------------------------------
	console.log('\n--- subagent-engine-root ---');
	const fakeEngine = join(tmp, 'UE_9.9');
	mkdirSync(join(fakeEngine, 'Engine', 'Build'), { recursive: true });
	writeFileSync(join(fakeEngine, 'Engine', 'Build', 'Build.version'), JSON.stringify({ MajorVersion: 9, MinorVersion: 9, PatchVersion: 1 }));
	const proj = join(tmp, 'proj');
	writeFileSync(join(proj, 'Proj.uproject'), JSON.stringify({ EngineAssociation: '9.9' }));
	r = runHook('subagent-engine-root.mjs', { hook_event_name: 'SubagentStart' }, { CLAUDE_PROJECT_DIR: proj, UNREAL_HOME: fakeEngine });
	check(/Unreal Engine 9\.9\.1 root on this machine/.test(r.stdout) && r.stdout.includes('Proj.uproject'), true, 'the engine root and the project reach the subagent');
	r = runHook('subagent-engine-root.mjs', { hook_event_name: 'SubagentStart' }, { CLAUDE_PROJECT_DIR: proj, UNREAL_HOME: '', UE_VERSION: '0.1' });
	check([r.code, r.stdout], [0, ''], 'no engine found -> silent');

	// ---- fork-context-guard --------------------------------------------------------------------------------------
	console.log('\n--- fork-context-guard ---');
	const turn = (tokens, extra = {}) => JSON.stringify({ type: 'assistant', ...extra,
		message: { usage: { input_tokens: 2, cache_read_input_tokens: tokens - 2, cache_creation_input_tokens: 0 } } });
	const transcript = (lines) => { const p = join(tmp, `t${Math.random().toString(36).slice(2)}.jsonl`); writeFileSync(p, lines.join('\n') + '\n'); return p; };
	const fork = (path, type = 'fork') => ({ tool_name: 'Agent', tool_input: { subagent_type: type, prompt: 'x' }, transcript_path: path });
	const big = transcript(['{"cut line', turn(50000), turn(200000), turn(900000, { isSidechain: true })]);
	r = runHook('fork-context-guard.mjs', fork(big));
	check([r.code, /200k tokens/.test(r.stderr)], [2, true], 'a fork from a 200k context is refused (the sidechain turn is ignored)');
	r = runHook('fork-context-guard.mjs', fork(transcript([turn(200000), turn(90000)])));
	check(r.code, 0, 'a fork from a 90k context passes');
	r = runHook('fork-context-guard.mjs', fork(big, 'general-purpose'));
	check(r.code, 0, 'a fresh agent passes whatever the context');
	r = runHook('fork-context-guard.mjs', fork(big), { UE_WS_FORK_MAX_CONTEXT: '0' });
	check(r.code, 0, 'UE_WS_FORK_MAX_CONTEXT=0 turns the guard off');
	r = runHook('fork-context-guard.mjs', fork(big), { UE_WS_FORK_MAX_CONTEXT: '300000' });
	check(r.code, 0, 'a raised limit lets the fork through');
	r = runHook('fork-context-guard.mjs', fork(join(tmp, 'missing.jsonl')));
	check(r.code, 0, 'no transcript -> fail open');

	// ---- editor-guard: parser ------------------------------------------------------------------------------------
	console.log('\n--- editor-guard: parser ---');
	const cls = (c) => classify(c);
	check(cls('taskkill /F /IM UnrealEditor.exe').killByImage, true, 'taskkill /im is a kill by image');
	check(cls('Stop-Process -Name UnrealEditor -Force').killByImage, true, 'Stop-Process -Name');
	check(cls('Get-Process UnrealEditor | ForEach-Object { $_.CloseMainWindow() }').killByImage, true, 'CloseMainWindow over every editor');
	check(cls('Get-Process UnrealEditor | Select Id, StartTime').killByImage, false, 'listing editors is not a kill');
	check(cls('$p = Get-Process UnrealEditor; $p.Kill()').killByImage, true, 'a variable holding every editor, then Kill()');
	check(cls('Get-CimInstance Win32_Process -Filter "Name=\'UnrealEditor.exe\'" | Invoke-CimMethod -MethodName Terminate').killByImage, true, 'CIM Terminate over every editor');
	check(cls('echo "taskkill /IM UnrealEditor.exe"').killByImage, false, 'a quoted mention is not a kill');
	check(cls('sed -i s/a/b/ ue-editor-kill-restore-dialog.md  # the UnrealEditor note').killByImage, false, 'a file name with "kill" next to the editor name is not a kill');
	check(cls("python - <<'EOF'\ndoc = '''\ntaskkill /IM UnrealEditor.exe\n'''\nEOF\necho done").killByImage, false, 'a heredoc body is data, not a command');
	check(cls("$t = @'\nStop-Process -Name UnrealEditor\n'@\nSet-Content a.md $t").killByImage, false, 'a here-string body is data');
	check(cls("cat <<'EOF' > a.txt\nx\nEOF\ntaskkill /IM UnrealEditor.exe").killByImage, true, 'a kill after a heredoc still counts');
	check(cls('taskkill /PID 1234 /F').killPids, [1234], 'taskkill /pid');
	check(cls('Stop-Process -Id 1234,5678').killPids, [1234, 5678], 'Stop-Process -Id list');
	check(cls('(Get-Process -Id 4321).CloseMainWindow()').killPids, [4321], 'CloseMainWindow by pid');
	check(cls('kill 999').killPids, [999], 'bash kill');
	check(!!cls(String.raw`& "C:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\UnrealEditor.exe" "C:\p\G\G.uproject"`).launch, true, 'a quoted editor path with spaces is a launch');
	check(cls(String.raw`Start-Process "C:\UE\UnrealEditor.exe" -ArgumentList '"C:\p\X.uproject"'`).launch?.uproject, String.raw`C:\p\X.uproject`, 'Start-Process launch names its project');
	check(cls('grep -n UnrealEditor.exe Saved/Logs/G.log').launch, null, 'a grep for the editor name is not a launch');
	check(cls(String.raw`"C:\UE\Build.bat" GEditor Win64 Development -Project=x`).build, { editorTarget: true }, 'an editor target build');
	check(cls(String.raw`"C:\UE\Build.bat" G Win64 Shipping`).build, { editorTarget: false }, 'a game target build');
	check(cls('cmd /c Utils\\increment-compile.cmd').build, { editorTarget: true }, 'a project compile script counts as an editor build');
	check(cls('git status').build, null, 'git status is nothing');

	// ---- editor-guard: end to end over a synthetic process table -------------------------------------------------
	console.log('\n--- editor-guard: end to end ---');
	const gp = join(tmp, 'gproj'), other = join(tmp, 'other'), free = join(tmp, 'free');
	for (const [d, n] of [[gp, 'G'], [other, 'O'], [free, 'F']]) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, `${n}.uproject`), '{}'); }
	writeFileSync(join(gp, '.mcp.json'), JSON.stringify({ mcpServers: { 'unreal-mcp': { type: 'http', url: 'http://127.0.0.1:18777/mcp' } } }));
	const ft = (ms) => (ms + 11644473600000) * 10000;
	const guardFixture = (listeners) => {
		const f = join(tmp, `procs-${Object.values(listeners).join('-') || 'none'}.json`);
		writeFileSync(f, JSON.stringify({
			processes: [
				{ p: 1, q: 0, n: 'explorer.exe', c: 'explorer', s: ft(1e12) },
				{ p: 77, q: 1, n: 'notepad.exe', c: 'notepad', s: ft(1e12 + 1) },
				{ p: 501, q: 1, n: 'UnrealEditor.exe', c: `"C:\\UE\\UnrealEditor.exe" "${join(gp, 'G.uproject')}"`, s: ft(1e12 + 2) },
				{ p: 502, q: 1, n: 'UnrealEditor.exe', c: `"C:\\UE\\UnrealEditor.exe" "${join(other, 'O.uproject')}"`, s: ft(1e12 + 3) },
			],
			listeners,
		}));
		return { UE_OWNER_FIXTURE: f };
	};
	const env0 = guardFixture({});
	const pre = (command, cwd = gp, env = env0) => runHook('editor-guard.mjs', { hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_use_id: 't1', cwd, tool_input: { command } }, env);
	check(pre('taskkill /F /IM UnrealEditor.exe').code, 2, 'kill by image -> blocked');
	check(pre('Stop-Process -Id 501').code, 2, 'stopping a person\'s editor by pid -> blocked');
	check(pre('Stop-Process -Id 77').code, 0, 'stopping a non-editor pid passes');
	check(pre(`& "C:\\UE\\UnrealEditor.exe" "${join(gp, 'G.uproject')}"`).code, 2, 'a second editor of the same project -> blocked');
	check(pre(`& "C:\\UE\\UnrealEditor.exe" "${join(free, 'F.uproject')}"`, free).code, 2, 'another project\'s person editor runs -> launch waits');
	check(pre(`& "C:\\UE\\UnrealEditor.exe" "${join(free, 'F.uproject')}" --alongside`, free).code, 0, '--alongside when the person allowed it');
	check(pre('"C:\\UE\\Build.bat" GEditor Win64 Development').code, 2, 'editor build while the project\'s editor runs -> blocked');
	check(pre('"C:\\UE\\Build.bat" FEditor Win64 Development', free).code, 0, 'editor build of a project without an editor passes');
	check(pre('git status').code, 0, 'an unrelated command passes');
	rmSync(join(tmpdir(), 'ue-editor-guard', 'port-18777.json'), { force: true });
	const mcp = (env) => runHook('editor-guard.mjs', { hook_event_name: 'PreToolUse', tool_name: 'mcp__unreal-mcp__call_tool', cwd: gp, tool_input: {} }, env);
	check(mcp(guardFixture({ 18777: 502 })).code, 2, 'MCP port answered by another project\'s editor -> blocked');
	rmSync(join(tmpdir(), 'ue-editor-guard', 'port-18777.json'), { force: true });
	check(mcp(guardFixture({ 18777: 501 })).code, 0, 'MCP port answered by this project\'s editor passes');
	rmSync(join(tmpdir(), 'ue-editor-guard', 'port-18777.json'), { force: true });
	const toolset = runHook('editor-guard.mjs', { hook_event_name: 'PreToolUse', tool_name: 'mcp__unreal-mcp__call_tool', cwd: gp, tool_input: {} }, guardFixture({ 18777: 501 }));
	check([toolset.code, /"permissionDecision"/.test(toolset.stdout)], [0, false], 'a toolset call into a person\'s editor of this project is not asked about');
	rmSync(join(tmpdir(), 'ue-editor-guard', 'port-18777.json'), { force: true });
	r = runHook('editor-guard.mjs', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'never-seen', cwd: gp, tool_input: { command: 'ls' } }, env0);
	check([r.code, r.stdout], [0, ''], 'PostToolUse without a PreToolUse record is silent');

	// ---- install-editor-guard ------------------------------------------------------------------------------------
	console.log('\n--- install-editor-guard ---');
	const base = { model: 'x', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node other.mjs' }] }] } };
	const once = wire(base, { hookPath: 'C:/k/hooks/editor-guard.mjs' });
	check(once.changes.length, 2, 'install adds Pre and Post');
	check(once.settings.hooks.PreToolUse.length, 2, 'the foreign hook stays');
	check(wire(once.settings, { hookPath: 'C:/k/hooks/editor-guard.mjs' }).changes.length, 0, 'a second install changes nothing');
	const old = structuredClone(once.settings);
	old.hooks.PostToolUse[0].matcher = 'Bash|PowerShell';
	check(wire(old, { hookPath: 'C:/k/hooks/editor-guard.mjs' }).changes, ['PostToolUse: matcher Bash|PowerShell -> Bash|PowerShell|mcp__.*unreal.*'], 'an older wiring gets the new matcher');
	const gone = wire(once.settings, { uninstall: true });
	check([gone.settings.hooks.PreToolUse.length, gone.settings.hooks.PostToolUse], [1, undefined], 'uninstall removes only the guard');

	// ---- session-state ---------------------------------------------------------------------------------------------
	console.log('\n--- session-state ---');
	const sp = join(tmp, 'StateGame');
	const touch = (rel, ms) => {
		mkdirSync(dirname(join(sp, rel)), { recursive: true });
		writeFileSync(join(sp, rel), '');
		if (ms) utimesSync(join(sp, rel), ms / 1000, ms / 1000);
	};
	const t0 = Date.now() - 3600_000;
	touch('StateGame.uproject');
	touch('Source/Built/A.cpp', t0);
	touch('Binaries/Win64/UnrealEditor-Built.dll', t0 + 60_000);
	touch('Source/Stale/B.cpp', t0 + 120_000);
	touch('Binaries/Win64/UnrealEditor-Stale.dll', t0);
	touch('Plugins/Kit/Kit.uplugin');
	touch('Plugins/Kit/Source/KitRuntime/C.h', t0);
	check(staleModules(sp).map((s) => [s.module, s.built > 0]).sort(), [['KitRuntime', false], ['Stale', true]], 'stale and never-built modules found, the built one not');
	const dp = join(tmp, 'DescGame');
	const putDesc = (rel, body, ms) => {
		mkdirSync(dirname(join(dp, rel)), { recursive: true });
		writeFileSync(join(dp, rel), body ?? '');
		if (ms) utimesSync(join(dp, rel), ms / 1000, ms / 1000);
	};
	putDesc('DescGame.uproject', JSON.stringify({ Modules: [{ Name: 'Game', Type: 'Runtime' }], Plugins: [{ Name: 'Off', Enabled: false }] }));
	putDesc('Source/Game/A.cpp', '', t0);
	putDesc('Source/Undeclared/B.cpp', '', t0);
	putDesc('Plugins/Audio/Audio.uplugin', '﻿' + JSON.stringify({ Modules: [
		{ Name: 'AudioCore', Type: 'Runtime' },
		{ Name: 'AudioMac', Type: 'Runtime', PlatformAllowList: ['Mac'] },
		{ Name: 'AudioTool', Type: 'Program' },
	] }));
	for (const m of ['AudioCore', 'AudioMac', 'AudioTool', 'AudioLink']) putDesc(`Plugins/Audio/Source/${m}/X.cpp`, '', t0);
	putDesc('Plugins/Off/Off.uplugin', JSON.stringify({ Modules: [{ Name: 'OffRuntime', Type: 'Runtime' }] }));
	putDesc('Plugins/Off/Source/OffRuntime/Y.cpp', '', t0);
	putDesc('Plugins/Opt/Opt.uplugin', JSON.stringify({ EnabledByDefault: false, Modules: [{ Name: 'OptRuntime', Type: 'Runtime' }] }));
	putDesc('Plugins/Opt/Source/OptRuntime/Z.cpp', '', t0);
	check(staleModules(dp).map((s) => s.module).sort(), ['AudioCore', 'Game'], 'only modules the descriptors build: undeclared, other-platform, Program and disabled plugins skipped');
	const noProcs = join(tmp, 'no-procs.json');
	writeFileSync(noProcs, JSON.stringify({ processes: [] }));
	r = runHook('session-state.mjs', { hook_event_name: 'SessionStart', cwd: sp }, { UE_OWNER_FIXTURE: noProcs, CLAUDE_PROJECT_DIR: '' });
	const stateCtx = JSON.parse(r.stdout || '{}').hookSpecificOutput?.additionalContext ?? '';
	check([/none of this project running/.test(stateCtx), /Stale is stale/.test(stateCtx), /KitRuntime is stale \(never built/.test(stateCtx)], [true, true, true], 'context: editor, stale and never-built modules');
	r = runHook('session-state.mjs', { hook_event_name: 'SessionStart', cwd: tmp }, { CLAUDE_PROJECT_DIR: '' });
	check([r.code, r.stdout], [0, ''], 'silent outside an Unreal project');
	r = runHook('session-state.mjs', { hook_event_name: 'SessionStart', cwd: sp }, { UE_WS_SESSION_STATE: '0' });
	check(r.stdout, '', 'UE_WS_SESSION_STATE=0 turns it off');

	// ---- skill-lint ------------------------------------------------------------------------------------------------
	console.log('\n--- skill-lint ---');
	const lp = join(tmp, 'LintGame');
	const put = (rel, text) => {
		mkdirSync(dirname(join(lp, rel)), { recursive: true });
		writeFileSync(join(lp, rel), text);
	};
	put('.claude/skill-lint.json', JSON.stringify({
		skillsDir: '.agents/skills', instructions: '.agents/AGENTS.md', listSection: 'Skills Usage', countPattern: 'all (\\d+) skills',
		pathRoots: ['Utils', 'Docs'], skillNamePattern: 'zz-[a-z0-9-]+', notSkills: ['zz-build'], optionalPaths: ['Docs/later'],
		retired: { 'old-tool.cmd': 'removed' },
	}));
	put('Utils/real.py', '');
	put('Docs/real.md', '');
	put('.agents/skills/zz-good/SKILL.md', '---\nname: zz-good\ndescription: fine\n---\nRun `Utils/real.py`, see Docs/real.md, Docs/later/x.md and `zz-build`.\n');
	put('.agents/skills/zz-bad/SKILL.md', '---\nname: zz-wrong\ndescription: x\n---\nRun Utils/gone.py and ghost.cmd, old-tool.cmd, skill `zz-missing`, mcp__nosrv__do.\n');
	put('.agents/AGENTS.md', '# A\n\n## Skills Usage\n- **zz-good**: x\n- **zz-gone**: y\n\nCovers all 3 skills.\n\n## Next\n');
	const lint = lintProject(lp).problems.map((p) => p.slice(1, 4)).sort();
	check(lint, ['FRM', 'LST', 'LST', 'LST', 'MCP', 'PTH', 'RET', 'SCR', 'SCR', 'SKL'], 'every kind of broken reference is reported, the good skill is clean');
	r = runHook('skill-lint-after-edit.mjs', { tool_input: { file_path: join(lp, '.agents/skills/zz-good/SKILL.md') } });
	check([r.code, /\[PTH\].*gone\.py/.test(r.stderr)], [2, true], 'an edit of a skill runs the linter and returns its problems');
	r = runHook('skill-lint-after-edit.mjs', { tool_input: { file_path: join(lp, 'Docs/real.md') } });
	check(r.code, 0, 'an edit outside the skills and the instructions is not linted');
	r = runHook('skill-lint-after-edit.mjs', { tool_input: { file_path: join(tmp, 'StateGame', 'notes.md') } });
	check(r.code, 0, 'silent in a project without .claude/skill-lint.json');
} finally {
	rmSync(tmp, { recursive: true, force: true });
}

console.log(fails.length ? `\nhooks-test: ${pass} passed, ${fails.length} FAILED` : `\nhooks-test: ${pass} passed, 0 failed`);
process.exit(fails.length ? 1 : 0);
