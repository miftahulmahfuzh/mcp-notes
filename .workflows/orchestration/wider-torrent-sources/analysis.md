# Code Analysis: torrent sources behind TM / TS (indexes, add-on providers, tracker lists)

**Type:** Feature Implementation
**Date:** 2026-11-19 02:54 WIB
**Session ID:** 20261119-025431-K7QD
**Plan:** `.workflows/plan/WIDER_TORRENT_SOURCES_PLAN.md` (3 phases)
**Worktree:** `/home/miftah/.worktrees/mcp-notes/wider-torrent-sources` on `feature/wider-torrent-sources` (base `origin/main` @ `24687f1`)

---

## User Input

### Original User Request
this so we implement the most robust approach:
our primary objective here is to improve our TM / TS in anyway shape or form (more indexes, more providers, more tracker lists, etc)
start cooking

### User-Provided Context
The request follows a conversation in the same session: the owner proposed installing Stremio on WSL to copy magnets
out of it and feed them to `/update-cloud-source`. The answer given there, and the facts it rests on: Stremio holds
no torrents itself, its results come from add-ons that answer an open JSON protocol
(`/stream/<type>/<imdb id>.json`), and the finder already asks the main one (Torrentio). "this" in the request is
the list of things that answer offered as real ways to widen the torrent side: more Stremio add-ons as JSON indexes,
and Torrentio-style tracker lists kept for every torrent.

### User-Provided Files
None.

### Requirement IDs
| ID | What the user asked for (verbatim) |
|---|---|
| R1 | "improve our TM / TS in anyway shape or form (more indexes" |
| R2 | "more providers" |
| R3 | "more tracker lists, etc)" |

"etc" and "the most robust approach" are read as a quality bar on all three, not a fourth deliverable: every new
source can be turned off, and its failure never blocks or delays a play (criteria R1.3, R2.3, R3.3).

#### Acceptance Criteria
| ID | Pattern | Criterion |
|---|---|---|
| R1.1 | event | WHEN the torrent finder is asked for a film or an episode THE SYSTEM SHALL ask Knaben, Bitsearch and torrents-csv by title (a film by title and year, an episode by title and SxxEyy) side by side with the existing JSON indexes and report one attempt per index under its own name |
| R1.2 | unwanted | IF a title-search index lists a release of another title, another year's film of the same name or another episode THEN THE SYSTEM SHALL leave it out of the candidates with an exclude reason and never open it |
| R1.3 | unwanted | IF a title-search index fails, times out or answers a bot check THEN THE SYSTEM SHALL record that outcome in its attempt, still answer the other indexes' candidates, and never retry it with a disguised client |
| R1.4 | optional | WHERE `NOTESD_TORRENT_KNABEN_URL`, `NOTESD_TORRENT_BITSEARCH_URL` or `NOTESD_TORRENT_TORRENTSCSV_URL` is `off` THE SYSTEM SHALL send no request to that index |
| R2.1 | event | WHEN the torrent finder is asked for a film or an episode THE SYSTEM SHALL ask the TorrentsDB Stremio add-on by IMDb id and join its listings with the other indexes' by info hash, so one torrent listed twice is one candidate naming both in `listedBy` |
| R2.2 | optional | WHERE the title's original language is Spanish THE SYSTEM SHALL also ask the Peerflix Stremio add-on by IMDb id, and for any other original language send Peerflix no request |
| R2.3 | unwanted | IF a Stremio add-on provider fails, times out or answers a bot check THEN THE SYSTEM SHALL record that outcome in its attempt and still answer the other indexes' candidates |
| R2.4 | optional | WHERE `NOTESD_TORRENT_TORRENTSDB_URL` or `NOTESD_TORRENT_PEERFLIX_URL` is `off` THE SYSTEM SHALL send no request to that provider |
| R3.1 | event | WHEN the daemon starts with torrents and discovery on, and once a day after that, THE SYSTEM SHALL fetch the public tracker lists (ngosang `trackers_best`, newtrackon `stable`), keep the UDP trackers that answer a BEP 15 connect, and store them in `<torrent dir>/tracker-lists.json` |
| R3.2 | event | WHEN a torrent is opened or its candidates are scraped THE SYSTEM SHALL add the kept list trackers after the candidate's own trackers and the tracker book's, without repeats |
| R3.3 | unwanted | IF a tracker list cannot be fetched or no tracker answers THEN THE SYSTEM SHALL keep the previously stored trackers and neither delay nor fail any play |
| R3.4 | optional | WHERE `NOTESD_TORRENT_TRACKER_LISTS` is `off` or `NOTESD_TORRENT_DISCOVERY` is `off` THE SYSTEM SHALL fetch no list and add no list tracker |

---

## Detailed Requirements Understanding

**Problem/Requirement Statement**: A TM / TS play (`direct_stream_play` with `provider: "torrent"`) finds its
torrents through `findCandidates` (`src/directStream/torrent/find/find.ts`), which today asks four JSON indexes by
IMDb id (Torrentio, apibay, EZTV, YTS) and three browser-driven fallback sites. Every opened torrent announces to the
candidate's own trackers, seven hard-coded `DEFAULT_TRACKERS` and the tracker book (trackers learned from pasted
magnets). The request is to widen all three inputs: indexes, aggregating providers, and trackers.

**Success Criteria**: the twelve criteria above. In short: five new JSON sources answer candidates into the same
ranking; a daily job keeps a verified public tracker list that every open and scrape uses; each is switchable and
none can fail a play.

**Key Considerations**:
- Three of the new sources (Knaben, Bitsearch, torrents-csv) search by **title**, not IMDb id. Today only the browser
  sites do that, and their matching lives in `claude/streaming/torrent/match.mjs`, outside the daemon. Inside the
  finder, `rankCandidates` excludes `other_title` by a substring test of the normalized title
  (`namesTitle`, `find/rank.ts`) and checks the episode, but has no year check for films: a title search for a
  film whose name is shared by another year's film (or is a common word) would pass.
- Peerflix lists Spanish releases; nearly all are Castilian dubs. Direct streaming plays original language only, so
  for a non-Spanish title its listings would all be `dubbed` or last-resort noise.
- Every index request must say it is notesd (`TORRENT_INDEX_USER_AGENT`); a bot check is the outcome `bot_check`.
- A throwaway daemon (`verify.sh up --torrent`) and every unit test must not reach the real network: the harness
  sets each index's address to a fake or `off` by name (verify.sh:336-344), so a new index that defaults on would
  be asked for real there unless the harness names it too.
- Assumption: the public instances probed on 2026-11-19 (below) stay reachable from the owner's networks; each has
  its own address setting so a moved host is a config change.

---

## Probe evidence (2026-11-19, from this machine, plain curl)

Trimmed real answers are saved beside this file in `.workflows/analyze/20261119-025431-K7QD-samples/`.

| Source | Request | Answer |
|---|---|---|
| TorrentsDB | `GET https://torrentsdb.com/stream/movie/tt0111161.json` | 200 JSON, 96 streams in Torrentio's shape (`name`, `title` with 👤 💾 ⚙️, `infoHash` sometimes upper case, `fileIdx`, `behaviorHints.filename`, `sources` on 47). Sites: knaben 34, rargb 33, ThePirateBay 11, sktorrent 7, rutor 5, ilcorsaronero 2, limetorrent 2, kickasstorrents 1, YTS 1. 7 info hashes Torrentio's 500 did not hold. |
| Peerflix | `GET https://addon.peerflix.mov/stream/movie/tt0111161.json` | 200 JSON, 174 streams, same shape but the stats line ends `🌐 <site>` instead of `⚙️ <site>`, a flag line (🇪🇸) before it, and some rows have no 💾. Almost all Castilian dubs. |
| Knaben | `POST https://api.knaben.org/v1` JSON body `{search_type:"100%", search_field:"title", query, order_by:"seeders", order_direction:"desc", size, hide_unsafe, hide_xxx}` | 200 JSON `{hits:[{hash, title, bytes, seeders, peers, magnetUrl (with tr=), tracker, cachedOrigin, category, categoryId, ...}], total}` |
| Bitsearch | `GET https://bitsearch.to/api/v1/search?q=<q>&sort=seeders` | 200 JSON `{success, results:[{infohash, title, size, seeders, leechers, category, verified, ...}], pagination}`. `solidtorrents.to/api/v1/search` answers the identical body (one backend): only one of them is worth asking. |
| torrents-csv | `GET https://torrents-csv.com/service/search?q=<q>&size=<n>` | 200 JSON `{torrents:[{infohash, name, size_bytes, seeders, leechers, completed, scraped_date, ...}], next}` |
| ngosang list | `GET https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt` | 200 text, one tracker per line with blank lines between, 18 trackers |
| newtrackon | `GET https://newtrackon.com/api/stable` | 200 text, same format, ~50 trackers (udp, http, https) |
| MediaFusion | `GET https://mediafusion.elfhosted.com/stream/movie/tt0111161.json` | 200 `{"streams":[]}`: needs a per-user config in the address. Not usable as is. |
| Comet | `GET https://comet.elfhosted.com/stream/movie/tt0111161.json` | 403. Not usable. |
| Nyaa RSS | `GET https://nyaa.si/?page=rss&q=...` | timed out at 25 s from this network. Torrentio already lists NyaaSi (seen on `series/tt22248376:1:1`). |

---

## Analysis Scope

### Explicitly Mentioned Files
None.

### Discovered Related Files
- `src/directStream/torrent/find/find.ts` — `findCandidates`, `defaultIndexes`, `IndexBases`, `DEFAULT_INDEX_BASES`, `IndexHealth`
- `src/directStream/torrent/find/types.ts` — `TorrentQuery`, `IndexRow`, `TorrentCandidate`, `TorrentIndex`, `IndexContext`, `IndexFetch`
- `src/directStream/torrent/find/torrentio.ts` — `readTorrentioStream`, `torrentioIndex`
- `src/directStream/torrent/find/apibay.ts`, `eztv.ts`, `yts.ts` — the other three index modules
- `src/directStream/torrent/find/candidate.ts` — `DEFAULT_TRACKERS`, `candidateFrom`, `normalizeInfoHash`, `answerOf`
- `src/directStream/torrent/find/http.ts` — `getIndexJson` (GET only), `isBotCheck`, `trackersFromMagnet`, `as*` readers
- `src/directStream/torrent/find/rank.ts` — `rankCandidates`, `joinListings`, `namesTitle`, `exclusionOf`
- `src/directStream/torrent/find/release.ts` — `parseRelease`, `episodeFitOf`
- `src/directStream/torrent/find/scrape.ts` — BEP 15 `udpScraper`, `udpTrackerOf`, `udpTrackers`, `connectPacket`, `SCRAPE_MAX_TRACKERS = 8`
- `src/directStream/torrent/find/index.ts` — the barrel
- `src/directStream/torrent/origins.ts` — `TrackerBook`, `trackerKey`, `trackerHost`, `TRACKER_BOOK_FILE`
- `src/directStream/torrent/source.ts` — `TorrentSource` (`trackersOf` :479, `swarmCounts` :484, `learnMagnet` :501), `indexesOf` :1056, `buildTorrentSource` :1063
- `src/directStream/torrent/engine.ts` — WebTorrent options (`dht`, `tracker`, `announce: spec.trackers`) :189, :258
- `src/config.ts` — `TORRENT_INDEX_NAMES` :336, `TorrentFinderConfig` :343, `TORRENT_INDEX_URL_KEYS` :357, `parseTorrentFinder` :365, torrent block :421-440 and :1092-1104
- `src/background.ts` — where daily loops start and close (trending :216-220, :271)
- `src/daemon.ts` — builds the torrent source and the background deps
- `src/directStream/trending/sources.ts`, `job.ts` — a daily job with injected sources and clock (the pattern in the repo for one)
- `docs/guide/streaming.md` — "Playing from a torrent" :1713 (names the four indexes at :1800), "What a magnet says of its index" :2178
- `docs/guide/reference/configuration.md` — index rows :177-180, torrent rows :167-173
- `.claude/skills/verify-notesd/scripts/verify.sh` :336-344 — sets the four index addresses per mode
- `.claude/skills/verify-notesd/scripts/torrent/fake-index.mjs` — the fake Torrentio/apibay/EZTV
- `.claude/skills/verify-notesd/features/direct-streaming.md` — the feature map
- Tests: `tests/unit/directStream/torrent/find/{findCandidates,indexes,indexHealth,rank,scrape}.test.ts`, `tests/unit/directStream/torrent/origins.test.ts`, `tests/unit/directStream/torrentSource.test.ts`, `torrentRotation.test.ts`; fixtures `tests/fixtures/torrent/*.json`

---

## Current Dataflow

### Entry Point: `TorrentSource.resolve` → `find`

**Location:** `src/directStream/torrent/source.ts:1086` (`buildTorrentSource` wires `find` to `findCandidates`)
**Trigger:** a torrent play (`direct_stream_play` `provider: "torrent"`, the play route, fetch-ahead)
**Input Schema:** `TorrentQuery`: `imdbId`, `kind`, optional `title`, `originalTitle`, `year`, `originalLanguage`; for tv `season`, `episode`, `absoluteEpisode`, `alt`
**Next Step:** `findCandidates(query, { indexes, health, fallback, tried, minSeeds, maxSizeBytes, timeoutMs })`

### Processing Chain

1. **`indexesOf(finder)`** — `source.ts:1056`. Reads `config.torrent.finder.indexes` (a `Partial<Record<TorrentIndexName, string | null>>`): a string replaces the address, `null` (`off`) removes the index. Calls `defaultIndexes({ bases, yts })` and filters by name.
2. **`defaultIndexes`** — `find.ts:111`. Returns `torrentioIndex`, `apibayIndex`, `eztvIndex` and, unless `yts === false`, `ytsIndex`, each at `bases.<name> ?? DEFAULT_INDEX_BASES.<name>`.
3. **`findCandidates`** — `find.ts:196`. Normalizes the IMDb id, filters indexes by `kinds`, `askAll` in parallel. `askOne` (:139) gives each index an `IndexContext` whose `fetch(url, init?)` forces notesd's User-Agent, defaults `accept: application/json`, binds the timeout signal, and **passes only `headers` and `signal` to the real fetch**: `IndexFetch`'s init type is `{ headers? }` and `FetchLike`'s is `{ headers, signal }`, so an index cannot send a method or a body today. A thrown error or the timeout becomes outcome `error`; `IndexHealth.record` counts consecutive errors and skips the index for 30 min after 3.
4. **Index module `find`** — e.g. `torrentio.ts:50`: builds `/stream/movie/<imdb>.json` or `/stream/series/<imdb>:<s>:<e>.json` (using `query.alt` when set), `getIndexJson`, maps each stream through `readTorrentioStream` to an `IndexRow`, then `candidateFrom(row, 'torrentio', query, query.kind === 'tv')` (`scoped` true for a series address).
   - `readTorrentioStream` (:13) reads the site from the stats line with `SITE = /⚙️?\s*(.+)$/u` and requires a line with 👤 or 💾 to find the stats; the release name is the first title line; trackers are the `sources` entries that start `tracker:`.
5. **`candidateFrom`** — `candidate.ts:55`. Normalizes the hash (hex any case, or base32), clamps seeds, appends `DEFAULT_TRACKERS` to the row's trackers, parses the release.
6. **`rankCandidates`** — `rank.ts`. Groups by info hash and `joinListings` (max seeds, union of `listedBy` and `trackers`, `scoped` if any). `exclusionOf` leaves out `bad_hash`, `other_title` (`namesTitle`: the normalized title or original title must be a substring of name + file name), `dubbed`, `cam`, `three_d`, `other_episode`, `few_seeds`, `too_big`. Dub-named but otherwise fitting releases go to `lastResort`.
7. **Fallback** — `find.ts:214`: when every kept candidate is in `tried` (or none is kept) the browser sites are asked.
8. **Back in `TorrentSource`** — `swarmCounts` (:484) scrapes `[...DEFAULT_TRACKERS, ...book.list(), ...candidates' trackers]` through `udpScraper`, which asks only the first `SCRAPE_MAX_TRACKERS` (8) distinct UDP trackers of that list within `SCRAPE_TIMEOUT_MS` (1.5 s); candidates no tracker knows a seeder for go last (`deadLast`). Each open passes `trackersOf(c)` (:479) = candidate trackers + book to `swarm.open` → `engine.add` → WebTorrent `announce`.

### Data Persistence
- No database write in the finder. `IndexHealth` and the tried-torrent memory are in memory per daemon run.
- The tracker book is one JSON file, `<config.torrent.dir>/trackers.json` (`TrackerBook`, `origins.ts`): `{ trackers: [{ url, added_at, from }] }`, UDP only, at most `TRACKER_BOOK_MAX` (40), written only by `learnMagnet` after a tracker answered a scrape.

### Exit Points
- `FoundCandidates { candidates, indexes: IndexAttempt[], excluded, lastResort }`; the attempts become `Index: <name>` lines of a play's attempt list.

---

## Key Data Structures

### `TorrentIndex` — `find/types.ts:150`
`{ name; kinds?; timeoutMs?; find(query, ctx): Promise<IndexAnswer> }`. Used by every index module, `find-sites.ts` (the fallback sites) and tests.

### `IndexRow` — `find/types.ts:84`
`{ infoHash; name; fileName?; fileIdx?; seeds; sizeBytes; trackers?; site?; hints? }`.

### `IndexBases` / `DEFAULT_INDEX_BASES` — `find.ts:67,75`
One address per default index; mirrored by `TORRENT_INDEX_NAMES` and `TORRENT_INDEX_URL_KEYS` in `src/config.ts` (each env name spelled out so `docs:check` finds it).

### `TrackerBook` — `origins.ts:118`
`list()`, `has(url)`, `add(urls, from)`; reading never throws.

---

## Dependencies

### Configuration / Environment
`NOTESD_TORRENT`, `NOTESD_TORRENT_DISCOVERY`, `NOTESD_TORRENT_DIR`, `NOTESD_TORRENT_INDEX_TIMEOUT_MS`, `NOTESD_TORRENT_MIN_SEEDS`, `NOTESD_TORRENT_MAX_GB`, `NOTESD_TORRENT_{TORRENTIO,APIBAY,EZTV,YTS}_URL`. Every variable has a row in `docs/guide/reference/configuration.md`; `tests/unit/docs/reference.test.ts` fails `npm test` on a variable without one.

### External Services
Torrentio, apibay, EZTV, YTS (HTTP JSON); UDP trackers (BEP 15 scrape); DHT through WebTorrent.

---

## Reference List

| Symbol / key | File:line | Kind | Package |
|---|---|---|---|
| `defaultIndexes` | `src/directStream/torrent/find/find.ts:111` | def | torrent/find |
| `defaultIndexes` | `src/directStream/torrent/source.ts:1059` | call | torrent |
| `IndexBases`, `DEFAULT_INDEX_BASES` | `find/find.ts:67,75` | def | torrent/find |
| `TORRENT_INDEX_NAMES` | `src/config.ts:336`; `source.ts:2,1058` | def · call | config, torrent |
| `TORRENT_INDEX_URL_KEYS` | `src/config.ts:357` | def | config |
| `readTorrentioStream`, `torrentioIndex` | `find/torrentio.ts:13,50` | def | torrent/find |
| `IndexFetch`, `FetchLike` | `find/types.ts:137,163`; `find/find.ts:156-161` | def · impl | torrent/find |
| `getIndexJson` | `find/http.ts` | def | torrent/find |
| `namesTitle`, `exclusionOf` | `find/rank.ts` | def | torrent/find |
| `DEFAULT_TRACKERS` | `find/candidate.ts:9`; `origins.ts`; `source.ts:487,503,506,521` | def · call | torrent |
| `trackersOf`, `swarmCounts` | `source.ts:479,484` | def | torrent |
| `SCRAPE_MAX_TRACKERS` | `find/scrape.ts` | def | torrent/find |
| `TrackerBook`, `TRACKER_BOOK_FILE` | `origins.ts`; `source.ts:1103` | def · call | torrent |
| index address env per mode | `.claude/skills/verify-notesd/scripts/verify.sh:336-344` | config | verify harness |
| index rows | `docs/guide/reference/configuration.md:177-180` | doc | docs |
| the four indexes named | `docs/guide/streaming.md:1800` | doc | docs |
| index fixtures | `tests/fixtures/torrent/*.json`; `tests/unit/directStream/torrent/find/indexes.test.ts`, `findCandidates.test.ts` | test | tests |

---

## Impact Points (files that WILL need changes)
1. `src/directStream/torrent/find/torrentio.ts` — the Stremio add-on reader is specific to Torrentio's stats line (phase 1)
2. new add-on provider modules under `find/`, `find/index.ts` barrel (phase 1; phase 2 adds its own exports)
3. `src/directStream/torrent/find/find.ts` — `IndexBases`, `DEFAULT_INDEX_BASES`, `defaultIndexes` (phase 1, then phase 2); `askOne`'s fetch drops method and body (phase 2)
4. `src/directStream/torrent/find/types.ts` — `IndexFetch` / `FetchLike` init (phase 2)
5. new title-search index modules and a shared title-query/fit helper under `find/`; `find/rank.ts` if the year check lands there (phase 2)
6. `src/config.ts` — `TORRENT_INDEX_NAMES`, `TORRENT_INDEX_URL_KEYS` (phase 1, then phase 2); the torrent block's new tracker-lists switch (phase 3)
7. `src/directStream/torrent/source.ts` — `indexesOf` comment/behaviour (phase 1, 2); `trackersOf`, `swarmCounts`, `buildTorrentSource` (phase 3)
8. new tracker-lists module beside `origins.ts`; `find/scrape.ts` for a connect-only liveness check; `src/background.ts` and `src/daemon.ts` for the daily loop (phase 3)
9. `docs/guide/reference/configuration.md`, `docs/guide/streaming.md`, `CLAUDE.md` (all three phases, different rows/sections)
10. `.claude/skills/verify-notesd/scripts/verify.sh`, `scripts/torrent/fake-index.mjs`, `features/direct-streaming.md` (all three phases)
11. tests and fixtures under `tests/unit/directStream/torrent/` and `tests/fixtures/torrent/` (all three phases)

**This document describes. The plan files prescribe.**
