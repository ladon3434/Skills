// run-tests — every offline test of the marketplace in one run. None starts an editor, a build or a network call;
// they need node, git and python on PATH. Run before a commit, after repo-check:
//
//   node scripts/run-tests.mjs [<name part> ...]     only the tests whose name contains one of the parts
//
// Exit 0 all passed, 1 a test failed. A test that cannot start (python missing) is a failure, not a skip.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const Here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const node = (rel, ...args) => ({ name: rel, cmd: process.execPath, args: [join(Here, rel), ...args] });
const python = (rel, ...args) => ({ name: rel, cmd: 'python', args: ['-B', join(Here, rel), ...args] });
const S = (plugin, skill = plugin) => `${plugin}/skills/${skill}`;

const Tests = [
	node('scripts/repo-check.mjs'),
	node(`${S('ue-workstation')}/tests/hooks-test.mjs`),
	node(`${S('ue-workstation')}/scripts/mjs/safe-pull.mjs`, '--selftest'),
	node(`${S('ue-workstation')}/scripts/mjs/ue-owner.mjs`, '--selftest'),
	node(`${S('ue-build-test')}/scripts/mjs/ue-selftest.mjs`),
	node(`${S('unreal-editor')}/scripts/mcp-bridge/test/bridge-test.mjs`),
	node(`${S('unreal-editor')}/scripts/test/ue-py-test.mjs`),
	node(`${S('code-analysis')}/scripts/mjs/crash-triage.mjs`, '--selftest'),
	node(`${S('ue-content-gates')}/scripts/mjs/asset-path-lint.mjs`, '--selftest'),
	node(`${S('ue-content-gates')}/scripts/mjs/cook-check.mjs`, '--selftest'),
	python(`${S('ue-content-gates')}/scripts/py/find_asset_refs.py`, '--selftest'),
	python(`${S('ue-content-gates')}/scripts/py/ref_lint.py`, '--selftest'),
	node(`${S('ue-cpp-authoring')}/scripts/mjs/discarded-verdict-lint.mjs`, '--selftest'),
	node(`${S('ue-perf')}/scripts/mjs/ue-trace.mjs`, '--selftest'),
	python(`${S('devping')}/scripts/tests/pingtest.py`),
];

const only = process.argv.slice(2);
const chosen = Tests.filter((t) => !only.length || only.some((p) => t.name.includes(p)));
let failed = 0;
for (const t of chosen) {
	if (!existsSync(t.args[t.cmd === 'python' ? 1 : 0])) {
		console.log(`FAIL ${t.name} - the test file is gone`);
		failed++;
		continue;
	}
	const started = Date.now();
	const r = spawnSync(t.cmd, t.args, { cwd: Here, encoding: 'utf8', windowsHide: true, timeout: 600000 });
	const secs = ((Date.now() - started) / 1000).toFixed(1);
	const ok = !r.error && r.status === 0;
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${t.name} (${secs} s)${r.error ? ` - ${r.error.message}` : ''}`);
	if (!ok) {
		failed++;
		const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd().split(/\r?\n/).slice(-15);
		for (const l of tail) console.log(`       ${l}`);
	}
}
console.log(failed ? `run-tests: ${failed} of ${chosen.length} FAILED` : `run-tests: all ${chosen.length} passed`);
process.exitCode = failed ? 1 : 0;
