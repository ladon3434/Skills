// discarded-verdict-lint — a reader's verdict is never thrown away.
//
// Usage: discarded-verdict-lint.cmd <file...>                     judge these files
//        discarded-verdict-lint.cmd --all                         every source root of the project
//        discarded-verdict-lint.cmd --root <dir>... [--with <dir>]... [<file...>]
//        discarded-verdict-lint.cmd ... --marker DEVIATION:          also accept the project's own allow marker
//        discarded-verdict-lint.cmd --selftest
// Default roots: <project>/Source and every Plugins/**/Source (nearest .uproject up from cwd). Each root keeps
// its OWN reader inventory; `--with <dir>` adds the readers of a tree the judged roots call into (a plugin that
// parses its arguments through another plugin's helpers).
// Exit: 0 clean · 1 findings · 2 usage error.
//
// THE DEFECT. A reader reports «I could not read this» through its RETURN and writes the value through an
// out-parameter. Drop the return and the out-parameter keeps whatever it was initialised with:
// `ParseVector(LocationJson, Location);` on a malformed argument leaves `Location` at the origin, the tool reports
// success, and a check of the result's shape passes. Nothing in that chain raises its voice. It is most common in
// editor tooling that takes JSON/string arguments (MCP tools, commandlets, editor utilities), but any game code
// with `bool TryGetX(..., FX& Out)` helpers has it.
//
// WHAT COUNTS AS A READER — derived, never listed: a function DECLARED in the root that returns `bool` or
// `FString` (an «ERROR: …» channel) AND has a non-const reference (or pointer-to-pointer) parameter. A plain
// non-const `T*` is the object worked on (`bool SaveAsset(UObject* Asset)`), not a value written back. The one
// engine name added by hand is `ImportText_Direct`: it writes a property and answers only through its return.
// Keyed by the last identifier of the name — no symbol table — so a foreign function sharing a reader's name is
// judged as a reader. Deliberately not caught: the `TryGet*Field` family, whose failure is legible in the
// out-value itself and is checked on the next line by idiom.
//
// WHAT COUNTS AS DISCARDED: the call is the WHOLE statement, `Reader(a, b);`. `if(!Reader(...))`, `return
// Reader(...)`, `const bool bOk = Reader(...)`, `ensure(Reader(...))`, `Out.Add(Reader(...))` all use it.
//
// THE DELIBERATE DISCARD: `// verdict-ok: <why>` on the statement's line or the line above.
// The compiler-enforced alternative for NEW readers is `[[nodiscard]]` on the declaration; this gate covers the
// readers that already exist without touching their signatures.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE_READERS = new Set(['ImportText_Direct']);
const AllowMarkers = [/\/\/\s*verdict-ok:\s*\S/];
const SKIP = new Set(['Intermediate', 'Binaries', 'DerivedDataCache', 'Saved', 'ThirdParty']);

// --- the source, with everything that is not code blanked out (offsets preserved) -----------------------------

/** Comments on one line, found by ONE pass that recognises strings and comments together (each hides the
 *  other: `"a // b"` is data, an apostrophe inside a block comment is prose). State carries across lines. */
function scanLine(line, state) {
	const found = [];
	let i = 0;
	if (state.inBlock) {
		const end = line.indexOf('*/');
		if (end < 0) return [{ start: 0, text: line }];
		state.inBlock = false;
		found.push({ start: 0, text: line.slice(0, end + 2) });
		i = end + 2;
	}
	while (i < line.length) {
		const ch = line[i];
		if (ch === '"' || ch === "'") {
			i++;
			while (i < line.length && line[i] !== ch) i += line[i] === '\\' ? 2 : 1;
			i++;
			continue;
		}
		if (ch === '/' && line[i + 1] === '/') { found.push({ start: i, text: line.slice(i) }); return found; }
		if (ch === '/' && line[i + 1] === '*') {
			const end = line.indexOf('*/', i + 2);
			if (end < 0) { state.inBlock = true; found.push({ start: i, text: line.slice(i) }); return found; }
			found.push({ start: i, text: line.slice(i, end + 2) });
			i = end + 2;
			continue;
		}
		i++;
	}
	return found;
}

function blankStrings(line) {
	const out = line.split('');
	let i = 0;
	while (i < out.length) {
		const ch = out[i];
		if (ch !== '"' && ch !== "'") { i++; continue; }
		i++;
		while (i < out.length) {
			if (out[i] === '\\') { out[i] = ' '; if (i + 1 < out.length) out[i + 1] = ' '; i += 2; continue; }
			if (out[i] === ch) { i++; break; }
			out[i] = ' ';
			i++;
		}
	}
	return out.join('');
}

export function readSource(text) {
	const lines = text.split(/\r?\n/);
	const state = { inBlock: false };
	const code = [];
	const allowed = new Array(lines.length).fill(false);
	let inMacro = false;
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		let blanked = raw;
		for (const c of scanLine(raw, state)) {
			if (AllowMarkers.some((m) => m.test(c.text))) allowed[i] = true;
			blanked = blanked.slice(0, c.start) + ' '.repeat(c.text.length) + blanked.slice(c.start + c.text.length);
		}
		const directive = inMacro || blanked.trimStart().startsWith('#');
		inMacro = directive && blanked.trimEnd().endsWith('\\');
		// A macro body is not a statement of this translation unit; blanked, not dropped, so offsets hold.
		code.push(directive ? ' '.repeat(blanked.length) : blankStrings(blanked));
	}
	return { code: code.join('\n'), lines, allowed };
}

// --- the reader inventory -------------------------------------------------------------------------------------

const SIGNATURE = /\b(?:bool|FString)\s+(?:[A-Za-z_]\w*::)*([A-Za-z_]\w*)\s*\(([^;{)]*(?:\([^)]*\)[^;{)]*)*)\)\s*(?:const\s*)?[;{]/g;

export function splitParams(params) {
	const out = [];
	let depth = 0, start = 0;
	for (let i = 0; i < params.length; i++) {
		const ch = params[i];
		if (ch === '<' || ch === '(' || ch === '[') depth++;
		else if (ch === '>' || ch === ')' || ch === ']') depth--;
		else if (ch === ',' && depth === 0) { out.push(params.slice(start, i)); start = i + 1; }
	}
	if (params.slice(start).trim()) out.push(params.slice(start));
	return out;
}

/** A parameter the callee writes back: a non-const reference, or a pointer-to-pointer. */
export function isOutParam(param) {
	const declaration = (param.split('=')[0] ?? '').trim();
	const marker = declaration.search(/&|\*\s*\*/);
	if (marker < 0) return false;
	return !/\bconst\b/.test(declaration.slice(0, marker + 1));
}

export function readersIn(text) {
	const out = new Set();
	for (const m of readSource(text).code.matchAll(SIGNATURE)) {
		if (splitParams(m[2] ?? '').some(isOutParam)) out.add(m[1]);
	}
	return out;
}

// --- the statement machine ------------------------------------------------------------------------------------

const CALL = /^([A-Za-z_]\w*(?:\s*(?:::|->|\.)\s*[A-Za-z_]\w*)*)\s*\(([\s\S]*)\)$/;
const CONTROL_HEADER = /(^|[^\w])(if|while|for|switch|catch)\s*\($/;

function balanced(inner) {
	let depth = 0;
	for (const ch of inner) {
		if (ch === '(') depth++;
		else if (ch === ')' && --depth < 0) return false;
	}
	return depth === 0;
}

export function findings(text, file, readers) {
	const source = readSource(text);
	const { code } = source;
	const out = [];
	let start = 0, depth = 0;
	const judge = (statement, offset) => {
		const body = statement.replace(/^\s*else\b/, '');
		const trimmed = body.trim();
		if (!trimmed) return;
		const call = CALL.exec(trimmed);
		if (!call || !balanced(call[2] ?? '')) return;
		const chain = call[1].split(/::|->|\./);
		const callee = chain[chain.length - 1].trim();
		if (!readers.has(callee) && !ENGINE_READERS.has(callee)) return;
		const at = offset + (statement.length - body.length) + body.indexOf(trimmed);
		let line = 1;
		for (let i = 0; i < at; i++) if (code[i] === '\n') line++;
		if (source.allowed[line - 1] || (line > 1 && source.allowed[line - 2])) return;
		out.push({ file, line, text: (source.lines[line - 1] ?? '').trim(), callee });
	};
	for (let i = 0; i < code.length; i++) {
		const ch = code[i];
		if (ch === '(') { depth++; continue; }
		if (ch === ')') {
			depth = Math.max(0, depth - 1);
			// The `)` closing a control header is a boundary too: the body of `if(x) Reader(a, b);` is a statement.
			if (depth === 0 && CONTROL_HEADER.test(code.slice(start, i + 1).replace(/\([\s\S]*$/, '('))) start = i + 1;
			continue;
		}
		if (depth > 0) continue;
		if (ch === ';' || ch === '{' || ch === '}') { judge(code.slice(start, i), start); start = i + 1; }
	}
	return out;
}

// --- tree walk ------------------------------------------------------------------------------------------------

export function sourceFiles(root) {
	const out = [];
	const walk = (dir) => {
		let entries;
		try { entries = readdirSync(dir); } catch { return; }
		for (const name of entries) {
			if (SKIP.has(name)) continue;
			const p = join(dir, name);
			let s;
			try { s = statSync(p); } catch { continue; }
			if (s.isDirectory()) walk(p);
			else if (['.cpp', '.h'].includes(extname(name).toLowerCase())) out.push(p);
		}
	};
	walk(root);
	return out;
}

/** The inventory is always read from the WHOLE tree, never from the files judged: a call site reaches readers
 *  declared in other files, and a slice would forget them and pass the file in silence. */
export function inventory(dirs) {
	const out = new Set();
	for (const dir of dirs) for (const f of sourceFiles(dir)) {
		try { for (const n of readersIn(readFileSync(f, 'utf8'))) out.add(n); } catch { /* unreadable: skip */ }
	}
	return out;
}

function findUprojectDir(start) {
	let dir = resolve(start);
	for (;;) {
		try { if (readdirSync(dir).some((f) => f.toLowerCase().endsWith('.uproject'))) return dir; } catch { /* keep walking */ }
		const up = dirname(dir);
		if (up === dir) return null;
		dir = up;
	}
}

export function defaultRoots(projectDir) {
	const roots = [];
	if (existsSync(join(projectDir, 'Source'))) roots.push(join(projectDir, 'Source'));
	const walk = (dir, depth) => {
		let entries;
		try { entries = readdirSync(dir); } catch { return; }
		if (entries.some((e) => e.toLowerCase().endsWith('.uplugin'))) {
			if (existsSync(join(dir, 'Source'))) roots.push(join(dir, 'Source'));
			return;
		}
		if (depth > 0) for (const e of entries) if (statSync(join(dir, e)).isDirectory()) walk(join(dir, e), depth - 1);
	};
	walk(join(projectDir, 'Plugins'), 3);
	return roots;
}

// --- selftest -------------------------------------------------------------------------------------------------

function selftest() {
	let failed = 0;
	const eq = (actual, expected, what) => {
		const a = JSON.stringify(actual), b = JSON.stringify(expected);
		if (a !== b) { console.error(`FAIL: ${what}\n  expected ${b}\n  got      ${a}`); failed++; }
	};
	const READER = 'bool ParseVector(const FString& Json, FVector& Out);\n';
	const count = (src) => findings(READER + src, 'x.cpp', readersIn(READER + src)).length;
	eq(count('void F() { ParseVector(LocationJson, Location); }\n'), 1, 'a bare reader call is a discarded verdict');
	eq(count('void F() {\n    ParseVector(A, B);\n    ParseVector(C, D);\n}\n'), 2, 'each one is its own finding');
	eq(count('void F() { Property->ImportText_Direct(*Text, ValuePtr, nullptr, PPF_None); }\n'), 1, 'the named engine reader counts too');
	eq(count('void F() { if(!ParseVector(Json, Out)) { return; } }\n'), 0, 'a checked call');
	eq(count('bool F() { return ParseVector(Json, Out); }\n'), 0, 'a returned verdict');
	eq(count('void F() { const bool bOk = ParseVector(Json, Out); }\n'), 0, 'an assigned verdict');
	eq(count('void F() { ensure(ParseVector(Json, Out)); }\n'), 0, 'a verdict handed to ensure');
	eq(count('void F() { Results.Add(ParseVector(Json, Out)); }\n'), 0, 'a call in argument position');
	eq(count('void F() { if(ParseVector(A, B) && ParseVector(C, D)) { return; } }\n'), 0, 'both halves of a condition');
	eq(count('void F() { if(bReady) ParseVector(Json, Out); }\n'), 1, 'a braceless if-body is its own statement');
	eq(count('void F() { if(bReady) { ParseVector(Json, Out); } else ParseVector(A, B); }\n'), 2, 'and a braceless else-body');
	eq(count('void F() { Landscape->PostEditChange(); }\n'), 0, 'a void call is not a reader');
	eq(readersIn('bool IsReady(const FString& Json);\n').size, 0, 'a bool function without an out-parameter is not a reader');
	eq(readersIn('void Fill(FVector& Out);\n').size, 0, 'a void function has no verdict');
	eq(readersIn('bool SaveAsset(UObject* Asset);\n').size, 0, 'a plain pointer is the object worked on');
	eq(readersIn('bool Read(const FString& Json, TSharedPtr<FJsonObject>** Out);\n').has('Read'), true, 'a pointer-to-pointer is an out-parameter');
	eq(readersIn('FString ReadOptional(const FString& Json, FVector& Out);\n').has('ReadOptional'), true, 'an FString error channel is a verdict');
	eq(readersIn('bool Read(const TMap<FString, int32>& In);\n').size, 0, 'a comma inside a template argument does not split parameters');
	eq(count('void F() { /* keep */ ParseVector(Json, Out); }\n'), 1, 'a comment in front of a call does not hide it');
	eq(count('void F() { const TCHAR* S = "a; ParseVector(Json, Out);"; }\n'), 0, 'a semicolon inside a string does not end a statement');
	eq(count("void F() { Log(TEXT(\"don't\")); ParseVector(Json, Out); }\n"), 1, 'an apostrophe in a string does not swallow the next statement');
	eq(count('void F() {\n#define PARSE() \\\n    ParseVector(Json, Out);\n}\n'), 0, 'a macro body is not a statement');
	eq(count('void F() { ParseVector(A, B) ? Keep() : Drop(); }\n'), 0, 'a call opening a larger expression');
	eq(count('void F() { ParseVector(Json, Out); // verdict-ok: the default is the documented fallback\n}\n'), 0, 'a marker on the line');
	eq(count('void F() {\n    // verdict-ok: documented fallback\n    ParseVector(Json, Out);\n}\n'), 0, 'a marker on the line above');
	eq(count('void F() {\n    // verdict-ok: other\n    Foo();\n    ParseVector(Json, Out);\n}\n'), 1, 'a marker two lines up marks the wrong statement');
	eq(findings(READER + 'void F() {\n    ParseVector(\n        A,\n        B);\n}\n', 'x.cpp', readersIn(READER)).map((f) => f.line), [3], 'reported on the line the call opens');
	if (failed) { console.error(`discarded-verdict-lint selftest: ${failed} failure(s)`); return 1; }
	console.log('discarded-verdict-lint selftest: ok');
	return 0;
}

// --- CLI ------------------------------------------------------------------------------------------------------

function main(argv) {
	if (argv.includes('--selftest')) return selftest();
	const listArg = (flag) => argv.flatMap((a, i) => (argv[i - 1] === flag ? [resolve(a)] : []));
	for (const word of argv.flatMap((a, i) => (argv[i - 1] === '--marker' ? [a] : []))) {
		const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		AllowMarkers.push(new RegExp(`//\\s*${escaped}\\s*\\S`));
	}
	const given = argv.filter((a, i) => !a.startsWith('--') && !['--root', '--with', '--marker'].includes(argv[i - 1])).map((f) => resolve(f));
	let roots = listArg('--root');
	const extra = listArg('--with');
	if (!roots.length) {
		const project = findUprojectDir(process.env.CLAUDE_PROJECT_DIR || process.cwd());
		if (!project) { console.error('discarded-verdict-lint: no .uproject above the current directory - pass --root <dir>'); return 2; }
		roots = defaultRoots(project);
	}
	if (!argv.includes('--all') && !given.length) {
		console.error('usage: discarded-verdict-lint <file...> | --all [--root <dir>]... [--with <dir>]... | --selftest');
		return 2;
	}
	const rootOf = (f) => roots.filter((r) => f.startsWith(r + sep)).sort((a, b) => b.length - a.length)[0] ?? null;
	const files = argv.includes('--all') ? roots.flatMap(sourceFiles) : given.filter((f) => rootOf(f) && ['.cpp', '.h'].includes(extname(f).toLowerCase()));
	const extraReaders = inventory(extra);
	const found = [];
	for (const root of roots) {
		const mine = files.filter((f) => rootOf(f) === root);
		if (!mine.length) continue;
		const readers = inventory([root]);
		for (const n of extraReaders) readers.add(n);
		for (const f of mine) {
			let text;
			try { text = readFileSync(f, 'utf8'); } catch { continue; }
			found.push(...findings(text, f, readers));
		}
	}
	for (const f of found) {
		console.log(`${f.file}:${f.line}: the verdict of ${f.callee} is discarded - on bad input the value it writes keeps whatever it held`);
		console.log(`    ${f.text}`);
	}
	if (found.length) {
		console.log(`\ndiscarded-verdict-lint: ${found.length} discarded verdict(s) in ${new Set(found.map((f) => f.file)).size} file(s).`);
		console.log('Read the verdict - branch and report which argument failed. A discard that is genuinely correct is');
		console.log('marked `// verdict-ok: <why>` on the statement or the line above.');
		return 1;
	}
	console.log(`discarded-verdict-lint: ok (${files.length} file(s), ${roots.length} root(s))`);
	return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)));
