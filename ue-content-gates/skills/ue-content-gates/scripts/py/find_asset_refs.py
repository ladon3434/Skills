r"""Which assets use a C++ symbol? Lists .uasset/.umap files whose FName table names it. Offline, no editor.

    find-asset-refs.cmd <Symbol> [<Symbol>...] [--in <dir>]... [--json] [--rename-to <NewName>]

<Symbol> forms:
    AMyActor / UMyComponent / FMyStruct   a reflected type; the C++ prefix (A/U/F) is dropped, because a package
                                           stores AMyActor as MyActor. EMyEnum keeps its E.
    MyActor                               a bare reflected name (also a property, function or Blueprint name)
    UMyComponent::Speed                   a member: files that name BOTH the type and the member
    /Script/MyModule                      a C++ module (every asset whose classes come from it)

Default search roots: the project's Content/ and every plugin's Content/ (nearest .uproject from the current
directory). Each hit says HOW the file uses the symbol:
    parent   the Blueprint's NativeParentClass / ParentClass is the type
    import   the package imports the type (it has an instance, a variable of it, a cast, a node calling into it)
    name     the name only appears in the table (a property, function, pin or tag of that name - confirm by
             opening the asset: a common word such as Speed matches unrelated packages)

A hit is evidence, not proof. Zero hits for a type is strong evidence that no content uses it - the content
half of a dead-code check; the C++ half is a source search. --rename-to prints the [CoreRedirects] lines a
rename needs so the listed assets keep loading.
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import uasset  # noqa: E402

TYPE_PREFIX = re.compile(r"^[AUF](?=[A-Z])")


def candidates(symbol):
    """(kind, [names to look for], member) for one CLI symbol."""
    symbol = uasset.unmangle(symbol)
    if symbol.lower().startswith("/script/"):
        return "module", [symbol], None
    owner, _, member = symbol.partition("::")
    names = [owner]
    if TYPE_PREFIX.match(owner):
        names.insert(0, owner[1:])
    kind = "member" if member else ("type" if TYPE_PREFIX.match(owner) or owner.startswith("E") else "name")
    return kind, names, member or None


def classify(p, names_lower, member_lower):
    table = {n.lower() for n in p.names}
    how = set()
    # The parent lives in an asset-registry tag string, not in the name table: a Blueprint whose parent is
    # another Blueprint still names its native ancestor there and nowhere else.
    for key in ("NativeParentClass", "ParentClass"):
        value = (p.tag(key) or "").lower()
        if any(value.endswith(f".{n}'") or value.endswith(f".{n}_c'") for n in names_lower):
            how.add("parent")
    if member_lower and member_lower not in table:
        return None
    if not how and not any(n in table for n in names_lower):
        return None
    modules = set()
    for imp in p.imports:
        if imp["object_name"].lower() in names_lower:
            how.add("import")
            if imp["outer"] < 0:
                outer = p.imports[-imp["outer"] - 1]["object_name"]
                if outer.startswith("/Script/"):
                    modules.add(outer)
    if not how:
        how.add("name")
    return sorted(how), sorted(modules)


def redirect_lines(symbol, kind, names, member, modules, new_name):
    module = modules[0] if modules else "/Script/<Module>"
    bare = names[0]
    new_bare = TYPE_PREFIX.sub("", new_name) if kind in ("type", "member") and TYPE_PREFIX.match(new_name) else new_name
    if kind == "module":
        return [f'+PackageRedirects=(OldName="{symbol}",NewName="{new_name}")']
    if kind == "member":
        return [f'+PropertyRedirects=(OldName="{bare}.{member}",NewName="{bare}.{new_name}")',
                f'+FunctionRedirects=(OldName="{bare}.{member}",NewName="{bare}.{new_name}")  ; if it is a UFUNCTION']
    owner = symbol.split("::")[0]
    if owner.startswith("F"):
        what = "StructRedirects"
    elif owner.startswith("E"):
        what = "EnumRedirects"
    else:
        what = "ClassRedirects"
    return [f'+{what}=(OldName="{module}.{bare}",NewName="{module}.{new_bare}")']


def default_roots():
    root = uasset.find_project_root(Path.cwd())
    if not root:
        raise SystemExit("find-asset-refs: no .uproject above the current directory - pass --in <Content dir>")
    return [c for _, c in uasset.content_mounts(root) if c.is_dir()]


def selftest():
    checks = [
        (candidates("AMyActor") == ("type", ["MyActor", "AMyActor"], None), "an actor class drops its A"),
        (candidates("FMyRow") == ("type", ["MyRow", "FMyRow"], None), "a struct drops its F"),
        (candidates("EMyMode")[1] == ["EMyMode"], "an enum keeps its E"),
        (candidates("UMyComp::Speed") == ("member", ["MyComp", "UMyComp"], "Speed"), "a member names its owner"),
        (candidates("/Script/MyGame")[0] == "module", "a module path"),
        (candidates("C:/Program Files/Git/Script/MyGame")[1] == ["/Script/MyGame"], "a Git Bash-mangled module path"),
        (candidates("Fire") == ("name", ["Fire"], None), "a plain word is not a type (no F + capital)"),
        (redirect_lines("UMyComp", "type", ["MyComp"], None, ["/Script/Game"], "UNewComp")
         == ['+ClassRedirects=(OldName="/Script/Game.MyComp",NewName="/Script/Game.NewComp")'], "class redirect"),
    ]
    failed = [what for ok, what in checks if not ok]
    for what in failed:
        print(f"FAIL: {what}")
    print("find-asset-refs selftest: " + ("ok" if not failed else f"{len(failed)} failure(s)"))
    return 1 if failed else 0


def main(argv):
    if "--selftest" in argv:
        return selftest()
    as_json = "--json" in argv
    roots, symbols, new_name = [], [], None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--in":
            roots.append(Path(argv[i + 1])); i += 2; continue
        if a == "--rename-to":
            new_name = uasset.unmangle(argv[i + 1]); i += 2; continue
        if not a.startswith("--"):
            symbols.append(uasset.unmangle(a))
        i += 1
    if not symbols:
        print(__doc__.strip())
        return 2
    if new_name and len(symbols) != 1:
        raise SystemExit("find-asset-refs: --rename-to takes exactly one symbol")
    roots = roots or default_roots()
    packages = list(uasset.walk_packages(*roots))
    report = []
    unreadable = []
    parsed = []
    for f in packages:
        try:
            parsed.append(uasset.read_package(f))
        except (uasset.PackageError, OSError) as e:
            unreadable.append(f"{f}: {e}")
    for symbol in symbols:
        kind, names, member = candidates(symbol)
        names_lower = {n.lower() for n in names}
        member_lower = member.lower() if member else None
        hits, modules = [], set()
        for p in parsed:
            found = classify(p, names_lower, member_lower)
            if found:
                how, mods = found
                modules.update(mods)
                main_asset = p.main_asset()
                hits.append({"file": p.path, "how": how, "class": main_asset["class"] if main_asset else None})
        row = {"symbol": symbol, "looked_for": names + ([member] if member else []), "hits": hits,
               "modules": sorted(modules)}
        if new_name:
            row["core_redirects"] = redirect_lines(uasset.unmangle(symbol), kind, names, member, sorted(modules), new_name)
        report.append(row)
        if not as_json:
            print(f"=== {symbol} ({kind}; names {', '.join(row['looked_for'])}) :: {len(hits)} package(s)")
            for h in sorted(hits, key=lambda h: h["file"]):
                print(f"  {'+'.join(h['how']):12} {h['file']}  [{(h['class'] or '?').split('.')[-1]}]")
            if new_name:
                print("  [CoreRedirects] in Config/DefaultEngine.ini:")
                for line in row["core_redirects"]:
                    print(f"    {line}")
    if as_json:
        print(json.dumps({"scanned": len(packages), "unreadable": unreadable, "symbols": report}, indent=1))
    else:
        print(f"scanned {len(packages)} package(s) under {', '.join(str(r) for r in roots)}")
        if unreadable:
            print(f"UNREADABLE {len(unreadable)} package(s) - their use of the symbol is unknown:")
            for u in unreadable[:20]:
                print(f"  {u}")
    return 1 if unreadable else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
