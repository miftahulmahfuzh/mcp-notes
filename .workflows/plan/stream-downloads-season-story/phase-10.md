# Phase 10: Office network: a torrent download through WARP before the cloud

**Plan set:** `STREAM_DOWNLOADS_SEASON_STORY_PLAN.md`
**Analysis:** `.workflows/analyze/20261120-213359-K7Q2_code_analyzer.md`
**Satisfies:** R1 — the Download button's default is a 1080p torrent first, on every network the owner works from
**Criteria:** R1.4, R1.12
**Depends on:** Phase 2, Phase 3, Phase 4 (and through them phase 1, landed at `a7a075d`)
**Difficulty:** HARD
**Package:** `src/directStream/downloads`

---

## Goal

After this phase a download follows one source order on every network: a 1080p torrent with live seeds, then the
cloud at 1080p or lower, then a torrent below 1080p. On SSID `Employee`, a torrent step (or a season pack) whose every
torrent sent no file list, with WARP off, switches Cloudflare WARP on once through the stream service's one
`WarpHolds` and asks the torrents again. Only then does `auto` go on to the next source, and a torrent asked for by
hand fail `no_peers_here`. A download that goes ahead under WARP holds it while its torrent is in the swarm. It lets go
when it is done, paused, failed or cancelled. WARP goes back off when switching did not help or the last holder lets
go, unless a torrent plays on screen. A WARP the owner turned on is never touched. The engine reaches WARP only
through a narrow port (`status`, `ours`, `hold`, `release`); it never sees `set`.

Phase 2 is being implemented with the old rule. This phase replaces that rule in phase 2's and phase 3's code as
their plans leave it. Every code anchor below is quoted from `phase-2.md` / `phase-3.md` / `phase-4.md`. None of those
files exists in the tree before those phases land.

## Decisions (made here, binding on the implementer)

1. **How a download learns "no peer at all".** It reuses `noPeersAtAll` (`src/directStream/torrentWarp.ts:28`) on the
   attempts `TorrentSource.fetchKept` (a film or an episode) or `TorrentSource.fetchPack` (a season pack) answered.
   Every torrent attempt that is not `skipped` ended at `NO_FILE_LIST`. The adapter `torrentDownloadsOf` computes it,
   and the engine reads it as `TorrentFetch`'s `noPeers` on the failure branch. A season pack reads it straight off
   `PackFetch.attempts` (`tryPack`'s failed open is `no_stream` + `NO_FILE_LIST`, phase 3 Step 3). The second ask
   first forgets the title's swarm failures (`TorrentSource.forgetNoPeers`), as a play's does
   (`DirectStreamService.throughWarp`, `src/directStream/service.ts:1204-1207`).
2. **What decides "office".** `NOTESD_STREAM_DOWNLOAD_SSID` still decides it: phase 2's `ssid` seam (`fixedSsid` when
   set, else `ssidFrom` over WARP's status). A pinned SSID keeps tests and throwaway daemons off the real Wi-Fi name.
   WARP's own state (`disconnected` / `connected` / ...) comes from the injected switch's `status`, read only when a
   torrent step found no peer on the office network.
3. **The narrow port.** Phase 2 wrote a type-level guarantee: the engine holds no `WarpSwitch`, and `ssidFrom` takes
   `Pick<WarpSwitch, 'status'>`. This phase replaces it. The engine now receives `DownloadWarp` (`status`, `ours`,
   `hold`, `release`), built by `DirectStreamService.warpForDownloads()` over its own `private readonly warpHolds`
   (`src/directStream/service.ts:512`). So a play and a download share one set of holders. `WarpHolds.set` is
   private and `DownloadWarp` has no `set`, so nothing in `src/directStream/downloads/` can switch WARP except by
   holding or letting go. `claude/streaming/warp.mjs` stays the one place `warp-cli` and `netsh` run.
4. **A play's rule is not reused as is.** `torrentThroughWarp` lets go at the end of its own ask and keeps WARP on
   forever when it played (`release(second.ok)`). A download must hold WARP while its torrent is in the swarm, then put
   it back off. So a sibling `WarpRounds.round` (new `src/directStream/downloads/warp.ts`) does the same checks in the
   same order (no peer at all, office, WARP off or ours, hold, ask again, let go on failure). It hands back a once-only
   `WarpHold` when the second ask got a torrent. `torrentWarp.ts` is not edited.
5. **Letting go and "a play still holds it".** Every release a download makes passes
   `played = (a torrent plays on screen now)` to `WarpHolds.release`. A torrent playing on screen on the office network
   may be playing through the WARP the download held, and the play's own rule keeps WARP on when a torrent plays
   through it. So a download paused for a play (play first, R1.9) lets go with `played: true`, and WARP stays on
   (`kept`). A download that is done, failed or cancelled with no torrent on screen lets go with `false`, and WARP goes
   back off when it was the last holder (a play's ask still running holds it: `held`). One consequence matches today's
   play rule: once a play kept WARP on, it stays on until the owner's `/warp off`. A download carried on after that play
   sees a WARP it did not switch (`ours` false) and goes through it without touching it.
6. **A daemon stop.** Today a play's hold is taken and given back within the one torrent ask
   (`torrentThroughWarp`). `DirectStreamService` has no WARP step at close, so a stop switches nothing and WARP stays
   as it is (on, after a play that played through it). A download matches that. `StreamDownloads.close` and
   `SeasonPackJob.close` give back no hold and run no `warp.mjs` during shutdown. The hold dies with the process, and
   the row stays `running`. After the restart the carried-on download finds WARP on and not this run's (`ours` false),
   so it goes through it and never switches it off. It does not wait off the office network any more: it is opened
   again under the same rule (phase 2's `if (resumeHash !== null && office) continue;` is deleted).
7. **One round per torrent step.** Each torrent step that finds no peer at all gets one WARP round, as each torrent ask
   of a play does. `via: torrent` is two steps (1080p, then below), so it can switch WARP on and back off twice before
   failing `no_peers_here`. A carried-on torrent whose swarm gives nothing is retried by phase 2's `retryLater` at most
   `DOWNLOAD_RESUME_TRIES` times, each with its own round.
8. **`no_peers_here`.** A torrent step fails `no_peers_here` when it found no peer at all on the office network, after
   the WARP round (or with `NOTESD_STREAM_WARP=off`, without one). `finalFailure` answers `no_peers_here` when every step
   failed that way (`via: torrent`). Off the office network the same case stays phase 2's `no_source`.
9. **`NOTESD_STREAM_WARP=off`.** `DirectStreamService` is built with `warp: null`, so `warpForDownloads()` answers null
   and nothing is switched. The torrent is tried, and with no peers the order goes on: `auto` to the cloud, a torrent
   asked for by hand to `no_peers_here`. Every `verify.sh` daemon pins it off (and the SSID to `verify-home`).

## Interface Contract

**Deletes:**
- `planDownload`'s office branches and its `here.office` input, and the `const office: DownloadPlan` value
  (`src/directStream/downloads/plan.ts`, phase 2 Step 6). `'no_peers_here'` leaves `DownloadPlan`'s error union: the
  plan no longer makes it.
- `StreamDownloads.startNext`'s office read and the wait of a carried-on torrent download on the office network
  (`office ??= isOffice(await this.opts.ssid());` and `if (resumeHash !== null && office) continue;`, phase 2 Step 7).
- `SeasonDownloadsDeps.office()` and `take`'s `if (await this.deps.office()) return null;`
  (`src/directStream/downloads/season.ts`, phase 3 Step 5). The `office:` member goes from phase 3 6c's
  `new SeasonDownloads({...})` and from phase 3's tests.
- Phase 2's test-only rule "a download never switches WARP" (the fake switch whose `set` throws).

**Renames:** none.

**Creates:**
- `src/directStream/downloads/warp.ts` (new): `interface DownloadWarp`, `downloadWarpOf(holds, sw)`,
  `interface WarpHold`, `interface WarpRound<T>`, `interface WarpRoundsOptions`, `class WarpRounds` (`round`),
  `putBackText(back)`.
- `DirectStreamService.warpForDownloads(): DownloadWarp | null` (`src/directStream/service.ts`, right after
  `throughWarp`).
- `DownloadTorrents.forgetNoPeers(ref: StreamRef): void` (`src/directStream/downloads/types.ts`).
- The failure branch of `TorrentFetch` gains `noPeers?: boolean`.
- `StreamDownloadsOptions.warp?: DownloadWarp | null`; private `StreamDownloads.warpRounds`, `warpBacks`,
  `letGoWarp(job)`, `office()`; `Job.warp: WarpHold | null`.
- `SeasonDownloadsDeps.warp?: WarpRounds | null`; `SeasonPackJobParts.warp?: WarpHold | null`; private
  `SeasonPackJob.closing`.
- Tests: `FakeWarp` (`tests/unit/directStream/downloads/fakes.ts`); `FakeTorrents.viaWarp`, `warpIsOn`,
  `forgetNoPeers`.

**Signature changes:**
- `planDownload(ask, here: { office: boolean; torrent: boolean; cloud: boolean })` -> `planDownload(ask, here: { torrent: boolean; cloud: boolean })`
- private `StreamDownloads.planOf(row, office)` -> `planOf(row)`
- `finalFailure`: also answers `no_peers_here` when every step failed with it.

**Requires (from earlier phases):**
- Phase 2: `src/directStream/downloads/{types,plan,service}.ts` exactly as phase 2 Steps 5–7 write them, with
  `torrentDownloadsOf`, `ssidFrom`, `fixedSsid`, `buildStreamDownloads` (whose `wiring.directStream` is the
  `DirectStreamService`); `TorrentSource.fetchKept` answering `KeptResolve` with `attempts`; phase 2's tests
  (`fakes.ts`, `plan.test.ts`, `service.test.ts`) as Steps 12–14 write them; phase 2's configuration rows and the
  `daemon.ts` comment (Steps 8, 9).
- Phase 3: `season.ts` as Step 5 writes it; its edits to phase 2's `service.ts` (6a–6j, Step 7: `this.pack`,
  `this.season`, `run(job, row, steps, before, resume)` with the batch hook, `playFirst`'s pack branch, `close`'s
  `pack?.close()`); `PackFetch` with `attempts`; `season.test.ts` and
  `tests/integration/directStream.seasonDownloads.int.test.ts` as Steps 10–11 write them.
- Phase 4: the `'POST /api/stream/downloads'` entry in `scripts/docs/httpRoutes.ts` (phase 4 Step 4) with the
  phrase `; on the office network the cloud alone)`.
- Existing, unchanged: `noPeersAtAll`, `WarpHolds` (`src/directStream/torrentWarp.ts`), `OFFICE_SSID`, `WarpState`,
  `WarpSwitch` (`src/streaming/warp.ts`), `TorrentSource.forgetNoPeers` (`src/directStream/torrent/source.ts:576`),
  `NO_FILE_LIST` (`source.ts:35`).

**Leaves alone (owned by others):** `src/directStream/torrentWarp.ts` (its behaviour for plays, its text);
`claude/streaming/warp.mjs`; `src/directStream/cacheShelf.ts` and the shelf adapter in `src/daemon.ts:566-576`
(Phase 5); `DirectStreamService.torrentsOnScreen`/`downloadFacts` and phase 5's `aheadFetching` after them (Phases 2,
5: this phase's one addition to `src/directStream/service.ts` sits after `throughWarp`, about 1 000 lines further
down); every web file (Phases 5, 7, 8); the story code (Phases 6, 7); `docs/guide/*.md` prose, `CLAUDE.md`, and the
other `.claude/skills/verify-notesd/features/*` entries (Phase 9); `verify.sh` (no change: it already pins
`NOTESD_STREAM_WARP=off` and `NOTESD_STREAM_DOWNLOAD_SSID=verify-home`).

## Files

| File | Action | What changes |
|---|---|---|
| `src/directStream/downloads/warp.ts` | create | `DownloadWarp`, `downloadWarpOf`, `WarpHold`, `WarpRound`, `WarpRounds`, `putBackText` |
| `src/directStream/downloads/plan.ts` | replace (phase 2's file) | one order on every network; `finalFailure` knows `no_peers_here` |
| `src/directStream/downloads/types.ts` | modify (phase 2's) | `TorrentFetch` failure `noPeers?`; `DownloadTorrents.forgetNoPeers` |
| `src/directStream/downloads/service.ts` | modify (phase 2's, as phase 3 leaves it) | imports, options, `Job.warp`, fields, constructor, `cancel`, `close`, `settled`, `playFirst`, `followTorrent`, `startNext`, `planOf`, `run`, `letGoWarp`, `office`, `ssidFrom`'s doc, the adapter's `fetch`/`forgetNoPeers`, `buildStreamDownloads`' `warp` |
| `src/directStream/downloads/season.ts` | modify (phase 3's) | imports, `SeasonDownloadsDeps.warp`, `take`, `SeasonPackJobParts.warp`, `SeasonPackJob` `pause`/`close`/`run` |
| `src/directStream/service.ts:27`, `:1211` | modify | import; `warpForDownloads()` after `throughWarp` |
| `src/streaming/warp.ts:27-31` | modify | `WarpSwitch`'s doc names the download |
| `src/config.ts:202-207` | modify | `warp?`'s doc names the download |
| `src/daemon.ts` (phase 2's two comment lines over `deps.streamDownloads = buildStreamDownloads(...)`) | modify | the comment no longer says a download never switches WARP |
| `docs/guide/reference/configuration.md:131` and phase 2's two rows after `:145` | modify | `NOTESD_STREAM_WARP`, `NOTESD_STREAM_DOWNLOADS`, `NOTESD_STREAM_DOWNLOAD_SSID` |
| `scripts/docs/httpRoutes.ts` (phase 4's `'POST /api/stream/downloads'` entry) | modify | the office phrase; then `npm run docs:gen` regenerates `docs/guide/reference/http-api.md` |
| `.claude/skills/verify-notesd/features/direct-streaming.md:628-633` | modify | the WARP entry names the download and its tests |
| `tests/unit/directStream/downloads/fakes.ts` | replace (phase 2's) | `FakeTorrents` learns WARP; `FakeWarp` |
| `tests/unit/directStream/downloads/plan.test.ts` | replace (phase 2's) | no office input; R1.4 rewritten |
| `tests/unit/directStream/downloads/service.test.ts` | modify (phase 2's) | imports and `build`; R1.4 rewritten; R1.12 added |
| `tests/unit/directStream/downloads/season.test.ts` | modify (phase 3's) | imports, `setup`, the office case; R1.4 / R1.12 pack tests |
| `tests/integration/directStream.seasonDownloads.int.test.ts` | modify (phase 3's) | drop `office: async () => false,` |

## Implementation Steps

Order: Step 1 (the new module) and Step 2 (the plan) build alone. Steps 3–6 change the engine. Step 7 wires the
service. Steps 8–10 are texts. Steps 11–15 are tests. Run `npm run typecheck` after Step 7 and the downloads tests
after Step 14.

### Step 1: `src/directStream/downloads/warp.ts` (new)
**File:** `src/directStream/downloads/warp.ts`
**Change:** the download's WARP round, the narrow port, and the once-only hold.
**Code:**
```ts
import { OFFICE_SSID, type WarpState, type WarpSwitch } from '../../streaming/warp.js';
import type { WarpHolds } from '../torrentWarp.js';

/**
 * Cloudflare WARP for a torrent download the owner asked for (stream-downloads phase 10). The source order is the same
 * on every network. On the office network (SSID Employee), a torrent step whose every torrent sent no file list
 * (noPeersAtAll) is asked once more with WARP on, as a torrent play is (torrentWarp.ts). A download that goes ahead
 * through WARP holds it while its torrent is in the swarm, and lets go when it is done, paused, failed or cancelled.
 * WARP goes back off when the last holder lets go, unless a torrent plays on screen. The holders are the stream
 * service's one WarpHolds, shared with torrent plays. A download never reaches the switch's `set`, only this port.
 */

/** WARP as a download may use it: read, hold, let go. No `set` (DirectStreamService.warpForDownloads builds it). */
export interface DownloadWarp {
  /** WARP's state and the Wi-Fi name now (warp.mjs `status`). */
  status(): Promise<WarpState>;
  /** True while the stream service switched WARP on and a play or a download still holds it: a download may join it. */
  readonly ours: boolean;
  /** WarpHolds.hold: WARP switched on for the first holder; the switch's state (null, or not connected: nothing held). */
  hold(): Promise<WarpState | null>;
  /** WarpHolds.release: `played` true keeps WARP on (a torrent plays through it). */
  release(played: boolean): Promise<'held' | 'kept' | WarpState | null>;
}

/** The port over the stream service's WarpHolds and the switch's `status`: what a download gets instead of the switch. */
export function downloadWarpOf(holds: WarpHolds, sw: Pick<WarpSwitch, 'status'>): DownloadWarp {
  return {
    status: () => sw.status(),
    get ours(): boolean {
      return holds.ours;
    },
    hold: () => holds.hold(),
    release: (played) => holds.release(played),
  };
}

/** A download's share of WARP after a round whose second ask got a torrent. */
export interface WarpHold {
  /** Lets go once (a second call does nothing); never throws. */
  release(): Promise<void>;
}

/** What a round answers: the fetch to go on with, the hold when it went ahead through WARP, and what was said. */
export interface WarpRound<T> {
  out: T;
  hold: WarpHold | null;
  /** True when no peer answered on the office network: a torrent asked for by hand then fails `no_peers_here`. */
  office: boolean;
  /** The line for the row's detail and the log; null when no round was due. */
  note: string | null;
}

export interface WarpRoundsOptions {
  /** Null: NOTESD_STREAM_WARP=off (or no automatic flip). Nothing is switched, and the order goes on. */
  warp: DownloadWarp | null;
  /** True on the office network: the download's SSID seam (NOTESD_STREAM_DOWNLOAD_SSID, else WARP's status). */
  office: () => Promise<boolean>;
  /** True while a torrent plays on screen: a download letting go then keeps WARP on (the play may play through it). */
  playing: () => boolean;
  log: (line: string) => void;
}

const NETWORK = `the office network (${OFFICE_SSID})`;
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What happened to WARP when a download let go of it. */
export function putBackText(back: 'held' | 'kept' | WarpState | null): string {
  if (back === 'held') return 'WARP stays on while a torrent play or another download holds it';
  if (back === 'kept') return 'WARP stays on: a torrent plays through it';
  if (back?.ok === true && back.warp === 'disconnected') return 'WARP was put back off';
  return `WARP could not be put back off (${back?.error ?? 'the switch failed'}): /warp off`;
}

export class WarpRounds {
  constructor(private readonly o: WarpRoundsOptions) {}

  /**
   * After a torrent step (or a season pack) that got nothing: when `noPeers` (every torrent sent no file list), on
   * the office network, with WARP off or on by this daemon, WARP is held and `again` asks once more. When that got
   * something, the answer carries the hold, and the caller lets go of it when the download leaves the swarm. When
   * it did not, WARP is let go at once. Anywhere else, `first` comes back as it is. A WARP the owner turned on is
   * never touched. Throws only what `again` throws, after letting go.
   */
  async round<T extends { ok: boolean }>(label: string, first: T, noPeers: boolean, again: () => Promise<T>): Promise<WarpRound<T>> {
    const none: WarpRound<T> = { out: first, hold: null, office: false, note: null };
    if (first.ok || !noPeers) return none;
    let office = false;
    try {
      office = await this.o.office();
    } catch {
      office = false;
    }
    if (!office) return none;
    const said = (note: string): WarpRound<T> => {
      this.o.log(`[notesd] downloads: ${label}: ${note}`);
      return { out: first, hold: null, office: true, note };
    };
    const warp = this.o.warp;
    if (warp === null) return said(`no torrent peer answered on ${NETWORK}; Cloudflare WARP is not switched by notesd here (NOTESD_STREAM_WARP=off)`);
    let state: WarpState;
    try {
      state = await warp.status();
    } catch (err) {
      return said(`no torrent peer answered on ${NETWORK}; Cloudflare WARP's state could not be read (${messageOf(err)})`);
    }
    // On, and not by this daemon: the owner's WARP, never touched.
    if (state.warp !== 'disconnected' && !warp.ours) {
      return said(`no torrent peer answered on ${NETWORK} with Cloudflare WARP ${state.warp}, which notesd did not switch on and leaves as it is`);
    }
    const on = await warp.hold();
    if (on === null || !on.ok || on.warp !== 'connected') {
      return said(`no torrent peer answered on ${NETWORK}; Cloudflare WARP could not be turned on (${on?.error ?? 'the switch failed'})`);
    }
    let second: T;
    try {
      second = await again();
    } catch (err) {
      await this.letGo(warp);
      throw err;
    }
    if (second.ok) {
      const note = `no torrent peer answered on ${NETWORK}, so Cloudflare WARP was turned on and the torrents asked again; WARP stays on while this download is in the swarm`;
      this.o.log(`[notesd] downloads: ${label}: ${note}`);
      return { out: second, hold: this.holdOf(warp, label), office: true, note };
    }
    const back = await this.letGo(warp);
    const note = `no torrent peer answered on ${NETWORK}; through Cloudflare WARP no torrent could be downloaded either, so ${putBackText(back)}`;
    this.o.log(`[notesd] downloads: ${label}: ${note}`);
    return { out: second, hold: null, office: true, note };
  }

  private holdOf(warp: DownloadWarp, label: string): WarpHold {
    let held = true;
    return {
      release: async () => {
        if (!held) return;
        held = false;
        const back = await this.letGo(warp);
        this.o.log(`[notesd] downloads: ${label}: let go of Cloudflare WARP; ${putBackText(back)}`);
      },
    };
  }

  /** WarpHolds.release; a torrent playing on screen now keeps WARP on (it may play through it). Never throws. */
  private async letGo(warp: DownloadWarp): Promise<'held' | 'kept' | WarpState | null> {
    try {
      return await warp.release(this.o.playing());
    } catch {
      return null;
    }
  }
}
```
**Impact:** new module. It imports `WarpHolds` as a type only and `OFFICE_SSID` from `src/streaming/warp.ts`, so no
import cycle forms with `src/directStream/service.ts` (Step 7 imports this file there).

### Step 2: `src/directStream/downloads/plan.ts`: one order on every network
**File:** `src/directStream/downloads/plan.ts` (phase 2 Step 6's file; replace the whole file)
**Change:** subtract the office rule from the pure plan. The office case is now the engine's WARP round (Step 6).
`finalFailure` keeps `no_peers_here` when every step failed with it.
**Code:**
```ts
import { OFFICE_SSID } from '../../streaming/warp.js';
import type { SwarmCount, TorrentCandidate } from '../torrent/find/index.js';
import { PREFERRED_TORRENT_HEIGHT } from '../torrent/source.js';
import type { DownloadVia, TorrentBand } from './types.js';

/**
 * The source order of a download, pure and the same on every network. With no source named (`auto`): a 1080p
 * torrent with live seeds, then the owner's cloud cache at 1080p or lower, then a torrent below 1080p. On the office
 * network (SSID Employee) a torrent step that reaches no peer at all is asked once more through Cloudflare WARP before
 * the next step. That is the engine's (downloads/warp.ts), not the plan's.
 */

/** The cloud cache's height cap for a download: the torrents' preferred height, so the cloud never beats the torrent it stands in for. */
export const CLOUD_MAX_HEIGHT = PREFERRED_TORRENT_HEIGHT;

export type CloudStep = { kind: 'cloud'; maxHeight: number };
export type DownloadStep = { kind: 'torrent'; band: TorrentBand } | { kind: 'hash'; infoHash: string } | CloudStep;

export type DownloadPlan = { ok: true; steps: DownloadStep[] } | { ok: false; error: 'torrent_off' | 'cloud_off' | 'no_source'; detail: string };

/** One step that did not give a download: what it was, the code, and what was seen. `step` null: before any step. */
export interface StepFailure {
  step: DownloadStep | null;
  error: string;
  detail: string;
}

/** True on the office network: there a torrent that reaches no peer is asked once more through WARP. */
export function isOffice(ssid: string | null): boolean {
  return ssid === OFFICE_SSID;
}

/** The steps of one download, in order; or why it cannot start here. */
export function planDownload(ask: { via: DownloadVia; infoHash: string | null }, here: { torrent: boolean; cloud: boolean }): DownloadPlan {
  const cloud: CloudStep = { kind: 'cloud', maxHeight: CLOUD_MAX_HEIGHT };
  const torrentOff: DownloadPlan = { ok: false, error: 'torrent_off', detail: 'torrents are off on this machine (NOTESD_TORRENT=off)' };
  if (ask.infoHash !== null) return here.torrent ? { ok: true, steps: [{ kind: 'hash', infoHash: ask.infoHash }] } : torrentOff;
  if (ask.via === 'cloud') return here.cloud ? { ok: true, steps: [cloud] } : { ok: false, error: 'cloud_off', detail: 'the stream cache is off on this machine' };
  if (ask.via === 'torrent') return here.torrent ? { ok: true, steps: [{ kind: 'torrent', band: 'preferred' }, { kind: 'torrent', band: 'below' }] } : torrentOff;
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
 * Why a download failed once every step did: one step's own code; `no_peers_here` when every step reached no peer on
 * the office network (WARP included); `dubbed` when every step found only dubs; else `no_source`. The detail names
 * each step and what it saw.
 */
export function finalFailure(failures: readonly StepFailure[]): { error: string; detail: string } {
  if (failures.length === 0) return { error: 'no_source', detail: 'nothing could be tried' };
  const detail = failures.map((f) => `${stepLabel(f.step)}: ${f.error}${f.detail === '' ? '' : ` (${f.detail})`}`).join('; ');
  if (failures.length === 1) return { error: failures[0]!.error, detail };
  if (failures.every((f) => f.error === 'no_peers_here')) return { error: 'no_peers_here', detail };
  return { error: failures.every((f) => f.error === 'dubbed') ? 'dubbed' : 'no_source', detail };
}
```
**Impact:** `planDownload` loses an input. Its only callers are `StreamDownloads.planOf` (Step 5) and
`plan.test.ts` (Step 12). `DownloadPlan`'s failure no longer carries `no_peers_here`. `StreamDownloads.fail` takes it
as a `string`, so nothing else changes. Phase 3 never calls `planDownload`.

### Step 3: `src/directStream/downloads/types.ts`: the fetch says "no peer at all"
**File:** `src/directStream/downloads/types.ts` (phase 2 Step 5's file), the `TorrentFetch` type and the
`DownloadTorrents` interface.
**Change:** replace phase 2's line
`export type TorrentFetch = { ok: true; handle: KeptTorrentHandle; detail: string } | { ok: false; error: 'no_source' | 'dubbed'; detail: string };`
and its doc comment with:
```ts
/**
 * A torrent step's answer: the torrent now downloading (`detail`: its name and height), or why none could be.
 * `noPeers`: every torrent tried sent no file list (torrentWarp.ts noPeersAtAll), so WARP may reach them on the
 * office network; unset: false.
 */
export type TorrentFetch =
  | { ok: true; handle: KeptTorrentHandle; detail: string }
  | { ok: false; error: 'no_source' | 'dubbed'; detail: string; noPeers?: boolean };
```
In `interface DownloadTorrents`, after phase 2's `fetch(ref: StreamRef, ask: TorrentAsk): Promise<TorrentFetch>;`, insert:
```ts
  /** Forgets the title's torrents whose swarm did not deliver, so the next fetch tries them again (the ask through WARP). */
  forgetNoPeers(ref: StreamRef): void;
```
**Impact:** `torrentDownloadsOf` (Step 6e) and `FakeTorrents` (Step 11) implement the new member. No other
`DownloadTorrents` exists (phase 4's integration test passes `torrents: null`).

### Step 4: `StreamDownloads`: options, the job's hold, fields, constructor
**File:** `src/directStream/downloads/service.ts` (phase 2 Step 7's file as phase 3 Step 6 leaves it)

**4a. Imports.** Add after phase 2's `import { DOWNLOAD_CANCELLED, downloadRef, DownloadsRepo, ... } from './repo.js';`:
```ts
import { noPeersAtAll } from '../torrentWarp.js';
import { WarpRounds, type DownloadWarp, type WarpHold } from './warp.js';
```
and add `type TorrentAsk,` to phase 2's multi-line import from `./types.js` (after `type TorrentFetch,`). Keep `isOffice` in
the import from `./plan.js`: Step 5's `office()` uses it.

**4b. `StreamDownloadsOptions`.** Replace phase 2's member
```ts
  /** The Wi-Fi network's name, or null (none, or it could not be read). Only ever read: a download never switches WARP. */
  ssid: () => Promise<string | null>;
```
with
```ts
  /** The Wi-Fi network's name, or null (none, or it could not be read): decides the office network. Only read here. */
  ssid: () => Promise<string | null>;
  /**
   * Cloudflare WARP as a download may use it (downloads/warp.ts): the stream service's one WarpHolds, shared with
   * torrent plays, and WARP's status; never the switch. Null or unset (NOTESD_STREAM_WARP=off, tests): nothing is
   * switched, and a torrent that reaches no peer on the office network goes on to the next source.
   */
  warp?: DownloadWarp | null;
```

**4c. `Job`.** In phase 2's `interface Job`, after `handle: KeptTorrentHandle | null;`, insert:
```ts
  /** The WARP this download switched on (or joined) to reach its swarm, held until it leaves the swarm; null: none. */
  warp: WarpHold | null;
```

**4d. Fields.** After phase 3's `private pack: SeasonPackJob | null = null;`, insert:
```ts
  /** The office network's WARP round for a torrent step or a season pack (downloads/warp.ts). */
  private readonly warpRounds: WarpRounds;
  /** WARP being let go (a done, cancelled, paused or failed download): `settled` waits for them. */
  private readonly warpBacks = new Set<Promise<void>>();
```

**4e. Constructor.** Directly after phase 2's `this.every = opts.every ?? defaultEvery;` and before phase 3's
`const episodes = opts.seasonEpisodes ?? null;`, insert:
```ts
    this.warpRounds = new WarpRounds({
      warp: opts.warp ?? null,
      office: () => this.office(),
      playing: () => this.opts.playingTorrents().length > 0,
      log: this.log,
    });
```
In phase 3's `new SeasonDownloads<DownloadRequestAnswer>({ ... })` (6c), replace the line
`            office: async () => isOffice(await opts.ssid()),`
with
```ts
            warp: this.warpRounds,
```
**Impact:** `warpRounds` is set before `season`, which reads it. With `opts.warp` unset (every existing test and
phase 4's integration test) a round switches nothing (Decision 9).

### Step 5: `StreamDownloads`: letting go, the queue, the plan
**File:** `src/directStream/downloads/service.ts` (same file)

**5a. `cancel`.** In phase 2's `cancel`, replace the block
```ts
    if (job !== null && job.id === id) {
      this.job = null;
      job.stopped = true;
      if (job.handle !== null) this.opts.torrents?.release(job.handle);
    }
```
with
```ts
    if (job !== null && job.id === id) {
      this.job = null;
      job.stopped = true;
      if (job.handle !== null) this.opts.torrents?.release(job.handle);
      this.letGoWarp(job);
    }
```

**5b. `close`.** In phase 2's `close`, replace the block
```ts
    if (job !== null) {
      job.stopped = true;
      if (job.handle !== null) this.opts.torrents?.release(job.handle);
    }
```
with
```ts
    if (job !== null) {
      job.stopped = true;
      if (job.handle !== null) this.opts.torrents?.release(job.handle);
      // WARP is left as it is, as a torrent play's is at a stop: no warp.mjs runs while the daemon stops.
      job.warp = null;
    }
```

**5c. `settled`.** Replace phase 2's line
`      const waiting = [this.tickRun, this.current].filter((p): p is Promise<void> => p !== null);`
with
```ts
      const waiting = [this.tickRun, this.current, ...this.warpBacks].filter((p): p is Promise<void> => p !== null);
```

**5d. `playFirst`.** In phase 2's part of `playFirst` (after phase 3's pack branch), replace
```ts
    this.job = null;
    job.stopped = true;
    this.opts.torrents?.release(handle);
    await this.opts.repo.setState(this.host, job.id, 'paused', this.now());
```
with
```ts
    this.job = null;
    job.stopped = true;
    this.opts.torrents?.release(handle);
    // A torrent plays on screen: WARP is let go and stays on while that play may play through it.
    this.letGoWarp(job);
    await this.opts.repo.setState(this.host, job.id, 'paused', this.now());
```

**5e. `followTorrent`.** Replace phase 2's lines
```ts
    this.job = null;
    torrents.release(handle);
    const on: DownloadOn = { source: 'torrent', infoHash: handle.infoHash };
```
with
```ts
    this.job = null;
    torrents.release(handle);
    this.letGoWarp(job);
    const on: DownloadOn = { source: 'torrent', infoHash: handle.infoHash };
```

**5f. `startNext`.** Replace the whole method (phase 2's, with phase 3 6h's guards) with:
```ts
  /** The oldest queued or paused download whose first step can run now, started behind this look. */
  private async startNext(): Promise<void> {
    if (this.job !== null || this.pack !== null || this.closed) return;
    const rows = (await this.opts.repo.list(this.host, { states: ['queued', 'paused'] })).filter((r) => !this.clouds.has(r.id));
    if (rows.length === 0) return;
    const at = this.now().getTime();
    const playing = this.opts.playingTorrents().length > 0;
    for (const row of rows) {
      if (this.job !== null || this.pack !== null || this.closed) return;
      if ((this.retries.get(row.id)?.at ?? 0) > at) continue;
      // A torrent download carried on (a pause, a restart) is opened again on every network: on the office network
      // its fetch goes through the WARP round like any torrent step.
      const resumeHash = row.source === 'torrent' ? row.sourceId : null;
      const plan = this.planOf(row);
      if (!plan.ok) {
        await this.fail(row.id, downloadRef(row), [{ step: null, error: plan.error, detail: plan.detail }], null);
        continue;
      }
      // Play first: a torrent download does not start while a torrent plays on screen; a cloud one does.
      if (playing && plan.steps[0]!.kind !== 'cloud') continue;
      const job: Job = { id: row.id, ref: downloadRef(row), handle: null, warp: null, stopped: false, remuxRetried: false, lastBytes: row.bytesDone, sourceHash: resumeHash };
      this.job = job;
      const before = this.pending.get(row.id)?.failures ?? [];
      this.pending.delete(row.id);
      const run = this.run(job, row, plan.steps, before, resumeHash !== null);
      this.current = run;
      void run.finally(() => {
        if (this.current === run) this.current = null;
      });
      return;
    }
  }
```

**5g. `planOf`.** Replace phase 2's method with:
```ts
  /** The steps of a row: what a failed cache left, a carry-on by info hash, a cache followed again, or its whole plan. */
  private planOf(row: StreamDownloadRow): DownloadPlan {
    const pending = this.pending.get(row.id);
    if (pending !== undefined) return { ok: true, steps: pending.steps };
    if (row.source === 'torrent' && row.sourceId !== null) return { ok: true, steps: [{ kind: 'hash', infoHash: row.sourceId }] };
    const full = planDownload({ via: row.via, infoHash: row.infoHash }, { torrent: this.opts.torrents !== null, cloud: this.opts.caches !== null });
    if (row.source === 'cloud' && full.ok) return { ok: true, steps: [{ kind: 'cloud', maxHeight: CLOUD_MAX_HEIGHT }, ...stepsAfterCloud(full.steps)] };
    return full;
  }
```

**5h. Two new private methods**, directly after `planOf`:
```ts
  /** True on the office network (the pinned or read SSID); a network that cannot be read is not the office. */
  private async office(): Promise<boolean> {
    try {
      return isOffice(await this.opts.ssid());
    } catch {
      return false;
    }
  }

  /** Lets go of the WARP a job held, once, behind the caller (warp.mjs may take a minute); `settled` waits for it. */
  private letGoWarp(job: Job): void {
    const hold = job.warp;
    job.warp = null;
    if (hold === null) return;
    const back: Promise<void> = hold.release().finally(() => this.warpBacks.delete(back));
    this.warpBacks.add(back);
  }
```
**Impact:** WARP is let go on every way a held torrent leaves a single download: done (5e), paused for a play (5d),
cancelled (5a), failed after the hold (Step 6 `catch`). It is never let go on a daemon stop (5b, Decision 6). The
cancel route does not wait for `warp.mjs`.

### Step 6: `StreamDownloads.run`, the adapter, `ssidFrom`'s doc, the build
**File:** `src/directStream/downloads/service.ts` (same file)

**6a. `run`.** Replace the whole method (phase 2's, with phase 3 6i's signature and batch hook) with:
```ts
  /** One download's steps, in order, until a torrent is held, the cache took it, or every step failed. Never throws. */
  private async run(job: Job, row: StreamDownloadRow, steps: readonly DownloadStep[], before: readonly StepFailure[], resume: boolean): Promise<void> {
    const failures: StepFailure[] = [...before];
    try {
      await this.opts.repo.setState(this.host, job.id, 'running', this.now());
      // The first row of a season the queue reaches: the season's pack, when one fits, carries every row it holds.
      const seasonRow = this.season === null ? null : seasonRowOf(row);
      if (this.season !== null && seasonRow !== null && seasonRow.batch !== null) {
        const pack = await this.season.take(seasonRow);
        if (pack !== null) {
          if (job.stopped || this.job !== job || this.closed) {
            // Cancelled while the pack was looked for: its rows wait, paused, for the next look. The daemon stopping:
            // closed, so the WARP it may hold is left as it is.
            if (this.closed) await pack.close();
            else await pack.pause();
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
        const ask: TorrentAsk = step.kind === 'hash' ? { infoHash: step.infoHash } : { band: step.band };
        const first = await torrents.fetch(job.ref, ask);
        // On the office network a step that reached no peer at all is asked once more through WARP (downloads/warp.ts).
        const round = await this.warpRounds.round(refLabel(job.ref), first, !first.ok && first.noPeers === true, () => {
          torrents.forgetNoPeers(job.ref);
          return torrents.fetch(job.ref, ask);
        });
        const fetched = round.out;
        if (job.stopped || this.job !== job) {
          if (fetched.ok) torrents.release(fetched.handle);
          job.warp = round.hold;
          if (!this.closed) this.letGoWarp(job);
          return;
        }
        if (!fetched.ok) {
          const noPeersHere = round.office && fetched.noPeers === true;
          failures.push({ step, error: noPeersHere ? 'no_peers_here' : fetched.error, detail: round.note === null ? fetched.detail : `${fetched.detail}; ${round.note}` });
          continue;
        }
        job.handle = fetched.handle;
        job.warp = round.hold;
        this.retries.delete(job.id);
        await torrents.keep(fetched.handle.infoHash, true);
        await this.opts.repo.on(this.host, job.id, { source: 'torrent', infoHash: fetched.handle.infoHash }, this.now());
        this.log(`[notesd] downloads: ${refLabel(job.ref)} downloads from the torrent ${fetched.detail}${job.warp === null ? '' : ' through Cloudflare WARP'}, kept until it is deleted on the Cache page`);
        return;
      }
      if (job.stopped || this.closed) return;
      if (resume && (await this.retryLater(job, failures))) return;
      await this.fail(job.id, job.ref, failures, job.sourceHash);
    } catch (err) {
      if (this.closed || job.stopped) return;
      this.letGoWarp(job);
      this.log(`[notesd] downloads: ${refLabel(job.ref)}: ${messageOf(err)}`);
      await this.fail(job.id, job.ref, [...failures, { step: null, error: 'download_failed', detail: messageOf(err) }], job.sourceHash).catch(() => undefined);
    } finally {
      if (this.job === job && job.handle === null) this.job = null;
      if (this.job === null) void this.tick();
    }
  }
```

**6b. `ssidFrom`'s doc.** Replace phase 2's doc comment
```ts
/**
 * The SSID as a download reads it: warp.mjs's `status`, once a minute at most. Typed to `status` alone, so nothing a
 * download holds can switch WARP. A status that cannot be read is no network (not the office).
 */
```
with
```ts
/**
 * The SSID as a download reads it: warp.mjs's `status`, once a minute at most. A status that cannot be read is no
 * network (not the office). Typed to `status` alone: a download switches WARP only by holding the stream service's
 * WarpHolds (downloads/warp.ts), never through this reader.
 */
```

**6c. The adapter's `fetch`.** In phase 2's `torrentDownloadsOf`, replace the line
`      if (!out.ok) return { ok: false, error: out.error, detail: attemptsText(out.attempts) };`
with
```ts
      if (!out.ok) return { ok: false, error: out.error, detail: attemptsText(out.attempts), noPeers: noPeersAtAll(out.attempts) };
```

**6d. The adapter's `forgetNoPeers`.** In phase 2's `torrentDownloadsOf`, after the `fetch: async (ref, ask) => { ... },`
member and before `now: async (handle) => {`, insert:
```ts
    forgetNoPeers: (ref) => source()?.forgetNoPeers(ref),
```

**6e. `buildStreamDownloads`.** In phase 3 Step 7's `return new StreamDownloads({ ... })`, directly after the line
`    playingTorrents: () => ds.torrentsOnScreen(),`, insert:
```ts
    // The stream service's one WarpHolds, so a play and a download share WARP's holders; null with NOTESD_STREAM_WARP=off.
    warp: ds.warpForDownloads(),
```
**Impact:** the per-episode path, a carried-on torrent and a torrent picked by hand all go through one round per
torrent step. With `warp` null, or off the office network, `round` gives `first` back unchanged, and phase 2's
order is as before (`fetch band:preferred` → `request … 1080` → `fetch band:below`). `buildStreamDownloads`' wiring
type is unchanged: `warp: Pick<WarpSwitch, 'status'>` still feeds `ssidFrom`, and `src/daemon.ts` passes nothing new.

### Step 7: `DirectStreamService.warpForDownloads`
**File:** `src/directStream/service.ts`

**7a.** After line 27 (`import type { WarpSwitch } from '../streaming/warp.js';`), insert:
```ts
import { downloadWarpOf, type DownloadWarp } from './downloads/warp.js';
```

**7b.** After the closing `  }` of `private async throughWarp(...)` (today line 1211; about 20 lines lower once phase 2
Step 4 adds `downloadFacts`/`torrentsOnScreen` near line 582), insert:
```ts

  /**
   * Cloudflare WARP as a torrent download uses it (downloads/warp.ts): this service's one WarpHolds, so a play and a
   * download hold WARP together and the last to let go puts back what this service switched on, plus the switch's
   * status, read only. Never the switch itself: a download cannot `set` WARP. Null with NOTESD_STREAM_WARP=off, or
   * without the automatic flip.
   */
  warpForDownloads(): DownloadWarp | null {
    const warp = this.opts.warp ?? null;
    if (warp === null || !warp.auto || this.warpHolds === null) return null;
    return downloadWarpOf(this.warpHolds, warp.switch);
  }
```
**Impact:** a play's path (`throughWarp`, `torrentThroughWarp`) is untouched. This addition is about 1 000 lines below
phase 2's `downloadFacts`/`torrentsOnScreen` and phase 5's `aheadFetching`, so it merges cleanly beside both.
`npm run typecheck` passes from here.

### Step 8: Comments that said a download never switches WARP
**8a. File:** `src/streaming/warp.ts:27-31`. Replace
```ts
/**
 * Cloudflare WARP on the Windows side. The daemon builds `scriptWarp()`; tests pass a fake. WARP carries the whole
 * machine's traffic: only the owner's switch (the `warp` tool, /warp) and the torrent play on the office network
 * (torrentWarp.ts) call `set`.
 */
```
with
```ts
/**
 * Cloudflare WARP on the Windows side. The daemon builds `scriptWarp()`; tests pass a fake. WARP carries the whole
 * machine's traffic: only the owner's switch (the `warp` tool, /warp) and the stream service's WarpHolds call `set`
 * (torrentWarp.ts: a torrent play, or a torrent download through downloads/warp.ts, on the office network).
 */
```

**8b. File:** `src/config.ts:202-207`. Replace
```ts
  /**
   * `NOTESD_STREAM_WARP`, default on: a torrent play that found no peer at all on the office network
   * (SSID Employee) with Cloudflare WARP off switches it on and asks again
   * (src/directStream/torrentWarp.ts); the streaming command's site retry reads the same variable.
   * `off` or unset in a literal: the daemon never reads or switches WARP for a play.
   */
```
with
```ts
  /**
   * `NOTESD_STREAM_WARP`, default on: a torrent play or a torrent download that found no peer at all on the office
   * network (SSID Employee) with Cloudflare WARP off switches it on and asks again
   * (src/directStream/torrentWarp.ts, src/directStream/downloads/warp.ts); the streaming command's site retry reads
   * the same variable. `off` or unset in a literal: the daemon never switches WARP for a play or a download.
   */
```

**8c. File:** `src/daemon.ts`, phase 2 Step 9's comment over `deps.streamDownloads = buildStreamDownloads(config, {`
(a few lines below phase 5's `new CacheShelf({...})` at 566–576, which this step does not touch). Replace the two lines
```ts
  // Downloads the owner asks for (src/directStream/downloads/): one at a time, a 1080p torrent first, then the cloud
  // cache, kept until deleted on the Cache page. It reads the SSID through warp's status and never switches WARP.
```
with
```ts
  // Downloads the owner asks for (src/directStream/downloads/): one at a time, a 1080p torrent first, then the cloud
  // cache, kept until deleted on the Cache page. It reads the SSID through warp's status; on the office network it
  // holds WARP through the stream service's WarpHolds (directStream.warpForDownloads) to reach a torrent's peers.
```
**Impact:** comments only.

### Step 9: Configuration rows
**File:** `docs/guide/reference/configuration.md`

**9a.** Line 131, the `NOTESD_STREAM_WARP` row. Replace the sentence
`And a torrent play that found no peer at all on the office network (SSID `Employee`) with WARP off switches WARP on and asks once more, leaving it on only when that played (an attempt `WARP` says which); see [streaming.md](../streaming.md#cloudflare-warp-for-torrents).`
with
`And a torrent play that found no peer at all on the office network (SSID `Employee`) with WARP off switches WARP on and asks once more, leaving it on only when that played (an attempt `WARP` says which); see [streaming.md](../streaming.md#cloudflare-warp-for-torrents). A torrent download the owner asked for does the same before it goes on to the cloud, and holds WARP on while its torrent is in the swarm; WARP goes back off when the download is done, paused, failed or cancelled, unless a torrent play or another download still holds it (a torrent playing on screen keeps it on).`

**9b.** Phase 2's two rows after line 145 (`NOTESD_STREAM_DOWNLOADS`, `NOTESD_STREAM_DOWNLOAD_SSID`). Replace both
with:
```markdown
| `NOTESD_STREAM_DOWNLOADS` | on | Downloads the owner asks for: one film or episode at a time, kept on this machine until it is deleted on the Cache page (neither the torrent age prune nor `NOTESD_TORRENT_BUDGET_GB` deletes it). With no source named, a 1080p torrent with live seeds first, then a cloud source at 1080p or lower, then a torrent below 1080p, on every network: on the office network (SSID `Employee`) a torrent that reaches no peer at all is asked once more through Cloudflare WARP (see `NOTESD_STREAM_WARP`) before the next source. A torrent download pauses while a torrent plays on screen, and a restart carries every unfinished download on. It needs `NOTESD_TORRENT` or the stream cache. `off`: nothing is downloaded and what was queued waits. See [streaming.md](../streaming.md#caching-a-film-or-an-episode). |
| `NOTESD_STREAM_DOWNLOAD_SSID` | unset | The Wi-Fi network a download takes this machine to be on, for the office rule (SSID `Employee`: a torrent that reaches no peer at all is asked once more through Cloudflare WARP). Unset: read from Cloudflare WARP's status, at most once a minute. Set: that value is the network and no SSID is read (WARP's own state is still read when a download would switch it). Every `verify.sh` daemon sets it to `verify-home`. |
```
**Impact:** `tests/unit/docs/reference.test.ts` checks that the rows exist. Their names are unchanged, so it passes.
Phase 9 retargets the `#caching-a-film-or-an-episode` anchor (phase 2's handoff, unchanged).

### Step 10: The route's text and the feature map
**10a. File:** `scripts/docs/httpRoutes.ts`, phase 4 Step 4's `'POST /api/stream/downloads'` entry. In its string,
replace the exact text
`then a torrent below 1080p; on the office network the cloud alone)`
with
`then a torrent below 1080p, on every network: on the office network a torrent that reaches no peer is asked once more through Cloudflare WARP first)`
Then run `npm run docs:gen`. It rewrites `docs/guide/reference/http-api.md` (never hand-edited, regenerated and never
merged, as the index's Shared files say). The `direct_stream_cache` description (phase 4 Step 3's `DESCRIPTION`)
says nothing about the office network or WARP, so it is unchanged.

**10b. File:** `.claude/skills/verify-notesd/features/direct-streaming.md:628-633`. Replace the entry's sentence
`only when it played). Proven by `npx vitest run tests/unit/scripts/warp.test.ts tests/unit/streaming.warp.test.ts tests/unit/mcp.warpTool.test.ts tests/unit/directStream/torrentPlay.test.ts``
with
`only when it played). A torrent download the owner asked for gets the same one more ask through WARP before the cloud, holds WARP while its torrent is in the swarm, and lets go when it is done, paused, failed or cancelled (off again unless a torrent play or another download holds it; `src/directStream/downloads/warp.ts`, the stream service's one `WarpHolds`). Proven by `npx vitest run tests/unit/scripts/warp.test.ts tests/unit/streaming.warp.test.ts tests/unit/mcp.warpTool.test.ts tests/unit/directStream/torrentPlay.test.ts tests/unit/directStream/downloads -t "WARP|R1.4|R1.12"``
**Impact:** the feature map names the new behaviour and its proof. Phase 9 adds the downloads entries after this phase
and must keep this sentence.

### Step 11: Test fakes
**File:** `tests/unit/directStream/downloads/fakes.ts` (phase 2 Step 12's file; replace the whole file)
**Code:**
```ts
import type { CacheNow, DownloadCaches, DownloadTorrents, KeptTorrentHandle, TorrentAsk, TorrentFetch, TorrentNow } from '../../../../src/directStream/downloads/types.js';
import { refLabel, type StreamRef } from '../../../../src/directStream/types.js';
import type { WarpState, WarpStatus, WarpSwitch } from '../../../../src/streaming/warp.js';

/**
 * The torrent side, recorded: `fetch band:preferred`, `fetch hash:<h>` (` (WARP)` appended while WARP is on),
 * `forget <ref>`, `keep <h> true`, `release <h>`.
 */
export class FakeTorrents implements DownloadTorrents {
  readonly calls: string[] = [];
  /** What fetch answers, by `band:preferred`, `band:below` or `hash:<info hash>`; unset: no_source. */
  readonly answers = new Map<string, TorrentFetch>();
  /** What fetch answers while WARP is on, by the same keys; unset: `answers`. */
  readonly viaWarp = new Map<string, TorrentFetch>();
  /** Whether WARP is on now (a test points it at its FakeWarp). */
  warpIsOn: () => boolean = () => false;
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
    const warp = this.warpIsOn();
    this.calls.push(`fetch ${key}${warp ? ' (WARP)' : ''}`);
    return (warp ? this.viaWarp.get(key) : undefined) ?? this.answers.get(key) ?? { ok: false, error: 'no_source', detail: 'no torrent fits' };
  }

  forgetNoPeers(ref: StreamRef): void {
    this.calls.push(`forget ${refLabel(ref)}`);
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

/** Cloudflare WARP's switch, recorded: `status`, `on`, `off`. `connects` false: WARP never comes on. */
export class FakeWarp implements WarpSwitch {
  readonly calls: string[] = [];

  constructor(
    public state: { warp: WarpStatus; ssid: string | null },
    private readonly connects = true,
  ) {}

  async status(): Promise<WarpState> {
    this.calls.push('status');
    return { ok: true, ...this.state };
  }

  async set(on: boolean): Promise<WarpState> {
    this.calls.push(on ? 'on' : 'off');
    if (on && !this.connects) return { ok: false, warp: 'disconnected', ssid: this.state.ssid, error: 'did_not_switch' };
    this.state = { ...this.state, warp: on ? 'connected' : 'disconnected' };
    return { ok: true, ...this.state, changed: true };
  }
}
```
**Impact:** phase 2's tests keep passing. WARP is never on in them (the default network is `kosan_baruu`), so no
call gets the ` (WARP)` suffix. Phase 2's integration test and phase 4's import `FakeTorrents` / `FakeCaches`
unchanged in shape.

### Step 12: `plan.test.ts`
**File:** `tests/unit/directStream/downloads/plan.test.ts` (phase 2 Step 13's file; replace the whole file)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { bandAllows, CLOUD_MAX_HEIGHT, finalFailure, isOffice, planDownload, stepsAfterCloud } from '../../../../src/directStream/downloads/plan.js';
import { parseRelease } from '../../../../src/directStream/torrent/find/index.js';

const HERE = { torrent: true, cloud: true };
const H = 'ab'.repeat(20);
const c = (name: string, seeds: number) => ({ seeds, release: parseRelease(name) });

describe('R1.2 planDownload: the order with no source named', () => {
  it('is a 1080p torrent, then the cloud at 1080p or lower, then a torrent below 1080p', () => {
    expect(planDownload({ via: 'auto', infoHash: null }, HERE)).toEqual({
      ok: true,
      steps: [{ kind: 'torrent', band: 'preferred' }, { kind: 'cloud', maxHeight: 1080 }, { kind: 'torrent', band: 'below' }],
    });
    expect(CLOUD_MAX_HEIGHT).toBe(1080);
  });
  it('leaves out a side that is off', () => {
    expect(planDownload({ via: 'auto', infoHash: null }, { ...HERE, torrent: false })).toEqual({ ok: true, steps: [{ kind: 'cloud', maxHeight: 1080 }] });
    expect(planDownload({ via: 'auto', infoHash: null }, { ...HERE, cloud: false })).toEqual({ ok: true, steps: [{ kind: 'torrent', band: 'preferred' }, { kind: 'torrent', band: 'below' }] });
    expect(planDownload({ via: 'auto', infoHash: null }, { torrent: false, cloud: false })).toMatchObject({ ok: false, error: 'no_source' });
  });
  it('downloads only from the source named', () => {
    expect(planDownload({ via: 'cloud', infoHash: null }, HERE)).toEqual({ ok: true, steps: [{ kind: 'cloud', maxHeight: 1080 }] });
    expect(planDownload({ via: 'torrent', infoHash: null }, HERE)).toEqual({ ok: true, steps: [{ kind: 'torrent', band: 'preferred' }, { kind: 'torrent', band: 'below' }] });
    expect(planDownload({ via: 'torrent', infoHash: H }, HERE)).toEqual({ ok: true, steps: [{ kind: 'hash', infoHash: H }] });
  });
  it('goes on after a failed cache to what follows the cloud', () => {
    const plan = planDownload({ via: 'auto', infoHash: null }, HERE);
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

describe('R1.4 planDownload: the same order on every network', () => {
  it('reads SSID Employee as the office', () => {
    expect(isOffice('Employee')).toBe(true);
    expect(isOffice('kosan_baruu')).toBe(false);
    expect(isOffice(null)).toBe(false);
  });
  it('takes no network into the plan: a torrent asked for is planned there too, the 1080p torrent first', () => {
    expect(planDownload({ via: 'torrent', infoHash: H }, HERE)).toEqual({ ok: true, steps: [{ kind: 'hash', infoHash: H }] });
    expect(planDownload({ via: 'auto', infoHash: null }, HERE)).toMatchObject({ ok: true, steps: [{ kind: 'torrent', band: 'preferred' }, { kind: 'cloud' }, { kind: 'torrent' }] });
  });
  it('fails no_peers_here when every torrent step reached no peer, and no_source when the cloud also failed', () => {
    const here = finalFailure([
      { step: { kind: 'torrent', band: 'preferred' }, error: 'no_peers_here', detail: 'through Cloudflare WARP no torrent could be downloaded either' },
      { step: { kind: 'torrent', band: 'below' }, error: 'no_peers_here', detail: '' },
    ]);
    expect(here.error).toBe('no_peers_here');
    expect(here.detail).toBe('torrent 1080p: no_peers_here (through Cloudflare WARP no torrent could be downloaded either); torrent below 1080p: no_peers_here');
    expect(finalFailure([{ step: { kind: 'torrent', band: 'preferred' }, error: 'no_peers_here', detail: '' }, { step: { kind: 'cloud', maxHeight: 1080 }, error: 'no_source', detail: '' }]).error).toBe('no_source');
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

### Step 13: `service.test.ts`
**File:** `tests/unit/directStream/downloads/service.test.ts` (phase 2 Step 14's file)

**13a. Imports.** Replace phase 2's import block (the nine lines from `import { beforeEach, describe, expect, it } from 'vitest';`
to `import { FakeCaches, FakeTorrents } from './fakes.js';`) with:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedSsid, ssidFrom, StreamDownloads } from '../../../../src/directStream/downloads/service.js';
import type { TorrentFetch } from '../../../../src/directStream/downloads/types.js';
import { downloadWarpOf } from '../../../../src/directStream/downloads/warp.js';
import { WarpHolds } from '../../../../src/directStream/torrentWarp.js';
import { refLabel, type StreamRef } from '../../../../src/directStream/types.js';
import type { WarpStatus } from '../../../../src/streaming/warp.js';
import { MemoryDownloadRecords } from '../../../helpers/memoryDownloadRecords.js';
import { FakeCaches, FakeTorrents, FakeWarp } from './fakes.js';
```

**13b. `build`.** Replace phase 2's whole `function build(...) { ... }` with:
```ts
function build(o: { repo?: MemoryDownloadRecords; torrents?: FakeTorrents | null; caches?: FakeCaches | null; ssid?: string | null; warp?: WarpStatus; warpOff?: boolean } = {}) {
  const repo = o.repo ?? new MemoryDownloadRecords();
  const torrents = o.torrents === undefined ? new FakeTorrents() : o.torrents;
  const caches = o.caches === undefined ? new FakeCaches() : o.caches;
  const playing: { hashes: string[] } = { hashes: [] };
  const sw = new FakeWarp({ warp: o.warp ?? 'disconnected', ssid: o.ssid === undefined ? 'kosan_baruu' : o.ssid });
  // The stream service's one WarpHolds: a torrent play asks through the same holders (R1.12).
  const holds = new WarpHolds(sw);
  if (torrents !== null) torrents.warpIsOn = () => sw.state.warp === 'connected';
  const swept: number[] = [];
  const lines: string[] = [];
  const downloads = new StreamDownloads({
    host: 'host-a',
    repo,
    torrents,
    caches,
    ssid: ssidFrom(sw, { ttlMs: 0 }),
    warp: o.warpOff === true ? null : downloadWarpOf(holds, sw),
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
  /** WARP switched on and off, in order (reads left out). */
  const switches = (): string[] => sw.calls.filter((c) => c !== 'status');
  return { downloads, repo, torrents: torrents as FakeTorrents, caches: caches as FakeCaches, playing, sw, holds, switches, swept, lines, drive };
}

/** A torrent fetch whose every swarm sent no file list: no peer at all. */
const NO_PEERS: TorrentFetch = { ok: false, error: 'no_source', detail: 'Torrent: Film.2026.1080p.WEB-DL: no_stream (no file list from the swarm in time)', noPeers: true };

/** On SSID Employee, a 1080p torrent whose peers answer only through WARP. */
function officeThroughWarp() {
  const t = build({ ssid: 'Employee' });
  t.torrents.answers.set('band:preferred', NO_PEERS);
  t.torrents.viaWarp.set('band:preferred', ok(H1));
  t.torrents.viaWarp.set(`hash:${H1}`, ok(H1));
  return t;
}
```

**13c. R1.4.** Replace phase 2's whole `describe('R1.4 the office network', () => { ... });` block (its three tests)
with:
```ts
describe('R1.4 the office network: a torrent download asks again through WARP before the cloud', () => {
  it('switches WARP on once when no peer answered, asks the torrents again, and downloads the 1080p torrent', async () => {
    const t = officeThroughWarp();
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    expect(t.torrents.calls).toEqual(['fetch band:preferred', `forget ${refLabel(FILM)}`, 'fetch band:preferred (WARP)', `keep ${H1} true`]);
    expect(t.switches()).toEqual(['on']);
    expect(t.caches.calls).toEqual([]);
    expect(t.repo.rows[0]).toMatchObject({ state: 'running', source: 'torrent', sourceId: H1 });
  });

  it('opens a torrent download carried on after a restart under the same rule, instead of waiting', async () => {
    const t = officeThroughWarp();
    const { row } = await t.repo.create('host-a', { ref: FILM, via: 'auto', infoHash: null, batch: null }, new Date(clock));
    await t.repo.on('host-a', row.id, { source: 'torrent', infoHash: H1 }, new Date(clock));
    t.torrents.answers.set(`hash:${H1}`, NO_PEERS);
    await t.downloads.start();
    await t.downloads.settled();
    expect(t.torrents.calls).toEqual([`fetch hash:${H1}`, `forget ${refLabel(FILM)}`, `fetch hash:${H1} (WARP)`, `keep ${H1} true`]);
    expect(t.switches()).toEqual(['on']);
    expect(t.repo.rows[0]).toMatchObject({ state: 'running', source: 'torrent', sourceId: H1 });
  });

  it('fails a torrent asked for by hand with no_peers_here once WARP did not reach a peer either', async () => {
    const t = build({ ssid: 'Employee' });
    t.torrents.answers.set('band:preferred', NO_PEERS);
    t.torrents.answers.set('band:below', NO_PEERS);
    await t.downloads.request(FILM, { via: 'torrent' });
    await t.downloads.settled();
    expect(t.switches()).toEqual(['on', 'off', 'on', 'off']);
    expect(t.caches.calls).toEqual([]);
    const [view] = await t.downloads.list();
    expect(view).toMatchObject({ state: 'failed', error: 'no_peers_here' });
    expect(view!.detail).toContain('through Cloudflare WARP');
  });

  it('never touches a WARP the owner turned on: the torrents are asked through it once, then the cloud', async () => {
    const t = build({ ssid: 'Employee', warp: 'connected' });
    t.torrents.answers.set('band:preferred', NO_PEERS);
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    expect(t.torrents.calls).toEqual(['fetch band:preferred (WARP)']);
    expect(t.switches()).toEqual([]);
    expect(t.caches.calls).toEqual([`request ${refLabel(FILM)} 1080`]);
  });

  it('switches nothing with NOTESD_STREAM_WARP=off: the torrent is tried, and the order goes on', async () => {
    const t = build({ ssid: 'Employee', warpOff: true });
    t.torrents.answers.set('band:preferred', NO_PEERS);
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    expect(t.torrents.calls).toEqual(['fetch band:preferred']);
    expect(t.switches()).toEqual([]);
    expect(t.caches.calls).toEqual([`request ${refLabel(FILM)} 1080`]);
  });

  it('asks nothing again on another network', async () => {
    const t = build({ ssid: 'kosan_baruu' });
    t.torrents.answers.set('band:preferred', NO_PEERS);
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    expect(t.torrents.calls).toEqual(['fetch band:preferred']);
    expect(t.switches()).toEqual([]);
    expect(t.caches.calls).toEqual([`request ${refLabel(FILM)} 1080`]);
  });
});

describe('R1.4 R1.12 switching WARP on did not reach a peer', () => {
  it('puts WARP back off, and only then goes on to the cloud', async () => {
    const t = build({ ssid: 'Employee' });
    t.torrents.answers.set('band:preferred', NO_PEERS);
    const warpAtCloud: string[] = [];
    const request = t.caches.request.bind(t.caches);
    t.caches.request = async (ref, maxHeight) => {
      warpAtCloud.push(t.sw.state.warp);
      return request(ref, maxHeight);
    };
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    expect(t.torrents.calls).toEqual(['fetch band:preferred', `forget ${refLabel(FILM)}`, 'fetch band:preferred (WARP)']);
    expect(t.switches()).toEqual(['on', 'off']);
    expect(warpAtCloud).toEqual(['disconnected']);
    expect(t.holds.ours).toBe(false);
    expect(t.repo.rows[0]).toMatchObject({ state: 'running', source: 'cloud' });
  });
});

describe('R1.12 a download lets go of the WARP it held', () => {
  it('puts WARP back off when the download is done', async () => {
    const t = officeThroughWarp();
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    expect(t.switches()).toEqual(['on']);
    t.torrents.whole.add(H1);
    await t.drive();
    expect(t.repo.rows[0]).toMatchObject({ state: 'done', source: 'torrent', sourceId: H1 });
    expect(t.switches()).toEqual(['on', 'off']);
    expect(t.holds.ours).toBe(false);
  });

  it('puts WARP back off when the download is cancelled', async () => {
    const t = officeThroughWarp();
    const asked = await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    await t.downloads.cancel(asked.download!.id);
    await t.downloads.settled();
    expect(t.switches()).toEqual(['on', 'off']);
    expect(t.holds.ours).toBe(false);
  });

  it('keeps WARP on when it pauses for a torrent playing on screen, and opens its torrent again through it after', async () => {
    const t = officeThroughWarp();
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    t.playing.hashes = [OTHER];
    await t.drive();
    expect((await t.downloads.list())[0]).toMatchObject({ state: 'paused', source: 'torrent', source_id: H1 });
    expect(t.switches()).toEqual(['on']);
    expect(t.holds.ours).toBe(false);
    t.playing.hashes = [];
    await t.drive();
    expect(t.torrents.calls.slice(-2)).toEqual([`fetch hash:${H1} (WARP)`, `keep ${H1} true`]);
    expect(t.switches()).toEqual(['on']);
    expect(t.repo.rows[0]).toMatchObject({ state: 'running' });
  });

  it('leaves WARP on while a torrent play still holds it, and the play letting go puts it back off', async () => {
    const t = officeThroughWarp();
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    // A torrent play asks through the same WARP: it joins the holders and switches nothing.
    expect(await t.holds.hold()).toMatchObject({ warp: 'connected' });
    t.torrents.whole.add(H1);
    await t.drive();
    expect(t.repo.rows[0]).toMatchObject({ state: 'done' });
    expect(t.switches()).toEqual(['on']);
    expect(await t.holds.release(false)).toMatchObject({ warp: 'disconnected' });
    expect(t.switches()).toEqual(['on', 'off']);
  });

  it('leaves WARP as it is when the daemon stops, as a torrent play’s WARP is', async () => {
    const t = officeThroughWarp();
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    await t.downloads.close();
    await t.downloads.settled();
    expect(t.switches()).toEqual(['on']);
    expect(t.repo.rows[0]).toMatchObject({ state: 'running', sourceId: H1 });
  });
});
```
Phase 2's last block, `describe('R1.4 the SSID pinned by NOTESD_STREAM_DOWNLOAD_SSID', ...)`, stays as it is.
**Impact:** `ok`, `H1`, `OTHER`, `FILM` and `clock` are phase 2's constants, declared above `build`. Every other phase 2
test runs on `kosan_baruu` with WARP off and is unchanged.

### Step 14: `season.ts`: a season pack through WARP
**File:** `src/directStream/downloads/season.ts` (phase 3 Step 5's file)

**14a. Imports.** After phase 3's `import type { DownloadFacts, DownloadVia } from './types.js';`, add:
```ts
import { noPeersAtAll } from '../torrentWarp.js';
import type { WarpHold, WarpRounds } from './warp.js';
```

**14b. `SeasonDownloadsDeps`.** Replace phase 3's member
```ts
  /** True on the office network (SSID `Employee`): no pack is opened there; the per-episode path applies the office rule. */
  office(): Promise<boolean>;
```
with
```ts
  /**
   * The office network's WARP round (downloads/warp.ts): a pack whose every swarm sent no file list is looked for once
   * more with WARP on, and the job holds WARP until it is done. Null or unset: no round (NOTESD_STREAM_WARP=off, tests).
   */
  warp?: WarpRounds | null;
```

**14c. `take`.** Replace phase 3's whole `take` (its doc comment and body) with:
```ts
  /**
   * The queue reached `row` (phase 2's `run`, before its own steps). For the first row of a batch asked `auto` or
   * `torrent` the queue reaches, the batch's season pack is looked for, on every network. On the office network, a
   * pack search whose every swarm sent no file list is asked once more through Cloudflare WARP, and the job holds WARP
   * while it downloads. With a pack, the answer is the job that downloads every row it holds. The queue keeps it as its
   * one torrent job, lets it go while a torrent plays, and cancels one of its rows through it. A batch is looked at
   * once per daemon run, except when two or more of its rows still name one torrent as their source (a pack that
   * carried them before a pause or a restart). That pack is opened again by its info hash, with no index asked. Null:
   * the row downloads on its own (a film, a cloud download, a torrent picked by hand, no pack, a batch already looked
   * at).
   */
  async take(row: SeasonRow): Promise<SeasonPackJob | null> {
    const { packs, swarm } = this.deps;
    if (row.batch === null || row.via === 'cloud' || row.infoHash !== null || packs === null || swarm === null) return null;
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
    const ask = (): Promise<PackFetch> =>
      packs.fetch(
        row.ref.tmdbId,
        row.ref.season,
        open.map((r) => r.ref.episode),
        { heights: row.via === 'auto' ? 'preferred' : 'any', known },
      );
    const first = await ask();
    const round = this.deps.warp == null ? null : await this.deps.warp.round(label, first, !first.ok && noPeersAtAll(first.attempts), ask);
    const fetched = round?.out ?? first;
    const hold: WarpHold | null = round?.hold ?? null;
    if (!fetched.ok) {
      this.log(`[notesd] downloads: ${label}: no season pack${round?.note == null ? '' : ` (${round.note})`}; ${open.length} episode(s) download one by one`);
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
      // fetchPack took one hold per episode it holds: every one is given back, and WARP with them.
      for (let i = 0; i < pack.episodes.length; i += 1) await swarm.release(pack.infoHash).catch(() => undefined);
      await hold?.release();
      this.log(`[notesd] downloads: ${label}: the season pack ${pack.name} could not be recorded (${messageOf(err)}); each episode downloads on its own`);
      return null;
    }
    this.log(`[notesd] downloads: ${label}: ${carried.length} episode(s) from the season pack ${pack.name}${hold === null ? '' : ' through Cloudflare WARP'}${pack.lacking.length === 0 ? '' : `; ${pack.lacking.map((e) => `E${pad(e)}`).join(', ')} on their own`}`);
    return new SeasonPackJob({
      pack,
      carried,
      rows: this.deps.rows,
      swarm,
      warp: hold,
      ...(this.deps.finish === undefined ? {} : { finish: this.deps.finish }),
      now: () => this.now().getTime(),
      sleep: this.sleep,
      pollMs: PACK_POLL_MS,
      stallMs: PACK_STALL_MS,
      log: this.log,
    });
  }
```

**14d. `SeasonPackJobParts`.** After phase 3's `swarm: PackSwarm;` member, insert:
```ts
  /** The WARP this pack went ahead through (downloads/warp.ts), let go when the job ends; null: none. */
  warp?: WarpHold | null;
```

**14e. `SeasonPackJob`.** After phase 3's field `private stopped = false;`, insert:
```ts
  /** The daemon stops: the WARP this pack holds is left as it is. */
  private closing = false;
```
Replace phase 3's `pause` and `close` with:
```ts
  /**
   * A torrent plays on screen (phase 2's play first): the pack lets go of its swarm and every row it still carries waits
   * `paused`, the pack still its source. The WARP it held is let go at once (it stays on while that play may play
   * through it). When the play ends the queue reaches them again and `take` opens the same pack by its info hash.
   */
  async pause(): Promise<void> {
    const left = this.letGo();
    await this.p.warp?.release();
    for (const c of left) await this.p.rows.paused(c.row.id);
  }

  /**
   * The daemon stops: every hold is let go; the rows stay running, and the next start carries them on from disk.
   * WARP is left as it is, as a torrent play's is at a stop.
   */
  async close(): Promise<void> {
    this.closing = true;
    this.letGo();
  }
```
Replace phase 3's `run` with:
```ts
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
    } finally {
      // Done, failed, cancelled or paused: the WARP this pack held is let go (back off unless a play or another holder
      // keeps it). A daemon stop leaves it as it is.
      if (!this.closing) await this.p.warp?.release();
    }
  }
```
**14f. The engine's wiring** of `warp` into `SeasonDownloads` is Step 4e.
**Impact:** the office network no longer keeps a season from its pack. `WarpHold.release` never throws and runs at
most once, so `done` still never rejects. Phase 3's tests that pass no `warp` behave as before.

### Step 15: Phase 3's tests
**15a. File:** `tests/unit/directStream/downloads/season.test.ts` (phase 3 Step 10's file).

Imports: after phase 3's `import type { StreamRef } from '../../../../src/directStream/types.js';`, add:
```ts
import { downloadWarpOf, WarpRounds } from '../../../../src/directStream/downloads/warp.js';
import { NO_FILE_LIST } from '../../../../src/directStream/torrent/source.js';
import { WarpHolds } from '../../../../src/directStream/torrentWarp.js';
import { FakeWarp } from './fakes.js';
```

Replace phase 3's whole `function setup(...) { ... }` with:
```ts
function setup(o: { episodes?: SeasonEpisode[] | null; whole?: number[]; pack?: PackFetch; packThroughWarp?: PackFetch; sw?: FakeWarp; warp?: WarpRounds | null } = {}) {
  const rows = new MemoryRows();
  const swarm = new FakeSwarm();
  const fetches: { episodes: number[]; heights: string; known: string | null }[] = [];
  const packs: SeasonPacks = {
    fetch: async (_tmdbId, _season, episodes, options) => {
      fetches.push({ episodes: [...episodes], heights: options.heights, known: options.known ?? null });
      if (o.sw?.state.warp === 'connected' && o.packThroughWarp !== undefined) return o.packThroughWarp;
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
    warp: o.warp ?? null,
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

/** WARP on the office network, as the engine builds the round (downloads/warp.ts). */
function officeWarp(playing: () => boolean = () => false) {
  const sw = new FakeWarp({ warp: 'disconnected', ssid: 'Employee' });
  const holds = new WarpHolds(sw);
  const warp = new WarpRounds({ warp: downloadWarpOf(holds, sw), office: async () => true, playing, log: () => undefined });
  return { sw, holds, warp, switches: (): string[] => sw.calls.filter((c) => c !== 'status') };
}

/** A pack search whose one pack's swarm sent no file list: no peer at all. */
const PEERLESS: PackFetch = { ok: false, error: 'no_pack', attempts: [{ provider: 'Torrent: Fixture.Show.S01.1080p', outcome: 'no_stream', took_s: 20, detail: `${NO_FILE_LIST} (timed out)` }] };
```

Replace phase 3's test
`  it('looks for no pack for a cloud download, a torrent picked by hand, or on the office network', async () => { ... });`
(the whole `it`, eight lines) with:
```ts
  it('looks for no pack for a cloud download or a torrent picked by hand', async () => {
    const cloud = setup({ pack: packOf([1, 2, 3]) });
    expect(await cloud.seasons.take((await queued(cloud, 'cloud'))[0]!)).toBeNull();
    const picked = setup({ pack: packOf([1, 2, 3]) });
    expect(await picked.seasons.take(picked.rows.add(1, 'torrent', 'b-hand', PACK))).toBeNull();
    expect([...cloud.fetches, ...picked.fetches]).toEqual([]);
  });
```

Append after phase 3's `describe('SeasonPackJob', ...)` block:
```ts
describe('R1.4 a season pack on the office network', () => {
  it('is looked for there too, and switches nothing when its swarm answers', async () => {
    const w = officeWarp();
    const s = setup({ pack: packOf([1, 2, 3]), sw: w.sw, warp: w.warp });
    const job = await s.seasons.take((await queued(s))[0]!);
    expect(job?.rowIds).toEqual(['d1', 'd2', 'd3']);
    expect(s.fetches).toHaveLength(1);
    for (const index of [0, 1, 2]) s.swarm.wholeFiles.add(index);
    await job!.done;
    expect(w.switches()).toEqual([]);
  });

  it('switches WARP on once when the pack sent no file list, takes the pack through it, and puts WARP back off when the pack is done', async () => {
    const w = officeWarp();
    const s = setup({ pack: PEERLESS, packThroughWarp: packOf([1, 2, 3]), sw: w.sw, warp: w.warp });
    const job = await s.seasons.take((await queued(s))[0]!);
    expect(s.fetches).toHaveLength(2);
    expect(job?.rowIds).toEqual(['d1', 'd2', 'd3']);
    expect(w.switches()).toEqual(['on']);
    for (const index of [0, 1, 2]) s.swarm.wholeFiles.add(index);
    await job!.done;
    expect(s.rows.stored.map((r) => r.state)).toEqual(['done', 'done', 'done']);
    expect(w.switches()).toEqual(['on', 'off']);
    expect(w.holds.ours).toBe(false);
  });
});

describe('R1.4 R1.12 a season pack WARP did not help', () => {
  it('puts WARP back off, and the episodes download one by one', async () => {
    const w = officeWarp();
    const s = setup({ pack: PEERLESS, sw: w.sw, warp: w.warp });
    expect(await s.seasons.take((await queued(s))[0]!)).toBeNull();
    expect(s.fetches).toHaveLength(2);
    expect(w.switches()).toEqual(['on', 'off']);
    expect(s.rows.stored.map((r) => r.state)).toEqual(['queued', 'queued', 'queued']);
  });
});

describe('R1.12 a season pack paused for a torrent playing on screen', () => {
  it('lets go of WARP at once, and WARP stays on for the play', async () => {
    let playing = false;
    const w = officeWarp(() => playing);
    const s = setup({ pack: PEERLESS, packThroughWarp: packOf([1, 2, 3]), sw: w.sw, warp: w.warp });
    const job = (await s.seasons.take((await queued(s))[0]!))!;
    playing = true;
    await job.pause();
    await job.done;
    expect(s.rows.stored.map((r) => r.state)).toEqual(['paused', 'paused', 'paused']);
    expect(w.switches()).toEqual(['on']);
    expect(w.holds.ours).toBe(false);
  });
});
```

**15b. File:** `tests/integration/directStream.seasonDownloads.int.test.ts` (phase 3 Step 11's file). Delete the line
`      office: async () => false,`
from its `new SeasonDownloads({ ... })`. `SeasonDownloadsDeps` has no `office` member any more, so the literal would
not typecheck.
**Impact:** every other phase 3 test is unchanged. It passes no `warp`, so `take` makes no round.

## Principles applied

- Subtract before you add: the office branches of `planDownload`, `planOf`'s `office` input, `startNext`'s wait of a
  carried-on torrent, `SeasonDownloadsDeps.office` and `take`'s early return are deleted (Steps 2, 5f, 5g, 14b, 14c)
  before the WARP round is added. The order is one list with no network in it again.
- Laziness protocol: the round reuses `noPeersAtAll`, `OFFICE_SSID`, `TorrentSource.forgetNoPeers` and the stream
  service's existing `WarpHolds`. `torrentWarp.ts` gets no new parameter: `torrentThroughWarp` lets go at the end of its
  own ask, so a sibling `WarpRounds.round` (Step 1) keeps the same checks and hands back a hold. `buildStreamDownloads`'
  wiring and `src/daemon.ts`'s call are unchanged: the port comes from `ds.warpForDownloads()`.
- Make illegal states unrepresentable: the engine gets `DownloadWarp`, which has no `set` (Step 1, Step 7). This
  replaces phase 2's "no `WarpSwitch` in the engine" with an equally typed guarantee. A `WarpHold` releases once by
  construction. `noPeers` exists only on `TorrentFetch`'s failure branch (Step 3).
- Boundary discipline: "office" is decided in one place, the SSID seam (`NOTESD_STREAM_DOWNLOAD_SSID` or WARP's status,
  through `StreamDownloads.office()`). The round trusts the boolean, and WARP's own state is read only after that says
  office.
- Test behavior, not implementation: the new tests assert what the switch was told (`on`/`off` in order), what was
  fetched, and the rows' states and codes, over a real `WarpHolds` and a fake switch. No private member is mocked.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` and `npm run test:int -- tests/integration/directStream.seasonDownloads.int.test.ts`
**Proof:** WARP carries the whole machine's traffic. CLAUDE.md forbids a test or a throwaway daemon to switch it, and
every `verify.sh` daemon pins `NOTESD_STREAM_WARP=off` and `NOTESD_STREAM_DOWNLOAD_SSID=verify-home`. So the proof is
the real engine (`StreamDownloads`, `SeasonDownloads`, `SeasonPackJob`, `WarpRounds`) over the real `WarpHolds` that
plays use, with a fake switch, a fake swarm and a fake cache at the seams. The order and every `on`/`off` sent to the
switch are asserted.
- Harness: `.claude/skills/verify-notesd` exists, but it cannot reach this behaviour (it pins WARP off and the SSID
  to a home network on purpose, so no journey drives a throwaway daemon). The journeys are `vitest` runs.
- Feature-map entries: `.claude/skills/verify-notesd/features/direct-streaming.md` (the Cloudflare WARP entry, Step 10b)
- Journeys:
  - **J1** · traces R1.4 — `npx vitest run tests/unit/directStream/downloads -t "R1.4"` → passes when vitest reports 0 failed and at least 14 passed (plan 3, engine 8, season 3). Those tests show the following. On SSID `Employee` a 1080p download whose swarm sent no file list makes the calls `fetch band:preferred`, `forget <film>`, `fetch band:preferred (WARP)`, `keep <h> true`, with the switch told `on` once and no cloud request. A download carried on after a restart there is opened again by its hash through WARP instead of waiting. A torrent asked for by hand lists `{state: 'failed', error: 'no_peers_here'}` with the switch told `on, off, on, off`. When WARP did not help it is `off` before the cloud is asked (`warpAtCloud` = `['disconnected']`). A WARP the owner turned on, `NOTESD_STREAM_WARP=off`, and another network each switch nothing and go on to `request <film> 1080`. A season pack whose swarm sent no file list is looked for twice and taken through WARP. The plan is the same order with no network in it.
  - **J2** · traces R1.12 — `npx vitest run tests/unit/directStream/downloads -t "R1.12"` → passes when vitest reports 0 failed and at least 8 passed (engine 6, season 2). The switch is told `on, off` when the download is done, when it is cancelled, when switching did not reach a peer (single and season pack), and when a pack is done. It stays `on` when the download pauses for a torrent playing on screen (and the download reopens its torrent by hash through it), and while a play still holds `WarpHolds` (then `off` when the play lets go). It is never `off` on `close()`. `holds.ours` is false after every letting go.
  - **J3** · traces R1.4 — `npm run docs:check && ! grep -n "WARP is never switched for a download\|on the office network the cloud alone" docs/guide/reference/configuration.md docs/guide/reference/http-api.md scripts/docs/httpRoutes.ts` → passes when `docs:check` exits 0 and `grep` finds nothing. The configuration rows and the generated route reference name the WARP round instead of the old rule.
- Neighbor check: a torrent play's WARP rule is unchanged. Run `npx vitest run tests/unit/streaming.warp.test.ts tests/unit/directStream/torrentPlay.test.ts && git diff --stat 72283db -- src/directStream/torrentWarp.ts claude/streaming/warp.mjs`. It passes when vitest reports 0 failed (among them "with the flip: switches WARP on, asks again, and keeps it on when that played", "stays on when one of them played through it, though the other found nothing", "never switches off a WARP the owner turned on, whatever the asks find", and torrentPlay's "with the flip: WARP on, the same torrent asked again, and it plays") and `git diff --stat` prints nothing: neither file differs from the set's base.
- Cost: none. No model call, no network, no real WARP switch.

**Exit criteria:** `npm run typecheck`, `npm test` and the season integration test pass. J1–J3 and the neighbor check
pass. No file under `src/directStream/downloads/` names `WarpSwitch['set']` or calls `.set(`
(`grep -rn "\.set(" src/directStream/downloads/warp.ts` finds nothing).

## Handoffs

- **Phase 9 (runs after this phase):** these texts still state the old rule and must state the new one. They are
  CLAUDE.md's WARP rule (add "a torrent download the owner asked for" to the list; a download holds WARP while its
  torrent is in the swarm and lets go when done, paused, failed or cancelled), `docs/guide/streaming.md` "Cloudflare
  WARP for torrents" (lines 2229–2259: a download's round, its hold, the shared `WarpHolds`, the stop) and
  "Downloading a title", and the rules-in-the-code bullet (line 2891). Phase 9's own plan also holds old-rule text:
  `phase-9.md` lines 354, 414–415 and 565–566 (the `downloads.sh` `INCONCLUSIVE` guard on `no_peers_here` can stay,
  with the reason "the run read the office SSID": the pin still makes it unreachable), 540–541, 926–928, 966 (the
  `no_peers_here` row: "a torrent asked for on the office network reached no peer, even through Cloudflare WARP"),
  978, 989, 1032, 1116 (`never for a cloud stream or a download,` becomes "never for a cloud stream"), 1119. Keep
  this phase's sentence in `features/direct-streaming.md`'s WARP entry when adding the downloads entries.
- **Reconciler (index):** the index's R1.4 row must take the new text and journeys (`P10.J1`, `P10.J3`, phase 10).
  R1.12 needs a row (`P10.J2`, phase 10). Invariant 6 ("WARP is never switched by a download") and the Decisions row
  "Office network: ... Straight to cloud on SSID `Employee`; WARP never switched for a download" are overturned by the
  owner and must be rewritten. Phase 2's plan text must be marked superseded where this phase replaces it (list
  below).
- **Superseded in `phase-2.md`** (this phase replaces them; the implementer of phase 2 may write them as planned):
  line 15 (Goal: "On SSID `Employee` it goes straight to the cloud and never touches WARP"); Step 6's `plan.ts` office
  text and code, lines 586–588, 597, 606–629; Step 7's `ssid` option doc, lines 729–730; `startNext`, lines
  1016–1024; `planOf`, lines 1045–1051; `run`'s torrent fetch, lines 1071–1079; `ssidFrom`'s doc, lines 1221–1224;
  the adapter's failure line 1277; Step 8's two configuration rows, lines 1395–1396; Step 9's daemon comment,
  line 1430; Step 12's `FakeTorrents`, lines 1505–1554; Step 13's `HOME`/`OFFICE`, lines 1603–1604, the inline
  literal on line 1619, and the R1.4 block, lines 1654–1671; Step 14's imports and `build`, lines 1692–1747, and the
  R1.4 block, lines 1793–1824 (the pinned-SSID test at 2042–2046 stays); Principles line 2441 (the "no `WarpSwitch`"
  guarantee); Verification **J2**, line 2456.
- **Superseded in `phase-3.md`:** `SeasonDownloadsDeps.office`, lines 607–608; `take`, lines 798–859; `pause`/`close`,
  lines 904–917; `run`, lines 949–960; 6c's `office:` line 1067; 6i's stop branch, lines 1157–1160; the test
  `setup`, lines 1598–1626 (with 1616); the office test, lines 1721–1729; the integration line 1904.
- **Superseded in `phase-4.md`:** the phrase `; on the office network the cloud alone)` in the
  `'POST /api/stream/downloads'` description, line 707.
- **Phase 8 (no change needed):** its `no_peers_here: 'no torrent peers on this network'` label stays true. The code
  now means "no peer even through WARP".
- **Not done here:** the season pack and the single episodes it lacks each run their own round. After a pack let go of
  WARP, a lacking episode that finds no peer switches it on again. Merging the two holds would need a hold that
  outlives the job and is left out. Also left out: `torrentWarp.ts`' `WarpHolds` doc still says "torrent asks" (its
  text is out of this phase's scope).

## Rollback

Revert this phase's commit. Phase 2's and phase 3's code, tests and texts come back as their plans wrote them (the
old office rule: cloud alone on `Employee`, WARP never switched for a download). Nothing in the database changes. If
WARP was left on by a download when the daemon stopped, `/warp off` turns it off.
