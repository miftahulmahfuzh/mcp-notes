# Plan: Movies subsystem

**Slug:** movies-library
**Date:** 2026-11-14 12:16 WIB
**Analysis:** `.workflows/analyze/20261114-121616-M7VL_code_analyzer.md`
**Worktree:** `/home/miftah/.worktrees/mcp-notes/movies-library`
**Branch:** `feature/movies-library` (base: `origin/main` @ `e09e602`)
**Phases:** 9
**Status:** phases 1, 2, 3, 5 of 9 complete (phase 5 on `phase-5-movies-library`, not yet integrated)
**Coordinator:** —

---

## Why

Movies subsystem for mcp-notes (new sidebar icon "Movies", route /movies). Decisions agreed with the owner in session E6-MP:

SCOPE
- Library roots (this host, WSL): /mnt/c/Users/mahfu/Videos/ and /mnt/c/Users/mahfu/Downloads/Telegram Desktop/ (nested). Roots must be configurable/injectable (env), tests never touch the real dirs.
- Track only video files (mkv, mp4, avi, m4v, webm). Junk filter: keep only files >= 15 minutes (ffprobe, /usr/bin/ffprobe exists) that match on TMDB; everything else goes to a hidden "unmatched" list the user can fix by hand. Videos/Done/docker_es/ is NOT a movie collection (WhatsApp/Snapinsta clips) and must end up excluded/unmatched. Videos/Pak Bernard/ IS part of the library and must be registered.
- Filename shapes seen on disk: Pahe dots (How.to.Make.a.Killing.2026.1080p.WEB-DL.x265.6CH-Pahe.in.mkv), Pahe underscores (The_Rivals_of_Amziah_King_2026_1080p_BluRay_x265_DD+5_1_Pahe_in.mkv), "Title (Year)/Title.mkv" where the year is only in the folder (Pak Bernard), SxxEyy inside a season folder (Mobland S01 WEB-DL 1080p x265 6CH [Pahe.in]/MobLand.S01E01.Stick.or.Twist...mkv), absolute numbering (One Piece - 405 720p WEB-DL x264 2CH [Pahe.in].mkv), a folder holding two films (Nezha (2019)/Ne.Zha.2019... and Ne.Zha.2.2025...).

METADATA
- TMDB API (key was added by the owner to .env.local; find the var name there, add it to config + README env table). Poster, release date, synopsis, production studios, crew (producer, writer, director), cast with real name + character name, per-season episode titles. Haiku only as fallback when a filename does not match confidently. Risk: TMDB may be blocked by Indonesian ISPs, test reachability from this machine first; OMDb is the fallback. Posters must be viewable from both machines (shared DB, not shared disk).

DATA MODEL
- Three layers: title (movie or series, TMDB data, outlives its files), file (path, host, size, duration, season/episode, first_seen, deleted_at), play events (file, started/ended, position, duration). Studios and people are real rows so "Blumhouse films I saw this year" is a plain query.
- Series collapse into one title/detail page with per-episode progress and per-episode deleted flag.
- Sync detects new files and deleted files. A move (e.g. Telegram Desktop -> Videos/Done, matched by name+size) is NOT a delete. A move into Videos/Done is a "finished" signal (owner: usually, not always).
- Deleted is not the same as watched; derive state from last position: deleted at >= 90% or manually flagged = finished; deleted partway = dropped; deleted at 0% = removed unwatched. Detail page shows a deleted flag.
- User state: manual "watched" flag (covers the 95%-skipping-credits case), rating 0-5 stars, optional review. Review is a normal note linked to the title (search, revisions, /n for free) shown as one text field on the detail page; rating is a column.
- Files and VLC are per-host: Play works only on the owning machine (available:false / not_on_this_machine pattern, same as photos).

PLAYBACK + PROGRESS (most important feature)
- VLC is Windows-only: /mnt/c/Program Files/VideoLAN/VLC/vlc.exe (no WSL vlc). Detail page has an icon button Play/Resume.
- Live layer: notesd launches vlc.exe (wslpath -w for the file) with --start-time=<sec> and VLC's HTTP interface on, polls position/length/state every few seconds, writes play events. We resume ourselves, no VLC prompt. Check how WSL reaches the Windows-side VLC HTTP port (NAT vs mirrored networking; curl.exe/powershell.exe as a way to stay on the Windows side).
- Passive layer: on each sync read /mnt/c/Users/mahfu/AppData/Roaming/vlc/vlc-qt-interface.ini [RecentsMRL] (list= file:// URLs, times= ms positions, last 30, written only on VLC exit). Catches films opened from Explorer and backfills history on day one (The Dog Stars, Bad Apples, Runner are in there though the files are gone).
- All paths (vlc.exe, ini, roots, ffprobe) injectable; tests use fakes.

UI
- Movies page: poster grid gallery; click opens movie-detail-page (release date, synopsis, studios, producer/writer, cast with character names, play/resume button, watched flag, stars, review field, deleted flag; for series the episode list with progress). The all-encompassing pill query bar must be on the Movies page too. Owner taste: icon-only buttons, Phosphor icons, never the Claude-default look. Hidden "unmatched" list with manual fix.

MCP / /n
- Tools so /n can answer: "which Mobland episode did I watch last and when" (survives deletion), "Blumhouse movies I have seen this year", "recommend other Margaret Qualley films" (TMDB filmography minus seen, plus web search), "continue Mobland" = movies_continue: resume the latest unfinished episode, else play the next episode whose file is present, else report which episode is missing vs present (a present-but-not-found file is a bug); "continue whatever I watched last night" = same tool with no title, newest play event.

ORDER
1. Scanner, filename parser, TMDB, grid + detail page (rating, review, watched flag, pill bar). 2. VLC play/resume, live tracking, ini backfill. 3. MCP tools + /n wiring.
Initial iteration; more changes will follow, so keep it robust and extensible. Update CLAUDE.md, README and the verify-notesd features map.

Added by the owner on 2026-11-14 13:08, after a crash during planning:

the WSL terminal crashed again. i am pretty sure this is caused by windows's VLC that i paused for several minutes. i am fairly sure that windows VLC has memory leak problem. if i pause a movie for too long, it will crash. and it made WSL terminal crash as well. maybe we need to prepare to track this memory leak / VLC hang on WSL terminal. because after we ship this, i will use WSL's vlc from now on.

## Requirements

| ID | What the user asked for (verbatim) | Phases |
|---|---|---|
| R1 | SCOPE - Library roots (this host, WSL): /mnt/c/Users/mahfu/Videos/ and /mnt/c/Users/mahfu/Downloads/Telegram Desktop/ (nested). Roots must be configurable/injectable (env), tests never touch the real dirs. - Track only video files (mkv, mp4, avi, m4v, webm). Junk filter: keep only files >= 15 minutes (ffprobe, /usr/bin/ffprobe exists) that match on TMDB; everything else goes to a hidden "unmatched" list the user can fix by hand. Videos/Done/docker_es/ is NOT a movie collection (WhatsApp/Snapinsta clips) and must end up excluded/unmatched. Videos/Pak Bernard/ IS part of the library and must be registered. - Filename shapes seen on disk: Pahe dots (How.to.Make.a.Killing.2026.1080p.WEB-DL.x265.6CH-Pahe.in.mkv), Pahe underscores (The_Rivals_of_Amziah_King_2026_1080p_BluRay_x265_DD+5_1_Pahe_in.mkv), "Title (Year)/Title.mkv" where the year is only in the folder (Pak Bernard), SxxEyy inside a season folder (Mobland S01 WEB-DL 1080p x265 6CH [Pahe.in]/MobLand.S01E01.Stick.or.Twist...mkv), absolute numbering (One Piece - 405 720p WEB-DL x264 2CH [Pahe.in].mkv), a folder holding two films (Nezha (2019)/Ne.Zha.2019... and Ne.Zha.2.2025...). | 2, 3, 4 |
| R2 | METADATA - TMDB API (key was added by the owner to .env.local; find the var name there, add it to config + README env table). Poster, release date, synopsis, production studios, crew (producer, writer, director), cast with real name + character name, per-season episode titles. Haiku only as fallback when a filename does not match confidently. Risk: TMDB may be blocked by Indonesian ISPs, test reachability from this machine first; OMDb is the fallback. Posters must be viewable from both machines (shared DB, not shared disk). | 2, 3, 4 |
| R3 | DATA MODEL - Three layers: title (movie or series, TMDB data, outlives its files), file (path, host, size, duration, season/episode, first_seen, deleted_at), play events (file, started/ended, position, duration). Studios and people are real rows so "Blumhouse films I saw this year" is a plain query. - Series collapse into one title/detail page with per-episode progress and per-episode deleted flag. - Sync detects new files and deleted files. A move (e.g. Telegram Desktop -> Videos/Done, matched by name+size) is NOT a delete. A move into Videos/Done is a "finished" signal (owner: usually, not always). - Deleted is not the same as watched; derive state from last position: deleted at >= 90% or manually flagged = finished; deleted partway = dropped; deleted at 0% = removed unwatched. Detail page shows a deleted flag. - User state: manual "watched" flag (covers the 95%-skipping-credits case), rating 0-5 stars, optional review. Review is a normal note linked to the title (search, revisions, /n for free) shown as one text field on the detail page; rating is a column. - Files and VLC are per-host: Play works only on the owning machine (available:false / not_on_this_machine pattern, same as photos). | 1, 3, 4, 5 |
| R4 | PLAYBACK + PROGRESS (most important feature) - VLC is Windows-only: /mnt/c/Program Files/VideoLAN/VLC/vlc.exe (no WSL vlc). Detail page has an icon button Play/Resume. - Live layer: notesd launches vlc.exe (wslpath -w for the file) with --start-time=<sec> and VLC's HTTP interface on, polls position/length/state every few seconds, writes play events. We resume ourselves, no VLC prompt. Check how WSL reaches the Windows-side VLC HTTP port (NAT vs mirrored networking; curl.exe/powershell.exe as a way to stay on the Windows side). - Passive layer: on each sync read /mnt/c/Users/mahfu/AppData/Roaming/vlc/vlc-qt-interface.ini [RecentsMRL] (list= file:// URLs, times= ms positions, last 30, written only on VLC exit). Catches films opened from Explorer and backfills history on day one (The Dog Stars, Bad Apples, Runner are in there though the files are gone). - All paths (vlc.exe, ini, roots, ffprobe) injectable; tests use fakes. | 5 |
| R5 | UI - Movies page: poster grid gallery; click opens movie-detail-page (release date, synopsis, studios, producer/writer, cast with character names, play/resume button, watched flag, stars, review field, deleted flag; for series the episode list with progress). The all-encompassing pill query bar must be on the Movies page too. Owner taste: icon-only buttons, Phosphor icons, never the Claude-default look. Hidden "unmatched" list with manual fix. | 6 |
| R6 | MCP / /n - Tools so /n can answer: "which Mobland episode did I watch last and when" (survives deletion), "Blumhouse movies I have seen this year", "recommend other Margaret Qualley films" (TMDB filmography minus seen, plus web search), "continue Mobland" = movies_continue: resume the latest unfinished episode, else play the next episode whose file is present, else report which episode is missing vs present (a present-but-not-found file is a bug); "continue whatever I watched last night" = same tool with no title, newest play event. | 5, 7 |
| R7 | ORDER 1. Scanner, filename parser, TMDB, grid + detail page (rating, review, watched flag, pill bar). 2. VLC play/resume, live tracking, ini backfill. 3. MCP tools + /n wiring. Initial iteration; more changes will follow, so keep it robust and extensible. Update CLAUDE.md, README and the verify-notesd features map. | 8 |
| R8 | the WSL terminal crashed again. i am pretty sure this is caused by windows's VLC that i paused for several minutes. i am fairly sure that windows VLC has memory leak problem. if i pause a movie for too long, it will crash. and it made WSL terminal crash as well. maybe we need to prepare to track this memory leak / VLC hang on WSL terminal. because after we ship this, i will use WSL's vlc from now on. | 9 |

### Acceptance Criteria

| ID | Pattern | Criterion | Phases | Journeys |
|---|---|---|---|---|
| R1.1 | event | WHEN a sync pass finds a video file (mkv, mp4, avi, m4v, webm) of at least 15 minutes under a configured root that matches a TMDB title THE SYSTEM SHALL register the file under that title for this host | 3 | P3.J1 |
| R1.2 | unwanted | IF a video file under a root is shorter than 15 minutes or matches no TMDB title THEN THE SYSTEM SHALL keep it out of the library and record it as unmatched with the reason | 3 | P3.J2 |
| R1.3 | ubiquitous | THE SYSTEM SHALL parse title, year, season, episode and absolute episode number from each of the six filename shapes found on disk (Pahe dots, Pahe underscores, year only in the folder, SxxEyy in a season folder, absolute numbering, two films in one folder) | 2 | P2.J1, P2.J4 |
| R1.4 | optional | WHERE `NOTESD_MOVIES_ROOTS` is set THE SYSTEM SHALL scan exactly those directories recursively and no others | 3 | P3.J1 |
| R1.5 | event | WHEN the owner assigns a TMDB title to an unmatched file THE SYSTEM SHALL register the file under that title and remove it from the unmatched list | 4 | P4.J4, P4.J5 |
| R2.1 | event | WHEN a title is matched for the first time THE SYSTEM SHALL store its poster path, release date, synopsis, production companies, directors, writers, producers and cast with character names, and for a series its episode titles per season | 2, 3 | P2.J2, P2.J4, P3.J1 |
| R2.2 | unwanted | IF the parsed name has no confident TMDB match THEN THE SYSTEM SHALL ask the Haiku fallback for a title and year, and leave the file unmatched when that also gives no confident match | 2 | P2.J3 |
| R2.3 | unwanted | IF TMDB cannot be reached during a sync pass THEN THE SYSTEM SHALL finish the pass, leave the affected files pending and retry them on the next pass | 3 | P3.J6 |
| R2.4 | ubiquitous | THE SYSTEM SHALL return each title's poster as a URL that loads on a machine that does not hold the title's files | 4 | P4.J1, P4.J5 |
| R3.1 | event | WHEN a tracked file is gone from disk and no file with the same name and size appeared elsewhere under the roots THE SYSTEM SHALL mark the file deleted and keep its title and play events | 3 | P3.J5 |
| R3.2 | event | WHEN a file with the same name and size as a missing tracked file appears at another path under the roots THE SYSTEM SHALL update the tracked file's path and not mark it deleted | 3 | P3.J3 |
| R3.3 | event | WHEN a tracked file moves into, or is first found inside, a folder named in `NOTESD_MOVIES_DONE_DIRS` THE SYSTEM SHALL record a done signal that makes the file's state finished | 3 | P3.J4 |
| R3.4 | ubiquitous | THE SYSTEM SHALL derive each file's state as finished (manual flag, done signal, or last position at least 90% of duration), in progress (present, partway), unwatched (present, never played), dropped (deleted partway) or removed unwatched (deleted, never played) | 1 | P1.J1, P1.J3 |
| R3.5 | ubiquitous | THE SYSTEM SHALL keep every episode file of a series under one title, each with its own season, episode, progress and deleted flag | 3 | P3.J1 |
| R3.6 | event | WHEN the owner sets the watched flag, a rating from 0 to 5 or a review on a title THE SYSTEM SHALL store the flag and rating on the title and the review as a note linked to the title | 4 | P4.J3, P4.J5 |
| R3.7 | state | WHILE a file is recorded for another host THE SYSTEM SHALL report it with `available: false` and answer a play request with `not_on_this_machine` | 4, 5 | P4.J2, P4.J5, P5.J4, P5.J9 |
| R3.8 | ubiquitous | THE SYSTEM SHALL store production companies and people as rows joined to titles, so one query lists the titles of a company or person the owner has finished in a date range | 1 | P1.J2, P1.J3 |
| R4.1 | event | WHEN the owner asks to play a file that is on this host THE SYSTEM SHALL start vlc.exe on it at the last recorded position (from the start when there is none or the file was finished) | 5 | P5.J1, P5.J9, P5.J12 |
| R4.2 | state | WHILE a VLC that notesd started is playing THE SYSTEM SHALL record the position and duration into that play event every few seconds | 5 | P5.J2, P5.J9, P5.J12 |
| R4.3 | event | WHEN a VLC that notesd started exits THE SYSTEM SHALL close the play event with the last position it read | 5 | P5.J3, P5.J9, P5.J12 |
| R4.4 | event | WHEN a sync pass reads VLC's `[RecentsMRL]` list THE SYSTEM SHALL record each entry's position as a play observation for the matching file, creating a deleted file under its matched title for an entry whose file is gone | 5 | P5.J6 |
| R4.5 | unwanted | IF vlc.exe, WSL interop or the Windows curl is missing on this host THEN THE SYSTEM SHALL answer a play request with `player_unavailable` and report playback as unavailable in the capabilities the page reads | 5 | P5.J5, P5.J11 |
| R5.1 | event | WHEN the owner presses the Movies icon in the rail or opens `/movies` THE SYSTEM SHALL show the library as a grid of posters, one per title | 6 | P6.J1 |
| R5.2 | event | WHEN the owner clicks a poster THE SYSTEM SHALL open `/movies/<title id>` showing release date, synopsis, studios, directors, writers, producers, cast with character names, the play or resume button, the watched flag, the star rating and the review field, and for a series the episode list with each episode's progress | 6 | P6.J2, P6.J3 |
| R5.3 | state | WHILE a title's file is deleted THE SYSTEM SHALL show a deleted flag on that file or episode in the detail page | 6 | P6.J2 |
| R5.4 | ubiquitous | THE SYSTEM SHALL show the pill query bar on the Movies page and send its question to the chat with the page (and open title) named on the first line | 6 | P6.J4 |
| R5.5 | event | WHEN the owner opens the unmatched list from the Movies page THE SYSTEM SHALL list the unmatched files with their reason and let the owner assign a title to one | 6 | P6.J5 |
| R6.1 | event | WHEN `movies_continue` is called with a title THE SYSTEM SHALL play the latest unfinished episode or film from its position, else the next episode whose file is present, else answer which next episode is missing and which later ones are present | 5, 7 | P5.J7, P5.J10, P7.J4, P7.J6 |
| R6.2 | event | WHEN `movies_continue` is called without a title THE SYSTEM SHALL continue the title of the newest play event | 5, 7 | P5.J8, P5.J10, P7.J5, P7.J6 |
| R6.3 | ubiquitous | THE SYSTEM SHALL expose MCP tools that list titles by text, company, person, state and finished date range, and return one title with its episodes, files and play events, including deleted files | 7 | P7.J1, P7.J2, P7.J3 |
| R6.4 | event | WHEN `movies_person` is called with a person's name THE SYSTEM SHALL return that person's TMDB filmography with each entry marked seen or not seen by the owner | 7 | P7.J7 |
| R6.5 | ubiquitous | THE SYSTEM SHALL make the movie tools callable from the wall's chat bar and describe them in the `/n` skill and the MCP instructions | 7 | P7.J8 |
| R7.1 | ubiquitous | THE SYSTEM SHALL document the Movies subsystem in `CLAUDE.md`, the README (env table, HTTP API, MCP tools) and a `movies.md` entry in the verify-notesd feature map | 8 | P8.J1, P8.J2, P8.J3, P8.J4 |
| R8.1 | state | WHILE any vlc.exe is running on this host THE SYSTEM SHALL append a health sample (time, pid, working set, private bytes, handle count, whether notesd started it, and for a notesd-started VLC its playback state and seconds paused) to a per-host log file on disk at a fixed interval | 9 | P9.J1, P9.J5, P9.J6, P9.J7, P9.J8 |
| R8.2 | event | WHEN the daemon starts and its previous run ended without a clean stop while a vlc.exe was being sampled THE SYSTEM SHALL record an incident holding the last samples before the stop and the Windows Application Error and Application Hang events (application, faulting module, exception code, time) from the minutes around the last sample | 9 | P9.J2, P9.J6 |
| R8.3 | unwanted | IF a VLC that notesd started stops answering its HTTP interface while its process still exists THEN THE SYSTEM SHALL record a hang in the health log and keep the play event's last position | 9 | P9.J3, P9.J5, P9.J8 |
| R8.4 | optional | WHERE `NOTESD_VLC_EXTRA_ARGS` is set THE SYSTEM SHALL pass those arguments to every VLC it launches | 9 | P9.J4, P9.J5 |
| R8.5 | event | WHEN `GET /api/movies/player/health` is requested THE SYSTEM SHALL return this host's recent health samples and incidents | 9 | P9.J5, P9.J6, P9.J7 |

## Scope

**In scope:** a `src/movies/` subsystem (schema, repo, parser, TMDB client, sync, read model, VLC player), `/api/movies*` routes, MCP `movies_*` tools, the `/movies` page of the wall, docs and the feature map.

**Out of scope:** OMDb (TMDB is reachable, see Decisions); caching posters on disk; subtitles; streaming video in the browser; downloading anything; a second player (mpv); editing TMDB metadata by hand beyond re-assigning a file's title; embeddings/semantic search over titles (full text only in this iteration).

## Invariants

1. The tree typechecks (`npm run typecheck`) and `npm test` passes at the end of every phase; `npm run test:int` passes at the end of every phase that touches the database or routes.
2. `src/movies/repo.ts` (`MoviesRepo`) is the only writer of the `movie_*` tables. Routes, MCP tools, the sync pass and the player all go through it.
3. A title row is never deleted because its files are gone. Files are soft-deleted (`deleted_at`); plays are never deleted.
4. Tests never read the real library roots, the real `vlc-qt-interface.ini`, the real `vlc.exe`, or the network. Every path and binary is injected; TMDB is a fake or a fixture server (`TMDB_API_BASE`).
5. With `NOTESD_MOVIES=off`, or no roots configured, nothing is scanned and no process is spawned on its own (no ffprobe, no background sampler). `DEFAULT_MOVIES_CONFIG` (what tests get) is off. (Reconciled reading, see Decisions: with roots empty but the library on, an explicit same-origin play request still launches VLC.)
6. Notes are written only through `NotesService` (the review note included).
7. Play, continue and every other route that spawns a process is same-origin only (`sameOriginOnly`), like the reveal and resume routes. notesd never kills or reuses a VLC it did not start.
8. Ids are never invented: a title id is `movie-<tmdb id>` or `tv-<tmdb id>`; file and play ids are database serials.
9. UI: icon-only buttons with Phosphor icons (`weight="duotone"`, `data-tip`, `aria-label`), the existing `.ibtn` classes and CSS variables. No new UI library.
10. Existing behavior of notes, sessions, adversary and connectors does not change.

## Shared contract

Every phase plans against these names. A phase may add private helpers; it may not rename what is here.

### Environment (`src/config.ts` → `Config.movies: MoviesConfig`, `parseMovies(env)`, `DEFAULT_MOVIES_CONFIG`)

| Variable | Field | Default |
|---|---|---|
| `NOTESD_MOVIES` | `enabled` (`parseSwitch`) | on in `parseMovies`; `DEFAULT_MOVIES_CONFIG.enabled = false` |
| `NOTESD_MOVIES_ROOTS` | `roots: string[]` (split on `:`; absolute, `expandHome`) | `[]` (nothing scanned) |
| `NOTESD_MOVIES_DONE_DIRS` | `doneDirs: string[]` (folder names, split on `:`, compared case-insensitively against each path segment below the root) | `['Done']` |
| `NOTESD_MOVIES_SCAN_MS` | `scanMs` | `120000` |
| `NOTESD_MOVIES_MIN_SECONDS` | `minSeconds` | `900` |
| `TMDB_API_READ_ACCESS_TOKEN` | `tmdb.token` (Bearer, preferred) | `null` |
| `TMDB_API_KEY` | `tmdb.apiKey` (v3 `api_key=` query, used when no token) | `null` |
| `TMDB_API_BASE` | `tmdb.apiBase` | `https://api.themoviedb.org/3` |
| `TMDB_IMAGE_BASE` | `tmdb.imageBase` | `https://image.tmdb.org/t/p` |
| `NOTESD_FFPROBE_BIN` | `ffprobeBin` | `ffprobe` |
| `NOTESD_VLC_BIN` | `vlc.bin` | `/mnt/c/Program Files/VideoLAN/VLC/vlc.exe` |
| `NOTESD_VLC_INI` | `vlc.ini: string \| null` (the passive layer is off when null) | `null` |
| `NOTESD_VLC_HTTP_PORT` | `vlc.httpPort` | `47318` |
| `NOTESD_VLC_POLL_MS` | `vlc.pollMs` | `5000` |
| `NOTESD_CURL_EXE` | `vlc.curlExe` | `/mnt/c/Windows/System32/curl.exe` |
| `NOTESD_MOVIES_FALLBACK_MODEL` | `fallbackModel: string \| null` (`off` -> null: no Haiku fallback) | `haiku` |
| `NOTESD_VLC_HEALTH_MS` | `vlc.healthMs` (phase 9 adds the field; 0 turns sampling off, 1-4999 rejected; with no roots the monitor is off too) | `30000` |
| `NOTESD_VLC_EXTRA_ARGS` | `vlc.extraArgs: string[]` (phase 9 adds the field; split on whitespace, appended before the file path, inside the `systemd-run` scope argv; `--http-*`, `--extraintf`, `--intf`, `-I` rejected) | `[]` |
| `NOTESD_TASKLIST_EXE` | not in `Config`: read through `DetectProbe.env` by `src/movies/vlc/health.ts` (phase 9), like `NOTESD_EXPLORER_BIN` | `/mnt/c/Windows/System32/tasklist.exe` |
| `NOTESD_POWERSHELL_EXE` | not in `Config`: read through `DetectProbe.env` by `src/movies/vlc/health.ts` (phase 9) | `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe` |

Without a TMDB credential the sync still registers files, all as unmatched with reason `no_tmdb_credentials`.

### Tables (migration `drizzle/0017_movies.sql`, Drizzle objects in `src/db/schema.ts`)

- `movie_titles` (`movieTitles`): `id text pk` (`movie-<tmdb id>` / `tv-<tmdb id>`), `kind text` (`movie`|`tv`), `tmdb_id int`, `title`, `original_title`, `year int null`, `release_date date null`, `overview text`, `poster_path text null`, `backdrop_path text null`, `runtime_min int null`, `genres jsonb` (string[]), `season_count int null`, `episode_count int null`, `watched_at timestamptz null` (manual flag), `rating smallint null` (0..5, check), `review_note_id text null references notes(id) on delete set null`, `metadata_fetched_at timestamptz`, `created_at`, `updated_at`, `search_tsv` generated (`simple`: title, original_title, overview). Unique (`kind`, `tmdb_id`).
- `movie_companies` (`movieCompanies`): `id int pk` (TMDB company id), `name`, `logo_path null`, `origin_country null`. `movie_title_companies` (`movieTitleCompanies`): `title_id` → titles cascade, `company_id` → companies, `ord int`, pk (`title_id`, `company_id`).
- `movie_people` (`moviePeople`): `id int pk` (TMDB person id), `name`, `profile_path null`. `movie_credits` (`movieCredits`): `id bigserial pk`, `title_id` → titles cascade, `person_id` → people, `role text` (`cast`|`director`|`writer`|`producer`|`creator`), `character text null`, `job text null`, `ord int`; index (`person_id`), index (`title_id`, `role`, `ord`).
- `movie_episodes` (`movieEpisodes`): pk (`title_id`, `season`, `episode`), `name`, `air_date date null`, `runtime_min int null`, `overview text null`, `still_path text null`.
- `movie_files` (`movieFiles`): `id bigserial pk`, `title_id text null` → titles (null = unmatched/pending), `host text`, `path text` (absolute Linux path), `name text` (basename), `size bigint null`, `mtime timestamptz null`, `duration_s real null`, `season int null`, `episode int null`, `absolute_episode int null`, `status text` (`matched`|`unmatched`|`pending`), `reason text null` (`too_short`|`no_match`|`low_confidence`|`tmdb_error`|`no_tmdb_credentials`|`probe_failed`), `parsed jsonb null`, `source text` (`scan`|`vlc_recents`), `first_seen_at`, `last_seen_at`, `deleted_at null`, `moved_at null`, `done_at null` (done signal), `watched_at null` (manual per-file flag), `updated_at`. Partial unique index on (`host`, `path`) where `deleted_at is null`; index (`title_id`); index (`host`, `name`, `size`).
- `movie_plays` (`moviePlays`): `id bigserial pk`, `file_id` → files cascade, `host text`, `source text` (`live`|`vlc_recents`), `started_at timestamptz`, `ended_at null`, `start_position_s real null`, `position_s real null` (null = opened, position unknown), `duration_s real null`, `updated_at`; index (`file_id`, `started_at desc`), index (`started_at desc`).

### Modules (`src/movies/`)

| File | Phase | Exports (the contract) |
|---|---|---|
| `types.ts` | 1 | `TitleKind`, `CreditRole`, `FileStatus`, `FileReason`, `WATCH_STATES`/`WatchState` (`'finished'\|'in_progress'\|'unwatched'\|'dropped'\|'removed_unwatched'\|'seen'`), row types, the single definition of `TitleMetadata` + `CompanyMeta`, `CreditMeta`, `EpisodeMeta` (no `ord`: array order), `FileClassification` + `classifyReason`, `NewMovieFile`, `NewPlay`, `PlayReading`, `RecentsObservation`, `TitleUserPatch`, `ParsedNameRecord`, `titleId(kind, tmdbId)`, `parseTitleId(id)` |
| `state.ts` | 1 | `FINISHED_RATIO = 0.9`, `fileState(file, lastPlay): WatchState`, `titleState(kind, fileStates, watched = false)`, `resumePosition(file, lastPlay): number` (0 when finished, none, or position unknown) |
| `repo.ts` | 1 | `class MoviesRepo` — the only writer, and the only phase that edits the file. `upsertTitle(meta, now?): string`, `upsertFile(input: NewMovieFile, now?): { file, created }` (on a live row only scan facts are refreshed; with `deletedAt` always a new deleted row), `markSeen(ids, at)`, `markDeleted(id, at)`, `moveFile(id, { path, name }, at, { done })`, `setDone(id, at)`, `assignFile(fileId, titleId, episode?, now?)`, `setUnmatched(fileId, reason, now?)`, `setTitleUser(titleId, patch)`, `setFileWatched(fileId, watched, now?)` (false also clears the done signal), `startPlay(NewPlay)`, `updatePlay(playId, reading, now?)`, `endPlay(playId, reading, endedAt)`, `recordObservation(obs)`, `closeOpenPlays(host)`; reads `filesForHost(host, { includeDeleted? })` (live only by default), `fileById`, `fileByPath`, `findTrackedFile(host, path, name)`, `titleById`, `loadTitleMetadata`, `lastPlay(fileId)` (newest play with a known position, else newest), `latestPlay(host?)`, `titlesFinishedBetween(filter)` |
| `parse.ts` | 2 | `VIDEO_EXTENSIONS`, `isVideoFile(name)`, `parseVideoPath(relPath: string): ParsedName` (`{ title, year, season, episode, absoluteEpisode, kindHint: 'movie'\|'tv'\|null, fileName, dirName }`, assignable to `MovieParsedName`), `ParsedName` |
| `tmdb.ts` | 2 | `interface TmdbClient { searchMovie, searchTv, movieDetails(id): TitleMetadata, tvDetails(id): TitleMetadata (with episodes), searchPerson(): TmdbPersonHit[] ({ personId, name, knownFor, ... }), personCredits(): TmdbPersonCredit[] ({ kind, tmdbId, title, releaseDate, credit: 'cast'\|'crew', character, job, ... }) }`, `createTmdbClient(config.tmdb, fetch?, options?)`, `TmdbError(code: 'no_credentials'\|'network'\|'timeout'\|'http'\|'bad_response', message, status?)`, `posterUrl(imageBase, path, size?)`, `absoluteToSeasonEpisode(episodes, n)` (the n-th listed episode over seasons >= 1, TMDB's own numbers). In phase 2 it holds a field-for-field mirror of `types.ts`'s `TitleMetadata` family; phase 3 turns it into a re-export |
| `match.ts` | 2 | `matchTitle(parsed, client, fallback?: NameFallback \| null): Promise<MatchResult>` (`{ kind: 'matched', tmdbKind, tmdbId, confidence, source: 'filename'\|'fallback', matchedTitle } \| { kind: 'none', reason: 'no_match'\|'low_confidence' }`); rejects with `TmdbError` when a TMDB call fails, never turns it into `none` |
| `fallback.ts` | 2 | `interface NameFallback { model; resolve(fileName, dirName \| null): Promise<{ title, year, kind } \| null> }` (never rejects), `createHaikuFallback({ claudeBin, cwd, model? }): NameFallback \| null` (Agent SDK, as `src/sessions/summarize.ts`) |
| `scan.ts` | 3 | `walkRoots(roots)`, `probeDuration(ffprobeBin, path)`, injectable `ScanFs` |
| `sync.ts` | 3 | `runSyncPass(deps): Promise<SyncReport>` (never rejects; counts incl. new, moved, deleted, done, matched, unmatched, pending, waiting), `SyncHook` (`{ name?, afterScan?(ctx): Promise<number \| void> }`, the number = rows written) so phase 5 plugs the VLC recents reader in, `TitleResolver` / `tmdbResolver(tmdb, fallback)` (reused by phase 5), `tmdbUnreachable(err)` (the R2.3 breaker rule). A pass only judges files under a currently configured root |
| `service.ts` | 3 | `class MoviesService` held in `AppDeps.movies` (`MoviesService \| null`): `start()`, `close()`, `syncNow()`, `status(): MoviesStatus` (sync: `{ host, roots, done_dirs, scan_ms, min_seconds, scanning, running, tmdb: 'ok'\|'no_credentials'\|'unreachable', next_pass_at, last_pass }`), `assign(fileId, { kind, tmdbId, season?, episode? })` (throws `MoviesServiceError` `not_found`\|`no_tmdb_credentials`\|`tmdb_unreachable`; emits `assign`), `host`, `repo`, `tmdb`, `events` (`MovieEvents`: `changed(reason, { titleIds?, fileIds? })`, `on(listener) -> unsubscribe`, `listenerCount()`; event `{ type: 'changed', reason: 'sync'\|'assign'\|'user'\|'play', title_ids, file_ids }`), `addSyncHook(hook)`; `buildMoviesService(config: Config, db, overrides?)` returns null only with `NOTESD_MOVIES=off` (empty roots: built, never scans) |
| `read.ts` | 4 | `ReadContext = { host, imageBase }`; `listTitles(db, filter, ctx)` (`TitleFilter`: `q`, `state`, `kind`, `company`, `person`, `finishedFrom`, `finishedTo`, `sort`, `limit`), `getTitle(db, id, ctx)`, `listUnmatched(db, ctx)`, `history(db, filter)` (`HistoryFilter`: `titleId`, `fileId`, `host`, `from`, `to`, `limit`; `PlayView` carries `episode_name`, `file_deleted`, `file_deleted_at`), returning wire views with `state`, `available`, `poster_url` |
| `reviewNote.ts` | 4 | `saveReview(service, notes, titleId, text)` (creates or updates the linked note through `NotesService`, tags it `#movie`) |
| `vlc/launch.ts`, `vlc/http.ts`, `vlc/recents.ts` | 5 | `PlayerEnv`/`detectPlayerEnv` (paths are taken as given if executable, so test/verify fakes work), `vlcArgs`, `VlcLauncher`/`spawnVlcLauncher({ scope? })` (under systemd: `systemd-run --user --scope`, so a daemon restart does not kill VLC), `VlcStatusReader` (curl.exe), `parseRecents(iniText)`, `recentsSyncHook` |
| `player.ts` | 5 | `class MoviePlayer`: `host`, `availability()`, `start()` (closes stale live plays), `play(fileId): PlayStarted`, `current(): PlayerSnapshot \| null`, `close()`; `PlayError` codes `not_on_this_machine`, `player_unavailable`, `file_missing`, `not_found`; `buildMoviePlayback(service, config, overrides?)`; held in `AppDeps.moviesPlayer?: MoviePlayer \| null` (the one player the play routes and `movies_continue` share). Emits `changed('play')` on play start and end only |
| `vlc/health.ts`, `vlc/incidents.ts` | 9 | `HealthMonitor` (`start()`, `settled()`, `processAlive(ep)`, `onHang(e)`, `status()`, `report(limit)`, `close()`), `buildVlcHealth({ config, dataDir, host, tracked, ... })` (interval 0 when roots are empty), `HealthLog` (append-only, fsync'd `<dataDir>/movies/vlc-health-<host>.jsonl` + `.1.jsonl`, 5 MiB rotation), `windowsProcessLister`, `detectHealthEnv`, record types `SampleRecord`/`HangRecord`/`IncidentRecord`/`HealthReport`; `analyzePreviousRun`, `powershellEventLogReader`, `buildIncident`. Held in `AppDeps.moviesHealth?: HealthMonitor \| null`. Phase 9 also edits phase 5's `vlcArgs(l, extraArgs = [])`, `spawnVlcLauncher({ scope?, extraArgs? })` and `player.ts` (`MoviePlayerDeps.health?`, the hang rule, `healthView()`); without a health link the player behaves exactly as phase 5 |
| `continue.ts` | 5 | `continueTitle({ db, player, exists? }, titleQuery \| null): Promise<ContinueResult>`; the query may be an exact title id (what the web sends) or text. `ContinueResult` = `resumed\|started` (`title, file, position, play`) \| `missing` (`title, missing, present`) \| `nothing` (`title, reason: finished\|caught_up\|no_episodes, finished_at, last`) \| `ambiguous` (`query, candidates`) \| `no_match` (`query`) |

### HTTP

Phase 1 creates both routers empty and mounts them in `src/http/app.ts`; later phases only fill their own file.

- `src/http/moviesApi.ts` `moviesApiRoutes(deps, options?)` (phase 4): `GET /api/movies` (filter: `q`, `state`, `kind`, `company`, `person`, `finished_from`, `finished_to`, `sort`, `limit`), `GET /api/movies/unmatched`, `GET /api/movies/status`, `GET /api/movies/:id`, `GET /api/movies/search-tmdb?q=&kind=` (for the manual fix), `POST /api/movies/:id/user` (`{ watched?, rating?, review? }`), `POST /api/movies/files/:fileId/watched`, `POST /api/movies/files/:fileId/assign`, `POST /api/movies/sync` (202; `?wait=true` 200 with the report), `GET /api/movies/events` (SSE `event: changed`, data = the `MovieChangeEvent`). `:id` / `:fileId` are regex-constrained (`{[a-z]+-[0-9]+}`, `{[0-9]+}`), so they never match `/api/movies/player`, `/continue` or `/player/health`. Writes are same-origin. With `deps.movies === null` every route answers 503 `movies_off`.
- `src/http/moviesPlayApi.ts` `moviesPlayRoutes(deps)` (phase 5): `POST /api/movies/files/:fileId/play` (`202 { ok: true, play: PlayStarted }`; 404 `not_found` / `not_on_this_machine`, 409 `player_unavailable`, 410 `file_missing`), `POST /api/movies/continue` (`{ title? }` -> `ContinueResult`), `GET /api/movies/player` (`{ available, reason, current: PlayerSnapshot \| null }`); phase 9 adds `GET /api/movies/player/health?limit=1..2000` (`HealthReport`; 400 `invalid_limit`; 503 `movies_off` without a monitor; read only) and widens the router's deps to `Pick<AppDeps, 'db' \| 'moviesPlayer' \| 'moviesHealth'>`. POSTs same-origin. `GET /api/capabilities` gains `movies_playback` (the web reads `/api/movies/player` instead).

### MCP (phase 7; names in `src/chat/status.ts` `MOVIE_TOOL_NAMES`)

`movies_list`, `movies_get`, `movies_history`, `movies_continue`, `movies_person`, `movies_mark`.

### Web (phase 6)

`View` gains `'movies'`; `MOVIES_PATH = '/movies'`; routes `/movies`, `/movies/<title id>`, `/movies/unmatched`; `web/src/pages/MoviesPage.tsx`, `web/src/components/movies/*`, `web/src/moviesApi.ts`, `web/src/hooks/useMovies.ts`, `web/src/lib/movies.ts` (`moviesChatMessage`: first line `[Movies · library]`, `[Movies · unmatched files]`, `[Movies · <title> (<year>) · <title id>]`, or `[Movies · <title id>]` while the detail loads). Verify hooks: rail/sidebar button named `Movies`, poster `<img alt={title}>`, file and episode rows `data-testid="movie-file"` with `data-file-id`, `data-deleted`, `data-state`.

## Phases

| # | Title | Satisfies | Package | Files | Depends on | Difficulty | Plan | TaskID | Card |
|---|-------|-----------|---------|-------|-----------|------------|------|--------|------|
| 1 | Foundation: schema, repo, state, config, seams | R3 | `src/db`, `src/movies`, `src/config.ts`, `src/http` | 31 | — | NORMAL | `.workflows/plan/movies-library/phase-1.md` | P1-NOTES-A102 | — |
| 2 | Filename parser, TMDB client, matcher, Haiku fallback | R1, R2 | `src/movies` | 18 | — | HARD | `.workflows/plan/movies-library/phase-2.md` | P1-NOTES-A103 | — |
| 3 | Library sync: scan, diff, match, store, background service | R1, R2, R3 | `src/movies`, `src/background.ts`, `src/daemon.ts` | 11 | 1, 2 | HARD | `.workflows/plan/movies-library/phase-3.md` | P1-NOTES-A104 | — |
| 4 | HTTP API: read model, user state, review note, manual fix, SSE | R1, R2, R3 | `src/http`, `src/movies` | 6 | 3 | NORMAL | `.workflows/plan/movies-library/phase-4.md` | P1-NOTES-A105 | — |
| 5 | VLC playback: launch, live tracking, recents backfill, continue | R3, R4, R6 | `src/movies/vlc`, `src/http` | 22 | 3 | HARD | `.workflows/plan/movies-library/phase-5.md` | P1-NOTES-A106 | — |
| 6 | Web: Movies page, grid, detail, unmatched, pill | R5 | `web/src` | 29 | 4, 5 | HARD | `.workflows/plan/movies-library/phase-6.md` | P1-NOTES-A107 | — |
| 7 | MCP tools, chat bar allow-list, `/n` skill | R6 | `src/mcp`, `src/chat`, `claude/skills/n` | 14 | 4, 5 | NORMAL | `.workflows/plan/movies-library/phase-7.md` | P1-NOTES-A108 | — |
| 8 | Docs, feature map, verify fixtures, live config | R7 | docs, `.claude/skills/verify-notesd` | 15 | 6, 7, 9 | NORMAL | `.workflows/plan/movies-library/phase-8.md` | P1-NOTES-A109 | — |
| 9 | VLC health log, hang detection, crash incidents | R8 | `src/movies/vlc`, `src/http` | 17 | 5 | NORMAL | `.workflows/plan/movies-library/phase-9.md` | P1-NOTES-A110 | — |

Waves: {1, 2} → {3} → {4, 5} → {6, 7, 9} → {8}.

Phases 3 and 4 each serve three requirements. That coupling is real: one sync pass is where scope (R1), metadata (R2) and the file lifecycle (R3) meet, and one read model returns all three.

### Phase 1 — Foundation: schema, repo, state, config, seams
**Satisfies:** R3
**Criteria:** R3.4, R3.8
**Owns:** `drizzle/0017_movies.sql` + `drizzle/meta`; the `movie_*` tables in `src/db/schema.ts`; `src/movies/types.ts` (the one `TitleMetadata` definition), `state.ts`, `repo.ts` (every method any phase calls, `closeOpenPlays` and `findTrackedFile` for phase 5 included; no later phase edits this file); `MoviesConfig`/`parseMovies`/`DEFAULT_MOVIES_CONFIG` in `src/config.ts`; `movies: MoviesService | null` in `AppDeps` as a forward type (a minimal `src/movies/service.ts` exporting only the `MoviesService` interface shape phase 3 will implement, `deps.movies = null` in `src/daemon.ts` and every test builder of `AppDeps`); empty `src/http/moviesApi.ts` and `src/http/moviesPlayApi.ts` routers mounted in `src/http/app.ts`; the README env table rows; unit tests for `state.ts` and config; integration tests for the migration and `MoviesRepo` (including the "company finished in a date range" query of R3.8).
**Does not touch:** parsing, TMDB, scanning, routes' bodies, web, MCP.
**Exit criteria:** migration applies on the test database; `MoviesRepo` round-trips titles with companies, credits and episodes, files and plays; `fileState` covers every state; `NOTESD_MOVIES_FALLBACK_MODEL=off` parses to `fallbackModel: null`; typecheck and both test suites pass.

### Phase 2 — Filename parser, TMDB client, matcher, Haiku fallback
**Satisfies:** R1, R2
**Criteria:** R1.3, R2.1, R2.2
**Owns:** `src/movies/parse.ts`, `tmdb.ts`, `match.ts`, `fallback.ts`, their unit tests, `tests/helpers/tmdbFixtures.ts` and TMDB JSON fixtures under `tests/fixtures/movies/`. Because phase 1 runs in the same wave, `tmdb.ts` declares a field-for-field mirror of `types.ts`'s `TitleKind`, `CreditRole`, `CompanyMeta`, `CreditMeta`, `EpisodeMeta`, `TitleMetadata` under the same names; phase 3 replaces it with a re-export.
**Does not touch:** the database, config (takes a plain `{ token, apiKey, apiBase }`), scanning, routes, web. No network in tests.
**Exit criteria:** every filename listed in the request parses to the expected title/year/season/episode (a table-driven test with the real names from the analysis); `tvDetails` returns episodes for every season; a low-confidence search goes to the fallback; an unreachable TMDB raises `TmdbError`.

### Phase 3 — Library sync: scan, diff, match, store, background service
**Satisfies:** R1, R2, R3
**Criteria:** R1.1, R1.2, R1.4, R2.1, R2.3, R3.1, R3.2, R3.3, R3.5
**Owns:** `src/movies/scan.ts`, `sync.ts`, the real `service.ts` (`MoviesService`, `buildMoviesService`, `MovieEvents`, `assign`, `addSyncHook`); the re-export that replaces phase 2's mirrored types in `tmdb.ts`; building it in `src/daemon.ts`; starting and closing it in `src/background.ts`; unit tests with a fake fs/ffprobe/TMDB; an integration test that runs passes over a temp directory against the test database.
**Does not touch:** routes, VLC, web, MCP. It provides `assign` and `syncNow` for phase 4 and `addSyncHook` for phase 5.
**Exit criteria:** a pass over a fixture tree registers matched files, lists short/no-match files as unmatched (short ones without any TMDB call), groups a season folder under one `tv-` title, detects delete, move and done; files under no configured root are never judged; a TMDB outage (network/timeout/401/403/429/5xx) leaves files `pending` and the next pass matches them, while one title's 404 leaves only that file pending; unmatched files are never re-matched (no repeated Haiku call); nothing runs with `NOTESD_MOVIES=off` or empty roots.

### Phase 4 — HTTP API: read model, user state, review note, manual fix, SSE
**Satisfies:** R1, R2, R3
**Criteria:** R1.5, R2.4, R3.6, R3.7
**Owns:** `src/movies/read.ts`, `reviewNote.ts`, the body of `src/http/moviesApi.ts`, `tests/integration/helpers/moviesSeed.ts`, integration tests over HTTP.
**Does not touch:** `src/http/app.ts` (already mounted), `src/http/moviesPlayApi.ts`, `src/movies/repo.ts`, VLC, web, MCP.
**Exit criteria:** every route in the contract answers; a title detail carries state per file/episode, `available` per file and `poster_url`; assigning an unmatched file moves it into the library; watched/rating/review persist and the review is a real note; 503 `movies_off` without a service.

### Phase 5 — VLC playback: launch, live tracking, recents backfill, continue
**Satisfies:** R3, R4, R6
**Criteria:** R3.7, R4.1, R4.2, R4.3, R4.4, R4.5, R6.1, R6.2
**Owns:** `src/movies/vlc/*`, `player.ts`, `continue.ts`, the body of `src/http/moviesPlayApi.ts`, `movies_playback` in `/api/capabilities` (`src/http/reveal.ts`), `AppDeps.moviesPlayer` (`src/deps.ts`), building the player and registering `recentsSyncHook` in `src/daemon.ts`, unit tests with a fake launcher/status reader/ini, an integration test with a fake VLC, `tests/fixtures/movies/{fake-vlc.mjs,memVlc.ts,rows.ts}`, `tests/integration/helpers/moviesPlaySeed.ts`.
**Does not touch:** `src/http/moviesApi.ts`, `read.ts`, `src/movies/repo.ts` (its two repo methods live in phase 1), `src/http/app.ts`, web, MCP. It may reuse `findOnPath`/`spawnDetached`/`runWslpath` from `src/http/reveal.ts` without changing their behavior.
**Exit criteria:** play launches the (fake) VLC with the Windows path, `--no-one-instance`, `--extraintf http`, loopback host, our port and a per-launch password, confirms `playing`, seeks to the resume position, polls into one play event and closes it when the status reader reports the process gone; `changed` is emitted on play start and end only; under systemd VLC is launched in its own `systemd-run --user --scope`; recents entries become observations, including for a file that no longer exists; continue picks resume / next present / missing as specified and accepts an exact title id.

### Phase 6 — Web: Movies page, grid, detail, unmatched, pill
**Satisfies:** R5
**Criteria:** R5.1, R5.2, R5.3, R5.4, R5.5
**Owns:** everything under `web/src` named in the contract, plus `Rail.tsx`, `Sidebar.tsx`, `Header.tsx`, `App.tsx`, `lib/route.ts`, `types.ts`, `styles.css` edits and their jsdom tests.
**Does not touch:** the server.
**Exit criteria:** the rail icon toggles the page; grid, detail (movie and series), unmatched list with assign, stars, watched, review, play/resume (disabled with a tip when playback is unavailable or the file is on another host), deleted flags and the pill all work against the phase 4 and 5 routes; back/forward and deep links work.

### Phase 7 — MCP tools, chat bar allow-list, `/n` skill
**Satisfies:** R6
**Criteria:** R6.1, R6.2, R6.3, R6.4, R6.5
**Owns:** `src/mcp/movieTools.ts`, registration in `src/mcp/server.ts`, `ToolDeps.movies` + `mcpToolDeps` in `src/http/app.ts` (`movies_continue` drives `deps.moviesPlayer`, the same instance as `POST /api/movies/continue`), `MOVIE_TOOL_NAMES` + `allowedChatTools` in `src/chat/status.ts`, the subsystem sentence in `src/chat/prompt.ts`, `src/mcp/instructions.ts`, `claude/skills/n/SKILL.md`, MCP integration tests.
**Does not touch:** routes, web, the player's internals (it calls `continueTitle`, `MoviePlayer`, `read.ts`).
**Exit criteria:** the six tools answer over `/mcp` against seeded data, including a deleted series' last watched episode and a company-in-year list; `movies_person` marks seen entries; the chat allow-list contains the tools.

### Phase 8 — Docs, feature map, verify fixtures, live config
**Satisfies:** R7
**Criteria:** R7.1
**Owns:** `CLAUDE.md` (architecture paragraph), `README.md` (tour, HTTP API and MCP tables; the env rows exist from phase 1 and are completed here), `.claude/skills/verify-notesd/features/movies.md` and its README row, movie fixtures for `verify.sh` (generated video tree, fake TMDB, fake VLC), and a documented step that adds the roots, `NOTESD_VLC_INI` and the Done dir to the live `/home/miftah/mcp-notes/.env.local` (untracked; appended only if absent).
**Does not touch:** product code, except a verify-harness seam a journey cannot do without.
**Exit criteria:** the feature map's journeys run green on a throwaway daemon; docs name every env var, route and tool that exists (phase 9's included). J4 and the VLC-survives-restart check are post-merge only: a verifier reports J4 `pending` before the merge and judges R7.1 on J1-J3.

### Phase 9 — VLC health log, hang detection, crash incidents
**Satisfies:** R8
**Criteria:** R8.1, R8.2, R8.3, R8.4, R8.5
**Owns:** `src/movies/vlc/health.ts` (process sampler over the Windows side: every `vlc.exe` with pid, working set, private bytes, handles, start time, through one injectable `ProcessLister`; the append-only per-host log `<dataDir>/movies/vlc-health-<host>.jsonl` written with a synchronous append so the last line survives a WSL crash, size-capped by rotation; a heartbeat/clean-stop marker; `HealthMonitor` start/close), `src/movies/vlc/incidents.ts` (at start: unclean previous stop + samples → read Windows Application Error / Application Hang events around the last sample through an injectable `EventLogReader`, write one incident record), the hang rule in `src/movies/player.ts` (HTTP silent while the pid exists → `hang` record, the play keeps its last position; distinct from VLC gone), `vlc.healthMs` and `vlc.extraArgs` in `src/config.ts` and their use in `vlc/launch.ts`, `GET /api/movies/player/health` in `src/http/moviesPlayApi.ts`, starting and closing the monitor where phase 5 builds the playback, README env rows for the two variables, unit and integration tests with fake lister / fake event log.
**Does not touch:** web (phase 6), MCP and `src/chat` (phase 7), `src/http/app.ts`, `src/movies/repo.ts`, the schema (no table: the log is a file because it must survive the database being unreachable and the VM dying). It never kills, pauses or restarts a VLC. Also owns: `AppDeps.moviesHealth` (`src/deps.ts`), the monitor block in `src/daemon.ts`, `tests/unit/config.test.ts` additions, `tests/fixtures/movies/fake-windows.mjs`, `GET /fake/hang` in phase 5's `fake-vlc.mjs`. No same-wave phase edits any of these files.
**Exit criteria:** with a fake lister, samples are appended for notesd-started and foreign VLCs; killing the daemon without a clean stop and starting it again writes one incident with the fake event log's entries; a silent HTTP interface with a live pid records a hang and no play is lost; extra args reach the launch line; the health route returns samples and incidents; with no roots or `NOTESD_VLC_HEALTH_MS=0` nothing is sampled. J6 (real daemon SIGKILLed) is WSL-only: off WSL it is `inconclusive`, never `failed`; R8.2 keeps J2, which runs everywhere. J8 is the owner's manual post-deploy check.

## Reconciliation Log

Round 1, 2026-11-14 (resumed after a crash; phases 2 and 3 were edited before it, the rest after). Phase 9 was not yet written when round 1 ended; round 2 reconciled it.

| # | Conflict | Kind | Resolution |
|---|---|---|---|
| 1 | `TitleMetadata` family defined twice with different names (phase 1 `CompanyMeta`/`CreditMeta`/`EpisodeMeta` in `types.ts`; phase 2 `TitleCompany`/`TitleCredit`/`TitleEpisode` with an `ord` field in `tmdb.ts`), phases 1 and 2 in one wave | Duplicate work / contract drift | Phase 1's names and fields win (no `ord`: array order, which `upsertTitle` already stores). Phase 2 keeps a field-for-field mirror under those names in `tmdb.ts` (both phases build alone; distinct files, no collision); phase 3 Step 0 replaces the mirror with `export type { ... } from './types.js'`. Phase 2's code, tests and contract edited; phase 1 handoff updated. No 2 -> 1 edge added |
| 2 | `absoluteToSeasonEpisode` signature (per-season counts vs `TitleMetadata.episodes`) and the Decisions row on cumulative counts | Contract drift | Phase 2's measured behavior wins: `absoluteToSeasonEpisode(episodes, n)` returns the n-th listed episode over seasons >= 1 with TMDB's own numbers. Phase 3 already called it so. Decisions row and Shared contract updated |
| 3 | Phase 3 tripped its per-pass breaker on any `TmdbError` and constructed `new TmdbError(message)`; phase 2's `TmdbError(code, message, status?)` | Contract drift | New `tmdbUnreachable(err)` in phase 3's `sync.ts`: `network`, `timeout`, `no_credentials`, `http` 401/403/429/>=500 trip the breaker (rest of the pass pending); `http` 404/other 4xx and `bad_response` leave only that file pending. Unit test added; test constructors fixed |
| 4 | Repo signatures assumed by phases 3, 4, 5, 7 differ from phase 1 (`MovieFileInput` vs `NewMovieFile` + `FileClassification`, `upsertFile` return, `moveFile` options, `assignFile` nullable, `startPlay` needs `startedAt`, `endPlay(…, endedAt)`, `updatePlay` returns boolean, `lastPlay` order) | Unmet assumption | Phase 1 is the source of truth; call sites rewritten in phases 3 (incl. writing a retried row's classification with `assignFile`/`setUnmatched`, since `upsertFile` only refreshes scan facts on a live row), 4 (`lastPlays` `distinct on` uses `lastPlay`'s order), 5 (player, continue, test fakes) and 7 |
| 5 | Phase 5 appended `closeOpenPlays`, `findTrackedFile`, `createDeletedFile` to `repo.ts` in the same wave as phase 4 | File collision risk | `closeOpenPlays` and `findTrackedFile` moved into phase 1 (same code); `createDeletedFile` dropped in favor of phase 1's `upsertFile({ …, deletedAt, classification: matched })`. Phase 5 no longer edits `repo.ts`; no later phase does |
| 6 | Events: phase 4 assumed `MovieChange {op, title_id, file_id}` + `emit`; phase 5 `emit('changed')`; phase 3 has `changed(reason, ids)` / `MovieChangeEvent` | Contract drift | Phase 3's shape wins (it serves the SSE wire as-is). Phase 4's SSE `data` is the `MovieChangeEvent`; phase 4 emits `user`, `service.assign` emits `assign` (phase 4's duplicate emit removed); phase 5 emits `changed('play', ids)` on play start and end only, never per poll; phase 6 mirror updated |
| 7 | `MoviesStatus` fields (phase 4/6 assumed `enabled, tmdb: boolean, last_sync_at, last_report, last_error`) | Contract drift | Phase 3's `status()` wins: `{ host, roots, done_dirs, scan_ms, min_seconds, scanning, running, tmdb: ok/no_credentials/unreachable, next_pass_at, last_pass }`; phase 4 Requires and phase 6 mirror, fixture and empty-library text updated |
| 8 | Phase 4 tests called `buildMoviesService(MoviesConfig, …)`; phase 3 takes `Config` and may return null | Contract drift | Phase 4 test builds `{ ...h.deps.config, movies: MOVIES_TEST_CONFIG }` and throws on null |
| 9 | Phase 4's assign route caught `TmdbError` and pre-checked `tmdb === null`; phase 3's `assign` throws `MoviesServiceError` and allows a stored title without credentials | Contract drift | Route maps `MoviesServiceError` codes (`not_found` 404, `no_tmdb_credentials` 503 `tmdb_off`, `tmdb_unreachable` 502 `tmdb_error`); pre-check removed |
| 10 | Service null vs empty roots; seeded rows outside roots | Behavioral fork | All plans agree: null only for `NOTESD_MOVIES=off`. Phase 3 Step 2 now states that a pass only judges files under a currently configured root (seeded/foreign rows survive). Phase 5's `movies_off` message no longer mentions roots |
| 11 | Player wiring: phase 7 assumed `moviesContinueDeps(appDeps)` and `ContinueDeps { db, repo, host, player }`; phase 5 has `{ db, player, exists? }` and `AppDeps.moviesPlayer` | Unmet assumption | Phase 7 aligned: `movieToolDeps` calls `continueTitle({ db, player: deps.moviesPlayer }, title)`; MCP and HTTP drive the same instance. Phase 7 owns the `app.ts` `mcpToolDeps` edit; phase 5 does not touch `app.ts`. Phase 7's fake player now has `host` and returns `start_position`, and the test passes `exists` |
| 12 | `ContinueResult`: phase 6/7 assumed four actions with `missing`/`present` as `{season, episode}[]` and nullable `title` | Contract drift | Phase 5's union (`resumed\|started\|missing\|nothing\|ambiguous\|no_match`, `ContinueEpisodeRef`) mirrored in phase 6 (`continueNotice` rewritten, tests updated) and phase 7 (`continueMessage`, `continueUrl`, description, unit test). Phase 5's `resolveTitle` already matches an exact id first; doc comment says so |
| 13 | Phase 6 assumed `CurrentPlay { position_s, duration_s }` and a `{}`-body play route | Contract drift | Mirrors phase 5's `PlayerSnapshot { position, duration, state, … }` and `202 { ok, play }`; detail's live line and `PLAYING` fixture updated. Web keeps reading `/api/movies/player`; `/api/capabilities.movies_playback` stays and is unused by the web |
| 14 | `read.ts` signatures: phase 7 assumed `TitleFilter{host}`, `getTitle(db,id,host)`, `HistoryItem` with `episode_name`/`file_deleted_at`; `TitleDetail.episodes` | Unmet assumption / gap | Phase 4 `PlayView` gains `episode_name` (join on `movie_episodes`) and `file_deleted_at`, `HistoryFilter` gains `fileId`; phase 7 passes `ReadContext { host, imageBase }` (new `MovieToolDeps.imageBase`), never filters history by host, reads `seasons[].episodes[]`, handles a null `title_id` |
| 15 | Phase 4 `parsedView(raw: ParsedName)` over a `MovieParsedName` column | Broken build | Typed as phase 1's `ParsedNameRecord`; `read.ts` re-exports `WATCH_STATES` from `types.ts` instead of redefining it |
| 16 | Phase 4 regex path params vs phase 5's `/api/movies/player`, `/continue` (and phase 9's `/player/health`) | Ordering check | No collision: `:id{[a-z]+-[0-9]+}` needs a dash and digits, `:fileId{[0-9]+}` digits; both routers are mounted once by phase 1, moviesApi first. Recorded in the HTTP contract |
| 17 | Phase 7 assumed `TmdbPerson { id, knownForDepartment }`, credits with `role` | Contract drift | Aligned to phase 2: `TmdbPersonHit.personId`, `knownFor`; `TmdbPersonCredit.credit` (code, fakes) |
| 18 | `tests/integration/helpers/moviesSeed.ts` created by phases 4 and 5 (same wave) | File collision | Phase 4 keeps it; phase 5's helper renamed `tests/integration/helpers/moviesPlaySeed.ts` (all imports updated) |
| 19 | `NOTESD_MOVIES_FALLBACK_MODEL=off` (phase 8's verify.sh) had no meaning in phase 1 (`off` passed as a model name) | Gap | Phase 1: `fallbackModel: string \| null`, `off` -> null, unit test, README row; phase 3 builds no fallback when null. A failed fallback leaves the file `unmatched no_match`, and unmatched files are never re-matched by a pass (phase 3 retries only `pending` and `no_tmdb_credentials`), so Haiku is never re-asked for the same file |
| 20 | VLC killed by `systemctl --user restart notesd` (`KillMode=control-group`), unmeasured | Behavioral fork | Phase 5's launcher starts VLC via `systemd-run --user --scope` when notesd runs as a systemd service (detected from `/proc/self/cgroup`), else a plain detached spawn; unit tests added; phase 8 post-deploy check verifies a VLC survives a restart |
| 21 | Phase 8 wall hooks (`Movies` button, poster `alt`, `data-testid="movie-file"` + `data-deleted`) | Unmet assumption | Button and `alt` already in phase 6; `FileRow` and `EpisodeItem` now carry `data-testid="movie-file"`, `data-file-id`, `data-deleted`, `data-state` |
| 22 | Phase 8 doc-check grepped literal `.get('/api/movies…'` calls, but phase 4 registers four routes through `*_PATH` constants with `{regex}` params | Broken proof | doc-check now collects every `/api/movies…` literal in both routers, strips `{…}`, and compares paths (not methods) both ways |
| 23 | Phase 8 journey called `movies_get {"id": …}`; phase 7's argument is `title` | Contract drift | journey and phase 8 Requires/Handoffs use `{"title": …}` |
| 24 | Phase 8 J4 needs the merged `main` and the live daemon | Proof timing | J4 marked POST-MERGE ONLY (`pending` before the merge, never `failed`); R7.1 keeps pre-merge journeys J1-J3. Phase 8 now depends on 6, 7, 9 (coordinator's edge, already in the index) |
| 25 | Pill first line (phase 6) vs the chat prompt / MCP instructions (phase 7) | Contract check | Consistent (`[Movies` prefix, title id last). The exact four formats are now written into phase 7's handoffs and the Web contract |
| 26 | Fake VLC and fake TMDB duplicated between phase 8 (`verify-notesd/scripts/movies/`) and phases 2/5 (`tests/`) | Duplicate work | Kept, recorded in phase 8: verify.sh scripts are standalone `.mjs`/`.sh` and phase 8's fakes have a different design (fake curl.exe + control CLI; more titles); a TS test helper cannot be imported there |
| 27 | Phase 5 defined its own `TitleResolver`/`tmdbResolver` in `vlc/recents.ts`, duplicating phase 3's | Duplicate work | Phase 5 re-exports phase 3's type and calls `tmdbResolver(tmdb, null)` from `sync.ts`; its `afterScan` returns rows written so the pass emits `changed('sync')` |
| 28 | Phase 9 plan not written when items 1-27 were done | Unreconciled (round 1) | Resolved in round 2 (rows 29-38) |

Round 2, 2026-11-14 (final): phase 9 against phases 1-8 and the "Phase 9 boundaries" decision, and a re-check of round 1's interface moves.

| # | Conflict | Kind | Resolution |
|---|---|---|---|
| 29 | Phase 9 quoted phase 5 mid-reconciliation (`vlcArgs`, `spawnVlcLauncher`, `player.ts` `Tracked`/`tick`/`finish`/`PlaybackOverrides`/`buildMoviePlayback`, `moviesPlayRoutes` signature, the daemon's two `moviesPlayer` lines, `deps.ts`) | Contract drift check | Every anchor matches the final `phase-5.md` verbatim; extra args land in `vlcArgs`, which `spawnVlcLauncher` passes both to `systemd-run --user --scope -- <vlc>` and to the plain spawn, before the file. Recorded in phase 9's Phase 5 handoff |
| 30 | Config half (`VlcConfig.healthMs`, `extraArgs`, phase 1's config-test expectations) | Ownership | Stays in phase 9 (Steps 1 and 9): wave {6, 7, 9} has no other editor of `src/config.ts` or `tests/unit/config.test.ts`, and phase 1 lands first. Phase 9's Phase 1 handoff and the index say the same |
| 31 | Sampler with no roots (invariant 5) | Invariant | `buildVlcHealth` passes interval 0 when `config.roots` is empty, and the startup line says so; `NOTESD_MOVIES=off` builds no monitor; `DEFAULT_MOVIES_CONFIG` is off |
| 32 | Same-wave files: phase 9's `src/deps.ts`, `src/daemon.ts`, `README.md`, `fake-vlc.mjs` vs phases 6 and 7 | Collision check | None: phase 6 edits only `web/**`, phase 7 only `src/mcp/**`, `src/chat/**`, `src/http/app.ts`, `claude/skills/n` and its own tests. Phase 9 does not touch `app.ts` |
| 33 | `/api/movies/player/health` vs phase 4's `:id{[a-z]+-[0-9]+}` | Route collision check | None (two segments after `/api/movies/`, and `player` has no `-<digits>`) |
| 34 | Phase 8 did not know phase 9's route, log file and four env vars; doc-check read env vars from `src/config.ts` only | Gap | Phase 8: four env rows kept in its README replacement block, an HTTP API row for the health route, the CLAUDE.md bullet and a "VLC health" feature-map sub-feature (proof = phase 9 J5/J6); doc-check scans `src/config.ts` and `src/movies/vlc/health.ts` (`ENV_RE` gains the two overrides; N >= 20, M >= 14) |
| 35 | A throwaway daemon could sample the owner's real `vlc.exe` | Gap | `verify.sh up --movies` pins `NOTESD_VLC_HEALTH_MS=0` and `NOTESD_VLC_EXTRA_ARGS=`; plain runs are movies-off (no monitor) |
| 36 | Phase 9 J7 drives a plain `verify.sh up`, which phase 8 later turns into a movies-off run | Proof timing | J7 is valid at phase 9's own verification (before phase 8); its text says so, and the feature map uses J5/J6 instead |
| 37 | Phase 9 J6 is WSL-only | Proof portability | Text says a verifier off WSL reports it `inconclusive`, never `failed`; R8.2 keeps J2, which runs everywhere |
| 38 | Phase 9's manual J8 (pause 10+ min, read the route) | Placement | Copied into phase 8's Step 10 as "Post-deploy check 2" |
| 39 | Round 1 moves re-checked: `closeOpenPlays`/`findTrackedFile` (phase 1 code, contract, phase 5 Requires/fakes), `tmdb.ts` re-export (phase 2 contract, phase 3 Step 0 and Files), `fallbackModel: string \| null` (phase 1 type/parse/test/README, phase 3 build, phase 8 README row), events / `MoviesStatus` / `PlayView` / `ContinueResult` / `ReadContext` (phases 3-7 and the index) | Verification | Consistent in every plan that names them; no leftover old names (grep for `MovieFileInput`, `createDeletedFile`, `moviesContinueDeps`, `TitleCompany`, `CurrentPlay`, `last_sync_at`, `events.emit`, `knownForDepartment` finds none) |

## Decisions

| Fork | Chosen | Rung |
|---|---|---|
| OMDb fallback vs TMDB only | TMDB only. The request says "test reachability from this machine first; OMDb is the fallback": tested 2026-11-14, API and image hosts both answer with the owner's credentials | 5: user's raw input |
| Posters cached on disk vs hotlinked | Hotlink `image.tmdb.org` from the stored `poster_path`. Disk is per host; "Posters must be viewable from both machines" | 5: user's raw input |
| How WSL reads VLC's HTTP interface | `curl.exe` on the Windows side against `127.0.0.1`. NAT networking cannot reach a loopback-bound VLC, and binding `0.0.0.0` would expose VLC control to the LAN | 6: surrounding convention (loopback-only daemon) |
| Resume by `--start-time` only vs confirm and seek | Launch, wait for the HTTP interface, make sure state is `playing`, then `seek` to the resume position. `--start-time` is still passed; the probe showed launch flags alone are not a reliable signal | 2: phase exit criteria (R4.1 must be observable) |
| Watcher vs polling for the roots | Polling every `NOTESD_MOVIES_SCAN_MS`. `/mnt/c` is drvfs and does not deliver inotify events for Windows-side changes | 6: surrounding convention |
| Meaning of `[RecentsMRL]` time 0 / -1 | "Opened, position unknown": a play observation with `position_s` null. A deleted file with only such observations has state `seen` (counts as seen in history, shown as uncertain) | 5: user's raw input ("deleted is not the same as watched") |
| Absolute-numbered episodes (`One Piece - 405`) | Store `absolute_episode`; map it to the n-th listed TMDB episode over seasons >= 1, keeping TMDB's own season and episode numbers (`absoluteToSeasonEpisode(TitleMetadata.episodes, n)`). Phase 2 measured on live TMDB that One Piece numbers episodes continuously (season 2 starts at episode 62), so cumulative per-season counts would invent episode numbers. When the mapping fails keep the file matched to the series with season/episode null | 3: the plans' code blocks (phase 2's measured J4) |
| Default roots | None in code. The two Windows paths go into the live `.env.local` (phase 8): "Roots must be configurable/injectable (env)" | 5: user's raw input |
| Title id format | `movie-<tmdb id>` / `tv-<tmdb id>` | 6: surrounding convention (ids are never invented) |
| What the 13:03 crash was (2026-11-14) | Not assumed to be a memory leak. The Windows Application log shows `Explorer.EXE` and `WindowsTerminal.exe` faulting at 13:03-13:04, one in the Intel graphics driver module `igd10umt64xe.DLL` (0xc0000005); no `vlc.exe` fault and no resource-exhaustion event were logged, and the WSL VM restarted. Phase 9 therefore records both memory samples and the Windows fault events, and `NOTESD_VLC_EXTRA_ARGS` lets the owner test a decoder/output change (for example `--avcodec-hw=none`) without a code change | 5: user's raw input ("prepare to track this memory leak / VLC hang") |
| One `TitleMetadata` definition while phases 1 and 2 run in parallel | `types.ts` (phase 1) holds it with phase 1's names (`CompanyMeta`, `CreditMeta`, `EpisodeMeta`, no `ord`); phase 2 mirrors it field for field in `tmdb.ts`; phase 3 turns the mirror into a re-export. No new edge | 3: the plans' code blocks (phase 1's repo stores array order as `ord`; the Shared contract puts `TitleMetadata` in `types.ts`) |
| Which `TmdbError`s mean "TMDB unreachable" (R2.3) | `network`, `timeout`, `no_credentials`, `http` 401/403/429/>=500 stop TMDB calls for the rest of the pass (all pending); a 404/other 4xx or a malformed body leaves only that file pending and the pass goes on | 4: index Requirements (R2.3: "cannot be reached"; one bad title is not an outage) |
| Present file whose only plays have an unknown position; a play left at exactly 0 | A present file played with position unknown is `in_progress` (Resume starts at 0); position 0 counts as never played (`unwatched` / `removed_unwatched`); a deleted file with only unknown positions is `seen`. Phases 4-7 call `fileState`/`resumePosition` instead of restating it, and continue resumes such a file from 0 | 5: user's raw input ("deleted is not the same as watched") |
| Event bus shape and when `changed` fires | Phase 3's `MovieEvents.changed(reason, ids)`; SSE data is the event as-is. `play` fires on play start and play end only, never per position poll (the web reloads its list on every event and polls `/api/movies/player` during a play) | 3: the plans' code blocks (phase 3's service; phase 6's measured reload cost) |
| `MoviesStatus` shape | Phase 3's `status()` (`host, roots, done_dirs, scan_ms, min_seconds, scanning, running, tmdb, next_pass_at, last_pass`) plus phase 4's `counts` | 3: the plans' code blocks (phase 3 implements it) |
| Movies service with empty roots; rows outside the roots | `buildMoviesService` returns null only for `NOTESD_MOVIES=off`. With no roots the service is built, never scans, and the read routes and an explicit play still work; invariant 5 is read as "nothing runs on its own". A pass only judges files under a currently configured root, so rows seeded by tests/verify outside the roots, rows of a removed root and `vlc_recents` rows are never marked deleted by a pass | 1: stated invariant (5, read with its purpose: tests and an unconfigured host start nothing) |
| One player for HTTP and MCP | `AppDeps.moviesPlayer` (phase 5) is the single `MoviePlayer`; `POST /api/movies/continue`, the play route and `movies_continue` all use it; no `moviesContinueDeps` builder. Phase 7 owns the `app.ts` `mcpToolDeps` edit | 3: the plans' code blocks (phase 5's wiring) |
| `ContinueResult` shape and the web's continue body | Phase 5's union including `ambiguous` and `no_match`; the web sends `{ title: <exact title id> }` and `continueTitle` matches an exact id first | 3: the plans' code blocks (phase 5) |
| Who adds repo methods | Only phase 1 edits `src/movies/repo.ts`: it also carries `closeOpenPlays` and `findTrackedFile` for phase 5; a vlc_recents file is created with `upsertFile` + `deletedAt` | 6: surrounding convention (one writer module per subsystem, one owner per file region) |
| `NOTESD_MOVIES_FALLBACK_MODEL=off` | `fallbackModel: null`: no Haiku fallback; such files stay unmatched. A failed fallback leaves the file `unmatched no_match`, and unmatched files are never re-matched by a pass, so the same file never costs a second Haiku call | 2: phase exit criteria (phase 8's `--movies` runs pin it off and must cost nothing) |
| A daemon restart must not interrupt a film | Phase 5 launches VLC through `systemd-run --user --scope --collect` when notesd itself runs as a systemd service (its cgroup ends in a `*.service` other than `user@<uid>.service`), so `KillMode=control-group` on `notesd.service` cannot reach it; otherwise a plain detached spawn (tests, verify, manual runs). `cmd.exe /c start` was rejected (re-quoting of paths through cmd and the WSL interop) and `KillMode=process` (affects every child of the unit). Phase 8's post-deploy check verifies it | 2: phase exit criteria |
| Phase 8 J4 (live `.env.local` + live daemon) | Post-merge only: `pending` before the set is on `main`, never `failed`; R7.1 is judged pre-merge on J1-J3 | 2: phase exit criteria |
| Seed helper names | Phase 4 owns `tests/integration/helpers/moviesSeed.ts`; phase 5 uses `moviesPlaySeed.ts`; phase 7 `moviesMcpSeed.ts` | 6: surrounding convention (one owner per file) |
| Phase 9 config ownership | Phase 9 keeps its config edits (`VlcConfig.healthMs`, `extraArgs`, parse helpers, config-test expectations); phase 1 does not know them | 6: surrounding convention (one owner per file region within a wave; no same-wave editor of `config.ts`) |
| Phase 9 boundaries (applied in round 2) | Phase 9 is in wave {6, 7, 9}: it must not edit any file phase 6 (`web/**`) or phase 7 (`src/mcp/**`, `src/chat/**`, `src/http/app.ts`, `claude/skills/n`) edits. It edits after phase 5: `src/config.ts` (two fields; phase 1's README block and config tests need not know them), `vlc/launch.ts` (`vlcArgs` + extra args; keep `spawnVlcLauncher`'s systemd scope), `player.ts`, `moviesPlayApi.ts` (`GET /api/movies/player/health`; a literal path so phase 8's doc-check finds it), README env rows appended to phase 1's contiguous block. Its background sampler must not run when the library is off or has no roots (invariant 5) and is off in `DEFAULT_MOVIES_CONFIG`. Phase 8 documents its route, log file `<dataDir>/movies/vlc-health-<host>.jsonl` and the two env vars | 1: stated invariants (5, and one owner per file within a wave) |
| "i will use WSL's vlc" | The Windows `vlc.exe` started from WSL by notesd. No Linux VLC is installed or planned | 4: index Why (R4: "VLC is Windows-only") |

## Open Questions

None.

## Rollback

Per phase: revert the phase's commit; phases 2–8 add files and wiring only. Phase 1's migration is additive (`movie_*` tables only); to back it out drop those tables and delete the `0017` journal entry. As a whole: delete branch `feature/movies-library`; if already merged, set `NOTESD_MOVIES=off` to stop all movie work without a revert.

## Next

Execute the phases one at a time, starting at phase 1:

    /implement -f .workflows/plan/MOVIES_LIBRARY_PLAN.md --phase 1

Or run the whole set as a swarm — a session per phase, concurrent wherever `Depends on` allows, resumable on any machine:

    /analyze-orchestrator -f .workflows/plan/MOVIES_LIBRARY_PLAN.md

Or put them on the board first (GitHub repos only):

    /create-task --from-plan .workflows/plan/MOVIES_LIBRARY_PLAN.md
