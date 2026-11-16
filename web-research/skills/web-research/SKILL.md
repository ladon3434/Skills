---
name: web-research
description: Web research that brings back claims with their sources, and a second route for public pages that WebFetch cannot open — a 403, a bot wall, a CAPTCHA, an empty shell, a wiki that answers 401/402 — through the public Jina Reader (r.jina.ai). Use for "search the web", "find articles / reviews / talks / wiki pages about X", "the page does not open", "WebFetch got 403", "read this wiki", and in every research brief given to a subagent. Russian: «поищи в интернете», «найди статьи / обзоры / вики», «страница не открывается», «вики не пускает», «прочитай через ридер».
---

# web-research — sources first, a second route for pages that refuse bots

A research answer is only as good as the pages actually read. Search engines show snippets; wikis, stores and
news sites often answer an automated fetch with 403, 401, a "Just a moment" check or an empty JavaScript shell.
This skill fixes what to do then, and how to mark what was and was not read.

## The order

1. **Search, then open the pages that answer.** Read only what bears on the question. A claim without a page behind
   it is not written.
2. **WebFetch first.** It is the normal route.
3. **The reader second.** A page WebFetch could not open (403, 401, 402, a bot wall, a CAPTCHA, an empty shell) is
   asked once more through Jina Reader, a public service that fetches a public page and returns its text:

   ```
   curl -s --max-time 40 "https://r.jina.ai/<the page URL>"
   ```

   No key is needed; the free limit is about 20 pages a minute, so do not fan out dozens of pages at once.
   - A 200 answer **with the page's own text** counts. A body that says "blocked", "403", "log in", "access denied",
     or a page of cookie and tracking junk does not.
   - A Cloudflare "Just a moment" page is asked once more after about half a minute; often the second answer is whole.
   - Known not to pass (2026-11): Reddit, helpx.adobe.com. Go straight to "not read" for them.
   - A wiki.gg wiki that answers 401 "you don't seem to be authorized" through the reader too is closed to everyone
     (a wiki still in onboarding), not walled against bots: no route reads it. Look for the same game's wiki on
     fandom.com, which the reader does pass (2026-11).
4. **Still nothing — say so.** The page is named `not read: <URL>`, and nothing from its search snippet is written
   as if it had been read. Look for the same fact elsewhere: an official patch note, a mirror, the Wayback Machine
   copy (`https://web.archive.org/web/<URL>`), a second wiki.

The reader is for **public** pages only. A page behind a login, a paywall or a private repository is not read this
way: use the user's own authenticated tool (`gh`, an MCP connector, their browser) or name it as not read.

## Marking what was read

Each finding is one line: the claim, its URL, its date or the version it applies to, and how sure it is (primary
source, guide, forum post, guess). Contradicting sources are both named.

- A claim taken through the reader carries `(via r.jina.ai)` beside its URL.
- A claim from a search snippet only carries `(snippet)` and counts as unconfirmed.
- Pages neither route opened are listed under `not read:` at the end.

## In a brief to a subagent

A research subagent does not know this skill unless the brief says so. Paste the order above into every research
brief, or hand the axis to the `web-searcher` agent of this plugin, which follows it by itself.

## Permission

The reader runs through `curl` in the Bash tool. A permission mode that reviews commands may stop the first call as
an unknown outside service. The user decides; to allow it once and for all, a rule in their settings:

```
"permissions": { "allow": [ "Bash(curl -s --max-time 40 \"https://r.jina.ai/*)" ] }
```

Never work around a refusal in another way: report which pages stayed unread.
