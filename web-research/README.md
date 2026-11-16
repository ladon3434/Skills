# web-research

Web research that brings back claims with sources, and a second route for public pages that refuse automated
fetches. Not tied to Unreal or to any project.

The route — re-read a page that WebFetch could not open through the public Jina Reader (`r.jina.ai`), mark what was
read that way and name what stayed unread — comes from the agent harness of TheHouse (`the-web-searcher`).

## Contents

| Path | What |
| --- | --- |
| `skills/web-research/SKILL.md` | the order: search → WebFetch → the reader → "not read"; marking sources; what to paste into a research brief; the permission rule |
| `agents/web-searcher.md` | a subagent that runs one research axis by that order and returns findings with URLs, dates and confidence |

## Install

A plugin of the `ue-skills` marketplace (adding the marketplace: root `README.md`):

```
claude plugin install web-research@ue-skills                 :: every project on the machine
claude plugin install web-research@ue-skills --scope local   :: this project only
```

After installing — `/reload-plugins` or a new session.

Needs: `curl` (ships with Windows 10/11 and Git Bash), network access to `r.jina.ai`. A permission mode that reviews
commands may stop the first reader call; the rule that allows it is in the skill, section Permission.
