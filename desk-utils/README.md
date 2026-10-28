# desk-utils

Small Windows desktop helpers for any Claude Code session: the clipboard, a screenshot, a PDF from markdown/HTML.
Not tied to Unreal or to any project.

## Contents

Paths are relative to each skill folder `skills/<skill>/`; `.claude-plugin/` sits at the plugin root.

| Path | What |
| --- | --- |
| `skills/clipboard/SKILL.md` | read and write the clipboard: text, images, copied files (PowerShell) |
| `skills/screenshot/SKILL.md` | capture the screen (all monitors, primary, a window) to PNG and read it |
| `skills/make-pdf/SKILL.md` | print template and pipeline: content → HTML → PDF, checking the render through a PNG |
| `skills/make-pdf/scripts/html-to-pdf.cmd` + `mjs/html-to-pdf.mjs` | print to PDF/PNG with headless Chrome or Edge; the browser is found automatically (`BROWSER_EXE` → PATH → registry → Program Files) |

## Install

A plugin of the `ue-skills` marketplace (adding the marketplace: root `README.md`). From the project folder:

```
claude plugin install desk-utils@ue-skills --scope local   :: this project only; the project repository is not changed
claude plugin install desk-utils@ue-skills                 :: every project on the machine
```

Turn off: `/plugin` → Installed (space), or `claude plugin disable desk-utils@ue-skills`. After installing —
`/reload-plugins` or a new session.

Needs: Windows PowerShell 5.1 (ships with Windows), `node` 18+ for `make-pdf`, Chrome or Edge (Edge ships with
Windows 10/11). The clipboard and screenshots work only in the user's interactive session.
