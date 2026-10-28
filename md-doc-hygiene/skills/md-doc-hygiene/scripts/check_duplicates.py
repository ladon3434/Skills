"""
Duplicate-sentence checker for a markdown documentation tree.

Finds sentences that say the same thing twice. Comparison ignores case,
punctuation and dash variants, because that is exactly how the real defect
shows up: an edit leaves the old wording next to the new one, differing only
by a comma against an em dash.

    Periodicity is deliberately one, daily; ...
    Periodicity is deliberately one - daily; ...

An exact-match search walks straight past that pair. This one does not.

Checks (hard errors):
  [DUP] two near-identical sentences on the same line, or within three lines
        of each other - a copy-paste leftover, not a deliberate echo

Checks (warnings - for a human, never auto-fixed):
  [ECHO] the same sentence twice in one file, farther apart: sometimes a
         deliberate refrain, sometimes a glossary entry that has swallowed
         the rule it should only point at
  [ECHO] the same sentence in two files (longer ones only): a rule stated
         in two places has two sources of truth, and they drift

What is deliberately NOT compared: headings, table rows and separators,
blockquotes, fenced code, the whole "See also" section, and the text of
every link. Those repeat by design - two files describing a third one
should describe it in the same words, and a link's alias is the wording of
the rule it points at - so counting them buries the real findings.

Usage:
    python check_duplicates.py [docs root]        (default: the current directory)
"""

import os
import re
import sys
from collections import defaultdict

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8', errors='replace')
    except (AttributeError, ValueError):
        pass

MIN_SAME_FILE = 25      # shorter phrases repeat legitimately
MIN_CROSS_FILE = 40     # across files the bar is higher still
ADJACENT = 3            # lines apart that still counts as "same spot"

# Abbreviations whose full stop does not end a sentence. Without this the
# splitter cuts "see. Damage model" out of every cross-reference and the
# report fills up with fragments.
ABBR = (r'(?:см|т\.\s?е|т\.\s?к|т\.\s?д|т\.\s?п|напр|рис|стр|гл|пп?|ср|прим'    # Russian
        r'|e\.\s?g|i\.\s?e|etc|vs|cf|fig|ch|sec|no|approx)')                     # English
ABBR_TAIL = re.compile(ABBR + r'\.$', re.IGNORECASE)
SPLIT = re.compile(r'(?<=[.!?])\s+(?=[«("]?[А-ЯЁA-Z0-9])')
FENCE = re.compile(r'^\s*```')
HEADING = re.compile(r'^(#{1,6})\s+(.*?)\s*$')
# Link glosses to other files. Identical wording there is correct, not a
# defect: the same file should be described the same way from anywhere.
SEE_ALSO = ('см. также', 'see also')
LIST_MARK = re.compile(r'^\s*(?:[-*+]|\d+\.)\s+')


def strip_markup(s):
    # Links drop out entirely, alias and all. The house convention makes the
    # alias the target's own wording, so a correct cross-reference always
    # "repeats" what it points at - counting that flags every linked page.
    s = re.sub(r'\[\[[^\]]*\]\]', ' ', s)                    # [[file#anchor|alias]]
    s = re.sub(r'\[[^\]]*\]\([^)]*\)', ' ', s)              # [text](url)
    s = re.sub(r'\s*\^[a-z0-9-]+\s*$', '', s)              # trailing anchor
    s = s.replace('**', '').replace('`', '').replace('*', '')
    return re.sub(r'\s+', ' ', s).strip()


def normalize(s):
    """The comparison key: no case, no punctuation, no dash variants."""
    s = s.lower().replace('ё', 'е')              # yo -> ye
    s = re.sub(r'[«»"\'()\[\],;:.!?—–-]+', ' ', s)
    return re.sub(r'\s+', ' ', s).strip()


def skippable(raw):
    t = raw.strip()
    if not t or t == '---':
        return True
    if t.startswith('#') or t.startswith('|') or t.startswith('>'):
        return True
    return bool(re.match(r'^[-\s|:]+$', t))                # table separator


def sentences_of(raw):
    line = strip_markup(LIST_MARK.sub('', raw.strip()))
    if not line:
        return []
    out, buf = [], ''
    for piece in SPLIT.split(line):
        buf = (buf + ' ' + piece).strip() if buf else piece
        if not ABBR_TAIL.search(buf):
            out.append(buf)
            buf = ''
    if buf:
        out.append(buf)
    return out


def collect(base):
    groups = defaultdict(list)
    for root, _, files in os.walk(base):
        for fn in sorted(files):
            if not fn.endswith('.md'):
                continue
            path = os.path.join(root, fn)
            rel = os.path.relpath(path, base).replace('\\', '/')
            infence = in_see_also = False
            with open(path, encoding='utf-8') as fh:
                for no, raw in enumerate(fh, 1):
                    if FENCE.match(raw):
                        infence = not infence
                        continue
                    head = None if infence else HEADING.match(raw)
                    if head:
                        in_see_also = head.group(2).strip().lower() in SEE_ALSO
                    if infence or in_see_also or skippable(raw):
                        continue
                    for s in sentences_of(raw):
                        key = normalize(s)
                        if len(key) >= MIN_SAME_FILE:
                            groups[key].append((s, rel, no))
    return groups


def report(tag, where, variants, indent='      '):
    print('[%s] %s' % (tag, where))
    for v in variants:
        print('%s%s' % (indent, v if len(v) <= 160 else v[:160] + '…'))


def main(base):
    groups = collect(base)
    errors = warnings = 0

    for key in sorted(groups, key=lambda k: -len(k)):
        hits = groups[key]
        if len(hits) < 2:
            continue
        files = {f for _, f, _ in hits}
        lines = [n for _, _, n in hits]
        where = ', '.join('%s:%d' % (f, n) for _, f, n in hits)
        variants = []
        for text, _, _ in hits:                 # keep order, drop repeats
            if text not in variants:
                variants.append(text)

        if len(files) > 1:
            if len(key) >= MIN_CROSS_FILE:
                report('ECHO', where + '  - same sentence in two files',
                       variants)
                warnings += 1
        elif max(lines) - min(lines) <= ADJACENT:
            report('DUP ', where + '  - said twice in the same spot', variants)
            errors += 1
        else:
            report('ECHO', where + '  - same sentence twice in one file',
                   variants)
            warnings += 1

    print('')
    if errors:
        print('[FAILED] %d duplicate(s), %d echo(es) to eyeball.'
              % (errors, warnings))
        return 1
    if warnings:
        print('[SUCCESS] No duplicates. %d echo(es) to eyeball.' % warnings)
    else:
        print('[SUCCESS] No repeated sentences.')
    return 0


if __name__ == '__main__':
    args = sys.argv[1:]
    root = os.path.abspath(args[0] if args else '.')
    if not os.path.isdir(root):
        print('Error: docs directory not found: %s' % root)
        sys.exit(1)
    sys.exit(main(root))
