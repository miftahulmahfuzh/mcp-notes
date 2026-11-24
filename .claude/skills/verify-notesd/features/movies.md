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
- Cache page (`/movies/cache`): the drive icon after Films / Series on the Stream grid (aria-label `Cache`).
  `GET /api/stream/disk` lists this host's torrent downloads and cloud caches per title, season and episode,
  largest first, blocks on disk; a season pack's shared files count to the season. Trash and the two bulk
  buttons (`Delete Watched · <size>`, `Delete Not interested · <size>`) delete with no confirmation: the row
  hides at once, a toast offers Undo for 10 s, the files go when the window closes (or at the next start).
  Something playing or fetched is `in use` with a disabled trash, and the daemon answers 409 `in_use`. The
  `stream_disk` tool does the same from chat. Proof: `tests/unit/directStream/cacheShelf.test.ts`,
  `tests/unit/mcp.streamDiskTool.test.ts`, `web/src/components/movies/CachePage.test.tsx`; on a
  `$V up --web --torrent` run, `POST /api/stream/torrent` the fixture film and the pack's E01 and E02 under
  stored titles (`POST /api/movies/ensure` for `tv-247718`), check 409 `in_use` while they download, release
  them, then in Playwright open the page, unfold the series, trash E01, Undo, trash again and wait 13 s: E01's
  file and row are gone, E02 and the pack's other files stay. `$V restart` inside a window carries the
  deletion out at start (daemon.log `cache page: carried out 1 deletion(s) left pending by the restart`).
  What downloads now is listed with what is on disk (a queued download with nothing on disk yet has a 0 B row),
  each downloading row with a bar (`role="progressbar"`) and why it downloads (`asked`, `ahead`, `pause`); while
  anything downloads the page reads every 3 s instead of 15 s. The Downloading filter (an icon beside the bulk
  buttons, its count beside it, `aria-pressed`) lists only the titles, seasons and episodes downloading now,
  unfolded; a second click goes back. Proof: `web/src/components/movies/CachePage.test.tsx`,
  `tests/unit/directStream/cacheShelf.test.ts`; on a `TORRENT_SEED_KBPS=20 $V up --web --torrent` run,
  `direct-stream/downloads.sh RUN season cache` (see `features/direct-streaming.md`, "Downloads asked for").
- Download buttons (Stream side, direct streaming on): an icon on a film's page beside Play, on each season row
  and on each episode row (none at a series' head) queues the film, the season's aired episodes or the episode
  (`POST /api/stream/downloads`); its caret opens "Choose how to download <name>" (Best torrent, Cloud, Pick a
  torrent… which opens `TorrentsModal` with a download action per row; no pick row on a season). A bar under the
  button while queued or downloading; filled when on this machine; failed says why. Proof:
  `web/src/components/movies/DownloadButton.test.tsx web/src/lib/downloads.test.tsx`; on a throwaway run,
  `direct-stream/downloads.sh RUN title season`.
- Stream grid upkeep: the grid fills from real plays only (no refresh icon);
  the bookmark icon marks a title "interested" (`interested: true` on `POST /api/movies/:id/user`;
  the Stream side's `interested` pill lists it with no verified source too, as `interested_only`, and
  it clears "not interested"; proof: `npm run test:int -- tests/integration/movies.marks.int.test.ts`,
  which also proves a title last played from a torrent is on `GET /api/movies/stream`);
  a title page's "not interested" icon takes a title off the grid (it shows only under that
  filter); a poster under the
  pointer shows the watched flag (a series: every season) and, on the Stream side, "not
  interested", one click each with an undo and no confirmation (`.mv-tile-acts` is at opacity 0
  until `.mv-cell` is hovered; hover a poster with Playwright on an `up --web --movies` run, click
  `Mark <title> as watched`: the poster is gone from `all` at once and is under `finished`; read
  the title back as `finished`); each season has one button
  that marks all its episodes finished (`POST /api/movies/:id/episodes/watched`), an episode
  without a file has its own, and the notice offers an undo of exactly what changed. The caret
  before a season's name folds its episodes into a count, kept per title in the browser
  (`npx vitest run web/src/components/movies/EpisodeList.test.tsx`). The book icon of an episode
  opens its story, written once by Claude from published recaps found with WebSearch (the episode's dialogue only
  when no recap covers it) and kept in `movie_stories`; the book icon of a season row ("Narrate the full story of
  S01") opens the season's story, one section per episode, an episode no recap covers saying so, its sources as
  links (`POST /api/movies/:id/story` with `{season}` alone). Proof: `npx vitest run tests/unit/movies/story.test.ts
  tests/unit/movies/webStory.test.ts web/src/components/movies/StoryModal.test.tsx web/src/components/movies/EpisodeList.test.tsx`,
  `npm run test:int -- tests/integration/movies.api.int.test.ts` ("the story of an episode"). A throwaway daemon
  never writes one (`NOTESD_MOVIES_STORY_MODEL=off` is pinned): seed a `movie_stories` row through `$V exec` and
  open it on the page, as `direct-stream/downloads.sh RUN story` does. Proof:
  `web/src/App.stream.test.tsx`, `tests/integration/movies.marks.int.test.ts`.
- Names and the play menu (a title's page). A person, a studio or a genre clicked opens a pop-up
  (`EntityModal`): `GET /api/movies/people/:id` and `/companies/:id` read TMDB at each request;
  `GET|POST /api/movies/:id/genres/:genre` reads or collates the guide of that genre for that title
  (one model run with WebSearch, then `movie_genre_guides`). Every listed title carries `mark`
  (`watched`, `started`, `not_interested`), `interested` and `has_file`, read at the request; three
  icon buttons per row (`guide-mark-watched|interested|not_interested`) set a mark without opening
  the title, through `POST /api/movies/:id/user` after `ensure` for a title not stored; and a click opens
  the movie pop-up, after `POST /api/movies/ensure` for a title the library does not hold. A
  character still asks the chat. The caret beside Play, and on every episode row, is the play
  menu: the file (or pahe, `GET /api/movies/:id/pahe`), `POST /api/stream/play` with `provider`
  `cloud` or `torrent`, `POST /api/movies/:id/site-play` for a site. What played is kept per
  method (`movie_title_methods`), and a named kind goes back to it. The Torrent stream row's own list
  button opens every candidate torrent of the film or episode (`TorrentsModal`, `GET /api/stream/torrents`):
  per row its facts and flags, Play this one (`POST /api/stream/play` with `magnet`) and blacklist /
  un-blacklist (`POST|DELETE /api/stream/torrents/:hash/blacklist`); on a throwaway run stub
  `/api/stream/torrents*` with `page.route` like the stream rows. Proof:
  `npx vitest run web/src/App.movies.test.tsx web/src/lib/movies.test.tsx web/src/components/movies/TorrentsModal.test.tsx tests/unit/movies/guides.test.ts tests/unit/directStream/rememberedChannel.test.ts`,
  `npm run test:int -- tests/integration/movies.guides.int.test.ts`. On an `up --web --movies` run
  the fake TMDB knows no person or studio profile, so the pop-up is driven with Playwright
  `page.route` on `/api/movies/people/*`; the play menu needs no stub to open, and its site, stream
  and pahe rows are stubbed the same way (never give a throwaway run a real site, resolver or
  model: `NOTESD_MOVIES_STORY_MODEL=off` is pinned, so a genre answers `guide_off` unless a row is
  seeded into `movie_genre_guides` with `$V exec`).
- Trending on torrents (Stream side, second section under the grid). `GET /api/movies/trending` is this
  host's daily list (`stream_trending`) of the most seeded films and series from apibay's top-100 and EZTV's
  newest pages; no swarm is joined and `seeds` is only the index's claim. Seen, started, watched and not-interested titles are read from
  `movie_titles` on every request and on every build, so a mark removes a title at once. `POST
  /api/movies/trending/refresh` runs a pass now. Needs `verify.sh up --web --trending` (fake index serves the
  top lists from `$TORRENT/trending.json`; fake TMDB answers `/find/<imdb>`); `NOTESD_TRENDING=off` is pinned
  otherwise. Proof: `scripts/trending/journey.sh RUN` (listing, filters, no swarm joined, mark after
  build, then `trending.steps.mjs` in the page),
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
- The grid keeps its place: scroll the Library or Stream grid down, open a title, press Back (the
  arrow or the browser's): the grid is scrolled to the same offset, not the first row. Proof:
  `npx vitest run web/src/lib/scrollMemory.test.tsx`, and a `verify.sh up --web --movies` `ui` journey
  on a short viewport comparing `scrollY` before the click and after Back.
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
  episodes finished or takes the marks back (the page's season button), `not_interested` and `interested` set or
  clear those marks (one clears the other), and a title key the library does not hold (`tv-94997`) is stored from TMDB
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
