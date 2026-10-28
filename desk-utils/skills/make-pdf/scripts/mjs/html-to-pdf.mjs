// html-to-pdf.mjs — print an HTML file to PDF (or a PNG preview) with headless Chrome or Edge.
//
// The browser is found, not assumed: BROWSER_EXE → chrome/msedge on PATH → the registry's App Paths →
// the usual Program Files folders. Edge ships with every Windows 10/11 and prints the same way as Chrome.
//
//   html-to-pdf <input.html> <out.pdf> [--landscape-hint] [--header-footer] [--wait <ms>]
//   html-to-pdf <input.html> <out.png> --png [--width 900] [--height 1200]
//   html-to-pdf --where            which browser would be used
//
// Exit codes: 0 ok, 1 the browser ran but produced no file, 2 usage or no browser found.

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const Names = ['chrome.exe', 'msedge.exe'];

function fromPath(env) {
	for (const dir of String(env.PATH ?? '').split(';')) {
		for (const n of Names) {
			const p = resolve(dir.trim() || '.', n);
			if (dir.trim() && existsSync(p)) return p;
		}
	}
	return null;
}

function fromRegistry() {
	for (const hive of ['HKCU', 'HKLM']) {
		for (const n of Names) {
			const r = spawnSync('reg', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${n}`, '/ve'], { encoding: 'utf8', windowsHide: true });
			const m = (r.stdout ?? '').match(/REG_SZ\s+(.+\.exe)/i);
			if (m && existsSync(m[1].trim())) return m[1].trim();
		}
	}
	return null;
}

function fromKnown(env) {
	const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
	const tails = ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe'];
	for (const r of roots) for (const t of tails) if (existsSync(`${r}\\${t}`)) return `${r}\\${t}`;
	return null;
}

export function findBrowser(env = process.env) {
	if (env.BROWSER_EXE && existsSync(env.BROWSER_EXE)) return env.BROWSER_EXE;
	return fromPath(env) ?? fromRegistry() ?? fromKnown(env);
}

function main(argv) {
	const flag = (f) => argv.includes(f);
	const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
	const browser = findBrowser();
	if (flag('--where')) {
		console.log(browser ?? 'no Chrome or Edge found - set BROWSER_EXE');
		return browser ? 0 : 2;
	}
	const pos = argv.filter((a, i) => !a.startsWith('--') && !['--wait', '--width', '--height'].includes(argv[i - 1]));
	if (pos.length < 2) {
		console.error('usage: html-to-pdf <input.html> <out.pdf|out.png> [--png] [--header-footer] [--wait <ms>] [--width N --height N] | --where');
		return 2;
	}
	if (!browser) {
		console.error('html-to-pdf: no Chrome or Edge found - install one or set BROWSER_EXE');
		return 2;
	}
	const input = resolve(pos[0]);
	const out = resolve(pos[1]);
	if (!existsSync(input)) {
		console.error(`html-to-pdf: no such file ${input}`);
		return 2;
	}
	const args = ['--headless=new', '--disable-gpu', `--virtual-time-budget=${opt('--wait', '3000')}`];
	if (flag('--png')) args.push(`--window-size=${opt('--width', '900')},${opt('--height', '1200')}`, `--screenshot=${out}`);
	else {
		if (!flag('--header-footer')) args.push('--no-pdf-header-footer');
		args.push(`--print-to-pdf=${out}`);
	}
	args.push(pathToFileURL(input).href);
	spawnSync(browser, args, { stdio: 'ignore', windowsHide: true, timeout: 120000 });
	if (!existsSync(out) || statSync(out).size === 0) {
		console.error(`html-to-pdf: ${browser} produced no ${out}`);
		return 1;
	}
	console.log(`${out} (${statSync(out).size} bytes) via ${browser}`);
	return 0;
}

process.exit(main(process.argv.slice(2)));
