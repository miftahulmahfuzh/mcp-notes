# Streaming and download sites (pahe, idlix, lk21, flicksy, dramacool) and the direct-streaming resolver

## Sub-features
- `/pahe <title>`: links to a title's releases on pahe.ink. Parser proven by
  `npx vitest run tests/unit/scripts/paheSearch.test.ts`; live by
  `node claude/skills/pahe/search.mjs no other choice` (free, reads pahe.ink). The chat bar's side
  is prompt text (`tests/unit/chat-prompt.test.ts`).
- `/idlix`, `/lk21`, `/flicksy`, `/dramacool`: find a title, and start a single matching film (on
  dramacool, one episode) full screen. Matching and
  result building proven by `npx vitest run tests/unit/scripts/streamingSites.test.ts`.
- What played last time plays first, and site plays are kept: the routing by
  `npx vitest run tests/unit/directStream/rememberedChannel.test.ts`, the title match and the
  TMDB-less keeper by `npx vitest run tests/unit/streaming.sitePlays.test.ts`, the tables, the
  title page's `played_through` and the routes by
  `scripts/test-int.sh tests/integration/movies.channels.int.test.ts`, the page's line and the
  "From streaming sites" section by `npx vitest run web/src/lib/movies.test.tsx
  web/src/components/movies/SiteTitlesSection.test.tsx`. Live (plays on screen, ask first):
  `node claude/skills/dramacool/search.mjs --play summer vacation --episode 3` answers `kept`,
  then `GET /api/movies/tv-335951` shows `played_through.channel: "site"`.
- The streaming sites are the last resort of a play with no source named: a title last played on a
  site plays from a cloud provider or a torrent that has it, and a site is asked only after every
  cloud provider and every torrent found nothing (the remembered site at its page first, then a
  film idlix, lk21, flicksy, an episode idlix, dramacool, each by its own search, exactly one match;
  `several_matches` is skipped). A named provider, kind or magnet never asks a site; a `pending`
  play that fails later still falls back, and a re-ask meanwhile joins it with `starting()` busy.
  Proven with a fake runner and fake swarm by `npx vitest run tests/unit/directStream/rememberedChannel.test.ts`
  ("the streaming sites are the last resort" and `sitesToAsk`); the site-play route's shared
  `playOnSite` by `scripts/test-int.sh tests/integration/movies.guides.int.test.ts`. Live (plays on
  screen, ask first): `POST /api/stream/play` for a title no cloud provider or torrent has answers
  `{ok: true, site, site_url, site_play, attempts}` with `Site: <name>` attempts last, and the
  daemon's log has one `asked <site> for <title>` line per site.
- `streaming_find`, `streaming_play` (MCP, chat bar): proven with a fake runner by
  `npx vitest run tests/unit/mcp.streamingTools.test.ts tests/unit/streaming.test.ts`; the chat
  allow list and captions by `tests/unit/chat-status.test.ts`.
- Direct streaming, the resolver (`claude/streaming/direct/cli.mjs`): for a TMDB id, opens
  provider embeds (`providers.seed.json`) one at a time in a background tab of the streaming
  Chrome and prints the first stream found: provider, manifest, the headers its request carried,
  subtitle tracks. Providers with an English subtitle are tried first, then by health, then by
  quality; a provider that answers with a bot check is recorded as `bot_check` and passed over.
  Proven with a fake sniffer by `npx vitest run tests/unit/scripts/directResolve.test.ts`. The
  daemon side (player, pass-through, tools) is `direct-streaming.md`.

## How to get to it (user POV)
`/idlix no other choice` in Claude Code, or the same words in the wall's chat bar. The resolver
has no surface of its own: `/direct-stream` and the Stream side of `/movies` run it.

## Driving it
- A throwaway daemon has no streaming runner: both tools answer `streaming_off`. That is the
  expected proof there; do not wire the real script into a throwaway instance.
- Live lookup, free: `node claude/streaming/cli.mjs lk21 ready or not 2019`. The idlix lookup
  opens the streaming Chrome on Windows, minimized.
- Live play: `node claude/streaming/cli.mjs <site> --play <film>`. It brings Chrome to the front,
  goes full screen and plays with sound. Run it only when the owner expects it, and say so in
  the report.
- An episode on idlix, live: `node claude/streaming/cli.mjs idlix one piece --episode 787` answers
  `episode` with `season: 18` and its address (a lookup, nothing starts); `--episode 1` answers
  `episode: null` with three `episode_candidates` (two series, two seasons); with `--play` the
  one that fits starts like a film. The rules are in `tests/unit/scripts/streamingSites.test.ts`.
- Resolver order, offline: `node claude/streaming/direct/cli.mjs providers [--health <file>]`
  prints the providers in the order a resolve tries them.
- Resolver against local fixtures, no outside site: serve `tests/fixtures/direct-stream/` with
  `python3 -m http.server 7398 --bind 127.0.0.1 --directory tests/fixtures/direct-stream`, then
  `node claude/streaming/direct/cli.mjs resolve movie 550 --providers tests/fixtures/direct-stream/providers.json`:
  `FixtureCheck` ends `bot_check`, `FixtureStream` resolves (hls, 1080, English) after the
  sniffer's click. `node claude/streaming/direct/sniff.mjs 'http://localhost:7398/stream.html?id=550'`
  then shows `media.audible: 0`.
- Resolver live, free: `node claude/streaming/direct/cli.mjs resolve movie 550` (about 3 to 40 s
  per provider tried). It opens a background tab; no window comes forward and nothing is heard.
  `node claude/streaming/direct/sniff.mjs <embed url>` prints the raw capture of one embed.
- `node claude/streaming/direct/cli.mjs open <daemon url> --fullscreen` brings the streaming
  Chrome to the front: run it only when the owner expects it.

## Gotchas
- The sites change. A failing live run with passing unit tests means the site moved host
  (`IDLIX_ORIGIN`, `LK21_ORIGIN`, `FLICKSY_ORIGIN`, `DRAMACOOL_ORIGIN`) or changed its page: follow
  `claude/skills/create-streaming-skill` to look again.
- Never test against the owner's everyday Chrome. The scripts use their own profile folder.
- A resolve that fails with passing unit tests usually means a provider moved or added a check:
  `sniff.mjs <embed url>` shows what the page loaded. Providers are data; never add a user agent,
  header or click to get past a check.
- The sniffer mutes the pages it opens with a script installed before the page runs, not with
  Chrome's mute switch, which would also mute a film the owner is watching in the same Chrome.
- The sniffer's tab is a background tab, which Chrome treats as hidden: it drops mouse events sent
  to it and never reports its title. `sniff.ps1` therefore turns on focus emulation for that tab
  and asks the page for `document.title`. Without either, the fixture run ends `no_stream` twice.
- Starting an `/idlix`, `/lk21`, `/flicksy` or `/dramacool` film closes every other tab in the streaming Chrome, a
  resolver's tab included: that resolve answers `no_stream` for the provider it was on.
