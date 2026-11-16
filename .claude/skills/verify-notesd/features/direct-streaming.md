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
  401/403/410. Logic proven by `npx vitest run web/src/stream tests/unit/static.test.ts`.
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
  (`window.notesdStream` and the title), `J3 PASS` (403 with `X-Notesd-Upstream` mid-film, one
  refresh, continues at 100 s), `J2 PASS` (`.srt` as WebVTT), `MUTED PASS` (`?muted=1`) and `CDN PASS`.
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

## Gotchas
- Never point a throwaway daemon at the real resolver: it opens tabs in the owner's streaming Chrome.
  The live resolve is phase 1's check, run when the owner expects it; the live playback probe is
  `playcheck.mjs` (phase 6), which passes its own wrapper as `NOTESD_DIRECT_STREAM_CLI` under `--direct-stream`.
- A session lives in memory: restarting the daemon ends it (403 `unknown_session`).
- A 403 that carries `X-Notesd-Upstream` is the stream host's (an expired token: refresh); one
  without it is notesd's refusal (`unknown_session`, `forbidden_host`).
- `up --web` is required: the player is a separate bundle (`web/dist/stream.html`); without a fresh
  build `/stream/<id>` serves the wall's `index.html`.
