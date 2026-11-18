# Movies

## Sub-features
- Stream side (direct-streaming phase 9). Two icons at the top of `/movies` (group "Library or
  Stream") switch to `/movies?side=stream`: the same grid, fed by `GET /api/movies/stream`, which
  lists only titles with a `movie_stream_sources` row for this host, not stale, verified inside
  `NOTESD_STREAM_FRESH_DAYS`. No rail or sidebar entry. A title opened from it
  (`/movies/<id>?side=stream`) shows a stream line (provider, quality, English subtitle); its Play
  posts `POST /api/stream/play` once; `no_source` says so and the title leaves the grid on the
  refresh. A file here stays the default Play, the stream a second icon (R5.5). Series list every
  season, each episode streams when clicked. Proof: `web/src/App.stream.test.tsx`,
  `tests/integration/movies.stream.int.test.ts`; on a `verify.sh up --web --direct-stream` run
  (direct streaming on, phase 3's fake resolver), seed `movie_stream_sources` with `$V exec` (the
  daemon writes it only after a resolve) and stub `POST /api/stream/play` with Playwright
  `page.route` to choose its answer. Never give a throwaway run the real resolver.
- Stream grid upkeep: the refresh icon asks the prober for one pass now (`POST
  /api/stream/prober/pass`: the listing is rebuilt, idle is not waited for, a play still stops it);
  a title page's "not interested" icon takes a title off the grid (it shows only under that
  filter, and the prober's catalog stops counting and re-checking it); a poster under the
  pointer shows the watched flag (a series: every season) and, on the Stream side, "not
  interested", one click each with an undo and no confirmation (`.mv-tile-acts` is at opacity 0
  until `.mv-cell` is hovered; hover a poster with Playwright on an `up --web --movies` run, click
  `Mark <title> as watched`: the poster is gone from `all` at once and is under `finished`; read
  the title back as `finished`); each season has one button
  that marks all its episodes finished (`POST /api/movies/:id/episodes/watched`), an episode
  without a file has its own, and the notice offers an undo of exactly what changed. The caret
  before a season's name folds its episodes into a count, kept per title in the browser
  (`npx vitest run web/src/components/movies/EpisodeList.test.tsx`). The book icon of an episode
  opens its story, written once by Claude from the stored dialogue and kept
  (`POST /api/movies/:id/story`): `npx vitest run tests/unit/movies/story.test.ts web/src/components/movies/StoryModal.test.tsx`,
  `npm run test:int -- tests/integration/movies.api.int.test.ts` ("the story of an episode"). A
  throwaway daemon never writes one (`NOTESD_MOVIES_STORY_MODEL=off` is pinned): seed a dialogue row
  with a story through `$V exec` and open it on the page. Proof:
  `web/src/App.stream.test.tsx`, `tests/integration/movies.marks.int.test.ts`,
  `tests/unit/directStream/prober.test.ts` ("an asked pass").
- Names and the play menu (a title's page). A person, a studio or a genre clicked opens a pop-up
  (`EntityModal`): `GET /api/movies/people/:id` and `/companies/:id` read TMDB at each request;
  `GET|POST /api/movies/:id/genres/:genre` reads or collates the guide of that genre for that title
  (one model run with WebSearch, then `movie_genre_guides`). Every listed title carries `mark`
  (`watched`, `started`, `not_interested`) and `has_file`, read at the request, and a click opens
  the movie pop-up, after `POST /api/movies/ensure` for a title the library does not hold. A
  character still asks the chat. The caret beside Play, and on every episode row, is the play
  menu: the file (or pahe, `GET /api/movies/:id/pahe`), `POST /api/stream/play` with `provider`
  `cloud` or `torrent`, `POST /api/movies/:id/site-play` for a site. What played is kept per
  method (`movie_title_methods`), and a named kind goes back to it. Proof:
  `npx vitest run web/src/App.movies.test.tsx web/src/lib/movies.test.tsx tests/unit/movies/guides.test.ts tests/unit/directStream/rememberedChannel.test.ts`,
  `npm run test:int -- tests/integration/movies.guides.int.test.ts`. On an `up --web --movies` run
  the fake TMDB knows no person or studio profile, so the pop-up is driven with Playwright
  `page.route` on `/api/movies/people/*`; the play menu needs no stub to open, and its site, stream
  and pahe rows are stubbed the same way (never give a throwaway run a real site, resolver or
  model: `NOTESD_MOVIES_STORY_MODEL=off` is pinned, so a genre answers `guide_off` unless a row is
  seeded into `movie_genre_guides` with `$V exec`).
- Trending on torrents (Stream side, second section under the grid). `GET /api/movies/trending` is this
  host's daily list (`stream_trending`) of the most seeded films and series from apibay's top-100 and EZTV's
  newest pages, with a swarm probe per title (`TorrentStreams.peek`: file list only, no download row, no
  folder): `trending.probe.outcome` is `confirmed`, `no_peers`, `no_video`, `error` or null (not probed), and
  `seeds` is only the index's claim. Seen, started, watched and not-interested titles are read from
  `movie_titles` on every request and on every build, so a mark removes a title at once. `POST
  /api/movies/trending/refresh` runs a pass now. Needs `verify.sh up --web --trending` (fake index serves the
  top lists from `$TORRENT/trending.json`; fake TMDB answers `/find/<imdb>`); `NOTESD_TRENDING=off` is pinned
  otherwise. Proof: `scripts/trending/journey.sh RUN` (listing, filters, confirmed vs no_peers, nothing left
  behind by a probe, mark after build, then `trending.steps.mjs` in the page; the dead-swarm probe takes 20 s),
  `npx vitest run tests/unit/directStream/trending web/src/lib/movies.test.tsx`,
  `npm run test:int -- tests/integration/trending.int.test.ts`.
- VLC health (phase 9). Every `NOTESD_VLC_HEALTH_MS` (default 30 s; off at 0 or with no roots) each
  `vlc.exe` on this host is sampled through `tasklist.exe` / `powershell.exe` into
  `<dataDir>/movies/vlc-health-<host>.jsonl` (fsync'd lines: start, sample, idle, hang, clean_stop,
  incident). An unclean stop while sampling gives one incident on the next start with the Windows
  fault events around the last sample; a notesd VLC that stops answering while its process lives
  gets a hang line and its play stays open. While a `vlc.exe` exists each Windows `Display` event
  (4101: the driver was reset) gets a `gpu_reset` line, and a followed VLC that says `playing`
  with its clock advancing and its video counters frozen for three polls gets a `video_stall` line
  and `video_stalled: true` on `GET /api/movies/player`, which the Movies page shows as an amber
  alert line and "no picture in VLC" on the title (`web/src/App.movies.test.tsx`). Play or continue
  on the file already followed opens no second VLC (`already_playing`,
  `tests/unit/movies/player.rejoin.test.ts`), a restarted daemon follows the notesd VLC that is
  still open again (same play row; `tests/integration/movies.play.int.test.ts`, "a restarted
  daemon"; off with the health log, so never in `verify.sh up --movies`), and the grid marks the followed title's poster
  (playing / paused / no picture). On a title's page every genre, studio, crew member, cast
  member and character is a button that sends its own question through the pill (person id and
  the owner's position on the first line, a Google icon under the answer); the position is read
  from `GET /api/movies/player` when the question is sent, and the chat prompt holds back plot
  past it (`web/src/App.movies.test.tsx`, `tests/unit/chat-prompt.test.ts`). `GET /api/movies/player/health` returns it
  (`stalls`, `gpu_resets`). Proof: `npx vitest run tests/unit/movies/vlc.videoStall.test.ts` and
  `npm run test:int -- tests/integration/movies.health.int.test.ts tests/integration/movies.healthCrash.int.test.ts`
  (fake Windows side `tests/fixtures/movies/fake-windows.mjs`; the crash test needs WSL interop and
  is `inconclusive` elsewhere). `verify.sh up --movies` pins it off.
- Library sync. A background pass every `NOTESD_MOVIES_SCAN_MS` (and `POST /api/movies/sync`) walks
  `NOTESD_MOVIES_ROOTS` recursively for mkv, mp4, avi, m4v and webm. `ffprobe` drops anything under
  `NOTESD_MOVIES_MIN_SECONDS` as `too_short`; the rest is parsed from its path (Pahe dots, Pahe
  underscores, year only in the folder, SxxEyy in a season folder, absolute numbering, two films in
  one folder) and looked up on TMDB, with a Haiku fallback for unclear names. No match goes to the
  hidden unmatched list with a reason (`no_match`, `low_confidence`, `tmdb_error`,
  `no_tmdb_credentials`, `probe_failed`). TMDB unreachable: files stay `pending` and retry next pass.
- Titles: one per TMDB movie (`movie-<id>`) or series (`tv-<id>`), with poster, release date, synopsis,
  studios, directors, writers, producers, cast with characters, and per-season episode titles. A
  title is never deleted with its files.
- Files: per host. Gone from disk = deleted (row kept, deleted flag); same name and size elsewhere under
  the roots = moved (same row, new path); in or into a `NOTESD_MOVIES_DONE_DIRS` folder = done signal.
- State, derived at read time: finished (manual watched flag, done signal, or last position >= 90 %),
  in progress, unwatched, dropped (deleted partway), removed unwatched (deleted, never played), seen
  (only "opened" observations from VLC's recent list).
  A stream play (direct streaming) counts as one more copy of the film or episode and moves state
  the same way; a title known only from streams is not in the grid but opens by id. Proof:
  `npx vitest run tests/unit/movies/state.test.ts -t streams`,
  `npm run test:int -- tests/integration/movies.streams.int.test.ts`.
- User state: watched flag, 0-5 stars, review (a note tagged `#movie`, linked to the title).
- Play/Resume: starts the Windows `vlc.exe` on this host's file at the resume second, reads its status
  through Windows `curl.exe` every `NOTESD_VLC_POLL_MS` into one play event, closes it when VLC exits.
  Another host's file: `available: false`, play answers `not_on_this_machine`; no VLC/interop/curl:
  `player_unavailable`.
- VLC recents: each pass reads `[RecentsMRL]` from `NOTESD_VLC_INI`; entries become play observations,
  and a gone file becomes a deleted file under its matched title.
- Continue: `movies_continue` / `POST /api/movies/continue` resumes the latest unfinished episode or
  film, else starts the next episode whose file is here, else answers which episode is missing and
  which later ones are present. Without a title: the title of the newest play. MCP only:
  `random: true` ("play something") plays one title picked at random among those continue would
  play on this machine (`playSomething`, proven by `tests/integration/movies.mcp.int.test.ts`).
- Movie ids: every title and every episode of a series (with or without a file) has an `M-23T4` id
  (`movie_ids`, written by database triggers; `src/movies/ids.ts`). Tools, `GET /api/movies/<id>`
  and `/movies/<id>` on the wall take one; an episode's id opens its series scrolled to that
  episode. In wall chat an id is a link that opens the movie pop-up (Play, and a button to the
  page; while VLC has the title, or that episode, open it shows the outline, badge and position and
  re-reads them every 5 s); in Claude Code it is a link to the page (MCP instructions, the `note-links` mod).
  Proof: journey stage 1, `tests/integration/movies.mcp.int.test.ts` ("movie ids"),
  `web/src/App.movies.test.tsx` (the pop-up).
- Trailers: a title's details call also asks TMDB for its videos, and each season's call for that
  season's; the newest official YouTube trailer (a teaser only without one) is stored as a video id
  on the title (`trailer_key`, `season_trailers`). Titles stored before that are looked up ten per
  pass (`trailers_checked_at`). On the title's page the trailer icon beside Play, and one beside
  each season heading, plays it in a pop-up (`youtube-nocookie.com/embed/<id>`); with no trailer
  listed the same icon opens a YouTube search in a new tab. `movies_get` carries `trailer_url`.
  Proof: journey stages 1 and 12, `tests/unit/movies/tmdb.test.ts` (`pickTrailer`, `trailers`),
  `tests/integration/movies.sync.int.test.ts` ("looks up the trailers"),
  `web/src/App.movies.test.tsx` ("the trailer icon").
- MCP: `movies_list`, `movies_get`, `movies_history`, `movies_continue`, `movies_person`, `movies_mark`
  (also in the chat bar). SSE `changed` on `/api/movies/events`.
- `movies_mark` beyond watched, rating and review: `season` with `watched` marks one season's
  episodes finished or takes the marks back (the page's season button), `not_interested` sets or
  clears that mark, and a title key the library does not hold (`tv-94997`) is stored from TMDB
  first. Proof: `npm run test:int -- tests/integration/movies.mcp.int.test.ts`; on a
  `$V up --discovery` run, `direct-stream/discovery.sh RUN` (request 8 and "marks") and
  `$V mcp RUN movies_mark '{"title":"mobland","season":1,"watched":true}'` after a sync.

## How to get to it (user POV)
Wall: the Movies icon in the rail or sidebar -> `/movies` (poster grid; the Library / Stream icons
at the top of the page switch to `/movies?side=stream`, the titles verified to stream on this
machine) -> click a poster ->
`/movies/<title id>` (detail, Play/Resume, watched, stars, review, episodes with progress and deleted
flags). The unmatched list (`/movies/unmatched`) opens from the Movies page; pick a TMDB title for a
file there. The pill bar asks the chat about the page; on a title's page it reads "Ask about <title>" and
"this film" means that title (`moviesPillPlaceholder`, `web/src/App.movies.test.tsx` R5.4).
Claude Code: `/n continue MobLand`, `/n which MobLand episode did I watch last?`, `/n Blumhouse films I
finished this year`, `/n other Margaret Qualley films I haven't seen`.

## Driving it with verify.sh
`up --movies` gives the run its own library (generated once with ffmpeg by
`scripts/movies/make-fixtures.sh`, copied to `<run>/movies/library` so a journey may delete and move
files), a fake TMDB (`fake-tmdb.mjs` + `tmdb.json`, posters included) and fake `vlc.exe`/`curl.exe`
(`fake-vlc.mjs`) that record each launch and answer `status.json`. It prints `MOVIES=<dir>`.

The whole chain is one script, 12 stages, no model call (about 2-3 minutes):
```sh
V=.claude/skills/verify-notesd/scripts/verify.sh
$V up --web --movies                                     # RUN=..., MOVIES=...
.claude/skills/verify-notesd/scripts/movies/journey.sh RUN   # ends with: journey: PASS (12 stages)
$V down RUN                                              # keeps movies-tmdb-requests.log, movies-vlc-launches.jsonl
```
| Stage | What it proves |
| --- | --- |
| 1 sync | trailers (the film's video id, MobLand's season 1, none unchecked); 6 present files matched (`Videos/…Pahe.in.mkv`, the MobLand season folder as one `tv-247718` with S01E01-E03, `Done/The_Rivals…` with a done signal, `Telegram Desktop/Oldboy (2003)/Oldboy.mkv`); the 20 s `Done/docker_es` clip `unmatched:too_short`; studios, cast with characters, directors, 3 episode rows; two gone films from the fixture ini as deleted files with recents observations |
| 2 posters | `GET /api/movies` `poster_url`s on `TMDB_IMAGE_BASE`, one loads as `image/png` |
| 3 user state | `POST /api/movies/movie-467905/user` stores rating 4 + watched; review is a `#movie` note linked by `review_note_id` |
| 4 play | `POST …/files/<S01E01>/play` launches the fake VLC at 0 with `--fullscreen` and runs the fake `powershell.exe` (the bring-to-front call); `vlc at 912` is polled into the play; `vlc quit` closes it; S01E01 `finished` |
| 5 continue | MCP `movies_continue {title:"MobLand"}` -> `started` S01E02; stopped at 300 s -> `in_progress` |
| 6 continue, no title | `movies_continue {}` -> `resumed` S01E02 at about 300 s (`--start-time` or a `seek`) |
| 7 delete, move | `rm` S01E03 -> deleted, `removed_unwatched`, title kept; `mv` Oldboy into `Videos/Done` -> same row, new path, done signal, `finished` |
| 8 missing | S01E02 marked watched; `movies_continue` -> `missing` S01E03, no VLC launch |
| 9 other host | a seeded `verify-other-host` file is `available:false`; play answers `not_on_this_machine` |
| 10 unmatched | `GET /api/movies/unmatched` lists the clip `too_short`; `POST …/assign {kind, tmdb_id}` moves it into `movie-990003` |
| 11 MCP reads | `movies_person` (seen / not seen), `movies_list {company}`, `movies_history`, `movies_get` with the deleted file |
| 12 wall | `ui-library.mjs`: grid of loaded posters; MobLand page with episodes, cast and characters, one `data-deleted="true"` row; the trailer icon searches YouTube in a new tab, season 1's plays in the pop-up (YouTube itself is stubbed) |

Driving one piece by hand on the same run:
```sh
$V api RUN POST /api/movies/sync
$V sql RUN "select id, name, status, reason, title_id, deleted_at, done_at from movie_files order by id"
$V api RUN POST /api/movies/files/<fileId>/play '{}'
$V vlc RUN args            # what the fake vlc.exe was started with (Windows path, --start-time, port)
$V vlc RUN at 600          # jump the playing fake VLC to 600 s; the next poll records it
$V vlc RUN quit            # VLC "exits": the fake curl.exe times out unconnected (exit 28, like this Windows), the play closes
$V mcp RUN movies_continue '{"title":"MobLand"}'
cat "$MOVIES/tmdb.log"     # every TMDB request the daemon made (MOVIES= from up)
```

## Gotchas
- A plain `$V up` pins `NOTESD_MOVIES=off` (`/api/movies*` answer 503 `movies_off`), even when the
  checkout's `.env.local` names real roots. Only `--movies` turns it on, and only against the run's fakes.
- Never set `NOTESD_MOVIES_ROOTS`, `NOTESD_VLC_INI` or `NOTESD_VLC_BIN` to anything under `/mnt/c` on a
  run, and never drive the live daemon's Play: it starts the owner's real VLC.
- A long file whose name matches nothing would ask the Haiku fallback (billed). The fixture has none,
  and `--movies` pins `NOTESD_MOVIES_FALLBACK_MODEL=off`. Add a fixture with an unmatched long name only
  with that in mind.
- The fake VLC plays in real time from `--start-time`; use `$V vlc RUN at SECONDS` rather than waiting.
  Every fixture video is 960 s, and the fake reports that length.
- `$V up --web` matters for stage 12: the wall serves the last `web/dist` otherwise.
- The fixture library is cached in `$VERIFY_HOME/.movies-fixture`; bump the stamp name in
  `make-fixtures.sh` when its layout changes.
- `not_on_this_machine` needs another host's row: stage 9 seeds one with `$V exec`.
- Stage 6 accepts the resume second from either the launch's `--start-time` or a later `seek` command,
  because Play passes the first and confirms with the second.
