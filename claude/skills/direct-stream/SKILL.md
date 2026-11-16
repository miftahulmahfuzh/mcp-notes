---
name: direct-stream
description: Stream a film or one episode of a series straight from a cloud source into mcp-notes' own player page, full screen in the streaming Chrome on Windows, with an English subtitle when a source has one and no site adverts. Use whenever the user types "/direct-stream <title>" or "/direct-stream <title> <year>" in any Claude Code session — e.g. "/direct-stream saltburn", "/direct-stream dune 2021", "/direct-stream the bear season 2 episode 3", "this is a LOTR night. let's /direct-stream the first one" — and for a plain-English request to the same effect, such as "stream Saltburn directly", "direct-stream that one" — and for a request to stream something the user describes instead of naming: "stream a Johnny Depp movie, the more recent the better", "pick a Spanish series from this year and play it", "let's stream the most recent Shudder movie", "play one of Nolan's movies", "resume One Piece from episode 730", "I watched House of the Dragon season 1 last year, start season 2". A question such as "can I stream Saltburn directly?" is a lookup that starts nothing.
argument-hint: <title> [year] [season N episode M] | <a description: a person, studio, service, language, year>
---

# /direct-stream — stream a film straight to the player page

The text after `/direct-stream` names a film or a series episode, or describes one. Start it
through the `notes` MCP server's tools: `mcp__notes__direct_stream_play`,
`mcp__notes__direct_stream_find` and, when no title is named, `mcp__notes__direct_stream_discover`. Do not
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
- **An episode named by one number, without a season** ("resume one piece from episode 730",
  "the bear episode 11"): pass `absolute_episode` alone, never a season you worked out. The daemon
  maps it to the season and episode TMDB lists and answers which one it chose.
- **"Rewatch" a series** is `season: 1, episode: 1`, unless the user names another episode.
- **A person tells two titles of one name apart:** "James Gunn's Superman" names a director, and
  TMDB lists several films called Superman, two of them in 2025. Look with
  `direct_stream_discover` (`person`, `role: "director"`) and play the match by its `title_key`;
  a title and a year alone would answer `several_matches`.
- **Words that are not part of the name** ("(TV Series 2026)", "the series", "the 2021 film") give
  the `kind` and the `year`; leave them out of `title`.
- **A movie id or title key** from an earlier answer (`M-23T4`, `movie-550`) is passed as
  `title` as is.

## Step 1b: no title was named

"A Spanish series from this year", "a Johnny Depp movie", "the most recent Shudder movie" describe
titles. Find them with `direct_stream_discover`, which starts nothing:

| The user said | Call |
| --- | --- |
| a kind | `kind`: `movie` or `tv` |
| "this year", "from the nineties" | `year`, or `year_from` and `year_to` |
| "Spanish", "Korean", "Indonesian" | `language` (the original language, by name) |
| an actor | `person`, `role: "cast"` |
| "Nolan's", "directed by", "a Joko Anwar film" | `person`, `role: "director"` |
| a studio ("Blumhouse", "A24") | `company` (it stands for every company whose name starts with it; `filters.companies` lists them) |
| a streaming service or network ("Shudder", "Netflix") | `service` (`region` when not the US) |
| "the most recent", "the newer the better" | `sort: "newest"` |

Each title comes back marked against the library: `seen`, `started`, `not_interested`, and
`stream.verified` (this laptop has a recently verified source). `filters` names the person,
companies or service the name was read as; `other_people`, `other_companies` and `other_services`
list what else it fits. When the wrong one was used, call again with `person_id`, `company_id`
or `service_id`.

- **"pick one for me", "play one", "stream a ... movie" are asking.** Choose one title yourself:
  not one marked `seen` or `not_interested` (unless the user wants a rewatch), the newest when
  they asked for recent, otherwise one you can give a reason for. Play it with
  `direct_stream_play`, passing its `title_key` as `title`, and say which one you chose and why.
  When it answers `no_source`, choose another from the list, at most twice more, and say so.
- **"what are ...?", "which ...?" alone are questions.** List the titles with their years and
  start nothing. "What are Blumhouse's movies this year? play one" is both: list them, then play
  one.
- **Nothing passes the filters:** say so; do not fall back to a title from memory.

Worked examples (the year is this year's):

| The user said | Calls |
| --- | --- |
| let's watch some spanish series. pick one for me. find the one that was released this year | `direct_stream_discover {kind: "tv", language: "Spanish", year}`, then `direct_stream_play {title: <title_key>}` |
| stream a johnny depp movie. the more recent the better | `direct_stream_discover {person: "Johnny Depp", role: "cast", kind: "movie", sort: "newest"}`, then play the first |
| let's start resume one piece from episode 730 | `direct_stream_play {title: "one piece", absolute_episode: 730}` |
| i wanna rewatch penguin. let's stream it | `direct_stream_play {title: "the penguin", kind: "tv", season: 1, episode: 1}` |
| let's stream the most recent Shudder movie | `direct_stream_discover {kind: "movie", service: "Shudder", sort: "newest"}`, then play the first |
| what are Blumhouse's movie that was released this year? play one | `direct_stream_discover {company: "Blumhouse", kind: "movie", year}`; list them, then play one |
| play one of Nolan's movie | `direct_stream_discover {person: "Christopher Nolan", role: "director", kind: "movie"}`, then play one |
| i watched House of The Dragon season 1 last year. start season 2 | `direct_stream_find {title: "house of the dragon"}`, `movies_mark {title: <title_key>, season: 1, watched: true}`, `direct_stream_play {title: <title_key>, season: 2, episode: 1}` |
| i want to watch Joko Anwar's movie. play one | `direct_stream_discover {person: "Joko Anwar", role: "director", kind: "movie"}`, then play one |
| let's watch James Gunn's superman | `direct_stream_discover {person: "James Gunn", role: "director", kind: "movie"}`, then `direct_stream_play {title: <the title_key of Superman>}` |

`movies_mark` with `season` marks that season's episodes finished, not the series, and it stores
a series the library does not hold yet when `title` is its `title_key` (`tv-94997`).
`movies_mark {title, not_interested: true}` is for "I am not interested in that one".

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
  streaming Chrome window, and that a double click (or F, Esc, F11) leaves full screen. For a
  series also the season and
  episode, and with `picked` why that one: carried on from where it stopped (`resume`), the next
  episode (`next`), or the first (`first`).
- **`skipped_play: "several_matches"`:** one line per candidate with its year and kind; ask which
  one. When the user picks, call `direct_stream_play` again with that candidate's `movie_id`
  (or its exact title and year when it has none).
- **`skipped_play: "caught_up"`:** the last episode played (`last`) is finished and none comes
  after it. Say so; to watch one again the user names a season and an episode (`seasons` lists
  what there is).
- **`skipped_play: "not_aired"`:** say which episode is next and that it airs on `air_date`.
- **`picked: "absolute"`:** say which season and episode plays and that it is episode
  `absolute_episode` counted from the first.
- **`skipped_play: "episode_unclear"`:** the number can be read two ways (`reading: "count"`, the
  n-th episode in order; `reading: "number"`, the episode with that number in its season). List
  the `candidates` as season and episode and ask which; then call again with that `season` and
  `episode`.
- **`skipped_play: "no_such_episode"`:** the series has `episodes` episodes; say so.
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
