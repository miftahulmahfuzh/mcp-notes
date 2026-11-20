> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/stream-downloads-season-story/PLAN.md` phase 2. Source: `.workflows/plan/stream-downloads-season-story/phase-2.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 2: The download engine: queue, source order, kept downloads, offline-ready, play first

**Plan set:** `STREAM_DOWNLOADS_SEASON_STORY_PLAN.md`
**Analysis:** `.workflows/analyze/20261120-213359-K7Q2_code_analyzer.md`
**Satisfies:** R1, the Download button's default (1080p torrent first, cloud as the fallback) and what a download leaves on disk
**Criteria:** R1.2, R1.4, R1.5, R1.6, R1.7, R1.8, R1.9, R1.11
**Depends on:** Phase 1
**Difficulty:** HARD
**Package:** `src/directStream/downloads`, `src/directStream/torrent`

---

## Goal

After this phase the daemon has `StreamDownloads` (`deps.streamDownloads`). It takes one film or one episode at a time from the persisted `stream_downloads` queue. With no source named it tries a 1080p torrent with live seeds first, then the owner's cloud cache at 1080p or lower, then a torrent below 1080p. On SSID `Employee` it goes straight to the cloud and never touches WARP. A torrent is fetched the way a play finds one: the audio check runs, a dub is skipped, and the subtitle chain and the remux both run to their end. The torrent is marked kept (`stream_torrents.kept_at`), so neither prune deletes it, and it stays in the swarm until it is whole. It pauses while another torrent plays on screen. On every daemon start it carries on from what is on disk. Nothing can request a download yet: phase 4 adds the routes and the tool over `request` / `list` / `cancel`.

## Interface Contract

The reconciler reads this section to detect cross-phase conflicts. Be exact and exhaustive.

**Deletes:** nothing.

**Renames:** none.

**Creates:**
- `src/directStream/downloads/types.ts`:
  - `type DownloadVia = StreamDownloadVia`, `type DownloadState = StreamDownloadState`, `type DownloadSource = StreamDownloadSource` (re-exported from phase 1's schema)
  - `type TorrentBand = 'preferred' | 'below'`
  - `type TorrentAsk = { band: TorrentBand } | { infoHash: string }`
  - `interface DownloadAsk { via: DownloadVia; infoHash?: string | null; batch?: string | null }`
  - `interface DownloadRequestAnswer { download: DownloadView | null; created: boolean; onDisk: boolean }`
  - `interface DownloadView` (snake_case JSON shape: `id, host, available, kind, tmdb_id, season, episode, via, info_hash, batch, state, source, source_id, progress, bytes_done, bytes_total, peers, down_kbps, error, detail, created_at, updated_at, finished_at`)
  - `type DownloadErrorCode = 'invalid_request' | 'downloads_off' | 'unknown_download'`, `class DownloadError`
  - `type DownloadFacts = Pick<TorrentResolveOptions, 'audioLang' | 'imdbId' | 'names'>`
  - `interface KeptTorrentHandle { infoHash; fileIndex; name }`, `type TorrentFetch`, `type TorrentNow = KeptState & {bytesDone, bytesTotal, peers, downKbps}`, `interface DownloadTorrents`
  - `interface CacheNow`, `interface DownloadCaches`
- `src/directStream/downloads/plan.ts` (pure): `type DownloadStep`, `type CloudStep`, `type DownloadPlan`, `interface StepFailure`, `CLOUD_MAX_HEIGHT` (= `PREFERRED_TORRENT_HEIGHT`, 1080), `isOffice(ssid)`, `planDownload(ask, here)`, `liveSeeds(c, count)`, `bandAllows(band, c, count)`, `stepsAfterCloud(steps)`, `stepLabel(step)`, `finalFailure(failures)`
- `src/directStream/downloads/service.ts`: `class StreamDownloads`, `interface StreamDownloadsOptions`, `DOWNLOAD_TICK_MS`, `DOWNLOAD_RESUME_TRIES`, `DOWNLOAD_RETRY_MS`, `SSID_TTL_MS`, `ssidFrom(warp, options)`, `attemptsText(attempts)`, `torrentDownloadsOf(source, streams, facts)`, `cacheDownloadsOf(cache)`, `buildStreamDownloads(config, wiring)`
  - `StreamDownloads.request(ref: StreamRef, ask: DownloadAsk): Promise<DownloadRequestAnswer>` (throws `DownloadError` `invalid_request` / `downloads_off`)
  - `StreamDownloads.cancel(id: string): Promise<DownloadView>` (throws `DownloadError` `unknown_download`)
  - `StreamDownloads.list(filter?: { kind: 'movie' | 'tv'; tmdbId: number }): Promise<DownloadView[]>` (this host's queued, running, paused and failed rows, never a cancelled one; with no filter never a `done` row; with a title filter also that title's `done` rows, the latest per film or episode and only while that film or episode is still whole on this machine)
  - `StreamDownloads.start(): Promise<number>`, `close(): Promise<void>`, `tick(): Promise<void>`, `settled(): Promise<void>`, `get host(): string`
- `TorrentSource.fetchKept(ref, options: TorrentResolveOptions & { infoHash?: string | null }): Promise<KeptResolve>`, `TorrentSource.keptState(torrent): Promise<KeptState>`, `TorrentSource.retryKeptRemux(torrent): Promise<void>`, exported `type KeptResolve`, `interface KeptState`, `keptFailure(attempts)` (`src/directStream/torrent/source.ts`)
- `TorrentResolveOptions.only?: (c: TorrentCandidate, count: SwarmCount | null) => boolean` (new optional field; a play never sets it)
- `TorrentSwarm.trackersOf?(infoHash: string): Promise<string[]>` (new optional member)
- `TorrentStreams.keep(infoHash: string, kept: boolean): Promise<void>`, `TorrentStreams.trackersOf(infoHash: string): Promise<string[]>`, `TorrentStreams.fileProgress(infoHash: string, fileIndex: number): Promise<{ bytesDone: number; length: number } | null>` (`src/directStream/torrent/service.ts`)
- `TorrentRemux.status(infoHash: string, fileIndex: number): 'none' | 'running' | 'whole' | 'failed'` (`src/directStream/torrent/remux.ts`)
- `DirectStreamService.downloadFacts(ref: StreamRef): Promise<Pick<TorrentResolveOptions, 'audioLang' | 'imdbId' | 'names'>>`, `DirectStreamService.torrentsOnScreen(): string[]` (`src/directStream/service.ts`)
- `DirectStreamConfig.downloads?: boolean`, env `NOTESD_STREAM_DOWNLOADS` (default on) (`src/config.ts`), its row in `docs/guide/reference/configuration.md`
- `DirectStreamConfig.downloadSsid?: string | null`, env `NOTESD_STREAM_DOWNLOAD_SSID` (unset: the SSID is read from WARP's status; set: that value is the SSID and nothing is read) (`src/config.ts`), its row in `docs/guide/reference/configuration.md`, and the pin `NOTESD_STREAM_DOWNLOAD_SSID=verify-home` in `.claude/skills/verify-notesd/scripts/verify.sh` beside `NOTESD_STREAM_WARP=off`
- `fixedSsid(ssid: string): () => Promise<string | null>` (`src/directStream/downloads/service.ts`)
- `AppDeps.streamDownloads?: StreamDownloads | null` (`src/deps.ts`)

**Signature changes:**
- `TorrentStreams.keepBudget(held)` (private) -> `keepBudget(held, kept: ReadonlySet<string>)`. When kept downloads remain over the budget, its last log line names them. With nothing kept, the line is unchanged.

**Requires (from earlier phases), all from Phase 1 as its plan file states them:**
- `src/directStream/downloads/repo.ts`: `DownloadsRepo(db)`, `type DownloadRecords`, `DOWNLOAD_CANCELLED = 'cancelled'`, `downloadRef(row)`, `type DownloadOn = { source: 'torrent'; infoHash } | { source: 'cloud'; cacheId }`. The methods are called exactly as `create(host, {ref, via, infoHash, batch}, now)`, `get(host, id)`, `list(host, {kind?, tmdbId?, states?})`, `setState(host, id, 'queued'|'running'|'paused', now)`, `on(host, id, on, now)`, `progress(host, id, bytesDone, bytesTotal, now)`, `done(host, id, on, {bytesDone, bytesTotal}, now)`, `failed(host, id, error, detail, now)`, `cancel(host, id, now)` and `toResume(host, now)`. `create` re-queues a `failed` row (a cancelled one included) with `created: true`.
- `StreamDownloadRow` fields read: `id, host, kind, tmdbId, season, episode, via, infoHash, batch, state, source, sourceId, bytesDone, bytesTotal, error, errorDetail, createdAt, updatedAt, completedAt`. Schema types `StreamDownloadVia`, `StreamDownloadState`, `StreamDownloadSource`.
- `StreamTorrentRow.keptAt: Date | null`. `TorrentsRepo.setKept(host, infoHash, at: Date | null): Promise<number>` sets every row of the torrent on that host. `'setKept'` is in `TorrentRecords`. `MemoryTorrentRecords` implements `setKept` and fills `keptAt: null`.
- `tests/helpers/memoryDownloadRecords.ts` exports `MemoryDownloadRecords implements DownloadRecords`, with a public `rows: StreamDownloadRow[]`.
- `tests/integration/setup.ts` `truncateAll` empties `stream_downloads`.

**Leaves alone (owned by others):** `StreamDownloads.requestSeason`, season packs and several slots of one torrent per job (Phase 3); `src/http/streamDownloadsApi.ts`, `scripts/docs/httpRoutes.ts`, `direct_stream_cache`, `src/mcp/*`, `web/src/moviesApi.ts` (Phase 4); `src/directStream/cacheShelf.ts`, `streamDiskApi.ts` (Phase 5); `src/directStream/ahead.ts` (behaviour unchanged, `fetchAhead` untouched); `src/directStream/torrentWarp.ts`; `docs/guide/streaming.md`, `docs/guide/movies.md`, `.claude/skills/verify-notesd/features/*`, `CLAUDE.md` (Phase 9); every web file.

## Files

| File | Action | What changes |
|---|---|---|
| `src/directStream/torrent/remux.ts:347` | modify | `status(infoHash, fileIndex)` after `savedProbe` |
| `src/directStream/torrent/source.ts:130`, `:213`, `:510`, `:693` | modify | `TorrentSwarm.trackersOf?`, `TorrentResolveOptions.only`, the band filter in `resolve`, `fetchKept` / `keptState` / `retryKeptRemux` / `keptByHash` / `heardAsDub` / `dropKept`, `KeptResolve`, `KeptState`, `keptFailure` |
| `src/directStream/torrent/service.ts:44`, `:367`, `:517`, `:548`, `:754-846` | modify | `keptHashes`; `trackersOf`, `fileProgress`, `keep`; the age prune and the budget skip kept torrents |
| `src/directStream/service.ts:23`, `:582` | modify | import `TorrentResolveOptions`; `downloadFacts`, `torrentsOnScreen` |
| `src/directStream/downloads/types.ts` | create | the engine's shapes and seams |
| `src/directStream/downloads/plan.ts` | create | the pure source order, the office rule, the bands, the final failure |
| `src/directStream/downloads/service.ts` | create | `StreamDownloads`, the two adapters, `ssidFrom`, `buildStreamDownloads` |
| `src/config.ts:228`, `:977` | modify | `downloads?: boolean`, `NOTESD_STREAM_DOWNLOADS`; `downloadSsid?: string \| null`, `NOTESD_STREAM_DOWNLOAD_SSID` |
| `.claude/skills/verify-notesd/scripts/verify.sh:261` | modify | pins `NOTESD_STREAM_DOWNLOAD_SSID=verify-home` beside `NOTESD_STREAM_WARP=off` |
| `src/deps.ts:16`, `:98` | modify | `streamDownloads` |
| `src/daemon.ts:71`, `:579` | modify | build `deps.streamDownloads` |
| `src/background.ts:246-257`, `:282` | modify | start after the torrents' start; close first |
| `docs/guide/reference/configuration.md:145` | modify | `NOTESD_STREAM_DOWNLOADS` and `NOTESD_STREAM_DOWNLOAD_SSID` rows |
| `tests/unit/config.test.ts:58`, `:477` | modify | `downloads: true` in the two expected direct-stream configs |
| `tests/unit/config.streamCache.test.ts:18` | modify | the switch's default, `off` and literal default |
| `tests/unit/directStream/downloads/fakes.ts` | create | `FakeTorrents`, `FakeCaches` |
| `tests/unit/directStream/downloads/plan.test.ts` | create | the order, the office rule, the bands, the final failure |
| `tests/unit/directStream/downloads/service.test.ts` | create | the engine against fakes |
| `tests/unit/directStream/torrent/keptFetch.test.ts` | create | `fetchKept`, `keptState`, `TorrentRemux.status`, replay from disk |
| `tests/unit/directStream/torrent/keptPrune.test.ts` | create | both prunes skip a kept torrent; `keep` |
| `tests/integration/streamDownloads.engine.int.test.ts` | create | restart carry-on and the prune exemption on Postgres |

## Implementation Steps

Steps 1–4 change the torrent layer and leave the tree green on their own (`npx vitest run tests/unit/directStream/torrent tests/unit/directStream/torrentSource.test.ts`). Steps 5–7 add the engine. Steps 8–10 wire it in. Steps 11–16 are tests.

### Step 1: `TorrentRemux.status`
**File:** `src/directStream/torrent/remux.ts:347` (after `savedProbe`, before `resume`)
**Change:** A read-only answer for where one file's remux stands. A download holds the torrent until this says `whole`.
**Code:**
```ts
  /**
   * Where the remux of one file stands on this machine: `whole` once its done.json is on disk (made now or by an
   * earlier run), else what the run in memory is doing (`running`, `failed`); `none` when nothing runs or ran for it.
   */
  status(infoHash: string, fileIndex: number): 'none' | 'running' | 'whole' | 'failed' {
    if (existsSync(path.join(remuxDir(this.opts.dir, infoHash, fileIndex), REMUX_DONE_FILE))) return 'whole';
    const run = this.runs.get(`${infoHash}:${fileIndex}`);
    if (run === undefined) return 'none';
    if (run.state === 'running') return 'running';
    if (run.state === 'failed') return 'failed';
    return run.state === 'done' ? 'whole' : 'none';
  }
```
**Impact:** none on existing callers (`existsSync`, `path`, `remuxDir`, `REMUX_DONE_FILE` are already in scope in this file).

### Step 2: `TorrentSource`: a band filter, `trackersOf`, and `fetchKept`
**File:** `src/directStream/torrent/source.ts`

**2a.** `TorrentSwarm` (line 130, before the closing `}`), add:
```ts
  /** The trackers this host's row of a torrent keeps (what it was opened with), for opening it again by its info hash. Absent: none. */
  trackersOf?(infoHash: string): Promise<string[]>;
```

**2b.** `TorrentResolveOptions` (line 213, after `progress`), add:
```ts
  /**
   * Which of the found torrents may be tried at all (a download's band: 1080p with live seeds, or below 1080p), given
   * what the trackers said of its swarm (null: nobody answered for it). Unset: every one (a play).
   */
  only?: (c: TorrentCandidate, count: SwarmCount | null) => boolean;
```

**2c.** In `resolve`, insert directly before line 510 (`candidates = deadLast(candidates, counts);`):
```ts
    const only = options.only ?? null;
    if (only !== null) {
      const allowed = (c: TorrentCandidate): boolean => only(c, counts.get(c.infoHash) ?? null);
      const before = candidates.length + dubs.length;
      candidates = candidates.filter(allowed);
      dubs = dubs.filter(allowed);
      this.log(`[notesd] torrent: ${refLabel(ref)}: ${candidates.length + dubs.length} of ${before} torrent(s) fit what this download asks for`);
    }
```

**2d.** After `fetchAhead` (line 693, before `releaseAhead`'s doc comment), insert:
```ts
  /**
   * A download the owner asked for (src/directStream/downloads/): the title's torrent found and opened as a play finds
   * it (the indexes, the race, the header, the original-language check on the file's tags), or the one torrent
   * `infoHash` names (a pick, or a download carried on after a pause or a restart: no index is asked, its kept
   * trackers are used). A file that tags no audio language is heard before it is kept, and a dub is let go and the
   * next torrent tried. Unlike fetchAhead nothing is stopped: the subtitle chain and the remux run to their end. The
   * torrent stays in the swarm until `release`. Never throws.
   */
  async fetchKept(ref: StreamRef, options: TorrentResolveOptions & { infoHash?: string | null }): Promise<KeptResolve> {
    const attempts: ResolveAttempt[] = [];
    const skip = new Set((options.skip ?? []).map((hash) => hash.toLowerCase()));
    const pinned = options.infoHash ?? null;
    for (let round = 0; round < MAX_TORRENT_TRIES; round += 1) {
      const out = pinned !== null ? await this.keptByHash(ref, pinned, options) : await this.resolve(ref, { ...options, skip: [...skip] });
      attempts.push(...out.attempts);
      if (!out.ok) return { ok: false, error: keptFailure(attempts), attempts };
      const dub = await this.heardAsDub(out.torrent, out.source, options.audioLang);
      if (dub === null) {
        this.log(`[notesd] torrent: ${refLabel(ref)}: keeping ${out.torrent.name} (${out.torrent.infoHash.slice(0, 8)}), downloaded until it is whole`);
        return { ok: true, torrent: out.torrent, attempts };
      }
      // The torrent's `resolved` attempt is what was heard as a dub: it says so, so the failure reads `dubbed`.
      const label = torrentLabel(out.torrent.name);
      for (let i = 0; i < attempts.length; i += 1) {
        const a = attempts[i]!;
        if (a.provider === label && a.outcome === 'resolved') attempts[i] = { ...a, outcome: 'dubbed', detail: `${a.detail}; audio heard: ${dub}` };
      }
      this.noteDubbed(ref, out.torrent.infoHash, dub);
      this.dropKept(out.torrent);
      this.log(`[notesd] torrent: ${refLabel(ref)}: ${out.torrent.name} was heard as a dub (${dub}); not downloaded`);
      if (pinned !== null) break;
      skip.add(out.torrent.infoHash.toLowerCase());
    }
    return { ok: false, error: keptFailure(attempts), attempts };
  }

  /**
   * Where a kept download stands: its file whole on disk, its remux (none for a file Chrome plays as is), and whether
   * its subtitle chain is still searching. Never throws.
   */
  async keptState(torrent: SessionTorrent): Promise<KeptState> {
    const file = (await this.state(torrent)) === 'ready' ? 'whole' : 'downloading';
    const remux = torrent.manifestKind === 'hls' ? (this.opts.remux?.status(torrent.infoHash, torrent.fileIndex) ?? 'none') : 'none';
    return { file, remux, subtitles: (torrent.subtitlesPending ?? null) === null ? 'done' : 'searching' };
  }

  /** A kept download's remux that failed: started again once (the file is whole by then, so ffmpeg reads it from disk). Never throws. */
  async retryKeptRemux(torrent: SessionTorrent): Promise<void> {
    if (torrent.manifestKind !== 'hls' || !torrent.held) return;
    try {
      await this.opts.remux?.resume(torrent.infoHash, torrent.fileIndex);
    } catch (err) {
      this.log(`[notesd] torrent: the remux of ${torrent.name} (${torrent.infoHash.slice(0, 8)}) failed again: ${messageOf(err)}`);
    }
  }

  /** One torrent by its info hash, opened with the trackers this host kept for it and the shared ones; no index is asked. */
  private async keptByHash(ref: StreamRef, infoHash: string, options: TorrentResolveOptions): Promise<TorrentResolve> {
    const query = queryOf(ref, options.imdbId, options.names ?? null, options.audioLang);
    const base = candidateFromMagnet(infoHash, query);
    if (base === null) {
      return { ok: false, error: 'no_source', attempts: [{ provider: 'Torrent: magnet', outcome: 'error', took_s: 0, detail: 'not a 40-character info hash' }] };
    }
    const stored = (await Promise.resolve(this.opts.swarm.trackersOf?.(base.infoHash)).catch(() => undefined)) ?? [];
    const name = (await Promise.resolve(this.opts.swarm.releaseName?.(base.infoHash)).catch(() => null)) ?? base.name;
    const candidate: TorrentCandidate = { ...base, name, release: parseRelease(name), trackers: [...new Set([...stored, ...base.trackers])] };
    const play: PlayFacts = { audioLang: options.audioLang, imdbId: options.imdbId, resumeS: null, cloudTried: false };
    options.progress?.({ stage: `opening the torrent ${candidate.name}`, attempts: [] });
    return this.tryCandidates(ref, query, [candidate], play, this.now() + TORRENT_DEADLINE_MS, options.progress);
  }

  /** The reason a kept torrent's untagged audio was heard as a dub, or null (tagged, unknown original, no hearer, or not a dub). */
  private async heardAsDub(torrent: SessionTorrent, source: ResolvedSource, audioLang: string | null): Promise<string | null> {
    if (audioLang === null || !this.hears || (source.audio?.languages.length ?? 0) > 0) return null;
    const heard = await this.hearAudio(torrent, audioLang, 0);
    return heard?.verdict === 'dubbed' ? heard.reason : null;
  }

  /** Lets go of a kept torrent that will not be downloaded (a dub): its subtitle chain and remux stop, and it leaves the swarm at once. */
  private dropKept(torrent: SessionTorrent): void {
    torrent.stop.abort();
    if (!torrent.held) return;
    torrent.held = false;
    if (torrent.manifestKind === 'hls') this.opts.remux?.release(torrent.infoHash, torrent.fileIndex);
    this.dropNow(torrent.infoHash, true);
  }
```

**2e.** After the `TorrentResolve` type (line 218), insert:
```ts
/** What fetchKept answers: the torrent held for a download, or why none could be (`dubbed`: every torrent tried was a dub). */
export type KeptResolve =
  | { ok: true; torrent: SessionTorrent; attempts: ResolveAttempt[] }
  | { ok: false; error: 'no_source' | 'dubbed'; attempts: ResolveAttempt[] };

/** Where a kept download stands (TorrentSource.keptState). */
export interface KeptState {
  file: 'downloading' | 'whole';
  /** `none`: the file plays as is, or no remux runs for it. */
  remux: 'none' | 'running' | 'whole' | 'failed';
  subtitles: 'searching' | 'done';
}

/** `dubbed` when every torrent tried was refused or heard as a dub; else `no_source`. */
export function keptFailure(attempts: readonly ResolveAttempt[]): 'no_source' | 'dubbed' {
  const torrents = attempts.filter((a) => a.provider.startsWith(`${TORRENT_PROVIDER}: `) && a.outcome !== 'skipped');
  return torrents.length > 0 && torrents.every((a) => a.outcome === 'dubbed') ? 'dubbed' : 'no_source';
}
```
**Impact:** A play never sets `only` or calls `fetchKept`, so `resolve`, `fetchAhead`, `playMagnet` and `fromDisk` behave as before. `TorrentStreams` gains `trackersOf` in Step 3, so the daemon's swarm answers it. Test fakes may leave it out because the member is optional.

### Step 3: `TorrentStreams`: `keep`, `trackersOf`, `fileProgress`, and prunes that skip kept torrents
**File:** `src/directStream/torrent/service.ts`

**3a.** After line 45 (`TORRENT_RECENT_MS`), add:
```ts
/** The torrents the owner keeps as downloads (any row of it has `kept_at`): neither prune deletes them. */
const keptHashes = (rows: readonly StreamTorrentRow[]): Set<string> => new Set(rows.filter((r) => r.keptAt !== null).map((r) => r.infoHash));
```

**3b.** After `releaseName` (line 367), insert:
```ts
  /** The trackers this host's row of a torrent keeps; [] without a row (a download opened again by its info hash). */
  async trackersOf(infoHash: string): Promise<string[]> {
    const hash = normalizeInfoHash(infoHash);
    if (hash === null) return [];
    return (await this.repo.get(this.host, hash))?.trackers ?? [];
  }
```

**3c.** After `map` (line 517), insert:
```ts
  /**
   * How much of one chosen file is on this machine's disk now, for a download's progress: its whole length once it is
   * ready (or lives as its remux), else the verified bytes the swarm holds (the row's last count when not in the swarm).
   * Null for an unknown hash, the other machine's, or a file no episode chose.
   */
  async fileProgress(infoHash: string, fileIndex: number): Promise<{ bytesDone: number; length: number } | null> {
    const hash = normalizeInfoHash(infoHash);
    if (hash === null) return null;
    const found = await this.rowHere(hash, fileIndex);
    if (found instanceof Response) return null;
    const file = found.files.find((f) => f.index === fileIndex);
    if (file === undefined) return null;
    if (found.state === 'ready' || file.remuxed === true) return { bytesDone: file.length, length: file.length };
    const live = this.active.get(hash);
    const bytes = live !== undefined ? sumRanges(live.handle.ranges(fileIndex)) : found.bytesDone;
    return { bytesDone: Math.min(bytes, file.length), length: file.length };
  }
```

**3d.** After `inUse` (line 548), insert:
```ts
  /**
   * The owner's mark on a torrent of this host (a download they asked for): kept, the age prune and the budget leave
   * it alone until it is deleted on the Cache page; not kept, it prunes like any other. Every row of the torrent.
   */
  async keep(infoHash: string, kept: boolean): Promise<void> {
    const hash = normalizeInfoHash(infoHash);
    if (hash === null) return;
    const at = kept ? this.now() : null;
    await this.repo.setKept(this.host, hash, at);
    const live = this.active.get(hash);
    if (live !== undefined) for (const [key, row] of live.rows) live.rows.set(key, { ...row, keptAt: at });
  }
```

**3e.** Replace the first `try` block of `pruneNow` (lines 758-770) with:
```ts
    try {
      // A torrent goes when none of its episodes was played (else finished, else made) within keepDays; never one the owner keeps.
      const before = this.nowMs() - this.opts.keepDays * 86_400_000;
      const rows = await this.hostRows();
      const kept = keptHashes(rows);
      for (const [hash, { touched, name }] of this.lastActivity(rows)) {
        if (touched >= before || held(hash) || kept.has(hash)) continue;
        await this.folder.remove(hash);
        await this.repo.delete(this.host, hash);
        cleared += 1;
        this.log(`[notesd] torrent: cleared ${name}, not played for ${this.opts.keepDays} days`);
      }
    } catch (err) {
      this.log(`[notesd] torrent: could not clear old downloads: ${messageOf(err)}`);
    }
```

**3f.** Replace `keepBudget` (lines 799-846, doc comment included) with:
```ts
  /**
   * Deletes whole torrents (folder with its remux and cue files, and every row) until the torrent folder takes less
   * than `budgetBytes`. Never one in use, and never one the owner keeps as a download (its bytes still count). First
   * the downloads of titles the owner marked watched or not interested (`marked`), then the never played ones, oldest
   * first, then the played ones, least recently played first; a download played or finished within TORRENT_RECENT_MS
   * goes only when that was not enough (within each group).
   */
  private async keepBudget(held: (hash: string) => boolean): Promise<number> {
    const budget = this.opts.budgetBytes;
    if (budget === undefined) return 0;
    const sizes = new Map<string, number>();
    for (const hash of await this.folder.hashes()) sizes.set(hash, await this.folder.size(hash));
    let total = [...sizes.values()].reduce((a, b) => a + b, 0);
    if (total <= budget) return 0;
    const recentFrom = this.nowMs() - TORRENT_RECENT_MS;
    const rows = await this.hostRows();
    const kept = keptHashes(rows);
    // The titles the owner marked watched or not interested go first, whatever their age.
    const titleOf = (r: Pick<StreamTorrentRow, 'kind' | 'tmdbId'>): string => `${r.kind}-${r.tmdbId}`;
    let marked: ReadonlySet<string> = new Set();
    try {
      marked = (await this.opts.marked?.([...new Set(rows.map(titleOf))])) ?? new Set();
    } catch (err) {
      this.log(`[notesd] torrent: could not read which titles are watched or not interested: ${messageOf(err)}`);
    }
    const dismissed = new Set(rows.filter((r) => marked.has(titleOf(r))).map((r) => r.infoHash));
    const order = [...this.lastActivity(rows)]
      .filter(([hash]) => !held(hash) && !kept.has(hash) && (sizes.get(hash) ?? 0) > 0)
      .map(([hash, last]) => ({ hash, ...last, recent: last.touched >= recentFrom, dismissed: dismissed.has(hash) }))
      .sort(
        (a, b) =>
          Number(b.dismissed) - Number(a.dismissed) ||
          Number(a.recent) - Number(b.recent) ||
          Number(a.played !== null) - Number(b.played !== null) ||
          (a.played ?? a.touched) - (b.played ?? b.touched),
      );
    let cleared = 0;
    for (const t of order) {
      if (total <= budget) break;
      const size = sizes.get(t.hash) ?? 0;
      await this.folder.remove(t.hash);
      await this.repo.delete(this.host, t.hash);
      total -= size;
      cleared += 1;
      const why = `${t.dismissed ? 'watched or not interested, ' : ''}${t.played !== null ? `last played ${new Date(t.played).toISOString().slice(0, 10)}` : 'never played'}`;
      this.log(`[notesd] torrent: cleared ${t.name} (${gb(size)}, ${why}): the downloads took more than the ${gb(budget)} budget, ${gb(total)} now`);
    }
    if (total > budget) {
      const keptOnDisk = [...kept].filter((hash) => (sizes.get(hash) ?? 0) > 0);
      const keptBytes = keptOnDisk.reduce((n, hash) => n + (sizes.get(hash) ?? 0), 0);
      this.log(
        keptOnDisk.length === 0
          ? `[notesd] torrent: the downloads take ${gb(total)}, over the ${gb(budget)} budget, and what is left is in use`
          : `[notesd] torrent: the downloads take ${gb(total)}, over the ${gb(budget)} budget, and what is left is in use or kept by the owner (${keptOnDisk.length} kept download${keptOnDisk.length === 1 ? '' : 's'}, ${gb(keptBytes)})`,
      );
    }
    return cleared;
  }
```
**Impact:** The signature stays `keepBudget(held)` because it reads `kept` from its own `rows`, so `pruneNow`'s call does not change. The doc comment of `prune()` (line 647) is left as is: "kept" is stated at each rule. With nothing kept, existing `packAndBudget.test.ts` keeps the exact same log lines.

### Step 4: `DirectStreamService`: the facts a download needs, and the torrents on screen
**File:** `src/directStream/service.ts`

**4a.** Line 23: add `type TorrentResolveOptions` to the import from `./torrent/source.js`:
```ts
import { namesCloud, namesTorrent, PREFERRED_TORRENT_HEIGHT, SUBTITLES_PENDING, TORRENT_PROVIDER, type TorrentSource, type TorrentResolve, type TorrentResolveOptions, type MagnetReport } from './torrent/source.js';
```

**4b.** After `watched` (line 582), insert:
```ts
  /** What a download's torrent search needs of a title (src/directStream/downloads/): its original language, IMDb id, names and year. */
  async downloadFacts(ref: StreamRef): Promise<Pick<TorrentResolveOptions, 'audioLang' | 'imdbId' | 'names'>> {
    const namesHook = this.opts.hooks?.titleNames;
    return {
      audioLang: await this.audioLang(ref),
      imdbId: await this.imdbIdOf(ref),
      names: namesHook === undefined ? null : await this.hookValue('titleNames', () => namesHook(ref)),
    };
  }

  /**
   * The info hashes of the torrents stream sessions hold in the swarm now: a play from a torrent, on screen or being
   * reloaded. A replay from disk holds none (it joins no swarm). Downloads give way to these (play first).
   */
  torrentsOnScreen(): string[] {
    const out: string[] = [];
    for (const session of this.sessions.live()) if (session.torrent !== null && session.torrent.held) out.push(session.torrent.infoHash);
    return out;
  }
```
**Impact:** two additions. No existing path calls them.

### Step 5: `src/directStream/downloads/types.ts`
**File:** `src/directStream/downloads/types.ts` (new)
**Code:**
```ts
import type { StreamDownloadSource, StreamDownloadState, StreamDownloadVia } from '../../db/schema.js';
import type { KeptState, TorrentResolveOptions } from '../torrent/source.js';
import type { StreamRef } from '../types.js';

/**
 * Downloads the owner asks for (stream-downloads phase 2): one film or one episode at a time, persisted in
 * stream_downloads (written by DownloadsRepo only), kept on this machine until it is deleted on the Cache page.
 * These are the shapes the engine, its seams and (phase 4) the routes share.
 */

export type DownloadVia = StreamDownloadVia;
export type DownloadState = StreamDownloadState;
export type DownloadSource = StreamDownloadSource;

/** Which torrents a step may take: 1080p with live seeds (`preferred`), or below 1080p (`below`; 2160p is never taken unasked). */
export type TorrentBand = 'preferred' | 'below';

/** How a torrent step asks: by band (the indexes are asked), or one torrent by its info hash (a pick, a carry-on). */
export type TorrentAsk = { band: TorrentBand } | { infoHash: string };

/** What the owner asked for. `infoHash` only with `via: 'torrent'` (a torrent picked from the candidates list). */
export interface DownloadAsk {
  via: DownloadVia;
  infoHash?: string | null;
  /** The season click that made it (phase 3); null otherwise. */
  batch?: string | null;
}

/** What `request` answers: the row (null when the title is already whole here), and whether it was made by this ask. */
export interface DownloadRequestAnswer {
  download: DownloadView | null;
  created: boolean;
  /** The film or episode is already whole on this machine (a ready torrent download or cache): nothing was queued. */
  onDisk: boolean;
}

/** One download as `GET /api/stream/downloads` (phase 4) answers it. */
export interface DownloadView {
  id: string;
  host: string;
  /** True when the row is this machine's. */
  available: boolean;
  kind: 'movie' | 'tv';
  tmdb_id: number;
  /** Null for a film. */
  season: number | null;
  /** Null for a film. */
  episode: number | null;
  via: DownloadVia;
  info_hash: string | null;
  batch: string | null;
  /** `queued` also while the cloud cache holds it behind another of its downloads. */
  state: DownloadState;
  /** What it downloads from once one was found; null before. */
  source: DownloadSource | null;
  /** The torrent's info hash or the stream cache's id. */
  source_id: string | null;
  /** 0 to 1. */
  progress: number;
  bytes_done: number;
  /** Null when unknown (a cloud cache counts segments, not bytes). */
  bytes_total: number | null;
  /** The torrent's peers and download rate now; null for a cloud download or a torrent not in the swarm. */
  peers: number | null;
  down_kbps: number | null;
  /** Why it failed: `no_source`, `no_peers_here`, `dubbed`, `download_failed`, `torrent_off`, `cloud_off` or a cache's code. */
  error: string | null;
  detail: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export type DownloadErrorCode = 'invalid_request' | 'downloads_off' | 'unknown_download';

/** A request the engine refuses (phase 4 maps it to HTTP: 400, 503, 404). */
export class DownloadError extends Error {
  override readonly name = 'DownloadError';
  constructor(
    readonly code: DownloadErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The title facts a torrent search needs (DirectStreamService.downloadFacts). */
export type DownloadFacts = Pick<TorrentResolveOptions, 'audioLang' | 'imdbId' | 'names'>;

/** A torrent held for a download: what the engine knows of it. The adapter keeps the session torrent behind it. */
export interface KeptTorrentHandle {
  readonly infoHash: string;
  readonly fileIndex: number;
  readonly name: string;
}

/** A torrent step's answer: the torrent now downloading (`detail`: its name and height), or why none could be. */
export type TorrentFetch = { ok: true; handle: KeptTorrentHandle; detail: string } | { ok: false; error: 'no_source' | 'dubbed'; detail: string };

/** A held torrent now: KeptState plus its bytes and swarm. */
export type TorrentNow = KeptState & { bytesDone: number; bytesTotal: number | null; peers: number | null; downKbps: number | null };

/** The torrent side of the engine (torrentDownloadsOf over TorrentSource and TorrentStreams; tests pass a fake). */
export interface DownloadTorrents {
  /** True when this host holds a finished torrent download of `ref`. */
  onDisk(ref: StreamRef): Promise<boolean>;
  fetch(ref: StreamRef, ask: TorrentAsk): Promise<TorrentFetch>;
  now(handle: KeptTorrentHandle): Promise<TorrentNow>;
  /** Starts a failed remux again (once the file is whole). */
  retryRemux(handle: KeptTorrentHandle): Promise<void>;
  /** Lets go of the torrent: with no other user the daemon leaves its swarm. Safe twice. */
  release(handle: KeptTorrentHandle): void;
  /** Sets or clears the owner's mark that both prunes skip. */
  keep(infoHash: string, kept: boolean): Promise<void>;
}

/** A stream cache as the engine follows it. */
export interface CacheNow {
  id: string;
  state: 'downloading' | 'ready' | 'failed';
  running: boolean;
  queued: boolean;
  progress: number;
  bytes: number;
  maxHeight: number | null;
  error: string | null;
  errorDetail: string | null;
}

/** The cloud side of the engine (cacheDownloadsOf over StreamCache; tests pass a fake). */
export interface DownloadCaches {
  /** True when this host holds a ready cache of `ref`. */
  onDisk(ref: StreamRef): Promise<boolean>;
  /** The owner's cache of `ref` at `maxHeight` or lower (an existing cache of another height carries on at its own). */
  request(ref: StreamRef, maxHeight: number): Promise<CacheNow>;
  find(ref: StreamRef): Promise<CacheNow | null>;
  /** Stops the cache's download, keeping what is on disk. */
  pause(ref: StreamRef): Promise<boolean>;
}
```
**Impact:** new file.

### Step 6: `src/directStream/downloads/plan.ts`
**File:** `src/directStream/downloads/plan.ts` (new)
**Code:**
```ts
import { OFFICE_SSID } from '../../streaming/warp.js';
import type { SwarmCount, TorrentCandidate } from '../torrent/find/index.js';
import { PREFERRED_TORRENT_HEIGHT } from '../torrent/source.js';
import type { DownloadVia, TorrentBand } from './types.js';

/**
 * The source order of a download, pure. With no source named (`auto`): a 1080p torrent with live seeds, then the
 * owner's cloud cache at 1080p or lower, then a torrent below 1080p. On the office network (SSID Employee) torrent peers
 * are not reached and WARP is never switched for a download, so `auto` is the cloud alone and a torrent asked for
 * there fails with `no_peers_here`.
 */

/** The cloud cache's height cap for a download: the torrents' preferred height, so the cloud never beats the torrent it stands in for. */
export const CLOUD_MAX_HEIGHT = PREFERRED_TORRENT_HEIGHT;

export type CloudStep = { kind: 'cloud'; maxHeight: number };
export type DownloadStep = { kind: 'torrent'; band: TorrentBand } | { kind: 'hash'; infoHash: string } | CloudStep;

export type DownloadPlan = { ok: true; steps: DownloadStep[] } | { ok: false; error: 'no_peers_here' | 'torrent_off' | 'cloud_off' | 'no_source'; detail: string };

/** One step that did not give a download: what it was, the code, and what was seen. `step` null: before any step. */
export interface StepFailure {
  step: DownloadStep | null;
  error: string;
  detail: string;
}

/** True on the office network. */
export function isOffice(ssid: string | null): boolean {
  return ssid === OFFICE_SSID;
}

/** The steps of one download, in order; or why it cannot start here. */
export function planDownload(ask: { via: DownloadVia; infoHash: string | null }, here: { office: boolean; torrent: boolean; cloud: boolean }): DownloadPlan {
  const cloud: CloudStep = { kind: 'cloud', maxHeight: CLOUD_MAX_HEIGHT };
  const office: DownloadPlan = {
    ok: false,
    error: 'no_peers_here',
    detail: `this machine is on the office network (${OFFICE_SSID}), where torrent peers are not reached, and WARP is never switched for a download: download it from the cloud, or ask again on another network`,
  };
  const torrentOff: DownloadPlan = { ok: false, error: 'torrent_off', detail: 'torrents are off on this machine (NOTESD_TORRENT=off)' };
  if (ask.infoHash !== null) {
    if (here.office) return office;
    return here.torrent ? { ok: true, steps: [{ kind: 'hash', infoHash: ask.infoHash }] } : torrentOff;
  }
  if (ask.via === 'cloud') return here.cloud ? { ok: true, steps: [cloud] } : { ok: false, error: 'cloud_off', detail: 'the stream cache is off on this machine' };
  if (ask.via === 'torrent') {
    if (here.office) return office;
    return here.torrent ? { ok: true, steps: [{ kind: 'torrent', band: 'preferred' }, { kind: 'torrent', band: 'below' }] } : torrentOff;
  }
  if (here.office) return here.cloud ? { ok: true, steps: [cloud] } : office;
  const steps: DownloadStep[] = [];
  if (here.torrent) steps.push({ kind: 'torrent', band: 'preferred' });
  if (here.cloud) steps.push(cloud);
  if (here.torrent) steps.push({ kind: 'torrent', band: 'below' });
  return steps.length > 0 ? { ok: true, steps } : { ok: false, error: 'no_source', detail: 'neither torrents nor the stream cache are on on this machine' };
}

/** True when the swarm has a seeder: the trackers' word when any answered for it, else the seeds the index listed. */
export function liveSeeds(c: Pick<TorrentCandidate, 'seeds'>, count: SwarmCount | null): boolean {
  if (count !== null && count.trackers > 0) return count.seeders > 0;
  return c.seeds > 0;
}

/** Whether a found torrent belongs to a band: 1080p with live seeds, or below 1080p (a height its name does not say included; never 2160p). */
export function bandAllows(band: TorrentBand, c: Pick<TorrentCandidate, 'seeds' | 'release'>, count: SwarmCount | null): boolean {
  const height = c.release.height ?? null;
  if (band === 'preferred') return height === PREFERRED_TORRENT_HEIGHT && liveSeeds(c, count);
  return height !== PREFERRED_TORRENT_HEIGHT && height !== 2160;
}

/** The steps after the cloud step: what a download goes on to when its cache fails. */
export function stepsAfterCloud(steps: readonly DownloadStep[]): DownloadStep[] {
  const at = steps.findIndex((s) => s.kind === 'cloud');
  return at < 0 ? [] : steps.slice(at + 1);
}

export function stepLabel(step: DownloadStep | null): string {
  if (step === null) return 'download';
  if (step.kind === 'cloud') return `cloud at ${step.maxHeight}p or lower`;
  if (step.kind === 'hash') return `torrent ${step.infoHash.slice(0, 8)}`;
  return step.band === 'preferred' ? `torrent ${PREFERRED_TORRENT_HEIGHT}p` : `torrent below ${PREFERRED_TORRENT_HEIGHT}p`;
}

/**
 * Why a download failed once every step did: one step's own code, else `dubbed` when every step found only dubs, else
 * `no_source`. The detail names each step and what it saw.
 */
export function finalFailure(failures: readonly StepFailure[]): { error: string; detail: string } {
  if (failures.length === 0) return { error: 'no_source', detail: 'nothing could be tried' };
  const detail = failures.map((f) => `${stepLabel(f.step)}: ${f.error}${f.detail === '' ? '' : ` (${f.detail})`}`).join('; ');
  if (failures.length === 1) return { error: failures[0]!.error, detail };
  return { error: failures.every((f) => f.error === 'dubbed') ? 'dubbed' : 'no_source', detail };
}
```
**Impact:** new file.

### Step 7: `src/directStream/downloads/service.ts`
**File:** `src/directStream/downloads/service.ts` (new)
**Code:**
```ts
import type { Config } from '../../config.js';
import type { Db } from '../../db/client.js';
import type { StreamDownloadRow } from '../../db/schema.js';
import type { WarpSwitch } from '../../streaming/warp.js';
import type { StreamCache } from '../cache/service.js';
import { CacheError, type StreamCacheView } from '../cache/types.js';
import type { DirectStreamService } from '../service.js';
import type { SessionTorrent } from '../sessions.js';
import type { SwarmCount, TorrentCandidate } from '../torrent/find/index.js';
import type { TorrentSource } from '../torrent/source.js';
import type { TorrentStreams } from '../torrent/service.js';
import { normalizeInfoHash, PROGRESS_STEP_BYTES } from '../torrent/types.js';
import { refLabel, type ResolveAttempt, type StreamRef } from '../types.js';
import { bandAllows, CLOUD_MAX_HEIGHT, finalFailure, isOffice, planDownload, stepLabel, stepsAfterCloud, type CloudStep, type DownloadPlan, type DownloadStep, type StepFailure } from './plan.js';
import { DOWNLOAD_CANCELLED, downloadRef, DownloadsRepo, type DownloadOn, type DownloadRecords } from './repo.js';
import {
  DownloadError,
  type CacheNow,
  type DownloadAsk,
  type DownloadCaches,
  type DownloadFacts,
  type DownloadRequestAnswer,
  type DownloadState,
  type DownloadTorrents,
  type DownloadView,
  type KeptTorrentHandle,
  type TorrentFetch,
} from './types.js';

/** How often the engine looks at what it downloads (progress, a play on screen, a cache's end). */
export const DOWNLOAD_TICK_MS = 5_000;
/** A torrent download carried on by its info hash (a pause, a restart) whose swarm gave nothing is tried this many times. */
export const DOWNLOAD_RESUME_TRIES = 3;
/** ...this far apart. */
export const DOWNLOAD_RETRY_MS = 60_000;
/** The SSID is read once a minute at most (warp.mjs runs a Windows program). */
export const SSID_TTL_MS = 60_000;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const share = (n: number): number => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;

export interface StreamDownloadsOptions {
  /** os.hostname(): rows are made and read under it. */
  host: string;
  repo: DownloadRecords;
  /** Null with torrents off. */
  torrents: DownloadTorrents | null;
  /** Null without the stream cache. */
  caches: DownloadCaches | null;
  /** The Wi-Fi network's name, or null (none, or it could not be read). Only ever read: a download never switches WARP. */
  ssid: () => Promise<string | null>;
  /** The info hashes of the torrents playing on screen now (DirectStreamService.torrentsOnScreen). */
  playingTorrents: () => readonly string[];
  /** Told when a download is whole: the seek previews' sweep queues its sheets. */
  afterDone?: () => void;
  now?: () => Date;
  log?: (line: string) => void;
  /** Runs `fn` every `ms`; answers how to stop it. Default setInterval, unref'd. Tests pass a no-op and call tick(). */
  every?: (fn: () => void, ms: number) => () => void;
}

/** The one download fetching from a torrent (or being planned) now. */
interface Job {
  readonly id: string;
  readonly ref: StreamRef;
  handle: KeptTorrentHandle | null;
  /** Cancelled, paused or closed: whatever its run finds now is let go. */
  stopped: boolean;
  remuxRetried: boolean;
  lastBytes: number;
  /** The torrent a carried-on download fetched before (its kept mark is cleared if it fails for good). */
  readonly sourceHash: string | null;
}

/** A download handed to the stream cache, followed until the cache is ready or failed. */
interface CloudFollow {
  ref: StreamRef;
  step: CloudStep;
  /** What it goes on to when the cache fails (auto: a torrent below 1080p). */
  after: DownloadStep[];
  failures: StepFailure[];
}

const defaultEvery = (fn: () => void, ms: number): (() => void) => {
  const timer = setInterval(fn, ms);
  timer.unref();
  return () => clearInterval(timer);
};

/**
 * Downloads the owner asks for (stream-downloads phase 2), held in AppDeps.streamDownloads; phase 4's routes and tool
 * call request, list and cancel. One torrent download at a time; a cloud download is handed to the stream cache, whose
 * own queue runs it. A torrent download gives way to a torrent playing on screen (paused, carried on when the play
 * ends). What a start finds queued, running or paused carries on from what is on disk.
 */
export class StreamDownloads {
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly every: (fn: () => void, ms: number) => () => void;
  private job: Job | null = null;
  private current: Promise<void> | null = null;
  private readonly clouds = new Map<string, CloudFollow>();
  /** Steps left after a cache failed, for the row's next run. */
  private readonly pending = new Map<string, { steps: DownloadStep[]; failures: StepFailure[] }>();
  private readonly retries = new Map<string, { tries: number; at: number }>();
  private tickRun: Promise<void> | null = null;
  private tickAgain = false;
  private stopTimer: (() => void) | null = null;
  private closed = false;

  constructor(private readonly opts: StreamDownloadsOptions) {
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((line: string) => console.log(line));
    this.every = opts.every ?? defaultEvery;
  }

  get host(): string {
    return this.opts.host;
  }

  /**
   * Queues one film or episode and answers at once. A title already whole on this machine queues nothing (`onDisk`); a
   * slot already queued, running or paused is answered as it is (`created: false`). Throws DownloadError
   * `invalid_request` (a malformed info hash, or one without `via: torrent`) or `downloads_off` (the daemon stops).
   */
  async request(ref: StreamRef, ask: DownloadAsk): Promise<DownloadRequestAnswer> {
    if (this.closed) throw new DownloadError('downloads_off', 'The daemon is stopping.');
    const infoHash = ask.infoHash == null ? null : normalizeInfoHash(ask.infoHash);
    if (ask.infoHash != null && infoHash === null) throw new DownloadError('invalid_request', 'An info hash is 40 hexadecimal characters.');
    if (infoHash !== null && ask.via !== 'torrent') throw new DownloadError('invalid_request', 'A torrent picked by its info hash is downloaded with via "torrent".');
    if (await this.onDisk(ref)) return { download: null, created: false, onDisk: true };
    const { row, created } = await this.opts.repo.create(this.host, { ref, via: ask.via, infoHash, batch: ask.batch ?? null }, this.now());
    if (created) this.log(`[notesd] downloads: queued ${refLabel(ref)} (${ask.via}${infoHash === null ? '' : ` ${infoHash.slice(0, 8)}`})`);
    void this.tick();
    return { download: await this.viewOf(row), created, onDisk: false };
  }

  /**
   * Stops a download that is not finished: its torrent is let go and loses the owner's mark (unless another download
   * keeps it), a cloud download's cache stops with what it has on disk. The row is failed with `cancelled` and leaves
   * the list. A finished or failed one is answered as it is. Throws DownloadError `unknown_download`.
   */
  async cancel(id: string): Promise<DownloadView> {
    const row = await this.opts.repo.get(this.host, id);
    if (row === null) throw new DownloadError('unknown_download', 'No download of this machine has this id.');
    if (row.state === 'done' || row.state === 'failed') return this.viewOf(row);
    const ref = downloadRef(row);
    const job = this.job;
    if (job !== null && job.id === id) {
      this.job = null;
      job.stopped = true;
      if (job.handle !== null) this.opts.torrents?.release(job.handle);
    }
    if (this.clouds.delete(id)) await this.opts.caches?.pause(ref).catch(() => false);
    this.pending.delete(id);
    this.retries.delete(id);
    const cancelled = await this.opts.repo.cancel(this.host, id, this.now());
    if (row.source === 'torrent' && row.sourceId !== null) await this.unkeep(row.sourceId, id);
    this.log(`[notesd] downloads: cancelled ${refLabel(ref)}`);
    void this.tick();
    return this.viewOf(cancelled ?? row);
  }

  /**
   * This host's downloads not finished (queued, running, paused, failed; a cancelled one is left out), in the queue's
   * order, with live progress. With a title filter (the title page) also that title's finished downloads: the latest
   * `done` row per film or episode, and only while that film or episode is still whole here (one deleted on the Cache
   * page is no longer "on this machine"). Without a filter no `done` row is listed.
   */
  async list(filter?: { kind: 'movie' | 'tv'; tmdbId: number }): Promise<DownloadView[]> {
    const title = filter === undefined ? {} : { kind: filter.kind, tmdbId: filter.tmdbId };
    const open = (await this.opts.repo.list(this.host, { ...title, states: ['queued', 'running', 'paused', 'failed'] })).filter((r) => r.error !== DOWNLOAD_CANCELLED);
    const done: StreamDownloadRow[] = [];
    if (filter !== undefined) {
      const latest = new Map<string, StreamDownloadRow>();
      for (const r of await this.opts.repo.list(this.host, { ...title, states: ['done'] })) latest.set(`${r.season}x${r.episode}`, r);
      for (const r of latest.values()) if (await this.onDisk(downloadRef(r))) done.push(r);
    }
    return Promise.all([...open, ...done].map((r) => this.viewOf(r)));
  }

  /** A daemon start: what was queued, running or paused is queued again and carried on from what is on disk. Returns how many. */
  async start(): Promise<number> {
    const rows = await this.opts.repo.toResume(this.host, this.now());
    this.stopTimer ??= this.every(() => void this.tick(), DOWNLOAD_TICK_MS);
    void this.tick();
    return rows.length;
  }

  /** Lets go of the torrent held (its row stays running: the next start carries it on). Waits for nothing that runs long. */
  async close(): Promise<void> {
    this.closed = true;
    this.stopTimer?.();
    this.stopTimer = null;
    const job = this.job;
    this.job = null;
    if (job !== null) {
      job.stopped = true;
      if (job.handle !== null) this.opts.torrents?.release(job.handle);
    }
    this.clouds.clear();
  }

  /** One look: play first, the torrent held, the caches followed, the next download started. One at a time; an ask meanwhile runs once more after. */
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.tickRun !== null) {
      this.tickAgain = true;
      return this.tickRun;
    }
    const run = (async () => {
      try {
        do {
          this.tickAgain = false;
          await this.tickOnce();
        } while (this.tickAgain && !this.closed);
      } finally {
        this.tickRun = null;
      }
    })();
    this.tickRun = run;
    return run;
  }

  /** Resolves once no look and no download start runs (tests). */
  async settled(): Promise<void> {
    for (;;) {
      const waiting = [this.tickRun, this.current].filter((p): p is Promise<void> => p !== null);
      if (waiting.length === 0) return;
      await Promise.all(waiting);
    }
  }

  private async tickOnce(): Promise<void> {
    try {
      await this.playFirst();
      await this.followTorrent();
      await this.followClouds();
      await this.startNext();
    } catch (err) {
      this.log(`[notesd] downloads: ${messageOf(err)}`);
    }
  }

  /** A torrent playing on screen (another than the one downloaded): the torrent download lets go of its swarm and waits. */
  private async playFirst(): Promise<void> {
    const job = this.job;
    const handle = job?.handle ?? null;
    if (job === null || handle === null) return;
    if (!this.opts.playingTorrents().some((hash) => hash !== handle.infoHash)) return;
    this.job = null;
    job.stopped = true;
    this.opts.torrents?.release(handle);
    await this.opts.repo.setState(this.host, job.id, 'paused', this.now());
    this.log(`[notesd] downloads: paused ${refLabel(job.ref)} (${handle.name}): a torrent plays on screen; it carries on when the play ends`);
  }

  /** The torrent held: its progress written, and once its file, remux and subtitle search are done it is let go, finished. */
  private async followTorrent(): Promise<void> {
    const job = this.job;
    const torrents = this.opts.torrents;
    const handle = job?.handle ?? null;
    if (job === null || handle === null || torrents === null) return;
    const now = await torrents.now(handle);
    if (this.job !== job) return;
    if (Math.abs(now.bytesDone - job.lastBytes) >= PROGRESS_STEP_BYTES || (now.file === 'whole' && now.bytesDone !== job.lastBytes)) {
      job.lastBytes = now.bytesDone;
      await this.opts.repo.progress(this.host, job.id, now.bytesDone, now.bytesTotal, this.now());
    }
    if (now.file !== 'whole') return;
    if (now.remux === 'failed' && !job.remuxRetried) {
      job.remuxRetried = true;
      await torrents.retryRemux(handle);
      return;
    }
    if (now.remux === 'running' || now.subtitles === 'searching') return;
    if (this.job !== job) return;
    this.job = null;
    torrents.release(handle);
    const on: DownloadOn = { source: 'torrent', infoHash: handle.infoHash };
    await this.opts.repo.done(this.host, job.id, on, { bytesDone: now.bytesTotal ?? now.bytesDone, bytesTotal: now.bytesTotal }, this.now());
    this.log(
      `[notesd] downloads: ${refLabel(job.ref)} is on this machine (${handle.name})${now.remux === 'failed' ? '; its remux failed twice, a play remuxes it from disk' : ''}`,
    );
    this.opts.afterDone?.();
  }

  /** Each download handed to the cache: finished when it is ready; on to the next step (or failed) when it failed. */
  private async followClouds(): Promise<void> {
    const caches = this.opts.caches;
    if (caches === null) return;
    for (const [id, follow] of [...this.clouds]) {
      let cache: CacheNow | null;
      try {
        cache = await caches.find(follow.ref);
      } catch (err) {
        this.log(`[notesd] downloads: could not read the cache of ${refLabel(follow.ref)}: ${messageOf(err)}`);
        continue;
      }
      if (!this.clouds.has(id)) continue;
      if (cache === null) {
        // Its cache was deleted on the Cache page while it downloaded.
        this.clouds.delete(id);
        await this.opts.repo.failed(this.host, id, DOWNLOAD_CANCELLED, 'its cache was deleted', this.now());
        continue;
      }
      if (cache.state === 'ready') {
        this.clouds.delete(id);
        await this.finishCloud(id, follow.ref, cache);
        continue;
      }
      if (cache.state === 'failed') {
        this.clouds.delete(id);
        const failures = [...follow.failures, { step: follow.step, error: cache.error ?? 'download_failed', detail: cache.errorDetail ?? '' }];
        if (follow.after.length > 0) {
          this.pending.set(id, { steps: follow.after, failures });
          await this.opts.repo.setState(this.host, id, 'queued', this.now());
          this.log(`[notesd] downloads: the cloud cache of ${refLabel(follow.ref)} failed (${cache.error ?? 'failed'}); ${stepLabel(follow.after[0]!)} next`);
        } else {
          await this.fail(id, follow.ref, failures, null);
        }
        continue;
      }
      // Downloading: a cache neither running nor queued was stopped (a restart of the cache, the ahead rules): asked again.
      if (!cache.running && !cache.queued) await caches.request(follow.ref, follow.step.maxHeight).catch((err: unknown) => this.log(`[notesd] downloads: could not carry on the cache of ${refLabel(follow.ref)}: ${messageOf(err)}`));
      await this.opts.repo.progress(this.host, id, cache.bytes, null, this.now());
    }
  }

  /** The oldest queued or paused download whose first step can run now, started behind this look. */
  private async startNext(): Promise<void> {
    if (this.job !== null || this.closed) return;
    const rows = (await this.opts.repo.list(this.host, { states: ['queued', 'paused'] })).filter((r) => !this.clouds.has(r.id));
    if (rows.length === 0) return;
    const at = this.now().getTime();
    const playing = this.opts.playingTorrents().length > 0;
    let office: boolean | null = null;
    for (const row of rows) {
      if (this.job !== null || this.closed) return;
      if ((this.retries.get(row.id)?.at ?? 0) > at) continue;
      office ??= isOffice(await this.opts.ssid());
      const resumeHash = row.source === 'torrent' ? row.sourceId : null;
      // A torrent download carried on waits off the office network: nothing there reaches its peers.
      if (resumeHash !== null && office) continue;
      const plan = this.planOf(row, office);
      if (!plan.ok) {
        await this.fail(row.id, downloadRef(row), [{ step: null, error: plan.error, detail: plan.detail }], null);
        continue;
      }
      // Play first: a torrent download does not start while a torrent plays on screen; a cloud one does.
      if (playing && plan.steps[0]!.kind !== 'cloud') continue;
      const job: Job = { id: row.id, ref: downloadRef(row), handle: null, stopped: false, remuxRetried: false, lastBytes: row.bytesDone, sourceHash: resumeHash };
      this.job = job;
      const before = this.pending.get(row.id)?.failures ?? [];
      this.pending.delete(row.id);
      const run = this.run(job, plan.steps, before, resumeHash !== null);
      this.current = run;
      void run.finally(() => {
        if (this.current === run) this.current = null;
      });
      return;
    }
  }

  /** The steps of a row: what a failed cache left, a carry-on by info hash, a cache followed again, or its whole plan. */
  private planOf(row: StreamDownloadRow, office: boolean): DownloadPlan {
    const pending = this.pending.get(row.id);
    if (pending !== undefined) return { ok: true, steps: pending.steps };
    if (row.source === 'torrent' && row.sourceId !== null) return { ok: true, steps: [{ kind: 'hash', infoHash: row.sourceId }] };
    const full = planDownload({ via: row.via, infoHash: row.infoHash }, { office, torrent: this.opts.torrents !== null, cloud: this.opts.caches !== null });
    if (row.source === 'cloud' && full.ok) return { ok: true, steps: [{ kind: 'cloud', maxHeight: CLOUD_MAX_HEIGHT }, ...stepsAfterCloud(full.steps)] };
    return full;
  }

  /** One download's steps, in order, until a torrent is held, the cache took it, or every step failed. Never throws. */
  private async run(job: Job, steps: readonly DownloadStep[], before: readonly StepFailure[], resume: boolean): Promise<void> {
    const failures: StepFailure[] = [...before];
    try {
      await this.opts.repo.setState(this.host, job.id, 'running', this.now());
      for (let i = 0; i < steps.length; i += 1) {
        if (job.stopped) return;
        const step = steps[i]!;
        if (step.kind === 'cloud') {
          if (await this.startCloud(job, step, steps.slice(i + 1), failures)) return;
          continue;
        }
        const torrents = this.opts.torrents;
        if (torrents === null) {
          failures.push({ step, error: 'torrent_off', detail: 'torrents are off on this machine' });
          continue;
        }
        const fetched: TorrentFetch = await torrents.fetch(job.ref, step.kind === 'hash' ? { infoHash: step.infoHash } : { band: step.band });
        if (job.stopped || this.job !== job) {
          if (fetched.ok) torrents.release(fetched.handle);
          return;
        }
        if (!fetched.ok) {
          failures.push({ step, error: fetched.error, detail: fetched.detail });
          continue;
        }
        job.handle = fetched.handle;
        this.retries.delete(job.id);
        await torrents.keep(fetched.handle.infoHash, true);
        await this.opts.repo.on(this.host, job.id, { source: 'torrent', infoHash: fetched.handle.infoHash }, this.now());
        this.log(`[notesd] downloads: ${refLabel(job.ref)} downloads from the torrent ${fetched.detail}, kept until it is deleted on the Cache page`);
        return;
      }
      if (job.stopped || this.closed) return;
      if (resume && (await this.retryLater(job, failures))) return;
      await this.fail(job.id, job.ref, failures, job.sourceHash);
    } catch (err) {
      if (this.closed || job.stopped) return;
      this.log(`[notesd] downloads: ${refLabel(job.ref)}: ${messageOf(err)}`);
      await this.fail(job.id, job.ref, [...failures, { step: null, error: 'download_failed', detail: messageOf(err) }], job.sourceHash).catch(() => undefined);
    } finally {
      if (this.job === job && job.handle === null) this.job = null;
      if (this.job === null) void this.tick();
    }
  }

  /** The cloud step: the owner's cache at `maxHeight` or lower, followed from now on. False when the cache could not take it. */
  private async startCloud(job: Job, step: CloudStep, after: DownloadStep[], failures: StepFailure[]): Promise<boolean> {
    const caches = this.opts.caches;
    if (caches === null) {
      failures.push({ step, error: 'cloud_off', detail: 'the stream cache is off on this machine' });
      return false;
    }
    let cache: CacheNow;
    try {
      cache = await caches.request(job.ref, step.maxHeight);
    } catch (err) {
      failures.push({ step, error: 'download_failed', detail: messageOf(err) });
      return false;
    }
    if (job.stopped || this.job !== job) return true;
    if (cache.state === 'ready') {
      await this.finishCloud(job.id, job.ref, cache);
      return true;
    }
    await this.opts.repo.on(this.host, job.id, { source: 'cloud', cacheId: cache.id }, this.now());
    this.clouds.set(job.id, { ref: job.ref, step, after, failures: [...failures] });
    this.log(`[notesd] downloads: ${refLabel(job.ref)} downloads into the stream cache at ${cache.maxHeight === null ? 'the highest quality' : `${cache.maxHeight}p or lower`}`);
    return true;
  }

  private async finishCloud(id: string, ref: StreamRef, cache: CacheNow): Promise<void> {
    await this.opts.repo.done(this.host, id, { source: 'cloud', cacheId: cache.id }, { bytesDone: cache.bytes, bytesTotal: cache.bytes }, this.now());
    this.log(`[notesd] downloads: ${refLabel(ref)} is on this machine (the stream cache ${cache.id})`);
    this.opts.afterDone?.();
  }

  /** A carried-on torrent download whose swarm gave nothing: queued again a minute later, DOWNLOAD_RESUME_TRIES times in all. */
  private async retryLater(job: Job, failures: readonly StepFailure[]): Promise<boolean> {
    const tries = (this.retries.get(job.id)?.tries ?? 0) + 1;
    if (tries >= DOWNLOAD_RESUME_TRIES) {
      this.retries.delete(job.id);
      return false;
    }
    this.retries.set(job.id, { tries, at: this.now().getTime() + DOWNLOAD_RETRY_MS });
    await this.opts.repo.setState(this.host, job.id, 'queued', this.now());
    this.log(`[notesd] downloads: ${refLabel(job.ref)} could not carry on (${finalFailure(failures).detail}); trying again in ${Math.round(DOWNLOAD_RETRY_MS / 1000)} s`);
    return true;
  }

  /** Every step failed: the row says why (R1.11); a torrent it had kept loses the owner's mark. */
  private async fail(id: string, ref: StreamRef, failures: readonly StepFailure[], keptHash: string | null): Promise<void> {
    const final = finalFailure(failures);
    await this.opts.repo.failed(this.host, id, final.error, final.detail, this.now());
    if (keptHash !== null) await this.unkeep(keptHash, id);
    this.log(`[notesd] downloads: ${refLabel(ref)} could not be downloaded: ${final.error} (${final.detail})`);
  }

  /** Clears a torrent's kept mark unless another download of this host (not failed) still names it. */
  private async unkeep(infoHash: string, exceptId: string): Promise<void> {
    const rows = await this.opts.repo.list(this.host, { states: ['queued', 'running', 'paused', 'done'] });
    if (rows.some((r) => r.id !== exceptId && r.source === 'torrent' && r.sourceId === infoHash)) return;
    await this.opts.torrents?.keep(infoHash, false).catch((err: unknown) => this.log(`[notesd] downloads: could not clear the kept mark of ${infoHash.slice(0, 8)}: ${messageOf(err)}`));
  }

  private async onDisk(ref: StreamRef): Promise<boolean> {
    const torrent = (await this.opts.torrents?.onDisk(ref).catch(() => false)) === true;
    return torrent || (await this.opts.caches?.onDisk(ref).catch(() => false)) === true;
  }

  private async viewOf(row: StreamDownloadRow): Promise<DownloadView> {
    let state: DownloadState = row.state;
    let bytesDone = row.bytesDone;
    let bytesTotal = row.bytesTotal;
    let peers: number | null = null;
    let downKbps: number | null = null;
    let progress: number | null = null;
    const job = this.job;
    if (job !== null && job.id === row.id && job.handle !== null && this.opts.torrents !== null) {
      try {
        const now = await this.opts.torrents.now(job.handle);
        bytesDone = now.bytesDone;
        bytesTotal = now.bytesTotal;
        peers = now.peers;
        downKbps = now.downKbps;
      } catch {
        // The row's last count stands.
      }
    }
    if (this.clouds.has(row.id) && this.opts.caches !== null) {
      const cache = await this.opts.caches.find(downloadRef(row)).catch(() => null);
      if (cache !== null) {
        progress = cache.progress;
        bytesDone = cache.bytes;
        bytesTotal = null;
        if (cache.queued) state = 'queued';
      }
    }
    progress ??= row.state === 'done' ? 1 : bytesTotal !== null && bytesTotal > 0 ? share(bytesDone / bytesTotal) : 0;
    return {
      id: row.id,
      host: row.host,
      available: row.host === this.host,
      kind: row.kind,
      tmdb_id: row.tmdbId,
      season: row.kind === 'tv' ? row.season : null,
      episode: row.kind === 'tv' ? row.episode : null,
      via: row.via,
      info_hash: row.infoHash,
      batch: row.batch,
      state,
      source: row.source,
      source_id: row.sourceId,
      progress,
      bytes_done: bytesDone,
      bytes_total: bytesTotal,
      peers,
      down_kbps: downKbps,
      error: row.error,
      detail: row.errorDetail,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
      finished_at: row.completedAt === null ? null : row.completedAt.toISOString(),
    };
  }
}

/**
 * The SSID as a download reads it: warp.mjs's `status`, once a minute at most. Typed to `status` alone, so nothing a
 * download holds can switch WARP. A status that cannot be read is no network (not the office).
 */
export function ssidFrom(warp: Pick<WarpSwitch, 'status'>, options: { ttlMs?: number; now?: () => number } = {}): () => Promise<string | null> {
  const ttlMs = options.ttlMs ?? SSID_TTL_MS;
  const now = options.now ?? (() => Date.now());
  let kept: { at: number; ssid: string | null } | null = null;
  return async () => {
    if (kept !== null && now() - kept.at < ttlMs) return kept.ssid;
    let ssid: string | null = null;
    try {
      const state = await warp.status();
      ssid = state.ok ? state.ssid : null;
    } catch {
      ssid = null;
    }
    kept = { at: now(), ssid };
    return ssid;
  };
}

/**
 * The SSID pinned by NOTESD_STREAM_DOWNLOAD_SSID: answered as it is, and nothing is read (verify.sh pins it, so a
 * throwaway daemon never runs warp.mjs to read the machine's real network).
 */
export function fixedSsid(ssid: string): () => Promise<string | null> {
  return async () => ssid;
}

/** The last attempts of a torrent step that found nothing, for the row's detail (no key or token is in them). */
export function attemptsText(attempts: readonly ResolveAttempt[]): string {
  const said = attempts.filter((a) => a.outcome !== 'skipped' && (a.provider.startsWith('Torrent: ') || a.provider.startsWith('Index: ')));
  const text = said
    .slice(-4)
    .map((a) => `${a.provider}: ${a.outcome}${a.detail === '' ? '' : ` (${a.detail})`}`)
    .join('; ');
  return (text === '' ? 'no torrent was found' : text).slice(0, 400);
}

/** The torrent side over TorrentSource (built on first use, so read each time) and TorrentStreams. */
export function torrentDownloadsOf(source: () => TorrentSource | null, streams: TorrentStreams, facts: (ref: StreamRef) => Promise<DownloadFacts>): DownloadTorrents {
  const held = new WeakMap<KeptTorrentHandle, SessionTorrent>();
  return {
    onDisk: async (ref) => (await source()?.onDisk(ref)) === true,
    fetch: async (ref, ask) => {
      const s = source();
      if (s === null) return { ok: false, error: 'no_source', detail: 'torrents are off on this machine' };
      const title = await facts(ref);
      const band = 'band' in ask ? ask.band : null;
      const out = await s.fetchKept(ref, {
        ...title,
        resumeS: null,
        ...(band === null ? {} : { only: (c: TorrentCandidate, count: SwarmCount | null): boolean => bandAllows(band, c, count) }),
        ...('infoHash' in ask ? { infoHash: ask.infoHash } : {}),
      });
      if (!out.ok) return { ok: false, error: out.error, detail: attemptsText(out.attempts) };
      const handle: KeptTorrentHandle = { infoHash: out.torrent.infoHash, fileIndex: out.torrent.fileIndex, name: out.torrent.name };
      held.set(handle, out.torrent);
      return { ok: true, handle, detail: `${out.torrent.name}${out.torrent.height === null ? '' : `, ${out.torrent.height}p`}` };
    },
    now: async (handle) => {
      const torrent = held.get(handle);
      const s = source();
      const kept = torrent === undefined || s === null ? { file: 'downloading' as const, remux: 'none' as const, subtitles: 'done' as const } : await s.keptState(torrent);
      const file = await streams.fileProgress(handle.infoHash, handle.fileIndex);
      const stats = streams.stats(handle.infoHash);
      return { ...kept, bytesDone: file?.bytesDone ?? 0, bytesTotal: file?.length ?? null, peers: stats?.peers ?? null, downKbps: stats?.down_kbps ?? null };
    },
    retryRemux: async (handle) => {
      const torrent = held.get(handle);
      if (torrent !== undefined) await source()?.retryKeptRemux(torrent);
    },
    release: (handle) => {
      const torrent = held.get(handle);
      if (torrent === undefined) return;
      held.delete(handle);
      source()?.release(torrent);
    },
    keep: (infoHash, kept) => streams.keep(infoHash, kept),
  };
}

/** The cloud side over StreamCache: always the owner's cache (not `auto`), so the cache's prune never clears it. */
export function cacheDownloadsOf(cache: StreamCache): DownloadCaches {
  const nowOf = (v: StreamCacheView): CacheNow => ({
    id: v.id,
    state: v.state,
    running: v.running,
    queued: v.queued,
    progress: v.progress,
    bytes: v.bytes,
    maxHeight: v.max_height,
    error: v.error,
    errorDetail: v.error_detail,
  });
  return {
    onDisk: async (ref) => (await cache.find(ref))?.state === 'ready',
    request: async (ref, maxHeight) => {
      try {
        return nowOf((await cache.request(ref, { maxHeight })).cache);
      } catch (err) {
        // A cache of this title at another height already exists here: it is carried on (and becomes the owner's) at its own.
        if (err instanceof CacheError && err.code === 'cache_exists' && err.extra.cache !== undefined) {
          return nowOf((await cache.request(ref, { maxHeight: err.extra.cache.max_height })).cache);
        }
        throw err;
      }
    },
    find: async (ref) => {
      const v = await cache.find(ref);
      return v === null ? null : nowOf(v);
    },
    pause: (ref) => cache.pause(ref),
  };
}

/**
 * The daemon's download engine, or null with NOTESD_STREAM_DOWNLOADS=off, without direct streaming, or with neither
 * torrents nor the stream cache. Building it starts nothing: startBackground calls `start`.
 */
export function buildStreamDownloads(
  config: Config,
  wiring: {
    db: Db;
    directStream: DirectStreamService | null;
    torrentSource: () => TorrentSource | null;
    torrents: TorrentStreams | null;
    streamCache: StreamCache | null;
    warp: Pick<WarpSwitch, 'status'>;
    afterDone?: () => void;
    log?: (line: string) => void;
  },
): StreamDownloads | null {
  const ds = wiring.directStream;
  if (config.directStream?.downloads !== true || ds === null || (wiring.torrents === null && wiring.streamCache === null)) return null;
  return new StreamDownloads({
    host: ds.host,
    repo: new DownloadsRepo(wiring.db),
    torrents: wiring.torrents === null ? null : torrentDownloadsOf(wiring.torrentSource, wiring.torrents, (ref) => ds.downloadFacts(ref)),
    caches: wiring.streamCache === null ? null : cacheDownloadsOf(wiring.streamCache),
    ssid: config.directStream?.downloadSsid != null ? fixedSsid(config.directStream.downloadSsid) : ssidFrom(wiring.warp),
    playingTorrents: () => ds.torrentsOnScreen(),
    ...(wiring.afterDone === undefined ? {} : { afterDone: wiring.afterDone }),
    ...(wiring.log === undefined ? {} : { log: wiring.log }),
  });
}
```
**Impact:** new file. Every seam is injected (`DownloadTorrents`, `DownloadCaches`, `ssid`, `playingTorrents`, clock, timer), so unit tests reach no swarm, network, Chrome or WARP.

### Step 8: The switch `NOTESD_STREAM_DOWNLOADS`
**File:** `src/config.ts:228` (in `DirectStreamConfig`, after `previews?: boolean`) and `:977` (in `parseDirectStream`, after `previews: …`)
**Code:** after line 228 insert:
```ts
  /**
   * `NOTESD_STREAM_DOWNLOADS`, default on: films and episodes the owner asks to download (src/directStream/downloads/),
   * a 1080p torrent first, then the cloud cache, kept on this machine until deleted on the Cache page. It also needs
   * torrents or the stream cache. `off`, or unset in a literal: nothing is downloaded and what was queued waits.
   */
  downloads?: boolean
  /**
   * `NOTESD_STREAM_DOWNLOAD_SSID`: the Wi-Fi network a download's office rule (downloads/plan.ts) takes this machine to
   * be on. Unset (null): read from WARP's status (warp.mjs), once a minute at most. Set: that value is the SSID and
   * nothing is read; verify.sh pins it, so a throwaway daemon never reads the machine's real network.
   */
  downloadSsid?: string | null
```
after line 977 insert:
```ts
    downloads: parseSwitch('NOTESD_STREAM_DOWNLOADS', env.NOTESD_STREAM_DOWNLOADS),
    downloadSsid: env.NOTESD_STREAM_DOWNLOAD_SSID?.trim() || null,
```
**File:** `docs/guide/reference/configuration.md:145` (after the `NOTESD_STREAM_AHEAD` row) insert:
```markdown
| `NOTESD_STREAM_DOWNLOADS` | on | Downloads the owner asks for: one film or episode at a time, kept on this machine until it is deleted on the Cache page (neither the torrent age prune nor `NOTESD_TORRENT_BUDGET_GB` deletes it). With no source named, a 1080p torrent with live seeds first, then a cloud source at 1080p or lower, then a torrent below 1080p; on the office network (SSID `Employee`) the cloud alone, and WARP is never switched for a download. A torrent download pauses while a torrent plays on screen, and a restart carries every unfinished download on. It needs `NOTESD_TORRENT` or the stream cache. `off`: nothing is downloaded and what was queued waits. See [streaming.md](../streaming.md#caching-a-film-or-an-episode). |
| `NOTESD_STREAM_DOWNLOAD_SSID` | unset | The Wi-Fi network a download takes this machine to be on, for the office rule (SSID `Employee`: the cloud alone, no torrent). Unset: read from Cloudflare WARP's status, at most once a minute; a download only reads it and never switches WARP. Set: that value is the network and nothing is read. Every `verify.sh` daemon sets it to `verify-home`. |
```

**File:** `.claude/skills/verify-notesd/scripts/verify.sh:261`, directly after the line `    NOTESD_STREAM_WARP=off` in the env block, insert:
```bash
    # A throwaway daemon never reads the machine's Wi-Fi name for a download's office rule (downloads/plan.ts): the run
    # is "not the office", so a torrent download is tried wherever the run happens to be.
    NOTESD_STREAM_DOWNLOAD_SSID=verify-home
```
**Impact:** `tests/unit/config.test.ts` expects the exact parsed object. Step 11 adds `downloads: true` and `downloadSsid: null` there. `DEFAULT_DIRECT_STREAM_CONFIG` is unchanged: unset in a literal is off, so nothing new runs in tests. This phase adds no route and no MCP tool change, so `npm run docs:gen` has nothing to regenerate; `tests/unit/docs/reference.test.ts` checks the two configuration rows.

### Step 9: `AppDeps.streamDownloads` and the daemon's build
**File:** `src/deps.ts:16` (imports) and `:98` (after `torrents?`)
**Code:** add the import after line 16:
```ts
import type { StreamDownloads } from './directStream/downloads/service.js';
```
after line 98 insert:
```ts
  /**
   * Downloads the owner asks for (src/directStream/downloads/): the queue in stream_downloads, a 1080p torrent first,
   * then the cloud cache, kept until deleted on the Cache page. Null or absent with NOTESD_STREAM_DOWNLOADS=off or neither
   * torrents nor the stream cache. startBackground carries on what the last run left and closes it.
   */
  streamDownloads?: StreamDownloads | null;
```
**File:** `src/daemon.ts:71` (imports) and `:579` (after `deps.streamPreviews = …`)
**Code:** add after line 71:
```ts
import { buildStreamDownloads } from './directStream/downloads/service.js';
```
after line 579 insert:
```ts
  // Downloads the owner asks for (src/directStream/downloads/): one at a time, a 1080p torrent first, then the cloud
  // cache, kept until deleted on the Cache page. It reads the SSID through warp's status and never switches WARP.
  // A finished download's seek previews are queued at once. Null with NOTESD_STREAM_DOWNLOADS=off or neither source.
  deps.streamDownloads = buildStreamDownloads(config, {
    db,
    directStream,
    torrentSource: torrentSourceOf,
    torrents,
    streamCache,
    warp,
    afterDone: () => void deps.streamPreviews?.sweep(),
  });
```
**Impact:** Nothing runs until `startBackground` (Step 10). `createApp(deps)` does not read the field yet; phase 4 does.

### Step 10: Start after the torrents' start; close first
**File:** `src/background.ts:246-257` and `:282`
**Code:** replace lines 246-257 with:
```ts
  // Torrents (torrent-stream-source phase 1): old downloads are cleared and the tick starts; nothing joins a swarm here.
  const torrents = deps.torrents ?? null;
  const torrentsStarted: Promise<unknown> =
    torrents === null
      ? Promise.resolve()
      : torrents.start().then(
          (cleared) =>
            console.log(
              `[notesd] torrents on as ${torrents.host}: downloads in ${torrents.root}, upload capped at ${torrents.uploadKbps} kB/s` +
                (cleared > 0 ? `, ${cleared} download(s) not played for ${torrents.keepDays} days cleared` : ''),
            ),
          (err: unknown) => console.error(`[notesd] torrents: could not start: ${err instanceof Error ? err.message : String(err)}`),
        );

  // Downloads the owner asked for: what the last run left queued, running or paused carries on from what is on disk,
  // after the torrents' own start (its prune leaves kept downloads alone).
  const streamDownloads = deps.streamDownloads ?? null;
  if (streamDownloads !== null) {
    void torrentsStarted
      .then(() => streamDownloads.start())
      .then(
        (n) => {
          if (n > 0) console.log(`[notesd] downloads: carrying on ${n} download(s) on ${streamDownloads.host}`);
        },
        (err: unknown) => console.error(`[notesd] downloads: could not carry on downloads: ${err instanceof Error ? err.message : String(err)}`),
      );
  }
```
after line 282 (`await streamPreviews?.close();`) insert:
```ts
    // Before the torrents and the cache: the torrent a download holds is let go (its row stays running for the next start).
    await streamDownloads?.close();
```
**Impact:** The log line and the error path of the torrents' start are unchanged.

### Step 11: Config tests
**File:** `tests/unit/config.test.ts:58` and `:477`
**Change:** In both expected `directStream` objects, add `downloads: true,` and `downloadSsid: null,` after `previews: true,`.

**File:** `tests/unit/config.streamCache.test.ts` (after line 18)
**Code:**
```ts
    expect(parseDirectStream({}).downloads).toBe(true);
    expect(parseDirectStream({ NOTESD_STREAM_DOWNLOADS: 'off' }).downloads).toBe(false);
    expect(DEFAULT_DIRECT_STREAM_CONFIG.downloads).toBeUndefined();
    expect(parseDirectStream({}).downloadSsid).toBeNull();
    expect(parseDirectStream({ NOTESD_STREAM_DOWNLOAD_SSID: ' verify-home ' }).downloadSsid).toBe('verify-home');
```

### Step 12: Test fakes for the engine's seams
**File:** `tests/unit/directStream/downloads/fakes.ts` (new)
**Code:**
```ts
import type { CacheNow, DownloadCaches, DownloadTorrents, KeptTorrentHandle, TorrentAsk, TorrentFetch, TorrentNow } from '../../../../src/directStream/downloads/types.js';
import { refLabel, type StreamRef } from '../../../../src/directStream/types.js';

/** The torrent side, recorded: `fetch band:preferred`, `fetch hash:<h>`, `keep <h> true`, `release <h>`. */
export class FakeTorrents implements DownloadTorrents {
  readonly calls: string[] = [];
  /** What fetch answers, by `band:preferred`, `band:below` or `hash:<info hash>`; unset: no_source. */
  readonly answers = new Map<string, TorrentFetch>();
  /** Info hashes whose file is whole on disk. */
  readonly whole = new Set<string>();
  /** A held torrent's remux, by info hash; unset: none. */
  readonly remux = new Map<string, TorrentNow['remux']>();
  /** Info hashes whose subtitle search still runs. */
  readonly searching = new Set<string>();
  /** refLabel of the titles already whole here. */
  readonly onDiskRefs = new Set<string>();
  readonly kept = new Map<string, boolean>();

  async onDisk(ref: StreamRef): Promise<boolean> {
    return this.onDiskRefs.has(refLabel(ref));
  }

  async fetch(_ref: StreamRef, ask: TorrentAsk): Promise<TorrentFetch> {
    const key = 'band' in ask ? `band:${ask.band}` : `hash:${ask.infoHash}`;
    this.calls.push(`fetch ${key}`);
    return this.answers.get(key) ?? { ok: false, error: 'no_source', detail: 'no torrent fits' };
  }

  async now(handle: KeptTorrentHandle): Promise<TorrentNow> {
    const whole = this.whole.has(handle.infoHash);
    return {
      file: whole ? 'whole' : 'downloading',
      remux: this.remux.get(handle.infoHash) ?? 'none',
      subtitles: this.searching.has(handle.infoHash) ? 'searching' : 'done',
      bytesDone: whole ? 100 : 40,
      bytesTotal: 100,
      peers: 5,
      downKbps: 900,
    };
  }

  async retryRemux(handle: KeptTorrentHandle): Promise<void> {
    this.calls.push(`retry remux ${handle.infoHash}`);
  }

  release(handle: KeptTorrentHandle): void {
    this.calls.push(`release ${handle.infoHash}`);
  }

  async keep(infoHash: string, kept: boolean): Promise<void> {
    this.kept.set(infoHash, kept);
    this.calls.push(`keep ${infoHash} ${kept}`);
  }
}

/** The cloud side, recorded: `request <ref> <height>`, `pause <ref>`. */
export class FakeCaches implements DownloadCaches {
  readonly calls: string[] = [];
  readonly caches = new Map<string, CacheNow>();

  async onDisk(ref: StreamRef): Promise<boolean> {
    return this.caches.get(refLabel(ref))?.state === 'ready';
  }

  async request(ref: StreamRef, maxHeight: number): Promise<CacheNow> {
    this.calls.push(`request ${refLabel(ref)} ${maxHeight}`);
    const key = refLabel(ref);
    const was = this.caches.get(key);
    const cache: CacheNow =
      was === undefined || was.state === 'failed'
        ? { id: `0000000${this.caches.size + 1}-0000-4000-8000-000000000000`, state: 'downloading', running: true, queued: false, progress: 0, bytes: 0, maxHeight, error: null, errorDetail: null }
        : { ...was, running: was.state === 'downloading' };
    this.caches.set(key, cache);
    return { ...cache };
  }

  async find(ref: StreamRef): Promise<CacheNow | null> {
    const cache = this.caches.get(refLabel(ref));
    return cache === undefined ? null : { ...cache };
  }

  async pause(ref: StreamRef): Promise<boolean> {
    this.calls.push(`pause ${refLabel(ref)}`);
    return true;
  }

  set(ref: StreamRef, patch: Partial<CacheNow>): void {
    const cache = this.caches.get(refLabel(ref));
    if (cache === undefined) throw new Error(`no cache of ${refLabel(ref)}`);
    this.caches.set(refLabel(ref), { ...cache, ...patch });
  }
}
```

### Step 13: Unit tests of the plan
**File:** `tests/unit/directStream/downloads/plan.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { bandAllows, CLOUD_MAX_HEIGHT, finalFailure, isOffice, planDownload, stepsAfterCloud } from '../../../../src/directStream/downloads/plan.js';
import { parseRelease } from '../../../../src/directStream/torrent/find/index.js';

const HOME = { office: false, torrent: true, cloud: true };
const OFFICE = { office: true, torrent: true, cloud: true };
const H = 'ab'.repeat(20);
const c = (name: string, seeds: number) => ({ seeds, release: parseRelease(name) });

describe('R1.2 planDownload: the order with no source named', () => {
  it('is a 1080p torrent, then the cloud at 1080p or lower, then a torrent below 1080p', () => {
    expect(planDownload({ via: 'auto', infoHash: null }, HOME)).toEqual({
      ok: true,
      steps: [{ kind: 'torrent', band: 'preferred' }, { kind: 'cloud', maxHeight: 1080 }, { kind: 'torrent', band: 'below' }],
    });
    expect(CLOUD_MAX_HEIGHT).toBe(1080);
  });
  it('leaves out a side that is off', () => {
    expect(planDownload({ via: 'auto', infoHash: null }, { ...HOME, torrent: false })).toEqual({ ok: true, steps: [{ kind: 'cloud', maxHeight: 1080 }] });
    expect(planDownload({ via: 'auto', infoHash: null }, { ...HOME, cloud: false })).toEqual({ ok: true, steps: [{ kind: 'torrent', band: 'preferred' }, { kind: 'torrent', band: 'below' }] });
    expect(planDownload({ via: 'auto', infoHash: null }, { office: false, torrent: false, cloud: false })).toMatchObject({ ok: false, error: 'no_source' });
  });
  it('downloads only from the source named', () => {
    expect(planDownload({ via: 'cloud', infoHash: null }, HOME)).toEqual({ ok: true, steps: [{ kind: 'cloud', maxHeight: 1080 }] });
    expect(planDownload({ via: 'torrent', infoHash: null }, HOME)).toEqual({ ok: true, steps: [{ kind: 'torrent', band: 'preferred' }, { kind: 'torrent', band: 'below' }] });
    expect(planDownload({ via: 'torrent', infoHash: H }, HOME)).toEqual({ ok: true, steps: [{ kind: 'hash', infoHash: H }] });
  });
  it('goes on after a failed cache to what follows the cloud', () => {
    const plan = planDownload({ via: 'auto', infoHash: null }, HOME);
    if (!plan.ok) throw new Error('planned');
    expect(stepsAfterCloud(plan.steps)).toEqual([{ kind: 'torrent', band: 'below' }]);
  });
});

describe('R1.2 bandAllows: 1080p with live seeds, then below 1080p', () => {
  it('takes a 1080p release with live seeds into the preferred band, and nothing else', () => {
    expect(bandAllows('preferred', c('Film.2026.1080p.WEB-DL.x264', 12), null)).toBe(true);
    expect(bandAllows('preferred', c('Film.2026.1080p.WEB-DL.x264', 0), null)).toBe(false);
    expect(bandAllows('preferred', c('Film.2026.720p.WEB-DL.x264', 40), null)).toBe(false);
    expect(bandAllows('preferred', c('Film.2026.2160p.WEB-DL.x265', 40), null)).toBe(false);
  });
  it('believes the trackers over the index when they answered', () => {
    expect(bandAllows('preferred', c('Film.2026.1080p.WEB-DL.x264', 40), { seeders: 0, leechers: 3, trackers: 2 })).toBe(false);
    expect(bandAllows('preferred', c('Film.2026.1080p.WEB-DL.x264', 0), { seeders: 4, leechers: 1, trackers: 1 })).toBe(true);
    expect(bandAllows('preferred', c('Film.2026.1080p.WEB-DL.x264', 7), { seeders: 0, leechers: 0, trackers: 0 })).toBe(true);
  });
  it('takes 720p, 480p and an unsaid height below 1080p, never 1080p or 2160p', () => {
    expect(bandAllows('below', c('Film.2026.720p.WEB-DL.x264', 0), null)).toBe(true);
    expect(bandAllows('below', c('Film.2026.480p.DVDRip', 3), null)).toBe(true);
    expect(bandAllows('below', c('Film.2026.WEB-DL', 3), null)).toBe(true);
    expect(bandAllows('below', c('Film.2026.1080p.WEB-DL.x264', 3), null)).toBe(false);
    expect(bandAllows('below', c('Film.2026.2160p.WEB-DL.x265', 3), null)).toBe(false);
  });
});

describe('R1.4 planDownload: the office network', () => {
  it('reads SSID Employee as the office', () => {
    expect(isOffice('Employee')).toBe(true);
    expect(isOffice('kosan_baruu')).toBe(false);
    expect(isOffice(null)).toBe(false);
  });
  it('sends a download with no source named straight to the cloud', () => {
    expect(planDownload({ via: 'auto', infoHash: null }, OFFICE)).toEqual({ ok: true, steps: [{ kind: 'cloud', maxHeight: 1080 }] });
  });
  it('refuses a torrent asked for there with no_peers_here, and names WARP as never switched', () => {
    for (const ask of [{ via: 'torrent' as const, infoHash: null }, { via: 'torrent' as const, infoHash: H }]) {
      const plan = planDownload(ask, OFFICE);
      expect(plan).toMatchObject({ ok: false, error: 'no_peers_here' });
      if (!plan.ok) expect(plan.detail).toContain('WARP is never switched');
    }
    expect(planDownload({ via: 'auto', infoHash: null }, { ...OFFICE, cloud: false })).toMatchObject({ ok: false, error: 'no_peers_here' });
  });
});

describe('R1.11 finalFailure: why a download failed', () => {
  it('keeps one step’s own code, says dubbed when every step found only dubs, else no_source, naming each step', () => {
    expect(finalFailure([{ step: { kind: 'cloud', maxHeight: 1080 }, error: 'download_failed', detail: 'six tries' }])).toEqual({ error: 'download_failed', detail: 'cloud at 1080p or lower: download_failed (six tries)' });
    expect(finalFailure([{ step: { kind: 'torrent', band: 'preferred' }, error: 'dubbed', detail: '' }, { step: { kind: 'torrent', band: 'below' }, error: 'dubbed', detail: '' }]).error).toBe('dubbed');
    const mixed = finalFailure([
      { step: { kind: 'torrent', band: 'preferred' }, error: 'no_source', detail: 'Index: torrentio: no_stream' },
      { step: { kind: 'cloud', maxHeight: 1080 }, error: 'no_source', detail: '' },
      { step: { kind: 'torrent', band: 'below' }, error: 'dubbed', detail: '' },
    ]);
    expect(mixed.error).toBe('no_source');
    expect(mixed.detail).toBe('torrent 1080p: no_source (Index: torrentio: no_stream); cloud at 1080p or lower: no_source; torrent below 1080p: dubbed');
  });
});
```

### Step 14: Unit tests of the engine
**File:** `tests/unit/directStream/downloads/service.test.ts` (new)
**Code:**
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedSsid, ssidFrom, StreamDownloads } from '../../../../src/directStream/downloads/service.js';
import type { TorrentFetch } from '../../../../src/directStream/downloads/types.js';
import { refLabel, type StreamRef } from '../../../../src/directStream/types.js';
import type { WarpSwitch } from '../../../../src/streaming/warp.js';
import { MemoryDownloadRecords } from '../../../helpers/memoryDownloadRecords.js';
import { FakeCaches, FakeTorrents } from './fakes.js';

const FILM: StreamRef = { kind: 'movie', tmdbId: 550 };
const EPISODE: StreamRef = { kind: 'tv', tmdbId: 1399, season: 1, episode: 2 };
const H1 = 'a1'.repeat(20);
const H2 = 'b2'.repeat(20);
const OTHER = 'c3'.repeat(20);
let clock: number;
beforeEach(() => {
  clock = Date.parse('2026-11-20T12:00:00Z');
});

const ok = (infoHash: string, name = 'Film.2026.1080p.WEB-DL'): TorrentFetch => ({ ok: true, handle: { infoHash, fileIndex: 0, name }, detail: `${name}, 1080p` });

function build(o: { repo?: MemoryDownloadRecords; torrents?: FakeTorrents | null; caches?: FakeCaches | null; ssid?: string | null } = {}) {
  const repo = o.repo ?? new MemoryDownloadRecords();
  const torrents = o.torrents === undefined ? new FakeTorrents() : o.torrents;
  const caches = o.caches === undefined ? new FakeCaches() : o.caches;
  const playing: { hashes: string[] } = { hashes: [] };
  const warpCalls = { status: 0, set: 0 };
  const warp: WarpSwitch = {
    status: async () => {
      warpCalls.status += 1;
      return { ok: true, warp: 'disconnected', ssid: o.ssid === undefined ? 'kosan_baruu' : o.ssid };
    },
    set: async () => {
      warpCalls.set += 1;
      throw new Error('a download never switches WARP');
    },
  };
  const swept: number[] = [];
  const lines: string[] = [];
  const downloads = new StreamDownloads({
    host: 'host-a',
    repo,
    torrents,
    caches,
    ssid: ssidFrom(warp, { ttlMs: 0 }),
    playingTorrents: () => playing.hashes,
    afterDone: () => void swept.push(clock),
    now: () => new Date(clock),
    log: (line) => void lines.push(line),
    every: () => () => undefined,
  });
  const drive = async (): Promise<void> => {
    await downloads.tick();
    await downloads.settled();
  };
  return { downloads, repo, torrents: torrents as FakeTorrents, caches: caches as FakeCaches, playing, warpCalls, swept, lines, drive };
}

describe('R1.2 the order of a download with no source named', () => {
  it('takes a 1080p torrent with live seeds first, and keeps it', async () => {
    const t = build();
    t.torrents.answers.set('band:preferred', ok(H1));
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    expect(t.torrents.calls).toEqual(['fetch band:preferred', `keep ${H1} true`]);
    expect(t.caches.calls).toEqual([]);
    expect(t.repo.rows[0]).toMatchObject({ state: 'running', source: 'torrent', sourceId: H1 });
  });

  it('goes to the cloud at 1080p or lower when no 1080p torrent can be had', async () => {
    const t = build();
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    expect(t.torrents.calls).toEqual(['fetch band:preferred']);
    expect(t.caches.calls).toEqual([`request ${refLabel(FILM)} 1080`]);
    expect(t.repo.rows[0]).toMatchObject({ state: 'running', source: 'cloud' });
  });

  it('tries a torrent below 1080p only once the cloud failed', async () => {
    const t = build();
    t.torrents.answers.set('band:below', ok(H2, 'Film.2026.720p.WEB-DL'));
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    expect(t.torrents.calls).toEqual(['fetch band:preferred']);
    t.caches.set(FILM, { state: 'failed', running: false, error: 'no_source', errorDetail: 'no provider streams it' });
    await t.drive();
    expect(t.torrents.calls).toEqual(['fetch band:preferred', 'fetch band:below', `keep ${H2} true`]);
    expect(t.repo.rows[0]).toMatchObject({ state: 'running', source: 'torrent', sourceId: H2 });
  });

  it('finishes a cloud download when its cache is ready', async () => {
    const t = build();
    await t.downloads.request(EPISODE, { via: 'cloud' });
    await t.downloads.settled();
    expect(t.torrents.calls).toEqual([]);
    t.caches.set(EPISODE, { state: 'ready', running: false, progress: 1, bytes: 900 });
    await t.drive();
    expect(t.repo.rows[0]).toMatchObject({ state: 'done', source: 'cloud' });
    expect(t.swept).toHaveLength(1);
  });
});

describe('R1.4 the office network', () => {
  it('sends a download with no source named straight to the cloud, and never switches WARP', async () => {
    const t = build({ ssid: 'Employee' });
    t.torrents.answers.set('band:preferred', ok(H1));
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    expect(t.torrents.calls).toEqual([]);
    expect(t.caches.calls).toEqual([`request ${refLabel(FILM)} 1080`]);
    expect(t.warpCalls.status).toBeGreaterThan(0);
    expect(t.warpCalls.set).toBe(0);
  });

  it('fails a torrent asked for there with no_peers_here, opening nothing and never switching WARP', async () => {
    const t = build({ ssid: 'Employee' });
    t.torrents.answers.set('band:preferred', ok(H1));
    await t.downloads.request(FILM, { via: 'torrent' });
    await t.downloads.settled();
    expect(t.torrents.calls).toEqual([]);
    expect((await t.downloads.list())[0]).toMatchObject({ state: 'failed', error: 'no_peers_here' });
    expect(t.warpCalls.set).toBe(0);
  });

  it('leaves a torrent download that was running waiting while the office network is on', async () => {
    const t = build({ ssid: 'Employee' });
    const { row } = await t.repo.create('host-a', { ref: FILM, via: 'auto', infoHash: null, batch: null }, new Date(clock));
    await t.repo.on('host-a', row.id, { source: 'torrent', infoHash: H1 }, new Date(clock));
    await t.downloads.start();
    await t.downloads.settled();
    expect(t.torrents.calls).toEqual([]);
    expect(t.repo.rows[0]).toMatchObject({ state: 'queued', source: 'torrent', sourceId: H1 });
  });
});

describe('R1.5 a dub is left undownloaded', () => {
  it('goes on to the next band when the torrents found are dubs, and fails as dubbed when nothing else is left', async () => {
    const t = build({ caches: null });
    t.torrents.answers.set('band:preferred', { ok: false, error: 'dubbed', detail: 'Torrent: Film.2026.1080p.RUS: dubbed (its audio is ru, not the original en)' });
    t.torrents.answers.set('band:below', { ok: false, error: 'dubbed', detail: 'Torrent: Film.2026.720p.RUS: dubbed' });
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    expect(t.torrents.calls).toEqual(['fetch band:preferred', 'fetch band:below']);
    expect((await t.downloads.list())[0]).toMatchObject({ state: 'failed', error: 'dubbed' });
  });
});

describe('R1.6 a download the owner asked for is kept', () => {
  it('marks its torrent kept when it starts, and clears the mark when it is cancelled', async () => {
    const t = build();
    t.torrents.answers.set('band:preferred', ok(H1));
    const asked = await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    expect(t.torrents.kept.get(H1)).toBe(true);
    await t.downloads.cancel(asked.download!.id);
    expect(t.torrents.calls.slice(-2)).toEqual([`release ${H1}`, `keep ${H1} false`]);
    expect(await t.downloads.list()).toEqual([]);
  });

  it('asks the cache for the owner’s cache, never an auto one', async () => {
    const t = build();
    await t.downloads.request(FILM, { via: 'cloud' });
    await t.downloads.settled();
    expect(t.caches.calls).toEqual([`request ${refLabel(FILM)} 1080`]);
  });
});

describe('R1.7 a restart carries downloads on from what is on disk', () => {
  it('opens the same torrent again by its info hash, asking no index', async () => {
    const repo = new MemoryDownloadRecords();
    const before = build({ repo });
    before.torrents.answers.set('band:preferred', ok(H1));
    await before.downloads.request(FILM, { via: 'auto' });
    await before.downloads.settled();
    await before.downloads.close();
    expect(before.torrents.calls.at(-1)).toBe(`release ${H1}`);
    expect(repo.rows[0]).toMatchObject({ state: 'running', sourceId: H1 });
    const after = build({ repo });
    after.torrents.answers.set(`hash:${H1}`, ok(H1));
    expect(await after.downloads.start()).toBe(1);
    await after.downloads.settled();
    expect(after.torrents.calls).toEqual([`fetch hash:${H1}`, `keep ${H1} true`]);
    expect(repo.rows[0]).toMatchObject({ state: 'running', source: 'torrent', sourceId: H1 });
  });

  it('follows a cloud download’s cache again, and queued ones start in order', async () => {
    const repo = new MemoryDownloadRecords();
    const before = build({ repo, torrents: null });
    await before.downloads.request(FILM, { via: 'cloud' });
    await before.downloads.settled();
    await before.downloads.close();
    const after = build({ repo, torrents: null });
    expect(await after.downloads.start()).toBe(1);
    await after.downloads.settled();
    expect(after.caches.calls).toEqual([`request ${refLabel(FILM)} 1080`]);
    expect(repo.rows[0]).toMatchObject({ state: 'running', source: 'cloud' });
  });

  it('tries a carried-on torrent again a minute later when its swarm gives nothing, then fails', async () => {
    const t = build();
    const { row } = await t.repo.create('host-a', { ref: FILM, via: 'auto', infoHash: null, batch: null }, new Date(clock));
    await t.repo.on('host-a', row.id, { source: 'torrent', infoHash: H1 }, new Date(clock));
    await t.downloads.start();
    await t.downloads.settled();
    expect(t.repo.rows[0]).toMatchObject({ state: 'queued' });
    clock += 61_000;
    await t.drive();
    clock += 61_000;
    await t.drive();
    expect(t.torrents.calls.filter((c) => c === `fetch hash:${H1}`)).toHaveLength(3);
    expect(t.repo.rows[0]).toMatchObject({ state: 'failed', error: 'no_source' });
    expect(t.torrents.calls.at(-1)).toBe(`keep ${H1} false`);
  });
});

describe('R1.8 a torrent download finishes only once it is ready to play offline', () => {
  it('holds the torrent while its remux runs and its subtitle search goes on, then lets go and queues the previews', async () => {
    const t = build();
    t.torrents.answers.set('band:preferred', ok(H1));
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    t.torrents.whole.add(H1);
    t.torrents.remux.set(H1, 'running');
    t.torrents.searching.add(H1);
    await t.drive();
    expect(t.repo.rows[0]).toMatchObject({ state: 'running' });
    t.torrents.remux.set(H1, 'whole');
    await t.drive();
    expect(t.repo.rows[0]).toMatchObject({ state: 'running' });
    t.torrents.searching.delete(H1);
    await t.drive();
    expect(t.repo.rows[0]).toMatchObject({ state: 'done', source: 'torrent', sourceId: H1, bytesDone: 100 });
    expect(t.torrents.calls.at(-1)).toBe(`release ${H1}`);
    expect(t.swept).toHaveLength(1);
    expect(await t.downloads.list()).toEqual([]);
  });

  it('starts a failed remux again once, and finishes after a second failure (a play remuxes it from disk)', async () => {
    const t = build();
    t.torrents.answers.set('band:preferred', ok(H1));
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    t.torrents.whole.add(H1);
    t.torrents.remux.set(H1, 'failed');
    await t.drive();
    expect(t.torrents.calls.at(-1)).toBe(`retry remux ${H1}`);
    await t.drive();
    expect(t.repo.rows[0]).toMatchObject({ state: 'done' });
  });

  it('queues nothing for a title already whole here', async () => {
    const t = build();
    t.torrents.onDiskRefs.add(refLabel(FILM));
    expect(await t.downloads.request(FILM, { via: 'auto' })).toEqual({ download: null, created: false, onDisk: true });
    expect(t.repo.rows).toEqual([]);
  });
});

describe('R1.9 a torrent playing on screen comes first', () => {
  it('pauses the torrent download while another torrent plays, and carries it on when the play ends', async () => {
    const t = build();
    t.torrents.answers.set('band:preferred', ok(H1));
    t.torrents.answers.set(`hash:${H1}`, ok(H1));
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    t.playing.hashes = [OTHER];
    await t.drive();
    expect(t.torrents.calls).toEqual(['fetch band:preferred', `keep ${H1} true`, `release ${H1}`]);
    expect((await t.downloads.list())[0]).toMatchObject({ state: 'paused', source: 'torrent', source_id: H1 });
    await t.drive();
    expect(t.torrents.calls).toHaveLength(3);
    t.playing.hashes = [];
    await t.drive();
    expect(t.torrents.calls.slice(3)).toEqual([`fetch hash:${H1}`, `keep ${H1} true`]);
    expect(t.repo.rows[0]).toMatchObject({ state: 'running' });
  });

  it('starts no torrent download while a torrent plays, but a cloud one does', async () => {
    const t = build();
    t.playing.hashes = [OTHER];
    await t.downloads.request(FILM, { via: 'torrent' });
    await t.downloads.request(EPISODE, { via: 'cloud' });
    await t.downloads.settled();
    expect(t.torrents.calls).toEqual([]);
    expect(t.caches.calls).toEqual([`request ${refLabel(EPISODE)} 1080`]);
  });

  it('does not pause for the play of the very torrent it downloads', async () => {
    const t = build();
    t.torrents.answers.set('band:preferred', ok(H1));
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    t.playing.hashes = [H1];
    await t.drive();
    expect(t.repo.rows[0]).toMatchObject({ state: 'running' });
  });
});

describe('R1.11 a download nothing can give fails with a reason', () => {
  it('says no_source and what each step saw, in the list', async () => {
    const t = build();
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    t.caches.set(FILM, { state: 'failed', running: false, error: 'no_source', errorDetail: 'no provider streams it' });
    await t.drive();
    const [view] = await t.downloads.list();
    expect(view).toMatchObject({ state: 'failed', error: 'no_source', kind: 'movie', tmdb_id: 550 });
    expect(view!.detail).toBe('torrent 1080p: no_source (no torrent fits); cloud at 1080p or lower: no_source (no provider streams it); torrent below 1080p: no_source (no torrent fits)');
  });

  it('keeps the cache’s own code for a cloud download', async () => {
    const t = build();
    await t.downloads.request(EPISODE, { via: 'cloud' });
    await t.downloads.settled();
    t.caches.set(EPISODE, { state: 'failed', running: false, error: 'download_failed', errorDetail: 'six tries' });
    await t.drive();
    expect((await t.downloads.list())[0]).toMatchObject({ state: 'failed', error: 'download_failed', season: 1, episode: 2 });
  });

  it('refuses a malformed pick and a pick without via torrent', async () => {
    const t = build();
    await expect(t.downloads.request(FILM, { via: 'torrent', infoHash: 'nope' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(t.downloads.request(FILM, { via: 'auto', infoHash: H1 })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(t.downloads.cancel('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'unknown_download' });
  });
});

describe('the list reads progress live', () => {
  it('answers a running torrent’s bytes, peers and rate', async () => {
    const t = build();
    t.torrents.answers.set('band:preferred', ok(H1));
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    expect((await t.downloads.list())[0]).toMatchObject({ state: 'running', progress: 0.4, bytes_done: 40, bytes_total: 100, peers: 5, down_kbps: 900, available: true });
  });

  it('lists a title’s finished download only for that title, and only while it is still whole here', async () => {
    const t = build();
    await t.downloads.request(EPISODE, { via: 'cloud' });
    await t.downloads.settled();
    t.caches.set(EPISODE, { state: 'ready', running: false, progress: 1, bytes: 900 });
    await t.drive();
    const title = { kind: 'tv' as const, tmdbId: 1399 };
    expect(await t.downloads.list()).toEqual([]);
    expect(await t.downloads.list(title)).toMatchObject([{ state: 'done', source: 'cloud', season: 1, episode: 2, progress: 1 }]);
    // Deleted on the Cache page: no longer on this machine, so no longer listed.
    t.caches.caches.clear();
    expect(await t.downloads.list(title)).toEqual([]);
  });
});

describe('R1.4 the SSID pinned by NOTESD_STREAM_DOWNLOAD_SSID', () => {
  it('answers the pinned value and reads nothing', async () => {
    expect(await fixedSsid('verify-home')()).toBe('verify-home');
  });
});
```
**Impact:** This uses Phase 1's `MemoryDownloadRecords`. The tests assume it keeps phase 1's rules: `on` sets `source`/`sourceId`, `toResume` re-queues running and paused rows, and `failed`, `done` and `setState` return null for a row that is not open.

### Step 15: Unit tests of `fetchKept`, `keptState`, `TorrentRemux.status` and a replay from disk
**File:** `tests/unit/directStream/torrent/keptFetch.test.ts` (new)
**Code:**
```ts
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bandAllows } from '../../../../src/directStream/downloads/plan.js';
import type { StreamRef } from '../../../../src/directStream/types.js';
import { parseRelease, type SwarmCount, type TorrentCandidate } from '../../../../src/directStream/torrent/find/index.js';
import type { MediaProbe } from '../../../../src/directStream/torrent/probe.js';
import { REMUX_DONE_FILE, remuxDir, TorrentRemux } from '../../../../src/directStream/torrent/remux.js';
import type { SubtitleTier } from '../../../../src/directStream/torrent/subtitles/chain.js';
import { TorrentSource, type DownloadOnDisk, type FindAnswer, type TorrentHearer, type TorrentSwarm } from '../../../../src/directStream/torrent/source.js';
import { fakeFfmpeg } from '../remuxFakes.js';

const FILM: StreamRef = { kind: 'movie', tmdbId: 467905 };
const BASE = 'http://127.0.0.1:4321';
const h = (n: number): string => n.toString(16).padStart(40, '0');
const candidate = (infoHash: string, name: string, seeds = 40): TorrentCandidate => ({
  infoHash,
  name,
  fileName: null,
  fileIdx: null,
  seeds,
  sizeBytes: 700_000_000,
  index: 'torrentio',
  listedBy: ['torrentio'],
  site: null,
  trackers: ['http://127.0.0.1:1/announce'],
  scoped: false,
  release: parseRelease(name),
});
const MP4_EN: MediaProbe = { container: 'mov,mp4,m4a,3gp,3g2,mj2', video: { codec: 'h264', height: 1080 }, audio: [{ codec: 'aac', lang: 'eng' }], subtitles: [], durationS: 620, direct: true };
const MP4_DE: MediaProbe = { ...MP4_EN, audio: [{ codec: 'aac', lang: 'ger' }] };
const MP4_UNTAGGED: MediaProbe = { ...MP4_EN, audio: [{ codec: 'aac', lang: null }] };
const MKV: MediaProbe = { container: 'matroska,webm', video: { codec: 'h264', height: 1080 }, audio: [{ codec: 'ac3', lang: 'eng' }], subtitles: [], durationS: 620, direct: false };
const preferred = (c: TorrentCandidate, count: SwarmCount | null): boolean => bandAllows('preferred', c, count);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'notesd-kept-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(o: {
  candidates?: TorrentCandidate[];
  probes?: Record<string, MediaProbe>;
  heard?: Record<string, 'original' | 'dubbed'>;
  tiers?: SubtitleTier[];
  subtitleHeadMs?: number;
  remux?: TorrentRemux;
  ready?: string[];
  stored?: Record<string, string[]>;
  counts?: Record<string, SwarmCount>;
  disk?: DownloadOnDisk | null;
}) {
  const calls: string[] = [];
  const opened: { infoHash: string; trackers: readonly string[] }[] = [];
  let finds = 0;
  const swarm: TorrentSwarm = {
    open: async (pick) => {
      calls.push(`open ${pick.infoHash}`);
      opened.push({ infoHash: pick.infoHash, trackers: pick.trackers });
      return { infoHash: pick.infoHash, files: [{ index: 0, path: 'Film.2026.1080p.mkv', name: 'Film.2026.1080p.mkv', length: 700_000_000 }] };
    },
    use: (infoHash) => void calls.push(`use ${infoHash}`),
    release: (infoHash) => void calls.push(`release ${infoHash}`),
    drop: (infoHash) => void calls.push(`drop ${infoHash}`),
    discard: (infoHash) => void calls.push(`discard ${infoHash}`),
    find: async () => o.disk ?? null,
    filePath: (infoHash, index) => ((o.ready ?? []).includes(infoHash) ? `/data/torrents/${infoHash}/${index}.mkv` : null),
    localUrl: (infoHash, index) => `/api/stream/torrent/${infoHash}/f/${index}`,
    setDuration: () => undefined,
    trackersOf: async (infoHash) => o.stored?.[infoHash] ?? [],
  };
  const hear: TorrentHearer = {
    hear: async (source) => {
      const hash = /\/torrent\/([0-9a-f]+)\//.exec(source.manifest_url)?.[1] ?? '';
      const verdict = o.heard?.[hash] ?? 'original';
      return { verdict, detected: verdict === 'dubbed' ? 'ru' : 'en', probability: 0.97, reason: verdict === 'dubbed' ? 'the audio is spoken ru, not the original en' : 'the audio is spoken en' };
    },
  };
  const answer: FindAnswer = { candidates: o.candidates ?? [], indexes: [{ index: 'torrentio', outcome: 'ok', detail: '', took_s: 0.1, listed: (o.candidates ?? []).length }], excluded: [], lastResort: [] };
  const source = new TorrentSource({
    swarm,
    find: async () => {
      finds += 1;
      return answer;
    },
    probe: async (url) => o.probes?.[/\/torrent\/([0-9a-f]+)\//.exec(url)?.[1] ?? ''] ?? MP4_EN,
    tiers: o.tiers ?? [],
    remux: o.remux ?? null,
    hear,
    ...(o.counts === undefined ? {} : { scrape: async () => new Map(Object.entries(o.counts!)) }),
    localBase: () => BASE,
    settleMs: 5,
    ...(o.subtitleHeadMs === undefined ? {} : { subtitleHeadMs: o.subtitleHeadMs }),
    log: () => undefined,
  });
  return { source, calls, opened, finds: () => finds };
}

const until = async (check: () => Promise<boolean> | boolean): Promise<void> => {
  for (let i = 0; i < 200; i += 1) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('never');
};

describe('R1.2 TorrentSource.fetchKept keeps to the band it is given', () => {
  it('opens only the 1080p torrent with live seeds', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.720p.WEB-DL.x264'), candidate(h(2), 'Film.2026.1080p.WEB-DL.x264')] });
    const out = await t.source.fetchKept(FILM, { audioLang: 'en', imdbId: 'tt0467905', only: preferred });
    expect(out.ok && out.torrent.infoHash).toBe(h(2));
    expect(t.opened.map((x) => x.infoHash)).toEqual([h(2)]);
  });

  it('opens nothing when the only 1080p torrent has no seeder by the trackers’ word', async () => {
    const t = setup({ candidates: [candidate(h(2), 'Film.2026.1080p.WEB-DL.x264', 40)], counts: { [h(2)]: { seeders: 0, leechers: 2, trackers: 2 } } });
    const out = await t.source.fetchKept(FILM, { audioLang: 'en', imdbId: 'tt0467905', only: preferred });
    expect(out).toMatchObject({ ok: false, error: 'no_source' });
    expect(t.opened).toEqual([]);
  });
});

describe('R1.5 a dub is left undownloaded and the next torrent taken', () => {
  it('passes over a release whose tags name another language', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.1080p.WEB-DL.GER'), candidate(h(2), 'Film.2026.1080p.WEB-DL')], probes: { [h(1)]: MP4_DE } });
    const out = await t.source.fetchKept(FILM, { audioLang: 'en', imdbId: 'tt0467905', only: preferred });
    if (!out.ok) throw new Error('no torrent kept');
    expect(out.torrent.infoHash).toBe(h(2));
    expect(out.attempts.find((a) => a.provider.includes('GER'))?.outcome).toBe('dubbed');
  });

  it('hears a file that tags no language, lets a dub go, and keeps the next one heard as the original', async () => {
    const t = setup({
      candidates: [candidate(h(1), 'Film.2026.1080p.WEB-DL.A'), candidate(h(2), 'Film.2026.1080p.WEB-DL.B')],
      probes: { [h(1)]: MP4_UNTAGGED, [h(2)]: MP4_UNTAGGED },
      heard: { [h(1)]: 'dubbed' },
    });
    const out = await t.source.fetchKept(FILM, { audioLang: 'en', imdbId: 'tt0467905', only: preferred });
    if (!out.ok) throw new Error('no torrent kept');
    expect(out.torrent.infoHash).toBe(h(2));
    expect(t.calls).toContain(`drop ${h(1)}`);
    expect(out.attempts.find((a) => a.provider.endsWith('.A') && a.outcome === 'dubbed')?.detail).toContain('audio heard');
  });

  it('answers dubbed when every torrent found is a dub', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.1080p.WEB-DL.GER')], probes: { [h(1)]: MP4_DE } });
    expect(await t.source.fetchKept(FILM, { audioLang: 'en', imdbId: 'tt0467905', only: preferred })).toMatchObject({ ok: false, error: 'dubbed' });
  });
});

describe('R1.8 a kept torrent is finished offline-ready', () => {
  it('lets the subtitle search run to its end (a fetch ahead stops it)', async () => {
    const tier: SubtitleTier = { name: 'service', blocks: true, find: () => new Promise((r) => setTimeout(() => r([]), 60)) };
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.1080p.WEB-DL')], tiers: [tier], subtitleHeadMs: 5 });
    const out = await t.source.fetchKept(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    if (!out.ok) throw new Error('no torrent kept');
    expect(out.torrent.stop.signal.aborted).toBe(false);
    expect(await t.source.keptState(out.torrent)).toEqual({ file: 'downloading', remux: 'none', subtitles: 'searching' });
    await out.torrent.subtitlesPending;
    expect((await t.source.keptState(out.torrent)).subtitles).toBe('done');
  });

  it('keeps the remux of a file Chrome cannot play running to its end, and the finished remux stays after the release', async () => {
    const ffmpeg = fakeFfmpeg({ segmentsAtStart: 1 });
    const remux = new TorrentRemux({ dir, spawn: ffmpeg.spawn, pollMs: 5, log: () => undefined });
    const ready: string[] = [];
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.1080p.BluRay.AC3')], probes: { [h(1)]: MKV }, remux, ready });
    const out = await t.source.fetchKept(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    if (!out.ok) throw new Error('no torrent kept');
    expect(out.torrent.manifestKind).toBe('hls');
    expect(await t.source.keptState(out.torrent)).toMatchObject({ remux: 'running' });
    ready.push(h(1));
    await ffmpeg.runs[0]!.write(4, true);
    ffmpeg.runs[0]!.exit(0);
    await until(async () => (await t.source.keptState(out.torrent)).remux === 'whole');
    expect(await t.source.keptState(out.torrent)).toEqual({ file: 'whole', remux: 'whole', subtitles: 'done' });
    t.source.release(out.torrent);
    expect(remux.status(h(1), 0)).toBe('whole');
    expect(existsSync(path.join(remuxDir(dir, h(1), 0), REMUX_DONE_FILE))).toBe(true);
  });

  it('opens one torrent by its info hash with the trackers this host kept, asking no index', async () => {
    const t = setup({ stored: { [h(9)]: ['udp://stored.example:1337/announce'] } });
    const out = await t.source.fetchKept(FILM, { audioLang: 'en', imdbId: null, infoHash: h(9) });
    expect(out.ok && out.torrent.infoHash).toBe(h(9));
    expect(t.finds()).toBe(0);
    expect(t.opened[0]!.trackers).toContain('udp://stored.example:1337/announce');
  });

  it('plays a finished download from disk later with no index asked and no swarm joined', async () => {
    const t = setup({ disk: { infoHash: h(1), name: 'Film.2026.1080p.WEB-DL', fileIndex: 0, state: 'ready' }, ready: [h(1)] });
    expect(await t.source.onDisk(FILM)).toBe(true);
    expect(await t.source.fromDisk(FILM, { audioLang: 'en' })).not.toBeNull();
    expect(t.finds()).toBe(0);
    expect(t.calls.filter((c) => c.startsWith('open '))).toEqual([]);
  });
});
```
**Impact:** none. The remux test drives a real `TorrentRemux` over the existing fake ffmpeg (`tests/unit/directStream/remuxFakes.ts`).

### Step 16: Unit tests of the prune exemption, and the integration test
**File:** `tests/unit/directStream/torrent/keptPrune.test.ts` (new)
**Code:**
```ts
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TorrentStreams } from '../../../../src/directStream/torrent/service.js';
import { TorrentFolder } from '../../../../src/directStream/torrent/store.js';
import { FakeTorrentEngine } from '../../../helpers/fakeTorrentEngine.js';
import { MemoryTorrentRecords } from '../../../helpers/memoryTorrentRecords.js';

const DAY = 86_400_000;
const MIB = 1_048_576;
let root: string;
let clock: number;

function build(records: MemoryTorrentRecords, budgetBytes?: number) {
  const lines: string[] = [];
  const streams = new TorrentStreams({
    engine: new FakeTorrentEngine([]),
    repo: records,
    folder: new TorrentFolder(root),
    host: 'host-a',
    uploadKbps: 100,
    keepDays: 7,
    discovery: true,
    ...(budgetBytes === undefined ? {} : { budgetBytes }),
    now: () => new Date(clock),
    log: (line) => void lines.push(line),
    every: () => () => undefined,
  });
  return { streams, lines };
}

/** A ready film download of this host with `mib` MiB on disk, made `madeAt` (never played unless `playedAt`). */
async function download(records: MemoryTorrentRecords, hash: string, name: string, o: { mib: number; madeAt: number; playedAt?: number }): Promise<void> {
  const slot = { infoHash: hash, season: 0, episode: 0 };
  await records.record('host-a', { infoHash: hash, ref: { kind: 'movie', tmdbId: 7 }, name, release: null, trackers: [] }, new Date(o.madeAt));
  await records.chosen('host-a', slot, { files: [{ index: 0, path: `${name}/${name}.mkv`, length: o.mib * MIB }], fileIndex: 0, fileLength: o.mib * MIB }, new Date(o.madeAt));
  await records.ready('host-a', slot, o.mib * MIB, new Date(o.madeAt));
  if (o.playedAt !== undefined) await records.played('host-a', slot, new Date(o.playedAt));
  const file = new TorrentFolder(root).diskPath(hash, `${name}/${name}.mkv`)!;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.alloc(o.mib * MIB, 1));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'torrent-kept-'));
  clock = Date.parse('2026-11-20T12:00:00Z');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('R1.6 a download the owner keeps survives both prunes', () => {
  it('is not cleared by age, though never played for a month', async () => {
    const records = new MemoryTorrentRecords();
    const KEPT = 'a1'.repeat(20);
    const OLD = 'b2'.repeat(20);
    await download(records, KEPT, 'Kept.Film', { mib: 1, madeAt: clock - 30 * DAY });
    await download(records, OLD, 'Old.Film', { mib: 1, madeAt: clock - 30 * DAY });
    const { streams } = build(records);
    await streams.keep(KEPT, true);
    expect(await streams.prune()).toBe(1);
    expect(await readdir(root)).toEqual([KEPT]);
    expect(records.rows.map((r) => [r.infoHash, r.keptAt?.getTime() ?? null])).toEqual([[KEPT, clock]]);
  });

  it('is not cleared by the budget, which deletes the others first and says what is kept', async () => {
    const records = new MemoryTorrentRecords();
    const KEPT = 'c3'.repeat(20);
    const PLAYED = 'd4'.repeat(20);
    await download(records, KEPT, 'Kept.Film', { mib: 4, madeAt: clock - 3 * DAY });
    await download(records, PLAYED, 'Played.Film', { mib: 4, madeAt: clock - 2 * DAY, playedAt: clock - 60_000 });
    const { streams, lines } = build(records, 3 * MIB);
    await streams.keep(KEPT, true);
    expect(await streams.prune()).toBe(1);
    expect(await readdir(root)).toEqual([KEPT]);
    expect(lines.filter((l) => l.includes('budget')).at(-1)).toBe(
      '[notesd] torrent: the downloads take 4 MB, over the 3 MB budget, and what is left is in use or kept by the owner (1 kept download, 4 MB)',
    );
  });

  it('prunes like any other once the mark is cleared', async () => {
    const records = new MemoryTorrentRecords();
    const KEPT = 'e5'.repeat(20);
    await download(records, KEPT, 'Was.Kept', { mib: 1, madeAt: clock - 30 * DAY });
    const { streams } = build(records);
    await streams.keep(KEPT, true);
    await streams.keep(KEPT, false);
    expect(await streams.prune()).toBe(1);
    expect(await readdir(root)).toEqual([]);
  });
});
```
**File:** `tests/integration/streamDownloads.engine.int.test.ts` (new)
**Code:**
```ts
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { DownloadsRepo } from '../../src/directStream/downloads/repo.js';
import { StreamDownloads } from '../../src/directStream/downloads/service.js';
import { TorrentsRepo } from '../../src/directStream/torrent/repo.js';
import { TorrentStreams } from '../../src/directStream/torrent/service.js';
import { TorrentFolder } from '../../src/directStream/torrent/store.js';
import { FakeTorrentEngine } from '../helpers/fakeTorrentEngine.js';
import { FakeTorrents } from '../unit/directStream/downloads/fakes.js';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

const HOST = 'host-a';
const FILM = { kind: 'movie', tmdbId: 550 } as const;
const HASH = '0123456789abcdef0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';
const T0 = new Date('2026-11-20T12:00:00Z');
const DAY = 86_400_000;
const MIB = 1_048_576;

let db: Db;
let root: string;
beforeAll(() => {
  db = openTestDb();
});
afterAll(async () => {
  await closeTestDb(db);
});
beforeEach(async () => {
  await truncateAll(db);
  root = await mkdtemp(path.join(os.tmpdir(), 'downloads-int-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('R1.7 a restart carries a download on (Postgres)', () => {
  it('re-queues a running torrent download and opens the same torrent by its info hash', async () => {
    const repo = new DownloadsRepo(db);
    const { row } = await repo.create(HOST, { ref: FILM, via: 'auto', infoHash: null, batch: null }, T0);
    await repo.setState(HOST, row.id, 'running', T0);
    await repo.on(HOST, row.id, { source: 'torrent', infoHash: HASH }, T0);
    const torrents = new FakeTorrents();
    torrents.answers.set(`hash:${HASH}`, { ok: true, handle: { infoHash: HASH, fileIndex: 0, name: 'Fixture.Film' }, detail: 'Fixture.Film' });
    const downloads = new StreamDownloads({ host: HOST, repo, torrents, caches: null, ssid: async () => null, playingTorrents: () => [], now: () => T0, log: () => undefined, every: () => () => undefined });
    expect(await downloads.start()).toBe(1);
    await downloads.settled();
    expect(torrents.calls).toEqual([`fetch hash:${HASH}`, `keep ${HASH} true`]);
    expect(await repo.get(HOST, row.id)).toMatchObject({ state: 'running', source: 'torrent', sourceId: HASH });
    await downloads.close();
  });
});

describe('R1.6 a kept torrent survives both prunes (Postgres)', () => {
  it('stays through the age prune and the budget while an unkept one goes', async () => {
    const torrentsRepo = new TorrentsRepo(db);
    const folder = new TorrentFolder(root);
    const old = new Date(T0.getTime() - 30 * DAY);
    for (const hash of [HASH, OTHER]) {
      const slot = { infoHash: hash, season: 0, episode: 0 };
      await torrentsRepo.record(HOST, { infoHash: hash, ref: FILM, name: `Film.${hash.slice(0, 4)}`, release: null, trackers: [] }, old);
      await torrentsRepo.chosen(HOST, slot, { files: [{ index: 0, path: 'Film/Film.mkv', length: 2 * MIB }], fileIndex: 0, fileLength: 2 * MIB }, old);
      await torrentsRepo.ready(HOST, slot, 2 * MIB, old);
      const file = folder.diskPath(hash, 'Film/Film.mkv')!;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, Buffer.alloc(2 * MIB, 1));
    }
    const streams = new TorrentStreams({ engine: new FakeTorrentEngine([]), repo: torrentsRepo, folder, host: HOST, uploadKbps: 100, keepDays: 7, budgetBytes: MIB, discovery: true, now: () => T0, log: () => undefined, every: () => () => undefined });
    await streams.keep(HASH, true);
    await streams.prune();
    expect(await readdir(root)).toEqual([HASH]);
    expect((await torrentsRepo.slots(HOST, HASH)).map((r) => r.keptAt?.toISOString())).toEqual([T0.toISOString()]);
    expect(await torrentsRepo.slots(HOST, OTHER)).toEqual([]);
  });
});
```
**Impact:** none. These tests use Phase 1's `DownloadsRepo`, `TorrentsRepo.setKept` (through `TorrentStreams.keep`) and the `stream_downloads` table.

## Principles applied

- Make illegal states unrepresentable: the engine reads the network only through `ssidFrom(warp: Pick<WarpSwitch, 'status'>)`, and `StreamDownloadsOptions` holds no `WarpSwitch`. Nothing a download holds can switch WARP (R1.4), which is enforced by the type, not by a runtime check. `TorrentAsk` is a union of `{band}` or `{infoHash}`, so a step can never carry both. `DownloadVia`/`DownloadState`/`DownloadSource` are derived from Phase 1's row type, so the two cannot drift.
- Laziness protocol (reuse over new abstraction): pause, resume and restart share one path, `fetchKept(ref, {infoHash})`, which opens the torrent again by its hash. There is no separate hold/deselect mechanism on `TorrentStreams` and no session state to rebuild after a restart. A torrent is found and audio-checked by the existing `resolve`, with only an `only` filter added. The cloud path is `StreamCache.request` as the owner's. The previews come from the existing `StreamPreviews.sweep()`. The remux and subtitles come from the play's own `finish`, which is simply not aborted.
- Boundary discipline: an info hash is normalized once, in `StreamDownloads.request`. The source order is one pure function (`planDownload`) that everything else trusts. Phase 4's route validates the HTTP body and passes typed values.
- Sequence into verifiable units: Steps 1–4 (the torrent layer) pass the existing torrent suites before any engine code exists. Steps 5–7 (the engine) are each proven by a test file in Steps 13–16. Steps 8–10 (wiring) are proven by the config tests and the daemon restart journey.
- Test behavior, not implementation: the engine tests assert what a caller sees: the rows in the repo, `list()`'s views, and the calls each seam received (fetch, keep, release, request). The source tests drive the real `TorrentSource` and a real `TorrentRemux` over the existing fake swarm and fake ffmpeg. Nothing mocks the unit under test.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` and `npm run test:int -- tests/integration/streamDownloads.engine.int.test.ts`
**Proof:** No route or tool reaches the engine until Phase 4. The proof is therefore the engine's journeys on the real `TorrentSource`, `TorrentRemux` and `TorrentStreams` over fakes at the network seams, the rows read back from Postgres, and one drive of a real throwaway daemon. In that drive the daemon carries a seeded download on after a restart, from the loopback seeder, to a ready and kept torrent.
- Harness: `.claude/skills/verify-notesd`. Only J5's second command drives it (`up --torrent`, `exec`, `restart`, `sql`). The other journeys are `vitest` runs, since Phase 2 adds no HTTP or MCP surface.
- Feature-map entries: none. Phase 9 adds the downloads entries once a user can reach them.
- Journeys:
  - **J1** · traces R1.2 — `npx vitest run tests/unit/directStream/downloads tests/unit/directStream/torrent/keptFetch.test.ts -t "R1.2"` → passes when vitest reports 0 failed and at least 11 passed. That covers the plan order `[torrent 1080p, cloud 1080, torrent below]`, the band filter (only the 1080p hash is opened, nothing opened for a 1080p torrent the trackers call seedless), and the engine calling `fetch band:preferred` → `request … 1080` → `fetch band:below` in that order, with the cloud tried only after the preferred band found nothing and the lower torrent only after the cache failed
  - **J2** · traces R1.4 — `npx vitest run tests/unit/directStream/downloads -t "R1.4"` → passes when 0 failed and at least 7 passed (the pinned SSID answers `verify-home` and reads nothing): on SSID `Employee`, `auto` makes only `request <film> 1080` and no `fetch`; `via: torrent` lists `{state: 'failed', error: 'no_peers_here'}` with no torrent opened; a carried-on torrent row stays `queued`; and the fake WARP's `set` was called 0 times while its `status` was read
  - **J3** · traces R1.5 — `npx vitest run tests/unit/directStream/torrent/keptFetch.test.ts tests/unit/directStream/downloads/service.test.ts -t "R1.5"` → passes when 0 failed and at least 4 passed: a German-tagged release has a `dubbed` attempt and the English one is kept; an untagged file heard as Russian is `drop`ped and the next is kept; all-dubs answers `error: 'dubbed'`; the engine moves from `band:preferred` to `band:below` on a dub and lists `error: 'dubbed'`
  - **J4** · traces R1.6 — `npx vitest run tests/unit/directStream/torrent/keptPrune.test.ts tests/unit/directStream/downloads/service.test.ts -t "R1.6" && npm run test:int -- tests/integration/streamDownloads.engine.int.test.ts -t "R1.6"` → passes when both report 0 failed. That means a never-played kept torrent survives a 7-day age prune and a 3 MB budget (only its folder is left in the root), the log says `kept by the owner (1 kept download, 4 MB)`, and the engine sends `keep <h> true` on start and `keep <h> false` on cancel. On Postgres, after `prune()` only the kept hash's folder remains and its `stream_torrents.kept_at` is set, while the unkept torrent's rows are gone
  - **J5** · traces R1.7 — `npx vitest run tests/unit/directStream/downloads/service.test.ts -t "R1.7" && npm run test:int -- tests/integration/streamDownloads.engine.int.test.ts -t "R1.7"`, then the daemon drive: `V=.claude/skills/verify-notesd/scripts/verify.sh; OUT="$($V up --torrent)"; RUN=$(sed -n 's/^RUN=//p' <<<"$OUT"); T=$(sed -n 's/^TORRENT=//p' <<<"$OUT"); HASH=$(jq -r .info_hash "$T/fixture.json"); $V exec "$RUN" "insert into stream_downloads (host, kind, tmdb_id, season, episode, via, state, source, source_id, started_at) values ('$(hostname)', 'movie', 550, 0, 0, 'auto', 'running', 'torrent', '$HASH', now())"; $V restart "$RUN"; for i in $(seq 1 90); do $V sql "$RUN" "select state from stream_downloads" | grep -qw done && break; sleep 2; done; $V sql "$RUN" "select d.state, d.source_id = '$HASH' as same_torrent, t.state as torrent_state, t.kept_at is not null as kept from stream_downloads d join stream_torrents t on t.info_hash = d.source_id"; $V down "$RUN"` → passes when vitest reports 0 failed (a restart sends exactly `fetch hash:<h>`, `keep <h> true`, the row is `running` again with the same `source_id`, a carried-on swarm that gives nothing is tried 3 times before `failed`), and the last `sql` prints one row `done | t | ready | t`: the daemon carried the seeded running download on after its restart, from the loopback seeder, to a ready, kept torrent, without asking an index
  - **J6** · traces R1.8 — `npx vitest run tests/unit/directStream/torrent/keptFetch.test.ts tests/unit/directStream/downloads/service.test.ts -t "R1.8"` → passes when 0 failed and at least 7 passed. In those tests the kept torrent's `stop` is not aborted and `keptState` goes `subtitles: searching` → `done`. A real `TorrentRemux` goes `running` → `whole`, and its `done.json` is still there after `release`. A hash open uses the stored tracker with `finds() === 0`. A ready download plays through `fromDisk` with no `open` and no find. The engine keeps the row `running` while the remux runs or the subtitles search, then writes `{state: 'done', bytesDone: 100}`, releases the torrent and calls the previews sweep once
  - **J7** · traces R1.9 — `npx vitest run tests/unit/directStream/downloads/service.test.ts -t "R1.9"` → passes when 0 failed and 3 passed. With another torrent on screen, the calls end `release <h>` and the list shows `{state: 'paused', source_id: <h>}`. Nothing is fetched while the play lasts. When `playingTorrents` is empty again, the calls go on with `fetch hash:<h>`, `keep <h> true` and the row is `running`. A torrent-first download does not start during a play, though a cloud one does, and the play of the downloaded torrent itself pauses nothing
  - **J8** · traces R1.11 — `npx vitest run tests/unit/directStream/downloads -t "R1.11"` → passes when 0 failed and at least 4 passed, including `list()[0]` = `{state: 'failed', error: 'no_source', detail: 'torrent 1080p: no_source (no torrent fits); cloud at 1080p or lower: no_source (no provider streams it); torrent below 1080p: no_source (no torrent fits)'}` and a cloud-only failure keeping `error: 'download_failed'`
- Neighbor check: the torrent play and the fetch-ahead, whose `resolve`, `release` and prune this phase touches. Run `npx vitest run tests/unit/directStream/torrentSource.test.ts tests/unit/directStream/torrentRemuxSource.test.ts tests/unit/directStream/torrent tests/unit/directStream/ahead.test.ts tests/unit/config.test.ts tests/unit/config.streamCache.test.ts && npm run test:int -- tests/integration/directStream.torrents.int.test.ts`. It passes when every file reports 0 failed, including `packAndBudget.test.ts`'s unchanged budget log lines (nothing kept there) and `fetchAhead`'s `stop.signal.aborted === true`. If `tests/unit/directStream/ahead.test.ts` does not exist under that name, `npx vitest run -t "EpisodeAhead"` covers the same.
- Cost: none. No model call, no network, no swarm beyond the harness's loopback seeder.

**Exit criteria:** `npm run typecheck` and `npm test` pass. The new integration file passes on Postgres. J1–J8 pass. A throwaway daemon started with a `running` `stream_downloads` row carries it to `done` with its torrent `ready` and `kept_at` set.

## Handoffs

- **Phase 3 (R2):** phase 3 states its own edits to this phase's `service.ts` (reconciled): `request` is split into a private `enqueue` (no tick) plus the tick, `requestSeason`, a `pack: SeasonPackJob | null` beside `job` (one torrent download at a time still: `startNext` starts nothing while either is set), the batch hook at the top of `run` (which gains the claimed `row`), the pack's branches in `playFirst`, `cancel`, `close` and `viewOf`, and four options built in `buildStreamDownloads` (`seasonEpisodes`, `packs`, `packSwarm`, `finishEpisode`). The pack's play-first follows this phase's model: let go of the swarm, rows `paused` with the pack as their source, opened again by its info hash. `planDownload` and `bandAllows` are reused unchanged.
- **Phase 4 (R1.1, R1.3, R1.10, R1.11's route, R3.2):** map `DownloadError` to HTTP (`invalid_request` → 400, `downloads_off` → 503 together with `deps.streamDownloads == null`, `unknown_download` → 404). A request with `created: false` or `onDisk: true` → 200, `created: true` → 202. `GET /api/stream/downloads` answers `list()` without `?title=` and `list({kind, tmdbId})` with it (the `DownloadView` fields are already snake_case; with a title the latest `done` row per film or episode still whole here is included), with `active = list.some(d => d.state === 'queued' || d.state === 'running' || d.state === 'paused')` (reconciled: paused counts, so the title page keeps reading while a torrent play holds a download back). R3.2 asks for the "title": the route adds `title_id` (`${kind}-${tmdb_id}`). R1.11's route half is `GET` returning `error` and `detail`.
- **Phase 5 (R4.3):** a row from `list()` (no filter) is an `asked` download. `list()` without a filter leaves `done` rows out. The shelf reads finished downloads as the ordinary torrents and caches they are, and a kept torrent is the one whose `stream_torrents.kept_at` is set.
- **Phase 9:** `NOTESD_STREAM_DOWNLOAD_SSID` is pinned to `verify-home` in `verify.sh` by this phase; phase 9 uses the pin and adds no SSID line of its own.
- **Phase 9:** the "Downloading a title" section of `docs/guide/streaming.md` covers the order, the office rule, kept downloads and the prune, offline-ready, play first, carrying on after a restart, and the failure codes. Retarget the `NOTESD_STREAM_DOWNLOADS` row's link (it points at `#caching-a-film-or-an-episode` until that section exists). Add the feature-map entries and the `CLAUDE.md` lines (`DownloadsRepo` is the single writer of `stream_downloads`, a download never switches WARP, and kept torrents are skipped by both prunes).
- Not done here, on purpose: cancelling a cloud download pauses its cache (what it fetched stays, as the owner's cache, deletable on the Cache page) rather than deleting it. A cache that existed before the download may hold other bytes the owner wants. Phase 9 should say this in the guide.

## Rollback

Revert this phase's commit. The torrent layer goes back to `resolve` without `only`, no `fetchKept`, and prunes that ignore `kept_at` (Phase 1's column stays and is unread). `deps.streamDownloads` disappears and nothing starts. Rows already in `stream_downloads` are left as they are, unread until the phase lands again. On a running daemon without a revert, `NOTESD_STREAM_DOWNLOADS=off` stops the engine (queued rows wait), and clearing the marks (`update stream_torrents set kept_at = null`) gives kept torrents back to the prunes.
