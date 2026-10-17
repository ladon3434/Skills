#!/usr/bin/env python
"""Glossary checker: a Term is defined once, in its home chapter, with its anchor in the Terms section.

For documents that keep per-chapter glossaries: each chapter may hold a Terms section (a heading such as
«## Terms») with entries `- **Name**: definition`. The convention it guards:

  1. A Term is defined ONCE, in its home chapter. Elsewhere: a link («definition — see …»), not a second definition.
  2. A Term's anchor (e.g. ^t-name) is declared inside the Terms section, never in the middle of the rules.
     Catalogue chapters, where a card itself is the definition, are exempt.
  3. A definition answers "what is this" in a sentence or two plus a link: mechanics stay in the rules.

The project's settings: <project>/.claude/md-doc-hygiene/terms.json

    {
      "paths": ["Docs/Design/Chapters"],   # chapter folders (not recursive), relative to the project root
      "terms_heading": "Terms",              # text of the H2 heading of a Terms section
      "anchor_prefix": "t-",                 # block-ID prefix of a Term anchor (^t-...)
      "catalog_files": [],                   # chapters exempt from [ANC]
      "pointer_words": ["definition", "see"],# an entry with these (and short) only points to the home chapter
      "abbreviations": ["e.g.", "i.e."],     # not sentence ends
      "max_sentences": 3
    }

Checks (hard errors):
  [DUP] one Term defined in several chapters (bracketed variants such as "Skill (X)" collapse onto "Skill")
  [ANC] a Term anchor declared outside the Terms section
Checks (warnings, for a person to judge):
  [ORP] the Term occurs nowhere but its own chapter: possibly an orphan
  [LEN] a definition longer than max_sentences: mechanics have likely leaked into the glossary

Usage:
    python check_terms.py [<chapters dir> ...] [--config <terms.json>]
    Exit 0 = no hard errors (warnings do not fail), 1 = errors, 2 = no config / bad config.
"""
import argparse
import collections
import io
import json
import os
import re
import sys

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

CONFIG_REL = os.path.join(".claude", "md-doc-hygiene", "terms.json")
TERM_RE = re.compile(r"^- \*\*(.+?)\*\*\s*:\s*(.*)$")
SENT_RE = re.compile(r"[.!?](?:\s|$)")


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


def norm(name):
    """Drop bracketed variants and case, so 'Skill (X)' == 'Skill'."""
    return re.sub(r"\s*\(.*?\)", "", name).strip().lower()


class Rules:
    def __init__(self, cfg):
        self.terms_head = re.compile(r"^##\s+" + re.escape(cfg.get("terms_heading", "Terms")) + r"\s*$")
        prefix = re.escape(cfg.get("anchor_prefix", "t-"))
        self.anchor_at_end = re.compile(r"\^" + prefix + r"[a-z0-9-]+\s*$")
        self.catalog = set(cfg.get("catalog_files", []))
        self.pointer_words = [w.lower() for w in cfg.get("pointer_words", ["definition", "see"])]
        self.abbrev = cfg.get("abbreviations", [])
        self.max_sentences = int(cfg.get("max_sentences", 3))

    def strip_links(self, text):
        text = re.sub(r"\[\[[^\]|]*\|([^\]]*)\]\]", r"\1", text)
        text = re.sub(r"\[\[([^\]]*)\]\]", r"\1", text)
        return re.sub(r"\^[a-z]+-[a-z0-9-]+", "", text)

    def sentences(self, text):
        text = re.sub(r"\([^)]*\)", "", self.strip_links(text))
        for a in self.abbrev:
            text = text.replace(a, "")
        return len([s for s in SENT_RE.split(text) if s.strip()])

    def is_pointer(self, body):
        plain = self.strip_links(body).lower()
        return len(plain) < 160 and any(w in plain for w in self.pointer_words)


def check(chapters, rules):
    defs = collections.defaultdict(list)  # norm name -> [(file, name, body, line)]
    errors = warnings = 0
    for fn, text in chapters.items():
        lines = text.split("\n")
        in_terms = False
        terms_lines = set()
        for i, line in enumerate(lines):
            if rules.terms_head.match(line):
                in_terms = True
                continue
            if in_terms and (line.startswith("---") or line.startswith("## ")):
                in_terms = False
            if in_terms:
                terms_lines.add(i)
                m = TERM_RE.match(line)
                if m:
                    defs[norm(m.group(1))].append((fn, m.group(1), m.group(2), i + 1))
        if fn in rules.catalog:
            continue
        for i, line in enumerate(lines):
            if rules.anchor_at_end.search(line) and i not in terms_lines:
                print("[ANC] %s:%d  Term anchor declared outside the Terms section" % (fn, i + 1))
                errors += 1

    for places in defs.values():
        real = [p for p in places if not rules.is_pointer(p[2])]
        if len({p[0] for p in places}) > 1 and len(real) > 1:
            print('[DUP] "%s" defined in %d chapters -> %s' % (places[0][1], len(real), ", ".join("%s:%d" % (p[0], p[3]) for p in real)))
            errors += 1
    for places in defs.values():
        for fn, name, body, ln in places:
            n = rules.sentences(body)
            if n > rules.max_sentences:
                print('[LEN] %s:%d  "%s" - %d sentences (keep it to %d)' % (fn, ln, name, n, rules.max_sentences))
                warnings += 1
    for places in defs.values():
        if len(places) > 1:
            continue
        fn, name, body, ln = places[0]
        stem = re.split(r"[ (/]", name)[0]
        stem = (stem[:-2] if len(stem) > 6 else stem).lower()
        outside = sum(1 for other, text in chapters.items() if other != fn and stem in text.lower())
        own = len(re.findall(re.escape(stem), chapters[fn].lower()))
        if outside == 0 and own <= 2:
            print('[ORP] %s:%d  "%s" - occurs only in its own chapter (%d hits)' % (fn, ln, name, own))
            warnings += 1
    return defs, errors, warnings


def main():
    ap = argparse.ArgumentParser(description="per-chapter glossary convention")
    ap.add_argument("dirs", nargs="*")
    ap.add_argument("--config")
    args = ap.parse_args()
    config = args.config or find_config(args.dirs[0] if args.dirs else os.getcwd())
    if not config:
        print("Error: no %s - this project keeps no glossary convention." % CONFIG_REL)
        return 2
    try:
        with open(config, encoding="utf-8") as f:
            cfg = json.load(f)
        rules = Rules(cfg)
    except (OSError, ValueError, re.error) as e:
        print("Error: bad terms config %s: %s" % (config, e))
        return 2
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(config))))
    dirs = [os.path.abspath(d) for d in args.dirs] or [os.path.join(root, p) for p in cfg.get("paths", [])]
    total_err = total_warn = total_defs = total_chapters = 0
    for d in dirs:
        if not os.path.isdir(d):
            print("Error: chapters folder not found: %s" % d)
            return 2
        chapters = {fn: io.open(os.path.join(d, fn), encoding="utf-8").read() for fn in sorted(os.listdir(d)) if fn.endswith(".md")}
        defs, e, w = check(chapters, rules)
        total_err += e
        total_warn += w
        total_defs += len(defs)
        total_chapters += len(chapters)
    print("")
    print("Scanned %d chapters, %d distinct terms." % (total_chapters, total_defs))
    if total_err:
        print("[FAILED] %d error(s), %d warning(s)." % (total_err, total_warn))
        return 1
    print("[SUCCESS] No convention errors.%s" % (" %d warning(s) to eyeball." % total_warn if total_warn else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
