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
- Off: `NOTESD_DIRECT_STREAM=off` or `NOTESD_MOVIES=off` answers 503 `direct_stream_off` on every
  `/api/stream/*` route, and nothing is built that could start Chrome
  (`npx vitest run tests/unit/directStream/build.test.ts`).
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

## How to get to it (user POV)
Play on a stream (phase 9) or `/direct-stream <title>` (phase 7) opens the player page full screen in
the streaming Chrome. Underneath, both call `POST /api/stream/play` from the wall's origin.

## Driving it with verify.sh
- `$V up --direct-stream` (implies `--movies`): `up` prints `DIRECT=<run>/direct`. The fixture stream
  host listens on two ports of 127.0.0.1 and answers 403 without `Referer: https://embed.fixture/`; the
  fake resolver returns addresses on the first port, the second is named only inside the playlists.
  `echo dash > $DIRECT/mode` (or `no_source`, `no_chrome`) picks the next resolve's answer.
- `.claude/skills/verify-notesd/scripts/direct-stream/journey.sh RUN [seed|hls|dash|refuse]`: every check,
  saved as evidence; ends with `journey: PASS (...)`. Run `seed` first on a fresh run (it counts health
  after exactly one play).
- Every run without `--direct-stream` pins `NOTESD_DIRECT_STREAM=off`, so `$V up --movies` alone shows the
  off answer: `$V api RUN POST /api/stream/play '{"kind":"movie","tmdb_id":550}'` answers 503.
- `down` copies `upstream.jsonl` and `calls.jsonl` into the evidence folder.

## Gotchas
- Never point a throwaway daemon at the real resolver: it opens tabs in the owner's streaming Chrome.
  The live resolve is phase 1's check, run when the owner expects it; the live playback probe is
  `playcheck.mjs` (phase 6), which passes its own wrapper as `NOTESD_DIRECT_STREAM_CLI` under `--direct-stream`.
- A session lives in memory: restarting the daemon ends it (403 `unknown_session`).
- A 403 that carries `X-Notesd-Upstream` is the stream host's (an expired token: refresh); one
  without it is notesd's refusal (`unknown_session`, `forbidden_host`).
