#!/usr/bin/env python
"""Numbered series checker: headings that carry an ID ("## Q12. ...") stay a clean run, and text that names an ID
by number names one that exists.

Some documents number their sections on purpose - a register of questions, decisions, requirements - and people
quote the number ("see Q12"). Nothing else checks such numbers: a duplicate or a gap goes unnoticed, and a card that
promises "the next free one is Q15" goes stale the moment someone else takes Q15.

The series are the project's, not this script's: <project>/.claude/md-doc-hygiene/series.json

    {
      "series": [
        {
          "name": "Layer 20 questions",
          "file": "Docs/Design/Questions.md",           # the register, relative to the project root
          "heading": "^#{2,6} Q(\\\\d+)\\\\.",            # group 1 = the number
          "mention": "\\\\bQ(\\\\d+)\\\\b",                # how the text names an ID; group 1 = the number
          "paths": ["Docs/Design", "Docs/Tracker"],     # where mentions are looked for (default: the register)
          "skip": ["Docs/Tracker/Done", "Docs/Tracker/Cancelled"],
          "unless": "History",                          # optional: a mention with this around it is not reported
          "start": 1                                    # optional: the first number, default 1
        }
      ]
    }

`heading`, `mention` and `unless` are Python regular expressions; `unless` is looked for in the same line.
Mentions inside [[wiki links]], inline code and fenced code are not checked: a link to the heading is held by
check_md_structure ([ANC]), and code is quoted, not prose.

Checks:
  [SEQ ] (error)   the register's numbers repeat, skip one, or run out of order
  [GONE] (error)   the text names a number the register does not have - a stale promise or a typo
  [BARE] (warning) the text names an existing number as plain text - make it a link, so a renumbering breaks
                   loudly instead of pointing at the wrong item

Usage:
    python check_series.py [--config <series.json>] [--strict]
    --strict makes [BARE] an error. Exit 0 clean, 1 errors, 2 no config / bad config.
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

CONFIG_REL = os.path.join(".claude", "md-doc-hygiene", "series.json")
FENCE = re.compile(r"^\s*(```|~~~)")
WIKI_LINK = re.compile(r"\[\[[^\]\n]*\]\]")
INLINE_CODE = re.compile(r"`[^`\n]*`")


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


def prose_lines(path):
    """(line number, text) outside fenced code."""
    inside = False
    with open(path, encoding="utf-8") as fh:
        for no, line in enumerate(fh, 1):
            if FENCE.match(line):
                inside = not inside
                continue
            if not inside:
                yield no, line.rstrip("\n")


def md_files(target, skip):
    if os.path.isfile(target):
        found = [target]
    else:
        found = [os.path.join(r, f) for r, _, fs in os.walk(target) for f in fs if f.endswith(".md")]
    skip = [same(s) for s in skip]
    found = [os.path.normpath(p) for p in found]
    return sorted(p for p in found if not any(same(p) == s or same(p).startswith(s + os.sep) for s in skip))


def same(path):
    """A path in the form two spellings of one file agree on (slashes, and case on Windows)."""
    return os.path.normcase(os.path.normpath(path))


def check_register(series, register, root):
    """Returns (numbers in the register, error count)."""
    rel = os.path.relpath(register, root).replace("\\", "/")
    heading = series["heading"]
    start = int(series.get("start", 1))
    seen, errors, expected = {}, 0, start
    for no, line in prose_lines(register):
        m = heading.search(line)
        if not m:
            continue
        num = int(m.group(1))
        if num in seen:
            print("[SEQ ] %s:%d  %s %d repeats the one on line %d" % (rel, no, series["name"], num, seen[num]))
            errors += 1
        elif num != expected:
            print("[SEQ ] %s:%d  %s %d - expected %d" % (rel, no, series["name"], num, expected))
            errors += 1
        seen.setdefault(num, no)
        expected = max(expected, num + 1)
    return set(seen), errors


def check_mentions(series, numbers, files, register, root, strict):
    errors, warnings = 0, 0
    for path in files:
        rel = os.path.relpath(path, root).replace("\\", "/")
        for no, line in prose_lines(path):
            if same(path) == same(register) and series["heading"].search(line):
                continue
            if series["unless"] and series["unless"].search(line):
                continue
            text = INLINE_CODE.sub(" ", WIKI_LINK.sub(" ", line))
            for m in series["mention"].finditer(text):
                num = int(m.group(1))
                if num not in numbers:
                    print("[GONE] %s:%d  \"%s\" - %s has no such number" % (rel, no, m.group(0), series["name"]))
                    errors += 1
                elif strict:
                    print("[BARE] %s:%d  \"%s\" - plain text, link the heading" % (rel, no, m.group(0)))
                    errors += 1
                else:
                    print("[BARE] %s:%d  \"%s\" - plain text, link the heading (warning)" % (rel, no, m.group(0)))
                    warnings += 1
    return errors, warnings


def load(config):
    with open(config, encoding="utf-8") as f:
        cfg = json.load(f)
    out = []
    for s in cfg.get("series", []):
        out.append({
            "name": s["name"],
            "file": s["file"],
            "heading": re.compile(s["heading"]),
            "mention": re.compile(s["mention"]),
            "paths": s.get("paths") or [s["file"]],
            "skip": s.get("skip", []),
            "unless": re.compile(s["unless"]) if s.get("unless") else None,
            "start": s.get("start", 1),
        })
    if not out:
        raise ValueError("no series in the config")
    return out


def main():
    ap = argparse.ArgumentParser(description="numbered heading series and the mentions of their numbers")
    ap.add_argument("--config")
    ap.add_argument("--strict", action="store_true", help="a plain-text mention of an existing number is an error")
    args = ap.parse_args()
    config = args.config or find_config(os.getcwd())
    if not config:
        print("Error: no %s above %s - this project keeps no numbered series." % (CONFIG_REL, os.getcwd()))
        return 2
    try:
        all_series = load(config)
    except (OSError, ValueError, KeyError, re.error) as e:
        print("Error: bad series config %s: %s" % (config, e))
        return 2
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(config))))

    errors, warnings = 0, 0
    for s in all_series:
        register = os.path.normpath(os.path.join(root, s["file"]))
        targets = [os.path.join(root, p) for p in s["paths"]]
        missing = [t for t in [register] + targets if not os.path.exists(t)]
        if missing:
            print("Error: %s - missing %s" % (s["name"], ", ".join(missing)))
            return 2
        numbers, e = check_register(s, register, root)
        errors += e
        skip = [os.path.join(root, p) for p in s["skip"]]
        files = sorted({same(f): f for t in targets for f in md_files(t, skip)}.values())
        e, w = check_mentions(s, numbers, files, register, root, args.strict)
        errors += e
        warnings += w

    print("")
    if errors:
        print("[FAILED] %d problem(s), %d warning(s)." % (errors, warnings))
        return 1
    print("[SUCCESS] %d series clean, %d warning(s) to eyeball (%s)."
          % (len(all_series), warnings, os.path.relpath(config, root)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
