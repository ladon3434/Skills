---
name: doc-tts
description: Voice markdown documents into MP3 with a local neural voice (Qwen3-TTS on a ComfyUI stand), or Microsoft Edge TTS as a fallback. Use when asked to "listen to a document", "make audio / an mp3 of the doc", "read this doc aloud", "design / pick a voice", «прослушать документ», «сделай аудио/mp3 из доки», «озвучь документ», «начитай главу», «подбери голос». Cleans markdown into narrator text and speaks it with a designed voice, mirroring the folder structure. Windows, Python, ffmpeg, a ComfyUI stand with TTS-Audio-Suite.
---

# doc-tts — markdown → MP3 with a local neural voice

Takes a `.md` file or folder, cleans the markup into readable text and speaks it on the local ComfyUI stand.
Mirrors the structure: `<src-root>/<rel>.md` → `<out-root>/<rel>.mp3`. Paths are from the skill folder (`<skill>`).

## The approach

1. **A voice is designed once, from words.** Qwen3-TTS VoiceDesign 1.7B takes a written description and a seed and
   speaks a short reference clip. The voice *is* that clip: it is kept (`<name>.flac` + `<name>.json`), never
   designed again. A changed description or seed is a different voice. Voices are never cloned from someone else's
   recording.
2. **Every document is spoken by cloning the clip.** Qwen3-TTS Base 1.7B (Voice Clone) reads the text with the
   reference as narrator, in the voice's language (Russian by default).
3. The text goes to the stand in paragraph groups of ≤ 1200 chars; the parts are joined with a 0.45 s pause and
   encoded to mp3 by ffmpeg. Each part is cached (`%TEMP%\doc-tts-cache`, by voice + text), so a rerun after a
   failure or an edit only speaks what changed.

## Running
```
<skill>\scripts\doc-tts.cmd <file.md | folder> [--voice NAME] [flags]     (or python <skill>/scripts/doc_tts.py ...)
<skill>\scripts\doc-tts.cmd voices                                        list voices; * = the default
<skill>\scripts\doc-tts.cmd design NAME --instruction "..." [--seeds 1,2,3] [--language Russian] [--text "..."]
<skill>\scripts\doc-tts.cmd audition <file.md | "text"> [--voices a,b] [--chars 600] [--out DIR]
```
- **One file** — the mp3 lands next to it. **A folder** — recursively, each mp3 next to its `.md`.
- `--out-root <folder>` — the structure relative to `--src-root` (default: the input folder, or the file's folder) is
  repeated there. Audio is binary; if the docs are under git, suggest a folder outside the repository or in
  `.gitignore` instead of silently putting mp3s into the repository.
- `--dump-text` — save the cleaned text (one block per stand job) next to the mp3, to check what will be read.
- `--engine edge [--voice ru-RU-SvetlanaNeural] [--rate +10%]` — the old cloud path (`pip install edge-tts`,
  internet); default Edge voice `ru-RU-DmitryNeural`.

Speed on an 8 GB laptop GPU: the first job of a stand run loads the model (a minute or more); after that roughly real
time or slower — a long document takes a while, so run it in the background and say so.

## Voices

Looked up in `DOC_TTS_VOICES` (default `%USERPROFILE%\.claude\doc-tts\voices`), then in `<skill>/voices/` (shipped
with the plugin); a name in the first wins. The default is `DOC_TTS_VOICE`, else the voice whose json has
`"default": true`, else the only voice. `<name>.json` keeps how it was made: `instruction`, `seed`, `language`,
`text` (what the clip says), `speak_seed` (seed for reading, 1).

Shipped: `narrator_m` (default) — a calm middle-aged male narrator, Russian; its json holds the description and
seed it was designed from.

**Picking a voice:** `design` several descriptions with a few seeds each (`--seeds 1,2,3` → `NAME_s1`, …), listen
to the clips, then `audition` a real passage with the candidates — the cloned reading is what matters, not the
design clip. Keep the chosen one (rename its two files), delete the rest. Descriptions work best in English and
concrete: age, gender, timbre, pace, the kind of reader («audiobook narrator», «news anchor», «podcast host»).
The language of the voice is the language it will read; for English documents design an English voice.

## The stand

A ComfyUI with the TTS-Audio-Suite node pack (`Qwen3TTSEngineNode`, `UnifiedTTSTextNode`,
`UnifiedVoiceDesignerNode`). URL: `DOC_TTS_COMFY_URL`, else `COMFYUI_URL`, else `http://127.0.0.1:8188`. The
script does not start the stand; if it does not answer, say so and offer to start it.

- Start it with UTF-8 output, or the pack's emoji log lines raise `UnicodeEncodeError` and a job hangs in the queue:
  `set PYTHONUTF8=1` + `set PYTHONIOENCODING=utf-8`, then
  `python_embeded\python.exe -s ComfyUI\main.py --windows-standalone-build --disable-auto-launch --port <port>`.
- Raising one: the ComfyUI Windows portable build; `git clone https://github.com/diodiogod/TTS-Audio-Suite` into
  `ComfyUI/custom_nodes/` and run its `install.py` with the stand's Python. Qwen3-TTS runs in the pack's own runtime,
  installed on the first Qwen3 job (that job is slow). The models download on first use into
  `ComfyUI/models/TTS/qwen3_tts/`, or by hand from Hugging Face: `Qwen/Qwen3-TTS-12Hz-1.7B-Base` (reading) and
  `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign` (designing), about 8.5 GB together. Both Apache 2.0.
- One model family per stand run: loaded models stay in memory. Restart the stand when switching to another family.
- The stand keeps uploads in `ComfyUI/input/doc-tts/` and renders in `ComfyUI/output/doc-tts/`; both can be
  cleared at any time.
- Checking a render: Whisper (`openai-whisper`, model `small`, `language="ru"`) reads it back; compare with
  `--dump-text`.

## What the cleanup does (`clean_markdown`)
Drops YAML frontmatter, code blocks and inline code, images; `[text](url)` → text; wiki links: `[[File|Alias]]` →
"Alias", `[[NN_Name]]` → "Name", `[[#Section]]` → "Section"; bold/italic; headings become sentences; horizontal
rules; list bullets and numbering; tables are linearized (cells joined by commas). Square brackets become round
ones (the stand reads `[Name]` and `[pause:1]` as tags). Symbols become speakable in Russian: `§` → «параграф»,
`№` → «номер», ` + ` → «плюс», `↑/↓` → «растёт/падает», other arrows become a pause; emoji and unpronounceable
characters are dropped. For other languages adjust these replacements in `clean_markdown`.

## Notes
- Document-specific tweaks go into `clean_markdown` (`doc_tts.py`); look at `--dump-text` first.
- Hand the finished file to the user with `SendUserFile` when that tool exists; otherwise give the path.
