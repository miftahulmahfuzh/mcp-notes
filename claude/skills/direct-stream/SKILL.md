---
name: direct-stream
description: Stream a film or one episode of a series straight from a cloud source into mcp-notes' own player page, full screen in the streaming Chrome on Windows, with an English subtitle when a source has one and no site adverts. Use whenever the user types "/direct-stream <title>" or "/direct-stream <title> <year>" in any Claude Code session — e.g. "/direct-stream saltburn", "/direct-stream dune 2021", "/direct-stream the bear season 2 episode 3", "this is a LOTR night. let's /direct-stream the first one" — and for a plain-English request to the same effect, such as "stream Saltburn directly", "direct-stream that one". A question such as "can I stream Saltburn directly?" is a lookup that starts nothing.
argument-hint: <title> [year] [season N episode M]
---

# /direct-stream — stream a film straight to the player page

The text after `/direct-stream` names a film or a series episode. Start it through the `notes` MCP
server's tools, `mcp__notes__direct_stream_play` and `mcp__notes__direct_stream_find`. Do not
answer from memory, do not build a stream address, and do not open a provider's page yourself:
the daemon finds the source and opens the player.

How it works, and what can go wrong, is in `docs/guide/streaming.md` of the mcp-notes repo
("Direct streaming").

## Step 1: work out one title

- **The user typed it:** `/direct-stream saltburn` is the title "saltburn", no year.
  `/direct-stream dune 2021` is "dune", year 2021. A trailing number is a year only when words
  come before it and it is a plausible release year, so `/direct-stream 1917` and
  `/direct-stream blade runner 2049` are whole titles.
- **The user points at one:** "the first one", "that one", "it" mean a title from this
  conversation or from what you know. "this is a LOTR night. let's /direct-stream the first one"
  is The Lord of the Rings: The Fellowship of the Ring, 2001. Pass that exact title and year.
  When you cannot tell which title is meant, ask; do not guess between two.
- **A series:** pass `kind: "tv"`, `season` and `episode` ("the bear season 2 episode 3").
  An episode's movie id (`M-23T4`) names both, so pass it alone as `title`.
- **A movie id or title key** from an earlier answer (`M-23T4`, `movie-550`) is passed as
  `title` as is.

## Step 2: play, or look

`/direct-stream <title>` and "stream it" mean start it: call `direct_stream_play` once with
`title`, `year` when known, and `kind`, `season`, `episode` for a series. It takes 5 to 40
seconds; wait for it.

A question ("can I stream it directly?", "is Saltburn streamable?") is a lookup: call
`direct_stream_find`. It opens nothing.

The rule for a film in the library: `/direct-stream` or "stream" means stream it, even when the
file is here. Without those words a library film plays in VLC (`movies_continue`), not here.

## Step 3: answer

- **`started: true`:** one line: the title (with its year and movie id when it has one), the
  provider and whether an English subtitle is on (from `play`), that it plays full screen in the
  streaming Chrome window, and that F11 leaves full screen.
- **`skipped_play: "several_matches"`:** one line per candidate with its year and kind; ask which
  one. When the user picks, call `direct_stream_play` again with that candidate's `movie_id`
  (or its exact title and year when it has none).
- **`skipped_play: "series"`:** say a series streams one episode at a time, list `seasons` (season
  and number of episodes) and ask which season and episode.
- **`skipped_play: "no_match"`:** say no title has that name (and year). One retry is worth it
  when the title has an obvious other form (an original-language title, without a subtitle);
  say which name found it.
- **Error `no_source`:** nothing started. Say no source could stream it, then one short line per
  provider from `attempts` with its `outcome` (`no_stream`, `bot_check`, `error`,
  `skipped_browser_only`). Offer `/idlix` or `/lk21`. Do not call again unless asked.
- **`direct_stream_off`:** direct streaming is off on this daemon (or this is the machine
  without it). Say so; offer `/idlix` or `/lk21`.
- **Error `resolve_failed` or `open_failed`:** the streaming Chrome could not be used; report
  `reason` in one line (`no_chrome`: Chrome is not installed on Windows; `chrome_not_reachable`:
  the streaming Chrome did not answer) and offer `/idlix` or `/lk21`.
- **Another error:** report it in one line.

Never start a stream the user did not ask for, and never because you recommended a film.
Keep the answer short.
