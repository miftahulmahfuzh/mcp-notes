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
- **A series:** pass `kind: "tv"` when the user said it is a series. Pass `season` and `episode`
  only when the user named them ("the bear season 2 episode 3"); an episode's movie id (`M-23T4`)
  names both, so pass it alone as `title`. Without them the daemon carries the series on from what
  was watched: do not ask which episode, and do not work one out yourself.
- **Words that are not part of the name** ("(TV Series 2026)", "the series", "the 2021 film") give
  the `kind` and the `year`; leave them out of `title`.
- **A movie id or title key** from an earlier answer (`M-23T4`, `movie-550`) is passed as
  `title` as is.

## Step 2: play, or look

`/direct-stream <title>` and "stream it" mean start it: call `direct_stream_play` once with
`title`, `year` when known, `kind` when known, and `season` and `episode` when the user named
them. It takes 5 to 40 seconds; wait for it.

A series named without an episode starts where the user left it. The daemon keeps every play
(streams and VLC) in its database, so this works across sessions and restarts: `picked` is
`resume` (the episode played last is unfinished, and it carries on from the position it stopped
at), `next` (the episode after the last finished one) or `first` (nothing played yet: season 1,
episode 1).

A question ("can I stream it directly?", "is Saltburn streamable?") is a lookup: call
`direct_stream_find`. It opens nothing.

The rule for a film in the library: `/direct-stream` or "stream" means stream it, even when the
file is here. Without those words a library film plays in VLC (`movies_continue`), not here.

## Step 3: answer

- **`started: true`:** one line: the title (with its year and movie id when it has one), the
  provider and whether an English subtitle is on (from `play`), that it plays full screen in the
  streaming Chrome window, and that F11 leaves full screen. For a series also the season and
  episode, and with `picked` why that one: carried on from where it stopped (`resume`), the next
  episode (`next`), or the first (`first`).
- **`skipped_play: "several_matches"`:** one line per candidate with its year and kind; ask which
  one. When the user picks, call `direct_stream_play` again with that candidate's `movie_id`
  (or its exact title and year when it has none).
- **`skipped_play: "caught_up"`:** the last episode played (`last`) is finished and none comes
  after it. Say so; to watch one again the user names a season and an episode (`seasons` lists
  what there is).
- **`skipped_play: "not_aired"`:** say which episode is next and that it airs on `air_date`.
- **`skipped_play: "no_match"` with `did_you_mean`:** a site often calls a title by another name
  than TMDB does. Say no title has that exact name, list each `did_you_mean` entry with its year
  and kind, and ask whether one of them is meant. Do not play one unasked. When the user picks
  one, call `direct_stream_play` again with its `title_key` as `title` and `asked_as` set to the
  name the user first typed, word for word: the daemon remembers that name, so next time it finds
  the title directly. Never pass `asked_as` for a name the user did not use.
- **`skipped_play: "no_match"` with an empty `did_you_mean`:** say no title has that name (and
  year). One retry is worth it when the title has an obvious other form (an original-language
  title); say which name found it.
- **Error `no_source`:** nothing started. Say no source could stream it, then one short line per
  provider from `attempts` with its `outcome` (`no_stream`, `bot_check`, `error`, `dubbed`,
  `skipped_browser_only`). Offer `/idlix` or `/lk21`. Do not call again unless asked.
- **`direct_stream_off`:** direct streaming is off on this daemon (or this is the machine
  without it). Say so; offer `/idlix` or `/lk21`.
- **Error `resolve_failed` or `open_failed`:** the streaming Chrome could not be used; report
  `reason` in one line (`no_chrome`: Chrome is not installed on Windows; `chrome_not_reachable`:
  the streaming Chrome did not answer) and offer `/idlix` or `/lk21`.
- **Another error:** report it in one line.

A stream always plays in the title's original language. A provider whose stream is dubbed is
skipped (`dubbed` in `attempts`: say so in a few words when it happened, since the next provider
may be slower or lack a subtitle). `play.session.audio.original` is `true` when the stream names
the original language and `null` when it names none; a dub never plays. An English subtitle a
dub came with is lent to the stream that plays (`borrowed_from` on the track).

Never start a stream the user did not ask for, and never because you recommended a film.
Keep the answer short.
