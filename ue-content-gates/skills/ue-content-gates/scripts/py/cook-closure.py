# The dependency closure of a set of packages, as the editor's asset registry sees it - what a cooked game
# must carry for those packages to arrive whole. Run by cook-check.mjs --editor-closure through the
# pythonscript commandlet (runs INSIDE the editor; needs the Python Editor Script Plugin):
#   UnrealEditor-Cmd <uproject> -run=pythonscript -script="cook-closure.py <out.json> <package|folder/> ..."
# Writes {mode, roots, packages: {name: {class, from}}, unresolved: [...]} to <out.json> - the same shape as
# offline_closure.py, which reads the same data from package headers without an editor.
#
# Hard AND soft package references are followed: a soft reference is exactly the kind a cook can drop, and
# leaving it out would count the losses this check exists to find as "not expected". /Script/ packages are code,
# never cooked content, and are skipped. `from` names one referencer, so a missing package says who wanted it.
# A root ending in "/" is a folder: every package under it is a root.

import json
import sys

import unreal

args = sys.argv[1:]
out_path, raw_roots = args[0], args[1:]

registry = unreal.AssetRegistryHelpers.get_asset_registry()
registry.search_all_assets(True)
options = unreal.AssetRegistryDependencyOptions(
    include_soft_package_references=True,
    include_hard_package_references=True,
    include_searchable_names=False,
    include_soft_management_references=False,
    include_hard_management_references=False,
)

roots = []
for root in raw_roots:
    if root.endswith("/"):
        for data in registry.get_assets_by_path(root.rstrip("/"), recursive=True):
            roots.append(str(data.package_name))
    else:
        roots.append(root)


def asset_class(package):
    assets = registry.get_assets_by_package_name(package, include_only_on_disk_assets=True)
    return str(assets[0].asset_class_path.asset_name) if assets else ""


packages = {}
unresolved = []
stack = [(root, "") for root in roots]
while stack:
    name, referencer = stack.pop()
    if name in packages or name.startswith("/Script/"):
        continue
    cls = asset_class(name)
    if not cls:
        unresolved.append({"package": name, "from": referencer})
    packages[name] = {"class": cls, "from": referencer}
    for dep in registry.get_dependencies(name, options) or []:
        stack.append((str(dep), name))

with open(out_path, "w", encoding="utf-8") as f:
    json.dump({"mode": "editor", "roots": roots, "packages": packages, "unresolved": unresolved}, f, indent=1)
unreal.log("cook-closure: {} package(s) from {} root(s), {} unresolved -> {}".format(len(packages), len(roots), len(unresolved), out_path))
