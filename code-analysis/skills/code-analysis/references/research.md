# Research: how others do it → options → choice → plan

When the question looks outward before anything is built: "how is X done", "what are the options",
"which approach fits us", "research and propose a plan". The answer comes from the web, professional UE
sites, the engine source and Epic samples, measured against the project. Research reads and plans; it
never edits code or assets. A subject entirely inside the project's own code is analysis (`SKILL.md`),
not research.

## Rules

- **Fresh engine features are always on the table**, Experimental and Beta included. Each is shown with
  its maturity and risks, never rejected up front. The engine version is the one in the `.uproject`.
- **Assume prior art exists** — on professional sites, in runnable code, and in the project's own earlier
  research (the first step below looks there).
- **At least two genuinely different options** where real alternatives exist, each with honest
  tradeoffs; when there is one answer, give one and say so.
- **Cost is a column, never a reason an option is missing.** A paid candidate is priced and offered,
  not dropped. A claim about the repository that argues a candidate down is cited (`file:line`) or
  labelled an assumption.
- **Earlier decisions are context, not a fence.** An option rejected before gets the same rigour as the
  rest, and the arbiter says plainly whether new evidence moves the old decision.
- **Depth follows the size of the question**, not a token budget.

## Flow

1. **Earlier research first.** Search the project's research and plan folders (`.local/research/`,
   `.local/plans/`, or wherever the project keeps them) with **bare words**:
   `rg -il "word1|word2" .local/research .local/plans`. A quoted phrase must match verbatim and falsely
   answers "the topic is new". For each match: reuse the answer, research only the new slice, or say why
   the earlier research is stale.
2. **Scope** — the problem in one sentence, with its hard constraints: engine version, single-player or
   networked, the project's modules, how content gets authored (by hand, by agent tools, by scripts).
3. **Axes — fanned out in ONE message**, one agent per axis. Web axes run on `general-purpose` (it loads
   `WebSearch`/`WebFetch` through `ToolSearch`), the engine axis on `engine-reader`, the fit axis on
   `code-scout`. Each writes its findings to a report file in the research folder as rows
   `{claim, source URL or file:line, engine version or date, applies to us, confidence}`, about 10–15 rows,
   and answers with the path. The axes, picked by the question's size:
   - **fresh and Experimental engine features** — release notes, `dev.epicgames.com`, with the maturity of each;
   - **professional practice** — a URL and a date stamp on every finding (`references/sources.md`);
   - **engine source and Epic samples** — `engine-reader`; which sample is the reference for what is in
     `references/sources.md`;
   - **fit to the repository** — the project's architecture, modules, content structure, what it already has;
   - **agent-authorability** — can an agent build and change it with the tools the project has, and what
     stays a manual editor step for a person;
   - **headless verifiability** — what a test or commandlet can prove without a person at the editor;
   - **known failure modes** — `issues.unrealengine.com`, `hazards.cmd <words>`, forum threads.
   A large or architectural question adds a completeness critic before the arbiter, and external voices
   (`references/external-voices.md`: which voices for an outward subject, how to call them, how long to wait).
4. **Arbiter** — one pass over all axis reports once they are in. Merge and dedupe, then verify every claim
   an option rests on: does it exist in this engine version (`engine-api.cmd`, the engine source)? Is it a
   UE4-era answer? Is the plugin still shipping? A claim that fails is dropped or marked. Then assemble the
   options and list the questions only a person can answer.
5. **Choice.** When the options change a result the person sees, put them to the person and wait. Otherwise
   pick, and name the choice and the reason in the report.
6. **Plan** — `.local/plans/<feature>.md` (or the project's place for plans): the steps, each routed to the
   skill that executes it, and a **Sources** section — URL or engine `file:line`, the version or date stamp,
   a flag on every unverified claim.

## Report and archive

- To the person, in the language of the conversation: the options first — how it works, Experimental or
  not, fit, authorability, verifiability, pitfalls, cost, sources — then the choice made or the open questions.
- The raw axis, critic and external reports are archived in `.local/research/<yyyy-mm-dd>-<slug>/` (if the
  project keeps them elsewhere — there), with a `README.md` whose **first line is the answer** the research
  reached: that line is what the next search in step 1 sees. A bundle overtaken by later research gets a
  `superseded-by: <folder>` line and is never deleted. Fetched web pages are not committed.
- A conclusion resting only on agreement between agents of one vendor is marked as such.
