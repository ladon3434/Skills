#!/usr/bin/env node
// review-voices — find the external reviewer CLIs on this machine (agy, codex) and run one brief through
// every voice found, in parallel, read-only, each bounded in time. The third voice, fable (the code-analysis:reviewer
// agent on Claude Fable), is an Agent call the caller makes alongside; with no external voice it reviews alone.
// See references/external-voices.md.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HELP = `review-voices — the external review voices (agy = Gemini, codex = OpenAI), read-only;
the third voice, fable (code-analysis:reviewer agent), is dispatched by Claude alongside

  review-voices list
      which voices are on this machine, the binary and the model each would run
  review-voices run --brief <file> --subject <dir> [--out <dir>] [--only agy,codex] [--timeout-min 15] [--dry-run]
      run the brief through every voice found, in parallel; reports in <out>/<voice>.md (+ .err)

The brief and any file it names (diff.patch) live in the brief's folder; the voices are pointed at that folder and
the subject (agy can read nothing else; codex is sandboxed against writes, not reads). --out (default: a new temp folder) must lie outside both.

Last line: RESULT: voices <voice>=<OK|PARTIAL|EMPTY|FAILED|TIMEOUT|ABSENT> ... untouched=<OK|CHANGED|UNCHECKED>
Exit: 0 at least one report, 1 every voice failed, 2 usage error, 3 no voice on the machine
      (fable reviews alone), 4 the subject changed during the run.
Bound it from outside with the cap plus a margin: timeout <(timeout-min + 3) * 60> review-voices run ...

Environment:
  AGY_EXE, CODEX_EXE           explicit binaries (else PATH, then the usual install folders); set but missing — an error
  UE_REVIEW_AGY_MODEL          agy model (else the first non-Flash gemini-*-high that 'agy models' lists)
  UE_REVIEW_CODEX_MODEL        codex model (else codex's own default from ~/.codex/config.toml)
  UE_REVIEW_VOICES             agy,codex | agy | codex | none — which voices may run at all`;

const VOICES = ['agy', 'codex'];
const FABLE = 'code-analysis:reviewer agent (Claude Fable)';
const GUARD = 'READ-ONLY REVIEW. Do not create, edit, move or delete any file, do not run commands that change ' +
  'anything, do not install anything. Print the whole report to stdout.';
const isWin = process.platform === 'win32';
const live = new Set();

function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

function onPath(names) {
  for (const d of (process.env.PATH || '').split(path.delimiter).filter(Boolean))
    for (const n of names) { const p = path.join(d, n); if (isFile(p)) return p; }
  return null;
}

// A Windows .cmd cannot be spawned without a shell, and a shell would re-parse the prompt. An npm shim runs a
// node script: run that script with this node instead. Anything else is refused with a note.
function resolveLaunch(exe) {
  if (!/\.(cmd|bat)$/i.test(exe)) return { exe, pre: [] };
  const text = fs.readFileSync(exe, 'utf8');
  const m = text.match(/"%(?:~)?dp0%?\\?([^"]+?\.(?:c|m)?js)"/i);
  const js = m && path.join(path.dirname(exe), m[1]);
  if (js && isFile(js)) return { exe: process.execPath, pre: [js] };
  return { error: `${exe} is a shell shim with no node entry script; point the *_EXE variable at the real .exe` };
}

function locate(name, envVar, candidates) {
  const forced = process.env[envVar];
  if (forced) {
    const abs = path.resolve(forced);
    return isFile(abs) ? { path: abs } : { error: `${envVar} is set but not a file: ${abs}` };
  }
  const found = candidates();
  return found ? { path: path.resolve(found) } : { error: 'not found' };
}

function findAgy() {
  return locate('agy', 'AGY_EXE', () => onPath(isWin ? ['agy.exe', 'agy.cmd'] : ['agy']) ||
    (isWin && isFile(path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe'))
      ? path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe') : null));
}

function findCodex() {
  return locate('codex', 'CODEX_EXE', () => {
    const direct = onPath(isWin ? ['codex.exe', 'codex.cmd'] : ['codex']);
    if (direct || !isWin) return direct;
    // The Codex desktop app (Microsoft Store) ships the CLI inside its package; WindowsApps cannot be listed,
    // so ask Appx for the install folder. The folder name carries the version and moves on every update.
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-AppxPackage OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation'],
      { encoding: 'utf8', timeout: 20000, windowsHide: true });
    const loc = (r.stdout || '').trim();
    const exe = loc && path.join(loc, 'app', 'resources', 'codex.exe');
    return exe && isFile(exe) ? exe : null;
  });
}

// Never claude-* (the caller's own vendor) and never gpt-oss-* (failed a known-answer review); Flash is weak.
function classifyAgyModel(id, source) {
  if (/^claude-/i.test(id)) return { model: null, note: `${id} from ${source} is the caller's own vendor — not a voice` };
  if (/^gpt-oss/i.test(id)) return { model: null, note: `${id} from ${source} is not accepted as a review voice` };
  if (/flash/i.test(id)) return { model: id, note: `WEAK: ${id} (${source}) is Flash — evidence, never the deciding verdict` };
  return { model: id, note: source };
}

function agyModel(launch) {
  if (process.env.UE_REVIEW_AGY_MODEL) return classifyAgyModel(process.env.UE_REVIEW_AGY_MODEL, 'UE_REVIEW_AGY_MODEL');
  const r = spawnSync(launch.exe, [...launch.pre, 'models'],
    { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  if (r.error) return { model: null, note: `'agy models' failed: ${r.error.code || r.error.message}` };
  const ids = (r.stdout || '').split(/\r?\n/).map(l => l.trim().split(/\s+/)[0]).filter(Boolean);
  const strong = ids.find(id => /^gemini-/.test(id) && /-high$/.test(id) && !/flash/.test(id));
  if (strong) return classifyAgyModel(strong, `first non-Flash gemini-*-high in 'agy models'`);
  const flash = ids.find(id => /^gemini-/.test(id) && /-high$/.test(id));
  if (flash) return classifyAgyModel(flash, `only Flash in 'agy models'`);
  return { model: null, note: `no Gemini model in 'agy models' (exit ${r.status})` };
}

function voiceSet(spec, what) {
  const names = spec.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const bad = names.filter(n => !VOICES.includes(n));
  if (bad.length) throw new UsageError(`${what}: unknown voice ${bad.join(', ')} (known: ${VOICES.join(', ')}, or none)`);
  return new Set(names);
}

class UsageError extends Error {}

function detect(only) {
  const env = (process.env.UE_REVIEW_VOICES || 'agy,codex').trim().toLowerCase();
  const allow = env === 'none' ? new Set() : voiceSet(env, 'UE_REVIEW_VOICES');
  const voices = [];
  for (const name of VOICES) {
    if (!allow.has(name) || (only && !only.has(name))) continue;
    const loc = name === 'agy' ? findAgy() : findCodex();
    if (loc.error) { voices.push({ name, note: loc.error }); continue; }
    const launch = resolveLaunch(loc.path);
    if (launch.error) { voices.push({ name, path: loc.path, note: launch.error }); continue; }
    if (name === 'agy') voices.push({ name, path: loc.path, launch, ...agyModel(launch) });
    else {
      const model = process.env.UE_REVIEW_CODEX_MODEL || null;
      voices.push({ name, path: loc.path, launch, model, note: model ? 'UE_REVIEW_CODEX_MODEL' : 'codex default model' });
    }
  }
  for (const v of voices) v.ready = !!v.launch && (v.name !== 'agy' || !!v.model);
  return voices;
}

function label(v) { return v.model ? `${v.name}/${v.model}` : v.name; }

function parseArgs(argv) {
  const a = { cmd: argv[0], timeoutMin: 15 };
  for (let i = 1; i < argv.length; i++) {
    const k = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new UsageError(`${k} needs a value`); return argv[++i]; };
    if (k === '--brief') a.brief = val();
    else if (k === '--subject') a.subject = val();
    else if (k === '--out') a.out = val();
    else if (k === '--only') a.only = voiceSet(val(), '--only');
    else if (k === '--timeout-min') a.timeoutMin = Number(val());
    else if (k === '--dry-run') a.dry = true;
    else if (k === '--help' || k === '-h') a.cmd = 'help';
    else throw new UsageError(`unknown argument: ${k}`);
  }
  return a;
}

function real(p) { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } }

function inside(child, parent) {
  const rel = path.relative(real(parent), real(child));
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
}

// What a write into the subject would change: tracked content against HEAD, and every untracked file's size and
// mtime. Ignored files are not covered. --no-optional-locks: never take index.lock next to an editor or a commit.
function fingerprint(dir) {
  const git = args => spawnSync('git', ['--no-optional-locks', '-C', dir, ...args],
    { encoding: 'buffer', timeout: 120000, maxBuffer: 1 << 30, windowsHide: true });
  const top = git(['rev-parse', '--show-toplevel']);
  if (top.status !== 0) return { state: 'not-git' };
  const diff = git(['diff', 'HEAD', '--binary']);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']);
  if (diff.status !== 0 || untracked.status !== 0) return { state: 'failed' };
  const h = crypto.createHash('sha256').update(diff.stdout);
  for (const f of untracked.stdout.toString('utf8').split('\0').filter(Boolean)) {
    let st = null; try { st = fs.statSync(path.join(dir, f)); } catch {}
    h.update(`\0${f}\0${st ? `${st.size}:${st.mtimeMs}` : 'gone'}`);
  }
  return { state: 'ok', hash: h.digest('hex') };
}

function killTree(child) {
  if (!child.pid) return;
  if (isWin) spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', timeout: 15000, windowsHide: true });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }
}

function killAll() { for (const c of live) killTree(c); live.clear(); }

function agySettings(a) {
  // Headless agy auto-allows reads AND writes inside its workspace and soft-denies everything it would ask about.
  // Deny beats allow: grant reads of the subject and the brief folder only, deny every writing or executing action.
  return JSON.stringify({ permissions: {
    allow: [`read_file(${a.subject})`, `read_file(${a.briefDir})`],
    deny: ['write_file(*)', 'command(*)', 'unsandboxed(*)', 'execute_url(*)', 'read_url(*)', 'mcp(*)'],
  } });
}

function commandFor(v, a) {
  const cwd = path.join(a.out, v.name);
  if (v.name === 'agy') {
    const secs = Math.max(30, Math.round(a.timeoutMin * 60) - 30);
    const prompt = `${GUARD}\n\nThe review brief is the file ${a.brief}. Read it and follow it exactly. Files it names ` +
      `are in ${a.briefDir} or in the subject ${a.subject}.`;
    return { cwd, stdin: null, args: [...v.launch.pre, '--model', v.model, '--add-dir', a.subject, '--add-dir', a.briefDir,
      '--settings', agySettings(a), '--print-timeout', `${secs}s`, '-p', prompt] };
  }
  const args = [...v.launch.pre, 'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', a.subject,
    '-c', 'model_reasoning_effort="high"'];
  if (v.model) args.push('-m', v.model);
  args.push('-');
  return { cwd, args, stdin: `${GUARD}\n\n${a.briefText}` };
}

const DENIAL = /auto-denied|permission denied|soft-denied/i;

function runOne(v, a) {
  return new Promise(resolve => {
    const { args, cwd, stdin } = commandFor(v, a);
    fs.mkdirSync(cwd, { recursive: true });
    const outFile = path.join(a.out, `${v.name}.md`), errFile = path.join(a.out, `${v.name}.err`);
    const out = fs.openSync(outFile, 'wx'), err = fs.openSync(errFile, 'wx');
    const t0 = Date.now();
    let settled = false, timedOut = false, child = null, timer = null, grace = null;
    const finish = (code, extra) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(grace); if (child) live.delete(child);
      if (extra) fs.writeSync(err, `\n${extra}\n`);
      fs.closeSync(out); fs.closeSync(err);
      const size = fs.statSync(outFile).size, secs = Math.round((Date.now() - t0) / 1000);
      const denied = DENIAL.test(fs.readFileSync(errFile, 'utf8'));
      const status = timedOut ? 'TIMEOUT' : code !== 0 ? 'FAILED' : size === 0 ? 'EMPTY' : denied ? 'PARTIAL' : 'OK';
      resolve({ ...v, status, code, size, secs, outFile, errFile, denied });
    };
    try {
      child = spawn(v.launch.exe, args, { cwd, stdio: [stdin == null ? 'ignore' : 'pipe', out, err],
        windowsHide: true, detached: !isWin });
    } catch (e) { finish(-1, `spawn failed: ${e.code || e.message}`); return; }
    live.add(child);
    if (stdin != null) { child.stdin.on('error', () => {}); child.stdin.end(stdin); }
    timer = setTimeout(() => {
      timedOut = true; killTree(child);
      grace = setTimeout(() => finish(-1, 'killed at the cap, exit not confirmed within 20 s'), 20000);
    }, a.timeoutMin * 60000);
    child.on('error', e => finish(-1, `spawn failed: ${e.code || e.message}`));
    child.on('close', code => finish(code));
  });
}

function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.cmd || a.cmd === 'help' || a.cmd === '--help' || a.cmd === '-h') { console.log(HELP); return 0; }

  if (a.cmd === 'list') {
    const voices = detect(null);
    for (const v of voices) console.log(`${v.name.padEnd(6)} ${v.ready ? label(v) : 'ABSENT'}  ${v.path || ''}  (${v.note})`);
    console.log(`fable  ${FABLE}  (Claude dispatches it in the same message; not run by this script)`);
    const ready = voices.filter(v => v.ready);
    console.log(`RESULT: voices ${ready.map(label).concat('fable').join(' ')}${ready.length ? '' : ' (no external voice — fable alone)'}`);
    return ready.length ? 0 : 3;
  }
  if (a.cmd !== 'run') throw new UsageError(`unknown command: ${a.cmd}`);

  if (!a.brief || !a.subject) throw new UsageError('run needs --brief <file> and --subject <dir>');
  if (!Number.isFinite(a.timeoutMin) || a.timeoutMin <= 0 || a.timeoutMin > 120)
    throw new UsageError('--timeout-min must be a number in (0, 120]');
  a.subject = real(a.subject);
  a.brief = real(a.brief);
  if (!fs.existsSync(a.subject)) throw new UsageError(`subject not found: ${a.subject}`);
  if (!isFile(a.brief)) throw new UsageError(`brief not found: ${a.brief}`);
  a.briefDir = path.dirname(a.brief);
  a.briefText = fs.readFileSync(a.brief, 'utf8');
  if (a.briefText.trim() === '') throw new UsageError('the brief is empty');
  if (inside(a.briefDir, a.subject)) throw new UsageError('the brief folder must be outside --subject (reports and diffs would show as changes)');
  a.out = path.resolve(a.out || path.join(os.tmpdir(), 'ue-review-voices', stamp()));
  if (inside(a.out, a.subject) || inside(a.out, a.briefDir))
    throw new UsageError('--out must be outside --subject and outside the brief folder: the voices may read those');

  const voices = detect(a.only);
  const ready = voices.filter(v => v.ready);
  for (const v of voices) if (!v.ready) console.log(`${v.name}: ABSENT (${v.note})`);
  if (!ready.length) {
    console.log(`RESULT: voices fable (no external voice, exit 3) — the ${FABLE} carries the review alone`);
    return 3;
  }
  if (a.dry) {
    for (const v of ready) {
      const c = commandFor(v, a);
      console.log(`${label(v)}: cwd ${c.cwd}\n  argv ${JSON.stringify([v.launch.exe, ...c.args])}` +
        (c.stdin ? `\n  stdin: the read-only guard line, a blank line, then the brief` : ''));
    }
    console.log(`RESULT: voices DRY-RUN ${ready.map(label).join(' ')}`);
    return 0;
  }

  fs.mkdirSync(a.out, { recursive: true });
  for (const v of ready) for (const ext of ['md', 'err'])
    if (fs.existsSync(path.join(a.out, `${v.name}.${ext}`))) throw new UsageError(`${a.out} already holds reports: use a new --out`);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'])
    try { process.on(sig, () => { killAll(); process.exit(130); }); } catch {}
  process.on('exit', killAll);

  const before = fingerprint(a.subject);
  console.log(`running ${ready.map(label).join(', ')}; reports in ${a.out}; cap ${a.timeoutMin} min each`);
  const results = await Promise.all(ready.map(v => runOne(v, a)));
  for (const r of results) {
    console.log(`${label(r)}: ${r.status} (exit ${r.code}, ${r.size} bytes, ${r.secs}s) ${r.outFile}`);
    if (/WEAK/.test(r.note || '')) console.log(`  ${r.note}`);
    if (r.denied) console.log(`  a read was denied — the report may rest on part of the subject; see ${r.errFile}`);
    else if (r.status !== 'OK') console.log(`  stderr: ${r.errFile}`);
  }
  let untouched;
  if (before.state === 'not-git') { untouched = 'UNCHECKED'; console.log('untouched check: skipped — the subject is not a git work tree'); }
  else {
    const after = fingerprint(a.subject);
    if (before.state !== 'ok' || after.state !== 'ok') { untouched = 'UNCHECKED'; console.log('untouched check: FAILED to run (git error) — say "not verified"'); }
    else if (after.hash === before.hash) { untouched = 'OK'; console.log('untouched check: OK (tracked content and untracked files unchanged; ignored files not covered)'); }
    else {
      untouched = 'CHANGED';
      console.log('untouched check: CHANGED — the subject differs from before the run. A voice or a person working in parallel ' +
        'wrote into it; do not revert anything yourself — show the person `git status` and ask.');
    }
  }
  const absent = voices.filter(v => !v.ready).map(v => `${v.name}=ABSENT`);
  console.log(`RESULT: voices ${results.map(r => `${label(r)}=${r.status}`).concat(absent).join(' ')} untouched=${untouched}` +
    ` — plus the fable voice (${FABLE}), dispatched by Claude`);
  if (untouched === 'CHANGED') return 4;
  return results.some(r => r.status === 'OK' || r.status === 'PARTIAL') ? 0 : 1;
}

main().then(code => process.exit(code), e => {
  killAll();
  if (e instanceof UsageError) { console.error(`${e.message}\n\n${HELP}`); process.exit(2); }
  console.error(e.stack || String(e)); process.exit(2);
});
