r"""Read .uasset/.umap headers offline: FName table, asset class, Blueprint parent, dependencies.

No editor, no lock, no cook: it answers while an editor is busy or closed.

    package-names.cmd <package...>              the FName table, one name per line
    package-names.cmd --info <package...>       asset class, NativeParentClass/ParentClass, map flag, counts
    package-names.cmd --parents <package...>    NativeParentClass only (tab-separated, for scripts)
    package-names.cmd --deps [--game] <package...>
                                                packages this one references: hard/soft, game/editor-only
    package-names.cmd --selftest

A <package> is a file path (.uasset/.umap) or a package name (/Game/X/Y, /<Plugin>/X) resolved against the
project found from the current directory (nearest .uproject). Add --json for machine output.

Why a name table is useful: it holds every identifier the package serialized - variable and function names,
referenced classes (WITHOUT their C++ prefix: AMyActor is stored as MyActor), struct and enum names, module
paths (/Script/<Module>). Two tables' intersection is the vocabulary a reparent or a rename has to keep.
The import table lists every referenced class, so a cast and an inheritance look alike there; the parent of a
Blueprint is the asset-registry tag NativeParentClass (and ParentClass for a Blueprint parent).
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import uasset  # noqa: E402


def resolve_targets(args):
    root = uasset.find_project_root(Path.cwd())
    mounts = uasset.content_mounts(root) if root else []
    out = []
    for raw in args:
        arg = uasset.unmangle(raw)
        if Path(arg).is_file():
            out.append(Path(arg))
            continue
        if arg.startswith("/") and mounts:
            hit = uasset.file_of(arg.split(".")[0], mounts)
            if hit:
                out.append(hit)
                continue
        p = Path(arg)
        if p.is_dir():
            out.extend(sorted(uasset.walk_packages(p)))
            continue
        raise SystemExit(f"package-names: not a package file or a resolvable package name: {raw}")
    return out


def info(p):
    main = p.main_asset()
    return {
        "file": p.path,
        "class": main["class"] if main else None,
        "native_parent": p.tag("NativeParentClass"),
        "parent": p.tag("ParentClass"),
        "is_map": p.is_map,
        "ue4": p.ue4,
        "ue5": p.ue5,
        "names": len(p.names),
        "imports": len(p.imports),
        "soft_refs": len(p.soft_refs),
        "assets": [a["object_path"] + " : " + a["class"] for a in p.assets],
    }


def selftest():
    import struct
    import tempfile

    def fstr(s):
        b = s.encode() + b"\0"
        return struct.pack("<i", len(b)) + b

    names = ["/Script/CoreUObject", "Package", "/Game/Other", "Class", "None", "Thing"]
    # Build a minimal 5.8-layout package: summary, names, one import of /Game/Other, one soft ref, AR block.
    def build(offsets):
        name_off, imp_off, soft_off, ar_off, dep_off = offsets
        s = struct.pack("<Ii", uasset.PACKAGE_TAG, -9) + struct.pack("<i", 0)
        s += struct.pack("<iii", 522, 1018, 0) + b"\0" * 20 + struct.pack("<i", 0)
        s += struct.pack("<i", 0) + fstr("None") + struct.pack("<I", 0)
        s += struct.pack("<ii", len(names), name_off) + struct.pack("<ii", 0, 0) + fstr("")
        s += struct.pack("<ii", 0, 0) + struct.pack("<ii", 0, 0) + struct.pack("<ii", 1, imp_off)
        s += b"\0" * 16 + struct.pack("<i", 0) + struct.pack("<i", 0)
        s += struct.pack("<ii", 1, soft_off) + struct.pack("<i", 0) + struct.pack("<i", 0)
        s += struct.pack("<ii", 0, 0) + b"\0" * 16 + struct.pack("<i", 0)
        for _ in range(2):
            s += struct.pack("<HHHI", 5, 8, 0, 0) + fstr("")
        s += struct.pack("<I", 0) + struct.pack("<i", 0) + struct.pack("<I", 0) + struct.pack("<i", 0)
        s += struct.pack("<i", ar_off)
        return s

    head = build((0, 0, 0, 0, 0))
    name_off = len(head)
    nt = b"".join(fstr(n) + b"\0\0\0\0" for n in names)
    imp_off = name_off + len(nt)
    imp = struct.pack("<iiiiiii", 0, 0, 1, 0, 0, 2, 0) + struct.pack("<ii", 4, 0) + struct.pack("<i", 0)
    soft_off = imp_off + len(imp)
    soft = struct.pack("<ii", 5, 0)
    ar_off = soft_off + len(soft)
    ar_body = fstr("Thing") + fstr("/Script/Engine.Blueprint") + struct.pack("<i", 1) + fstr("NativeParentClass") + fstr("/Script/CoreUObject.Class'/Script/Engine.Actor'")
    dep_off = ar_off + 8 + 4 + len(ar_body)
    ar = struct.pack("<q", dep_off) + struct.pack("<i", 1) + ar_body
    deps = struct.pack("<iI", 1, 0) + struct.pack("<iI", 1, 1)
    data = build((name_off, imp_off, soft_off, ar_off, dep_off)) + nt + imp + soft + ar + deps
    assert len(build((1, 1, 1, 1, 1))) == len(head)
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "Thing.uasset"
        f.write_bytes(data)
        p = uasset.read_package(f)
        checks = [
            (p.names == names, "name table read in order"),
            (p.dependencies() == {"/Game/Other": {"hard": True, "soft": False, "game": False},
                                   "Thing": {"hard": False, "soft": True, "game": True}}, "hard import editor-only, soft ref in game"),
            (p.main_asset()["class"] == "/Script/Engine.Blueprint", "asset class from the registry block"),
            (p.tag("NativeParentClass").endswith("'/Script/Engine.Actor'"), "NativeParentClass tag"),
            (uasset.unmangle("C:/Program Files/Git/Game/Maps/A") == "/Game/Maps/A", "Git Bash path mangling undone"),
            (uasset.unmangle("/Game/Maps/A") == "/Game/Maps/A", "a clean path stays"),
        ]
    failed = [what for ok, what in checks if not ok]
    for what in failed:
        print(f"FAIL: {what}")
    print("package-names selftest: " + ("ok" if not failed else f"{len(failed)} failure(s)"))
    return 1 if failed else 0


def main(argv):
    if "--selftest" in argv:
        return selftest()
    as_json = "--json" in argv
    mode = next((m for m in ("--info", "--parents", "--deps") if m in argv), "--names")
    game_only = "--game" in argv
    args = [a for a in argv if not a.startswith("--")]
    if not args:
        print(__doc__.strip())
        return 2
    results = []
    status = 0
    for target in resolve_targets(args):
        try:
            p = uasset.read_package(target, want_assets=mode != "--names")
        except (uasset.PackageError, OSError) as e:
            print(f"ERROR {e}", file=sys.stderr)
            status = 1
            continue
        if mode == "--names":
            results.append({"file": p.path, "names": p.names})
            if not as_json:
                print(f"=== {p.path} :: {len(p.names)} names")
                print("\n".join(p.names))
        elif mode == "--parents":
            parent = p.tag("NativeParentClass")
            results.append({"file": p.path, "native_parent": parent})
            if not as_json:
                print(f"{parent or '<none>'}\t{p.path}")
        elif mode == "--info":
            row = info(p)
            results.append(row)
            if not as_json:
                print(f"=== {p.path}")
                for k in ("class", "native_parent", "parent", "is_map", "names", "imports", "soft_refs"):
                    print(f"  {k:14} {row[k]}")
                print(f"  {'version':14} UE4 {p.ue4} / UE5 {p.ue5}")
        else:
            deps = {k: v for k, v in sorted(p.dependencies().items()) if v["game"] or not game_only}
            results.append({"file": p.path, "deps": deps})
            if not as_json:
                print(f"=== {p.path} :: {len(deps)} package(s)")
                for name, d in deps.items():
                    kind = "+".join(k for k in ("hard", "soft") if d[k])
                    print(f"  {kind:9} {'game' if d['game'] else 'editor-only':11} {name}")
    if as_json:
        print(json.dumps(results, indent=1))
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
