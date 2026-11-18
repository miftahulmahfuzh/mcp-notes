# Plan: Wider torrent sources for TM / TS

**Slug:** wider-torrent-sources
**Date:** 2026-11-19 02:54 WIB
**Analysis:** `.workflows/analyze/20261119-025431-K7QD_code_analyzer.md`
**Worktree:** `/home/miftah/.worktrees/mcp-notes/wider-torrent-sources`
**Branch:** `feature/wider-torrent-sources` (base: `origin/main` @ `24687f1`)
**Phases:** 3
**Status:** phase 1/3 complete
**Coordinator:** —

---

## Why

this so we implement the most robust approach:
our primary objective here is to improve our TM / TS in anyway shape or form (more indexes, more providers, more tracker lists, etc)
start cooking

## Requirements

| ID | What the user asked for (verbatim) | Phases |
|---|---|---|
| R1 | "improve our TM / TS in anyway shape or form (more indexes" | 2 |
| R2 | "more providers" | 1 |
| R3 | "more tracker lists, etc)" | 3 |

"etc" and "the most robust approach" are read as a quality bar on all three (each source switchable, no failure
blocks a play), carried by R1.3, R2.3 and R3.3.

### Acceptance Criteria

| ID | Pattern | Criterion | Phases | Journeys |
|---|---|---|---|---|
| R1.1 | event | WHEN the torrent finder is asked for a film or an episode THE SYSTEM SHALL ask Knaben, Bitsearch and torrents-csv by title (a film by title and year, an episode by title and SxxEyy) side by side with the existing JSON indexes and report one attempt per index under its own name | 2 | P2.J1 |
| R1.2 | unwanted | IF a title-search index lists a release of another title, another year's film of the same name or another episode THEN THE SYSTEM SHALL leave it out of the candidates with an exclude reason and never open it | 2 | P2.J2 |
| R1.3 | unwanted | IF a title-search index fails, times out or answers a bot check THEN THE SYSTEM SHALL record that outcome in its attempt, still answer the other indexes' candidates, and never retry it with a disguised client | 2 | P2.J3 |
| R1.4 | optional | WHERE `NOTESD_TORRENT_KNABEN_URL`, `NOTESD_TORRENT_BITSEARCH_URL` or `NOTESD_TORRENT_TORRENTSCSV_URL` is `off` THE SYSTEM SHALL send no request to that index | 2 | P2.J4 |
| R2.1 | event | WHEN the torrent finder is asked for a film or an episode THE SYSTEM SHALL ask the TorrentsDB Stremio add-on by IMDb id and join its listings with the other indexes' by info hash, so one torrent listed twice is one candidate naming both in `listedBy` | 1 | P1.J1, P1.J5 |
| R2.2 | optional | WHERE the title's original language is Spanish THE SYSTEM SHALL also ask the Peerflix Stremio add-on by IMDb id, and for any other original language send Peerflix no request | 1 | P1.J2, P1.J5 |
| R2.3 | unwanted | IF a Stremio add-on provider fails, times out or answers a bot check THEN THE SYSTEM SHALL record that outcome in its attempt and still answer the other indexes' candidates | 1 | P1.J3 |
| R2.4 | optional | WHERE `NOTESD_TORRENT_TORRENTSDB_URL` or `NOTESD_TORRENT_PEERFLIX_URL` is `off` THE SYSTEM SHALL send no request to that provider | 1 | P1.J4, P1.J5 |
| R3.1 | event | WHEN the daemon starts with torrents and discovery on, and once a day after that, THE SYSTEM SHALL fetch the public tracker lists (ngosang `trackers_best`, newtrackon `stable`), keep the UDP trackers that answer a BEP 15 connect, and store them in `<torrent dir>/tracker-lists.json` | 3 | P3.J1 |
| R3.2 | event | WHEN a torrent is opened or its candidates are scraped THE SYSTEM SHALL add the kept list trackers after the candidate's own trackers and the tracker book's, without repeats | 3 | P3.J2 |
| R3.3 | unwanted | IF a tracker list cannot be fetched or no tracker answers THEN THE SYSTEM SHALL keep the previously stored trackers and neither delay nor fail any play | 3 | P3.J3 |
| R3.4 | optional | WHERE `NOTESD_TORRENT_TRACKER_LISTS` is `off` or `NOTESD_TORRENT_DISCOVERY` is `off` THE SYSTEM SHALL fetch no list and add no list tracker | 3 | P3.J4, P3.J5 |

## Scope

**In scope:**
- Two Stremio add-on providers asked by IMDb id: TorrentsDB (always) and Peerflix (Spanish-original titles only).
- Three title-search JSON indexes: Knaben, Bitsearch, torrents-csv, with a year/episode fit strict enough for a title search.
- A daily public tracker list (ngosang `trackers_best`, newtrackon `stable`), verified by a BEP 15 connect, used by every open and scrape.
- One address setting per new source and one switch for the tracker lists, documented; the verify harness and the guides kept in step.

**Out of scope:**
- Installing or driving Stremio itself; MediaFusion and Comet (probed: empty without a per-user config, 403); Nyaa's own RSS (timed out here, Torrentio already lists NyaaSi); solidtorrents (the same backend as Bitsearch).
- The browser-driven fallback sites, the ranking weights, the swarm choice, the remux, subtitles, Trending, the cloud providers.
- Any debrid service, any disguised client, any bot-check workaround.

## Invariants

1. The tree typechecks and `npm test` passes at the end of each phase (including `tests/unit/docs/reference.test.ts`).
2. Every index request says it is notesd (`TORRENT_INDEX_USER_AGENT`); a bot check is the outcome `bot_check`, never worked around.
3. No unit test, no `test:int` run and no throwaway daemon reaches a real index or tracker list: tests inject the fetch and the socket; `verify.sh` names every new address as a fake or `off`.
4. A new source's failure, timeout or absence never fails or delays a play beyond the finder's existing per-index timeout; tracker-list work never runs in a play's path.
5. Direct streaming still plays the original language only: nothing in this set loosens `dubbed`, `lastResort` or the header probe.
6. A title is never guessed: a title-search hit that does not name the asked title, year (film) or episode (series) is excluded.
7. Nothing is joined, announced or downloaded by the tracker-list job: a BEP 15 connect only.

## Phases

| # | Title | Satisfies | Package | Files | Depends on | Difficulty | Plan | TaskID | Card |
|---|-------|-----------|---------|-------|-----------|------------|------|--------|------|
| 1 | Stremio add-on providers: TorrentsDB and Peerflix (complete) | R2 | `src/directStream/torrent/find` | 18 | — | NORMAL | `.workflows/plan/wider-torrent-sources/phase-1.md` | P1-NOTES-A136 | — |
| 2 | Title-search JSON indexes: Knaben, Bitsearch, torrents-csv | R1 | `src/directStream/torrent/find` | 22 | 1 | HARD | `.workflows/plan/wider-torrent-sources/phase-2.md` | P1-NOTES-A137 | — |
| 3 | Daily verified public tracker lists | R3 | `src/directStream/torrent` | 18 | — | NORMAL | `.workflows/plan/wider-torrent-sources/phase-3.md` | P1-NOTES-A138 | — |

Phase 2 depends on 1 because both extend the same registry lines (`IndexBases`, `DEFAULT_INDEX_BASES`,
`defaultIndexes` in `find/find.ts`; `TORRENT_INDEX_NAMES`, `TORRENT_INDEX_URL_KEYS` in `src/config.ts`;
`verify.sh:336-344`; the index rows of `configuration.md`): phase 2 quotes them as phase 1 leaves them.
Phase 3 shares no line with either: in the files all three touch it owns different regions, listed under each phase, with
at least two unchanged lines between its hunks and theirs (checked against `24687f1`; see the Reconciliation Log).

### Phase 1 — Stremio add-on providers: TorrentsDB and Peerflix
**Satisfies:** R2
**Owns:**
- `find/torrentio.ts`: the stream reader generalized so one reader serves any Stremio torrent add-on (stats line with `⚙️` or `🌐` before the site, rows without 💾, flag lines), with Torrentio's behaviour and exports unchanged for its callers and fixtures.
- New provider indexes `torrentsdb` (default `https://torrentsdb.com`) and `peerflix` (default `https://addon.peerflix.mov`, asked only when `query.originalLanguage === 'es'`; otherwise answers `empty` with a detail saying so and sends no request).
- Registry: `IndexBases`, `DEFAULT_INDEX_BASES`, `defaultIndexes` (`find/find.ts`), the barrel, `TORRENT_INDEX_NAMES` + `TORRENT_INDEX_URL_KEYS` (`NOTESD_TORRENT_TORRENTSDB_URL`, `NOTESD_TORRENT_PEERFLIX_URL`), `indexesOf` in `source.ts`.
- `verify.sh` index block: both new names `off`, on a line of their own in each branch; a test in `tests/unit/config.torrentFinder.test.ts` that every `TORRENT_INDEX_URL_KEYS` value appears at least twice in `verify.sh` (both branches). `fake-index.mjs` is not changed.
- Docs: two rows after the YTS row in `configuration.md`; the index list in `docs/guide/streaming.md` "Playing from a torrent"; the feature map; a CLAUDE.md line under Direct streaming.
- Tests + fixtures for both providers (the trimmed real answers are in `.workflows/analyze/20261119-025431-K7QD-samples/`).
**Does not touch:** `IndexFetch`/`FetchLike` types, `find/rank.ts`, `find/scrape.ts`, `origins.ts`, `trackersOf`/`swarmCounts`/`buildTorrentSource`'s tracker options, `src/background.ts`, the torrent block of `src/config.ts` (:421-440, :1092-1104), loadConfig's key-list comment (:1194-1198; phase 2 names this phase's keys there), the browser sites.
**Exit criteria:** R2.1-R2.4 hold; with default settings `defaultIndexes()` returns torrentio, apibay, eztv, torrentsdb, peerflix and (films) yts; `npm run typecheck` and `npm test` pass.

### Phase 2 — Title-search JSON indexes: Knaben, Bitsearch, torrents-csv
**Satisfies:** R1
**Owns:**
- `IndexFetch`/`FetchLike` and `askOne`'s fetch wrapper: an index may send `method` and `body` (Knaben is a POST), with notesd's User-Agent still forced last and the signal still bound; a JSON helper beside `getIndexJson` for it.
- A shared title-search helper under `find/`: the query text (film: title and year; episode: title and `SxxEyy`, using `alt` when set) and the fit a title-search row must pass before it becomes a candidate (names the title; a film row that names a year names the asked year, a row with no year is dropped when the query has one; an episode row fits the episode or is its season pack by `episodeFitOf`), reported so the finder's `excluded` list still shows why (R1.2).
- New indexes `knaben` (`https://api.knaben.org/v1`), `bitsearch` (`https://bitsearch.to/api/v1`), `torrentscsv` (`https://torrents-csv.com/service`), each with its own `timeoutMs`, skipped (`empty`, no request) when the query has no title.
- `find/rank.ts`: `exclusionOf` holds a candidate every listing of which came from a title search (`TorrentCandidate.titleSearch?: true`, `find/types.ts`) to `titleSearchExclusion` right after `bad_hash`; `joinListings` drops `titleSearch` when an IMDb-keyed index lists the same hash. `ExcludeReason` gains `'other_year'` (no exhaustive switch or record over it exists in the repo: grep of `src`, `web/src`, `claude`, `scripts`, `tests`).
- Registry lines as phase 1 left them, plus `NOTESD_TORRENT_KNABEN_URL`, `NOTESD_TORRENT_BITSEARCH_URL`, `NOTESD_TORRENT_TORRENTSCSV_URL`; the `defaultIndexes` doc comment; loadConfig's key-list comment line :1197 (naming phase 1's two keys and its own three); `verify.sh`: its three keys `off` on a line of their own in **both** index branches (phase 1's test); three more `configuration.md` rows after phase 1's; a short "Indexes asked by title" bullet before "**Off.**" in the guide; feature map; a CLAUDE.md bullet directly after phase 1's.
- Phase 1's tests that pin the default index list: `findCandidates.test.ts` (four edited and two new tests) and `addonSwitches.test.ts` gain the three title-search entries.
- Tests + fixtures (real samples in the analysis samples folder), including a wrong-year film and a wrong-episode row.
**Does not touch:** the add-on reader and providers of phase 1 (reads them only), `indexesOf`, `find/scrape.ts`, `origins.ts`, tracker wiring in `source.ts`, `src/background.ts`, the torrent block of `src/config.ts`, loadConfig comment lines :1194-1196 (phase 3 inserts after :1194), the browser sites, `claude/streaming/torrent/match.mjs` and `scripts/torrent/fake-index.mjs`.
**Exit criteria:** R1.1-R1.4 hold; existing index tests still pass unchanged in meaning; `npm run typecheck` and `npm test` pass.

### Phase 3 — Daily verified public tracker lists
**Satisfies:** R3
**Owns:**
- A new module beside `origins.ts` (the tracker lists): fetch the two lists with notesd's User-Agent, parse, keep UDP trackers not already in `DEFAULT_TRACKERS` or the book, verify each by a BEP 15 connect (a connect-only check added to `find/scrape.ts` on its existing socket seam), store `<torrent dir>/tracker-lists.json` (`{ fetched_at, trackers: [{ url, source }] }`, capped), keep the previous file when a refresh fails or nothing answers. Injected fetch, socket and clock.
- A daily loop started and closed in `src/background.ts` (built in `src/daemon.ts`), first run shortly after start, never in a play's path; off when `NOTESD_TORRENT=off`, `NOTESD_TORRENT_DISCOVERY=off` or `NOTESD_TORRENT_TRACKER_LISTS=off`.
- `TorrentSource`: a `lists` option beside `book`; `trackersOf` and `swarmCounts` append the kept trackers after the candidate's and the book's; the scrape's tracker cap reviewed so the added trackers are actually asked without lengthening `SCRAPE_TIMEOUT_MS`; `buildTorrentSource` wires it.
- `find/scrape.ts`: the connect-only `udpConnector`, `SCRAPE_MAX_TRACKERS` 8 -> 16 with the last `SCRAPE_LIST_SLOTS` (6) kept for list trackers (`scrapeTrackerOrder`); no new barrel line (the existing `export * from './scrape.js'` carries them; no name collides with phases 1-2's exports).
- `src/config.ts` torrent block: `trackerLists` switch (+ the two list addresses as constants, not settings), and one new line in loadConfig's key-list comment after :1194; one `configuration.md` row placed after `NOTESD_TORRENT_PEERS`; a guide section under "Torrents" next to "What a magnet says of its index"; feature map bullet after :574; a CLAUDE.md bullet after :120; `verify.sh` pins `NOTESD_TORRENT_TRACKER_LISTS=off` in the base `env=(...)` array (:262) for every throwaway daemon.
- Tests: parsing, verification with a fake socket, keep-previous on failure, the off switches, `trackersOf`/`swarmCounts` order.
**Does not touch:** any index module, `find/find.ts`, `find/types.ts`, `find/rank.ts`, `TORRENT_INDEX_NAMES`/`TORRENT_INDEX_URL_KEYS`/`parseTorrentFinder`, loadConfig comment lines :1195-1198, `indexesOf`, the index rows of `configuration.md` (:177-180 and what phases 1-2 add after them), `TrackerBook`'s file or its `learnMagnet` behaviour, `engine.ts`.
**Exit criteria:** R3.1-R3.4 hold; a daemon with the switch off behaves exactly as today; `npm run typecheck` and `npm test` pass.

## Reconciliation Log

| # | Conflict | Phases | Resolution |
|---|---|---|---|
| 1 | File collision: phase 2 Step 10 quoted `find/find.ts`'s imports as they are today (no `peerflix`/`torrentsdb` lines) and said "wherever phase 1 put them" | 1 → 2 | Phase 2 Step 10 now quotes phase 1's import block as Before and the merged block as After (rule 4) |
| 2 | Contract drift: the `defaultIndexes` doc comment was handed back and forth (phase 2 left it to phase 1; phase 1 writes it for six indexes only) | 1, 2 | Phase 2 owns the final comment: Step 10 rewrites phase 1's comment to name the three title-search indexes; phase 2's Leaves-alone no longer lists it |
| 3 | File collision: phase 2 Step 12(b) named the film test by its old title; phase 1 renames it | 1 → 2 | Step 12(b) uses phase 1's name `'asks Torrentio, apibay, TorrentsDB and YTS …'`; phase 2's "if phase 1 switched to explicit indexes, drop (b)-(e)" fork removed: phase 1 keeps the default indexes |
| 4 | Broken-build phase: phase 1's new tests pin the whole attempt / index-name list (`findCandidates.test.ts` "asks Peerflix for a title made in Spanish", "records an add-on provider's bot check …"; `addonSwitches.test.ts` "are among the default indexes", "get no request when set off"); phase 2 adds three default indexes and did not update them, so `npm test` would fail at the end of phase 2 | 1 → 2 | Phase 2 Step 12 gains (f), (g) and an `addonSwitches.test.ts` edit with the exact new expectations; `addonSwitches.test.ts` added to phase 2's Files table |
| 5 | Broken-build phase / invariant: phase 1's new test requires every `TORRENT_INDEX_URL_KEYS` value at least twice in `verify.sh`; phase 2 put its three keys once, on one line before `# NOTESD_TRENDING=off` | 1 → 2 | Phase 2 Step 15 rewritten: its three keys on a line of their own in **both** branches of the index block, quoting phase 1's lines as Before. The old placement is gone |
| 6 | Gap: loadConfig's key-list comment (`src/config.ts:1194-1198`) would never name phase 1's two keys (phase 1 does not touch it; phase 2 added only its own three) | 1, 2 | Phase 2 rewrites :1197 only, naming all five new index keys (rule 5: phase 2 already owned the region) |
| 7 | File collision (concurrent): phase 3 left `NOTESD_TORRENT_TRACKER_LISTS` out of that comment and asked the reconciler to put it on :1195, adjacent to phase 2's :1196-1197 edit; phase 3 runs beside phase 1 and may land before or after phase 2 | 2, 3 | Phase 3 Step 4 inserts its own new line after :1194 and nothing else in the comment; phase 2 edits only :1197; :1195-1196 stay unchanged between the hunks whatever the merge order |
| 8 | File collision (adjacency): phase 2's CLAUDE.md bullet before :118 left two unchanged lines (:118-119) between it and phase 3's insert after :120 | 2, 3 | Phase 2's bullet moved to directly after phase 1's (before `  - A torrent is chosen by its swarm`, :116); :116-120 now separate phase 1-2's inserts from phase 3's |
| 9 | Shared-region check: `configuration.md` (P3 after :173, P1 after :180, P2 before the 1337X row after P1's), `streaming.md` (P3 :1742-1746, after :2199, :2214; P1 :1800-1801; P2 before "**Off.**" :1810), `features/direct-streaming.md` (P1 after :436, P2 before :437 after P1's, P3 after :574), `verify.sh` (P3 :262; P1-P2 :334-345), `source.ts` (P3 imports after :6, :113-114, :478-494, :1074-1076, :1103; P1 :1054-1060) | 1, 2, 3 | Checked against the tree at `24687f1`: phase 3's hunks are at least two unchanged lines from phases 1-2's in every shared file; phase 2's follow phase 1's in sequence. No move needed beyond rows 7 and 8; phase 2's feature-map anchor now says it lands after phase 1's bullet |
| 10 | Invariant 3 drift: phase 1's J5 drive builds the finder from an env that does not switch the title-search indexes off, so re-running P1.J5 after phase 2 lands (a verifier's run) would send real requests to Knaben, Bitsearch and torrents-csv | 1, 2 | Phase 1's J5 env sets `NOTESD_TORRENT_{KNABEN,BITSEARCH,TORRENTSCSV}_URL=off` (ignored by `parseTorrentFinder` until phase 2 lands); its expected output is unchanged |
| 11 | Index boundary: the draft's phase 2 Owns did not name `find/rank.ts` or `find/types.ts`'s `ExcludeReason`/`titleSearch`, though phase 2's steps edit them | 2 | Phase 2 Owns now lists them; phases 1 and 3 already exclude `rank.ts`. Grep: no exhaustive `switch`/`Record` over `ExcludeReason` exists, so `'other_year'` needs no other edit |
| 12 | Check: phase 3's `SCRAPE_MAX_TRACKERS` 8 -> 16 and `trackersOf` dedupe by `trackerKey` | 1, 2, 3 | No phase 1-2 test asserts the scrape cap or `trackersOf`; the existing scrape test asserts through the constant. No conflict |
| 13 | Check: phase 3's new `find/scrape.ts` exports (`ConnectTrackers`, `CONNECT_TIMEOUT_MS`, `CONNECT_MAX_TRACKERS`, `udpConnector`, `SCRAPE_LIST_SLOTS`, `scrapeTrackerOrder`) through the `find/index.ts` barrel | 1, 2, 3 | No collision with phase 1's (`readStremioStream`, `StremioAddon`, `stremioAddonIndex`, `torrentsdbIndex`, `peerflixIndex`, `PEERFLIX_LANGUAGE`), phase 2's (`titleSearch*`, `TITLE_SEARCH_*`, `unsearchable`, `knabenIndex`, `bitsearchIndex`, `torrentscsvIndex`, `postIndexJson`) or any existing barrel export |
| 14 | Requirement / criterion coverage | 1, 2, 3 | R1 -> 2, R2 -> 1, R3 -> 3; every criterion owned and traced (`ears_trace.py` exit 0); no creep: each phase's steps serve only its own R |

## Decisions

| # | Fork | Choice | Rung |
|---|---|---|---|
| D1 | Where phase 2's three `verify.sh` keys go: one line before `# NOTESD_TRENDING=off` (phase 2's draft) or in both index branches (phase 1's test) | Both branches, a line of their own in each | Stated invariant (Invariant 3, which phase 1 encodes as a test) and phase 1's exit criteria (`npm test` passes) |
| D2 | Who names the new index keys in loadConfig's key-list comment, and where `NOTESD_TORRENT_TRACKER_LISTS` goes in it | Phase 2 rewrites :1197 naming all five index keys; phase 3 inserts its own line after :1194; phase 1 does not touch the comment | Stated invariant 1 (each phase green and mergeable on its own) and the dependency shape given at Step 0 (phase 3 concurrent with phases 1-2, hunks kept textually apart) |
| D3 | Phase 2's CLAUDE.md bullet: before "The trackers are asked …" (:118) or beside phase 1's index bullet | Directly after phase 1's bullet, before "A torrent is chosen by its swarm" (:116) | Step 0 dependency shape (phase 3's hunk after :120 must stay apart) and the surrounding convention (index rules sit together) |
| D4 | Phase 1's tests pinning the default index list: switch them to an explicit `indexes` list (phase 2's offered fork) or keep the default indexes and extend them in phase 2 | Keep the default indexes; phase 2 appends its entries | Plans' code blocks (phase 1's Steps 10-11 test the daemon's own default list, which is what R2.1 / R2.4 prove) |
| D5 | Peerflix for a non-Spanish title: answer `empty` with a "not asked" detail (one visible `Index: peerflix` `no_stream` attempt per such play) or a new `TorrentIndex` language field filtered out in `findCandidates` | Keep the visible `empty` "not asked" answer; no new `TorrentIndex` field | Plans' code blocks (phase 1 Steps 1 and 3, the `skip` option) and the surrounding convention (phase 2's `unsearchable` answers the same way for a query it cannot ask) |
| D6 | Trending's swarm probe (`trending/job.ts` `peek`) does not get the list trackers | Out of scope for this set; nothing changes there | Index Scope ("Out of scope: … Trending") |
| D7 | `scripts/torrent/fake-index.mjs` has no title-search route, so no throwaway daemon shows a title-search candidate end to end (analysis impact point 10 names the file) | Out of scope; every throwaway daemon pins the five new index addresses `off`, and the unit journeys over recorded answers carry the proof | Stated invariant 3 (no throwaway daemon reaches a real index) and phase 2's exit criteria (J1-J4) |
| D8 | Long-anime releases named only by a running number (`One Piece - 1100`) are not found by the title-search indexes (asked `<title> SxxEyy`) | Out of scope; they are still found by the IMDb-keyed indexes and the fallback sites as today | Stated invariant 6 (a title is never guessed) and the index Why (improve TM / TS without loosening the fit) |
| D9 | Index `**Status:**` value: `reconciled` (the reconciler's default) or `planned` (the caller's instruction) | `planned` | The caller's instruction for this run |

## Open Questions

None.

## Rollback

Each phase is one commit series on `feature/wider-torrent-sources`; reverting a phase's commits restores the previous finder.
At run time, without a revert: set the new source's `NOTESD_TORRENT_<NAME>_URL=off`, or `NOTESD_TORRENT_TRACKER_LISTS=off` and delete `<torrent dir>/tracker-lists.json`.

## Next

Execute the phases one at a time, starting at phase 1:

    /implement -f .workflows/plan/WIDER_TORRENT_SOURCES_PLAN.md --phase 1

Or run the whole set as a swarm — a session per phase, concurrent wherever `Depends on` allows,
resumable on any machine:

    /analyze-orchestrator -f .workflows/plan/WIDER_TORRENT_SOURCES_PLAN.md

Or put them on the board first (GitHub repos only):

    /create-task --from-plan .workflows/plan/WIDER_TORRENT_SOURCES_PLAN.md
