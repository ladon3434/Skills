r"""Offline reader for editor-saved Unreal packages (.uasset / .umap), stdlib only.

Reads, without an editor:
  - the package summary (versions, flags, table offsets),
  - the FName table,
  - the import table and, from it, the packages this package depends on (hard references),
  - the soft package reference list (soft references),
  - the asset-registry "used in game" flags, which tell a game dependency from an editor-only one,
  - the asset-registry block: each asset's object path, class and tags (NativeParentClass, ParentClass, ...).

Layout notes (verified against UE 5.8 Engine/Source/Runtime/CoreUObject/Private/UObject/PackageFileSummary.cpp):
  - From EUnrealEngineObjectUE5Version::PACKAGE_SAVED_HASH (1016) the summary writes an FIoHash (20 bytes) and
    TotalHeaderSize BEFORE the custom versions, instead of TotalHeaderSize after them. A parser written against
    an earlier layout reads the first four bytes of the hash as the custom-version count and walks off.
  - The import table is not a reliable source for a Blueprint's parent: it lists every referenced class, so a
    cast and an inheritance look alike. The asset-registry tag NativeParentClass is authoritative.
  - Cooked packages (PKG_FilterEditorOnly) and unversioned ones are refused: their layout is not the editor one.
"""
import mmap
import re
import struct
from pathlib import Path

PACKAGE_TAG = 0x9E2A83C1
PKG_CONTAINS_MAP = 0x00020000
PKG_FILTER_EDITOR_ONLY = 0x80000000

# EUnrealEngineObjectUE4Version
UE4_STRING_ASSET_REFERENCES_MAP = 384
UE4_SERIALIZE_TEXT_IN_PACKAGES = 459
UE4_NAME_HASHES_SERIALIZED = 504
UE4_ADDED_SEARCHABLE_NAMES = 510
UE4_LOCALIZATION_ID = 516
UE4_ADDED_PACKAGE_OWNER = 518
UE4_NON_OUTER_PACKAGE_IMPORT = 520
UE4_ASSETREGISTRY_DEPENDENCYFLAGS = 521
UE4_ENGINE_VERSION_OBJECT = 336
UE4_COMPATIBLE_ENGINE_VERSION = 444
# EUnrealEngineObjectUE5Version
UE5_OPTIONAL_RESOURCES = 1003
UE5_ADD_SOFTOBJECTPATH_LIST = 1008
UE5_ASSETREGISTRY_PACKAGEBUILDDEPENDENCIES = 1013
UE5_METADATA_SERIALIZATION_OFFSET = 1014
UE5_VERSE_CELLS = 1015
UE5_PACKAGE_SAVED_HASH = 1016
UE5_IMPORT_TYPE_HIERARCHIES = 1018


class PackageError(ValueError):
    pass


class Reader:
    def __init__(self, data, path):
        self.data = data
        self.pos = 0
        self.path = path

    def need(self, count):
        if count < 0 or self.pos + count > len(self.data):
            raise PackageError(f"{self.path}: truncated at {self.pos} (+{count})")

    def i32(self):
        self.need(4)
        value = struct.unpack_from("<i", self.data, self.pos)[0]
        self.pos += 4
        return value

    def u32(self):
        self.need(4)
        value = struct.unpack_from("<I", self.data, self.pos)[0]
        self.pos += 4
        return value

    def u16(self):
        self.need(2)
        value = struct.unpack_from("<H", self.data, self.pos)[0]
        self.pos += 2
        return value

    def i64(self):
        self.need(8)
        value = struct.unpack_from("<q", self.data, self.pos)[0]
        self.pos += 8
        return value

    def skip(self, count):
        self.need(count)
        self.pos += count

    def fstring(self):
        length = self.i32()
        if length == 0:
            return ""
        if length > 0:
            self.need(length)
            raw = bytes(self.data[self.pos:self.pos + length])
            self.pos += length
            return raw.split(b"\x00", 1)[0].decode("utf-8", "replace")
        count = -length
        self.need(count * 2)
        raw = bytes(self.data[self.pos:self.pos + count * 2])
        self.pos += count * 2
        return raw.decode("utf-16-le", "replace").split("\x00", 1)[0]


class Package:
    """One parsed package. Attributes are filled by read_package()."""

    def __init__(self, path):
        self.path = str(path)
        self.ue4 = 0
        self.ue5 = 0
        self.flags = 0
        self.names = []
        self.imports = []          # dicts: class_package, class_name, outer, object_name, package_name
        self.soft_refs = []        # package names
        self.import_in_game = None   # list[bool] or None when the package has no flags
        self.soft_in_game = None
        self.assets = []           # dicts: object_path, class, tags
        self.summary = {}

    @property
    def is_map(self):
        return bool(self.flags & PKG_CONTAINS_MAP)

    def name(self, index, number):
        if not 0 <= index < len(self.names):
            raise PackageError(f"{self.path}: name index {index} out of range")
        base = self.names[index]
        return base if number == 0 else f"{base}_{number - 1}"

    def import_package(self, index):
        """The package an import lives in (UE's GetImportPackageName)."""
        seen = 0
        imp = self.imports[index]
        while True:
            if imp["package_name"] and imp["package_name"] != "None":
                return imp["package_name"]
            outer = imp["outer"]
            if outer == 0:
                return imp["object_name"]
            if outer > 0:
                return None             # outer is an export of this package
            seen += 1
            if seen > len(self.imports):
                raise PackageError(f"{self.path}: import outer chain loops")
            imp = self.imports[-outer - 1]

    def dependencies(self):
        """{package: {"hard": bool, "soft": bool, "game": bool}} - what this package references."""
        deps = {}

        def add(name, kind, game):
            if not name or name == "None":
                return
            entry = deps.setdefault(name, {"hard": False, "soft": False, "game": False})
            entry[kind] = True
            entry["game"] = entry["game"] or game

        for index in range(len(self.imports)):
            package = self.import_package(index)
            game = True if self.import_in_game is None else self.import_in_game[index]
            add(package, "hard", game)
        for index, package in enumerate(self.soft_refs):
            game = True if self.soft_in_game is None else self.soft_in_game[index]
            add(package, "soft", game)
        return deps

    def tag(self, key):
        for asset in self.assets:
            if key in asset["tags"]:
                return asset["tags"][key]
        return None

    def main_asset(self):
        """The asset whose object name equals the package's short name, else the first one."""
        short = Path(self.path).stem
        for asset in self.assets:
            if asset["object_path"].split(".")[-1] == short or asset["object_path"] == short:
                return asset
        return self.assets[0] if self.assets else None


def _bitarray(r):
    bits = r.i32()
    if bits < 0 or bits > 10_000_000:
        raise PackageError(f"{r.path}: implausible bit array size {bits}")
    words = (bits + 31) // 32
    values = []
    for _ in range(words):
        word = r.u32()
        for bit in range(32):
            if len(values) < bits:
                values.append(bool(word >> bit & 1))
    return values


def read_package(path, want_assets=True):
    path = Path(path)
    with open(path, "rb") as fh:
        if fh.seek(0, 2) < 32:
            raise PackageError(f"{path}: too small to be a package")
        # A memory map touches only the header pages; reading whole files makes a Content/ sweep IO-bound.
        with mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ) as data:
            return _parse(Reader(data, str(path)), path, want_assets)


def _parse(r, path, want_assets):
    p = Package(path)
    if r.u32() != PACKAGE_TAG:
        raise PackageError(f"{path}: not a package (bad tag)")
    legacy = r.i32()
    if legacy >= 0 or legacy < -9:
        raise PackageError(f"{path}: unsupported legacy file version {legacy}")
    if legacy != -4:
        r.i32()                                     # LegacyUE3Version
    p.ue4 = r.i32()
    p.ue5 = r.i32() if legacy <= -8 else 0
    licensee = r.i32()
    if not p.ue4 and not p.ue5 and not licensee:
        raise PackageError(f"{path}: unversioned package (cooked) - not readable offline")
    saved_hash = p.ue5 >= UE5_PACKAGE_SAVED_HASH
    if saved_hash:
        r.skip(20)                                  # FIoHash SavedHash
        r.i32()                                     # TotalHeaderSize
    if legacy <= -2:
        if legacy > -6:
            raise PackageError(f"{path}: legacy custom-version format {legacy} not supported")
        custom_count = r.i32()
        if not 0 <= custom_count <= 1024:
            raise PackageError(f"{path}: implausible custom version count {custom_count}")
        r.skip(custom_count * 20)                   # FGuid + int32 each
    if not saved_hash:
        r.i32()                                     # TotalHeaderSize
    r.fstring()                                     # PackageName (deprecated folder name)
    p.flags = r.u32()
    if p.flags & PKG_FILTER_EDITOR_ONLY:
        raise PackageError(f"{path}: cooked package (editor-only data filtered) - not readable offline")
    s = p.summary
    s["name_count"], s["name_offset"] = r.i32(), r.i32()
    if p.ue5 >= UE5_ADD_SOFTOBJECTPATH_LIST:
        r.i32(); r.i32()                            # SoftObjectPaths count/offset
    if p.ue4 >= UE4_LOCALIZATION_ID:
        r.fstring()                                 # LocalizationId (absent only when editor-only filtered)
    if p.ue4 >= UE4_SERIALIZE_TEXT_IN_PACKAGES:
        r.i32(); r.i32()                            # GatherableTextData count/offset
    s["export_count"], s["export_offset"] = r.i32(), r.i32()
    s["import_count"], s["import_offset"] = r.i32(), r.i32()
    if p.ue5 >= UE5_VERSE_CELLS:
        r.skip(16)                                  # cell export/import count/offset
    if p.ue5 >= UE5_METADATA_SERIALIZATION_OFFSET:
        r.i32()                                     # MetaDataOffset
    r.i32()                                         # DependsOffset
    s["soft_count"], s["soft_offset"] = 0, 0
    if p.ue4 >= UE4_STRING_ASSET_REFERENCES_MAP:
        s["soft_count"], s["soft_offset"] = r.i32(), r.i32()
    if p.ue4 >= UE4_ADDED_SEARCHABLE_NAMES:
        r.i32()                                     # SearchableNamesOffset
    r.i32()                                         # ThumbnailTableOffset
    if p.ue5 >= UE5_IMPORT_TYPE_HIERARCHIES:
        r.i32(); r.i32()
    if not saved_hash:
        r.skip(16)                                  # legacy package Guid
    if p.ue4 >= UE4_ADDED_PACKAGE_OWNER:
        r.skip(16)                                  # PersistentGuid
        if p.ue4 < UE4_NON_OUTER_PACKAGE_IMPORT:
            r.skip(16)                              # OwnerPersistentGuid
    generations = r.i32()
    if not 0 <= generations <= 100_000:
        raise PackageError(f"{path}: implausible generation count {generations}")
    r.skip(generations * 8)
    for present in (p.ue4 >= UE4_ENGINE_VERSION_OBJECT, p.ue4 >= UE4_COMPATIBLE_ENGINE_VERSION):
        if present:
            r.u16(); r.u16(); r.u16(); r.u32(); r.fstring()
        elif p.ue4 < UE4_ENGINE_VERSION_OBJECT:
            r.i32()
    r.u32()                                         # CompressionFlags
    if r.i32() != 0:
        raise PackageError(f"{path}: compressed chunks present - unsupported")
    r.u32()                                         # PackageSource
    for _ in range(r.i32()):                        # AdditionalPackagesToCook
        r.fstring()
    if legacy > -7:
        r.i32()                                     # NumTextureAllocations
    s["asset_registry_offset"] = r.i32()

    _read_names(r, p)
    _read_imports(r, p)
    _read_soft_refs(r, p)
    if want_assets:
        _read_asset_registry(r, p)
    return p


def _read_names(r, p):
    count, offset = p.summary["name_count"], p.summary["name_offset"]
    if not 0 <= offset < len(r.data) or not 0 <= count <= 2_000_000:
        raise PackageError(f"{r.path}: bad name table ({count} entries at {offset})")
    r.pos = offset
    for _ in range(count):
        p.names.append(r.fstring())
        if p.ue4 >= UE4_NAME_HASHES_SERIALIZED:
            r.skip(4)                               # two 16-bit hashes


def _fname(r, p):
    index = r.i32()
    number = r.i32()
    return p.name(index, number)


def _read_imports(r, p):
    count, offset = p.summary["import_count"], p.summary["import_offset"]
    if count == 0:
        return
    if not 0 < offset < len(r.data) or not 0 <= count <= 1_000_000:
        raise PackageError(f"{r.path}: bad import table ({count} at {offset})")
    r.pos = offset
    for _ in range(count):
        imp = {
            "class_package": _fname(r, p),
            "class_name": _fname(r, p),
            "outer": r.i32(),
            "object_name": _fname(r, p),
            "package_name": None,
        }
        if p.ue4 >= UE4_NON_OUTER_PACKAGE_IMPORT:
            imp["package_name"] = _fname(r, p)
        if p.ue5 >= UE5_OPTIONAL_RESOURCES:
            r.i32()                                 # bImportOptional
        p.imports.append(imp)


def _read_soft_refs(r, p):
    count, offset = p.summary["soft_count"], p.summary["soft_offset"]
    if count <= 0 or offset <= 0:
        return
    r.pos = offset
    for _ in range(count):
        p.soft_refs.append(_fname(r, p))


def _read_asset_registry(r, p):
    offset = p.summary["asset_registry_offset"]
    if offset <= 0 or offset >= len(r.data):
        return
    r.pos = offset
    dependency_offset = -1
    if p.ue4 >= UE4_ASSETREGISTRY_DEPENDENCYFLAGS:
        dependency_offset = r.i64()
    object_count = r.i32()
    if not 0 <= object_count <= 100_000:
        raise PackageError(f"{r.path}: implausible asset count {object_count}")
    for _ in range(object_count):
        object_path = r.fstring()
        object_class = r.fstring()
        tag_count = r.i32()
        if not 0 <= tag_count <= 100_000:
            raise PackageError(f"{r.path}: implausible tag count {tag_count}")
        tags = {}
        for _ in range(tag_count):
            key = r.fstring()
            tags[key] = r.fstring()
        p.assets.append({"object_path": object_path, "class": object_class, "tags": tags})
    if dependency_offset > 0:
        r.pos = dependency_offset
        p.import_in_game = _bitarray(r)
        p.soft_in_game = _bitarray(r)
        if len(p.import_in_game) != len(p.imports) or len(p.soft_in_game) != len(p.soft_refs):
            # Mismatch means the layout guess is wrong; drop the flags rather than mislabel dependencies.
            p.import_in_game = p.soft_in_game = None


# ---- file <-> package name -----------------------------------------------------------------------------------

PACKAGE_EXT = (".uasset", ".umap")


def find_project_root(start):
    """The directory of the nearest .uproject walking up from start; None when there is none."""
    here = Path(start).resolve()
    for d in [here, *here.parents]:
        if d.is_dir() and any(f.suffix.lower() == ".uproject" for f in d.iterdir() if f.is_file()):
            return d
    return None


def content_mounts(project_root, engine_root=None):
    """[(mount '/Game/', content dir)] for the project, every plugin under Plugins/ and (optionally) the engine."""
    root = Path(project_root)
    mounts = [("/Game/", root / "Content")]
    plugins = root / "Plugins"
    if plugins.is_dir():
        for uplugin in plugins.rglob("*.uplugin"):
            content = uplugin.parent / "Content"
            if content.is_dir():
                mounts.append((f"/{uplugin.stem}/", content))
    if engine_root:
        engine = Path(engine_root) / "Engine"
        mounts.append(("/Engine/", engine / "Content"))
        for uplugin in (engine / "Plugins").rglob("*.uplugin"):
            content = uplugin.parent / "Content"
            if content.is_dir():
                mounts.append((f"/{uplugin.stem}/", content))
    return mounts


def package_name_of(file, mounts):
    f = Path(file).resolve()
    for mount, content in mounts:
        try:
            rel = f.relative_to(content.resolve())
        except ValueError:
            continue
        return mount + rel.with_suffix("").as_posix()
    return None


def file_of(package, mounts):
    for mount, content in mounts:
        if package.lower().startswith(mount.lower()):
            rest = package[len(mount):]
            for ext in PACKAGE_EXT:
                candidate = content / (rest + ext)
                if candidate.is_file():
                    return candidate
    return None


def walk_packages(*dirs):
    for d in dirs:
        d = Path(d)
        if d.is_file():
            if d.suffix.lower() in PACKAGE_EXT:
                yield d
            continue
        for f in d.rglob("*"):
            if f.suffix.lower() in PACKAGE_EXT and f.is_file():
                yield f


_MSYS = re.compile(r"^[A-Za-z]:[\\/].*?[\\/]Git[\\/](.+)$")


def unmangle(arg):
    """Git Bash rewrites a leading-slash argument (/Game/X -> C:/Program Files/Git/Game/X) before a native
    program sees it. Undo that for arguments that are meant to be package paths."""
    m = _MSYS.match(arg)
    return "/" + m.group(1).replace("\\", "/") if m else arg
