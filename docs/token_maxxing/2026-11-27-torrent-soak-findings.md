# Token-Maxxing Session — 2026-11-27: Torrent Soak Findings

## 🎯 Achievement / End Result
- **Goal of the burn:** Investigate and fix the three findings from an unbounded torrent soak against the live daemon (soak note 2-IFP, play rows in `stream_play_log`). These were real playback failures the owner hit, and the play log exists to find them. Constraints: never loosen `titleSearchExclusion`, change no torrent ranking (that waits for an owner decision on 2026-12-04), and never touch the live daemon.
- **Concrete changes** (five commits on the branch, oldest first):
  - dc816d8 `fix(torrent): fetch the probed file's first and last pieces first, and log the file probed`. `src/directStream/torrent/engine.ts` (`WebTorrentHandle.headFirst`), `streams/torrentStreams.ts` (`TorrentStreams.headFirst`), `source/race.ts`, `source/constants.ts` (`PROBE_HEAD_BYTES` = 2 MiB), `source/types.ts`, `torrent/types.ts` (`TorrentSwarm.headFirst?`). New tests `tests/unit/directStream/torrent/probeHeadFirst.test.ts` (fake engine) and `engineHeadFirst.test.ts` (real webtorrent over loopback).
  - 55a33c2 `feat(torrent): a failed torrent attempt names the index that listed it`. Failure lines now end with "(from torrentsdb)" or "(from torrentio)". `titleSearch.test.ts` pins the two facts behind the Miracle in Cell No. 7 case.
  - ffc192f `fix(streaming): keep a crashed script's last stderr lines in its error, redacted`. `src/streaming/service.ts` `runJsonScript` keeps the last 8 stderr lines (at most 1000 chars), passed through `redactSecrets` and `redactQueries` with magnets cut. Test in `tests/unit/streaming.test.ts`.
  - 79d957f `fix(torrent): a racer with no header after 45 s gives way when another torrent waits`. `HEADER_GIVE_WAY_MS` in `source/constants.ts`, used in `source/race.ts` and `probeWhileDelivering.ts`. Tests in `torrentSource.test.ts`.
  - 7057515 `docs(plans): torrent ranking evidence from the 2026-11-27 soak for the 2026-12-04 decision`. New `docs/plans/2026-11-27-torrent-ranking-evidence.md`. Evidence only.
  - `docs/guide/streaming.md` was updated alongside each behaviour change. In total, 20 files changed: +515 / −20.
- **Real value delivered:**
  - Season packs and other big-piece torrents no longer have to download the whole file before ffprobe can read the header. The tail, where the MKV Cues/Tags and the MP4 moov live, now arrives within the first few MB. In the soak, Babylon Berlin S01E01 had taken in 25.2 MB from 14 peers in 79 s and still had no header.
  - A failed torrent attempt now names the index that listed it, so a wrong-year listing points straight at its source. In the soak that source was TorrentsDB, which keys listings by IMDb id.
  - A crashed streaming script now reports its cause in the resolve's `script_failed` detail and in the log, with no secrets, `tok` or Wyzie key in it.
  - A torrent that cannot produce a header no longer uses up the whole budget while better candidates wait. In the soak, A Record of a Mortal's Journey S01E01 sat on a 139-file pack for 85 s and the two releases behind it were never tried.
  - The owner gets written evidence (rows 39 and 11 of the play log) for the 2026-12-04 ranking decision.
- **Branch:** token-maxxing-2026-11-27-torrent-soak-findings
- **Merge status:** merged (commit 37a1b29, landed by coordinator orch-stream-play-log)
- **Approx token burn:** several million tokens (a real-webtorrent loopback experiment, live index checks, full unit and integration suites, a verify-notesd torrent journey, and a second base worktree to rule out a pre-existing failure) 🔥

## Context & Motivation

This is a worker session of coordinator `orch-stream-play-log` (slug `torrent-soak-findings`, session node KU-ZB). The coordinator pre-assigned the idea, so there was no menu.

The play log (`stream_play_log`, written only through `PlayLog`) was built to turn the owner's playback trouble into evidence. An unbounded soak against the live daemon produced soak note 2-IFP and a set of play rows, and three of them showed real failures:

1. Torrents with large pieces (season packs with 8-16 MB pieces) never got a header to ffprobe in time.
2. The 2019 Turkish film *Miracle in Cell No. 7* was tried with two 2013 Korean releases of the same name.
3. A streaming script crashed, and its error said nothing about the cause.

During the work the coordinator added a fourth item: a racer stuck with no header should give way to the torrents waiting behind it. Torrent ranking had come up as well, but it is deferred to the owner, so this session only wrote the evidence down.

## What We Did (blow-by-blow)

### Finding 1: no header on big-piece torrents

The play rows showed torrents taking in tens of MB from many peers and still failing the header probe. To find the root cause we ran an experiment with real webtorrent over loopback. `use` selects the whole file, and webtorrent 3.0.21's sequential strategy fetches the selection front to back. ffprobe needs bytes near the end of the file: the MKV Cues/Tags, or the MP4 moov when it sits at the end. With multi-block pieces, those tail pieces came only after the whole file had arrived.

The first fix we tried, a second `select` over the head and tail, did nothing. Webtorrent merges a selection that falls inside an existing selection into it (`Selections.concatenate`), so its priority is lost. The working fix reads the head and the tail as stream reads, which webtorrent does prioritise. Each read covers `PROBE_HEAD_BYTES` (2 MiB), and at least one piece. The call chain is `race()` → `TorrentSwarm.headFirst?` → `TorrentStreams.headFirst` → `WebTorrentHandle.headFirst`, and it runs before ffprobe. `TorrentStreams.headFirst` acts only on a used video or subtitle file, never on a remuxed one. This keeps the rule that only video and subtitle files are selected, read or served.

We also added one log line, so the next soak shows which file was probed: "probing <path> (file i of N, X MB, k subtitle files beside it), its first and last pieces first".

Proof:
- `probeHeadFirst.test.ts` drives a fake engine through the real `TorrentStreams` and `TorrentSource`. It failed before the fix.
- `engineHeadFirst.test.ts` uses real webtorrent over loopback. Without the fix, the tail piece arrived only once all 8.4 MB of the file were on disk. With the fix, it arrived at about 6.5 MB.

### Finding 2: Miracle in Cell No. 7, the wrong year

The two 2013 Korean releases came from TorrentsDB, a Stremio add-on keyed by IMDb id, which lists them under tt10431500, the 2019 Turkish film. A live check showed that Torrentio does not list them. `titleSearchExclusion` would drop both as `other_year`, but by design it applies only to what a title search alone listed. An IMDb-keyed listing is trusted as the title. No existing rule guards an IMDb-keyed listing's year. The brief ruled out new ranking or loosening work, so we added no guard. Instead:
- every failed torrent attempt now names the index that listed it (`(from torrentsdb)`), so this kind of mis-mapping is visible in the log and the play log;
- `titleSearch.test.ts` pins both facts: the exclusion drops these releases on a title search, and it does not apply to an IMDb-keyed listing.

### Finding 3: a crashed script said nothing

`runJsonScript` threw away stderr when a script crashed, so `script_failed` carried no cause. It now keeps the last 8 stderr lines, capped at 1000 characters, and passes them through `redactSecrets` and then `redactQueries` with magnets cut. The test checks that secrets, a download `tok` and the Wyzie key never reach the error.

### Item 4 (coordinator request): give way when stuck

In the soak, A Record of a Mortal's Journey S01E01 sat on a 139-file pack that took in 15.3 MB in 85 s with no header, and the two releases behind it were never tried. A racer with no header after `HEADER_GIVE_WAY_MS` (45 s) now gives way, but only when both of these hold:
- another torrent of the same ask is waiting for its slot (not yet opened in this round, or waiting in the dub-named round), and
- at least 25 s of the budget are left.

This shares the budget only. The order of candidates does not change, so it is not a ranking change.

### Item 5: ranking evidence for 2026-12-04

`docs/plans/2026-11-27-torrent-ranking-evidence.md` records two rows:
- Row 39, *Miracle in Cell No. 7*. NOMA, delivering 2.9 of 3.1 Mbps, was skipped for a Russian release delivering 1.5 of 6.6 Mbps that had an English subtitle file. That release stalled 9 times for 97.5 s, then switched by itself to NOMA.
- Row 11, *Confessions*. ArtymKo, delivering 1.9 of 6.0 Mbps, was chosen over YTS at 1.0 of 2.6 Mbps. It stalled for 258.7 s in 50 s of play.

This is evidence only. The decision is the owner's.

## Code / Design Details

- **Why stream reads and not `select`:** webtorrent's `Selections.concatenate` merges a range that falls inside an existing file selection into it, and the merged range keeps the whole file's priority. A read (`warm()` in `engine.ts`, which drains `file[Symbol.asyncIterator]({ start, end })` and drops the bytes) gets its pieces fetched next to the other reads in progress. The head and tail reads each cover `min(file.length, max(PROBE_HEAD_BYTES, pieceLength))`, and they are stopped when the file is let go.
- **Scope guard:** `TorrentStreams.headFirst` returns without doing anything unless the file is a used video or subtitle file. A remuxed file is never read this way, because its bytes come from ffmpeg and not from the swarm.
- **Optional on the interface:** `TorrentSwarm.headFirst?` is optional, so the fake engines and any other swarm keep working. The fake engine in `tests/helpers/fakeTorrentEngine.ts` records each `headFirst` call (info hash and file index) so tests can assert on it.
- **Give way:** the check sits in the probe loop (`probeWhileDelivering.ts`, through a `waiting()` callback). The race supplies that callback, which counts the torrents still waiting (`race.ts`). The abort reason reads "no header after N s while it delivered (...); K more torrents waited, so it gave way". The constants are in `source/constants.ts`.
- **Script stderr:** the tail is redacted before it is put into the error. Raw stderr is never put into the thrown error or a log line.

## Decisions & Trade-offs

- **No year guard for IMDb-keyed indexes.** Adding one would mean new filtering of a trusted listing, and the brief excludes that. Naming the index makes the problem visible at almost no cost. The owner decides whether TorrentsDB's mis-mappings deserve a rule.
- **No ranking change.** The ranking evidence points at real problems (rows 39 and 11), but ranking waits for the owner's 2026-12-04 decision, so this session only wrote the evidence down.
- **45 s give-way.** This is an estimate from the soak: a working torrent usually has a header well before 45 s, and the stuck ones were still stuck at 79-85 s. The 25 s floor keeps a give-way from starting a torrent that cannot finish probing.
- **2 MiB head and tail.** This is enough for an MKV's EBML header and Cues, or an MP4's moov, in every file of the soak. Each read is raised to at least one piece because a piece is the smallest unit webtorrent fetches.

## Follow-ups & YAGNI notes

- **verify-notesd's replay stage fails before this branch.** It fails the same way on the untouched base commit 56653a2 (checked on a separate base worktree): after the download completes, a replay asks the indexes instead of answering from disk. Not fixed here.
- **Ranking decision on 2026-12-04**, from `docs/plans/2026-11-27-torrent-ranking-evidence.md`.
- Maybe have `deliveryText` name the `chooseOrder` step that decided the choice.
- An IMDb-keyed index's year mis-mapping (TorrentsDB) has no guard by rule. The owner decides.
- Re-check the 45 s give-way time against the play log after a week.
- Flaky unit tests under load: `installGuard`, `rememberedChannel` and `cacheShelf` each failed in some runs (about 2 per run) at a load average of about 50. Each passes on its own, and none touches the changed code.

## Appendix

Proof run:
- `npm run typecheck`: clean.
- `npm test`: passed apart from about 2 tests per run that differed between runs (see above).
- `npm run docs:check`: current.
- `npm run test:int`: 108 files, 1088 tests passed.
- verify-notesd on a throwaway daemon (`up --torrent`): the `torrent.sh` stages fallback, named, dubbed and pack pass. `daemon.log` shows the new probing line on the real loopback pack, and "(from torrentio)" on the dubbed attempt. The replay stage fails, which is pre-existing (see Follow-ups).

References: soak note 2-IFP; `stream_play_log` rows 11 and 39; `docs/guide/streaming.md`; `docs/plans/2026-11-27-torrent-ranking-evidence.md`.
