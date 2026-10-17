r"""Forbidden-reference gate for content: no package may reference a package under a forbidden prefix.

    ref-lint.cmd [<package|dir>...]                       rules from <project>/.claude/content-gates.json
    ref-lint.cmd --forbid /Engine/ [--allow /Engine/EngineSky/]... [--maps-only] [--game-only] [<package|dir>...]
    ref-lint.cmd --config <file.json> ...  |  --selftest  |  --print-config

Without package arguments every package of the project is judged (Content/ and each plugin's Content/).
References are read from the package header - the import table (hard) and the soft package list (soft) -
with the asset registry's game / editor-only flag, so a reference is reported with its kind. Offline, no editor.

Fail-closed: an unreadable package is a failure, not a skip - a check that cannot run must not read as clean.

Typical rules (see the skill's references/config.md):
  - /Game/Developers/  - a per-user sandbox; shipped content that points into it breaks for everyone else.
  - a quarantine or scratch folder that is gitignored or deletable.
  - /Engine/ content in levels when the project's rule is "own assets only" (allow-list the engine
    materials and editor sprites a template brings).
A package that lives under the forbidden prefix itself is not judged: the sandbox may reference itself.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import uasset  # noqa: E402

CONFIG_NAME = Path(".claude") / "content-gates.json"
DEFAULT_RULES = [{
    "prefix": "/Game/Developers/",
    "why": "per-user sandbox content; a reference from shared content breaks on every other machine and in a build",
}]


def load_rules(project_root, config_path=None):
    path = Path(config_path) if config_path else (project_root / CONFIG_NAME if project_root else None)
    if path and path.is_file():
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        rules = data.get("forbiddenRefs")
        if rules is None:
            return DEFAULT_RULES, f"{path} (no forbiddenRefs - defaults)"
        return rules, str(path)
    if config_path:
        raise SystemExit(f"ref-lint: config not found: {config_path}")
    return DEFAULT_RULES, "built-in defaults"


def violations(package_name, is_map, deps, rules):
    """[(rule, referenced package, dep flags)] for one package. Pure."""
    out = []
    lname = (package_name or "").lower()
    for rule in rules:
        prefix = rule["prefix"].lower()
        if lname.startswith(prefix):
            continue
        if rule.get("from") and not any(lname.startswith(f.lower()) for f in rule["from"]):
            continue
        kinds = rule.get("kinds")
        if kinds and ("map" if is_map else "asset") not in kinds:
            continue
        allow = [a.lower() for a in rule.get("allow", [])]
        for ref, flags in deps.items():
            lref = ref.lower()
            if not lref.startswith(prefix) or any(lref.startswith(a) for a in allow):
                continue
            if rule.get("gameOnly") and not flags["game"]:
                continue
            out.append((rule, ref, flags))
    return out


def selftest():
    dep = lambda game=True, soft=False: {"hard": not soft, "soft": soft, "game": game}  # noqa: E731
    rules = [{"prefix": "/Game/Developers/"},
             {"prefix": "/Engine/", "kinds": ["map"], "allow": ["/Engine/EngineSky/"]},
             {"prefix": "/Game/_Scratch/", "gameOnly": True, "from": ["/Game/Maps/"]}]
    cases = [
        (("/Game/Maps/A", True, {"/Game/Developers/me/SM_X": dep()}), 1, "a sandbox reference is refused"),
        (("/Game/Developers/me/BP_Y", False, {"/Game/Developers/me/SM_X": dep()}), 0, "the sandbox may reference itself"),
        (("/Game/Maps/A", True, {"/Engine/BasicShapes/Cube": dep()}), 1, "engine content in a map is refused"),
        (("/Game/Props/B", False, {"/Engine/BasicShapes/Cube": dep()}), 0, "the map-only rule leaves assets alone"),
        (("/Game/Maps/A", True, {"/Engine/EngineSky/SM_Sky": dep()}), 0, "an allow-listed prefix passes"),
        (("/Game/Maps/A", True, {"/Game/_Scratch/T": dep(game=False)}), 0, "gameOnly ignores an editor-only reference"),
        (("/Game/Maps/A", True, {"/Game/_Scratch/T": dep(soft=True)}), 1, "a soft game reference counts"),
        (("/Game/Props/C", False, {"/Game/_Scratch/T": dep()}), 0, "a rule scoped by from judges only those packages"),
        (("/Game/Maps/A", True, {"/game/developers/me/x": dep()}), 1, "package names compare case-blind"),
    ]
    failed = 0
    for (name, is_map, deps), expected, what in cases:
        got = len(violations(name, is_map, deps, rules))
        if got != expected:
            failed += 1
            print(f"FAIL: {what} (expected {expected}, got {got})")
    print("ref-lint selftest: " + ("ok" if not failed else f"{failed} failure(s)"))
    return 1 if failed else 0


def main(argv):
    if "--selftest" in argv:
        return selftest()
    root = uasset.find_project_root(Path.cwd())
    config, adhoc, targets = None, None, []
    allow, maps_only, game_only = [], "--maps-only" in argv, "--game-only" in argv
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--config", "--forbid", "--allow"):
            value = uasset.unmangle(argv[i + 1])
            if a == "--config":
                config = value
            elif a == "--forbid":
                adhoc = value
            else:
                allow.append(value)
            i += 2
            continue
        if not a.startswith("--"):
            targets.append(Path(a))
        i += 1
    if adhoc:
        rule = {"prefix": adhoc, "allow": allow, "gameOnly": game_only}
        if maps_only:
            rule["kinds"] = ["map"]
        rules, source = [rule], "command line"
    else:
        rules, source = load_rules(root, config)
    if "--print-config" in argv:
        print(json.dumps({"source": source, "forbiddenRefs": rules}, indent=1))
        return 0
    if not root and not targets:
        raise SystemExit("ref-lint: no .uproject above the current directory - pass package files or dirs")
    mounts = uasset.content_mounts(root) if root else []
    dirs = targets or [c for _, c in mounts if c.is_dir()]
    files = sorted(uasset.walk_packages(*dirs))
    if not files:
        print(f"FAIL ref-lint: no package found under {', '.join(map(str, dirs))}")
        return 1
    findings, unreadable = [], []
    for f in files:
        name = uasset.package_name_of(f, mounts) if mounts else None
        try:
            p = uasset.read_package(f)
        except (uasset.PackageError, OSError) as e:
            unreadable.append(f"{f}: {e}")
            continue
        for rule, ref, flags in violations(name or str(f), p.is_map, p.dependencies(), rules):
            findings.append((name or str(f), ref, flags, rule))
    for pkg, ref, flags, rule in findings:
        kind = "+".join(k for k in ("hard", "soft") if flags[k])
        scope = "game" if flags["game"] else "editor-only"
        print(f"FAIL {pkg} -> {ref}  [{kind}, {scope}]  ({rule.get('why') or 'forbidden prefix ' + rule['prefix']})")
    for u in unreadable:
        print(f"FAIL unreadable {u}")
    rule_list = ", ".join(r["prefix"] + (" (maps)" if r.get("kinds") == ["map"] else "") for r in rules)
    if findings or unreadable:
        print(f"ref-lint: {len(findings)} forbidden reference(s), {len(unreadable)} unreadable package(s) in {len(files)} package(s); rules [{rule_list}] from {source}")
        return 1
    print(f"ref-lint: {len(files)} package(s), no forbidden reference; rules [{rule_list}] from {source}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
