---
name: make-pdf
description: Use when the user wants a PDF as the deliverable — "сделай pdf", "выгрузи в pdf", "экспортируй отчёт в pdf", "export this to PDF", "нужен pdf-файл". Turns markdown/HTML/a report you produced into a clean printable PDF via headless Chrome or Edge (no pandoc, no LaTeX). Windows.
---

# make-pdf — produce a PDF from content

Turns text/markdown/HTML into a polished PDF through **headless Chrome or Edge**. Edge ships with every
Windows 10/11, so there is no pandoc/LaTeX dependency. Paths below are from the skill folder (`<skill>`).

## Pipeline: content → styled HTML → browser → PDF

1. **Write an HTML file** to the session scratchpad. Embed the content in the print template below. If the
   source is markdown, render it to HTML yourself as you write the file — headings, lists, tables, code blocks,
   `**bold**`/`*italic*`. Keep everything inline (no external CSS/JS/fonts — the browser prints offline).

2. **Print to PDF:**
   ```
   <skill>\scripts\html-to-pdf.cmd <input.html> <out.pdf>
   ```
   (or `node <skill>/scripts/mjs/html-to-pdf.mjs ...`). It finds the browser itself — `BROWSER_EXE` → `chrome` /
   `msedge` on PATH → the registry's App Paths → Program Files — and prints which one it used. `--where` shows the
   choice without printing; `--wait <ms>` gives a page that lays out late more time (default 3000);
   `--header-footer` keeps the browser's date/URL/page-number footer (off by default).

3. **Confirm** the script reported the file with a non-trivial size, then hand it over with `SendUserFile` when
   that tool exists (the file *is* the deliverable); otherwise give its path.

**Verifying the render.** `Read` on a `.pdf` needs poppler (`pdftoppm`), which is often missing. To eyeball the
output, render the *same HTML* to PNG with the same engine and `Read` that:
`<skill>\scripts\html-to-pdf.cmd <input.html> <out.png> --png [--width 900 --height 1200]`.
Cyrillic, tables, monospace code and symbols like `— «ёлки» © § №` render correctly with the template below.

## Default print template

```html
<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 18mm 16mm; }
  body { font: 11pt/1.5 "Segoe UI", system-ui, sans-serif; color: #1a1a1a; }
  h1 { font-size: 20pt; margin: 0 0 .4em; }
  h2 { font-size: 15pt; margin: 1.2em 0 .3em; border-bottom: 1px solid #ddd; padding-bottom: .15em; }
  h3 { font-size: 12.5pt; margin: 1em 0 .3em; }
  code, pre { font-family: "Cascadia Code", Consolas, monospace; font-size: 9.5pt; }
  pre { background: #f5f5f5; padding: .7em 1em; border-radius: 5px; overflow-x: auto; white-space: pre-wrap; }
  table { border-collapse: collapse; width: 100%; margin: .6em 0; }
  th, td { border: 1px solid #ccc; padding: .4em .6em; text-align: left; vertical-align: top; }
  th { background: #f0f0f0; }
  h1, h2, h3 { break-after: avoid; }
  tr, pre, img { break-inside: avoid; }
  img { max-width: 100%; }
</style></head><body>
  <!-- content here -->
</body></html>
```

## Notes
- **Cyrillic** renders fine — `Segoe UI` covers it. Keep the file UTF-8.
- Landscape: `@page { size: A4 landscape; }`. Custom running headers: `@page` margin boxes.
- Images/charts: embed as `data:` URIs or reference local `file:///` paths — both print.
- No browser found (script exits 2): install Chrome or Edge, or set `BROWSER_EXE` to one.
- **Optional pandoc path** — only if the user already has pandoc with a PDF engine and asks for it:
  `pandoc in.md -o out.pdf`. Prefer the browser path otherwise.
