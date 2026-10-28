// PostToolUse (Edit|Write|MultiEdit): after an edit of a skill's .md or of the instructions file, lint every
// reference in the project's agent instructions (scripts/mjs/skill-lint.mjs). Problems go back to the model as an
// error (exit 2). Only in a project that opted in with .claude/skill-lint.json; silent everywhere else.

import { dirname } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readPayload } from './hook-io.mjs';
import { covers, findLintRoot, lintProject, loadConfig } from '../scripts/mjs/skill-lint.mjs';

function main() {
	const path = readPayload()?.tool_input?.file_path;
	if (!path || !/\.md$/i.test(path)) return;
	const root = findLintRoot(dirname(path));
	if (!root) return;
	let cfg;
	try {
		cfg = loadConfig(root);
	} catch {
		return;
	}
	if (!covers(root, cfg, path)) return;
	const { problems } = lintProject(root);
	if (!problems.length) return;
	process.stderr.write(`skill-lint:\n${problems.join('\n')}\n`);
	process.exit(2);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
