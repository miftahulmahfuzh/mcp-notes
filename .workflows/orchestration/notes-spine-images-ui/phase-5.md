# Phase 5: Image HTTP routes + upload, MCP image tools, image/date filters

**Plan set:** `NOTES_SPINE_IMAGES_UI_PLAN.md`
**Analysis:** `docs/analyzer/20261030-092006-K7N3_code_analyzer.md`
**Satisfies:** R2. Claude can save an image from a path, look at saved pictures, and filter by "has an image" and by EXIF taken date. The browser can upload images and fetch original, display, thumbnail and preview by note id. A missing file gives a clean "not on this machine" answer.
**Depends on:** Phase 4 (and through it Phases 1 and 2)
**Difficulty:** NORMAL
**Package:** `src/http/images.ts`, `src/mcp/imageTools.ts`, `src/notes/repo.ts`

---

## Goal

After this phase `notesd` serves image bytes by note id (`original`, `display`, `thumb`, `preview`)
with correct types, ETags and caching. It accepts multipart uploads at `POST /api/images`, and
returns a JSON 404 `{error:'not_on_this_machine', host}` when the file lives on another machine.
Claude gets two new MCP tools: `create_image` (local path → image note, dedupe-aware, source not
moved) and `view_images` (ids → MCP `image` content of the preview plus metadata text). It also
gets `has_image` and `taken_from`/`taken_to` filters on `list` and `search`, and a server
instructions paragraph that explains the image workflow.

## Plans this was written against

Reconciled against the phase-1, phase-2 and phase-4 plans (the reconciler rewrote this plan's
adapter, filters, harness and tests to their real exports). Every call into `src/images/*` still
goes through one file, `src/http/imageAccess.ts`, which the routes and the MCP tools share.

The coordinator's change after commit `30a58fd` (3-way visibility mode) is applied here:
**Phase 2 owns the repo-level `hasImage?: boolean` option** on list/search (true / false /
undefined = all). This phase does **not** implement `hasImage` in `repo.ts`. It only exposes
`has_image` in the MCP zod schemas and maps it to `hasImage`. This phase adds `takenFrom` /
`takenTo` to the repo, reusing phase 2's `parseDateBound` (same semantics as `from`/`to`).

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.

**Creates:**
- `src/http/images.ts`: `imageRoutes(deps: AppDeps, opts?: ImageRouteOptions): Hono` (fills P2's empty router factory; P2's `createApp` calls `imageRoutes(deps)`), `interface ImageRouteOptions { maxUploadBytes?: number }`
- HTTP routes: `POST /api/images`, `GET /api/notes/:id/original`, `GET /api/notes/:id/display`, `GET /api/notes/:id/thumb`, `GET /api/notes/:id/preview`
- `src/http/imageAccess.ts` (new): `MAX_IMAGE_BYTES`, `type ImageVariant`, `interface ServedFile`, `type ResolveResult`, `class ImageInputError`, `toolImageDeps(deps: ToolDeps): ImageDeps`, `resolveImageFile(img, rawId, variant)`, `ingestFromUpload()`, `ingestFromPath()`, `expandHome()`, `etagMatches()`
- `src/mcp/imageTools.ts`: real `registerImageTools(server, deps: ToolDeps)`, `VIEW_IMAGES_MAX = 8`, `describeImageNote(note: Note)`
- MCP tools: `create_image`, `view_images`
- `src/notes/repo.ts`: `takenFrom?: string`, `takenTo?: string` on P2's `NoteFilter`, two conditions in P2's `filterConditions`
- `src/mcp/tools.ts`: `has_image`, `taken_from`, `taken_to` in P2's `noteFilterShape` / `FilterArgs` / `toFilter`; `IMAGE_FILTER_HINT` appended to the `list` and `search` descriptions
- `src/mcp/instructions.ts`: one images section appended to P2's `sections`
- Tests: `tests/unit/takenFilter.test.ts`, `tests/unit/imageAccess.test.ts`, `tests/integration/imageHarness.ts`, `tests/integration/images.http.int.test.ts`, `tests/integration/images.mcp.int.test.ts`

**Signature changes:** `registerImageTools(server, deps: ToolDeps)` and `imageRoutes(deps: AppDeps)` keep P2's signatures (the routes add an optional `opts`). Bodies go from no-op/empty to real.

**Requires (from earlier phases):**
- **P1** `src/notes/ids.ts`: `normalizeId(raw): string | null`. Schema `notes` with `image_meta.taken_at` a UTC ISO `...Z` string (`Date#toISOString()` form) or null, indexed as text by `notes_image_taken_at_idx`. `tests/integration/setup.ts`: `openTestDb`, `closeTestDb`, `truncateAll`, `testDatabaseUrl`.
- **P2** `src/deps.ts` `AppDeps { config, db, events, service }`; `src/http/app.ts` mounts `app.route('/', imageRoutes(deps))` after `apiRoutes`; `src/mcp/tools.ts` `ToolDeps { service, dataDir, db }` (the reconciler added `db` to phase 2 for this phase), `noteFilterShape`, `FilterArgs`, `toFilter`, `run`; `src/mcp/instructions.ts` `buildInstructions()` with a `sections` array; `src/notes/repo.ts` `NoteFilter` + `filterConditions(filter): SQL[]` (shared by list and search; the service passes the filter straight through); `src/notes/dates.ts` `parseDateBound(value, 'from'|'to'): Date` (throws `NoteError('invalid_input')`); `NotesService.get(ids, { includeDeleted })`, `getOne`; `NoteError`.
- **P4** `src/images/ingest.ts`: `imageDeps(app: AppDeps): ImageDeps`, `type ImageDeps { dataDir, notes, records, ... }`, `ingestImage(img, input)` (input `{ bytes, originalName?, body?, origin? }` or `{ path, originalName?, body?, origin?, move? }` → `{ note, created }`, restores a soft-deleted duplicate), `locateImage(img, id)` → `LocatedImage | null` (`{ id, mime, originalPath, relPath, available, host, deleted, meta }`). `src/images/probe.ts`: `UnsupportedImageError`. `src/images/derive.ts`: `getDisplay(dataDir, src) → { path, mime }` (the original for browser formats), `getThumb(dataDir, src) → path` (webp), `getPreview(dataDir, src) → path` (jpeg), `OriginalMissingError`. `src/images/records.ts`: `dbImageRecords(db)`.

**Leaves alone (owned by others):** `package.json` / lockfile and `drizzle/*` (P1); `src/http/app.ts`, `src/mcp/server.ts`, `src/notes/{service,types,events,dates}.ts` (P2); `src/images/*` (P4: called, never edited); `src/http/api.ts`, `src/http/static.ts`, `src/chat/*`, `GET /api/notes/:id` JSON (P6); `web/**` (P7, P8).

## Files

| File | Action | What changes |
|---|---|---|
| `src/http/imageAccess.ts` | create | the single adapter over P4's image API, id/path/etag helpers |
| `src/http/images.ts` | modify (P2 stub → full file) | the upload route and the four byte-serving routes |
| `src/mcp/imageTools.ts` | modify (P2 no-op → full file) | `create_image`, `view_images` |
| `src/notes/repo.ts` | modify (P2's `NoteFilter` and `filterConditions`) | `takenFrom`/`takenTo` fields + two conditions |
| `src/mcp/tools.ts` | modify (P2's `noteFilterShape`, `FilterArgs`, `toFilter`, list/search descriptions) | three fields, three mappings, the hint |
| `src/mcp/instructions.ts` | modify (append to `sections`) | one images section |
| `tests/unit/takenFilter.test.ts` | create | the taken-range SQL |
| `tests/unit/imageAccess.test.ts` | create | `expandHome`, `etagMatches` |
| `tests/integration/imageHarness.ts` | create | builds deps, app, temp data dir, port-0 server, fixtures |
| `tests/integration/images.http.int.test.ts` | create | every HTTP route |
| `tests/integration/images.mcp.int.test.ts` | create | both tools + the three filters via the SDK client |

## Implementation Steps

### Step 1: Taken-date filter in the repo
**File:** `src/notes/repo.ts`, P2's `NoteFilter` interface and `filterConditions` (directly after the
`hasImage` lines).
**Change:** two optional fields and two conditions. Bounds go through P2's `parseDateBound`, so
`taken_from`/`taken_to` mean exactly what `from`/`to` mean (YYYY-MM-DD = a whole local day, `to`
inclusive; datetimes exact; garbage → `NoteError('invalid_input')`). Phase 1 stores `taken_at` as a
UTC ISO string in `toISOString()` form, so a **text** comparison against
`parseDateBound(...).toISOString()` orders correctly and uses `notes_image_taken_at_idx`. Notes
with no `taken_at` never match a taken range (`null >= x` is null).
**Code:**
```ts
// in interface NoteFilter, after hasImage
  /** EXIF taken date, lower bound: YYYY-MM-DD (local day) or ISO datetime. Image notes only. */
  takenFrom?: string;
  /** EXIF taken date, upper bound, inclusive: YYYY-MM-DD (whole local day) or ISO datetime. */
  takenTo?: string;
```
```ts
// in filterConditions, directly after the two hasImage lines
  const takenAt = sql`(${notes.imageMeta} ->> 'taken_at')`;
  if (filter.takenFrom !== undefined && filter.takenFrom !== '') {
    conds.push(sql`${takenAt} >= ${parseDateBound(filter.takenFrom, 'from').toISOString()}`);
  }
  if (filter.takenTo !== undefined && filter.takenTo !== '') {
    conds.push(sql`${takenAt} < ${parseDateBound(filter.takenTo, 'to').toISOString()}`);
  }
```
(`sql`, `notes` and `parseDateBound` are already imported in P2's `repo.ts`.)
**Impact:** list and search both filter by EXIF taken date; the service passes the filter object
straight to the repo, so no service change. Existing callers do not change (fields optional).

### Step 2: `has_image` and taken range on the MCP `list` and `search` tools
**File:** `src/mcp/tools.ts`, P2's `noteFilterShape`, `FilterArgs`, `toFilter`, and the `list` /
`search` `description` strings.
**Change:** add three fields to the shared shape (both tools spread it), map them, and append one
sentence to both descriptions. P2's handlers already call `toFilter`, so no handler changes.
**Code:**
```ts
// add to noteFilterShape (after `to`)
  has_image: z
    .boolean()
    .optional()
    .describe('true: only image notes (photos, screenshots). false: only text notes. Omit for both.'),
  taken_from: z
    .string()
    .optional()
    .describe(
      'Earliest EXIF "taken" date of the photo: YYYY-MM-DD (start of that local day) or an ISO 8601 datetime. Only image notes whose camera recorded a date can match. For the day a picture was SAVED use from/to instead.',
    ),
  taken_to: z
    .string()
    .optional()
    .describe('Latest EXIF "taken" date, inclusive: YYYY-MM-DD (the whole local day) or an ISO 8601 datetime.'),
```
```ts
// add to FilterArgs
  has_image?: boolean | undefined;
  taken_from?: string | undefined;
  taken_to?: string | undefined;
```
```ts
// add to toFilter, before `return filter;`
  if (args.has_image !== undefined) filter.hasImage = args.has_image;
  if (args.taken_from !== undefined) filter.takenFrom = args.taken_from;
  if (args.taken_to !== undefined) filter.takenTo = args.taken_to;
```
```ts
// near the top of tools.ts
/** Appended to the `list` and `search` descriptions. */
export const IMAGE_FILTER_HINT =
  ' Filter image notes with has_image, and by when the photo was taken with taken_from/taken_to (EXIF). To look at the pictures, pass the ids to view_images.';
```
In the `list` and `search` registrations, append `+ IMAGE_FILTER_HINT` to the existing
`description` expression.
**Impact:** Claude can ask for `list {has_image: true, from, to}`. Each result already carries
`image` (P2). An invalid taken bound comes back as an `invalid_input:` error result through P2's
`run`.

### Step 3: The image adapter
**File:** `src/http/imageAccess.ts` (new, whole file)
**Change:** the only module that imports `src/images/*`. Both the HTTP routes and the MCP tools
use it. It resolves a note id + variant to a file on disk through P4's `locateImage` and getters,
and maps P4's errors: `OriginalMissingError` and `!loc.available` → `not_on_this_machine`;
`UnsupportedImageError` → `ImageInputError('not_an_image')`. A missing original makes every
variant 404 `not_on_this_machine` (index HTTP contract; P4's getters require the original).
**Code:**
```ts
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getDisplay, getPreview, getThumb, OriginalMissingError } from '../images/derive.js';
import { ingestImage, locateImage, type ImageDeps, type LocatedImage } from '../images/ingest.js';
import { UnsupportedImageError } from '../images/probe.js';
import { dbImageRecords } from '../images/records.js';
import type { ToolDeps } from '../mcp/tools.js';
import { normalizeId } from '../notes/ids.js';
import type { Note, Origin } from '../notes/types.js';

/** Upload / create_image size cap. */
export const MAX_IMAGE_BYTES = 200 * 1024 * 1024;

export type ImageVariant = 'original' | 'display' | 'thumb' | 'preview';

export interface ServedFile {
  absPath: string;
  mime: string;
  etag: string;
  size: number;
  /** true for originals: bytes behind this URL never change. */
  immutable: boolean;
}

export type ResolveResult =
  | { status: 'ok'; loc: LocatedImage; file: ServedFile; servedOriginal: boolean }
  | { status: 'not_found' }
  | { status: 'no_image'; id: string }
  | { status: 'not_on_this_machine'; id: string; host: string | null };

export type ImageInputErrorCode = 'not_absolute' | 'not_found' | 'not_a_file' | 'not_an_image' | 'too_large';

export class ImageInputError extends Error {
  constructor(
    readonly code: ImageInputErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ImageInputError';
  }
}

/** ImageDeps for the MCP tools (P2 hands them ToolDeps, not AppDeps). */
export function toolImageDeps(deps: ToolDeps): ImageDeps {
  return { dataDir: deps.dataDir, notes: deps.service, records: dbImageRecords(deps.db) };
}

export function expandHome(p: string, home: string = os.homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/** True when an If-None-Match header value names this ETag (handles lists, weak tags and `*`). */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''))
    .some((t) => t === '*' || t === etag);
}

const DERIVED_MIME = { thumb: 'image/webp', preview: 'image/jpeg' } as const;

/** Look up a note by any id spelling and resolve one image variant to a file. */
export async function resolveImageFile(img: ImageDeps, rawId: string, variant: ImageVariant): Promise<ResolveResult> {
  const id = normalizeId(rawId);
  if (id === null) return { status: 'not_found' };
  const loc = await locateImage(img, id);
  if (loc === null) {
    // Unknown id, or a text note: tell them apart for a clearer 404 body.
    return (await img.notes.getOne(id)) ? { status: 'no_image', id } : { status: 'not_found' };
  }
  if (loc.deleted) return { status: 'not_found' };
  if (!loc.available) return { status: 'not_on_this_machine', id: loc.id, host: loc.host };

  const sha = loc.meta.sha256;
  try {
    let absPath: string;
    let mime: string;
    let servedOriginal = false;
    if (variant === 'original') {
      absPath = loc.originalPath;
      mime = loc.mime;
      servedOriginal = true;
    } else if (variant === 'display') {
      const d = await getDisplay(img.dataDir, loc);
      absPath = d.path;
      mime = d.mime;
      servedOriginal = d.path === loc.originalPath;
    } else if (variant === 'thumb') {
      absPath = await getThumb(img.dataDir, loc);
      mime = DERIVED_MIME.thumb;
    } else {
      absPath = await getPreview(img.dataDir, loc);
      mime = DERIVED_MIME.preview;
    }
    const st = await stat(absPath);
    return {
      status: 'ok',
      loc,
      servedOriginal,
      file: {
        absPath,
        mime,
        etag: servedOriginal ? `"${sha}"` : `"${sha}-${variant}"`,
        size: st.size,
        immutable: servedOriginal,
      },
    };
  } catch (err) {
    if (err instanceof OriginalMissingError) return { status: 'not_on_this_machine', id: loc.id, host: loc.host };
    throw err;
  }
}

function blankToUndefined(s: string | undefined | null): string | undefined {
  return s != null && s.trim() !== '' ? s : undefined;
}

async function runIngest(
  img: ImageDeps,
  input: Parameters<typeof ingestImage>[1],
): Promise<{ note: Note; created: boolean }> {
  try {
    return await ingestImage(img, input);
  } catch (err) {
    if (err instanceof UnsupportedImageError) {
      throw new ImageInputError('not_an_image', `not an image: ${err.message}`);
    }
    throw err;
  }
}

/** HTTP upload path: bytes come from the multipart File. */
export async function ingestFromUpload(
  img: ImageDeps,
  file: File,
  body: string | undefined,
  maxBytes: number = MAX_IMAGE_BYTES,
): Promise<{ note: Note; created: boolean }> {
  if (file.size === 0) throw new ImageInputError('not_an_image', 'the uploaded file is empty');
  if (file.size > maxBytes) {
    throw new ImageInputError('too_large', `file is ${file.size} bytes; the limit is ${maxBytes}`);
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const origin: Origin = { source: 'web' };
  const b = blankToUndefined(body);
  return runIngest(img, { bytes, originalName: file.name || 'upload', origin, ...(b !== undefined ? { body: b } : {}) });
}

/** MCP create_image path: a local file, copied (never moved). */
export async function ingestFromPath(
  img: ImageDeps,
  rawPath: string,
  body: string | undefined,
  origin: Origin | null,
): Promise<{ note: Note; created: boolean }> {
  const p = expandHome(rawPath.trim());
  if (!path.isAbsolute(p)) {
    throw new ImageInputError('not_absolute', `path must be absolute (or start with ~/): ${rawPath}`);
  }
  let st;
  try {
    st = await stat(p);
  } catch {
    throw new ImageInputError('not_found', `no such file: ${p}`);
  }
  if (!st.isFile()) throw new ImageInputError('not_a_file', `not a regular file: ${p}`);
  if (st.size === 0) throw new ImageInputError('not_an_image', `empty file: ${p}`);
  if (st.size > MAX_IMAGE_BYTES) {
    throw new ImageInputError('too_large', `file is ${st.size} bytes; the limit is ${MAX_IMAGE_BYTES}`);
  }
  const b = blankToUndefined(body);
  return runIngest(img, { path: p, originalName: path.basename(p), origin, move: false, ...(b !== undefined ? { body: b } : {}) });
}
```
**Impact:** the only importer of `src/images/*` besides `src/background.ts` (P4).

### Step 4: The HTTP router
**File:** `src/http/images.ts`. Replace P2's stub with the whole file.
**Change:** upload plus four byte routes. Paths are absolute because P2 mounts this router at `/`.
Originals are streamed from disk and never re-encoded. Image responses carry `nosniff` and a
sandboxing CSP, so a hostile file opened directly cannot script the localhost origin.
**Code:**
```ts
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppDeps } from '../deps.js';
import { imageDeps, type ImageDeps } from '../images/ingest.js';
import {
  etagMatches,
  ImageInputError,
  ingestFromUpload,
  MAX_IMAGE_BYTES,
  resolveImageFile,
  type ImageVariant,
} from './imageAccess.js';

export interface ImageRouteOptions {
  /** Upload cap in bytes. Default MAX_IMAGE_BYTES (200 MB). Tests lower it. */
  maxUploadBytes?: number;
}

/** Room for multipart boundaries and the optional body field on top of the file itself. */
const MULTIPART_OVERHEAD = 1024 * 1024;

const VARIANTS: readonly ImageVariant[] = ['original', 'display', 'thumb', 'preview'];

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function sendImage(c: Context, img: ImageDeps, variant: ImageVariant): Promise<Response> {
  const r = await resolveImageFile(img, c.req.param('id') ?? '', variant);
  switch (r.status) {
    case 'not_found':
      return c.json({ error: 'not_found' }, 404);
    case 'no_image':
      return c.json({ error: 'no_image', id: r.id }, 404);
    case 'not_on_this_machine':
      return c.json({ error: 'not_on_this_machine', host: r.host }, 404);
    case 'ok':
      break;
  }
  const f = r.file;
  const headers: Record<string, string> = {
    'Content-Type': f.mime,
    ETag: f.etag,
    'Cache-Control': f.immutable ? 'private, max-age=31536000, immutable' : 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  };
  const originalName = r.loc.meta.original_name;
  if (r.servedOriginal && originalName) headers['Content-Disposition'] = contentDisposition(originalName);
  if (etagMatches(c.req.header('if-none-match'), f.etag)) {
    return c.body(null, 304, headers);
  }
  headers['Content-Length'] = String(f.size);
  const stream = Readable.toWeb(createReadStream(f.absPath)) as unknown as ReadableStream<Uint8Array>;
  return c.body(stream, 200, headers);
}

export function imageRoutes(deps: AppDeps, opts: ImageRouteOptions = {}): Hono {
  const maxUpload = opts.maxUploadBytes ?? MAX_IMAGE_BYTES;
  const img = imageDeps(deps);
  const r = new Hono();

  r.post(
    '/api/images',
    bodyLimit({
      maxSize: maxUpload + MULTIPART_OVERHEAD,
      onError: (c) => c.json({ error: 'too_large', max_bytes: maxUpload }, 413),
    }),
    async (c) => {
      let form: Record<string, string | File | (string | File)[]>;
      try {
        form = await c.req.parseBody({ all: true });
      } catch {
        return c.json({ error: 'bad_multipart' }, 400);
      }
      const fileField = Array.isArray(form['file']) ? form['file'][0] : form['file'];
      if (!(fileField instanceof File)) return c.json({ error: 'file_required' }, 400);
      const bodyField = Array.isArray(form['body']) ? form['body'][0] : form['body'];
      const body = typeof bodyField === 'string' ? bodyField : undefined;
      try {
        const result = await ingestFromUpload(img, fileField, body, maxUpload);
        return c.json(result, result.created ? 201 : 200);
      } catch (err) {
        if (err instanceof ImageInputError) {
          const status = err.code === 'too_large' ? 413 : 415;
          return c.json({ error: err.code, message: err.message }, status);
        }
        throw err;
      }
    },
  );

  for (const variant of VARIANTS) {
    r.get(`/api/notes/:id/${variant}`, (c) => sendImage(c, img, variant));
  }

  return r;
}
```
**Impact:** these routes become live through P2's `app.ts`, which already mounts `imageRoutes(deps)`. Hono
answers `HEAD` from the `GET` handlers. `/api/notes/:id` (JSON, P6) is a different path and does
not collide.

### Step 5: MCP image tools
**File:** `src/mcp/imageTools.ts`. Replace P2's no-op with the whole file.
**Change:** `view_images` reads notes through P2's `service.get(ids, { includeDeleted: true })`
(wire notes carry body, tags, dates and `image`) and the preview file through the adapter.
**Code:**
```ts
import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ImageInputError, ingestFromPath, resolveImageFile, toolImageDeps } from '../http/imageAccess.js';
import { normalizeId } from '../notes/ids.js';
import type { Note } from '../notes/types.js';
import type { ToolDeps } from './tools.js';

export const VIEW_IMAGES_MAX = 8;

type Content = CallToolResult['content'][number];

const originShape = z
  .object({
    cwd: z.string().optional().describe('Working directory the note was saved from.'),
    repo: z.string().optional().describe('Repository name or remote.'),
    claude_session: z.string().optional().describe('Claude Code session id.'),
  })
  .optional()
  .describe('Where this note came from. Pass the current cwd/repo when saving from a repo.');

function text(t: string): Content {
  return { type: 'text', text: t };
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** The metadata text block that accompanies every image view_images returns. */
export function describeImageNote(note: Note): string {
  const lines = [`id: ${note.id}`, `saved: ${note.created_at}`];
  if (note.image) {
    lines.push(`taken: ${note.image.taken_at ?? 'unknown (no EXIF date)'}`);
    lines.push(
      `image: ${note.image.width}x${note.image.height} ${note.image.mime}, ${formatBytes(note.image.bytes)}` +
        (note.image.original_name ? `, original name ${note.image.original_name}` : ''),
    );
  }
  lines.push(`tags: ${note.tags.length > 0 ? note.tags.map((t) => `#${t}`).join(' ') : 'none'}`);
  lines.push(`body: ${note.body.trim() === '' ? '(empty)' : note.body}`);
  return lines.join('\n');
}

export function registerImageTools(server: McpServer, deps: ToolDeps): void {
  const img = toolImageDeps(deps);

  server.registerTool(
    'create_image',
    {
      title: 'Create image note',
      description:
        'Save a local image file (screenshot, photo, PNG/JPEG/WebP/GIF/HEIC/TIFF...) as an image note. ' +
        'Give an absolute path (~/ is expanded). The file is COPIED byte for byte into the notes store; the source is left where it is. ' +
        'Optional body is the note text; #hashtags in it become tags. ' +
        'If the exact same file was saved before, the existing note is returned (created: false) instead of a duplicate. ' +
        'Non-image files are refused. Returns { note, created }.',
      inputSchema: {
        path: z.string().min(1).describe('Absolute path to the image file, or a path starting with ~/.'),
        body: z.string().optional().describe('Text for the note. #hashtags become tags.'),
        origin: originShape,
      },
    },
    async ({ path, body, origin }): Promise<CallToolResult> => {
      try {
        const { note, created } = await ingestFromPath(img, path, body, { ...(origin ?? {}), source: 'mcp' });
        return { content: [text(JSON.stringify({ note, created }, null, 2))] };
      } catch (err) {
        if (err instanceof ImageInputError) {
          return { isError: true, content: [text(`create_image refused (${err.code}): ${err.message}`)] };
        }
        throw err;
      }
    },
  );

  server.registerTool(
    'view_images',
    {
      title: 'View images',
      description:
        `Look at the pictures of image notes. Takes 1 to ${VIEW_IMAGES_MAX} note ids (any case, dash optional). ` +
        'For each id returns its metadata (id, saved date, EXIF taken date, dimensions, tags, body) followed by the picture itself, ' +
        'downscaled to at most 1568 px on the long edge. Find ids first with list/search (has_image: true). ' +
        'Text notes, unknown ids and images whose file lives on another machine come back as a text line saying so. ' +
        `For more than ${VIEW_IMAGES_MAX} images, call again with the next batch.`,
      inputSchema: {
        ids: z
          .array(z.string().min(1))
          .min(1)
          .max(VIEW_IMAGES_MAX)
          .describe(`Note ids, 1 to ${VIEW_IMAGES_MAX}.`),
      },
    },
    async ({ ids }): Promise<CallToolResult> => {
      const found = await deps.service.get(ids, { includeDeleted: true });
      const byId = new Map(found.notes.map((n) => [n.id, n]));
      const content: Content[] = [];
      for (const raw of ids) {
        const id = normalizeId(raw);
        const note = id ? byId.get(id) : undefined;
        if (!note) {
          content.push(text(`${raw}: no such note.`));
          continue;
        }
        if (note.deleted_at !== undefined) {
          content.push(text(`${note.id}: this note is deleted (restore it to view it).`));
          continue;
        }
        if (!note.image) {
          content.push(text(`${describeImageNote(note)}\n(text note: it has no image)`));
          continue;
        }
        let resolved;
        try {
          resolved = await resolveImageFile(img, note.id, 'preview');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          content.push(text(`${describeImageNote(note)}\n(the preview could not be generated: ${msg})`));
          continue;
        }
        if (resolved.status === 'ok') {
          const data = (await readFile(resolved.file.absPath)).toString('base64');
          content.push(text(describeImageNote(note)));
          content.push({ type: 'image', data, mimeType: resolved.file.mime });
        } else if (resolved.status === 'not_on_this_machine') {
          content.push(
            text(
              `${describeImageNote(note)}\n(image not on this machine: the file lives on ${resolved.host ?? 'another machine'})`,
            ),
          );
        } else {
          content.push(text(`${note.id}: no image available.`));
        }
      }
      return { content };
    },
  );
}
```
**Impact:** `notes` MCP clients see two new tools. The `registerImageTools` signature is P2's.
Origins from `create_image` get `source: 'mcp'`, as P2's `create` does.

### Step 6: Server instructions section
**File:** `src/mcp/instructions.ts`, P2's `buildInstructions`: append one string to the `sections`
array, after the last element.
**Code:**
```ts
    `Images. Some notes are image notes: a photo or screenshot saved on the laptop that stored it. Every note returned by get/list/search has an image field: null for text notes, otherwise {mime, width, height, bytes, taken_at, original_name, host, available}. To look at pictures, find the ids first, then call view_images with up to 8 ids; it returns each picture plus its metadata. "Show me pictures I saved on 30 oct" means list with has_image: true and from/to for that day, then view_images on the ids. "Photos taken last week" uses taken_from/taken_to (the camera's EXIF date) instead. To save a local image file (for example a screenshot path you have), call create_image with its absolute path and optional body text; the file is copied, not moved, and saving the same file again returns the existing note. available: false means the file lives on another machine (host): the note's text is still there, but its picture cannot be viewed here.`,
```
**Impact:** text only. P2's instructions unit test checks other sections and still passes.

### Step 7: Unit tests
**File:** `tests/unit/takenFilter.test.ts` (new)
```ts
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { filterConditions } from '../../src/notes/repo.js';
import { NoteError } from '../../src/notes/types.js';

const dialect = new PgDialect();
const render = (f: Parameters<typeof filterConditions>[0]) =>
  filterConditions(f).map((c) => dialect.sqlToQuery(c));

describe('filterConditions: taken range', () => {
  it('adds nothing without bounds (beyond the default deleted filter)', () => {
    expect(render({}).some((q) => q.sql.includes('taken_at'))).toBe(false);
  });

  it('compares image_meta->>taken_at as text against UTC ISO bounds (whole local days)', () => {
    const qs = render({ takenFrom: '2026-10-30', takenTo: '2026-10-30' }).filter((q) => q.sql.includes('taken_at'));
    expect(qs).toHaveLength(2);
    expect(qs[0]!.sql).toContain(`("notes"."image_meta" ->> 'taken_at') >=`);
    expect(qs[1]!.sql).toContain(`("notes"."image_meta" ->> 'taken_at') <`);
    expect(qs[0]!.params).toEqual([new Date(2026, 9, 30).toISOString()]);
    expect(qs[1]!.params).toEqual([new Date(2026, 9, 31).toISOString()]);
  });

  it('rejects garbage with invalid_input', () => {
    expect(() => filterConditions({ takenFrom: 'yesterday' })).toThrow(NoteError);
  });
});
```

**File:** `tests/unit/imageAccess.test.ts` (new). This imports `imageAccess.ts`, which imports P4's
modules. That is fine because nothing runs at import time.
```ts
import { describe, expect, it } from 'vitest';
import { etagMatches, expandHome } from '../../src/http/imageAccess.js';

describe('expandHome', () => {
  it('expands ~ and ~/', () => {
    expect(expandHome('~', '/home/u')).toBe('/home/u');
    expect(expandHome('~/Pictures/a.png', '/home/u')).toBe('/home/u/Pictures/a.png');
  });
  it('leaves other paths alone', () => {
    expect(expandHome('/tmp/a.png', '/home/u')).toBe('/tmp/a.png');
    expect(expandHome('~other/a.png', '/home/u')).toBe('~other/a.png');
    expect(expandHome('rel/a.png', '/home/u')).toBe('rel/a.png');
  });
});

describe('etagMatches', () => {
  it('matches exact, weak, listed and *', () => {
    expect(etagMatches('"abc"', '"abc"')).toBe(true);
    expect(etagMatches('W/"abc"', '"abc"')).toBe(true);
    expect(etagMatches('"x", "abc"', '"abc"')).toBe(true);
    expect(etagMatches('*', '"abc"')).toBe(true);
  });
  it('rejects missing or different tags', () => {
    expect(etagMatches(undefined, '"abc"')).toBe(false);
    expect(etagMatches('"abd"', '"abc"')).toBe(false);
  });
});
```

### Step 8: Integration harness
**File:** `tests/integration/imageHarness.ts` (new; not a test file)
**Change:** builds the real app over the Docker test DB (phase 1's `setup.ts` helpers), a temp
data dir, and an optional port-0 server for the MCP client. It never binds 7317 (invariant 10)
and never touches `~/mcp-notes-data` (invariant 11). It inserts text notes with raw SQL so tests
can pick the id.
```ts
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import type { AppDeps } from '../../src/deps.js';
import { createApp } from '../../src/http/app.js';
import { dbImageRecords } from '../../src/images/records.js';
import { NoteEvents } from '../../src/notes/events.js';
import { NotesService } from '../../src/notes/service.js';
import { closeTestDb, openTestDb, testDatabaseUrl, truncateAll } from './setup.js';

export interface Harness {
  deps: AppDeps;
  app: ReturnType<typeof createApp>;
  dataDir: string;
  /** Start a real HTTP server on 127.0.0.1:0 (needed for the MCP client). */
  listen(): Promise<string>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const url = testDatabaseUrl();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'mcp-notes-p5-'));
  for (const sub of ['images', 'cache', 'inbox', 'inbox/failed']) {
    await mkdir(path.join(dataDir, sub), { recursive: true });
  }
  const db = openTestDb();
  const events = new NoteEvents();
  const service = new NotesService({ db, dataDir, events });
  const deps: AppDeps = {
    config: { databaseUrl: url, port: 0, host: '127.0.0.1', dataDir },
    db,
    events,
    service,
  };
  const app = createApp(deps);
  let server: ServerType | undefined;

  return {
    deps,
    app,
    dataDir,
    async listen() {
      if (server) {
        const addr = server.address();
        if (addr && typeof addr === 'object') return `http://127.0.0.1:${addr.port}`;
      }
      const port = await new Promise<number>((resolve) => {
        server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve(info.port));
      });
      return `http://127.0.0.1:${port}`;
    },
    async reset() {
      await truncateAll(db);
      await rm(path.join(dataDir, 'images'), { recursive: true, force: true });
      await rm(path.join(dataDir, 'cache'), { recursive: true, force: true });
      await mkdir(path.join(dataDir, 'images'), { recursive: true });
      await mkdir(path.join(dataDir, 'cache'), { recursive: true });
    },
    async close() {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await closeTestDb(db);
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** A solid-colour image. Different colours give different bytes, so they do not dedupe. */
export async function makeImage(
  format: 'png' | 'jpeg' | 'tiff',
  width: number,
  height: number,
  rgb: { r: number; g: number; b: number },
): Promise<Buffer> {
  const img = sharp({ create: { width, height, channels: 3, background: rgb } });
  if (format === 'png') return img.png().toBuffer();
  if (format === 'jpeg') return img.jpeg({ quality: 90 }).toBuffer();
  return img.tiff().toBuffer();
}

/** Insert a plain text note directly (no image). */
export async function insertTextNote(h: Harness, id: string, body: string): Promise<void> {
  await h.deps.db.execute(
    sql`insert into notes (id, body, tags, created_at, updated_at)
        values (${id}, ${body}, '{}'::text[], now(), now())`,
  );
}

/** Set image_meta.taken_at directly (the EXIF path itself is P4's test subject). */
export async function setTakenAt(h: Harness, id: string, takenAtIso: string | null): Promise<void> {
  await h.deps.db.execute(
    sql`update notes
        set image_meta = jsonb_set(image_meta, '{taken_at}', ${takenAtIso === null ? sql`'null'::jsonb` : sql`to_jsonb(${takenAtIso}::text)`})
        where id = ${id}`,
  );
}

/** Absolute path of a note's original on disk. */
export async function originalPathOf(h: Harness, id: string): Promise<string> {
  const rec = await dbImageRecords(h.deps.db).byId(id);
  if (!rec) throw new Error(`note ${id} has no image_path`);
  return path.join(h.dataDir, rec.image_path);
}

export function cacheDirOf(h: Harness, id: string): string {
  return path.join(h.dataDir, 'cache', id);
}
```

### Step 9: HTTP integration tests
**File:** `tests/integration/images.http.int.test.ts` (new)
```ts
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { Hono } from 'hono';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { imageRoutes } from '../../src/http/images.js';
import {
  cacheDirOf,
  insertTextNote,
  makeImage,
  originalPathOf,
  startHarness,
  type Harness,
} from './imageHarness.js';

interface UploadResult {
  note: { id: string; body: string; tags: string[]; image: { mime: string; width: number; height: number; available: boolean; host: string | null } | null };
  created: boolean;
}

describe('image HTTP routes', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
  });

  async function upload(bytes: Buffer, name: string, type: string, body?: string, app: Hono = h.app): Promise<Response> {
    const fd = new FormData();
    fd.append('file', new File([bytes], name, { type }));
    if (body !== undefined) fd.append('body', body);
    return app.request('/api/images', { method: 'POST', body: fd });
  }

  it('uploads an image, returns {note, created}, and dedupes the same bytes', async () => {
    const png = await makeImage('png', 64, 32, { r: 200, g: 10, b: 10 });
    const r1 = await upload(png, 'red.png', 'image/png', 'a red box #from_phone');
    expect(r1.status).toBe(201);
    const j1 = (await r1.json()) as UploadResult;
    expect(j1.created).toBe(true);
    expect(j1.note.body).toBe('a red box #from_phone');
    expect(j1.note.tags).toEqual(['from_phone']);
    expect(j1.note.image).toMatchObject({ mime: 'image/png', width: 64, height: 32, available: true });

    const r2 = await upload(png, 'again.png', 'image/png');
    expect(r2.status).toBe(200);
    const j2 = (await r2.json()) as UploadResult;
    expect(j2.created).toBe(false);
    expect(j2.note.id).toBe(j1.note.id);
  });

  it('serves the original byte for byte with immutable caching and an sha256 ETag', async () => {
    const png = await makeImage('png', 40, 40, { r: 1, g: 2, b: 3 });
    const { note } = (await (await upload(png, 'orig.png', 'image/png')).json()) as UploadResult;

    const res = await h.app.request(`/api/notes/${note.id}/original`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const got = Buffer.from(await res.arrayBuffer());
    expect(Buffer.compare(got, png)).toBe(0);
    expect(Buffer.compare(got, await readFile(await originalPathOf(h, note.id)))).toBe(0);

    const etag = res.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const again = await h.app.request(`/api/notes/${note.id}/original`, { headers: { 'If-None-Match': etag! } });
    expect(again.status).toBe(304);
  });

  it('accepts lower-case and dash-less ids', async () => {
    const png = await makeImage('png', 10, 10, { r: 9, g: 9, b: 9 });
    const { note } = (await (await upload(png, 'id.png', 'image/png')).json()) as UploadResult;
    const loose = note.id.replace('-', '').toLowerCase();
    expect((await h.app.request(`/api/notes/${loose}/original`)).status).toBe(200);
    expect((await h.app.request(`/api/notes/${note.id.toLowerCase()}/thumb`)).status).toBe(200);
  });

  it('serves thumb (webp, 480 wide max) and preview (jpeg, long edge <= 1568)', async () => {
    const big = await makeImage('jpeg', 2400, 1200, { r: 30, g: 120, b: 60 });
    const { note } = (await (await upload(big, 'big.jpg', 'image/jpeg')).json()) as UploadResult;

    const thumb = await h.app.request(`/api/notes/${note.id}/thumb`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('content-type')).toBe('image/webp');
    const tMeta = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata();
    expect(tMeta.format).toBe('webp');
    expect(tMeta.width).toBeLessThanOrEqual(480);

    const preview = await h.app.request(`/api/notes/${note.id}/preview`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-type')).toBe('image/jpeg');
    const pMeta = await sharp(Buffer.from(await preview.arrayBuffer())).metadata();
    expect(pMeta.format).toBe('jpeg');
    expect(Math.max(pMeta.width!, pMeta.height!)).toBeLessThanOrEqual(1568);
  });

  it('display returns the original for browser formats and a JPEG for TIFF', async () => {
    const png = await makeImage('png', 50, 20, { r: 5, g: 50, b: 150 });
    const { note: pngNote } = (await (await upload(png, 'd.png', 'image/png')).json()) as UploadResult;
    const d1 = await h.app.request(`/api/notes/${pngNote.id}/display`);
    expect(d1.headers.get('content-type')).toBe('image/png');
    expect(Buffer.compare(Buffer.from(await d1.arrayBuffer()), png)).toBe(0);

    const tiff = await makeImage('tiff', 60, 30, { r: 90, g: 90, b: 10 });
    const { note: tifNote } = (await (await upload(tiff, 'd.tiff', 'image/tiff')).json()) as UploadResult;
    const d2 = await h.app.request(`/api/notes/${tifNote.id}/display`);
    expect(d2.status).toBe(200);
    expect(d2.headers.get('content-type')).toBe('image/jpeg');
    expect((await sharp(Buffer.from(await d2.arrayBuffer())).metadata()).width).toBe(60);
  });

  it('refuses non-images, a missing file field and oversized uploads', async () => {
    const notImage = await upload(Buffer.from('hello, not a picture'), 'a.txt', 'text/plain');
    expect(notImage.status).toBe(415);
    expect(((await notImage.json()) as { error: string }).error).toBe('not_an_image');

    const fd = new FormData();
    fd.append('body', 'no file here');
    const noFile = await h.app.request('/api/images', { method: 'POST', body: fd });
    expect(noFile.status).toBe(400);
    expect(((await noFile.json()) as { error: string }).error).toBe('file_required');

    const small = new Hono().route('/', imageRoutes(h.deps, { maxUploadBytes: 1024 }));
    const png = await makeImage('png', 300, 300, { r: 250, g: 1, b: 250 });
    const pngNoise = Buffer.concat([png, Buffer.alloc(4096, 7)]);
    const tooBig = await upload(pngNoise, 'big.png', 'image/png', undefined, small);
    expect(tooBig.status).toBe(413);
    expect(((await tooBig.json()) as { error: string }).error).toBe('too_large');
  });

  it('returns not_found for unknown ids and no_image for text notes', async () => {
    const unknown = await h.app.request('/api/notes/Z-ZZZ/original');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'not_found' });

    const garbage = await h.app.request('/api/notes/not-an-id-at-all/thumb');
    expect(garbage.status).toBe(404);

    await insertTextNote(h, 'T-XT1', 'just words');
    const text = await h.app.request('/api/notes/T-XT1/preview');
    expect(text.status).toBe(404);
    expect(((await text.json()) as { error: string }).error).toBe('no_image');
  });

  it('answers not_on_this_machine with the host when the original is gone', async () => {
    const png = await makeImage('png', 30, 30, { r: 77, g: 77, b: 1 });
    const { note } = (await (await upload(png, 'gone.png', 'image/png')).json()) as UploadResult;
    await rm(await originalPathOf(h, note.id));
    await rm(cacheDirOf(h, note.id), { recursive: true, force: true });

    for (const v of ['original', 'display', 'thumb', 'preview']) {
      const res = await h.app.request(`/api/notes/${note.id}/${v}`);
      expect(res.status, v).toBe(404);
      expect(await res.json(), v).toEqual({ error: 'not_on_this_machine', host: os.hostname() });
    }
  });

  it('a cached derivative is not served once the original is gone (every variant 404s)', async () => {
    const png = await makeImage('png', 900, 600, { r: 10, g: 200, b: 200 });
    const { note } = (await (await upload(png, 'cached.png', 'image/png')).json()) as UploadResult;
    expect((await h.app.request(`/api/notes/${note.id}/thumb`)).status).toBe(200);
    await rm(await originalPathOf(h, note.id));
    const thumb = await h.app.request(`/api/notes/${note.id}/thumb`);
    expect(thumb.status).toBe(404);
    expect(((await thumb.json()) as { error: string }).error).toBe('not_on_this_machine');
  });
});
```

### Step 10: MCP integration tests
**File:** `tests/integration/images.mcp.int.test.ts` (new)
**Change:** uses the SDK client over the real `/mcp` route on a port-0 server. P2's `list`/`search`
return `{ notes, next_cursor }` as JSON text.
```ts
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cacheDirOf,
  insertTextNote,
  makeImage,
  originalPathOf,
  setTakenAt,
  startHarness,
  type Harness,
} from './imageHarness.js';

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string } | { type: string }>;
};

function texts(r: ToolResult): string[] {
  return r.content.flatMap((c) => (c.type === 'text' ? [(c as { text: string }).text] : []));
}

function noteIds(r: ToolResult): string[] {
  const parsed = JSON.parse(texts(r)[0] ?? '{"notes":[]}') as { notes: Array<{ id: string }> };
  return parsed.notes.map((n) => n.id).sort();
}

describe('MCP image tools and filters', () => {
  let h: Harness;
  let client: Client;
  let srcDir: string;

  beforeAll(async () => {
    h = await startHarness();
    const base = await h.listen();
    client = new Client({ name: 'p5-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    srcDir = path.join(h.dataDir, '..', `p5-src-${process.pid}`);
  });
  afterAll(async () => {
    await client.close();
    await rm(srcDir, { recursive: true, force: true });
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    await rm(srcDir, { recursive: true, force: true });
    await mkdir(srcDir, { recursive: true });
  });

  async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return (await client.callTool({ name, arguments: args })) as ToolResult;
  }

  async function createFromFile(name: string, bytes: Buffer, body?: string): Promise<{ id: string; created: boolean }> {
    const p = path.join(srcDir, name);
    await writeFile(p, bytes);
    const r = await call('create_image', { path: p, ...(body !== undefined ? { body } : {}) });
    expect(r.isError, texts(r).join('\n')).toBeFalsy();
    const j = JSON.parse(texts(r)[0]!) as { note: { id: string }; created: boolean };
    return { id: j.note.id, created: j.created };
  }

  it('lists the tools and the new filter fields', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['create_image', 'view_images', 'list', 'search']));
    for (const t of tools.filter((x) => x.name === 'list' || x.name === 'search')) {
      const props = Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      expect(props, t.name).toEqual(expect.arrayContaining(['has_image', 'taken_from', 'taken_to']));
    }
  });

  it('create_image copies (not moves) the file and dedupes', async () => {
    const png = await makeImage('png', 48, 48, { r: 3, g: 140, b: 3 });
    const first = await createFromFile('shot.png', png, 'screenshot of the bug #seer');
    expect(first.created).toBe(true);
    await expect(access(path.join(srcDir, 'shot.png'))).resolves.toBeUndefined();
    const stored = await originalPathOf(h, first.id);
    expect(Buffer.compare(await readFile(stored), png)).toBe(0);

    const second = await createFromFile('shot-copy.png', png);
    expect(second).toEqual({ id: first.id, created: false });
  });

  it('create_image refuses relative paths, missing files and non-images', async () => {
    const rel = await call('create_image', { path: 'relative/shot.png' });
    expect(rel.isError).toBe(true);
    expect(texts(rel).join(' ')).toContain('not_absolute');

    const missing = await call('create_image', { path: path.join(srcDir, 'nope.png') });
    expect(missing.isError).toBe(true);
    expect(texts(missing).join(' ')).toContain('not_found');

    const txt = path.join(srcDir, 'notes.txt');
    await writeFile(txt, 'plain text');
    const notImage = await call('create_image', { path: txt });
    expect(notImage.isError).toBe(true);
    expect(texts(notImage).join(' ')).toContain('not_an_image');
  });

  it('view_images returns the preview as MCP image content plus metadata', async () => {
    const jpg = await makeImage('jpeg', 2000, 1000, { r: 220, g: 180, b: 20 });
    const { id } = await createFromFile('photo.jpg', jpg, 'sunset #from_phone');
    const r = await call('view_images', { ids: [id.toLowerCase().replace('-', '')] });
    expect(r.isError).toBeFalsy();
    const img = r.content.find((c) => c.type === 'image') as { data: string; mimeType: string } | undefined;
    expect(img?.mimeType).toBe('image/jpeg');
    const meta = await sharp(Buffer.from(img!.data, 'base64')).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1568);
    const t = texts(r).join('\n');
    expect(t).toContain(`id: ${id}`);
    expect(t).toContain('2000x1000');
    expect(t).toContain('#from_phone');
  });

  it('view_images explains text notes, unknown ids and missing files', async () => {
    await insertTextNote(h, 'T-XT2', 'only words');
    const png = await makeImage('png', 20, 20, { r: 100, g: 0, b: 100 });
    const { id: goneId } = await createFromFile('gone.png', png);
    await rm(await originalPathOf(h, goneId));
    await rm(cacheDirOf(h, goneId), { recursive: true, force: true });

    const r = await call('view_images', { ids: ['T-XT2', 'Q-QQQ', goneId] });
    expect(r.content.some((c) => c.type === 'image')).toBe(false);
    const t = texts(r).join('\n');
    expect(t).toContain('text note');
    expect(t).toContain('Q-QQQ: no such note');
    expect(t).toContain('not on this machine');
    expect(t).toContain(os.hostname());
  });

  it('view_images caps a call at 8 ids', async () => {
    const ids = Array.from({ length: 9 }, (_, i) => `A-AA${i}`);
    let refused = false;
    try {
      const r = await call('view_images', { ids });
      refused = r.isError === true;
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });

  it('list and search filter by has_image and taken range', async () => {
    await insertTextNote(h, 'T-XT3', 'a text note about sunsets');
    const a = await createFromFile('a.png', await makeImage('png', 10, 10, { r: 1, g: 1, b: 1 }), 'sunset one');
    const b = await createFromFile('b.png', await makeImage('png', 10, 10, { r: 2, g: 2, b: 2 }), 'sunset two');
    const c = await createFromFile('c.png', await makeImage('png', 10, 10, { r: 3, g: 3, b: 3 }), 'no exif');
    await setTakenAt(h, a.id, new Date(2026, 9, 29, 23, 30).toISOString());
    await setTakenAt(h, b.id, new Date(2026, 9, 30, 10, 0).toISOString());
    await setTakenAt(h, c.id, null);

    expect(noteIds(await call('list', { has_image: true }))).toEqual([a.id, b.id, c.id].sort());
    expect(noteIds(await call('list', { has_image: false }))).toEqual(['T-XT3']);
    expect(noteIds(await call('list', {}))).toEqual([a.id, b.id, c.id, 'T-XT3'].sort());

    expect(noteIds(await call('list', { taken_from: '2026-10-30', taken_to: '2026-10-30' }))).toEqual([b.id]);
    expect(noteIds(await call('list', { taken_to: '2026-10-29' }))).toEqual([a.id]);
    expect(noteIds(await call('list', { taken_from: '2026-10-29' }))).toEqual([a.id, b.id].sort());

    expect(noteIds(await call('search', { query: 'sunset', has_image: true }))).toEqual([a.id, b.id].sort());
    expect(noteIds(await call('search', { query: 'sunset', has_image: false }))).toEqual(['T-XT3']);
    expect(noteIds(await call('search', { query: 'sunset', taken_from: '2026-10-30' }))).toEqual([b.id]);

    const bad = await call('list', { taken_from: 'yesterday' }).catch(() => ({ isError: true, content: [] }) as ToolResult);
    expect(bad.isError).toBe(true);
  });
});
```
(`query` is P2's `search` argument name.)

## Verification

**Build:** `npm run typecheck && npm run build`
**Tests:** `npm test` (unit, includes `takenFilter` and `imageAccess`) and `npm run test:int` (includes `images.http.int.test.ts` and `images.mcp.int.test.ts`)
**Manual check:** start the daemon on a spare port with a temp data dir:
`NOTESD_PORT=7399 NOTES_DATA_DIR=$(mktemp -d) node dist/main.js`. Then run
`curl -F file=@some.jpg -F body='test #p5' http://127.0.0.1:7399/api/images` →
`{note, created:true}`; `curl -sD- http://127.0.0.1:7399/api/notes/<id>/original -o /tmp/x && cmp /tmp/x some.jpg`;
delete the file under `<data>/images/...` and the `cache/<id>` dir → the same URL returns
404 `{"error":"not_on_this_machine","host":"..."}`.
**Exit criteria:** an upload produces a note whose `/original` bytes are identical to the upload.
`view_images` returns an MCP `image` block of the preview. A missing original returns 404
`not_on_this_machine` with the host. `list`/`search` honour `has_image` and `taken_from`/`taken_to`.
All four gates are green.

## Handoffs

- **P2 (resolved by the reconciler):** `imageRoutes(deps: AppDeps)` is already a factory mounted
  after `apiRoutes`; `ToolDeps` now carries `db` (added to phase 2) so `registerImageTools` can
  build `ImageDeps`. `hasImage` is P2's; this phase adds `takenFrom`/`takenTo` with P2's
  `parseDateBound` and maps MCP `has_image` → `hasImage` in P2's `toFilter`.
- **P2:** `originShape` in `imageTools.ts` duplicates P2's origin zod schema. If `tools.ts` exports
  one, import it instead. That is a cleanup, not required.
- **P4 (resolved by the reconciler):** calls P4's real exports only: `imageDeps`, `ingestImage`,
  `locateImage`, `getDisplay`/`getThumb`/`getPreview`, `OriginalMissingError`,
  `UnsupportedImageError`, `dbImageRecords`. The browser-displayable set is P4's
  (`isBrowserDisplayable`), so the two can never disagree.
- **P6:** must not add an `/api/*` catch-all 404 or a `/api/notes/:id/*` route. `apiRoutes` is
  mounted before `imageRoutes` and would shadow these routes.
- **P8:** the upload response is `201 {note, created:true}` for a new note and `200 {note, created:false}`
  for a dedupe hit. Errors are `400 {error:'file_required'|'bad_multipart'}`,
  `413 {error:'too_large', max_bytes}`, `415 {error:'not_an_image', message}`. Byte routes return 404 JSON
  `{error:'not_found'|'no_image'|'not_on_this_machine', host?}`. Show the placeholder for
  `not_on_this_machine`, or whenever `note.image.available === false`.

## Rollback

Revert this phase's commit. That restores P2's empty `images.ts` router and no-op
`registerImageTools`, removes `imageAccess.ts`, the filter lines in `repo.ts` / `tools.ts`, the
instructions section, and the tests. No schema or
dependency changes to undo. Image files written by manual checks live in temp data dirs only.
