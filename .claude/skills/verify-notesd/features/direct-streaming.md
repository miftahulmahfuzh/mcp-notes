# Direct streaming (provider registry, play, sessions, the pass-through)

## Sub-features
- Provider registry: `claude/streaming/direct/providers.seed.json` is loaded into `stream_providers`
  at every start (shared by both machines; seed rows have `origin_site` null); health per provider
  and host in `stream_provider_health`, written after every resolve. Proven by
  `npm run test:int -- tests/integration/directStream.repo.int.test.ts` and `journey.sh RUN seed`.
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
  English subtitle shown by default (inside the manifest first, then a separate `.vtt`/`.srt`), a
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

## /report-stream-bug (a stream's evidence, the cause, a note)
- `claude/skills/report-stream-bug/collect.sh [SNAPSHOT_DIR]` gathers the snapshot (the folder it
  is handed, else a new one from `POST /api/stream/evidence/snapshot`), the session's records
  (`GET /api/stream/evidence`, and the on-disk log's tail), the daemon's direct-stream lines with
  every query cut off, and `network.json` (a reference download, the stream through the session,
  the stream host's first answer) into one folder, and prints a summary with the cause. With the
  daemon down or the session ended it still writes the log tail and the measurement, and `missing:`
  says what is not there. No file in the folder holds a pass-through address or a token.
- `diagnose.mjs classify|summary|note DIR` names the cause (`connection_slow`, `host_slow`,
  `token_expired`, `provider_broken`, `session_ended`, `new`); the skill saves the note it writes
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
  files by index, resume after a restart. `GET /api/stream/cache[/:id]` lists both machines'
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
