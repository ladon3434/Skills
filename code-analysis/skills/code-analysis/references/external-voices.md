# Review voices: Fable, `agy`, `codex`

For deep analysis, expensive decisions and reviews before release. Three voices: **`fable`** — the
`code-analysis:reviewer` agent on Claude Fable, present in every second opinion; **`agy`** (Gemini) and **`codex`**
(OpenAI) — external CLIs, when the machine has them and the subject calls for them. Only Claude calls them,
non-interactively, in English, with the full question and the constraints in one brief — the voices have no
repository config. They read; they do not edit code and do not touch git. The diff-review recipe that uses them — `review.md`,
"Second opinion".

## First — what is on the machine

`review-voices list` (Bash; from PowerShell `<skill>\scripts\review-voices.cmd list`) — each external voice, its
binary and the model it would run, plus the `fable` line, then `RESULT: voices ...`; exit 3 — no external voice
(`fable` alone). The script runs only the external voices; `fable` is an Agent call Claude makes in the same
message. A voice that is absent is not called and not waited for; the report states who was missing.

- `agy` — on PATH or `%LOCALAPPDATA%\agy\bin\agy.exe` (`AGY_EXE` overrides).
- `codex` — on PATH, else the CLI inside the Codex desktop app (Microsoft Store:
  `<package>\app\resources\codex.exe`; the folder name carries the version and moves on every update, so the
  script asks Appx for it, `CODEX_EXE` overrides).
- `UE_REVIEW_VOICES=none|agy|codex|agy,codex` — which voices may run at all on this machine.

## A voice is a model family, not a binary

`agy` is a shell over several families: Gemini (`gemini-*`), OpenAI open-weight (`gpt-oss-*`) and Claude
(`claude-*`). `agy` with a `claude-*` model is the same vendor as us; it does not count as a cross-vendor voice.
Model names change with every release, so none is written down here: `review-voices` takes the first non-Flash
`gemini-*-high` that `agy models` lists (`UE_REVIEW_AGY_MODEL` overrides) and runs `codex` on its own default
model (`UE_REVIEW_CODEX_MODEL` overrides). The signature in the report is by model, as `review-voices` prints it:
`agy/<model>`, `codex`, `fable`.

The `fable` voice is the strongest Claude model, but the same vendor as the main session: a stronger reader, not
an independent family of mind — agreement between it and the main session is agreement within one vendor, and
between it and an external voice it is a real second vendor. `fable` is the anchor: without
Fable on the account there is no second opinion at all — no substitute model, and the external voices do not run
alone; the owner is told "second opinion not done: no Fable on this account".

## Which voices

- `fable` — always, in every second opinion and deep pass, whatever else runs.
- External subject (the engine, the market, other people's decisions) → plus `agy` + `codex`.
- Internal subject (our harness, conventions, own code) → `fable` only by default; the owner switches the external
  ones on by word.
- System subject (the answer rewrites how the machine or the game works) → plus `agy` + `codex` always, with the
  repository root and history.
- No external voice on the machine, or "no external" from the owner → `fable` alone; the report says there was no
  cross-vendor voice.
- A conclusion that rests only on agreement within one vendor is marked as such.
- A secret in a gitignored repository file still travels to the external analyst: secrets only in environment
  variables.

## One voice missing

- **No `codex`** → `fable` + `agy`. The report says honestly: one cross-vendor voice.
- **No `agy`** → `fable` + `codex`, the same.
- **Only Flash in `agy`** — `review-voices` marks it `WEAK`: evidence, never the deciding verdict.
- **`gpt-oss-*` does not replace codex.** Tested on a review with a known answer: in 19 s it ruled "accept" where
  the defect was, and proposed a "defect" that does not exist. Fit only as a cheap additional voice, never as the
  sole or deciding verdict; `review-voices` never picks it.
- Any external verdict a conclusion rests on is re-checked by Claude against the code itself — in that same test
  Gemini Pro had the real finding and gpt-oss a false one, and from outside they cannot be told apart.

## Read-only, and how it is enforced

- **agy** auto-allows reads *and writes* inside its workspace in headless mode, and soft-denies (exit 0, a notice
  on stderr) anything it would have to ask about — so a prompt alone does not make it read-only, and a read
  outside the granted folders silently yields an empty or partial report — the first such read ends the run with
  no output at all (`EMPTY`, stderr: «a tool required the "read_file" permission … auto-denied»). `review-voices`
  passes session rules (`--settings`, never saved): allow `read_file` on the subject, the brief folder and this
  skill's `references` folder (the checklist a brief names), deny `write_file`, `command`, `execute_url`,
  `read_url` and `mcp` on everything (deny beats allow). agy rejects `unsandboxed(...)` as an invalid rule, so it is
  not passed. Verified: with them a write and a shell command are refused with "Matches user-configured deny
  rule", and a file under `references` is read (12.11.2026). Any other file a brief needs is copied into the brief
  folder. Never `--dangerously-skip-permissions` — it approves writes and commands too. A denial notice in its
  stderr makes the status `PARTIAL`; git's warning that it cannot read the global ignore file under codex's sandbox
  does not.
- **codex** runs `exec --sandbox read-only` with the brief on stdin, and prints only its final message to
  stdout. Verified on Windows: a write is refused with "Access ... is denied". The sandbox limits writes and
  commands, not reads: unlike `agy`, codex is not confined to the subject and the brief folder — what else it can
  read depends on its own sandbox setup on the machine.
- Both also get a read-only line at the head of the prompt; in practice they refuse there already.
- After the run `review-voices` compares a fingerprint of the subject (`git diff HEAD` plus every untracked file's
  size and time; ignored files not covered) with the one taken before. `untouched=CHANGED` means the content moved
  — with the voices sandboxed, most likely a person or another session working in the same tree: revert nothing,
  show `git status` to the person. Not a git tree — `UNCHECKED`.
- The reports go to `--out` (default a new temp folder), outside the subject and the brief folder: `agy` cannot
  read another voice's report (codex is not granted the folder, but its reads are not confined — see above).

## Calling by hand

When `review-voices` itself is not usable (another OS, a flag it does not pass), `review-voices run ... --dry-run`
prints each voice's exact argv (as JSON) and what goes to stdin. Rules that hold either way:

- name the `agy` model: without `--model` it takes whatever `~/.gemini/antigravity-cli/settings.json` says;
- give `agy` the deny rules above, and every voice the read-only line at the head of the prompt;
- `codex exec` without a prompt argument reads stdin: give it the brief on stdin, or `< /dev/null` with the prompt
  as an argument — otherwise it waits for stdin forever;
- exit 0 with an empty report is a failure, not "nothing to say": check the file size and the stderr;
- call the binaries directly, not through wrappers and aliases (their flags land before yours); machine config in
  `~/.bashrc`, `~/.codex/config.toml` and `~/.gemini/` may override flags.

## Waiting for the voices

`review-voices run` waits for every voice in parallel and kills a voice's process tree past its cap
(`--timeout-min`, default 15; `agy` also gets `--print-timeout` just under it). Start it in the background with an
outer bound of the cap plus a margin — `timeout 1100 review-voices run ...` for the default cap — so the outer bound
never cuts the run before its own cap does; on Ctrl+C or a signal it kills the voices it started. Dispatch the
`fable` voice (the `reviewer` agent) in the same message, and read the report folder once both are in. A voice with `TIMEOUT`, `FAILED`
or `EMPTY` is named "did not answer" in the report — the synthesis does not stall on one voice.

## Completeness critic

Before the synthesis of a deep pass — a separate agent gets the question and all axis reports and answers one
thing: what was not considered, which finding rests on an unverified assumption, which axis would have been worth
adding. Its answer is an input to the synthesis, not a report to the owner.

## Refuter

The critic looks for what is missing; the refuter for what is wrong. In a deep pass every finding of severity 2–3
goes to the `code-analysis:refuter` agent (Opus whatever the main model is), whose only task is to disprove it:
read the cited `file:line` and the code around it, and answer `holds` · `does not hold` · `cannot establish`, with
the evidence. A finding that does not hold is dropped; one that cannot be established is reported as doubtful.
Many findings — one refuter per axis report, all in one message. Agents not installed — `general-purpose` with
the same task.
