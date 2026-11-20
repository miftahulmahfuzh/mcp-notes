# Code Analysis: Stream downloads and the season story

**Type:** Feature Implementation
**Date:** 2026-11-20 21:33
**Session ID:** 20261120-213359-K7Q2 (Claude Code session node SV-BD)
**Plan:** `.workflows/plan/STREAM_DOWNLOADS_SEASON_STORY_PLAN.md` (9 phases)
**Worktree:** `/home/miftah/.worktrees/mcp-notes/stream-downloads-season-story`, branch `feature/stream-downloads-season-story` (base `origin/main` @ `72283db`)

---

## User Input

### Original User Request

The request came in two messages. The first, verbatim:

> i want to discuss something with you:
> considering these things:
> 1. we can already support forward-caching for Torrent and Non Torrent movies/series
> 2. we already have Cache page
>
> ---
>
> i am just thinking , why not add an icon button Download as well? add it to title page.
> from my experince using Stream subsystem, Torrent always gives higher image quality (if it is a 1080p magnet) compared to Non Torrent sources.
> i am thinking, by default, clicking download will download the 1080p magnet version, but if it is not available, then download (or cache, if you prefer to call it that way) from NT cloud sources. you know what, just add a small dropdown "Choose how to download <movie/series name>" , so user can manually select NT source if he wanted to.
>
> - for Series, we also need to add the download button in Season row (which will start downloading the whole season) , and episode row (which will only download that episode) .
>
> - i hope we can show somekind of live progress bar of the download as well . title page can see this. also:
> - i think we need to improve Cache page: add "Downloading" filter :
> by default (cache-default-view), we show all files that are being downloaded together with the downloaded files in the cache list. but we can click this Downloading filter and the list will only show the files that are currently being downloaded only (cache-downloading-view).
> - show live download progress bar in the files in Cache page (both in cache-default-view and cache-downloading-view)
>
> ---
>
> unrelated thing:
> 1. we need to add "Narrate the full story of SXX" on the Season row in title page. btw, Inferring the story from the subtitle is a fucking bad idea. i tested it some days ago. is there any other alternatives? can't you find some website that always talk full stories / full spoilers of the Series?
>
> ---
>
> study the codebase. tell me what you think about this idea

The second, after the assistant's proposal, verbatim:

> let's do as you say. /analyze it

### User-Provided Context

"As you say" is the assistant's proposal in the same session, which the owner accepted whole. Its points, as they were put to the owner:

**Download button**
- A persisted download job for torrents: the fetch-ahead holds one torrent in memory, gives up after 3 hours and is lost on a daemon restart. A season needs a queue that survives restarts, so a small table with its own single writer.
- Protection from the prune: torrents are deleted after 7 days unplayed and the folder is kept under 40 GB. A download needs a "kept by the owner" mark the prune skips.
- Finish the job at download time: remux, subtitle search and seek previews, so the title plays with the internet down.
- Season packs: for a season, one pack over N torrents, with a row per episode.
- Progress: one `GET /api/stream/downloads` polled every 2–3 s while something downloads and the page is visible; it feeds the title page, the season and episode rows, and the Cache page.
- Order: 1080p torrent with live seeds, then cloud at 1080p or lower, then a lower torrent. The audio-language check runs before gigabytes are committed.
- Button: an icon that downloads the default, with a caret for "Choose how to download": best torrent, cloud, or pick a torrent (the existing candidates list with a download action).
- Play comes first: downloads pause while a torrent plays on screen.
- Same store: the Cache store, not the DM/DS library. The UI says "Download".
- Cache page: the "Downloading" filter and progress bars, and each row labelled with why it downloads (asked, ahead, pause).
- Office network (SSID `Employee`): the assistant recommended that a download there goes straight to cloud and WARP is never switched for a download. The owner answered "let's do as you say".

**Season story**
- Not from subtitles. Claude with WebSearch, as the genre guide does, written once and kept by `MoviesRepo`.
- Sources in order: Wikipedia (season articles, "List of … episodes"), Fandom wikis, recap sites (Dramabeans, Vulture, AV Club, Den of Geek).
- Per-episode sections, sources shown as links in the modal, an episode with no source found is said so, never invented.
- The per-episode book icon becomes web-first; the subtitle stays only as a fallback for episodes too new or obscure to have a recap.

### User-Provided Files

None marked with `@`.

### Requirement IDs

| ID | What the user asked for (verbatim) |
|---|---|
| R1 | i am just thinking , why not add an icon button Download as well? add it to title page. from my experince using Stream subsystem, Torrent always gives higher image quality (if it is a 1080p magnet) compared to Non Torrent sources. i am thinking, by default, clicking download will download the 1080p magnet version, but if it is not available, then download (or cache, if you prefer to call it that way) from NT cloud sources. you know what, just add a small dropdown "Choose how to download <movie/series name>" , so user can manually select NT source if he wanted to. |
| R2 | for Series, we also need to add the download button in Season row (which will start downloading the whole season) , and episode row (which will only download that episode) . |
| R3 | i hope we can show somekind of live progress bar of the download as well . title page can see this. |
| R4 | i think we need to improve Cache page: add "Downloading" filter : by default (cache-default-view), we show all files that are being downloaded together with the downloaded files in the cache list. but we can click this Downloading filter and the list will only show the files that are currently being downloaded only (cache-downloading-view). |
| R5 | show live download progress bar in the files in Cache page (both in cache-default-view and cache-downloading-view) |
| R6 | we need to add "Narrate the full story of SXX" on the Season row in title page. btw, Inferring the story from the subtitle is a fucking bad idea. i tested it some days ago. is there any other alternatives? can't you find some website that always talk full stories / full spoilers of the Series? |

#### Acceptance Criteria

| ID | Pattern | Criterion |
|---|---|---|
| R1.1 | event | WHEN the owner clicks the Download button of a film on its Stream-side title page THE SYSTEM SHALL queue a download of that film to this machine's stream store through `POST /api/stream/downloads` and answer at once |
| R1.2 | event | WHEN a download with no source named is planned THE SYSTEM SHALL try a 1080p torrent with live seeds first, then a cloud source at 1080p or lower, then a torrent below 1080p |
| R1.3 | event | WHEN the owner opens the Download button's caret THE SYSTEM SHALL show a menu titled "Choose how to download <name>" offering best torrent, cloud and pick a torrent, and SHALL download only from the one chosen |
| R1.4 | state | WHILE this machine is on SSID `Employee` THE SYSTEM SHALL send a download with no source named straight to cloud and SHALL NOT switch WARP for any download |
| R1.5 | unwanted | IF a torrent candidate's audio is not in the title's original language THEN THE SYSTEM SHALL leave it undownloaded and go on to the next candidate |
| R1.6 | ubiquitous | THE SYSTEM SHALL keep a download the owner asked for through the age prune and the budget prune until the owner deletes it |
| R1.7 | event | WHEN the daemon starts with downloads queued or running in `stream_downloads` THE SYSTEM SHALL carry them on from what is on disk |
| R1.8 | event | WHEN a torrent download finishes THE SYSTEM SHALL hold on this machine its remux (for a file Chrome cannot play as is), an English subtitle when one was found, and its seek previews, so a later play of it asks no index and joins no swarm |
| R1.9 | state | WHILE a torrent plays on screen THE SYSTEM SHALL pause torrent downloads, and SHALL resume them when that play ends |
| R1.10 | event | WHEN `direct_stream_cache` is called with `action: "start"` and a torrent asked for THE SYSTEM SHALL queue the same download the button queues |
| R1.11 | unwanted | IF no torrent and no cloud source of a title can be downloaded THEN THE SYSTEM SHALL mark the download failed with a reason that `GET /api/stream/downloads` returns |
| R2.1 | event | WHEN the owner clicks the Download button of a season row THE SYSTEM SHALL queue every aired episode of that season that is not whole on this machine |
| R2.2 | event | WHEN the owner clicks the Download button of an episode row THE SYSTEM SHALL queue that episode only |
| R2.3 | optional | WHERE a season pack with live seeds holds the season THE SYSTEM SHALL download the season from that one torrent and record one `stream_torrents` row per episode |
| R2.4 | unwanted | IF an episode of the season has not aired THEN THE SYSTEM SHALL leave it out of the season's download |
| R3.1 | state | WHILE a download of the title is queued or running and the page is visible THE SYSTEM SHALL show a progress bar on the title page, on the season row and on the episode row it belongs to, read again at most 3 s apart |
| R3.2 | event | WHEN `GET /api/stream/downloads` is asked THE SYSTEM SHALL answer every queued, running and failed download of this machine with its title, season, episode, state, source kind, progress from 0 to 1, bytes and error |
| R3.3 | state | WHILE nothing downloads THE SYSTEM SHALL NOT ask `GET /api/stream/downloads` more often than the page's normal refresh |
| R4.1 | ubiquitous | THE SYSTEM SHALL list on the Cache page's default view what is being downloaded together with what is downloaded |
| R4.2 | event | WHEN the owner clicks the Downloading filter THE SYSTEM SHALL list only the titles, seasons and episodes being downloaded now, and SHALL return to the default view when it is clicked again |
| R4.3 | ubiquitous | THE SYSTEM SHALL label each downloading row of the Cache page with why it downloads: asked, ahead or pause |
| R5.1 | state | WHILE a row of the Cache page downloads THE SYSTEM SHALL show a live progress bar on it in the default view and in the Downloading view |
| R6.1 | event | WHEN the owner clicks the story button of a season row THE SYSTEM SHALL open a pop-up with that season's full story, one section per episode |
| R6.2 | ubiquitous | THE SYSTEM SHALL write a season's story from web sources found with WebSearch and SHALL NOT read a subtitle for it |
| R6.3 | ubiquitous | THE SYSTEM SHALL show the web sources a story was written from as links in the pop-up |
| R6.4 | unwanted | IF no web source tells an episode's story THEN THE SYSTEM SHALL say so in that episode's section and SHALL NOT invent one |
| R6.5 | event | WHEN a stored story is asked for again THE SYSTEM SHALL answer it from the store without calling a model |
| R6.6 | event | WHEN an episode's book icon is clicked and no story is stored THE SYSTEM SHALL write it from web sources, and from the episode's subtitle only when the web has none |

---

## Detailed Requirements Understanding

**Problem/Requirement Statement**

Two unrelated capabilities.

A. The Stream side can already put a film or episode on disk in three ways, none of which the owner starts from the wall: `direct_stream_cache` (Claude Code only, cloud only), a pause in the player (cloud, `auto`), and the fetch-ahead of the next episode (cloud or torrent, in memory). The owner wants a deliberate, visible download: a button on the title page, the season row and the episode row; torrent first for picture quality; progress shown live; the Cache page able to show only what is downloading.

B. The only story on the wall is per episode and written from the episode's subtitle, which carries no speaker and no silent action. The owner wants a season-level story and a better source than subtitles.

**Success Criteria**

The 28 criteria above. In short: a click queues a download that survives a restart, prefers a 1080p torrent, is never pruned behind the owner's back, and ends as a title that plays with the network down; its progress is visible on the title page and the Cache page; a season's story opens from the season row, is written from the web with its sources named, and the episode story follows the same route first.

**Key Considerations**

- **Three things already download; a fourth must not collide.** The cloud cache runs one job at a time (`CACHE_JOBS = 1`) with its own queue; a fetch-ahead "gives way to any other". The torrent side has no queue at all: `EpisodeAhead.held` is one torrent in memory.
- **A torrent's retention is by play, not by intent.** `pruneNow` deletes a torrent none of whose episodes was played, finished or made within `keepDays` (7); `keepBudget` deletes whole torrents over `budgetBytes` (40 GiB), dismissed titles first, then never-played, then least recently played. Nothing marks a torrent as the owner's. The cloud cache has that mark (`stream_caches.auto`, false = the owner's).
- **`fetchAhead` deliberately stops the work a download needs.** It calls `resolve`, then aborts the torrent's `stop` controller (the subtitle tiers, the sync) and releases the remux. A download for offline play needs the opposite.
- **A season pack is recorded under one episode by the fetch-ahead**, though `stream_torrents` is keyed by (host, info hash, season, episode) and `TorrentStreams.takeSlot` gives another episode of a pack in the swarm its own row.
- **The rules that bound the design** (CLAUDE.md, "What must never change"): nothing starts unasked (a click is the ask; a season click asks for every aired episode); a torrent is in the swarm only while something uses it (a download job is a use, and lets go when the file is whole); only video and subtitle files are selected; original language only; WARP is switched only by the owner, a streaming site's one retry and a torrent *play* that found no peer on `Employee`; single writers (`TorrentsRepo` for `stream_torrents`, `MoviesRepo` for `movie_*`, `DirectStreamRepo` for `stream_caches`); 1080p is the preferred height (`PREFERRED_TORRENT_HEIGHT`); every path, binary, fetch and clock injected in tests; `titleSearchExclusion` never loosened.
- **Rows record their host.** A download row of the other machine must read `available: false`.
- **Stories have no home without a dialogue.** `MoviesRepo.saveStory` updates a `movie_dialogues` row and answers false when there is none; `MovieStories.get` reads the story off the dialogue row. A story written from the web, and any season story, has no dialogue row to sit on.
- **The genre guide is the precedent for a web-written text**: Agent SDK, `tools: ['WebSearch']`, `GUIDE_MAX_TURNS = 16`, 240 s, the owner's login, kept in `movie_genre_guides` by `MoviesRepo.saveGenreGuide`, `NOTESD_MOVIES_STORY_MODEL`.
- **Docs are checked against the code.** A new route goes in `scripts/docs/httpRoutes.ts` and `npm run docs:gen` in the same change; a new env var gets a configuration row; a changed MCP tool regenerates `mcp-tools.md`.

**Assumptions**

- "Download" and "cache" are one store. Nothing is written to the library roots, and DM/DS never plays a download.
- "1080p magnet … not available" means: no 1080p candidate with live seeds (the trackers' scrape, as the candidates list reads it), or none that passes the audio check or delivers.
- A download asked for by hand is kept until deleted on the Cache page (`stream_disk`), where the existing trash and undo already work on torrents and caches.
- A season's download covers aired episodes of that season only, specials (season 0) included when that row is clicked.
- The season story covers that season only.
- Existing stories written from dialogue stay readable.

---

## Analysis Scope

### Explicitly Mentioned Files

None. The agreed proposal named: `src/directStream/cache/*`, `ahead.ts`, `cacheShelf.ts`, `torrent/service.ts`, `src/movies/story.ts`, `guides.ts`, `web/src/components/movies/{CachePage,EpisodeList,MovieDetail,PlayMenu,TorrentsModal,StoryModal}.tsx`, `docs/guide/streaming.md`, `docs/guide/movies.md`.

### Discovered Related Files

- `src/directStream/torrent/source.ts` (1572 lines): `TorrentSource.resolve`, `fetchAhead`, `releaseAhead`, `onDisk`, `listCandidates`, `hearAudio`, `PREFERRED_TORRENT_HEIGHT`.
- `src/directStream/torrent/repo.ts`: `TorrentsRepo`, the only writer of `stream_torrents`.
- `src/directStream/service.ts` (2526 lines): `MovieStreams`, `buildAhead` (line 530), `watched`, session and torrent wiring, `audioLang`, `imdbIdOf`, `neighborsOf`.
- `src/directStream/repo.ts`: `DirectStreamRepo`, writer of `stream_caches`.
- `src/directStream/torrentWarp.ts`, `src/streaming/warp.ts` (`OFFICE_SSID = 'Employee'`, `WarpState.ssid`).
- `src/directStream/previews/*`: the seek-preview builder, which already makes sheets for whole videos on disk 30 s after start and every half hour (`TorrentStreams.wholeVideos`).
- `src/directStream/torrent/remux.ts`, `remuxOnly.ts`, `subtitles/*`: what a play prepares.
- `src/http/streamCacheApi.ts`, `streamDiskApi.ts`, `streamTorrentCandidatesApi.ts`, `moviesApi.ts` (story routes, line 538), `moviesGuideApi.ts`.
- `src/mcp/streamCacheTools.ts` (`direct_stream_cache`), `streamDiskTool.ts`.
- `src/db/schema.ts`: `streamTorrents` (1709), `streamCaches` (1628), `movieDialogues` (1173), `movieGenreGuides` (1464); `drizzle/` last migration `0042_torrent_marks.sql`.
- `src/db/sharedImport.ts`: `SHARED_IMPORT_TABLES`.
- `src/movies/repo.ts`: `dialogue`, `saveDialogue`, `saveStory` (1192), `genreGuide`, `saveGenreGuide`.
- `web/src/moviesApi.ts` (`fetchStreamDisk`, `writeStory`, disk types), `web/src/lib/movies.ts`.
- `scripts/docs/httpRoutes.ts`, `docs/guide/reference/*`, `.claude/skills/verify-notesd/features/{movies,direct-streaming}.md`, `scripts/docs/shots/*.mjs`.
- `src/mcp/instructions.ts`, `src/chat/prompt.ts`, `claude/skills/direct-stream`, `claude/skills/n`.

---

## Current Dataflow

### A1. Cloud cache (the owner's, `direct_stream_cache`)

**Entry:** `POST /api/stream/cache` (`src/http/streamCacheApi.ts`) or the `direct_stream_cache` tool (`src/mcp/streamCacheTools.ts`), body `{kind, tmdb_id, season?, episode?, max_height?}`.

1. `StreamCache.request(ref, {maxHeight, auto?, ahead?, gentle?})` (`cache/service.ts:191`): `repo.createCache(host, ref, maxHeight, now, auto)` makes or finds the one row per title slot and host; a row that was `auto` and is now asked for by the owner becomes the owner's.
2. `enqueue` puts it on the in-memory queue; `CACHE_JOBS = 1` job runs (`CacheJob`, `cache/job.ts`): resolve out of sight, plan one rendition (`cache/plan.ts`), fetch four files at a time (one when `gentle`), six tries each, re-resolve on 401/403/410.
3. Progress is `segments_done / segments_total` on the row, `progress` on `StreamCacheView`, with `running` and `queued`.
4. `StreamCache.start()` at daemon start carries unfinished downloads on.
5. `prune` clears `auto` caches three days after the last write; the owner's stay.

**Exit:** files under `<NOTESD_STREAM_CACHE_DIR>/<id>/`; `GET /api/stream/cache`, `/:id`, `/:id/map`, `/:id/f/:name`.

### A2. Fetch-ahead (the next episode)

**Entry:** a position report of the player page → `MovieStreams.watched(id, report)` (`service.ts:576`) → `EpisodeAhead.watched`.

1. Half watched and playing → `decide`.
2. Torrent play: waits until its own file is whole (`onDisk`), then `torrents.fetch(next)` → `TorrentSource.fetchAhead` → `resolve` (indexes asked, torrents raced, picked file probed, audio checked) → the subtitle chain and sync aborted, the remux released → the torrent stays in the swarm, `held`, polled every 30 s, let go when ready or after 3 h.
3. Cloud play: `caches.ahead(next, {gentle})` → `StreamCache.request(..., {auto: true, ahead: true})`.
4. A daemon restart forgets the held torrent.

### A3. Torrent retention

`TorrentStreams.tick` (`torrent/service.ts:630`) records progress, settles finished downloads, lets idle torrents leave the swarm and now and then runs `pruneNow` (754): by age (`keepDays`), orphan folders, originals beside a whole remux, then `keepBudget` (805). `held(hash)` (in the swarm or being opened) is the only exemption. `diskUsage()` (563) feeds the Cache page.

### A4. The Cache page

**Entry:** `GET /api/stream/disk` (`streamDiskApi.ts`) → `CacheShelf` (`cacheShelf.ts:237`) builds `ShelfView`: totals, `budget_bytes`, `bulk`, and `titles` → `seasons` → `episodes`, each with `kinds` (`torrent`, `cloud`), sizes, `watched`, `playing`, `in_use`. `ShelfTorrents` and `ShelfCaches` (154, 161) are its two sources; `liveSlots` (23) says what plays or is held. `web/.../CachePage.tsx` reads it every 15 s while visible (`REFRESH_MS`), unfolds titles and seasons, deletes through `POST /api/stream/disk/delete` with a 10 s undo. No row carries a progress figure or the reason it downloads.

### A5. The title page (Stream side)

`MovieDetail.tsx` renders the head buttons (play at 305, `PlayMenu` at 308, watched, interested, not interested), `EpisodeList` (season heads with fold, trailer and season-watched buttons at 121–126; `EpisodeItem` with the book icon at 208–217 and the play button), and opens `StoryModal` (413) and `TorrentsModal`. `PlayMenu` names a source by hand; `TorrentsModal` lists `GET` torrent candidates and plays one by its info hash as `magnet`.

### B1. The episode story

**Entry:** `POST /api/movies/:id/story` `{season?, episode?}` (`moviesApi.ts:559`) → `MovieStories.write` (`story.ts:226`).

1. The stored story (on the `movie_dialogues` row) is answered with `cached: true`.
2. Else `dialoguePage` reads the stored dialogue, or resolves a stream source out of sight and reads its English subtitle (`directStream/dialogue.ts`), stored by `MoviesRepo.saveDialogue`.
3. `StoryWriter.write(storyInput(...))`: one Agent SDK call, no tools, `STORY_SYSTEM_PROMPT`, 240 s.
4. `MoviesRepo.saveStory` writes `story`, `story_model`, `story_at` on the dialogue row.

**Exit:** `{story: {season, episode, text, model, written_at, provider, cues}, cached}`; errors `story_off`, `no_dialogue`, `no_source`, `no_subtitle`, `resolve_failed`, `story_failed`. `EpisodeView.has_story` fills the book icon.

### B2. The genre guide (the web-written precedent)

`POST /api/movies/:id/genre/...` (`moviesGuideApi.ts:158`) → `GenreGuides.write` (`guides.ts:408`) → `createGuideWriter` (292): Agent SDK with `tools: ['WebSearch']`, `allowedTools: ['WebSearch']`, `GUIDE_MAX_TURNS`, JSON answer parsed by `parseGuide`, titles resolved on TMDB, kept by `saveGenreGuide`.

---

## Key Data Structures

- **`stream_torrents`** (`schema.ts:1709`): PK (host, info_hash, season, episode); `file_index`, `files`, `file_length`, `bytes_done`, `state` (downloading, ready, failed), `played_at`, `completed_at`. No owner mark.
- **`stream_caches`** (`schema.ts:1628`): one per (kind, tmdb_id, season, episode, host); `max_height`, `state`, `segments_total`, `segments_done`, `auto`.
- **`movie_dialogues`** (`schema.ts:1173`): PK (title_id, season, episode); `body`, `provider`, `cues` NOT NULL; `story`, `story_model`, `story_at`.
- **`movie_genre_guides`** (`schema.ts:1464`): PK (title_id, genre); `description`, `items` jsonb, `model`, `written_at`.
- **`StreamRef`** (`directStream/types.ts`): `{kind: 'movie', tmdbId}` or `{kind: 'tv', tmdbId, season, episode}`.
- **`ShelfTitle` / `ShelfSeason` / `ShelfEpisode`** (`cacheShelf.ts:39–92`), **`StreamCacheView`** (`cache/types.ts:16`), **`StoryView`** (`story.ts:152`), **`AheadTorrents`** (`ahead.ts`).

---

## Dependencies

- **Configuration:** `NOTESD_TORRENT`, `NOTESD_TORRENT_DIR`, `NOTESD_TORRENT_KEEP_DAYS` (7), `NOTESD_TORRENT_BUDGET_GB` (40), `NOTESD_TORRENT_MAX_GB`, `NOTESD_TORRENT_REMUX`, `NOTESD_STREAM_CACHE_DIR`, `NOTESD_STREAM_AHEAD`, `NOTESD_STREAM_PREVIEWS`, `NOTESD_STREAM_WARP`, `NOTESD_MOVIES_STORY_MODEL`.
- **External:** the torrent indexes and trackers, the cloud providers through the streaming Chrome, TMDB, Wyzie, Whisper, ffmpeg, the `claude` binary with WebSearch.
- **Tests:** `verify.sh` pins the indexes, trackers, canary, trending and WARP to fakes; every new seam must be injectable the same way.

---

## Reference List

| Symbol / key | File:line | Kind | Package |
|---|---|---|---|
| `streamTorrents` | `src/db/schema.ts:1709` | def | db |
| `streamCaches` | `src/db/schema.ts:1628` | def | db |
| `movieDialogues` | `src/db/schema.ts:1173` | def | db |
| `SHARED_IMPORT_TABLES` | `src/db/sharedImport.ts` | config | db |
| `TorrentsRepo` | `src/directStream/torrent/repo.ts` | def | directStream/torrent |
| `TorrentStreams.pruneNow` / `keepBudget` | `src/directStream/torrent/service.ts:754` / `805` | def | directStream/torrent |
| `TorrentStreams.diskUsage` / `takeSlot` | `src/directStream/torrent/service.ts:563` / `1019` | def | directStream/torrent |
| `TorrentSource.resolve` / `fetchAhead` / `listCandidates` | `src/directStream/torrent/source.ts:477` / `687` / `807` | def | directStream/torrent |
| `PREFERRED_TORRENT_HEIGHT` | `src/directStream/torrent/source.ts:47` | def | directStream/torrent |
| `EpisodeAhead` | `src/directStream/ahead.ts` | def | directStream |
| `MovieStreams.buildAhead` / `watched` | `src/directStream/service.ts:530` / `576` | call | directStream |
| `StreamCache.request` / `player` / `start` | `src/directStream/cache/service.ts:191` / `348` / `169` | def | directStream/cache |
| `CacheShelf`, `ShelfTorrents`, `ShelfCaches`, `liveSlots` | `src/directStream/cacheShelf.ts:237`, `154`, `161`, `23` | def | directStream |
| `OFFICE_SSID` | `src/streaming/warp.ts:12` | def | streaming |
| `torrentThroughWarp` | `src/directStream/torrentWarp.ts:97` | def | directStream |
| `/api/stream/cache*` | `src/http/streamCacheApi.ts` | def | http |
| `/api/stream/disk*` | `src/http/streamDiskApi.ts` | def | http |
| `direct_stream_cache` | `src/mcp/streamCacheTools.ts` | def | mcp |
| `MovieStories`, `StoryWriter`, `STORY_SYSTEM_PROMPT` | `src/movies/story.ts:204`, `70`, `29` | def | movies |
| `createGuideWriter` | `src/movies/guides.ts:292` | def | movies |
| `MoviesRepo.saveStory` / `dialogue` | `src/movies/repo.ts:1192` / `1171` | def | movies |
| story routes | `src/http/moviesApi.ts:538–575` | def | http |
| `CachePage` | `web/src/components/movies/CachePage.tsx` | def | web |
| `EpisodeList` season head / book icon | `web/src/components/movies/EpisodeList.tsx:121` / `208` | def | web |
| `MovieDetail` head buttons / `StoryModal` | `web/src/components/movies/MovieDetail.tsx:305` / `413` | call | web |
| `PlayMenu`, `TorrentsModal`, `StoryModal` | `web/src/components/movies/*.tsx` | def | web |
| `fetchStreamDisk`, `writeStory` | `web/src/moviesApi.ts` | def | web |
| route descriptions | `scripts/docs/httpRoutes.ts:205–332` | doc | scripts/docs |
| guides | `docs/guide/streaming.md:1586`, `1718`, `1861`; `docs/guide/movies.md:679` | doc | docs |
| feature map | `.claude/skills/verify-notesd/features/{movies,direct-streaming}.md` | doc | verify |

---

## Impact Points (files that WILL need changes)

1. `src/db/schema.ts`, `drizzle/0043_*.sql`, `src/db/sharedImport.ts` (only if a merge rule is needed): the download queue, the owner mark, the story store. Phase 1.
2. `src/directStream/torrent/repo.ts`, `src/movies/repo.ts`, a new downloads repo: single writers. Phase 1.
3. `src/directStream/torrent/service.ts`, `source.ts`, a new `src/directStream/downloads/*`, `src/directStream/service.ts`, `src/daemon.ts`, `src/deps.ts`, `src/config.ts`: the download engine. Phases 2 and 3.
4. `src/http/*` (a new downloads route file), `src/mcp/streamCacheTools.ts`, `scripts/docs/httpRoutes.ts`, generated references, `src/mcp/instructions.ts`: routes and the tool. Phase 4.
5. `src/directStream/cacheShelf.ts`, `src/http/streamDiskApi.ts`, `src/mcp/streamDiskTool.ts`, `web/src/components/movies/CachePage.{tsx,css,test.tsx}`, `web/src/moviesApi.ts`: the Cache page. Phase 5.
6. `src/movies/story.ts`, a new web story writer, `src/http/moviesApi.ts`, `scripts/docs/httpRoutes.ts`: stories from the web. Phase 6.
7. `web/src/components/movies/{StoryModal,EpisodeList,MovieDetail}.tsx`, `web/src/moviesApi.ts`: the season story button and the modal. Phase 7.
8. `web/src/components/movies/{MovieDetail,EpisodeList,TorrentsModal}.tsx`, a new download button and menu, `web/src/lib/movies.ts`, `web/src/moviesApi.ts`: the title page's download buttons and bars. Phase 8.
9. `docs/guide/{streaming,movies}.md`, `docs/guide/img/*`, `scripts/docs/shots/*`, `.claude/skills/verify-notesd/features/*`, `CLAUDE.md`, `claude/skills/direct-stream`, `src/chat/prompt.ts`: guides, pictures, the feature map, the end-to-end proof. Phase 9.

**This document describes. The plan files prescribe.**
