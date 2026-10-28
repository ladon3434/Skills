// capture-level.mjs — shoot the editor's CURRENT level from given camera poses into PNG files on disk.
//
// Why a script: CaptureViewport returns its image inside the MCP answer — right for the agent's own look (a bridge
// can lift it into an image block), useless when a PERSON needs the picture as a file. No toolset writes a
// screenshot to disk, so this script is the HTTP client and saves the base64 itself.
// Stock Epic toolsets only (EditorToolset.EditorAppToolset.CaptureViewport), works headless under -RenderOffScreen.
//
//   node capture-level.mjs --out <dir> --shot <name>:<x>,<y>,<z>:<pitch>,<yaw> [--shot ...] [--grid] [--url URL | --project DIR]
//
// It photographs whatever level is loaded; placing actors is the caller's job. Facts that bite (references/
// epic-mcp-toolsets.md §Screenshots): load_level the map again before a shot after property edits on the current
// level; pin auto-exposure and motion blur before judging brightness; one process per shot if meshes go missing.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { connect, findImages, serverUrl } from './mcp-http.mjs';

const Usage = 'usage: node capture-level.mjs --out <dir> --shot <name>:<x>,<y>,<z>:<pitch>,<yaw> [--shot ...] [--grid] [--url URL | --project DIR]';

export function parseShot(spec) {
	const m = /^([A-Za-z0-9_.-]+):(-?[\d.]+),(-?[\d.]+),(-?[\d.]+):(-?[\d.]+),(-?[\d.]+)$/.exec(spec ?? '');
	if (!m) return null;
	return { name: m[1], loc: { x: +m[2], y: +m[3], z: +m[4] }, rot: { pitch: +m[5], yaw: +m[6] } };
}

export function captureArgs(shot, grid) {
	return {
		captureTransform: { location: shot.loc, rotation: { ...shot.rot, roll: 0 }, scale: { x: 1, y: 1, z: 1 } },
		// Both optional params must be passed EXPLICITLY or the facade answers «needs a default value».
		// gridSpacing 0 + maxLabelDistance 0 is how you ask for a clean plate.
		annotations: grid
			? { gridSpacing: 100, gridExtent: 3000, gridHeight: 0, maxLabelDistance: 5000, classFilter: null, maxLabels: 12 }
			: { gridSpacing: 0, gridExtent: 0, gridHeight: 0, maxLabelDistance: 0, classFilter: null, maxLabels: 0 },
		bShowUI: false,
	};
}

async function main(argv) {
	if (argv.includes('--help') || argv.includes('-h')) {
		console.log(Usage);
		return 0;
	}
	const shots = [];
	let outDir = null;
	let grid = false;
	let url = null;
	let project = null;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--out') outDir = argv[++i];
		else if (argv[i] === '--grid') grid = true;
		else if (argv[i] === '--url') url = argv[++i];
		else if (argv[i] === '--project') project = argv[++i];
		else if (argv[i] === '--shot') {
			const s = parseShot(argv[++i]);
			if (!s) {
				console.log(`ERROR: bad --shot "${argv[i]}" - expected <name>:<x>,<y>,<z>:<pitch>,<yaw>`);
				return 2;
			}
			shots.push(s);
		}
	}
	if (!outDir || !shots.length) {
		console.log(Usage);
		return 2;
	}
	const c = connect(serverUrl(url, project), { name: 'capture-level' });
	mkdirSync(outDir, { recursive: true });
	await c.handshake();
	let failed = 0;
	for (const s of shots) {
		try {
			const result = await c.callTool('EditorToolset.EditorAppToolset', 'CaptureViewport', captureArgs(s, grid));
			const images = findImages(result);
			if (!images.length) throw new Error(`${s.name}: the capture returned no image - ${JSON.stringify(result).slice(0, 300)}`);
			const file = resolve(outDir, `${s.name}.${images[0].mimeType.includes('jpeg') ? 'jpg' : 'png'}`);
			const bytes = Buffer.from(images[0].data, 'base64');
			writeFileSync(file, bytes);
			console.log(`${file}  (${Math.round(bytes.length / 1024)} KB)`);
		} catch (e) {
			console.log(`ERROR: ${e.message}`);
			failed++;
		}
	}
	return failed ? 1 : 0;
}

// process.exitCode, never process.exit(): a forced exit with an HTTP socket still open dies with a libuv
// assertion on Windows and a garbage exit code.
main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(e) => {
		console.log(`ERROR: ${e.message}`);
		process.exitCode = 1;
	},
);
