---
name: direct-stream
description: Stream a film or one episode of a series straight from a cloud source into mcp-notes' own player page, full screen in the streaming Chrome on Windows, with an English subtitle when a source has one and no site adverts. Use whenever the user types "/direct-stream <title>" or "/direct-stream <title> <year>" in any Claude Code session — e.g. "/direct-stream saltburn", "/direct-stream dune 2021", "/direct-stream the bear season 2 episode 3", "this is a LOTR night. let's /direct-stream the first one" — and for a plain-English request to the same effect, such as "stream Saltburn directly", "direct-stream that one" — and for a request to stream something the user describes instead of naming: "stream a Johnny Depp movie, the more recent the better", "pick a Spanish series from this year and play it", "let's stream the most recent Shudder movie", "play one of Nolan's movies", "resume One Piece from episode 730", "I watched House of the Dragon season 1 last year, start season 2". Also for a request that ends with one of the user's watch codenames: TM or TS (stream a film or a series from a torrent), NTM or NTS (from a cloud provider, never a torrent) — "play some chinese action movie TM", "continue OP TS". Also use it to cache one on this laptop before watching it — "cache One Piece episode 790 first", "download the next episode so it doesn't lag", "is it cached?", "clear the cache of that one." A question such as "can I stream Saltburn directly?" is a lookup that starts nothing.
argument-hint: <title> [year] [season N episode M] [TM|TS|NTM|NTS] | <a description: a person, studio, service, language, genre, year>
---

# /direct-stream — stream a film straight to the player page

The text after `/direct-stream` names a film or a series episode, or describes one. Start it
through the `notes` MCP server's tools: `mcp__notes__direct_stream_play`,
`mcp__notes__direct_stream_find` and, when no title is named, `mcp__notes__direct_stream_discover`. Do not
answer from memory, do not build a stream address, and do not open a provider's page yourself:
the daemon finds the source and opens the player.

How it works, and what can go wrong, is in `docs/guide/streaming.md` of the mcp-notes repo
("Direct streaming").

## Codenames

The user names where a title is watched from with one upper-case word. It is a whole word, usually
the last of the request, and never part of the title: take it off before reading the title.

| Codename | Source | Kind | How it plays |
| --- | --- | --- | --- |
| DM | the library (a file the user downloaded) | film | `movies_continue`, VLC (the `/n` skill) |
| DS | the library | series | `movies_continue`, VLC |
| NTM | a cloud provider, never a torrent | film | `direct_stream_play` with `provider: "cloud"` |
| NTS | a cloud provider, never a torrent | series | `direct_stream_play` with `provider: "cloud"` |
| TM | a torrent | film | `direct_stream_play` with `provider: "torrent"` |
| TS | a torrent | series | `direct_stream_play` with `provider: "torrent"` |

- The M or S also gives the `kind` (`movie` or `tv`) when you look a title up or discover one.
- A codename at the start of a remark ("TM shadow edge is smooth af") says what was played and how.
  It asks for nothing; a request that follows in the same message keeps that codename.
- Without a codename nothing changes: pass no `provider`.
- `provider: "cloud"` never falls back to a torrent, and `provider: "torrent"` asks no cloud
  provider. When one answers `no_source`, say so and offer the other; do not switch unasked.

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
- **A season named without an episode** ("play House of the Dragon season 2"): pass `season`
  alone. The daemon starts that season's first unfinished episode (`picked`: `first`, `resume` or
  `next`); a season already finished starts again at its first episode.
- **"Rewatch" a series** is `season: 1, episode: 1`, unless the user names another episode.
- **A title the user half remembers** ("a spanish movie called something like looking through your
  window"): work out the real title first, from what you know and then `WebSearch` (Through My
  Window, 2022), and play it by that name and year. Say which title you took it for. `did_you_mean`
  covers a near miss; a description is yours to resolve.
- **"The film X made before this one"** is `direct_stream_discover` with `person`, `kind: "movie"`
  and `sort: "newest"`: every title carries its `release_date`, so take the first one released
  before the film named, leaving out galas and voice roles.
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
| "horror", "action", "comedy" | `genre`, one or several (every one must fit) |
| what it is about: "mafia", "zombies", "bloody" | `keyword`, one or several (any may fit) |
| "Kdrama" | `kind: "tv"`, `language: "Korean"` |
| "Chinese" | `language: "Chinese"`: Mandarin (`zh`) and Cantonese (`cn`) together |
| a person's "most recent project" | `person`, `sort: "newest"`, no `kind`; skip entries where the role is Self |

- **A genre is read per kind.** TMDB files series under fewer genres: for a series "action" is
  Action & Adventure and "sci-fi" is Sci-Fi & Fantasy, and there is no Horror, Thriller or Romance.
  Pass those as `keyword` for a series. `filters.genres` says what was understood.
- **A keyword is a hint, not a promise.** TMDB tags few titles, recent and non-English ones least.
  Pass a few words that mean the same ("mafia", "gangster", "organized crime") and, when a genre is
  close, the genre too ("crime"). When no title carries a keyword, the list comes back without the
  keyword filter and `filters.keywords_dropped` is `true`: choose from it by overview and by what
  you know of the titles (`WebSearch` when unsure), and say the list was not filtered by it. When
  nothing listed fits, find a title that does yourself and play it by name and year.
- **A misspelt person** ("park bo yeung") is still found when the name is a letter or two off
  (`filters.person.asked_as` keeps the words asked). Pass the right spelling when you know it.

Each title comes back marked against the library: `seen`, `started`, `not_interested`, and
`stream.verified` (this laptop has a recently verified source). `filters` names the person,
companies or service the name was read as; `other_people`, `other_companies` and `other_services`
list what else it fits. When the wrong one was used, call again with `person_id`, `company_id`
or `service_id`.

- **"pick one for me", "play one", "stream a ... movie" are asking.** Pass `unseen_only: true` to
  `direct_stream_discover`: the titles the user has seen or marked not interested are then not in
  the list at all (`left_out` counts them), so the one you choose is never one they watched.
  Choose one title yourself: the newest when they asked for recent, otherwise one you can give a
  reason for.
- **A title you chose yourself is never a dead end.** When it answers `no_source`, do not ask the
  user what to do next: choose another title from the same `direct_stream_discover` list and play
  that instead, at most twice more (three tried in all), then say which ones failed and which one
  played. This matters most for TM/TS ("play any comedy movie released on 2025 TM", "play
  something from torrent"): a torrent's swarm can be dead for one title and alive for the next, so
  working down the list is what makes an open-ended torrent request actually land, instead of
  stopping at the first title's bad luck. It does not apply to a title the user named themselves
  (`/direct-stream <title>`, "play The Shadow's Edge TM"): that one's failure is reported and the
  user is asked, never swapped for another title without asking.
- **A rewatch is never filtered.** "Rewatch one of Nolan's movies", "let's watch that Madelyn Cline
  film again" is the same call without `unseen_only`, choosing among the ones marked `seen`. A
  title the user names ("play The Map That Leads to You") goes straight to `direct_stream_play`,
  seen or not: `unseen_only` is only for a title you choose.
- **Everything was seen** (`titles` empty, `left_out` set): say so, name what they have seen, and
  ask whether to watch one again. Do not pick one unasked. Play it with
  `direct_stream_play`, passing its `title_key` as `title`, and say which one you chose and why.
  When it answers `no_source`, choose another from the list, at most twice more, and say so.
- **"what are ...?", "which ...?" alone are questions.** List the titles with their years and
  start nothing. "What are Blumhouse's movies this year? play one" is both: list them, then play
  one.
- **Nothing passes the filters:** say so; do not fall back to a title from memory.

Worked examples (the year is this year's):

| The user said | Calls |
| --- | --- |
| let's watch some spanish series. pick one for me. find the one that was released this year | `direct_stream_discover {kind: "tv", language: "Spanish", year, unseen_only: true}`, then `direct_stream_play {title: <title_key>}` |
| stream a johnny depp movie. the more recent the better | `direct_stream_discover {person: "Johnny Depp", role: "cast", kind: "movie", sort: "newest", unseen_only: true}`, then play the first |
| let's start resume one piece from episode 730 | `direct_stream_play {title: "one piece", absolute_episode: 730}` |
| i wanna rewatch penguin. let's stream it | `direct_stream_play {title: "the penguin", kind: "tv", season: 1, episode: 1}` |
| let's stream the most recent Shudder movie | `direct_stream_discover {kind: "movie", service: "Shudder", sort: "newest", unseen_only: true}`, then play the first |
| what are Blumhouse's movie that was released this year? play one | `direct_stream_discover {company: "Blumhouse", kind: "movie", year}` (no `unseen_only`: they asked what there is); list them, then play one that is not marked `seen` or `not_interested` |
| play one of Nolan's movie | `direct_stream_discover {person: "Christopher Nolan", role: "director", kind: "movie", unseen_only: true}`, then play one |
| i watched House of The Dragon season 1 last year. start season 2 | `direct_stream_find {title: "house of the dragon"}`, `movies_mark {title: <title_key>, season: 1, watched: true}`, `direct_stream_play {title: <title_key>, season: 2, episode: 1}` |
| i want to watch Joko Anwar's movie. play one | `direct_stream_discover {person: "Joko Anwar", role: "director", kind: "movie", unseen_only: true}`, then play one |
| let's watch James Gunn's superman | `direct_stream_discover {person: "James Gunn", role: "director", kind: "movie"}`, then `direct_stream_play {title: <the title_key of Superman>}` |

The ten requests the codenames were written for:

| The user said | Calls |
| --- | --- |
| play some chinese action movie TM | `direct_stream_discover {kind: "movie", language: "Chinese", genre: "action", unseen_only: true}`, then `direct_stream_play {title: <title_key>, provider: "torrent"}` |
| TM shadow edge is smooth af. let's play jackie chan's movie before this one now | The first sentence is a remark (The Shadow's Edge, 2025, played from a torrent) and its codename carries to the request. `direct_stream_discover {person: "Jackie Chan", role: "cast", kind: "movie", sort: "newest"}`; take the first film with a `release_date` before The Shadow's Edge's, leaving out galas and voice roles; `direct_stream_play {title: <title_key>, provider: "torrent"}` |
| continue OP TS | `direct_stream_play {title: "OP", provider: "torrent"}` (OP is a name the library holds for One Piece; no episode, so it carries on) |
| there is a spanish movie called smth like looking through your window . TM | Work the title out first (Through My Window, 2022), then `direct_stream_play {title: "Through My Window", year: 2022, provider: "torrent"}` |
| play one of indonesian horror movie released this year TM | `direct_stream_discover {kind: "movie", language: "Indonesian", genre: "horror", year, unseen_only: true}`, then play one with `provider: "torrent"` |
| play one of thai comedy movie released on 2025 TM | `direct_stream_discover {kind: "movie", language: "Thai", genre: "comedy", year: 2025, unseen_only: true}`, then play one with `provider: "torrent"` |
| play one of Kdrama with bloody action genre TS | `direct_stream_discover {kind: "tv", language: "Korean", genre: "action", keyword: ["gore", "bloody", "violence", "revenge"], unseen_only: true}`, then `direct_stream_play {title: <title_key>, provider: "torrent"}` |
| what is the most recent park bo yeung project? let's watch it TS | `direct_stream_discover {person: "Park Bo-young", sort: "newest"}` (no `kind`: films and series together); the first entry where she is not Self; `direct_stream_play {title: <title_key>, provider: "torrent"}` |
| i miss korean mafia movies. play one released this year TM | `direct_stream_discover {kind: "movie", language: "Korean", genre: "crime", keyword: ["mafia", "gangster", "organized crime"], year, unseen_only: true}`, then play one with `provider: "torrent"` |
| play House of Dragon season 2 TS | `direct_stream_play {title: "House of the Dragon", season: 2, provider: "torrent"}` |
| play something from torrent | `direct_stream_discover {unseen_only: true}` (no filters at all: any kind, any title), then `direct_stream_play {title: <title_key>, provider: "torrent"}`; on `no_source` try the next title on the list, at most twice more |
| play any comedy movie released on 2025 TM | `direct_stream_discover {kind: "movie", genre: "comedy", year: 2025, unseen_only: true}`, then play down the list with `provider: "torrent"` until one starts, at most three titles tried |

`movies_mark` with `season` marks that season's episodes finished, not the series, and it stores
a series the library does not hold yet when `title` is its `title_key` (`tv-94997`).
`movies_mark {title, not_interested: true}` is for "I am not interested in that one".

## Caching first

A slow connection or a far stream host makes a stream stutter or stop. The daemon can download one
film or episode to this laptop first, with `mcp__notes__direct_stream_cache` (its description names
the arguments). Work out the title as in step 1 first.

- **"cache X first", "download the next episode so it doesn't lag":** start a cache with the same
  title fields `direct_stream_play` takes, and a maximum height when the user named a quality ("in
  720p"). Say it is downloading, and that a play started now already plays from it.
- **"cache it and play it":** start the cache, then call `direct_stream_play`: the play uses the
  cache while it downloads.
- **"is it cached?", "how far is the download?":** ask for its status and say the state
  (`downloading` with its progress, `ready`, `failed` with why) and the quality. A cache made on the
  other laptop answers `available: false` here: say it is on the other laptop and cannot play here.
- **"clear the cache of X":** clear it. Nothing else removes a cache.

A play needs nothing extra: `direct_stream_play` uses this laptop's cache of the title by itself.

## Step 2: play, or look

`/direct-stream <title>` and "stream it" mean start it: call `direct_stream_play` once with
`title`, `year` when known, `kind` when known, and `season` and `episode` when the user named
them. It takes 5 to 40 seconds; wait for it. The tool always answers within about 45 seconds:
a play that needs longer answers `pending: true` (see step 3).
"stream it from a torrent", TM and TS are `provider: "torrent"`: only the torrent source is asked.
NTM and NTS are `provider: "cloud"`: only the cloud providers are asked, and never a torrent.

A series named without an episode starts where the user left it. The daemon keeps every play
(streams and VLC) in its database, so this works across sessions and restarts: `picked` is
`resume` (the episode played last is unfinished, and it carries on from the position it stopped
at), `next` (the episode after the last finished one) or `first` (nothing played yet: season 1,
episode 1).

A question ("can I stream it directly?", "is Saltburn streamable?") is a lookup: call
`direct_stream_find`. It opens nothing.

The rule for a film in the library: `/direct-stream` or "stream" means stream it, even when the
file is here. Without those words a library film plays in VLC (`movies_continue`), not here.

### A magnet the user pasted

When the user pastes a magnet link (`magnet:?xt=urn:btih:...`), or a bare 40-character info hash,
play that exact torrent with `direct_stream_play`'s `magnet` argument, skipping every index. This is
for a torrent the user found themselves (e.g. on ext.to) when the indexes have nothing.

- **Still name the title.** The magnet only says which torrent; `title` (with `year`/`kind` when
  known) gives the play its title, poster, resume position and the original-language check. When the
  user pasted only a magnet in this session, take the title from what was just discussed (the film
  they were trying to watch). When no title is anywhere to be found, the magnet's `dn` names it, so
  pass that as `title`; say you took the name from the magnet.
- It is a torrent play, so you need not set `provider`. The file plays only when its audio is the
  title's original language and it holds a video Chrome can play; a magnet that is a dub, or one with
  no video file (a soundtrack/OST, a sample, a subtitle pack), answers `no_source` with a single
  `Torrent: <name>` attempt saying why. Say that plainly; do not retry.
- Never build or guess a magnet yourself, and never pass one the user did not give: this is only for
  a link the user pasted.

## Step 3: answer

- **`started: false` with `pending: true`:** the play is still being started in the daemon (a
  torrent whose swarm is slow, a resolve through many providers), and the player opens by itself
  when a source plays. Say in one line that it is still starting and what is being tried (`stage`,
  and the `attempts` finished so far), then call `direct_stream_play` again with exactly the same
  arguments: that joins the play in flight and never starts a second one. Do not try another
  source meanwhile.
- **`started: true`:** one line: the title (with its year and movie id when it has one), the
  provider and whether an English subtitle is on (from `play`), that it plays full screen in the
  streaming Chrome window, and that a double click (or F, Esc, F11) leaves full screen. For a
  series also the season and
  episode, and with `picked` why that one: carried on from where it stopped (`resume`), the next
  episode (`next`), or the first (`first`).
  When `play.session.cached` is set, say it plays from this laptop's cache: `ready` (no provider was asked; it plays even offline) or `downloading` (a part not downloaded yet is fetched as it is reached). Name the provider from `play.session.provider`; `attempts` is empty.
  When `play.session.torrent` is set (provider `Torrent`), say it plays from a torrent: name the release
  (`torrent.name`), and say it downloads while it plays (`state: "downloading"`) or plays from this laptop's
  disk (`ready`, no `Index:` or `Torrent:` attempt: no index and no swarm was asked).
  When `attempts` holds `Subtitles: pending`, the film started before the subtitle search ended: say
  the subtitle appears by itself in a moment, not that there is none.
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
- **`skipped_play: "no_such_season"`:** the series has no such season; say so with `seasons`.
- **`skipped_play: "no_match"` with `did_you_mean`:** a site often calls a title by another name
  than TMDB does. Say no title has that exact name, list each `did_you_mean` entry with its year
  and kind, and ask whether one of them is meant. Do not play one unasked. When the user picks
  one, call `direct_stream_play` again with its `title_key` as `title` and `asked_as` set to the
  name the user first typed, word for word: the daemon remembers that name, so next time it finds
  the title directly. Never pass `asked_as` for a name the user did not use.
- **`skipped_play: "no_match"` with an empty `did_you_mean`:** say no title has that name (and
  year). One retry is worth it when the title has an obvious other form (an original-language
  title); say which name found it.
- **Error `no_source`:** nothing started. For a title you chose yourself from a
  `direct_stream_discover` list (not one the user named), try the next title on that list instead
  of reporting failure — see Step 1b. For a title the user named, say no source could stream it,
  then one short line per attempt from `attempts` with its `outcome` (`no_stream`, `bot_check`,
  `error`, `dubbed`, `unplayable`, `skipped_browser_only`). The daemon tries a torrent before answering, so `attempts`
  may end with `Index: <name>` (a torrent index asked) and `Torrent: <release>` (a torrent tried;
  `unplayable`: Chrome cannot play its file). Offer `/idlix` or `/lk21`. Do not call again unless asked.
  With `provider: "cloud"` (NTM, NTS) no torrent was tried, and with `provider: "torrent"` (TM, TS)
  no cloud provider: say which, and offer the other source.
  - **When an attempt is `Index: ext: bot_check`** (a torrent play, TM/TS), ext.to's Cloudflare gate
    stopped the search, and it only clears when the owner solves it by hand in the streaming Chrome.
    Offer to open it: run `node claude/streaming/torrent/cli.mjs ext gate` from the mcp-notes
    checkout (it brings ext's tab to the front; wait for its `{ cleared }` answer), tell the owner
    to solve the "Just a moment" / Turnstile check in that window, and once it answers `cleared: true`
    retry the same `direct_stream_play` — the daemon's ext search then rides the cookie the Chrome
    kept. Do this only when the owner agrees; never forge or click the challenge for them.
- **Error `torrent_off`:** torrents are off on this machine (`NOTESD_TORRENT=off`); say so and offer
  to stream it from a cloud provider (call again without `provider`).
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
