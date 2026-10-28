// uasset.mjs — offline reader of editor-saved package headers (.uasset / .umap) for the node scripts.
//
// A port of the part of `py/uasset.py` the node gates need: the summary, the FName table, the import table, the
// asset-registry block (each asset's object path, class and tags) and the import type hierarchies (UE5 >= 1018:
// the super types of an imported class, written only for some classes). `py/uasset.py` is the reference: the
// layout notes there and in `references/package-format.md` apply here unchanged; change both together.
//
// Only the header is read (a file is read in growing chunks, never whole: a .umap can be hundreds of MB).
// Cooked (PKG_FilterEditorOnly) and unversioned packages are refused with a PackageError.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { basename, extname } from 'node:path';

export const PACKAGE_TAG = 0x9e2a83c1;
const PKG_CONTAINS_MAP = 0x00020000;
const PKG_FILTER_EDITOR_ONLY = 0x80000000;

// EUnrealEngineObjectUE4Version
const UE4_ENGINE_VERSION_OBJECT = 336;
const UE4_STRING_ASSET_REFERENCES_MAP = 384;
const UE4_COMPATIBLE_ENGINE_VERSION = 444;
const UE4_SERIALIZE_TEXT_IN_PACKAGES = 459;
const UE4_NAME_HASHES_SERIALIZED = 504;
const UE4_ADDED_SEARCHABLE_NAMES = 510;
const UE4_LOCALIZATION_ID = 516;
const UE4_ADDED_PACKAGE_OWNER = 518;
const UE4_NON_OUTER_PACKAGE_IMPORT = 520;
const UE4_ASSETREGISTRY_DEPENDENCYFLAGS = 521;
// EUnrealEngineObjectUE5Version
const UE5_OPTIONAL_RESOURCES = 1003;
const UE5_ADD_SOFTOBJECTPATH_LIST = 1008;
const UE5_METADATA_SERIALIZATION_OFFSET = 1014;
const UE5_VERSE_CELLS = 1015;
const UE5_PACKAGE_SAVED_HASH = 1016;
const UE5_IMPORT_TYPE_HIERARCHIES = 1018;

export class PackageError extends Error {}

/** Random access over a file descriptor or a Buffer; file bytes are pulled in on demand. */
class Reader {
	constructor(source, path) {
		this.path = path;
		this.pos = 0;
		if (Buffer.isBuffer(source)) {
			this.fd = null;
			this.buf = source;
			this.size = source.length;
		} else {
			this.fd = source;
			this.size = fstatSync(source).size;
			this.buf = Buffer.alloc(0);
		}
	}

	need(count) {
		const end = this.pos + count;
		if (count < 0 || end > this.size) throw new PackageError(`${this.path}: truncated at ${this.pos} (+${count})`);
		if (end <= this.buf.length) return;
		const want = Math.min(this.size, Math.max(end, this.buf.length * 2, 65536));
		const next = Buffer.alloc(want);
		this.buf.copy(next, 0, 0, this.buf.length);
		let at = this.buf.length;
		while (at < want) {
			const n = readSync(this.fd, next, at, want - at, at);
			if (n <= 0) throw new PackageError(`${this.path}: short read at ${at}`);
			at += n;
		}
		this.buf = next;
	}

	i32() { this.need(4); const v = this.buf.readInt32LE(this.pos); this.pos += 4; return v; }
	u32() { this.need(4); const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
	u16() { this.need(2); const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
	i64() { this.need(8); const v = this.buf.readBigInt64LE(this.pos); this.pos += 8; return Number(v); }
	skip(count) { this.need(count); this.pos += count; }

	fstring() {
		const length = this.i32();
		if (length === 0) return '';
		if (length > 0) {
			if (length > 1 << 24) throw new PackageError(`${this.path}: implausible string length ${length}`);
			this.need(length);
			const raw = this.buf.subarray(this.pos, this.pos + length);
			this.pos += length;
			const nul = raw.indexOf(0);
			return raw.subarray(0, nul < 0 ? raw.length : nul).toString('utf8');
		}
		const count = -length;
		if (count > 1 << 23) throw new PackageError(`${this.path}: implausible string length ${length}`);
		this.need(count * 2);
		const s = this.buf.subarray(this.pos, this.pos + count * 2).toString('utf16le');
		this.pos += count * 2;
		const nul = s.indexOf('\0');
		return nul < 0 ? s : s.slice(0, nul);
	}
}

/**
 * Parse a package header. `source` is a file path or a Buffer (the selftests build packages in memory).
 * Returns {path, ue4, ue5, flags, isMap, names, imports, assets, typeHierarchies}; `assets` are
 * {objectPath, class, tags}; `typeHierarchies` maps an import index to its super types [{type, package}],
 * nearest first.
 */
export function readPackage(source, path = typeof source === 'string' ? source : '<buffer>') {
	if (Buffer.isBuffer(source)) return parse(new Reader(source, path));
	const fd = openSync(source, 'r');
	try {
		return parse(new Reader(fd, path));
	} finally {
		closeSync(fd);
	}
}

function parse(r) {
	const p = { path: r.path, ue4: 0, ue5: 0, flags: 0, names: [], imports: [], assets: [], typeHierarchies: new Map() };
	if (r.size < 32) throw new PackageError(`${r.path}: too small to be a package`);
	if (r.u32() !== PACKAGE_TAG) throw new PackageError(`${r.path}: not a package (bad tag)`);
	const legacy = r.i32();
	if (legacy >= 0 || legacy < -9) throw new PackageError(`${r.path}: unsupported legacy file version ${legacy}`);
	if (legacy !== -4) r.i32(); // LegacyUE3Version
	p.ue4 = r.i32();
	p.ue5 = legacy <= -8 ? r.i32() : 0;
	const licensee = r.i32();
	if (!p.ue4 && !p.ue5 && !licensee) throw new PackageError(`${r.path}: unversioned package (cooked) - not readable offline`);
	const savedHash = p.ue5 >= UE5_PACKAGE_SAVED_HASH;
	if (savedHash) { r.skip(20); r.i32(); } // FIoHash SavedHash, TotalHeaderSize
	if (legacy <= -2) {
		if (legacy > -6) throw new PackageError(`${r.path}: legacy custom-version format ${legacy} not supported`);
		const customCount = r.i32();
		if (customCount < 0 || customCount > 1024) throw new PackageError(`${r.path}: implausible custom version count ${customCount}`);
		r.skip(customCount * 20);
	}
	if (!savedHash) r.i32(); // TotalHeaderSize
	r.fstring(); // PackageName
	p.flags = r.u32();
	if (p.flags & PKG_FILTER_EDITOR_ONLY) throw new PackageError(`${r.path}: cooked package (editor-only data filtered) - not readable offline`);
	p.isMap = Boolean(p.flags & PKG_CONTAINS_MAP);
	const s = {};
	s.nameCount = r.i32(); s.nameOffset = r.i32();
	if (p.ue5 >= UE5_ADD_SOFTOBJECTPATH_LIST) { r.i32(); r.i32(); }
	if (p.ue4 >= UE4_LOCALIZATION_ID) r.fstring();
	if (p.ue4 >= UE4_SERIALIZE_TEXT_IN_PACKAGES) { r.i32(); r.i32(); }
	r.i32(); r.i32(); // export count/offset
	s.importCount = r.i32(); s.importOffset = r.i32();
	if (p.ue5 >= UE5_VERSE_CELLS) r.skip(16);
	if (p.ue5 >= UE5_METADATA_SERIALIZATION_OFFSET) r.i32();
	r.i32(); // DependsOffset
	if (p.ue4 >= UE4_STRING_ASSET_REFERENCES_MAP) { r.i32(); r.i32(); }
	if (p.ue4 >= UE4_ADDED_SEARCHABLE_NAMES) r.i32();
	r.i32(); // ThumbnailTableOffset
	s.hierCount = 0; s.hierOffset = 0;
	if (p.ue5 >= UE5_IMPORT_TYPE_HIERARCHIES) { s.hierCount = r.i32(); s.hierOffset = r.i32(); }
	if (!savedHash) r.skip(16);
	if (p.ue4 >= UE4_ADDED_PACKAGE_OWNER) {
		r.skip(16);
		if (p.ue4 < UE4_NON_OUTER_PACKAGE_IMPORT) r.skip(16);
	}
	const generations = r.i32();
	if (generations < 0 || generations > 100000) throw new PackageError(`${r.path}: implausible generation count ${generations}`);
	r.skip(generations * 8);
	for (const present of [p.ue4 >= UE4_ENGINE_VERSION_OBJECT, p.ue4 >= UE4_COMPATIBLE_ENGINE_VERSION]) {
		if (present) { r.u16(); r.u16(); r.u16(); r.u32(); r.fstring(); } else if (p.ue4 < UE4_ENGINE_VERSION_OBJECT) r.i32();
	}
	r.u32(); // CompressionFlags
	if (r.i32() !== 0) throw new PackageError(`${r.path}: compressed chunks present - unsupported`);
	r.u32(); // PackageSource
	for (let n = r.i32(), i = 0; i < n; i++) r.fstring(); // AdditionalPackagesToCook
	if (legacy > -7) r.i32(); // NumTextureAllocations
	s.assetRegistryOffset = r.i32();

	readNames(r, p, s);
	readImports(r, p, s);
	readHierarchies(r, p, s);
	readAssetRegistry(r, p, s);
	return p;
}

function fname(r, p) {
	const index = r.i32();
	const number = r.i32();
	if (index < 0 || index >= p.names.length) throw new PackageError(`${r.path}: name index ${index} out of range`);
	return number === 0 ? p.names[index] : `${p.names[index]}_${number - 1}`;
}

function readNames(r, p, s) {
	if (s.nameOffset < 0 || s.nameOffset >= r.size || s.nameCount < 0 || s.nameCount > 2000000) {
		throw new PackageError(`${r.path}: bad name table (${s.nameCount} entries at ${s.nameOffset})`);
	}
	r.pos = s.nameOffset;
	for (let i = 0; i < s.nameCount; i++) {
		p.names.push(r.fstring());
		if (p.ue4 >= UE4_NAME_HASHES_SERIALIZED) r.skip(4);
	}
}

function readImports(r, p, s) {
	if (s.importCount === 0) return;
	if (s.importOffset <= 0 || s.importOffset >= r.size || s.importCount < 0 || s.importCount > 1000000) {
		throw new PackageError(`${r.path}: bad import table (${s.importCount} at ${s.importOffset})`);
	}
	r.pos = s.importOffset;
	for (let i = 0; i < s.importCount; i++) {
		const imp = { classPackage: fname(r, p), className: fname(r, p), outer: r.i32(), objectName: fname(r, p), packageName: null };
		if (p.ue4 >= UE4_NON_OUTER_PACKAGE_IMPORT) imp.packageName = fname(r, p);
		if (p.ue5 >= UE5_OPTIONAL_RESOURCES) r.i32();
		p.imports.push(imp);
	}
}

// TPair<FPackageIndex, FImportTypeHierarchy>: int32 index, int32 super count, then per super type four FNames
// (TypeName, PackageName, ClassName, ClassPackageName). UObject itself is omitted (implied).
function readHierarchies(r, p, s) {
	if (s.hierCount <= 0 || s.hierOffset <= 0 || s.hierOffset >= r.size) return;
	if (s.hierCount > 100000) throw new PackageError(`${r.path}: implausible type hierarchy count ${s.hierCount}`);
	r.pos = s.hierOffset;
	for (let i = 0; i < s.hierCount; i++) {
		const index = r.i32();
		const count = r.i32();
		if (count < 0 || count > 1000) throw new PackageError(`${r.path}: implausible super type count ${count}`);
		const supers = [];
		for (let k = 0; k < count; k++) {
			const type = fname(r, p), pkg = fname(r, p);
			fname(r, p); fname(r, p);
			supers.push({ type, package: pkg });
		}
		if (index < 0) p.typeHierarchies.set(-index - 1, supers);
	}
}

function readAssetRegistry(r, p, s) {
	const offset = s.assetRegistryOffset;
	if (offset <= 0 || offset >= r.size) return;
	r.pos = offset;
	if (p.ue4 >= UE4_ASSETREGISTRY_DEPENDENCYFLAGS) r.i64();
	const objectCount = r.i32();
	if (objectCount < 0 || objectCount > 100000) throw new PackageError(`${r.path}: implausible asset count ${objectCount}`);
	for (let i = 0; i < objectCount; i++) {
		const objectPath = r.fstring();
		const cls = r.fstring();
		const tagCount = r.i32();
		if (tagCount < 0 || tagCount > 100000) throw new PackageError(`${r.path}: implausible tag count ${tagCount}`);
		const tags = {};
		for (let k = 0; k < tagCount; k++) { const key = r.fstring(); tags[key] = r.fstring(); }
		p.assets.push({ objectPath, class: cls, tags });
	}
}

/** The asset whose object name equals the package's short name, else the first one; null when there is none. */
export function mainAsset(p) {
	const short = basename(p.path, extname(p.path));
	return p.assets.find((a) => a.objectPath.split('.').pop() === short || a.objectPath === short) ?? p.assets[0] ?? null;
}

/** `/Script/Engine.StaticMesh` → `StaticMesh`; `/Script/CoreUObject.Class'/Script/Engine.Actor'` → `Actor`;
 *  `/Game/A/BP_X.BP_X_C` → `BP_X_C`; a short legacy name stays. */
export function shortClass(path) {
	if (!path) return path;
	const quoted = /'([^']*)'/.exec(path);
	const inner = quoted ? quoted[1] : path;
	return inner.split(/[.:]/).pop();
}

/** The package of a class path: `/Game/A/BP_X.BP_X_C` → `/Game/A/BP_X`; `/Script/Engine.Actor` → `/Script/Engine`. */
export function classPackage(path) {
	if (!path) return null;
	const quoted = /'([^']*)'/.exec(path);
	const inner = quoted ? quoted[1] : path;
	const dot = inner.indexOf('.');
	return dot < 0 ? null : inner.slice(0, dot);
}

/** Synthetic 5.8-layout package for selftests: a name table, imports [{classPackage, className, objectName}]
 *  (outermost, no package name), an asset registry block with the given assets ({objectPath, class, tags}) and
 *  import type hierarchies [{importIndex, supers: [name...]}]. Every name an import or a hierarchy uses must be in
 *  `names`, and `names` must hold 'None'. */
export function buildPackage({ assets, names = ['None'], flags = 0, imports = [], hierarchies = [] }) {
	const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };
	const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
	const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
	const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; };
	const fstr = (s) => { const body = Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]); return Buffer.concat([i32(body.length), body]); };
	const zero = (n) => Buffer.alloc(n);
	const header = (nameOff, impOff, hierOff, arOff) => Buffer.concat([
		u32(PACKAGE_TAG), i32(-9), i32(0), i32(522), i32(1018), i32(0), zero(20), i32(0),
		i32(0), fstr('None'), u32(flags),
		i32(names.length), i32(nameOff), i32(0), i32(0), fstr(''), i32(0), i32(0),
		i32(0), i32(0), i32(imports.length), i32(impOff), zero(16), i32(0), i32(0),
		i32(0), i32(0), i32(0), i32(0), i32(hierarchies.length), i32(hierOff), zero(16), i32(0),
		u16(5), u16(8), u16(0), u32(0), fstr(''), u16(5), u16(8), u16(0), u32(0), fstr(''),
		u32(0), i32(0), u32(0), i32(0), i32(arOff),
	]);
	const size = header(0, 0, 0, 0).length;
	const nameTable = Buffer.concat(names.map((n) => Buffer.concat([fstr(n), zero(4)])));
	const nameIndex = (n) => { const i = names.indexOf(n); if (i < 0) throw new Error(`buildPackage: ${n} not in names`); return Buffer.concat([i32(i), i32(0)]); };
	const importTable = Buffer.concat(imports.map((m) => Buffer.concat([
		nameIndex(m.classPackage), nameIndex(m.className), i32(0), nameIndex(m.objectName), nameIndex('None'), i32(0),
	])));
	const hier = Buffer.concat(hierarchies.map((h) => Buffer.concat([
		i32(-h.importIndex - 1), i32(h.supers.length),
		...h.supers.map((t) => Buffer.concat([nameIndex(t), nameIndex('None'), nameIndex('None'), nameIndex('None')])),
	])));
	const arBody = Buffer.concat([i32(assets.length), ...assets.map((a) => Buffer.concat([
		fstr(a.objectPath), fstr(a.class), i32(Object.keys(a.tags ?? {}).length),
		...Object.entries(a.tags ?? {}).map(([k, v]) => Buffer.concat([fstr(k), fstr(v)])),
	]))]);
	const nameOff = size, impOff = imports.length ? nameOff + nameTable.length : 0;
	const hierOff = hierarchies.length ? nameOff + nameTable.length + importTable.length : 0;
	const arOff = nameOff + nameTable.length + importTable.length + hier.length;
	return Buffer.concat([header(nameOff, impOff, hierOff, arOff), nameTable, importTable, hier, i64(0), arBody]);
}
