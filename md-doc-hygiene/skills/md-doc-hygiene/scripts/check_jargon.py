#!/usr/bin/env python
"""Jargon checker: words a project swept out of its documents must not creep back.

The word list is the project's, not this script's: <project>/.claude/md-doc-hygiene/jargon.json

    {
      "paths": ["Docs/Design"],                         # default folders, relative to the project root
      "rules": [
        {"pattern": "[Пп]опап\\\\w*", "hint": "всплывающее окно"},
        {"pattern": "[Фф]лаг\\\\w*", "hint": "признак", "unless": "под\\\\s+флаг"}
      ]
    }

`pattern` and `unless` are Python regular expressions; `unless` is looked for around the match (12 characters
before, 6 after) and, when found, the match is not reported. Fenced code is skipped. Every hit is an error:
replace the word, or, if it has to stay, add an exception to the project's list.

Checks (hard errors):
  [JRG] a word from the list is in the text

Usage:
    python check_jargon.py [<docs dir> ...] [--config <jargon.json>]
    Without a docs dir: the config's "paths". Exit 0 clean, 1 hits, 2 no config / bad config.
"""
import argparse
import json
import os
import re
import sys

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

CONFIG_REL = os.path.join(".claude", "md-doc-hygiene", "jargon.json")
FENCE = re.compile(r"^\s*(```|~~~)")


def find_config(start):
    d = os.path.abspath(start)
    while True:
        cand = os.path.join(d, CONFIG_REL)
        if os.path.isfile(cand):
            return cand
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def load_rules(config_path):
    with open(config_path, encoding="utf-8") as f:
        cfg = json.load(f)
    rules = []
    for r in cfg.get("rules", []):
        rules.append((re.compile(r["pattern"]), r.get("hint", ""), re.compile(r["unless"]) if r.get("unless") else None))
    return cfg, rules


def scan(base, rules, shown_root):
    found = 0
    files = [base] if os.path.isfile(base) else [os.path.join(r, f) for r, _, fs in os.walk(base) for f in sorted(fs) if f.endswith(".md")]
    for path in sorted(files):
        rel = os.path.relpath(path, shown_root).replace("\\", "/")
        in_fence = False
        with open(path, encoding="utf-8") as fh:
            for no, line in enumerate(fh, 1):
                if FENCE.match(line):
                    in_fence = not in_fence
                    continue
                if in_fence:
                    continue
                for pattern, hint, unless in rules:
                    for m in pattern.finditer(line):
                        if unless and unless.search(line[max(0, m.start() - 12):m.end() + 6]):
                            continue
                        print('[JRG] %s:%d  "%s" - write: %s' % (rel, no, m.group(0), hint))
                        found += 1
    return found


def main():
    ap = argparse.ArgumentParser(description="words a project swept out of its docs")
    ap.add_argument("docs", nargs="*")
    ap.add_argument("--config")
    args = ap.parse_args()
    config = args.config or find_config(args.docs[0] if args.docs else os.getcwd())
    if not config:
        print("Error: no %s above %s - this project keeps no jargon list." % (CONFIG_REL, args.docs[0] if args.docs else os.getcwd()))
        return 2
    try:
        cfg, rules = load_rules(config)
    except (OSError, ValueError, KeyError, re.error) as e:
        print("Error: bad jargon config %s: %s" % (config, e))
        return 2
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(config))))
    targets = [os.path.abspath(d) for d in args.docs] or [os.path.join(root, p) for p in cfg.get("paths", [])]
    missing = [t for t in targets if not os.path.exists(t)]
    if not targets or missing:
        print("Error: nothing to scan%s" % (": missing " + ", ".join(missing) if missing else " (no paths in the config)"))
        return 2
    found = sum(scan(t, rules, root) for t in targets)
    print("")
    if found:
        print("[FAILED] %d jargon word(s). Replace, or - if the word has to stay - ask and add an exception to %s." % (found, os.path.relpath(config, root)))
        return 1
    print("[SUCCESS] No listed jargon (%d rule(s), %s)." % (len(rules), os.path.relpath(config, root)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
