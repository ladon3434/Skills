// install-agent-tools.mjs — install the agent-friendly CLI tools an Unreal + Claude Code workstation uses, through
// winget. Each entry is skipped when its probe command already resolves on PATH.
//
//   node install-agent-tools.mjs            install what is missing
//   node install-agent-tools.mjs --list     print the table and what is missing, install nothing

import { execFileSync, spawnSync } from 'node:child_process';

/** [winget id, name, probe command, why] */
export const Tools = [
	['Git.Git', 'Git for Windows', 'git', 'git + Git Bash (Claude Code runs Bash tool and hooks there)'],
	['GitHub.GitLFS', 'git-lfs', 'git-lfs', '.uasset/.umap live in LFS'],
	['OpenJS.NodeJS.LTS', 'Node.js LTS', 'node', 'every hook and script of the kit; MCP stdio bridges'],
	['BurntSushi.ripgrep.MSVC', 'ripgrep', 'rg', 'engine and project search'],
	['LLVM.LLVM', 'LLVM (clang-format, clangd)', 'clang-format', 'the format-after-edit hook; clangd on demand'],
	['UniversalCtags.Ctags', 'universal-ctags', 'ctags', 'the engine symbol index (code-analysis)'],
	['sharkdp.fd', 'fd', 'fd', 'fast file find'],
	['jqlang.jq', 'jq', 'jq', 'JSON in the shell'],
	['sharkdp.bat', 'bat', 'bat', 'file viewer with line numbers'],
	['ast-grep.ast-grep', 'ast-grep', 'sg', 'structural code search / rewrite'],
	['chmln.sd', 'sd', 'sd', 'safe find-and-replace'],
	['Wilfred.difftastic', 'difftastic', 'difft', 'syntax-aware diff'],
	['GitHub.cli', 'gh', 'gh', 'GitHub from the shell'],
	['Python.Python.3.13', 'Python 3.13', 'python', 'tooling scripts, offline asset readers'],
	['astral-sh.uv', 'uv', 'uv', 'python environments'],
	['ImageMagick.ImageMagick', 'ImageMagick', 'magick', 'texture checks and packing'],
];

function onPath(command) {
	try {
		execFileSync('where', [command], { stdio: 'ignore', windowsHide: true });
		return true;
	} catch {
		return false;
	}
}

const listOnly = process.argv.includes('--list') || process.argv.includes('--dry-run');
if (process.argv.includes('--help')) {
	console.log('usage: install-agent-tools [--list]');
	process.exit(0);
}

if (listOnly) {
	for (const [id, name, probe, why] of Tools) {
		console.log(`${onPath(probe) ? 'present' : 'MISSING'}  ${name.padEnd(28)} ${id.padEnd(26)} ${why}`);
	}
	process.exit(0);
}

if (!onPath('winget')) {
	console.log('winget was not found. Install "App Installer" from the Microsoft Store, or install the tools by hand (--list shows the ids).');
	process.exit(1);
}

let failures = 0;
for (const [id, name, probe] of Tools) {
	if (onPath(probe)) {
		console.log(`present: ${name} (${probe}) - skipped`);
		continue;
	}
	console.log(`------------------------------------------------------\nInstalling ${name} (${id})`);
	const r = spawnSync('winget', ['install', '--id', id, '--exact', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements'],
		{ stdio: 'inherit', windowsHide: true });
	if (r.status === 0) console.log(`installed: ${name}`);
	else { failures++; console.log(`FAILED: ${name}`); }
}
if (onPath('git-lfs')) spawnSync('git', ['lfs', 'install'], { stdio: 'inherit', windowsHide: true });
console.log('\nDone. Open a new terminal (PATH changes), then run doctor.cmd.');
process.exit(failures ? 1 : 0);
