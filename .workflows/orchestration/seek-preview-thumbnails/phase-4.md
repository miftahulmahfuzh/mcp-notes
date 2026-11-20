# Phase 4: The hover box on the player page

**Plan set:** `SEEK_PREVIEW_THUMBNAILS_PLAN.md`
**Analysis:** `.workflows/analyze/20261120-192436-K7QP_code_analyzer.md`
**Satisfies:** R1, R2: the hover picture over the player's timeline (R1), and making it hold up when the frames or their pictures are missing or broken (R2)
**Criteria:** R1.1, R1.5, R2.1
**Depends on:** none (built at the same time as phase 1, against the index's fixed interface contract)
**Difficulty:** NORMAL
**Package:** `web/src/stream`

---

## Goal

When the pointer is over the timeline of notesd's player page (`/stream/<id>`), a box above it shows
the time at that position and, where the session's previews hold a frame for it and that frame's
picture loads, the frame. The page reads the previews once after the session loads and again
whenever a session or a position answer carries a higher `preview_rev`, so new frames show up
without a reload. A gap, a 404 or a picture that does not load shows the time alone, never a
broken picture. A daemon without phase 1 (no `preview_rev`, a 404 on the previews route) shows the
time alone.

## Interface Contract

The page side of the index's "Interface contract" section, built exactly to it. Nothing here
changes the contract.

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `web/src/stream/session.ts`: `PreviewCue`, `Previews`, `NO_PREVIEWS`, `parsePreviews`,
  `fetchPreviews`, `previewsUrl`; the field `StreamSession.previewRev` (from the session's
  `preview_rev`, 0 when absent); the field `PositionAnswer.previewRev` (from the position answer's
  `preview_rev`, null when absent).
- `web/src/stream/previews.ts` (new): `hoverTime`, `cueAt`, `frameStyle`, `previewPlacement`,
  `SheetCache`, `SheetStatus`, `SheetSize`, `LoadSheet`, `loadSheetImage`, `StageBox`, the constants
  `SEEK_THUMB_PX`, `PREVIEW_WIDTH_PX`, `TIME_ONLY_WIDTH_PX`, `PREVIEW_TIME_PX`, `PREVIEW_GAP_PX`,
  `PREVIEW_EDGE_PX`.
- `web/src/stream/controller.ts`: `StreamState.previews` (also on `window.notesdStream.previews`).
- `web/src/stream/StreamApp.tsx`: the optional prop `loadSheet` of `StreamApp`; the internal
  `SeekPreview` component and `useSheetCache` hook; the box `[data-testid="seek-preview"]`
  (`.st-preview`, `.st-preview-frame` with `data-sheet` and `data-rect`, `.st-preview-time`).
- `web/src/stream/stream.css`: `.st-preview`, `.st-preview-frame`, `.st-preview-time`.
- `web/src/testing/streamFakes.ts`: `previewsJson`, `previewCueJson`, `fakeSheets`.
- `web/src/stream/previews.test.tsx` (new).

**Signature changes:**
- `StreamApp({ sessionId, muted, deps })` -> `StreamApp({ sessionId, muted, deps, loadSheet })`
  (`loadSheet` optional, defaults to `loadSheetImage`).
- `PositionAnswer` gains `previewRev: number | null` (every return of `postPosition` sets it).

**Requires (from earlier phases):** nothing landed. At run time the page reads, as the contract fixes
them and phase 1 (and 3) serve them:
- `GET /api/stream/sessions/:id/previews` -> `{ state, rev, source, cues: [{ start_s, end_s, url, x, y, w, h }] }`;
- `preview_rev` in `GET /api/stream/sessions/:id` and in the answer of `POST /api/stream/sessions/:id/position`;
- each cue's `url` a same-origin path (starts with one `/`) that answers a picture (a JPEG sheet, or
  the pass-through with `img=1`).
Against a daemon without them, everything here degrades to the timestamp alone (proved by tests).

**Leaves alone (owned by others):** everything under `src/`, `claude/`, `docs/`, `scripts/`, and
`CLAUDE.md` (phases 1, 2, 3, 5); `.claude/skills/verify-notesd/features/direct-streaming.md` and
`.claude/skills/verify-notesd/scripts/**` (phase 5).

## Files

| File | Action | What changes |
|---|---|---|
| `web/src/stream/session.ts` | modify | `previewRev` in `StreamSession` (`:36`, `:198`), `previewsUrl` (`:231`), the previews types, `parsePreviews`, `fetchPreviews` (after `:370`), `previewRev` in `PositionAnswer` / `postPosition` (`:422-452`) |
| `web/src/stream/previews.ts` | create | the pointer-to-time map, the cue lookup, the frame's style, the box's place, the sheet cache and its `Image()` probe |
| `web/src/stream/controller.ts` | modify | imports (`:11-41`), `StreamState.previews` (`:194`), `INITIAL_STATE` (`:229`), three fields (`:319`), `followPreviews` / `readPreviews` (after `:1525`), calls in `open` (`:405`), `goToEpisode` (`:450`), `moveTo` (`:969`), `swapTo` (`:1145`), `askCache` (`:1229`), `report` (`:1462-1468`), `followSubtitleRev` (`:1505`), `refresh` (`:1550`) |
| `web/src/stream/StreamApp.tsx` | modify | imports (`:1`, `:27-31`), `Hover`, `useSheetCache`, `SeekPreview` (before `:444`), the prop and hooks in `StreamApp` (`:446-467`), the stage ref and the box (`:583-584`), the timeline's pointer handlers (`:651-663`) |
| `web/src/stream/stream.css` | modify | the box's rules after `.st-clock` (`:192`) |
| `web/src/testing/streamFakes.ts` | modify | `previewsJson`, `previewCueJson`, `fakeSheets` (end of file, `:108`) |
| `web/src/stream/previews.test.tsx` | create | the pure parts |
| `web/src/stream/controller.test.tsx` | modify | `previewRev: 0` in the `parseSession` equality (`:47-67`), the import (`:4`, `:5`), a new `describe` at the end (`:1715`) |
| `web/src/stream/StreamApp.test.tsx` | modify | the imports (`:5-6`), a new `describe` at the end (`:508`) |

## Implementation Steps

Each step ends with a command that can fail. Run them in order.

### Step 1: The previews in the session module
**File:** `web/src/stream/session.ts:36`, `:198`, `:231`, after `:370`, `:422-452`
**Change:** read `preview_rev` from the session and from the position answer; add the previews
address, types, parser and fetch. The parser is the one boundary: it keeps only cues the page can
draw (finite numbers, `end_s > start_s`, a positive rectangle, a same-origin path with no control
characters), sorts them, drops a cue that overlaps the one before, and makes `none` mean exactly
"no cue, no source". Everything after it trusts the list.

**Code:**

1a. In `interface StreamSession`, after the `sourceRev` field (`:36`):

```ts
  /** The daemon's count of changes to the session's seek-preview frames (`preview_rev`); 0 when it does not say (a daemon with no previews). */
  previewRev: number;
```

1b. In `parseSession`'s return object, after `sourceRev: count(o.source_rev) ?? 0,` (`:198`):

```ts
    previewRev: count(o.preview_rev) ?? 0,
```

1c. After `export const reportUrl = ...` (`:231`):

```ts
export const previewsUrl = (id: string): string => `${sessionUrl(id)}/previews`;
```

1d. After `fetchTorrentStatus` (ends `:370`), a new block:

```ts
/** One frame of a session's seek previews: the stretch of the film it stands for, and where it is in which picture. */
export interface PreviewCue {
  /** [startS, endS): the seconds of the film the frame stands for. */
  startS: number;
  endS: number;
  /** A same-origin address, used as is: a sheet of the daemon, or the pass-through with `img=1`. */
  url: string;
  /** The frame's rectangle inside the picture at `url`, in pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * GET /api/stream/sessions/:id/previews as parsePreviews leaves it: cues sorted by start, never
 * overlapping, maybe with gaps; `none` exactly when there is no cue, and then no source.
 */
export interface Previews {
  state: 'none' | 'partial' | 'ready';
  /** The session's `preview_rev` this list belongs to. */
  rev: number;
  source: 'provider' | 'local' | null;
  cues: PreviewCue[];
}

/** No frame: before the first read, for a daemon with no previews, and in a new session. */
export const NO_PREVIEWS: Previews = { state: 'none', rev: 0, source: null, cues: [] };

/** A path on this origin: one leading slash (never `//host`), no control character. */
const SAME_ORIGIN_PATH = /^\/(?!\/)[^\u0000-\u001f\u007f]*$/;
/** A frame every 10 s for 55 hours: more is not a film. */
const MAX_PREVIEW_CUES = 20_000;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function previewCue(value: unknown): PreviewCue | null {
  if (typeof value !== 'object' || value === null) return null;
  const { start_s: startS, end_s: endS, url, x, y, w, h } = value as Record<string, unknown>;
  if (!finite(startS) || !finite(endS) || startS < 0 || endS <= startS) return null;
  if (typeof url !== 'string' || !SAME_ORIGIN_PATH.test(url)) return null;
  if (!finite(x) || !finite(y) || !finite(w) || !finite(h) || x < 0 || y < 0 || w <= 0 || h <= 0) return null;
  return { startS, endS, url, x, y, w, h };
}

/** The previews answer, checked once; null when it is not one (no `cues` list). */
export function parsePreviews(json: unknown): Previews | null {
  if (typeof json !== 'object' || json === null) return null;
  const o = json as Record<string, unknown>;
  if (!Array.isArray(o.cues)) return null;
  const sorted = o.cues
    .slice(0, MAX_PREVIEW_CUES)
    .map(previewCue)
    .filter((c): c is PreviewCue => c !== null)
    .sort((a, b) => a.startS - b.startS);
  // The daemon never sends overlapping cues; one that starts before the last kept one ends is dropped.
  const cues: PreviewCue[] = [];
  for (const cue of sorted) {
    const last = cues.at(-1);
    if (last === undefined || cue.startS >= last.endS) cues.push(cue);
  }
  const rev = count(o.rev) ?? 0;
  if (cues.length === 0) return { state: 'none', rev, source: null, cues };
  return {
    state: o.state === 'ready' ? 'ready' : 'partial',
    rev,
    source: o.source === 'provider' || o.source === 'local' ? o.source : null,
    cues,
  };
}

/** The session's seek-preview frames; null when the daemon cannot say (a 404 from a daemon with none, a network failure, a body that is not the answer). Never throws. */
export async function fetchPreviews(id: string, fetchImpl: typeof fetch): Promise<Previews | null> {
  try {
    const res = await fetchImpl(previewsUrl(id), { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return parsePreviews(await res.json().catch(() => null));
  } catch {
    return null;
  }
}
```

1e. Replace `interface PositionAnswer` and `postPosition` (`:422-452`) with:

```ts
/** What the answer to a position report tells the page. */
export interface PositionAnswer {
  /** The session's `subtitle_rev` as the daemon has it now (StreamSession.subtitleRev); null when it did not say. */
  rev: number | null;
  /** The session's `source_rev` as the daemon has it now (StreamSession.sourceRev); null when it did not say. */
  sourceRev: number | null;
  /** The session's `preview_rev` as the daemon has it now (StreamSession.previewRev); null when it did not say (a daemon with no previews). */
  previewRev: number | null;
  /** The daemon does not know the session (it restarted), or could not be reached: the page carries its play on. */
  gone: boolean;
}

/**
 * Never throws. A failed report is not sent again: the position is reported again in 5 s. A closing
 * page's report is sent `keepalive`, so it outlives the page, and its answer is not read.
 */
export async function postPosition(id: string, report: PositionReport, fetchImpl: typeof fetch): Promise<PositionAnswer> {
  let res: Response;
  try {
    res = await fetchImpl(positionUrl(id), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
      ...(report.closed === true ? { keepalive: true } : {}),
    });
  } catch {
    return { rev: null, sourceRev: null, previewRev: null, gone: report.closed !== true };
  }
  if (report.closed === true) return { rev: null, sourceRev: null, previewRev: null, gone: false };
  const body = (await res.json().catch(() => null)) as { subtitle_rev?: unknown; source_rev?: unknown; preview_rev?: unknown; error?: unknown } | null;
  if (!res.ok) return { rev: null, sourceRev: null, previewRev: null, gone: body?.error === 'unknown_session' || daemonDown(res.status, body) };
  return { rev: count(body?.subtitle_rev), sourceRev: count(body?.source_rev), previewRev: count(body?.preview_rev), gone: false };
}
```

1f. `web/src/stream/controller.test.tsx:47-67`: the `parseSession` equality lists every field; add
`previewRev: 0,` after `sourceRev: 0,` (`:64`), so the expected object is:

```ts
    expect(parseSession(streamSessionJson({ resume_s: 42.5, subtitles }))).toEqual({
      id: 'S1',
      title: 'Fight Club (1999)',
      manifestUrl: '/api/stream/sessions/S1/p?u=m1',
      manifestKind: 'hls',
      subtitles: [
        { url: '/x', lang: 'en', label: 'en', english: true },
        { url: '/y', lang: null, label: 'English (CC)', english: true },
      ],
      resumeS: 42.5,
      audioTrack: null,
      prevEpisode: null,
      nextEpisode: null,
      cached: null,
      torrent: null,
      subtitleRev: 0,
      sourceRev: 0,
      previewRev: 0,
      sourceNote: null,
      ref: { kind: 'movie', tmdbId: 550 },
      provider: 'VidFast',
    });
```

**Check:** `npx tsc -p tsconfig.web.json && npx vitest run web/src/stream/controller.test.tsx`
(green: the controller does not read the new fields yet).
**Impact:** additive. `postPosition`'s callers read only `rev`, `sourceRev`, `gone` until step 4.

### Step 2: The pure parts of the hover box
**File:** `web/src/stream/previews.ts` (new)
**Change:** the pointer-to-second map (the thumb's centre travels the track's width minus the thumb,
as Chrome maps a click), the cue lookup (binary search), the frame's style (the sheet as the div's
background, moved and scaled so the cue's rectangle fills the box's width; null when the
rectangle is not inside the picture that loaded), the box's place (centred over the pointer, above
the track, inside the stage), and the sheet cache: each sheet probed once with `Image()` when first
hovered, its size or its failure remembered; failures forgotten when the previews change (one more
try per `rev`).

**Code:**

```ts
import type { PreviewCue } from './session';

/** The range thumb's width (stream.css `.st-seek::-webkit-slider-thumb`): its centre runs from half of it in from each end. */
export const SEEK_THUMB_PX = 11;
/** How wide the box draws a frame: the daemon's own frames are 240 px, so they show pixel for pixel. */
export const PREVIEW_WIDTH_PX = 240;
/** The box with the time alone (stream.css `.st-preview-time` min-width). */
export const TIME_ONLY_WIDTH_PX = 72;
/** The line the time takes under the frame (stream.css `.st-preview-time` height). */
export const PREVIEW_TIME_PX = 22;
/** Between the box and the top of the timeline. */
export const PREVIEW_GAP_PX = 10;
/** The least room between the box and the stage's edges. */
export const PREVIEW_EDGE_PX = 8;

/** The stage's box as the pointer event saw it (getBoundingClientRect). */
export interface StageBox {
  left: number;
  bottom: number;
  width: number;
  height: number;
}

export interface SheetSize {
  width: number;
  height: number;
}

/** Loads one sheet's picture and answers its natural size; rejects when it does not load. */
export type LoadSheet = (url: string) => Promise<SheetSize>;

/** What the page knows of a sheet: being probed, loaded (with its size), or failed. */
export type SheetStatus = { state: 'loading' } | { state: 'failed' } | ({ state: 'ready' } & SheetSize);

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The film's second under the pointer: where a click there would put the thumb's centre, clamped to
 * the film. Null when the film has no duration yet or the track has no room. Integer inputs give an
 * exact second (the product is divided once).
 */
export function hoverTime(clientX: number, track: Pick<DOMRect, 'left' | 'width'>, durationS: number, thumbPx = SEEK_THUMB_PX): number | null {
  if (!(durationS > 0) || !(track.width > thumbPx)) return null;
  const travel = track.width - thumbPx;
  const offset = Math.min(travel, Math.max(0, clientX - track.left - thumbPx / 2));
  return (offset * durationS) / travel;
}

/** The frame that stands for second `t`: the cue whose [startS, endS) holds it; null in a gap. `cues` is sorted and never overlaps (parsePreviews). */
export function cueAt(cues: readonly PreviewCue[], t: number): PreviewCue | null {
  let lo = 0;
  let hi = cues.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].startS <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found === -1) return null;
  const cue = cues[found];
  return t < cue.endS ? cue : null;
}

export interface FrameStyle {
  width: number;
  height: number;
  backgroundImage: string;
  backgroundPosition: string;
  backgroundSize: string;
}

/**
 * The frame drawn `width` px wide: a div whose background is the sheet, moved and scaled so the cue's
 * rectangle fills it. Null when the rectangle is not inside the picture that loaded (nothing drawn
 * from outside it).
 */
export function frameStyle(cue: PreviewCue, sheet: SheetSize, width: number): FrameStyle | null {
  if (cue.x + cue.w > sheet.width || cue.y + cue.h > sheet.height) return null;
  const k = width / cue.w;
  const px = (n: number): string => `${round2(n)}px`;
  return {
    width,
    height: Math.round(cue.h * k),
    // JSON.stringify quotes the address and escapes `"` and `\`, which a CSS string reads back as they were.
    backgroundImage: `url(${JSON.stringify(cue.url)})`,
    backgroundPosition: `${px(-cue.x * k)} ${px(-cue.y * k)}`,
    backgroundSize: `${px(sheet.width * k)} ${px(sheet.height * k)}`,
  };
}

/**
 * Where the box goes, in px from the stage's left and bottom: centred over the pointer, PREVIEW_GAP_PX
 * above the timeline's top, and never closer than PREVIEW_EDGE_PX to the stage's edges.
 */
export function previewPlacement(clientX: number, stage: StageBox, trackTop: number, box: SheetSize): { left: number; bottom: number } {
  const maxLeft = Math.max(PREVIEW_EDGE_PX, stage.width - box.width - PREVIEW_EDGE_PX);
  const left = Math.min(maxLeft, Math.max(PREVIEW_EDGE_PX, clientX - stage.left - box.width / 2));
  const maxBottom = Math.max(PREVIEW_EDGE_PX, stage.height - box.height - PREVIEW_EDGE_PX);
  const bottom = Math.min(maxBottom, Math.max(PREVIEW_EDGE_PX, stage.bottom - trackTop + PREVIEW_GAP_PX));
  return { left: round2(left), bottom: round2(bottom) };
}

/** The browser's probe: an Image() that is never put on the page, so a sheet that fails is never shown broken. */
export const loadSheetImage: LoadSheet = (url) =>
  new Promise<SheetSize>((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('sheet_failed'));
    img.src = url;
  });

/**
 * The sheets of the session's previews, each probed once, when a hover first reaches a frame in it
 * (never all of them at once); its size or its failure is remembered, so a broken sheet is asked for
 * once. `forgetFailures` gives the failed ones one more try when the previews change.
 */
export class SheetCache {
  private readonly known = new Map<string, SheetStatus>();
  private readonly load: LoadSheet;
  private readonly onChange: () => void;

  constructor(load: LoadSheet, onChange: () => void) {
    this.load = load;
    this.onChange = onChange;
  }

  /** What is known of `url`; null before it was wanted. */
  peek(url: string): SheetStatus | null {
    return this.known.get(url) ?? null;
  }

  /** Starts the probe of `url` unless it is known already. */
  want(url: string): void {
    if (this.known.has(url)) return;
    this.known.set(url, { state: 'loading' });
    let probe: Promise<SheetSize>;
    try {
      probe = this.load(url);
    } catch {
      probe = Promise.reject(new Error('sheet_failed'));
    }
    probe.then(
      (size) => this.settle(url, size.width > 0 && size.height > 0 ? { state: 'ready', width: size.width, height: size.height } : { state: 'failed' }),
      () => this.settle(url, { state: 'failed' }),
    );
  }

  /** The previews changed: a sheet that failed may be there now. */
  forgetFailures(): void {
    for (const [url, status] of this.known) if (status.state === 'failed') this.known.delete(url);
  }

  private settle(url: string, status: SheetStatus): void {
    if (this.known.get(url)?.state !== 'loading') return;
    this.known.set(url, status);
    this.onChange();
  }
}
```

**Check:** `npx tsc -p tsconfig.web.json` (the tests for this module come in step 6).
**Impact:** new module, no caller yet.

### Step 3: Fakes for the previews
**File:** `web/src/testing/streamFakes.ts:108` (end of file)
**Change:** the contract's previews answer, one cue of it, and a sheet loader the test answers one
load at a time.

**Code:** add `import type { SheetSize } from '../stream/previews';` after the existing imports
(`:2`), and at the end of the file:

```ts
/** GET /api/stream/sessions/:id/previews as the plan set's interface contract answers it. */
export function previewsJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { state: 'partial', rev: 0, source: 'local', cues: [], ...over };
}

/** One cue of that answer: frame `index` of a sheet of 6 × 6 frames of 240 × 135 px, standing for the 10 s from `startS`. */
export function previewCueJson(url: string, startS: number, index: number): Record<string, unknown> {
  return { start_s: startS, end_s: startS + 10, url, x: (index % 6) * 240, y: Math.floor(index / 6) * 135, w: 240, h: 135 };
}

export interface FakeSheets {
  /** The page's LoadSheet: each call waits until the test answers it. */
  load: Mock<(url: string) => Promise<SheetSize>>;
  /** Answers the pending load of `url` with the picture's size, or as a picture that did not load (a 404, bytes that do not decode). */
  answer: (url: string, size: SheetSize | 'fail') => void;
}

export function fakeSheets(): FakeSheets {
  const pending = new Map<string, { resolve: (size: SheetSize) => void; reject: (err: Error) => void }>();
  const load = vi.fn<(url: string) => Promise<SheetSize>>(
    (url) =>
      new Promise<SheetSize>((resolve, reject) => {
        pending.set(url, { resolve, reject });
      }),
  );
  return {
    load,
    answer: (url, size) => {
      const waiting = pending.get(url);
      if (waiting === undefined) throw new Error(`no load of ${url} is pending`);
      pending.delete(url);
      if (size === 'fail') waiting.reject(new Error('sheet_failed'));
      else waiting.resolve(size);
    },
  };
}
```

**Check:** `npx tsc -p tsconfig.web.json`.
**Impact:** test-only helpers.

### Step 4: The previews in the controller's state
**File:** `web/src/stream/controller.ts`
**Change:** `previews` in `StreamState`; read once after the session loads (`open`, which `start`,
`goToEpisode` and `swapTo` all go through) and again whenever a session the page reads
(`moveTo`, `askCache`'s move, `refresh`, `followSubtitleRev`) or a position answer carries a
`preview_rev` higher than the one asked for. Never on a timer. One read at a time per session; a
rev that arrives during a read is read when it ends. A read that fails keeps the frames the page
had (that rev is not asked again; a higher one is). A new session (an episode switch, a carried-on
play, a refresh that changed the id) starts from `NO_PREVIEWS`. A log line (to the player's log and
the daemon's evidence) only when the number of frames or the state changed; a failed read logs
nothing, so a daemon without previews leaves the log as it was.

**Code:**

4a. Imports (`:11-41`): add `fetchPreviews,`, `NO_PREVIEWS,` and `type Previews,` to the list
imported from `'./session'`, e.g. after `fetchTorrentStatus,` (`:30`):

```ts
  fetchPreviews,
  NO_PREVIEWS,
  type Previews,
```

4b. `interface StreamState`, after the `torrent` field (`:194`):

```ts
  /**
   * The session's seek-preview frames (GET /api/stream/sessions/:id/previews) as last read; NO_PREVIEWS
   * before the first read, in a new session, and for a daemon that has none. The box over the timeline
   * draws them.
   */
  previews: Previews;
```

4c. `INITIAL_STATE`, after `torrent: null,` (`:229`):

```ts
  previews: NO_PREVIEWS,
```

4d. Fields of `StreamController`, after `private readonly settled: Promise<void>;` (`:319`):

```ts
  /** The session `state.previews` belongs to (or is being read for); null: none yet, the next session reads its own. */
  private previewsOf: string | null = null;
  /** The highest `preview_rev` asked for that session; -1 before the first read. */
  private previewRevAsked = -1;
  /** The session whose previews are being read now: one read at a time per session. */
  private previewsReading: string | null = null;
```

4e. `open()`: after the `this.set({ title: ..., torrent: torrentView(session.torrent) });` call
(ends `:405`):

```ts
    // The seek-preview frames: read once now, and again only when the daemon says they changed.
    this.followPreviews(this.sessionId, session.previewRev);
```

4f. `goToEpisode()`: replace `this.set({ cachedRanges: [], torrent: null });` (`:450`) with:

```ts
    this.previewsOf = null;
    this.set({ cachedRanges: [], torrent: null, previews: NO_PREVIEWS });
```

4g. `moveTo()`: after `this.session = answer.session;` (`:969`):

```ts
    this.followPreviews(this.sessionId, answer.session.previewRev);
```

4h. `swapTo()`: replace the `this.set({ stage: 'refreshing', error: null, ... bugReport: { status: 'idle' } });`
line (`:1145`) with:

```ts
    this.previewsOf = null;
    this.set({ stage: 'refreshing', error: null, refreshes: 0, qualities: [], quality: -1, subtitles: [], cachedRanges: [], previews: NO_PREVIEWS, bugReport: { status: 'idle' } });
```

4i. `askCache()`: after `this.session = answer.session;` (`:1229`):

```ts
    this.followPreviews(this.sessionId, answer.session.previewRev);
```

4j. `report()`: replace the `.then` callback (`:1462-1468`) with:

```ts
    void postPosition(asked, report, this.deps.fetch).then((answer) => {
      // The daemon moved the session to another source by itself: that reload brings its subtitles too.
      if (answer.sourceRev !== null && this.session !== null && answer.sourceRev !== this.session.sourceRev) void this.followSourceRev(asked, answer.sourceRev);
      else if (answer.rev !== null) void this.followSubtitleRev(asked, answer.rev);
      // New seek-preview frames (a sheet finished, a provider's track was read): the box over the timeline uses them at once.
      if (answer.previewRev !== null) this.followPreviews(asked, answer.previewRev);
      // The daemon restarted under the film (or is restarting): a fresh session for the same play.
      if (answer.gone && !this.disposed && this.sessionId === asked && !this.carrying) void this.carryOn('unknown_session');
    });
```

4k. `followSubtitleRev()`: after `const fresh = await fetchSession(asked, this.deps.fetch);` (`:1505`):

```ts
      this.followPreviews(asked, fresh.previewRev);
```

4l. `refresh()`: after `this.session = session;` (`:1550`):

```ts
      this.followPreviews(this.sessionId, session.previewRev);
```

4m. Two new methods, after `followSubtitleRev` (ends `:1525`):

```ts
  /**
   * Reads the session's seek-preview frames when `rev` (its `preview_rev`, from the session or a position
   * answer) is higher than the one asked for, or none was read yet for this session. Never on a timer.
   * One read at a time per session; a higher rev that arrives meanwhile is read when it ends. A new
   * session starts from no frames.
   */
  private followPreviews(asked: string, rev: number): void {
    if (this.disposed || this.sessionId !== asked) return;
    if (this.previewsOf !== asked) {
      this.previewsOf = asked;
      this.previewRevAsked = -1;
      if (this.state.previews !== NO_PREVIEWS) this.set({ previews: NO_PREVIEWS });
    }
    if (rev <= this.previewRevAsked) return;
    this.previewRevAsked = rev;
    if (this.previewsReading === asked) return;
    void this.readPreviews(asked);
  }

  /** The read itself: a failed one keeps the frames the page had and says nothing (that rev is not asked again; a higher one is). */
  private async readPreviews(asked: string): Promise<void> {
    this.previewsReading = asked;
    try {
      for (;;) {
        const wanted = this.previewRevAsked;
        const got = await fetchPreviews(asked, this.deps.fetch);
        if (this.disposed || this.sessionId !== asked || this.previewsOf !== asked) return;
        let reached = wanted;
        if (got !== null) {
          reached = Math.max(wanted, got.rev);
          this.previewRevAsked = Math.max(this.previewRevAsked, got.rev);
          const was = this.state.previews;
          this.set({ previews: got });
          if (got.cues.length !== was.cues.length || got.state !== was.state) {
            const n = got.cues.length;
            this.note(`previews: ${got.state}, ${n} ${n === 1 ? 'frame' : 'frames'} (${got.source ?? 'none'}, rev ${got.rev})`);
          }
        }
        if (this.previewRevAsked <= reached) return;
      }
    } finally {
      if (this.previewsReading === asked) this.previewsReading = null;
    }
  }
```

**Check:** `npx tsc -p tsconfig.web.json && npx vitest run web/src/stream` (every existing stream test
stays green: an unrouted previews read is a 404, which changes nothing and logs nothing).
**Impact:** one more GET per session load (`/previews`), and one per raised `preview_rev`.
`window.notesdStream` gains `previews` (additive; the verify steps and the docs shots read other
fields).

### Step 5: The box over the timeline
**File:** `web/src/stream/StreamApp.tsx`, `web/src/stream/stream.css:192`
**Change:** the stage and the timeline get refs. The timeline's pointer events (enter, move, down)
set the hover: the pointer's x, the second under it (`hoverTime` over the input's own box, which
excludes its 10 px margins), and the stage's box and the track's top as read at that event. A
pointer down starts a drag: window-level `pointermove` keeps the box following the pointer off the
track, and `pointerup` / `pointercancel` away from the track hides it. `pointerleave` hides it
unless a drag is on. The box is drawn only while there is a hover, the film has a duration and the
controls are not hidden (`hidden`, the same flag that fades the bar). It is placed in the stage
right after the `<video>`, so the captions, the top line, the overlays and the control bar (all later
in the page, no `z-index` anywhere) paint over it, and it has `pointer-events: none` and
`aria-hidden`, so it never takes the pointer and never keeps the controls up. The sheet of the
hovered cue is probed when the hover reaches it (`SheetCache.want` in an effect); until it loaded,
and when it failed or the rectangle is not inside it, the box shows the time alone. The owner's
look: a 2 px radius as `.st-btn`, the menu's dark panel and hairline, Geist Mono, no shadowed card.

**Code:**

5a. Line 1, add `useReducer`:

```ts
import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
```

5b. Line 30, replace the `./session` type import with:

```ts
import type { CachedInfo, EpisodeNumber, PreviewCue, TimeRange } from './session';
```

and after line 31 (`import { pickDefaultSubtitle } from './subtitles';`):

```ts
import {
  cueAt,
  frameStyle,
  hoverTime,
  loadSheetImage,
  PREVIEW_EDGE_PX,
  PREVIEW_TIME_PX,
  PREVIEW_WIDTH_PX,
  previewPlacement,
  SheetCache,
  TIME_ONLY_WIDTH_PX,
  type LoadSheet,
  type StageBox,
} from './previews';
```

5c. Before `type MenuName = 'subtitles' | 'quality';` (`:444`):

```tsx
/** The pointer on the timeline: its x, the film's second there, and the boxes the preview is placed against, read at that event. */
interface Hover {
  clientX: number;
  t: number;
  stage: StageBox;
  trackTop: number;
}

/** The sheets of the session's previews, each loaded once, when a hover first reaches it; a failed one gets one more try when the previews change. */
function useSheetCache(load: LoadSheet, rev: number): SheetCache {
  const [, changed] = useReducer((n: number) => n + 1, 0);
  const [cache] = useState(() => new SheetCache(load, changed));
  useEffect(() => {
    cache.forgetFailures();
  }, [cache, rev]);
  return cache;
}

/**
 * The box over the timeline while the pointer is on it or drags it: the frame of that second where the
 * session's previews hold one and its picture loaded, and the time under it; the time alone in a gap,
 * while the picture loads, and when it failed. It takes no pointer and is drawn before the captions and
 * the controls, which paint over it.
 */
function SeekPreview({ hover, cues, sheets, rev }: { hover: Hover; cues: readonly PreviewCue[]; sheets: SheetCache; rev: number }) {
  const cue = cueAt(cues, hover.t);
  const url = cue?.url ?? null;
  useEffect(() => {
    if (url !== null) sheets.want(url);
  }, [url, sheets, rev]);
  const sheet = url === null ? null : sheets.peek(url);
  const width = Math.min(PREVIEW_WIDTH_PX, Math.max(0, hover.stage.width - 2 * PREVIEW_EDGE_PX));
  const frame = cue !== null && sheet?.state === 'ready' ? frameStyle(cue, sheet, width) : null;
  const size = frame === null ? { width: TIME_ONLY_WIDTH_PX, height: PREVIEW_TIME_PX } : { width: frame.width, height: frame.height + PREVIEW_TIME_PX };
  const at = previewPlacement(hover.clientX, hover.stage, hover.trackTop, size);
  return (
    <div
      className="st-preview"
      data-testid="seek-preview"
      data-frame={frame === null ? 'none' : 'shown'}
      aria-hidden="true"
      style={{ left: at.left, bottom: at.bottom, width: size.width }}
    >
      {frame !== null && cue !== null && <div className="st-preview-frame" data-sheet={cue.url} data-rect={`${cue.x},${cue.y},${cue.w},${cue.h}`} style={frame} />}
      <span className="st-preview-time">{formatClock(hover.t)}</span>
    </div>
  );
}
```

5d. The signature of `StreamApp` (`:446`):

```tsx
export function StreamApp({
  sessionId,
  muted = false,
  deps,
  loadSheet = loadSheetImage,
}: {
  sessionId: string | null;
  muted?: boolean;
  deps?: Partial<ControllerDeps>;
  /** How a preview sheet's picture is probed; the browser's Image() unless a test gives its own. */
  loadSheet?: LoadSheet;
}) {
```

5e. After `const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);` (`:455`):

```tsx
  const stageRef = useRef<HTMLDivElement | null>(null);
  const seekRef = useRef<HTMLInputElement | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [dragging, setDragging] = useState(false);
  const sheets = useSheetCache(loadSheet, state.previews.rev);
  const hoverAt = useCallback(
    (clientX: number): Hover | null => {
      const stage = stageRef.current;
      const seek = seekRef.current;
      if (stage === null || seek === null) return null;
      // The input's own box: its margins are outside it, so the second is where a click would seek.
      const track = seek.getBoundingClientRect();
      const t = hoverTime(clientX, track, view.duration);
      if (t === null) return null;
      const s = stage.getBoundingClientRect();
      return { clientX, t, stage: { left: s.left, bottom: s.bottom, width: s.width, height: s.height }, trackTop: track.top };
    },
    [view.duration],
  );
  // A drag of the thumb: the box follows the pointer even off the track, and goes when it is let go away from it.
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => setHover(hoverAt(e.clientX));
    const up = (e: PointerEvent) => {
      setDragging(false);
      const r = seekRef.current?.getBoundingClientRect();
      const over = r !== undefined && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!over) setHover(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [dragging, hoverAt]);
```

(`view` is declared at `:451`, before this block, so `hoverAt` can read it.)

5f. The stage and the box (`:583-584`): the stage `div` gets `ref={stageRef}`, and the box goes
right after the `<video>`:

```tsx
      <div ref={stageRef} className={hidden ? 'st-stage st-idle' : 'st-stage'} data-stage={state.stage} onMouseMove={wake}>
        <video ref={setVideo} className="st-video" playsInline muted={muted} onClick={togglePlay} onDoubleClick={fullscreenToggle} />
        {hover !== null && !hidden && view.duration > 0 && <SeekPreview hover={hover} cues={state.previews.cues} sheets={sheets} rev={state.previews.rev} />}
```

5g. The timeline (`:651-663`):

```tsx
          <input
            ref={seekRef}
            className="st-seek"
            type="range"
            aria-label="Position"
            min={0}
            max={view.duration}
            step={1}
            value={Math.min(view.time, view.duration)}
            onChange={(e) => {
              if (video !== null) video.currentTime = Number(e.currentTarget.value);
            }}
            onPointerEnter={(e) => setHover(hoverAt(e.clientX))}
            onPointerMove={(e) => setHover(hoverAt(e.clientX))}
            onPointerDown={(e) => {
              setDragging(true);
              setHover(hoverAt(e.clientX));
            }}
            onPointerLeave={() => {
              if (!dragging) setHover(null);
            }}
            style={{ ['--st-fill' as string]: `${fill}%`, ['--st-loaded-bar' as string]: loadedGradient([...view.buffered, ...state.cachedRanges], view.duration) } as CSSProperties}
          />
```

5h. `web/src/stream/stream.css`, after the `.st-clock` rule (ends `:192`):

```css
/*
 * Seek previews: the box over the timeline while the pointer is on it. It comes right after the
 * video in the page and nothing has a z-index, so the captions and the controls paint over it; it
 * never takes the pointer, so it never keeps the controls from hiding.
 */
.st-preview {
  position: absolute;
  display: flex;
  flex-direction: column;
  align-items: center;
  pointer-events: none;
}
.st-preview-frame {
  flex: none;
  background-color: #121211;
  background-repeat: no-repeat;
  border-radius: 2px;
  outline: 1px solid rgba(236, 235, 228, 0.14);
}
.st-preview-time {
  box-sizing: border-box;
  min-width: 72px;
  height: 22px;
  padding: 0 8px;
  font-size: 12px;
  line-height: 22px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.03em;
  text-align: center;
  color: #ecebe4;
  text-shadow: 0 0 4px #000, 0 1px 2px #000;
}
/* The time alone: on the menu's dark panel, so it reads over a bright picture. */
.st-preview[data-frame='none'] .st-preview-time {
  background: rgba(18, 18, 17, 0.88);
  border-radius: 2px;
  outline: 1px solid rgba(236, 235, 228, 0.14);
}
```

(`outline`, not `border`, so the frame's box is exactly the width `previewPlacement` was given.)

**Check:** `npm run typecheck && npx vitest run web/src/stream` (existing tests green).
**Impact:** the player page gains the hover box; nothing else on it changes.

### Step 6: The tests
**Files:** `web/src/stream/previews.test.tsx` (new), `web/src/stream/controller.test.tsx` (end,
`:1715`; imports `:4-5`), `web/src/stream/StreamApp.test.tsx` (end, `:508`; imports `:5-6`)
**Change:** behaviour through the public seams: pure functions by their outputs, the controller
through its fetch and state, the page through pointer events on the rendered DOM.

**Code:**

6a. `web/src/stream/previews.test.tsx` (new):

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { cueAt, frameStyle, hoverTime, previewPlacement, SheetCache, type LoadSheet } from './previews';
import type { PreviewCue } from './session';

const cue = (startS: number, over: Partial<PreviewCue> = {}): PreviewCue => ({ startS, endS: startS + 10, url: '/s.jpg', x: 0, y: 0, w: 240, h: 135, ...over });

describe('hoverTime', () => {
  // The track's box starts at 300 px and is 811 px wide: the thumb's centre travels 800 px.
  const track = { left: 300, width: 811 };

  it('is the second a click there would seek to, clamped to the film', () => {
    expect(hoverTime(305.5, track, 600)).toBe(0);
    expect(hoverTime(705.5, track, 600)).toBe(300);
    expect(hoverTime(773.5, track, 600)).toBe(351);
    expect(hoverTime(1105.5, track, 600)).toBe(600);
    expect(hoverTime(100, track, 600)).toBe(0);
    expect(hoverTime(2000, track, 600)).toBe(600);
  });

  it('has nothing to say without a duration or a track with room', () => {
    expect(hoverTime(705.5, track, 0)).toBeNull();
    expect(hoverTime(705.5, track, Number.NaN)).toBeNull();
    expect(hoverTime(705.5, { left: 300, width: 11 }, 600)).toBeNull();
  });
});

describe('cueAt', () => {
  const cues = [cue(0), cue(10), cue(40)];

  it('finds the frame whose stretch holds the second, and none in a gap', () => {
    expect(cueAt(cues, 0)).toBe(cues[0]);
    expect(cueAt(cues, 9.99)).toBe(cues[0]);
    expect(cueAt(cues, 10)).toBe(cues[1]);
    expect(cueAt(cues, 25)).toBeNull();
    expect(cueAt(cues, 45)).toBe(cues[2]);
    expect(cueAt(cues, 50)).toBeNull();
    expect(cueAt(cues, -1)).toBeNull();
    expect(cueAt([], 5)).toBeNull();
  });
});

describe('frameStyle', () => {
  it('moves and scales the sheet so the rectangle fills the box', () => {
    const c = cue(0, { x: 240, y: 135 });
    expect(frameStyle(c, { width: 1440, height: 810 }, 240)).toEqual({
      width: 240,
      height: 135,
      backgroundImage: 'url("/s.jpg")',
      backgroundPosition: '-240px -135px',
      backgroundSize: '1440px 810px',
    });
    expect(frameStyle(c, { width: 1440, height: 810 }, 120)).toEqual({
      width: 120,
      height: 68,
      backgroundImage: 'url("/s.jpg")',
      backgroundPosition: '-120px -67.5px',
      backgroundSize: '720px 405px',
    });
  });

  it('draws nothing from outside the picture, and quotes an address with a quote in it', () => {
    expect(frameStyle(cue(0, { x: 240 }), { width: 400, height: 810 }, 240)).toBeNull();
    expect(frameStyle(cue(0, { y: 700 }), { width: 1440, height: 810 }, 240)).toBeNull();
    expect(frameStyle(cue(0, { url: '/p?u=a"b(c)' }), { width: 240, height: 135 }, 240)?.backgroundImage).toBe('url("/p?u=a\\"b(c)")');
  });
});

describe('previewPlacement', () => {
  const stage = { left: 0, bottom: 900, width: 1400, height: 900 };

  it('centres the box over the pointer, above the timeline', () => {
    expect(previewPlacement(705.5, stage, 850, { width: 240, height: 157 })).toEqual({ left: 585.5, bottom: 60 });
  });

  it('keeps the box inside the stage', () => {
    expect(previewPlacement(301, stage, 850, { width: 240, height: 157 }).left).toBe(8);
    expect(previewPlacement(1395, stage, 850, { width: 240, height: 157 }).left).toBe(1152);
    expect(previewPlacement(700, { left: 0, bottom: 100, width: 1400, height: 100 }, 90, { width: 240, height: 157 }).bottom).toBe(8);
  });
});

describe('SheetCache', () => {
  it('loads each sheet once, remembers a failure until the previews change, and says when one settles', async () => {
    const load = vi.fn<LoadSheet>(async (url) => {
      if (url === '/b') throw new Error('404');
      if (url === '/empty') return { width: 0, height: 0 };
      return { width: 1440, height: 810 };
    });
    const changed = vi.fn();
    const cache = new SheetCache(load, changed);
    expect(cache.peek('/a')).toBeNull();
    cache.want('/a');
    cache.want('/a');
    expect(cache.peek('/a')).toEqual({ state: 'loading' });
    cache.want('/b');
    cache.want('/empty');
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(3));
    expect(cache.peek('/a')).toEqual({ state: 'ready', width: 1440, height: 810 });
    expect(cache.peek('/b')).toEqual({ state: 'failed' });
    // A picture with no size is not drawn.
    expect(cache.peek('/empty')).toEqual({ state: 'failed' });
    cache.want('/b');
    expect(load).toHaveBeenCalledTimes(3);
    cache.forgetFailures();
    expect(cache.peek('/a')).toEqual({ state: 'ready', width: 1440, height: 810 });
    expect(cache.peek('/b')).toBeNull();
    cache.want('/b');
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('takes a loader that throws as a failed sheet', async () => {
    const changed = vi.fn();
    const cache = new SheetCache(() => {
      throw new Error('no Image here');
    }, changed);
    cache.want('/a');
    await vi.waitFor(() => expect(cache.peek('/a')).toEqual({ state: 'failed' }));
  });
});
```

6b. `web/src/stream/controller.test.tsx`: line 4 becomes

```ts
import { NO_PREVIEWS, SessionError, fetchPreviews, mutedFromLocation, parsePreviews, parseSession, sessionIdFromLocation } from './session';
```

and line 5 becomes

```ts
import { fakeEngines, fakeVideo, jsonResponse, previewCueJson, previewsJson, routeFetch, sessionTrack, streamSessionJson, type FetchCall } from '../testing/streamFakes';
```

At the end of the file:

```tsx
describe('StreamController: seek previews (seek-preview-thumbnails phase 4)', () => {
  const PREVIEWS = `${S1}/previews`;
  const SHEET = `${S1}/previews/sheet-00000.jpg`;
  const reads = (t: { calls: FetchCall[] }, url = PREVIEWS) => t.calls.filter((c) => c.method === 'GET' && c.url === url).length;

  it('reads the answer once and keeps only what it can draw', () => {
    const cues = [
      previewCueJson(SHEET, 10, 1),
      previewCueJson(SHEET, 0, 0),
      { ...previewCueJson(SHEET, 20, 2), url: '//elsewhere.example/x.jpg' },
      { ...previewCueJson(SHEET, 30, 3), w: 0 },
      previewCueJson(SHEET, 5, 0),
      { start_s: 40, end_s: 40, url: SHEET, x: 0, y: 0, w: 240, h: 135 },
    ];
    expect(parsePreviews(previewsJson({ rev: 3, cues }))).toEqual({
      state: 'partial',
      rev: 3,
      source: 'local',
      cues: [
        { startS: 0, endS: 10, url: SHEET, x: 0, y: 0, w: 240, h: 135 },
        { startS: 10, endS: 20, url: SHEET, x: 240, y: 0, w: 240, h: 135 },
      ],
    });
    // `none` is no cue and no source, whatever the answer said.
    expect(parsePreviews({ state: 'ready', rev: 1, source: 'provider', cues: [] })).toEqual({ state: 'none', rev: 1, source: null, cues: [] });
    expect(parsePreviews({ state: 'ready', rev: 1 })).toBeNull();
    expect(parsePreviews(null)).toBeNull();
    expect(parseSession(streamSessionJson()).previewRev).toBe(0);
    expect(parseSession(streamSessionJson({ preview_rev: 4 })).previewRev).toBe(4);
  });

  it('never throws: a 404, a network failure and a body it cannot read are null', async () => {
    expect(await fetchPreviews('S1', routeFetch({}).fetchImpl)).toBeNull();
    const down = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    expect(await fetchPreviews('S1', down)).toBeNull();
    expect(await fetchPreviews('S1', routeFetch({ [`GET ${PREVIEWS}`]: () => new Response('<html>', { status: 200 }) }).fetchImpl)).toBeNull();
  });

  it('reads the frames once the session loads and again only when a position answer carries a higher preview_rev; a failed read keeps them (R1.5)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const daemon = { rev: 0, cues: [previewCueJson(SHEET, 0, 0)], down: false };
    const t = setup({
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson({ preview_rev: daemon.rev })),
      [`GET ${PREVIEWS}`]: () => (daemon.down ? jsonResponse({ error: 'boom' }, 500) : jsonResponse(previewsJson({ rev: daemon.rev, cues: daemon.cues }))),
      [`POST ${S1}/position`]: () => jsonResponse({ ok: true, play_id: 'p1', ended: false, subtitle_rev: 0, source_rev: 0, preview_rev: daemon.rev }),
    });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    await vi.waitFor(() => expect(t.controller.getState().previews.cues).toHaveLength(1));
    expect(reads(t)).toBe(1);
    expect(t.controller.getState().log).toContain('previews: partial, 1 frame (local, rev 0)');
    Object.assign(t.media, { currentTime: 30, duration: 888, paused: false });
    t.fire('timeupdate');
    // Reports that carry the same number read nothing, and nothing reads on a timer.
    await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS * 6);
    expect(t.posts().length).toBeGreaterThanOrEqual(5);
    expect(reads(t)).toBe(1);
    daemon.rev = 1;
    daemon.cues = [previewCueJson(SHEET, 0, 0), previewCueJson(SHEET, 10, 1)];
    await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS);
    await vi.waitFor(() => expect(t.controller.getState().previews).toMatchObject({ rev: 1, cues: [{ startS: 0 }, { startS: 10 }] }));
    expect(reads(t)).toBe(2);
    expect(t.controller.getState().log).toContain('previews: partial, 2 frames (local, rev 1)');
    // A read that fails keeps the frames the page had and puts nothing on the page.
    daemon.rev = 2;
    daemon.down = true;
    await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS);
    await vi.waitFor(() => expect(reads(t)).toBe(3));
    expect(t.controller.getState()).toMatchObject({ stage: 'ready', error: null, previews: { rev: 1, cues: [{ startS: 0 }, { startS: 10 }] } });
    // The same rev is not asked again; the film was never loaded again.
    await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS * 3);
    expect(reads(t)).toBe(3);
    expect(t.made).toHaveLength(1);
  });

  it('works against a daemon with no previews: no preview_rev, a 404, nothing said', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const t = setup({
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson()),
      [`POST ${S1}/position`]: () => jsonResponse({ ok: true, play_id: 'p1', ended: false, subtitle_rev: 0 }),
    });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    Object.assign(t.media, { currentTime: 30, duration: 888, paused: false });
    t.fire('timeupdate');
    await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS * 3);
    expect(reads(t)).toBe(1);
    expect(t.controller.getState()).toMatchObject({ stage: 'ready', previews: NO_PREVIEWS, errors: [] });
    expect(t.controller.getState().log.some((line) => line.startsWith('previews'))).toBe(false);
  });

  it("drops the frames of the episode it leaves and reads the next one's", async () => {
    const S2 = '/api/stream/sessions/S2';
    const t = setup(
      {
        [`GET ${S1}`]: () => jsonResponse(streamSessionJson({ kind: 'tv', season: 1, episode: 1, next_episode: { season: 1, episode: 2 } })),
        [`GET ${PREVIEWS}`]: () => jsonResponse(previewsJson({ state: 'ready', cues: [previewCueJson(SHEET, 0, 0)] })),
        [`POST ${S1}/episode`]: () => jsonResponse({ session_id: 'S2' }),
        [`GET ${S2}`]: () => jsonResponse(streamSessionJson({ session_id: 'S2', manifest_url: `${S2}/p?u=m2`, kind: 'tv', season: 1, episode: 2, prev_episode: { season: 1, episode: 1 } })),
      },
      { onSession: () => {} },
    );
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    await vi.waitFor(() => expect(t.controller.getState().previews.state).toBe('ready'));
    await t.controller.goToEpisode('next');
    await vi.waitFor(() => expect(t.made).toHaveLength(2));
    // Episode 2's previews answer 404: the page shows none, never episode 1's.
    await vi.waitFor(() => expect(reads(t, `${S2}/previews`)).toBe(1));
    expect(t.controller.getState().previews).toEqual(NO_PREVIEWS);
  });
});
```

6c. `web/src/stream/StreamApp.test.tsx`: line 5 becomes

```ts
import { StreamApp, delayText, cachedLabel, episodeLabel, formatClock, formatSpeed, IDLE_MS, loadedGradient, reportLabel, reportText, sourceLine, switchErrorText, RECONNECTING_NOTICE, SYNCED_NOTICE, SYNCED_NOTICE_MS, torrentLabel } from './StreamApp';
```

and line 6 becomes

```ts
import { fakeEngines, fakeSheets, jsonResponse, previewCueJson, previewsJson, routeFetch, streamSessionJson, type FetchCall } from '../testing/streamFakes';
```

At the end of the file:

```tsx
describe('the seek preview over the timeline (seek-preview-thumbnails phase 4)', () => {
  const SHEET_A = '/api/stream/sessions/S1/previews/sheet-00000.jpg';
  const SHEET_B = '/api/stream/sessions/S1/previews/sheet-00001.jpg';
  const SIZE = { width: 1440, height: 810 };
  // A 1400 × 900 stage; the timeline's box starts at 300 px and is 811 px wide, so the thumb's centre
  // travels 800 px over the film's 600 s; the track's top is at 850 px.
  const STAGE = { left: 0, top: 0, right: 1400, bottom: 900, width: 1400, height: 900, x: 0, y: 0 };
  const TRACK = { left: 300, top: 850, right: 1111, bottom: 870, width: 811, height: 20, x: 300, y: 850 };
  const xAt = (t: number) => TRACK.left + 5.5 + (800 * t) / 600;
  // Frames for 0-10 s and 300-310 s on one sheet, 400-410 s on another; a gap between them.
  const CUES = [previewCueJson(SHEET_A, 0, 0), previewCueJson(SHEET_A, 300, 30), previewCueJson(SHEET_B, 400, 4)];

  async function hoverable(previews: () => Response, routes: Record<string, (call: FetchCall) => Response> = {}) {
    vi.spyOn(HTMLMediaElement.prototype, 'duration', 'get').mockReturnValue(600);
    const sheets = fakeSheets();
    const { made, createEngine } = fakeEngines();
    const { fetchImpl, calls } = routeFetch({
      'GET /api/stream/sessions/S1': () => jsonResponse(streamSessionJson()),
      'GET /api/stream/sessions/S1/previews': previews,
      ...routes,
    });
    const el = render(<StreamApp sessionId="S1" loadSheet={sheets.load} deps={{ fetch: fetchImpl, createEngine, textUrl: () => 'blob:x', revokeTextUrl: () => {} }} />);
    await settle();
    act(() => made[0].req.handlers.onReady({ qualities: [], subtitles: [] }));
    const video = el.querySelector('video')!;
    act(() => {
      video.dispatchEvent(new Event('durationchange'));
    });
    await settle();
    const stage = el.querySelector('.st-stage') as HTMLElement;
    const seek = el.querySelector('.st-seek') as HTMLInputElement;
    stage.getBoundingClientRect = () => STAGE as DOMRect;
    seek.getBoundingClientRect = () => TRACK as DOMRect;
    return { el, stage, seek, video, made, calls, sheets };
  }

  const pointer = (target: EventTarget, type: string, clientX: number, init: MouseEventInit = {}) =>
    act(() => {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, clientY: 860, ...init }));
    });
  const box = (el: Element) => el.querySelector<HTMLElement>('[data-testid="seek-preview"]');
  const frame = (el: Element) => el.querySelector<HTMLElement>('[data-testid="seek-preview"] .st-preview-frame');
  const time = (el: Element) => el.querySelector('[data-testid="seek-preview"] .st-preview-time')?.textContent ?? null;

  it('shows the frame of the second under the pointer and its time above the timeline, loading only the sheet that holds it (R1.1)', async () => {
    const t = await hoverable(() => jsonResponse(previewsJson({ cues: CUES })));
    expect(box(t.el)).toBeNull();
    pointer(t.seek, 'pointermove', xAt(300));
    // The picture is still loading: the time alone, never an empty or broken frame.
    expect(time(t.el)).toBe('5:00');
    expect(frame(t.el)).toBeNull();
    expect(t.sheets.load.mock.calls).toEqual([[SHEET_A]]);
    await act(async () => t.sheets.answer(SHEET_A, SIZE));
    expect(frame(t.el)?.dataset).toMatchObject({ sheet: SHEET_A, rect: '0,675,240,135' });
    expect(frame(t.el)?.style.width).toBe('240px');
    expect(frame(t.el)?.style.height).toBe('135px');
    expect(time(t.el)).toBe('5:00');
    // Centred over the pointer (705.5 − 120), 10 px above the track's top (900 − 850 + 10).
    expect(box(t.el)?.style.left).toBe('585.5px');
    expect(box(t.el)?.style.bottom).toBe('60px');
    expect(box(t.el)?.getAttribute('aria-hidden')).toBe('true');
    expect(t.el.querySelector('img')).toBeNull();
    // Near the start the box stays inside the stage; the same sheet is not loaded again.
    pointer(t.seek, 'pointermove', xAt(0));
    expect(time(t.el)).toBe('0:00');
    expect(frame(t.el)?.dataset.rect).toBe('0,0,240,135');
    expect(box(t.el)?.style.left).toBe('8px');
    expect(t.sheets.load).toHaveBeenCalledTimes(1);
  });

  it('shows the time alone where no frame covers the second and where the picture failed, never a broken picture (R2.1)', async () => {
    const t = await hoverable(() => jsonResponse(previewsJson({ cues: CUES })));
    pointer(t.seek, 'pointermove', xAt(351));
    expect(time(t.el)).toBe('5:51');
    expect(frame(t.el)).toBeNull();
    expect(box(t.el)?.dataset.frame).toBe('none');
    expect(box(t.el)?.style.width).toBe('72px');
    expect(t.sheets.load).not.toHaveBeenCalled();
    pointer(t.seek, 'pointermove', xAt(405));
    await act(async () => t.sheets.answer(SHEET_B, 'fail'));
    expect(time(t.el)).toBe('6:45');
    expect(frame(t.el)).toBeNull();
    expect(t.el.querySelector('img')).toBeNull();
    expect(window.notesdStream?.stage).toBe('ready');
    expect(window.notesdStream?.errors).toEqual([]);
    // A failed picture is remembered: going back there loads nothing.
    pointer(t.seek, 'pointermove', xAt(0));
    pointer(t.seek, 'pointermove', xAt(405));
    expect(t.sheets.load.mock.calls).toEqual([[SHEET_B], [SHEET_A]]);
    expect(frame(t.el)).toBeNull();
  });

  it('shows the time alone when the daemon has no previews at all (R2.1)', async () => {
    const t = await hoverable(() => jsonResponse({ error: 'not_found' }, 404));
    pointer(t.seek, 'pointermove', xAt(300));
    expect(time(t.el)).toBe('5:00');
    expect(frame(t.el)).toBeNull();
    expect(t.sheets.load).not.toHaveBeenCalled();
  });

  it('uses new frames as soon as a position answer carries a higher preview_rev, without loading the film again (R1.5)', async () => {
    let rev = 0;
    const t = await hoverable(() => jsonResponse(previewsJson({ rev, cues: rev === 0 ? [] : CUES })), {
      'POST /api/stream/sessions/S1/position': () => jsonResponse({ ok: true, play_id: 'p1', ended: false, subtitle_rev: 0, source_rev: 0, preview_rev: rev }),
    });
    pointer(t.seek, 'pointermove', xAt(300));
    expect(time(t.el)).toBe('5:00');
    expect(frame(t.el)).toBeNull();
    rev = 1;
    Object.defineProperty(t.video, 'currentTime', { configurable: true, value: 30 });
    act(() => {
      t.video.dispatchEvent(new Event('pause'));
    });
    await settle();
    expect(window.notesdStream?.previews.rev).toBe(1);
    pointer(t.seek, 'pointermove', xAt(300));
    await act(async () => t.sheets.answer(SHEET_A, SIZE));
    expect(frame(t.el)?.dataset.rect).toBe('0,675,240,135');
    expect(t.made).toHaveLength(1);
    expect(t.el.querySelector('video')).toBe(t.video);
    expect(t.calls.filter((c) => c.url === '/api/stream/sessions/S1/previews')).toHaveLength(2);
  });

  it('follows a drag off the track, and goes on leave, on a release away from the track and when the controls hide (R1.1)', async () => {
    const t = await hoverable(() => jsonResponse(previewsJson({ cues: CUES })));
    pointer(t.seek, 'pointermove', xAt(300));
    expect(box(t.el)).not.toBeNull();
    pointer(t.seek, 'pointerout', xAt(300), { relatedTarget: t.stage });
    expect(box(t.el)).toBeNull();
    // A drag: the box follows the pointer even above the track, and goes when it is let go there.
    pointer(t.seek, 'pointerdown', xAt(0));
    pointer(t.seek, 'pointerout', xAt(0), { relatedTarget: t.stage });
    pointer(window, 'pointermove', xAt(300), { clientY: 700 });
    expect(time(t.el)).toBe('5:00');
    pointer(window, 'pointerup', xAt(300), { clientY: 700 });
    expect(box(t.el)).toBeNull();
    // The controls hide while the film plays: the box goes with them.
    vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockReturnValue(false);
    act(() => {
      t.video.dispatchEvent(new Event('play'));
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      pointer(t.stage, 'mousemove', xAt(300));
      pointer(t.seek, 'pointermove', xAt(300));
      expect(box(t.el)).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(IDLE_MS + 10);
      });
      expect(t.stage.classList.contains('st-idle')).toBe(true);
      expect(box(t.el)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
```

**Check:** `npx vitest run web/src/stream` (all green), then `npm run typecheck && npm test`.
**Impact:** tests only.

## Principles applied

- Boundary discipline: the previews answer is validated and normalized once, in `parsePreviews` (same-origin path, finite numbers, positive rectangle, sorted, overlaps dropped, `none` exactly when there is no cue); `cueAt`, the controller and the box trust the list. The one later check, the rectangle against the loaded picture's size in `frameStyle`, is against a second input (the picture) that only exists once it loads.
- Make illegal states unrepresentable: a sheet's state is the union `SheetStatus` (a size exists only on `ready`), and a frame is drawn only from a `ready` status, so "drawn from a picture that failed or has no size" cannot be written; `NO_PREVIEWS` is the one empty value, replaced wholesale on a new session.
- Laziness protocol: no new dependency and no poller; the refetch reuses the position answer that already carries `subtitle_rev` and `source_rev`; the box reuses `formatClock`, `hidden` and the menu's colours; the pure parts sit in one small module because `StreamApp.tsx` is already 720 lines and they are tested by output.
- Sequence into verifiable units: each step ends with a typecheck or a vitest run that can fail, the session module first (with the one existing test it changes), the controller before the page.
- Test behavior, not implementation: the page tests dispatch pointer events on the rendered timeline and read the DOM (time, `data-rect`, position, no `img`); the controller tests read the fetch log and the public state; nothing asserts on private fields or mocks the unit under test (the sheet loader is the browser seam, injected).

## Verification

**Build:** `npm run typecheck && npm run build`
**Tests:** `npx vitest run web/src/stream web/src/testing && npm test`
**Proof:** the real page build in Chromium, its routes faked by Playwright to follow the contract
exactly, as `player.steps.mjs` does. Phase 1 is built at the same time, so nothing here may need
the daemon's previews routes: the steps fake `/api/stream/sessions/S1`, its pass-through (the HLS
fixture film), `/position` (with `preview_rev`), `/previews` and the two sheets (an SVG of six
coloured 240 × 135 frames, and one that answers 404). The verify skill lets a page be driven this
way (`$V up --web` then `$V ui RUN steps.mjs`, with `page.route` in the steps).
- Harness: `.claude/skills/verify-notesd` (`up --web`, `ui`)
- Feature-map entries: none in this phase. The "Seek previews" entry of
  `.claude/skills/verify-notesd/features/direct-streaming.md` is phase 5's (see Handoffs).
- Setup, from the worktree root:
  ```sh
  V=.claude/skills/verify-notesd/scripts/verify.sh
  FIX=$(bash .claude/skills/verify-notesd/scripts/stream/make-hls-fixture.sh "$HOME/.local/state/notesd-verify/.stream-fixture")
  $V up --web            # note RUN=
  STEPS=$(mktemp -d)/preview-hover.steps.mjs   # write the file below there
  STREAM_FIXTURE="$FIX" $V ui RUN "$STEPS"
  ```
  The transcript is the `NN-ui-preview-hover.txt` the run prints (`[evidence: ...]`); it ends with
  `result: PASS`. Then `$V down RUN`.
- Journeys:
  - **J1** · traces R1.1 — `STREAM_FIXTURE="$FIX" $V ui RUN "$STEPS"` → passes when the transcript has `J1 PASS`: hovering the timeline at 15.5 s shows `[data-testid="seek-preview"]` with time `0:15` and a `.st-preview-frame` whose `data-sheet` is `/api/stream/sessions/S1/previews/sheet-a.svg`, `data-rect` `240,0,240,135`, width 240 px and a computed `background-image` naming `sheet-a.svg`; the box's bottom is above the timeline's top and inside the stage; its computed `pointer-events` is `none`; no `img` in it; only `sheet-a.svg` was requested
  - **J2** · traces R1.5 — same run → passes when the transcript has `J2 PASS`: at 45.5 s the box first shows `0:45` alone (rev 0 has no frame there); after the fake raises `preview_rev` to 1 in its position answers, the page reads `/previews` a second time and the same hover shows `data-rect` `960,0,240,135`, with `window.__noReload` still set, the same `video.currentSrc`, the film still playing and `window.notesdStream.previews.rev === 1`; 12 s more of position answers carrying 1 bring no third read
  - **J3** · traces R2.1 — same run → passes when the transcript has `J3 PASS`: at 75.5 s (a gap) the box shows `1:15` and no frame; at 95.5 s (a frame whose sheet answers 404) it shows `1:35` and no frame and no `img` after the 404 was served, `window.notesdStream.stage` is `ready` with no error; hovering there again requests the broken sheet no second time
  - **J4** · traces R1.1 — same run → passes when the transcript has `HIDE PASS` (the box goes when the pointer leaves the timeline, and when the controls hide after 2.5 s without a move: `.st-stage.st-idle` and no box) and `DRAG PASS` (pressing on the thumb at 15.5 s and moving 80 px above the track to 45.5 s shows `0:45`; releasing there removes the box)
- Neighbor check: the player's existing journeys still pass on the same build, with a fake that answers the previews route `403 unknown_session` (a daemon that knows nothing of previews): `STREAM_FIXTURE="$FIX" $V ui RUN .claude/skills/verify-notesd/scripts/stream/player.steps.mjs` → the transcript has `J1 PASS`, `API PASS`, `BUFFER PASS`, `J3 PASS`, `J2 PASS`, `MUTED PASS`, `CDN PASS` and `result: PASS`.
- Cost: none (no LLM, no network; Chromium and ffmpeg on this machine).

The steps file (`$STEPS`), complete:

```js
// Seek previews on the player page (seek-preview-thumbnails phase 4), in a throwaway daemon's real page
// build (verify.sh up --web), against routes faked here exactly as the plan set's interface contract
// fixes them: the session, its pass-through (the HLS fixture film of make-hls-fixture.sh, 120 s),
// /position with preview_rev, /previews and two sheets (an SVG of six frames, and one that answers 404).
// Nothing of the daemon's previews code is used. Nothing leaves this machine.
//   STREAM_FIXTURE=<folder make-hls-fixture.sh printed> verify.sh ui RUN <this file>
// Logs "J1 PASS" (R1.1), "J2 PASS" (R1.5), "J3 PASS" (R2.1), "HIDE PASS", "DRAG PASS".
import { readFileSync } from 'node:fs'
import path from 'node:path'

const FIX = process.env.STREAM_FIXTURE
const TYPES = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.vtt': 'text/vtt' }
const SHEET_A = '/api/stream/sessions/S1/previews/sheet-a.svg'
const SHEET_BROKEN = '/api/stream/sessions/S1/previews/sheet-broken.jpg'
const COLORS = ['#c0473a', '#e9c46a', '#9cc5a1', '#4a7ab0', '#8e5ab0', '#ecebe4']
// Six 240 × 135 frames side by side: frame i stands for [10 i, 10 i + 10) s.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="135">${COLORS.map(
  (c, i) => `<rect x="${i * 240}" y="0" width="240" height="135" fill="${c}"/><text x="${i * 240 + 120}" y="82" font-size="48" font-family="monospace" text-anchor="middle" fill="#000">${i * 10}s</text>`,
).join('')}</svg>`

function check(ok, what) {
  if (!ok) throw new Error(what)
}

async function until(page, cond, ms, what) {
  for (let waited = 0; waited < ms; waited += 250) {
    if (cond()) return
    await page.waitForTimeout(250)
  }
  check(cond(), what)
}

const frameCue = (i) => ({ start_s: i * 10, end_s: i * 10 + 10, url: SHEET_A, x: i * 240, y: 0, w: 240, h: 135 })

// rev 0: frames for 0-30 s. rev 1: 0-60 s, a gap to 90 s, then one frame whose sheet answers 404.
function previews(rev) {
  const cues = rev === 0 ? [0, 1, 2].map(frameCue) : [...[0, 1, 2, 3, 4, 5].map(frameCue), { start_s: 90, end_s: 100, url: SHEET_BROKEN, x: 0, y: 0, w: 240, h: 135 }]
  return { state: 'partial', rev, source: 'local', cues }
}

const session = {
  session_id: 'S1', kind: 'movie', tmdb_id: 1, season: null, episode: null, provider: 'Fixture', best_height: 720,
  created_at: null, refreshed_at: null, expires_at: null, title: 'Fixture Film (2026)',
  manifest_url: '/api/stream/sessions/S1/p?u=v720/index.m3u8', manifest_kind: 'hls', subtitles: [], resume_s: 0,
  subtitle_rev: 0, source_rev: 0, preview_rev: 0,
}

const preview = () => {
  const box = document.querySelector('[data-testid="seek-preview"]')
  if (!box) return null
  const frame = box.querySelector('.st-preview-frame')
  const r = box.getBoundingClientRect()
  const seek = document.querySelector('.st-seek').getBoundingClientRect()
  const stage = document.querySelector('.st-stage').getBoundingClientRect()
  return {
    time: box.querySelector('.st-preview-time')?.textContent ?? null,
    sheet: frame?.dataset.sheet ?? null,
    rect: frame?.dataset.rect ?? null,
    frameW: frame ? Math.round(frame.getBoundingClientRect().width) : null,
    bg: frame ? getComputedStyle(frame).backgroundImage : null,
    imgs: box.querySelectorAll('img').length,
    pointerEvents: getComputedStyle(box).pointerEvents,
    above: r.bottom <= seek.top,
    inside: r.left >= stage.left && r.right <= stage.right && r.top >= stage.top,
  }
}

export default async ({ page, base, shot, log }) => {
  check(FIX, 'set STREAM_FIXTURE to the folder make-hls-fixture.sh printed')
  const fake = { rev: 0, previewReads: 0, sheetReads: [], posts: 0 }
  await page.route('**/api/stream/sessions/**', async (route) => {
    const url = new URL(route.request().url())
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (url.pathname === '/api/stream/sessions/S1') return json(200, session)
    if (url.pathname === '/api/stream/sessions/S1/p') {
      const file = path.join(FIX, url.searchParams.get('u') ?? '')
      return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
    }
    if (url.pathname === '/api/stream/sessions/S1/position') {
      fake.posts += 1
      return json(200, { ok: true, play_id: 'p1', ended: false, subtitle_rev: 0, source_rev: 0, preview_rev: fake.rev })
    }
    if (url.pathname === '/api/stream/sessions/S1/previews') {
      fake.previewReads += 1
      return json(200, previews(fake.rev))
    }
    if (url.pathname === SHEET_A) {
      fake.sheetReads.push(url.pathname)
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: SVG })
    }
    if (url.pathname === SHEET_BROKEN) {
      fake.sheetReads.push(url.pathname)
      return json(404, { error: 'not_found' })
    }
    return json(404, { error: 'not_found' })
  })

  const seekBox = async () => {
    const b = await page.locator('.st-seek').boundingBox()
    check(b, 'the timeline is on the page')
    return b
  }
  // Where the thumb's centre is at second t (the 11 px thumb's centre travels the box's width less 11 px).
  const hoverAt = async (t, dy = 0) => {
    const b = await seekBox()
    const d = await page.evaluate(() => document.querySelector('video').duration)
    await page.mouse.move(b.x + 5.5 + ((b.width - 11) * t) / d, b.y + b.height / 2 + dy)
    return b
  }
  const timeIs = (want) => page.waitForFunction((w) => document.querySelector('[data-testid="seek-preview"] .st-preview-time')?.textContent === w, want, { timeout: 5_000 })

  await page.goto(`${base}/stream/S1?muted=1`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 30_000 })
  await page.waitForFunction(() => { const v = document.querySelector('video'); return !!v && !v.paused && v.currentTime > 1 && v.duration > 100 }, null, { timeout: 30_000 })
  await until(page, () => fake.previewReads === 1, 5_000, 'the previews were read once after the session loaded')
  await page.evaluate(() => { window.__noReload = true })

  // J1 (R1.1): the frame of 15.5 s and its time, above the timeline.
  await hoverAt(15.5)
  await timeIs('0:15')
  await page.waitForSelector('[data-testid="seek-preview"] .st-preview-frame', { timeout: 5_000 })
  const j1 = await page.evaluate(preview)
  log(`J1 ${JSON.stringify(j1)} sheets=${JSON.stringify(fake.sheetReads)}`)
  check(j1.sheet === SHEET_A && j1.rect === '240,0,240,135', `J1: the frame of 10-20 s from sheet-a (got ${j1.sheet} ${j1.rect})`)
  check(j1.frameW === 240 && /sheet-a\.svg/.test(j1.bg), `J1: drawn 240 px wide from sheet-a (got ${j1.frameW}, ${j1.bg})`)
  check(j1.above && j1.inside, 'J1: the box is above the timeline and inside the stage')
  check(j1.pointerEvents === 'none' && j1.imgs === 0, 'J1: the box takes no pointer and holds no <img>')
  check(fake.sheetReads.length === 1 && fake.sheetReads[0] === SHEET_A, `J1: only the hovered sheet was loaded (got ${JSON.stringify(fake.sheetReads)})`)
  await shot('j1-frame')
  log('J1 PASS: a hover at 15.5 s shows the 10-20 s frame and 0:15 above the timeline')

  // J2 (R1.5): 45.5 s has no frame under rev 0; rev 1 arrives in a position answer and brings one, without a reload.
  await hoverAt(45.5)
  await timeIs('0:45')
  check((await page.evaluate(preview)).sheet === null, 'J2: no frame at 45.5 s under rev 0')
  const src = await page.evaluate(() => document.querySelector('video').currentSrc)
  fake.rev = 1
  await until(page, () => fake.previewReads === 2, 15_000, 'J2: a position answer carrying preview_rev 1 brought a second read')
  await hoverAt(45.6)
  await timeIs('0:45')
  await page.waitForSelector('[data-testid="seek-preview"] .st-preview-frame', { timeout: 5_000 })
  const j2 = await page.evaluate(preview)
  const j2page = await page.evaluate(() => ({ kept: window.__noReload === true, src: document.querySelector('video').currentSrc, playing: !document.querySelector('video').paused, rev: window.notesdStream.previews.rev }))
  log(`J2 ${JSON.stringify(j2)} ${JSON.stringify(j2page)}`)
  check(j2.rect === '960,0,240,135', `J2: the new frame of 40-50 s (got ${j2.rect})`)
  check(j2page.kept && j2page.src === src && j2page.playing && j2page.rev === 1, `J2: same page, same film, still playing, rev 1 (got ${JSON.stringify(j2page)})`)
  const posts = fake.posts
  await page.waitForTimeout(12_000)
  check(fake.posts >= posts + 2 && fake.previewReads === 2, `J2: answers carrying the same rev read nothing (posts ${fake.posts - posts}, reads ${fake.previewReads})`)
  await shot('j2-new-frame')
  log('J2 PASS: preview_rev 1 in a position answer brought the 40-50 s frame without a reload; no read on a timer')

  // J3 (R2.1): a gap, then a frame whose sheet answers 404: the time alone, nothing broken.
  await hoverAt(75.5)
  await timeIs('1:15')
  const gap = await page.evaluate(preview)
  check(gap.sheet === null && gap.imgs === 0, 'J3: the time alone in a gap')
  await hoverAt(95.5)
  await timeIs('1:35')
  await until(page, () => fake.sheetReads.includes(SHEET_BROKEN), 5_000, 'J3: the broken sheet was asked for')
  await page.waitForTimeout(500)
  const broken = await page.evaluate(preview)
  const stage = await page.evaluate(() => ({ stage: window.notesdStream.stage, errors: window.notesdStream.errors }))
  log(`J3 ${JSON.stringify(broken)} ${JSON.stringify(stage)}`)
  check(broken.time === '1:35' && broken.sheet === null && broken.imgs === 0, 'J3: the time alone where the picture failed')
  check(stage.stage === 'ready' && stage.errors.length === 0, 'J3: no error on the page')
  await shot('j3-time-alone')
  await hoverAt(75.5)
  await hoverAt(95.6)
  await page.waitForTimeout(500)
  check(fake.sheetReads.filter((s) => s === SHEET_BROKEN).length === 1, 'J3: a failed sheet is asked for once')
  log('J3 PASS: a gap and a 404 sheet show the time alone, never a broken picture')

  // HIDE: off the timeline, and when the controls hide.
  await hoverAt(15.5)
  await timeIs('0:15')
  await page.mouse.move(700, 300)
  await page.waitForFunction(() => !document.querySelector('[data-testid="seek-preview"]'), null, { timeout: 2_000 })
  await hoverAt(15.5)
  await timeIs('0:15')
  await page.waitForFunction(() => document.querySelector('.st-stage')?.classList.contains('st-idle') && !document.querySelector('[data-testid="seek-preview"]'), null, { timeout: 6_000 })
  log('HIDE PASS: the box goes when the pointer leaves the timeline and when the controls hide')

  // DRAG: press on the thumb, move above the track, release there.
  await page.mouse.move(700, 400)
  const b = await hoverAt(15.5)
  await page.mouse.down()
  const d = await page.evaluate(() => document.querySelector('video').duration)
  await page.mouse.move(b.x + 5.5 + ((b.width - 11) * 45.5) / d, b.y - 80, { steps: 8 })
  await timeIs('0:45')
  await shot('drag')
  await page.mouse.up()
  await page.waitForFunction(() => !document.querySelector('[data-testid="seek-preview"]'), null, { timeout: 2_000 })
  log('DRAG PASS: the box follows a drag above the track and goes on release there')
}
```

**Exit criteria:** `npm run typecheck` and `npm test` pass; the steps above end with
`result: PASS` and the lines `J1 PASS`, `J2 PASS`, `J3 PASS`, `HIDE PASS`, `DRAG PASS`; the
neighbor check passes.

## Handoffs

- **Phase 5 (feature map, guide, pictures):** the "Seek previews" entry of
  `.claude/skills/verify-notesd/features/direct-streaming.md` (the user-facing change of this phase
  is recorded there by phase 5, which owns the file); it may adopt the steps file above as
  `.claude/skills/verify-notesd/scripts/stream/preview-hover.steps.mjs` and name it in the entry.
  The guide's prose about the box (`docs/guide/streaming.md` "The player" and the new "Seek
  previews" section) and the `player-preview` picture in `scripts/docs/shots/streaming.mjs` are
  phase 5's; the selectors to use are `[data-testid="seek-preview"]`, `.st-preview-frame`
  (`data-sheet`, `data-rect`) and `.st-preview-time`. R1.6 (a frame within one interval of the
  real film) is proved end to end there.
- **Phase 1 (daemon side):** the page relies on the contract as written: `preview_rev` in the
  session and in the position answer, the `rev` field in the previews answer, every cue `url` a
  path beginning with a single `/`. A cue whose `url` is absolute (`http://...`) or protocol-relative
  is dropped by `parsePreviews` by design. The previews route may answer `403 unknown_session` for
  an unknown session; the page treats any non-200 as "no frames".
- **Phase 3 (provider track):** provider cues are drawn from the pass-through address (`img=1`) as
  any other sheet, probed once per address with `Image()`; a provider picture whose real size does
  not contain the cue's rectangle is shown as the time alone (`frameStyle` returns null).
- Noticed, not done (no phase owns it): `controller.ts:98-100` has three constants indented as if
  inside a block (`EVENT_TEXT_MAX`, `EVENTS_PER_POST`); harmless, left as is.

## Rollback

Revert this phase's commit. It touches only `web/src/stream/*`, `web/src/testing/streamFakes.ts`
and the two test files; the daemon is unchanged, and the previews routes (phase 1) simply go unread.
A built page without this phase shows no box.
