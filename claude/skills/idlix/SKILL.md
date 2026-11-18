---
name: idlix
description: Find a film's or series' page on idlix (z3.idlixku.com), a site the user streams from, and play the film or one episode. Use whenever the user types "/idlix <title>" or "/idlix <title> <year>" in any Claude Code session — e.g. "/idlix no other choice", "/idlix ready or not 2019", "/idlix la brea", "/idlix OP 787", "/idlix la brea season 2 episode 3" — and for a plain-English request to the same effect, such as "find No Other Choice on idlix", "is La Brea on idlix?", "play it on idlix", "put on No Other Choice from idlix". Searches the site, matches the results against the title and year, and answers with the link to each match. For "/idlix <title>" with one matching film it also opens the film in a Chrome window on Windows, starts it and shows it full screen.
argument-hint: <title> [year]
---

# /idlix — find a title on idlix (z3.idlixku.com), and play it

The text after `/idlix` is a film or series title, optionally followed by its release year. Answer
with the link to its page on idlix (z3.idlixku.com), and for a film start it playing full screen on the user's
screen. Do not answer from memory and never build a link to the site by hand: a link counts only
when the search returned it.

idlix sits behind Cloudflare and answers 403 to `curl`, `WebFetch` and a headless browser. Do not
try those, and do not try to disguise one as a browser. The script asks from inside a real Chrome
on the Windows side instead, which is the only way this skill reads the site.

How the sites work, and what can go wrong, is in `docs/guide/streaming.md` of the mcp-notes repo.

## Step 1: work out the title and year

- **The user typed them:** `/idlix ready or not 2019` is the title "ready or not", year 2019.
- **The user points at a film from this session** ("/idlix that one", "play it on idlix" after a
  recommendation or a `movies_*` result): use that title and its year from the conversation.
- **No year anywhere:** search without one. Do not guess a year from memory.
- **An episode:** `/idlix OP 787` is the series "one piece", episode 787; `/idlix la brea season 2
  episode 3` is "la brea", season 2, episode 3. Write a nickname out in full (OP is One Piece):
  the search matches the whole name. A number that could be a year or an episode ("/idlix dark
  2017") is a year unless the user says episode. Pass a season only when the user named one: the
  site finds it, since a long anime numbers its episodes through the seasons (One Piece 787 is in
  season 18).

## Step 2: search, and play

`/idlix <title>` means "put it on": run the script with `--play`. A question ("is La Brea on
idlix?", "find the idlix link for it") is a lookup only: run it without `--play`.

```sh
node ~/.claude/skills/idlix/search.mjs --play no other choice
node ~/.claude/skills/idlix/search.mjs --play ready or not 2019
node ~/.claude/skills/idlix/search.mjs la brea
node ~/.claude/skills/idlix/search.mjs --play one piece --episode 787
node ~/.claude/skills/idlix/search.mjs --play la brea --season 2 --episode 3
```

Give the Bash call a timeout of at least 150 seconds with `--play`: the script waits until the
film is running.

What the search does: idlix answers only a real browser, so even the lookup runs inside the
streaming Chrome on Windows: the script makes sure it is running (starting it minimized, about 4
seconds; under a second when it is already up) and runs the site's own search request
(`/api/search`) inside a tab on the site. `HTTP 403` in the error means Cloudflare is now
refusing the real Chrome too.

Before the film idlix shows a 7-second countdown and then an advert; with the ad blocker in the
streaming Chrome the advert usually does not come. `--play` closes the advertising tab the play
button opens, waits the countdown out and presses the site's own "Skip Ad" when an advert offers
it. The whole flow takes about 25 seconds.

The site moves between numbered hosts (z2, z3, ...) and the old one forwards to the new. The
script follows it by itself: `origin` in the answer is where the site is now.

It prints JSON:

- `matches`: the results whose name is the asked title (its English or its other name), and
  whose year is the asked year when one was given, in the site's order. Each has `title` (name
  and year), `kind` (`movie` or `series`), `quality` for a film, `seasons` for a series, and
  `url`.
- `others`: every other result. The search is fuzzy, so most of these are unrelated.
- `episode`, with `--episode` only: the one episode that fits (`season`, `episode`, `name`, `url`,
  and `title`, its series), found by asking the site's own episode API for every matching series;
  null when none or several fit, and then `episode_candidates` lists the ones that do.
- `play`, with `--play` only: what happened on screen (below).
- `warp`, when present: the site did not answer, so the script switched Cloudflare WARP the
  other way round and asked again, which worked: `connected` (it was off; some sites are only
  reached through it) or `disconnected` (it was on; some sites refuse its addresses). WARP stays
  that way, for the whole laptop; say so in one line.
- `kept`, after a play that started: what the daemon kept of it. `recorded: true` with `title_id`:
  the title is now on the Stream side of the wall's movies page, and Play there, or a
  `direct_stream_play` that names no source, comes back to this site. `recorded: true` with
  `site_title_id`: TMDB does not list the title, so it is kept by what the site says of it, in the
  Stream side's "From streaming sites" section. `recorded: false` with `reason`, or null (the
  daemon is down): the play happened and is only not kept; say so only when asked.
- `ok: false` with `error`: the site could not be asked. A host that does not resolve usually
  means the site moved somewhere the script could not follow (it follows a move to another
  numbered host by itself): ask the user for the current address and rerun with
  `IDLIX_ORIGIN=https://<host>`. `no_chrome` means Chrome is not installed on Windows.

What `--play` does, only when `matches` is exactly one film: a Chrome with its own profile folder
(`%LOCALAPPDATA%\notesd-stream-chrome`, apart from the user's everyday Chrome) comes to the
front, opens the film's page, starts the player, and once the film is running the window goes
full screen with the player stretched over it. The user leaves full screen with F11 (Esc gives
the page back inside the full-screen window). Never close a Chrome this skill did not start.

- `play.playing: true` with `fullscreen`, `duration_s` and `muted`: the film is on screen.
- `play.skipped_play`: nothing was started. `several_matches`: show the links, ask which one,
  then play the chosen one with `search.mjs --play-url <its url>`. `series`: a series is not
  started without an episode; give its link. `no_match`: see step 3. With `--episode`:
  `no_episode` (no matching series has that episode: say so), `several_episodes` (two series, or
  two seasons, have an episode of that number: list `episode_candidates` with series and season,
  ask which, then play the chosen one with `--play-url <its url>`), `no_video` (the site lists
  the episode without a video).
- `play.playing: false` with `stage` or `error`: the flow stopped there, usually because the
  window was minimized while it waited (`visible: false`). Say where it stopped; running the
  same command again starts over.

To play a link the user already has from an earlier answer: `search.mjs --play-url <url>`.

## Step 3: answer

- **A film was started:** one line: the `title` as a markdown link to its `url`, that it is
  playing full screen in the streaming Chrome window, and F11 to leave full screen.
- **An episode was started:** the same line, with the series' title, the season and episode and
  the episode's name, linked to `episode.url`.
- **One or more matches, nothing started:** one line per match: the `title` as a markdown link
  to its `url`, followed by the kind, and the quality or the number of seasons. When the matches
  have different years (a remake and its original), say so in one line and let the user pick.
- **No match, but `others` holds a near miss** (the same title with a subtitle, another
  spelling, a sequel): show up to three of those as links and say plainly that none is exact.
  Do not play a near miss without being asked.
- **No match and nothing close:** say the site does not have it under that name. One retry is
  worth it when the title has an obvious other form (an original-language title, a title without
  its subtitle); say which name found it.
- **`ok: false`:** report the error in one line. Do not fall back to a guessed link.

The link in the answer opens in the user's default browser as a fresh page: a page that is
already playing cannot be handed over through a link, which is why the film plays in the
streaming Chrome window. That Chrome runs uBlock Origin Lite, which the owner added to its profile, so most of a site's adverts do not show in it.

Do not look for the film's video or download sources, and do not press anything on the page
beyond what `--play` does.

Keep the answer short: the links, and at most one line of comment.
