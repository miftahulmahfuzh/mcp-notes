---
name: idlix
description: Find a film's or series' page on idlix (z2.idlixku.com), the site the user streams from. Use whenever the user types "/idlix <title>" or "/idlix <title> <year>" in any Claude Code session — e.g. "/idlix no other choice", "/idlix ready or not 2019", "/idlix la brea" — and for a plain-English request to the same effect, such as "find No Other Choice on idlix", "is La Brea on idlix?", "get me the idlix link for that film". Asks the site's own search through a real Chrome on Windows (the site blocks every other client), matches the results against the title and year, and answers with the link to each match.
argument-hint: <title> [year]
---

# /idlix — find a title on idlix

The text after `/idlix` is a film or series title, optionally followed by its release year. Answer
with the link to its page on idlix. Do not answer from memory and never build an idlix link by
hand: a link counts only when the search returned it.

idlix sits behind Cloudflare and answers 403 to `curl`, `WebFetch` and a headless browser. Do not
try those, and do not try to disguise one as a browser. The script below asks from inside a real
Chrome on the Windows side instead, which is the only way this skill reads the site.

## Step 1: work out the title and year

- **The user typed them:** `/idlix ready or not 2019` is the title "ready or not", year 2019.
- **The user points at a film from this session** ("/idlix that one", "find it on idlix" after a
  recommendation or a `movies_*` result): use that title and its year from the conversation.
- **No year anywhere:** search without one. Do not guess a year from memory.

## Step 2: search

Run the script in this skill's folder with the title, and the year last when there is one:

```sh
node ~/.claude/skills/idlix/search.mjs no other choice
node ~/.claude/skills/idlix/search.mjs ready or not 2019
```

What it does: `cdp.ps1` (Windows PowerShell) makes sure a Chrome with its own profile folder
(`%LOCALAPPDATA%\notesd-idlix-chrome`, apart from the user's everyday Chrome) is running with a
DevTools port on Windows loopback, starting it minimized when it is not, and runs the site's own
search request (`/api/search`) inside a tab on the site. A cold start takes about 4 seconds, a
warm one under a second. The Chrome window stays open, minimized, for the next search; never
close a Chrome this skill did not start.

It prints JSON:

- `matches`: the results whose name is the asked title (its English or original-language name),
  and whose year is the asked year when one was given, in the site's order. Each has `title`
  (name and year), `kind` (`movie` or `series`), `quality` for a film (`BLU-RAY`, `WEB-DL`),
  `seasons` for a series, and `url`.
- `others`: every other result. The search is fuzzy, so most of these are unrelated.
- `ok: false` with `error`: the site could not be asked. `no_chrome` means Chrome is not
  installed on Windows; `HTTP 403` means Cloudflare is now blocking the real Chrome too; a
  failure to resolve the host usually means the site moved (it changes between `z1`, `z2`, ...
  hosts): ask the user for the current address and rerun with `IDLIX_ORIGIN=https://<host>`.

## Step 3: answer

- **One or more matches:** one line per match: the `title` as a markdown link to its `url`,
  followed by the kind, and the quality or the number of seasons. When the matches have
  different years (a remake and its original), say so in one line and let the user pick.
- **No match, but `others` holds a near miss** (the same title with a subtitle, another
  spelling, a sequel): show up to three of those as links and say plainly that none is exact.
- **No match and nothing close:** say idlix does not have it under that name. One retry is worth
  it when the title has an obvious other form (an original-language title, a title without its
  subtitle); say which name found it.
- **`ok: false`:** report the error in one line. Do not fall back to a guessed link.

Stop at the page link. Do not open the page and do not look for its video or download sources.

Keep the answer short: the links, and at most one line of comment.
