// mcp-http.mjs — a minimal MCP Streamable-HTTP client for the skill's scripts (capture-*, tests).
// Plain JSON or SSE answers, optional mcp-session-id. A script that writes a PNG to disk is an ordinary client of a
// documented server: the editor returns images INSIDE the MCP answer, and only a client can save them as files.

import { findProjectUproject } from './ue-engine.mjs';
import { projectInfo } from './ue-project.mjs';
import { resolve } from 'node:path';

export function parseSse(text) {
	const messages = [];
	let data = [];
	const flush = () => {
		if (!data.length) return;
		try {
			messages.push(JSON.parse(data.join('\n')));
		} catch {
			/* a non-JSON event is not ours */
		}
		data = [];
	};
	for (const line of text.split(/\r?\n/)) {
		if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
		else if (!line.trim()) flush();
	}
	flush();
	return messages.length === 1 ? messages[0] : messages;
}

/** The server URL: --url, else UE_MCP_URL / UE_MCP_PORT / project settings (ue-project.mjs). */
export function serverUrl(urlArg, projectArg) {
	if (urlArg) return urlArg;
	const uproject = projectArg ? (projectArg.toLowerCase().endsWith('.uproject') ? resolve(projectArg) : findProjectUproject(resolve(projectArg))) : findProjectUproject();
	if (!uproject) throw new Error('no .uproject found (run inside the project, or pass --project / --url)');
	return projectInfo(uproject, process.env, { withEngine: false }).url;
}

export function connect(url, { name = 'unreal-editor-skill', timeoutMs = 300000 } = {}) {
	let sessionId = null;
	let nextId = 1;
	const post = async (body) => {
		const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
		if (sessionId) headers['mcp-session-id'] = sessionId;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
			const sid = res.headers.get('mcp-session-id');
			if (sid) sessionId = sid;
			if (res.status === 202) return null;
			if (!res.ok) throw new Error(`HTTP ${res.status} from ${url} - is the editor up? (scripts/editor-ready.sh)`);
			const text = await res.text();
			if (!text) return null;
			return (res.headers.get('content-type') || '').includes('text/event-stream') ? parseSse(text) : JSON.parse(text);
		} catch (e) {
			if (controller.signal.aborted) throw new Error(`no answer from ${url} in ${Math.round(timeoutMs / 1000)}s`);
			if (e?.cause?.code === 'ECONNREFUSED') throw new Error(`nothing listens at ${url} - is the editor up? (scripts/editor-ready.sh)`);
			throw e;
		} finally {
			clearTimeout(timer);
		}
	};
	const rpc = async (method, params) => {
		const res = await post({ jsonrpc: '2.0', id: nextId++, method, params });
		const msg = Array.isArray(res) ? res.find((m) => m && m.id !== undefined) : res;
		if (!msg) throw new Error(`no response to ${method}`);
		if (msg.error) throw new Error(`${method}: ${msg.error.message || JSON.stringify(msg.error)}`);
		return msg.result;
	};
	return {
		async handshake() {
			await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version: '1.0.0' } });
			await post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {});
		},
		rpc,
		/** One Epic toolset call through the tool-search meta-tool. */
		callTool: (toolset, tool, args) => rpc('tools/call', { name: 'call_tool', arguments: { toolset_name: toolset, tool_name: tool, arguments: args } }),
	};
}

/** Every base64 image in a tool result, wherever the server nested it (the shape moved between engine versions). */
export function findImages(node, out = []) {
	if (!node || typeof node !== 'object') return out;
	if (typeof node.data === 'string' && typeof node.mimeType === 'string' && node.data.length > 256) {
		out.push({ data: node.data, mimeType: node.mimeType });
		return out;
	}
	for (const val of Object.values(node)) {
		if (val && typeof val === 'object') findImages(val, out);
		else if (typeof val === 'string' && val.length > 4096 && val.includes('"mimeType"')) {
			try {
				findImages(JSON.parse(val), out);
			} catch {
				/* not a nested JSON payload */
			}
		}
	}
	return out;
}

/** A toolset answer's `returnValue` string, also when wrapped in the MCP content envelope. */
export function returnValue(node) {
	if (!node || typeof node !== 'object') return null;
	if (typeof node.returnValue === 'string') return node.returnValue;
	for (const val of Object.values(node)) {
		if (val && typeof val === 'object') {
			const found = returnValue(val);
			if (found !== null) return found;
		} else if (typeof val === 'string' && val.includes('returnValue')) {
			try {
				const found = returnValue(JSON.parse(val));
				if (found !== null) return found;
			} catch {
				/* not a nested payload */
			}
		}
	}
	return null;
}
