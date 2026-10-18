# External voices (`agy`, `codex`) and the `fable` critic

For deep analysis and expensive decisions. Only Claude calls them, non-interactively, in English,
with the full question and the constraints in the prompt — the voices have no repository config. They
read; they do not edit code and do not touch git.

## First — what is on the machine

`codex --version`, `agy --version`, `agy models`. A voice that is absent is not called and not waited for;
the report states who was missing. Substitution rules — below.

## A voice is a model family, not a binary

`agy` is a shell over several families: Gemini (`gemini-*`), OpenAI open-weight
(`gpt-oss-*`) and Claude (`claude-*`). `agy` with a `claude-*` model is the same vendor as us;
it does not count as a cross-vendor voice. The signature in the report is by model: `agy/gemini-3.1-pro-high`,
`codex/<model>`, `fable`.

## Which voices

- External subject (the engine, the market, other people's decisions) → `agy` (Gemini Pro) + `codex`.
- Internal subject (our harness, conventions, own code) → by default without them; a second
  opinion — `fable` (an agent with `model: fable`). The owner switches the external ones on by word.
- System subject (the answer rewrites how the machine or the game works) → `agy` + `codex`
  always, with the repository root and history.
- "no external" from the owner — without both.
- A conclusion that rests only on agreement within one vendor is marked as such.
- A secret in a gitignored repository file still travels to the external analyst: secrets
  only in environment variables.

## No `codex` — substitute through `agy`

The codex role is a second strong voice independent of Gemini. It is covered like this:

- **A pair of voices** (external/system subject) → `agy/gemini-3.1-pro-high` + the `fable` critic.
  The report says honestly: there is one cross-vendor voice.
- **Single-verdict reviewer** (`review.md`) → `agy/gemini-3.1-pro-high`. Not Flash: a review
  is wanted for depth.
- **`gpt-oss-*` does not replace codex.** Tested on a review with a known answer: in 19 s it ruled
  "accept" where the defect was, and proposed a "defect" that does not exist. Fit only as a
  cheap additional voice, never as the sole or deciding verdict.
- Any external verdict a conclusion rests on is re-checked by Claude against the code
  itself — in that same test Gemini Pro had the real finding and gpt-oss a false one, and from outside they
  cannot be told apart.

## `agy` is never read-only

`agy` has no read sandbox. `--mode plan` does not forbid writes: in it the agent writes a plan,
asks for approval — and still creates the file. `--sandbox` restricts the terminal, not writes.
Therefore:

- Do not give a reader voice `--dangerously-skip-permissions`: in `-p` reading works without it.
- Run from an empty report folder (cwd), attach the subject with `--add-dir`; in the prompt — "read-only,
  do not create, edit or delete any file; print the whole report to stdout".
- After the call check that the subject is untouched: `git status --short` in a repository, otherwise
  `find <subject> -newer <brief file>`. Touched — revert its edit and say so in the report.

## Calling

- `agy --model gemini-3.1-pro-high --add-dir "<subject>" --print-timeout 900s -p "$(cat <brief>)" < /dev/null > <report> 2> <report>.err`
  - always name the model: without `--model` it takes whatever is set in `~/.gemini/antigravity-cli/settings.json`;
  - the report arrives whole on stdout, exit 0; Pro on a one-file review — ~2.5 minutes, Flash —
    under a minute; `--print-timeout` guards against a hang;
  - empty stdout with exit 0 is a failure, not "nothing to say".
- `codex exec --sandbox workspace-write -m <model> -c model_reasoning_effort="high" --cd "<abs. path of the report folder>" '<prompt>' < /dev/null`
  - Always `< /dev/null`: otherwise `codex exec` waits for stdin forever.
  - The report is written in one piece at the end: minutes without stdout and without a file are writing, not
    a hang. A hang is a live process whose stdout has not grown for longer than ~15 minutes.
  - `--cd` — a literal absolute path (`$CLAUDE_PROJECT_DIR` can be empty in a background
    subshell); a non-git folder also needs `--skip-git-repo-check`.
  - In `--sandbox read-only` it cannot write the report file — either `workspace-write` with
    `--cd` on the report folder, or the whole report to stdout with redirection.
  - Exit 0 with an empty report is a failure, check the file size.
- Call the binaries directly, not through wrappers and aliases (their flags land before yours);
  machine config in `~/.bashrc` and `~/.gemini/` may override flags.

## Waiting for the voices

Each voice runs in the background with its report going to a file; `agy` is capped by
`--print-timeout 900s`, `codex` counts as hung by the rule above (no stdout growth for ~15 minutes).
The caller does not wait for a notification: once the axis reports are in, it looks at the report
folder itself. A voice past its cap is killed, and the report says "did not finish" for it — the
synthesis does not stall on one voice.

## Completeness critic

Before the synthesis of a deep pass — a separate agent gets the question and all axis reports and
answers one thing: what was not considered, which finding rests on an unverified assumption,
which axis would have been worth adding. Its answer is an input to the synthesis, not a report to the owner.

## Refuter

The critic looks for what is missing; the refuter for what is wrong. In a deep pass every finding of
severity 2–3 goes to a separate agent (`general-purpose`, or `fable` for a second family of mind)
whose only task is to disprove it: read the cited `file:line` and the code around it, and answer
`holds` · `does not hold` · `cannot establish`, with the evidence. A finding that does not hold is
dropped; one that cannot be established is reported as doubtful. Many findings — one refuter per
axis report, all in one message.
