# Direct streaming (provider registry, play, sessions, the pass-through)

## Sub-features
- Provider registry: `claude/streaming/direct/providers.seed.json` is loaded into `stream_providers`
  at every start (seed rows have `origin_site` null); health per provider
  and host in `stream_provider_health`, written after every resolve. Proven by
  `npm run test:int -- tests/integration/directStream.repo.int.test.ts` and `journey.sh RUN seed`.
- Episode addresses in the seed, and the whole-series fallback: an episode's stream that a nested
  frame given the series alone loaded (`seriesPlayerFrame` in `resolve.mjs`) is `no_stream`. Proven by
  `npx vitest run tests/unit/scripts/directResolve.test.ts -t "whole-series"`, and live (owner's
  machine, providers are live) by `node claude/streaming/direct/campaign.mjs run --only Smashy,VidRock,NexaStream --out <dir>`
  (each row's episode `resolved`, control `no_stream`), `node claude/streaming/direct/cli.mjs resolve tv 1396 1 99 --only NexaStream`
  (`no_stream`, "a whole-series player") and the live playback probe below with `--check subtitle --provider <name> tv 1396 2 3`.
- Play: `POST /api/stream/play` (same-origin) resolves through the resolver CLI and opens
  `http://localhost:<port>/stream/<session id>` full screen in the streaming Chrome (the page itself
  is phase 4's). Sessions live in memory: a 32-character random id, 4 hours idle, 24 hours at most.
- Pass-through `GET /api/stream/sessions/:id/p?u=`: only the captured `Referer`, `Origin`,
  `User-Agent` and the player's `Range`; HLS and DASH rewritten so every address comes back through
  it; `.srt` served as WebVTT; hosts limited to what the session's resolve returned and what its
  playlists, manifests and redirects named. Proven by `journey.sh RUN hls dash refuse` and
  `npm run test:int -- tests/integration/directStream.api.int.test.ts`.
- Refresh: `POST /api/stream/sessions/:id/refresh` resolves again under the same id.
- Stream evidence (stream-cache-and-bug-report phase 1): every pass-through answer is one line in
  `<data dir>/movies/stream-evidence-<host>.jsonl` (host and path, never the query; upstream status,
  `ttfb_ms`, `bytes`, `duration_ms`, `kbps`, `outcome`), the page's log lines arrive through
  `POST /api/stream/sessions/:id/events` (same-origin), and `POST /api/stream/evidence/snapshot`
  writes `stream-reports/<stamp>-<id start>/` with `session.json`, `evidence.jsonl`, `player.json`.
  Rotated at 5 MB into `.1.jsonl`; a failed write never fails an answer. Proven by
  `npx vitest run tests/unit/directStream/evidence.test.ts web/src/stream/controller.test.tsx`,
  `npm run test:int -- tests/integration/directStream.evidence.int.test.ts`,
  `journey.sh RUN evidence playerlog snapshot unwritable`, and `DASH EVIDENCE PASS` in
  `dash-expiry.steps.mjs`.
- Off: `NOTESD_DIRECT_STREAM=off` or `NOTESD_MOVIES=off` answers 503 `direct_stream_off` on every
  `/api/stream/*` route, and nothing is built that could start Chrome
  (`npx vitest run tests/unit/directStream/build.test.ts`).
- The player page `/stream/<session id>`: plays HLS (hls.js), DASH (dash.js) or a plain file, the
  English subtitle shown by default (inside the manifest first, then a separate `.vtt`/`.srt`);
  subtitle files are read side by side and hold the film 3 s at most, a late one joins the menu
  (`npx vitest run web/src/stream/controller.test.tsx -t "holds the film"`), a
  quality menu, start at `resume_s`, positions every 5 s and on pause/end, refresh-and-continue on
  401/403/410. After a fatal network error the page stays on the film (`stage: "recovering"`, a
  spinner, positions still reported) and loads again from where it is after 2, 4, 8, 16 and 16 s;
  the error shows only when the fifth restart fails too. HLS keeps 120 s loaded ahead, 30 s under
  `?muted=1`. Logic proven by `npx vitest run web/src/stream tests/unit/static.test.ts`; in a real
  browser by `player.steps.mjs` (BUFFER) and `recovery.steps.mjs` (below).
- Stream plays and verified sources (phase 5). The player page's position reports
  (`POST /api/stream/sessions/:id/position`, same-origin) land on one `movie_plays` row per player
  session (source `stream`, provider, no file); the title's and episode's state, history and the
  resume position follow it like a VLC play. After every resolve this machine's
  `movie_stream_sources` row is verified, or stale on `no_source` (a Chrome failure writes
  nothing); a title is fresh while verified within `NOTESD_STREAM_FRESH_DAYS` and not stale. A
  title known only from streams stays out of the Library grid. Proof:
  `npm run test:int -- tests/integration/movies.streams.int.test.ts`; on a run, seed a stream play
  with `verify.sh exec` and read `GET /api/movies/<id>` and `GET /api/movies` (journey J2 of
  `.workflows/plan/direct-streaming/phase-5.md`).
- `/update-cloud-source <site url>` (`direct_stream_update_source`) and `direct_stream_sources`:
  read an aggregator site's provider templates, add the ones the registry lacks (matched by
  template host and path), probe each new one against the known titles, report per provider; a
  site that cannot be read changes nothing. A site whose scripts hold no template is read through
  the embed frames a watch page loads in the streaming Chrome (`frames.mjs`, the sniffer): the
  TMDB id, season and episode in a frame's address become `{id}`, `{season}`, `{episode}`, and the
  answer says which reader found each provider. Frame reader proven with a fake sniffer by
  `npx vitest run tests/unit/scripts/directFrames.test.ts tests/unit/directStream.updateSource.test.ts`
  (never the real one: `templatesCommand` opens no browser unless it is handed a sniffer). Reader
  proven over the real fmovies chunk by
  `npx vitest run tests/unit/scripts/directTemplates.test.ts`; insert-once, untouched rows,
  probes and the unchanged registry by
  `npm run test:int -- tests/integration/directStream.updateSource.int.test.ts`; the tools and
  the chat bar's exclusion by `tests/unit/mcp.directStreamSourceTools.test.ts` and
  `tests/unit/chat-status.test.ts`.
- The prober (off unless `NOTESD_STREAM_PROBER=on`): TMDB candidates become verified titles up to the
  catalog size, verified sources are re-checked before they go stale, and nothing is probed while the
  laptop is in use or something plays. Proven by `npx vitest run tests/unit/directStream` (fake clock,
  idle, TMDB and resolver), `npm run test:int -- tests/integration/streamProber.int.test.ts` (the SQL),
  and `GET /api/stream/prober` on `verify.sh up --direct-stream --prober` (candidates listed from the
  fake TMDB, the pass stopped at `not_idle`, nothing probed).
- The player page on a torrent (torrent-stream-source phase 4): beside the title a magnet with the
  peers and the download speed (`GET /api/stream/torrent/<hash>` every 2 s while it downloads and the
  tab shows; a drive once the file is on disk), the timeline's grey bar fed by
  `GET /api/stream/torrent/<hash>/map`, a spinner and `Fetching this part from peers` for a seek past
  what is on disk, no automatic move to another source (its stalls are only logged), the shuffle
  button (`Another torrent (S)`) moving to the next torrent and naming it, no pause cache;
  `window.notesdStream.torrent`. Logic proven by `npx vitest run web/src/stream`; in a real browser by
  `torrent-player.steps.mjs` and `torrent-live.steps.mjs` (below).

## How to get to it (user POV)
Play on a stream (phase 9) or `/direct-stream <title>` (phase 7) opens the player page full screen in
the streaming Chrome. Underneath, both call `POST /api/stream/play` from the wall's origin.
- The player: what `/direct-stream <title>` (and Play on the Stream side of `/movies`) opens, full
  screen, in the streaming Chrome.

## Driving it with verify.sh
- `$V up --direct-stream` (implies `--movies`): `up` prints `DIRECT=<run>/direct`. The fixture stream
  host listens on two ports of 127.0.0.1 and answers 403 without `Referer: https://embed.fixture/`; the
  fake resolver returns addresses on the first port, the second is named only inside the playlists.
  `echo dash > $DIRECT/mode` (or `dash_film`, `no_source`, `no_chrome`) picks the next resolve's answer.
- `.claude/skills/verify-notesd/scripts/direct-stream/journey.sh RUN [seed|hls|dash|refuse|evidence|playerlog|snapshot|unwritable]`: every check,
  saved as evidence; ends with `journey: PASS (...)`. Run `seed` first on a fresh run (it counts health
  after exactly one play). `evidence`, `playerlog`, `snapshot` and `unwritable` read
  `<run>/data/movies/stream-evidence-<hostname>.jsonl` and `<run>/data/movies/stream-reports/`.
- Every run without `--direct-stream` pins `NOTESD_DIRECT_STREAM=off`, so `$V up --movies` alone shows the
  off answer: `$V api RUN POST /api/stream/play '{"kind":"movie","tmdb_id":550}'` answers 503.
- `down` copies `upstream.jsonl` and `calls.jsonl` into the evidence folder.
- Prober off: `$V up --direct-stream --prober=off`, then `$V api RUN GET /api/stream/prober` answers
  `enabled: false`, `off_reason: "setting_off"`; `stream_probe_titles` stays empty.
- Prober on: `$V up --direct-stream --prober`; after about 10 s `GET /api/stream/prober` has a `last_pass`
  with `stopped: "not_idle"` and `probed: 0`, and `stream_probe_titles` holds the fake TMDB's 5 films
  and 1 series as listed candidates. Never raise `<run>/movies/idle_ms` (see SKILL.md's gotcha).
- The player, without Windows Chrome or a provider: build the fixture once, then drive the real
  page in a throwaway daemon with the session routes faked by Playwright:
  `FIX=$(bash .claude/skills/verify-notesd/scripts/stream/make-hls-fixture.sh "$HOME/.local/state/notesd-verify/.stream-fixture")`,
  `$V up --web`, `STREAM_FIXTURE="$FIX" $V ui RUN .claude/skills/verify-notesd/scripts/stream/player.steps.mjs`.
  The transcript has `J1 PASS` (English over a French default, quality menu, resume), `API PASS`
  (`window.notesdStream` and the title), `BUFFER PASS` (60 s or more loaded ahead, 40 s or less
  under `?muted=1`), `J3 PASS` (on `?muted=1`: 403 with `X-Notesd-Upstream` mid-film, one refresh,
  continues at 100 s), `J2 PASS` (`.srt` as WebVTT), `MUTED PASS` (`?muted=1`) and `CDN PASS`.
- Network recovery, same fixture and `up --web`:
  `STREAM_FIXTURE="$FIX" $V ui RUN .claude/skills/verify-notesd/scripts/stream/recovery.steps.mjs`
  (about two minutes). The transcript has `RECOVER PASS` (segment loads aborted at 80 s: stage
  `recovering` with the spinner, positions still posted, plays on from 80 s once they answer) and
  `SPENT PASS` (every load aborted: five restarts over 40 s or more, then
  `Playback stopped (networkError manifestLoadError).`), with a screenshot of each.
- A pause caches the film and the timeline shows it (the real page and hls.js, the daemon's cache and
  file route, the fake resolver in mode `hls_film`; on its own `up --web --direct-stream` run):
  `FIX=$(bash .claude/skills/verify-notesd/scripts/stream/make-hls-film.sh "$HOME/.local/state/notesd-verify/.stream-fixture-hls-film")`,
  `DIRECT=<that path> HLS_FILM="$FIX" $V ui RUN .claude/skills/verify-notesd/scripts/stream/pause-cache.steps.mjs`.
  The transcript has `BAR PASS` (while it streams the thick grey bar covers what the browser holds, not the
  film), `PAUSE CACHE PASS` (2 s into a pause the page asks, the session moves onto an `auto` cache under
  the same id, still paused at the same second), `CACHE BAR PASS` (the bar reaches 100%, 150 segments on
  disk, the cache mark shows) and `CACHE PLAY PASS` (play goes on from disk, no pass-through request),
  with screenshots `streaming-bar` and `cached-bar`. The queue order, the map and the three-day clearing
  are in `tests/integration/directStream.cache.int.test.ts`.
- The player on a torrent, with the session and the torrent routes faked by Playwright (the real page
  build; a 300 s H.264/AAC MP4 made once with ffmpeg under `~/.local/state/notesd-verify/.torrent-film`,
  40% of it "on disk" until the steps release the rest): `$V up --web`, then
  `$V ui RUN .claude/skills/verify-notesd/scripts/stream/torrent-player.steps.mjs` (about 90 s). The
  transcript has `TORRENT STATUS PASS` (7 peers and 2.0 MB/s beside the title, the grey bar at 40%),
  `HIDDEN PASS` (a hidden tab asks nothing and asks again when it shows), `TORRENT WAIT PASS` (a seek to
  200 s shows `Fetching this part from peers`), `NO AUTO MOVE PASS` (three stalls logged, no
  `POST .../source`), `TORRENT READY PASS` (released: it plays on past 200 s, the bar reaches 100%, the
  drive mark shows, no more asks) and `SHUFFLE PASS` (S moves to the next torrent and the line names it),
  with screenshots `torrent-status`, `torrent-fetching` and `torrent-ready`.
- The player on a real torrent session (phase 1's loopback fixture torrent, phase 3's fake index):
  `$V up --web --direct-stream --torrent`, then
  `$V ui RUN .claude/skills/verify-notesd/scripts/stream/torrent-live.steps.mjs`. The transcript has
  `TORRENT LIVE PASS` (the page read the daemon's peers and speed into the mark and
  `window.notesdStream.torrent`) and `TORRENT DISK PASS` (the download completes, the bar covers the
  film, the page stops asking).
- A film that keeps stalling moves to another provider (same fixture and `up --web --direct-stream` as the
  DASH expiry below, on its own run: it counts the resolves in `calls.jsonl`):
  `DIRECT=<that path> DASH_FIXTURE="$FIX" $V ui RUN .claude/skills/verify-notesd/scripts/stream/source-switch.steps.mjs`
  (about one minute). The transcript has `SWITCH PASS` (segment loads failed past the buffer: three
  stalls, one `POST .../source`, the film plays on from 100 s on another provider), `SWITCH SESSION PASS`
  (same session id, the second resolve carries `--skip <first provider>`, the evidence log holds
  `created` then `switched`), `DELIVERY PASS` (`direct_stream_sources` shows the provider it left with
  `delivery.verdict: "bad"`) and `ORDER PASS` (the next resolve's health file marks it). The verdict's
  rules are `npx vitest run tests/unit/directStream/delivery.test.ts`.
- A DASH token that expires, end to end (the real page and dash.js, the daemon's pass-through and
  DASH rewriting, the fake resolver, the fixture stream host; Chromium, nothing of the owner's):
  `FIX=$(bash .claude/skills/verify-notesd/scripts/stream/make-dash-fixture.sh "$HOME/.local/state/notesd-verify/.stream-fixture-dash")`,
  `$V up --web --direct-stream` (note `DIRECT=`), then
  `DIRECT=<that path> DASH_FIXTURE="$FIX" $V ui RUN .claude/skills/verify-notesd/scripts/stream/dash-expiry.steps.mjs`.
  The transcript has `DASH PLAY PASS`, `DASH EXPIRY PASS` (the host refuses the old token with 403,
  one refresh, playback continues at 100 s under the new token, two resolves) and `DASH OVER PASS`
  (a 403 without `X-Notesd-Upstream` ends the session, no refresh) and `DASH EVIDENCE PASS` (the
  daemon's evidence log holds the 403s under the old token, the manifest under the new one, and the
  page's `refresh after 403` and `error: session_over` lines). The steps set
  `<run>/direct/mode` to `dash_film` and raise `<run>/direct/token`; the host serves
  `<run>/direct/film` only under the current token. Engine logic:
  `npx vitest run web/src/stream/dashEngine.test.tsx`; the live gate's DASH path:
  `npx vitest run tests/unit/scripts/playcheck.test.ts`.
- The player against a real provider is phase 6's `playcheck.mjs` (muted, normal window).
  `--check expiry` takes an HLS or a DASH provider (`--provider VidLink` for DASH).
- Live template read, free, no browser:
  `node claude/streaming/direct/cli.mjs templates https://ww6-fmovies.com/ --no-chrome` prints
  `ok: true` and the 24 providers. Without `--no-chrome`, a site whose scripts hold no template is
  opened in the owner's streaming Chrome (a background tab, muted): run that only when the owner
  asked. Never run `direct_stream_update_source` against the live daemon for a
  site with new providers unless the owner asked: it writes the shared registry and probes in
  the streaming Chrome.
- Live playback probe (owner's machine only; providers are live): `node claude/streaming/direct/playcheck.mjs setup --dir ~/.local/state/notesd-playcheck`, then `NOTESD_DIRECT_STREAM_CLI=$HOME/.local/state/notesd-playcheck/cli.mjs $V up --web --direct-stream`, then `node claude/streaming/direct/playcheck.mjs run --daemon <URL> --dir ~/.local/state/notesd-playcheck --check play|dash|vidnest|subtitle|expiry --provider <name> movie 550`. It prints one JSON report with a verdict. It brings the streaming Chrome to the front in a normal window, muted: say so before running it. Results go into the Playback section of `docs/plans/2026-11-15-direct-streaming-findings.md` with `playcheck.mjs findings`, and `playcheck.mjs audit` checks that section against the seed.

## /direct-stream (find and play)
- `direct_stream_find`, `direct_stream_play` (MCP, chat bar, `/direct-stream` skill): one film
  starts through the service, several matches start nothing, `no_source` carries every provider's
  outcome, off answers `direct_stream_off`. A series without an episode carries on from what was
  watched (`picked`: `first`, `resume`, `next`; `caught_up` and `not_aired` start nothing). A name
  only TMDB's alternative titles hold matches; a name nothing holds answers `no_match` with
  `did_you_mean`, and `asked_as` stores it as an alias of the picked title. Proven with a
  fake service by `npx vitest run tests/unit/mcp.directStreamTools.test.ts tests/unit/directStream`
  (the pick rules: `tests/unit/directStream/episodePick.test.ts`); the stored-title lookup and the
  alias column by `npm run test:int -- tests/integration/directStream.lookup.int.test.ts`;
  the chat allow list, captions and prompt by `tests/unit/chat-status.test.ts tests/unit/chat-prompt.test.ts tests/unit/mcp.instructions.test.ts`.
- Throwaway daemon: both tools answer `direct_stream_off` (`$V mcp RUN direct_stream_play '{"title":"saltburn"}'`).
  That is the expected proof there; never wire the real resolver into a throwaway instance.
- Live: `/direct-stream saltburn` in Claude Code against the installed daemon. It resolves
  through the streaming Chrome and plays full screen with sound: the owner's to run.

## Discovery, absolute episodes and season marks
- `direct_stream_discover` (MCP, chat bar, the `/direct-stream` skill): TMDB titles by kind, year,
  original language, person and role, production company or streaming service, newest or most
  popular first, each marked against the library (`in_library`, `state`, `seen`, `started`,
  `not_interested`) and this host's verified sources (`stream.verified`). Names resolve to TMDB
  ids in the tool; the others a name fits come back as `other_people`, `other_companies`,
  `other_services`. It starts nothing. `direct_stream_play` takes `absolute_episode` ("One Piece
  episode 730") and answers `picked: "absolute"`, `episode_unclear`, `no_such_episode` or
  `not_aired`. `movies_mark` takes `season` (that season's episodes finished or not),
  `not_interested`, and a title key the library does not hold, which is stored from TMDB first.
- Proven by `npx vitest run tests/unit/mcp.directStreamTools.test.ts tests/unit/directStream/discover.test.ts tests/unit/directStream/episodePick.test.ts tests/unit/movies/tmdb.lists.test.ts tests/unit/mcp.movieTools.test.ts`
  (fake TMDB client, fake service) and `npm run test:int -- tests/integration/movies.mcp.int.test.ts`
  (the season marks, not interested, a title stored from its key).
- Throwaway daemon: `$V up --discovery` (implies `--direct-stream`; the fake TMDB also loads
  `scripts/movies/tmdb-discovery.json`), then
  `.claude/skills/verify-notesd/scripts/direct-stream/discovery.sh RUN`. It makes the tool calls
  the skill names for each of the ten requests of
  `docs/plans/2026-11-16-direct-stream-discovery-brief.md`, picks from the answers, and ends with
  `discovery: PASS (10 requests)`; every call's output is in the evidence folder. Plays go to the
  fake resolver. Add a title to `tmdb-discovery.json`, not to `tmdb.json`: the prober checks and
  the guide pictures count the titles of `tmdb.json`.
- Live, read-only (plays nothing): `direct_stream_discover` against the installed daemon reads the
  real TMDB. A real play is the owner's to run.

## Watch codenames, genre and keyword, cloud only, a season alone
- The six codenames (DM, DS: the library; NTM, NTS: `direct_stream_play` with `provider: "cloud"`,
  never a torrent; TM, TS: `provider: "torrent"`) are told to Claude in the MCP instructions, the
  chat prompt, the `direct-stream` and `n` skills and the play tool's description.
  `direct_stream_discover` takes `genre` (read per kind, every one must fit) and `keyword` (any may
  fit; `filters.keywords_dropped` when no title carries one), reads "Chinese" as `zh` and `cn`, and
  finds a person whose name is a letter or two off (`filters.person.asked_as`).
  `direct_stream_play` takes a season alone (`picked` first, resume or next; `no_such_season`). The
  torrent finder asks for an episode TMDB numbers on across seasons by its place in the season
  (One Piece S16E629 is `16:1`).
- Proven by `npx vitest run tests/unit/mcp.directStreamTools.test.ts tests/unit/directStream/discover.test.ts tests/unit/directStream/episodePick.test.ts tests/unit/directStream/torrentPlay.test.ts tests/unit/directStream/torrentSource.test.ts tests/unit/directStream/torrent/find tests/unit/movies/tmdb.lists.test.ts tests/unit/chat-prompt.test.ts tests/unit/mcp.instructions.test.ts`.
- Throwaway daemon: `$V up --discovery --torrent`, then
  `.claude/skills/verify-notesd/scripts/direct-stream/codenames.sh RUN`. It makes the tool calls the
  skill names for each of the owner's ten requests (`docs/guide/streaming.md`, "Codenames") and ends
  with `codenames: PASS (10 requests)`. One request plays for real from the loopback torrent
  (Karate Kid: Legends, the fixture's audio being English); for the others the fake index lists
  nothing and the check is `no_source` from the torrent source alone, the index asked by the right
  address, and no cloud resolve. `provider: "cloud"` is checked both ways at the end.
  `discovery.sh RUN` passes on the same run when it goes first.
- Live, read-only: `direct_stream_discover` against the installed daemon reads the real TMDB. A
  real TM or TS play joins a real swarm and takes over the screen: the owner's to run.

## Anime, subtitles behind a relay, and answers that are no playlist
- An anime (original language Japanese, known to `api.ani.zip`) is resolved through the anime
  embeds first (`anime.seed.json`, keyed by AniList id and the episode counted through the series):
  Japanese audio with an English subtitle file. The mapping is by the episode's air date. A
  subtitle file behind a relay, a text-track request and a subtitle service's list all become
  tracks; an HLS answer without `#EXTM3U` is not a stream. Proven by
  `npx vitest run tests/unit/directStream/anime.test.ts tests/unit/scripts/directResolve.test.ts`
  and `npm run test:int -- tests/integration/directStream.api.int.test.ts tests/integration/movies.streams.int.test.ts`
  (`--anime` reaches the resolver; only a Japanese title is looked up).
- Every throwaway run pins `NOTESD_ANIME_MAP_URL=off`: the real index is never asked.
- Live (owner's machine): `node claude/streaming/direct/cli.mjs resolve tv 37854 17 730 --audio-lang ja --anime 21:730`
  resolves out of sight through "VidNest Anime" in about 6 s (hls 1080p, one English subtitle).
  `resume one piece from episode 730` in Claude Code plays it: the owner's to run.

## The dialogue of a film or an episode
- `direct_stream_dialogue` (MCP, chat bar): the English subtitle of a stream source as lines with
  their minute, resolved out of sight (no player opens), stored in `movie_dialogues` and answered
  from there afterwards; a series needs its episode (`needs_episode`), a long film comes in pages
  (`next_from_minute`), and `no_subtitle` / `no_source` say why there is none. Proven by
  `npx vitest run tests/unit/directStream/dialogue.test.ts tests/unit/mcp.directStreamTools.test.ts`
  and `npm run test:int -- tests/integration/directStream.api.int.test.ts tests/integration/movies.streams.int.test.ts`
  ("the dialogue": the fixture's `.srt` through the pass-through, a subtitle playlist's segments,
  the stored row).
- Throwaway daemon: `$V up --direct-stream`, then
  `$V mcp RUN direct_stream_dialogue '{"title":"movie-990004"}'` answers the fixture's one line
  (`[00:01] Hello.`) with `cached: false`, and the same call again with `cached: true`; the fake
  resolver's `calls.jsonl` holds one resolve and no `open`.
- Live (owner's machine, out of sight, plays nothing):
  `direct_stream_dialogue {"title":"one piece","absolute_episode":760}` reads about 290 lines
  through "VidNest Anime".

## Previous and next episode in the player
- A series' session carries `prev_episode` and `next_episode`; the player shows a button for each
  (Shift+P, Shift+N), and `POST /api/stream/sessions/:id/episode` resolves the neighbour into a new
  session that the page plays without leaving full screen. A failed resolve leaves the episode on
  screen playing. Proven by `npx vitest run web/src/stream` and
  `npm run test:int -- tests/integration/directStream.api.int.test.ts tests/integration/movies.streams.int.test.ts`.
- Real browser, throwaway daemon: `$V up --web --discovery` (note `DIRECT=`), then
  `DIRECT=<that path> DASH_FIXTURE="$FIX" $V ui RUN .claude/skills/verify-notesd/scripts/stream/episode-buttons.steps.mjs`
  (`FIX` from `make-dash-fixture.sh`, as for the DASH expiry). The transcript has `BUTTONS PASS`,
  `NEXT PASS` (a click resolves S16E731, a new session plays, the play of S16E730 is closed),
  `PREV PASS` (Shift+P) and `FILM PASS` (no buttons on a film), with a screenshot of the buttons.

## Original audio, and the stream on screen
- A dub is never a source: the resolver reads what each stream speaks (manifest audio tracks, else
  the first segment's MPEG-TS programme table or MP4 track header), skips a stream in another
  language than TMDB's `original_language` as `dubbed`, lends its English subtitle file to the
  stream that is kept, and the player selects the manifest's original-language track. Proven by
  `npx vitest run tests/unit/scripts/directAudio.test.ts tests/unit/directStream/runner.test.ts web/src/stream`
  and `npm run test:int -- tests/integration/directStream.api.int.test.ts tests/integration/movies.streams.int.test.ts`
  (`--audio-lang` reaches the resolver; the language is read from TMDB once and stored).
- Live (owner's machine, out of sight, plays nothing):
  `node claude/streaming/direct/cli.mjs resolve tv 293610 1 1 --audio-lang ko` answers HyperLink
  `dubbed` ("audio is en, the original is ko") and another provider `resolved`.
- The cloud audio-language check: a cloud `.mp4` often has no audio-language tags, so the resolver's
  check above cannot see a dub. Before a cloud provider's first play of a foreign-language title,
  ~30 s of its audio goes through Whisper's `detect` task and a provider heard dubbing is passed over
  in the `vetted` loop for one serving the original (cloud-only; only when the original language is
  known and is not English; verdict kept per title+provider in `movies/stream-audio.json`; `unsure`
  plays; a dub still plays when nothing else does). Proven by
  `npx vitest run tests/unit/directStream/audioLang.test.ts tests/unit/directStream/audioVet.test.ts tests/unit/directStream/torrent/whisper.test.ts`.
  `NOTESD_STREAM_AUDIO_CHECK=off` turns it off.
- The stream on screen: the player page's reports (`paused`, `beat`, `closed`) feed
  `GET /api/movies/player` `stream`, and the Movies page marks the poster, the title page and the
  episode row "playing" (pulsing) or "paused". Proven by `tests/integration/movies.streams.int.test.ts`
  ("the stream on screen"), `web/src/stream/controller.test.tsx` and `web/src/App.stream.test.tsx`.
  End to end on a throwaway daemon: `$V up --web --direct-stream`, then
  `$V ui RUN .claude/skills/verify-notesd/scripts/direct-stream/live.steps.mjs` (PLAYING, PAUSED,
  PAGE and CLOSED PASS, with a screenshot of each).

## Full screen, the player's name, and looking at a poster
- The page takes its own full screen in `start()` (a double click leaves it from the first play);
  the window is made full screen only as a fallback. The tab and the line over the picture name the
  title (`Series S01E01`). `movies_pictures` hands the model a title's poster, backdrop and episode
  still as images. Proven by `npx vitest run tests/unit/scripts/directResolve.test.ts web/src/stream/StreamApp.test.tsx tests/unit/mcp.movieTools.test.ts`
  and `npm run test:int -- tests/integration/movies.streams.int.test.ts tests/integration/movies.mcp.int.test.ts`.
- Live (owner's to run): `/direct-stream <title>`, then a double click on the picture leaves full screen.

## A play carries on after the daemon restarts
- The player page keeps its play (title, provider or info hash, position) and, when the daemon lost
  the session or is down, asks `POST /api/stream/continue` every 5 s for a fresh session at the same
  position ("Reconnecting to notesd…"; the ended message only after 3 minutes); a cached play that
  keeps stalling leaves the cache (`/source` with `leave_cache: true`). Proven by
  `npx vitest run tests/unit/directStream/continueSession.test.ts web/src/stream/controller.test.tsx web/src/stream/StreamApp.test.tsx`.
  On `verify.sh up --direct-stream`: play a title, open its page with Playwright, restart the
  throwaway daemon, and check the page's address moves to a new session id and `window.notesdStream.stage`
  returns to `ready` at about the same position.

## The next episode, fetched ahead
- While an episode plays, the daemon caches the next one (cloud) or fetches it from a torrent
  (`src/directStream/ahead.ts`): once the episode is half through by its playing reports (ten minutes
  of playing when the page gives no duration), one episode ahead, nothing for a film or a DASH
  stream; it gives way to every other download and stops when the stream stalls.
  `verify.sh up --direct-stream`, then
  `.claude/skills/verify-notesd/scripts/direct-stream/ahead.sh RUN` (a little over two minutes:
  it reports a 4-minute episode as the page does). It checks that nothing is fetched a quarter through, that the next
  episode's `auto` cache is ready, that the film fetched nothing, the daemon's `stream ahead:` line,
  and that the next button plays the cached episode. The torrent path is unit-tested
  (`tests/unit/directStream/ahead.test.ts`, `torrentSource.test.ts` "fetchAhead") and can be seen on
  `up --torrent` by playing S01E01 of series 247718 with `provider: "torrent"` and reporting positions.
  The queue's give-way and `pause` are in `tests/integration/directStream.cache.int.test.ts`.

## /report-stream-bug (a stream's evidence, the cause, a note)
- `claude/skills/report-stream-bug/collect.sh [SNAPSHOT_DIR]` gathers the snapshot (the folder it
  is handed, else a new one from `POST /api/stream/evidence/snapshot`), the session's records
  (`GET /api/stream/evidence`, and the on-disk log's tail), the daemon's direct-stream lines with
  every query cut off, and `network.json` (a reference download, the stream through the session,
  the stream host's first answer) into one folder, and prints a summary with the cause. With the
  daemon down or the session ended it still writes the log tail and the measurement, and `missing:`
  says what is not there. No file in the folder holds a pass-through address or a token.
- `diagnose.mjs classify|summary|note DIR` names the cause (`connection_slow`, `host_slow`,
  `token_expired`, `provider_broken`, `session_ended`, `torrent_swarm_slow`, `new`); the skill saves the note it writes
  (`#stream-bug`). Proven by `npx vitest run tests/unit/scripts/reportStreamBug.test.ts` (fake daemon
  and stream host, the fixture folders `tests/fixtures/stream-report/<cause>/`).
- Throwaway daemon (free, nothing of the owner's): `$V up --direct-stream` (note `URL=`, `DIRECT=`),
  a local reference file (`python3 -m http.server 47391 --bind 127.0.0.1 --directory <dir with ref.bin>`),
  a play (`echo hls > $DIRECT/mode`, `$V api RUN POST /api/stream/play '{"kind":"movie","tmdb_id":550}'`,
  one GET of its `manifest_url`), then
  `bash claude/skills/report-stream-bug/collect.sh --wall $URL --data-dir <run>/data --log <run>/daemon.log --reference http://127.0.0.1:47391/ref.bin --host-scheme http`.
  The folder lands under `<run>/data/movies/stream-reports/`; `network.json` has `stream.ok: true`
  from the fixture host's 1080 rendition; `grep -rl 'p?u=' <folder>` prints nothing. A note:
  `$V mcp RUN create` with `diagnose.mjs note <folder>`'s body, then `$V mcp RUN list '{"tags_any":["stream-bug"]}'`.
- Live: `/report-stream-bug` in Claude Code after a broken play (the reference download reaches
  Cloudflare; nothing is played or refreshed).
## Stream cache
- `POST /api/stream/cache` (same-origin) and `direct_stream_cache` (Claude Code only; not in the chat
  bar) download one film or episode to this machine: one HLS rendition (the tallest, or the tallest
  not above `max_height`), the original-language audio rendition, segments, init sections, AES-128
  keys and the English subtitle as WebVTT, or a plain file by ranges; DASH, DRM and live answer
  `cache_unsupported`. Retries with backoff, a fresh resolve on a refused token that keeps the
  files by index, resume after a restart. `GET /api/stream/cache[/:id]` lists every host's
  caches (`available: false` for the other's); `DELETE /api/stream/cache/:id` stops, deletes the
  folder and the row; `GET /api/stream/cache/:id/f/:name` serves files with Range and fetches a
  missing one at once. Files: `<NOTES_DATA_DIR>/movies/stream-cache/<id>/`.
- Proven by `npx vitest run tests/unit/directStream/cache tests/unit/mcp.streamCacheTools.test.ts tests/unit/config.streamCache.test.ts tests/unit/chat-status.test.ts`
  (parsers, the downloader against an in-memory stream host, the tool) and
  `npm run test:int -- tests/integration/directStream.cache.int.test.ts` (table, routes, both
  machines, delete during a download, restart).
- Throwaway daemon: `$V up --direct-stream`, then
  `.claude/skills/verify-notesd/scripts/direct-stream/cache.sh RUN` (stages `start tool refused other clear`;
  `clear` needs `start`; each stage once per fresh run, since a title has one cache per machine and
  `fail_once` fails a file once per host process). It ends with `cache: PASS (...)`. The `refused` stage sets `<run>/direct/mode`
  to `hls_token`, `token_uses` to 10 and `fail_once` to `seg3.ts`: the fixture host's tokened film
  (`/tok/t<N>/`) refuses a token after ten media answers and fails `seg3.ts` once.
- Playing from a cache is phase 6's entry.

## Playing from the cache
- A play (`POST /api/stream/play`, `direct_stream_play`, the player's previous/next buttons) uses
  this host's stream cache of the title first: a `ready` cache plays its local playlist with no
  resolve (`attempts: []`, `session.cached.state: "ready"`, `manifest_url` under
  `/api/stream/cache/<id>/f/`); a `downloading` one plays the same playlist and the file route
  fetches missing segments on demand; a failed cache, a cache on the other machine, a cache made
  for another language or none resolves as before. `POST /api/stream/cache/:id/play` plays one
  cache by id; another machine's answers 404 `not_on_this_machine` with `host`. The page shows a
  drive icon beside the title (`.st-cached`, aria-label "Playing from this machine's cache ...")
  and `window.notesdStream.cached`. A refresh keeps a cache that can still play, else resolves.
- Logic: `npx vitest run tests/unit/directStream/cachePlay.test.ts web/src/stream tests/unit/mcp.directStreamTools.test.ts`.
- Throwaway daemon (`$V up --web --direct-stream`, note RUN and `DIRECT=`), in this order on one run:
  `.claude/skills/verify-notesd/scripts/direct-stream/cache-play.sh RUN ready`, then
  `DIRECT=<run>/direct $V ui RUN .claude/skills/verify-notesd/scripts/stream/cache-play.steps.mjs`
  (`CACHE PAGE PASS`, screenshot `cache-play-page`), then
  `.claude/skills/verify-notesd/scripts/direct-stream/cache-play.sh RUN downloading other-host`.
  The script makes a cache of TMDB movie 550 through `POST /api/stream/cache` (fake resolver,
  fixture host), sets the fake resolver to `no_source` to prove nothing resolves, and edits the
  run's `stream_caches` row with `verify.sh exec` for the downloading and other-host cases.

## Torrents: the engine and its file route (torrent phase 1)
- `POST /api/stream/torrent` (same-origin) opens a torrent by info hash for a title and answers its file list
  from the swarm; with `files` (video and subtitle indexes only; anything else is 400 `not_media`) it
  downloads them in order under `<NOTES_DATA_DIR>/movies/torrents/<hash>/` and holds the torrent until
  `POST /api/stream/torrent/:hash/release`. `GET /api/stream/torrent/:hash/f/:index` answers a byte range with
  exactly those bytes, fetching that range first; `.../map` the stretches on disk; `GET /api/stream/torrent`
  the engine (`port`, `swarm`, `upload_cap_bytes_per_s`) and every download. Upload is capped at
  `NOTESD_TORRENT_UPLOAD_KBPS`; a torrent leaves the swarm once nothing holds it (at once when finished, three
  minutes after the last request otherwise) and only its chosen files stay; a finished download opens and plays
  from disk with no swarm; downloads are cleared after `NOTESD_TORRENT_KEEP_DAYS` without a play.
  `NOTESD_TORRENT=off`: 503 `torrent_off`, nothing is built, no socket is opened.
- Logic: `npx vitest run tests/unit/directStream/torrent tests/unit/config.torrent.test.ts` (`engine.test.ts`
  seeds a generated torrent over loopback with DHT and trackers off); the table, both machines and replay from
  disk: `npm run test:int -- tests/integration/directStream.torrents.int.test.ts`.
- Throwaway daemon: `$V up --torrent` (implies `--direct-stream`; prints `TORRENT=<run>/torrent`). It starts a
  loopback seeder (`scripts/torrent/seed.mjs`, 200 kB/s) of the generated film and season pack
  (`scripts/torrent/make-fixture.sh`: a 120 s H.264/AAC MP4 with English audio, its `.en.srt`, a README, a
  sample and an inert `setup.exe`; two 20 s episodes), writes `fixture.json` and `pack.json`
  (`{info_hash, name, trackers: [], port, piece_length, files}`) and `seeder.jsonl` there, and gives the daemon
  `NOTESD_TORRENT_DISCOVERY=off`, `NOTESD_TORRENT_PEERS=127.0.0.1:<seeder>` and a 64 kB/s cap.
  `TORRENT_FIXTURE_FILE=<path>` seeds that one file as the film instead; a folder moved into
  `<run>/torrent/seed/<name>/` is seeded too and described in `<run>/torrent/seeded/<name>.json`. Then
  `.claude/skills/verify-notesd/scripts/torrent/torrent.sh RUN` (stages `idle files refuse range cap leave only
  disk`, in order, once per run, on the generated film) prints `REFUSE PASS`, `RANGE PASS`, `CAP PASS`,
  `LEAVE PASS`, `ONLY PASS`, `DISK PASS` and `torrent: PASS (...)`. On a run without `--torrent`,
  `torrent.sh RUN off` prints `OFF PASS`.
- Every other run pins `NOTESD_TORRENT=off` and `NOTESD_TORRENT_DIR` under the run: no throwaway daemon joins a
  real swarm or writes into the owner's torrent folder.

## Playing from a torrent
- A play with `provider: "torrent"` (any case; `direct_stream_play`, `POST /api/stream/play`) asks only the torrent
  source; without a provider the order is the stream cache, a finished torrent download on this machine (no index, no
  swarm, no `Index:`/`Torrent:` attempt), the cloud providers, then on `no_source` or `resolve_failed` the torrent source. A torrent
  session: `provider: "Torrent"`, `manifest_kind: "mp4"`, `manifest_url` `/api/stream/torrent/<hash>/f/<index>`,
  `session.torrent` `{info_hash, file_index, name, index, state, seeds}`. Attempts after the cloud's:
  `Index: <name>` per index, `Torrent: <release>` per torrent (`resolved`, `no_stream`, `dubbed`, `unplayable`,
  `error`, `skipped` for one that lost the choice). The shuffle button moves to the next torrent; a `closed`/`ended` report, two idle minutes or the session's
  end release the torrent; reading the session again takes it back. `NOTESD_TORRENT=off`: 503 `torrent_off` for a
  named torrent play, everything else as before.
- Logic: `npx vitest run tests/unit/directStream/torrentProbe.test.ts tests/unit/directStream/torrentSource.test.ts tests/unit/directStream/torrentPlay.test.ts tests/unit/config.torrentFinder.test.ts tests/unit/mcp.directStreamTools.test.ts`.
- Finding a torrent (phase 2's finder, no route of its own): `npx vitest run tests/unit/directStream/torrent/find` over
  recorded index answers (dubs, cinema recordings and 3D left out, the seed floor, direct releases first, an episode or
  a pack that holds it, `bot_check`/`error` per index, every request sent as notesd).
- The Stremio add-on providers beside Torrentio: TorrentsDB for every title, Peerflix only for a title made in Spanish.
  `npx vitest run tests/unit/directStream/torrent/find/indexes.test.ts tests/unit/directStream/torrent/find/findCandidates.test.ts tests/unit/directStream/torrent/find/addonSwitches.test.ts tests/unit/config.torrentFinder.test.ts`
  over their recorded answers (`tests/fixtures/torrent/{torrentsdb,peerflix}-movie-shawshank.json`): a torrent Torrentio
  and TorrentsDB both list is one candidate with both in `listedBy`; Peerflix gets no request for any other language and
  its attempt says `not asked`; a provider's bot check, timeout or failure is its own attempt and the others still answer;
  `NOTESD_TORRENT_TORRENTSDB_URL=off` / `NOTESD_TORRENT_PEERFLIX_URL=off` send nothing. Every throwaway daemon sets both
  `off`, so its attempt lists are unchanged.
- Indexes asked by title (Knaben, Bitsearch, torrents-csv: `Index: knaben`, `Index: bitsearch`, `Index: torrentscsv`):
  a film by title and year, an episode by title and `SxxEyy`; a release only they list must be the title followed by
  the year (one either way) or the episode's marker, else `other_title` / `other_year` / `other_episode` in `excluded`;
  a bot check, timeout or failure is that index's attempt only. Proven by
  `npx vitest run tests/unit/directStream/torrent/find/titleSearch.test.ts tests/unit/config.torrentFinder.test.ts`
  over the answers recorded on 2026-11-19 (`tests/fixtures/torrent/{knaben,bitsearch,torrentscsv}-shawshank.json`).
  Every throwaway daemon pins the three `off` (the fake index is Torrentio-shaped only): a `--torrent` run's play
  names no `Index: knaben`, `Index: bitsearch` or `Index: torrentscsv` attempt.
- Throwaway daemon, a torrent run (`$V up --web --torrent`, note RUN): in this order,
  `.claude/skills/verify-notesd/scripts/direct-stream/torrent.sh RUN fallback named`, then
  `SID=$(cat ~/.local/state/notesd-verify/RUN/torrent-journey/sid) $V ui RUN .claude/skills/verify-notesd/scripts/stream/torrent-play.steps.mjs`
  (`TORRENT PAGE PASS`, screenshot `torrent-page`), then `torrent.sh RUN replay dubbed pack`. The fake index
  (`scripts/torrent/fake-index.mjs`, Torrentio-shaped, the finder's only index on a `--torrent` run) lists phase 1's
  loopback fixture(s) under a release name made of the asked title and year (from the fake TMDB's `tmdb.json`);
  `<run>/torrent/index-mode` switches it to `empty` or `error`, `<run>/torrent/candidates.json`
  (`[{info_hash, name, seeds?, size_bytes?}]`, `name` the release's tail after `<Title>.<Year>.`) replaces its answer
  for every query, and its requests are kept as `torrent-index-requests.jsonl` in the evidence.
- Torrents off (`$V up --direct-stream`): `torrent.sh RUN off`. It runs a resolve, so on a run shared with
  `journey.sh RUN seed ...` (whose `seed` stage expects the run's first resolve) run `journey.sh` first.
- The loopback seeder speaks uTP as well as TCP: the daemon's engine tries uTP first and falls back to TCP only
  after about 40 s, longer than the 20 s a play waits for a torrent's file list.

## A torrent play that starts fast, survives and answers
- **Busy while starting.** A stream play in flight (a cloud resolve, a torrent's indexes and swarms, a page opened
  under 30 s ago that does not report yet) is listed in `GET /api/movies/player` `starting`
  (`{kind, tmdb_id, season, episode, title, provider, since, stage}`) and makes `busy` true while `stream` is still
  null. `scripts/install.sh` reads `busy` before the build and before the restart: busy exits 75 with nothing
  changed (`--wait` waits, `--force` restarts anyway, `--check-idle` only asks).
- **Chosen by the swarm.** The best three torrents are opened side by side; of those whose headers arrive (2 s of
  settling after the first), the one whose swarm delivers plays (6 peers or more, or a rate at or above the film's
  bitrate), then an English subtitle file, then more peers, then the finder's order. Its attempt names the peers
  and the rate; the others are `skipped`, leave at once and lead the shuffle button's list. Six torrents and 90 s
  at most.
- **Subtitles behind the film.** A play answered before its chain ended holds `Subtitles: pending`; the session's
  subtitle and `subtitle_rev` 1 arrive behind it, and the page loads the track on its next position report.
- **An answer within 45 s.** `direct_stream_play` answers `started: false, pending: true` with `stage` and the
  attempts so far when the play outlasts 45 s; the same call again joins the play or reads its outcome. Every
  attempt of a play that started nothing is in the daemon's log (`started nothing after`, then `attempt` lines).
- **A dead index is left out.** Three `error` plays in a row (a timeout or a failure): `Index: <name>` is `skipped`
  for 30 minutes of this daemon and gets no request. Never for a `bot_check`.
- Logic: `npx vitest run tests/unit/directStream/torrentSource.test.ts tests/unit/directStream/playInFlight.test.ts tests/unit/directStream/torrent/find/indexHealth.test.ts tests/unit/scripts/installGuard.test.ts tests/unit/mcp.directStreamTools.test.ts tests/unit/config.torrent.test.ts`.
- Throwaway daemon: `NOTESD_TORRENT_SUBTITLE_WAIT_MS=1500 $V up --torrent` (the daemon's own subtitle wait), then
  `.claude/skills/verify-notesd/scripts/torrent/speed.sh RUN` (stages `race subtitles pending index`, about two
  minutes; `index` last, since it leaves the fake index out for the rest of the run). It ends with
  `speed: PASS (race subtitles pending index)`. A dead swarm is a `candidates.json` entry whose info hash nobody
  seeds; `<run>/torrent/index-mode` also takes `hang` (never answers) and `slow:<ms>`; `$SUBS/delay-ms` holds every
  answer of the fake subtitle service back. The stage `pending` asks `scripts/install.sh`'s own `check_idle`
  (sourced, pointed at the run, never at 7317) while the play is in flight (`evidence/speed-check-idle.txt`).
- Not driven: two live swarms of different health (loopback has one seeder; `chooseOrder` and the race are
  unit-tested with fake swarms), and the open player page taking a late first subtitle (the page's reload on
  `subtitle_rev` is `subtitles-synced.steps.mjs`'s; here the session and the position answer are read).

## Torrent remux (a file Chrome cannot play as is)
- A torrent file the probe marks not `direct` (MKV, AC3/E-AC3/DTS, HEVC) with H.264, HEVC, AV1 or VP9 video plays as
  an ffmpeg remux: `manifest_kind: "hls"`, `manifest_url`
  `/api/stream/torrent/<hash>/hls/<index>/index.m3u8?remux=1&total_s=<film s>`. Video copied, the original-language
  audio as AAC stereo, fMP4 segments in `<torrent dir>/<hash>/notesd-remux/<index>/`; the playlist is EVENT, grows
  with the download and is served with `EXT-X-ENDLIST` only after `done.json` (a clean ffmpeg exit). The page starts
  at the resume position or 0, shows the whole film, and holds a seek past the remuxed part until it is there; the map
  answers the remuxed stretch. Other video (MPEG-2, VC-1) is `unplayable`; `NOTESD_TORRENT_REMUX=off` makes every such
  file `unplayable`. A finished remux replays from disk with no ffmpeg.
- Logic: `npx vitest run tests/unit/directStream/torrentRemux.test.ts tests/unit/directStream/torrentRemux.ffmpeg.test.ts tests/unit/directStream/torrentRemuxRoute.test.ts tests/unit/directStream/torrentRemuxSource.test.ts web/src/stream/hlsEngine.test.tsx`
  (the ffmpeg file runs the real ffmpeg on a generated H.264 + AC3 MKV served at a trickle).
- Throwaway daemon: `FIX=$(bash .claude/skills/verify-notesd/scripts/stream/make-mkv-fixture.sh "$HOME/.local/state/notesd-verify/.stream-fixture-mkv")`,
  `$V up --web --torrent` (note RUN), then
  `RUN_DIR=$HOME/.local/state/notesd-verify/RUN $V ui RUN .claude/skills/verify-notesd/scripts/stream/torrent-remux.steps.mjs`:
  `REMUX PLAY PASS`, `REMUX TRACKS PASS`, `REMUX SEEK PASS`, `REMUX REPLAY PASS`, `REMUX GROWING PASS`, screenshots
  `remux-playing` and `remux-growing`. Run `.claude/skills/verify-notesd/scripts/torrent/offer-remux.sh RUN` before
  the steps: it seeds the MKV through phase 1's `<run>/torrent/seed/remux/` and makes it the fake index's answer
  (`<run>/torrent/candidates.json`).
- Remux off: `NOTESD_TORRENT_REMUX=off $V up --torrent`, `.claude/skills/verify-notesd/scripts/torrent/offer-remux.sh RUN`, then
  `$V api RUN POST /api/stream/play '{"kind":"movie","tmdb_id":467905,"provider":"torrent"}'` answers 502 `no_source`
  with a `Torrent: ...AC3-NOTESD` attempt `unplayable`.

## Torrent subtitles
- A torrent session (`provider: "torrent"`, or the fall-through after a cloud `no_source`) carries an
  English subtitle from the first tier that has one: `kept` (an earlier play of the same torrent),
  `files` (an English `.srt`/`.vtt`/`.ass` inside the torrent, or its one subtitle file that names no
  language), `service` (Wyzie Subs first when `WYZIE_API_KEY` is set, then the OpenSubtitles add-on at
  `NOTESD_TORRENT_SUBTITLE_URL`, by file hash then by IMDb id), `borrow` (a cloud provider's English
  subtitle, resolved out of sight; skipped after a cloud `no_source`). The play answer's `attempts`
  hold one `Subtitles: <tier>` line per tier asked. Files are WebVTT under
  `<data dir>/movies/torrents/<hash>/.notesd-subs/`, served by
  `GET /api/stream/torrent/:hash/sub/:name`; the page shows the English one (or the lone unnamed one)
  by default. Among torrents whose swarms deliver alike, one whose files hold an English subtitle plays.
  The film does not wait for the chain past 1.5 s (`NOTESD_TORRENT_SUBTITLE_WAIT_MS`); `up --torrent`
  sets 40 s so these journeys read the subtitle in the play's answer (see "A torrent play that starts
  fast" for the daemon's own wait).
- Logic: `npx vitest run tests/unit/directStream/torrent/subtitles tests/unit/directStream/torrent/subtitleRoute.test.ts`.
- Throwaway daemon: `$V up --web --direct-stream --torrent` (note RUN, `TORRENT=`, `SUBS=`), then
  `.claude/skills/verify-notesd/scripts/torrent/subtitles.sh RUN` (all stages, about four minutes;
  `files` before `replay`, `quiet` before `wyzie`). `up --torrent` starts a fake subtitle service
  (`scripts/torrent/fake-subs.mjs`; `$SUBS/mode` is `ok`, `id_only`, `empty`, `error` or `wyzie`;
  `$SUBS/requests.jsonl` records each add-on request's path and user-agent) and points
  `NOTESD_TORRENT_SUBTITLE_URL` at it; never the real service. The same fake answers as Wyzie Subs
  (`/search`, a fake `WYZIE_API_KEY`, requests in `$SUBS/wyzie-requests.jsonl` without the key): it
  lists a file only in mode `wyzie`, and every other `up` turns both services off, so the owner's real
  key in `.env.local` is never used. Fixture torrents come from
  `scripts/torrent/make-subtitle-fixtures.sh` (cached in `$VERIFY_HOME/.torrent-subtitle-fixtures`).
  The transcript ends with `subtitles: PASS (...)`; `down` copies the request logs into the evidence.
- The subtitle track inside a torrent's file (torrent-stream-source phase 7): with no subtitle
  file in the torrent, the file's English text track (SubRip, ASS, mov_text, WebVTT) is extracted
  with ffmpeg into a growing cue feed, `GET /api/stream/torrent/<hash>/cues/embedded-<file>-<stream>?after=<i>`
  (`{cues, next, complete}`), and the page reads it every 4 s until complete; picture tracks (PGS,
  VobSub) are skipped and the next tier is asked. Fixtures (MP4 that Chrome plays as is):
  `FX=$(bash .claude/skills/verify-notesd/scripts/stream/make-torrent-sub-fixtures.sh "$HOME/.local/state/notesd-verify/.torrent-sub-fixture")`
  gives `$FX/sub-text.mp4` (English mov_text, cue N "Line N" from 3N-2 s to 3N s) and
  `$FX/sub-picture.mp4` (English VobSub only). Page journey:
  `TORRENT_FIXTURE_FILE="$FX/sub-text.mp4" $V up --web --direct-stream --torrent`, then
  `$V ui RUN .claude/skills/verify-notesd/scripts/stream/embedded-subtitle.steps.mjs`: the transcript
  has `EMBEDDED SESSION PASS`, `EMBEDDED FEED PASS`, `EMBEDDED CAPTION PASS`, `EMBEDDED SEEK PASS`.
  Picture only: `TORRENT_FIXTURE_FILE="$FX/sub-picture.mp4" $V up --direct-stream --torrent`, play
  `{"kind":"movie","tmdb_id":467905,"provider":"torrent"}`: no subtitle has `growing`, the log says
  `no English text subtitle track`, and no `notesd-cues` folder exists. Logic:
  `npx vitest run tests/unit/directStream/torrent web/src/stream/subtitles.test.tsx web/src/stream/controller.test.tsx`
  (the real ffmpeg is in `embedded.ffmpeg.test.ts`).

## Torrent fallback sites: 1337x and ext.to (torrent phase 9)
- Torrent fallback sites: when the JSON torrent indexes answer nothing usable, 1337x and ext.to are
  asked through the streaming Chrome (`claude/streaming/torrent/cli.mjs`, a background tab), side by
  side within about 40 s. Their rows pass the same release filter and ranking, and each site is an
  `Index: 1337x` / `Index: ext` attempt (`bot_check`, `error` naming `no_chrome`, `empty`, or
  candidates). Not asked at all when an index had a usable candidate. Under `up --direct-stream` the
  script is a fake (`<run>/torrent-sites/mode`: `rows`, `empty`, `bot_check`, `no_chrome`; calls in
  `evidence/torrent-sites-calls.jsonl`). Proven by
  `npx vitest run tests/unit/scripts/torrentSites.test.ts tests/unit/directStream/torrent/findSites.test.ts tests/unit/config.torrentSites.test.ts`,
  by a `provider: "torrent"` play with the fake index set to `empty` and the fake sites set to `rows`
  (the session's torrent comes from `1337x`) and to `bot_check` (both sites `bot_check`, no
  `magnets` call), and live by `node claude/streaming/torrent/cli.mjs 1337x sintel 2010` (releases with
  seeds and 40-hex `info_hash`).

## Torrent rotation, tracker scrape, RuTracker and a magnet's index
- Asking again tries the next torrents: a failed torrent play remembers what it tried per film or episode, so the
  next ask starts at the seventh candidate, and its last attempt `Torrents: not tried yet` says how many are left.
  The trackers are asked for each candidate's seeders before a swarm is joined, and one they call dead goes last.
  Proven by `npx vitest run tests/unit/directStream/torrentRotation.test.ts tests/unit/directStream/torrent/find/scrape.test.ts`,
  and live by two `provider: "torrent"` plays in a row of a title with a thin swarm: the second answer's
  `Torrent:` attempts name other releases than the first's.
- RuTracker as a third fallback site (`Index: rutracker`; `bot_check` with `login_required` until the owner ran
  `cli.mjs rutracker gate`): `npx vitest run tests/unit/scripts/torrentSites.test.ts tests/unit/directStream/torrent/findSites.test.ts`,
  and live by `node claude/streaming/torrent/cli.mjs rutracker search --title "<title>"`
  after the gate.
- `/update-cloud-source <magnet>` (`direct_stream_update_source` with `magnet`): the index by the magnet's own
  trackers, its public trackers kept in `<torrent dir>/trackers.json`, the swarm as the trackers know it. Proven by
  `npx vitest run tests/unit/directStream/torrent/origins.test.ts tests/unit/mcp.directStreamSourceTools.test.ts`
  and by the tool call on the live daemon with a RuTracker magnet (`origin.index` is `rutracker`).
- Public tracker lists (`NOTESD_TORRENT_TRACKER_LISTS`, default on, needs `NOTESD_TORRENT_DISCOVERY`): a minute after start and
  once a day ngosang `trackers_best` and newtrackon `stable` are read, each new UDP tracker gets a BEP 15 connect only,
  up to 20 that answer are kept in `<torrent dir>/tracker-lists.json` and added after the candidate's and the book's
  trackers to every torrent opened and every scrape; a failed refresh keeps the previous file. Proven by
  `npx vitest run tests/unit/directStream/torrent/trackerLists.test.ts tests/unit/directStream/torrent/find/scrape.test.ts tests/unit/directStream/torrentRotation.test.ts tests/unit/config.torrent.test.ts`
  (fake fetch, socket and clock; the two lists' real answers in `tests/fixtures/torrent/tracker-lists/`). Every throwaway
  daemon pins it off: `$V up` logs `[notesd] tracker lists off: NOTESD_TORRENT_TRACKER_LISTS=off` and its torrent folder
  holds no `tracker-lists.json`. Live: `jq '.trackers | length' <NOTESD_TORRENT_DIR>/tracker-lists.json` a minute after a
  restart, and the daemon log's `[notesd] tracker lists: N of M new trackers answered` line.

## /sync-subtitle: a subtitle checked against the film's audio
- `direct_stream_sync_subtitle` (the `/sync-subtitle` skill): Whisper hears a minute at six places of the
  film, the subtitle is judged for text (heard lines found in its cues) and timing (anchors' offsets), and a
  wrong or out-of-step one is re-timed or replaced by the first of the services' files that passes both; live
  (the session on screen gets it, `subtitle_rev` goes up) or idle (kept for the next play). Nothing changes
  unless a subtitle passed both checks. A hint (`at`, or the minute around where the player on screen is) is
  heard first: with 8 lines there, the hint and the film's two ends settle a right subtitle in three stretches
  (`heard.hint.enough`), anything else goes on to the usual places. Proven by `npx vitest run tests/unit/directStream/subtitleCheck
  tests/unit/mcp.subtitleCheckTools.test.ts tests/unit/directStream/torrent/subtitles/wyzie.test.ts` (a fake
  cutter and transcriber; real shelves in a temporary folder; another episode's file ranked last). The
  throwaway daemon has no Whisper: the tool answers `subtitle_check_off` there. A real check needs a real
  film: the session log of 2026-11-18 (FS-93) ran it on American Horror Story S01E02 from disk.

- A film not in English is heard through Whisper's translation: where the words do not settle a subtitle, the
  lines' starts do (`onsetFit` in `subtitleCheck/match.ts`, `matched_by: onsets`). Proof:
  `tests/unit/directStream/subtitleCheck/onsets.test.ts` (the film's own file in step, 33 s early and re-timed,
  another film's file, a drifting one, too few lines, never for English); on real streams, seven recorded sets of
  heard lines against seventeen files with the words blanked found 9 of 12 right files and none of 107 wrong ones.

## Wyzie Synced, and a cloud stream with no English subtitle
- A cloud stream the subtitle services have nothing for gets a growing Whisper transcript
  (`src/directStream/cloudWhisper.ts`; `GET /api/stream/subs/<title>/cues/whisper`). Proof:
  `tests/unit/directStream/cloudWhisper.test.ts` (the track at once, filled to the film's end from the
  session's own stream, the resume stretch first, stopped with the session and carried on by the next, the
  route, and the outside-subtitle path: Wyzie's `400 Invalid id` inline and late, a service that does have a
  file, Whisper off). Against a real provider: The Raid on VidRock with the services switched off, first cues
  after 27 s (2026-11-20). The throwaway daemon has no Whisper Python in its data folder, so it does not show this.
- The audio of a cloud HLS stream is cut from its segments by the daemon (`src/directStream/hlsCut.ts`,
  `hlsStretch` in `picture.ts`), for Wyzie Synced and `/sync-subtitle` alike: ffmpeg alone read 2 of 12 cloud
  streams in the subtitle soak of 2026-11-20 (PNG-wrapped segments, fragmented MP4 named like pictures, a host
  that refuses one request in four). Proof: `tests/unit/directStream/hlsCut.test.ts` (real segments made with
  ffmpeg: wrapped MPEG-TS, fMP4 with its own audio playlist, trimmed to the second, the film's end, a faltering
  host, an incomplete stretch as a failed cut); against real providers the soak driver
  (`~/mcp-notes-data/soak-2026-11-19/subs.mts run --channel cloud --redo`) heard 11 of the same 12. The
  throwaway daemon's fixture stream is plain HLS, which both paths read.
- Wyzie Synced: a torrent session's subtitle from the `service` or `borrow` tier (also when `kept` answers it
  on a replay) is re-timed behind the play. ffmpeg cuts the film's audio in 5-minute stretches,
  `claude/streaming/torrent/vad.py` (Whisper's Python) finds the speech, `POST <wyzie>/sync` answers the
  subtitle that fits; horizons 30 min, 60 min, the whole film (a 422 goes on to the next). The synced file
  is kept as `synced-<file index>.vtt` (`English (Wyzie, synced)`), the outcome as `synced-<file index>.json`
  beside it, the session's `subtitle_rev` goes up, and the open page (which reads `subtitle_rev` in the answer
  to `POST /api/stream/sessions/:id/position`) loads it without touching the film, says `Subtitles synced`
  and sets the G/H delay back to 0. `NOTESD_TORRENT_WYZIE_SYNC=off`, no key, or no Python: nothing is synced.
- A cloud session whose source shows no English subtitle gets the title's outside one (Wyzie, then the
  add-on by IMDb id): a local subtitle `English (Wyzie)` / `English (OpenSubtitles)` at
  `GET /api/stream/subs/<movie-550 | tv-1396-s1e2>/outside.vtt`, kept under
  `<data dir>/movies/stream-subs/`, reused by every later play of the title, asked for at most 4 s inline
  (later: `subtitle_rev` goes up). It is synced the same way, its audio cut from the stream (the captured
  headers) or from this machine's cache of it; the synced file is `synced.vtt`. A stream with an English
  subtitle asks nothing. `direct_stream_dialogue` reads the outside file when the source has no English track.
- Logic: `npx vitest run tests/unit/directStream/torrent/subtitles/synced.test.ts tests/unit/directStream/outsideSubtitles.test.ts tests/unit/directStream/torrentSource.test.ts tests/unit/config.torrent.test.ts web/src/stream/controller.test.tsx web/src/stream/StreamApp.test.tsx`;
  the position answer's `subtitle_rev` in `tests/integration/movies.streams.int.test.ts`.
- Throwaway daemon: `NOTESD_TORRENT_WHISPER=off NOTESD_TORRENT_WHISPER_PYTHON=$PWD/tests/fixtures/torrent/fake-vad.mjs $V up --web --torrent`,
  then `.claude/skills/verify-notesd/scripts/torrent/synced.sh RUN` (stages `torrent`, `cloud`, `english`;
  about two minutes). The fake speech detector stands in for Whisper's Python (8.5 s of "speech" in every
  10 s of the WAV ffmpeg really cut); the fake subtitle service answers `POST /sync` in mode `sync` once
  `$SUBS/sync-go` exists (`$SUBS/sync-refuse`: 422), so `scripts/stream/subtitles-synced.steps.mjs` watches the
  real page go from "Wyzie subtitle line" to "Synced subtitle line". `$DIRECT/no_subtitle` makes the fake
  resolver answer a stream with no subtitle; the cloud stage plays `hls_film`, whose host refuses a request
  without the captured Referer. The transcript ends with `synced: PASS (torrent cloud english)`.
- Real pieces, checked by hand on the owner's machine (never by a throwaway daemon): `vad.py` on five
  minutes of a library film gave the same stretches as the brief's sample, and the sample
  (`tests/fixtures/torrent-subtitles/wyzie-synced-speech.json`) through `wyzieSynced` with the real key
  answered offset -0.89 s, fps `23.976:24`, confidence 1 (one sync: 60 requests; do not repeat it idly).
- Gotcha: a sync job waits on the torrent's file route until the film is downloaded as far as it cuts; the
  loopback seeder uploads at 200 kB/s, so keep a fixture film small.

## Torrent subtitles: Whisper, the last resort

- When the torrent's subtitle file, the subtitle service, the cloud borrow and the embedded text track
  all give no English subtitle, the session answers at once with a subtitle `{label: "English (Whisper)",
  lang: "en", growing: true}` whose cues arrive stretch by stretch in phase 7's cue feed and show in the
  player as they come; once the file is transcribed to the end the feed says `complete` (the subtitle stays
  `growing: true`: it is a cue feed). English titles are
  transcribed, others translated (`task` in each worker request).
- Off: `NOTESD_TORRENT_WHISPER=off`, or no Python at `NOTESD_TORRENT_WHISPER_PYTHON`: no Whisper track,
  one daemon log line (`torrent whisper: off` / `no Python at ...`).
- Proof: `npx vitest run tests/unit/directStream/torrent/whisper.test.ts tests/unit/directStream/torrent/whisperConfig.test.ts tests/unit/scripts/installWhisper.test.ts`;
  on a run, journeys J1 and J2 of `.workflows/plan/torrent-stream-source/phase-8.md` with the fake worker
  `tests/fixtures/torrent/fake-whisper.mjs` (`NOTESD_TORRENT_WHISPER_PYTHON=<it>`,
  `NOTESD_TORRENT_WHISPER_STRETCH_S=5`; `FAKE_WHISPER_DELAY_MS`, `FAKE_WHISPER_LOG`, `FAKE_WHISPER_MODE`);
  the real model by J3 (`npx tsx scripts/whisper-sample.ts`, scratch install, never the live data dir).
- Gotcha: a run's Whisper folder is `<run>/data/whisper`, which has no venv, so the tier is off on a
  throwaway daemon unless `NOTESD_TORRENT_WHISPER_PYTHON` is set in the caller's shell (verify.sh passes
  it through). Never point it at `~/mcp-notes-data/whisper`.

## Gotchas
- Never point a throwaway daemon at the real resolver: it opens tabs in the owner's streaming Chrome.
  The live resolve is phase 1's check, run when the owner expects it; the live playback probe is
  `playcheck.mjs` (phase 6), which passes its own wrapper as `NOTESD_DIRECT_STREAM_CLI` under `--direct-stream`.
- A session lives in memory: restarting the daemon ends it (403 `unknown_session`).
- A 403 that carries `X-Notesd-Upstream` is the stream host's (an expired token: refresh); one
  without it is notesd's refusal (`unknown_session`, `forbidden_host`).
- `up --web` is required: the player is a separate bundle (`web/dist/stream.html`); without a fresh
  build `/stream/<id>` serves the wall's `index.html`.

## Reporting a stream bug from the player
- The player's error stage shows an icon-only bug button (`Report this stream bug`). A click posts
  the page's own log to `POST /api/stream/sessions/:id/report` (same-origin): the daemon writes
  phase 1's evidence snapshot at once, adds `report.json` (the page's view, the outcome) to the
  folder, and opens one tmux window `stream-bug-<id6>` running claude `--permission-mode auto` on
  `/report-stream-bug <folder>` in the mcp-notes checkout. One report per session, also after a
  restart (`409 already_reported {dir}`); no tmux or no runnable claude keeps the snapshot
  (`409 no_tmux` / `500 spawn_failed`, both with `dir`) and the page says "Report saved but not
  opened". An ended session is still reported from the page's log (`complete: false`).
- Proven by `npx vitest run tests/unit/directStream/report.test.ts tests/unit/directStream/reportRoute.test.ts web/src/stream`
  (fake tmux and snapshot; restart; concurrent clicks; address queries dropped).
- Throwaway daemon (every run's tmux is the fake `scripts/stream/fake-tmux.sh`; nothing opens on
  the owner's screen): `$V up --web --direct-stream` (note `TMUX_FAKE=`), then
  `TMUX_FAKE=<that path> $V ui RUN .claude/skills/verify-notesd/scripts/stream/report-button.steps.mjs`.
  The transcript has `BUTTON PASS`, `REPORT PASS` (one `new-window` carrying the prompt),
  `ALREADY PASS`, `NO_TMUX PASS` and `SPAWN_FAILED PASS`. Needs `claude` on PATH (the daemon checks
  the binary can run before asking tmux); elsewhere start `up` with `NOTESD_CLAUDE_BIN=$(command -v true)`.
- Live: a click on the owner's daemon opens a real Claude Code window that runs the skill and
  writes a `#stream-bug` note; it is the owner's to click.
