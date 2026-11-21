# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v0.9.0] - 2026-11-21

Downloads and a play that looks after itself: a film, a season or an episode is downloaded to
this machine on request, a play moves to another source when its stream turns out wrong or
stalls, and carries on after a daemon restart. Around it: a Cache page, seek previews on the
player, stories written from the web, five more torrent indexes, a torrent list and blacklist
per title, and Cloudflare WARP switched for torrents on the office network.

### Added

- **Downloading a title** (`src/directStream/downloads/*`, migration 0043,
  `NOTESD_STREAM_DOWNLOADS`): the download button on a title's page, a season's row or an
  episode's row, and `direct_stream_cache`, put the film, the season's aired episodes or the
  episode on this machine. With no source named: a 1080p torrent with live seeders, then the
  cloud at 1080p or lower, then a smaller torrent. A season is taken from a pack when one has
  seeders, a download carries on the 1080p torrent already partly on disk, and what the owner
  asked for is kept through the prunes until it is deleted. Queued, running and paused downloads
  carry on after a restart.
- **The Cache page** (`/movies/cache`, `stream_disk`): what this machine keeps on disk for
  streaming (caches, torrents, downloads), with a Downloading filter, progress bars and why a
  row is there; a row is deleted with a 10 second undo.
- **Seek previews** (`src/directStream/previews/*`, `NOTESD_STREAM_PREVIEWS`): a picture over
  the player's timeline, from a provider's own preview track or built by one niced ffmpeg from
  video already on this machine. A build asks the network for nothing and joins no swarm.
- **A play moves by itself**: when a picture or audio check that finished behind the play
  rejects the stream, when a torrent or a stream keeps stalling, or when a stream cannot be
  played at all, the play goes to another source at the same position, twice at most. A
  provider named by hand stays.
- **A play carries on after the daemon restarts**: the player page asks for a fresh session for
  the same play and goes on from its buffer.
- **Stories from the web** (`src/movies/webStory.ts`): a season's story from its row's book
  icon, one section per aired episode, written by Claude with WebSearch as its only tool from
  published recaps, with the sources listed. An episode's story goes to the web first and reads
  its dialogue only when no source covers it; an episode no source covers says so.
- **Five more torrent indexes**: TorrentsDB and Peerflix (asked by IMDb id), Knaben, Bitsearch
  and torrents-csv (asked by title, with the title and the year or episode marker required).
  Public tracker lists are read once a day and the trackers that answer are kept
  (`NOTESD_TORRENT_TRACKER_LISTS`).
- **The torrents of a title** (`direct_stream_torrents`, migration 0042): every candidate
  torrent of a film or episode in one list, each playable or downloadable by hand, and a
  blacklist per info hash that holds for every title.
- **Dubs among torrents**: a release named after a known voice-over group is a dub by name, and
  a torrent whose file tags no audio language is heard by Whisper five minutes in; a dub moves
  the play. A title's audio language can be set when TMDB's original language is not what is
  spoken (migration 0041, `direct_stream_play`'s `audio_lang`).
- **Cloudflare WARP for torrents** (`warp` tool, `/warp`): on SSID `Employee`, a torrent play
  or a download the owner asked for that found no peer at all gets one round through WARP,
  which is put back when it did not help. The owner can read and switch WARP by hand.
- **Whisper for a cloud stream** that no subtitle service covers, and `/sync-subtitle` matches
  a film not in English by where its lines start.
- **A daily provider canary** (`NOTESD_STREAM_CANARY`) writes provider health; providers are
  asked side by side once two gave nothing, and one that failed five times in a row rests.
- Episode addresses for Smashy, VidRock and NexaStream.
- The daemon applies migrations 0038-0043 at its next start; `scripts/install.sh` registers the
  `warp` skill.

### Changed

- **A streaming site plays only after direct streaming found nothing**: a play with no source
  named asks every cloud provider and every torrent first, and a site (idlix, lk21, flicksy,
  dramacool) last. A named provider, codename or magnet never asks a site.
- **1080p first**: a header probe waits while the swarm delivers, a remembered 720p torrent goes
  after the indexes' search for a 1080p, and a cloud stream under 1080p waits up to 25 s for a
  provider that gave 1080p.
- A season pack keeps every episode it downloaded, each in its own row (migration 0040), and
  the torrent folder has a budget (`NOTESD_TORRENT_BUDGET_GB`, 40) that deletes titles marked
  Watched or Not interested first.
- The torrent engine reaches peers over TCP only, and one ask of the torrents has one 90 s
  budget.
- One shared Whisper worker that stops when idle.
- The seed holds the ten cloud providers that still stream; a seed row the file no longer names
  is deleted.
- The next episode is fetched ahead once the one on screen is half watched.
- The guides and `CLAUDE.md` follow the code: one pass of the README, the streaming guide and
  the streaming parts of the other guides against it, and the "no disguise" and advert
  prohibitions are gone from `CLAUDE.md`, the skills, the guide and the code comments.

### Removed

- The background stream prober and its settings (`NOTESD_STREAM_PROBER`,
  `NOTESD_STREAM_CATALOG_SIZE`, `NOTESD_STREAM_PROBE_BUDGET`, `NOTESD_STREAM_IDLE_SECONDS`,
  `NOTESD_STREAM_PROBE_MS`; migration 0038): the canary stands in for it.
- Trending's swarm probe (`NOTESD_TRENDING_PROBE`, migration 0039): the list is built from the
  indexes and TMDB only and joins no swarm.
- The `direct_stream_dialogue` tool, YTS as an index of its own (`NOTESD_TORRENT_YTS_URL`), and
  four settings nobody set, now constants (`NOTESD_STREAM_FIRST_PROVIDER`,
  `NOTESD_TRENDING_SKIP_LANGUAGES`, `NOTESD_TORRENT_INDEX_TIMEOUT_MS`,
  `NOTESD_TORRENT_WHISPER_THREADS`).

### Fixed

- A peer's uTP reset, a late handshake and an HTTP tracker's answer for a torrent already left
  no longer end the daemon.
- An outgoing connect gets 2.5 s per address, not Node's 250 ms, and an index whose connection
  failed at once is asked again.
- A provider that is down, a slow stream check or a title that is not out yet no longer holds a
  play back; the stream checks hold a play for four seconds at most.
- A starved remux is `no_stream`, a remuxed film keeps its remux only, and a stopped remux
  deletes its half-made copy.
- A torrent that does not play leaves no row, a swarm probe deletes only the files it made, and
  the prune clears folders no download names.
- A signs-and-songs track is never shown as the English subtitle, the release's own subtitle
  outranks a kept service file, and subtitle files read from bytes have their mojibake undone.
- The subtitle moves above the seek preview box, and a checked subtitle resets the player's
  G/H delay.
- A cloud stream's audio is cut from its segments, so its language can be heard and its
  subtitle synced and checked on streams ffmpeg cannot open.
- A blacklisted torrent leaves its title on the Stream side, fakes named `.exe` and trailers are
  never candidates, and a title with no IMDb id still asks the indexes searched by title.
- A pending play's outcome is answered once, a second pasted magnet for the same title is its
  own play, and a restart-continue counts as busy.
- The Cache page's in-use chip is readable and says why.

## [v0.8.0] - 2026-11-19

Direct streaming: a film or an episode plays in notesd's own player page from a cloud provider
or a torrent, in its original language with an English subtitle and no site adverts. Around it:
a Stream side on `/movies` with a daily Trending list, two more streaming sites, pop-ups for
people, studios and genres, and a Postgres on this machine in place of Neon.

### Added

- **Direct streaming** (`src/directStream/*`, `claude/streaming/direct/*`, migrations
  0020-0022, `docs/guide/streaming.md`): a resolver finds a title's stream at a cloud provider,
  a pass-through serves it, and notesd's own player page shows it full screen in the streaming
  Chrome. `/direct-stream` and the `direct_stream_find`, `direct_stream_play` and
  `direct_stream_sources` tools drive it from Claude Code and the chat bar.
  `NOTESD_DIRECT_STREAM=off` turns it off.
- **The player page** (hls.js, dash.js): the page draws the subtitles itself, G and H delay
  them, the shuffle button (S) asks for another source, and there are previous and next episode
  buttons. A pause caches the film and the timeline shows what is loaded; a network error or an
  expired token is recovered from on the same page, and a provider that keeps stalling is left.
- **Original language only**: every resolve carries the title's `original_language`, and a
  stream that names other languages only is `dubbed` and skipped. A cloud stream with no
  language tags has ~30 s of its audio heard by Whisper (`NOTESD_STREAM_AUDIO_CHECK`), and two
  frames of a stream are looked at before a provider's first play, so a cinema recording or a
  burned-in advert is passed over (`NOTESD_STREAM_PICTURE_MODEL`).
- **Torrents as a source** (`src/directStream/torrent/*`, `webtorrent`, migration 0031): four
  JSON indexes (Torrentio, apibay, EZTV, YTS), then 1337x, ext.to and RuTracker through the
  streaming Chrome. The best three swarms are opened side by side and the one whose headers
  arrive plays; the trackers are scraped first, and asking again tries the next torrents. A file
  Chrome cannot play is remuxed by ffmpeg, a pasted magnet plays that exact torrent, and a
  dub-named release is a last resort the file itself decides. Only video and subtitle files are
  ever selected. `NOTESD_TORRENT=off` builds nothing.
- **Subtitles for a torrent**: the torrent's own files, an embedded track fed as it grows, Wyzie
  Subs (`WYZIE_API_KEY`), Stremio's OpenSubtitles add-on, then Whisper as the last tier. A
  subtitle from outside the stream is re-timed behind the play by Wyzie Synced, and a cloud
  stream with no English track gets an outside subtitle per title.
- **`/sync-subtitle`** (`direct_stream_sync_subtitle`): Whisper hears a minute at six places
  and the subtitle is scored on text and timing; it is replaced or re-timed only when the new
  one passed both. A time in the request (`at`, such as `12:37`), or else the minute around
  where the player on screen is, is heard first, and when enough is said there only the film's two ends
  are heard beside it.
- **Watch codenames**: DM and DS play from the library in VLC, NTM and NTS from a cloud
  provider, TM and TS from a torrent. The same words are told to every client.
- **What played last time plays first** (migrations 0034, 0036): the channel a title last really
  played through (cloud provider, torrent, or a site and its page) is kept per title and host,
  written only once the player reports, and asked first by a request that names no source.
- **Discovery** (`direct_stream_discover`, migrations 0023, 0024): find something to stream by
  person, studio, service, language, genre, keyword or year, never a title already watched; a
  title is found by its other names, and a series carries on where it was left.
- **Stream cache** (`direct_stream_cache`, migrations 0029, 0030): a title is downloaded to
  this machine before watching and played from there. While an episode plays the next one is
  fetched ahead and gives way to the episode on screen (`NOTESD_STREAM_AHEAD`).
- **`/update-cloud-source`** (`direct_stream_update_source`): reads a site's provider
  templates from its scripts, the frames a watch page loads, or a tab the owner already cleared
  by hand, and probes each new provider. Given a magnet, it names the index it came from and
  keeps its trackers that answer.
- **`/report-stream-bug`**: the daemon keeps a stream evidence log, and the player's report
  button opens a session that collects a snapshot, the pass-through's records, the player's log
  and a download-speed comparison, and names the cause. It reads a torrent session by its swarm.
- **Stream side of `/movies`**: the titles with a stream source verified on this machine, last
  play first, with a refresh button and a background prober that fills it while Windows is idle
  (`NOTESD_STREAM_PROBER`, off by default). A stream on screen shows as playing or paused, and
  a play being started says what it is doing.
- **Trending on torrents** (`src/directStream/trending/`, migration 0032): a daily list of the
  most seeded films and series not yet seen, with one swarm probe per title; "confirmed" means a
  peer sent a file list with a video. A control torrent tells a blocked network from dead
  swarms, and `NOTESD_TRENDING_SKIP_LANGUAGES` leaves languages out.
- **Marks and an Interested watch list** (migration 0037): watched, interested and not
  interested are set from a poster without opening the title, and the poster leaves the grid at
  the click. An interested title with no verified source is listed under its own filter.
- **Pop-ups for people, studios and genres**: a name on a title's page opens a pop-up with its
  titles, read from TMDB at each request, each with the three mark buttons. A genre's guide is
  collated once per title by Claude and kept. A title the library does not hold is stored before
  its pop-up opens.
- **The play menu** names the source by hand: the library, a cloud provider, a torrent, a
  streaming site (`POST /api/movies/:id/site-play`) or the title's pahe pages.
- **Stories and dialogue** (migrations 0027, 0028): `direct_stream_dialogue` reads what is said
  in a film or an episode, and an episode's book icon writes its story once from that dialogue
  (`NOTESD_MOVIES_STORY_MODEL`). `movies_pictures` lets Claude look at a title's poster,
  backdrop or episode still.
- **`/flicksy` and `/dramacool`**: a third and a fourth streaming site, the latter playing
  episodes; `/idlix` plays one episode of a series. Every site play is reported to the daemon
  and listed on the Stream side, and a title TMDB does not list is kept with what the site's
  page says (migration 0035).
- **Seasons on a series' page**: a season folds, and one button marks it finished (migration
  0025). A play started from an episode row is followed on that row.
- **`scripts/install.sh --check-idle`, `--wait` and `--force`**: the installer refuses to
  restart the daemon (exit 75, nothing changed) while a film plays or a play is being started;
  `--wait` installs once the daemon is idle. `GET /api/movies/player` carries `stream`,
  `starting` and `busy`.
- `scripts/install.sh` registers the six new skills (`flicksy`, `dramacool`, `direct-stream`,
  `update-cloud-source`, `report-stream-bug`, `sync-subtitle`) and installs Whisper
  (`faster-whisper`, model `small`) unless torrents or Whisper are turned off. Re-run it after
  updating; the daemon applies migrations 0020-0037 at its next start.

### Changed

- **notesd runs on a Postgres on this machine**: `scripts/install.sh` creates the
  `mcp-notes-pg` Docker container (127.0.0.1:55437) and points `DATABASE_URL` at it; the daemon
  waits for it and applies `drizzle/` at every start, so `npm run db:migrate` is no longer an
  install step. The old Neon address stays as `IMPORT_DATABASE_URL` and is read once: staged
  behind the daemon, merged at the next start. Nothing at run time depends on a hosted database,
  and the adversary toggle and daily cap now count per machine.
- A site that does not answer is asked once more with Cloudflare WARP the other way round
  (`NOTESD_STREAM_WARP`), and idlix is followed to another numbered host of the same name;
  `IDLIX_ORIGIN` defaults to `z3.idlixku.com`.
- The Movies page has one row of controls, the name pop-up scrolls inside its box, and the chat
  movie pop-up follows the play.
- `cinemaos.live` is the cloud provider tried first (`NOTESD_STREAM_FIRST_PROVIDER`); a
  provider is scored on how it delivers and dead ones are tried last.
- The streaming and movies guides match the product, with pictures; the streaming guide's
  player pictures come from the throwaway daemon and the Sintel trailer.

### Fixed

- Subtitles and controls stay on screen in full screen: the player is 2 px short of the screen,
  so Chrome draws no overlay over the page.
- A title with no file anywhere lists every episode.
- A passively embedded Turnstile script or Cloudflare beacon no longer reads as a bot check.
- Anime plays: Japanese audio with English subtitles, and an episode is mapped when TMDB and the
  index differ by a day.
- A studio name stands for all its TMDB companies.
- A slow subtitle host or an undecodable stream no longer holds a play back, and a stray
  `session_over` does not stop a cache move.
- A rated star is solid white.
- Skill descriptions load in full, and `direct-stream`'s argument hint is quoted.

## [v0.7.0] - 2026-11-15

Streaming sites (`/pahe`, `/idlix`, `/lk21`) from Claude Code and the chat bar, trailers and
one-click name questions on a title's page, and a Movies page that knows what VLC is really
doing.

### Added

- **Streaming sites** (`claude/streaming/*`, `docs/guide/streaming.md`): one command,
  `cli.mjs`, with a module per site. `/idlix` and `/lk21` find a title, and for one matching
  film start it and show it full screen in a real Chrome on Windows with its own profile
  folder, driven through `cdp.ps1` (PowerShell, since WSL cannot reach Windows loopback). A
  link counts only when the site's own search returned it.
- **Streaming MCP tools** (`streaming_find`, `streaming_play`, `src/mcp/streamingTools.ts`,
  `src/streaming/service.ts`): the daemon runs the same command, so the wall's chat bar can do
  what the skills do. `NOTESD_STREAMING=off` turns them off; `IDLIX_ORIGIN` and `LK21_ORIGIN`
  follow a site that moved.
- **`/pahe`**: finds a title's page on pahe.ink from Claude Code and the chat bar, keeping the
  search results whose name and year match, best source first.
- **`/create-streaming-skill`**: records how a new site is looked at and added, with the
  mistakes made on the first two.
- **Trailers** (migration 0019): the newest official YouTube trailer is stored per title and
  per season; a trailer icon beside Play and on each season heading plays it in a pop-up, or
  opens a YouTube search when TMDB lists none. Older titles are looked up ten per sync pass,
  and `movies_get` carries `trailer_url`.
- **Ask about any name on a title page**: every genre, studio, crew member, cast member and
  character is a link that sends its own question through the pill. A question from an
  unfinished title carries the owner's position, and the chat leaves out what happens after it.
- **VLC without picture is detected**: the health log writes a `gpu_reset` line per Windows
  display-driver reset and a `video_stall` line when the followed VLC plays with frozen video
  counters; `GET /api/movies/player` carries `video_stalled`. The Movies page shows an amber
  alert, and the grid poster and the title page carry a playing / paused / no picture chip.
- **`/trace-vlc-bug`**: collects the health log, VLC's windows and frame counters, Windows
  events and screenshots into one evidence folder and matches them against the known causes.
- **`dword_journal_set_source`**: sets or clears "Where from?" on a saved journal entry, the
  one UPDATE the writer allows on `journal_entries`. `/j` fills it with the film or episode
  watched in the session.
- `scripts/install.sh` registers the five new skills (`trace-vlc-bug`, `pahe`, `idlix`,
  `lk21`, `create-streaming-skill`). Re-run it after updating, and run `npm run db:migrate`
  once for migration 0019.

### Changed

- **Play never opens the playing file twice**: Play or continue on the file notesd already
  follows brings the open VLC to the front, tells it to play when paused and answers
  `already_playing`. A followed VLC that is stopped, hung, gone or without video is not reused.
- **A daemon restart keeps following its VLC**: at start the daemon lists its own `vlc.exe`
  processes and reopens the play row of one that still plays. A VLC opened by hand is never
  adopted.
- The answer panel folds to its header line on a press or wheel turn outside it, so the names
  under it on a title page can be clicked; a pinned panel stays open.
- The movies guide shows the owner's real library: `npm run docs:shots -- --live movies` reads
  the running daemon, and plain `docs:shots -- movies` retakes only the unmatched list and the
  assign dialog (`DOCS_SHOTS_CHAT`, `DOCS_SHOTS_PLAY`, `DOCS_LIVE_URL`).
- The adversary and connectors guides link Seer and the connector apps to their GitHub repos.

### Fixed

- Poster grid links use the canonical `/movies/M-xxxx` id instead of the internal
  `movie-<tmdb>` / `tv-<tmdb>` key.
- The streaming tools work from the daemon: PowerShell is named by its full path, since the
  systemd unit's `PATH` has no Windows folders, and a play that arrives while the streaming
  Chrome is closing is tried once more.
- `/pahe` runs its search when the skill is reached through its `~/.claude/skills` symlink.

## [v0.6.0] - 2026-11-14

Movies: a watched library on `/movies`, matched against TMDB and played through VLC, plus one
guide per subsystem replacing the single long README.

### Added

- **Movies subsystem** (`/movies`): the roots under `MOVIES_LIBRARY_DIRS` are parsed, matched
  against TMDB and polled for changes (`src/movies/scan.ts`, `match.ts`, `tmdb.ts`, `sync.ts`);
  `MoviesRepo` (`src/movies/repo.ts`) is the only writer of the `movie_*` tables (migration
  0017). Titles and files are shared across both machines, files and watch state are per host,
  watch state is derived at read time and never stored (`src/movies/state.ts`).
- **Movie ids** (`M-23T4`, migration 0018, `src/movies/ids.ts`): one per title and per episode,
  minted by database triggers like note ids; a movie id written in a note body links to its
  movie page, not the wall (`claude/mods/note-links`).
- **Play via VLC**: Play starts the Windows `vlc.exe` full screen and in front and reads its
  status through Windows `curl.exe`, since WSL NAT cannot reach Windows loopback
  (`src/movies/vlc/*`); a closed VLC port no longer fails Play with `no_free_port`
  (`src/movies/vlc/launch.ts`). A health log, hang detection and crash incidents cover VLC going
  away mid-play.
- **Movies web page**: grid, title/episode detail, an unmatched list with manual assignment,
  and a sidebar pill; the pill reads "Ask about `<title>`" on a title's page and "play
  something" picks a random playable title when nothing is open.
- **Movies MCP tools** (`movies_list`, `movies_get`, `movies_history`, `movies_mark`,
  `movies_continue`, `movies_person`) and chat allow-list entries; the review left on a title or
  episode is written as a normal note through `NotesService`.
- `scripts/install.sh` registers the Movies pieces. Re-run it after updating, and run
  `npm run db:migrate` once for migrations 0017-0018.

### Changed

- **Docs restructured into one guide per subsystem** under `docs/guide/` (wall, claude-code,
  search, chat, sessions, connectors, adversary, movies, architecture, install), each with its
  own pictures; `docs/guide/reference/{mcp-tools,http-api,configuration}.md` are generated and
  checked against the code (`npm run docs:gen`, `npm run docs:check`,
  `tests/unit/docs/reference.test.ts`). `README.md` is now a one-line-per-subsystem index with
  links into the guides; `docs/INSTALL.md` is folded into `docs/guide/install.md`.
- `scripts/docs/httpRoutes.ts` and `envVars.ts` describe every HTTP route and non-setting
  env var so generated reference docs and `docs:check` stay complete.

### Fixed

- A movie id written as a note link opens the movie page instead of the wall's note view.
- The expanded sidebar no longer shows a duplicate Movies icon.

## [v0.5.0] - 2026-11-12

Context Rot and a fuller Spawn fresh, Claude Code session forks, Claude's replies and
commits as session search context, notes auto-linked to their session, and a much
lighter load on Neon.

### Added

- **Context Rot view** (node panel, Gauge button left of Tree): a bar of the session's current context over its inferred window, coloured by band (with an Unknown state), live over a per-node SSE stream and polled every 60 s for another machine's session. Ingest stores each session's latest and peak main-chain context, its first message's context and the context-1m beta flag (migration 0016, older rows filled once per host by a context backfill); `src/sessions/contextWindow.ts` infers window, percent and band at read time. API: `GET /api/sessions/:nodeId/context` and `/context/stream`; `SessionInfo.context` on node shapes.
- **Spawn fresh carries a handoff**: every prompt and reply, within a budget, is written to `<dataDir>/handoffs/` and passed to the new `claude` with `--append-system-prompt-file`. `GET /api/sessions/:nodeId/handoff` gives a dry-run estimate, shown as a second bar in the Context Rot view; it dims and says "no saving: resume is as cheap" when a fresh spawn gains nothing.
- **Session forks** (`--fork-session`, background jobs) get their own node, linked to the parent with a new `fork` link source ranked above `env`/`hook`/`heuristic` (migration 0015). Ingest detects a fork from `jobs/<id>/state.json` or a shared head uuid (a fork of a fork links to that fork) and cuts the copied prefix, so tokens, commits, prompts and replies the parent already had count nowhere. Every re-reader honours the cut, and a one-time fork backfill per host re-reads forks ingested before this.
- Forks on the wall: dotted fork edge, GitFork badge, "forked from <id> after prompt N" in the node panel; API, MCP (`session_get`, `sessions_search`) and hook context describe forks and background jobs, and `session_get` adds `resume_command`.
- **Resume attaches to a live background job**: instead of 409 `live_outside_tmux`, resume opens a tmux window running `claude attach <jobId>` and focuses or types into it on the next ask.
- **Claude's replies as session search context**: the reply to each prompt (the text after the turn's last tool call) is stored redacted in `cc_session_replies` (migration 0014, full-text indexed, filled for older sessions by the prompts backfill) and embedded in the background into `cc_session_reply_embeddings`. `sessions_search` and `GET /api/sessions/search` match on it and list hits in `via_replies`.
- **Commit subjects in session search**: a session's `search_tsv` (migration 0013) and its embed text include its commits; `SESSION_EMBED_TEXT_VERSION` re-embeds every session once.
- `sessions_search` matches a session's notes too (`via_notes`). Note and reply evidence counts `BLEND.related` (0.6) times the session's own, proven against a labelled fixture.
- **Notes auto-link to their session**: the new `notes-link` PostToolUse hook posts each note written in a Claude Code session to `/api/sessions/hook/link-note`, so `/n` saves no longer need "and link it to this node". A failed link is returned to the model, and `/n` verifies every link.
- **Egress meter and Neon quota breaker**: rows and bytes are counted per query shape, a loopback-only `GET /api/debug/egress` reports them, one summary line is logged per hour, and Neon error 53000 opens a 30 minute circuit breaker. `NOTESD_EGRESS_METER=off` turns the meter off.
- Wall shortcuts: Alt+B toggles the sidebar, Alt+C switches between the session graph and project chat; tooltips name their chords. README gains a "Keyboard shortcuts" section and a rewritten "Context rot: resume or spawn fresh".

### Changed

- **Less Neon traffic**: hidden tabs make no requests and visible ones poll at slower, adaptive cadences (notes 300 s, graph 30-120 s, projects and adversary 120 s); notes, tags and the session graph answer 304 on an unchanged fingerprint, with a server-side graph cache; ingest reads a session row once per append instead of three times; the summary worker's idle scan runs at most every 5 minutes unless something changed, and skips settled rows.
- `searchSessions` is built from `CandidateSource`s merged in one place (`mergeCandidates`).
- `scripts/install.sh` registers six hooks (adds `notes-link`). Re-run it after updating, and run `npm run db:migrate` once for migrations 0013-0016.
- Integration tests: one test database per git worktree, and the test containers run with durability off (`test:int` ~93 s warm instead of minutes).

### Fixed

- `seer_leaderboard` returns, drawdowns and Sharpe exclude the owner's monthly paper top-up, which made every strategy read about +40% on a losing month; `current_equity_usd` stays the real balance.
- `git merge-base` output is no longer read as commits; the commit gate needs commit/push/merge as the actual git subcommand.
- The fresh-spawn estimate leaves sessions that open with a slash command or a handoff out of the repo baseline.
- Windows opened by "Resume in tmux" get tmux's global `PATH`, not the systemd unit's bare one.
- The node modal's token stats stay on one row.

## [v0.4.0] - 2026-11-06

Seer Adversarial, the daily-words connector (`/v`, `/j`), session note links and
on-demand summaries, and the `verify-notesd` skill.

### Added

- **Seer Adversarial** (`/adversary`): a background reviewer reads Seer's `strategy_candidates`, has Claude gather news, filings and prices (`ADVERSARY_GATHER_MODEL`, default sonnet) and give a verdict (`agree`, `object`, `unsure`; `ADVERSARY_VERDICT_MODEL`, default opus) on each pick, and writes verdicts, `paused` marks and leases into Seer's DB through an allow-listed writer (`seerWriter.ts`). Only verdicts decided before the session's 09:30 New York open count; later ones are marked `late`. Each method gets a Claude twin book that skips objected picks, compared against the original and SPY. Attempts and usage are logged in `adversary_reviews` (migration 0011). `ADVERSARY_DAILY_CAP` (15 a day), turn and time limits, `NOTESD_ADVERSARY=off` as the per-machine kill switch, and a shared ON/OFF toggle on the page.
- **Adversary wall page**: roster, per-method curves and stats, verdict cards with reasons and sources, the daily A / C / Claude three-way, the objection scorecard, both go-live checklists, "Review now", a sword rail button and Alt+Z focus. API under `/api/adversary/*` (`overview`, `methods/:id`, `decisions/:session`, `daily/:id`, `scorecard/:id`, `toggle`, `review-now`), `event: adversary` on `/api/events`, and MCP tools `adversary_overview`, `adversary_verdicts`, `adversary_scorecard`.
- **Seer nightly dispatch**: each automatic pass starts Seer's GitHub nightly (`gh workflow run nightly.yml`) once New York midnight + 5 minutes has passed, because GitHub's own cron fires after the US open. At most 3 tries a day, state shared by both machines; `NOTESD_SEER_DISPATCH=off`, `NOTESD_GH_BIN`.
- **`/redo <method> <TICKER>` skill** with `adversary_redo_context` / `adversary_redo_submit`: redoes one pick's review with real web search, only while that session has not opened.
- **`/check-seer-adversarial-nightly` skill**: checks Seer's nightly, saves one note per problem linked to the session, and says when (in WIB) today's Adversarial results will land.
- **daily-words connector** (`dword`): `dword_schema` and `dword_sql` (read-only), plus `dword_vocab_lookup`, `dword_vocab_add`, `dword_journal_find_similar` and `dword_journal_add`, which write through an allow-listed writer as the user named by `DWORD_USER_EMAIL`. Vocabulary lookups match exact terms, original words, inflected forms and near spellings; journal saves are refused as duplicates (exact after normalizing, or cosine distance below 0.25) unless `force: true`, and a failed embedding never blocks a save. `DAILY_WORDS_DIR` (default `~/daily-words`).
- **`/v` and `/j` skills** for adding or looking up a word, phrase or saying in daily-words from any Claude Code session (`/v term > sentence` keeps the sentence as context); the wall chat runs the same flow with its own status captions.
- **Session note links**: `link_note` / `unlink_note` (MCP) attach an existing note to a session (`note_session_links`, migration 0009); `session_get` lists a session's notes with `kind: "made" | "linked"`. Session notes open in the big editor, and linked notes carry a link icon.
- **Summarize on demand**: `POST /api/sessions/:nodeId/summarize` records a request that the owning machine's summary worker serves first, idle or not (migration 0010); the node panel shows why a session has no summary yet and a Summarize button.
- **Full session prompts**: every prompt is stored redacted in `cc_session_prompts`, backfilled per host, and read with `GET /api/sessions/:nodeId/prompts` (`complete: false` with `incomplete_reason` when only excerpts exist); the node panel's Expand prompts modal shows them with copy. Images pasted into a prompt are shown with it (migration 0012).
- **`verify-notesd` skill** (`.claude/skills/verify-notesd/`): `verify.sh up` starts a
  throwaway daemon from the current checkout. Each run gets its own database in the
  `mcp-notes-pg-verify` container (127.0.0.1:55436), its own port, data dir and empty
  `CLAUDE_HOME`. `doctor`, `api`, `upload`, `mcp`, `ui` (Playwright with video and screenshots),
  `sql` and `down` drive it. Every call saves numbered evidence under
  `~/.local/state/notesd-verify/<run>/evidence`, and that evidence survives teardown. It never
  touches the live daemon, Neon, `~/mcp-notes-data` or `~/.claude`
- **Feature map** (`features/`): notes, search, images and files, recycle bin, wall, projects,
  chat. Each entry says how a user reaches the feature, how to drive it, and the end state that
  proves it works. Plans cite these entries in their Proof sections
- `playwright` 1.62.1 as a dev dependency, for the wall drives
- Projects page: Alt+Z toggles focus mode; note ids in node summaries are links; a cross-repo parent opens in its own repo.
- Wall: clicking a note card's cover image opens the lightbox.

### Changed

- `scripts/install.sh` also links the `check-seer-adversarial-nightly`, `redo`, `v` and `j` skills. Re-run it after updating, and run `npm run db:migrate` once for migrations 0009-0012.
- The `/n` skill and MCP instructions cover the dword connector, session note links and the adversary tools.
- `.claude/settings.local.json` is ignored by git; `CLAUDE.md` points at the verify skill

### Fixed

- Session commits are linked to the clone that holds them, also when the session's worktree was removed, and commits printed only by `git log --oneline` after a quiet `git commit` are counted.
- A bare skill call is kept as a session's first prompt.
- The nightly dispatch finds `gh` outside the systemd unit's `PATH` and retries a failed dispatch after 15 minutes.
- Projects: the graph view fills the window with the pill at the bottom, chat history opens with the pill at the bottom, the bar floats while scrolling, and its tooltips show below the buttons instead of being cut off.
- The sidebar's "n photos" count, which made it scroll sideways, is gone.
- Adversary page: the query pill is anchored to the window bottom, roster cadence and dates moved into tooltips, and the go-live checklist boxes fill their row without wrapping values.

## [v0.3.0] - 2026-11-02

The project session graph: every Claude Code session on both laptops, per repo, with
exact parent links, Haiku summaries, search, cost, and resume into tmux.

### Added

- **Project session graph** (`/projects`): every Claude Code session on both laptops, per repo, as a git-graph of lanes on a time axis, newest at the top. Hand-started sessions form the trunk; sessions they spawned branch off, folded into a `+N` chip. Running sessions pulse, the other laptop's are marked, and only visible nodes are drawn (smooth at ~1000). A rail icon opens the repo list in the sidebar; the picked repo is stored server-side (`app_settings`), so both laptops agree. The graph polls every 10 s with `If-None-Match` (`304` when unchanged).
- **Session ingest**: a background job reads `~/.claude/projects/**/*.jsonl` into `cc_sessions` (migration 0007): repo (worktree paths resolved even after the worktree is gone), branch, name, titles, prompts, times, tokens and cost, commits, files and plan docs. It backfills everything on disk on first start and then reads only appended bytes. `sdk-ts` / `sdk-cli` sessions are skipped. `CLAUDE_HOME`, `NOTES_WORKTREES_DIR`, `NOTESD_SESSIONS=off`.
- **Node ids** like `A0-3G` for every session, generated server-side. Typing one (upper case, with the dash) into any Claude Code prompt makes the `notes-prompt` hook add that session's summary, plan docs, commits and transcript path via `GET /api/sessions/context`; a prompt with no id still costs one regex test.
- **Exact parent links**: new `notes-session` (SessionStart) and `notes-spawn` (Bash PreToolUse) hooks and `POST /api/sessions/hook/start|spawn`. A session reports its parent from `CC_PARENT_SESSION` and learns its own and its parent's node id; a `claude` launched by hand in a tmux window claims the pending spawn its parent left (30 s window). Older sessions get `heuristic` links from their parents' transcripts (`swarm.py launch|spawn --name`, `SendMessage {to}`).
- **Session summaries and search**: sessions idle for 15 minutes are summarized once with Claude Haiku (secrets redacted first), embedded, and searched with the same hybrid blend as notes; the backlog is summarized in the background.
- **Session tools** for MCP and the chat bar: `sessions_search`, `session_get`, `session_transcript` (owning machine only, else `not_on_this_machine`), `sessions_usage` (tokens and cost per session or month) and `session_resume`. Read API under `/api/projects` and `/api/sessions`.
- **Node panel**: summary, prompts, commits, notes made, tokens; Tree / Timeline (Gantt) toggle for the subtree; resume (or spawn fresh) into a new tmux window with no confirm, except for a session on the other laptop. A live session is focused or messaged instead of resumed twice. A deleted worktree falls back to the repo's main checkout, then `~/<repo>`, then `$HOME`, and the answer carries `original_cwd`. `POST /api/sessions/:nodeId/resume`, same-origin only; `NOTESD_TMUX_SOCKET`, `NOTESD_TMUX_BIN`.
- **Per-project chat**: a chat pill under the graph keeps its threads to that repo (`project` on `POST /api/chat`, stored as `chat_threads.project`), and the project header toggles between the graph and that project's chat history (`GET /api/chat/messages?project=`).
- **"unfinished" badge** on orchestrator nodes whose swarm still has pending phases and no live session, from `swarm.py verify` (`NOTESD_SWARM_SCRIPT`, cached 60 s).

- **Focus mode** for the graph: a toolbar icon shows only the graph (or project chat) with its toolbar and pill, kept in the URL as `&focus=1`; Esc leaves it. `/projects?node=ID` with no repo resolves the node's repo.
- **Clickable node ids**: ids like `BE-XU` in chat link to a node pop-up with "Show on graph" (only ids the server knows, via `GET /api/sessions/known`); the `note-links` mod links them in Claude Code replies, and `/open` accepts them.
- **Subagent transcripts count**: the ingester also tails `<uuid>/subagents/agent-*.jsonl` with their own offsets (`cc_subagent_transcripts`, migration 0008) and folds their tokens, models and commits into the parent session.
- **Cost on the node**: the subagent share is shown as part of the recorded total, and sessions without a recorded total get an estimate from per-model tokens (`src/sessions/pricing.ts`). The detail API adds `cost_estimated`, `subagent_count` and `subagent_cost_usd`.
- **Commit links**: every commit on a node (detail API and `session_get`) carries a `url` to GitHub, Bitbucket or GitLab, built from the repo's origin remote; short shas are widened to full ones.
- README: session graph screenshots, a GIF tour and a "Running swarms with the graph" guide.

### Changed

- `scripts/install.sh` registers five Claude Code hooks instead of three and raises `cleanupPeriodDays` in `~/.claude/settings.json` (to `NOTES_CLAUDE_RETENTION_DAYS`, default 3650) so Claude Code keeps the transcripts the graph reads; `scripts/uninstall.sh` removes all five and leaves `cleanupPeriodDays` alone. Re-run `scripts/install.sh` after updating, and `npm run db:migrate` once.
- `notes-prompt` now looks at every prompt for a node id, not only `/n` prompts. Without one it still does no I/O.
- In `~/claude-commands`, `swarm.py`'s `spawn_argv` passes `-e CC_PARENT_SESSION=<CLAUDE_CODE_SESSION_ID>` to every session it spawns (a tmux child does not inherit its parent's environment). Pull that repo and run its `./sync.sh` to get exact links for swarm children.

### Fixed

- A session's commits now include the ranges of `git push` and fast-forward `git merge`, expanded with `git log`, not only the line `git commit` prints, so `git commit -q` and commits landed from other sessions show up.
- Node panel: one line per commit, long subjects cut with an ellipsis (full subject on hover). Node ids in chat use the plain note-id pill; the graph is as wide as its longest title instead of a fixed column, graph and panel share one height, and focus mode drops the page's bottom padding.

## [v0.2.0] - 2026-10-31

Chat history, note files, image similarity search, and Claude Code hooks that turn
pasted pictures into notes.

### Added

- **Same-prompt pasted image to note**: `create_image` and `attach_image` accept `pasted_image` (the N of `[Image #N]`); the `notes-paste` PreToolUse hook now also covers them, uploads that picture and hands the call on with `image_id`. Needed because Claude Code writes a prompt to the transcript only after UserPromptSubmit hooks finish (measured live), so the `notes-prompt` hook cannot name an image pasted in the same `/n` prompt; it now tells Claude to use `pasted_image N` for it. Without the hook the server refuses with `pasted_image_unresolved` and a pointer. Re-run `scripts/install.sh` to widen the installed matcher.
- **Pasted image to note**: `create_image` and `attach_image` take `image_id`, the id of an image pasted into the wall chat or a Claude Code `/n` prompt (like `G-0NC`, any case, dash optional), as an alternative to `path` (exactly one of the two). Same copy and sha256 dedupe (`created: false` / `attached: false` for a known picture); an unknown id is refused as "no pasted image". The wall agent and `/n` now use it for "make that image a note" instead of asking for a file path.
- **Claude Code prompt hook** (`notes-prompt`, UserPromptSubmit, `/n` prompts only): stores the session's pasted images (newest 8, 20 MB each, every turn of the session) in the chat image store before Claude answers and tells it their ids, latest marked, so "that image" resolves. Other prompts are untouched. Logs to `~/.local/state/notes-capture/prompt.log`; `npm run verify:prompt-hook` checks it live.
- **Note-id links in chat**: ids in answers and history bubbles open the big editor in place (fetched, deleted and unknown ids handled quietly); the editor's "Show on wall" icon goes to `/?note=<id>` and flashes the card.
- **Chat history bubble actions**: reply to any bubble (quote chip above the composer, `reply_to` sent, quoted header jumps to the original), edit your questions in place (kept as a revision, marked "edited"; the answer is not regenerated), delete any bubble with a 6 s undo and an option to drop its answer, and a "Show deleted" toggle with restore.
- **Claude Code capture**: a Stop hook saves every `/n` exchange (prompt, final answer, pasted images) to the chat history as a `claude_code` thread through `POST /api/capture/claude-code` (loopback, header-guarded, idempotent, with an outbox when the daemon is down); a PreToolUse hook lets `/n` search with a pasted image via `similar_images({pasted_image: 1})`; `install.sh` merges both hooks into `~/.claude/settings.json` (`--skip-hooks`), `uninstall.sh` removes them.
- **Image lightbox**: click a photo in the big editor's strip to see it large; arrows (click or
  keys) move between the note's photos without closing, Esc closes only the photo (R4).
- **Paste images into the chat bar**: with the bar focused, a pasted image uploads to a separate chat image store (`chat_images`, sha256-deduped, never a note) and shows as a removable thumbnail; the question goes out with up to four images, even with no text, and the agent receives them as image blocks named `[image upload:ID]`.
- Note files on the wall: a paperclip picker, drop and ctrl-v in the note editor attach any file. Files show as chips with download, reveal and undoable remove. Cards show a file count. The note-level "Show in Explorer" opens the note's files folder.
- **Note files (server)**: `note_files` table (migration 0004), `files/<noteId>/` store with sha256 dedupe, attach/remove/restore/download routes, per-file and note-level reveal, and `files` on every note for MCP and the chat agent.
- **Chat history (backend)**: wall chat turns are stored in our own tables (migration 0006) and each turn's context is rebuilt from them; Agent SDK `resume` and session files are gone, so Claude and GLM see the same prompt. `[msg:ID]` labels, a leading `[msg:ID]` in an answer becomes `reply_to`, edit/delete/restore and a paged timeline API, `event: chat` on `/api/events`.
- **Image similarity search**: Gemini Embedding 2 image vectors in `note_image_embeddings`, a background worker, `npm run embed:images:backfill` (`--dry-run`, `--limit`, `--retry-failed`) and the `similar_images` MCP tool (by image id, wall-chat upload or text query), on the wall chat's allow list.
- **Chat history page** (`/history`): every wall chat and captured `/n` exchange on one timeline in Jakarta time, with thread dividers, a "claude code" badge, image thumbnails that open the lightbox, live updates, and a pill at the bottom to keep chatting (paste images there too). It opens from a new sidebar icon above the recycle bin and from a "Chat in full screen" button on the answer panel.

### Changed

- `notes-prompt` no longer waits 2.5 s for the current prompt to appear in the transcript (it never does while a hook blocks); it reads once.
- `scripts/install.sh` registers three Claude Code hooks (notes-capture, notes-paste, notes-prompt) instead of two; `scripts/uninstall.sh` removes all three.

### Fixed

- A picture pasted with a `/n` slash command was invisible to the prompt, paste and capture hooks: Claude Code writes it on the `isMeta` skill-body entry after the command, without `imagePasteIds`, and the hooks only read the command entry. They now count those meta pictures as the command's own.

- **Note modal off-screen for image-heavy notes**: the editor overlay's single grid column stretched to the thumbnail strip's width (a 58-image note), pushing the panel off the right edge; the column is now `minmax(0, 1fr)`.
- **Image ids in chat open that image**: ids of images quoted in an answer ("image 5-RI4 in note B-SMK") were linked as notes and answered "no note"; clicking one now opens that image in the lightbox (arrows walk the other images of its note), without leaving the page.
- Wall card footer: the "Show in Explorer" icon now sits right after the copy-ID icon instead of floating mid-footer.

## [v0.1.0] - 2026-10-30

First tagged release of mcp-notes: a personal plain-text note store in Postgres,
exposed to Claude Code over MCP and to the browser as "the wall".

### Added

- **Notes spine**: notes service, `notesd` daemon and MCP server with create, get, list,
  update, append, delete/restore, revisions/revert, tags (parsed from `#hashtags` in the body)
  and short ids (`A-B32`). Ships the `/n` skill, a systemd unit and install scripts.
- **Images**: image store with derivatives, ingest service, inbox watcher, HTTP routes and
  upload, per-image `note_images` table, and MCP tools to create, attach, remove, restore
  and view images. Image and date filters on list/search.
- **Web UI (the wall)**: wall, rail, sidebar, header, inline edit, live updates over SSE,
  gallery, photo modal, full-screen view, drag/paste upload, a big note editor modal,
  delete with undo, recycle bin, "reveal in Explorer", tag autocomplete while typing `#`,
  a collapsible answer panel, a multi-line chat bar, readable links in answers and a tab icon.
- **Chat bar brain**: Agent SDK backend (Claude with a GLM fallback), threads, guardrails,
  status captions and brain label in the panel.
- **Connectors**: read-only generic and curated tools for the user's own apps —
  expense-tracking, run-insights and Seer (leaderboard, positions, Sera methods) —
  wired into the chat bar allow list and the `/n` skill.
- **Semantic search**: pgvector schema, OpenRouter embedder, background embedding worker and
  `embed:backfill` CLI, hybrid search (words, meaning, tags, recency) and the `related` tool.
- **Clickable note ids**: Claude Code mod that links note ids to the wall, `/open <id>`,
  and wall deep links (`?note=<id>` / `#<id>`).
- **`/migrate` skill**: moves a folder of images into one image note, then deletes the folder.
- Pinned Node 22.23.4 via `.nvmrc`; README with screenshots and GIFs.

### Fixed

- Photo modal text fell back to a serif font.
- Long words no longer spill out of a note card.
- Connector `_sql` no longer cuts off a query that ends in a literal.
- Images whose files are not on this machine are hidden in the gallery, note cards,
  recycle bin and editor instead of showing broken tiles.

[v0.9.0]: https://github.com/miftahulmahfuzh/mcp-notes/releases/tag/v0.9.0
[v0.8.0]: https://github.com/miftahulmahfuzh/mcp-notes/releases/tag/v0.8.0
[v0.7.0]: https://github.com/miftahulmahfuzh/mcp-notes/releases/tag/v0.7.0
[v0.6.0]: https://github.com/miftahulmahfuzh/mcp-notes/releases/tag/v0.6.0
[v0.5.0]: https://github.com/miftahulmahfuzh/mcp-notes/releases/tag/v0.5.0
[v0.4.0]: https://github.com/miftahulmahfuzh/mcp-notes/releases/tag/v0.4.0
[v0.3.0]: https://github.com/miftahulmahfuzh/mcp-notes/releases/tag/v0.3.0
[v0.2.0]: https://github.com/miftahulmahfuzh/mcp-notes/releases/tag/v0.2.0
[v0.1.0]: https://github.com/miftahulmahfuzh/mcp-notes/releases/tag/v0.1.0
