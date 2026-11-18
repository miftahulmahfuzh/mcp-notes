---
name: lk21
description: Find a film's or series' page on lk21 (LayarKaca21, tv12.lk21official.cc), a site the user streams from, and play the film. Use whenever the user types "/lk21 <title>" or "/lk21 <title> <year>" in any Claude Code session — e.g. "/lk21 love of your life", "/lk21 ready or not 2019", "/lk21 la brea" — and for a plain-English request to the same effect, such as "find No Other Choice on lk21", "is La Brea on lk21?", "play it on lk21", "put on No Other Choice from lk21". Searches the site, matches the results against the title and year, and answers with the link to each match. For "/lk21 <title>" with one matching film it also opens the film in a Chrome window on Windows, starts it and shows it full screen.
argument-hint: <title> [year]
---

# /lk21 — find a title on lk21 (LayarKaca21, tv12.lk21official.cc), and play it

The text after `/lk21` is a film or series title, optionally followed by its release year. Answer
with the link to its page on lk21 (LayarKaca21, tv12.lk21official.cc), and for a film start it playing full screen on the user's
screen. Do not answer from memory and never build a link to the site by hand: a link counts only
when the search returned it.

The lookup reads the site directly; only playing needs the Chrome window on the Windows side.

How the sites work, and what can go wrong, is in `docs/guide/streaming.md` of the mcp-notes repo.

## Step 1: work out the title and year

- **The user typed them:** `/lk21 ready or not 2019` is the title "ready or not", year 2019.
- **The user points at a film from this session** ("/lk21 that one", "play it on lk21" after a
  recommendation or a `movies_*` result): use that title and its year from the conversation.
- **No year anywhere:** search without one. Do not guess a year from memory.

## Step 2: search, and play

`/lk21 <title>` means "put it on": run the script with `--play`. A question ("is La Brea on
lk21?", "find the lk21 link for it") is a lookup only: run it without `--play`.

```sh
node ~/.claude/skills/lk21/search.mjs --play love of your life
node ~/.claude/skills/lk21/search.mjs --play ready or not 2019
node ~/.claude/skills/lk21/search.mjs la brea
```

Give the Bash call a timeout of at least 150 seconds with `--play`: the script waits until the
film is running.

What the search does: lk21 answers a plain request, so a lookup needs no browser. The script
reads the search host the home page names and asks it for the title, which takes about a second
and opens nothing.

The film plays inside a frame from another host. `--play` presses the player's play button
inside that frame, and presses the player's own play again when the first press only set it up.
There is no countdown; the whole flow takes 6 to 20 seconds. A series on lk21 forwards to
another site, so it is always a link and never started.

It prints JSON:

- `matches`: the results whose name is the asked title (its English or its other name), and
  whose year is the asked year when one was given, in the site's order. Each has `title` (name
  and year), `kind` (`movie` or `series`), `quality` for a film, `seasons` for a series, and
  `url`.
- `others`: every other result. The search is fuzzy, so most of these are unrelated.
- `play`, with `--play` only: what happened on screen (below).
- `warp`, when present: the site did not answer on this network, so the script turned Cloudflare
  WARP on (it was installed and off) and asked again. WARP stays on, for the whole laptop; say so
  in one line.
- `kept`, after a play that started: what the daemon kept of it. `recorded: true` with `title_id`:
  the title is now on the Stream side of the wall's movies page, and Play there, or a
  `direct_stream_play` that names no source, comes back to this site. `recorded: true` with
  `site_title_id`: TMDB does not list the title, so it is kept by what the site says of it, in the
  Stream side's "From streaming sites" section. `recorded: false` with `reason`, or null (the
  daemon is down): the play happened and is only not kept; say so only when asked.
- `ok: false` with `error`: the site could not be asked. A host that does not resolve usually
  means the site moved to another host: ask the user for the current address and rerun with
  `LK21_ORIGIN=https://<host>`. `no_chrome` means Chrome is not installed on Windows.

What `--play` does, only when `matches` is exactly one film: a Chrome with its own profile folder
(`%LOCALAPPDATA%\notesd-stream-chrome`, apart from the user's everyday Chrome) comes to the
front, opens the film's page, starts the player, and once the film is running the window goes
full screen with the player stretched over it. The user leaves full screen with F11 (Esc gives
the page back inside the full-screen window). Never close a Chrome this skill did not start.

- `play.playing: true` with `fullscreen`, `duration_s` and `muted`: the film is on screen.
- `play.skipped_play`: nothing was started. `several_matches`: show the links, ask which one,
  then play the chosen one with `search.mjs --play-url <its url>`. `series`: a series is not
  started; give its link. `no_match`: see step 3.
- `play.playing: false` with `stage` or `error`: the flow stopped there, usually because the
  window was minimized while it waited (`visible: false`). Say where it stopped; running the
  same command again starts over.

To play a link the user already has from an earlier answer: `search.mjs --play-url <url>`.

## Step 3: answer

- **A film was started:** one line: the `title` as a markdown link to its `url`, that it is
  playing full screen in the streaming Chrome window, and F11 to leave full screen.
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
