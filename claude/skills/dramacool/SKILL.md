---
name: dramacool
description: Find an Asian drama's, show's or film's page on dramacool (dramacool9.com.ro), a site the user streams from, and play one episode of it. Use whenever the user types "/dramacool <title>", "/dramacool <title> <year>" or "/dramacool <title> <episode>" in any Claude Code session — e.g. "/dramacool summer vacation 3", "/dramacool summer vacation 2026 episode 3", "/dramacool love wins all season 2 episode 5", "/dramacool pink summer" — and for a plain-English request to the same effect, such as "find Summer Vacation on dramacool", "is Pink Summer on dramacool?", "play episode 4 on dramacool", "put on the next episode from dramacool". Searches the site, matches the results against the title and year, and answers with the link to each match. With an episode and one matching title it also opens the episode in a Chrome window on Windows, starts it and shows it full screen.
argument-hint: <title> [year] [episode]
---

# /dramacool — find a title on dramacool (dramacool9.com.ro), and play an episode

The text after `/dramacool` is a drama, show or film title, optionally followed by its release
year and an episode. Answer with the link to its page on dramacool (dramacool9.com.ro), and for an
episode start it playing full screen on the user's screen. Do not answer from memory and never
build a link to the site by hand: a link counts only when the search returned it.

The lookup reads the site directly; only playing needs the Chrome window on the Windows side.

How the sites work, and what can go wrong, is in `docs/guide/streaming.md` of the mcp-notes repo.

## Step 1: work out the title, year and episode

- **The user typed them:** `/dramacool summer vacation 2026 episode 3` is the title "summer
  vacation", year 2026, episode 3.
- **The user points at a title from this session** ("/dramacool that one", "play the next episode
  on dramacool" after an earlier play): use that title and its year from the conversation, and
  the episode after the one that was played.
- **No year anywhere:** search without one. Do not guess a year from memory.
- **An episode:** every title on the site is a list of episodes, so a trailing number is the
  episode: `/dramacool summer vacation 3` is "summer vacation", episode 3. A number that could be
  a year ("/dramacool summer vacation 2026") is a year. A film is a title with one episode:
  "play the film Devil River on dramacool" is episode 1.
- **A season:** a later season is a title of its own on the site ("Love Wins All Season 2
  (2026)"). Pass a season only when the user named one: `/dramacool love wins all season 2
  episode 5` is "love wins all", season 2, episode 5.
- **No episode anywhere, and not a film:** it is a lookup. Do not pick an episode yourself.

## Step 2: search, and play

`/dramacool <title> <episode>` means "put it on": run the script with `--play`. A question ("is
Pink Summer on dramacool?", "find the dramacool link for it") is a lookup only: run it without
`--play`.

```sh
node ~/.claude/skills/dramacool/search.mjs --play summer vacation --episode 3
node ~/.claude/skills/dramacool/search.mjs --play summer vacation 2026 --episode 3
node ~/.claude/skills/dramacool/search.mjs --play love wins all --season 2 --episode 5
node ~/.claude/skills/dramacool/search.mjs pink summer
```

Give the Bash call a timeout of at least 150 seconds with `--play`: the script waits until the
episode is running.

What the search does: it reads the site's own search page (`/?s=`), its first 20 titles, with a
plain request and no browser. With `--episode` it then reads the page of each matching title and
takes the episode that page links under "All Episodes".

The site shows nothing before the episode. The player belongs to another host (vidbasic, the
site's "Fast Server"), which lays small adverts over the picture, in full screen too; the ad
blocker in the streaming Chrome keeps them away (none came in a play on 2026-11-18). `--play`
never presses them: their "Close" opens an advertising page, sometimes in the place of the
episode. The whole flow takes about 9 seconds. Only the site's first server is played.

It prints JSON:

- `matches`: the results whose name is the asked title (its name, or its name with the season),
  and whose year is the asked year when one was given, in the site's order. Each has `title`
  (name and year), `kind` (always `series`: every title is a list of episodes), and `url`.
- `others`: every other result. The search is fuzzy, so most of these are unrelated.
- `episode`, with `--episode` only: the one episode that fits (`season`, `episode`, `url`, and
  `title`, its series), found on the page of every matching title; null when none or several
  fit, and then `episode_candidates` lists the ones that do.
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
  means the site moved to another host: ask the user for the current address and rerun with
  `DRAMACOOL_ORIGIN=https://<host>`. `no_chrome` means Chrome is not installed on Windows.

What `--play` does, only when exactly one matching title has the episode: a Chrome with its own
profile folder (`%LOCALAPPDATA%\notesd-stream-chrome`, apart from the user's everyday Chrome)
comes to the front, opens the episode's page, starts the player, and once the episode is running
the window goes full screen with the player stretched over it. The user leaves full screen with
F11 (Esc gives the page back inside the full-screen window). Never close a Chrome this skill did
not start.

- `play.playing: true` with `fullscreen`, `duration_s` and `muted`: the episode is on screen.
  The player remembers where the episode was left, so `position_s` may not be 0.
- `play.skipped_play`: nothing was started. `series`: no episode was asked for; give the title's
  link. `no_match`: see step 3. With `--episode`: `no_episode` (no matching title has that
  episode: say so; a title the site lists without any video answers this too),
  `several_episodes` (two titles, or two seasons, have an episode of that number: list
  `episode_candidates` with series and season, ask which, then play the chosen one with
  `--play-url <its url>`).
- `play.playing: false` with `stage` or `error`: the flow stopped there, usually because the
  window was minimized while it waited (`visible: false`). Say where it stopped; running the
  same command again starts over.

To play a link the user already has from an earlier answer: `search.mjs --play-url <url>`. Only
an episode's page plays (`.../<title>-episode-<n>.html`); a title's page is a link.

## Step 3: answer

- **An episode was started:** one line: the series' `title` with the episode (and the season
  when it is not the first) as a markdown link to `episode.url`, that it is playing full screen
  in the streaming Chrome window, and F11 to leave full screen.
- **One or more matches, nothing started:** one line per match: the `title` as a markdown link
  to its `url`. When the matches have different years (a remake and its original, or two
  seasons), say so in one line and let the user pick.
- **No match, but `others` holds a near miss** (the same title with a subtitle, another
  spelling, a sequel): show up to three of those as links and say plainly that none is exact.
  Do not play a near miss without being asked.
- **No match and nothing close:** say the site does not have it under that name. One retry is
  worth it when the title has an obvious other form (a romanized original title, a title without
  its subtitle); say which name found it.
- **`ok: false`:** report the error in one line. Do not fall back to a guessed link.

The link in the answer opens in the user's default browser as a fresh page: a page that is
already playing cannot be handed over through a link, which is why the episode plays in the
streaming Chrome window. That Chrome runs uBlock Origin Lite, which the owner added to its profile, so most of a site's adverts do not show in it.

Do not look for the episode's video or download sources, and do not press anything on the page
beyond what `--play` does.

Keep the answer short: the links, and at most one line of comment.
