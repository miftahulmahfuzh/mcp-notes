# Movies

## Sub-features
- VLC health (phase 9). Every `NOTESD_VLC_HEALTH_MS` (default 30 s; off at 0 or with no roots) each
  `vlc.exe` on this host is sampled through `tasklist.exe` / `powershell.exe` into
  `<dataDir>/movies/vlc-health-<host>.jsonl` (fsync'd lines: start, sample, idle, hang, clean_stop,
  incident). An unclean stop while sampling gives one incident on the next start with the Windows
  fault events around the last sample; a notesd VLC that stops answering while its process lives
  gets a hang line and its play stays open. `GET /api/movies/player/health` returns it. Proof:
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
- User state: watched flag, 0-5 stars, review (a note tagged `#movie`, linked to the title).
- Play/Resume: starts the Windows `vlc.exe` on this host's file at the resume second, reads its status
  through Windows `curl.exe` every `NOTESD_VLC_POLL_MS` into one play event, closes it when VLC exits.
  Another host's file: `available: false`, play answers `not_on_this_machine`; no VLC/interop/curl:
  `player_unavailable`.
- VLC recents: each pass reads `[RecentsMRL]` from `NOTESD_VLC_INI`; entries become play observations,
  and a gone file becomes a deleted file under its matched title.
- Continue: `movies_continue` / `POST /api/movies/continue` resumes the latest unfinished episode or
  film, else starts the next episode whose file is here, else answers which episode is missing and
  which later ones are present. Without a title: the title of the newest play.
- MCP: `movies_list`, `movies_get`, `movies_history`, `movies_continue`, `movies_person`, `movies_mark`
  (also in the chat bar). SSE `changed` on `/api/movies/events`.

## How to get to it (user POV)
Wall: the Movies icon in the rail or sidebar -> `/movies` (poster grid) -> click a poster ->
`/movies/<title id>` (detail, Play/Resume, watched, stars, review, episodes with progress and deleted
flags). The unmatched list (`/movies/unmatched`) opens from the Movies page; pick a TMDB title for a
file there. The pill bar asks the chat about the page.
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
| 1 sync | 6 present files matched (`Videos/…Pahe.in.mkv`, the MobLand season folder as one `tv-247718` with S01E01-E03, `Done/The_Rivals…` with a done signal, `Telegram Desktop/Oldboy (2003)/Oldboy.mkv`); the 20 s `Done/docker_es` clip `unmatched:too_short`; studios, cast with characters, directors, 3 episode rows; two gone films from the fixture ini as deleted files with recents observations |
| 2 posters | `GET /api/movies` `poster_url`s on `TMDB_IMAGE_BASE`, one loads as `image/png` |
| 3 user state | `POST /api/movies/movie-467905/user` stores rating 4 + watched; review is a `#movie` note linked by `review_note_id` |
| 4 play | `POST …/files/<S01E01>/play` launches the fake VLC at 0; `vlc at 912` is polled into the play; `vlc quit` closes it; S01E01 `finished` |
| 5 continue | MCP `movies_continue {title:"MobLand"}` -> `started` S01E02; stopped at 300 s -> `in_progress` |
| 6 continue, no title | `movies_continue {}` -> `resumed` S01E02 at about 300 s (`--start-time` or a `seek`) |
| 7 delete, move | `rm` S01E03 -> deleted, `removed_unwatched`, title kept; `mv` Oldboy into `Videos/Done` -> same row, new path, done signal, `finished` |
| 8 missing | S01E02 marked watched; `movies_continue` -> `missing` S01E03, no VLC launch |
| 9 other host | a seeded `verify-other-host` file is `available:false`; play answers `not_on_this_machine` |
| 10 unmatched | `GET /api/movies/unmatched` lists the clip `too_short`; `POST …/assign {kind, tmdb_id}` moves it into `movie-990003` |
| 11 MCP reads | `movies_person` (seen / not seen), `movies_list {company}`, `movies_history`, `movies_get` with the deleted file |
| 12 wall | `ui-library.mjs`: grid of loaded posters; MobLand page with episodes, cast and characters, one `data-deleted="true"` row |

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
