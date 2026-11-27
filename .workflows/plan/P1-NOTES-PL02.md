> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/stream-play-log/PLAN.md` phase 2. Source: `/home/miftah/mcp-notes/.workflows/orchestration/stream-play-log/phase-2.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 2: Player page counters

**Plan set:** `STREAM_PLAY_LOG_PLAN.md`
**Analysis:** `.workflows/analyze/20261127-081756-PL7K_code_analyzer.md`
**Satisfies:** R1 — the per-play record; this phase gives it the page's own measurements
**Criteria:** R1.6
**Depends on:** none
**Difficulty:** NORMAL
**Package:** `web/src/stream`

---

## Goal

Every position report the player page posts (`POST /api/stream/sessions/:id/position`), the plain
5 s one, the pause, the `beat`, `ended` and `closed` ones, carries a `stats` object: a random id of
this page load of this session and the page's counters since then (first-frame time, played time,
stalls and stalled time, torrent waits and waited time, engine errors). The counters are measured
with a monotonic clock (`performance.now()`, injected in tests), never the wall clock. Nothing else
the page does changes: no stall-to-switch rule, no evidence line, no 2 px rule.

## Interface Contract

**Deletes:** nothing
**Renames:** nothing
**Creates:**
- `PlayStatsReport` (type, `web/src/stream/session.ts`) — the wire shape of `stats`
- `PlayStats` class, `newLoadId()`, `PLAYED_GAP_MAX_MS` (`web/src/stream/playStats.ts`, new)
- `ControllerDeps.now?: () => number` (`web/src/stream/controller.ts`) — monotonic ms clock, default `() => performance.now()`
- `.claude/skills/verify-notesd/scripts/stream/play-stats.steps.mjs` (new Playwright drive)

**Signature changes:** `PositionReport` gains a required `stats: PlayStatsReport` (the page always sends it; `postPosition` is its only caller).

**The exact body the page posts** (every report kind; `beat`/`closed`/`ended` keys unchanged):

```json
{
  "position_s": 312.4,
  "duration_s": 1440,
  "ended": false,
  "paused": false,
  "stats": {
    "load": "Qx3_k9LmA-2bZt7W",
    "first_frame_ms": 1840,
    "played_ms": 61250,
    "stalls": 2,
    "stalled_ms": 4100,
    "waits": 1,
    "waited_ms": 9000,
    "errors": 0
  }
}
```

- `load`: 16 characters of `[A-Za-z0-9_-]` (inside the contract's 8-32), from `crypto.getRandomValues`.
  A new id, with every counter at zero, is made when the page loads, and again when the same page
  starts playing **another session** without reloading (the episode buttons, `goToEpisode`; the
  carry-on into a fresh session after a daemon restart, `swapTo`). A source switch inside the same
  session (`moveTo`, a refresh) keeps the id and the counters. So one `load` id never spans two
  sessions, and phase 1 can keep the latest `stats` per `(session, load)` and sum over loads.
- Every number is a non-negative integer, cumulative since that load, and never decreases from one
  report to the next under the same `load` (open stalls and waits are included up to the report's
  moment). `first_frame_ms` is `null` until the first frame.
- `first_frame_ms`: ms from the page load (the controller's construction, or the session change
  above) to the first `playing` event while the film is on the page and not paused.
- `played_ms`: the sum of the gaps between consecutive `timeupdate`s while the film is on the page,
  not paused, not ended, the position moved forward by at most 2 s, each gap capped at 1 000 ms. A
  `waiting` resets the count, so time stood still is never counted as played.
- `stalls`: one per freeze the page's existing stall timer confirms (`stalled at N s` evidence line,
  `STALL_MIN_MS`, plus the seek grace). A freeze the timer confirms again every `STALL_REPEAT_MS`
  is still one stall. A freeze during which the torrent is fetching a missing part is a wait, not a
  stall. A pause, a seek's own wait within the grace, a wait shorter than `STALL_MIN_MS` and the
  first load (stage not `ready`) are not stalls.
- `stalled_ms`: for each counted stall, from the first `waiting` event of that freeze until the
  film moves again (`playing`), is sought, paused, or the page plays another session.
- `waits` / `waited_ms`: each time the page writes `waiting for the torrent at N s` (the
  `fetching` mark turns on) is one wait, timed until the mark turns off (the part arrived, the
  film moved, or the source changed).
- `errors`: each network error the engine starts riding out (`onRecovering` with `attempt === 1`)
  and each stream the engine declared broken (`onFatal`). The page's own `fail()` is not counted:
  after it the page reports nothing more, so the count could never reach the daemon.

**Requires (from earlier phases):** nothing. Phase 1's `positionBody.stats` is optional; a server
without it (today's `positionBody` is a non-strict zod object) drops the key, so this phase is safe
to land alone.
**Leaves alone (owned by others):** all of `src/` (phase 1 parses `stats`, sums over `load` ids,
writes `stream_play_log`); `docs/guide/streaming.md` ("The play log", phase 1); the stall-to-switch
rules (`STALLS_TO_SWITCH`, `TORRENT_STALLS_TO_SWITCH`, `STALL_WINDOW_MS`, `STALL_REPEAT_MS`,
`SEEK_GRACE_MS`, `MAX_SOURCE_SWITCHES`, `SOURCE_SWITCH_COOLDOWN_MS`, `countStall`, `changeSource`,
and their `Date.now()` reads); every `note()` text; `StreamApp.tsx` (the default clock lives in the
controller, so `browserDeps()` needs no change).

## Files

| File | Action | What changes |
|---|---|---|
| `web/src/stream/session.ts:100` | modify | `PlayStatsReport` type; `PositionReport.stats` |
| `web/src/stream/playStats.ts` | create | the counters (`PlayStats`) and `newLoadId` |
| `web/src/stream/controller.ts:46,259,335,337,461,839,845,872,885,894,903,914,991,1159,1329,1430,1444,1464` | modify | a `PlayStats` per page load of a session, fed by the existing video events and stall timer; `stats` in `report()` |
| `web/src/stream/playStats.test.tsx` | create | the counters' arithmetic and the load id |
| `web/src/stream/controller.test.tsx:17,35,1834` | modify | `setup` takes `now`; `posts()` leaves `stats` out of position bodies; new describe for R1.6 |
| `.claude/skills/verify-notesd/scripts/stream/play-stats.steps.mjs` | create | real-page drive that reads the posted `stats` |
| `.claude/skills/verify-notesd/features/direct-streaming.md:55` | modify | one bullet: the page's counters and their proof (phase 1 edits the same file at :821 only; see Handoffs) |

## Implementation Steps

### Step 1: The wire type
**File:** `web/src/stream/session.ts:100` (replace the whole `PositionReport` interface, lines 100-110)
**Change:** add the `stats` shape next to the report it rides on.
**Code:**
```ts
/**
 * What the page measured of its play since it loaded this session (stream-play-log R1.6). Every
 * number is cumulative since that load and never goes down under the same `load`; the daemon keeps
 * the latest per load and sums over loads.
 */
export interface PlayStatsReport {
  /** A random id of this page load of this session: 16 characters of [A-Za-z0-9_-]. */
  load: string;
  /** Page load to the first frame moving; null until then. */
  first_frame_ms: number | null;
  /** Time the film advanced. */
  played_ms: number;
  /** Freezes the page's stall timer confirmed (a torrent's wait for a missing part is not one). */
  stalls: number;
  /** From the moment each counted freeze began until the film moved again. */
  stalled_ms: number;
  /** "waiting for the torrent" waits. */
  waits: number;
  waited_ms: number;
  /** Network errors the engine rode out (one per episode) and streams it declared broken. */
  errors: number;
}

export interface PositionReport {
  position_s: number;
  duration_s: number | null;
  ended: boolean;
  /** The film is paused: the Movies page shows "paused" on its poster. */
  paused: boolean;
  /** Sent only to say the paused page is still open; the position did not move. */
  beat?: boolean;
  /** The page is closing: its last report. */
  closed?: boolean;
  /** The page's counters since it loaded this session; sent with every report. */
  stats: PlayStatsReport;
}
```
**Impact:** `controller.ts` must now send `stats` (Step 3); nothing else builds a `PositionReport`
(`postPosition` at `session.ts:526` only serialises it). `npm run typecheck` fails between Step 1 and
Step 3, so land them together.

### Step 2: The counters
**File:** `web/src/stream/playStats.ts` (new)
**Change:** one small class that knows nothing of the video element; the controller calls it from
the events it already handles. The clock is injected.
**Code:**
```ts
import type { PlayStatsReport } from './session';

/** A gap between two time updates longer than this is the film standing still, not playing. */
export const PLAYED_GAP_MAX_MS = 1_000;
/** A move of the position larger than this between two time updates is a seek, not play. */
const PLAYED_JUMP_MAX_S = 2;
const LOAD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LOAD_LENGTH = 16;

/** A random id of one page load of one session: 16 characters of [A-Za-z0-9_-]. */
export function newLoadId(random: (bytes: Uint8Array) => Uint8Array = (bytes) => globalThis.crypto.getRandomValues(bytes)): string {
  let id = '';
  for (const byte of random(new Uint8Array(LOAD_LENGTH))) id += LOAD_ALPHABET[byte & 63];
  return id;
}

/**
 * The page's counters since it loaded a session (stream-play-log R1.6), sent as `stats` with every
 * position report. Intervals come from `now`, a monotonic clock (performance.now() in the browser):
 * this machine's wall clock steps.
 */
export class PlayStats {
  readonly load: string;
  private readonly now: () => number;
  private readonly loadedAt: number;
  private firstFrameMs: number | null = null;
  private playedMs = 0;
  private lastTick: { at: number; mediaS: number } | null = null;
  private stalls = 0;
  private stalledMs = 0;
  /** When the current freeze began (its first `waiting`); null while the film moves. */
  private stillSince: number | null = null;
  /** The current freeze was counted as a stall. */
  private stallOpen = false;
  private waits = 0;
  private waitedMs = 0;
  private waitSince: number | null = null;
  private errors = 0;

  constructor(now: () => number, load: string = newLoadId()) {
    this.now = now;
    this.load = load;
    this.loadedAt = now();
  }

  /** The film moves on the page for the first time. Later calls change nothing. */
  firstFrame(): void {
    if (this.firstFrameMs === null) this.firstFrameMs = Math.max(0, this.now() - this.loadedAt);
  }

  /**
   * A time update. `advancing`: the film is on the page, not paused and not ended. Play is counted
   * between two updates only when the position moved forward a little (not a seek), each gap at most
   * PLAYED_GAP_MAX_MS.
   */
  tick(mediaS: number, advancing: boolean): void {
    const at = this.now();
    const last = this.lastTick;
    if (advancing && last !== null && mediaS > last.mediaS && mediaS - last.mediaS <= PLAYED_JUMP_MAX_S) {
      this.playedMs += Math.min(Math.max(0, at - last.at), PLAYED_GAP_MAX_MS);
    }
    this.lastTick = advancing ? { at, mediaS } : null;
  }

  /** The film ran out of data while it should play: the moment it stood still (the first `waiting` of a freeze). */
  standingStill(): void {
    if (this.stillSince === null) this.stillSince = this.now();
    this.lastTick = null;
  }

  /**
   * The page's stall timer confirmed the freeze. One freeze is one stall, however often the timer
   * fires again; a freeze while the torrent fetches a missing part is a wait, not a stall.
   */
  stalled(torrentWait: boolean): void {
    if (this.stallOpen || torrentWait || this.stillSince === null) return;
    this.stalls += 1;
    this.stallOpen = true;
  }

  /** The film moves again, was sought or paused: the freeze is over. */
  moved(): void {
    if (this.stallOpen && this.stillSince !== null) this.stalledMs += Math.max(0, this.now() - this.stillSince);
    this.stillSince = null;
    this.stallOpen = false;
  }

  /** The page began waiting for a torrent's missing part ("waiting for the torrent"). */
  waitStarted(): void {
    if (this.waitSince !== null) return;
    this.waits += 1;
    this.waitSince = this.now();
  }

  /** The part arrived, the film moved, or the source changed. */
  waitEnded(): void {
    if (this.waitSince === null) return;
    this.waitedMs += Math.max(0, this.now() - this.waitSince);
    this.waitSince = null;
  }

  error(): void {
    this.errors += 1;
  }

  /** The counters now; a stall or a wait still open counts up to this moment. */
  report(): PlayStatsReport {
    const at = this.now();
    const openStall = this.stallOpen && this.stillSince !== null ? Math.max(0, at - this.stillSince) : 0;
    const openWait = this.waitSince !== null ? Math.max(0, at - this.waitSince) : 0;
    return {
      load: this.load,
      first_frame_ms: this.firstFrameMs === null ? null : Math.round(this.firstFrameMs),
      played_ms: Math.round(this.playedMs),
      stalls: this.stalls,
      stalled_ms: Math.round(this.stalledMs + openStall),
      waits: this.waits,
      waited_ms: Math.round(this.waitedMs + openWait),
      errors: this.errors,
    };
  }
}
```
**Impact:** new file, no callers until Step 3.

### Step 3: Feed the counters from the controller
**File:** `web/src/stream/controller.ts` — each sub-step names its lines (as on `7b2d61c`; nothing
earlier in this set touches the file).

**3a. Import** — after line 46 (`import { addFeedCue, ... } from './subtitles';`) add:
```ts
import { PlayStats } from './playStats';
```

**3b. The clock in `ControllerDeps`** — replace lines 258-260 (the `memory?` field and the closing
brace of `ControllerDeps`) with:
```ts
  /** Where the page keeps what it knows of its play, so a reload after a daemon restart can carry it on (sessionStorage in the browser). */
  memory?: Pick<Storage, 'getItem' | 'setItem'>;
  /** A monotonic clock in ms for the play's counters (performance.now() by default). Never the wall clock: it steps on this machine. */
  now?: () => number;
}
```

**3c. Fields** — after line 335 (`private previewsReading: string | null = null;`) add:
```ts
  /** The monotonic clock the counters use. */
  private readonly now: () => number;
  /** The counters of this page load of this session, sent with every position report; new when the page plays another session. */
  private stats: PlayStats;
```

**3d. Constructor** — replace lines 337-350 with:
```ts
  constructor(sessionId: string, video: HTMLVideoElement, deps: ControllerDeps) {
    this.sessionId = sessionId;
    this.video = video;
    this.deps = deps;
    this.mutedMode = deps.muted === true;
    this.now = deps.now ?? (() => performance.now());
    this.stats = new PlayStats(this.now);
    this.settled = new Promise<void>((resolve) => {
      this.settle = resolve;
    });
    if (this.mutedMode) {
      // Before any play(): phase 6's muted checks must never make a sound.
      this.video.muted = true;
      this.state = { ...this.state, muted: true };
    }
  }
```

**3e. Another episode, fresh counters** — in `goToEpisode`, replace line 461
(`this.sessionId = nextId;`; the closing report to the old session at line 455 has already gone out
with the old counters) with:
```ts
    this.sessionId = nextId;
    // Another session: its own load id and counters, so no load id ever spans two sessions.
    this.stats = new PlayStats(this.now);
```

**3f. Engine errors** — in `attach`, replace the `onFatal` handler (lines 845-847) with:
```ts
          onFatal: (message) => {
            if (!current()) return;
            this.stats.error();
            void this.leaveBrokenSource(message);
          },
```
and replace `onRecovering` (the method, lines 872-878) with:
```ts
  private onRecovering(attempt: number, message: string): void {
    if (this.state.stage === 'error') return;
    // One network error per episode of restarts, however many restarts it takes.
    if (attempt === 1) this.stats.error();
    const at = this.video.currentTime > 0 ? this.video.currentTime : this.lastPositionS;
    this.set({ stage: 'recovering' });
    this.note(`recovering ${attempt}/${NETWORK_RETRY_LIMIT} after ${message} at ${round1(at)} s`);
    this.countStall();
  }
```
(keep the method's existing doc comment above it).

**3g. Seek, waiting, the stall timer, moving** — replace lines 885-917 (`onSeek` through `onMoving`)
with:
```ts
  private readonly onSeek = (): void => {
    this.lastSeekAt = Date.now();
    this.clearStallTimer();
    // A seek ends a freeze; the wait it starts is timed afresh.
    this.stats.moved();
    this.markFetching(true);
  };

  // The film ran out of data while it should be playing. A wait that outlasts STALL_MIN_MS is a
  // stall; a seek's own wait, a pause and the first load are not. A torrent's wait for a part that
  // is not on disk yet is also shown as such.
  private readonly onWaiting = (): void => {
    if (this.state.stage === 'ready') this.markFetching(true);
    if (this.state.stage !== 'ready' || this.video.paused) return;
    this.stats.standingStill();
    // A seek's own wait is not a stall, unless it outlasts the grace.
    this.armStall(STALL_MIN_MS + Math.max(0, this.lastSeekAt + SEEK_GRACE_MS - Date.now()));
  };

  // A film that stays frozen is counted again every STALL_REPEAT_MS, so one long freeze moves the
  // source as three short ones do. `playing`, a seek and a pause end the wait.
  private armStall(delayMs: number): void {
    this.clearStallTimer();
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      if (this.disposed || this.state.stage !== 'ready' || this.video.paused) return;
      this.note(`stalled at ${round1(this.video.currentTime)} s`);
      // The play log counts the freeze once, and not at all when it is a torrent's wait.
      this.stats.stalled(this.state.torrent?.fetching === true);
      this.countStall();
      if (this.state.stage === 'ready') this.armStall(STALL_REPEAT_MS);
    }, delayMs);
  }

  private readonly onMoving = (): void => {
    this.clearStallTimer();
    this.stats.moved();
    if (this.onFilm() && !this.video.paused) this.stats.firstFrame();
    this.markFetching(false);
  };
```

**3h. A source switch ends a torrent wait** — in `moveTo`, immediately before the
`this.set({ stage: 'refreshing', kind: ..., torrent: torrentView(answer.session.torrent), ... })`
call at line 991 (which replaces the torrent view and so drops its `fetching` mark), add:
```ts
    // The new source's view has no fetching mark: the wait for the old one's part is over.
    this.stats.waitEnded();
```

**3i. Carried on in a fresh session, fresh counters** — in `swapTo`, replace line 1159
(`this.sessionId = session.id;`) with:
```ts
    this.sessionId = session.id;
    // Another session: its own load id and counters.
    this.stats = new PlayStats(this.now);
```

**3j. The torrent wait** — replace `markFetching` (lines 1329-1335) with:
```ts
  private markFetching(on: boolean): void {
    const torrent = this.state.torrent;
    if (torrent === null || torrent.fetching === on) return;
    if (on && (torrent.state === 'ready' || onDisk(this.state.cachedRanges, this.video.currentTime))) return;
    this.set({ torrent: { ...torrent, fetching: on } });
    if (on) {
      this.stats.waitStarted();
      this.note(`waiting for the torrent at ${round1(this.video.currentTime)} s`);
    } else {
      this.stats.waitEnded();
    }
  }
```
(keep its doc comment; the `note` text is unchanged).

**3k. Played time** — replace `onTime` (lines 1430-1434) with:
```ts
  private readonly onTime = (): void => {
    this.applySubtitleDelay();
    this.readCaption();
    if (this.onFilm() && this.video.currentTime > 0) this.lastPositionS = this.video.currentTime;
    this.stats.tick(this.video.currentTime, this.onFilm() && !this.video.paused && !this.video.ended);
  };
```

**3l. A pause ends a freeze** — replace `onPause` (lines 1444-1448) with:
```ts
  private readonly onPause = (): void => {
    this.clearStallTimer();
    // A pause is not a stall: a freeze in progress ends here.
    this.stats.moved();
    this.armPauseCache();
    if (this.onFilm() && !this.video.ended) this.report();
  };
```

**3m. Every report carries the counters** — replace lines 1470-1477 (the `const report = {...}`
literal in `report()`) with:
```ts
    const report = {
      position_s: round1(position),
      duration_s: duration === null ? null : round1(duration),
      ended,
      paused: !ended && this.video.paused,
      ...(extra.beat === true ? { beat: true } : {}),
      ...(extra.closed === true ? { closed: true } : {}),
      stats: this.stats.report(),
    };
```
**Impact:** every position POST body gains `stats`. Existing controller tests that `toEqual` a
position body (`controller.test.tsx:340,346,357,371,423,737`) would fail; Step 5 makes the
`posts()` helper leave `stats` out of position bodies so they keep testing positions, and adds the
tests for `stats`. The stall-to-switch behaviour is untouched: `countStall`, `changeSource`, the
timers and their delays are the same calls in the same order.

### Step 4: Unit tests of the counters
**File:** `web/src/stream/playStats.test.tsx` (new; `.tsx` because `vitest.config.ts:52` includes only
`web/src/**/*.test.tsx`)
**Code:**
```tsx
import { describe, expect, it } from 'vitest';
import { PLAYED_GAP_MAX_MS, PlayStats, newLoadId } from './playStats';

describe('newLoadId', () => {
  it('is 16 characters of [A-Za-z0-9_-], random each time', () => {
    const a = newLoadId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(newLoadId()).not.toBe(a);
    expect(newLoadId((bytes) => bytes.fill(0))).toBe('AAAAAAAAAAAAAAAA');
    expect(newLoadId((bytes) => bytes.fill(255))).toBe('________________');
  });
});

describe('PlayStats', () => {
  function counters() {
    const clock = { ms: 100 };
    const stats = new PlayStats(() => clock.ms, 'load-0001');
    return { clock, stats };
  }

  it('starts at zero with no first frame, and times the first frame from the load once', () => {
    const { clock, stats } = counters();
    expect(stats.report()).toEqual({ load: 'load-0001', first_frame_ms: null, played_ms: 0, stalls: 0, stalled_ms: 0, waits: 0, waited_ms: 0, errors: 0 });
    clock.ms += 2_345;
    stats.firstFrame();
    clock.ms += 5_000;
    stats.firstFrame();
    expect(stats.report().first_frame_ms).toBe(2_345);
  });

  it('counts play only between close updates while the film advances, never across a seek or a long gap', () => {
    const { clock, stats } = counters();
    stats.tick(10, true);
    clock.ms += 250;
    stats.tick(10.25, true);
    clock.ms += 250;
    stats.tick(60, true); // a seek
    clock.ms += 5_000;
    stats.tick(60.25, true); // a long gap: capped
    clock.ms += 250;
    stats.tick(60.5, false); // paused
    clock.ms += 250;
    stats.tick(60.75, true); // the first update after a pause only starts the count
    expect(stats.report().played_ms).toBe(250 + PLAYED_GAP_MAX_MS);
  });

  it('counts one stall per confirmed freeze, open ones up to now, and none for a torrent wait', () => {
    const { clock, stats } = counters();
    stats.standingStill();
    clock.ms += 1_500;
    stats.stalled(false);
    clock.ms += 1_000;
    stats.stalled(false); // the timer again: same freeze
    expect(stats.report()).toMatchObject({ stalls: 1, stalled_ms: 2_500 });
    clock.ms += 500;
    stats.moved();
    clock.ms += 9_000;
    expect(stats.report()).toMatchObject({ stalls: 1, stalled_ms: 3_000 });
    // A freeze the timer never confirmed, and one that was a torrent's wait.
    stats.standingStill();
    clock.ms += 1_000;
    stats.moved();
    stats.waitStarted();
    stats.standingStill();
    clock.ms += 7_000;
    stats.stalled(true);
    stats.waitEnded();
    stats.moved();
    expect(stats.report()).toMatchObject({ stalls: 1, stalled_ms: 3_000, waits: 1, waited_ms: 7_000 });
  });

  it('never goes down from one report to the next', () => {
    const { clock, stats } = counters();
    stats.standingStill();
    clock.ms += 1_500;
    stats.stalled(false);
    stats.waitStarted();
    const seen: number[][] = [];
    for (let i = 0; i < 5; i++) {
      clock.ms += 333;
      if (i === 2) stats.moved();
      if (i === 3) stats.waitEnded();
      const r = stats.report();
      seen.push([r.stalled_ms, r.waited_ms]);
    }
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i][0]).toBeGreaterThanOrEqual(seen[i - 1][0]);
      expect(seen[i][1]).toBeGreaterThanOrEqual(seen[i - 1][1]);
    }
  });
});
```
**Impact:** new tests only.

### Step 5: Controller tests
**File:** `web/src/stream/controller.test.tsx`

**5a.** Replace `setup` and its `posts` helper (lines 17-36) with:
```tsx
function setup(
  routes: Record<string, (call: FetchCall) => Response>,
  opts: { muted?: boolean; memory?: Pick<Storage, 'getItem' | 'setItem'>; onSession?: (id: string) => void; now?: () => number } = {},
) {
  const { made, createEngine } = fakeEngines();
  const { fetchImpl, calls } = routeFetch(routes);
  const { video, media, play, fire } = fakeVideo();
  const texts: string[] = [];
  const controller = new StreamController('S1', video, {
    fetch: fetchImpl,
    createEngine,
    textUrl: (vtt) => {
      texts.push(vtt);
      return `blob:vtt-${texts.length}`;
    },
    revokeTextUrl: () => {},
    muted: opts.muted,
    memory: opts.memory,
    onSession: opts.onSession,
    now: opts.now,
  });
  controllers.push(controller);
  // A position body without its `stats` (the counters have their own describe, R1.6); other bodies as sent.
  const withoutStats = (url: string, body: unknown): unknown => {
    if (!url.endsWith('/position') || body === null || typeof body !== 'object') return body;
    const rest = { ...(body as Record<string, unknown>) };
    delete rest.stats;
    return rest;
  };
  const posts = (url = `${S1}/position`) => calls.filter((c) => c.method === 'POST' && c.url === url).map((c) => withoutStats(url, c.body));
  return { controller, made, calls, video, media, play, fire, texts, posts };
}
```

**5b.** Append at the end of the file (after line 1834):
```tsx
describe('the counters in every position report (R1.6)', () => {
  const LOAD_ID = /^[A-Za-z0-9_-]{8,32}$/;
  const HASH = '08ada5a7a6183aae1e09d831df6748d566095a10';
  const S2 = '/api/stream/sessions/S2';
  type Stats = { load: string; first_frame_ms: number | null; played_ms: number; stalls: number; stalled_ms: number; waits: number; waited_ms: number; errors: number };

  /** A page whose counters' clock moves only when the test says; `elapse` moves it and the timers together. */
  function counted(session: Record<string, unknown> = streamSessionJson(), routes: Record<string, (call: FetchCall) => Response> = {}) {
    const clock = { ms: 0 };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(session), ...routes }, { now: () => clock.ms });
    const elapse = async (ms: number) => {
      clock.ms += ms;
      await vi.advanceTimersByTimeAsync(ms);
    };
    /** The film plays `seconds` on: a time update every 250 ms. */
    const play = async (seconds: number) => {
      for (let i = 0; i < seconds * 4; i++) {
        await elapse(250);
        t.media.currentTime += 0.25;
        t.fire('timeupdate');
      }
    };
    /** The page reports at once: a closing tab says its last position each time it is told, and changes no counter. */
    const reportNow = () => window.dispatchEvent(new Event('pagehide'));
    const bodiesTo = (url = `${S1}/position`) => t.calls.filter((c) => c.method === 'POST' && c.url === url).map((c) => c.body as Record<string, unknown> & { stats: Stats });
    const last = (url = `${S1}/position`) => bodiesTo(url).at(-1)?.stats;
    return { ...t, clock, elapse, play, reportNow, bodiesTo, last };
  }

  async function ready(t: ReturnType<typeof counted>, engine = 0) {
    await vi.waitFor(() => expect(t.made).toHaveLength(engine + 1));
    t.made[engine].req.handlers.onReady({ qualities: [], subtitles: [] });
  }

  it('times the first frame from the page load, counts play only while the film moves, and sends it all under one load id in every kind of report', async () => {
    const t = counted();
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    await t.elapse(1_200);
    await ready(t);
    t.fire('playing');
    await t.play(10);
    t.reportNow();
    const first = t.last();
    // The first update only starts the count: 39 gaps of 250 ms.
    expect(first).toEqual({ load: expect.stringMatching(LOAD_ID), first_frame_ms: 1_200, played_ms: 9_750, stalls: 0, stalled_ms: 0, waits: 0, waited_ms: 0, errors: 0 });

    // Paused: the pause report and the beat carry the counters, and play stops counting.
    t.media.paused = true;
    t.fire('pause');
    await t.elapse(POSITION_INTERVAL_MS);
    const [pausedReport, beat] = t.bodiesTo().slice(-2);
    expect(pausedReport).toMatchObject({ paused: true, stats: first });
    expect(beat).toMatchObject({ beat: true, stats: first });

    // Play again, then the end: the first update after the pause only starts the count again.
    t.media.paused = false;
    t.fire('play');
    await t.play(2);
    Object.assign(t.media, { duration: 600, ended: true });
    t.fire('ended');
    expect(t.bodiesTo().at(-1)).toMatchObject({ ended: true, stats: { ...first, played_ms: 9_750 + 1_750 } });
    expect(new Set(t.bodiesTo().map((b) => b.stats.load))).toEqual(new Set([first?.load]));
  });

  it('counts a stall once the wait outlasts STALL_MIN_MS, timed from the moment the film stood still until it moves again', async () => {
    const t = counted();
    void t.controller.start();
    await ready(t);
    t.fire('playing');
    await t.play(2);
    t.fire('waiting');
    await t.elapse(STALL_MIN_MS);
    expect(t.controller.getState().log.some((line) => line.startsWith('stalled at'))).toBe(true);
    await t.elapse(2_500);
    // Still frozen: the report counts it up to now.
    t.reportNow();
    expect(t.last()).toMatchObject({ stalls: 1, stalled_ms: 4_000 });
    t.fire('playing');
    await t.play(1);
    t.reportNow();
    // Played: 7 gaps before the freeze, 3 after it; the frozen time is not play.
    expect(t.last()).toMatchObject({ stalls: 1, stalled_ms: 4_000, played_ms: 2_500 });
  });

  it('counts one long freeze as one stall, though the switch rule counts it every STALL_REPEAT_MS', async () => {
    const t = counted();
    void t.controller.start();
    await ready(t);
    t.fire('playing');
    await t.play(1);
    t.fire('waiting');
    await t.elapse(STALL_MIN_MS + STALL_REPEAT_MS + 500);
    t.fire('playing');
    t.reportNow();
    expect(t.controller.getState().log.filter((line) => line.startsWith('stalled at'))).toHaveLength(2);
    expect(t.last()).toMatchObject({ stalls: 1, stalled_ms: STALL_MIN_MS + STALL_REPEAT_MS + 500 });
  });

  it("does not count the first load, a short wait, a seek's own wait within the grace or a wait while paused", async () => {
    const t = counted();
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    // The first load: the engine is not ready yet.
    t.fire('waiting');
    await t.elapse(STALL_MIN_MS * 2);
    await ready(t);
    t.fire('playing');
    await t.play(1);
    // A short wait.
    t.fire('waiting');
    await t.elapse(STALL_MIN_MS - 100);
    t.fire('playing');
    // A seek's own wait, inside the grace.
    t.media.currentTime = 900;
    t.fire('seeking');
    t.fire('waiting');
    await t.elapse(SEEK_GRACE_MS);
    t.fire('playing');
    await t.play(1);
    // A wait while paused.
    t.media.paused = true;
    t.fire('pause');
    t.fire('waiting');
    await t.elapse(STALL_MIN_MS * 3);
    t.reportNow();
    expect(t.last()).toMatchObject({ stalls: 0, stalled_ms: 0, waits: 0, waited_ms: 0 });
    expect(t.controller.getState().log.some((line) => line.startsWith('stalled'))).toBe(false);
  });

  it("counts a torrent's wait for a missing part as a wait, never as a stall, though the stall timer fires during it", async () => {
    const t = counted(
      streamSessionJson({
        provider: 'Torrent',
        manifest_kind: 'mp4',
        manifest_url: `/api/stream/torrent/${HASH}/f/0`,
        torrent: { info_hash: HASH, name: 'Sintel.2010.1080p.WEB.x264', index: 'Torrentio', state: 'downloading', seeds: 52 },
      }),
      {
        [`GET /api/stream/torrent/${HASH}`]: () => jsonResponse({ info_hash: HASH, state: 'downloading', peers: 5, down_kbps: 4000, up_kbps: 800, progress: 0.2 }),
        [`GET /api/stream/torrent/${HASH}/map`]: () => jsonResponse({ duration_s: 888, ranges: [[0, 60]] }),
      },
    );
    void t.controller.start();
    await ready(t);
    t.media.duration = 888;
    t.fire('playing');
    await vi.waitFor(() => expect(t.controller.getState().cachedRanges).toEqual([[0, 60]]));
    await t.play(1);
    t.media.currentTime = 400;
    t.fire('seeking');
    t.fire('waiting');
    await t.elapse(SEEK_GRACE_MS + STALL_MIN_MS + 1_000);
    expect(t.controller.getState().log).toContain('waiting for the torrent at 400 s');
    expect(t.controller.getState().log.some((line) => line.startsWith('stalled at'))).toBe(true);
    t.reportNow();
    expect(t.last()).toMatchObject({ stalls: 0, stalled_ms: 0, waits: 1, waited_ms: SEEK_GRACE_MS + STALL_MIN_MS + 1_000 });
    // The part arrives: the wait ends there.
    t.fire('seeked');
    t.fire('playing');
    await t.elapse(1_000);
    t.reportNow();
    expect(t.last()).toMatchObject({ stalls: 0, stalled_ms: 0, waits: 1, waited_ms: SEEK_GRACE_MS + STALL_MIN_MS + 1_000 });
  });

  it('counts each network error the engine rides out and each stream it declared broken', async () => {
    const t = counted(streamSessionJson(), {
      [`POST ${S1}/source`]: () => jsonResponse({ ...streamSessionJson({ manifest_url: `${S1}/p?u=m2`, provider: 'VidNest Anime' }), switched: true, reason: null, from: 'VidFast' }),
    });
    void t.controller.start();
    await ready(t);
    t.fire('playing');
    await t.play(1);
    // One network error, ridden out over two restarts.
    t.made[0].req.handlers.onRecovering(1, 'networkError fragLoadError');
    t.made[0].req.handlers.onRecovering(2, 'networkError fragLoadError');
    t.made[0].req.handlers.onRecovered();
    // A stream that cannot be played at all: the page moves to another provider and plays on.
    t.made[0].req.handlers.onFatal('mediaError bufferAppendError');
    await ready(t, 1);
    t.fire('playing');
    await t.play(1);
    t.reportNow();
    expect(t.last()).toMatchObject({ errors: 2 });
  });

  it('starts a new load id and fresh counters when the page plays another session without loading again', async () => {
    const ep = (over: Record<string, unknown>) => streamSessionJson({ kind: 'tv', tmdb_id: 37854, season: 17, ...over });
    const next = ep({ session_id: 'S2', episode: 731, manifest_url: `${S2}/p?u=m731`, prev_episode: { season: 17, episode: 730 } });
    const t = counted(ep({ episode: 730, next_episode: { season: 17, episode: 731 } }), {
      [`POST ${S1}/episode`]: () => jsonResponse(next),
      [`GET ${S2}`]: () => jsonResponse(next),
    });
    void t.controller.start();
    await ready(t);
    t.fire('playing');
    await t.play(2);
    t.fire('waiting');
    await t.elapse(STALL_MIN_MS);
    t.fire('playing');
    await t.controller.goToEpisode('next');
    // The old session's last word carries its own counters.
    const old = t.last();
    expect(t.bodiesTo().at(-1)).toMatchObject({ closed: true });
    expect(old).toMatchObject({ stalls: 1, stalled_ms: STALL_MIN_MS });
    await vi.waitFor(() => expect(t.made).toHaveLength(2));
    await t.elapse(800);
    await ready(t, 1);
    t.media.currentTime = 0;
    t.fire('playing');
    await t.play(1);
    t.reportNow();
    const fresh = t.last(`${S2}/position`);
    expect(fresh).toEqual({ load: expect.stringMatching(LOAD_ID), first_frame_ms: 800, played_ms: 750, stalls: 0, stalled_ms: 0, waits: 0, waited_ms: 0, errors: 0 });
    expect(fresh?.load).not.toBe(old?.load);
  });
});
```
Notes for the implementer:
- Imports used here (`POSITION_INTERVAL_MS`, `SEEK_GRACE_MS`, `STALL_MIN_MS`, `STALL_REPEAT_MS`,
  `streamSessionJson`, `jsonResponse`, `FetchCall`, `vi`) are already imported at lines 2-6.
- The counters' clock is the manual `clock`; `vi.waitFor` advancing the fake timers does not move
  it, so every expected millisecond above is exact. If an exact value is off by the `waitFor`
  inside `ready()` (it runs before `elapse` in each test), the cause is the code, not the test:
  only `elapse` moves `clock`.
- A pause arms the pause-cache ask after `PAUSE_CACHE_DELAY_MS`; its `POST .../cache` is answered
  404 by `routeFetch` and only writes a log line. That is expected in the first test.

**Impact:** the six existing `toEqual` assertions on position bodies pass unchanged through
`posts()`; the R1.6 behaviour is asserted by the new describe.

### Step 6: Real-page drive
**File:** `.claude/skills/verify-notesd/scripts/stream/play-stats.steps.mjs` (new)
**Change:** drive the real page build in a throwaway daemon with the session routes faked (as
`recovery.steps.mjs` and `torrent-player.steps.mjs` do), keep every posted position body, and
check its `stats`.
**Code:**
```js
// The player page's counters (stream-play-log phase 2, R1.6) in a throwaway daemon's real build
// (verify.sh up --web). As in recovery.steps.mjs, the daemon's /api/stream/sessions/* routes are
// answered here: S1 from the HLS fixture make-hls-fixture.sh builds (under ?muted=1: 30 s loaded
// ahead, and a muted page never asks for another source), T1 a torrent session as in
// torrent-player.steps.mjs (a 300 s MP4, 40% "on disk" until released). Every position report the
// page posts is kept, and its `stats` read. Nothing leaves this machine; no Chrome on Windows.
//   STREAM_FIXTURE=<folder make-hls-fixture.sh printed> verify.sh ui RUN <this file>
// Logs "FIRST FRAME PASS", "STALL PASS", "GRACE PASS", "BEAT PASS", "NEW LOAD PASS",
// "TORRENT WAIT PASS"; the first failed check throws and fails the run.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const FIX = process.env.STREAM_FIXTURE
const TYPES = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.vtt': 'text/vtt' }
const LOAD = /^[A-Za-z0-9_-]{8,32}$/
const FILM_DIR = process.env.TORRENT_FILM_DIR ?? path.join(os.homedir(), '.local/state/notesd-verify/.torrent-film')
const FILM = path.join(FILM_DIR, 'film.mp4')
const FILM_S = 300
const ON_DISK = 0.4
const HASH = '08ada5a7a6183aae1e09d831df6748d566095a10'
/** Under hls.js's 10 s time-to-first-byte limit, over the 6.5 s a seek's wait needs to be a stall. */
const STALL_HOLD_MS = 8_000
/** Inside the 5 s seek grace: never a stall. */
const GRACE_HOLD_MS = 2_000
/** Long enough for the page's stall timer to fire during the torrent's wait. */
const TORRENT_HOLD_MS = 9_000

function check(ok, what) {
  if (!ok) throw new Error(what)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeFilm() {
  if (existsSync(FILM)) return
  mkdirSync(FILM_DIR, { recursive: true })
  const part = path.join(FILM_DIR, 'film.part.mp4')
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=duration=${FILM_S}:size=640x360:rate=24`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${FILM_S}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '48',
    '-c:a', 'aac', '-shortest', '-movflags', '+faststart', part,
  ])
  renameSync(part, FILM)
}

async function until(page, cond, ms, what) {
  for (let waited = 0; waited < ms; waited += 250) {
    if (await cond()) return
    await page.waitForTimeout(250)
  }
  check(await cond(), what)
}

const hlsSession = {
  session_id: 'S1', kind: 'movie', tmdb_id: 1, season: null, episode: null, provider: 'Fixture', best_height: 720,
  created_at: null, refreshed_at: null, expires_at: null,
  title: 'Fixture Stats (2026)',
  manifest_url: '/api/stream/sessions/S1/p?u=v720/index.m3u8',
  manifest_kind: 'hls',
  subtitles: [],
  resume_s: 20,
}

const torrentSession = {
  session_id: 'T1', kind: 'movie', tmdb_id: 1, season: null, episode: null, provider: 'Torrent', best_height: 360,
  created_at: null, refreshed_at: null, expires_at: null, cached: null,
  title: 'Fixture Torrent Stats (2026)',
  manifest_url: `/api/stream/torrent/${HASH}/f/0`,
  manifest_kind: 'mp4',
  subtitles: [],
  resume_s: 0,
  torrent: { info_hash: HASH, name: 'Fixture.Film.2026.1080p.WEB.x264', index: 'Fixture', state: 'downloading', seeds: 52 },
}

const playingPast = (page, s, timeout = 30_000) =>
  page.waitForFunction((at) => {
    const v = document.querySelector('video')
    return !!v && !v.paused && v.currentTime > at
  }, s, { timeout })

const pageLog = (page) => page.evaluate(() => window.notesdStream?.log ?? [])

export default async ({ page, base, shot, log }) => {
  check(FIX, 'set STREAM_FIXTURE to the folder make-hls-fixture.sh printed')
  makeFilm()
  const film = readFileSync(FILM)
  const size = film.length
  const cut = Math.floor(size * ON_DISK)
  const fake = { posts: [], hold: null, released: false }
  const reportsOf = (id) => fake.posts.filter((p) => p.id === id)
  const statsOf = (id) => reportsOf(id).map((p) => p.body.stats).filter((s) => s !== undefined)
  const lastStats = (id) => statsOf(id).at(-1)
  const nextReport = async (id, what) => {
    const n = reportsOf(id).length
    await until(page, () => reportsOf(id).length > n, 8_000, what)
    return lastStats(id)
  }

  await page.route('**/api/stream/sessions/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    const m = /^\/api\/stream\/sessions\/(S1|T1)(?:\/(p|position|events|cache))?$/.exec(url.pathname)
    if (!m) return json(403, { error: 'unknown_session' })
    const [, id, tail] = m
    if (tail === 'position') {
      fake.posts.push({ id, body: req.postDataJSON() })
      return json(200, { ok: true })
    }
    if (tail === 'events' || tail === 'cache') return json(404, { error: 'not_found' })
    if (tail === 'p') {
      const u = url.searchParams.get('u') ?? ''
      const seg = /seg(\d+)\.ts$/.exec(u)
      const hold = fake.hold
      // A one-shot hold: the first segment asked in the range waits, as a slow host's would.
      if (seg && hold && Number(seg[1]) >= hold.from && Number(seg[1]) < hold.to) {
        fake.hold = null
        await sleep(hold.ms)
      }
      const file = path.join(FIX, u)
      try {
        await route.fulfill({ status: 200, headers: { 'x-notesd-upstream': '200' }, contentType: TYPES[path.extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
      } catch {
        // The page gave the request up: nothing to answer.
      }
      return
    }
    return json(200, id === 'S1' ? hlsSession : torrentSession)
  })

  await page.route('**/api/stream/torrent/**', async (route) => {
    const req = route.request()
    const m = /^\/api\/stream\/torrent\/([0-9a-f]{40})(\/map|\/f\/0)?$/.exec(new URL(req.url()).pathname)
    if (!m) return route.fulfill({ status: 404, json: { error: 'not_found' } })
    const [, hash, tail] = m
    if (tail === undefined) return route.fulfill({ json: { info_hash: hash, state: 'downloading', peers: 7, down_kbps: 16000, up_kbps: 800, progress: ON_DISK } })
    if (tail === '/map') return route.fulfill({ json: { duration_s: FILM_S, ranges: [[0, FILM_S * ON_DISK]] } })
    const asked = /bytes=(\d+)-(\d*)/.exec(req.headers()['range'] ?? '')
    const start = asked ? Number(asked[1]) : 0
    let end = asked && asked[2] !== '' ? Math.min(Number(asked[2]), size - 1) : size - 1
    if (!fake.released) {
      if (start >= cut) {
        while (!fake.released) await sleep(250)
      } else {
        end = Math.min(end, cut - 1)
      }
    }
    try {
      await route.fulfill({
        status: 206,
        headers: { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}` },
        body: film.subarray(start, end + 1),
      })
    } catch {
      // The page gave the request up (a seek): nothing to answer.
    }
  })

  // FIRST FRAME: the first reports carry a load id, a first-frame time and played time, nothing else.
  await page.goto(`${base}/stream/S1?muted=1`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 30_000 })
  await playingPast(page, 22)
  await until(page, () => (lastStats('S1')?.played_ms ?? 0) > 0, 12_000, 'a position report carries stats with play counted')
  const first = lastStats('S1')
  log(`FIRST ${JSON.stringify(first)}`)
  check(reportsOf('S1').every((p) => p.body.stats !== undefined), 'every position report carries stats')
  check(LOAD.test(first.load), `the load id is 8-32 of [A-Za-z0-9_-] (got ${first.load})`)
  check(typeof first.first_frame_ms === 'number' && first.first_frame_ms > 0 && first.first_frame_ms < 30_000, `first_frame_ms is a time under 30 s (got ${first.first_frame_ms})`)
  check(first.stalls === 0 && first.stalled_ms === 0 && first.waits === 0 && first.waited_ms === 0 && first.errors === 0, `nothing but play counted yet (got ${JSON.stringify(first)})`)
  log('FIRST FRAME PASS')

  // STALL: a seek to 100 s whose first segment answers after 8 s. Past the 5 s grace and 1.5 s, it is one stall,
  // timed from the moment the film stood still until it moved.
  fake.hold = { from: 50, to: 60, ms: STALL_HOLD_MS }
  await page.evaluate(() => {
    document.querySelector('video').currentTime = 100
  })
  await playingPast(page, 101.5, 40_000)
  const stall = await nextReport('S1', 'a report after the stall')
  log(`STALL ${JSON.stringify(stall)}`)
  check(stall.load === first.load, 'the same load id')
  check(stall.stalls === 1, `one stall (got ${stall.stalls})`)
  check(stall.stalled_ms >= 6_000 && stall.stalled_ms <= 12_000, `stalled_ms about 8 s (got ${stall.stalled_ms})`)
  check(stall.played_ms > first.played_ms, 'play went on counting')
  check((await pageLog(page)).some((line) => line.startsWith('stalled at')), 'the page wrote its own "stalled at" line')
  await shot('play-stats-after-stall')
  log('STALL PASS')

  // GRACE: a seek to 70 s whose first segment answers after 2 s, inside the grace: no new stall.
  fake.hold = { from: 35, to: 45, ms: GRACE_HOLD_MS }
  await page.evaluate(() => {
    document.querySelector('video').currentTime = 70
  })
  await playingPast(page, 71.5, 30_000)
  const grace = await nextReport('S1', 'a report after the short seek')
  log(`GRACE ${JSON.stringify(grace)}`)
  check(grace.stalls === 1 && grace.stalled_ms === stall.stalled_ms, `the seek's own wait was not a stall (got ${JSON.stringify(grace)})`)
  log('GRACE PASS')

  // BEAT: a paused page's beats carry the same counters; play stops counting.
  await page.evaluate(() => document.querySelector('video').pause())
  await until(page, () => reportsOf('S1').filter((p) => p.body.beat === true).length >= 2, 15_000, 'two beats while paused')
  const beats = reportsOf('S1').filter((p) => p.body.beat === true).slice(-2).map((p) => p.body.stats)
  check(beats.every((s) => s.load === first.load), 'beats carry the same load id')
  check(beats[0].played_ms === beats[1].played_ms, `no play counted while paused (${beats[0].played_ms} then ${beats[1].played_ms})`)
  log('BEAT PASS')

  // NEW LOAD: a reload is a new page load: a new id, counters from zero.
  await page.reload()
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 30_000 })
  await until(page, () => lastStats('S1')?.load !== first.load, 15_000, 'a report under a new load id')
  const reloaded = lastStats('S1')
  log(`NEW LOAD ${JSON.stringify(reloaded)}`)
  check(LOAD.test(reloaded.load) && reloaded.load !== first.load, 'a different load id')
  check(reloaded.stalls === 0 && reloaded.stalled_ms === 0, 'counters start again from zero')
  log('NEW LOAD PASS')

  // TORRENT WAIT: a seek past what is on disk waits 9 s for the torrent: one wait, timed, and not a stall,
  // though the page's stall timer fires during it.
  await page.goto(`${base}/stream/T1?muted=1`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 30_000 })
  await playingPast(page, 2)
  await until(page, () => statsOf('T1').length > 0, 8_000, 'a torrent report carries stats')
  const before = await nextReport('T1', 'a torrent report before the seek')
  await page.evaluate(() => {
    document.querySelector('video').currentTime = 200
  })
  await until(page, async () => (await page.evaluate(() => window.notesdStream?.torrent?.fetching === true)), 5_000, 'the page waits for the torrent')
  await page.waitForTimeout(TORRENT_HOLD_MS)
  fake.released = true
  await playingPast(page, 202)
  const after = await nextReport('T1', 'a torrent report after the wait')
  log(`TORRENT ${JSON.stringify({ before, after })}`)
  check(after.load === before.load, 'the same load id')
  check(after.waits - before.waits === 1, `one more wait (got ${after.waits - before.waits})`)
  check(after.waited_ms - before.waited_ms >= 7_000 && after.waited_ms - before.waited_ms <= 20_000, `the wait timed about 9 s (got ${after.waited_ms - before.waited_ms})`)
  check(after.stalls === before.stalls && after.stalled_ms === before.stalled_ms, `the torrent's wait was not a stall (got ${JSON.stringify(after)})`)
  check((await pageLog(page)).some((line) => line.startsWith('stalled at')), "the page's stall timer did fire during the wait")
  await shot('play-stats-torrent')
  log('TORRENT WAIT PASS')
}
```
**Impact:** new script, run only by the Proof; touches nothing in the daemon.

### Step 7: Feature map
**File:** `.claude/skills/verify-notesd/features/direct-streaming.md:55` (after the bullet that ends
`` `.workflows/plan/direct-streaming/phase-5.md`). ``)
**Change:** add one bullet.
**Code:**
```markdown
- The player page's counters (stream-play-log phase 2): every position report (the 5 s one, pause,
  `beat`, `ended`, `closed`) carries `stats`: a random `load` id of this page load of this session
  (a new one when the page plays another session without reloading) and, since then,
  `first_frame_ms`, `played_ms`, `stalls` and `stalled_ms` (one per freeze the page's stall timer
  confirms, timed from the moment the film stood still until it moved; a pause, a seek's own wait in
  the grace and the first load are not stalls), `waits` and `waited_ms` (the torrent's "waiting for
  the torrent"; never a stall), `errors`. Measured with `performance.now()`. Logic:
  `npx vitest run web/src/stream/playStats.test.tsx web/src/stream/controller.test.tsx -t "R1.6|PlayStats|newLoadId"`;
  in the real page build: `$V up --web`, then
  `STREAM_FIXTURE="$FIX" $V ui RUN .claude/skills/verify-notesd/scripts/stream/play-stats.steps.mjs`
  (about 90 s; `FIX` from `make-hls-fixture.sh` as for `player.steps.mjs`). The transcript has
  `FIRST FRAME PASS`, `STALL PASS`, `GRACE PASS`, `BEAT PASS`, `NEW LOAD PASS` and `TORRENT WAIT PASS`.
  What the daemon keeps of them is the play log's (phase 1).
```
**Impact:** docs only; `docs:check` does not read the feature map.

## Principles applied

- Laziness protocol: no new event listeners, timers or detection; the counters hang off the handlers that already exist (`onWaiting`, the stall timer's callback, `onMoving`, `onSeek`, `onPause`, `markFetching`, `onTime`), and the stall/wait rules stay exactly the page's own (`STALL_MIN_MS`, the grace, the `fetching` mark).
- Boundary discipline / make illegal states unrepresentable: one `load` id never spans two sessions — the page mints a new `PlayStats` whenever `sessionId` changes (`goToEpisode`, `swapTo`), so the daemon never has to guess which counters belong to which session; `stats` is a required field of `PositionReport`, so no report can leave without it.
- Test behavior, not implementation: the controller tests drive video events and read the posted bodies, not `PlayStats` internals; `PlayStats` is a separate class with an injected clock so its arithmetic is tested with exact numbers.
- Encode lessons in structure (the WSL wall-clock step): the counters take their clock only through `ControllerDeps.now` (default `performance.now()`); `PlayStats` has no access to `Date`.
- Prove it works: a Playwright drive of the real page build reads the bodies the page actually posts (Step 6), not only the unit tests.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npx vitest run web/src/stream` then `npm test`
**Proof:** the posted position bodies of the real page build carry the counters.
- Harness: `.claude/skills/verify-notesd`
- Feature-map entries: `.claude/skills/verify-notesd/features/direct-streaming.md`
- Journeys:
  - **J1** · traces R1.6 — `npx vitest run web/src/stream/playStats.test.tsx web/src/stream/controller.test.tsx -t "R1.6|PlayStats|newLoadId"` → passes when every test in the describe `the counters in every position report (R1.6)` and in `playStats.test.tsx` passes (first frame 1 200 ms and played 9 750 ms under one load id across plain, pause, beat and ended reports; one stall of 4 000 ms; one long freeze is one stall; no stall for the first load, a short wait, a seek in the grace or a pause; a torrent wait counted as `waits: 1` with no stall; `errors: 2`; a new load id after the episode button)
  - **J2** · traces R1.6 — `V=.claude/skills/verify-notesd/scripts/verify.sh; FIX=$(bash .claude/skills/verify-notesd/scripts/stream/make-hls-fixture.sh "$HOME/.local/state/notesd-verify/.stream-fixture"); $V up --web` (note `RUN`), then `STREAM_FIXTURE="$FIX" $V ui RUN .claude/skills/verify-notesd/scripts/stream/play-stats.steps.mjs`, then `$V down RUN` → passes when the run succeeds and its transcript under `~/.local/state/notesd-verify/RUN/evidence/` has `FIRST FRAME PASS`, `STALL PASS` (one stall, `stalled_ms` 6-12 s), `GRACE PASS`, `BEAT PASS`, `NEW LOAD PASS` and `TORRENT WAIT PASS` (one wait of 7-20 s, stall count unchanged although a `stalled at` line was written)
- Neighbor check: the stall-to-switch rules this phase must not change — `npx vitest run web/src/stream/controller.test.tsx -t "keeps stalling|moves the play by itself|torrent session"` passes, and on the same `up --web` run `$V ui RUN .claude/skills/verify-notesd/scripts/stream/torrent-player.steps.mjs` still logs `NO AUTO MOVE PASS` and `SHUFFLE PASS`
- Cost: none (no LLM, no network; ffmpeg fixtures are cached under `~/.local/state/notesd-verify/`)

**Exit criteria:** `npm run typecheck` and `npm test` pass; J1 and J2 pass; every position body the
real page posts has `stats` with a `load` id and the seven counters, and the existing stall-switch
tests are unchanged and green.

## Handoffs

- **Phase 1 (R1.3):** parse `positionBody.stats` exactly as the body above: `load` matches
  `^[A-Za-z0-9_-]{8,32}$`; the seven numbers are non-negative integers, `first_frame_ms` nullable;
  each is cumulative per `load` and non-decreasing, so keep the **latest** stats per
  `(session, load)` and sum over loads (never add successive reports of the same load). A `load` is
  only ever reported to one session id. `first_frame_ms` for the row: the first load that reported
  a non-null one, as the index says. Reports arrive with `beat: true` too (R1.5: write nothing to
  the database for those, keep the tally in memory only if wanted).
- **Phase 1 (docs, reconciled: done in phase 1's plan):** `docs/guide/streaming.md` "The play log"
  carries the paragraph of what the page counts (one stall per confirmed freeze, timed from standing
  still to moving; a torrent wait is not a stall; a pause, a seek within the grace and the first load
  are not stalls; `performance.now()`; a new load id per page load and per session change). This
  phase does not edit the guide.
- **Phase 1 (parser, reconciled):** phase 1's `pageStatsBody` accepts exactly this body (`load`
  `^[A-Za-z0-9_-]{8,32}$`, so the 16-character id fits; numbers rounded; `first_frame_ms` nullish;
  `stats` on beat/closed/ended reports kept in memory, a quiet beat writes nothing), and its
  `StatsTally` keeps the latest per `(session, load)` and sums over loads.
- **Shared file (concurrent with phase 1):** `.claude/skills/verify-notesd/features/direct-streaming.md`:
  this phase adds one bullet at :55 only; phase 1 adds its "## The play log" section before
  `## Gotchas` (:821). Different lines: on a merge, keep both.
- **Phase 3:** `played_ms` is only the time the film advanced on the page, so "stalls per hour
  played" = `stalls / (played_ms / 3.6e6)` is meaningful even for short test plays.
- Observation, not this set's work: the stall-to-switch rules (`countStall`, `changeSource`,
  `onSeek`'s `lastSeekAt`, `carryOn`'s give-up) still read `Date.now()`; on this machine the wall
  clock steps ~1.9 s every ~34 s. Moving them to the injected clock changes a switch rule, which
  Invariant 6 forbids here; worth a task card of its own.

## Rollback

Revert this phase's commit. `PositionReport` loses `stats`, the page stops sending it, and phase 1's
parser (the key is optional) sees old-style reports; nothing is stored by this phase.
