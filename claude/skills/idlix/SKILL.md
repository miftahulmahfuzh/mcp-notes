---
name: idlix
description: Find a film's or series' page on idlix (z2.idlixku.com), the site the user streams from. Use whenever the user types "/idlix <title>" or "/idlix <title> <year>" in any Claude Code session — e.g. "/idlix no other choice", "/idlix ready or not 2019", "/idlix la brea" — and for a plain-English request to the same effect, such as "find No Other Choice on idlix", "is La Brea on idlix?", "get me the idlix link for that film". Asks the site's own search through a real Chrome on Windows (the site blocks every other client), matches the results against the title and year, and answers with the link to each match. For "/idlix <title>" with one matching film it also opens the film in that Chrome, starts it and shows it full screen ("play it on idlix", "put on No Other Choice").
argument-hint: <title> [year]
---

# /idlix — find a title on idlix, and play it

The text after `/idlix` is a film or series title, optionally followed by its release year. Answer
with the link to its page on idlix, and for a film start it playing full screen on the user's
screen. Do not answer from memory and never build an idlix link by
hand: a link counts only when the search returned it.

idlix sits behind Cloudflare and answers 403 to `curl`, `WebFetch` and a headless browser. Do not
try those, and do not try to disguise one as a browser. The script below asks from inside a real
Chrome on the Windows side instead, which is the only way this skill reads the site.

## Step 1: work out the title and year

- **The user typed them:** `/idlix ready or not 2019` is the title "ready or not", year 2019.
- **The user points at a film from this session** ("/idlix that one", "find it on idlix" after a
  recommendation or a `movies_*` result): use that title and its year from the conversation.
- **No year anywhere:** search without one. Do not guess a year from memory.

## Step 2: search, and play

`/idlix <title>` means "put it on": run the script with `--play`. A question ("is La Brea on
idlix?", "find the idlix link for it") is a lookup only: run it without `--play`.

```sh
node ~/.claude/skills/idlix/search.mjs --play no other choice
node ~/.claude/skills/idlix/search.mjs --play ready or not 2019
node ~/.claude/skills/idlix/search.mjs la brea
```

Give the Bash call a timeout of at least 150 seconds with `--play`: the site shows a countdown
and an advert before the film, and the script waits through them (about 25 seconds in all).

What the search does: `cdp.ps1` (Windows PowerShell) makes sure a Chrome with its own profile
folder (`%LOCALAPPDATA%\notesd-idlix-chrome`, apart from the user's everyday Chrome) is running
with a DevTools port on Windows loopback, starting it minimized when it is not, and runs the
site's own search request (`/api/search`) inside a tab on the site. A cold start takes about 4
seconds, a warm one under a second. Never close a Chrome this skill did not start.

It prints JSON:

- `matches`: the results whose name is the asked title (its English or original-language name),
  and whose year is the asked year when one was given, in the site's order. Each has `title`
  (name and year), `kind` (`movie` or `series`), `quality` for a film (`BLU-RAY`, `WEB-DL`),
  `seasons` for a series, and `url`.
- `others`: every other result. The search is fuzzy, so most of these are unrelated.
- `play`, with `--play` only: what happened on screen (below).
- `ok: false` with `error`: the site could not be asked. `no_chrome` means Chrome is not
  installed on Windows; `HTTP 403` means Cloudflare is now blocking the real Chrome too; a
  failure to resolve the host usually means the site moved (it changes between `z1`, `z2`, ...
  hosts): ask the user for the current address and rerun with `IDLIX_ORIGIN=https://<host>`.

What `--play` does, only when `matches` is exactly one film: it brings that Chrome window to the
front, opens the film's page, clicks the play button, closes the advertising tab the click
opens, waits through the countdown, presses the site's own "Skip Ad" when the advert offers it,
and once the film is running makes the window full screen with the player stretched over it.
The user leaves full screen with F11 (Esc gives the page back inside the full-screen window).

- `play.playing: true` with `fullscreen`, `duration_s` and `muted`: the film is on screen.
- `play.skipped_play`: nothing was started. `several_matches`: show the links, ask which one,
  then play the chosen one with `search.mjs --play-url <its url>`. `series`: a series has
  episodes to choose, so give its link; `--play-url` on a series page is untried, so say what
  came back if the user asks for it anyway. `no_match`: see step 3.
- `play.playing: false` with `stage` (`countdown`, `advert`, `film`, `no_player`) or `error`:
  the flow stopped there, usually because the window was covered or minimized while it waited
  (`visible: false`). Say where it stopped; running the same command again starts over.

To play a link the user already has from an earlier answer: `search.mjs --play-url <url>`.

## Step 3: answer

- **A film was started:** one line: the `title` as a markdown link to its `url`, that it is
  playing full screen in the idlix Chrome window, and F11 to leave full screen.
- **One or more matches, nothing started:** one line per match: the `title` as a markdown link
  to its `url`, followed by the kind, and the quality or the number of seasons. When the matches
  have different years (a remake and its original), say so in one line and let the user pick.
- **No match, but `others` holds a near miss** (the same title with a subtitle, another
  spelling, a sequel): show up to three of those as links and say plainly that none is exact.
  Do not play a near miss without being asked.
- **No match and nothing close:** say idlix does not have it under that name. One retry is worth
  it when the title has an obvious other form (an original-language title, a title without its
  subtitle); say which name found it.
- **`ok: false`:** report the error in one line. Do not fall back to a guessed link.

The link in the answer opens in the user's default browser as a fresh page: a page that is
already playing cannot be handed over through a link, which is why the film plays in the
skill's own Chrome window. That Chrome has no ad blocker, so the site's adverts show in it.

Do not look for the film's video or download sources, and do not press anything on the page
beyond what `--play` does.

Keep the answer short: the links, and at most one line of comment.
