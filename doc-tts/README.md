# doc-tts

Markdown documents → MP3 with a local neural voice: strips the markup into narrator-friendly text and speaks it
with Qwen3-TTS on a local ComfyUI stand, mirroring the folder structure. A voice is designed once from a written
description and kept as a short reference clip; documents are read by cloning it. Microsoft Edge TTS stays as a
fallback (`--engine edge`).

## Contents

Paths are relative to the skill folder `skills/doc-tts/`; `.claude-plugin/` sits at the plugin root.

| Path | What |
| --- | --- |
| `SKILL.md` | running, flags, voices, what the cleanup does |
| `scripts/doc-tts.cmd` | wrapper: finds Python (`PYTHON` → PATH → `py -3`) |
| `scripts/doc_tts.py` | markdown cleanup, voice design, audition, reading through the stand (or `edge-tts`) |
| `voices/` | shipped voices: `<name>.flac` reference clip + `<name>.json` (how it was designed) |

## Install

A plugin of the `ue-skills` marketplace (adding the marketplace: root `README.md`). From the project folder:

```
claude plugin install doc-tts@ue-skills --scope local   :: this project only; the project repository is not changed
claude plugin install doc-tts@ue-skills                 :: every project on the machine
```

Turn off: `/plugin` → Installed (space), or `claude plugin disable doc-tts@ue-skills`. After installing —
`/reload-plugins` or a new session.

Needs Python 3, `ffmpeg` on PATH and a ComfyUI stand with the TTS-Audio-Suite pack and the Qwen3-TTS models
(SKILL.md, «The stand»); `DOC_TTS_COMFY_URL` points at it. By default each mp3 lands next to its `.md`;
`--out-root` puts them in a separate folder.
