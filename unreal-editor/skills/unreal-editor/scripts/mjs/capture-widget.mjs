// capture-widget.mjs — a Widget Blueprint's designer view as Slate draws it, into a PNG file on disk.
//
// Stock Epic toolsets only: EditorAppToolset.OpenEditorForAsset → SlateInspectorToolset.Windows(list) →
// Windows(select) → Screenshot. The window is chosen by TITLE, not by index: under -RenderOffScreen there is no
// active window, and the index of the asset's tab depends on what else is open. No title match is an error,
// never a capture of whatever window sorted first. The editor chrome is in frame on purpose: it is the real asset.
// The first render of a session can show text without brushes (textures stream on the editor tick): shoot again
// from a later call before judging.
//
//   node capture-widget.mjs --asset /Game/UI/WBP_X.WBP_X --out <dir> [--url URL | --project DIR]

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { connect, findImages, returnValue, serverUrl } from './mcp-http.mjs';

const Usage = 'usage: node capture-widget.mjs --asset /Game/.../WBP_X.WBP_X --out <dir> [--url URL | --project DIR]';
const SLATE = 'SlateInspectorToolset.SlateInspectorToolset';

/** The editor window whose title names the asset; null when none does. */
export function pickWindow(windows, assetName) {
	return (Array.isArray(windows) ? windows : []).find((w) => String(w?.title).includes(assetName)) ?? null;
}

async function main(argv) {
	const at = (f) => {
		const i = argv.indexOf(f);
		return i >= 0 ? argv[i + 1] : null;
	};
	if (argv.includes('--help') || argv.includes('-h')) {
		console.log(Usage);
		return 0;
	}
	const assetPath = at('--asset');
	const outDir = at('--out');
	if (!assetPath || !outDir) {
		console.log(Usage);
		return 2;
	}
	const assetName = assetPath.split('/').pop().split('.').pop();
	const c = connect(serverUrl(at('--url'), at('--project')), { name: 'capture-widget' });
	await c.handshake();
	await c.callTool('EditorToolset.EditorAppToolset', 'OpenEditorForAsset', { assetPath });
	const listed = returnValue(await c.callTool(SLATE, 'Windows', { action: 'list', index: 0, ref: '' }));
	let windows;
	try {
		windows = JSON.parse(listed);
	} catch {
		throw new Error(`Windows(list) did not answer with JSON: ${String(listed).slice(0, 200)}`);
	}
	const hit = pickWindow(windows, assetName);
	if (!hit) throw new Error(`no editor window titled like '${assetName}' - got ${JSON.stringify(windows)}`);
	await c.callTool(SLATE, 'Windows', { action: 'select', index: hit.index, ref: '' });
	const images = findImages(await c.callTool(SLATE, 'Screenshot', { ref: '' }));
	if (!images.length) throw new Error('the capture returned no image');
	mkdirSync(resolve(outDir), { recursive: true });
	const file = resolve(outDir, `${assetName}.${images[0].mimeType.includes('jpeg') ? 'jpg' : 'png'}`);
	const bytes = Buffer.from(images[0].data, 'base64');
	writeFileSync(file, bytes);
	console.log(`${file}  (${bytes.length} bytes)`);
	return 0;
}

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(e) => {
		console.log(`capture-widget: ${e.message}`);
		process.exitCode = 1;
	},
);
