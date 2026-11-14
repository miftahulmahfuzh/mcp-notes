# Code Analysis: Movies subsystem

**Type:** Feature Implementation
**Date:** 2026-11-14 12:16 WIB
**Session ID:** 20261114-121616-M7VL (Claude Code node E6-MP)
**Plan:** `.workflows/plan/MOVIES_LIBRARY_PLAN.md` (9 phases)
**Worktree:** `/home/miftah/.worktrees/mcp-notes/movies-library`, branch `feature/movies-library` (base `origin/main` @ `e09e602`)

---

## User Input

### Original User Request

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

### User-Provided Context

Owner's answers in the brainstorm (same session): `Videos/Done/docker_es/` is not a movie collection; the 15-minute + TMDB filter with a hidden unmatched list is OK; `Videos/Done` "usually means the movies/episodes that i've watched indeed. so you can utilize it as a done signal"; `Pak Bernard` "is part of my library, register the movies there"; TMDB credentials are in `.env.local`. The owner accepted the three risks (TMDB reachability, per-host play, VLC ini lag).

### User-Provided Files

None.

### Requirement IDs

| ID | What the user asked for (verbatim) |
|---|---|
| R1 | SCOPE - Library roots (this host, WSL): /mnt/c/Users/mahfu/Videos/ and /mnt/c/Users/mahfu/Downloads/Telegram Desktop/ (nested). Roots must be configurable/injectable (env), tests never touch the real dirs. - Track only video files (mkv, mp4, avi, m4v, webm). Junk filter: keep only files >= 15 minutes (ffprobe, /usr/bin/ffprobe exists) that match on TMDB; everything else goes to a hidden "unmatched" list the user can fix by hand. Videos/Done/docker_es/ is NOT a movie collection (WhatsApp/Snapinsta clips) and must end up excluded/unmatched. Videos/Pak Bernard/ IS part of the library and must be registered. - Filename shapes seen on disk: Pahe dots (How.to.Make.a.Killing.2026.1080p.WEB-DL.x265.6CH-Pahe.in.mkv), Pahe underscores (The_Rivals_of_Amziah_King_2026_1080p_BluRay_x265_DD+5_1_Pahe_in.mkv), "Title (Year)/Title.mkv" where the year is only in the folder (Pak Bernard), SxxEyy inside a season folder (Mobland S01 WEB-DL 1080p x265 6CH [Pahe.in]/MobLand.S01E01.Stick.or.Twist...mkv), absolute numbering (One Piece - 405 720p WEB-DL x264 2CH [Pahe.in].mkv), a folder holding two films (Nezha (2019)/Ne.Zha.2019... and Ne.Zha.2.2025...). |
| R2 | METADATA - TMDB API (key was added by the owner to .env.local; find the var name there, add it to config + README env table). Poster, release date, synopsis, production studios, crew (producer, writer, director), cast with real name + character name, per-season episode titles. Haiku only as fallback when a filename does not match confidently. Risk: TMDB may be blocked by Indonesian ISPs, test reachability from this machine first; OMDb is the fallback. Posters must be viewable from both machines (shared DB, not shared disk). |
| R3 | DATA MODEL - Three layers: title (movie or series, TMDB data, outlives its files), file (path, host, size, duration, season/episode, first_seen, deleted_at), play events (file, started/ended, position, duration). Studios and people are real rows so "Blumhouse films I saw this year" is a plain query. - Series collapse into one title/detail page with per-episode progress and per-episode deleted flag. - Sync detects new files and deleted files. A move (e.g. Telegram Desktop -> Videos/Done, matched by name+size) is NOT a delete. A move into Videos/Done is a "finished" signal (owner: usually, not always). - Deleted is not the same as watched; derive state from last position: deleted at >= 90% or manually flagged = finished; deleted partway = dropped; deleted at 0% = removed unwatched. Detail page shows a deleted flag. - User state: manual "watched" flag (covers the 95%-skipping-credits case), rating 0-5 stars, optional review. Review is a normal note linked to the title (search, revisions, /n for free) shown as one text field on the detail page; rating is a column. - Files and VLC are per-host: Play works only on the owning machine (available:false / not_on_this_machine pattern, same as photos). |
| R4 | PLAYBACK + PROGRESS (most important feature) - VLC is Windows-only: /mnt/c/Program Files/VideoLAN/VLC/vlc.exe (no WSL vlc). Detail page has an icon button Play/Resume. - Live layer: notesd launches vlc.exe (wslpath -w for the file) with --start-time=<sec> and VLC's HTTP interface on, polls position/length/state every few seconds, writes play events. We resume ourselves, no VLC prompt. Check how WSL reaches the Windows-side VLC HTTP port (NAT vs mirrored networking; curl.exe/powershell.exe as a way to stay on the Windows side). - Passive layer: on each sync read /mnt/c/Users/mahfu/AppData/Roaming/vlc/vlc-qt-interface.ini [RecentsMRL] (list= file:// URLs, times= ms positions, last 30, written only on VLC exit). Catches films opened from Explorer and backfills history on day one (The Dog Stars, Bad Apples, Runner are in there though the files are gone). - All paths (vlc.exe, ini, roots, ffprobe) injectable; tests use fakes. |
| R5 | UI - Movies page: poster grid gallery; click opens movie-detail-page (release date, synopsis, studios, producer/writer, cast with character names, play/resume button, watched flag, stars, review field, deleted flag; for series the episode list with progress). The all-encompassing pill query bar must be on the Movies page too. Owner taste: icon-only buttons, Phosphor icons, never the Claude-default look. Hidden "unmatched" list with manual fix. |
| R6 | MCP / /n - Tools so /n can answer: "which Mobland episode did I watch last and when" (survives deletion), "Blumhouse movies I have seen this year", "recommend other Margaret Qualley films" (TMDB filmography minus seen, plus web search), "continue Mobland" = movies_continue: resume the latest unfinished episode, else play the next episode whose file is present, else report which episode is missing vs present (a present-but-not-found file is a bug); "continue whatever I watched last night" = same tool with no title, newest play event. |
| R7 | ORDER 1. Scanner, filename parser, TMDB, grid + detail page (rating, review, watched flag, pill bar). 2. VLC play/resume, live tracking, ini backfill. 3. MCP tools + /n wiring. Initial iteration; more changes will follow, so keep it robust and extensible. Update CLAUDE.md, README and the verify-notesd features map. |

#### Acceptance Criteria

| ID | Pattern | Criterion |
|---|---|---|
| R1.1 | event | WHEN a sync pass finds a video file (mkv, mp4, avi, m4v, webm) of at least 15 minutes under a configured root that matches a TMDB title THE SYSTEM SHALL register the file under that title for this host |
| R1.2 | unwanted | IF a video file under a root is shorter than 15 minutes or matches no TMDB title THEN THE SYSTEM SHALL keep it out of the library and record it as unmatched with the reason |
| R1.3 | ubiquitous | THE SYSTEM SHALL parse title, year, season, episode and absolute episode number from each of the six filename shapes found on disk (Pahe dots, Pahe underscores, year only in the folder, SxxEyy in a season folder, absolute numbering, two films in one folder) |
| R1.4 | optional | WHERE `NOTESD_MOVIES_ROOTS` is set THE SYSTEM SHALL scan exactly those directories recursively and no others |
| R1.5 | event | WHEN the owner assigns a TMDB title to an unmatched file THE SYSTEM SHALL register the file under that title and remove it from the unmatched list |
| R2.1 | event | WHEN a title is matched for the first time THE SYSTEM SHALL store its poster path, release date, synopsis, production companies, directors, writers, producers and cast with character names, and for a series its episode titles per season |
| R2.2 | unwanted | IF the parsed name has no confident TMDB match THEN THE SYSTEM SHALL ask the Haiku fallback for a title and year, and leave the file unmatched when that also gives no confident match |
| R2.3 | unwanted | IF TMDB cannot be reached during a sync pass THEN THE SYSTEM SHALL finish the pass, leave the affected files pending and retry them on the next pass |
| R2.4 | ubiquitous | THE SYSTEM SHALL return each title's poster as a URL that loads on a machine that does not hold the title's files |
| R3.1 | event | WHEN a tracked file is gone from disk and no file with the same name and size appeared elsewhere under the roots THE SYSTEM SHALL mark the file deleted and keep its title and play events |
| R3.2 | event | WHEN a file with the same name and size as a missing tracked file appears at another path under the roots THE SYSTEM SHALL update the tracked file's path and not mark it deleted |
| R3.3 | event | WHEN a tracked file moves into, or is first found inside, a folder named in `NOTESD_MOVIES_DONE_DIRS` THE SYSTEM SHALL record a done signal that makes the file's state finished |
| R3.4 | ubiquitous | THE SYSTEM SHALL derive each file's state as finished (manual flag, done signal, or last position at least 90% of duration), in progress (present, partway), unwatched (present, never played), dropped (deleted partway) or removed unwatched (deleted, never played) |
| R3.5 | ubiquitous | THE SYSTEM SHALL keep every episode file of a series under one title, each with its own season, episode, progress and deleted flag |
| R3.6 | event | WHEN the owner sets the watched flag, a rating from 0 to 5 or a review on a title THE SYSTEM SHALL store the flag and rating on the title and the review as a note linked to the title |
| R3.7 | state | WHILE a file is recorded for another host THE SYSTEM SHALL report it with `available: false` and answer a play request with `not_on_this_machine` |
| R3.8 | ubiquitous | THE SYSTEM SHALL store production companies and people as rows joined to titles, so one query lists the titles of a company or person the owner has finished in a date range |
| R4.1 | event | WHEN the owner asks to play a file that is on this host THE SYSTEM SHALL start vlc.exe on it at the last recorded position (from the start when there is none or the file was finished) |
| R4.2 | state | WHILE a VLC that notesd started is playing THE SYSTEM SHALL record the position and duration into that play event every few seconds |
| R4.3 | event | WHEN a VLC that notesd started exits THE SYSTEM SHALL close the play event with the last position it read |
| R4.4 | event | WHEN a sync pass reads VLC's `[RecentsMRL]` list THE SYSTEM SHALL record each entry's position as a play observation for the matching file, creating a deleted file under its matched title for an entry whose file is gone |
| R4.5 | unwanted | IF vlc.exe, WSL interop or the Windows curl is missing on this host THEN THE SYSTEM SHALL answer a play request with `player_unavailable` and report playback as unavailable in the capabilities the page reads |
| R5.1 | event | WHEN the owner presses the Movies icon in the rail or opens `/movies` THE SYSTEM SHALL show the library as a grid of posters, one per title |
| R5.2 | event | WHEN the owner clicks a poster THE SYSTEM SHALL open `/movies/<title id>` showing release date, synopsis, studios, directors, writers, producers, cast with character names, the play or resume button, the watched flag, the star rating and the review field, and for a series the episode list with each episode's progress |
| R5.3 | state | WHILE a title's file is deleted THE SYSTEM SHALL show a deleted flag on that file or episode in the detail page |
| R5.4 | ubiquitous | THE SYSTEM SHALL show the pill query bar on the Movies page and send its question to the chat with the page (and open title) named on the first line |
| R5.5 | event | WHEN the owner opens the unmatched list from the Movies page THE SYSTEM SHALL list the unmatched files with their reason and let the owner assign a title to one |
| R6.1 | event | WHEN `movies_continue` is called with a title THE SYSTEM SHALL play the latest unfinished episode or film from its position, else the next episode whose file is present, else answer which next episode is missing and which later ones are present |
| R6.2 | event | WHEN `movies_continue` is called without a title THE SYSTEM SHALL continue the title of the newest play event |
| R6.3 | ubiquitous | THE SYSTEM SHALL expose MCP tools that list titles by text, company, person, state and finished date range, and return one title with its episodes, files and play events, including deleted files |
| R6.4 | event | WHEN `movies_person` is called with a person's name THE SYSTEM SHALL return that person's TMDB filmography with each entry marked seen or not seen by the owner |
| R6.5 | ubiquitous | THE SYSTEM SHALL make the movie tools callable from the wall's chat bar and describe them in the `/n` skill and the MCP instructions |
| R7.1 | ubiquitous | THE SYSTEM SHALL document the Movies subsystem in `CLAUDE.md`, the README (env table, HTTP API, MCP tools) and a `movies.md` entry in the verify-notesd feature map |

---

## Detailed Requirements Understanding

**Problem/Requirement Statement**: notesd has no notion of video files. The owner browses films in Windows Explorer and loses all history when a file is deleted. Add a subsystem that mirrors two Windows folders into Postgres as titles, files and play events, enriches titles from TMDB, plays files in the Windows VLC from WSL while tracking position, and exposes it all on the wall (`/movies`), over HTTP and over MCP.

**Success Criteria**: the 33 acceptance criteria above. In the owner's terms: a poster grid of the real library; a detail page with studio, crew and cast; Play/Resume that opens VLC at the right second; history that survives deleting the file; "continue Mobland" from `/n`.

**Key Considerations**:

- `/mnt/c` is drvfs (9p). inotify does not fire for changes made from Windows, so sync is a polling pass, not a watcher (unlike `images/inbox.ts`).
- The daemon runs as a systemd user unit with a minimal PATH; Windows binaries must be reached by absolute path (the reveal route already does this for `explorer.exe`).
- Two hosts share the database. Files, plays and the VLC ini are per host; titles, credits, rating and review are shared.
- The owner deletes files routinely. A title must never be deleted because its files are gone.
- `Videos/Done` holds both finished films and a junk folder (`docker_es`); the junk filter, not the folder name, decides library membership.

**Assumptions** (inferences, each recorded as a decision in the plan index):

- Posters are hotlinked from `image.tmdb.org` using the stored `poster_path`; nothing is cached on disk. Verified reachable from this machine.
- OMDb is not built: TMDB answered from this machine with both credentials.
- VLC `[RecentsMRL]` `times` values of 0 or -1 mean "opened, no resume point". They are recorded as an observation without a position.
- A title id is `movie-<tmdb id>` or `tv-<tmdb id>`: derived from TMDB, never invented.

---

## Analysis Scope

### Explicitly Mentioned Files

None (paths on the Windows side are data, not code).

### Discovered Related Files

- `src/deps.ts` — `AppDeps`; optional subsystems are nullable fields (`adversary`).
- `src/daemon.ts`, `src/main.ts` — build `AppDeps`.
- `src/background.ts` — starts and stops every background worker.
- `src/config.ts` — `Config`, per-subsystem `parseX(env)` + `DEFAULT_X_CONFIG`, `parseSwitch`, `parsePositiveInt`, `expandHome`.
- `src/http/app.ts` — mounts routers; its header says "later phases fill the routers, never this file".
- `src/http/adversaryApi.ts` — the model for a subsystem router (zod validation, `sameOriginOnly` for writes).
- `src/http/reveal.ts` — WSL detection (`detectRevealEnv`, `WSL_INTEROP_FILES`), `findOnPath`, `runWslpath`, detached `spawn` of a Windows binary, injectable `RevealDeps`; `/api/capabilities`.
- `src/http/sameOrigin.ts` — `sameOriginOnly`.
- `src/images/ingest.ts`, `src/http/images.ts` — the `available` / `not_on_this_machine` host pattern.
- `src/notes/service.ts` — `create`, `update`, `linkSession`; the only writer of notes. `src/notes/sessionLinks.ts` and `note_session_links` are the model for linking a note to another entity.
- `src/notes/events.ts`, `src/sessions/events.ts` — event emitters behind SSE.
- `src/db/schema.ts` (981 lines), `drizzle/0016_session_context.sql` (latest), `drizzle/meta`.
- `src/mcp/server.ts`, `src/mcp/tools.ts` (`run`, `ToolDeps`), `src/mcp/adversaryTools.ts`, `src/mcp/instructions.ts`.
- `src/chat/status.ts` — `*_TOOL_NAMES` and `allowedChatTools()`; `src/chat/prompt.ts` — the chat bar's system prompt listing subsystems.
- `src/sessions/summarize.ts` — the Agent SDK Haiku call pattern.
- `web/src/types.ts` (`View`), `web/src/lib/route.ts`, `web/src/App.tsx` (1026 lines), `web/src/components/Rail.tsx`, `Sidebar.tsx`, `Header.tsx`, `web/src/pages/AdversaryPage.tsx`, `web/src/components/adversary/AdversaryPill.tsx`, `web/src/hooks/useAdversary.ts`, `web/src/adversaryApi.ts`, `web/src/lib/adversary.ts` (`adversaryChatMessage`), `web/src/hooks/useCapabilities.ts`.
- `claude/skills/n/SKILL.md` — the `/n` skill.
- `.claude/skills/verify-notesd/` — `SKILL.md`, `scripts/`, `features/*.md`.
- `scripts/test-int.sh`, `tests/integration/setup.ts`, `tests/unit/**`.
- `scripts/install.sh` — writes the systemd unit.
- `README.md`, `CLAUDE.md`.

---

## Current Dataflow

There is no movie code. The flows a new subsystem plugs into:

### Entry Point: daemon start

**Location:** `src/main.ts` → `src/daemon.ts` builds `AppDeps` → `createApp(deps)` (`src/http/app.ts:96`) and `startBackground(deps)` (`src/background.ts:44`).
**Next Step:** each router is mounted with `app.route('/', xRoutes(deps))`; each worker is started in `startBackground` and closed in the returned stop function inside one `Promise.all`.

### Processing Chain (the adversary subsystem, the closest model)

1. `parseAdversary(env)` in `src/config.ts:317` → `Config.adversary`.
2. `src/daemon.ts` builds `AdversaryService | null` into `deps.adversary`.
3. `startBackground` calls `deps.adversary.start()` and logs one line; stop calls `close()`.
4. `adversaryApiRoutes(deps, options)` (`src/http/adversaryApi.ts:42`): GET reads, same-origin POST writes, zod-validated.
5. `registerAdversaryTools(server, deps)` (`src/mcp/adversaryTools.ts:44`), names from `ADVERSARY_TOOL_NAMES` in `src/chat/status.ts:54`, which `allowedChatTools()` spreads into the chat bar's allow-list.
6. Web: `View` gains a member (`web/src/types.ts:86`), `lib/route.ts` gains a path + route parser + `hrefForView` branch, `App.tsx` gains state, toggle, popstate branch, heading and page render; `Rail.tsx` and `Sidebar.tsx` gain an icon button; the page pins a `ChatBar variant="page"` (`AdversaryPill`) whose text goes through the wall chat with a context line (`adversaryChatMessage`).

### Launching a Windows program from the daemon

`src/http/reveal.ts`: `detectRevealEnv(probe)` requires linux + a WSL interop binfmt entry + `wslpath` on PATH + a resolvable `explorer.exe` (env override `NOTESD_EXPLORER_BIN`, PATH, then `/mnt/c/Windows/explorer.exe`). `runWslpath` converts paths with a 5 s timeout. `spawn` starts the process detached and resolves once spawned. All three are behind `RevealDeps`, which tests replace.

### Data Persistence

Postgres through Drizzle (`src/db/schema.ts`), one SQL migration per change in `drizzle/` (next number: `0017`). Each subsystem has one writer module (`SessionsRepo`, `reviewsRepo.ts`, `NotesService`).

### Exit Points

HTTP JSON under `/api/*`, SSE (`/api/events`, per-subsystem streams), MCP tool results through `run()` in `src/mcp/tools.ts`.

---

## Measured facts about this machine (2026-11-14)

| Fact | Evidence |
|---|---|
| 95 mkv/mp4 files under the two roots | `find` over both roots |
| `Videos/Done/docker_es/` holds ~28 short mp4 clips (0.2–130 MB) | listing |
| VLC is at `/mnt/c/Program Files/VideoLAN/VLC/vlc.exe`; no `vlc` or `mpv` in WSL; `/usr/bin/ffprobe` exists | `ls`, `which` |
| `ffprobe -show_entries format=duration` on `Oldboy.mkv` over drvfs prints `7198.75` | run |
| WSL networking is NAT (no `networkingMode` in `.wslconfig`; gateway `172.25.224.1`) | `.wslconfig`, `ip route` |
| VLC HTTP bound to `127.0.0.1` on Windows is not reachable from WSL (`curl` to the gateway: no connection) | probe |
| `/mnt/c/Windows/system32/curl.exe -u :pw http://127.0.0.1:<port>/requests/status.json` works from WSL in ~70 ms and returns `time`, `length`, `state`, `position`, `information.category.meta.filename` | probe |
| `?command=seek&val=1200` moved a running VLC to 1200 s of 7198 s | probe |
| After VLC exits, `curl.exe` exits 7 (connection refused) | probe |
| Headless `-I http --no-video --no-audio` did not autoplay reliably (state `stopped` until a command) | probe; the real launch uses the normal Qt window with `--extraintf http` and must confirm `state: playing` itself |
| `vlc-qt-interface.ini` `[RecentsMRL]` has `list=` (comma-separated percent-encoded `file:///C:/...` URLs) and `times=` (ms; 0 and -1 occur); entries for already-deleted files are present | file read |
| The owner's own VLC may be running; a notesd launch must not reuse or kill it (`--no-one-instance`, track by our own port) | `tasklist` showed a second vlc.exe |
| TMDB: `api.themoviedb.org` and `image.tmdb.org` reachable; `.env.local` has `TMDB_API_READ_ACCESS_TOKEN` (v4 bearer) and `TMDB_API_KEY` (v3); both returned results for "How to Make a Killing" (movie 467905) and "MobLand" (tv 247718) | `curl` |

---

## Key Data Structures

None exist for movies. Models to mirror: `noteSessionLinks` (`src/db/schema.ts:806`), `adversaryReviews` (`:921`), `appSettings` (`:882`).

---

## Dependencies

### Configuration / Environment

Existing: `.env.local` is loaded by `loadConfig` (`src/config.ts:362`). New variables are listed in the plan index's Shared contract.

### External Services

- TMDB v3 API (`/search/movie`, `/search/tv`, `/movie/{id}?append_to_response=credits`, `/tv/{id}?append_to_response=aggregate_credits`, `/tv/{id}/season/{n}`, `/search/person`, `/person/{id}/combined_credits`), images at `https://image.tmdb.org/t/p/<size><path>`.
- Claude Agent SDK (Haiku) for the name fallback, as in `src/sessions/summarize.ts`.
- Windows side: `vlc.exe`, `curl.exe`, `wslpath`.

---

## Impact Points (files that WILL need changes)

1. `drizzle/0017_movies.sql`, `drizzle/meta/*`, `src/db/schema.ts` — tables (phase 1)
2. `src/config.ts`, `src/deps.ts`, `src/daemon.ts` — `MoviesConfig`, `deps.movies` (phase 1; service built in phase 3)
3. `src/http/app.ts` — mount two movie routers (phase 1, as empty seams)
4. `src/movies/*` (new) — types, repo, state (1); parse, tmdb, match, fallback (2); scan, sync, service (3); read (4); vlc/*, player, continue (5)
5. `src/background.ts` — start/stop the movies service (phase 3)
6. `src/http/moviesApi.ts` (4), `src/http/moviesPlayApi.ts` (5), `src/http/reveal.ts` capabilities (5)
7. `src/notes/service.ts` or a new `src/movies/reviewNote.ts` — review note through `NotesService` (phase 4)
8. `web/src/types.ts`, `lib/route.ts`, `App.tsx`, `components/Rail.tsx`, `Sidebar.tsx`, `Header.tsx`, new `pages/MoviesPage.tsx`, `components/movies/*`, `moviesApi.ts`, `hooks/useMovies.ts`, `lib/movies.ts`, `styles.css` (phase 6)
9. `src/mcp/movieTools.ts` (new), `src/mcp/server.ts`, `src/mcp/tools.ts` (`ToolDeps`), `src/http/app.ts` `mcpToolDeps`, `src/mcp/instructions.ts`, `src/chat/status.ts`, `src/chat/prompt.ts`, `claude/skills/n/SKILL.md` (phase 7)
10. `README.md`, `CLAUDE.md`, `.claude/skills/verify-notesd/features/movies.md` + `README.md` there, `.claude/skills/verify-notesd/scripts/*` (movie fixtures), `.env.local` of the live checkout (phase 8)

**This document describes. The plan files prescribe.**

---

## Addendum (2026-11-14 13:08): R8, added by the owner after a crash during planning

**Verbatim:** the WSL terminal crashed again. i am pretty sure this is caused by windows's VLC that i paused for several minutes. i am fairly sure that windows VLC has memory leak problem. if i pause a movie for too long, it will crash. and it made WSL terminal crash as well. maybe we need to prepare to track this memory leak / VLC hang on WSL terminal. because after we ship this, i will use WSL's vlc from now on.

**Measured after the crash:** the Windows Application log has three Application Error (id 1000) events between 13:03:45 and 13:04:53: `Explorer.EXE` (module `Windows.UI.Xaml.dll`, 0xc000027b), `WindowsTerminal.exe` (module `igd10umt64xe.DLL`, the Intel graphics driver, 0xc0000005), `WindowsTerminal.exe` (`ucrtbase.dll`, 0xc0000409). No `vlc.exe` fault and no resource-exhaustion event. The WSL VM restarted. The leak is one hypothesis and a graphics-driver fault is another; no existing code records either.

**Criteria R8.1-R8.5** and their owner (phase 9) are in the plan index. Impact points: `src/movies/vlc/health.ts`, `src/movies/vlc/incidents.ts` (new), `src/movies/player.ts`, `src/movies/vlc/launch.ts`, `src/http/moviesPlayApi.ts`, `src/config.ts`, `src/deps.ts`, `src/daemon.ts`, `README.md`.
