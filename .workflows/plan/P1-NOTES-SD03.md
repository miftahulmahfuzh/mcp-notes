> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/stream-downloads-season-story/PLAN.md` phase 3. Source: `/home/miftah/mcp-notes/.workflows/orchestration/stream-downloads-season-story/phase-3.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 3: Season downloads: aired episodes, the season pack, a row per episode

**Plan set:** `STREAM_DOWNLOADS_SEASON_STORY_PLAN.md`
**Analysis:** `.workflows/analyze/20261120-213359-K7Q2_code_analyzer.md`
**Satisfies:** R2 — the season row's Download button downloads the whole season (the engine side; the route is phase 4's, the button phase 8's)
**Criteria:** R2.1, R2.3, R2.4
**Depends on:** Phase 2 (and through it phase 1)
**Difficulty:** HARD
**Package:** `src/directStream/downloads`, `src/directStream/torrent`

---

## Goal

After this phase `StreamDownloads.requestSeason(tmdbId, season, {via})` queues one `stream_downloads` row per aired
episode of the season that is not whole on this machine, all under one `batch`, and answers at once with what it
queued and what it left out (not aired, no air day, already whole). When the queue reaches the first row of such a
batch (via `auto` or `torrent`, off the office network), it looks once for a season pack with live seeds (1080p only
for `auto`), opens it once, checks the first wanted episode's audio before anything else is selected, takes every
wanted episode it holds with its own `use` (video and subtitle files only, one `stream_torrents` row each, kept by the
owner's mark) and marks each row `done` as its file becomes whole, then makes it ready to play offline as a play from
disk would (its remux and subtitle). Episodes the pack lacks, or every episode when no pack fits, stay queued and
download one by one through phase 2's per-episode path, in episode order. While a torrent plays on screen the pack lets
go of its swarm and its rows wait `paused`; when the play ends the same pack is opened again by its info hash.

## Interface Contract

The reconciler reads this section to detect cross-phase conflicts. Be exact and exhaustive.

**Deletes:** nothing.

**Renames:** nothing.

**Creates:**
- `src/directStream/downloads/season.ts` (new): `SeasonDownloads<R>` (`request(tmdbId, season, {via})`, `take(row)`),
  `SeasonPackJob` (`infoHash`, `rowIds`, `done`, `pause()`, `close()`, `cancel(rowId)`, `progress(rowId)`),
  `airedEpisodes(list, today)`, `seasonRowOf(row)`, `seasonRowsOf(repo, host, now)`, `packSwarmOf(torrents)`,
  `finishFromDisk(source, facts, options?)`, types `TvRef`, `SeasonEpisode`, `SeasonLeftOut`, `SeasonAnswer<R>`,
  `SeasonRow`, `SeasonRows`, `PackSwarm`, `SeasonPacks`, `SeasonDownloadsDeps<R>`, constants `PACK_POLL_MS` (30 s),
  `PACK_STALL_MS` (2 h), `FINISH_READY_TRIES` (10), `FINISH_MAX_POLLS` (120).
- `src/directStream/torrent/seasonPack.ts` (new): `seasonPacks(candidates, season, counts, height)`, `holdsSeason(name, season)`.
- `src/directStream/torrent/source.ts`: `TorrentSource.fetchPack(tmdbId, season, episodes, options)`, private
  `tryPack`, private `useSlotOf`; exported types `PackOptions`, `PackHold`, `PackFetch`; constant `MAX_PACK_TRIES` (3);
  optional member `TorrentSwarm.useSlot?(pick, fileIndexes)`.
- `src/directStream/torrent/service.ts`: `TorrentStreams.useSlot(pick, fileIndexes)`, `TorrentStreams.releaseSlot(infoHash, ref)`,
  private `useIn(hash, live, fileIndexes, key)` (the old body of `use`).
- `src/movies/streams.ts`: `MovieStreams.seasonEpisodes(tmdbId, season)`.
- This phase's own edits to phase 2's `src/directStream/downloads/service.ts` (step 6, quoted as phase 2 leaves it):
  public `StreamDownloads.requestSeason(tmdbId, season, {via}): Promise<SeasonAnswer<DownloadRequestAnswer>>`;
  `request`'s body moves into a private `enqueue(ref, ask)` (the same answer, no tick), `request` = `enqueue` + tick;
  private fields `season: SeasonDownloads<DownloadRequestAnswer> | null` and `pack: SeasonPackJob | null` (the one
  torrent job when it carries a season pack; `job` and `pack` are never both set); `run(job, row, steps, before,
  resume)` gains the claimed `row` and the batch hook at its top; `playFirst`, `cancel`, `close` and `viewOf` gain the
  pack's branch; `StreamDownloadsOptions` gains `seasonEpisodes?`, `packs?`, `packSwarm?`, `finishEpisode?`;
  `buildStreamDownloads`' wiring gains `movieStreams?: Pick<MovieStreams, 'seasonEpisodes'> | null` and builds the four.

**Signature changes:** `TorrentStreams.use(infoHash, fileIndexes)` keeps its signature and behaviour (its body moves
into `useIn`). Phase 2's private `StreamDownloads.run` gains a `row: StreamDownloadRow` parameter (its one caller,
`startNext`, passes the row it planned).

**Requires (from earlier phases):** exact names phase 3 calls, as phases 1 and 2 state them (reconciled).
- Phase 1, `src/db/schema.ts`: `StreamDownloadRow` (`id`, `host`, `kind`, `tmdbId`, `season`, `episode`, `via`,
  `infoHash`, `batch`, `state` `queued|running|paused|done|failed`, `source` `torrent|cloud|null`, `sourceId`,
  `bytesDone`, `bytesTotal`, `error`, `errorDetail`, `createdAt`, `updatedAt`, `completedAt`); `StreamTorrentRow.keptAt`.
- Phase 1, `src/directStream/downloads/repo.ts`: `type DownloadRecords` with `list(host, {states?})` (ordered
  `created_at`, `season`, `episode`, `id`: a batch's rows run in episode order), `get(host, id)`,
  `setState(host, id, 'queued'|'running'|'paused', now)`, `on(host, id, {source: 'torrent', infoHash}, now)`,
  `done(host, id, on, {bytesDone, bytesTotal}, now)`, `failed(host, id, error, detail, now)`, and
  `create(host, {ref, via, infoHash, batch}, now): Promise<{row, created}>` (the integration test seeds with it).
  Only `seasonRowsOf` and the integration test call them.
- Phase 1, `TorrentsRepo.setKept(host, infoHash, at: Date | null)`, reached through phase 2's `TorrentStreams.keep`.
- Phase 2, `src/directStream/downloads/types.ts`: `DownloadVia`, `DownloadRequestAnswer {download, created, onDisk}`,
  `DownloadError`.
- Phase 2, `src/directStream/downloads/plan.ts`: `isOffice(ssid)`.
- Phase 2, `src/directStream/downloads/service.ts` as phase 2's plan writes it: `StreamDownloadsOptions` (`host`,
  `repo: DownloadRecords`, `torrents`, `caches`, `ssid`, `playingTorrents`, `afterDone?`, `now?`, `log?`, `every?`);
  private `job: Job | null`, `onDisk(ref)`, `tick()`, `startNext()`, `run(job, steps, before, resume)`, `playFirst()`,
  `viewOf(row)`; public `request(ref, {via, infoHash?, batch?})`, `cancel(id)`, `close()`;
  `buildStreamDownloads(config, wiring: {db, directStream, torrentSource, torrents, streamCache, warp, afterDone?, log?})`.
  Play first there means: let go of the swarm, mark the row `paused` with its torrent as its source, and open it again
  by its info hash when the play ends. A season pack follows the same model (no deselect-and-reselect on `TorrentStreams`).
- Phase 2, `TorrentStreams.keep(infoHash, kept: boolean)`; `TorrentSource.keptState(torrent)` and `release(torrent)`;
  `DirectStreamService.downloadFacts(ref): Promise<{audioLang, imdbId, names}>`.
- Phase 2: the prune and the budget skip a torrent any of whose rows has `kept_at` (the pack is kept through them).
- Existing code, unchanged: `TorrentSource.fromDisk(ref, {audioLang})` starts a whole download's remux (when its file
  needs one) and its subtitle chain, which is how a pack episode is made ready to play offline (R1.8's steps for a
  pack episode, `finishFromDisk`).

**Leaves alone (owned by others):** phase 2's source order, office rule, `fetchKept`, prune exemption and per-episode
download path (reused unchanged); `src/http/*`, `src/mcp/*`, `scripts/docs/*` (phase 4); `cacheShelf.ts` (phase 5);
`web/*` (phases 5, 7, 8); `docs/*`, `.claude/skills/verify-notesd/*` (phase 9); `ahead.ts` and the fetch-ahead's own
pack handling; `src/directStream/torrent/find/*` (read, not edited: no ranking rule changes, `titleSearchExclusion`
untouched).

## Files

| File | Action | What changes |
|---|---|---|
| `src/directStream/torrent/service.ts` | modify | `use` body moves to `useIn`; new `useSlot`, `releaseSlot` (after `release`, line 302) |
| `src/directStream/torrent/seasonPack.ts` | create | `seasonPacks`, `holdsSeason` (pure) |
| `src/directStream/torrent/source.ts` | modify | `TorrentSwarm.useSlot?` (line 130); `PackOptions`/`PackHold`/`PackFetch`/`MAX_PACK_TRIES` (after line 218); `fetchPack`, `tryPack`, `useSlotOf` (after `releaseAhead`, line 700, and after phase 2's `fetchKept`) |
| `src/movies/streams.ts` | modify | `seasonEpisodes` after `neighbors` (line 323) |
| `src/directStream/downloads/season.ts` | create | season request, the pack job, the row adapter, the swarm adapter, `finishFromDisk` |
| `src/directStream/downloads/service.ts` | modify (phase 2's) | options, fields, constructor, `enqueue`/`request`, `requestSeason`, the pack's branches in `playFirst`/`cancel`/`close`/`startNext`/`run`/`viewOf`, `buildStreamDownloads`' four options |
| `src/daemon.ts` | modify | `movieStreams` added to phase 2's `buildStreamDownloads(config, {...})` call |
| `tests/unit/directStream/torrent/useSlot.test.ts` | create | `useSlot` / `releaseSlot` on the real `TorrentStreams` |
| `tests/unit/directStream/torrent/seasonPack.test.ts` | create | `seasonPacks`, `TorrentSource.fetchPack` |
| `tests/unit/directStream/downloads/season.test.ts` | create | `SeasonDownloads.request` / `take`, `SeasonPackJob` |
| `tests/integration/directStream.seasonDownloads.int.test.ts` | create | the whole path on Postgres: one swarm, N kept rows, N done rows |

## Implementation Steps

### Step 1: `TorrentStreams.useSlot` and `releaseSlot`
**File:** `src/directStream/torrent/service.ts:239-272` (replace `use`), and new methods after `release` (ends line 302)
**Change:** today `use` puts the files on "the episode whose row already holds these files, else the one last opened".
A season download takes several episodes of one pack in a row, and a play may open the same pack meanwhile, so it
names the episode itself. `use`'s body moves unchanged into `useIn`, which takes an optional slot key; `use` calls it
with `null` (same behaviour); `useSlot` takes the slot first (`takeSlot`, which makes the row) and passes its key.
`releaseSlot` is the cancel of one episode of a held pack: that episode's own unfinished files are deselected and its
hold given back. No other line of the class changes; `slotOf` and `TorrentPick` are already imported.
**Code:** replace lines 239-272 with:
```ts
  /**
   * Selects these files (videos and subtitles only) and counts one more user. On a finished download read
   * from disk it does nothing (nothing joins a swarm). Throws not_open, not_media, invalid_hash.
   */
  async use(infoHash: string, fileIndexes: readonly number[]): Promise<void> {
    const hash = normalizeInfoHash(infoHash);
    if (hash === null) throw new TorrentError('invalid_hash', 'An info hash is 40 hexadecimal characters.');
    const live = this.active.get(hash);
    if (live === undefined) {
      if (await this.readyOnDisk(hash, fileIndexes)) return;
      throw new TorrentError('not_open', 'Open the torrent before using its files.');
    }
    await this.useIn(hash, live, fileIndexes, null);
  }

  /**
   * `use` for one named episode of a torrent in the swarm (a season download takes every wanted episode of a pack this
   * way, one hold each): that episode's row, made now when there is none, takes the files, whatever episode was opened
   * last. Two episodes on one file (a double episode) each keep their own row. On a finished download read from disk
   * it does nothing. Throws not_open, not_media, invalid_hash.
   */
  async useSlot(pick: TorrentPick, fileIndexes: readonly number[]): Promise<void> {
    const hash = normalizeInfoHash(pick.infoHash);
    if (hash === null) throw new TorrentError('invalid_hash', 'An info hash is 40 hexadecimal characters.');
    const live = this.active.get(hash);
    if (live === undefined) {
      if (await this.readyOnDisk(hash, fileIndexes)) return;
      throw new TorrentError('not_open', 'Open the torrent before using its files.');
    }
    live.lastRequestAt = this.nowMs();
    await this.takeSlot(live, { ...pick, infoHash: hash });
    await this.useIn(hash, live, fileIndexes, slotKey(slotOf(hash, pick.ref)));
  }

  /** A ready row of this host that chose every one of these files, whole on disk: nothing to join. */
  private async readyOnDisk(hash: string, fileIndexes: readonly number[]): Promise<boolean> {
    for (const row of await this.repo.slots(this.host, hash)) {
      if (row.state === 'ready' && fileIndexes.every((i) => row.files.some((f) => f.index === i)) && (await this.diskHandle(row)) !== null) return true;
    }
    return false;
  }

  /** `use` on a torrent in the swarm. `key`: the episode's row that takes the files; null: as `use` has always chosen. */
  private async useIn(hash: string, live: Active, fileIndexes: readonly number[], key: string | null): Promise<void> {
    const chosen = this.mediaFiles(live.handle, fileIndexes);
    // A video that lives as its remux is never fetched again: its original was deleted on purpose.
    const remuxed = new Set([...live.rows.values()].flatMap((r) => r.files.filter((f) => f.remuxed === true).map((f) => f.index)));
    live.handle.select(chosen.filter((f) => !remuxed.has(f.index)).map((f) => f.index));
    live.users += 1;
    live.lastRequestAt = this.nowMs();
    // The episode named; else the one whose row already holds these files (a reload takes its torrent again), else the one last opened.
    const named = key === null ? undefined : live.rows.get(key);
    const row = named ?? [...live.rows.values()].find((r) => chosen.every((c) => r.files.some((f) => f.index === c.index))) ?? this.current(live);
    const files: StreamTorrentFile[] = row.files.map((f) => ({ ...f }));
    for (const f of chosen) if (!files.some((m) => m.index === f.index)) files.push({ index: f.index, path: f.path, length: f.length });
    const fileIndex = row.fileIndex ?? chosen.find((f) => mediaOf(f.name) === 'video')?.index ?? null;
    const fileLength = files.find((f) => f.index === fileIndex)?.length ?? null;
    try {
      live.rows.set(slotKey(row), await this.repo.chosen(this.host, row, { files, fileIndex, fileLength }, this.now()));
    } catch (err) {
      // The caller sees a throw and holds nothing: the user it was counted as is taken back.
      live.users -= 1;
      throw err;
    }
  }
```
and insert after `release` (after line 302, before the `drop` doc comment):
```ts
  /**
   * Gives back the hold one episode took with `useSlot` and stops fetching that episode's own files (the ones no other
   * episode of the torrent chose, and not whole yet): a season download whose episode was cancelled. The episode's row
   * and what is on disk stay. With no hold left the torrent goes as after `release`. Unknown or not in the swarm: ignored.
   */
  async releaseSlot(infoHash: string, ref: StreamRef): Promise<void> {
    const hash = normalizeInfoHash(infoHash);
    const live = hash === null ? undefined : this.active.get(hash);
    if (hash === null || live === undefined) return;
    const key = slotKey(slotOf(hash, ref));
    const row = live.rows.get(key);
    if (row !== undefined) {
      const others = new Set([...live.rows.values()].filter((r) => slotKey(r) !== key).flatMap((r) => r.files.map((f) => f.index)));
      const stop = row.files.map((f) => f.index).filter((i) => !others.has(i) && !live.handle.done(i));
      if (stop.length > 0) {
        try {
          live.handle.deselect?.(stop);
        } catch (err) {
          this.log(`[notesd] torrent: could not stop ${row.name}${episodeOf(row)}: ${messageOf(err)}`);
        }
      }
    }
    await this.release(hash);
  }
```
**Impact:** `use` behaves as before (every existing caller and test unchanged). Two new public methods; nothing calls
them until step 3.

### Step 2: the season packs among a season's candidates
**File:** `src/directStream/torrent/seasonPack.ts` (new)
**Change:** a pure filter and order over the finder's answer for the season's first wanted episode. It reads the
release name with the finder's own parser and never re-ranks what the finder left out (`titleSearchExclusion`, dub,
cam, seed floor all applied already in `rankCandidates`).
**Code:**
```ts
import { heightRank, looksDead, parseEpisodeRef, type ReleaseHeight, type SwarmCount, type TorrentCandidate } from './find/index.js';

/**
 * The season packs among a season's torrent candidates, for a season download (TorrentSource.fetchPack): a release
 * whose name holds more than one episode (`release.pack`) and names `season` (alone, in a range of seasons that covers
 * it, or a complete series that names no season), whose swarm the trackers do not call dead, at `height` when one is
 * given. Best first: the preferred height (HEIGHT_PREFERENCE), one season before a range or a complete series, then
 * more seeders. What the finder left out stays out: nothing here loosens its rules.
 */
export function seasonPacks(
  candidates: readonly TorrentCandidate[],
  season: number,
  counts: ReadonlyMap<string, SwarmCount>,
  height: ReleaseHeight | null,
): TorrentCandidate[] {
  const seeders = (c: TorrentCandidate): number => Math.max(c.seeds, counts.get(c.infoHash)?.seeders ?? 0);
  return candidates
    .filter((c) => c.release.pack && holdsSeason(c.name, season) && !looksDead(counts.get(c.infoHash)) && (height === null || c.release.height === height))
    .sort(
      (a, b) =>
        heightRank(a.release.height) - heightRank(b.release.height) ||
        Number(spansMore(a.name)) - Number(spansMore(b.name)) ||
        seeders(b) - seeders(a) ||
        a.infoHash.localeCompare(b.infoHash),
    );
}

/** The release name names `season`: alone, inside a range of seasons, or a complete series that names no season. */
export function holdsSeason(name: string, season: number): boolean {
  const ref = parseEpisodeRef(name);
  if (ref.season === null) return ref.complete;
  return season >= ref.season && season <= (ref.seasonTo ?? ref.season);
}

/** A range of seasons or a complete series: more than the one season is listed. */
function spansMore(name: string): boolean {
  const ref = parseEpisodeRef(name);
  return ref.seasonTo !== null || ref.complete;
}
```
**Impact:** new module, no caller until step 3.

### Step 3: `TorrentSource.fetchPack`
**File:** `src/directStream/torrent/source.ts` — the import block (lines 1-18), `TorrentSwarm` (line 130, before its
closing brace), new exported types after `TorrentResolve` (line 218), new methods after `releaseAhead` (line 700; after
phase 2's `fetchKept` when phase 2 put it there).
**Change:** the indexes are asked once for the season's first wanted episode (the finder's existing episode query: a
pack is listed for every episode it holds, so no new query shape is needed). The packs among the answer are opened one
at a time, at most `MAX_PACK_TRIES`. Each episode's file is chosen by the existing `pickFile`. The first wanted
episode the pack holds is taken alone, probed through the daemon's file route and refused exactly as a play refuses
(`refusalOf`: a dub, a file Chrome cannot play and the remux cannot help), then heard when its tags name no language;
only a pack that passes has its other episodes taken. A pack that fails is let go at once (its swarm left, its fresh
rows and folder deleted by `drop`), and the next is tried. `known` (the pack a batch was downloading from before a
restart) is tried first without asking any index.

Add to the imports (line 18 block):
```ts
import { seasonPacks } from './seasonPack.js';
```
Add to `TorrentSwarm`, after `downloadsOf?` (line 130):
```ts
  /** `use` for one named episode of a torrent in the swarm (TorrentStreams.useSlot). Absent: open again for that episode, then `use`. */
  useSlot?(pick: TorrentPick, fileIndexes: readonly number[]): unknown;
```
Add after the `TorrentResolve` type (line 218):
```ts
/** Season packs opened per season download before the answer is no_pack (downloads/season.ts then downloads each episode alone). */
export const MAX_PACK_TRIES = 3;

/** What a season download asks of the torrent source (TorrentSource.fetchPack). */
export interface PackOptions {
  /** The title's original language (TMDB's code); null: unknown. */
  audioLang: string | null;
  imdbId: string | null;
  /** The title's names, as for the season's first wanted episode; null: unknown. */
  names: TitleNames | null;
  /** `preferred`: only a pack at PREFERRED_TORRENT_HEIGHT (a download with no source named); `any`: every height, the preferred first. */
  heights: 'preferred' | 'any';
  /** The info hash this season was downloading from before a restart: tried first, with no index asked. */
  known?: string | null;
}

/** A season pack held for a season download: one `use` of the torrent per episode in `episodes`, until each is let go. */
export interface PackHold {
  infoHash: string;
  /** The release name as the index listed it. */
  name: string;
  /** The wanted episodes the pack holds, in episode order, with their chosen files (a video and its subtitles). */
  episodes: { episode: number; video: number; subtitles: number[] }[];
  /** The wanted episodes the pack holds no file of, in episode order: each downloads on its own. */
  lacking: number[];
  /** `Index: <name>` per index asked, then `Torrent: <release>` per pack tried. */
  attempts: ResolveAttempt[];
}

export type PackFetch = { ok: true; pack: PackHold } | { ok: false; error: 'no_pack'; attempts: ResolveAttempt[] };
```
Add after `releaseAhead` (line 700):
```ts
  /**
   * A season download's pack (downloads/season.ts). The indexes are asked for the first wanted episode; the season packs
   * among the answer (seasonPack.ts) are opened one at a time, at most MAX_PACK_TRIES, and the first that passes is
   * kept: its first wanted episode is taken alone and checked as a play is (the probe's refusal, then a hearing when its
   * tags name no language) before any other episode is selected; then every wanted episode it holds is taken with its
   * own `use`, its video and subtitle files only, one `stream_torrents` row each. `known` is tried first, with no
   * index asked. Never throws: a pack that fails is let go at once.
   */
  async fetchPack(tmdbId: number, season: number, episodes: readonly number[], options: PackOptions): Promise<PackFetch> {
    const wanted = [...new Set(episodes)].sort((a, b) => a - b);
    const [first] = wanted;
    if (first === undefined) return { ok: false, error: 'no_pack', attempts: [] };
    const refOf = (episode: number): StreamRef => ({ kind: 'tv', tmdbId, season, episode });
    const label = `TMDB tv ${tmdbId} S${pad(season)}`;
    const started = this.now();
    const query = queryOf(refOf(first), options.imdbId, options.names, options.audioLang);
    // Blacklisted by the owner, or heard speaking another language than this title's: never tried.
    const marked = await this.leftOutByMarks(options.audioLang);
    const attempts: ResolveAttempt[] = [];
    const kept = (hold: Omit<PackHold, 'attempts'>): PackFetch => {
      this.log(`[notesd] torrent: ${label}: downloading ${plural(hold.episodes.length, 'episode')} from the season pack ${hold.name} (${hold.infoHash.slice(0, 8)})${hold.lacking.length === 0 ? '' : `; it lacks ${hold.lacking.map((e) => `E${pad(e)}`).join(', ')}`}`);
      return { ok: true, pack: { ...hold, attempts } };
    };
    const known = options.known == null ? null : candidateFromMagnet(options.known, query);
    if (known !== null && !marked.has(known.infoHash.toLowerCase())) {
      const out = await this.tryPack(known, refOf, wanted, options, TORRENT_DEADLINE_MS);
      attempts.push(out.attempt);
      if (out.ok) return kept(out.pack);
    }
    let found: FindAnswer;
    try {
      found = await this.opts.find(query, AbortSignal.timeout(TORRENT_DEADLINE_MS), { tried: marked });
    } catch (err) {
      return { ok: false, error: 'no_pack', attempts: [...attempts, { provider: 'Index: all', outcome: 'error', took_s: seconds(started, this.now()), detail: messageOf(err) }] };
    }
    attempts.push(...found.indexes.map(indexAttempt));
    const listed = found.candidates.filter((c) => c.release.pack && !marked.has(c.infoHash.toLowerCase()) && c.infoHash !== known?.infoHash);
    const counts = await this.swarmCounts(listed);
    const packs = seasonPacks(listed, season, counts, options.heights === 'preferred' ? PREFERRED_TORRENT_HEIGHT : null);
    for (const c of packs.slice(0, MAX_PACK_TRIES)) {
      const out = await this.tryPack(c, refOf, wanted, options, TORRENT_DEADLINE_MS);
      attempts.push(out.attempt);
      if (out.ok) return kept(out.pack);
    }
    this.log(`[notesd] torrent: ${label}: no season pack of ${plural(wanted.length, 'episode')} ${packs.length === 0 ? `was found (${plural(listed.length, 'pack')} listed, none ${options.heights === 'preferred' ? `at ${PREFERRED_TORRENT_HEIGHT}p ` : ''}with live seeds holding the season)` : 'passed'}; each episode downloads on its own`);
    return { ok: false, error: 'no_pack', attempts };
  }

  /**
   * One pack up to its holds: the file list from the swarm, each wanted episode's file (pickFile), the first one taken
   * and checked, then the others taken. Any failure lets go of every hold taken here, and of the torrent.
   */
  private async tryPack(
    c: TorrentCandidate,
    refOf: (episode: number) => StreamRef,
    wanted: readonly number[],
    options: PackOptions,
    budgetMs: number,
  ): Promise<{ ok: true; pack: Omit<PackHold, 'attempts'>; attempt: ResolveAttempt } | { ok: false; attempt: ResolveAttempt }> {
    const started = this.now();
    const swarm = this.opts.swarm;
    const attempt = (outcome: ResolveOutcome, detail: string): ResolveAttempt => ({ provider: torrentLabel(c.name), outcome, took_s: seconds(started, this.now()), detail });
    const pickOf = (episode: number): TorrentPick => ({ infoHash: c.infoHash, trackers: this.trackersOf(c), name: c.name, ref: refOf(episode), release: c.release });
    let holds = 0;
    const letGo = (): void => {
      if (holds === 0) this.dropNow(c.infoHash, false);
      for (; holds > 0; holds -= 1) this.dropNow(c.infoHash, true);
    };
    const [first] = wanted;
    if (first === undefined) return { ok: false, attempt: attempt('skipped', 'no episode was asked for') };
    let opened: OpenedTorrent;
    try {
      opened = await swarm.open(pickOf(first), { timeoutMs: Math.min(TORRENT_OPEN_TIMEOUT_MS, budgetMs) });
    } catch (err) {
      letGo();
      return { ok: false, attempt: attempt('no_stream', `${NO_FILE_LIST} (${messageOf(err)})`) };
    }
    const held = wanted.flatMap((episode) => {
      const picked = pickFile(opened.files, queryOf(refOf(episode), options.imdbId, null, options.audioLang));
      return picked === null ? [] : [{ episode, video: picked.video, subtitles: picked.subtitles }];
    });
    const lacking = wanted.filter((episode) => !held.some((h) => h.episode === episode));
    const [head, ...rest] = held;
    if (head === undefined) {
      letGo();
      return { ok: false, attempt: attempt('no_stream', `the torrent holds no file of ${wanted.map((e) => `E${pad(e)}`).join(', ')}`) };
    }
    try {
      await this.useSlotOf(pickOf(head.episode), [head.video, ...head.subtitles]);
      holds += 1;
      // The audio check a play applies, on the first wanted episode alone, before any other file is selected.
      const url = `${this.opts.localBase()}${swarm.localUrl(c.infoHash, head.video)}`;
      const probed = await this.probeWhileDelivering(url, c.infoHash, Math.max(PROBE_MIN_MS, budgetMs - (this.now() - started)), () => false);
      if (!probed.ok) {
        letGo();
        return { ok: false, attempt: attempt(probed.outcome, `E${pad(head.episode)}: ${probed.detail}`) };
      }
      const probe = probed.probe;
      this.noteTags(c.infoHash, c.name, audioLanguages(probe));
      const refusal = refusalOf(probe, options.audioLang, this.opts.remux ?? null);
      if (refusal !== null) {
        letGo();
        this.remember(refKey(refOf(head.episode)), c.infoHash, true, `${refusal.outcome}: ${refusal.detail}`);
        return { ok: false, attempt: attempt(refusal.outcome, `E${pad(head.episode)}: ${refusal.detail}`) };
      }
      if (options.audioLang !== null && audioLanguages(probe).length === 0 && this.hears) {
        const heard = await this.hearAudio({ infoHash: c.infoHash, fileIndex: head.video, name: c.name, durationS: probe.durationS }, options.audioLang, null);
        if (heard?.verdict === 'dubbed') {
          letGo();
          this.noteDubbed(refOf(head.episode), c.infoHash, heard.reason);
          return { ok: false, attempt: attempt('dubbed', `E${pad(head.episode)}: ${heard.reason}`) };
        }
      }
      this.noteDuration(c.infoHash, probe, head.video);
      for (const e of rest) {
        await this.useSlotOf(pickOf(e.episode), [e.video, ...e.subtitles]);
        holds += 1;
      }
    } catch (err) {
      letGo();
      return { ok: false, attempt: attempt('error', messageOf(err)) };
    }
    const detail = `${plural(held.length, 'episode')} taken${lacking.length === 0 ? '' : `; it lacks ${lacking.map((e) => `E${pad(e)}`).join(', ')}`}, ${c.seeds} seeds`;
    return { ok: true, pack: { infoHash: c.infoHash, name: c.name, episodes: held, lacking }, attempt: attempt('resolved', detail) };
  }

  /** `use` for one named episode of a torrent opened before (TorrentStreams.useSlot); a swarm without it is opened again for the episode. */
  private async useSlotOf(pick: TorrentPick, fileIndexes: readonly number[]): Promise<void> {
    const swarm = this.opts.swarm;
    if (swarm.useSlot !== undefined) {
      await swarm.useSlot(pick, fileIndexes);
      return;
    }
    await swarm.open(pick, { timeoutMs: TORRENT_OPEN_TIMEOUT_MS });
    await swarm.use(pick.infoHash, fileIndexes);
  }
```
**Impact:** `pickFile` already selects only video and subtitle files, and `TorrentStreams.mediaFiles` refuses anything
else, so a pack's other files (samples, `.nfo`, programs) are never selected. The finder, its ranking and
`titleSearchExclusion` are untouched. Nothing calls `fetchPack` until step 6.

### Step 4: `MovieStreams.seasonEpisodes`
**File:** `src/movies/streams.ts:323` (after `neighbors`)
**Change:** the season's episodes and their air days from the stored title, as `neighbors` and `releaseDate` read them
(the title is ensured first). The phase reads only; the aired filter is applied once, in `airedEpisodes` (step 5).
**Code:**
```ts
  /**
   * A season's episodes with the day each aired (TMDB's, as the stored title keeps it), in episode order, for a season
   * download (src/directStream/downloads/season.ts). The title is stored first. Null when it is not stored and cannot be.
   */
  async seasonEpisodes(tmdbId: number, season: number): Promise<{ episode: number; airDate: string | null }[] | null> {
    try {
      const id = await this.ensureTitle({ kind: 'tv', tmdbId });
      if (id === null) return null;
      const meta = await this.movies.repo.loadTitleMetadata(id);
      if (meta === null) return null;
      return meta.episodes
        .filter((e) => e.season === season)
        .map((e) => ({ episode: e.episode, airDate: e.airDate }))
        .sort((a, b) => a.episode - b.episode);
    } catch (err) {
      this.log(`[notesd] direct stream: could not read season ${season} of TMDB tv ${tmdbId}: ${messageOf(err)}`);
      return null;
    }
  }
```
**Impact:** new method, read-only.

### Step 5: the season download and the pack job
**File:** `src/directStream/downloads/season.ts` (new)
**Change:** everything season-shaped lives here, behind small seams so the engine of phase 2 only adds one hook:
`SeasonDownloads.request` (what `requestSeason` answers), `SeasonDownloads.take` (the hook the queue calls for a
claimed row of a batch), `SeasonPackJob` (the one torrent job that carries several rows), the adapter onto
`DownloadsRepo` (`seasonRowsOf`, the only place that names phase 1's repo methods) and onto `TorrentStreams`
(`packSwarmOf`). A batch's pack is looked for once per daemon run; its rows finish and fail one by one.
**Code:**
```ts
import { randomUUID } from 'node:crypto';
import type { StreamDownloadRow } from '../../db/schema.js';
import type { PackFetch, PackHold, PackOptions, TorrentSource } from '../torrent/source.js';
import type { TorrentStreams } from '../torrent/service.js';
import { refLabel, type StreamRef } from '../types.js';
import type { DownloadRecords } from './repo.js';
import type { DownloadFacts, DownloadVia } from './types.js';

/**
 * Season downloads (the season row's Download button, R2). A season asks for every aired episode of it that this
 * machine does not hold whole: one `stream_downloads` row each, under one batch, queued at once. When the queue reaches
 * the first of them (one torrent download at a time, StreamDownloads' runner), the batch's season pack is looked for
 * once (TorrentSource.fetchPack): with one, a single swarm carries every episode it holds, one `stream_torrents` row
 * and one hold each, kept by the owner's mark, and each row is done when its file is whole. Episodes the pack lacks,
 * or all of them when no pack fits, go through the per-episode path in episode order. Nothing starts unasked: only the
 * episodes the owner's click named, never one that has not aired.
 */

/** How often a season pack's episodes are looked at (whole yet, cancelled, the swarm still sending). */
export const PACK_POLL_MS = 30_000;
/** A season pack whose swarm sent nothing for this long fails what it still carries. */
export const PACK_STALL_MS = 2 * 3_600_000;
/** A whole pack episode is ready to play from disk once the torrents' tick settled it: looked for this many times, PACK_POLL_MS apart. */
export const FINISH_READY_TRIES = 10;
/** Its remux and subtitle search are waited for at most this many looks, PACK_POLL_MS apart (an hour). */
export const FINISH_MAX_POLLS = 120;

export type TvRef = Extract<StreamRef, { kind: 'tv' }>;

/** One episode of a season as the title's stored metadata lists it; `airDate` is TMDB's day (`2026-10-08`) or null. */
export interface SeasonEpisode {
  episode: number;
  airDate: string | null;
}

/** An episode a season download left out, and why: it airs later, no day is known for it, or it is whole here already. */
export interface SeasonLeftOut {
  episode: number;
  why: 'not_aired' | 'no_air_date' | 'whole';
}

/** What StreamDownloads.requestSeason answers. `queued` holds what `request` answered per episode, in episode order. */
export type SeasonAnswer<R> =
  | { ok: true; batch: string | null; queued: R[]; left_out: SeasonLeftOut[] }
  | { ok: false; error: 'unknown_season' | 'seasons_off'; detail: string };

/** A `stream_downloads` row of an episode, as a season download reads it. */
export interface SeasonRow {
  id: string;
  ref: TvRef;
  via: DownloadVia;
  /** A torrent the owner picked by hand: such a row is never carried by a pack. */
  infoHash: string | null;
  batch: string | null;
  /** The torrent the row was downloading from (a pack, before a restart); null when none yet. */
  sourceId: string | null;
}

/** What a season download writes and reads of its rows (DownloadsRepo through `seasonRowsOf`). */
export interface SeasonRows {
  /** This host's rows of `batch` still to download (queued, running or paused), in episode order. */
  open(batch: string): Promise<SeasonRow[]>;
  /** True while the row is still to download: a cancel, or anything else that ended it, says false. */
  wanted(id: string): Promise<boolean>;
  /** The row downloads from the pack now: running, the pack's info hash its source. */
  running(id: string, infoHash: string): Promise<void>;
  /** A torrent plays on screen: the row waits, the pack still its source (the next take opens it again by its hash). */
  paused(id: string): Promise<void>;
  done(id: string, infoHash: string, bytes: { done: number; total: number } | null): Promise<void>;
  failed(id: string, code: 'download_failed', detail: string): Promise<void>;
}

/** The torrents as a season pack uses them (TorrentStreams with phase 2's owner's mark, through `packSwarmOf`). */
export interface PackSwarm {
  /** True once the file is whole on this machine (its file, or its remux alone). */
  whole(infoHash: string, fileIndex: number): Promise<boolean>;
  /** The file's bytes on disk now and its length; null when this machine has no such file. */
  bytes(infoHash: string, fileIndex: number): Promise<{ done: number; total: number } | null>;
  /** Bytes the torrent received from peers since it was opened; null when it cannot say. */
  received(infoHash: string): number | null;
  /** Gives back one episode's hold; with none left the torrent leaves the swarm when it is finished. */
  release(infoHash: string): Promise<void>;
  /** One episode's own files stop downloading and its hold is given back (TorrentStreams.releaseSlot). */
  releaseSlot(infoHash: string, ref: StreamRef): Promise<void>;
  /** The owner's mark on every row of the torrent: the age prune and the budget skip it. */
  keep(infoHash: string): Promise<void>;
}

/** TorrentSource.fetchPack, with the title's language, IMDb id and names filled in by the wiring. */
export interface SeasonPacks {
  fetch(tmdbId: number, season: number, episodes: readonly number[], options: Pick<PackOptions, 'heights' | 'known'>): Promise<PackFetch>;
}

export interface SeasonDownloadsDeps<R> {
  /** The season's episodes as the title's stored metadata lists them; null when the series is not stored and cannot be. */
  episodes(tmdbId: number, season: number): Promise<SeasonEpisode[] | null>;
  /** True when this machine holds the episode whole (a finished torrent download, a ready cache). */
  whole(ref: TvRef): Promise<boolean>;
  /** StreamDownloads.request: one row for the episode, answered at once (the existing one when it is still to download). */
  request(ref: TvRef, options: { via: DownloadVia; batch: string }): Promise<R>;
  rows: SeasonRows;
  /** Null: torrents off; every row of a season downloads on its own. */
  packs: SeasonPacks | null;
  swarm: PackSwarm | null;
  /** True on the office network (SSID `Employee`): no pack is opened there; the per-episode path applies the office rule. */
  office(): Promise<boolean>;
  /** What a torrent download does once a file is whole (the remux to its end, the subtitle: finishFromDisk); absent: nothing more. */
  finish?(ref: TvRef): Promise<void>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  newBatch?: () => string;
  log?: (line: string) => void;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const pad = (n: number): string => String(n).padStart(2, '0');
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const OPEN_STATES: ReadonlySet<string> = new Set(['queued', 'running', 'paused']);

const tvRef = (tmdbId: number, season: number, episode: number): TvRef => ({ kind: 'tv', tmdbId, season, episode });

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/**
 * The episodes of a season a download takes: aired on or before `today` (TMDB's day, as `refuseUnreleased` reads it).
 * One that airs later, or whose day TMDB does not give, is left out: nothing is asked for an episode that may not exist yet.
 */
export function airedEpisodes(list: readonly SeasonEpisode[], today: string): { aired: number[]; leftOut: SeasonLeftOut[] } {
  const aired: number[] = [];
  const leftOut: SeasonLeftOut[] = [];
  for (const e of [...list].sort((a, b) => a.episode - b.episode)) {
    if (e.airDate === null || !DAY.test(e.airDate)) leftOut.push({ episode: e.episode, why: 'no_air_date' });
    else if (e.airDate > today) leftOut.push({ episode: e.episode, why: 'not_aired' });
    else aired.push(e.episode);
  }
  return { aired, leftOut };
}

/** A `stream_downloads` row as a season download reads it; null for a film's. */
export function seasonRowOf(r: StreamDownloadRow): SeasonRow | null {
  if (r.kind !== 'tv') return null;
  return {
    id: r.id,
    ref: tvRef(r.tmdbId, r.season, r.episode),
    via: r.via,
    infoHash: r.infoHash,
    batch: r.batch,
    sourceId: r.source === 'torrent' ? r.sourceId : null,
  };
}

/** SeasonRows over phase 1's DownloadsRepo (through phase 2's DownloadRecords), the only writer of `stream_downloads`. */
export function seasonRowsOf(
  repo: Pick<DownloadRecords, 'list' | 'get' | 'setState' | 'on' | 'done' | 'failed'>,
  host: string,
  now: () => Date,
): SeasonRows {
  return {
    open: async (batch) =>
      (await repo.list(host, { states: ['queued', 'running', 'paused'] }))
        .filter((r) => r.batch === batch)
        .flatMap((r) => {
          const row = seasonRowOf(r);
          return row === null ? [] : [row];
        })
        .sort((a, b) => a.ref.episode - b.ref.episode),
    wanted: async (id) => {
      const row = await repo.get(host, id);
      return row !== null && OPEN_STATES.has(row.state);
    },
    running: async (id, infoHash) => {
      await repo.on(host, id, { source: 'torrent', infoHash }, now());
      await repo.setState(host, id, 'running', now());
    },
    paused: async (id) => {
      await repo.setState(host, id, 'paused', now());
    },
    done: async (id, infoHash, bytes) => {
      await repo.done(host, id, { source: 'torrent', infoHash }, { bytesDone: bytes?.done ?? 0, bytesTotal: bytes?.total ?? null }, now());
    },
    failed: async (id, code, detail) => {
      await repo.failed(host, id, code, detail, now());
    },
  };
}

/** PackSwarm over TorrentStreams, with phase 2's owner's mark (`keep(hash, true)`). */
export function packSwarmOf(torrents: Pick<TorrentStreams, 'filePath' | 'remuxOnly' | 'onDisk' | 'received' | 'release' | 'releaseSlot' | 'keep'>): PackSwarm {
  return {
    whole: async (infoHash, fileIndex) => (await torrents.filePath(infoHash, fileIndex)) !== null || (await torrents.remuxOnly(infoHash, fileIndex)),
    bytes: async (infoHash, fileIndex) => {
      const disk = await torrents.onDisk(infoHash, fileIndex);
      if (disk === null) return null;
      const done = disk.kind === 'whole' ? disk.length : disk.ranges.reduce((n, [from, to]) => n + (to - from), 0);
      return { done, total: disk.length };
    },
    received: (infoHash) => torrents.received(infoHash),
    release: (infoHash) => torrents.release(infoHash),
    releaseSlot: (infoHash, ref) => torrents.releaseSlot(infoHash, ref),
    keep: (infoHash) => torrents.keep(infoHash, true),
  };
}

/**
 * A pack episode made ready to play offline (R1.8), as a play from disk makes it: TorrentSource.fromDisk starts its
 * remux (a file Chrome cannot play as is) and its subtitle chain on the whole file, and this waits until both are done,
 * then lets the session torrent go (it joined no swarm). fromDisk finds the episode once the torrents' tick settled it
 * ready; until then it is looked for again, FINISH_READY_TRIES times. Nothing found: a later play makes it ready itself.
 * Never throws.
 */
export function finishFromDisk(
  source: () => Pick<TorrentSource, 'fromDisk' | 'keptState' | 'release'> | null,
  facts: (ref: StreamRef) => Promise<Pick<DownloadFacts, 'audioLang'>>,
  options: { sleep?: (ms: number) => Promise<void>; pollMs?: number; log?: (line: string) => void } = {},
): (ref: TvRef) => Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const pollMs = options.pollMs ?? PACK_POLL_MS;
  const log = options.log ?? ((line: string) => console.log(line));
  return async (ref) => {
    try {
      const s = source();
      if (s === null) return;
      const audioLang = (await facts(ref)).audioLang ?? null;
      let out: Awaited<ReturnType<TorrentSource['fromDisk']>> = null;
      for (let i = 0; i < FINISH_READY_TRIES && out === null; i += 1) {
        out = await s.fromDisk(ref, { audioLang });
        if (out === null) await sleep(pollMs);
      }
      if (out === null) {
        log(`[notesd] downloads: ${refLabel(ref)} is whole, but not yet readable from disk; a play makes it ready`);
        return;
      }
      try {
        for (let i = 0; i < FINISH_MAX_POLLS; i += 1) {
          const now = await s.keptState(out.torrent);
          if (now.remux !== 'running' && now.subtitles === 'done') return;
          await sleep(pollMs);
        }
      } finally {
        s.release(out.torrent);
      }
    } catch (err) {
      log(`[notesd] downloads: ${refLabel(ref)}: could not make it ready to play offline: ${messageOf(err)}`);
    }
  };
}

export class SeasonDownloads<R> {
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly newBatch: () => string;
  /** The batches whose pack was looked for in this daemon run: the rows left over download on their own. */
  private readonly looked = new Set<string>();

  constructor(private readonly deps: SeasonDownloadsDeps<R>) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? ((line: string) => console.log(line));
    this.sleep = deps.sleep ?? defaultSleep;
    this.newBatch = deps.newBatch ?? (() => randomUUID());
  }

  /**
   * The season row's Download: every aired episode of the season not whole on this machine gets its row, in episode
   * order, under one new batch; answered at once (nothing is fetched here). `unknown_season` when the stored title
   * lists no episode of the season.
   */
  async request(tmdbId: number, season: number, options: { via: DownloadVia }): Promise<SeasonAnswer<R>> {
    const list = await this.deps.episodes(tmdbId, season);
    if (list === null || list.length === 0) {
      return { ok: false, error: 'unknown_season', detail: `TMDB tv ${tmdbId} lists no episode of season ${season}.` };
    }
    const { aired, leftOut } = airedEpisodes(list, this.now().toISOString().slice(0, 10));
    const wanted: number[] = [];
    for (const episode of aired) {
      if (await this.deps.whole(tvRef(tmdbId, season, episode))) leftOut.push({ episode, why: 'whole' });
      else wanted.push(episode);
    }
    leftOut.sort((a, b) => a.episode - b.episode);
    const left = leftOut.length === 0 ? '' : `; left out ${leftOut.map((l) => `E${pad(l.episode)} (${l.why.replace(/_/g, ' ')})`).join(', ')}`;
    if (wanted.length === 0) {
      this.log(`[notesd] downloads: season ${season} of TMDB tv ${tmdbId}: nothing to download${left}`);
      return { ok: true, batch: null, queued: [], left_out: leftOut };
    }
    const batch = this.newBatch();
    const queued: R[] = [];
    for (const episode of wanted) queued.push(await this.deps.request(tvRef(tmdbId, season, episode), { via: options.via, batch }));
    this.log(`[notesd] downloads: season ${season} of TMDB tv ${tmdbId}: ${wanted.length} episode(s) queued (${options.via})${left}`);
    return { ok: true, batch, queued, left_out: leftOut };
  }

  /**
   * The queue reached `row` (phase 2's `run`, before its own steps). For the first row of a batch asked `auto` or
   * `torrent` the queue reaches, off the office network, the batch's season pack is looked for: with one, the job that
   * downloads every row it holds (the queue keeps it as its one torrent job, lets it go while a torrent plays, and
   * cancels one of its rows through it). A batch is looked at once per daemon run, except when two or more of its rows
   * still name one torrent as their source (a pack that carried them before a pause or a restart): that pack is opened
   * again by its info hash, with no index asked. Null: the row downloads on its own (a film, a cloud download, a torrent
   * picked by hand, no pack, a batch already looked at).
   */
  async take(row: SeasonRow): Promise<SeasonPackJob | null> {
    const { packs, swarm } = this.deps;
    if (row.batch === null || row.via === 'cloud' || row.infoHash !== null || packs === null || swarm === null) return null;
    if (await this.deps.office()) return null;
    const open: SeasonRow[] = [];
    for (const r of await this.deps.rows.open(row.batch)) {
      if (r.via !== row.via || r.infoHash !== null || r.ref.tmdbId !== row.ref.tmdbId || r.ref.season !== row.ref.season) continue;
      // Whole meanwhile (played to the end, fetched ahead): the per-episode path finds it on disk and ends the row.
      if (await this.deps.whole(r.ref)) continue;
      open.push(r);
    }
    if (open.length === 0) return null;
    // A torrent two or more of the batch's rows still name: the pack that carried them before a pause or a restart.
    const named = new Map<string, number>();
    for (const r of open) if (r.sourceId !== null) named.set(r.sourceId, (named.get(r.sourceId) ?? 0) + 1);
    const shared = [...named].find(([, n]) => n >= 2)?.[0] ?? null;
    if (this.looked.has(row.batch) && shared === null) return null;
    this.looked.add(row.batch);
    const label = `season ${row.ref.season} of TMDB tv ${row.ref.tmdbId}`;
    const known = shared ?? open.find((r) => r.sourceId !== null)?.sourceId ?? null;
    const fetched = await packs.fetch(row.ref.tmdbId, row.ref.season, open.map((r) => r.ref.episode), { heights: row.via === 'auto' ? 'preferred' : 'any', known });
    if (!fetched.ok) {
      this.log(`[notesd] downloads: ${label}: no season pack; ${open.length} episode(s) download one by one`);
      return null;
    }
    const pack = fetched.pack;
    const carried = pack.episodes.flatMap((e) => {
      const r = open.find((x) => x.ref.episode === e.episode);
      return r === undefined ? [] : [{ row: r, video: e.video }];
    });
    try {
      await swarm.keep(pack.infoHash);
      for (const c of carried) await this.deps.rows.running(c.row.id, pack.infoHash);
    } catch (err) {
      // fetchPack took one hold per episode it holds: every one is given back.
      for (let i = 0; i < pack.episodes.length; i += 1) await swarm.release(pack.infoHash).catch(() => undefined);
      this.log(`[notesd] downloads: ${label}: the season pack ${pack.name} could not be recorded (${messageOf(err)}); each episode downloads on its own`);
      return null;
    }
    this.log(`[notesd] downloads: ${label}: ${carried.length} episode(s) from the season pack ${pack.name}${pack.lacking.length === 0 ? '' : `; ${pack.lacking.map((e) => `E${pad(e)}`).join(', ')} on their own`}`);
    return new SeasonPackJob({
      pack,
      carried,
      rows: this.deps.rows,
      swarm,
      ...(this.deps.finish === undefined ? {} : { finish: this.deps.finish }),
      now: () => this.now().getTime(),
      sleep: this.sleep,
      pollMs: PACK_POLL_MS,
      stallMs: PACK_STALL_MS,
      log: this.log,
    });
  }
}

interface Carried {
  row: SeasonRow;
  video: number;
}

export interface SeasonPackJobParts {
  pack: PackHold;
  carried: Carried[];
  rows: SeasonRows;
  swarm: PackSwarm;
  finish?: (ref: TvRef) => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
  stallMs: number;
  log: (line: string) => void;
}

/**
 * One season pack downloading several rows at once: the queue's one torrent job while it runs. Each episode is done
 * on its own when its file is whole (its hold given back, then the offline step); a cancelled one stops alone; a swarm
 * that sends nothing for `stallMs` fails what is left. A torrent on screen (`pause`) or the daemon stopping (`close`)
 * lets go of every hold at once. `done` settles when no row is left or it was let go; it never rejects.
 */
export class SeasonPackJob {
  readonly infoHash: string;
  readonly rowIds: readonly string[];
  readonly done: Promise<void>;
  private readonly finished = new Set<string>();
  private readonly dropped = new Set<string>();
  private stopped = false;
  private lastGrowthAt: number;
  private lastReceived: number | null;

  constructor(private readonly p: SeasonPackJobParts) {
    this.infoHash = p.pack.infoHash;
    this.rowIds = p.carried.map((c) => c.row.id);
    this.lastGrowthAt = p.now();
    this.lastReceived = p.swarm.received(this.infoHash);
    this.done = this.run();
  }

  /**
   * A torrent plays on screen (phase 2's play first): the pack lets go of its swarm and every row it still carries waits
   * `paused`, the pack still its source. When the play ends the queue reaches them again and `take` opens the same pack
   * by its info hash.
   */
  async pause(): Promise<void> {
    const left = this.letGo();
    for (const c of left) await this.p.rows.paused(c.row.id);
  }

  /** The daemon stops: every hold is let go; the rows stay running, and the next start carries them on from disk. */
  async close(): Promise<void> {
    this.letGo();
  }

  /** Stops one row of the pack (its own files, its hold); the row's state is the canceller's to write. False when the job does not carry it. */
  async cancel(rowId: string): Promise<boolean> {
    const c = this.pending().find((x) => x.row.id === rowId);
    if (c === undefined) return false;
    await this.drop(c);
    return true;
  }

  /** A carried row's bytes on disk and its file's length, for the downloads list; null when the job does not carry it. */
  async progress(rowId: string): Promise<{ done: number; total: number } | null> {
    const c = this.p.carried.find((x) => x.row.id === rowId);
    return c === undefined ? null : this.p.swarm.bytes(this.infoHash, c.video);
  }

  private pending(): Carried[] {
    return this.p.carried.filter((c) => !this.finished.has(c.row.id) && !this.dropped.has(c.row.id));
  }

  /** Every hold still taken is given back (with none left the torrent leaves the swarm); answers the rows it carried. */
  private letGo(): Carried[] {
    if (this.stopped) return [];
    this.stopped = true;
    const left = this.pending();
    for (const c of left) {
      this.dropped.add(c.row.id);
      void this.p.swarm.release(this.infoHash).catch(() => undefined);
    }
    return left;
  }

  private async run(): Promise<void> {
    try {
      for (;;) {
        if (this.stopped) return;
        await this.look();
        if (this.stopped || this.pending().length === 0) return;
        await this.p.sleep(this.p.pollMs);
      }
    } catch (err) {
      await this.failRest(`the season pack ${this.p.pack.name} stopped: ${messageOf(err)}`);
    }
  }

  private async look(): Promise<void> {
    for (const c of this.pending()) {
      if (this.stopped) return;
      if (!(await this.p.rows.wanted(c.row.id))) {
        await this.drop(c);
        continue;
      }
      if (!(await this.p.swarm.whole(this.infoHash, c.video))) continue;
      this.finished.add(c.row.id);
      await this.p.rows.done(c.row.id, this.infoHash, await this.p.swarm.bytes(this.infoHash, c.video));
      this.p.log(`[notesd] downloads: ${refLabel(c.row.ref)} is on disk from the season pack ${this.p.pack.name}`);
      await this.p.swarm.release(this.infoHash);
      // The offline step (finishFromDisk) never throws: it logs what it could not do.
      if (this.p.finish !== undefined) await this.p.finish(c.row.ref);
    }
    if (this.pending().length === 0 || this.stopped) {
      this.lastGrowthAt = this.p.now();
      return;
    }
    const received = this.p.swarm.received(this.infoHash);
    if (received === null) return;
    if (received !== this.lastReceived) {
      this.lastReceived = received;
      this.lastGrowthAt = this.p.now();
      return;
    }
    if (this.p.now() - this.lastGrowthAt >= this.p.stallMs) {
      await this.failRest(`the swarm of ${this.p.pack.name} sent nothing for ${Math.round(this.p.stallMs / 3_600_000)} h`);
    }
  }

  private async drop(c: Carried): Promise<void> {
    this.dropped.add(c.row.id);
    await this.p.swarm.releaseSlot(this.infoHash, c.row.ref);
  }

  private async failRest(detail: string): Promise<void> {
    for (const c of this.pending()) {
      this.dropped.add(c.row.id);
      try {
        await this.p.rows.failed(c.row.id, 'download_failed', detail);
        await this.p.swarm.release(this.infoHash);
      } catch (err) {
        this.p.log(`[notesd] downloads: ${refLabel(c.row.ref)}: ${messageOf(err)}`);
      }
    }
    this.p.log(`[notesd] downloads: season pack ${this.p.pack.name}: ${detail}`);
  }
}
```
**Impact:** new module. It names phase 1's repo methods (through phase 2's `DownloadRecords`) and `StreamDownloadRow`
fields in `seasonRowOf` / `seasonRowsOf` only, and phase 2's `DownloadVia`, `DownloadFacts` and `TorrentStreams.keep`.
The offline step for a pack episode is `finishFromDisk` over the existing `TorrentSource.fromDisk` and phase 2's
`keptState`/`release`: no step is lifted out of `fetchKept` (phase 2's `fetchKept` has none to lift; a play's own
`finish` runs inside `tryCandidates`, which a pack does not go through). The pack's play-first is phase 2's model, so
`TorrentStreams` gains no pause or resume of its own.

### Step 6: `StreamDownloads.requestSeason` and the queue's pack hook (this phase's edits to phase 2's file)
**File:** `src/directStream/downloads/service.ts`, as phase 2's plan writes it (Step 7 there). Every anchor below is
quoted from that code.
**Change:** a season pack is the queue's one torrent job while it runs, held in a new `pack` field beside phase 2's
`job` (never both set, so "one torrent download at a time" still holds). The hook sits at the top of `run`, which runs
behind the tick (the pack search asks the indexes and opens a swarm, minutes at worst, so it must not block `tick`).
Play first, cancel, close and the list's progress each gain the pack's branch. The season's rows are created without a
tick between them (`enqueue`), so the queue never reaches E01 before E02 and E03 exist.

**6a. Imports.** Phase 2's file already imports `isOffice` (from `./plan.js`), `StreamRef`, `normalizeInfoHash` and `refLabel`. Add:
```ts
import type { MovieStreams } from '../../movies/streams.js';
import { finishFromDisk, packSwarmOf, SeasonDownloads, SeasonPackJob, seasonRowOf, seasonRowsOf, type PackSwarm, type SeasonAnswer, type SeasonEpisode, type SeasonPacks, type TvRef } from './season.js';
```
and add `type DownloadVia` to the import from `./types.js`.

**6b. `StreamDownloadsOptions`**, after phase 2's `every?` member:
```ts
  /** A season's episodes with their air days (MovieStreams.seasonEpisodes); null or unset: requestSeason answers seasons_off. */
  seasonEpisodes?: ((tmdbId: number, season: number) => Promise<SeasonEpisode[] | null>) | null;
  /** TorrentSource.fetchPack with the title's facts filled in; null or unset: every episode of a season downloads on its own. */
  packs?: SeasonPacks | null;
  /** TorrentStreams as a season pack uses it (packSwarmOf); null or unset: as `packs` null. */
  packSwarm?: PackSwarm | null;
  /** A pack episode made ready to play offline once whole (finishFromDisk); null or unset: nothing more is done. */
  finishEpisode?: ((ref: TvRef) => Promise<void>) | null;
```

**6c. Fields**, after phase 2's `private closed = false;`:
```ts
  /** Season downloads; null without an episode list (the movies store off). */
  private readonly season: SeasonDownloads<DownloadRequestAnswer> | null;
  /** The season pack the queue downloads now: its one torrent job while set (`job` is null then). */
  private pack: SeasonPackJob | null = null;
```
and at the end of the constructor, after `this.every = opts.every ?? defaultEvery;`:
```ts
    const episodes = opts.seasonEpisodes ?? null;
    this.season =
      episodes === null
        ? null
        : new SeasonDownloads<DownloadRequestAnswer>({
            episodes,
            whole: (ref) => this.onDisk(ref),
            request: (ref, o) => this.enqueue(ref, { via: o.via, batch: o.batch }),
            rows: seasonRowsOf(opts.repo, opts.host, this.now),
            packs: opts.packs ?? null,
            swarm: opts.packSwarm ?? null,
            office: async () => isOffice(await opts.ssid()),
            ...(opts.finishEpisode == null ? {} : { finish: opts.finishEpisode }),
            now: this.now,
            log: this.log,
          });
```

**6d. `request` and `enqueue`.** Replace phase 2's `request` (its doc comment and body) with:
```ts
  /**
   * Queues one film or episode and answers at once. A title already whole on this machine queues nothing (`onDisk`); a
   * slot already queued, running or paused is answered as it is (`created: false`). Throws DownloadError
   * `invalid_request` (a malformed info hash, or one without `via: torrent`) or `downloads_off` (the daemon stops).
   */
  async request(ref: StreamRef, ask: DownloadAsk): Promise<DownloadRequestAnswer> {
    const answer = await this.enqueue(ref, ask);
    void this.tick();
    return answer;
  }

  /**
   * The season row's Download (phase 4's POST with a season and no episode): every aired episode of the season that is
   * not whole on this machine is queued, one row each under one batch, in episode order, and the queue looks once all
   * exist; answered at once. `seasons_off` without an episode list; `unknown_season` when the title lists no episode of
   * the season. Throws DownloadError `downloads_off` while the daemon stops.
   */
  async requestSeason(tmdbId: number, season: number, options: { via: DownloadVia }): Promise<SeasonAnswer<DownloadRequestAnswer>> {
    if (this.closed) throw new DownloadError('downloads_off', 'The daemon is stopping.');
    if (this.season === null) return { ok: false, error: 'seasons_off', detail: 'No episode list is wired here (the movies store is off).' };
    const answer = await this.season.request(tmdbId, season, options);
    void this.tick();
    return answer;
  }

  /** `request` without the look after it (a season queues all its rows first). */
  private async enqueue(ref: StreamRef, ask: DownloadAsk): Promise<DownloadRequestAnswer> {
    if (this.closed) throw new DownloadError('downloads_off', 'The daemon is stopping.');
    const infoHash = ask.infoHash == null ? null : normalizeInfoHash(ask.infoHash);
    if (ask.infoHash != null && infoHash === null) throw new DownloadError('invalid_request', 'An info hash is 40 hexadecimal characters.');
    if (infoHash !== null && ask.via !== 'torrent') throw new DownloadError('invalid_request', 'A torrent picked by its info hash is downloaded with via "torrent".');
    if (await this.onDisk(ref)) return { download: null, created: false, onDisk: true };
    const { row, created } = await this.opts.repo.create(this.host, { ref, via: ask.via, infoHash, batch: ask.batch ?? null }, this.now());
    if (created) this.log(`[notesd] downloads: queued ${refLabel(ref)} (${ask.via}${infoHash === null ? '' : ` ${infoHash.slice(0, 8)}`})`);
    return { download: await this.viewOf(row), created, onDisk: false };
  }
```

**6e. `cancel`.** After phase 2's line `if (this.clouds.delete(id)) await this.opts.caches?.pause(ref).catch(() => false);` insert:
```ts
    if (this.pack !== null && this.pack.rowIds.includes(id)) await this.pack.cancel(id);
```
(phase 2's `unkeep(row.sourceId, id)` after it keeps the pack's mark while another of its rows names it).

**6f. `close`.** Before phase 2's `this.clouds.clear();` insert:
```ts
    const pack = this.pack;
    this.pack = null;
    await pack?.close();
```

**6g. `playFirst`.** Insert at the top of phase 2's `playFirst`, before `const job = this.job;`:
```ts
    const pack = this.pack;
    if (pack !== null && this.opts.playingTorrents().some((hash) => hash !== pack.infoHash)) {
      this.pack = null;
      await pack.pause();
      this.log(`[notesd] downloads: paused the season pack ${pack.infoHash.slice(0, 8)}: a torrent plays on screen; it carries on when the play ends`);
      return;
    }
```

**6h. `startNext`.** In phase 2's `startNext`, replace both guards `if (this.job !== null || this.closed) return;` and
`if (this.job !== null || this.closed) return;` (the first line of the method and the first line of the loop) with
`if (this.job !== null || this.pack !== null || this.closed) return;`, and replace the call
`const run = this.run(job, plan.steps, before, resumeHash !== null);` with
`const run = this.run(job, row, plan.steps, before, resumeHash !== null);`. A row of a pack paused for a play has the
pack as its source, so phase 2's `planOf` gives it a `hash` step and phase 2's "a torrent download does not start while
a torrent plays" holds for it unchanged.

**6i. `run`.** Replace phase 2's signature line
`private async run(job: Job, steps: readonly DownloadStep[], before: readonly StepFailure[], resume: boolean): Promise<void> {`
with
`private async run(job: Job, row: StreamDownloadRow, steps: readonly DownloadStep[], before: readonly StepFailure[], resume: boolean): Promise<void> {`
and insert directly after phase 2's `await this.opts.repo.setState(this.host, job.id, 'running', this.now());`:
```ts
      // The first row of a season the queue reaches: the season's pack, when one fits, carries every row it holds.
      const seasonRow = this.season === null ? null : seasonRowOf(row);
      if (this.season !== null && seasonRow !== null && seasonRow.batch !== null) {
        const pack = await this.season.take(seasonRow);
        if (pack !== null) {
          if (job.stopped || this.job !== job || this.closed) {
            // Cancelled or stopped while the pack was looked for: its rows wait, paused, for the next look.
            await pack.pause();
            return;
          }
          this.job = null;
          this.pack = pack;
          void pack.done.finally(() => {
            if (this.pack === pack) this.pack = null;
            void this.tick();
          });
          // A row the pack lacks waits its turn and downloads on its own once the pack is done.
          if (!pack.rowIds.includes(job.id)) await this.opts.repo.setState(this.host, job.id, 'queued', this.now());
          return;
        }
      }
```
Phase 2's `finally` (`if (this.job === job && job.handle === null) this.job = null; if (this.job === null) void this.tick();`)
is unchanged: the tick it starts finds `pack` set and starts nothing.

**6j. `viewOf`.** After phase 2's block that reads a held torrent's progress (`if (job !== null && job.id === row.id && …) { … }`), insert:
```ts
    const pack = this.pack;
    if (pack !== null && pack.rowIds.includes(row.id)) {
      const p = await pack.progress(row.id).catch(() => null);
      if (p !== null) {
        bytesDone = p.done;
        bytesTotal = p.total;
      }
    }
```

**Impact:** a request with no batch, and every film, runs exactly as phase 2 built it (`request` answers the same; the
hook only fires for a batch). `startNext` waits while a pack runs, as it waits for phase 2's `job`.

### Step 7: wiring in `buildStreamDownloads` and the daemon
**File:** `src/directStream/downloads/service.ts` (phase 2's `buildStreamDownloads`) and `src/daemon.ts` (phase 2's
`deps.streamDownloads = buildStreamDownloads(config, {...})` call, after `deps.streamPreviews = …`).
**Change:** the four options are built where phase 2 builds the engine. Off with the movies store off
(`movieStreams` null or absent: `requestSeason` answers `seasons_off`) or torrents off (every row of a season
downloads on its own, from the cloud when asked).
**Code:** in `buildStreamDownloads`' `wiring` type, after `afterDone?: () => void;`, add:
```ts
    /** The movies store's MovieStreams (seasonEpisodes); null or absent: no season download. */
    movieStreams?: Pick<MovieStreams, 'seasonEpisodes'> | null;
```
Replace phase 2's `return new StreamDownloads({ … });` at the end of `buildStreamDownloads` with:
```ts
  const torrents = wiring.torrents;
  const facts = (ref: StreamRef): Promise<DownloadFacts> => ds.downloadFacts(ref);
  const movieStreams = wiring.movieStreams ?? null;
  const finish = torrents === null ? null : finishFromDisk(wiring.torrentSource, facts, wiring.log === undefined ? {} : { log: wiring.log });
  return new StreamDownloads({
    host: ds.host,
    repo: new DownloadsRepo(wiring.db),
    torrents: torrents === null ? null : torrentDownloadsOf(wiring.torrentSource, torrents, facts),
    caches: wiring.streamCache === null ? null : cacheDownloadsOf(wiring.streamCache),
    ssid: config.directStream?.downloadSsid != null ? fixedSsid(config.directStream.downloadSsid) : ssidFrom(wiring.warp),
    playingTorrents: () => ds.torrentsOnScreen(),
    ...(wiring.afterDone === undefined ? {} : { afterDone: wiring.afterDone }),
    ...(wiring.log === undefined ? {} : { log: wiring.log }),
    seasonEpisodes: movieStreams === null ? null : (tmdbId, season) => movieStreams.seasonEpisodes(tmdbId, season),
    packs:
      torrents === null
        ? null
        : {
            fetch: async (tmdbId, season, episodes, o) => {
              const source = wiring.torrentSource();
              const [first] = episodes;
              if (source === null || first === undefined) return { ok: false, error: 'no_pack', attempts: [] };
              const f = await facts({ kind: 'tv', tmdbId, season, episode: first });
              return source.fetchPack(tmdbId, season, episodes, { audioLang: f.audioLang ?? null, imdbId: f.imdbId ?? null, names: f.names ?? null, ...o });
            },
          },
    packSwarm: torrents === null ? null : packSwarmOf(torrents),
    finishEpisode:
      finish === null
        ? null
        : async (ref) => {
            await finish(ref);
            // The seek previews' sweep queues the episode's sheets, as for a single download (phase 2's afterDone).
            wiring.afterDone?.();
          },
  });
```
Add `type DownloadFacts` to the import from `./types.js` (if phase 2's file does not import it already).

In `src/daemon.ts`, add one member to phase 2's call, after `afterDone: () => void deps.streamPreviews?.sweep(),`:
```ts
    movieStreams,
```
(`movieStreams` is the daemon's `const movieStreams = movies === null ? null : new MovieStreams(movies);`, line 220.)
**Impact:** none at start: nothing runs until a season is asked for.

### Step 8: tests for `useSlot` and `releaseSlot`
**File:** `tests/unit/directStream/torrent/useSlot.test.ts` (new)
**Code:**
```ts
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TorrentStreams } from '../../../../src/directStream/torrent/service.js';
import { TorrentFolder } from '../../../../src/directStream/torrent/store.js';
import { TorrentError, type TorrentPick } from '../../../../src/directStream/torrent/types.js';
import type { StreamRef } from '../../../../src/directStream/types.js';
import { FakeTorrentEngine } from '../../../helpers/fakeTorrentEngine.js';
import { MemoryTorrentRecords } from '../../../helpers/memoryTorrentRecords.js';

const PACK = 'facade'.padEnd(40, '1');
const SHOW = 'Fixture.Show.S01.1080p';
const data = (seed: number): Buffer => Buffer.from(Array.from({ length: 4096 }, (_, i) => (i + seed) % 251));
const FILES = [
  { path: `${SHOW}/Fixture.Show.S01E01.mp4`, data: data(1) },
  { path: `${SHOW}/Fixture.Show.S01E02.mp4`, data: data(2) },
  { path: `${SHOW}/Fixture.Show.S01E03.mp4`, data: data(3) },
  { path: `${SHOW}/setup.exe`, data: data(4) },
];
const ep = (episode: number): StreamRef => ({ kind: 'tv', tmdbId: 1399, season: 1, episode });
const pick = (episode: number): TorrentPick => ({ infoHash: PACK, trackers: [], name: SHOW, ref: ep(episode) });
const OPEN = { timeoutMs: 1_000 };

let root: string;

function build() {
  const records = new MemoryTorrentRecords();
  const engine = new FakeTorrentEngine([{ infoHash: PACK, name: SHOW, files: FILES }]);
  const streams = new TorrentStreams({
    engine,
    repo: records,
    folder: new TorrentFolder(root),
    host: 'host-a',
    uploadKbps: 100,
    keepDays: 7,
    discovery: true,
    now: () => new Date('2026-11-20T12:00:00Z'),
    log: () => undefined,
    every: () => () => undefined,
  });
  return { streams, engine, records };
}

const rowsOf = async (records: MemoryTorrentRecords): Promise<[number, number | null][]> =>
  (await records.slots('host-a', PACK)).map((r): [number, number | null] => [r.episode, r.fileIndex]).sort((a, b) => a[0] - b[0]);

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'torrent-slot-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('TorrentStreams.useSlot', () => {
  it('takes each episode of a pack in the swarm under its own row, one hold each, with one open', async () => {
    const { streams, engine, records } = build();
    await streams.open(pick(1), OPEN);
    await streams.useSlot(pick(1), [0]);
    await streams.useSlot(pick(2), [1]);
    await streams.useSlot(pick(3), [2]);
    expect(engine.added).toEqual([PACK]);
    expect(await rowsOf(records)).toEqual([[1, 0], [2, 1], [3, 2]]);
    expect(streams.status().swarm.find((s) => s.info_hash === PACK)?.users).toBe(3);
  });

  it('gives a double episode (one file, two episodes) a row per episode, where `use` would put both on the first', async () => {
    const { streams, records } = build();
    await streams.open(pick(1), OPEN);
    await streams.useSlot(pick(1), [0]);
    await streams.useSlot(pick(2), [0]);
    expect(await rowsOf(records)).toEqual([[1, 0], [2, 0]]);
  });

  it('refuses a file that is neither a video nor a subtitle, and a torrent not opened', async () => {
    const { streams } = build();
    await expect(streams.useSlot(pick(1), [0])).rejects.toMatchObject({ code: 'not_open' });
    await streams.open(pick(1), OPEN);
    await expect(streams.useSlot(pick(1), [3])).rejects.toBeInstanceOf(TorrentError);
    await expect(streams.useSlot(pick(1), [3])).rejects.toMatchObject({ code: 'not_media' });
  });
});

describe('TorrentStreams.releaseSlot', () => {
  it("stops one episode's own files and gives back its hold; the other episodes go on", async () => {
    const { streams, engine, records } = build();
    await streams.open(pick(1), OPEN);
    for (const e of [1, 2, 3]) await streams.useSlot(pick(e), [e - 1]);
    await streams.releaseSlot(PACK, ep(2));
    expect(engine.deselected).toEqual([{ infoHash: PACK, indexes: [1] }]);
    expect(streams.status().swarm.find((s) => s.info_hash === PACK)?.users).toBe(2);
    expect(await rowsOf(records)).toEqual([[1, 0], [2, 1], [3, 2]]);
    expect(engine.removed).toEqual([]);
  });
});
```

### Step 9: tests for the season packs and `fetchPack`
**File:** `tests/unit/directStream/torrent/seasonPack.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { parseRelease, type SwarmCount, type TorrentCandidate } from '../../../../src/directStream/torrent/find/index.js';
import type { MediaProbe } from '../../../../src/directStream/torrent/probe.js';
import { seasonPacks } from '../../../../src/directStream/torrent/seasonPack.js';
import { TorrentSource, type FindAnswer, type PackOptions, type TorrentSwarm } from '../../../../src/directStream/torrent/source.js';
import type { TorrentFileInfo } from '../../../../src/directStream/torrent/types.js';

const h = (n: number): string => n.toString(16).padStart(40, '0');
const PACK_1080 = h(1);
const PACK_720 = h(2);
const MULTI = h(3);
const SINGLE = h(4);
const OTHER_SEASON = h(5);
const pad = (n: number): string => String(n).padStart(2, '0');

const candidate = (infoHash: string, name: string, seeds: number): TorrentCandidate => ({
  infoHash,
  name,
  fileName: null,
  fileIdx: null,
  seeds,
  sizeBytes: 9_000_000_000,
  index: 'torrentio',
  listedBy: ['torrentio'],
  site: null,
  trackers: ['http://127.0.0.1:1/announce'],
  scoped: false,
  release: parseRelease(name),
});

const CANDIDATES = [
  candidate(PACK_720, 'Fixture.Show.S01.720p.WEB.x264', 90),
  candidate(PACK_1080, 'Fixture.Show.S01.1080p.WEB.x264', 40),
  candidate(MULTI, 'Fixture.Show.S01-S03.1080p.WEB.x264', 200),
  candidate(SINGLE, 'Fixture.Show.S01E01.1080p.WEB.x264', 300),
  candidate(OTHER_SEASON, 'Fixture.Show.S02.1080p.WEB.x264', 300),
];

const file = (index: number, filePath: string): TorrentFileInfo => ({ index, path: filePath, name: filePath.split('/').pop() ?? filePath, length: 500_000_000 });
const seasonFiles = (episodes: number[], season = 1): TorrentFileInfo[] => episodes.map((e, i) => file(i, `Fixture.Show/Fixture.Show.S${pad(season)}E${pad(e)}.1080p.mp4`));

const MP4_EN: MediaProbe = { container: 'mov,mp4,m4a,3gp,3g2,mj2', video: { codec: 'h264', height: 1080 }, audio: [{ codec: 'aac', lang: 'eng' }], subtitles: [], durationS: 2_700, direct: true };
const MP4_DE: MediaProbe = { ...MP4_EN, audio: [{ codec: 'aac', lang: 'ger' }] };

const ids = (list: TorrentCandidate[]): string[] => list.map((c) => c.infoHash);

describe('seasonPacks', () => {
  it('keeps the packs that hold the season, the preferred height first, one season before a range, a dead swarm out', () => {
    expect(ids(seasonPacks(CANDIDATES, 1, new Map(), null))).toEqual([PACK_1080, MULTI, PACK_720]);
    expect(ids(seasonPacks(CANDIDATES, 1, new Map(), 1080))).toEqual([PACK_1080, MULTI]);
    const dead = new Map<string, SwarmCount>([[PACK_1080, { seeders: 0, leechers: 3, trackers: 3 }]]);
    expect(ids(seasonPacks(CANDIDATES, 1, dead, 1080))).toEqual([MULTI]);
    expect(ids(seasonPacks(CANDIDATES, 2, new Map(), null))).toEqual([OTHER_SEASON, MULTI]);
  });
});

function setup(o: { files?: Record<string, TorrentFileInfo[]>; probes?: Record<string, MediaProbe>; candidates?: TorrentCandidate[] } = {}) {
  const calls: string[] = [];
  let finds = 0;
  const swarm: TorrentSwarm = {
    open: async (pick) => {
      calls.push(`open ${pick.infoHash}`);
      return { infoHash: pick.infoHash, files: o.files?.[pick.infoHash] ?? seasonFiles([1, 2, 3]) };
    },
    use: (infoHash, indexes) => {
      calls.push(`use ${infoHash} ${indexes.join(',')}`);
    },
    useSlot: (pick, indexes) => {
      calls.push(`useSlot ${pick.infoHash} E${pick.ref.kind === 'tv' ? pick.ref.episode : 0} ${indexes.join(',')}`);
    },
    release: (infoHash) => {
      calls.push(`release ${infoHash}`);
    },
    drop: (infoHash) => {
      calls.push(`drop ${infoHash}`);
    },
    discard: (infoHash) => {
      calls.push(`discard ${infoHash}`);
    },
    find: async () => null,
    filePath: () => null,
    localUrl: (infoHash, index) => `/api/stream/torrent/${infoHash}/f/${index}`,
    setDuration: () => undefined,
  };
  const source = new TorrentSource({
    swarm,
    find: async () => {
      finds += 1;
      const answer: FindAnswer = { candidates: o.candidates ?? CANDIDATES, indexes: [], excluded: [], lastResort: [] };
      return answer;
    },
    probe: async (url) => {
      const m = /\/torrent\/([0-9a-f]+)\/f\/(\d+)/.exec(url);
      calls.push(`probe ${m?.[1]} ${m?.[2]}`);
      return o.probes?.[m?.[1] ?? ''] ?? MP4_EN;
    },
    tiers: [],
    localBase: () => 'http://127.0.0.1:4321',
    log: () => undefined,
  });
  return { source, calls, finds: () => finds };
}

const OPTIONS: PackOptions = { audioLang: 'en', imdbId: null, names: null, heights: 'preferred' };
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('TorrentSource.fetchPack', () => {
  it("opens one pack once, checks the first episode's audio before any other is taken, and takes a hold per episode", async () => {
    const { source, calls } = setup();
    const out = await source.fetchPack(1399, 1, [3, 1, 2], OPTIONS);
    expect(out.ok && out.pack).toMatchObject({ infoHash: PACK_1080, episodes: [{ episode: 1, video: 0 }, { episode: 2, video: 1 }, { episode: 3, video: 2 }], lacking: [] });
    expect(calls).toEqual([`open ${PACK_1080}`, `useSlot ${PACK_1080} E1 0`, `probe ${PACK_1080} 0`, `useSlot ${PACK_1080} E2 1`, `useSlot ${PACK_1080} E3 2`]);
  });

  it('lets go of a pack whose first episode is a dub before the rest is taken, and tries the next', async () => {
    const { source, calls } = setup({ probes: { [PACK_1080]: MP4_DE } });
    const out = await source.fetchPack(1399, 1, [1, 2, 3], OPTIONS);
    await settle();
    expect(out.ok && out.pack.infoHash).toBe(MULTI);
    expect(calls.filter((c) => c.startsWith(`useSlot ${PACK_1080}`))).toEqual([`useSlot ${PACK_1080} E1 0`]);
    expect(calls).toContain(`drop ${PACK_1080}`);
    expect(out.ok && out.pack.attempts.find((a) => a.provider.includes('S01.1080p'))?.outcome).toBe('dubbed');
  });

  it('asks only for a 1080p pack with no source named; any height when a torrent is asked for', async () => {
    const only720 = [candidate(PACK_720, 'Fixture.Show.S01.720p.WEB.x264', 90)];
    const preferred = setup({ candidates: only720 });
    expect(await preferred.source.fetchPack(1399, 1, [1, 2, 3], OPTIONS)).toMatchObject({ ok: false, error: 'no_pack' });
    expect(preferred.calls).toEqual([]);
    const any = setup({ candidates: only720 });
    const out = await any.source.fetchPack(1399, 1, [1, 2, 3], { ...OPTIONS, heights: 'any' });
    expect(out.ok && out.pack.infoHash).toBe(PACK_720);
  });

  it('says which wanted episodes the pack lacks, and lets go of a pack holding none of them', async () => {
    const lacking = setup({ files: { [PACK_1080]: [file(0, 'Fixture.Show/Fixture.Show.S01E01.mp4'), file(1, 'Fixture.Show/Fixture.Show.S01E03.mp4')] } });
    const out = await lacking.source.fetchPack(1399, 1, [1, 2, 3], OPTIONS);
    expect(out.ok && out.pack).toMatchObject({ infoHash: PACK_1080, episodes: [{ episode: 1, video: 0 }, { episode: 3, video: 1 }], lacking: [2] });
    const none = setup({ files: { [PACK_1080]: seasonFiles([1, 2, 3], 2) } });
    const next = await none.source.fetchPack(1399, 1, [1, 2, 3], OPTIONS);
    await settle();
    expect(next.ok && next.pack.infoHash).toBe(MULTI);
    expect(none.calls).toContain(`discard ${PACK_1080}`);
  });

  it('tries the pack a batch was downloading from before a restart first, with no index asked', async () => {
    const { source, finds } = setup();
    const out = await source.fetchPack(1399, 1, [1, 2, 3], { ...OPTIONS, known: PACK_720 });
    expect(out.ok && out.pack.infoHash).toBe(PACK_720);
    expect(finds()).toBe(0);
  });
});
```

### Step 10: tests for the season download and the pack job
**File:** `tests/unit/directStream/downloads/season.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { finishFromDisk, PACK_STALL_MS, SeasonDownloads, type PackSwarm, type SeasonEpisode, type SeasonPacks, type SeasonRow, type SeasonRows } from '../../../../src/directStream/downloads/season.js';
import type { DownloadVia } from '../../../../src/directStream/downloads/types.js';
import type { PackFetch } from '../../../../src/directStream/torrent/source.js';
import type { StreamRef } from '../../../../src/directStream/types.js';

const TMDB = 1399;
const PACK = 'facade'.padEnd(40, '2');
const EPISODES: SeasonEpisode[] = [
  { episode: 1, airDate: '2026-10-01' },
  { episode: 2, airDate: '2026-10-08' },
  { episode: 3, airDate: '2026-10-15' },
  { episode: 4, airDate: '2026-11-27' },
  { episode: 5, airDate: null },
];

type Stored = SeasonRow & { state: 'queued' | 'running' | 'paused' | 'done' | 'failed'; error: string | null };

class MemoryRows implements SeasonRows {
  readonly stored: Stored[] = [];
  private next = 1;

  add(episode: number, via: DownloadVia, batch: string, infoHash: string | null = null): Stored {
    const row: Stored = { id: `d${this.next++}`, ref: { kind: 'tv', tmdbId: TMDB, season: 1, episode }, via, infoHash, batch, sourceId: null, state: 'queued', error: null };
    this.stored.push(row);
    return row;
  }

  get(id: string): Stored {
    const row = this.stored.find((r) => r.id === id);
    if (row === undefined) throw new Error(`no row ${id}`);
    return row;
  }

  async open(batch: string): Promise<SeasonRow[]> {
    return this.stored.filter((r) => r.batch === batch && ['queued', 'running', 'paused'].includes(r.state)).sort((a, b) => a.ref.episode - b.ref.episode);
  }
  async wanted(id: string): Promise<boolean> {
    return ['queued', 'running', 'paused'].includes(this.get(id).state);
  }
  async running(id: string, infoHash: string): Promise<void> {
    Object.assign(this.get(id), { state: 'running', sourceId: infoHash });
  }
  async paused(id: string): Promise<void> {
    this.get(id).state = 'paused';
  }
  async done(id: string, infoHash: string): Promise<void> {
    Object.assign(this.get(id), { state: 'done', sourceId: infoHash });
  }
  async failed(id: string, code: string): Promise<void> {
    Object.assign(this.get(id), { state: 'failed', error: code });
  }
}

class FakeSwarm implements PackSwarm {
  readonly calls: string[] = [];
  readonly wholeFiles = new Set<number>();
  receivedBytes: number | null = null;
  async whole(_infoHash: string, index: number): Promise<boolean> {
    return this.wholeFiles.has(index);
  }
  async bytes(_infoHash: string, index: number): Promise<{ done: number; total: number }> {
    return { done: this.wholeFiles.has(index) ? 100 : 10, total: 100 };
  }
  received(): number | null {
    return this.receivedBytes;
  }
  async release(): Promise<void> {
    this.calls.push('release');
  }
  async releaseSlot(_infoHash: string, ref: StreamRef): Promise<void> {
    this.calls.push(`releaseSlot E${ref.kind === 'tv' ? ref.episode : 0}`);
  }
  async keep(): Promise<void> {
    this.calls.push('keep');
  }
}

const NO_PACK: PackFetch = { ok: false, error: 'no_pack', attempts: [] };
const packOf = (episodes: number[], lacking: number[] = []): PackFetch => ({
  ok: true,
  pack: { infoHash: PACK, name: 'Fixture.Show.S01.1080p', episodes: episodes.map((episode, i) => ({ episode, video: i, subtitles: [] })), lacking, attempts: [] },
});

function setup(o: { episodes?: SeasonEpisode[] | null; whole?: number[]; pack?: PackFetch; office?: boolean } = {}) {
  const rows = new MemoryRows();
  const swarm = new FakeSwarm();
  const fetches: { episodes: number[]; heights: string; known: string | null }[] = [];
  const packs: SeasonPacks = {
    fetch: async (_tmdbId, _season, episodes, options) => {
      fetches.push({ episodes: [...episodes], heights: options.heights, known: options.known ?? null });
      return o.pack ?? NO_PACK;
    },
  };
  let clock = Date.parse('2026-11-20T12:00:00Z');
  const seasons = new SeasonDownloads<Stored>({
    episodes: async () => (o.episodes === undefined ? EPISODES : o.episodes),
    whole: async (ref) => (o.whole ?? []).includes(ref.episode),
    request: async (ref, { via, batch }) => rows.add(ref.episode, via, batch),
    rows,
    packs,
    swarm,
    office: async () => o.office === true,
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
      await new Promise((resolve) => setImmediate(resolve));
    },
    newBatch: () => 'batch-1',
    log: () => undefined,
  });
  return { seasons, rows, swarm, fetches };
}

async function queued(s: ReturnType<typeof setup>, via: DownloadVia = 'auto'): Promise<Stored[]> {
  const answer = await s.seasons.request(TMDB, 1, { via });
  if (!answer.ok) throw new Error(answer.detail);
  return answer.queued;
}

describe('SeasonDownloads.request', () => {
  it('queues every aired episode not whole on this machine, in episode order, under one batch', async () => {
    const s = setup({ whole: [2] });
    const answer = await s.seasons.request(TMDB, 1, { via: 'auto' });
    expect(answer).toMatchObject({
      ok: true,
      batch: 'batch-1',
      left_out: [
        { episode: 2, why: 'whole' },
        { episode: 4, why: 'not_aired' },
        { episode: 5, why: 'no_air_date' },
      ],
    });
    expect(answer.ok && answer.queued.map((r) => [r.ref.episode, r.state, r.batch])).toEqual([
      [1, 'queued', 'batch-1'],
      [3, 'queued', 'batch-1'],
    ]);
  });

  it('leaves out an episode that has not aired, and never looks for it in a pack', async () => {
    const s = setup({ pack: packOf([1, 2, 3]) });
    const [first] = await queued(s);
    expect(s.rows.stored.map((r) => r.ref.episode)).toEqual([1, 2, 3]);
    const job = await s.seasons.take(first!);
    expect(s.fetches.map((f) => f.episodes)).toEqual([[1, 2, 3]]);
    // The job's loop ends only once every carried file is whole.
    for (const index of [0, 1, 2]) s.swarm.wholeFiles.add(index);
    await job!.done;
  });

  it('answers unknown_season when the stored title lists no episode of the season, and queues nothing when all are whole', async () => {
    expect(await setup({ episodes: [] }).seasons.request(TMDB, 1, { via: 'auto' })).toMatchObject({ ok: false, error: 'unknown_season' });
    const all = setup({ whole: [1, 2, 3] });
    expect(await all.seasons.request(TMDB, 1, { via: 'auto' })).toMatchObject({ ok: true, batch: null, queued: [] });
    expect(all.rows.stored).toEqual([]);
  });
});

describe('SeasonDownloads.take', () => {
  it('downloads a season from its pack: one look, every row carried and kept, each done when its file is whole', async () => {
    const s = setup({ pack: packOf([1, 2, 3]) });
    const rows = await queued(s);
    const job = await s.seasons.take(rows[0]!);
    expect(job?.rowIds).toEqual(['d1', 'd2', 'd3']);
    expect(s.swarm.calls).toEqual(['keep']);
    expect(s.rows.stored.map((r) => [r.state, r.sourceId])).toEqual([
      ['running', PACK],
      ['running', PACK],
      ['running', PACK],
    ]);
    for (const index of [0, 1, 2]) s.swarm.wholeFiles.add(index);
    await job!.done;
    expect(s.rows.stored.map((r) => [r.state, r.sourceId])).toEqual([
      ['done', PACK],
      ['done', PACK],
      ['done', PACK],
    ]);
    expect(s.swarm.calls.filter((c) => c === 'release')).toHaveLength(3);
    expect(await s.seasons.take(rows[1]!)).toBeNull();
    expect(s.fetches).toHaveLength(1);
  });

  it('leaves an episode the pack lacks queued, to download on its own after the pack', async () => {
    const s = setup({ pack: packOf([1, 3], [2]) });
    const rows = await queued(s);
    const job = await s.seasons.take(rows[0]!);
    expect(job?.rowIds).toEqual(['d1', 'd3']);
    s.swarm.wholeFiles.add(0);
    s.swarm.wholeFiles.add(1);
    await job!.done;
    expect(s.rows.stored.map((r) => [r.ref.episode, r.state])).toEqual([
      [1, 'done'],
      [2, 'queued'],
      [3, 'done'],
    ]);
    expect(await s.seasons.take(rows[1]!)).toBeNull();
  });

  it('with no pack, every row downloads on its own, in order, and the batch is looked at once', async () => {
    const s = setup();
    const rows = await queued(s);
    expect(await s.seasons.take(rows[0]!)).toBeNull();
    expect(await s.seasons.take(rows[1]!)).toBeNull();
    expect(s.fetches).toHaveLength(1);
    expect(s.rows.stored.map((r) => r.state)).toEqual(['queued', 'queued', 'queued']);
  });

  it('looks for no pack for a cloud download, a torrent picked by hand, or on the office network', async () => {
    const cloud = setup({ pack: packOf([1, 2, 3]) });
    expect(await cloud.seasons.take((await queued(cloud, 'cloud'))[0]!)).toBeNull();
    const office = setup({ pack: packOf([1, 2, 3]), office: true });
    expect(await office.seasons.take((await queued(office))[0]!)).toBeNull();
    const picked = setup({ pack: packOf([1, 2, 3]) });
    expect(await picked.seasons.take(picked.rows.add(1, 'torrent', 'b-hand', PACK))).toBeNull();
    expect([...cloud.fetches, ...office.fetches, ...picked.fetches]).toEqual([]);
  });

  it('asks for a 1080p pack with no source named, any height for a torrent, and the pack it had before a restart', async () => {
    const auto = setup();
    await auto.seasons.take((await queued(auto, 'auto'))[0]!);
    const torrent = setup();
    const rows = await queued(torrent, 'torrent');
    torrent.rows.get('d2').sourceId = PACK;
    await torrent.seasons.take(rows[0]!);
    expect([auto.fetches[0], torrent.fetches[0]]).toEqual([
      { episodes: [1, 2, 3], heights: 'preferred', known: null },
      { episodes: [1, 2, 3], heights: 'any', known: PACK },
    ]);
  });
});

describe('SeasonPackJob', () => {
  it('lets go of the pack while a torrent plays (its rows wait, paused, the pack their source) and opens the same pack by its hash after; a cancel stops that episode alone', async () => {
    const s = setup({ pack: packOf([1, 2, 3]) });
    const rows = await queued(s);
    const job = (await s.seasons.take(rows[0]!))!;
    expect(await job.cancel('d2')).toBe(true);
    s.rows.get('d2').state = 'failed';
    await job.pause();
    await job.done;
    expect(s.rows.stored.map((r) => [r.state, r.sourceId])).toEqual([
      ['paused', PACK],
      ['failed', PACK],
      ['paused', PACK],
    ]);
    expect(s.swarm.calls).toEqual(['keep', 'releaseSlot E2', 'release', 'release']);
    // The play ended: the queue reaches d1 again; d1 and d3 still name the pack, so it is opened again by its hash.
    const again = (await s.seasons.take(s.rows.get('d1')))!;
    expect(s.fetches.map((f) => f.known)).toEqual([null, PACK]);
    expect(again.rowIds).toEqual(['d1', 'd3']);
    s.swarm.wholeFiles.add(0);
    s.swarm.wholeFiles.add(2);
    await again.done;
    expect(s.rows.stored.map((r) => r.state)).toEqual(['done', 'failed', 'done']);
    expect(await again.progress('d1')).toEqual({ done: 100, total: 100 });
  });

  it('fails what is left when the swarm sends nothing for two hours', async () => {
    const s = setup({ pack: packOf([1, 2]) });
    s.swarm.receivedBytes = 0;
    const job = (await s.seasons.take((await queued(s))[0]!))!;
    await job.done;
    expect(PACK_STALL_MS).toBe(2 * 3_600_000);
    expect(s.rows.stored.map((r) => [r.ref.episode, r.state, r.error])).toEqual([
      [1, 'failed', 'download_failed'],
      [2, 'failed', 'download_failed'],
      [3, 'queued', null],
    ]);
  });
});

describe('finishFromDisk: a pack episode made ready to play offline', () => {
  it('looks again until the episode reads from disk, waits for its remux and subtitle, then lets it go', async () => {
    const calls: string[] = [];
    const torrent = { infoHash: PACK } as never;
    let reads = 0;
    let looks = 0;
    const source = {
      fromDisk: async () => {
        calls.push('fromDisk');
        reads += 1;
        return reads < 3 ? null : ({ torrent, source: {} as never, attempts: [] } as never);
      },
      keptState: async () => {
        looks += 1;
        return { file: 'whole' as const, remux: looks < 2 ? ('running' as const) : ('whole' as const), subtitles: 'done' as const };
      },
      release: () => void calls.push('release'),
    };
    const finish = finishFromDisk(() => source, async () => ({ audioLang: 'en' }), { sleep: async () => undefined, log: () => undefined });
    await finish({ kind: 'tv', tmdbId: TMDB, season: 1, episode: 1 });
    expect(calls).toEqual(['fromDisk', 'fromDisk', 'fromDisk', 'release']);
    expect(looks).toBe(2);
  });
});
```

### Step 11: the integration test on Postgres
**File:** `tests/integration/directStream.seasonDownloads.int.test.ts` (new)
**Change:** the whole season path with the real writers (`DownloadsRepo`, `TorrentsRepo`), the real
`TorrentStreams` over `FakeTorrentEngine`, and the real `TorrentSource.fetchPack` over a fake finder and probe; rows
read back with SQL.
**Code:**
```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { streamDownloads, streamTorrents } from '../../src/db/schema.js';
import { DownloadsRepo } from '../../src/directStream/downloads/repo.js';
import { packSwarmOf, SeasonDownloads, seasonRowsOf } from '../../src/directStream/downloads/season.js';
import { parseRelease, type TorrentCandidate } from '../../src/directStream/torrent/find/index.js';
import type { MediaProbe } from '../../src/directStream/torrent/probe.js';
import { TorrentsRepo } from '../../src/directStream/torrent/repo.js';
import { TorrentStreams } from '../../src/directStream/torrent/service.js';
import { TorrentSource } from '../../src/directStream/torrent/source.js';
import { TorrentFolder } from '../../src/directStream/torrent/store.js';
import { FakeTorrentEngine } from '../helpers/fakeTorrentEngine.js';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

const HOST = 'host-a';
const PACK = 'facade'.padEnd(40, '3');
const SHOW = 'Fixture.Show.S01.1080p.WEB.x264';
const T0 = new Date('2026-11-20T12:00:00Z');
const data = (seed: number): Buffer => Buffer.from(Array.from({ length: 4096 }, (_, i) => (i + seed) % 251));
const FILES = [1, 2, 3].map((e) => ({ path: `${SHOW}/Fixture.Show.S01E0${e}.1080p.mp4`, data: data(e) }));
const MP4_EN: MediaProbe = { container: 'mov,mp4,m4a,3gp,3g2,mj2', video: { codec: 'h264', height: 1080 }, audio: [{ codec: 'aac', lang: 'eng' }], subtitles: [], durationS: 2_700, direct: true };
const PACK_CANDIDATE: TorrentCandidate = {
  infoHash: PACK,
  name: SHOW,
  fileName: null,
  fileIdx: null,
  seeds: 60,
  sizeBytes: 12_288,
  index: 'torrentio',
  listedBy: ['torrentio'],
  site: null,
  trackers: [],
  scoped: false,
  release: parseRelease(SHOW),
};

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
  root = await mkdtemp(path.join(os.tmpdir(), 'season-int-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('a season download from its pack', () => {
  it('joins one swarm, records and keeps one stream_torrents row per episode, and ends each stream_downloads row done', async () => {
    const torrentsRepo = new TorrentsRepo(db);
    const downloads = new DownloadsRepo(db);
    const engine = new FakeTorrentEngine([{ infoHash: PACK, name: SHOW, files: FILES }]);
    const folder = new TorrentFolder(root);
    const streams = new TorrentStreams({ engine, repo: torrentsRepo, folder, host: HOST, uploadKbps: 100, keepDays: 7, discovery: true, now: () => T0, log: () => undefined, every: () => () => undefined });
    const source = new TorrentSource({
      swarm: streams,
      find: async () => ({ candidates: [PACK_CANDIDATE], indexes: [], excluded: [], lastResort: [] }),
      probe: async () => MP4_EN,
      tiers: [],
      localBase: () => 'http://127.0.0.1:1',
      log: () => undefined,
    });
    const rows = seasonRowsOf(downloads, HOST, () => T0);
    const seasons = new SeasonDownloads({
      episodes: async () => [
        { episode: 1, airDate: '2026-10-01' },
        { episode: 2, airDate: '2026-10-08' },
        { episode: 3, airDate: '2026-10-15' },
        { episode: 4, airDate: '2026-12-01' },
      ],
      whole: (ref) => source.onDisk(ref),
      request: (ref, o) => downloads.create(HOST, { ref, via: o.via, infoHash: null, batch: o.batch }, T0),
      rows,
      packs: { fetch: (tmdbId, season, episodes, o) => source.fetchPack(tmdbId, season, episodes, { audioLang: 'en', imdbId: null, names: null, ...o }) },
      // TorrentStreams.keep (phase 2) writes the owner's mark through TorrentsRepo.setKept.
      swarm: packSwarmOf(streams),
      office: async () => false,
      now: () => T0,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
      newBatch: () => 'batch-int',
      log: () => undefined,
    });

    const answer = await seasons.request(1399, 1, { via: 'auto' });
    expect(answer).toMatchObject({ ok: true, batch: 'batch-int', left_out: [{ episode: 4, why: 'not_aired' }] });
    const [first] = await rows.open('batch-int');
    const job = await seasons.take(first!);
    expect(job).not.toBeNull();
    expect(engine.added).toEqual([PACK]);

    for (const [index, f] of FILES.entries()) {
      const target = folder.diskPath(PACK, f.path)!;
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, f.data);
      engine.have(PACK, index);
    }
    await job!.done;
    await streams.tick();

    const torrents = await db.select().from(streamTorrents).where(eq(streamTorrents.infoHash, PACK));
    expect(torrents.map((r) => [r.episode, r.fileIndex, r.state, r.keptAt !== null]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([
      [1, 0, 'ready', true],
      [2, 1, 'ready', true],
      [3, 2, 'ready', true],
    ]);
    const asked = await db.select().from(streamDownloads).where(eq(streamDownloads.batch, 'batch-int'));
    expect(asked.map((r) => [r.episode, r.state, r.source, r.sourceId]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([
      [1, 'done', 'torrent', PACK],
      [2, 'done', 'torrent', PACK],
      [3, 'done', 'torrent', PACK],
    ]);
    for (const episode of [1, 2, 3]) expect(await source.onDisk({ kind: 'tv', tmdbId: 1399, season: 1, episode })).toBe(true);
    expect(engine.added).toEqual([PACK]);
  });
});
```
**Impact:** phase 1's `truncateAll` empties `stream_downloads`. `seasonRowsOf(downloads, …)` takes phase 1's
`DownloadsRepo` directly (it satisfies the `DownloadRecords` methods named).

## Principles applied

- Laziness protocol: no new "season" query shape in the finder or the indexes, and no new pack table: the finder is asked for the first wanted episode (packs are listed per episode), `pickFile` chooses each episode's file, and `stream_torrents`' existing row per (hash, season, episode) records the pack; `TorrentStreams` gains only `useSlot` and `releaseSlot`.
- Make illegal states unrepresentable: `PackFetch` and `SeasonAnswer` are unions (no `ok: true` without a pack or rows), and the pack's height rule is `heights: 'preferred' | 'any'` instead of a height plus a flag that only means something for `auto`.
- Boundary discipline: the aired filter runs once, in `airedEpisodes` at `request` time, on TMDB's day strings (a malformed day is `no_air_date`); `take` trusts the rows and only re-checks "whole", which can change between the click and the queue reaching the batch. Phase 1/2 names are confined to `seasonRowsOf`, `seasonRowOf`, `finishFromDisk`, the step 6 edits and the step 7 wiring.
- Sequence into verifiable units: steps 1, 3 and 5 each have their own test file (steps 8, 9, 10), each runnable before the next step; step 11 proves the joined path on Postgres.
- Test behavior, not implementation: the tests assert rows' states, the swarm's boundary calls (one open, one keep, which files are selected and when) and `stream_torrents` / `stream_downloads` rows read back with SQL, never private members of the units under test.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npx vitest run tests/unit/directStream/torrent/useSlot.test.ts tests/unit/directStream/torrent/seasonPack.test.ts tests/unit/directStream/downloads/season.test.ts && npm test && npm run test:int -- tests/integration/directStream.seasonDownloads.int.test.ts`
**Proof:** this phase adds no route, tool or page (phase 4's `POST /api/stream/downloads` is the first surface a user can reach), so the real artifact here is the engine's rows in Postgres: the integration test drives `SeasonDownloads.request` and `take` with the real `DownloadsRepo`, `TorrentsRepo`, `TorrentStreams` and `TorrentSource.fetchPack`, and reads `stream_torrents` and `stream_downloads` back with SQL.
- Harness: `.claude/skills/verify-notesd` exists, but nothing this phase builds is reachable over HTTP, MCP or the wall yet; run instead: `npm run test:int` (pgvector Postgres in Docker, `scripts/test-int.sh`) and `npx vitest run`. Phase 9 drives the season download through the route on `verify.sh up --torrent` (its loopback seeder serves a season pack).
- Feature-map entries: none (phase 9 owns `features/direct-streaming.md`)
- Journeys:
  - **J1** · traces R2.1 — `npx vitest run tests/unit/directStream/downloads/season.test.ts -t "queues every aired episode not whole on this machine"` → passes when the test passes: the answer is `ok` with `batch: "batch-1"`, one `queued` row each for E01 and E03 in that order, both `queued` under `batch-1`, and E02 left out as `whole`
  - **J2** · traces R2.4 — `npx vitest run tests/unit/directStream/downloads/season.test.ts -t "has not aired"` → passes when the test passes: no row is made for E04 (airs 2026-11-27, after the clock's 2026-11-20) or E05 (no air day), the answer lists them as `not_aired` and `no_air_date`, and the pack is asked for episodes `[1, 2, 3]` only
  - **J3** · traces R2.3 — `npm run test:int -- tests/integration/directStream.seasonDownloads.int.test.ts` → passes when the test passes: the fake engine was asked to add the pack's info hash exactly once; `stream_torrents` holds three rows of that hash (episodes 1, 2, 3, file indexes 0, 1, 2), each `ready` with `kept_at` set; `stream_downloads` holds three rows of `batch-int`, each `done` with `source = 'torrent'` and `source_id` the pack's hash; and `TorrentSource.onDisk` is true for each episode
  - **J4** · traces R2.3 — `npx vitest run tests/unit/directStream/torrent/seasonPack.test.ts` → passes when all tests pass: a 1080p pack with live seeds is opened once and its first episode is probed before E02 and E03 are selected; a pack whose first episode is German audio for an English title is dropped after only E01 was selected, and the next pack is used; with no source named a 720p-only answer gives `no_pack` and opens nothing
  - **J5** · traces R2.1, R2.3 — `npx vitest run tests/unit/directStream/downloads/season.test.ts -t "lacks|lets go of the pack"` → passes when both tests pass: the pack job carries `d1` and `d3`, both end `done`, and `d2` (E02, which the pack lacks) is still `queued` for its own download, with no second pack lookup; and a pack let go for a torrent play leaves its rows `paused` with the pack as their source, then is opened again by its hash (`known` = the pack) and ends them `done`
- Neighbor check: the existing torrent play and pack paths, which share `use`: `npx vitest run tests/unit/directStream/torrent tests/unit/directStream/torrentSource.test.ts tests/unit/directStream/torrentPlay.test.ts tests/unit/directStream/ahead.test.ts && npm run test:int -- tests/integration/directStream.torrents.int.test.ts` → passes when every test passes unchanged (notably `packAndBudget.test.ts` "keeps E01 on disk when E02 of the same pack is watched after it")
- Cost: none (no network, no model, no real swarm)

**Exit criteria:** `npm run typecheck`, `npm test` and the season integration test pass; a pack found means one swarm open, N `stream_torrents` rows, N kept, each episode `onDisk`; no pack means every row stays queued for the per-episode path in order; an unaired episode and an episode already whole get no row; a pack missing one episode leaves that one alone queued.

## Handoffs

- **Phase 4 (R2.1, the route), reconciled:** `POST /api/stream/downloads` with `kind: "tv"`, `season` and no `episode` calls `StreamDownloads.requestSeason(tmdb_id, season, {via})`, which answers `SeasonAnswer<DownloadRequestAnswer>`. Mapping (one set, phases 3 and 4): `ok: true` → `created` = the `queued` answers with `created: true`, `whole` = `left_out` with `why: 'whole'` plus the `queued` answers with `onDisk: true`, `not_aired` = `left_out` with `why` `not_aired` or `no_air_date`, `downloads` = the `queued` answers' `download` rows; 202 when `created > 0`, else 200. `ok: false` `unknown_season` → 404 `unknown_season`; `seasons_off` → 503 `downloads_off`. A body with `info_hash` and no `episode` is 400 `invalid_body` (a pack is never picked by hand; phase 8 leaves the pick row out for a season). `GET /api/stream/downloads` reads a pack row's progress through phase 2's `viewOf` (step 6j) and returns `batch` so phase 8 can roll a season's rows up.
- **Phase 2 (reconciled):** this phase edits phase 2's `service.ts` itself (step 6, every anchor quoted from phase 2's plan) and builds its options in phase 2's `buildStreamDownloads` (step 7). It uses phase 2's names as they are: `DownloadRecords`, `DownloadRequestAnswer`, `onDisk`, `isOffice(await ssid())`, `TorrentStreams.keep(hash, true)`, `downloadFacts`, `keptState`, `release`. Nothing is lifted out of `fetchKept`; `TorrentStreams` gains no pause or resume.
- **Phase 1 (reconciled):** `list`/`claimNext` order `created_at, season, episode, id` (phase 1 orders so); `StreamDownloadRow.sourceId`; `TorrentsRepo.setKept(host, infoHash, at)` setting every row of the hash; `truncateAll` covering `stream_downloads`. Note: a pack episode cancelled mid-way keeps its partial `stream_torrents` row under the pack's kept mark until the owner deletes it on the Cache page.
- **Phase 9 (docs, proof):** `docs/guide/streaming.md` line 1894 ("A season pack ... is recorded under one episode") describes the fetch-ahead and stays true for it; the new "Downloading a title" section says a season download takes a pack with one row per episode and one hold each, the audio check on its first episode, 1080p only with no source named, the fallback per episode, and the 2-hour stall. The verify-notesd journey through the route on `--torrent` (its `pack.json` seeder) proves R2.1 and R2.3 on a running daemon.
- **Not done here, noted:** the fetch-ahead (`ahead.ts`) still records a pack under one episode; it could take `useSlot` later. Out of scope (owned by nobody in this set).

## Rollback

Revert this phase's commit. `requestSeason`, `enqueue` and the pack hook go with it; phase 2's per-episode engine is untouched,
`TorrentStreams.use` is unchanged in behaviour, and no migration belongs to this phase. Rows already written by a
season download are ordinary `stream_downloads` rows with a `batch` (phase 2 runs them one by one) and ordinary kept
`stream_torrents` rows the Cache page deletes.
