> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/stream-cache-and-bug-report/PLAN.md` phase 2. Source: `.workflows/plan/stream-cache-and-bug-report/phase-2.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 2: Player recovers from network errors and buffers further

**Plan set:** `STREAM_CACHE_AND_BUG_REPORT_PLAN.md`
**Analysis:** `.workflows/analyze/20261116-125845-K7QM_code_analyzer.md`
**Satisfies:** R1 — the small player fix inside R1: recover from a fatal network error instead of stopping, and buffer further than 30 s where it is safe
**Criteria:** R1.7, R1.8
**Depends on:** Phase 1
**Difficulty:** NORMAL
**Package:** `web/src/stream`

---

## Goal

Today a fatal network error in the player (hls.js `fragLoadError` and its kin) ends the play at
once (`hlsEngine.ts:47` → `onFatal` → `controller.fail()`), and hls.js keeps only 30 s loaded ahead
(`hlsEngine.ts:20`). After this phase the three engines restart loading after a wait (2, 4, 8, 16,
16 s) from where the film is, the page stays on the film with a reconnecting spinner
(`stage: 'recovering'`), positions are still reported, and the error is shown only when the fifth
restart failed too. An HLS play keeps 120 s loaded ahead; a `?muted=1` check keeps 30 s, so the
expiry checks still find segments that are not loaded yet.

## Interface Contract

**Deletes:** nothing. The comment above `new Hls(...)` (`hlsEngine.ts:17-19`) is rewritten.
**Renames:** local `recovered` -> `mediaRecovered` inside `createHlsEngine` (`hlsEngine.ts:22`), now that a second kind of recovery lives beside it.
**Creates (all in `web/src/stream/engine.ts`):**
- `EngineHandlers.onRecovering(attempt: number, message: string): void` — a fatal network error that is not a refusal; the engine restarts loading after `networkRetryDelayMs(attempt)`. `attempt` is 1..`NETWORK_RETRY_LIMIT`.
- `EngineHandlers.onRecovered(): void` — a load succeeded after a restart; the engine's count starts again. **This is a second handler beyond the index's contract line ("gains `onRecovering`")**: only the engine can tell that a load succeeded; "playback advances" is not a usable signal with 120 s buffered, because the film plays on from the buffer while every load still fails, which would reset the count forever and never spend the retries.
- `EngineRequest.bufferAheadS?: number` — seconds to keep loaded ahead (HLS); `BUFFER_AHEAD_S` when left out. Phase 6 sets it for a complete cache.
- `BUFFER_AHEAD_S = 120`, `MUTED_BUFFER_AHEAD_S = 30`
- `NETWORK_RETRY_LIMIT = 5`, `networkRetryDelayMs(attempt)` = `min(2000 * 2^(attempt-1), 16000)` → 2, 4, 8, 16, 16 s
- `interface NetworkRecovery { fail(message): void; loaded(): void; stop(): void }` and `networkRecovery(handlers, restart): NetworkRecovery`
- `web/src/stream/hlsEngine.test.tsx`, `web/src/stream/nativeEngine.test.tsx` (new tests)
- `.claude/skills/verify-notesd/scripts/stream/recovery.steps.mjs` (new journey script)

**Signature changes:**
- `type Stage = 'loading' | 'ready' | 'refreshing' | 'error'` -> `'loading' | 'ready' | 'refreshing' | 'recovering' | 'error'` (`controller.ts:19`)
- `StreamState` gains no field (the attempt number lives only in the engine and in the log line).

**Controller log lines this phase adds** (through the existing `note()`, which phase 1 posts to the daemon):
- `recovering <attempt>/5 after <message> at <seconds> s` (e.g. `recovering 1/5 after networkError fragLoadError at 1312.4 s`)
- `recovered at <seconds> s`
The final failure is unchanged: `fail()` with the engine's message (`networkError fragLoadError`), shown as `Playback stopped (networkError fragLoadError).`

**Overlay:** `stage === 'recovering'` shows the `CircleNotch` spinner in `.st-center` with `role="status"` and `aria-label="Reconnecting after a network error"`; `.st-stage[data-stage="recovering"]`. The error branch of `StageOverlay` is not touched.

**Requires (from earlier phases):** Phase 1 has changed `StreamController.note()` / `fail()` (`controller.ts:267-280`) so their lines are also posted to `POST /api/stream/sessions/:id/events`, without changing the text kept in `state.log` / `state.errors`, and without awaiting or failing on the answer. This phase does **not** edit `note()`, `fail()`, `session.ts` or anything phase 1 added; every controller edit below is matched by its text, not its line number (phase 1's insertions shift the numbers).
**Leaves alone (owned by others):** daemon source (`src/**`) and route docs (phase 1, 4, 5, 6); the error branch of `StageOverlay` and any report button (phase 4); `SessionInfo.cached` and the cache (phases 5, 6); `claude/streaming/direct/playcheck.mjs` (unchanged: it already loads `?muted=1`).

## Files

| File | Action | What changes |
|---|---|---|
| `web/src/stream/engine.ts` | modify | `onRecovering`/`onRecovered` handlers (l.21-36), `bufferAheadS` (l.46-55), buffer and retry constants, `networkRecovery()` (appended) |
| `web/src/stream/hlsEngine.ts` | modify | whole file: buffer from `bufferAheadS`, fatal network errors go to `networkRecovery`, `FRAG_LOADED` ends a recovery |
| `web/src/stream/dashEngine.ts` | modify | whole file: download error codes go to `networkRecovery` (`attachSource` at the position), `FRAGMENT_LOADING_COMPLETED` ends it |
| `web/src/stream/nativeEngine.ts` | modify | whole file: `MEDIA_ERR_NETWORK` reloads the file and puts the picture back |
| `web/src/stream/controller.ts` | modify | `Stage` (l.19), imports (l.1), `bufferAheadS` and the two handlers in `attach` (l.306-345), `onRecovering`/`onRecovered`/`onFilm` (after `onReady`, l.351), `onFilm()` in the position handlers (l.412-439), `playWithSound` (l.136), `goToEpisode` (l.205) |
| `web/src/stream/StreamApp.tsx` | modify | `StageOverlay` busy branch (l.222-229), idle-hide condition (l.339) |
| `web/src/stream/hlsEngine.test.tsx` | create | hls.js mocked at the module boundary: buffer config, restart, spent, manifest, refusal, destroy, media error |
| `web/src/stream/nativeEngine.test.tsx` | create | reload after a network error, spent, other media errors, refusal |
| `web/src/stream/dashEngine.test.tsx` | modify | mock gains `attachSource` and `FRAGMENT_LOADING_COMPLETED`; handlers helper gains the two handlers; new describe for download errors |
| `web/src/stream/controller.test.tsx` | modify | new describe "a network error (R1.7)" and the buffer request (R1.8) |
| `web/src/stream/StreamApp.test.tsx` | modify | reconnecting spinner then the error |
| `.claude/skills/verify-notesd/scripts/stream/player.steps.mjs` | modify | BUFFER check; J3 moves to `?muted=1` (with 120 s ahead the 120 s fixture is fully loaded before the seek) |
| `.claude/skills/verify-notesd/scripts/stream/recovery.steps.mjs` | create | RECOVER and SPENT journeys in real Chromium |
| `.claude/skills/verify-notesd/features/direct-streaming.md` | modify | player sub-feature and the two journey scripts |
| `docs/guide/streaming.md` | modify | "A network error" and "Buffer" bullets in the player list; `stage` values |

## Implementation Steps

Before anything: the worktree has no `node_modules`; run `npm ci` in
`/home/miftah/.worktrees/mcp-notes/stream-cache-and-bug-report` once.

**Shared files (reconciled).** Phase 1 has landed: `controller.ts`, `controller.test.tsx` and
`dashEngine.test.tsx` are edited as phase 1 left them, matched by text (keep phase 1's `send` /
`postEvents` lines and its refresh-counting line at `dashEngine.test.tsx:118`). This phase runs beside
phases 3 and 5: its only shared files with them are `docs/guide/streaming.md` and
`.claude/skills/verify-notesd/features/direct-streaming.md`, where every edit is additive and anchored
by the quoted text. Phases 4 and 6 edit `controller.ts`, `StreamApp.tsx` and `engine.ts` after this
phase and quote them as it leaves them; phase 6 builds on `EngineRequest.bufferAheadS`,
`BUFFER_AHEAD_S` and `MUTED_BUFFER_AHEAD_S` (one buffer setting, reconciled). No route or tool is
added, so the generated references are untouched.

### Step 1: Retry and buffer primitives in the engine contract
**File:** `web/src/stream/engine.ts:21-55` and appended at the end (after l.95)
**Change:** Replace the `EngineHandlers` interface (l.21-36) and the `EngineRequest` interface
(l.46-55) with the versions below, and append the constants and `networkRecovery()` at the end of
the file. Nothing else in the file changes.
**Code:**
```ts
export interface EngineHandlers {
  /** The manifest is read: its renditions and subtitle tracks are known. */
  onReady(ready: EngineReady): void;
  /**
   * A request through the pass-through came back 401, 403 or 410 with `X-Notesd-Upstream`: the
   * stream host refused the token. The controller refreshes the session.
   */
  onAuthError(status: number): void;
  /**
   * A 401, 403 or 410 without `X-Notesd-Upstream`: notesd itself refused (`unknown_session`,
   * `forbidden_host`). The session is over; a refresh cannot help.
   */
  onSessionOver(status: number): void;
  /**
   * A fatal network error that is not a refusal (hls.js `fragLoadError`, `fragLoadTimeOut`,
   * `levelLoadError`, `manifestLoadError` and kin; a dash.js download error; a plain file's
   * network error). The engine loads again from where the film is after
   * `networkRetryDelayMs(attempt)`; the film stays on the page. `attempt` runs 1..NETWORK_RETRY_LIMIT,
   * and when it is spent the next failure comes as onFatal.
   */
  onRecovering(attempt: number, message: string): void;
  /** A load succeeded after a restart: the play goes on and the attempts start again. */
  onRecovered(): void;
  /** Playback cannot go on for another reason. */
  onFatal(message: string): void;
}
```
```ts
export interface EngineRequest {
  kind: ManifestKind;
  video: HTMLVideoElement;
  src: string;
  /** Seconds to start at; 0 = the start. */
  startAt: number;
  /** The audio track to play (the title's original language) when the manifest names several; null: the manifest's default. */
  audioTrack?: AudioTrackRef | null;
  /** Seconds of the film to keep loaded ahead of the picture (HLS); BUFFER_AHEAD_S when left out. */
  bufferAheadS?: number;
  handlers: EngineHandlers;
}
```
Appended at the end of `engine.ts`:
```ts
/** How far ahead of the picture a play keeps the film loaded (R1.8); hls.js held 30 s before. */
export const BUFFER_AHEAD_S = 120;

/**
 * The same under `?muted=1`: the expiry checks (playcheck.mjs, player.steps.mjs J3) need segments
 * that are not loaded yet when the token expires.
 */
export const MUTED_BUFFER_AHEAD_S = 30;

/** Restarts after a fatal network error before the play stops with the error (R1.7). */
export const NETWORK_RETRY_LIMIT = 5;

/** The wait before restart `attempt` (1-based): 2, 4, 8, 16, 16 s. The libraries' own per-request retries come first. */
export function networkRetryDelayMs(attempt: number): number {
  return Math.min(2_000 * 2 ** (attempt - 1), 16_000);
}

export interface NetworkRecovery {
  /** A fatal network error: the next restart after its wait, or `message` to onFatal once the restarts are spent. */
  fail(message: string): void;
  /** A load succeeded: after a restart, the recovery is over and the count starts again. */
  loaded(): void;
  /** No restart from now on (the engine is destroyed, or its session refused). */
  stop(): void;
}

/**
 * The restart loop all three engines share. `restart` loads again from where the film is; it runs
 * only after the wait and never after stop(). A failure while a restart is waiting is the same
 * failure (several loads fail at once) and is not counted twice.
 */
export function networkRecovery(handlers: EngineHandlers, restart: () => void): NetworkRecovery {
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  return {
    fail(message) {
      if (stopped || timer !== null) return;
      if (attempt >= NETWORK_RETRY_LIMIT) {
        stopped = true;
        handlers.onFatal(message);
        return;
      }
      attempt += 1;
      handlers.onRecovering(attempt, message);
      timer = setTimeout(() => {
        timer = null;
        if (!stopped) restart();
      }, networkRetryDelayMs(attempt));
    },
    loaded() {
      if (stopped || timer !== null || attempt === 0) return;
      attempt = 0;
      handlers.onRecovered();
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
```
**Impact:** every `EngineHandlers` object must now carry the two handlers: the controller's (step 5)
and the test helpers (steps 7, 9). `npm run typecheck` fails until steps 5 and 9 land, so steps 1-5
and 9 are one commit.

### Step 2: hls.js — keep 120 s ahead, restart after a fatal network error
**File:** `web/src/stream/hlsEngine.ts` (whole file, 71 lines)
**Change:** Replace the file. The buffer limits both come from `bufferAheadS` (hls.js sizes its
buffer as `max(maxBufferLength, maxBufferSize/bitrate)` capped by `maxMaxBufferLength`; setting both
to the same value makes it exactly that, whatever the bitrate). A fatal `NETWORK_ERROR` goes to the
recovery instead of `onFatal`; a refusal stops the recovery (the engine is about to be replaced, or
the session is over). Before `MANIFEST_PARSED` there is nothing to continue, so the restart asks for
the manifest again (`loadSource`, which starts loading itself); after it, `startLoad` at the
picture's position.
**Code:**
```ts
import Hls, { ErrorTypes, Events, type MediaPlaylist } from 'hls.js';
import {
  audioTrackIndex,
  BUFFER_AHEAD_S,
  networkRecovery,
  reportRefusal,
  UPSTREAM_HEADER,
  type EngineRequest,
  type PlayerEngine,
} from './engine';

/** X-Notesd-Upstream of a failed load: hls.js's default XhrLoader hands the XMLHttpRequest over as `networkDetails`. */
function upstreamOf(details: unknown): string | null {
  const d = details as { getResponseHeader?: (name: string) => string | null; headers?: { get?: (name: string) => string | null } } | null | undefined;
  if (typeof d?.getResponseHeader === 'function') return d.getResponseHeader(UPSTREAM_HEADER);
  if (typeof d?.headers?.get === 'function') return d.headers.get(UPSTREAM_HEADER);
  return null;
}

export function createHlsEngine({ video, src, startAt, handlers, audioTrack, bufferAheadS = BUFFER_AHEAD_S }: EngineRequest): PlayerEngine {
  if (!Hls.isSupported()) {
    handlers.onFatal('hls_unsupported');
    return { setQuality() {}, setEmbeddedSubtitle() {}, destroy() {} };
  }
  // hls.js sizes its forward buffer from maxBufferLength and the bitrate, capped at
  // maxMaxBufferLength (up to 600 s by default). Both are bufferAheadS, so a play keeps exactly that
  // much loaded ahead (R1.8): 120 s, or 30 s under ?muted=1 so the expiry checks (playcheck.mjs,
  // player.steps.mjs J3) still find segments not yet loaded when the token expires.
  const hls = new Hls({
    startPosition: startAt > 0 ? startAt : -1,
    maxBufferLength: bufferAheadS,
    maxMaxBufferLength: bufferAheadS,
  });
  let subtitleTracks: MediaPlaylist[] = [];
  let mediaRecovered = false;
  let manifestParsed = false;
  // R1.7: after a fatal network error, load again from where the film is. Before the manifest was
  // read there is nothing to continue, so the manifest is asked for again.
  const network = networkRecovery(handlers, () => {
    if (!manifestParsed) {
      hls.loadSource(src);
      return;
    }
    hls.startLoad(video.currentTime > 0 ? video.currentTime : startAt > 0 ? startAt : -1);
  });

  hls.on(Events.MANIFEST_PARSED, (_event, data) => {
    manifestParsed = true;
    subtitleTracks = data.subtitleTracks;
    // The original-language audio, never the manifest's default when that is a dub.
    const audio = audioTrackIndex(data.audioTracks.map((t) => ({ lang: t.lang ?? null, label: t.name })), audioTrack);
    if (audio !== -1) hls.audioTrack = audio;
    handlers.onReady({
      qualities: data.levels.map((level, index) => ({
        index,
        height: level.height > 0 ? level.height : null,
        bitrate: level.bitrate > 0 ? level.bitrate : null,
      })),
      subtitles: subtitleTracks.map((track, index) => ({ index, label: track.name, lang: track.lang ?? null })),
    });
  });

  hls.on(Events.FRAG_LOADED, () => {
    network.loaded();
  });

  hls.on(Events.ERROR, (_event, data) => {
    if (reportRefusal(handlers, data.response?.code, upstreamOf(data.networkDetails))) {
      // A refresh replaces this engine, or the session is over: no restart either way.
      network.stop();
      return;
    }
    if (!data.fatal) return;
    if (data.type === ErrorTypes.NETWORK_ERROR) {
      network.fail(`${data.type} ${data.details}`);
      return;
    }
    if (data.type === ErrorTypes.MEDIA_ERROR && !mediaRecovered) {
      mediaRecovered = true;
      hls.recoverMediaError();
      return;
    }
    handlers.onFatal(`${data.type} ${data.details}`);
  });

  hls.loadSource(src);
  hls.attachMedia(video);

  return {
    setQuality(index) {
      hls.currentLevel = index;
    },
    setEmbeddedSubtitle(index) {
      const track = index === null ? undefined : subtitleTracks[index];
      if (track === undefined) {
        hls.subtitleTrack = -1;
        hls.subtitleDisplay = false;
        return;
      }
      hls.setSubtitleOption(track);
      hls.subtitleDisplay = true;
    },
    destroy() {
      network.stop();
      hls.destroy();
    },
  };
}
```
**Impact:** the message after the retries are spent is the same string as today
(`networkError fragLoadError`), so the page's error text is unchanged. A refusal still goes to
`onAuthError` / `onSessionOver` before anything else.

### Step 3: dash.js — reopen the stream after a download error
**File:** `web/src/stream/dashEngine.ts` (whole file, 77 lines)
**Change:** Replace the file. dash.js's download error codes (`MediaPlayerErrors`: 11 manifest
loader, 25 manifest, 26 sidx, 27 content, 28 init segment, 29 xlink) go to the recovery, which
reopens the stream with `attachSource(src, position)`; any other error stays fatal at once.
`FRAGMENT_LOADING_COMPLETED` without an `error` ends a recovery (dash.js fires it for failed loads too,
with the error inside). A refusal seen by the interceptor stops the recovery. The dash.js buffer
settings are **not** changed (see Principles applied / Risks: `dash-expiry.steps.mjs` plays a
120 s DASH fixture without `?muted=1` and needs unloaded segments at 100 s).
**Code:**
```ts
import { MediaPlayer, type MediaInfo } from 'dashjs';
import { audioTrackIndex, networkRecovery, reportRefusal, UPSTREAM_HEADER, type EngineRequest, type PlayerEngine } from './engine';

/**
 * dash.js's codes for a load that failed after its own retries (MediaPlayerErrors): the manifest
 * loader (11) and the manifest, sidx, segment, init segment and xlink downloads (25-29).
 */
const NETWORK_ERROR_CODES: ReadonlySet<number> = new Set([11, 25, 26, 27, 28, 29]);

/** X-Notesd-Upstream of a response the interceptor saw (dash.js 5 lower-cases header names in `headers`). */
function upstreamOf(response: unknown): string | null {
  const headers = (response as { headers?: Record<string, string> | null } | null)?.headers;
  return headers?.[UPSTREAM_HEADER] ?? null;
}

function describe(event: unknown): string {
  try {
    const error = (event as { error?: unknown }).error ?? event;
    return JSON.stringify(error).slice(0, 200);
  } catch {
    return 'error';
  }
}

function errorCode(event: unknown): number | null {
  const code = (event as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === 'number' ? code : null;
}

export function createDashEngine({ video, src, startAt, handlers, audioTrack }: EngineRequest): PlayerEngine {
  const player = MediaPlayer().create();
  let textTracks: MediaInfo[] = [];
  let live = true;
  // R1.7: dash.js has retried the download already; open the stream again where the film is.
  const network = networkRecovery(handlers, () => {
    if (live) player.attachSource(src, video.currentTime > 0 ? video.currentTime : startAt > 0 ? startAt : undefined);
  });

  player.updateSettings({ streaming: { text: { defaultEnabled: false } } });
  player.addResponseInterceptor(async (response) => {
    // A refresh replaces this engine, or the session is over: no restart either way.
    if (live && reportRefusal(handlers, response.status, upstreamOf(response))) network.stop();
    return response;
  });
  player.on(MediaPlayer.events.STREAM_INITIALIZED, () => {
    if (!live) return;
    textTracks = player.getTracksFor('text');
    // The original-language audio, never the manifest's default when that is a dub.
    const audioTracks = player.getTracksFor('audio');
    const audio = audioTrackIndex(audioTracks.map((t) => ({ lang: t.lang, label: t.labels[0]?.text ?? null })), audioTrack);
    if (audio !== -1 && audioTracks[audio] !== undefined) player.setCurrentTrack(audioTracks[audio]);
    handlers.onReady({
      qualities: player.getRepresentationsByType('video').map((rep, index) => ({
        index,
        height: rep.height > 0 ? rep.height : null,
        bitrate: rep.bandwidth > 0 ? rep.bandwidth : null,
      })),
      subtitles: textTracks.map((track, index) => ({
        index,
        label: track.labels[0]?.text ?? track.lang ?? `Track ${index + 1}`,
        lang: track.lang,
      })),
    });
  });
  player.on(MediaPlayer.events.FRAGMENT_LOADING_COMPLETED, (event: unknown) => {
    // dash.js says "completed" for a failed load too, with its error in the event.
    if (live && (event as { error?: unknown } | null)?.error == null) network.loaded();
  });
  player.on(MediaPlayer.events.ERROR, (event: unknown) => {
    if (!live) return;
    const message = `dash ${describe(event)}`;
    const code = errorCode(event);
    if (code !== null && NETWORK_ERROR_CODES.has(code)) network.fail(message);
    else handlers.onFatal(message);
  });
  player.initialize(video, src, false, startAt > 0 ? startAt : undefined);

  return {
    setQuality(index) {
      if (index < 0) {
        player.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: true } } } });
        return;
      }
      player.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: false } } } });
      player.setRepresentationForTypeByIndex('video', index, true);
    },
    setEmbeddedSubtitle(index) {
      const track = index === null ? undefined : textTracks[index];
      if (track === undefined) {
        player.enableText(false);
        return;
      }
      player.setCurrentTrack(track);
      player.enableText(true);
    },
    destroy() {
      live = false;
      network.stop();
      player.reset();
    },
  };
}
```
**Impact:** a reopened stream fires `STREAM_INITIALIZED` again, so `onReady` runs again; the
controller's `applyChoices` already handles a second `onReady` (it does so after a refresh). If
`player.on(MediaPlayer.events.FRAGMENT_LOADING_COMPLETED, (event: unknown) => …)` does not
typecheck against dash.js 5.2.1's overloads, type the listener as
`(event: { error?: unknown }) => …` — the behavior is the same.

### Step 4: The plain-file engine — reload after a network error
**File:** `web/src/stream/nativeEngine.ts` (whole file, 40 lines)
**Change:** Replace the file. A media error with code `MEDIA_ERR_NETWORK` (2), or a probe that
cannot reach the daemon at all, goes to the recovery, which reloads the file (`video.src = src`); the
next `loadedmetadata` puts the picture back where it stopped, ends the recovery and plays again if
it was playing. Any other media error is fatal at once, as today; a refusal is still a refusal.
`onReady` is sent once, on the first load only.
**Code:**
```ts
import { networkRecovery, reportRefusal, UPSTREAM_HEADER, type EngineRequest, type PlayerEngine } from './engine';

/** MediaError.MEDIA_ERR_NETWORK: the browser lost the file while loading it. */
const MEDIA_ERR_NETWORK = 2;

export function createNativeEngine({ video, src, startAt, handlers }: EngineRequest, fetchImpl: typeof fetch = fetch): PlayerEngine {
  let live = true;
  let readied = false;
  /** Where the next loadedmetadata puts the picture: the start, then where a network error stopped the film. */
  let resumeAt = startAt;
  let resumePlaying = false;
  // R1.7: load the file again; onMeta continues from resumeAt.
  const network = networkRecovery(handlers, () => {
    if (live) video.src = src;
  });
  const onMeta = () => {
    if (!live) return;
    if (resumeAt > 0) video.currentTime = resumeAt;
    if (readied) {
      network.loaded();
      if (resumePlaying) void Promise.resolve(video.play()).catch(() => {});
      return;
    }
    readied = true;
    handlers.onReady({
      qualities: video.videoHeight > 0 ? [{ index: 0, height: video.videoHeight, bitrate: null }] : [],
      subtitles: [],
    });
  };
  const onError = () => {
    if (!live) return;
    const code = video.error?.code ?? 0;
    const why = `media error ${code}`;
    if (video.currentTime > 0) resumeAt = video.currentTime;
    resumePlaying = !video.paused;
    fetchImpl(src, { headers: { range: 'bytes=0-0' } })
      .then((res) => {
        if (!live) return;
        if (reportRefusal(handlers, res.status, res.headers.get(UPSTREAM_HEADER))) {
          network.stop();
          return;
        }
        if (code === MEDIA_ERR_NETWORK) network.fail(why);
        else handlers.onFatal(why);
      })
      .catch(() => {
        // The probe could not reach the daemon either: the network, not the file.
        if (live) network.fail(why);
      });
  };
  video.addEventListener('loadedmetadata', onMeta);
  video.addEventListener('error', onError);
  video.src = src;

  return {
    setQuality() {},
    setEmbeddedSubtitle() {},
    destroy() {
      live = false;
      network.stop();
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('error', onError);
      video.removeAttribute('src');
      video.load();
    },
  };
}
```
**Impact:** a probe that throws used to be `onFatal`; it is now a retried network failure that ends
in the same `onFatal(why)` once spent.

### Step 5: The controller's `recovering` stage
**File:** `web/src/stream/controller.ts` — as it stands after phase 1. Each edit is matched by the
quoted text; phase 1's lines in `note()` / `fail()` and anything it added are left as they are.

**5a. Imports** (l.1). Replace
`import type { CreateEngine, EngineReady, PlayerEngine, Quality } from './engine';` with:
```ts
import {
  BUFFER_AHEAD_S,
  MUTED_BUFFER_AHEAD_S,
  NETWORK_RETRY_LIMIT,
  type CreateEngine,
  type EngineReady,
  type PlayerEngine,
  type Quality,
} from './engine';
```

**5b. Stage** (l.19). Replace `export type Stage = 'loading' | 'ready' | 'refreshing' | 'error';` with:
```ts
/** `recovering`: a network error; the engine loads again after a wait while the film stays on the page. */
export type Stage = 'loading' | 'ready' | 'refreshing' | 'recovering' | 'error';
```

**5c. playWithSound** (l.136). Replace
`    if (this.disposed || this.state.stage !== 'ready') return false;` with:
```ts
    if (this.disposed || !this.onFilm()) return false;
```

**5d. goToEpisode** (l.205). Replace
`    if (this.state.stage === 'ready' && !this.video.ended) this.report({ closed: true });` with:
```ts
    if (this.onFilm() && !this.video.ended) this.report({ closed: true });
```

**5e. attach** (l.306-345). Replace the whole method with:
```ts
  private async attach(session: StreamSession, startAt: number): Promise<void> {
    const generation = ++this.generation;
    const current = () => generation === this.generation && !this.disposed;
    this.ready = null;
    this.readySinceAttach = false;
    let engine: PlayerEngine;
    try {
      engine = await this.deps.createEngine({
        kind: session.manifestKind,
        video: this.video,
        src: session.manifestUrl,
        startAt,
        audioTrack: session.audioTrack,
        // R1.8: 120 s ahead; ?muted=1 keeps 30 s for the expiry checks.
        bufferAheadS: this.mutedMode ? MUTED_BUFFER_AHEAD_S : BUFFER_AHEAD_S,
        handlers: {
          onReady: (ready) => {
            if (current()) this.onReady(ready);
          },
          onAuthError: (status) => {
            if (current()) void this.refresh(status);
          },
          onSessionOver: (status) => {
            // notesd's own refusal (no X-Notesd-Upstream): the session is gone; a refresh cannot help.
            if (current() && this.state.stage !== 'error') this.fail(new SessionError('session_over', status));
          },
          onRecovering: (attempt, message) => {
            if (current()) this.onRecovering(attempt, message);
          },
          onRecovered: () => {
            if (current()) this.onRecovered();
          },
          onFatal: (message) => {
            if (current()) this.fail(new SessionError(message, 0));
          },
        },
      });
    } catch (err) {
      if (current()) this.fail(err);
      return;
    }
    if (!current()) {
      engine.destroy();
      return;
    }
    this.engine = engine;
    if (this.ready !== null) this.applyChoices();
  }
```

**5f. New methods**, inserted right after `onReady` (after l.351, before `applyChoices`):
```ts
  /**
   * R1.7: the engine lost the network and loads again after a wait. The film stays on the page
   * (it plays on from its buffer meanwhile); the error is shown only when the engine gives up.
   */
  private onRecovering(attempt: number, message: string): void {
    if (this.state.stage === 'error') return;
    const at = this.video.currentTime > 0 ? this.video.currentTime : this.lastPositionS;
    this.set({ stage: 'recovering' });
    this.note(`recovering ${attempt}/${NETWORK_RETRY_LIMIT} after ${message} at ${round1(at)} s`);
  }

  /** A load succeeded after a restart: back to the film (or to loading, when it never played since attach). */
  private onRecovered(): void {
    if (this.state.stage === 'error') return;
    if (this.state.stage === 'recovering') this.set({ stage: this.readySinceAttach ? 'ready' : 'loading' });
    this.note(`recovered at ${round1(this.video.currentTime)} s`);
  }

  /** The film is on the page: playing, paused, or riding out a network error on its buffer. */
  private onFilm(): boolean {
    return this.state.stage === 'ready' || this.state.stage === 'recovering';
  }
```

**5g. Position handlers** (l.412-439). Replace the block from `private readonly onTime` through
`onClose` with:
```ts
  private readonly onTime = (): void => {
    if (this.onFilm() && this.video.currentTime > 0) this.lastPositionS = this.video.currentTime;
  };

  // Every 5 s while the page is open: the position while it plays, and a beat while it is paused, so
  // the Movies page knows the film is still on screen (src/movies/streamLive.ts). A recovery is still
  // the film on screen: it plays on from its buffer.
  private readonly onTick = (): void => {
    if (!this.onFilm() || this.video.ended) return;
    this.report(this.video.paused ? { beat: true } : {});
  };

  private readonly onPause = (): void => {
    if (this.onFilm() && !this.video.ended) this.report();
  };

  // Play after a pause: say so at once, not at the next tick.
  private readonly onPlay = (): void => {
    if (this.onFilm() && !this.video.ended) this.report();
  };

  private readonly onEnded = (): void => {
    if (this.onFilm()) this.report({ ended: true });
  };

  // The tab or the window closes: the last position, and the film is no longer on screen.
  private readonly onClose = (): void => {
    if (this.onFilm() && !this.video.ended) this.report({ closed: true });
  };
```
**Impact:** `refresh()` is unchanged: a refused token during a recovery still refreshes (stage
`recovering` is neither `refreshing` nor `error`), and a refusal of a just-refreshed engine that has
not played is still caught by `refreshes > 0 && !readySinceAttach`. `errors` gets nothing during a
recovery, so `playcheck.mjs`'s verdicts read the same errors as before.

### Step 6: The reconnecting spinner
**File:** `web/src/stream/StreamApp.tsx:222-229` and `:339`
**Change:** The busy branch of `StageOverlay` also covers `recovering`, with its own label. Leave the
error branch (l.230-238) exactly as it is (phase 4 edits it). The controls hide while idle in
`recovering` too, since the film plays on.
**Code:** insert above `function StageOverlay` (after `type MenuName` is fine too; keep it above the function):
```tsx
const BUSY_LABELS = { loading: 'Loading', refreshing: 'Reconnecting', recovering: 'Reconnecting after a network error' } as const;
```
Replace the first `if` of `StageOverlay` (l.223-229):
```tsx
  if (state.stage === 'loading' || state.stage === 'refreshing' || state.stage === 'recovering') {
    return (
      <div className="st-center" role="status" aria-label={BUSY_LABELS[state.stage]}>
        <CircleNotch className="st-spin" />
      </div>
    );
  }
```
Replace l.339:
```tsx
  const hidden = idle && !view.paused && menu === null && (state.stage === 'ready' || state.stage === 'recovering') && state.switching === null;
```
**Impact:** icon only (Phosphor `CircleNotch`, already imported); `.st-center` has
`pointer-events: none`, so the film's controls stay usable during a recovery. No CSS change.

### Step 7: hls.js engine tests
**File:** `web/src/stream/hlsEngine.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeVideo } from '../testing/streamFakes';

/** One hls.js instance as the engine drives it: its config, what it was told, and a hook to fire its events. */
interface FakeHls {
  config: Record<string, unknown>;
  loadSource: ReturnType<typeof vi.fn>;
  startLoad: ReturnType<typeof vi.fn>;
  recoverMediaError: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  emit(event: string, data?: unknown): void;
}

const instances = vi.hoisted(() => [] as FakeHls[]);

vi.mock('hls.js', () => {
  const Events = { MANIFEST_PARSED: 'hlsManifestParsed', ERROR: 'hlsError', FRAG_LOADED: 'hlsFragLoaded' };
  const ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError', OTHER_ERROR: 'otherError' };
  class Hls {
    static isSupported(): boolean {
      return true;
    }
    audioTrack = -1;
    currentLevel = -1;
    subtitleTrack = -1;
    subtitleDisplay = false;
    private readonly listeners = new Map<string, ((event: string, data: unknown) => void)[]>();
    private readonly fake: FakeHls;
    constructor(config: Record<string, unknown>) {
      this.fake = {
        config,
        loadSource: vi.fn(),
        startLoad: vi.fn(),
        recoverMediaError: vi.fn(),
        destroy: vi.fn(),
        emit: (event, data) => {
          for (const listener of this.listeners.get(event) ?? []) listener(event, data);
        },
      };
      instances.push(this.fake);
    }
    on(event: string, listener: (event: string, data: unknown) => void): void {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    }
    loadSource(src: string): void {
      this.fake.loadSource(src);
    }
    attachMedia(): void {}
    startLoad(position: number): void {
      this.fake.startLoad(position);
    }
    recoverMediaError(): void {
      this.fake.recoverMediaError();
    }
    setSubtitleOption(): void {}
    destroy(): void {
      this.fake.destroy();
    }
  }
  return { default: Hls, Events, ErrorTypes };
});

import { BUFFER_AHEAD_S, MUTED_BUFFER_AHEAD_S, NETWORK_RETRY_LIMIT, networkRetryDelayMs, type EngineHandlers } from './engine';
import { createHlsEngine } from './hlsEngine';

const SRC = '/api/stream/sessions/S1/p?u=m1';
const PARSED = { levels: [{ height: 720, bitrate: 2_000_000 }], audioTracks: [], subtitleTracks: [] };
const fragError = (details = 'fragLoadError') => ({ type: 'networkError', details, fatal: true, response: { code: 0 } });

afterEach(() => {
  instances.length = 0;
  vi.useRealTimers();
});

function handlers(): EngineHandlers & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    onReady: () => calls.push('ready'),
    onAuthError: (status) => calls.push(`auth ${status}`),
    onSessionOver: (status) => calls.push(`over ${status}`),
    onRecovering: (attempt, message) => calls.push(`recovering ${attempt} ${message}`),
    onRecovered: () => calls.push('recovered'),
    onFatal: (message) => calls.push(`fatal ${message}`),
  };
}

function start(over: { bufferAheadS?: number; startAt?: number } = {}) {
  const { video, media } = fakeVideo();
  const h = handlers();
  const engine = createHlsEngine({
    kind: 'hls',
    video,
    src: SRC,
    startAt: over.startAt ?? 0,
    handlers: h,
    ...(over.bufferAheadS === undefined ? {} : { bufferAheadS: over.bufferAheadS }),
  });
  return { engine, hls: instances.at(-1)!, media, h };
}

describe('createHlsEngine: how far ahead it loads (R1.8)', () => {
  it('keeps 120 s ahead whatever the bitrate, and 30 s when the page asks for it (?muted=1)', () => {
    expect(BUFFER_AHEAD_S).toBe(120);
    expect(start().hls.config).toMatchObject({ maxBufferLength: 120, maxMaxBufferLength: 120 });
    expect(start({ bufferAheadS: MUTED_BUFFER_AHEAD_S }).hls.config).toMatchObject({ maxBufferLength: 30, maxMaxBufferLength: 30 });
  });
});

describe('createHlsEngine: a fatal network error (R1.7)', () => {
  it('waits, loads again from where the film is, and goes on once a fragment loads', () => {
    vi.useFakeTimers();
    const { hls, media, h } = start();
    hls.emit('hlsManifestParsed', PARSED);
    media.currentTime = 312.4;
    hls.emit('hlsError', fragError());
    expect(h.calls).toEqual(['ready', 'recovering 1 networkError fragLoadError']);
    vi.advanceTimersByTime(networkRetryDelayMs(1) - 1);
    expect(hls.startLoad).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(hls.startLoad).toHaveBeenCalledWith(312.4);
    hls.emit('hlsFragLoaded', {});
    expect(h.calls.at(-1)).toBe('recovered');
    // The count started again: the next failure is a first try again.
    hls.emit('hlsError', fragError());
    expect(h.calls.at(-1)).toBe('recovering 1 networkError fragLoadError');
  });

  it(`stops with the error only after ${NETWORK_RETRY_LIMIT} restarts that did not help, waiting longer each time`, () => {
    vi.useFakeTimers();
    const { hls, h } = start();
    hls.emit('hlsManifestParsed', PARSED);
    for (let attempt = 1; attempt <= NETWORK_RETRY_LIMIT; attempt++) {
      hls.emit('hlsError', fragError('fragLoadTimeOut'));
      // A second fatal error while the restart waits (audio and video at once) is the same failure.
      hls.emit('hlsError', fragError('fragLoadTimeOut'));
      expect(h.calls.at(-1)).toBe(`recovering ${attempt} networkError fragLoadTimeOut`);
      vi.advanceTimersByTime(networkRetryDelayMs(attempt));
      expect(hls.startLoad).toHaveBeenCalledTimes(attempt);
    }
    hls.emit('hlsError', fragError('fragLoadTimeOut'));
    expect(h.calls.at(-1)).toBe('fatal networkError fragLoadTimeOut');
    expect(h.calls.filter((c) => c.startsWith('recovering'))).toHaveLength(NETWORK_RETRY_LIMIT);
    hls.emit('hlsError', fragError('fragLoadTimeOut'));
    expect(h.calls.filter((c) => c.startsWith('fatal'))).toHaveLength(1);
    expect([1, 2, 3, 4, 5].map(networkRetryDelayMs)).toEqual([2_000, 4_000, 8_000, 16_000, 16_000]);
  });

  it('asks for the manifest again when it never loaded', () => {
    vi.useFakeTimers();
    const { hls, h } = start({ startAt: 600 });
    expect(hls.loadSource).toHaveBeenCalledTimes(1);
    hls.emit('hlsError', { type: 'networkError', details: 'manifestLoadError', fatal: true, response: { code: 0 } });
    expect(h.calls).toEqual(['recovering 1 networkError manifestLoadError']);
    vi.advanceTimersByTime(networkRetryDelayMs(1));
    expect(hls.loadSource).toHaveBeenCalledTimes(2);
    expect(hls.loadSource).toHaveBeenLastCalledWith(SRC);
    expect(hls.startLoad).not.toHaveBeenCalled();
  });

  it('a refused token is still a refresh, never a retry', () => {
    vi.useFakeTimers();
    const { hls, h } = start();
    hls.emit('hlsManifestParsed', PARSED);
    hls.emit('hlsError', { ...fragError(), response: { code: 403 }, networkDetails: { getResponseHeader: () => '403' } });
    hls.emit('hlsError', fragError());
    vi.advanceTimersByTime(60_000);
    expect(h.calls).toEqual(['ready', 'auth 403']);
    expect(hls.startLoad).not.toHaveBeenCalled();
  });

  it('a destroyed engine restarts nothing', () => {
    vi.useFakeTimers();
    const { engine, hls, h } = start();
    hls.emit('hlsManifestParsed', PARSED);
    hls.emit('hlsError', fragError());
    engine.destroy();
    vi.advanceTimersByTime(60_000);
    expect(hls.destroy).toHaveBeenCalled();
    expect(hls.startLoad).not.toHaveBeenCalled();
    expect(h.calls).toEqual(['ready', 'recovering 1 networkError fragLoadError']);
  });

  it('a media error is still recovered once, and the second one stops the play', () => {
    const { hls, h } = start();
    hls.emit('hlsError', { type: 'mediaError', details: 'bufferStalledError', fatal: true });
    expect(hls.recoverMediaError).toHaveBeenCalledTimes(1);
    hls.emit('hlsError', { type: 'mediaError', details: 'bufferStalledError', fatal: true });
    expect(h.calls).toEqual(['fatal mediaError bufferStalledError']);
  });
});
```
**Impact:** none outside the file.

### Step 8: Plain-file engine tests
**File:** `web/src/stream/nativeEngine.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NETWORK_RETRY_LIMIT, networkRetryDelayMs, type EngineHandlers } from './engine';
import { createNativeEngine } from './nativeEngine';
import { fakeVideo } from '../testing/streamFakes';

const SRC = '/api/stream/sessions/S1/p?u=film.mp4';

afterEach(() => {
  vi.useRealTimers();
});

function handlers(): EngineHandlers & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    onReady: () => calls.push('ready'),
    onAuthError: (status) => calls.push(`auth ${status}`),
    onSessionOver: (status) => calls.push(`over ${status}`),
    onRecovering: (attempt, message) => calls.push(`recovering ${attempt} ${message}`),
    onRecovered: () => calls.push('recovered'),
    onFatal: (message) => calls.push(`fatal ${message}`),
  };
}

/** A <video> whose MediaError the test sets, recording every address the engine hands it. */
function nativeVideo() {
  const { video, media, play, fire } = fakeVideo();
  let error: { code: number } | null = null;
  const loads: string[] = [];
  Object.defineProperty(video, 'error', { configurable: true, get: () => error });
  Object.defineProperty(video, 'src', {
    configurable: true,
    get: () => loads.at(-1) ?? '',
    set: (value: string) => {
      loads.push(value);
    },
  });
  video.load = vi.fn();
  return {
    video,
    media,
    play,
    fire,
    loads,
    fail(code: number) {
      error = { code };
      fire('error');
    },
  };
}

/** The engine's probe of the file through the pass-through. */
const probe = (status: number, upstream: string | null = String(status)) =>
  vi.fn(async () => new Response('', { status, headers: upstream === null ? {} : { 'x-notesd-upstream': upstream } }));

describe('createNativeEngine: a network error (R1.7)', () => {
  it('loads the file again after a wait and puts the picture back where it stopped', async () => {
    vi.useFakeTimers();
    const v = nativeVideo();
    const h = handlers();
    createNativeEngine({ kind: 'mp4', video: v.video, src: SRC, startAt: 0, handlers: h }, probe(206));
    expect(v.loads).toEqual([SRC]);
    v.fire('loadedmetadata');
    Object.assign(v.media, { currentTime: 1312.5, paused: false });
    v.fail(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toEqual(['ready', 'recovering 1 media error 2']);
    await vi.advanceTimersByTimeAsync(networkRetryDelayMs(1));
    expect(v.loads).toEqual([SRC, SRC]);
    v.media.currentTime = 0;
    v.fire('loadedmetadata');
    expect(v.media.currentTime).toBe(1312.5);
    expect(h.calls).toEqual(['ready', 'recovering 1 media error 2', 'recovered']);
    expect(v.play).toHaveBeenCalled();
  });

  it(`stops with the error after ${NETWORK_RETRY_LIMIT} reloads that did not help`, async () => {
    vi.useFakeTimers();
    const v = nativeVideo();
    const h = handlers();
    createNativeEngine({ kind: 'mp4', video: v.video, src: SRC, startAt: 0, handlers: h }, probe(502, null));
    v.fire('loadedmetadata');
    for (let attempt = 1; attempt <= NETWORK_RETRY_LIMIT; attempt++) {
      v.fail(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.calls.at(-1)).toBe(`recovering ${attempt} media error 2`);
      await vi.advanceTimersByTimeAsync(networkRetryDelayMs(attempt));
    }
    expect(v.loads).toHaveLength(1 + NETWORK_RETRY_LIMIT);
    v.fail(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls.at(-1)).toBe('fatal media error 2');
  });

  it('a file the browser cannot play still stops at once, and a refusal is still a refusal', async () => {
    const broken = nativeVideo();
    const h = handlers();
    createNativeEngine({ kind: 'mp4', video: broken.video, src: SRC, startAt: 0, handlers: h }, probe(206));
    broken.fail(4);
    await vi.waitFor(() => expect(h.calls).toEqual(['fatal media error 4']));

    const refused = nativeVideo();
    const r = handlers();
    createNativeEngine({ kind: 'mp4', video: refused.video, src: SRC, startAt: 0, handlers: r }, probe(403));
    refused.fail(2);
    await vi.waitFor(() => expect(r.calls).toEqual(['auth 403']));
  });
});
```
**Impact:** none outside the file.

### Step 9: dash.js engine tests
**File:** `web/src/stream/dashEngine.test.tsx`
**Change:** (a) the `FakePlayer` interface (l.6-13) gains `attached`; (b) the mock (l.17-58) gains
the `FRAGMENT_LOADING_COMPLETED` event name and `attachSource`; (c) the imports after the mock
(l.60-63) gain the retry constants and `afterEach` restores real timers; (d) `handlers()` (l.72-81)
gains the two handlers; (e) a new `describe` is appended. The existing tests stay as they are.
**Code:** (a) replace l.6-13:
```tsx
interface FakePlayer {
  src: string;
  startAt: number | undefined;
  reset: ReturnType<typeof vi.fn>;
  /** Every attachSource(src, startTime) the engine made: a reopened stream. */
  attached: [string, number | undefined][];
  /** A response dash.js finished loading: runs the engine's response interceptor. */
  respond(status: number, headers?: Record<string, string>): Promise<void>;
  emit(event: string, payload?: unknown): void;
}
```
(b) replace l.17-58:
```tsx
vi.mock('dashjs', () => {
  const events = { STREAM_INITIALIZED: 'streamInitialized', ERROR: 'error', FRAGMENT_LOADING_COMPLETED: 'fragmentLoadingCompleted' };
  const MediaPlayer = () => ({
    create() {
      const listeners = new Map<string, ((payload: unknown) => void)[]>();
      const interceptors: ((response: unknown) => Promise<unknown>)[] = [];
      const player: FakePlayer = {
        src: '',
        startAt: undefined,
        reset: vi.fn(),
        attached: [],
        async respond(status, headers = {}) {
          for (const interceptor of interceptors) await interceptor({ status, headers });
        },
        emit(event, payload) {
          for (const listener of listeners.get(event) ?? []) listener(payload);
        },
      };
      players.push(player);
      return {
        updateSettings() {},
        addResponseInterceptor(fn: (response: unknown) => Promise<unknown>) {
          interceptors.push(fn);
        },
        on(event: string, fn: (payload: unknown) => void) {
          listeners.set(event, [...(listeners.get(event) ?? []), fn]);
        },
        initialize(_video: unknown, src: string, _autoplay: boolean, startAt?: number) {
          player.src = src;
          player.startAt = startAt;
        },
        attachSource(src: string, startAt?: number) {
          player.attached.push([src, startAt]);
        },
        getTracksFor: () => [],
        getRepresentationsByType: () => [{ height: 360, bandwidth: 700_000 }],
        setCurrentTrack() {},
        enableText() {},
        setRepresentationForTypeByIndex() {},
        reset: player.reset,
      };
    },
  });
  MediaPlayer.events = events;
  return { MediaPlayer };
});
```
(c) replace l.60-70 (imports through the existing `afterEach`):
```tsx
import { StreamController } from './controller';
import { createEngine } from './createEngine';
import { createDashEngine } from './dashEngine';
import { NETWORK_RETRY_LIMIT, networkRetryDelayMs, type EngineHandlers } from './engine';

const S1 = '/api/stream/sessions/S1';
const UPSTREAM = { 'x-notesd-upstream': '403' };

afterEach(() => {
  players.length = 0;
  vi.useRealTimers();
});
```
(d) replace l.72-81:
```tsx
function handlers(): EngineHandlers & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    onReady: () => calls.push('ready'),
    onAuthError: (status) => calls.push(`auth ${status}`),
    onSessionOver: (status) => calls.push(`over ${status}`),
    onRecovering: (attempt, message) => calls.push(`recovering ${attempt} ${message}`),
    onRecovered: () => calls.push('recovered'),
    onFatal: (message) => calls.push(`fatal ${message}`),
  };
}
```
(e) appended at the end of the file:
```tsx
describe('createDashEngine: a failed download (R1.7)', () => {
  it('opens the stream again where the film is after a wait, and goes on once a segment loads', () => {
    vi.useFakeTimers();
    const h = handlers();
    const { video, media } = fakeVideo();
    createDashEngine({ kind: 'dash', video, src: `${S1}/p?u=m1`, startAt: 0, handlers: h });
    media.currentTime = 100;
    players[0]!.emit('error', { error: { code: 27, message: 'segment not available' } });
    expect(h.calls).toEqual(['recovering 1 dash {"code":27,"message":"segment not available"}']);
    vi.advanceTimersByTime(networkRetryDelayMs(1));
    expect(players[0]!.attached).toEqual([[`${S1}/p?u=m1`, 100]]);
    // dash.js reports a failed load as "completed" too, with its error: not a recovery.
    players[0]!.emit('fragmentLoadingCompleted', { error: { code: 27 } });
    expect(h.calls.at(-1)).toMatch(/^recovering 1/);
    players[0]!.emit('fragmentLoadingCompleted', {});
    expect(h.calls.at(-1)).toBe('recovered');
  });

  it('stops after the restarts are spent, and at once on an error that is not a download', () => {
    vi.useFakeTimers();
    const h = handlers();
    createDashEngine({ kind: 'dash', video: fakeVideo().video, src: `${S1}/p?u=m1`, startAt: 30, handlers: h });
    for (let attempt = 1; attempt <= NETWORK_RETRY_LIMIT; attempt++) {
      players[0]!.emit('error', { error: { code: 25 } });
      vi.advanceTimersByTime(networkRetryDelayMs(attempt));
    }
    expect(players[0]!.attached).toEqual(Array.from({ length: NETWORK_RETRY_LIMIT }, () => [`${S1}/p?u=m1`, 30]));
    players[0]!.emit('error', { error: { code: 25 } });
    expect(h.calls.at(-1)).toBe('fatal dash {"code":25}');

    const other = handlers();
    createDashEngine({ kind: 'dash', video: fakeVideo().video, src: `${S1}/p?u=m1`, startAt: 0, handlers: other });
    players[1]!.emit('error', { error: { code: 23, message: 'source buffer' } });
    expect(other.calls).toEqual(['fatal dash {"code":23,"message":"source buffer"}']);
  });

  it('a refused token stops any restart', async () => {
    vi.useFakeTimers();
    const h = handlers();
    createDashEngine({ kind: 'dash', video: fakeVideo().video, src: `${S1}/p?u=m1`, startAt: 0, handlers: h });
    players[0]!.emit('error', { error: { code: 27 } });
    await players[0]!.respond(403, UPSTREAM);
    vi.advanceTimersByTime(60_000);
    expect(players[0]!.attached).toEqual([]);
    expect(h.calls).toEqual(['recovering 1 dash {"code":27}', 'auth 403']);
  });
});
```
**Impact:** the existing DASH tests keep passing: after a refresh the old player is destroyed
(`live = false`, recovery stopped), so its late `error` code 27 still says nothing.

### Step 10: Controller tests
**File:** `web/src/stream/controller.test.tsx`
**Change:** l.3-4 imports gain the constants; a new `describe` is appended at the end of the file.
Every assertion filters fetch calls by URL, so phase 1's event posts do not disturb it.
**Code:** replace l.3-4:
```tsx
import { MAX_REFRESHES, POSITION_INTERVAL_MS, StreamController } from './controller';
import { audioTrackIndex, BUFFER_AHEAD_S, classifyRefusal, MUTED_BUFFER_AHEAD_S, NETWORK_RETRY_LIMIT } from './engine';
```
Appended:
```tsx
describe('StreamController: a network error (R1.7) and the buffer (R1.8)', () => {
  it('asks the engine for 120 s ahead, and 30 s under ?muted=1', async () => {
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson()) });
    await t.controller.start();
    expect(t.made[0]?.req.bufferAheadS).toBe(BUFFER_AHEAD_S);
    const m = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson()) }, { muted: true });
    await m.controller.start();
    expect(m.made[0]?.req.bufferAheadS).toBe(MUTED_BUFFER_AHEAD_S);
  });

  it('stays on the film while the engine retries, reports positions meanwhile, and plays on when it recovers', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson()) });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    const engine = t.made[0];
    engine.req.handlers.onReady({ qualities: [], subtitles: [] });
    Object.assign(t.media, { currentTime: 300, duration: 1440, paused: false });
    t.fire('timeupdate');

    engine.req.handlers.onRecovering(1, 'networkError fragLoadError');
    expect(t.controller.getState()).toMatchObject({ stage: 'recovering', error: null, errors: [] });
    expect(t.controller.getState().log.at(-1)).toBe(`recovering 1/${NETWORK_RETRY_LIMIT} after networkError fragLoadError at 300 s`);
    expect(engine.destroy).not.toHaveBeenCalled();
    expect(t.made).toHaveLength(1);

    // The film plays on from its buffer: its position still reaches the daemon.
    t.media.currentTime = 305;
    await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS);
    expect(t.posts().at(-1)).toEqual({ position_s: 305, duration_s: 1440, ended: false, paused: false });

    engine.req.handlers.onRecovering(2, 'networkError fragLoadError');
    engine.req.handlers.onRecovered();
    expect(t.controller.getState()).toMatchObject({ stage: 'ready', error: null, errors: [] });
    expect(t.controller.getState().log.at(-1)).toBe('recovered at 305 s');
  });

  it("stops with the engine's message once the retries are spent, and a late word changes nothing", async () => {
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson()) });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    const { handlers } = t.made[0].req;
    handlers.onReady({ qualities: [], subtitles: [] });
    for (let attempt = 1; attempt <= NETWORK_RETRY_LIMIT; attempt++) handlers.onRecovering(attempt, 'networkError fragLoadError');
    expect(t.controller.getState().stage).toBe('recovering');
    handlers.onFatal('networkError fragLoadError');
    expect(t.controller.getState()).toMatchObject({ stage: 'error', error: 'networkError fragLoadError', errors: ['networkError fragLoadError'] });
    handlers.onRecovering(1, 'networkError fragLoadError');
    handlers.onRecovered();
    expect(t.controller.getState().stage).toBe('error');
  });

  it('a refused token while it recovers still refreshes, and the replaced engine is not heard', async () => {
    const t = setup({
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson()),
      [`POST ${S1}/refresh`]: () => jsonResponse(streamSessionJson()),
    });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    t.media.currentTime = 200;
    t.fire('timeupdate');
    t.made[0].req.handlers.onRecovering(1, 'networkError fragLoadError');
    t.made[0].req.handlers.onAuthError(403);
    expect(t.controller.getState().stage).toBe('refreshing');
    await vi.waitFor(() => expect(t.made).toHaveLength(2));
    expect(t.made[1].req.startAt).toBe(200);
    t.made[0].req.handlers.onRecovering(2, 'networkError fragLoadError');
    expect(t.controller.getState().stage).toBe('refreshing');
    t.made[1].req.handlers.onReady({ qualities: [], subtitles: [] });
    expect(t.controller.getState()).toMatchObject({ stage: 'ready', refreshes: 1 });
  });
});
```
**Impact:** none outside the file.

### Step 11: StreamApp test
**File:** `web/src/stream/StreamApp.test.tsx` — insert inside `describe('StreamApp', …)`, right after
the test `'says why when the session is unknown'` (l.183-190).
**Code:**
```tsx
  it('shows a reconnecting spinner on the film while the player retries, and the error once it gives up (R1.7)', async () => {
    const { made, createEngine } = fakeEngines();
    const { fetchImpl } = routeFetch({ 'GET /api/stream/sessions/S1': () => jsonResponse(streamSessionJson()) });
    const el = render(<StreamApp sessionId="S1" deps={{ fetch: fetchImpl, createEngine, textUrl: () => 'blob:x', revokeTextUrl: () => {} }} />);
    await settle();
    act(() => made[0].req.handlers.onReady({ qualities: [], subtitles: [] }));
    await settle();
    act(() => made[0].req.handlers.onRecovering(1, 'networkError fragLoadError'));
    expect(el.querySelector('.st-stage')?.getAttribute('data-stage')).toBe('recovering');
    expect(el.querySelector('[role="status"][aria-label="Reconnecting after a network error"] svg')).not.toBeNull();
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(el.querySelector('video')).not.toBeNull();
    expect(window.notesdStream?.stage).toBe('recovering');
    act(() => made[0].req.handlers.onFatal('networkError fragLoadError'));
    expect(el.querySelector('[role="alert"]')?.textContent).toBe('Playback stopped (networkError fragLoadError).');
  });
```
**Impact:** phase 4 adds a report button inside the alert; it should then compare with
`toContain('Playback stopped (networkError fragLoadError).')` if its button carries text (it is
icon-only, so `textContent` stays the same).

### Step 12: player.steps.mjs — prove the 120 s buffer; J3 on `?muted=1`
**File:** `.claude/skills/verify-notesd/scripts/stream/player.steps.mjs`
**Change:** With 120 s ahead, the 120 s fixture is fully loaded long before J3's seek to 100 s, so
the expired token would never be met (J3 would time out). J3 moves to `?muted=1` (30 s ahead), as
`playcheck.mjs --check expiry` does; a BUFFER check proves both limits.
**Code:** (a) replace header line 6:
```js
// Logs "J1 PASS", "API PASS", "BUFFER PASS", "J3 PASS", "J2 PASS", "MUTED PASS", "CDN PASS"; the first failed check throws and fails the run.
```
(b) after `const englishCueShowing = …` (l.57-60), add:
```js
// Seconds loaded ahead of the picture (the last buffered range).
const aheadS = () => {
  const v = document.querySelector('video')
  const b = v.buffered
  return b.length ? Math.round((b.end(b.length - 1) - v.currentTime) * 10) / 10 : 0
}
```
(c) replace the block from `  // J3 (R2.5): the stream host refuses the token mid-film; one refresh, playback continues there.`
through `  fake.expired = true` (l.140-141) with:
```js
  // BUFFER (R1.8): the page keeps up to 120 s loaded ahead; hls.js held 30 s before, so 60 s ahead
  // is reachable only under the new limit. ?muted=1 keeps 30 s for the expiry checks.
  await page.waitForFunction((min) => {
    const v = document.querySelector('video')
    const b = v.buffered
    return b.length > 0 && b.end(b.length - 1) - v.currentTime >= min
  }, 60, { timeout: 30_000 })
  const ahead = await page.evaluate(aheadS)

  // J3 (R2.5) runs on ?muted=1, as playcheck's expiry check does: there the page keeps 30 s ahead,
  // so the segments past the seek are not loaded yet when the token expires.
  await page.goto(`${base}/stream/S1?muted=1`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 30_000 })
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !!v && !v.paused && v.currentTime > 21
  }, null, { timeout: 30_000 })
  await page.waitForTimeout(3_000)
  const mutedAhead = await page.evaluate(aheadS)
  check(mutedAhead <= 40, `BUFFER: ?muted=1 keeps about 30 s ahead (got ${mutedAhead} s)`)
  log(`BUFFER PASS ${ahead} s loaded ahead without ?muted=1 (60 s or more), ${mutedAhead} s under ?muted=1`)

  // J3 (R2.5): the stream host refuses the token mid-film; one refresh, playback continues there.
  fake.expired = true
```
**Impact:** J3's other checks are unchanged (the muted page starts at `resume_s` 20, plays muted,
shows the English track). Before this phase the BUFFER wait times out (the old cap never reaches
60 s ahead), so this check fails on `main`.

### Step 13: recovery.steps.mjs — the recovery in a real browser
**File:** `.claude/skills/verify-notesd/scripts/stream/recovery.steps.mjs` (new)
**Change:** Two journeys against the real page and real hls.js in Chromium, with the session routes
faked by Playwright from the same HLS fixture. A load "fails" by aborting the request (a network
failure: no answer, no `X-Notesd-Upstream`). Both use the fixture's single 720p playlist so hls.js has
no other level to switch to, and `?muted=1` so 30 s ahead reaches the failure quickly.
**Code:**
```js
// The player's recovery from network errors (R1.7) in a throwaway daemon's real build
// (verify.sh up --web). As in player.steps.mjs, the daemon's /api/stream/sessions/* routes are
// answered here from the HLS fixture make-hls-fixture.sh builds; a failed load is an aborted
// request (no answer at all, so no X-Notesd-Upstream: a network failure, not a refusal). Nothing
// leaves this machine and no Chrome on Windows is touched.
//   STREAM_FIXTURE=<folder make-hls-fixture.sh printed> verify.sh ui RUN <this file>
// Logs "RECOVER PASS" and "SPENT PASS"; the first failed check throws and fails the run.
import { readFileSync } from 'node:fs'
import path from 'node:path'

const FIX = process.env.STREAM_FIXTURE
const TYPES = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.vtt': 'text/vtt', '.srt': 'application/x-subrip' }
const LIMIT = 5

function check(ok, what) {
  if (!ok) throw new Error(what)
}

// S1 plays the fixture's 720p playlist (its segment addresses name S1); S9 is the same title
// under a session whose every load fails.
function sessionJson(id) {
  return {
    session_id: id, kind: 'movie', tmdb_id: 1, season: null, episode: null, provider: 'Fixture', best_height: 720,
    created_at: null, refreshed_at: null, expires_at: null,
    title: id === 'S1' ? 'Fixture Recover (2026)' : 'Fixture Down (2026)',
    manifest_url: `/api/stream/sessions/${id}/p?u=v720/index.m3u8`,
    manifest_kind: 'hls',
    subtitles: [],
    resume_s: 20,
  }
}

const pageState = () => ({
  stage: window.notesdStream?.stage ?? null,
  error: window.notesdStream?.error ?? null,
  errors: window.notesdStream?.errors ?? [],
  log: window.notesdStream?.log ?? [],
  title: document.title,
  path: location.pathname,
  video: !!document.querySelector('video'),
  t: document.querySelector('video')?.currentTime ?? 0,
  spinner: !!document.querySelector('[role="status"][aria-label="Reconnecting after a network error"]'),
  alert: document.querySelector('[role="alert"]')?.textContent ?? '',
})

export default async ({ page, base, shot, log }) => {
  check(FIX, 'set STREAM_FIXTURE to the folder make-hls-fixture.sh printed')
  const fake = { segmentsDown: false, aborted: 0, downLoads: 0, posts: [] }
  await page.route('**/api/stream/sessions/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    const m = /^\/api\/stream\/sessions\/(S1|S9)(?:\/(p|position|events))?$/.exec(url.pathname)
    if (!m) return json(403, { error: 'unknown_session' })
    const [, id, tail] = m
    if (tail === 'p') {
      const u = url.searchParams.get('u') ?? ''
      if (id === 'S9') {
        fake.downLoads += 1
        return route.abort('failed')
      }
      if (fake.segmentsDown && /seg\d+\.ts$/.test(u)) {
        fake.aborted += 1
        return route.abort('failed')
      }
      const file = path.join(FIX, u)
      return route.fulfill({ status: 200, headers: { 'x-notesd-upstream': '200' }, contentType: TYPES[path.extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
    }
    if (tail === 'position') {
      fake.posts.push({ id, at: Date.now(), ...req.postDataJSON() })
      return json(200, { ok: true })
    }
    // Phase 1's log lines: accepted, not checked here.
    if (tail === 'events') return json(200, { ok: true })
    return json(200, sessionJson(id))
  })

  // RECOVER (R1.7): every segment load fails mid-film; the page stays on the film, says it is
  // reconnecting, keeps reporting, and plays on from there once the host answers again.
  await page.goto(`${base}/stream/S1?muted=1`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 30_000 })
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !!v && !v.paused && v.currentTime > 21
  }, null, { timeout: 30_000 })
  fake.segmentsDown = true
  await page.evaluate(() => {
    document.querySelector('video').currentTime = 80
  })
  // hls.js gives up on the segment first (its own retries), then the page's recovery begins.
  await page.waitForFunction(() => ['recovering', 'error'].includes(window.notesdStream?.stage), null, { timeout: 120_000 })
  const during = await page.evaluate(pageState)
  log(`RECOVER during ${JSON.stringify(during)}`)
  check(during.stage === 'recovering', `RECOVER: a fatal network error put the page in recovering, not error (got ${during.stage} ${during.error})`)
  check(during.path === '/stream/S1' && during.video && during.title === 'Fixture Recover (2026)', 'RECOVER: the page stayed on the film')
  check(during.spinner, 'RECOVER: the reconnecting spinner shows')
  check(during.log.some((l) => new RegExp(`^recovering 1/${LIMIT} after networkError frag`).test(l)), `RECOVER: the log says recovering 1/${LIMIT} after a fragment error (log ${JSON.stringify(during.log)})`)
  check(fake.aborted > 0, 'RECOVER: segment loads were failed')
  await shot('recovering')
  const postsBefore = fake.posts.length
  await page.waitForTimeout(6_000)
  const still = await page.evaluate(pageState)
  check(still.stage === 'recovering', `RECOVER: still recovering while the host is down (got ${still.stage})`)
  check(fake.posts.length > postsBefore, 'RECOVER: positions were still reported during the recovery')
  fake.segmentsDown = false
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 60_000 })
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !v.paused && v.currentTime > 81
  }, null, { timeout: 60_000 })
  const after = await page.evaluate(pageState)
  log(`RECOVER after ${JSON.stringify(after)}`)
  check(after.log.some((l) => /^recovered at /.test(l)), 'RECOVER: the log says recovered')
  check(after.errors.length === 0 && after.error === null, `RECOVER: no error was shown (got ${JSON.stringify(after.errors)})`)
  check(after.t > 80 && after.t < 100, `RECOVER: playing on from 80 s (at ${after.t})`)
  log(`RECOVER PASS ${fake.aborted} segment loads failed at 80 s; the page stayed on the film reconnecting, reported positions, and played on from 80 s once they answered`)

  // SPENT (R1.7): every load of S9 fails; the error comes only after the five restarts and their waits.
  const started = Date.now()
  await page.goto(`${base}/stream/S9?muted=1`)
  const stages = new Set()
  for (;;) {
    const s = await page.evaluate(() => window.notesdStream?.stage ?? null)
    stages.add(s)
    if (s === 'error') break
    check(Date.now() - started < 180_000, `SPENT: no error within 180 s (stages ${[...stages].join(',')})`)
    await page.waitForTimeout(250)
  }
  const elapsedS = Math.round((Date.now() - started) / 100) / 10
  const end = await page.evaluate(pageState)
  log(`SPENT end after ${elapsedS} s ${JSON.stringify(end)} loads ${fake.downLoads}`)
  check(stages.has('recovering'), 'SPENT: the page was recovering before it stopped')
  check(end.error === 'networkError manifestLoadError', `SPENT: the error is the manifest's network error (got ${end.error})`)
  check(end.alert.includes('Playback stopped (networkError manifestLoadError).'), `SPENT: the page says playback stopped (got ${end.alert})`)
  for (let n = 1; n <= LIMIT; n++) {
    check(end.log.some((l) => l.startsWith(`recovering ${n}/${LIMIT} after networkError manifestLoadError`)), `SPENT: the log has try ${n} of ${LIMIT}`)
  }
  check(elapsedS >= 40, `SPENT: the error came only after the waits of 2+4+8+16+16 s (after ${elapsedS} s)`)
  check(fake.downLoads >= LIMIT + 1, `SPENT: the manifest was asked for at least once per try (got ${fake.downLoads})`)
  await shot('spent')
  log(`SPENT PASS ${LIMIT} restarts over ${elapsedS} s, ${fake.downLoads} manifest loads, then "Playback stopped (networkError manifestLoadError)."`)
}
```
**Impact:** proof only; nothing imports it.

### Step 14: Feature map
**File:** `.claude/skills/verify-notesd/features/direct-streaming.md:20-23` (the player sub-feature) and `:82-84` (the player journey)
**Change:** In the sub-feature bullet that starts "The player page `/stream/<session id>`", replace
the line `  401/403/410. Logic proven by \`npx vitest run web/src/stream tests/unit/static.test.ts\`.` with:
```md
  401/403/410. After a fatal network error the page stays on the film (`stage: "recovering"`, a
  spinner, positions still reported) and loads again from where it is after 2, 4, 8, 16 and 16 s;
  the error shows only when the fifth restart fails too. HLS keeps 120 s loaded ahead, 30 s under
  `?muted=1`. Logic proven by `npx vitest run web/src/stream tests/unit/static.test.ts`; in a real
  browser by `player.steps.mjs` (BUFFER) and `recovery.steps.mjs` (below).
```
In "Driving it with verify.sh", replace the three lines starting
`  The transcript has \`J1 PASS\` (English over a French default, quality menu, resume), \`API PASS\``
through `  refresh, continues at 100 s), \`J2 PASS\` (\`.srt\` as WebVTT), \`MUTED PASS\` (\`?muted=1\`) and \`CDN PASS\`.` with:
```md
  The transcript has `J1 PASS` (English over a French default, quality menu, resume), `API PASS`
  (`window.notesdStream` and the title), `BUFFER PASS` (60 s or more loaded ahead, 40 s or less
  under `?muted=1`), `J3 PASS` (on `?muted=1`: 403 with `X-Notesd-Upstream` mid-film, one refresh,
  continues at 100 s), `J2 PASS` (`.srt` as WebVTT), `MUTED PASS` (`?muted=1`) and `CDN PASS`.
- Network recovery, same fixture and `up --web`:
  `STREAM_FIXTURE="$FIX" $V ui RUN .claude/skills/verify-notesd/scripts/stream/recovery.steps.mjs`
  (about two minutes). The transcript has `RECOVER PASS` (segment loads aborted at 80 s: stage
  `recovering` with the spinner, positions still posted, plays on from 80 s once they answer) and
  `SPENT PASS` (every load aborted: five restarts over 40 s or more, then
  `Playback stopped (networkError manifestLoadError).`), with a screenshot of each.
```
**Impact:** docs only.

### Step 15: Guide
**File:** `docs/guide/streaming.md` — the player list in "Direct streaming" (the bullets around l.459-470) and the paragraph after the list (l.484-486)
**Change:** Insert two bullets right after the "**An expired token.**" bullet (which ends
`that arrives from the replaced player after the refresh began is dropped.`) and before
`- **Sound.**`:
```md
- **A network error.** When a load fails for another reason than a refused token (hls.js's
  `fragLoadError`, `fragLoadTimeOut`, `levelLoadError`, `manifestLoadError` and the rest of its
  network errors, a dash.js download error, a plain file's network error), the page stays on the
  film, which plays on from what it has loaded, and shows a spinner (`stage: "recovering"`). After
  2, 4, 8, 16 and 16 seconds it loads again from where the film is; the first piece that loads ends
  the recovery and the count starts over. Only when the fifth restart fails too does the page stop
  with the message, such as `Playback stopped (networkError fragLoadError).` Positions are still
  reported meanwhile, and each try is a line in the page's log
  (`recovering 2/5 after networkError fragLoadError at 1312.4 s`, then `recovered at 1320 s`), which
  the page sends to the daemon with its other log lines.
- **Buffer.** An HLS play keeps up to 120 seconds loaded ahead of the picture, so a slow stretch of
  the stream host is ridden out. A `?muted=1` check keeps 30 seconds, so the expiry check still finds
  pieces that are not loaded when the token runs out. A DASH play keeps dash.js's own amount.
```
Replace the line
`The page keeps its state on \`window.notesdStream\` (stage, \`kind\`, \`levels\`, \`level\`, subtitle`
with:
```md
The page keeps its state on `window.notesdStream` (`stage`: `loading`, `ready`, `refreshing`,
`recovering` or `error`; `kind`, `levels`, `level`, subtitle
```
**Impact:** docs only. The guide shows no picture of the player, so no `docs:shots` run. No new
route, tool or env var, so no `docs:gen` and no configuration row.

## Principles applied

- Fix root causes: the reproduction is the RECOVER journey (J2) on `main`: the abort at 80 s sends hls.js's fatal `fragLoadError` through `hlsEngine.ts:47` straight to `onFatal` → `controller.fail()`, so the page shows `stage: 'error'` instead of `recovering`; the fix is at that line (a fatal `NETWORK_ERROR` goes to `networkRecovery`), not in the controller or the overlay.
- Laziness protocol: one `networkRecovery()` in `engine.ts` serves the three engines (three real callers) instead of three copies; no injected clock (the tests use vitest's fake timers); no new state field for the attempt number; no CSS change (the existing spinner overlay is reused); dash.js buffer settings left alone.
- Make illegal states unrepresentable: no `recoveryAttempt` field in `StreamState`, which could disagree with `stage` (an attempt number while `ready`, or `recovering` with attempt 0); the attempt lives in the engine's recovery and in the log line, and the stage alone says the page is recovering.
- Test behavior, not implementation: the engine tests mock hls.js / dash.js at the module boundary and assert what the engine tells the controller and the library (handler calls, `startLoad` at the position, `attachSource`, the config), never the recovery helper's internals; the controller tests drive its handlers and read its state and its position posts; the proof is the real page with real hls.js in Chromium (J2, J3, J4).
- Prove it works: `recovery.steps.mjs` and the BUFFER check in `player.steps.mjs` drive the real built page in Chromium, not only the unit tests.

## Verification

**Build:** `cd /home/miftah/.worktrees/mcp-notes/stream-cache-and-bug-report && npm ci && npm run typecheck && npm run build`
**Tests:** `npm test` (includes `web/src/stream/*.test.tsx` and the docs reference test) and `npm run docs:check`; `npm run test:int` is unaffected by this phase but must still pass (Invariant 1).
**Proof:** the real player page (built by `up --web`) with real hls.js in Chromium, driven by Playwright, the session routes faked from the HLS fixture.
- Harness: `.claude/skills/verify-notesd` (`V=.claude/skills/verify-notesd/scripts/verify.sh`). Setup for J2-J4 and the neighbor check:
  `FIX=$(bash .claude/skills/verify-notesd/scripts/stream/make-hls-fixture.sh "$HOME/.local/state/notesd-verify/.stream-fixture")`, then `$V up --web` (note `RUN=`). For the DASH neighbor: `$V up --web --direct-stream` (note `DIRECT=`) and `FIXD=$(bash .claude/skills/verify-notesd/scripts/stream/make-dash-fixture.sh "$HOME/.local/state/notesd-verify/.stream-fixture-dash")`. `$V down RUN` at the end.
- Feature-map entries: `.claude/skills/verify-notesd/features/direct-streaming.md`
- Journeys:
  - **J1** · traces R1.7 — `npx vitest run web/src/stream` → passes when every test passes, including `hlsEngine.test.tsx` "waits, loads again from where the film is…" (`startLoad(312.4)` after 2 s, then `recovered`), "stops with the error only after 5 restarts…", `dashEngine.test.tsx` "opens the stream again where the film is…", `nativeEngine.test.tsx` "loads the file again after a wait…", `controller.test.tsx` "stays on the film while the engine retries…" (stage `recovering`, a position post at 305 s, then `ready`) and `StreamApp.test.tsx` "shows a reconnecting spinner…"
  - **J2** · traces R1.7 — `STREAM_FIXTURE="$FIX" $V ui RUN .claude/skills/verify-notesd/scripts/stream/recovery.steps.mjs` → passes when the transcript has `RECOVER PASS` (with segment loads aborted at 80 s, `window.notesdStream.stage` is `recovering` with the spinner while the page stays on `/stream/S1`, position posts keep arriving, and once loads answer again the stage is `ready` and the video plays on past 81 s with `errors` empty). On `main` this journey fails at `RECOVER: a fatal network error put the page in recovering, not error`.
  - **J3** · traces R1.7 — the same run as J2 → passes when the transcript has `SPENT PASS`: with every load of S9 aborted, the stage is `recovering` first, the log has `recovering 1/5` … `recovering 5/5 after networkError manifestLoadError`, `error` is `networkError manifestLoadError` only 40 s or more after the page opened, and the alert reads `Playback stopped (networkError manifestLoadError).`
  - **J4** · traces R1.8 — `STREAM_FIXTURE="$FIX" $V ui RUN .claude/skills/verify-notesd/scripts/stream/player.steps.mjs` → passes when the transcript has `BUFFER PASS` (60 s or more loaded ahead of the picture on `/stream/S1`, impossible under the old 30 s cap, and 40 s or less on `/stream/S1?muted=1`) and `result: PASS`
  - **J5** · traces R1.8 — `npx vitest run web/src/stream/hlsEngine.test.tsx web/src/stream/controller.test.tsx -t "ahead"` → passes when hls.js is built with `maxBufferLength` and `maxMaxBufferLength` 120 (30 when asked) and the controller asks for `bufferAheadS` 120, and 30 under `?muted=1`
- Neighbor check: the token-expiry refresh, which shares the engines' error paths and needs unloaded segments. The J4 run must also show `J1 PASS`, `J3 PASS`, `J2 PASS`, `MUTED PASS`, `CDN PASS`; and on the `--direct-stream` run, `DIRECT=<path> DASH_FIXTURE="$FIXD" $V ui RUN .claude/skills/verify-notesd/scripts/stream/dash-expiry.steps.mjs` must show `DASH PLAY PASS`, `DASH EXPIRY PASS` and `DASH OVER PASS` (a 403 without `X-Notesd-Upstream` still ends the session, and no restart follows). `npx vitest run tests/unit/scripts/playcheck.test.ts` passes unchanged.
- Cost: none (no LLM turns, no live provider; local Chromium only). The live `playcheck.mjs --check expiry` stays the owner's to run.
**Exit criteria:** `npm run typecheck`, `npm test`, `npm run docs:check` pass; J1-J5 pass; the neighbor check's transcripts show every PASS listed.

## Handoffs

- **Phase 1 (R2.2):** the lines `recovering <n>/5 after <message> at <s> s` and `recovered at <s> s` reach `state.log` through `note()`; posting them to `POST /api/stream/sessions/:id/events` is phase 1's, and so is any journey that reads them back from the evidence log. `recovery.steps.mjs` answers `/events` with 200 and checks nothing about it.
- **Phase 4 (R4.1):** `Stage` now includes `recovering`; the report button belongs only to the `error` branch of `StageOverlay`, which this phase did not touch. `StreamApp.test.tsx`'s new test compares the alert's `textContent` exactly; an icon-only button keeps it equal.
- **Phase 6 (R1.4, "no buffer cap for a complete cache"), reconciled:** phase 6 sets `EngineRequest.bufferAheadS` in `StreamController.attach` (the line `bufferAheadS: this.mutedMode ? MUTED_BUFFER_AHEAD_S : BUFFER_AHEAD_S`) from the session's `cached` state, adding only `CACHED_BUFFER_AHEAD_S` (600) to `engine.ts`; hls.js reads it as both `maxBufferLength` and `maxMaxBufferLength`. The recovery applies to local files too and needs no change.
- **Decided (index Decisions):** `EngineHandlers` gains `onRecovered()` beside `onRecovering(attempt, message)` (reason in the Interface Contract); the index's "Contracts between phases" names both.
- **Decided (index Decisions):** R1.8 is met for HLS (the 30 s cap the criterion names is hls.js's). dash.js keeps its own buffer defaults, because `dash-expiry.steps.mjs` plays a 120 s DASH fixture without `?muted=1` and needs segments that are not loaded at 100 s; DASH is rare among the registry's providers. R1.8's text is unchanged; the narrowing is recorded as a decision.

## Rollback

Revert this phase's commits. The engines go back to stopping on the first fatal network error and to
a 30 s buffer; `player.steps.mjs` J3 goes back to the unmuted page, which works again with the 30 s
cap. Nothing is stored anywhere: no data, no migration, no setting.

## Risks

- hls.js 1.7.4 may not raise a *fatal* error for an aborted fragment of a single-level stream (it might keep the level and wait), or may refuse `startLoad` on a level it marked failed. J2 is the check: if it fails at the first `waitForFunction`, read the transcript's `RECOVER during` line and hls.js's `errorController` for `fragLoadError` before changing the engine.
- dash.js 5 may emit `fragmentLoadingCompleted` for a failed request without an `error` field; then a DASH recovery would end on the failed load and the count would reset each time (the play would keep retrying instead of stopping). The DASH unit test assumes the field; the DASH neighbor journey does not exercise recovery.
- The SPENT journey depends on timing (40 s or more); hls.js's own manifest retry (one retry after 1 s) adds a little to each try, never less.
