# Phase 1: Daemon: `image_id` on create_image / attach_image

**Plan set:** `CHAT_IMAGE_TO_NOTE_PLAN.md`
**Analysis:** `docs/analyzer/20261031-122441-Q7MX_code_analyzer.md`
**Satisfies:** R1, R5 — the agent can turn a pasted chat image (id like `G-0NC`) into a note or attach it to one, with tests
**Depends on:** none
**Difficulty:** NORMAL
**Package:** `src/http`, `src/mcp`

---

## Goal

`create_image` and `attach_image` accept `image_id`, a CHAT image id (the `chat_images` id space, any case, dash optional), as an alternative to `path`. The daemon resolves it to the stored original under `<dataDir>/chat-images/...` and runs the same copy + sha256 dedupe ingest as `path` (`created:false` / `attached:false` on repeat). Exactly one of `path` / `image_id` is required. Unknown ids, ids whose file lives on the other laptop, and both-or-neither arguments are refused with the C1 wording. `path` calls behave exactly as before.

## Interface Contract

**Deletes:** none
**Renames:** none
**Creates (all in `src/http/imageAccess.ts`):**
- `ImageInputErrorCode` gains `'bad_arguments' | 'unknown_chat_image' | 'not_on_this_machine'`
- `CHAT_IMAGE_ID_HINT` (const string): `'Pasted image ids look like G-0NC and appear as [image upload:ID] in chat or in the pasted-images note of a Claude Code /n prompt'`
- `type ChatImageFileDeps = { db: Db; dataDir: string }`
- `interface ChatImageFile { id: string; absPath: string; originalName: string | null }`
- `function toolChatImageDeps(deps: ToolDeps): ChatImageFileDeps`
- `type ImageSourceArg = { kind: 'path'; path: string } | { kind: 'image_id'; imageId: string }`
- `function oneImageSource(args: { path?: string | undefined; image_id?: string | undefined }): ImageSourceArg` (throws `ImageInputError('bad_arguments', 'give exactly one of path or image_id')`)
- `async function resolveChatImageFile(chat: ChatImageFileDeps, rawId: string): Promise<ChatImageFile>` (throws `ImageInputError('unknown_chat_image', 'no pasted image <id>. ' + CHAT_IMAGE_ID_HINT)` or `ImageInputError('not_on_this_machine', 'pasted image <ID> is stored on <host>, not on this machine')`; `<host>` falls back to `another machine`)
- `async function ingestFromChatImage(img: ImageDeps, chat: ChatImageFileDeps, rawId: string, body: string | undefined, origin: Origin | null): Promise<{ note: Note; created: boolean }>`
- `async function attachFromChatImage(img: AttachDeps, chat: ChatImageFileDeps, noteId: string, rawId: string): Promise<AttachResult>`

**Signature changes (MCP tool input schemas, `src/mcp/imageTools.ts`):**
- `create_image({ path: string, body?, origin? })` -> `create_image({ path?: string, image_id?: string, body?: string, origin? })`
- `attach_image({ id: string, path: string, origin? })` -> `attach_image({ id: string, path?: string, image_id?: string, origin? })`
- Neither/both: `isError` text exactly `create_image refused (bad_arguments): give exactly one of path or image_id` / `attach_image refused (bad_arguments): give exactly one of path or image_id`.
- Other refusals keep the existing `<tool> refused (<code>): <message>` frame, so an unknown id reads `create_image refused (unknown_chat_image): no pasted image Z-ZZZ. Pasted image ids look like G-0NC and appear as [image upload:ID] in chat or in the pasted-images note of a Claude Code /n prompt`.
- Created note origin is `{ ...origin, source: 'mcp' }`, as for `path`.

**Requires (from earlier phases):** none.
**Provides to later phases:** Phase 2 (`src/chat/status.ts` captions) may key on the tool input field name `image_id` on `create_image` / `attach_image`. Phase 4's integration test calls `create_image({ image_id })` over `/mcp` and expects `created:false` on the second call.
**Leaves alone (owned by others):** `src/mcp/instructions.ts`, `src/chat/*` (incl. `prompt.ts`, `status.ts`; `src/chat/images.ts` is only imported, not edited) (Phase 2); `claude/hooks/*`, `scripts/*`, `claude/skills/n/SKILL.md` (Phase 3); README, INSTALL, CHANGELOG, `tests/integration/prompt.hook.int.test.ts` (Phase 4).

## Files

| File | Action | What changes |
|---|---|---|
| `src/http/imageAccess.ts` | modify | imports (l.1-19); `ImageInputErrorCode` (l.42); new chat-image helpers appended after `attachFromPath` (after l.262) |
| `src/mcp/imageTools.ts` | modify | imports (l.5-13); `img`/`chat` deps (l.103); `create_image` registration (l.105-132); `attach_image` registration (l.227-253) |
| `tests/unit/imageAccess.test.ts` | modify | new `describe` blocks for `oneImageSource` and `resolveChatImageFile` (fake db), appended after l.27 |
| `tests/integration/images.mcp.int.test.ts` | modify | imports (l.1-18); new cases for `create_image({image_id})` inside the existing describe (before its closing `});` at l.221) |
| `tests/integration/images.attach.int.test.ts` | modify | imports (l.1-11); new cases for `attach_image({id, image_id})` in the MCP describe (before its closing `});` at l.447) |

No change is needed in `src/http/images.ts`: `writeErrorResponse` (l.38-42) and the upload route (l.126-131) map every non-`too_large` `ImageInputError` to 415, and HTTP routes never call the new functions, so the new codes never reach HTTP. No `switch` over `ImageInputErrorCode` exists (checked `src/http/*.ts`), so widening the union cannot break exhaustiveness.

## Implementation Steps

### Step 1: Widen `ImageInputErrorCode`
**File:** `src/http/imageAccess.ts:42`
**Change:** replace the one-line type.
**Code:**
```ts
export type ImageInputErrorCode =
  | 'not_absolute'
  | 'not_found'
  | 'not_a_file'
  | 'not_an_image'
  | 'too_large'
  /** MCP only: neither or both of path / image_id were given. */
  | 'bad_arguments'
  /** MCP only: image_id names no row in chat_images (never looked up among note images). */
  | 'unknown_chat_image'
  /** MCP only: the chat image's original is not under this machine's data dir (pasted on the other laptop). */
  | 'not_on_this_machine';
```
**Impact:** additive; HTTP mapping unchanged (see Files note).

### Step 2: Imports for the chat image store
**File:** `src/http/imageAccess.ts:1-19`
**Change:** add two imports. The import block becomes:
```ts
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { locateChatImage } from '../chat/images.js';
import type { Db } from '../db/client.js';
import { getDisplay, getPreview, getThumb, OriginalMissingError } from '../images/derive.js';
import {
  attachImage,
  ingestImage,
  locateImage,
  locateNoteImage,
  type AttachDeps,
  type AttachResult,
  type ImageDeps,
  type LocatedImage,
} from '../images/ingest.js';
import { UnsupportedImageError } from '../images/probe.js';
import { dbImageRecords } from '../images/records.js';
import type { ToolDeps } from '../mcp/tools.js';
import { normalizeId } from '../notes/ids.js';
import type { Note, Origin } from '../notes/types.js';
```
**Impact:** no cycle: `src/chat/images.ts` imports only `db/`, `images/`, `notes/ids`, and type-only `deps.js` / `chat/backend.js`; it never imports `http/`.

### Step 3: Chat-image resolution, ingest and attach
**File:** `src/http/imageAccess.ts`, append after `attachFromPath` (current end of file, l.262)
**Change:** new exported helpers. They reuse `locateChatImage` (`src/chat/images.ts:258`, any `normalizeId` spelling, `available` = original exists here) and the existing private `runIngest` / `runAttach` / `blankToUndefined`. The chat original is copied (`move: false`), exactly like a `path`, so sha256 dedupe against live note images is the existing `ingestImage` / `attachImage` behaviour. No size check is needed: chat uploads are capped at 50 MB (`MAX_CHAT_IMAGE_BYTES`), below `MAX_IMAGE_BYTES` (200 MB).
**Code:**
```ts
/** The tail of every unknown_chat_image message: where a pasted image's id can be found. */
export const CHAT_IMAGE_ID_HINT =
  'Pasted image ids look like G-0NC and appear as [image upload:ID] in chat or in the pasted-images note of a Claude Code /n prompt';

/** What resolving a chat image id needs: the daemon's db and data dir (ToolDeps has both). */
export type ChatImageFileDeps = { db: Db; dataDir: string };

/** A pasted chat image whose original is on this machine. */
export interface ChatImageFile {
  /** Canonical chat image id (A-B32 form, chat_images id space). */
  id: string;
  /** Absolute path of the stored original under `<dataDir>/chat-images/`. */
  absPath: string;
  /** The client's file name at paste time, or null (e.g. a Claude Code capture). */
  originalName: string | null;
}

/** ChatImageFileDeps for the MCP tools. */
export function toolChatImageDeps(deps: ToolDeps): ChatImageFileDeps {
  return { db: deps.db, dataDir: deps.dataDir };
}

/** Which image source an MCP call named. */
export type ImageSourceArg = { kind: 'path'; path: string } | { kind: 'image_id'; imageId: string };

/** create_image / attach_image take exactly one of path and image_id. */
export function oneImageSource(args: { path?: string | undefined; image_id?: string | undefined }): ImageSourceArg {
  const hasPath = args.path !== undefined;
  const hasImageId = args.image_id !== undefined;
  if (hasPath === hasImageId) {
    throw new ImageInputError('bad_arguments', 'give exactly one of path or image_id');
  }
  return hasPath ? { kind: 'path', path: args.path as string } : { kind: 'image_id', imageId: args.image_id as string };
}

/**
 * A pasted chat image by id (any case, dash optional) -> its original on this machine. Looks only
 * in chat_images: a note image id is never matched here (it is "no pasted image"). Throws
 * ImageInputError unknown_chat_image / not_on_this_machine.
 */
export async function resolveChatImageFile(chat: ChatImageFileDeps, rawId: string): Promise<ChatImageFile> {
  const shown = normalizeId(rawId) ?? rawId.trim();
  const loc = await locateChatImage(chat, rawId);
  if (loc === null) {
    throw new ImageInputError('unknown_chat_image', `no pasted image ${shown}. ${CHAT_IMAGE_ID_HINT}`);
  }
  if (!loc.available) {
    throw new ImageInputError(
      'not_on_this_machine',
      `pasted image ${loc.row.id} is stored on ${loc.row.host ?? 'another machine'}, not on this machine`,
    );
  }
  return { id: loc.row.id, absPath: loc.source.originalPath, originalName: loc.row.originalName };
}

/** The name a chat image gets in the note: its paste-time name, else its stored file name (`G-0NC.png`). */
function chatImageOriginalName(file: ChatImageFile): string {
  return file.originalName ?? path.basename(file.absPath);
}

/** MCP create_image with image_id: the pasted chat image's original, copied (never moved). */
export async function ingestFromChatImage(
  img: ImageDeps,
  chat: ChatImageFileDeps,
  rawId: string,
  body: string | undefined,
  origin: Origin | null,
): Promise<{ note: Note; created: boolean }> {
  const file = await resolveChatImageFile(chat, rawId);
  const b = blankToUndefined(body);
  return runIngest(img, {
    path: file.absPath,
    originalName: chatImageOriginalName(file),
    origin,
    move: false,
    ...(b !== undefined ? { body: b } : {}),
  });
}

/** MCP attach_image with image_id: the pasted chat image's original, copied (never moved). */
export async function attachFromChatImage(
  img: AttachDeps,
  chat: ChatImageFileDeps,
  noteId: string,
  rawId: string,
): Promise<AttachResult> {
  const file = await resolveChatImageFile(chat, rawId);
  return runAttach(img, noteId, { path: file.absPath, originalName: chatImageOriginalName(file), move: false });
}
```
**Impact:** additive. `ingestFromPath` / `attachFromPath` are untouched, so `path` calls are byte for byte as today (invariant 2).

### Step 4: Tool imports
**File:** `src/mcp/imageTools.ts:5-13`
**Change:** the `../http/imageAccess.js` import becomes:
```ts
import {
  attachFromChatImage,
  attachFromPath,
  ImageInputError,
  ingestFromChatImage,
  ingestFromPath,
  oneImageSource,
  resolveImageFile,
  toolAttachDeps,
  toolChatImageDeps,
  toolImageDeps,
  type ResolveResult,
} from '../http/imageAccess.js';
```

### Step 5: `create_image` takes `image_id`
**File:** `src/mcp/imageTools.ts:102-132`
**Change:** add `chat` deps next to `img`, and replace the whole `create_image` registration.
**Code:**
```ts
export function registerImageTools(server: McpServer, deps: ToolDeps): void {
  const img = toolImageDeps(deps);
  const chat = toolChatImageDeps(deps);

  server.registerTool(
    'create_image',
    {
      title: 'Create image note',
      description:
        'Save an image as a new note with that one image. Give exactly one of path or image_id. ' +
        'path: a local image file (screenshot, photo, PNG/JPEG/WebP/GIF/HEIC/TIFF...), absolute or starting with ~/; ' +
        'the file is COPIED byte for byte into the notes store and the source is left where it is. ' +
        'image_id: a picture the user PASTED into a chat, by its CHAT image id like G-0NC ' +
        '(the wall chat shows it as [image upload:ID]; a Claude Code /n prompt lists the pasted images by id). ' +
        "This is a chat image id, NOT a note image id from a note's images[].id. Use image_id, never a path, for a pasted picture. " +
        'Optional body is the note text; #hashtags in it become tags. ' +
        'If the exact same picture already lives in a note, that note is returned (created: false) instead of a duplicate. ' +
        'Non-image files are refused. Returns { note, created }.',
      inputSchema: {
        path: z.string().min(1).optional().describe('Absolute path to a local image file, or a path starting with ~/. Omit when giving image_id.'),
        image_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Chat image id of a pasted picture, like G-0NC (shown as [image upload:ID]). Case-insensitive; the dash may be omitted. ' +
              'Not a note image id. Omit when giving path.',
          ),
        body: z.string().optional().describe('Text for the note. #hashtags become tags.'),
        origin: originShape,
      },
    },
    async ({ path, image_id, body, origin }): Promise<CallToolResult> => {
      try {
        const source = oneImageSource({ path, image_id });
        const noteOrigin = { ...(origin ?? {}), source: 'mcp' };
        const { note, created } =
          source.kind === 'path'
            ? await ingestFromPath(img, source.path, body, noteOrigin)
            : await ingestFromChatImage(img, chat, source.imageId, body, noteOrigin);
        return { content: [text(JSON.stringify({ note, created }, null, 2))] };
      } catch (err) {
        if (err instanceof ImageInputError) {
          return { isError: true, content: [text(`create_image refused (${err.code}): ${err.message}`)] };
        }
        throw err;
      }
    },
  );
```
(The `view_images` registration that follows at l.134-223 is unchanged.)
**Impact:** `path` becomes optional in the published JSON schema; `required` lists neither `path` nor `image_id`. A call with only `path` takes the identical code path as before.

### Step 6: `attach_image` takes `image_id`
**File:** `src/mcp/imageTools.ts:227-253`
**Change:** replace the whole `attach_image` registration (the `const attach = toolAttachDeps(deps);` line at l.225 stays).
**Code:**
```ts
  server.registerTool(
    'attach_image',
    {
      title: 'Attach image to note',
      description:
        'Add an image to an existing note; a note can hold several images, kept in attach order. ' +
        'Give the note id and exactly one of path or image_id. ' +
        'path: a local image file (screenshot, photo, PNG/JPEG/WebP/GIF/HEIC/TIFF...), absolute or starting with ~/; ' +
        'the file is COPIED byte for byte into the notes store and the source is left where it is. ' +
        'image_id: a picture the user PASTED into a chat, by its CHAT image id like G-0NC ' +
        '(the wall chat shows it as [image upload:ID]; a Claude Code /n prompt lists the pasted images by id). ' +
        "This is a chat image id, NOT a note image id from a note's images[].id. Use image_id, never a path, for a pasted picture. " +
        'If the exact same picture already lives in a note (this one or another), nothing is copied and that note is returned with attached: false: tell the user which note holds it (a deleted holder note is restored). ' +
        'The note must not be deleted (restore it first). Non-image files are refused. Returns { note, attached }; a new image is the last entry of note.images.',
      inputSchema: {
        id: z.string().min(1).describe('Note id like A-B32 to attach to. Case-insensitive; the dash may be omitted.'),
        path: z.string().min(1).optional().describe('Absolute path to a local image file, or a path starting with ~/. Omit when giving image_id.'),
        image_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Chat image id of a pasted picture, like G-0NC (shown as [image upload:ID]). Case-insensitive; the dash may be omitted. ' +
              'Not a note image id. Omit when giving path.',
          ),
        origin: originShape,
      },
    },
    async ({ id, path, image_id }): Promise<CallToolResult> => {
      try {
        const source = oneImageSource({ path, image_id });
        const result =
          source.kind === 'path'
            ? await attachFromPath(attach, id, source.path)
            : await attachFromChatImage(attach, chat, id, source.imageId);
        return { content: [text(JSON.stringify(result, null, 2))] };
      } catch (err) {
        if (err instanceof ImageInputError) {
          return { isError: true, content: [text(`attach_image refused (${err.code}): ${err.message}`)] };
        }
        return errorResult(err);
      }
    },
  );
```
**Impact:** as Step 5. `origin` is accepted and ignored, as today. A deleted / unknown target note still comes back through `errorResult` (`deleted: ...`, `not_found: ...`). With `image_id`, the chat image is resolved before the note is checked, so an unknown image on a deleted note reports `unknown_chat_image` first.

### Step 7: Unit tests
**File:** `tests/unit/imageAccess.test.ts` (whole file; existing l.1-27 kept, imports widened, new blocks appended)
**Change:** pure checks of `oneImageSource` and of `resolveChatImageFile` against a chainable fake `Db` (`select().from().where().limit()` is the only query `findChatImage` makes; `eq(...)` builds SQL without a connection).
**Code:**
```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import type { ChatImageRow } from '../../src/db/schema.js';
import {
  CHAT_IMAGE_ID_HINT,
  etagMatches,
  expandHome,
  ImageInputError,
  oneImageSource,
  resolveChatImageFile,
} from '../../src/http/imageAccess.js';

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

/** The ImageInputError a promise or function threw, or a failing assertion. */
async function inputError(fn: () => unknown): Promise<ImageInputError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ImageInputError);
    return err as ImageInputError;
  }
  throw new Error('expected an ImageInputError');
}

describe('oneImageSource', () => {
  it('takes a path alone', () => {
    expect(oneImageSource({ path: '/tmp/a.png' })).toEqual({ kind: 'path', path: '/tmp/a.png' });
    expect(oneImageSource({ path: '/tmp/a.png', image_id: undefined })).toEqual({ kind: 'path', path: '/tmp/a.png' });
  });
  it('takes an image_id alone', () => {
    expect(oneImageSource({ image_id: 'g0nc' })).toEqual({ kind: 'image_id', imageId: 'g0nc' });
  });
  it('refuses both and neither with bad_arguments', async () => {
    for (const args of [{}, { path: undefined, image_id: undefined }, { path: '/tmp/a.png', image_id: 'G-0NC' }]) {
      const err = await inputError(() => oneImageSource(args));
      expect(err.code).toBe('bad_arguments');
      expect(err.message).toBe('give exactly one of path or image_id');
    }
  });
});

/** A Db whose only query (`select().from().where().limit()`) returns `rows`. */
function fakeDb(rows: ChatImageRow[]): Db {
  // Annotated: a self-referencing initializer would otherwise be an implicit-any error (TS7022).
  const q: { from: () => unknown; where: () => unknown; limit: () => Promise<ChatImageRow[]> } = {
    from: () => q,
    where: () => q,
    limit: async () => rows,
  };
  return { select: () => q } as unknown as Db;
}

function chatRow(over: Partial<ChatImageRow> = {}): ChatImageRow {
  return {
    id: 'G-0NC',
    path: 'chat-images/2026/10/G-0NC.png',
    sha256: 'a'.repeat(64),
    mime: 'image/png',
    width: 40,
    height: 30,
    bytes: 123,
    originalName: 'pasted.png',
    host: 'lenovo',
    source: 'wall',
    createdAt: new Date('2026-10-31T01:02:03.000Z'),
    ...over,
  };
}

describe('resolveChatImageFile', () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'mcp-notes-chatfile-'));
  });
  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('refuses a string that cannot be an id as unknown_chat_image, with the hint', async () => {
    const err = await inputError(() => resolveChatImageFile({ db: fakeDb([]), dataDir }, ' not-an-id '));
    expect(err.code).toBe('unknown_chat_image');
    expect(err.message).toBe(`no pasted image not-an-id. ${CHAT_IMAGE_ID_HINT}`);
  });

  it('names an unknown id in canonical form', async () => {
    const err = await inputError(() => resolveChatImageFile({ db: fakeDb([]), dataDir }, 'g0nc'));
    expect(err.code).toBe('unknown_chat_image');
    expect(err.message).toBe(
      'no pasted image G-0NC. Pasted image ids look like G-0NC and appear as [image upload:ID] in chat or in the pasted-images note of a Claude Code /n prompt',
    );
  });

  it('refuses a row whose original is not on this machine, naming its host', async () => {
    const err = await inputError(() =>
      resolveChatImageFile({ db: fakeDb([chatRow({ id: 'H-0ST', path: 'chat-images/2026/10/H-0ST.png', host: 'other-laptop' })]), dataDir }, 'H-0ST'),
    );
    expect(err.code).toBe('not_on_this_machine');
    expect(err.message).toBe('pasted image H-0ST is stored on other-laptop, not on this machine');
  });

  it('says "another machine" when the row has no host', async () => {
    const err = await inputError(() =>
      resolveChatImageFile({ db: fakeDb([chatRow({ id: 'N-0HS', path: 'chat-images/2026/10/N-0HS.png', host: null })]), dataDir }, 'N-0HS'),
    );
    expect(err.message).toBe('pasted image N-0HS is stored on another machine, not on this machine');
  });

  it('returns the original under the data dir when it is here', async () => {
    const rel = 'chat-images/2026/10/G-0NC.png';
    await mkdir(path.join(dataDir, 'chat-images/2026/10'), { recursive: true });
    await writeFile(path.join(dataDir, rel), Buffer.from([1, 2, 3]));
    const file = await resolveChatImageFile({ db: fakeDb([chatRow({ path: rel })]), dataDir }, 'g-0nc');
    expect(file).toEqual({ id: 'G-0NC', absPath: path.join(path.resolve(dataDir), rel), originalName: 'pasted.png' });
  });
});
```
**Impact:** none on source.

### Step 8: Integration tests, `create_image({image_id})`
**File:** `tests/integration/images.mcp.int.test.ts`
**Change (a), imports l.1-18:** the block becomes:
```ts
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ingestChatImage, locateChatImage } from '../../src/chat/images.js';
import { setImageDeleted } from '../../src/notes/imageRepo.js';
import type { Note } from '../../src/notes/types.js';
import {
  addImage,
  cacheDirOf,
  insertTextNote,
  makeImage,
  originalPathOf,
  setTakenAt,
  startHarness,
  type Harness,
} from './imageHarness.js';
```
**Change (b):** insert these helpers and cases inside `describe('MCP image tools and filters', ...)`, directly after the last `it(...)` ("view_images says when an image was removed", ending l.220) and before the describe's closing `});` (l.221).
**Code:**
```ts
  /** Stores bytes in chat_images as a wall paste would; returns the chat image id. */
  async function paste(bytes: Buffer, originalName: string | null = 'pasted.png'): Promise<string> {
    const r = await ingestChatImage({ db: h.deps.db, dataDir: h.dataDir }, { bytes, originalName, source: 'wall' });
    return r.image.id;
  }

  async function noteCount(): Promise<number> {
    const res = await h.deps.db.execute<{ n: number }>(sql`select count(*)::int as n from notes`);
    return res.rows[0]?.n ?? 0;
  }

  const BAD_ARGS = 'create_image refused (bad_arguments): give exactly one of path or image_id';

  it('publishes path and image_id on create_image, neither required', async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === 'create_image');
    const schema = t!.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    expect(Object.keys(schema.properties ?? {})).toEqual(expect.arrayContaining(['path', 'image_id', 'body', 'origin']));
    expect(schema.required ?? []).not.toContain('path');
    expect(schema.required ?? []).not.toContain('image_id');
    expect(t!.description).toMatch(/CHAT image id/);
  });

  it('create_image takes a pasted chat image by image_id, copies it, and dedupes', async () => {
    const png = await makeImage('png', 40, 30, { r: 9, g: 99, b: 199 });
    const chatId = await paste(png);
    const loc = await locateChatImage({ db: h.deps.db, dataDir: h.dataDir }, chatId);

    const r = await call('create_image', { image_id: chatId.toLowerCase().replace('-', ''), body: 'from the chat #pasted' });
    expect(r.isError, texts(r).join('\n')).toBeFalsy();
    const first = JSON.parse(texts(r)[0]!) as { note: Note; created: boolean };
    expect(first.created).toBe(true);
    expect(first.note.body).toBe('from the chat #pasted');
    expect(first.note.tags).toEqual(['pasted']);
    expect(first.note.origin?.source).toBe('mcp');
    expect(first.note.images).toHaveLength(1);
    expect(first.note.images[0]!.original_name).toBe('pasted.png');
    // The note image has its own id in the note-image space; the chat original stays where it was.
    expect(Buffer.compare(await readFile(await originalPathOf(h, first.note.id)), png)).toBe(0);
    await expect(access(loc!.source.originalPath)).resolves.toBeUndefined();

    const again = await call('create_image', { image_id: chatId });
    expect(again.isError, texts(again).join('\n')).toBeFalsy();
    expect(JSON.parse(texts(again)[0]!)).toMatchObject({ note: { id: first.note.id }, created: false });

    // Same bytes by path: the same note, no duplicate.
    expect(await createFromFile('same.png', png)).toEqual({ id: first.note.id, created: false });
    expect(await noteCount()).toBe(1);
  });

  it('create_image names a chat image without an original name by its stored file name', async () => {
    const chatId = await paste(await makeImage('png', 20, 20, { r: 77, g: 7, b: 177 }), null);
    const r = await call('create_image', { image_id: chatId });
    expect(r.isError, texts(r).join('\n')).toBeFalsy();
    const j = JSON.parse(texts(r)[0]!) as { note: Note };
    expect(j.note.images[0]!.original_name).toBe(`${chatId}.png`);
  });

  it('create_image dedupes a pasted image against a note that already holds the bytes', async () => {
    const png = await makeImage('png', 24, 24, { r: 15, g: 25, b: 35 });
    const held = await createFromFile('held.png', png, 'saved earlier');
    const chatId = await paste(png);
    const r = await call('create_image', { image_id: chatId });
    expect(r.isError, texts(r).join('\n')).toBeFalsy();
    expect(JSON.parse(texts(r)[0]!)).toMatchObject({ note: { id: held.id }, created: false });
  });

  it('create_image refuses both, neither, unknown, note-image and other-machine image_ids', async () => {
    const png = await makeImage('png', 16, 16, { r: 200, g: 20, b: 2 });
    const p = path.join(srcDir, 'both.png');
    await writeFile(p, png);
    const chatId = await paste(png);

    const both = await call('create_image', { path: p, image_id: chatId });
    expect(both.isError).toBe(true);
    expect(texts(both).join('\n')).toBe(BAD_ARGS);

    const neither = await call('create_image', { body: 'no picture' });
    expect(neither.isError).toBe(true);
    expect(texts(neither).join('\n')).toBe(BAD_ARGS);

    const unknown = await call('create_image', { image_id: 'z-zzz' });
    expect(unknown.isError).toBe(true);
    expect(texts(unknown).join('\n')).toBe(
      'create_image refused (unknown_chat_image): no pasted image Z-ZZZ. Pasted image ids look like G-0NC and appear as [image upload:ID] in chat or in the pasted-images note of a Claude Code /n prompt',
    );

    // A NOTE image id is a different id space: never matched as a pasted image.
    const noteImg = await createFromFile('note.png', await makeImage('png', 16, 16, { r: 2, g: 20, b: 200 }));
    const asChat = await call('create_image', { image_id: noteImg.id });
    expect(asChat.isError).toBe(true);
    expect(texts(asChat).join('\n')).toContain(`create_image refused (unknown_chat_image): no pasted image ${noteImg.id}.`);

    // Pasted on the other laptop: the row is here, the file is not.
    const loc = await locateChatImage({ db: h.deps.db, dataDir: h.dataDir }, chatId);
    await h.deps.db.execute(sql`update chat_images set host = 'other-laptop' where id = ${chatId}`);
    await rm(loc!.source.originalPath);
    const away = await call('create_image', { image_id: chatId });
    expect(away.isError).toBe(true);
    expect(texts(away).join('\n')).toBe(
      `create_image refused (not_on_this_machine): pasted image ${chatId} is stored on other-laptop, not on this machine`,
    );

    expect(await noteCount()).toBe(1); // only noteImg
  });
```
**Impact:** `h.reset()` already truncates `chat_images` and empties `chat-images/` (`imageHarness.ts:72-77`, `setup.ts:50`), so each case starts clean. `Note.origin` is `Origin | null` (`src/notes/types.ts:85`).

### Step 9: Integration tests, `attach_image({id, image_id})`
**File:** `tests/integration/images.attach.int.test.ts`
**Change (a), imports l.1-11:** the block becomes:
```ts
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ingestChatImage, locateChatImage } from '../../src/chat/images.js';
import { imageRoutes } from '../../src/http/images.js';
import type { NoteEvent } from '../../src/notes/events.js';
import type { Note } from '../../src/notes/types.js';
import { insertTextNote, makeImage, startHarness, type Harness } from './imageHarness.js';
```
**Change (b):** insert inside `describe('MCP attach_image / remove_image / restore_image', ...)`, after the last `it(...)` ("reports clashes, deleted notes, relative paths and unknown image ids as tool errors", ending l.446) and before the describe's closing `});` (l.447).
**Code:**
```ts
  /** Stores bytes in chat_images as a wall paste would; returns the chat image id. */
  async function paste(bytes: Buffer, originalName = 'pasted.png'): Promise<string> {
    const r = await ingestChatImage({ db: h.deps.db, dataDir: h.dataDir }, { bytes, originalName, source: 'wall' });
    return r.image.id;
  }

  const BAD_ARGS = 'attach_image refused (bad_arguments): give exactly one of path or image_id';

  it('publishes path and image_id on attach_image, only id required', async () => {
    const t = (await client.listTools()).tools.find((x) => x.name === 'attach_image');
    const schema = t!.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    expect(Object.keys(schema.properties ?? {})).toEqual(expect.arrayContaining(['id', 'path', 'image_id']));
    expect(schema.required ?? []).toEqual(['id']);
    expect(t!.description).toMatch(/CHAT image id/);
  });

  it('attach_image takes a pasted chat image by image_id, copies it, and dedupes', async () => {
    const bytes = await solid(130, 131, 132);
    const n = await h.deps.service.create({ body: 'needs a picture' });
    const chatId = await paste(bytes);
    const loc = await locateChatImage({ db: h.deps.db, dataDir: h.dataDir }, chatId);

    const r = await call('attach_image', { id: n.id, image_id: chatId.toLowerCase() });
    expect(r.isError, textOf(r)).toBeFalsy();
    const first = JSON.parse(textOf(r)) as AttachBody;
    expect(first.attached).toBe(true);
    expect(first.note.id).toBe(n.id);
    expect(first.note.images).toHaveLength(1);
    const added = first.note.images[0]!;
    expect(added.original_name).toBe('pasted.png');
    expect(added.id).toMatch(ID);
    const rows = await imageRows(h, n.id);
    expect(await readFile(path.join(h.dataDir, rows[0]!.path))).toEqual(bytes);
    await access(loc!.source.originalPath);

    const again = await call('attach_image', { id: n.id, image_id: chatId });
    expect(again.isError, textOf(again)).toBeFalsy();
    expect(JSON.parse(textOf(again))).toMatchObject({ attached: false, note: { id: n.id } });

    // Another note: the holder comes back, nothing is copied.
    const other = await h.deps.service.create({ body: 'other note' });
    const elsewhere = await call('attach_image', { id: other.id, image_id: chatId });
    expect(elsewhere.isError, textOf(elsewhere)).toBeFalsy();
    expect(JSON.parse(textOf(elsewhere))).toMatchObject({ attached: false, note: { id: n.id } });
    expect(await imageRows(h, other.id)).toEqual([]);
  });

  it('attach_image refuses both, neither, unknown and other-machine image_ids; a deleted note stays an error', async () => {
    const n = await h.deps.service.create({ body: 'target' });
    const bytes = await solid(140, 141, 142);
    const p = await file('both.png', bytes);
    const chatId = await paste(bytes);

    const both = await call('attach_image', { id: n.id, path: p, image_id: chatId });
    expect(both.isError).toBe(true);
    expect(textOf(both)).toBe(BAD_ARGS);

    const neither = await call('attach_image', { id: n.id });
    expect(neither.isError).toBe(true);
    expect(textOf(neither)).toBe(BAD_ARGS);

    const unknown = await call('attach_image', { id: n.id, image_id: 'Z-ZZZ' });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toBe(
      'attach_image refused (unknown_chat_image): no pasted image Z-ZZZ. Pasted image ids look like G-0NC and appear as [image upload:ID] in chat or in the pasted-images note of a Claude Code /n prompt',
    );

    const gone = await h.deps.service.create({ body: 'deleted target' });
    await h.deps.service.delete(gone.id);
    const deleted = await call('attach_image', { id: gone.id, image_id: chatId });
    expect(deleted.isError).toBe(true);
    expect(textOf(deleted)).toMatch(/^deleted: /);

    const loc = await locateChatImage({ db: h.deps.db, dataDir: h.dataDir }, chatId);
    await h.deps.db.execute(sql`update chat_images set host = 'other-laptop' where id = ${chatId}`);
    await rm(loc!.source.originalPath);
    const away = await call('attach_image', { id: n.id, image_id: chatId });
    expect(away.isError).toBe(true);
    expect(textOf(away)).toBe(
      `attach_image refused (not_on_this_machine): pasted image ${chatId} is stored on other-laptop, not on this machine`,
    );

    expect(await imageRows(h, n.id)).toEqual([]);
  });
```
**Impact:** uses the file's existing helpers `solid`, `imageRows`, `ID`, `AttachBody`, `call`, `textOf`, `file` (l.15-47, l.358-376). The `deleted:` assertion relies on `attachImage` raising `NoteError('deleted')` for a soft-deleted target, which the existing path test at l.437-440 already pins.

## Verification

**Build:** `npm run typecheck`
**Tests:**
- `npx vitest run tests/unit/imageAccess.test.ts tests/unit/mcp.describe.test.ts tests/unit/chat-status.test.ts`
- `npm test` (whole unit suite stays green)
- `npm run test:int -- tests/integration/images.mcp.int.test.ts tests/integration/images.attach.int.test.ts` (Docker Postgres)
- `npm run test:int -- tests/integration/similarImages.mcp.int.test.ts tests/integration/chat.images.int.test.ts` (neighbours that share `chat_images` and the image tools; must stay green)
**Manual check:** against a running daemon, paste an image in the wall chat, note its `[image upload:G-xxx]`, and ask the wall agent to "save that image as a note" with an explicit "use create_image with image_id G-xxx" (phase 2 supplies the default wording); a new image note appears, and asking again returns the same note.
**Exit criteria (from the index):** `create_image({image_id})` makes an image note from a chat image; same bytes again → `created:false` same note; `attach_image({id, image_id})` appends or returns `attached:false`; unknown / other-machine / both-or-neither arguments are refused with the C1 wording; `path` calls unchanged; typecheck and unit and integration tests green.

## Handoffs

- **Phase 2 (R1, R3):** `src/mcp/instructions.ts` "Images." / "Attaching." paragraphs, the wall agent prompt (`src/chat/prompt.ts`), and `src/chat/status.ts` captions must name `image_id` (a CHAT image id, `[image upload:ID]`) and stop asking for a path for pasted pictures. Phase 1 only changes the tool descriptions in `src/mcp/imageTools.ts`. Note for Phase 2's captions: the input field name is exactly `image_id`, on both `create_image` and `attach_image`.
- **Phase 4 (R6):** CHANGELOG `[Unreleased]` Added entry for `image_id` on `create_image` / `attach_image`; README tool table (~l.692) row update. Phase 1 writes no docs.
- **Not owned by any phase (recorded, not built):** `ingestFromPath` and `checkLocalImagePath` duplicate the same path checks (`imageAccess.ts:182-205` vs `:224-241`). This is a drive-by cleanup and stays out of scope.

## Risks

- **TOCTOU on the chat original:** the file can vanish between `resolveChatImageFile`'s existence check and `ingestImage` reading it (another process deleting it by hand). `ingestImage` then throws a raw ENOENT error. `create_image` rethrows it and the MCP SDK turns it into a generic tool error; `attach_image` sends it through `errorResult`. Rare (nothing in the daemon deletes chat originals) and not worth a special case.
- **Description length:** the two descriptions grow by about 350 characters each. They reach every MCP client's tool list, so they cost a little context per session.
- **Wall-agent tool allow-list:** the wall agent calls `mcp__notes__create_image` through `allowedChatTools` (`src/chat/status.ts`), which allows the tool by name, not by argument, so no allow-list change is needed. Phase 2 owns that file in any case.

## Rollback

`git revert` this phase's commit. The change is additive: `path` calls never touch the new code, and there is no migration or config. Notes already created from chat images stay as ordinary image notes.
