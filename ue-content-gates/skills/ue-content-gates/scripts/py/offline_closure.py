r"""Offline dependency closure of a set of packages - what a cooked game must carry for them to arrive whole.

    python offline_closure.py <out.json> [--project <dir>] [--engine <UnrealHome>] [--all-refs] <root> [<root>...]

A <root> is a package name (/Game/Maps/Title) or a folder (/Game/Always/ - every package under it).
Same JSON shape as cook-closure.py (the editor's asset-registry version):
    {"mode": "offline", "roots": [...], "packages": {name: {"class", "from", "file"}}, "unresolved": [...]}

Follows hard (import table) and soft (soft package list) references read from each package header. By default
only references the asset registry marks as used in game - what the cooker follows; --all-refs also follows
editor-only ones. /Script/ packages are code and are skipped. A World Partition map also pulls its
__ExternalActors__ / __ExternalObjects__ packages. Engine and engine-plugin content is followed when --engine is
given; otherwise an /Engine/ reference is recorded as a leaf with an empty class but not as unresolved.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import uasset  # noqa: E402

EXTERNAL_FOLDERS = ("__ExternalActors__", "__ExternalObjects__")


def expand_root(root, mounts):
    """A package name stays; a folder (ends with /) becomes every package under it."""
    if not root.endswith("/"):
        return [root.split(".")[0]]
    for mount, content in mounts:
        if root.lower().startswith(mount.lower()):
            folder = content / root[len(mount):]
            return sorted(uasset.package_name_of(f, mounts) for f in uasset.walk_packages(folder)) if folder.is_dir() else []
    return []


def external_packages(package, mounts):
    for mount, content in mounts:
        if package.lower().startswith(mount.lower()):
            rel = package[len(mount):]
            out = []
            for folder in EXTERNAL_FOLDERS:
                d = content / folder / rel
                if d.is_dir():
                    out.extend(uasset.package_name_of(f, mounts) for f in uasset.walk_packages(d))
            return out
    return []


def closure(roots, mounts, game_only=True, engine_known=True):
    packages, unresolved = {}, []
    stack = [(r, "") for r in roots]
    while stack:
        name, referencer = stack.pop()
        key = name.lower()
        if key in packages or key.startswith("/script/"):
            continue
        f = uasset.file_of(name, mounts)
        if not f:
            leaf = not engine_known and key.startswith("/engine/")
            packages[key] = {"name": name, "class": "", "from": referencer, "file": None}
            if not leaf:
                unresolved.append({"package": name, "from": referencer})
            continue
        try:
            p = uasset.read_package(f)
        except (uasset.PackageError, OSError) as e:
            packages[key] = {"name": name, "class": "", "from": referencer, "file": str(f), "error": str(e)}
            unresolved.append({"package": name, "from": referencer, "error": str(e)})
            continue
        main = p.main_asset()
        packages[key] = {"name": name, "class": (main["class"].split(".")[-1] if main else "?"), "from": referencer, "file": str(f)}
        for dep, flags in p.dependencies().items():
            if game_only and not flags["game"]:
                continue
            stack.append((dep, name))
        if p.is_map:
            for ext in external_packages(name, mounts):
                stack.append((ext, name))
    return {v["name"]: {k: v[k] for k in v if k != "name"} for v in packages.values()}, unresolved


def main(argv):
    if len(argv) < 2:
        print(__doc__.strip())
        return 2
    out_path = Path(argv[0])
    project, engine, roots, game_only = None, None, [], "--all-refs" not in argv
    i = 1
    while i < len(argv):
        a = argv[i]
        if a in ("--project", "--engine"):
            if a == "--project":
                project = Path(argv[i + 1])
            else:
                engine = argv[i + 1]
            i += 2
            continue
        if not a.startswith("--"):
            roots.append(uasset.unmangle(a))
        i += 1
    project = project or uasset.find_project_root(Path.cwd())
    if not project:
        raise SystemExit("offline_closure: no .uproject found - pass --project")
    mounts = uasset.content_mounts(project, engine)
    expanded = []
    for r in roots:
        expanded.extend(expand_root(r, mounts))
    packages, unresolved = closure(expanded, mounts, game_only, engine_known=bool(engine))
    result = {"mode": "offline", "game_only": game_only, "roots": expanded, "packages": packages, "unresolved": unresolved}
    out_path.write_text(json.dumps(result, indent=1), encoding="utf-8")
    print(f"offline-closure: {len(packages)} package(s) from {len(expanded)} root(s), {len(unresolved)} unresolved -> {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
