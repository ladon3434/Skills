"""
Markdown link checker: every local [text](path) and every Obsidian [[Page]] must resolve.

Checks (hard errors):
  [LINK] [text](path) whose target file does not exist (web links, mailto: and #anchors are skipped)
  [WIKI] [[Page]] / [[Page|alias]] / [[Page#Heading]] naming no .md page under the root
  [ABS ] file:/// or drive-absolute link - it breaks on every other machine; link relatively

Skipped by design: link syntax shown inside inline code (`[[...]]`), fenced code blocks, and files named
_TEMPLATE.md (templates hold placeholders). Anchors inside pages are check_md_structure.py's job.

Usage:
    python check_md_links.py [docs root]        (default: the current directory)
Exit code 0 = clean, 1 = broken links.
"""

import os
import re
import sys
import urllib.parse

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8', errors='replace')
    except (AttributeError, ValueError):
        pass

LINK_RE = re.compile(r'\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)')
WIKI_RE = re.compile(r'\[\[([^\]]+)\]\]')
INLINE_CODE_RE = re.compile(r'`[^`\n]*`')
FENCE_RE = re.compile(r'^\s*(```|~~~)')
SKIPPED_FILES = {'_TEMPLATE.md'}
SKIPPED_DIRS = {'.git', '.obsidian', 'node_modules', '.trash'}


def md_files(root):
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in SKIPPED_DIRS]
        for f in files:
            if f.endswith('.md'):
                yield os.path.join(d, f)


def wiki_index(root):
    """Lower-case page names Obsidian resolves: the bare file name and the root-relative path."""
    pages = set()
    for p in md_files(root):
        pages.add(os.path.splitext(os.path.basename(p))[0].lower())
        pages.add(os.path.splitext(os.path.relpath(p, root))[0].lower().replace('\\', '/'))
    return pages


def check(root):
    pages = wiki_index(root)
    bad = 0
    print('Scanning: %s\n' % root)
    for path in sorted(md_files(root)):
        if os.path.basename(path) in SKIPPED_FILES:
            continue
        rel = os.path.relpath(path, root)
        here = os.path.dirname(path)
        in_fence = False
        try:
            lines = open(path, encoding='utf-8').read().splitlines()
        except (OSError, UnicodeDecodeError) as e:
            print('[READ] %s - %s' % (rel, e))
            bad += 1
            continue
        for no, line in enumerate(lines, 1):
            if FENCE_RE.match(line):
                in_fence = not in_fence
                continue
            if in_fence:
                continue
            line = INLINE_CODE_RE.sub('', line)

            for link in LINK_RE.findall(line):
                if link.startswith(('http://', 'https://', 'mailto:', '#')):
                    continue
                target = link
                if target.startswith('file:///'):
                    print('[ABS ] %s:%d  %s - absolute file link breaks on other machines' % (rel, no, link))
                    bad += 1
                    target = target[8:]
                elif re.match(r'^[A-Za-z]:[\\/]', target):
                    print('[ABS ] %s:%d  %s - absolute path breaks on other machines' % (rel, no, link))
                    bad += 1
                target = urllib.parse.unquote(target.split('#')[0])
                if not target:
                    continue
                full = os.path.normpath(target if os.path.isabs(target) or re.match(r'^[A-Za-z]:', target)
                                        else os.path.join(here, target))
                if not os.path.exists(full):
                    print('[LINK] %s:%d  %s -> %s (missing)' % (rel, no, link, full))
                    bad += 1

            for inner in WIKI_RE.findall(line):
                page = inner.replace('\\|', '|').split('|')[0].split('#')[0].strip()
                if not page:
                    continue                                   # [[#Heading]] in the same file
                if page.lower().replace('\\', '/') not in pages:
                    print('[WIKI] %s:%d  [[%s]] - no page "%s"' % (rel, no, inner, page))
                    bad += 1

    if bad:
        print('\n[FAILED] %d broken link(s).' % bad)
        return 1
    print('[SUCCESS] All local markdown and wiki links resolve.')
    return 0


if __name__ == '__main__':
    root = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else '.')
    if not os.path.isdir(root):
        print('Error: directory not found: %s' % root)
        sys.exit(1)
    sys.exit(check(root))
