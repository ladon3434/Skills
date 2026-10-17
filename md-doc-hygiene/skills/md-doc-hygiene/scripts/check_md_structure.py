"""
Markdown structure checker for Obsidian-style docs.

Headings carry no numbers: links point at heading TEXT, so renumbering cannot break them. What can still drift
are the numbers of list items inside a section, and anchors go stale when a heading is renamed outside Obsidian.

Checks:
  [NUM] ordered-list numbering is continuous per indent level inside each heading
  [ANC] every [[File#Heading]] and [[#Heading]] resolves to a real heading
  [BLK] every [[File#^id]] / [[#^id]] resolves to a real block id (a trailing "^id" on a line)
  [DUPH] a heading text repeated in one file - its anchor is ambiguous
  [NUMH] a heading that starts with a number ("2.5 Items") - renumbering breaks every reference to it
  [HCHR] a "##"+ heading with # | ^ %% [[ ]] (a link to it breaks on its own syntax) or ":" (Obsidian rewrites it
         in heading links, so a link by the heading text may not match)
  [PIPE] a [[link|alias]] inside a table row without "\\|" - the renderer splits the row at that pipe
  [TBL] an indented table row (a table inside a list item) - many renderers show it as text with bars
  [COLS] a table row whose cell count differs from the header's
  [TOC] the table of contents between <!-- toc --> and <!-- /toc --> misses a heading, lists one that is not
        below it, or differs in order or nesting; with --require-toc also a file of 3+ "##" sections without one
  [SECT] "§2.5"-style reference (only with --forbid-section-signs, for docs that retired that scheme)
  [WS ] trailing whitespace and double spaces inside a line (skip with --no-whitespace)
Fenced code blocks are not checked.

Table of contents: a block in the file, entries are links to this file's headings below the block:
    <!-- toc -->            (levels ## and ###; <!-- toc:2 --> for ## only, up to <!-- toc:6 -->)
    - [[#Summary|Summary]]
    - [[#Problems|Problems]]
      - [[#Blocks play|Blocks play]]
    <!-- /toc -->
Every entry must reach its heading ([ANC]) and the list must match the headings ([TOC]).

Usage:
    python check_md_structure.py [docs root] [--fix] [--forbid-section-signs] [--no-whitespace] [--require-toc]

--fix renumbers ordered lists and rebuilds every table of contents from the headings, in place, and reports what
it changed. Other references are NEVER rewritten: a ref may be in range yet point at the wrong item, and only a
human can tell.
Exit code 0 = clean, 1 = problems found.
"""

import os
import re
import sys

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8', errors='replace')
    except (AttributeError, ValueError):
        pass

HEADING_RE = re.compile(r'^#{1,6}\s+(.*?)\s*$')
ITEM_RE = re.compile(r'^([ \t]*)(\d+)\.\s')
XREF_RE = re.compile(r'\[\[([^\]|#\n]+)#([^\]|#^\n]+)(?:\|[^\]]*)?\]\]')
LOCALREF_RE = re.compile(r'\[\[#([^\]|#^\n]+)(?:\|[^\]]*)?\]\]')
BLOCKREF_RE = re.compile(r'\[\[([^\]|#\n]*)#\^([A-Za-z0-9-]+)(?:\|[^\]]*)?\]\]')
BLOCKID_RE = re.compile(r'\s\^([A-Za-z0-9-]+)\s*$')
NUMBERED_HEADING_RE = re.compile(r'^\d+(\.\d+)*[.)]?\s')
UNESCAPED_PIPE_IN_LINK_RE = re.compile(r'\[\[[^\]]*[^\\]\|')
SECTION_SIGN_RE = re.compile(r'§\s*\d')
FENCE_RE = re.compile(r'^\s*(```|~~~)')
HEADING_LEVEL_RE = re.compile(r'^(#{1,6})\s+(.*?)\s*$')
LINK_SYNTAX_IN_HEADING_RE = re.compile(r'[#|^]|%%|\[\[|\]\]')
TOC_OPEN_RE = re.compile(r'^\s*<!--\s*toc(?::([2-6]))?\s*-->\s*$', re.I)
TOC_CLOSE_RE = re.compile(r'^\s*<!--\s*/toc\s*-->\s*$', re.I)
TOC_ENTRY_RE = re.compile(r'^([ \t]*)[-*]\s+\[\[#([^\]|#^\n]+?)\s*(?:\|[^\]]*)?\]\]\s*$')
TABLE_DELIM_RE = re.compile(r'^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$')
REQUIRE_TOC_SECTIONS = 3
SKIPPED_DIRS = {'.git', '.obsidian', 'node_modules', '.trash'}


def indent_width(s):
    return len(s.replace('\t', '    '))


def code_mask(lines):
    """True for lines inside (or opening/closing) a fenced code block."""
    mask, inside = [], False
    for line in lines:
        if FENCE_RE.match(line):
            mask.append(True)
            inside = not inside
        else:
            mask.append(inside)
    return mask


def scan(path):
    with open(path, encoding='utf-8') as f:
        lines = f.readlines()
    mask = code_mask(lines)
    heads, blocks = [], set()
    for line, code in zip(lines, mask):
        if code:
            continue
        m = HEADING_RE.match(line)
        if m:
            heads.append(m.group(1))
        b = BLOCKID_RE.search(line.rstrip('\n'))
        if b:
            blocks.add(b.group(1))
    return lines, mask, heads, blocks


def check_numbering(lines, mask, fix):
    problems, changed, levels, section = [], False, {}, '(top)'
    for i, line in enumerate(lines):
        if mask[i]:
            continue
        if line.startswith('#'):
            levels.clear()
            section = line.strip('# \n')
            continue
        m = ITEM_RE.match(line)
        if not m:
            continue
        ind, num = indent_width(m.group(1)), int(m.group(2))
        for deeper in [k for k in levels if k > ind]:
            del levels[deeper]
        if ind not in levels:
            levels[ind] = num                     # a list may legitimately start at 0 or 1
            continue
        expected = levels[ind] + 1
        if num != expected:
            problems.append((i + 1, section, num, expected))
            if fix:
                lines[i] = ITEM_RE.sub(lambda mm, e=expected: '%s%d. ' % (mm.group(1), e), line, count=1)
                changed = True
                num = expected
        levels[ind] = num
    return problems, changed


def cell_count(row):
    s = row.strip().replace('\\|', '')
    if s.startswith('|'):
        s = s[1:]
    if s.endswith('|'):
        s = s[:-1]
    return s.count('|') + 1


def check_tables(lines, mask):
    """[TBL] indented rows, [COLS] cell counts against the header. Yields (tag, line, message)."""
    i, n = 0, len(lines)
    while i < n - 1:
        head, delim = lines[i].rstrip('\n'), lines[i + 1].strip()
        if mask[i] or not head.strip().startswith('|') or '-' not in delim or not TABLE_DELIM_RE.match(delim):
            i += 1
            continue
        width, j, indented = cell_count(head), i, False
        while j < n and not mask[j] and lines[j].strip().startswith('|'):
            row = lines[j].rstrip('\n')
            if row[:1] in (' ', '\t') and not indented:
                indented = True
                yield ('TBL', j + 1, 'indented table row - a table inside a list item renders as text; '
                                     'make the item a paragraph and put the table at column 0')
            if j != i + 1 and cell_count(row) != width:
                yield 'COLS', j + 1, '%d cells, the header has %d' % (cell_count(row), width)
            j += 1
        i = j


def headings_with_levels(lines, mask, start=0):
    out = []
    for i in range(start, len(lines)):
        if mask[i]:
            continue
        m = HEADING_LEVEL_RE.match(lines[i])
        if m:
            out.append((len(m.group(1)), m.group(2)))
    return out


def check_toc(lines, mask, fix, require):
    """Returns (problems [(line, message)], changed). The TOC lists this file's headings below it."""
    opens = [i for i, l in enumerate(lines) if not mask[i] and TOC_OPEN_RE.match(l)]
    if not opens:
        sections = sum(1 for lvl, _ in headings_with_levels(lines, mask) if lvl == 2)
        if require and sections >= REQUIRE_TOC_SECTIONS:
            return [(1, 'no table of contents - add <!-- toc --> ... <!-- /toc --> under the title')], False
        return [], False
    if len(opens) > 1:
        return [(opens[1] + 1, 'a second <!-- toc --> - keep one table of contents per file')], False
    o = opens[0]
    close = next((i for i in range(o + 1, len(lines)) if not mask[i] and TOC_CLOSE_RE.match(lines[i])), None)
    if close is None:
        return [(o + 1, '<!-- toc --> without a closing <!-- /toc -->')], False
    depth = int(TOC_OPEN_RE.match(lines[o]).group(1) or 3)
    want = [(lvl, t) for lvl, t in headings_with_levels(lines, mask, close + 1) if 2 <= lvl <= depth]

    problems, entries, indents = [], [], set()
    for i in range(o + 1, close):
        if not lines[i].strip():
            continue
        m = TOC_ENTRY_RE.match(lines[i])
        if not m:
            problems.append((i + 1, 'not a TOC entry - expected "- [[#Heading|Heading]]"'))
            continue
        entries.append((indent_width(m.group(1)), m.group(2).strip(), i + 1))
        indents.add(indent_width(m.group(1)))
    rank = {w: k for k, w in enumerate(sorted(indents))}
    have = [(rank[w] + 2, t) for w, t, _ in entries]

    if have != want:
        want_t, have_t = [t for _, t in want], [t for _, t in have]
        for t in want_t:
            if t not in have_t:
                problems.append((o + 1, 'heading "%s" is missing from the table of contents' % t))
        for _, t, ln in entries:
            if t not in want_t:
                problems.append((ln, '"%s" is no heading of levels 2-%d below the table of contents' % (t, depth)))
        common_have = [x for x in have if x[1] in want_t]
        common_want = [x for x in want if x[1] in have_t]
        if [t for _, t in common_have] != [t for _, t in common_want]:
            problems.append((o + 1, 'entries are not in the order of the headings'))
        elif common_have != common_want:
            problems.append((o + 1, 'entry nesting differs from the heading levels'))
        if not problems:
            problems.append((o + 1, 'table of contents differs from the headings'))

    if fix and problems:
        lines[o + 1:close] = ['%s- [[#%s|%s]]\n' % ('  ' * (lvl - 2), t, t) for lvl, t in want]
        return problems, True
    return problems, False


def main(root, fix, forbid_sections, whitespace, require_toc):
    files = []
    for d, dirs, names in os.walk(root):
        dirs[:] = [x for x in dirs if x not in SKIPPED_DIRS]
        files += [os.path.join(d, n) for n in names if n.endswith('.md')]

    data, heads, blocks = {}, {}, {}
    for p in files:
        key = os.path.splitext(os.path.basename(p))[0].lower()
        data[p] = scan(p)
        heads.setdefault(key, set()).update(data[p][2])
        blocks.setdefault(key, set()).update(data[p][3])

    bad = 0
    for p in sorted(files):
        rel = os.path.relpath(p, root)
        me = os.path.splitext(os.path.basename(p))[0].lower()
        lines, mask, my_heads, _ = data[p]

        problems, changed = check_numbering(lines, mask, fix)
        for ln, sec, got, exp in problems:
            print('[NUM] %s:%d  "%s"  item %d -> %s %d' % (rel, ln, sec, got, 'renumbered' if fix else 'expected', exp))
            bad += 1
        toc_problems, toc_changed = check_toc(lines, mask, fix, require_toc)
        for ln, msg in toc_problems:
            print('[TOC] %s:%d  %s%s' % (rel, ln, msg, ' - rebuilt' if toc_changed else ''))
            bad += 1
        if toc_changed:
            mask = code_mask(lines)
        if changed or toc_changed:
            with open(p, 'w', encoding='utf-8', newline='\n') as f:
                f.writelines(lines)

        for tag, ln, msg in check_tables(lines, mask):
            print('[%s] %s:%d  %s' % (tag.ljust(3), rel, ln, msg))
            bad += 1

        seen = set()
        for h in my_heads:
            if h in seen:
                print('[DUPH] %s  heading "%s" appears twice - its anchor is ambiguous' % (rel, h))
                bad += 1
            seen.add(h)
            if NUMBERED_HEADING_RE.match(h):
                print('[NUMH] %s  heading "%s" starts with a number - drop it, link by text' % (rel, h))
                bad += 1
        for lvl, h in headings_with_levels(lines, mask):
            if lvl == 1:
                continue                          # the title: nothing links to it
            if LINK_SYNTAX_IN_HEADING_RE.search(h):
                print('[HCHR] %s  heading "%s" has # | ^ %%%% [[ or ]] - a link to it breaks on its own syntax, '
                      'reword' % (rel, h))
                bad += 1
            elif ':' in h:
                print('[HCHR] %s  heading "%s" has ":" - Obsidian rewrites it in heading links, so a link by the '
                      'heading text may not match; reword (a dash or a comma)' % (rel, h))
                bad += 1

        for ln, line in enumerate(lines, 1):
            if mask[ln - 1]:
                continue
            probe = line.replace('\\|', '|')

            for m in XREF_RE.finditer(probe):
                tgt, anc = m.group(1).strip().lower(), m.group(2).strip()
                tgt = tgt.rsplit('/', 1)[-1]
                if tgt in heads and anc not in heads[tgt]:
                    print('[ANC] %s:%d  [[%s#%s]] - no such heading' % (rel, ln, m.group(1), anc))
                    bad += 1
            for m in LOCALREF_RE.finditer(probe):
                if m.group(1).strip() not in heads[me]:
                    print('[ANC] %s:%d  [[#%s]] - no such heading here' % (rel, ln, m.group(1).strip()))
                    bad += 1
            for m in BLOCKREF_RE.finditer(probe):
                tgt = (m.group(1).strip().lower().rsplit('/', 1)[-1]) or me
                if tgt in blocks and m.group(2) not in blocks[tgt]:
                    print('[BLK] %s:%d  [[%s#^%s]] - no such block id' % (rel, ln, m.group(1), m.group(2)))
                    bad += 1

            if line.lstrip().startswith('|') and UNESCAPED_PIPE_IN_LINK_RE.search(line):
                print('[PIPE] %s:%d  link alias in a table row needs "\\|" - the bare pipe splits the row' % (rel, ln))
                bad += 1
            if forbid_sections and SECTION_SIGN_RE.search(line):
                print('[SECT] %s:%d  "§N" reference - link the heading: [[File#Heading|text]]' % (rel, ln))
                bad += 1
            if whitespace:
                stripped = line.rstrip('\n')
                if stripped != stripped.rstrip():
                    print('[WS ] %s:%d  trailing whitespace' % (rel, ln))
                    bad += 1
                if re.search(r'\S  +\S', stripped):
                    print('[WS ] %s:%d  double space inside line' % (rel, ln))
                    bad += 1

    if bad:
        print('\n[FAILED] %d problem(s).' % bad)
        print('Lists renumbered, tables of contents rebuilt - review mentions of item numbers in changed sections.'
              if fix else 'Run with --fix to renumber lists and rebuild tables of contents '
                          '(other references are never rewritten).')
        return 1
    print('[SUCCESS] Numbering, headings, anchors, tables and tables of contents are clean.')
    return 0


if __name__ == '__main__':
    flags = {a for a in sys.argv[1:] if a.startswith('--')}
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    root = os.path.abspath(args[0] if args else '.')
    if not os.path.isdir(root):
        print('Error: directory not found: %s' % root)
        sys.exit(1)
    sys.exit(main(root, '--fix' in flags, '--forbid-section-signs' in flags, '--no-whitespace' not in flags,
                  '--require-toc' in flags))
