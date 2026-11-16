# Phase 6 addendum: Wyzie Subs ahead of the keyless OpenSubtitles add-on

From the owner, 2026-11-16, handed over by the planning session (`analyze-torrent-stream-source`) after the
plan set was reconciled. It is part of phase 6 and has the same weight as `phase-6.md`. It adds to phase 6's
own files only: no other phase changes, no new dependency edge. It replaces the index's old Decisions row
that left Wyzie out.

The owner bought a Wyzie Pro key and put it in `/home/miftah/mcp-notes/.env.local` as `WYZIE_API_KEY`.

## What to build

- A second service in the `service` tier (`src/directStream/torrent/subtitles/service.ts` or a sibling
  `wyzie.ts`): when `config.torrent.wyzieKey` is set, ask Wyzie first; when it answers nothing usable, fails
  or times out, go on to the keyless add-on as planned. With no key the tier behaves exactly as planned.
  Attempts read `Subtitles: service` with a detail naming which service answered (`wyzie` / `opensubtitles`).
- Setting: `WYZIE_API_KEY` (a secret, read from `.env.local` like `OPENROUTER_API_KEY`; unset = Wyzie off).
  Add its row to `docs/guide/reference/configuration.md` (`docs:check` fails on an undocumented variable).
  Never log the key or write it into attempts, evidence or the kept subtitle's `chosen.json`; download
  addresses carry a `tok` query, so log hosts and paths only.
- `TorrentConfig` field order: `wyzieKey` (and the base address, if it is a field) right after phase 6's
  `subtitleUrl`.
- It stays inside the 40 s blocking budget the chain already has: give the Wyzie step at most 12 s.

## The API (probed live on 2026-11-16 with the owner's key; all answered 200)

- `GET https://sub.wyzie.io/search?id=<tt IMDb id or TMDB id>&language=en&format=srt&key=<key>`; for an
  episode add `&season=<n>&episode=<n>` (both together). The base address is a setting, default
  `https://sub.wyzie.io`.
- Answer: a JSON array. Each item: `id`, `url` (a direct download on `sub.wyzie.io/c/...`, returns the file
  as SRT, UTF-8), `format` (`srt` | `sub` | `ssa` | `txt`: ask `format=srt` and still check), `language`
  (`"en"`), `display`, `isHearingImpaired` (bool), `source`, `release`, `releases[]` (release and file
  names), `fileName`, `origin` (BluRay, WEB-DL, DVD), `downloadCount`, `matchedRelease`, `quality`
  (`{score, flags}` or null), `ai` (bool).
- Drop items with `ai: true` (machine translations) and anything whose language is not `en`.
- `source`: the default is `charlie` only (1 request, about 1 s). `source=all` asks all 12 live sources the
  Pro key may use (12 requests, about 8 s, and one source timed out in the probe: header
  `X-Sources-Timed-Out`). First request with the default source; only when it gives no English `.srt`, a
  second with `source=all`. Response headers `X-Wyzie-Cost`, `X-Wyzie-Balance`, `X-Wyzie-Plan` exist; the
  balance was 1,999,960 requests, so cost is no concern.
- The `release=` filter exists but took 13 s and matched loosely: do not use it. Rank on our side, the way
  the add-on results are ranked in the plan: most tokens shared between the torrent's release name and the
  item's `release` / `releases` / `fileName`, then same origin (BluRay vs WEB), then not hearing-impaired
  before hearing-impaired, then `downloadCount`.
- Errors: 401 without a key, 503 "Source temporarily offline" when only paused sources were named; treat any
  non-200 or non-array as a failure of this step and go on.
- A real request says it is notesd (the same User-Agent as the other tiers). Invariant 6 holds.
- Sample answers from the probe are in
  `/home/miftah/mcp-notes/.workflows/orchestration/torrent-stream-source/logs/wyzie-samples/`
  (`catchme-en.json`, `sintel-en.json`, `bb-s1e1.json`, `tmdb-fightclub.json`; untracked, this machine only).
  Cut a small fixture from `sintel-en.json` for the tests; strip the `tok` and anything key-like from the
  fixture's urls before committing it.

## Tests and proof

- Unit: with a key and a fake fetch, Wyzie is asked first and its best English `.srt` is served; `ai` items
  and the hearing-impaired ordering; a Wyzie failure falls through to the add-on; no key means Wyzie is
  never asked. Invariant 3 holds: no test or journey of `npm test` / `test:int` / the throwaway daemon asks
  the real Wyzie; the verify harness's fake subtitle service answers `/search` too. One journey line under
  R3.3 (it already owns "fetch an English subtitle from a subtitle service").
- Docs: one sentence in phase 6's guide subsection, and the configuration row.

## Not in this update

- Wyzie Synced (`POST /sync`: re-times a subtitle to the file's audio). The owner has not asked for it; do
  not build it.
