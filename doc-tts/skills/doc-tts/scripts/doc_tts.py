#!/usr/bin/env python
"""doc-tts — voice markdown documents into MP3 with a local neural voice (Qwen3-TTS on a ComfyUI stand).

The approach: a voice is designed once from a written description (Qwen3-TTS VoiceDesign) and kept as a short
reference clip; every document is then spoken by Qwen3-TTS Base cloning that clip. Microsoft Edge TTS stays as a
fallback engine (--engine edge, needs internet and the edge-tts package).

Mirrors the folder structure: <src-root>/<rel>.md -> <out-root>/<rel>.mp3; by default each mp3 lands next to its .md.

Commands:
    python doc_tts.py <file.md | folder> [--voice NAME] [--out-root DIR] [--dump-text]
    python doc_tts.py voices                                   list the voices
    python doc_tts.py design NAME --instruction "..." [--seeds 1,2,3] [--text "..."]
    python doc_tts.py audition <file.md | text> [--voices a,b] [--chars 600]
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    try:                                   # document paths may be non-ASCII; the console may not be UTF-8
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

SKILL = Path(__file__).resolve().parents[1]
SHIPPED_VOICES = SKILL / "voices"
USER_VOICES = Path(os.environ.get("DOC_TTS_VOICES") or Path.home() / ".claude" / "doc-tts" / "voices")
CACHE = Path(os.environ.get("DOC_TTS_CACHE") or Path(tempfile.gettempdir()) / "doc-tts-cache")
API = (os.environ.get("DOC_TTS_COMFY_URL") or os.environ.get("COMFYUI_URL") or "http://127.0.0.1:8188").rstrip("/")
SUBFOLDER = "doc-tts"                      # under the stand's input/ and output/
CHUNK_CHARS = 1200                         # text per stand job; the node splits it further into ~400-char pieces
PARAGRAPH_PAUSE = 0.45                     # seconds of silence between jobs (paragraph boundaries)
DEFAULT_LANGUAGE = "Russian"
DESIGN_TEXT = {
    "Russian": "Здравствуйте. Это пробная запись голоса для чтения документов. "
               "Сейчас я прочитаю небольшой отрывок: спокойно, внятно, без спешки, с паузами там, где они нужны.",
    "English": "Hello. This is a test recording of a voice for reading documents aloud. "
               "I will read a short passage now: calmly, clearly, without hurrying, pausing where it matters.",
}
EDGE_DEFAULT_VOICE = "ru-RU-DmitryNeural"


# ---------- markdown -> narrator text ----------

def clean_markdown(md: str) -> str:
    """markdown -> plain text a narrator can read. Symbol words are Russian; adjust for other languages."""
    t = md.replace("\r\n", "\n")
    t = re.sub(r"^---\n.*?\n---\n", "", t, flags=re.DOTALL)      # YAML frontmatter
    t = re.sub(r"```.*?```", "", t, flags=re.DOTALL)             # code blocks
    t = re.sub(r"`([^`]*)`", r"\1", t)                           # inline code
    t = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", t)              # images -> alt text
    t = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", t)               # links -> text

    def _wiki(m):                       # [[NN_Name]] -> "Name"; [[File#Section|Alias]] -> "Alias"
        inner = m.group(1).replace("\\|", "|")
        if "|" in inner:
            return inner.split("|", 1)[1]
        name = re.sub(r"^\d+_", "", inner.split("#", 1)[0] or inner.split("#", 1)[-1])
        return name.replace("_", " ")
    t = re.sub(r"\[\[([^\]]+)\]\]", _wiki, t)

    t = re.sub(r"\*\*([^*]+)\*\*", r"\1", t)                     # **bold**
    t = re.sub(r"\*([^*]+)\*", r"\1", t)                         # *italic*
    t = re.sub(r"__([^_]+)__", r"\1", t)
    t = re.sub(r"^#{1,6}\s*(.*)$", lambda m: m.group(1).rstrip(".:") + ".", t, flags=re.MULTILINE)  # heading = sentence
    t = re.sub(r"^\s*([-*_])\1{2,}\s*$", "", t, flags=re.MULTILINE)  # horizontal rules ---/***
    t = re.sub(r"^\s*>\s?", "", t, flags=re.MULTILINE)           # quotes
    t = re.sub(r"^\s*[-*+]\s+", "", t, flags=re.MULTILINE)       # list bullets
    t = re.sub(r"^\s*\d+[.)]\s+", "", t, flags=re.MULTILINE)     # list numbering

    # tables: drop separator rows, join cells with commas
    out_lines = []
    for ln in t.split("\n"):
        if "|" in ln and re.match(r"^\s*\|?\s*:?-{2,}", ln):
            continue
        if "|" in ln:
            ln = ", ".join(c.strip() for c in ln.split("|") if c.strip())
        out_lines.append(ln)
    t = "\n".join(out_lines)

    # symbols -> speakable words (Russian narration)
    t = t.replace("§", " параграф ").replace("№", " номер ")
    t = t.replace("→", " ").replace("↔", " ").replace("←", " ")
    t = t.replace("↑", " растёт ").replace("↓", " падает ")
    t = re.sub(r"\s\+\s", " плюс ", t)                          # " + " read as "plus"
    t = t.replace("[", "(").replace("]", ")")                   # the stand reads [Name] / [pause:1] as tags
    t = re.sub(r"[*_`#>]", "", t)                               # leftover markup
    # drop emoji and other unpronounceable characters (letters of any script and digits stay)
    t = re.sub(r"[^\w\s.,;:!?()\-«»\"'/%–—…]", "", t, flags=re.UNICODE)

    t = re.sub(r"\n{3,}", "\n\n", t)                            # collapse blank lines
    t = re.sub(r"[ \t]{2,}", " ", t)
    return t.strip()


def chunks(text: str, limit: int = CHUNK_CHARS):
    """Paragraph groups of at most `limit` chars; an over-long paragraph is cut at sentence ends."""
    pieces = []
    for para in re.split(r"\n\s*\n", text):
        para = " ".join(para.split())
        if not para:
            continue
        while len(para) > limit:
            cut = max(para.rfind(s, 0, limit) for s in (". ", "! ", "? ", "; ", "… "))
            cut = cut + 1 if cut > limit // 3 else para.rfind(" ", 0, limit)
            if cut <= 0:
                cut = limit
            pieces.append(para[:cut].strip())
            para = para[cut:].strip()
        pieces.append(para)
    out, cur = [], ""
    for p in pieces:
        if cur and len(cur) + 1 + len(p) > limit:
            out.append(cur)
            cur = p
        else:
            cur = f"{cur}\n{p}" if cur else p
    if cur:
        out.append(cur)
    return out


# ---------- voices ----------

def voice_dirs():
    return [d for d in (USER_VOICES, SHIPPED_VOICES) if d.is_dir()]


def all_voices():
    found = {}
    for d in reversed(voice_dirs()):                # the user's folder wins over the shipped one
        for meta in d.glob("*.json"):
            clip = next((meta.with_suffix(s) for s in (".flac", ".wav") if meta.with_suffix(s).exists()), None)
            if clip:
                info = json.loads(meta.read_text(encoding="utf-8"))
                found[meta.stem] = {**info, "clip": clip, "meta": meta}
    return found


def default_voice_name(voices):
    want = os.environ.get("DOC_TTS_VOICE")
    if want:
        return want
    marked = [n for n, v in voices.items() if v.get("default")]
    return marked[0] if marked else (sorted(voices)[0] if len(voices) == 1 else None)


def pick_voice(name):
    voices = all_voices()
    name = name or default_voice_name(voices)
    if not name:
        listing = ", ".join(sorted(voices)) or "none yet"
        die(f"no voice chosen (voices: {listing}). Pass --voice, set DOC_TTS_VOICE, or make one with "
            f"`doc_tts.py design`.")
    if name not in voices:
        die(f"no voice '{name}' in {', '.join(str(d) for d in voice_dirs()) or USER_VOICES}")
    return name, voices[name]


# ---------- the ComfyUI stand ----------

_INFO = None


def die(msg, code=2):
    print(f"doc-tts: {msg}", file=sys.stderr)
    raise SystemExit(code)


def http_json(path, body=None, headers=None, timeout=60):
    req = urllib.request.Request(API + path, body, headers or ({"Content-Type": "application/json"} if body else {}))
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def stand_info():
    global _INFO
    if _INFO is None:
        try:
            _INFO = http_json("/object_info", timeout=120)
        except (urllib.error.URLError, OSError) as e:
            die(f"the ComfyUI stand does not answer at {API} ({e}). Start it (with PYTHONUTF8=1, see SKILL.md) or "
                f"point DOC_TTS_COMFY_URL at it.")
        for cls in ("Qwen3TTSEngineNode", "UnifiedTTSTextNode", "UnifiedVoiceDesignerNode"):
            if cls not in _INFO:
                die(f"the stand at {API} has no {cls} node - install TTS-Audio-Suite (SKILL.md, «The stand»).")
    return _INFO


def node(cls, **given):
    """A graph node with every required input the caller leaves out filled from the node's own default."""
    inputs = {}
    for name, entry in stand_info()[cls]["input"].get("required", {}).items():
        kind, opts = entry[0], (entry[1] if len(entry) > 1 and isinstance(entry[1], dict) else {})
        if "default" in opts:
            inputs[name] = opts["default"]
        elif isinstance(kind, list) and kind:
            inputs[name] = kind[0]
    inputs.update(given)
    return {"class_type": cls, "inputs": inputs}


def upload(clip: Path) -> str:
    """Put a reference clip into the stand's input/doc-tts/ and return the name LoadAudio takes."""
    boundary = uuid.uuid4().hex
    parts = []
    for key, val in (("subfolder", SUBFOLDER), ("type", "input"), ("overwrite", "true")):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{val}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{clip.name}"\r\n'
                 f'Content-Type: application/octet-stream\r\n\r\n'.encode() + clip.read_bytes() + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    reply = http_json("/upload/image", b"".join(parts), {"Content-Type": f"multipart/form-data; boundary={boundary}"})
    return f"{reply.get('subfolder') or SUBFOLDER}/{reply['name']}"


def run_graph(graph, label):
    """Queue a graph, wait for it, return the bytes and extension of its first audio output."""
    reply = http_json("/prompt", json.dumps({"prompt": graph, "client_id": "doc-tts"}).encode())
    pid, started = reply["prompt_id"], time.time()
    while True:
        time.sleep(1)
        hist = http_json(f"/history/{pid}")
        if pid in hist:
            entry = hist[pid]
            break
        if time.time() - started > 1800:
            die(f"{label}: no result after 30 min - check the stand's console")
    status = entry.get("status", {})
    files = [f for out in entry.get("outputs", {}).values() for f in out.get("audio", []) + out.get("audios", [])]
    if status.get("status_str") != "success" or not files:
        die(f"{label}: the stand failed: {json.dumps(status.get('messages', []), ensure_ascii=False)[-800:]}", 1)
    f = files[0]
    q = urllib.parse.urlencode({"filename": f["filename"], "subfolder": f.get("subfolder", ""), "type": f.get("type", "output")})
    with urllib.request.urlopen(f"{API}/view?{q}", timeout=120) as r:
        return r.read(), Path(f["filename"]).suffix or ".flac"


def clone_graph(ref_name, text, language, seed, prefix):
    return {
        "1": node("Qwen3TTSEngineNode", model_variant="TTS - Base 1.7B (Voice Clone)", device="cuda", language=language),
        "2": node("LoadAudio", audio=ref_name),
        "3": node("UnifiedTTSTextNode", TTS_engine=["1", 0], text=text, narrator_voice="none", seed=seed,
                  opt_narrator=["2", 0]),
        "4": node("SaveAudio", audio=["3", 0], filename_prefix=f"{SUBFOLDER}/{prefix}"),
    }


def speak(text, voice_name, voice, label):
    """text -> list of audio files (one per chunk), cached by voice + text so a rerun resumes."""
    language = voice.get("language", DEFAULT_LANGUAGE)
    seed = int(voice.get("speak_seed", 1))
    clip_hash = hashlib.sha1(voice["clip"].read_bytes()).hexdigest()[:10]
    ref_name, parts = None, []
    pieces = chunks(text)
    for i, piece in enumerate(pieces, 1):
        key = hashlib.sha1(f"{clip_hash}|{language}|{seed}|{piece}".encode()).hexdigest()[:16]
        hit = next(iter(CACHE.glob(f"{key}.*")), None)
        if hit is None:
            ref_name = ref_name or upload(voice["clip"])
            t0 = time.time()
            data, ext = run_graph(clone_graph(ref_name, piece, language, seed, f"{voice_name}_{key}"),
                                  f"{label} {i}/{len(pieces)}")
            CACHE.mkdir(parents=True, exist_ok=True)
            hit = CACHE / f"{key}{ext}"
            hit.write_bytes(data)
            print(f"  {i}/{len(pieces)}  {len(piece)} chars  {time.time() - t0:.0f} s", flush=True)
        parts.append(hit)
    return parts


# ---------- audio ----------

def ffmpeg():
    exe = shutil.which("ffmpeg")
    if not exe:
        die("ffmpeg is not on PATH (winget install Gyan.FFmpeg)")
    return exe


def join_to_mp3(parts, out: Path, pause=PARAGRAPH_PAUSE):
    """Chunks joined with a short pause between them, encoded to mp3."""
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [ffmpeg(), "-v", "error", "-y"]
    for p in parts:
        cmd += ["-i", str(p)]
    pad = "".join(f"[{i}:a]aresample=24000,aformat=channel_layouts=mono,apad=pad_dur={pause if i < len(parts) - 1 else 0}[a{i}];"
                  for i in range(len(parts)))
    pad += "".join(f"[a{i}]" for i in range(len(parts))) + f"concat=n={len(parts)}:v=0:a=1[out]"
    cmd += ["-filter_complex", pad, "-map", "[out]", "-c:a", "libmp3lame", "-q:a", "4", str(out)]
    subprocess.run(cmd, check=True)


# ---------- commands ----------

def out_path_for(md_path: Path, src_root: Path, out_root: Path) -> Path:
    try:
        rel = md_path.resolve().relative_to(src_root.resolve())
    except ValueError:
        rel = Path(md_path.name)          # a file outside src-root -> just its name
    return (out_root / rel).with_suffix(".mp3")


def collect(input_path: str):
    p = Path(input_path)
    if p.is_dir():
        return sorted(p.rglob("*.md"))
    return [p] if p.is_file() else []


def edge_synth(text, voice, rate, out: Path):
    try:
        import asyncio
        import edge_tts
    except ImportError:
        die("the edge-tts package is missing - install it: pip install edge-tts")
    out.parent.mkdir(parents=True, exist_ok=True)

    async def go():
        # The online service now and then answers a valid request with no audio; a retry a moment later succeeds.
        for attempt in range(1, 5):
            try:
                await edge_tts.Communicate(text, voice, rate=rate).save(str(out))
                return
            except edge_tts.exceptions.NoAudioReceived:
                if attempt == 4:
                    raise
                print(f"  no audio from the service, retry {attempt}/3", file=sys.stderr)
                await asyncio.sleep(3 * attempt)
    asyncio.run(go())


def cmd_read(args):
    inp = Path(args.input)
    src_root = Path(args.src_root) if args.src_root else (inp if inp.is_dir() else inp.parent)
    out_root = Path(args.out_root) if args.out_root else src_root
    files = collect(args.input)
    if not files:
        die(f"no .md at: {args.input}", 1)
    vname = args.voice or EDGE_DEFAULT_VOICE
    if args.engine == "qwen":
        vname, voice = pick_voice(args.voice)
        ffmpeg()
    for md in files:
        text = clean_markdown(md.read_text(encoding="utf-8"))
        if not text.strip():
            print(f"skipped (empty): {md}")
            continue
        out = out_path_for(md, src_root, out_root)
        if args.dump_text:
            out.parent.mkdir(parents=True, exist_ok=True)
            out.with_suffix(".txt").write_text("\n\n".join(chunks(text)), encoding="utf-8")
        print(f"{md}  ->  {out}", flush=True)
        if args.engine == "edge":
            edge_synth(text, vname, args.rate, out)
        else:
            join_to_mp3(speak(text, vname, voice, md.name), out)
    print(f"done: {len(files)} file(s), voice {vname}")


def cmd_voices():
    voices = all_voices()
    if not voices:
        print(f"no voices yet; folders: {USER_VOICES} (yours), {SHIPPED_VOICES} (shipped)")
        return
    dflt = default_voice_name(voices)
    for name, v in sorted(voices.items()):
        mark = "*" if name == dflt else " "
        print(f"{mark} {name:24} {v.get('language', DEFAULT_LANGUAGE):8} seed {v.get('seed')}  {v.get('instruction', '')}")
        print(f"  {'':24} {v['clip']}")


def cmd_design(args):
    """VoiceDesign: description + seed -> a reference clip saved as a voice. Several seeds = several candidates."""
    language = args.language
    text = args.text or DESIGN_TEXT.get(language) or DESIGN_TEXT["English"]
    dest = Path(args.dir) if args.dir else USER_VOICES
    dest.mkdir(parents=True, exist_ok=True)
    seeds = [int(s) for s in args.seeds.split(",")]
    for seed in seeds:
        name = args.name if len(seeds) == 1 else f"{args.name}_s{seed}"
        graph = {
            "1": node("Qwen3TTSEngineNode", model_variant="Voice Design - 1.7B VoiceDesign", device="cuda",
                      language=language),
            "2": node("UnifiedVoiceDesignerNode", TTS_engine=["1", 0], reference_text=text, seed=seed,
                      voice_instruction=args.instruction),
            "3": node("SaveAudio", audio=["2", 1], filename_prefix=f"{SUBFOLDER}/design_{name}"),
        }
        t0 = time.time()
        data, ext = run_graph(graph, f"design {name}")
        clip = dest / f"{name}{ext}"
        clip.write_bytes(data)
        meta = {"instruction": args.instruction, "seed": seed, "language": language, "text": text,
                "model": "Qwen3-TTS-12Hz-1.7B-VoiceDesign", "speak_seed": 1}
        clip.with_suffix(".json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"{name}: {clip}  ({time.time() - t0:.0f} s)", flush=True)


def cmd_audition(args):
    """The same passage read by several voices, to choose by ear."""
    src = Path(args.source)
    text = clean_markdown(src.read_text(encoding="utf-8")) if src.is_file() else args.source
    if len(text) > args.chars:
        text = text[:args.chars].rsplit(" ", 1)[0]
    voices = all_voices()
    names = args.voices.split(",") if args.voices else sorted(voices)
    out_dir = Path(args.out) if args.out else Path.cwd() / "doc-tts-audition"
    for name in names:
        if name not in voices:
            die(f"no voice '{name}'")
        out = out_dir / f"{name}.mp3"
        print(f"{name}  ->  {out}", flush=True)
        join_to_mp3(speak(text, name, voices[name], name), out)


def main():
    argv = sys.argv[1:]
    sub = argv[0] if argv and argv[0] in ("voices", "design", "audition") else None
    if sub == "voices":
        return cmd_voices()
    if sub == "design":
        ap = argparse.ArgumentParser(prog="doc_tts.py design", description="design a voice from a description")
        ap.add_argument("name")
        ap.add_argument("--instruction", required=True, help="the voice described in words (English works best)")
        ap.add_argument("--seeds", default="1", help="comma list; one candidate per seed (NAME_s<seed>)")
        ap.add_argument("--language", default=DEFAULT_LANGUAGE)
        ap.add_argument("--text", default=None, help="what the candidate says (also the reference transcript)")
        ap.add_argument("--dir", default=None, help=f"where to save (default {USER_VOICES})")
        return cmd_design(ap.parse_args(argv[1:]))
    if sub == "audition":
        ap = argparse.ArgumentParser(prog="doc_tts.py audition", description="one passage, several voices")
        ap.add_argument("source", help=".md file or the text itself")
        ap.add_argument("--voices", default=None, help="comma list (default: all)")
        ap.add_argument("--chars", type=int, default=600)
        ap.add_argument("--out", default=None, help="folder for the mp3s (default ./doc-tts-audition)")
        return cmd_audition(ap.parse_args(argv[1:]))
    ap = argparse.ArgumentParser(description="markdown -> mp3 with a local neural voice (or edge-tts)")
    ap.add_argument("input", help=".md file or folder")
    ap.add_argument("--voice", default=None, help="a voice name (doc_tts.py voices); for --engine edge an Edge voice id")
    ap.add_argument("--engine", choices=("qwen", "edge"), default="qwen")
    ap.add_argument("--rate", default="+0%", help="edge only: speech rate, e.g. +10%%")
    ap.add_argument("--src-root", default=None,
                    help="source root for mirroring (default: the input folder, or the file's folder)")
    ap.add_argument("--out-root", default=None,
                    help="root for the mp3s (default: src-root, i.e. next to each .md)")
    ap.add_argument("--dump-text", action="store_true",
                    help="save the cleaned text (one block per stand job) next to the mp3")
    cmd_read(ap.parse_args(argv))


if __name__ == "__main__":
    main()
