> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/seek-preview-thumbnails/PLAN.md` phase 3. Source: `.workflows/plan/seek-preview-thumbnails/phase-3.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 3: A provider's own preview track

**Plan set:** `SEEK_PREVIEW_THUMBNAILS_PLAN.md`
**Analysis:** `.workflows/analyze/20261120-192436-K7QP_code_analyzer.md`
**Satisfies:** R1, R2 — the hover frame comes from the provider's own seek-preview track where the provider's page loaded one, and a bad track never shows a wrong frame or spoils the provider's record
**Criteria:** R1.4, R2.6
**Depends on:** Phase 1
**Difficulty:** NORMAL
**Package:** `src/directStream` (with `claude/streaming/direct`)

---

## Goal

Today the resolver throws away the seek-preview WebVTT track a provider's page loads (`resolve.mjs:226`). After
this phase the resolver keeps the first such track, with the headers its request carried, as `source.thumbnails`.
The daemon reads that track once per session source through the pass-through's host check, and
`GET /api/stream/sessions/:id/previews` lists its frames (`source: "provider"`). Each frame's picture is a
pass-through address with `img=1`. The pass-through answers it only with an `image/*` body under a size limit and
records it as kind `image`, which never counts in a provider's delivery. A track that cannot be fetched, is too
big or holds no picture cue gives no frame and writes nothing to the evidence log.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `ThumbnailTrack` (`src/directStream/types.ts`): `{url, referer, origin, user_agent}`.
- `ProviderPreviewSource` (class implementing phase 1's `PreviewSource`, `name: 'provider'`), `providerSource` (the registry factory over phase 1's `PreviewSourceDeps`), `ProviderPreviewOptions`, `ThumbnailCue`, `parseThumbnailCues`, `PROVIDER_TRACK_MAX_BYTES` (2 MiB), `PROVIDER_TRACK_TIMEOUT_MS` (15 s), `PROVIDER_LIST_WAIT_MS` (3 s), `PROVIDER_MAX_CUES` (20 000) (`src/directStream/previews/providerSource.ts`)
- `PREVIEW_IMAGE_MAX_BYTES` (4 MiB), `readCappedBytes`, `readCapped` now exported (`src/directStream/passThrough.ts`)
- `thumbnailTrack(hits, userAgent)` (`claude/streaming/direct/resolve.mjs`)
- Pass-through query `img=1` on `GET /api/stream/sessions/:id/p`, with two new refusals: 502 `not_an_image`, 502 `image_too_large`
- Evidence request kind `image` (`evidence.ts` schema, `ForwardKind`)
- Fixture: `fake-cli.mjs` reads `<DIRECT_STREAM_FAKE_DIR>/thumbs` (a track name) and `upstream.mjs` serves `/thumbs/{thumbs,whole,words,page,big}.vtt`, `/thumbs/sprite-{0,1}.png`, `/thumbs/page.png`

**Signature changes:**
- `ResolvedSource` gains the optional `thumbnails?: ThumbnailTrack | null`. Optional so every stand-in source (`cacheSource`, the torrent `standIn`, tests) still compiles unchanged.
- `ForwardRequest` gains the optional `preview?: 'track' | 'image'`.
- `ForwardKind` becomes `'hls' | 'dash' | 'vtt' | 'media' | 'image'`.
- `sourceHosts(source)` also returns the host of `source.thumbnails.url`.
- The resolver's printed `source` gains `thumbnails` (object or null), between `en_subtitle` and `audio`.

**Requires (from earlier phases):** phase 1's `src/directStream/previews/types.ts` (`PreviewSource`, `PreviewList`,
`PreviewCue` exactly as in the index's contract) and its registry `src/directStream/previews/sources.ts`. See
**Assumptions**.

**Leaves alone (owned by others):** `web/` (phase 4), `sniff.ps1`, `sniff.mjs`, `rewrite.ts` (read only:
`proxiedUrl`, `absoluteHttp` are imported, not changed), the builder, queue, store and routes of
`src/directStream/previews/` (phase 1), `src/directStream/torrent/` and `previews/torrentSource.ts` (phase 2),
`src/directStream/delivery.ts` (no code change: it already keeps `kind === 'media'` only, `delivery.ts:84`;
this phase adds a test that holds it there), `docs/guide/*.md` prose, `CLAUDE.md`,
`.claude/skills/verify-notesd/**` (phase 5), `src/daemon.ts` (phase 1's only; this phase needs no line there, A2).

### Assumptions (phase 1 has landed; reconciled against phase 1's plan)

- **A1.** `src/directStream/previews/types.ts` exports `PreviewCue`, `PreviewList` and `PreviewSource` as written in
  the index's contract. `PreviewSource.list(session)` takes the `StreamSession` of `src/directStream/sessions.ts`.
  (Phase 1 Step 1.)
- **A2.** `src/directStream/previews/sources.ts` holds `PREVIEW_SOURCES`, factories
  `(deps: PreviewSourceDeps) => PreviewSource | null`, one per line, asked in the order provider, torrent, cache.
  `PreviewSourceDeps` offers (phase 1 Step 9):
  - `fetch: FetchLike`, `DirectStreamService.passThroughFetch` (the fetch the pass-through uses, `service.ts:517`),
    so a test's injected fetch reaches this source too;
  - `changed(session: StreamSession): void`, the change hook: phase 1 lists that session again, and its
    `preview_rev` rises if the list differs (the one place it rises, `StreamPreviews.list`);
  - `log`.

  This source's factory `providerSource` is the first line. `src/daemon.ts` needs no line (phase 1 passes `fetch`
  and `changed` from `buildStreamPreviews`).
- **A3.** Phase 1 asks the sources only while `NOTESD_STREAM_PREVIEWS` is on (R2.7). The position route never awaits
  `list()`: it calls the synchronous `StreamPreviews.reported(id)` and answers the session's `previewRev` at once, so
  `list()` may wait up to `PROVIDER_LIST_WAIT_MS` (3 s) once per session source, the first time it is asked. Phase 1
  still guards against a `list()` that throws, as the contract says. This one never throws. (Phase 1 Steps 10, 16.)
- **A4.** `GET /api/stream/sessions/:id/previews` answers without a same-origin guard, like
  `GET /api/stream/sessions/:id`. A `verify.sh up` run has previews off unless the caller sets
  `NOTESD_STREAM_PREVIEWS=on`, which passes through (phase 1 Step 19); the Proof journeys set it.
- **A5.** Phase 1 does not change `passThrough.ts`, `evidence.ts` or `delivery.ts`, as its "Does not touch" says.
- **A6 (shared files).** Phase 1 lands first and adds `previewRev` to `StreamSession` and `SessionStore.create`
  (`sessions.ts:129`, `:202`); this phase's `sourceHosts` edit (`sessions.ts:138-146` before phase 1, `:143-151` after its five added lines) is a
  different region and quotes the function as it stays after phase 1. Phase 1 also adds the two previews routes to
  `src/http/directStreamApi.ts` (after the `GET /api/stream/sessions/:id` route) and edits its position route; this
  phase's `/p` route edit (Step 10) is another region, below phase 1's two routes. Phase 1 adds the two previews entries to `scripts/docs/httpRoutes.ts`;
  this phase edits the `/p` entry and the previews entry's `source` sentence as phase 1 wrote it (Steps 11, 11b).
  Phase 2 runs at the same time and adds `torrentSource` to `PREVIEW_SOURCES` (Step 9 quotes the list after both).

### Decision: a cue with no `#xywh` fragment (one whole picture per cue)

**Not listed.** The contract's cue needs `x, y, w, h` inside the picture. Without a fragment, that rectangle is the
picture's own size, and only fetching every picture (hundreds of requests to the stream host) would tell it. A
guessed size draws a wrong or cropped frame. The contract has no "scale the whole picture" flag, so no frame is
the safe answer: the page then shows the timestamp alone (R2.1).

A track made only of such cues counts as one that "holds no picture cue" (R2.6). A mixed track lists only its
fragment cues. This drops the index's exception clause ("unless every cue names one picture each of which is a
single frame, which is listed with the page scaling it"): the contract cannot express it. See **Handoffs**.

## Files

| File | Action | What changes |
|---|---|---|
| `claude/streaming/direct/resolve.mjs` | modify | `subtitleExtOf` (factored out of `requestSubtitles`), new `thumbnailTrack`, `pickSource` returns `thumbnails` |
| `tests/unit/scripts/directResolve.test.ts` | modify | the seek-preview case keeps the track; three new cases; two whole-shape assertions gain `thumbnails` |
| `src/directStream/types.ts` | modify | `ThumbnailTrack`, `ResolvedSource.thumbnails?` |
| `src/directStream/runner.ts` | modify | zod `thumbnails` (optional, never fails a resolve), normalized into `ResolvedSource` |
| `tests/unit/directStream/runner.test.ts` | modify | three cases for `thumbnails` |
| `src/directStream/sessions.ts` | modify | `sourceHosts` adds the track's host (after phase 1's `previewRev` lines, another region) |
| `src/directStream/passThrough.ts` | modify | `preview` on `ForwardRequest`, the track's headers for a preview request, `img` answers checked and kept whole, `ForwardKind` `image`, `readCapped`/`readCappedBytes` exported |
| `src/directStream/evidence.ts` | modify | request `kind` enum gains `image` |
| `src/http/directStreamApi.ts` | modify | the pass-through route reads `img=1` (phase 1's file too: its two previews routes and the position route are other regions) |
| `src/directStream/previews/providerSource.ts` | create | the provider source and the cue parser |
| `src/directStream/previews/sources.ts` | modify | one import, one registry line `providerSource,` first in the list (phase 1's file) |
| `scripts/docs/httpRoutes.ts` | modify | the pass-through entry names `img=1` and its refusals; phase 1's previews entry names `source: provider` |
| `docs/guide/reference/http-api.md` | regenerate | `npm run docs:gen` |
| `tests/fixtures/direct-stream/fake-cli.mjs` | modify | `<dir>/thumbs` makes the resolve name that track |
| `tests/fixtures/direct-stream/upstream.mjs` | modify | serves the tracks and pictures under `/thumbs/` |
| `tests/unit/directStream/previews/providerSource.test.ts` | create | the source's behaviour, R1.4 and R2.6 |
| `tests/unit/directStream/passThroughPreview.test.ts` | create | `img=1` answers, headers, evidence kind |
| `tests/unit/directStream/delivery.test.ts` | modify | a picture never counts in delivery |
| `claude/skills/report-stream-bug/diagnose.mjs:159-161` | modify | `isPass` leaves evidence kind `image` out (reconciler: unowned impact point, assigned here) |
| `tests/unit/scripts/reportStreamBug.test.ts` | modify | failing preview pictures change no stream-bug cause |

## Implementation Steps

### Step 1: The resolver keeps the track
**File:** `claude/streaming/direct/resolve.mjs:198-230` (after `isThumbnailTrack`, replacing `requestSubtitles`) and `:302-320` (`pickSource`)
**Change:** factor the extension test out of `requestSubtitles` and add `thumbnailTrack`, which returns the first
`.vtt` hit that `isThumbnailTrack` names. It applies the same status and `http(s)` tests as `requestSubtitles` and
carries the headers that hit's request carried. `requestSubtitles` still skips every such hit, so a track is never a
subtitle. `pickSource` returns it as `thumbnails`, as its last key, so the printed source reads
`..., en_subtitle, thumbnails, audio, took_s` (the `...found` spread at `resolve.mjs:611` keeps that order). `sniff.ps1`
and `sniff.mjs` are not changed: the track is told by its name, or by its cues when the sniffer kept the body.

**Code:** replace `requestSubtitles` (`:214-230`) with:
```js
/** The subtitle format a request names: by its path, its type or a query parameter; null when it names none. */
function subtitleExtOf(hit) {
  return (
    SUBTITLE_EXT.exec(pathOf(hit.url))?.[1]?.toLowerCase() ??
    (/^text\/vtt/i.test(String(hit.mime ?? '')) ? 'vtt' : null) ??
    subtitleExtIn(hit.url) ??
    (hit.type === 'TextTrack' ? 'vtt' : null)
  );
}

/**
 * The player's seek-preview track: the first WebVTT request isThumbnailTrack names, with the headers that very
 * request carried (the daemon fetches the track, and the pictures it names, with exactly these). Null when the
 * page loaded none. Never a subtitle: requestSubtitles leaves every such request out.
 */
export function thumbnailTrack(hits, userAgent = null) {
  for (const hit of hits) {
    if (typeof hit.status === 'number' && !okStatus(hit)) continue;
    if (!HTTP.test(String(hit.url ?? ''))) continue;
    if (subtitleExtOf(hit) !== 'vtt' || !isThumbnailTrack(hit)) continue;
    return { url: hit.url, referer: hit.referer ?? null, origin: hit.origin ?? null, user_agent: hit.user_agent ?? userAgent ?? null };
  }
  return null;
}

function requestSubtitles(hits, skipDirs) {
  const tracks = [];
  for (const hit of hits) {
    if (typeof hit.status === 'number' && !okStatus(hit)) continue;
    if (!/^https?:\/\//.test(String(hit.url ?? ''))) continue;
    const ext = subtitleExtOf(hit);
    if (!ext) continue;
    if (ext === 'vtt' && skipDirs.has(dirOf(hit.url))) continue;
    if (ext === 'vtt' && isThumbnailTrack(hit)) continue;
    tracks.push({ url: hit.url, lang: guessLang(hit.url), label: null, format: ext, source: 'request' });
  }
  return tracks;
}
```
Replace `pickSource` (`:298-320`) with:
```js
/**
 * The stream in one capture: the manifest, the headers its request carried, the subtitle tracks
 * seen, the best height, and the player's seek-preview track (null when it loaded none). Null when
 * the capture holds no stream.
 */
export function pickSource(sniff) {
  const hits = Array.isArray(sniff?.hits) ? sniff.hits : [];
  const best = bestHit(sniff);
  if (best === null) return null;
  const { hit, kind } = best;
  const body = typeof hit.body === 'string' ? hit.body : '';
  const inManifest = kind === 'hls' ? hlsSubtitles(body, hit.url) : kind === 'dash' ? dashSubtitles(body, hit.url) : [];
  const skipDirs = new Set(inManifest.filter((t) => t.format === 'hls').map((t) => dirOf(t.url)));
  const seen = new Set();
  const subtitles = [...inManifest, ...requestSubtitles(hits, skipDirs), ...indexSubtitles(hits)].filter((t) => (seen.has(t.url) ? false : (seen.add(t.url), true)));
  return {
    manifest_url: hit.url,
    manifest_kind: kind,
    headers: { referer: hit.referer ?? null, origin: hit.origin ?? null, user_agent: hit.user_agent ?? sniff.user_agent ?? null },
    subtitles,
    best_height: best.height ?? bestHeight(hit, kind),
    en_subtitle: subtitles.some(isEnglish),
    thumbnails: thumbnailTrack(hits, sniff.user_agent ?? null),
  };
}
```
Also update the `isThumbnailTrack` doc comment (`:198-202`): its last sentence becomes "Kept apart as the source's
`thumbnails` (thumbnailTrack), never a subtitle."
**Impact:** every resolve's printed source carries `thumbnails`. An older daemon strips the unknown key (zod
`z.object` strips), so nothing breaks before Step 3 lands.

### Step 2: The resolver's tests
**File:** `tests/unit/scripts/directResolve.test.ts:200-207`, `:239-251`, `:409`
**Change:** add `thumbnails: null` to the whole-object expectation at `:200`. Add `'thumbnails'` to the key list at
`:409`. Replace the seek-preview case at `:239-251` with the four cases below. The import at `:11` gains `thumbnailTrack`.
**Code:**
At `:11`:
```ts
import { embedUrl, indexSubtitles, pickSource, resolveTitle, seriesPlayerFrame, thumbnailTrack } from '../../../claude/streaming/direct/resolve.mjs';
```
At `:200-207`:
```ts
    expect(found).toEqual({
      manifest_url: 'https://cdn.example/hls/master.m3u8?token=abc',
      manifest_kind: 'hls',
      headers: { referer: 'https://vidfast.vc/', origin: 'https://vidfast.vc', user_agent: UA },
      subtitles: [{ url: 'https://cdn.example/hls/subs/en.m3u8', lang: 'en', label: 'English', format: 'hls', source: 'manifest' }],
      best_height: 2160,
      en_subtitle: true,
      thumbnails: null,
    });
```
At `:409`:
```ts
    expect(Object.keys(out.source)).toEqual(['provider', 'embed_url', 'manifest_url', 'manifest_kind', 'headers', 'subtitles', 'best_height', 'en_subtitle', 'thumbnails', 'audio', 'took_s']);
```
Replacing `:239-251`:
```ts
  it("keeps a player's seek-preview file apart from the subtitles: the first one, with the headers its request carried", () => {
    const found = pickSource(
      capture({
        hits: [
          hit({ url: 'https://cdn.example/vd/abc/index.m3u8', mime: 'application/vnd.apple.mpegurl', body: MASTER }),
          hit({ at_s: 3, url: 'https://cdn.example/vd/abc/thumbs/thumbs.vtt', mime: 'text/vtt', referer: 'https://player.example/', origin: 'https://player.example' }),
          hit({ at_s: 3, url: 'https://cdn.example/vd/abc/preview.vtt', mime: 'text/vtt', body: 'WEBVTT\n\n00:00.000 --> 00:10.000\nthumbs/sprite-001.jpg#xywh=160,0,160,90\n' }),
          hit({ at_s: 3, url: 'https://subs.example/the-fix/English.vtt', mime: 'text/vtt' }),
        ],
      }),
    );
    expect(found.subtitles.filter((t: Json) => t.source === 'request').map((t: Json) => t.url)).toEqual(['https://subs.example/the-fix/English.vtt']);
    expect(found.thumbnails).toEqual({ url: 'https://cdn.example/vd/abc/thumbs/thumbs.vtt', referer: 'https://player.example/', origin: 'https://player.example', user_agent: UA });
  });

  it('tells a seek-preview file by its cues when its name does not, and skips one the host refused', () => {
    const hits = [
      hit({ at_s: 3, url: 'https://cdn.example/vd/abc/thumbs.vtt', mime: 'text/vtt', status: 403 }),
      hit({ at_s: 3, url: 'https://cdn.example/vd/abc/preview.vtt', mime: 'text/vtt', user_agent: null, body: 'WEBVTT\n\n00:00.000 --> 00:10.000\nsprite-1.jpg#xywh=0,0,160,90\n' }),
    ];
    expect(thumbnailTrack(hits, 'TabChrome/1')).toEqual({ url: 'https://cdn.example/vd/abc/preview.vtt', referer: 'https://vidfast.vc/', origin: 'https://vidfast.vc', user_agent: 'TabChrome/1' });
  });

  it('names no seek-preview file when the page loaded none: a subtitle is never one, nor a sprite picture', () => {
    const hits = [
      hit({ url: 'https://subs.example/the-fix/English.vtt', mime: 'text/vtt' }),
      hit({ url: 'https://cdn.example/vd/abc/thumbs/sprite-1.jpg', mime: 'image/jpeg' }),
      hit({ url: 'blob:https://vidfast.vc/thumbs.vtt', mime: 'text/vtt' }),
    ];
    expect(thumbnailTrack(hits, UA)).toBeNull();
    expect(pickSource(capture({ hits: [hit({ url: 'https://cdn.example/a.m3u8', body: MASTER }), ...hits] })).thumbnails).toBeNull();
  });
```
**Impact:** `npx vitest run tests/unit/scripts/directResolve.test.ts` passes.

### Step 3: The type and the boundary
**File:** `src/directStream/types.ts:85-128`, `src/directStream/runner.ts:43-69` and `:95-132`
**Change:** add `ThumbnailTrack` and the optional field. Parse the field once, at the resolver's boundary. A
`thumbnails` that does not fit never fails a resolve: zod `.catch(null)` makes it null, and an address that is not
http(s) is null too. Inside the daemon, `thumbnails` is either a whole, valid track or null.
**Code:** in `types.ts`, after `CapturedHeaders` (`:90`):
```ts
/**
 * A player's seek-preview WebVTT track the provider's page loaded (resolve.mjs thumbnailTrack), with the headers
 * that very request carried: the daemon fetches the track, and the pictures it names, with exactly these
 * (previews/providerSource.ts, passThrough.ts). Never a subtitle.
 */
export interface ThumbnailTrack extends CapturedHeaders {
  /** Absolute http(s) address. */
  url: string;
}
```
In `ResolvedSource` (`:116-128`), after `audio?`:
```ts
  /** The player's seek-preview track; absent or null when the page loaded none (or an older resolver answered). */
  thumbnails?: ThumbnailTrack | null;
```
In `runner.ts`, the import at `:4-12` gains `type ThumbnailTrack`:
```ts
import {
  DirectStreamError,
  MANIFEST_KINDS,
  RESOLVE_OUTCOMES,
  isEnglish,
  type ResolveAttempt,
  type ResolveOutput,
  type SubtitleTrack,
  type ThumbnailTrack,
} from './types.js';
```
After `subtitleSchema` (`:49`):
```ts
const thumbnailsSchema = z.object({
  url: z.string(),
  referer: z.string().nullish(),
  origin: z.string().nullish(),
  user_agent: z.string().nullish(),
});
```
In `sourceSchema`, after `en_subtitle` (`:59`):
```ts
  /** A newer resolver's seek-preview track. Missing (an older resolver) or not fitting: null, and the resolve still stands. */
  thumbnails: thumbnailsSchema.nullish().catch(null),
```
After `toAttempt` (`:88`):
```ts
/** The seek-preview track as the daemon keeps it: null unless its address is http(s); header values null when not sent. */
function toThumbnailTrack(t: z.infer<typeof thumbnailsSchema> | null | undefined): ThumbnailTrack | null {
  if (t === undefined || t === null) return null;
  const url = absoluteHttp(t.url);
  return url === null ? null : { url, referer: present(t.referer), origin: present(t.origin), user_agent: present(t.user_agent) };
}
```
In `parseResolveOutput`'s returned `source` (`:114-130`), after `en_subtitle`:
```ts
      thumbnails: toThumbnailTrack(s.thumbnails),
```
**Impact:** `session.source.thumbnails` is set on every session made from a resolve. Cache and torrent stand-ins
leave it unset, which means null.

### Step 4: The runner's tests
**File:** `tests/unit/directStream/runner.test.ts:84` (inside `describe('parseResolveOutput')`, before its closing `});`)
**Code:**
```ts
  it('reads the seek-preview track with its own headers, and none from an older resolver', () => {
    const thumbnails = { url: 'https://img.example/vd/1/thumbs.vtt?tok=1', referer: 'https://player.example/', origin: '', user_agent: 'Chrome/142' };
    const out = parseResolveOutput({ ...RESOLVED, source: { ...RESOLVED.source, thumbnails } });
    expect(out.ok && out.source.thumbnails).toEqual({ url: 'https://img.example/vd/1/thumbs.vtt?tok=1', referer: 'https://player.example/', origin: null, user_agent: 'Chrome/142' });
    const older = parseResolveOutput(RESOLVED);
    expect(older.ok && older.source.thumbnails).toBeNull();
  });

  it('keeps the resolve when its seek-preview track does not fit: no track', () => {
    for (const thumbnails of [{ url: 'blob:https://player.example/1' }, { url: 42 }, 'thumbs.vtt']) {
      const out = parseResolveOutput({ ...RESOLVED, source: { ...RESOLVED.source, thumbnails } });
      expect(out.ok).toBe(true);
      expect(out.ok && out.source.thumbnails).toBeNull();
      expect(out.ok && out.source.manifest_url).toBe('https://cdn.example/hls/master.m3u8');
    }
  });
```
**Impact:** `npx vitest run tests/unit/directStream/runner.test.ts` passes.

### Step 5: The session may reach the track's host
**File:** `src/directStream/sessions.ts:138-146` (`:143-151` once phase 1's `previewRev` lines have landed above it)
**Change:** the track's host is a host the resolve returned, like a subtitle's. A refresh adds it the same way,
because `replaceSource` already calls `sourceHosts` (`:253`). The hosts of the pictures are added only by the
provider source, after it has read the track (Step 8).
**Code:**
```ts
/** The hosts a resolve returned: the manifest's, every subtitle track's and the seek-preview track's. */
export function sourceHosts(source: ResolvedSource): Set<string> {
  const hosts = new Set<string>();
  const named = [source.manifest_url, ...source.subtitles.map((t) => t.url), ...(source.thumbnails ? [source.thumbnails.url] : [])];
  for (const url of named) {
    const host = hostOf(url);
    if (host !== null) hosts.add(host);
  }
  return hosts;
}
```
**Impact:** only a session whose source names a track gains a host.

### Step 6: The pass-through: a preview request and an `img=1` answer
**File:** `src/directStream/passThrough.ts` (whole file, 205 lines today)
**Change:**
- `ForwardRequest.preview` is a single field with two values, so "a picture that is also a subtitle" cannot be
  built.
- A preview request goes with the track's captured headers. The track's own request carried those headers; the
  sniffer records no picture request (`sniff.ps1:189`), and a player asks for its pictures from the page that asked
  for the track. The page gets the manifest's headers when the source has no track.
- An `image` request sends no `Range`. Its answer passes only when the host answers 2xx with an `image/*` type. It
  is read whole, up to `PREVIEW_IMAGE_MAX_BYTES`, so the page never gets half a picture. It is cacheable by the
  browser (`private, max-age=86400`): the address names the session and the picture, and the hover asks for the
  same sheet again and again.
- Its trace kind is `image`.
- `readCapped` is split into `readCappedBytes` plus a decoder, and both are exported (the provider source reads
  the track with `readCapped`).

Everything else in `forward` is unchanged.
**Code:**
```ts
import { absoluteHttp, rewriteDash, rewriteHls, srtToVtt } from './rewrite.js';
import { allows, learn, type StreamSession } from './sessions.js';
import type { CapturedHeaders } from './types.js';

/** A playlist or manifest larger than this is refused (they are kilobytes; this stops a runaway body). */
export const PLAYLIST_MAX_BYTES = 8 * 1024 * 1024;
/** A seek-preview picture (`img=1`) larger than this is refused: a sprite sheet is tens or hundreds of kilobytes. */
export const PREVIEW_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
/** The stream host must start answering within this; a body then streams for as long as it takes. */
export const UPSTREAM_HEADERS_TIMEOUT_MS = 20_000;
export const MAX_REDIRECTS = 5;
/** Carries the stream host's own status on every forwarded answer; notesd's own refusals never carry it. */
export const UPSTREAM_STATUS_HEADER = 'x-notesd-upstream';
const PASSED_HEADERS = ['content-type', 'content-range', 'accept-ranges', 'last-modified', 'etag'] as const;
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ForwardRequest {
  /** The `u` query parameter: the stream host address to fetch (empty when missing). */
  target: string;
  /** The player's `Range` header, forwarded as is (never for an `image` request). */
  range: string | null;
  /** `vtt=1`: the answer is a subtitle file to hand back as WebVTT. */
  vtt: boolean;
  /**
   * A seek preview's request (previews/providerSource.ts), sent with the headers the resolve captured for the
   * provider's preview track: `track`, that WebVTT file, read by the daemon; `image` (`img=1`), one of its
   * pictures, answered only as an image/* body under PREVIEW_IMAGE_MAX_BYTES. Unset: a request of the play.
   */
  preview?: 'track' | 'image';
  /** Aborted when the player goes away; the stream host request is aborted with it. */
  signal: AbortSignal;
}

/** What the answer carries: a rewritten playlist or manifest, a subtitle, media streamed through, or a seek-preview picture. */
export type ForwardKind = 'hls' | 'dash' | 'vtt' | 'media' | 'image';

/**
 * What forward() saw, for the stream evidence log (evidence.ts). forward() only writes it, as it
 * goes; it never reads it back, so an answer is the same with or without one.
 */
export interface ForwardTrace {
  /** The clock `headersAt` is read from (milliseconds, monotonic). */
  readonly clock: () => number;
  /** The address last asked for (after redirects); null when nothing was fetched. */
  target: string | null;
  redirects: number;
  /** The stream host's status; null when it never answered. */
  upstreamStatus: number | null;
  /** clock() when the stream host's headers arrived; null when they never did. */
  headersAt: number | null;
  kind: ForwardKind | null;
  /** `<code>: <message>` when notesd answered with its own error (forbidden_host, upstream_error); else null. */
  error: string | null;
}

export function newForwardTrace(clock: () => number = () => performance.now()): ForwardTrace {
  return { clock, target: null, redirects: 0, upstreamStatus: null, headersAt: null, kind: null, error: null };
}

export function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Only what the real Chrome's manifest request carried, plus the player's Range. No cookie, nothing invented. */
export function upstreamHeaders(captured: CapturedHeaders, range: string | null): Record<string, string> {
  const headers: Record<string, string> = {};
  if (captured.referer !== null) headers.referer = captured.referer;
  if (captured.origin !== null) headers.origin = captured.origin;
  if (captured.user_agent !== null) headers['user-agent'] = captured.user_agent;
  if (range !== null && range !== '') headers.range = range;
  return headers;
}

/**
 * The captured headers a request goes with: a seek preview's, those the provider's preview track was asked
 * with (the player asks for the track's pictures from the same page); everything else, and a preview request
 * of a source with no track, the manifest's.
 */
function capturedFor(session: StreamSession, req: ForwardRequest): CapturedHeaders {
  const track = session.source.thumbnails ?? null;
  if (req.preview === undefined || track === null) return session.source.headers;
  return { referer: track.referer, origin: track.origin, user_agent: track.user_agent };
}

type TextKind = 'hls' | 'dash' | 'vtt';

function textKind(target: string, contentType: string, vtt: boolean): TextKind | null {
  if (vtt) return 'vtt';
  const pathname = new URL(target).pathname.toLowerCase();
  if (/mpegurl/i.test(contentType) || /\.m3u8?$/.test(pathname)) return 'hls';
  if (/dash\+xml/i.test(contentType) || pathname.endsWith('.mpd')) return 'dash';
  // VidNest serves its master playlist as master.txt.
  if (pathname.endsWith('.txt') && !/^(video|audio|image)\//i.test(contentType)) return 'hls';
  return null;
}

/** The whole body, or null (the body cancelled) as soon as it passes `max` bytes. */
export async function readCappedBytes(res: Response, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (res.body === null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** The whole body as text, or null as soon as it passes `max` bytes. */
export async function readCapped(res: Response, max: number): Promise<string | null> {
  const bytes = await readCappedBytes(res, max);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

type Refuse = (status: number, error: string, message: string) => Response;

/**
 * A seek-preview picture (`img=1`): the host's answer only when it is 2xx, an image/* type and at most
 * PREVIEW_IMAGE_MAX_BYTES, read whole so the page never gets half a picture; else 502 `not_an_image` or
 * `image_too_large`. Cacheable by the browser: the address names the session and the picture.
 */
async function answerImage(upstream: Response, out: Headers, refuse: Refuse): Promise<Response> {
  const contentType = upstream.headers.get('content-type') ?? '';
  if (!upstream.ok || !/^image\//i.test(contentType)) {
    await upstream.body?.cancel().catch(() => undefined);
    const type = contentType === '' ? 'no type' : (contentType.split(';')[0] ?? '').trim();
    return refuse(502, 'not_an_image', `The stream host answered ${upstream.status} with ${type}, not a picture.`);
  }
  let bytes: Uint8Array<ArrayBuffer> | null = null;
  if (Number(upstream.headers.get('content-length') ?? '0') > PREVIEW_IMAGE_MAX_BYTES) {
    await upstream.body?.cancel().catch(() => undefined);
  } else {
    try {
      bytes = await readCappedBytes(upstream, PREVIEW_IMAGE_MAX_BYTES);
    } catch (err) {
      return refuse(502, 'upstream_error', `The stream host broke off: ${messageOf(err)}`);
    }
  }
  if (bytes === null) return refuse(502, 'image_too_large', `The picture is larger than ${PREVIEW_IMAGE_MAX_BYTES} bytes.`);
  out.set('content-type', contentType);
  out.set('content-length', String(bytes.byteLength));
  out.set('cache-control', 'private, max-age=86400');
  return new Response(bytes, { status: upstream.status, headers: out });
}

/**
 * Fetches `req.target` for a live session and hands the answer back. Refuses with 403 `forbidden_host`,
 * before any request, an address that is not http(s) or not on a host the session may reach. Follows
 * redirects itself (a redirect answered by the session's host vouches for its target, like a playlist
 * entry). Playlists and manifests are read whole and rewritten, and the hosts they name join the
 * session; a seek-preview picture is checked and read whole (answerImage); everything else streams
 * through as it arrives, with the stream host's status. `trace`, when given, is filled in for the
 * evidence log; the answer does not depend on it.
 */
export async function forward(session: StreamSession, req: ForwardRequest, fetchImpl: FetchLike, trace: ForwardTrace | null = null): Promise<Response> {
  const refuse: Refuse = (status, error, message) => {
    if (trace !== null) trace.error = `${error}: ${message}`;
    return jsonError(status, error, message);
  };
  const first = absoluteHttp(req.target);
  if (first === null || !allows(session, first)) {
    return refuse(403, 'forbidden_host', 'That address is not on a host this stream session may reach.');
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (req.signal.aborted) abort();
  else req.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, UPSTREAM_HEADERS_TIMEOUT_MS);
  const image = req.preview === 'image';
  const headers = upstreamHeaders(capturedFor(session, req), image ? null : req.range);
  let target = first;
  let upstream: Response;
  try {
    let hops = 0;
    for (;;) {
      if (trace !== null) trace.target = target;
      const res = await fetchImpl(target, { headers, redirect: 'manual', signal: controller.signal });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (location === null) {
        upstream = res;
        break;
      }
      await res.body?.cancel().catch(() => undefined);
      const next = absoluteHttp(location, target);
      hops += 1;
      if (trace !== null) trace.redirects = hops;
      if (next === null || hops > MAX_REDIRECTS) {
        req.signal.removeEventListener('abort', abort);
        return refuse(
          502,
          'upstream_error',
          next === null ? 'The stream host redirected to an address that is not http(s).' : `The stream host redirected more than ${MAX_REDIRECTS} times.`,
        );
      }
      learn(session, next);
      target = next;
    }
  } catch (err) {
    req.signal.removeEventListener('abort', abort);
    return refuse(502, 'upstream_error', `The stream host did not answer: ${messageOf(err)}`);
  } finally {
    clearTimeout(timer);
  }
  if (trace !== null) {
    trace.upstreamStatus = upstream.status;
    trace.headersAt = trace.clock();
  }

  const out = new Headers({ 'cache-control': 'no-store', [UPSTREAM_STATUS_HEADER]: String(upstream.status) });
  if (image) {
    if (trace !== null) trace.kind = 'image';
    try {
      return await answerImage(upstream, out, refuse);
    } finally {
      req.signal.removeEventListener('abort', abort);
    }
  }
  const contentType = upstream.headers.get('content-type') ?? '';
  const nullBody = NULL_BODY_STATUSES.has(upstream.status);
  const kind = textKind(target, contentType, req.vtt);
  if (trace !== null) trace.kind = kind ?? 'media';
  if (kind !== null && !nullBody) {
    let text: string | null;
    try {
      text = await readCapped(upstream, PLAYLIST_MAX_BYTES);
    } catch (err) {
      return refuse(502, 'upstream_error', `The stream host broke off: ${messageOf(err)}`);
    } finally {
      req.signal.removeEventListener('abort', abort);
    }
    if (text === null) return refuse(502, 'upstream_error', `The playlist is larger than ${PLAYLIST_MAX_BYTES} bytes.`);
    let body = text;
    let type = contentType === '' ? 'text/plain; charset=utf-8' : contentType;
    if (kind === 'hls' && text.replace(/^﻿/, '').trimStart().startsWith('#EXTM3U')) {
      const r = rewriteHls(text, target, session.id);
      for (const url of r.urls) learn(session, url);
      body = r.text;
      type = 'application/vnd.apple.mpegurl';
    } else if (kind === 'dash' && /<MPD[\s>]/.test(text)) {
      const r = rewriteDash(text, target, session.id);
      for (const url of r.urls) learn(session, url);
      body = r.text;
      type = 'application/dash+xml';
    } else if (kind === 'vtt' && upstream.ok) {
      body = srtToVtt(text);
      type = 'text/vtt; charset=utf-8';
    }
    out.set('content-type', type);
    return new Response(body, { status: upstream.status, headers: out });
  }
  for (const name of PASSED_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) out.set(name, value);
  }
  const length = upstream.headers.get('content-length');
  if (length !== null && upstream.headers.get('content-encoding') === null) out.set('content-length', length);
  return new Response(nullBody ? null : upstream.body, { status: upstream.status, headers: out });
}
```
Note: the BOM in the `text.replace(/^﻿/, '')` regex at today's `:181` is a literal U+FEFF. Keep the
character exactly as it is in the file today: edit around that line, do not retype it.
**Impact:** a request without `preview` takes the same path as today, so every existing pass-through test still
passes. The typed `Uint8Array<ArrayBuffer>` body was typechecked against this repo's TypeScript 5.9.3 and
`@types/node` 22 while this was planned.

### Step 7: The evidence kind
**File:** `src/directStream/evidence.ts:49`
**Code:**
```ts
  kind: z.enum(['hls', 'dash', 'vtt', 'media', 'image']).nullable(),
```
**Impact:** `observeForward` writes `kind: 'image'` for a picture (`trace.kind`, `evidence.ts:335`).
`deliveryByProvider` keeps `kind === 'media'` only (`delivery.ts:84`), so a picture never counts in a provider's
delivery, and `delivery.ts` needs no change. A daemon older than this phase reads an `image` line as foreign and
skips it (`parseEvidenceLine` returns null).

### Step 8: The provider source
**File:** `src/directStream/previews/providerSource.ts` (new)
**Change:** the whole source and its parser.
- The source keeps one entry per session in a `WeakMap`, so an ended session takes its entry with it and no
  end listener is needed.
- An entry is made for one source object. A refresh or a switch replaces `session.source` (`sessions.ts:248-266` today, `:254-272` after phase 1),
  and with it the track: the new source's track is read, and with no track there are no frames.
- The track goes through `forward()` (the host check, the redirect rules and the track's own headers) and never
  through `observeForward`, so nothing about it reaches the evidence log.
- The pictures' hosts are learned only from a track that held at least one picture cue, and only while that entry
  is still the session's.
**Code:**
```ts
import { redactQueries } from '../evidence.js';
import { forward, readCapped, type FetchLike } from '../passThrough.js';
import { absoluteHttp, proxiedUrl } from '../rewrite.js';
import { learn, type StreamSession } from '../sessions.js';
import type { ResolvedSource, ThumbnailTrack } from '../types.js';
import type { PreviewSourceFactory } from './sources.js';
import type { PreviewCue, PreviewList, PreviewSource } from './types.js';

/**
 * A provider's own seek-preview track (SEEK_PREVIEW_THUMBNAILS phase 3, R1.4, R2.6). The resolver keeps the first
 * WebVTT request the provider's page made that names itself a thumbnail track (resolve.mjs thumbnailTrack, the
 * source's `thumbnails`). This source reads it once per session source, through the pass-through's host check and
 * with the headers that request carried, and lists its cues. A cue is a picture address with `#xywh=x,y,w,h`; the
 * page fetches its picture through the pass-through with `img=1`, which lets only image/* answers under a size
 * limit through and records them as kind `image`, never counted in a provider's delivery. The track itself is
 * fetched outside the evidence log: a track that cannot be fetched, is too big or names no picture is one log
 * line and no frame.
 *
 * A cue whose picture has no `#xywh` fragment (one whole picture per cue) is not listed: its rectangle is the
 * picture's own size, which only fetching every picture would tell, and a guessed one shows a wrong or cropped
 * frame. No frame (the page then shows the time alone) is the safe answer.
 */

/** A seek-preview track is one short line per frame: tens or hundreds of kilobytes. Past this it is not one. */
export const PROVIDER_TRACK_MAX_BYTES = 2 * 1024 * 1024;
/** The whole read of the track, headers and body. */
export const PROVIDER_TRACK_TIMEOUT_MS = 15_000;
/** How long list() waits for a track still being read before it answers without it (the change is told when it lands). */
export const PROVIDER_LIST_WAIT_MS = 3_000;
/** More cues than this are left out: one a second for five and a half hours. */
export const PROVIDER_MAX_CUES = 20_000;
/** A frame wider or taller than this is no thumbnail. */
const MAX_FRAME_PX = 4096;

const NONE: PreviewList = { state: 'none', source: null, cues: [] };

/** One picture cue of a track, its picture resolved against the track's address and without the fragment. */
export interface ThumbnailCue {
  start_s: number;
  end_s: number;
  /** Absolute http(s). */
  picture: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const TIMESTAMP = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/;
const XYWH = /^xywh=(?:pixel:)?(\d+),(\d+),(\d+),(\d+)$/i;

function seconds(stamp: string): number | null {
  const m = TIMESTAMP.exec(stamp.trim());
  if (m === null) return null;
  const [, h = '0', mm = '0', ss = '0', ms = '0'] = m;
  return Number(h) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms.padEnd(3, '0')) / 1000;
}

/**
 * The picture cues of a WebVTT seek-preview track, sorted by start, never overlapping (a cue that starts inside
 * the one before starts where that one ends; one wholly inside it is dropped). A cue without an `#xywh` fragment,
 * with a percent rectangle, an empty or oversized rectangle, a picture that is not http(s) or an end not after its
 * start is left out. Text that is not WebVTT has none.
 */
export function parseThumbnailCues(text: string, trackUrl: string, maxCues: number = PROVIDER_MAX_CUES): ThumbnailCue[] {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  if (!/^WEBVTT(?:[ \t]|$)/.test(lines[0] ?? '')) return [];
  const found: ThumbnailCue[] = [];
  for (let i = 1; i < lines.length && found.length < maxCues; i += 1) {
    const line = lines[i] ?? '';
    const arrow = line.indexOf('-->');
    if (arrow < 0) continue;
    const start = seconds(line.slice(0, arrow));
    const end = seconds(line.slice(arrow + 3).trim().split(/\s+/)[0] ?? '');
    const payload = (lines[i + 1] ?? '').trim();
    i += 1;
    if (start === null || end === null || !(end > start)) continue;
    const hash = payload.indexOf('#');
    if (hash <= 0) continue;
    const rect = XYWH.exec(payload.slice(hash + 1));
    if (rect === null) continue;
    const x = Number(rect[1]);
    const y = Number(rect[2]);
    const w = Number(rect[3]);
    const h = Number(rect[4]);
    if (w <= 0 || h <= 0 || w > MAX_FRAME_PX || h > MAX_FRAME_PX) continue;
    const picture = absoluteHttp(payload.slice(0, hash), trackUrl);
    if (picture === null) continue;
    found.push({ start_s: start, end_s: end, picture, x, y, w, h });
  }
  found.sort((a, b) => a.start_s - b.start_s);
  const out: ThumbnailCue[] = [];
  let lastEnd = Number.NEGATIVE_INFINITY;
  for (const cue of found) {
    if (cue.end_s <= lastEnd) continue;
    out.push({ ...cue, start_s: Math.max(cue.start_s, lastEnd) });
    lastEnd = cue.end_s;
  }
  return out;
}

export interface ProviderPreviewOptions {
  /** The pass-through's fetch (DirectStreamService's; tests inject one). */
  fetch?: FetchLike;
  /** Told when this source's list for a session changed: frames arrived, or the frames it listed are gone. */
  onChange?: (session: StreamSession) => void;
  log?: (line: string) => void;
  maxBytes?: number;
  timeoutMs?: number;
  waitMs?: number;
}

interface Entry {
  /** The session's source this entry was made for: a refresh or a switch brings another, and with it another track (or none). */
  readonly source: ResolvedSource;
  /** Null while the track is being read. */
  list: PreviewList | null;
  done: Promise<void>;
}

const hasFrames = (list: PreviewList | null): boolean => list !== null && list.cues.length > 0;

/** The track a session's frames may come from: null for a cache's or a torrent's stand-in source (their frames come from the video on disk). */
function trackOf(session: StreamSession): ThumbnailTrack | null {
  if (session.cache !== null || session.torrent !== null) return null;
  return session.source.thumbnails ?? null;
}

function toPreviewCue(sessionId: string, cue: ThumbnailCue): PreviewCue {
  return { start_s: cue.start_s, end_s: cue.end_s, url: `${proxiedUrl(sessionId, cue.picture)}&img=1`, x: cue.x, y: cue.y, w: cue.w, h: cue.h };
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

export class ProviderPreviewSource implements PreviewSource {
  readonly name = 'provider' as const;
  private readonly entries = new WeakMap<StreamSession, Entry>();
  private readonly fetchImpl: FetchLike;
  private readonly onChange: (session: StreamSession) => void;
  private readonly log: (line: string) => void;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly waitMs: number;

  constructor(opts: ProviderPreviewOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.onChange = opts.onChange ?? (() => undefined);
    this.log = opts.log ?? ((line) => console.error(line));
    this.maxBytes = opts.maxBytes ?? PROVIDER_TRACK_MAX_BYTES;
    this.timeoutMs = opts.timeoutMs ?? PROVIDER_TRACK_TIMEOUT_MS;
    this.waitMs = opts.waitMs ?? PROVIDER_LIST_WAIT_MS;
  }

  /** The track's frames, `ready` and `provider`; `none` while there is no track, it is still being read, or it gave none. Never throws. */
  async list(session: StreamSession): Promise<PreviewList> {
    try {
      const track = trackOf(session);
      const had = this.entries.get(session);
      if (had !== undefined && (track === null || had.source !== session.source)) {
        this.entries.delete(session);
        if (hasFrames(had.list)) this.changed(session);
      }
      if (track === null) return NONE;
      const entry = this.entries.get(session) ?? this.start(session, track);
      if (entry.list === null && this.waitMs > 0) await Promise.race([entry.done, pause(this.waitMs)]);
      return entry.list ?? NONE;
    } catch (err) {
      this.log(`[notesd] previews: the provider source failed: ${redactQueries(err instanceof Error ? err.message : String(err))}`);
      return NONE;
    }
  }

  private start(session: StreamSession, track: ThumbnailTrack): Entry {
    const entry: Entry = { source: session.source, list: null, done: Promise.resolve() };
    this.entries.set(session, entry);
    entry.done = this.readCues(session, track)
      .then((cues) => {
        // A refresh or a switch replaced the source while the track was read: this answer is for a track the session no longer has.
        if (this.entries.get(session) !== entry) return;
        if (cues.length === 0) {
          entry.list = NONE;
          return;
        }
        for (const cue of cues) learn(session, cue.picture);
        entry.list = { state: 'ready', source: 'provider', cues: cues.map((cue) => toPreviewCue(session.id, cue)) };
        this.changed(session);
      })
      .catch(() => {
        entry.list = NONE;
      });
    return entry;
  }

  /** The track's picture cues; [] (and one log line, without the address) when it gives none. Never rejects. */
  private async readCues(session: StreamSession, track: ThumbnailTrack): Promise<ThumbnailCue[]> {
    const provider = session.source.provider;
    const signal = AbortSignal.timeout(this.timeoutMs);
    let res: Response | null = null;
    const miss = async (reason: string): Promise<ThumbnailCue[]> => {
      await res?.body?.cancel().catch(() => undefined);
      this.log(`[notesd] previews: ${provider}'s preview track gives no frame: ${reason}`);
      return [];
    };
    const late = `it took longer than ${this.timeoutMs} ms`;
    try {
      res = await forward(session, { target: track.url, range: null, vtt: false, preview: 'track', signal }, this.fetchImpl);
      if (!res.ok) return await miss(signal.aborted ? late : `it answered ${res.status}`);
      const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      if (/^(?:text\/html|application\/xhtml|image\/|video\/|audio\/)/.test(type)) return await miss(`it answered ${type}`);
      if (Number(res.headers.get('content-length') ?? '0') > this.maxBytes) return await miss(`it is larger than ${this.maxBytes} bytes`);
      const text = await readCapped(res, this.maxBytes);
      if (text === null) return await miss(`it is larger than ${this.maxBytes} bytes`);
      const cues = parseThumbnailCues(text, track.url);
      return cues.length > 0 ? cues : await miss('it holds no picture cue');
    } catch {
      return miss(signal.aborted ? late : 'it could not be fetched');
    }
  }

  private changed(session: StreamSession): void {
    try {
      this.onChange(session);
    } catch {
      // A listener never fails a list.
    }
  }
}

/** The registry's provider source (sources.ts): the pass-through's fetch, and phase 1's change hook as `onChange`. */
export const providerSource: PreviewSourceFactory = (deps) => new ProviderPreviewSource({ fetch: deps.fetch, onChange: deps.changed, log: deps.log });
```
**Impact:** none until Step 9 registers it. `sources.ts` imports `providerSource` from here and this file imports
only the `PreviewSourceFactory` type from `sources.ts`: a type-only cycle, as phase 1's `cacheSource.ts` has.

### Step 9: The registry line
**File:** `src/directStream/previews/sources.ts` (phase 1's file, as phase 1 Step 9 writes it)
**Change:** one import after `import { cacheSource } from './cacheSource.js';`, and one line first in the list.
Phase 1 lands first and writes the list as:
```ts
export const PREVIEW_SOURCES: readonly PreviewSourceFactory[] = [
  cacheSource,
];
```
**Code:**
```ts
import { providerSource } from './providerSource.js';
```
```ts
export const PREVIEW_SOURCES: readonly PreviewSourceFactory[] = [
  providerSource,
  cacheSource,
];
```
**Impact:** with previews on, a pass-through session whose source names a track lists the track's frames. Phase 2
runs at the same time and adds `torrentSource` (with its import) before `cacheSource`. Whichever of the two merges
second keeps both lines; the list after both is:
```ts
export const PREVIEW_SOURCES: readonly PreviewSourceFactory[] = [
  providerSource,
  torrentSource,
  cacheSource,
];
```

### Step 10: The route reads `img=1`
**File:** `src/http/directStreamApi.ts`, the `GET /api/stream/sessions/:id/p` route (`:153-160` today; after phase 1 it
sits just below phase 1's two previews routes and one added import, about `:178-185`: find it by its path)
**Code:**
```ts
  r.get('/api/stream/sessions/:id/p', (c) => {
    const image = c.req.query('img') === '1';
    return service().passThrough(c.req.param('id'), {
      target: c.req.query('u') ?? '',
      range: image ? null : (c.req.header('range') ?? null),
      vtt: !image && c.req.query('vtt') === '1',
      ...(image ? { preview: 'image' as const } : {}),
      signal: c.req.raw.signal,
    });
  });
```
**Impact:** `DirectStreamService.passThrough` (`service.ts:1907`) is unchanged. It hands the request to
`observeForward`, which records the picture as kind `image`.

### Step 11: The route's reference entry
**File:** `scripts/docs/httpRoutes.ts`, the `'GET /api/stream/sessions/:id/p'` entry (`:254-255` today; `:258-259`
after phase 1's two previews entries above it)
**Code:**
```ts
      'GET /api/stream/sessions/:id/p':
        'The pass-through. Query: `u` (the stream host address), `vtt=1` (hand a subtitle file back as WebVTT), `img=1` (a picture of a provider\'s seek-preview track, as `GET /api/stream/sessions/:id/previews` lists it: sent with the headers the resolve captured for that track and without `Range`, answered only as a whole `image/*` body of at most 4 MiB, cacheable by the browser, and recorded in the evidence log as kind `image`, which never counts in a provider\'s delivery). Fetches `u` with only the `Referer`, `Origin` and `User-Agent` the resolve captured and the player\'s `Range`, and streams the answer back with the host\'s status, also in `X-Notesd-Upstream`. HLS playlists and DASH manifests come back with every address rewritten to this route. 403 `unknown_session`; 403 `forbidden_host`, and nothing is fetched, when `u` is not on a host the session\'s resolve returned or that a playlist, manifest, redirect or seek-preview track fetched through the session named. 502 `upstream_error`; with `img=1`, 502 `not_an_image` (the host answered no picture) or `image_too_large`.',
```
Then run `npm run docs:gen` to regenerate `docs/guide/reference/http-api.md`. Never hand-edit that file.
**Impact:** `tests/unit/docs/reference.test.ts` stays green.

### Step 11b: The previews route's entry names the provider
**File:** `scripts/docs/httpRoutes.ts`, the `'GET /api/stream/sessions/:id/previews'` entry phase 1 added (phase 1
Step 17, after the `'GET /api/stream/sessions/:id'` entry)
**Change:** in that string, replace phase 1's sentence
```
`source` is `local`: sprite sheets made on this machine from the video of the film the session plays (the stream cache it plays from, or a torrent\'s file or remux).
```
with
```
`source` is `provider` (the stream\'s own seek-preview track, asked first: each cue\'s `url` is the pass-through with `img=1`; the track is read once per session source with the headers the resolve captured for it, at most 2 MiB in 15 s, and a track that cannot be read, is too big or names no picture with an `#xywh` rectangle gives no frame) or `local` (sprite sheets made on this machine from the video of the film the session plays: the stream cache it plays from, or a torrent\'s file or remux).
```
Nothing else in the entry changes. Then `npm run docs:gen` (once, with Step 11's).
**Impact:** the generated reference names both sources; `tests/unit/docs/reference.test.ts` stays green.

### Step 12: The fixture resolver and stream host
**Files:** `tests/fixtures/direct-stream/fake-cli.mjs:1-15` (header comment), `:86-110`; `tests/fixtures/direct-stream/upstream.mjs:37-38`, `:202-214`
**Change:** `<dir>/thumbs`, naming a file under the host's `/thumbs/`, makes the next resolve answer that seek-preview
track, with the embed's headers. The host's referer check (`upstream.mjs:241`) applies to the track and its pictures
too, so a request sent with the wrong headers gets a 403.
**Code:** in `fake-cli.mjs`'s header comment, after the `calls.jsonl` lines (`:12-13`):
```js
//   thumbs         a name under upstream.mjs's /thumbs/ (thumbs.vtt, whole.vtt, words.vtt, page.vtt, big.vtt, or a
//                  missing one such as gone.vtt): the resolve's source names that seek-preview track, with the
//                  embed's headers; no file, no track
```
After `const noSubtitle = ...` (`:85`):
```js
  // <dir>/thumbs: the page loaded that seek-preview track (resolve.mjs thumbnailTrack).
  const thumbsFile = path.join(dir, 'thumbs');
  const thumbs = existsSync(thumbsFile) ? readFileSync(thumbsFile, 'utf8').trim() : '';
```
In the printed `source`, after `en_subtitle: !noSubtitle,` (`:105`):
```js
      ...(thumbs !== '' ? { thumbnails: { url: `${origin}/thumbs/${thumbs}`, referer: FIXTURE_REFERER, origin: FIXTURE_ORIGIN, user_agent: FIXTURE_USER_AGENT } } : {}),
```
In `upstream.mjs`, after `const SRT = ...` (`:38`):
```js
// A player's seek-preview track and its pictures (fake-cli.mjs's <dir>/thumbs names the track a resolve answers).
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const THUMBS_VTT = ['WEBVTT', '', '00:00:00.000 --> 00:00:04.000', 'sprite-0.png#xywh=0,0,160,90', '', '00:00:04.000 --> 00:00:08.000', 'sprite-0.png#xywh=160,0,160,90', ''].join('\n');
const WHOLE_VTT = ['WEBVTT', '', '00:00:00.000 --> 00:00:04.000', 'sprite-0.png', '', '00:00:04.000 --> 00:00:08.000', 'sprite-1.png', ''].join('\n');
let bigVtt = null;

/** /thumbs/...: [status, type, body], or null (404). */
function thumbsAnswer(pathname) {
  switch (pathname) {
    case '/thumbs/thumbs.vtt':
      return [200, 'text/vtt', THUMBS_VTT];
    case '/thumbs/whole.vtt':
      return [200, 'text/vtt', WHOLE_VTT];
    case '/thumbs/words.vtt':
      return [200, 'text/vtt', VTT];
    case '/thumbs/page.vtt':
      return [200, 'text/html; charset=utf-8', '<!doctype html><title>Just a moment...</title>'];
    case '/thumbs/big.vtt':
      bigVtt ??= `WEBVTT\n\nNOTE ${'x'.repeat(3 * 1024 * 1024)}\n`;
      return [200, 'text/vtt', bigVtt];
    case '/thumbs/sprite-0.png':
    case '/thumbs/sprite-1.png':
      return [200, 'image/png', PNG_1PX];
    case '/thumbs/page.png':
      return [200, 'text/html; charset=utf-8', '<!doctype html><title>Not found</title>'];
    default:
      return null;
  }
}
```
In `answer()` (`:202`), first line of the body:
```js
  const thumbs = thumbsAnswer(pathname);
  if (thumbs !== null) return thumbs;
```
**Impact:** without a `thumbs` file, the fake resolver answers as before, so no existing test or journey changes.

### Step 13: The provider source's tests
**File:** `tests/unit/directStream/previews/providerSource.test.ts` (new)
**Code:**
```ts
import { describe, expect, it, vi } from 'vitest';
import { forward, type FetchLike } from '../../../../src/directStream/passThrough.js';
import {
  PROVIDER_TRACK_MAX_BYTES,
  ProviderPreviewSource,
  parseThumbnailCues,
} from '../../../../src/directStream/previews/providerSource.js';
import { proxiedUrl } from '../../../../src/directStream/rewrite.js';
import { SessionStore, allows, type StreamSession } from '../../../../src/directStream/sessions.js';
import type { ResolvedSource, StreamRef } from '../../../../src/directStream/types.js';

const REF: StreamRef = { kind: 'movie', tmdbId: 550 };
const TRACK = 'https://img.example/vd/abc/thumbs/thumbs.vtt?tok=TRACKTOKEN';
const TRACK2 = 'https://img2.example/vd/abc/thumbs.vtt';
const SOURCE: ResolvedSource = {
  provider: 'VidFast',
  embed_url: 'https://vidfast.example/movie/550',
  manifest_url: 'https://cdn.example/hls/master.m3u8',
  manifest_kind: 'hls',
  headers: { referer: 'https://vidfast.example/', origin: 'https://vidfast.example', user_agent: 'Chrome/142' },
  subtitles: [],
  best_height: 1080,
  en_subtitle: false,
  took_s: 2,
  thumbnails: { url: TRACK, referer: 'https://player.example/', origin: 'https://player.example', user_agent: 'Chrome/142 player' },
};
const NONE = { state: 'none', source: null, cues: [] };
// Out of order on purpose; the third picture is on a host only the track names.
const SPRITES = [
  'WEBVTT',
  '',
  '00:00:10.000 --> 00:00:20.000',
  'sprite-1.jpg#xywh=160,0,160,90',
  '',
  '00:00.000 --> 00:10.000',
  'sprite-1.jpg#xywh=0,0,160,90',
  '',
  '00:00:20.000 --> 00:00:30.000 align:start',
  'https://pics.example/s/sprite-2.jpg#xywh=pixel:0,0,160,90',
  '',
].join('\n');

interface Seen {
  url: string;
  headers: Record<string, string>;
}

function host(answer: (url: string, init: RequestInit) => Response | Promise<Response>): { fetchImpl: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    fetchImpl: async (url, init) => {
      seen.push({ url, headers: { ...(init.headers as Record<string, string>) } });
      return answer(url, init);
    },
  };
}

const vtt = (body: string, headers: Record<string, string> = {}): Response => new Response(body, { status: 200, headers: { 'content-type': 'text/vtt', ...headers } });

function live(source: ResolvedSource = SOURCE): { store: SessionStore; session: StreamSession } {
  const store = new SessionStore();
  return { store, session: store.create(REF, source, []) };
}

function made(opts: { fetchImpl: FetchLike; maxBytes?: number; timeoutMs?: number; waitMs?: number }): { source: ProviderPreviewSource; changed: StreamSession[]; lines: string[] } {
  const changed: StreamSession[] = [];
  const lines: string[] = [];
  const source = new ProviderPreviewSource({
    fetch: opts.fetchImpl,
    onChange: (s) => changed.push(s),
    log: (line) => lines.push(line),
    maxBytes: opts.maxBytes,
    timeoutMs: opts.timeoutMs ?? 2_000,
    waitMs: opts.waitMs ?? 2_000,
  });
  return { source, changed, lines };
}

describe("a provider's seek-preview track (R1.4)", () => {
  it("lists its frames, sorted, as pass-through addresses with img=1, read once with the track's own headers", async () => {
    const { fetchImpl, seen } = host(() => vtt(SPRITES));
    const { source, changed } = made({ fetchImpl });
    const { session } = live();
    const list = await source.list(session);
    expect(list).toEqual({
      state: 'ready',
      source: 'provider',
      cues: [
        { start_s: 0, end_s: 10, url: `${proxiedUrl(session.id, 'https://img.example/vd/abc/thumbs/sprite-1.jpg')}&img=1`, x: 0, y: 0, w: 160, h: 90 },
        { start_s: 10, end_s: 20, url: `${proxiedUrl(session.id, 'https://img.example/vd/abc/thumbs/sprite-1.jpg')}&img=1`, x: 160, y: 0, w: 160, h: 90 },
        { start_s: 20, end_s: 30, url: `${proxiedUrl(session.id, 'https://pics.example/s/sprite-2.jpg')}&img=1`, x: 0, y: 0, w: 160, h: 90 },
      ],
    });
    expect(await source.list(session)).toEqual(list);
    expect(seen).toEqual([{ url: TRACK, headers: { referer: 'https://player.example/', origin: 'https://player.example', 'user-agent': 'Chrome/142 player' } }]);
    expect(changed).toEqual([session]);
  });

  it('lets the session reach the hosts the track named, and no other', async () => {
    const { fetchImpl } = host(() => vtt(SPRITES));
    const { source } = made({ fetchImpl });
    const { session } = live();
    expect(allows(session, TRACK)).toBe(true);
    expect(allows(session, 'https://pics.example/s/sprite-2.jpg')).toBe(false);
    await source.list(session);
    expect(allows(session, 'https://pics.example/s/sprite-2.jpg')).toBe(true);
    const other = host(() => new Response('x', { headers: { 'content-type': 'image/png' } }));
    const res = await forward(session, { target: 'https://elsewhere.example/s.png', range: null, vtt: false, preview: 'image', signal: new AbortController().signal }, other.fetchImpl);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'forbidden_host' });
    expect(other.seen).toEqual([]);
  });

  it('lists nothing and fetches nothing for a source with no track, a cache or a torrent', async () => {
    const { fetchImpl, seen } = host(() => vtt(SPRITES));
    const { source } = made({ fetchImpl });
    expect(await source.list(live({ ...SOURCE, thumbnails: null }).session)).toEqual(NONE);
    const { session: cached } = live();
    cached.cache = { id: 'c1', state: 'ready', height: 1080, manifestUrl: '/api/stream/cache/c1/f/master.m3u8', subtitles: [] };
    expect(await source.list(cached)).toEqual(NONE);
    expect(seen).toEqual([]);
  });

  it("reads a refreshed source's own track, and drops the frames when the new source has none", async () => {
    const { fetchImpl, seen } = host((url) => vtt(url === TRACK2 ? SPRITES.replaceAll('sprite-1.jpg', 'next.jpg') : SPRITES));
    const { source, changed } = made({ fetchImpl });
    const { store, session } = live();
    await source.list(session);
    store.replaceSource(session, { ...SOURCE, thumbnails: { url: TRACK2, referer: null, origin: null, user_agent: null } }, []);
    const next = await source.list(session);
    expect(seen.map((s) => s.url)).toEqual([TRACK, TRACK2]);
    expect(next.cues[0]?.url).toBe(`${proxiedUrl(session.id, 'https://img2.example/vd/abc/next.jpg')}&img=1`);
    store.replaceSource(session, { ...SOURCE, thumbnails: null }, []);
    expect(await source.list(session)).toEqual(NONE);
    // frames came (1), the old frames went and new ones came (2, 3), the frames went (4)
    expect(changed).toHaveLength(4);
  });

  it('answers without the track while it is still read, then tells the change and lists it', async () => {
    let release: (res: Response) => void = () => undefined;
    const { fetchImpl } = host(() => new Promise<Response>((resolve) => { release = resolve; }));
    const { source, changed } = made({ fetchImpl, waitMs: 10 });
    const { session } = live();
    expect(await source.list(session)).toEqual(NONE);
    release(vtt(SPRITES));
    await vi.waitFor(() => expect(changed).toEqual([session]));
    expect((await source.list(session)).cues).toHaveLength(3);
  });
});

describe('a track that gives no frame (R2.6)', () => {
  const big = 'WEBVTT\n\n' + 'x'.repeat(4096);
  const cases: Array<[string, (url: string, init: RequestInit) => Response | Promise<Response>, number?]> = [
    ['cannot be reached', () => Promise.reject(new Error('ECONNREFUSED'))],
    ['answers 404', () => new Response('gone', { status: 404, headers: { 'content-type': 'text/plain' } })],
    ['is an HTML page', () => new Response('<!doctype html><title>Just a moment...</title>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })],
    ['says it is over the size limit', () => vtt(SPRITES, { 'content-length': String(PROVIDER_TRACK_MAX_BYTES + 1) })],
    ['runs over the size limit', () => vtt(big), 1024],
    ['holds words, not pictures', () => vtt('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello.\n')],
    ['names whole pictures with no rectangle', () => vtt('WEBVTT\n\n00:00.000 --> 00:10.000\nsprite-0.jpg\n\n00:10.000 --> 00:20.000\nsprite-1.jpg\n')],
    ['is not WebVTT', () => vtt('sprite-0.jpg#xywh=0,0,160,90\n')],
    [
      'takes longer than the time limit',
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ],
  ];
  it.each(cases)('lists no frame from a track that %s, lets no picture host in and logs one line without its address', async (_name, answer, maxBytes) => {
    const { fetchImpl, seen } = host(answer);
    const { source, changed, lines } = made({ fetchImpl, maxBytes, timeoutMs: 50 });
    const { session } = live();
    expect(await source.list(session)).toEqual(NONE);
    expect(await source.list(session)).toEqual(NONE);
    expect(seen).toHaveLength(1);
    expect(changed).toEqual([]);
    expect(allows(session, 'https://img.example/vd/abc/thumbs/sprite-0.jpg')).toBe(true); // the track's own host, from the resolve
    expect(allows(session, 'https://pics.example/s/sprite-2.jpg')).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("VidFast's preview track gives no frame");
    expect(lines[0]).not.toContain('TRACKTOKEN');
  });
});

describe('parseThumbnailCues', () => {
  it('keeps picture cues only, sorted, and never overlapping', () => {
    const text = [
      '﻿WEBVTT',
      '',
      '1',
      '00:00:00.000 --> 00:00:10.000',
      'a.jpg#xywh=0,0,160,90',
      '',
      '00:00:08.000 --> 00:00:20.000',
      'a.jpg#xywh=160,0,160,90',
      '',
      '00:00:12.000 --> 00:00:18.000',
      'a.jpg#xywh=320,0,160,90',
      '',
      '00:00:30.000 --> 00:00:30.000',
      'a.jpg#xywh=0,90,160,90',
      '',
      '00:00:40.000 --> 00:00:50.000',
      'a.jpg#xywh=percent:0,0,50,50',
      '',
      '00:00:50.000 --> 00:01:00.000',
      'a.jpg#xywh=0,0,0,90',
      '',
      '00:01:00.000 --> 00:01:10.000',
      'data:image/png;base64,AAAA#xywh=0,0,160,90',
      '',
    ].join('\r\n');
    expect(parseThumbnailCues(text, 'https://img.example/t/thumbs.vtt')).toEqual([
      { start_s: 0, end_s: 10, picture: 'https://img.example/t/a.jpg', x: 0, y: 0, w: 160, h: 90 },
      { start_s: 10, end_s: 20, picture: 'https://img.example/t/a.jpg', x: 160, y: 0, w: 160, h: 90 },
    ]);
  });
});
```
**Impact:** `npx vitest run tests/unit/directStream/previews/providerSource.test.ts` passes.

### Step 14: The pass-through's picture tests
**File:** `tests/unit/directStream/passThroughPreview.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { observeForward, parseEvidenceLine, type EvidenceInput, type EvidenceSink } from '../../../src/directStream/evidence.js';
import { PREVIEW_IMAGE_MAX_BYTES, forward, type FetchLike, type ForwardRequest } from '../../../src/directStream/passThrough.js';
import { SessionStore, type StreamSession } from '../../../src/directStream/sessions.js';
import type { ResolvedSource, StreamRef } from '../../../src/directStream/types.js';

const REF: StreamRef = { kind: 'movie', tmdbId: 550 };
const SOURCE: ResolvedSource = {
  provider: 'VidFast',
  embed_url: 'https://vidfast.example/movie/550',
  manifest_url: 'https://cdn.example/hls/master.m3u8',
  manifest_kind: 'hls',
  headers: { referer: 'https://vidfast.example/', origin: 'https://vidfast.example', user_agent: 'Chrome/142' },
  subtitles: [],
  best_height: 1080,
  en_subtitle: false,
  took_s: 2,
  thumbnails: { url: 'https://cdn.example/thumbs/thumbs.vtt', referer: 'https://player.example/', origin: null, user_agent: 'Chrome/142 player' },
};
const PIC = 'https://cdn.example/thumbs/sprite-0.jpg';

function session(): StreamSession {
  return new SessionStore().create(REF, SOURCE, []);
}

function req(target: string, over: Partial<ForwardRequest> = {}): ForwardRequest {
  return { target, range: null, vtt: false, signal: new AbortController().signal, ...over };
}

function host(make: () => Response): { fetchImpl: FetchLike; sent: Array<Record<string, string>> } {
  const sent: Array<Record<string, string>> = [];
  return {
    sent,
    fetchImpl: async (_url, init) => {
      sent.push({ ...(init.headers as Record<string, string>) });
      return make();
    },
  };
}

const jpeg = (bytes: number, headers: Record<string, string> = {}): Response => new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'image/jpeg', ...headers } });

describe('a seek-preview picture through the pass-through (img=1)', () => {
  it("comes back whole with its type, sent with the track's headers and no Range, cacheable by the browser", async () => {
    const { fetchImpl, sent } = host(() => jpeg(1234));
    const res = await forward(session(), req(PIC, { preview: 'image', range: 'bytes=0-9' }), fetchImpl);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe('private, max-age=86400');
    expect((await res.arrayBuffer()).byteLength).toBe(1234);
    expect(sent).toEqual([{ referer: 'https://player.example/', 'user-agent': 'Chrome/142 player' }]);
  });

  it.each([
    ['an HTML page', () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['a refusal', () => new Response('no', { status: 403, headers: { 'content-type': 'image/jpeg' } })],
    ['an answer with no type', () => new Response('??', { status: 200 })],
  ])('refuses %s with 502 not_an_image', async (_name, make) => {
    const res = await forward(session(), req(PIC, { preview: 'image' }), host(make).fetchImpl);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'not_an_image' });
  });

  it('refuses a picture over the size limit, said or streamed, with 502 image_too_large', async () => {
    const said = await forward(session(), req(PIC, { preview: 'image' }), host(() => jpeg(10, { 'content-length': String(PREVIEW_IMAGE_MAX_BYTES + 1) })).fetchImpl);
    expect(said.status).toBe(502);
    expect(await said.json()).toMatchObject({ error: 'image_too_large' });
    const streamed = await forward(session(), req(PIC, { preview: 'image' }), host(() => jpeg(PREVIEW_IMAGE_MAX_BYTES + 1)).fetchImpl);
    expect(streamed.status).toBe(502);
    expect(await streamed.json()).toMatchObject({ error: 'image_too_large' });
  });

  it("leaves a play's request as it was: the manifest's headers and the player's Range", async () => {
    const { fetchImpl, sent } = host(() => new Response(new Uint8Array(10), { status: 206, headers: { 'content-type': 'video/mp2t' } }));
    const res = await forward(session(), req('https://cdn.example/hls/seg1.ts', { range: 'bytes=0-9' }), fetchImpl);
    expect(res.status).toBe(206);
    expect(sent).toEqual([{ referer: 'https://vidfast.example/', origin: 'https://vidfast.example', 'user-agent': 'Chrome/142', range: 'bytes=0-9' }]);
  });

  it('is recorded as kind image, which the evidence log reads back', async () => {
    const records: EvidenceInput[] = [];
    const sink: EvidenceSink = { record: (r) => records.push(r) };
    const res = await observeForward(session(), req(PIC, { preview: 'image' }), host(() => jpeg(100)).fetchImpl, sink);
    await res.arrayBuffer();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: 'request', kind: 'image', status: 200, outcome: 'end', bytes: 100 });
    expect(parseEvidenceLine(JSON.stringify({ ...records[0], at: '2026-11-20T12:00:00.000Z' }))).toMatchObject({ kind: 'image' });
  });
});
```
**Impact:** `npx vitest run tests/unit/directStream/passThroughPreview.test.ts` passes.

### Step 15: A picture never counts in delivery
**File:** `tests/unit/directStream/delivery.test.ts` (inside `describe('a provider\'s delivery, from the evidence log')`, before its closing `});`)
**Code:**
```ts
  it("never counts a seek-preview picture (kind image) in a provider's delivery", () => {
    const pictures = many(DELIVERY_MIN_REQUESTS * 2, (i) => request('s1', 'VidFast', 10 - i / 10, 502, { kind: 'image', path: '/thumbs/sprite-1.jpg' }));
    expect(deliveryByProvider(pictures, NOW).has('VidFast')).toBe(false);
    const withSegments = [...pictures, ...many(DELIVERY_MIN_REQUESTS, (i) => request('s1', 'VidFast', 5 - i / 10, 200))];
    expect(deliveryByProvider(withSegments, NOW).get('VidFast')).toMatchObject({ verdict: 'good', requests: DELIVERY_MIN_REQUESTS, failed: 0 });
  });
```
**Impact:** this test keeps `delivery.ts:84` from ever counting a picture.

### Step 15b: A stream-bug report leaves the preview pictures out
**File:** `claude/skills/report-stream-bug/diagnose.mjs:159-161`; `tests/unit/scripts/reportStreamBug.test.ts`
(inside `describe('diagnose.mjs')`)
**Change:** this phase creates evidence kind `image`. `readFolder` keeps every `request` record as a pass-through
answer of the play (`passes`), and `facts` counts each in `failures` and in its host's answers (`diagnose.mjs:395-409`),
so a failing seek-preview picture would read as a failed request of the stream host. A picture is not the play's
request: `isPass` leaves kind `image` out, which takes it out of every count at once.
**Code:**
```js
/** A pass-through answer of the play: a seek-preview picture (kind `image`, never part of the play) is not one. */
function isPass(r) {
  return r[R.type] === FIELDS.types.request && r[R.kind] !== 'image';
}
```
Test (copies a fixture folder, adds failing picture records to its evidence, and checks they change nothing):
```ts
  it('leaves the seek-preview pictures (kind image) out of the pass-through answers and the cause', () => {
    const from = path.join(FIXTURES, 'host_slow');
    const plain = readFolder(from);
    const dir = mkdtempSync(path.join(tmpdir(), 'stream-report-image-'));
    for (const name of readdirSync(from)) writeFileSync(path.join(dir, name), readFileSync(path.join(from, name)));
    const first = plain.passes[0] as Record<string, unknown>;
    const pictures = Array.from({ length: 30 }, (_, i) =>
      JSON.stringify({ ...first, kind: 'image', path: `/thumbs/sprite-${i}.jpg`, status: 502, outcome: 'error', bytes: 0 }),
    );
    writeFileSync(path.join(dir, 'evidence.jsonl'), `${readFileSync(path.join(from, 'evidence.jsonl'), 'utf8').trimEnd()}\n${pictures.join('\n')}\n`);
    const withPictures = readFolder(dir);
    expect(withPictures.passes).toHaveLength(plain.passes.length);
    expect(classify(withPictures).cause).toBe(classify(plain).cause);
  });
```
(`mkdtempSync`, `readdirSync`, `readFileSync`, `writeFileSync`, `tmpdir` and `path` are already imported at the top of
the test file.)
**Impact:** `npx vitest run tests/unit/scripts/reportStreamBug.test.ts` passes; a report of a play with failing
preview pictures names the same cause as one without them.

### Step 16: Whole-tree check
Run `npm run typecheck`, `npm test` and `npm run docs:check`.

## Principles applied

- Boundary discipline: `thumbnails` is validated and normalized once, in `parseResolveOutput`. zod `.catch(null)` and `absoluteHttp` turn anything that does not fit into null, so a bad field never fails a resolve. Inside the daemon, `session.source.thumbnails` is trusted as a whole track or null. The track text is parsed in one place (`parseThumbnailCues`), and the picture answer is checked in one place (`answerImage`).
- Make illegal states unrepresentable: `ForwardRequest.preview` is one field, `'track' | 'image'`, not two booleans, and the route turns `vtt` off when `img=1`. `ThumbnailTrack` has a required `url`: the source carries a whole track or null, never a header set without an address.
- Laziness protocol: `delivery.ts` already counts only `kind === 'media'`, so it gets a test, not an edit. The track is read through the existing `forward()` (host check, redirects, header rule) instead of a second fetch path. `readCapped` is split and exported instead of copied. A `WeakMap` keyed by session replaces a session-end listener.
- Test behavior, not implementation: the tests drive the public `list()`, `forward()`, `observeForward()` and `deliveryByProvider()` through a fake stream host. They assert the requests the host saw, the answers and the hosts the session may reach, not private calls.
- Prove it works: the fixture resolver and stream host learn the seek-preview track, so the journeys run the real daemon's previews route, pass-through and evidence log, not only unit tests.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` (includes `tests/unit/docs/reference.test.ts`). The focused run is `npx vitest run tests/unit/scripts/reportStreamBug.test.ts tests/unit/scripts/directResolve.test.ts tests/unit/directStream/runner.test.ts tests/unit/directStream/previews/providerSource.test.ts tests/unit/directStream/passThroughPreview.test.ts tests/unit/directStream/delivery.test.ts tests/unit/directStream/evidence.test.ts`
**Proof:** a throwaway daemon plays a title whose fake resolve names a seek-preview track on the fixture stream
host. The previews route lists the track's frames as `img=1` pass-through addresses, which answer pictures. Bad
tracks list nothing and leave nothing in the evidence log.
- Harness: `.claude/skills/verify-notesd`. Every journey runs from the worktree root
  `/home/miftah/.worktrees/mcp-notes/seek-preview-thumbnails`, with `V=.claude/skills/verify-notesd/scripts/verify.sh`. Start one run for J1 and J2:
  `eval "$(NOTESD_STREAM_PREVIEWS=on $V up --direct-stream | grep -E '^(RUN|URL)=')"; D=~/.local/state/notesd-verify/$RUN/direct; printf 'hls\n' >"$D/mode"`
  (verify.sh keeps previews off unless the caller sets `NOTESD_STREAM_PREVIEWS=on`, which passes through). A play is
  `SID=$($V api "$RUN" POST /api/stream/play '{"kind":"movie","tmdb_id":550}' | sed '1,/^< HTTP /d' | jq -r .session.session_id)`. Run `$V down "$RUN"` at the end.
- Feature-map entries: `features/direct-streaming.md` ("Stream cache" and the pass-through journeys, read only). The "Seek previews" entry is phase 5's (see Handoffs).
- Journeys:
  - **J1** · traces R1.4 — `printf 'thumbs.vtt\n' >"$D/thumbs"`; play (SID); then
    `for i in $(seq 1 20); do P=$(curl -s "$URL/api/stream/sessions/$SID/previews"); [ "$(jq -r .state <<<"$P")" = ready ] && break; sleep 0.5; done; jq -c --arg sid "$SID" '{state,source,n:(.cues|length),first:(.cues[0]|{start_s,end_s,x,y,w,h}),img:(.cues|all(.url|startswith("/api/stream/sessions/"+$sid+"/p?u=") and endswith("&img=1")))}' <<<"$P"`;
    `curl -s "$URL/api/stream/sessions/$SID/previews" >/dev/null`;
    `curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "$URL$(jq -r '.cues[0].url' <<<"$P")"`;
    `curl -s -o /dev/null -w '%{http_code}\n' "$URL/api/stream/sessions/$SID/p?u=$(jq -rn --arg u "$(jq -r .origin "$D/upstream.json")/thumbs/page.png" '$u|@uri')&img=1"`;
    `curl -s -o /dev/null -w '%{http_code}\n' "$URL/api/stream/sessions/$SID/p?u=$(jq -rn '"http://198.51.100.7/s.png"|@uri')&img=1"`;
    `jq -c 'select(.path|startswith("/thumbs/"))|{path,referer,status}' "$D/upstream.jsonl"`;
    `curl -s "$URL/api/stream/evidence?session=$SID" | jq -c '[.records[]|select(.type=="request" and ((.path//"")|startswith("/thumbs/")))|{path,kind,status}]'`
    → passes when:
    - the first line is `{"state":"ready","source":"provider","n":2,"first":{"start_s":0,"end_s":4,"x":0,"y":0,"w":160,"h":90},"img":true}`;
    - the picture prints `200 image/png`, `page.png` prints `502` and the host the track never named prints `403`;
    - `upstream.jsonl` holds exactly one `/thumbs/thumbs.vtt` line, although the previews were read twice, and its referer is `https://embed.fixture/`, status 200. It also holds one `/thumbs/sprite-0.png` (200) and one `/thumbs/page.png` line;
    - the evidence prints `[{"path":"/thumbs/sprite-0.png","kind":"image","status":200},{"path":"/thumbs/page.png","kind":"image","status":200}]`, with no record of the track itself.
  - **J2** · traces R2.6 — on the same run:
    `for T in gone.vtt page.vtt big.vtt words.vtt whole.vtt; do printf '%s\n' "$T" >"$D/thumbs"; SID=$($V api "$RUN" POST /api/stream/play '{"kind":"movie","tmdb_id":550}' | sed '1,/^< HTTP /d' | jq -r .session.session_id); curl -s "$URL/api/stream/sessions/$SID/previews" >/dev/null; for i in $(seq 1 20); do grep -q "\"path\":\"/thumbs/$T\"" "$D/upstream.jsonl" && break; sleep 0.5; done; sleep 1; echo "$T $(curl -s "$URL/api/stream/sessions/$SID/previews" | jq -c '{state,source,cues}') $(curl -s "$URL/api/stream/evidence?session=$SID" | jq '[.records[]|select(.type=="request" and ((.path//"")|startswith("/thumbs/")))]|length')"; done; grep -c "preview track gives no frame" ~/.local/state/notesd-verify/$RUN/daemon.log || true`
    → passes when each of the five lines reads `<T> {"state":"none","source":null,"cues":[]} 0`. The track was fetched (404, an HTML page, over 2 MiB, words, whole pictures with no rectangle), no frame is listed and the evidence log holds nothing for it. The daemon-log count is informational: the log file's name comes from the harness.
  - **J3** · traces R2.6 — `npx vitest run tests/unit/directStream/delivery.test.ts tests/unit/directStream/passThroughPreview.test.ts tests/unit/directStream/previews/providerSource.test.ts tests/unit/scripts/reportStreamBug.test.ts` → passes when every test passes, including:
    - "never counts a seek-preview picture (kind image) in a provider's delivery";
    - "leaves the seek-preview pictures (kind image) out of the pass-through answers and the cause";
    - the nine "lists no frame from a track that …" cases, the time limit among them, each with one log line that carries no address token.
- Neighbor check: the pass-through and the evidence log are what this phase changes under every cloud play. On a
  fresh run with no `thumbs` file, `eval "$($V up --direct-stream | grep -E '^(RUN|URL)=')"; .claude/skills/verify-notesd/scripts/direct-stream/journey.sh "$RUN"; $V down "$RUN"` passes when it prints no `journey: FAIL` line and exits 0 (all eight stages: seed, hls, dash, refuse, evidence, playerlog, snapshot, unwritable).
- Cost: none. No paid model turns; the fake resolver and the fixture host are local.

**Exit criteria:**
- A resolve whose page loaded `thumbs.vtt` gives a session whose previews are `source: "provider"`, with
  `img=1` pass-through addresses that answer pictures.
- A track that is HTML, too big, unreachable, words or whole pictures without a rectangle gives `none`, and
  leaves no evidence record and no learned host.
- No request leaves for a host the track did not name.
- `npm run typecheck`, `npm test` and `npm run docs:check` pass.

## Handoffs

- **Index (settled by the reconciler):** the whole-picture-per-cue exception is dropped from the index's Phase 3
  block: such cues are never listed (see the Decision above).
- **Phase 1 (settled by the reconciler):** A1 to A6 are phase 1's plan as reconciled: `deps.fetch`,
  `deps.changed`, `deps.log`; the position answer never awaits `list()`; verify runs build previews only with
  `NOTESD_STREAM_PREVIEWS=on` from the caller.
- **Phase 4:** a provider cue's `url` is `/api/stream/sessions/<id>/p?u=<encoded>&img=1`, used as is (it passes
  phase 4's same-origin path check). The answer is cacheable (`private, max-age=86400`). A failed picture is a 502
  JSON body, which phase 4's `Image()` probe takes as a failed load (R2.1). The fixture's pictures are a 1×1 PNG, so a
  rectangle drawn from them is blank. That is fine for the route proofs, but not for a picture of the hover box.
- **Phase 5:**
  - `docs/guide/streaming.md` prose: the provider track as a source, `img=1`, evidence kind `image` (not counted in
    delivery, left out of a stream-bug report), whole-picture cues not listed, the 2 MiB track and 4 MiB picture
    limits, the 15 s read.
  - The "Seek previews" entry in `.claude/skills/verify-notesd/features/direct-streaming.md` can lift J1 and J2
    as written; the fixture's `<dir>/thumbs` switch is described in `fake-cli.mjs`'s header.
  - `CLAUDE.md`'s Streaming rules ("Every request to a stream host for a provider's track goes through the
    pass-through with the headers the resolve captured") belong to phase 5.
- **Not done (no criterion needs it):** `evidence.ts sessionSource` (the snapshot) does not name the seek-preview
  track; adding it (host and path only) would help a bug report.

## Rollback

Revert this phase's commits. The resolver's `thumbnails` is optional, and an older daemon's zod strips it, so a
newer resolver still works with the reverted daemon. Evidence lines with `kind: "image"` written before the revert
are skipped by the reverted daemon's reader (`parseEvidenceLine` returns null for them). They are rotated away with
the log. Nothing is written to the database or to disk by this phase. With phase 1 kept, the registry loses its
first line, and pass-through sessions then list no frame (the cache source answers only a session that plays from
its cache).
