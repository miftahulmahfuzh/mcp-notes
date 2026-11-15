> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/direct-streaming/PLAN.md` phase 4. Source: `.workflows/plan/direct-streaming/phase-4.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 4: The player page

**Plan set:** `DIRECT_STREAMING_PLAN.md`
**Analysis:** `.workflows/analyze/20261115-182932-Z85Y_code_analyzer.md`
**Satisfies:** R2 — "daemon proxy and player page" with "one click to a full-screen film"
**Criteria:** R2.3, R2.5
**Depends on:** Phase 3
**Difficulty:** HARD
**Package:** `web/src/stream`

---

## Goal

After this phase the daemon serves a third web bundle at `/stream/<sessionId>`: a page that fills
the window, reads the session from `GET /api/stream/sessions/:id`, and plays it through phase 3's
pass-through with hls.js (HLS), dash.js (DASH) or the browser itself (a plain file). The English
subtitle is shown by default when the manifest or the resolve has one (an `.srt` is converted to
WebVTT in the page), the quality is a choice, the play starts at `resume_s`, the position is
posted every 5 s and on pause and end, and a 401/403/410 from the stream host makes the page call
`POST .../refresh` and carry on from where it was. hls.js and dash.js are pinned npm packages
bundled into the page, each loaded only when the manifest needs it.

## Interface Contract

**Deletes:** none
**Renames:** none
**Creates:**
- Page `web/stream.html`, Vite input `stream` (`web/vite.config.ts`), served by `src/http/static.ts` for `GET /stream/<sessionId>` (one path segment, optional trailing slash).
- `web/src/stream/session.ts`: `ManifestKind`, `SessionSubtitle`, `StreamSession`, `SessionError`, `parseSession`, `sessionIdFromLocation`, `mutedFromLocation`, `sessionUrl`, `refreshUrl`, `positionUrl`, `fetchSession`, `refreshSession`, `postPosition`, `fetchText`, `PositionReport`.
- `web/src/stream/subtitles.ts`: `SubtitleOption`, `isEnglish`, `pickDefaultSubtitle`, `toWebVtt`.
- `web/src/stream/engine.ts`: `Quality`, `EmbeddedSubtitle`, `EngineReady`, `EngineHandlers` (`onReady`, `onAuthError`, `onSessionOver`, `onFatal`), `PlayerEngine`, `EngineRequest`, `CreateEngine`, `AUTH_STATUSES`, `isAuthStatus`, `UPSTREAM_HEADER` (`x-notesd-upstream`), `classifyRefusal`.
- `web/src/stream/createEngine.ts`: `createEngine`. `web/src/stream/{hlsEngine,dashEngine,nativeEngine}.ts`: `createHlsEngine`, `createDashEngine`, `createNativeEngine`.
- `web/src/stream/controller.ts`: `StreamController` (with `playWithSound()`), `StreamState` (with `muted`, `errors`), `Stage`, `ControllerDeps` (with `muted`), `INITIAL_STATE`, `POSITION_INTERVAL_MS` (5000), `MAX_REFRESHES` (3).
- `web/src/stream/StreamApp.tsx`: `StreamApp`, `formatClock`, `qualityLabel`, `IDLE_MS`, `NotesdStream`, `notesdStreamOf`; `window.notesdStream` (global; **reconciler**): the state snapshot plus `kind` (`hls|dash|mp4|null`), `levels` (the heights offered, highest first), `level` (the chosen quality's engine index, `-1` for auto), `errors` (the player's error messages, oldest first), `refreshes`, and `start()` (unmute and play, as a user gesture from phase 1's `open --fullscreen`; resolves `true` when playing with sound; does nothing and resolves `false` under `?muted=1`).
- **The address `/stream/<id>?muted=1` (reconciler, for phase 6):** the `<video>` is muted before any `play()`, is never unmuted (the mute key and icon do nothing), and the page never asks for full screen (the full-screen key, icon and double click do nothing). Without it, the page tries sound first and falls back to a muted start with the muted speaker icon when Chrome refuses.
- **The page's `<title>` (reconciler):** `Stream` until the session is read, then the session's title; never empty and never the address or host, because phase 1's `open` (through `cdp.ps1`) only takes a tab whose title differs from both, and answers `no_tab` otherwise.
- `web/src/testing/streamFakes.ts`: `fakeEngines`, `fakeVideo`, `routeFetch`, `jsonResponse`, `streamSessionJson`.
- Verify harness: `.claude/skills/verify-notesd/scripts/stream/make-hls-fixture.sh`, `.claude/skills/verify-notesd/scripts/stream/player.steps.mjs`.
- npm devDependencies `hls.js@1.7.4`, `dashjs@5.2.1` (exact pins, bundled; see Step 1 for why devDependencies).

**Signature changes:** none (`staticRoutes` gains one branch, same signature).

**Requires (from earlier phases):** Phase 3, exactly these shapes (the page relies on nothing else):

1. `GET /api/stream/sessions/:id` answers 200 with phase 3's `SessionInfo`. The page **requires**
   `session_id`, `manifest_url`, `manifest_kind`; it **reads** `title`, `subtitles[].url|lang|label|source|english`,
   `resume_s` when present; it **ignores** every other field.

   ```json
   {
     "session_id": "k3R9xQ2mVb7TfY0aQe1zN4uW8sXc2dLp",
     "kind": "movie", "tmdb_id": 550, "season": null, "episode": null,
     "title": "Fight Club (1999)",
     "provider": "VidFast",
     "manifest_kind": "hls",
     "manifest_url": "/api/stream/sessions/k3R9xQ2mVb7TfY0aQe1zN4uW8sXc2dLp/p?u=https%3A%2F%2Fhost.example%2Fmaster.m3u8",
     "subtitles": [
       { "url": "/api/stream/sessions/k3R9xQ2mVb7TfY0aQe1zN4uW8sXc2dLp/p?u=https%3A%2F%2Fhost.example%2Fen.srt&vtt=1",
         "lang": "en", "label": "English", "format": "vtt", "source": "request", "english": true }
     ],
     "best_height": 2160,
     "resume_s": 0,
     "created_at": "2026-11-15T12:00:00.000Z", "refreshed_at": "2026-11-15T12:00:00.000Z",
     "expires_at": "2026-11-15T16:00:00.000Z"
   }
   ```

   `manifest_kind` is one of `"hls"`, `"dash"`, `"mp4"` (`"mp4"` = a plain media file played
   natively). `manifest_url` and every `subtitles[].url` are **already pass-through addresses**
   (same origin, under the session); an `.srt` track comes back as WebVTT (`&vtt=1`, `format: "vtt"`).
   A track with `source: "manifest"` is inside the rewritten manifest, so the engine shows it; the
   page loads only `source: "request"` tracks as separate files. `english` is phase 3's `isEnglish`
   (the page uses it when present). `resume_s` is phase 5's: absent, `null` or `0` all mean "from
   the start". Errors are `{ "error": "<code>" }` with the contract's statuses (`unknown_session`
   403, `direct_stream_off` 503); the page shows the code's sentence and stops.
2. `GET /api/stream/sessions/:id/p?u=<url>` returns the **stream host's own status** for
   401, 403 and 410 (not mapped to 502), and every forwarded answer carries
   `X-Notesd-Upstream: <status>`. **The refresh rule (reconciler):** the page refreshes only on a
   401/403/410 that carries `X-Notesd-Upstream` (the stream host refused an expired token). A 403
   **without** it is notesd's own refusal (`unknown_session`, `forbidden_host`): the session is
   over, refresh cannot help, so the page says so (`session_over`) and stops, without a refresh
   call and without a loop.
3. `POST /api/stream/sessions/:id/refresh` (no body) answers 2xx with the session's `SessionInfo`
   (same `session_id`) when it was resolved again. When that `session_id` differs, the page reads
   that session next; otherwise it keeps its id. Either way it then re-reads
   `GET /api/stream/sessions/:id`. A non-2xx answer with `{ "error": "<code>" }` (`no_source`,
   `resolve_failed`, `unknown_session`, ...) ends the play with that code. It must accept a
   same-origin `POST` from the page (the browser sends `Origin`).

**Requires (from later phases, tolerated before they land):** Phase 5's
`POST /api/stream/sessions/:id/position` (same-origin only; the page posts from the daemon's own
origin, so the browser's `Origin` passes) with body
`{ "position_s": number, "duration_s": number | null, "ended": boolean }`
(`duration_s` is `null` while the duration is unknown or infinite). It answers 404 for a session
or a title it does not know; every answer, 404 included, and every network failure is ignored by
the page. The page posts every 5 s while playing, on `pause`, and on `ended` (then `ended: true`
and `position_s` = duration).

**Requires (from phase 1):** `cli.mjs open <url> --fullscreen` evaluates
`window.notesdStream.start()` in the page as a user gesture once the page is loaded (never when the
address carries `muted=1`).

**Leaves alone (owned by others):** `src/directStream/*`, `src/http/directStreamApi.ts`,
`scripts/docs/httpRoutes.ts` (phase 3; no new HTTP route here, `/stream/<id>` is a static page
like `/full/<id>`); `claude/streaming/direct/*` including `cli.mjs open --fullscreen` (phase 1);
`web/src/pages/*`, `web/src/components/movies/*`, `web/src/lib/*` (phase 9); `src/movies/*` and
the position route (phase 5); the guide's "Direct streaming" section heading and other
subsections (phases 1, 3, 7, 8, 10); `.claude/skills/verify-notesd/features/README.md` row
(phase 3).

## Files

| File | Action | What changes |
|---|---|---|
| `package.json:42` (devDependencies) | modify | add `"dashjs": "5.2.1"`, `"hls.js": "1.7.4"` |
| `package-lock.json` | modify | regenerated by `npm install --save-dev --save-exact` |
| `web/stream.html` | create | the third page shell |
| `web/vite.config.ts:20` | modify | third Vite input `stream` |
| `src/http/static.ts:105` | modify | serve `stream.html` for `/stream/<id>` |
| `tests/unit/static.test.ts:73` | modify | `/stream/<id>` serving test |
| `web/src/stream/session.ts` | create | session JSON boundary, URLs, calls to the daemon |
| `web/src/stream/subtitles.ts` | create | English detection, default choice, SRT to WebVTT |
| `web/src/stream/engine.ts` | create | the player interface every library sits behind |
| `web/src/stream/createEngine.ts` | create | picks and lazy-loads the engine for a manifest kind |
| `web/src/stream/hlsEngine.ts` | create | hls.js engine |
| `web/src/stream/dashEngine.ts` | create | dash.js engine |
| `web/src/stream/nativeEngine.ts` | create | plain-file engine |
| `web/src/stream/controller.ts` | create | the page's logic: session, subtitles, quality, positions, refresh |
| `web/src/stream/StreamApp.tsx` | create | video, icon-only controls, menus, keys, `window.notesdStream` |
| `web/src/stream/stream.css` | create | the page's look |
| `web/src/stream/main.tsx` | create | entry |
| `web/src/testing/streamFakes.ts` | create | fake engine, fake video, routed fetch |
| `web/src/stream/subtitles.test.tsx` | create | jsdom: SRT conversion, English-first |
| `web/src/stream/controller.test.tsx` | create | jsdom: controller behind a fake engine |
| `web/src/stream/StreamApp.test.tsx` | create | jsdom: menus, error view, clock |
| `docs/guide/streaming.md` (phase 3's "Direct streaming" section) | modify | `### The player` subsection |
| `docs/guide/architecture.md:232` | modify | Pages row for `/stream/<sessionId>` |
| `.claude/skills/verify-notesd/features/direct-streaming.md` (phase 3 creates) | modify | the player's sub-feature and how to drive it |
| `.claude/skills/verify-notesd/scripts/stream/make-hls-fixture.sh` | create | builds the HLS fixture the journeys play |
| `.claude/skills/verify-notesd/scripts/stream/player.steps.mjs` | create | Playwright journeys J1–J3 |

## Implementation Steps

### Step 1: Add hls.js and dash.js as pinned, bundled packages
**File:** `package.json:42` (the `devDependencies` block), `package-lock.json`
**Change:** Run from the worktree root:

```sh
npm install --save-dev --save-exact hls.js@1.7.4 dashjs@5.2.1
```

This adds, in alphabetical order inside `devDependencies`:

```json
    "dashjs": "5.2.1",
```
(between `"@vitejs/plugin-react"` and `"drizzle-kit"`) and

```json
    "hls.js": "1.7.4",
```
(between `"drizzle-kit"` and `"jsdom"`), and updates `package-lock.json` (dash.js brings its
`@svta/cml-*` and `bcp-47-match` dependencies).

devDependencies, not dependencies: every package the web bundle uses (`react`, `react-dom`,
`@phosphor-icons/react`, the fonts) is a devDependency here, because Vite bundles it into
`web/dist` and the daemon never imports it at run time. Versions: hls.js 1.7.4 (2026-10-28) and
dash.js 5.2.1 (2026-08-17), both older than two weeks; dash.js 5.3.0 (2026-11-04) is too new.
Nothing is loaded from a CDN (the spike's `cdnjs` tags are not copied).

**Impact:** `npm ci` installs two more packages. No server code imports them.
**Check:** `npm ls hls.js dashjs` prints both at the pinned versions.

### Step 2: The session boundary and the daemon calls
**File:** `web/src/stream/session.ts` (new; write Step 3's `subtitles.ts` first, it imports `isEnglish`)
**Change:** The one place the session JSON (phase 3's `SessionInfo`) is checked (`parseSession`),
the page's addresses, the `?muted=1` switch, and the three calls. Every later module trusts
`StreamSession`.
**Code:**
```ts
import { isEnglish } from './subtitles';

export type ManifestKind = 'hls' | 'dash' | 'mp4';

/** A separate subtitle file of the session (phase 3's `source: "request"` tracks). */
export interface SessionSubtitle {
  url: string;
  lang: string | null;
  label: string;
  /** Phase 3's `english` when it sent one, else isEnglish(lang, label). */
  english: boolean;
}

/** What the player needs from GET /api/stream/sessions/:id, checked once in parseSession. */
export interface StreamSession {
  id: string;
  title: string;
  manifestUrl: string;
  manifestKind: ManifestKind;
  subtitles: SessionSubtitle[];
  resumeS: number;
}

/** A failed session call. `code` is the daemon's `error` (`unknown_session`, `no_source`, ...) or one of ours. */
export class SessionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = 'SessionError';
    this.code = code;
    this.status = status;
  }
}

export interface PositionReport {
  position_s: number;
  duration_s: number | null;
  ended: boolean;
}

const KINDS: readonly string[] = ['hls', 'dash', 'mp4'];

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Phase 3's SessionInfo, checked once. A `source: "manifest"` track is inside the manifest (the engine shows it), so it is not a file. */
export function parseSession(json: unknown): StreamSession {
  if (typeof json !== 'object' || json === null) throw new SessionError('bad_session', 0);
  const o = json as Record<string, unknown>;
  const id = text(o.session_id);
  const manifestUrl = text(o.manifest_url);
  const kind = text(o.manifest_kind);
  if (id === null || manifestUrl === null || kind === null || !KINDS.includes(kind)) {
    throw new SessionError('bad_session', 0);
  }
  const subtitles: SessionSubtitle[] = [];
  if (Array.isArray(o.subtitles)) {
    for (const entry of o.subtitles) {
      if (typeof entry !== 'object' || entry === null) continue;
      const s = entry as Record<string, unknown>;
      if (s.source === 'manifest') continue;
      const url = text(s.url);
      if (url === null) continue;
      const lang = text(s.lang);
      const label = text(s.label) ?? lang ?? 'Subtitle';
      subtitles.push({ url, lang, label, english: typeof s.english === 'boolean' ? s.english : isEnglish(lang, label) });
    }
  }
  const resume = o.resume_s;
  return {
    id,
    title: text(o.title) ?? 'Stream',
    manifestUrl,
    manifestKind: kind as ManifestKind,
    subtitles,
    resumeS: typeof resume === 'number' && Number.isFinite(resume) && resume > 0 ? resume : 0,
  };
}

/** `?muted=1`: phase 6's muted check. Muted from the start, never unmuted, never full screen. */
export function mutedFromLocation(loc: Pick<Location, 'search'>): boolean {
  return new URLSearchParams(loc.search).get('muted') === '1';
}

/** The session id from `/stream/<sessionId>`. */
export function sessionIdFromLocation(loc: Pick<Location, 'pathname'>): string | null {
  const m = /^\/stream\/([^/]+)\/?$/.exec(loc.pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

export const sessionUrl = (id: string): string => `/api/stream/sessions/${encodeURIComponent(id)}`;
export const refreshUrl = (id: string): string => `${sessionUrl(id)}/refresh`;
export const positionUrl = (id: string): string => `${sessionUrl(id)}/position`;

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return body !== null && typeof body.error === 'string' ? body.error : `http_${res.status}`;
}

export async function fetchSession(id: string, fetchImpl: typeof fetch): Promise<StreamSession> {
  let res: Response;
  try {
    res = await fetchImpl(sessionUrl(id), { headers: { accept: 'application/json' } });
  } catch {
    throw new SessionError('network', 0);
  }
  if (!res.ok) throw new SessionError(await errorCode(res), res.status);
  return parseSession(await res.json().catch(() => null));
}

/** Asks the daemon to resolve the session again. Returns the id to read next: the answer's `session_id` when it names one (phase 3 keeps the id). */
export async function refreshSession(id: string, fetchImpl: typeof fetch): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(refreshUrl(id), { method: 'POST' });
  } catch {
    throw new SessionError('network', 0);
  }
  if (!res.ok) throw new SessionError(await errorCode(res), res.status);
  const body = (await res.json().catch(() => null)) as { session_id?: unknown } | null;
  return body !== null && typeof body.session_id === 'string' && body.session_id !== '' ? body.session_id : id;
}

/** Fire and forget: a 404 (no movies store yet, or a session it does not know) and every other failure are ignored. */
export async function postPosition(id: string, report: PositionReport, fetchImpl: typeof fetch): Promise<void> {
  try {
    await fetchImpl(positionUrl(id), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
    });
  } catch {
    // ignored: the position is reported again in 5 s
  }
}

export async function fetchText(url: string, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`http_${res.status}`);
  return res.text();
}
```
**Impact:** none outside the new folder.

### Step 3: English-first subtitles and SRT conversion
**File:** `web/src/stream/subtitles.ts` (new)
**Change:** One rule for "English", one rule for the default, one converter. An option carries
its `source` and `index` so nothing parses ids back.
**Code:**
```ts
export interface SubtitleOption {
  /** `manifest-<index>` or `file-<index>`: a stable key for menus and state. */
  id: string;
  /** A track inside the manifest (the engine shows it) or a separate file from the resolve (a <track>). */
  source: 'manifest' | 'file';
  index: number;
  label: string;
  lang: string | null;
  english: boolean;
}

const ENGLISH_LANG = /^(en|eng)(?:[-_].*)?$/i;

export function isEnglish(lang: string | null, label: string | null): boolean {
  if (lang !== null && ENGLISH_LANG.test(lang.trim())) return true;
  return label !== null && /\benglish\b/i.test(label);
}

/** English on by default: the first English track inside the manifest, else the first English file, else none. */
export function pickDefaultSubtitle(options: readonly SubtitleOption[]): string | null {
  const english = options.filter((o) => o.english);
  const chosen = english.find((o) => o.source === 'manifest') ?? english[0];
  return chosen ? chosen.id : null;
}

const SRT_TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/g;

/** WebVTT from an SRT or WebVTT file. WebVTT comes back as it came (BOM and CR removed). */
export function toWebVtt(input: string): string {
  const clean = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (/^WEBVTT/.test(clean)) return clean;
  const body = clean
    .split('\n')
    .map((line) =>
      line.includes('-->')
        ? line.replace(SRT_TIME, (_all: string, h: string, m: string, s: string, ms: string) => `${h.padStart(2, '0')}:${m}:${s}.${ms.padEnd(3, '0')}`)
        : line,
    )
    .join('\n');
  return `WEBVTT\n\n${body.trim()}\n`;
}
```
**Impact:** none outside the folder.

### Step 4: Tests for Steps 2–3
**File:** `web/src/stream/subtitles.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isEnglish, pickDefaultSubtitle, toWebVtt, type SubtitleOption } from './subtitles';

const opt = (source: 'manifest' | 'file', index: number, label: string, lang: string | null): SubtitleOption => ({
  id: `${source}-${index}`,
  source,
  index,
  label,
  lang,
  english: isEnglish(lang, label),
});

describe('toWebVtt', () => {
  it('turns SRT into WebVTT: header, dot milliseconds, two-digit hours, LF line ends', () => {
    const srt = '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\n\r\n2\r\n0:01:00,5 --> 0:01:02,000\r\nBye, then\r\n';
    expect(toWebVtt(srt)).toBe(
      'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nHello\n\n2\n00:01:00.500 --> 00:01:02.000\nBye, then\n',
    );
  });

  it('returns WebVTT as it came', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n';
    expect(toWebVtt(vtt)).toBe(vtt);
  });
});

describe('isEnglish', () => {
  it.each([
    ['en', null, true],
    ['eng', null, true],
    ['en-US', null, true],
    [null, 'English (CC)', true],
    ['fr', 'Français', false],
    [null, 'Bengali', false],
    [null, null, false],
  ])('lang %s, label %s -> %s', (lang, label, expected) => {
    expect(isEnglish(lang, label)).toBe(expected);
  });
});

describe('pickDefaultSubtitle', () => {
  it('prefers an English track inside the manifest over an English file', () => {
    expect(pickDefaultSubtitle([opt('manifest', 0, 'Français', 'fr'), opt('file', 0, 'English', 'en'), opt('manifest', 1, 'English', 'en')])).toBe('manifest-1');
  });

  it('falls back to an English file', () => {
    expect(pickDefaultSubtitle([opt('manifest', 0, 'Français', 'fr'), opt('file', 0, 'English', 'en')])).toBe('file-0');
  });

  it('shows nothing when no track is English', () => {
    expect(pickDefaultSubtitle([opt('manifest', 0, 'Español', 'es')])).toBeNull();
    expect(pickDefaultSubtitle([])).toBeNull();
  });
});
```
**Check:** `npx vitest run web/src/stream/subtitles.test.tsx` passes.

### Step 5: The player interface and its three engines
**File:** `web/src/stream/engine.ts` (new)
**Change:** The seam the tests fake. Engines report only typed values; the controller never
touches hls.js or dash.js.
**Code:**
```ts
import type { ManifestKind } from './session';

export interface Quality {
  /** The engine's own index for this rendition. */
  index: number;
  height: number | null;
  bitrate: number | null;
}

export interface EmbeddedSubtitle {
  index: number;
  label: string;
  lang: string | null;
}

export interface EngineReady {
  qualities: Quality[];
  subtitles: EmbeddedSubtitle[];
}

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
  /** Playback cannot go on for another reason. */
  onFatal(message: string): void;
}

export interface PlayerEngine {
  /** -1 lets the engine choose (auto). */
  setQuality(index: number): void;
  /** null turns the manifest's subtitles off. */
  setEmbeddedSubtitle(index: number | null): void;
  destroy(): void;
}

export interface EngineRequest {
  kind: ManifestKind;
  video: HTMLVideoElement;
  src: string;
  /** Seconds to start at; 0 = the start. */
  startAt: number;
  handlers: EngineHandlers;
}

export type CreateEngine = (request: EngineRequest) => Promise<PlayerEngine>;

export const AUTH_STATUSES: ReadonlySet<number> = new Set([401, 403, 410]);

export function isAuthStatus(status: unknown): status is number {
  return typeof status === 'number' && AUTH_STATUSES.has(status);
}

/** Phase 3's pass-through puts the stream host's status here on every answer it forwarded. */
export const UPSTREAM_HEADER = 'x-notesd-upstream';

/**
 * What a refused answer means: `expired` (the stream host's 401/403/410, forwarded with
 * X-Notesd-Upstream: refresh), `over` (notesd's own 401/403/410 without it: stop), or null (not a refusal).
 */
export function classifyRefusal(status: unknown, upstreamHeader: string | null | undefined): 'expired' | 'over' | null {
  if (!isAuthStatus(status)) return null;
  return upstreamHeader !== null && upstreamHeader !== undefined && upstreamHeader !== '' ? 'expired' : 'over';
}

/** Hands a refusal to the right handler; true when it was one. */
export function reportRefusal(handlers: EngineHandlers, status: unknown, upstreamHeader: string | null | undefined): boolean {
  const kind = classifyRefusal(status, upstreamHeader);
  if (kind === 'expired') handlers.onAuthError(status as number);
  else if (kind === 'over') handlers.onSessionOver(status as number);
  return kind !== null;
}
```

**File:** `web/src/stream/createEngine.ts` (new)
**Change:** hls.js and dash.js are dynamic imports, so Vite emits each as its own chunk and an
HLS film never downloads dash.js.
**Code:**
```ts
import type { CreateEngine } from './engine';
import { createNativeEngine } from './nativeEngine';

export const createEngine: CreateEngine = async (request) => {
  switch (request.kind) {
    case 'hls':
      return (await import('./hlsEngine')).createHlsEngine(request);
    case 'dash':
      return (await import('./dashEngine')).createDashEngine(request);
    case 'mp4':
      return createNativeEngine(request);
  }
};
```

**File:** `web/src/stream/hlsEngine.ts` (new)
**Code:**
```ts
import Hls, { ErrorTypes, Events, type MediaPlaylist } from 'hls.js';
import { reportRefusal, UPSTREAM_HEADER, type EngineRequest, type PlayerEngine } from './engine';

/** X-Notesd-Upstream of a failed load: hls.js's default XhrLoader hands the XMLHttpRequest over as `networkDetails`. */
function upstreamOf(details: unknown): string | null {
  const d = details as { getResponseHeader?: (name: string) => string | null; headers?: { get?: (name: string) => string | null } } | null | undefined;
  if (typeof d?.getResponseHeader === 'function') return d.getResponseHeader(UPSTREAM_HEADER);
  if (typeof d?.headers?.get === 'function') return d.headers.get(UPSTREAM_HEADER);
  return null;
}

export function createHlsEngine({ video, src, startAt, handlers }: EngineRequest): PlayerEngine {
  if (!Hls.isSupported()) {
    handlers.onFatal('hls_unsupported');
    return { setQuality() {}, setEmbeddedSubtitle() {}, destroy() {} };
  }
  const hls = new Hls({ startPosition: startAt > 0 ? startAt : -1 });
  let subtitleTracks: MediaPlaylist[] = [];
  let recovered = false;

  hls.on(Events.MANIFEST_PARSED, (_event, data) => {
    subtitleTracks = data.subtitleTracks;
    handlers.onReady({
      qualities: data.levels.map((level, index) => ({
        index,
        height: level.height > 0 ? level.height : null,
        bitrate: level.bitrate > 0 ? level.bitrate : null,
      })),
      subtitles: subtitleTracks.map((track, index) => ({ index, label: track.name, lang: track.lang ?? null })),
    });
  });

  hls.on(Events.ERROR, (_event, data) => {
    if (reportRefusal(handlers, data.response?.code, upstreamOf(data.networkDetails))) return;
    if (!data.fatal) return;
    if (data.type === ErrorTypes.MEDIA_ERROR && !recovered) {
      recovered = true;
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
      hls.destroy();
    },
  };
}
```

**File:** `web/src/stream/dashEngine.ts` (new)
**Change:** dash.js 5's response interceptor sees every response, failed ones included (checked
in `dist/modern/esm/dash.all.debug.js`, `_onRequestEnd` applies the interceptors before the
status test), so the 401/403/410 check sits there. Text tracks start disabled so the controller
alone decides what shows.
**Code:**
```ts
import { MediaPlayer, type MediaInfo } from 'dashjs';
import { reportRefusal, UPSTREAM_HEADER, type EngineRequest, type PlayerEngine } from './engine';

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

export function createDashEngine({ video, src, startAt, handlers }: EngineRequest): PlayerEngine {
  const player = MediaPlayer().create();
  let textTracks: MediaInfo[] = [];
  let live = true;

  player.updateSettings({ streaming: { text: { defaultEnabled: false } } });
  player.addResponseInterceptor(async (response) => {
    if (live) reportRefusal(handlers, response.status, upstreamOf(response));
    return response;
  });
  player.on(MediaPlayer.events.STREAM_INITIALIZED, () => {
    if (!live) return;
    textTracks = player.getTracksFor('text');
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
  player.on(MediaPlayer.events.ERROR, (event: unknown) => {
    if (live) handlers.onFatal(`dash ${describe(event)}`);
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
      player.reset();
    },
  };
}
```

**File:** `web/src/stream/nativeEngine.ts` (new)
**Change:** A plain file. A `<video>` error carries no HTTP status, so on an error the engine asks
the pass-through for one byte and reads the status.
**Code:**
```ts
import { reportRefusal, UPSTREAM_HEADER, type EngineRequest, type PlayerEngine } from './engine';

export function createNativeEngine({ video, src, startAt, handlers }: EngineRequest, fetchImpl: typeof fetch = fetch): PlayerEngine {
  let live = true;
  const onMeta = () => {
    if (!live) return;
    if (startAt > 0) video.currentTime = startAt;
    handlers.onReady({
      qualities: video.videoHeight > 0 ? [{ index: 0, height: video.videoHeight, bitrate: null }] : [],
      subtitles: [],
    });
  };
  const onError = () => {
    if (!live) return;
    const why = `media error ${video.error?.code ?? 0}`;
    fetchImpl(src, { headers: { range: 'bytes=0-0' } })
      .then((res) => {
        if (!live) return;
        if (!reportRefusal(handlers, res.status, res.headers.get(UPSTREAM_HEADER))) handlers.onFatal(why);
      })
      .catch(() => {
        if (live) handlers.onFatal(why);
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
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('error', onError);
      video.removeAttribute('src');
      video.load();
    },
  };
}
```
**Impact:** none outside the folder.
**Check:** `npm run typecheck` passes (this is the step that proves the hls.js and dash.js typings
line up: `data.response?.code`, `data.networkDetails`, the interceptor response's `headers`, `setSubtitleOption`, `addResponseInterceptor`,
`getRepresentationsByType`, `setRepresentationForTypeByIndex`, `setCurrentTrack`). If a dash.js
5.2.1 typing differs from the above, adjust to the installed `node_modules/dashjs/index.d.ts`
without changing the `PlayerEngine` behaviour, and say so in the commit.

### Step 6: The controller
**File:** `web/src/stream/controller.ts` (new)
**Change:** All of the page's behaviour, with no React and no library: read the session, load
separate subtitle files as `<track>`s, start an engine at `resume_s`, choose English, apply the
quality, post positions, refresh on a 401/403/410 the stream host sent (`onAuthError`, the
answer carried `X-Notesd-Upstream`) and continue; stop with `session_over` on one notesd sent
(`onSessionOver`: no refresh, no loop). Callbacks from an engine that was replaced are dropped by a
generation counter. A refreshed stream that is refused again before it plays, or a fourth refresh,
ends the play with `stream_expired` instead of looping. With `muted` (the address's `?muted=1`)
the video is muted before any `play()` and never unmuted; `playWithSound()` (the page's
`window.notesdStream.start()`) unmutes and plays once the stream is ready, and does nothing when muted.
**Code:**
```ts
import type { CreateEngine, EngineReady, PlayerEngine, Quality } from './engine';
import {
  fetchSession,
  fetchText,
  postPosition,
  refreshSession,
  SessionError,
  type ManifestKind,
  type StreamSession,
} from './session';
import { isEnglish, pickDefaultSubtitle, toWebVtt, type SubtitleOption } from './subtitles';

export const POSITION_INTERVAL_MS = 5_000;
export const MAX_REFRESHES = 3;
const LOG_MAX = 20;

export type Stage = 'loading' | 'ready' | 'refreshing' | 'error';

export interface StreamState {
  stage: Stage;
  title: string;
  kind: ManifestKind | null;
  /** Highest first. */
  qualities: Quality[];
  /** -1 = auto. */
  quality: number;
  subtitles: SubtitleOption[];
  subtitle: string | null;
  /** The code behind stage 'error'. */
  error: string | null;
  refreshes: number;
  /** The last position sent to the daemon. */
  reportedS: number | null;
  /** `?muted=1`: muted from the start, never unmuted, never full screen (phase 6's checks). */
  muted: boolean;
  /** The player's error messages, oldest first (phase 6's playcheck reads them). */
  errors: string[];
  /** Recent notes for scripts and people: refreshes, subtitle failures, errors. */
  log: string[];
}

export const INITIAL_STATE: StreamState = {
  stage: 'loading',
  title: 'Stream',
  kind: null,
  qualities: [],
  quality: -1,
  subtitles: [],
  subtitle: null,
  error: null,
  refreshes: 0,
  reportedS: null,
  muted: false,
  errors: [],
  log: [],
};

export interface ControllerDeps {
  fetch: typeof fetch;
  createEngine: CreateEngine;
  /** A URL a <track> can load WebVTT text from (a blob: URL in the browser). */
  textUrl: (vtt: string) => string;
  revokeTextUrl: (url: string) => void;
  /** `?muted=1` (mutedFromLocation). Default false. */
  muted?: boolean;
}

interface FileTrack {
  option: SubtitleOption;
  element: HTMLTrackElement;
  url: string;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class StreamController {
  private sessionId: string;
  private readonly video: HTMLVideoElement;
  private readonly deps: ControllerDeps;
  private state: StreamState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private session: StreamSession | null = null;
  private engine: PlayerEngine | null = null;
  private ready: EngineReady | null = null;
  private generation = 0;
  private readySinceAttach = false;
  private subtitleChosen = false;
  private lastPositionS = 0;
  private fileTracks: FileTrack[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private readonly mutedMode: boolean;
  /** Resolved the first time the stream is ready or the play has failed (playWithSound waits on it). */
  private settle: () => void = () => {};
  private readonly settled: Promise<void>;

  constructor(sessionId: string, video: HTMLVideoElement, deps: ControllerDeps) {
    this.sessionId = sessionId;
    this.video = video;
    this.deps = deps;
    this.mutedMode = deps.muted === true;
    this.settled = new Promise<void>((resolve) => {
      this.settle = resolve;
    });
    if (this.mutedMode) {
      // Before any play(): phase 6's muted checks must never make a sound.
      this.video.muted = true;
      this.state = { ...this.state, muted: true };
    }
  }

  /**
   * window.notesdStream.start(): phase 1's `open --fullscreen` evaluates it as a user gesture, so
   * Chrome lets the film play with sound. Waits until the stream is ready, then unmutes and plays.
   * Does nothing under ?muted=1. True when the film is playing with sound.
   */
  async playWithSound(): Promise<boolean> {
    if (this.mutedMode || this.disposed) return false;
    await this.settled;
    if (this.disposed || this.state.stage !== 'ready') return false;
    this.video.muted = false;
    try {
      await this.video.play();
    } catch (err) {
      this.note(`start: ${messageOf(err)}`);
      return false;
    }
    return !this.video.muted && !this.video.paused;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): StreamState => this.state;

  async start(): Promise<void> {
    this.video.addEventListener('timeupdate', this.onTime);
    this.video.addEventListener('seeking', this.onTime);
    this.video.addEventListener('pause', this.onPause);
    this.video.addEventListener('ended', this.onEnded);
    this.timer = setInterval(this.onTick, POSITION_INTERVAL_MS);
    let session: StreamSession;
    try {
      session = await fetchSession(this.sessionId, this.deps.fetch);
    } catch (err) {
      if (!this.disposed) this.fail(err);
      return;
    }
    if (this.disposed) return;
    this.session = session;
    this.set({ title: session.title, kind: session.manifestKind });
    await this.loadFileSubtitles(session);
    if (this.disposed) return;
    await this.attach(session, session.resumeS);
  }

  selectSubtitle(id: string | null): void {
    if (id !== null && !this.state.subtitles.some((o) => o.id === id)) return;
    this.subtitleChosen = true;
    this.showSubtitle(this.state.subtitles, id);
    this.set({ subtitle: id });
  }

  selectQuality(index: number): void {
    if (index !== -1 && !this.state.qualities.some((q) => q.index === index)) return;
    this.engine?.setQuality(index);
    this.set({ quality: index });
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.video.removeEventListener('timeupdate', this.onTime);
    this.video.removeEventListener('seeking', this.onTime);
    this.video.removeEventListener('pause', this.onPause);
    this.video.removeEventListener('ended', this.onEnded);
    this.engine?.destroy();
    this.engine = null;
    for (const track of this.fileTracks) {
      track.element.remove();
      this.deps.revokeTextUrl(track.url);
    }
    this.fileTracks = [];
  }

  private set(patch: Partial<StreamState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private note(line: string): void {
    this.set({ log: [...this.state.log, line].slice(-LOG_MAX) });
  }

  private fail(err: unknown): void {
    const code = err instanceof SessionError ? err.code : messageOf(err);
    this.set({
      stage: 'error',
      error: code,
      errors: [...this.state.errors, code].slice(-LOG_MAX),
      log: [...this.state.log, `error: ${code}`].slice(-LOG_MAX),
    });
    this.settle();
  }

  private async loadFileSubtitles(session: StreamSession): Promise<void> {
    for (const [index, sub] of session.subtitles.entries()) {
      try {
        const vtt = toWebVtt(await fetchText(sub.url, this.deps.fetch));
        const url = this.deps.textUrl(vtt);
        const element = this.video.ownerDocument.createElement('track');
        element.kind = 'subtitles';
        element.label = sub.label;
        if (sub.lang !== null) element.srclang = sub.lang;
        element.src = url;
        this.video.appendChild(element);
        this.fileTracks.push({
          option: { id: `file-${index}`, source: 'file', index, label: sub.label, lang: sub.lang, english: sub.english },
          element,
          url,
        });
      } catch (err) {
        this.note(`subtitle ${sub.label}: ${messageOf(err)}`);
      }
    }
  }

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

  private onReady(ready: EngineReady): void {
    this.ready = ready;
    this.readySinceAttach = true;
    if (this.engine !== null) this.applyChoices();
  }

  private applyChoices(): void {
    const ready = this.ready;
    const engine = this.engine;
    if (ready === null || engine === null) return;
    const embedded: SubtitleOption[] = ready.subtitles.map((s) => ({
      id: `manifest-${s.index}`,
      source: 'manifest',
      index: s.index,
      label: s.label,
      lang: s.lang,
      english: isEnglish(s.lang, s.label),
    }));
    const subtitles = [...embedded, ...this.fileTracks.map((t) => t.option)];
    const keep =
      this.subtitleChosen && (this.state.subtitle === null || subtitles.some((o) => o.id === this.state.subtitle));
    const subtitle = keep ? this.state.subtitle : pickDefaultSubtitle(subtitles);
    const qualities = [...ready.qualities].sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
    const quality = qualities.some((q) => q.index === this.state.quality) ? this.state.quality : -1;
    this.showSubtitle(subtitles, subtitle);
    if (quality !== -1) engine.setQuality(quality);
    this.set({ stage: 'ready', qualities, quality, subtitles, subtitle, error: null });
    this.settle();
    void this.playOrMute();
  }

  private showSubtitle(options: readonly SubtitleOption[], id: string | null): void {
    const chosen = options.find((o) => o.id === id) ?? null;
    this.engine?.setEmbeddedSubtitle(chosen !== null && chosen.source === 'manifest' ? chosen.index : null);
    for (const track of this.fileTracks) {
      const on = chosen !== null && chosen.source === 'file' && chosen.index === track.option.index;
      track.element.default = on;
      // jsdom has no TextTrack; a browser always does.
      if (track.element.track) track.element.track.mode = on ? 'showing' : 'disabled';
    }
  }

  /**
   * Sound first; when the browser refuses autoplay with sound, play muted (the mute icon shows it,
   * and phase 1's start() call unmutes it as a user gesture). Under ?muted=1, muted only.
   */
  private async playOrMute(): Promise<void> {
    if (this.mutedMode) {
      this.video.muted = true;
    } else {
      try {
        await this.video.play();
        return;
      } catch {
        // autoplay with sound refused
      }
    }
    this.video.muted = true;
    try {
      await this.video.play();
    } catch (err) {
      this.note(`play: ${messageOf(err)}`);
    }
  }

  private readonly onTime = (): void => {
    if (this.state.stage === 'ready' && this.video.currentTime > 0) this.lastPositionS = this.video.currentTime;
  };

  private readonly onTick = (): void => {
    if (this.state.stage === 'ready' && !this.video.paused && !this.video.ended) this.report(false);
  };

  private readonly onPause = (): void => {
    if (this.state.stage === 'ready' && !this.video.ended) this.report(false);
  };

  private readonly onEnded = (): void => {
    if (this.state.stage === 'ready') this.report(true);
  };

  private report(ended: boolean): void {
    if (this.session === null) return;
    const duration = Number.isFinite(this.video.duration) && this.video.duration > 0 ? this.video.duration : null;
    const position = ended && duration !== null ? duration : this.video.currentTime;
    if (!(position > 0)) return;
    const report = { position_s: round1(position), duration_s: duration === null ? null : round1(duration), ended };
    this.set({ reportedS: report.position_s });
    void postPosition(this.sessionId, report, this.deps.fetch);
  }

  private async refresh(status: number): Promise<void> {
    if (this.state.stage === 'refreshing' || this.state.stage === 'error') return;
    if (this.state.refreshes >= MAX_REFRESHES || (this.state.refreshes > 0 && !this.readySinceAttach)) {
      this.fail(new SessionError('stream_expired', status));
      return;
    }
    const continueAt = this.lastPositionS > 0 ? this.lastPositionS : (this.session?.resumeS ?? 0);
    this.generation += 1;
    this.set({ stage: 'refreshing', refreshes: this.state.refreshes + 1 });
    this.note(`refresh after ${status} at ${round1(continueAt)} s`);
    this.engine?.destroy();
    this.engine = null;
    this.ready = null;
    try {
      this.sessionId = await refreshSession(this.sessionId, this.deps.fetch);
      const session = await fetchSession(this.sessionId, this.deps.fetch);
      if (this.disposed) return;
      this.session = session;
      await this.attach(session, continueAt);
    } catch (err) {
      if (!this.disposed) this.fail(err);
    }
  }
}
```
**Impact:** none outside the folder.

### Step 7: Test fakes and the controller tests
**File:** `web/src/testing/streamFakes.ts` (new)
**Code:**
```ts
import { vi, type Mock } from 'vitest';
import type { CreateEngine, EngineRequest, PlayerEngine } from '../stream/engine';

export interface FakeEngine extends PlayerEngine {
  req: EngineRequest;
  setQuality: Mock<(index: number) => void>;
  setEmbeddedSubtitle: Mock<(index: number | null) => void>;
  destroy: Mock<() => void>;
}

/** A CreateEngine that records each engine the page asked for; tests drive its handlers. */
export function fakeEngines(): { made: FakeEngine[]; createEngine: CreateEngine } {
  const made: FakeEngine[] = [];
  const createEngine: CreateEngine = async (req) => {
    const engine: FakeEngine = {
      req,
      setQuality: vi.fn<(index: number) => void>(),
      setEmbeddedSubtitle: vi.fn<(index: number | null) => void>(),
      destroy: vi.fn<() => void>(),
    };
    made.push(engine);
    return engine;
  };
  return { made, createEngine };
}

export interface FakeMedia {
  currentTime: number;
  duration: number;
  paused: boolean;
  ended: boolean;
  muted: boolean;
}

/** A real <video> whose media fields the test sets (jsdom plays nothing). */
export function fakeVideo(init: Partial<FakeMedia> = {}) {
  const video = document.createElement('video');
  const media: FakeMedia = { currentTime: 0, duration: Number.NaN, paused: true, ended: false, muted: false, ...init };
  for (const key of Object.keys(media) as (keyof FakeMedia)[]) {
    Object.defineProperty(video, key, {
      configurable: true,
      get: () => media[key],
      set: (value: never) => {
        media[key] = value;
      },
    });
  }
  const play = vi.fn(async () => {
    media.paused = false;
  });
  video.play = play;
  const fire = (type: string) => {
    video.dispatchEvent(new Event(type));
  };
  return { video, media, play, fire };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export interface FetchCall {
  method: string;
  url: string;
  body: unknown;
}

/** A fetch answered by `"<METHOD> <url>"` routes; anything else is a 404 `not_found`. */
export function routeFetch(routes: Record<string, (call: FetchCall) => Response>) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const call = { method, url, body };
    calls.push(call);
    const route = routes[`${method} ${url}`];
    return route ? route(call) : jsonResponse({ error: 'not_found' }, 404);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** GET /api/stream/sessions/S1 as phase 3 answers it (its SessionInfo; see phase 4's interface contract). */
export function streamSessionJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: 'S1',
    kind: 'movie',
    tmdb_id: 550,
    season: null,
    episode: null,
    title: 'Fight Club (1999)',
    provider: 'VidFast',
    manifest_kind: 'hls',
    manifest_url: '/api/stream/sessions/S1/p?u=m1',
    subtitles: [],
    best_height: 1080,
    resume_s: 0,
    created_at: '2026-11-15T12:00:00.000Z',
    refreshed_at: '2026-11-15T12:00:00.000Z',
    expires_at: '2026-11-15T16:00:00.000Z',
    ...over,
  };
}

/** One subtitle track of a SessionInfo: a separate file (`source: "request"`) unless said otherwise. */
export function sessionTrack(url: string, lang: string | null, label: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { url, lang, label, format: 'vtt', source: 'request', english: lang === 'en', ...over };
}
```

**File:** `web/src/stream/controller.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_REFRESHES, POSITION_INTERVAL_MS, StreamController } from './controller';
import { classifyRefusal } from './engine';
import { SessionError, mutedFromLocation, parseSession, sessionIdFromLocation } from './session';
import { fakeEngines, fakeVideo, jsonResponse, routeFetch, sessionTrack, streamSessionJson, type FetchCall } from '../testing/streamFakes';

const S1 = '/api/stream/sessions/S1';
const controllers: StreamController[] = [];

afterEach(() => {
  for (const c of controllers.splice(0)) c.dispose();
  vi.useRealTimers();
});

function setup(routes: Record<string, (call: FetchCall) => Response>, opts: { muted?: boolean } = {}) {
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
  });
  controllers.push(controller);
  const posts = (url = `${S1}/position`) => calls.filter((c) => c.method === 'POST' && c.url === url).map((c) => c.body);
  return { controller, made, calls, video, media, play, fire, texts, posts };
}

const english = { index: 0, label: 'English', lang: 'en' };

describe('parseSession', () => {
  it('maps phase 3\'s SessionInfo and fills what is optional; tracks inside the manifest are not files', () => {
    const subtitles = [
      sessionTrack('/x', 'en', '', { english: true }),
      sessionTrack('/m.m3u8', 'en', 'English', { format: 'hls', source: 'manifest' }),
      { url: '/y', lang: null, label: 'English (CC)', format: 'vtt' },
    ];
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
    });
    expect(parseSession({ session_id: 'S1', manifest_url: '/m', manifest_kind: 'mp4' })).toMatchObject({ title: 'Stream', subtitles: [], resumeS: 0 });
    expect(() => parseSession({ id: 'S1', manifest_url: '/m', manifest_kind: 'mp4' })).toThrow('bad_session');
  });

  it('reads ?muted=1, and tells an expired token from a session notesd refused', () => {
    expect(mutedFromLocation({ search: '?muted=1' })).toBe(true);
    expect(mutedFromLocation({ search: '' })).toBe(false);
    expect(classifyRefusal(403, '403')).toBe('expired');
    expect(classifyRefusal(410, '410')).toBe('expired');
    expect(classifyRefusal(403, null)).toBe('over');
    expect(classifyRefusal(404, '404')).toBeNull();
  });

  it('refuses a session without a manifest or with an unknown kind', () => {
    expect(() => parseSession(streamSessionJson({ manifest_url: undefined }))).toThrow(SessionError);
    expect(() => parseSession(streamSessionJson({ manifest_kind: 'smooth' }))).toThrow('bad_session');
  });

  it('reads the id from /stream/<id>', () => {
    expect(sessionIdFromLocation({ pathname: '/stream/k3R9xQ2m' })).toBe('k3R9xQ2m');
    expect(sessionIdFromLocation({ pathname: '/stream/k3R9xQ2m/' })).toBe('k3R9xQ2m');
    expect(sessionIdFromLocation({ pathname: '/stream/' })).toBeNull();
    expect(sessionIdFromLocation({ pathname: '/stream/a/b' })).toBeNull();
  });
});

describe('StreamController: subtitles and quality (R2.3)', () => {
  it('starts at resume_s and shows the English track inside the manifest over a French one', async () => {
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson({ resume_s: 42 })) });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    const engine = t.made[0];
    expect(engine.req).toMatchObject({ kind: 'hls', src: `${S1}/p?u=m1`, startAt: 42 });

    engine.req.handlers.onReady({
      qualities: [
        { index: 0, height: 720, bitrate: null },
        { index: 1, height: 1080, bitrate: null },
        { index: 2, height: 480, bitrate: null },
      ],
      subtitles: [
        { index: 0, label: 'Français', lang: 'fr' },
        { index: 1, label: 'English', lang: 'en' },
      ],
    });

    const s = t.controller.getState();
    expect(s).toMatchObject({ stage: 'ready', title: 'Fight Club (1999)', subtitle: 'manifest-1', quality: -1 });
    expect(engine.setEmbeddedSubtitle).toHaveBeenLastCalledWith(1);
    expect(s.qualities.map((q) => q.height)).toEqual([1080, 720, 480]);
    await vi.waitFor(() => expect(t.play).toHaveBeenCalled());
  });

  it('shows a separate English .srt, converted to WebVTT, when the manifest has no English track', async () => {
    const FR = `${S1}/p?u=fr.vtt`;
    const EN = `${S1}/p?u=en.srt`;
    const t = setup({
      [`GET ${S1}`]: () =>
        jsonResponse(
          streamSessionJson({
            subtitles: [sessionTrack(FR, 'fr', 'French'), sessionTrack(EN, 'en', 'English', { format: 'srt' })],
          }),
        ),
      [`GET ${FR}`]: () => new Response('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBonjour\n'),
      [`GET ${EN}`]: () => new Response('1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\n'),
    });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [{ index: 0, label: 'Deutsch', lang: 'de' }] });

    expect(t.texts[1]).toBe('WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nHello\n');
    const tracks = [...t.video.querySelectorAll('track')];
    expect(tracks.map((el) => [el.kind, el.srclang, el.label, el.default, el.getAttribute('src')])).toEqual([
      ['subtitles', 'fr', 'French', false, 'blob:vtt-1'],
      ['subtitles', 'en', 'English', true, 'blob:vtt-2'],
    ]);
    const s = t.controller.getState();
    expect(s.subtitle).toBe('file-1');
    expect(s.subtitles.map((o) => o.label)).toEqual(['Deutsch', 'French', 'English']);
    expect(t.made[0].setEmbeddedSubtitle).toHaveBeenLastCalledWith(null);
  });

  it('shows no subtitle when none is English, and a pick reaches the engine', async () => {
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson()) });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [{ index: 0, label: 'Español', lang: 'es' }] });
    expect(t.controller.getState().subtitle).toBeNull();
    expect(t.made[0].setEmbeddedSubtitle).toHaveBeenLastCalledWith(null);

    t.controller.selectSubtitle('manifest-0');
    expect(t.made[0].setEmbeddedSubtitle).toHaveBeenLastCalledWith(0);
    expect(t.controller.getState().subtitle).toBe('manifest-0');
    t.controller.selectSubtitle('manifest-9');
    expect(t.controller.getState().subtitle).toBe('manifest-0');
  });

  it('offers the qualities and switches on a choice; an unknown one is ignored', async () => {
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson()) });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({
      qualities: [
        { index: 0, height: 360, bitrate: null },
        { index: 1, height: 2160, bitrate: null },
      ],
      subtitles: [],
    });
    t.controller.selectQuality(0);
    expect(t.made[0].setQuality).toHaveBeenLastCalledWith(0);
    expect(t.controller.getState().quality).toBe(0);
    t.controller.selectQuality(7);
    expect(t.controller.getState().quality).toBe(0);
    t.controller.selectQuality(-1);
    expect(t.made[0].setQuality).toHaveBeenLastCalledWith(-1);
    expect(t.controller.getState().quality).toBe(-1);
  });
});

describe('StreamController: positions', () => {
  it('posts every 5 s while playing, on pause and at the end; a 404 changes nothing', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson()) });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    Object.assign(t.media, { currentTime: 12.34, duration: 600, paused: false });

    await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS);
    expect(t.posts()).toEqual([{ position_s: 12.3, duration_s: 600, ended: false }]);

    t.media.paused = true;
    await vi.advanceTimersByTimeAsync(POSITION_INTERVAL_MS);
    expect(t.posts()).toHaveLength(1);

    t.media.currentTime = 15;
    t.fire('pause');
    Object.assign(t.media, { currentTime: 600, ended: true });
    t.fire('ended');
    await vi.waitFor(() => expect(t.posts()).toHaveLength(3));
    expect(t.posts().slice(1)).toEqual([
      { position_s: 15, duration_s: 600, ended: false },
      { position_s: 600, duration_s: 600, ended: true },
    ]);
    expect(t.controller.getState()).toMatchObject({ stage: 'ready', reportedS: 600, error: null });
  });
});

describe('StreamController: refresh and continue (R2.5)', () => {
  it.each([401, 403, 410])('a %i from the stream host refreshes the session and continues from the last position', async (status) => {
    let gets = 0;
    const t = setup({
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson({ manifest_url: `${S1}/p?u=m${++gets}` })),
      [`POST ${S1}/refresh`]: () => jsonResponse(streamSessionJson({ manifest_url: `${S1}/p?u=m2` })),
    });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    const first = t.made[0];
    first.req.handlers.onReady({ qualities: [], subtitles: [english] });
    t.media.currentTime = 77.5;
    t.fire('timeupdate');

    first.req.handlers.onAuthError(status);
    expect(t.controller.getState().stage).toBe('refreshing');
    expect(first.destroy).toHaveBeenCalled();
    await vi.waitFor(() => expect(t.made).toHaveLength(2));
    const second = t.made[1];
    expect(second.req).toMatchObject({ src: `${S1}/p?u=m2`, startAt: 77.5 });
    expect(t.calls.filter((c) => c.method === 'POST' && c.url === `${S1}/refresh`)).toHaveLength(1);

    first.req.handlers.onFatal('a late error from the replaced engine');
    second.req.handlers.onReady({ qualities: [], subtitles: [english] });
    expect(t.controller.getState()).toMatchObject({ stage: 'ready', refreshes: 1, subtitle: 'manifest-0', error: null });
    expect(second.setEmbeddedSubtitle).toHaveBeenLastCalledWith(0);
  });

  it('reads the session the refresh answer names, and reports positions to it', async () => {
    const S2 = '/api/stream/sessions/S2';
    const t = setup({
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson()),
      [`POST ${S1}/refresh`]: () => jsonResponse(streamSessionJson({ session_id: 'S2' })),
      [`GET ${S2}`]: () => jsonResponse(streamSessionJson({ session_id: 'S2', manifest_url: `${S2}/p?u=m1` })),
    });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    t.made[0].req.handlers.onAuthError(403);
    await vi.waitFor(() => expect(t.made).toHaveLength(2));
    expect(t.made[1].req.src).toBe(`${S2}/p?u=m1`);
    t.made[1].req.handlers.onReady({ qualities: [], subtitles: [] });
    t.media.currentTime = 30;
    t.fire('pause');
    await vi.waitFor(() => expect(t.posts(`${S2}/position`)).toEqual([{ position_s: 30, duration_s: null, ended: false }]));
  });

  it('continues from resume_s when the token is refused before anything played', async () => {
    const t = setup({
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson({ resume_s: 600 })),
      [`POST ${S1}/refresh`]: () => jsonResponse({}),
    });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onAuthError(410);
    await vi.waitFor(() => expect(t.made).toHaveLength(2));
    expect(t.made[1].req.startAt).toBe(600);
  });

  it('gives up when the refreshed stream is refused again before it plays', async () => {
    const t = setup({
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson()),
      [`POST ${S1}/refresh`]: () => jsonResponse({}),
    });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    t.made[0].req.handlers.onAuthError(403);
    await vi.waitFor(() => expect(t.made).toHaveLength(2));
    t.made[1].req.handlers.onAuthError(403);
    expect(t.controller.getState()).toMatchObject({ stage: 'error', error: 'stream_expired', refreshes: 1 });
    expect(t.calls.filter((c) => c.url === `${S1}/refresh`)).toHaveLength(1);
  });

  it(`stops after ${MAX_REFRESHES} refreshes`, async () => {
    const t = setup({
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson()),
      [`POST ${S1}/refresh`]: () => jsonResponse({}),
    });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    for (let i = 0; i < MAX_REFRESHES; i++) {
      t.made[i].req.handlers.onReady({ qualities: [], subtitles: [] });
      t.made[i].req.handlers.onAuthError(403);
      await vi.waitFor(() => expect(t.made).toHaveLength(i + 2));
    }
    t.made[MAX_REFRESHES].req.handlers.onReady({ qualities: [], subtitles: [] });
    t.made[MAX_REFRESHES].req.handlers.onAuthError(403);
    expect(t.controller.getState()).toMatchObject({ stage: 'error', error: 'stream_expired', refreshes: MAX_REFRESHES });
  });

  it("ends with the daemon's code when the refresh fails", async () => {
    const t = setup({
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson()),
      [`POST ${S1}/refresh`]: () => jsonResponse({ error: 'no_source', attempts: [] }, 502),
    });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    t.made[0].req.handlers.onAuthError(401);
    await vi.waitFor(() => expect(t.controller.getState()).toMatchObject({ stage: 'error', error: 'no_source' }));
    expect(t.made).toHaveLength(1);
  });

  it('shows an unknown session as an error and starts nothing', async () => {
    const t = setup({ [`GET ${S1}`]: () => jsonResponse({ error: 'unknown_session' }, 403) });
    await t.controller.start();
    expect(t.controller.getState()).toMatchObject({ stage: 'error', error: 'unknown_session' });
    expect(t.made).toHaveLength(0);
  });

  it('a 403 notesd sent (no X-Notesd-Upstream) ends the play as session_over, with no refresh and no loop', async () => {
    const t = setup({
      [`GET ${S1}`]: () => jsonResponse(streamSessionJson()),
      [`POST ${S1}/refresh`]: () => jsonResponse(streamSessionJson()),
    });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    t.made[0].req.handlers.onSessionOver(403);
    t.made[0].req.handlers.onSessionOver(403);
    expect(t.controller.getState()).toMatchObject({ stage: 'error', error: 'session_over', refreshes: 0, errors: ['session_over'] });
    expect(t.calls.filter((c) => c.url === `${S1}/refresh`)).toHaveLength(0);
    expect(t.made).toHaveLength(1);
  });
});

describe('StreamController: sound (D2) and the muted check', () => {
  it('playWithSound waits for the stream, unmutes and plays (phase 1\'s start() after a full-screen open)', async () => {
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson()) });
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.media.muted = true;
    const started = t.controller.playWithSound();
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    expect(await started).toBe(true);
    expect(t.media.muted).toBe(false);
    expect(t.play).toHaveBeenCalled();
  });

  it('?muted=1 is muted before any play, never unmuted, and start() does nothing', async () => {
    const t = setup({ [`GET ${S1}`]: () => jsonResponse(streamSessionJson()) }, { muted: true });
    expect(t.media.muted).toBe(true);
    void t.controller.start();
    await vi.waitFor(() => expect(t.made).toHaveLength(1));
    t.made[0].req.handlers.onReady({ qualities: [], subtitles: [] });
    await vi.waitFor(() => expect(t.play).toHaveBeenCalled());
    expect(await t.controller.playWithSound()).toBe(false);
    expect(t.media.muted).toBe(true);
    expect(t.controller.getState().muted).toBe(true);
  });
});
```
**Check:** `npx vitest run web/src/stream/controller.test.tsx` passes.

### Step 8: The page: video, icon-only controls, menus, keys
**File:** `web/src/stream/StreamApp.tsx` (new)
**Change:** React over the controller. Controls are Phosphor duotone icons with `aria-label` and
`title`, no text buttons (menu rows are choices, not buttons with words). Controls and cursor hide
after 2.5 s without the mouse while playing. `window.notesdStream` mirrors the state for phase 6.
**Code:**
```tsx
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import {
  ArrowArcLeft,
  ArrowArcRight,
  ArrowsIn,
  ArrowsOut,
  CircleNotch,
  ClosedCaptioning,
  GearSix,
  IconContext,
  Pause,
  Play,
  SpeakerHigh,
  SpeakerSlash,
  WarningCircle,
} from '@phosphor-icons/react';
import { INITIAL_STATE, StreamController, type ControllerDeps, type StreamState } from './controller';
import { createEngine } from './createEngine';
import type { Quality } from './engine';
import { pickDefaultSubtitle } from './subtitles';

/**
 * window.notesdStream: the player's state for scripts (phase 6's playcheck reads `kind`, `levels`,
 * `level`, `errors`, `refreshes` beside the <video>), and `start()`, which phase 1's
 * `open --fullscreen` evaluates as a user gesture so the film starts with sound.
 */
export interface NotesdStream extends StreamState {
  /** The heights offered, highest first. */
  levels: number[];
  /** The chosen quality's engine index; -1 for auto. */
  level: number;
  /** Unmute and play once ready; false (and nothing done) under ?muted=1. */
  start: () => Promise<boolean>;
}

export function notesdStreamOf(state: StreamState, start: () => Promise<boolean>): NotesdStream {
  return {
    ...state,
    levels: state.qualities.flatMap((q) => (q.height === null ? [] : [q.height])),
    level: state.quality,
    start,
  };
}

declare global {
  interface Window {
    notesdStream?: NotesdStream;
  }
}

const ICONS = { weight: 'duotone' as const, size: '1em', color: 'currentColor', mirrored: false };
export const IDLE_MS = 2_500;
const SEEK_STEP_S = 10;

const ERRORS: Record<string, string> = {
  no_session: 'There is no stream in this address.',
  unknown_session: 'This stream has ended. Start it again from Claude Code or the movies page.',
  direct_stream_off: 'Direct streaming is off on this machine.',
  no_source: 'No provider could play this title any more.',
  stream_expired: 'The stream host keeps refusing this stream.',
  session_over: 'This stream session has ended (the daemon no longer knows it). Start it again from Claude Code or the movies page.',
  bad_session: 'The daemon sent a stream this page cannot read.',
};

export function formatClock(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function qualityLabel(q: Quality): string {
  if (q.height !== null) return `${q.height}p`;
  if (q.bitrate !== null) return `${Math.round(q.bitrate / 1000)} kbps`;
  return `Level ${q.index + 1}`;
}

function browserDeps(): ControllerDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    createEngine,
    textUrl: (vtt) => URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' })),
    revokeTextUrl: (url) => URL.revokeObjectURL(url),
  };
}

const NO_SUBSCRIBE = () => () => {};
const initialSnapshot = () => INITIAL_STATE;

function useController(
  sessionId: string | null,
  video: HTMLVideoElement | null,
  deps: Partial<ControllerDeps> | undefined,
  muted: boolean,
): StreamController | null {
  const depsRef = useRef(deps);
  const [controller, setController] = useState<StreamController | null>(null);
  useEffect(() => {
    if (sessionId === null || video === null) return;
    const next = new StreamController(sessionId, video, { ...browserDeps(), ...depsRef.current, muted });
    setController(next);
    void next.start();
    return () => {
      next.dispose();
    };
  }, [sessionId, video, muted]);
  return controller;
}

interface MediaView {
  paused: boolean;
  time: number;
  duration: number;
  muted: boolean;
}

const MEDIA_EVENTS = ['play', 'pause', 'timeupdate', 'seeking', 'durationchange', 'loadedmetadata', 'volumechange'] as const;

function useMediaView(video: HTMLVideoElement | null): MediaView {
  const [view, setView] = useState<MediaView>({ paused: true, time: 0, duration: 0, muted: false });
  useEffect(() => {
    if (video === null) return;
    const read = () =>
      setView({
        paused: video.paused,
        time: video.currentTime,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        muted: video.muted,
      });
    for (const type of MEDIA_EVENTS) video.addEventListener(type, read);
    read();
    return () => {
      for (const type of MEDIA_EVENTS) video.removeEventListener(type, read);
    };
  }, [video]);
  return view;
}

function useFullscreen(): boolean {
  const [on, setOn] = useState(() => !!document.fullscreenElement);
  useEffect(() => {
    const read = () => setOn(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', read);
    return () => document.removeEventListener('fullscreenchange', read);
  }, []);
  return on;
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  else void document.documentElement.requestFullscreen?.().catch(() => {});
}

function IconButton({
  label,
  onClick,
  expanded,
  children,
}: {
  label: string;
  onClick: () => void;
  expanded?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="st-btn"
      aria-label={label}
      title={label}
      aria-haspopup={expanded === undefined ? undefined : 'menu'}
      aria-expanded={expanded}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

interface MenuItem {
  key: string;
  text: string;
  checked: boolean;
  onSelect: () => void;
}

function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  return (
    <div className="st-menu" role="menu" aria-label={label}>
      {items.map((item) => (
        <button key={item.key} type="button" role="menuitemradio" aria-checked={item.checked} onClick={item.onSelect}>
          {item.text}
        </button>
      ))}
    </div>
  );
}

function StageOverlay({ state }: { state: StreamState }) {
  if (state.stage === 'loading' || state.stage === 'refreshing') {
    return (
      <div className="st-center" role="status" aria-label={state.stage === 'refreshing' ? 'Reconnecting' : 'Loading'}>
        <CircleNotch className="st-spin" />
      </div>
    );
  }
  if (state.stage === 'error') {
    const code = state.error ?? 'unknown';
    return (
      <div className="st-center st-error" role="alert">
        <WarningCircle />
        <span>{ERRORS[code] ?? `Playback stopped (${code}).`}</span>
      </div>
    );
  }
  return null;
}

type MenuName = 'subtitles' | 'quality';

export function StreamApp({ sessionId, muted = false, deps }: { sessionId: string | null; muted?: boolean; deps?: Partial<ControllerDeps> }) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const controller = useController(sessionId, video, deps, muted);
  const live = useSyncExternalStore(controller?.subscribe ?? NO_SUBSCRIBE, controller?.getState ?? initialSnapshot);
  const state: StreamState = sessionId === null ? { ...INITIAL_STATE, stage: 'error', error: 'no_session' } : live;
  const view = useMediaView(video);
  const fullscreen = useFullscreen();
  const [menu, setMenu] = useState<MenuName | null>(null);
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const wake = useCallback(() => {
    setIdle(false);
    if (idleTimer.current !== null) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setIdle(true), IDLE_MS);
  }, []);
  useEffect(() => {
    wake();
    return () => {
      if (idleTimer.current !== null) clearTimeout(idleTimer.current);
    };
  }, [wake]);

  useEffect(() => {
    // Never empty, never the address or host: cdp.ps1 (phase 1's `open`) only takes a tab whose
    // title differs from both.
    document.title = state.title.trim() === '' ? 'Stream' : state.title;
  }, [state.title]);
  useEffect(() => {
    window.notesdStream = notesdStreamOf(state, () => controller?.playWithSound() ?? Promise.resolve(false));
  }, [state, controller]);

  const togglePlay = useCallback(() => {
    if (video === null) return;
    if (video.paused) void Promise.resolve(video.play()).catch(() => {});
    else video.pause();
  }, [video]);
  const seekBy = useCallback(
    (delta: number) => {
      if (video === null) return;
      const end = Number.isFinite(video.duration) ? video.duration : Number.POSITIVE_INFINITY;
      video.currentTime = Math.min(Math.max(0, video.currentTime + delta), end);
    },
    [video],
  );
  const toggleMute = useCallback(() => {
    // ?muted=1 is never unmuted (phase 6's checks).
    if (video !== null && !muted) video.muted = !video.muted;
  }, [video, muted]);
  const fullscreenToggle = useCallback(() => {
    // ?muted=1 never asks for full screen.
    if (!muted) toggleFullscreen();
  }, [muted]);
  const toggleSubtitles = useCallback(() => {
    if (controller === null) return;
    const s = controller.getState();
    controller.selectSubtitle(s.subtitle !== null ? null : (pickDefaultSubtitle(s.subtitles) ?? s.subtitles[0]?.id ?? null));
  }, [controller]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (key === ' ' || key === 'k') togglePlay();
      else if (key === 'arrowleft') seekBy(-SEEK_STEP_S);
      else if (key === 'arrowright') seekBy(SEEK_STEP_S);
      else if (key === 'm') toggleMute();
      else if (key === 'c') toggleSubtitles();
      else if (key === 'f') fullscreenToggle();
      else if (key === 'escape') setMenu(null);
      else return;
      e.preventDefault();
      wake();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, seekBy, toggleMute, toggleSubtitles, fullscreenToggle, wake]);

  const choose = (action: () => void) => {
    action();
    setMenu(null);
  };
  const hidden = idle && !view.paused && menu === null && state.stage === 'ready';
  const fill = view.duration > 0 ? (Math.min(view.time, view.duration) / view.duration) * 100 : 0;

  return (
    <IconContext.Provider value={ICONS}>
      <div className={hidden ? 'st-stage st-idle' : 'st-stage'} data-stage={state.stage} onMouseMove={wake}>
        <video ref={setVideo} className="st-video" playsInline muted={muted} onClick={togglePlay} onDoubleClick={fullscreenToggle} />
        <div className="st-top">
          <span className="st-title">{state.title}</span>
        </div>
        <StageOverlay state={state} />
        <div className="st-bar">
          <IconButton label={view.paused ? 'Play' : 'Pause'} onClick={togglePlay}>
            {view.paused ? <Play /> : <Pause />}
          </IconButton>
          <IconButton label="Back 10 seconds" onClick={() => seekBy(-SEEK_STEP_S)}>
            <ArrowArcLeft />
          </IconButton>
          <IconButton label="Forward 10 seconds" onClick={() => seekBy(SEEK_STEP_S)}>
            <ArrowArcRight />
          </IconButton>
          <input
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
            style={{ ['--st-fill' as string]: `${fill}%` } as CSSProperties}
          />
          <span className="st-clock">
            {formatClock(view.time)} / {formatClock(view.duration)}
          </span>
          <IconButton label={view.muted ? 'Unmute' : 'Mute'} onClick={toggleMute}>
            {view.muted ? <SpeakerSlash /> : <SpeakerHigh />}
          </IconButton>
          <div className="st-pop">
            <IconButton label="Subtitles" expanded={menu === 'subtitles'} onClick={() => setMenu(menu === 'subtitles' ? null : 'subtitles')}>
              <ClosedCaptioning weight={state.subtitle !== null ? 'fill' : 'duotone'} />
            </IconButton>
            {menu === 'subtitles' && (
              <Menu
                label="Subtitles"
                items={[
                  { key: 'off', text: 'Off', checked: state.subtitle === null, onSelect: () => choose(() => controller?.selectSubtitle(null)) },
                  ...state.subtitles.map((o) => ({
                    key: o.id,
                    text: o.label,
                    checked: o.id === state.subtitle,
                    onSelect: () => choose(() => controller?.selectSubtitle(o.id)),
                  })),
                ]}
              />
            )}
          </div>
          <div className="st-pop">
            <IconButton label="Quality" expanded={menu === 'quality'} onClick={() => setMenu(menu === 'quality' ? null : 'quality')}>
              <GearSix />
            </IconButton>
            {menu === 'quality' && (
              <Menu
                label="Quality"
                items={[
                  { key: 'auto', text: 'Auto', checked: state.quality === -1, onSelect: () => choose(() => controller?.selectQuality(-1)) },
                  ...state.qualities.map((q) => ({
                    key: String(q.index),
                    text: qualityLabel(q),
                    checked: q.index === state.quality,
                    onSelect: () => choose(() => controller?.selectQuality(q.index)),
                  })),
                ]}
              />
            )}
          </div>
          <IconButton label={fullscreen ? 'Exit full screen' : 'Full screen'} onClick={fullscreenToggle}>
            {fullscreen ? <ArrowsIn /> : <ArrowsOut />}
          </IconButton>
        </div>
      </div>
    </IconContext.Provider>
  );
}
```

**File:** `web/src/stream/stream.css` (new)
**Change:** The app's own palette (`#121211`, `#ecebe4`, amber `#e8b04a` from `web/src/styles.css`),
Geist Mono for the chrome, square buttons, no shadows or soft cards.
**Code:**
```css
.st-stage {
  position: fixed;
  inset: 0;
  background: #000;
  color: #ecebe4;
  font-family: 'Geist Mono', monospace;
  user-select: none;
  overflow: hidden;
}
.st-stage.st-idle {
  cursor: none;
}
.st-video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}
.st-video::cue {
  font-family: 'Host Grotesk Variable', 'Host Grotesk', sans-serif;
  font-size: 2.6vh;
  color: #f4f3ec;
  background: rgba(0, 0, 0, 0.55);
}
.st-top,
.st-bar {
  position: absolute;
  left: 0;
  right: 0;
  transition: opacity 0.25s ease;
}
.st-idle .st-top,
.st-idle .st-bar {
  opacity: 0;
  pointer-events: none;
}
.st-top {
  top: 0;
  padding: 18px 24px 36px;
  background: linear-gradient(rgba(0, 0, 0, 0.65), rgba(0, 0, 0, 0));
  font-size: 13px;
  letter-spacing: 0.04em;
  color: #bdbcb4;
}
.st-bar {
  bottom: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 36px 20px 16px;
  background: linear-gradient(rgba(0, 0, 0, 0), rgba(0, 0, 0, 0.8));
}
.st-btn {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  padding: 0;
  border: 0;
  border-radius: 2px;
  background: transparent;
  color: inherit;
  font-size: 22px;
  cursor: pointer;
}
.st-btn:hover,
.st-btn[aria-expanded='true'] {
  background: rgba(236, 235, 228, 0.12);
}
.st-btn:focus-visible {
  outline: 1px solid rgba(236, 235, 228, 0.85);
  outline-offset: 1px;
}
.st-seek {
  flex: 1;
  height: 20px;
  margin: 0 10px;
  appearance: none;
  background: transparent;
  cursor: pointer;
}
.st-seek::-webkit-slider-runnable-track {
  height: 3px;
  background: linear-gradient(to right, #ecebe4 var(--st-fill, 0%), rgba(236, 235, 228, 0.25) var(--st-fill, 0%));
}
.st-seek::-webkit-slider-thumb {
  appearance: none;
  width: 11px;
  height: 11px;
  margin-top: -4px;
  border-radius: 0;
  background: #ecebe4;
}
.st-clock {
  min-width: 128px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: right;
  color: #c9c8c0;
}
.st-pop {
  position: relative;
}
.st-menu {
  position: absolute;
  right: 0;
  bottom: 48px;
  display: flex;
  flex-direction: column;
  min-width: 168px;
  padding: 6px 0;
  background: #121211;
  border: 1px solid rgba(236, 235, 228, 0.14);
}
.st-menu button {
  all: unset;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 14px;
  font-size: 12px;
  letter-spacing: 0.03em;
  color: #a9a89f;
  cursor: pointer;
}
.st-menu button::before {
  content: '';
  width: 6px;
  height: 6px;
}
.st-menu button:hover {
  background: rgba(236, 235, 228, 0.08);
  color: #ecebe4;
}
.st-menu button[aria-checked='true'] {
  color: #ecebe4;
}
.st-menu button[aria-checked='true']::before {
  background: #e8b04a;
}
.st-center {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 14px;
  font-size: 40px;
  pointer-events: none;
}
.st-error {
  font-size: 36px;
  color: #c0473a;
}
.st-error span {
  max-width: 46ch;
  font-size: 13px;
  text-align: center;
  color: #c9c8c0;
}
.st-spin {
  animation: st-spin 0.9s linear infinite;
}
@keyframes st-spin {
  to {
    transform: rotate(360deg);
  }
}
```

**File:** `web/src/stream/main.tsx` (new)
**Code:**
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/host-grotesk';
import '@fontsource/geist-mono/400.css';
import './stream.css';
import { StreamApp } from './StreamApp';
import { mutedFromLocation, sessionIdFromLocation } from './session';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <StreamApp sessionId={sessionIdFromLocation(window.location)} muted={mutedFromLocation(window.location)} />
    </StrictMode>,
  );
}
```

**File:** `web/stream.html` (new)
**Code:**
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32" />
    <title>Stream</title>
    <style>
      html,
      body {
        margin: 0;
        height: 100%;
        background: #000;
        overflow: hidden;
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/stream/main.tsx"></script>
  </body>
</html>
```

**File:** `web/src/stream/StreamApp.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StreamApp, formatClock } from './StreamApp';
import { fakeEngines, jsonResponse, routeFetch, streamSessionJson } from '../testing/streamFakes';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(ui: ReactNode): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(ui));
  return host;
}

async function settle() {
  for (let i = 0; i < 10; i++) await act(async () => {});
}

function click(el: Element | null) {
  if (el === null) throw new Error('nothing to click');
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const button = (el: Element, label: string) => el.querySelector(`button[aria-label="${label}"]`);
const radios = (el: Element) =>
  [...el.querySelectorAll('[role="menuitemradio"]')].map((r) => [r.textContent, r.getAttribute('aria-checked')]);
const radio = (el: Element, text: string) =>
  [...el.querySelectorAll('[role="menuitemradio"]')].find((r) => r.textContent === text) ?? null;

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
  delete window.notesdStream;
});

describe('StreamApp', () => {
  it('shows the title, a quality menu highest first and English checked; a choice reaches the engine', async () => {
    const { made, createEngine } = fakeEngines();
    const { fetchImpl } = routeFetch({ 'GET /api/stream/sessions/S1': () => jsonResponse(streamSessionJson()) });
    const el = render(<StreamApp sessionId="S1" deps={{ fetch: fetchImpl, createEngine, textUrl: () => 'blob:x', revokeTextUrl: () => {} }} />);
    await settle();
    expect(made).toHaveLength(1);
    act(() =>
      made[0].req.handlers.onReady({
        qualities: [
          { index: 0, height: 720, bitrate: null },
          { index: 1, height: 1080, bitrate: null },
        ],
        subtitles: [{ index: 0, label: 'English', lang: 'en' }],
      }),
    );
    await settle();

    expect(document.title).toBe('Fight Club (1999)');
    expect(el.querySelector('.st-title')?.textContent).toBe('Fight Club (1999)');
    expect(window.notesdStream?.stage).toBe('ready');
    expect(el.querySelectorAll('.st-bar button[aria-label]').length).toBeGreaterThanOrEqual(7);
    for (const b of el.querySelectorAll('.st-bar > button, .st-bar > .st-pop > button')) {
      expect(b.textContent).toBe('');
      expect(b.querySelector('svg')).not.toBeNull();
    }

    click(button(el, 'Quality'));
    expect(radios(el)).toEqual([
      ['Auto', 'true'],
      ['1080p', 'false'],
      ['720p', 'false'],
    ]);
    click(radio(el, '720p'));
    expect(made[0].setQuality).toHaveBeenLastCalledWith(0);
    expect(el.querySelector('[role="menu"]')).toBeNull();

    click(button(el, 'Subtitles'));
    expect(radios(el)).toEqual([
      ['Off', 'false'],
      ['English', 'true'],
    ]);
    click(radio(el, 'Off'));
    expect(made[0].setEmbeddedSubtitle).toHaveBeenLastCalledWith(null);
    expect(window.notesdStream?.subtitle).toBeNull();
  });

  it('publishes what phase 6 reads and start() on window.notesdStream, with a title that is not the address', async () => {
    const { made, createEngine } = fakeEngines();
    const { fetchImpl } = routeFetch({ 'GET /api/stream/sessions/S1': () => jsonResponse(streamSessionJson()) });
    render(<StreamApp sessionId="S1" deps={{ fetch: fetchImpl, createEngine, textUrl: () => 'blob:x', revokeTextUrl: () => {} }} />);
    await settle();
    act(() => made[0].req.handlers.onReady({ qualities: [{ index: 0, height: 720, bitrate: null }, { index: 1, height: 1080, bitrate: null }], subtitles: [] }));
    await settle();
    expect(window.notesdStream).toMatchObject({ kind: 'hls', levels: [1080, 720], level: -1, errors: [], refreshes: 0, muted: false });
    expect(typeof window.notesdStream?.start).toBe('function');
    expect(document.title).not.toBe('');
    expect(document.title).not.toBe(location.href);
    expect(document.title).not.toBe(location.host);
  });

  it('under ?muted=1 the mute and full-screen controls do nothing and start() resolves false', async () => {
    const { made, createEngine } = fakeEngines();
    const { fetchImpl } = routeFetch({ 'GET /api/stream/sessions/S1': () => jsonResponse(streamSessionJson()) });
    const fullscreen = vi.fn(async () => {});
    document.documentElement.requestFullscreen = fullscreen;
    const el = render(<StreamApp sessionId="S1" muted deps={{ fetch: fetchImpl, createEngine, textUrl: () => 'blob:x', revokeTextUrl: () => {} }} />);
    await settle();
    act(() => made[0].req.handlers.onReady({ qualities: [], subtitles: [] }));
    await settle();
    const video = el.querySelector('video')!;
    expect(video.muted).toBe(true);
    click(button(el, 'Unmute') ?? button(el, 'Mute'));
    click(button(el, 'Full screen'));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f' }));
    });
    expect(video.muted).toBe(true);
    expect(fullscreen).not.toHaveBeenCalled();
    expect(await window.notesdStream?.start()).toBe(false);
  });

  it('says why when the session is unknown', async () => {
    const { made, createEngine } = fakeEngines();
    const { fetchImpl } = routeFetch({ 'GET /api/stream/sessions/S1': () => jsonResponse({ error: 'unknown_session' }, 403) });
    const el = render(<StreamApp sessionId="S1" deps={{ fetch: fetchImpl, createEngine }} />);
    await settle();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('This stream has ended');
    expect(made).toHaveLength(0);
  });

  it('says so when the address has no session', () => {
    const el = render(<StreamApp sessionId={null} />);
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('no stream in this address');
  });
});

describe('formatClock', () => {
  it.each([
    [0, '0:00'],
    [9.9, '0:09'],
    [75, '1:15'],
    [3725, '1:02:05'],
    [Number.NaN, '0:00'],
  ])('%s -> %s', (s, text) => {
    expect(formatClock(s)).toBe(text);
  });
});
```
**Check:** `npx vitest run web/src/stream` passes; `npm run typecheck` passes.

### Step 9: Build the page and serve it at `/stream/<sessionId>`
**File:** `web/vite.config.ts:20` (inside `rolldownOptions.input`, after `fullscreen`)
**Code:** the `input` object becomes
```ts
      input: {
        index: resolve(root, 'index.html'),
        fullscreen: resolve(root, 'fullscreen.html'),
        stream: resolve(root, 'stream.html'),
      },
```

**File:** `src/http/static.ts:105` (after the `/full/` branch, before `if (pathname !== '/')`)
**Code:** insert
```ts
    if (/^\/stream\/[^/]+\/?$/.test(pathname)) {
      const stream = await readInside(root, 'stream.html');
      return sendHtml(c, stream ?? index);
    }
```
so the handler reads, in order: reserved prefixes, `index.html` presence, `/assets/`, `/full/<id>`,
`/stream/<id>`, other root files, the `index.html` fallback. `/stream` is not under `/api`, `/mcp`
or `/health`, so nothing else answers it.

**File:** `tests/unit/static.test.ts:73` (after the `/full/:id` test)
**Code:** insert
```ts
  it('serves index.html for /stream/:id until stream.html exists, then stream.html', async () => {
    const app = appFor(dist);
    expect(await (await app.request('/stream/k3R9xQ2m')).text()).toContain('<title>index</title>');
    await writeFile(path.join(dist, 'stream.html'), '<!doctype html><title>Stream</title>');
    try {
      for (const url of ['/stream/k3R9xQ2m', '/stream/k3R9xQ2m/']) {
        const res = await app.request(url);
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-cache');
        expect(await res.text()).toContain('<title>Stream</title>');
      }
      expect(await (await app.request('/stream/a/b')).text()).toContain('<title>index</title>');
    } finally {
      await rm(path.join(dist, 'stream.html'));
    }
  });
```
**Impact:** a new static address; no API change.
**Check:** `npx vitest run tests/unit/static.test.ts` passes; `npm run build` then
`test -f web/dist/stream.html && grep -q 'src="/assets/stream-' web/dist/stream.html`.

### Step 10: The proof harness (a lever the verifier and phase 6 rerun)
**File:** `.claude/skills/verify-notesd/scripts/stream/make-hls-fixture.sh` (new, `chmod +x`)
**Change:** A 120 s HLS film with two renditions, a French (DEFAULT=YES) and an English WebVTT
track inside the manifest, and a separate English `.srt`. Every address is already in the
pass-through's form (`/api/stream/sessions/S1/p?u=<path>`), as phase 3's rewriting leaves them.
Cached: a second run only prints the folder.
**Code:**
```bash
#!/usr/bin/env bash
# Builds the HLS film the stream player journeys play (player.steps.mjs): 120 s, 720p and 360p,
# a French (DEFAULT=YES) and an English WebVTT track inside the manifest, and a separate English
# .srt. Every address is already in the pass-through's form, /api/stream/sessions/S1/p?u=<path>.
# Usage: make-hls-fixture.sh OUT_DIR   (prints OUT_DIR; a finished OUT_DIR is reused)
set -euo pipefail
out=${1:?usage: make-hls-fixture.sh OUT_DIR}
if [ -f "$out/.done" ]; then
  echo "$out"
  exit 0
fi
command -v ffmpeg >/dev/null || { echo "make-hls-fixture: ffmpeg not found" >&2; exit 1; }
mkdir -p "$out/v720" "$out/v360" "$out/subs"
P='/api/stream/sessions/S1/p?u='

for r in 720 360; do
  w=$((r * 16 / 9))
  ffmpeg -loglevel error -y \
    -f lavfi -i "testsrc2=size=${w}x${r}:rate=25" \
    -f lavfi -i "sine=frequency=440:sample_rate=48000" \
    -t 120 -c:v libx264 -preset veryfast -pix_fmt yuv420p -g 50 -keyint_min 50 -sc_threshold 0 \
    -c:a aac -b:a 64k \
    -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_filename "$out/v$r/seg%03d.ts" "$out/v$r/index.m3u8"
  sed -i -E "s#^(seg[0-9]+\.ts)\$#${P}v$r/\1#" "$out/v$r/index.m3u8"
done

printf 'WEBVTT\n\n00:00:00.000 --> 00:02:00.000\nHello from the English track\n' >"$out/subs/en.vtt"
printf 'WEBVTT\n\n00:00:00.000 --> 00:02:00.000\nBonjour de la piste francaise\n' >"$out/subs/fr.vtt"
for lang in en fr; do
  printf '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:120\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:120.0,\n%ssubs/%s.vtt\n#EXT-X-ENDLIST\n' \
    "$P" "$lang" >"$out/subs/$lang.m3u8"
done
printf '1\r\n00:00:00,000 --> 00:02:00,000\r\nHello from the SRT file\r\n' >"$out/subs/en.srt"

cat >"$out/master.m3u8" <<EOF
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Francais",LANGUAGE="fr",DEFAULT=YES,AUTOSELECT=YES,URI="${P}subs/fr.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="${P}subs/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",SUBTITLES="subs"
${P}v720/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",SUBTITLES="subs"
${P}v360/index.m3u8
EOF
touch "$out/.done"
echo "$out"
```

**File:** `.claude/skills/verify-notesd/scripts/stream/player.steps.mjs` (new)
**Change:** One Playwright drive of the real built page in the throwaway daemon. The daemon's
`/api/stream/sessions/*` is answered by a fake in the shape of this phase's interface contract
(so the drive needs no Windows Chrome and no provider), serving the fixture; `position` answers
404 on purpose. It logs one `J<k> PASS` line per journey and throws on the first failed check.
**Code:**
```js
// The stream player page (/stream/<id>) in a throwaway daemon's real build (verify.sh up --web).
// The daemon's /api/stream/sessions/* routes are answered here by a fake that serves the HLS
// fixture from make-hls-fixture.sh, in the shape phase 3 gives the page; /position answers 404 on
// purpose. Nothing leaves this machine and no Chrome on Windows is touched.
//   STREAM_FIXTURE=<folder make-hls-fixture.sh printed> verify.sh ui RUN <this file>
// Logs "J1 PASS", "API PASS", "J3 PASS", "J2 PASS", "MUTED PASS", "CDN PASS"; the first failed check throws and fails the run.
import { readFileSync } from 'node:fs'
import path from 'node:path'

const FIX = process.env.STREAM_FIXTURE
const TYPES = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.vtt': 'text/vtt', '.srt': 'application/x-subrip' }
// J3's "token expired" answers only segments from 90 s on, so loads ahead of the seek are not refused.
const EXPIRES_FROM_SEGMENT = 45

function check(ok, what) {
  if (!ok) throw new Error(what)
}

// Phase 3's SessionInfo shape (session_id; subtitle tracks carry source and english).
function sessionJson(id, fake) {
  const common = { session_id: id, kind: 'movie', tmdb_id: 1, season: null, episode: null, provider: 'Fixture', best_height: 720, created_at: null, refreshed_at: null, expires_at: null }
  if (id === 'S1') {
    return {
      ...common,
      title: 'Fixture Film (2026)',
      manifest_url: `/api/stream/sessions/S1/p?u=master.m3u8&t=${fake.token}`,
      manifest_kind: 'hls',
      subtitles: [],
      resume_s: 20,
    }
  }
  return {
    ...common,
    title: 'Fixture SRT (2026)',
    manifest_url: '/api/stream/sessions/S2/p?u=v720/index.m3u8',
    manifest_kind: 'hls',
    subtitles: [{ url: '/api/stream/sessions/S2/p?u=subs/en.srt', lang: 'en', label: 'English', format: 'srt', source: 'request', english: true }],
    resume_s: 0,
  }
}

async function until(page, cond, ms, what) {
  for (let waited = 0; waited < ms; waited += 250) {
    if (cond()) return
    await page.waitForTimeout(250)
  }
  check(cond(), what)
}

async function wakeControls(page) {
  await page.mouse.move(600, 400)
  await page.mouse.move(620, 420)
}

const englishCueShowing = (needle) => {
  const v = document.querySelector('video')
  return !!v && [...v.textTracks].some((t) => t.mode === 'showing' && [...(t.activeCues ?? [])].some((c) => c.text.includes(needle)))
}

export default async ({ page, base, shot, log }) => {
  check(FIX, 'set STREAM_FIXTURE to the folder make-hls-fixture.sh printed')
  const origin = new URL(base).origin
  const foreign = []
  page.on('request', (r) => {
    const u = r.url()
    if (!u.startsWith(origin) && !u.startsWith('blob:') && !u.startsWith('data:')) foreign.push(u)
  })
  const fake = { expired: false, refreshes: 0, token: 1, posts: [] }
  await page.route('**/api/stream/sessions/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    const m = /^\/api\/stream\/sessions\/(S1|S2)(?:\/(p|position|refresh))?$/.exec(url.pathname)
    if (!m) return json(403, { error: 'unknown_session' })
    const [, id, tail] = m
    if (tail === 'p') {
      // Like phase 3's pass-through: every forwarded answer carries X-Notesd-Upstream with the host's status.
      const u = url.searchParams.get('u') ?? ''
      const seg = /seg(\d+)\.ts$/.exec(u)
      if (fake.expired && seg && Number(seg[1]) >= EXPIRES_FROM_SEGMENT) {
        return route.fulfill({ status: 403, headers: { 'x-notesd-upstream': '403' }, body: 'token expired' })
      }
      const file = path.join(FIX, u)
      return route.fulfill({ status: 200, headers: { 'x-notesd-upstream': '200' }, contentType: TYPES[path.extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
    }
    if (tail === 'position') {
      fake.posts.push({ id, ...req.postDataJSON() })
      return json(404, { error: 'not_found' })
    }
    if (tail === 'refresh') {
      fake.refreshes += 1
      fake.expired = false
      fake.token += 1
      return json(200, sessionJson(id, fake))
    }
    return json(200, sessionJson(id, fake))
  })

  // J1 (R2.3): English shown over the manifest's French default, a quality choice, start at resume_s.
  await page.goto(`${base}/stream/S1`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 30_000 })
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !!v && !v.paused && v.currentTime > 21
  }, null, { timeout: 30_000 })
  await page.waitForFunction(englishCueShowing, 'English track', { timeout: 15_000 })
  const j1 = await page.evaluate(() => {
    const v = document.querySelector('video')
    return {
      title: document.title,
      showing: [...v.textTracks].filter((t) => t.mode === 'showing').map((t) => t.language),
      qualities: window.notesdStream.qualities.map((q) => q.height),
      subtitle: window.notesdStream.subtitle,
    }
  })
  log(`J1 state ${JSON.stringify(j1)}`)
  check(j1.title === 'Fixture Film (2026)', 'J1: the page title is the session title')
  check(JSON.stringify(j1.showing) === '["en"]', `J1: exactly one subtitle track showing, the English one (got ${JSON.stringify(j1.showing)})`)
  check(JSON.stringify(j1.qualities) === '[720,360]', `J1: 720p and 360p offered, highest first (got ${JSON.stringify(j1.qualities)})`)
  await wakeControls(page)
  await page.getByRole('button', { name: 'Quality', exact: true }).click()
  const items = (await page.getByRole('menuitemradio').allTextContents()).join('|')
  check(items === 'Auto|720p|360p', `J1: the quality menu lists Auto|720p|360p (got ${items})`)
  await page.getByRole('menuitemradio', { name: '360p', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('video')?.videoHeight === 360, null, { timeout: 20_000 })
  await shot('j1-english-360p')
  await until(page, () => fake.posts.some((p) => p.id === 'S1' && p.position_s >= 20 && p.ended === false), 8_000,
    'J1: positions were posted (each answered 404)')
  const stillPlaying = await page.evaluate(() => !document.querySelector('video').paused && window.notesdStream.stage === 'ready')
  check(stillPlaying, 'J1: a 404 from /position did not stop the film')
  log('J1 PASS English subtitle shown over a French default; quality menu Auto|720p|360p; switched to 360p; started at resume_s 20; 404 positions ignored')

  const exposed = await page.evaluate(() => ({ levels: window.notesdStream.levels, kind: window.notesdStream.kind, start: typeof window.notesdStream.start, title: document.title }))
  check(JSON.stringify(exposed.levels) === '[720,360]' && exposed.kind === 'hls' && exposed.start === 'function', `window.notesdStream has kind, levels and start() (got ${JSON.stringify(exposed)})`)
  check(exposed.title !== '' && exposed.title !== page.url() && exposed.title !== new URL(base).host, 'the page title is neither empty nor the address (phase 1 open needs it)')
  log('API PASS window.notesdStream exposes kind, levels, level, errors, refreshes and start(); the title is a real title')

  // J3 (R2.5): the stream host refuses the token mid-film; one refresh, playback continues there.
  fake.expired = true
  await page.evaluate(() => {
    document.querySelector('video').currentTime = 100
  })
  await page.waitForFunction(() => window.notesdStream?.refreshes === 1 && window.notesdStream.stage === 'ready', null, { timeout: 30_000 })
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return !v.paused && v.currentTime > 101
  }, null, { timeout: 30_000 })
  await page.waitForFunction(englishCueShowing, 'English track', { timeout: 15_000 })
  const j3 = await page.evaluate(() => ({ t: document.querySelector('video').currentTime, log: window.notesdStream.log }))
  log(`J3 state ${JSON.stringify(j3)}`)
  check(fake.refreshes === 1, `J3: exactly one POST .../refresh (got ${fake.refreshes})`)
  check(j3.t >= 100 && j3.t < 119, `J3: playing on from 100 s, not from 0 or resume_s (at ${j3.t})`)
  await shot('j3-after-refresh')
  log('J3 PASS a 403 on a segment at 100 s led to one refresh; playback continued from 100 s with the English subtitle')

  // J2 (R2.3): a separate English .srt is converted to WebVTT and shown by default.
  await page.goto(`${base}/stream/S2`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 30_000 })
  await page.waitForFunction(() => {
    const t = document.querySelector('video track')
    return !!t && t.track.mode === 'showing' && [...(t.track.activeCues ?? [])].some((c) => c.text.includes('SRT file'))
  }, null, { timeout: 20_000 })
  const j2 = await page.evaluate(() => {
    const t = document.querySelector('video track')
    return { srclang: t.srclang, isDefault: t.default, scheme: new URL(t.src).protocol, subtitle: window.notesdStream.subtitle }
  })
  log(`J2 state ${JSON.stringify(j2)}`)
  check(j2.srclang === 'en' && j2.isDefault && j2.scheme === 'blob:' && j2.subtitle === 'file-0',
    'J2: the English .srt is a WebVTT blob track, chosen and showing')
  await shot('j2-srt')
  log('J2 PASS a separate English .srt was converted to WebVTT and shown by default')

  // The muted check phase 6 relies on: ?muted=1 is muted before play, never unmuted, never full screen.
  await page.goto(`${base}/stream/S2?muted=1`)
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 30_000 })
  await page.keyboard.press('m')
  await page.keyboard.press('f')
  const mutedState = await page.evaluate(async () => ({
    muted: document.querySelector('video').muted,
    fullscreen: Boolean(document.fullscreenElement),
    started: await window.notesdStream.start(),
  }))
  check(mutedState.muted === true && mutedState.fullscreen === false && mutedState.started === false,
    `?muted=1 stays muted, never full screen, start() does nothing (got ${JSON.stringify(mutedState)})`)
  log('MUTED PASS ?muted=1 stayed muted and windowed; start() did nothing')

  check(foreign.length === 0, `no request left the daemon's origin: ${foreign.slice(0, 3).join(' ')}`)
  log('CDN PASS every request stayed on the daemon origin (hls.js bundled, no CDN)')
}
```
**Impact:** none on the product; two files under the verify skill.

### Step 11: Docs and the feature map
**File:** `docs/guide/streaming.md` — inside the "Direct streaming" section phase 3 creates, as
its own subsection after phase 3's text (the reconciler orders it among phases 1, 7, 8, 10's
subsections). If phase 3's section has a contents line, add `[The player](#the-player)` to it.
**Code:** append
```markdown
### The player

`/stream/<session id>` is the page a direct-stream play opens in the streaming Chrome. It is a
separate small bundle (`web/stream.html`, `web/src/stream/`), not part of the wall. The resolver's
`open --fullscreen` makes the window full screen; the page fills the window.

- **It plays what the session names.** The page reads `GET /api/stream/sessions/<id>` and plays its
  manifest through the pass-through: HLS with hls.js, DASH with dash.js, a plain file in the
  browser itself. Both libraries are npm packages built into the page, each fetched only when the
  manifest needs it. Nothing comes from a CDN.
- **English subtitles are on by default.** An English track inside the manifest comes first, then
  a separate English `.vtt` or `.srt` from the resolve (an `.srt` is converted to WebVTT in the
  page). With no English track, subtitles start off and the others can still be picked.
- **Quality** is Auto at first; the menu lists every rendition the manifest offers, highest first.
- **Position.** The film starts at the session's `resume_s`. The page reports
  `{ position_s, duration_s, ended }` to `POST /api/stream/sessions/<id>/position` every 5 seconds
  while playing, on pause and at the end; it ignores the answer, a 404 included.
- **An expired token.** When the stream host answers 401, 403 or 410 through the pass-through (the
  answer carries `X-Notesd-Upstream`), the page calls `POST /api/stream/sessions/<id>/refresh`,
  reads the session again and carries on from where it was. It does this at most three times for
  one page, and stops with a message when a refreshed stream is refused before it plays. A 403
  without that header is notesd's own (the session ended, or the daemon restarted): the page says
  the session has ended and does not refresh.
- **Sound.** A play from `/direct-stream` or the movies page opens the page full screen and then
  calls its `start()` the way a click would, so the film starts with sound. If the browser still
  will not start it with sound, the page starts it muted and the speaker icon shows it.
- **`?muted=1`** (the playback checks): muted from the start, never unmuted, never full screen.
- **Controls** are icons only and hide after 2.5 seconds without the mouse: play, back and forward
  10 seconds, position, mute, subtitles, quality, full screen. Keys: Space or K, the left and right
  arrows, M, C (subtitles on or off), F.

The page keeps its state on `window.notesdStream` (stage, `kind`, `levels`, `level`, subtitle
choice, `refreshes`, `errors`, the last position sent and a short log), for scripts that check a
play, and its `start()`.
```

**File:** `docs/guide/architecture.md:232` (after the `/full/<imageId>` row of the Pages table)
**Code:** insert the row
```markdown
| `/stream/<sessionId>` | The direct-streaming player, a separate small bundle (`web/stream.html`) with hls.js and dash.js built in. A play opens it in the streaming Chrome: see [The player](streaming.md#the-player). |
```

**File:** `.claude/skills/verify-notesd/features/direct-streaming.md` (phase 3 creates it)
**Change:** add the player to its sections (keep phase 3's headings; add under each).
**Code:** under `## Sub-features` add
```markdown
- The player page `/stream/<session id>`: plays HLS (hls.js), DASH (dash.js) or a plain file, the
  English subtitle shown by default (inside the manifest first, then a separate `.vtt`/`.srt`), a
  quality menu, start at `resume_s`, positions every 5 s and on pause/end, refresh-and-continue on
  401/403/410. Logic proven by `npx vitest run web/src/stream tests/unit/static.test.ts`.
```
under `## How to get to it (user POV)` add
```markdown
- The player: what `/direct-stream <title>` (and Play on the Stream side of `/movies`) opens, full
  screen, in the streaming Chrome.
```
under the driving section add
```markdown
- The player, without Windows Chrome or a provider: build the fixture once, then drive the real
  page in a throwaway daemon with the session routes faked by Playwright:
  `FIX=$(bash .claude/skills/verify-notesd/scripts/stream/make-hls-fixture.sh "$HOME/.local/state/notesd-verify/.stream-fixture")`,
  `$V up --web`, `STREAM_FIXTURE="$FIX" $V ui RUN .claude/skills/verify-notesd/scripts/stream/player.steps.mjs`.
  The transcript has `J1 PASS` (English over a French default, quality menu, resume), `API PASS`
  (`window.notesdStream` and the title), `J3 PASS` (403 with `X-Notesd-Upstream` mid-film, one
  refresh, continues at 100 s), `J2 PASS` (`.srt` as WebVTT), `MUTED PASS` (`?muted=1`) and `CDN PASS`.
- The player against a real provider is phase 6's `playcheck.mjs` (muted, normal window).
```
and under `## Gotchas` add
```markdown
- `up --web` is required: the player is a separate bundle (`web/dist/stream.html`); without a fresh
  build `/stream/<id>` serves the wall's `index.html`.
```
**Check:** `npm run docs:check` passes (the new links `streaming.md#the-player` resolve).

## Principles applied

- Boundary discipline: the session JSON is checked once, in `parseSession` (`session.ts`); engines hand the controller typed `Quality`/`EmbeddedSubtitle` values and numeric statuses, and the controller and UI never re-check them.
- Make illegal states unrepresentable: a subtitle option carries `source: 'manifest' | 'file'` and `index` instead of an id string to be parsed back, and the page's progress is one `Stage` union (`loading | ready | refreshing | error`) rather than separate booleans; stale engine callbacks are dropped by a generation counter rather than by flags.
- Test behavior, not implementation: the jsdom tests drive the controller and page only through the `PlayerEngine` seam (the boundary to hls.js/dash.js) and a routed `fetch`, and assert what the daemon receives (posts, refresh calls), what the engine is told, the `<track>` elements and the menus.
- Build the lever: the fixture generator and the Playwright journeys are checked into `verify-notesd/scripts/stream/`, so the verifier and phase 6 rerun the same proof instead of reading the diff.
- Laziness protocol: `static.ts` gets one more branch beside `/full/`, not a page table; subtitle files are loaded before the engine starts (one small fetch) instead of merging two asynchronous sources; position posts are fire-and-forget with no retry queue.
- Prove it works: the proof plays real H.264 HLS through real hls.js in the daemon's own build (Playwright's Chromium was checked to support `avc1`), not only the unit tests.

## Verification

**Build:** `cd /home/miftah/.worktrees/mcp-notes/direct-streaming && npm ci && npm run typecheck && npm run build && test -f web/dist/stream.html && grep -q 'src="/assets/stream-' web/dist/stream.html`
**Tests:** `npm test && npm run docs:check` (focused: `npx vitest run web/src/stream tests/unit/static.test.ts`)
**Proof:** the real built page, served by a throwaway daemon, plays a real HLS film through hls.js
in Playwright's Chromium, with the session routes faked in the contract's shape.
- Harness: `.claude/skills/verify-notesd` (`verify.sh up --web`, `verify.sh ui`), plus this phase's `scripts/stream/make-hls-fixture.sh` and `scripts/stream/player.steps.mjs`. Setup for J1–J3, from the worktree root:
  ```sh
  V=.claude/skills/verify-notesd/scripts/verify.sh
  FIX=$(bash .claude/skills/verify-notesd/scripts/stream/make-hls-fixture.sh "$HOME/.local/state/notesd-verify/.stream-fixture")
  eval "$($V up --web | grep -E '^(RUN|URL)=')"
  STREAM_FIXTURE="$FIX" $V ui "$RUN" .claude/skills/verify-notesd/scripts/stream/player.steps.mjs
  ```
  The transcript is `~/.local/state/notesd-verify/$RUN/evidence/NN-ui-player.txt`, with
  screenshots `*-j1-english-360p.png`, `*-j3-after-refresh.png`, `*-j2-srt.png` and a video.
  Finish with `$V down "$RUN"`.
- Feature-map entries: `features/direct-streaming.md` (the player part this phase adds)
- Journeys:
  - **J1** · traces R2.3 — the setup above, then `grep -E '^J1 PASS' ~/.local/state/notesd-verify/$RUN/evidence/*-ui-player.txt` → passes when the line is there: on `/stream/S1` the one showing text track is `en` with the cue "Hello from the English track" active although the manifest marks French `DEFAULT=YES`, `window.notesdStream.qualities` is `[720,360]`, the Quality menu reads `Auto|720p|360p`, choosing 360p makes `video.videoHeight` 360, playback started at or after `resume_s` 20, and the 404 answers to `/position` left the film playing
  - **J2** · traces R2.3 — same run, `grep -E '^J2 PASS' .../*-ui-player.txt` → passes when the line is there: on `/stream/S2` (no subtitle in the manifest, one English `.srt` in the session) the page's `<track>` has `srclang="en"`, `default`, a `blob:` src, mode `showing` and the active cue "Hello from the SRT file", and `window.notesdStream.subtitle` is `file-0`
  - **J3** · traces R2.5 — same run, `grep -E '^J3 PASS' .../*-ui-player.txt` → passes when the line is there: after the fake pass-through answers 403 with `X-Notesd-Upstream: 403` to segments from 90 s on and the film is moved to 100 s, the fake saw exactly one `POST /api/stream/sessions/S1/refresh`, `window.notesdStream.refreshes` is 1 with stage `ready`, the video plays on with `currentTime` between 100 and 119 (not 0, not `resume_s` 20), and the English cue is showing again
  - **J4** · traces R2.3, R2.5 — `npx vitest run web/src/stream` → passes when every test passes, including "starts at resume_s and shows the English track inside the manifest over a French one", "shows a separate English .srt, converted to WebVTT, ...", "offers the qualities and switches on a choice ...", the three "a 401/403/410 from the stream host refreshes the session and continues from the last position" cases, "gives up when the refreshed stream is refused again before it plays", "stops after 3 refreshes" and "a 403 notesd sent (no X-Notesd-Upstream) ends the play as session_over, with no refresh and no loop"
- Neighbor check: the full-screen photo page and the wall still serve from the same fallback: `npx vitest run tests/unit/static.test.ts web/src/fullscreen` passes, and in the same run `curl -s "$URL/full/A-B32" | grep -o '<title>[^<]*'` prints `<title>Image` while `curl -s "$URL/stream/S1" | grep -o '<title>[^<]*'` prints `<title>Stream` (before `$V down`); the transcript's `CDN PASS` line shows no request left the daemon's origin
- Cost: none billed (no LLM, no provider, no TMDB; ffmpeg encodes about 20 s of video once, cached)

**Exit criteria:** `npm run typecheck`, `npm test`, `npm run docs:check` and `npm run build` pass;
`web/dist/stream.html` exists and loads `/assets/stream-*.js`; the `player.steps.mjs` transcript
has `J1 PASS`, `API PASS`, `J3 PASS`, `J2 PASS`, `MUTED PASS` and `CDN PASS`.

## Handoffs

- **Phase 3 (contract, settled by the reconciler):** the pass-through returns the stream host's own 401, 403 and 410 with `X-Notesd-Upstream`; the page refreshes only on those and treats a 403 without the header as the end of the session. `GET /api/stream/sessions/:id` is phase 3's `SessionInfo` (`session_id`, pass-through `manifest_url` and `subtitles[].url`, `subtitles[].source` and `english`, `manifest_kind` `hls|dash|mp4`, `title`); `POST .../refresh` accepts a same-origin POST from the page and answers the `SessionInfo` with the same `session_id`.
- **Phase 1 (settled by the reconciler):** `cli.mjs open <url> --fullscreen` evaluates `window.notesdStream.start()` as a user gesture after the page loads (never with `muted=1`), so the film starts with sound; this page defines `start()` (`StreamController.playWithSound`). If Chrome still refuses, the page's muted start and muted speaker icon stand. The resolver's `manifest_kind` uses `hls`, `dash`, `mp4`.
- **Phase 5 (R2.4):** the page already posts `{ position_s, duration_s, ended }` to `POST /api/stream/sessions/:id/position`; `duration_s` is `null` while the duration is unknown, so the route's validation must accept `null`. `resume_s` in the session JSON is read when present. Proving R2.4 (a `movie_plays` row from these posts) is phase 5's journey.
- **Phase 6 (R7.3):** live proof of DASH (VidLink), VidNest and a real English subtitle in this page, and the forced-expiry check through the real pass-through, use `/stream/<id>?muted=1` (muted, never unmuted, never full screen), `window.notesdStream` (`kind`, `levels`, `level`, `errors`, `refreshes`, plus stage, qualities, subtitle, log) and the `<video>`. Known soft spots to check live: hls.js subtitle indexes when a manifest has more than one subtitle group (the engine passes the `MediaPlaylist` itself to `setSubtitleOption`, which should cover it), dash.js 5 text track selection through `setCurrentTrack` + `enableText`, and whether a provider's segment host answers a token failure with 401/403/410 or with something else. Phase 6 may fix `web/src/stream/*` after this phase.
- **Owner (index "Follow-ups for the owner"):** CLAUDE.md's "Web app" line names only `web/fullscreen.html` as the separate page; a mention of `web/stream.html` is left to the owner (no phase edits CLAUDE.md). The streaming guide has no pictures; a picture of the player would need a real play and is the owner's to ask for.

## Rollback

Revert this phase's commits. That removes `web/stream.html`, `web/src/stream/`,
`web/src/testing/streamFakes.ts`, the Vite input, the `/stream/` branch in `src/http/static.ts`
and its test, the two packages (re-run `npm install` to restore the lock file), the guide
subsection, the architecture row, the feature-map lines and the two verify scripts. No database or
API change to undo; `/stream/<id>` then falls back to the wall's `index.html`.
