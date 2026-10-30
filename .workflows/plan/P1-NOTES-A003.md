> Adopted from `docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md` phase 4. Source: `.workflows/plan/notes-spine-images-ui/phase-4.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 4: Image store, derivatives, ingest service, inbox watcher

**Plan set:** `NOTES_SPINE_IMAGES_UI_PLAN.md`
**Analysis:** `docs/analyzer/20261030-092006-K7N3_code_analyzer.md`
**Satisfies:** R2. Images are stored byte for byte with sha256 dedupe and metadata. The thumbnail, Claude preview and HEIC display derivatives are generated lazily. Ingestion runs through the inbox folder and through the `ingestImage` service that phase 5's HTTP upload and MCP tool call.
**Depends on:** Phase 2 (and through it phase 1)
**Difficulty:** HARD
**Package:** `src/images`

---

## Goal

After this phase, `src/images/` can take any image (as bytes or as a local path) and return its note. It stores the original byte for byte under `<dataDir>/images/YYYY/MM/<id>.<ext>` and records `image_meta`. The same bytes always come back as the same note, and a soft-deleted match is restored. It serves cache derivatives (`thumb.webp`, `preview.jpg`, `display.jpg`) on demand, and `notesd` watches `<dataDir>/inbox` and turns every image dropped there into a note. Phase 5 only has to put HTTP and MCP in front of these functions.

## Verified facts (scratch install, 2026-10-30, Node 22.23.1)

These were measured, not assumed. The scratch project was sharp 0.35.5 (phase 1 pins 0.35.3; the APIs used exist across 0.35.x), heic-convert 2.1.0, exifr 7.1.3, file-type 22.3.0, chokidar 6.0.0, vitest 4.1.2 and typescript 5.9.3. Every file in this plan was typechecked (`strict`, `noUncheckedIndexedAccess`, `NodeNext`) and the 50 unit tests passed 6 runs in a row.

| Question | Answer |
|---|---|
| Can sharp's prebuilt binary read HEIC? | **The header only.** `sharp(heic).metadata()` returns `format: 'heif'`, `compression: 'hevc'`, the correct width and height, and the raw `exif` block. Decoding pixels fails with *"Support for this compression format has not been built in: HEVC (a suitable decoder plugin is libde265)"*. `sharp.versions.heif` is 1.23.5 with AV1 (aom) only. |
| Who decodes HEVC pixels? | `heic-convert` (libheif in WASM). A 4032×3024 HEIC turns into a full-resolution `display.jpg` in about 1.5 s, at roughly 370 MB RSS peak. Thumb and preview from that JPEG take 0.3 s more. The output is display-oriented and carries no EXIF. |
| HEIC width and height | Read from sharp `metadata()`, with no decode. probe.ts keeps a fallback (decode through heic-convert, then measure) for headers sharp cannot read. |
| EXIF on HEIC | `exifr.parse(heicBuffer)` reports **"Malformed EXIF data"** on libheif-written HEIC. `exifr.parse(sharpMetadata.exif minus "Exif\0\0")` works for JPEG and HEIC alike, so probe.ts always reads EXIF that way. |
| `DateTimeOriginal` | It comes back as `'2024:10:30 14:05:09'` with `reviveValues:false`. Without an `OffsetTimeOriginal` it is read as process-local time (WIB on this machine), which matches exifr's own revive behaviour and the analysis's timezone assumption. |
| file-type mimes | `jpg→image/jpeg`, `png`, `gif`, `webp`, `avif→image/avif`, `heic→image/heic` (brand `heic`), `tif→image/tiff`. Plain text gives `undefined`. ESM-only: `fileTypeFromBuffer` and `fileTypeFromFile` are named exports. |
| `sharp.metadata().autoOrient` | Present in 0.35. An orientation-6 JPEG of 30×20 reports `autoOrient {width:20,height:30}`. probe.ts stores those display-oriented dimensions. |
| chokidar 6.0.0 | `watch(dir, {depth:0, ignored: fn, awaitWriteFinish:{stabilityThreshold,pollInterval}})` emits `add` for files already present before `ready`. `awaitWriteFinish` is **not** applied to that initial scan, which is why inbox.ts does its own stable-size wait for those files. It does not descend into `failed/`, and dotfiles are filtered by the `ignored` function. The API used here (`watch`, `on('add'|'error')`, `once('ready')`, `close()`) is the same in chokidar 4, 5 and 6. |
| HEIC fixtures in Node | Not possible: there is no HEVC encoder in any npm package available here. Fixtures are made with Pillow + pillow-heif (x265). The script is deterministic: two runs gave the same sha256. |

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `src/images/probe.ts`: `SUPPORTED_IMAGE_MIMES`, `BROWSER_DISPLAYABLE_MIMES`, `isBrowserDisplayable(mime)`, `isHeifMime(mime)`, `class UnsupportedImageError { detectedMime }`, `type SniffResult`, `type ImageProbe`, `sha256Hex(bytes)`, `sniffImageBytes(bytes)`, `sniffImageFile(path)`, `decodeHeicToJpeg(bytes, quality?)`, `exifDateToIso(value, offset?)`, `probeImage(bytes)`.
- `src/images/store.ts`: `type DataDirs`, `dataDirs(dataDir)`, `ensureDataDirs(dataDir)`, `chooseExt(originalName, mimeExt)`, `originalRelPath(id, ext, savedAt)`, `resolveInDataDir(dataDir, rel)`, `cacheDirFor(dataDir, id)`, `fileExists(p)`, `removeQuietly(p)`, `class DestinationExistsError`, `writeNewFile(dest, bytes)`, `copyIntoNewFile(src, dest)`, `type MoveFs`, `moveIntoNewFile(src, dest, fs?)`.
- `src/images/derive.ts`: `THUMB_WIDTH` (480), `PREVIEW_LONG_EDGE` (1568), `PREVIEW_MAX_BYTES` (3 750 000), `type ImageSource {id, mime, originalPath}`, `type DerivativePaths`, `derivativePaths(dataDir, id)`, `class OriginalMissingError { id }`, `getDisplay(dataDir, src) → {path, mime}`, `getThumb(dataDir, src) → path`, `getPreview(dataDir, src) → path`.
- `src/images/records.ts`: `type ImageRecord { id, image_path, image_meta, deleted_at }`, `interface ImageRecords { bySha256(sha256); byId(id) }`, `dbImageRecords(db): ImageRecords` (read-only SQL on phase 1's `notes` table; the notes service stays the only writer).
- `src/images/ingest.ts`: `type ImageNotes` (= `Pick<NotesService, 'create' | 'getOne' | 'restore' | 'newId'>`), `type ImageDeps {dataDir, notes, records, hostname?, now?}`, `imageDeps(app: AppDeps): ImageDeps`, `type IngestInput`, `type IngestResult {note, created}`, `type LocatedImage`, `ingestImage(deps, input)`, `locateImage(deps, id)`.
- `src/images/inbox.ts`: `type InboxLogger`, `type InboxWatcherOptions`, `type InboxWatcher {idle, close}`, `isIgnoredInboxName(name)`, `startInboxWatcher(opts)`.
- `tests/fixtures/images/{exif.jpg,plain.png,photo.heic,make-fixtures.py}`, `tests/helpers/{fixtures,fakeNotes}.ts`, `tests/unit/images/{probe,store,derive,ingest,inbox}.test.ts`, `tests/integration/images.int.test.ts`.

**Signature changes:** `src/background.ts` changes from a no-op body to the inbox watcher. Its exported signature stays exactly what phase 2 ships: `startBackground(deps: AppDeps): Promise<StopBackground>`, `type StopBackground = () => Promise<void>` (A8).

**What phase 5 calls (the public API of this phase):**
```ts
// upload / MCP create_image
const img = imageDeps(deps);                                   // deps: AppDeps (phase 2's src/deps.ts)
ingestImage(img, { bytes, originalName, body, origin })        // HTTP multipart
ingestImage(img, { path, body, origin, move: false })          // MCP local path: never move the user's file
// → { note: Note, created: boolean }; throws UnsupportedImageError for non-images (→ 415/400)

// serving
const loc = await locateImage(img, id);   // null → 404 (unknown id or not an image note); loc.deleted is reported, not filtered
if (!loc.available) → 404 { error: 'not_on_this_machine', host: loc.host }
original: loc.originalPath, loc.mime
display:  await getDisplay(dataDir, loc)   // { path, mime }: the original if browser-displayable, else display.jpg
thumb:    await getThumb(dataDir, loc)     // path of thumb.webp (image/webp)
preview:  await getPreview(dataDir, loc)   // path of preview.jpg (image/jpeg); base64 of it stays < 5 MB
// getters throw OriginalMissingError if the file vanished between locate and generate
```

**Requires (from earlier phases):**

| # | From | What this phase relies on | Used in |
|---|---|---|---|
| A1 | P1 | The package is ESM (`"type": "module"`, `module: NodeNext`). Relative imports carry `.js`. Needed because file-type 22 and chokidar 5+ are ESM-only. | all |
| A2 | P1 | Installed: `sharp`, `heic-convert`, `exifr`, `file-type`, `chokidar` (any of 4/5/6), `@types/node`, `vitest`. **No `@types/heic-convert` is needed**: probe.ts loads it through `createRequire` with a local type, so it compiles with or without those types. | probe, inbox |
| A3 | P1 | `src/notes/ids.ts` exports `normalizeId(input): string \| null` (used by `records.byId`). `src/db/client.ts` exports `type Db`; `src/db/schema.ts` exports `notes` and `type ImageMeta` (`host: string \| null`, `taken_at` a UTC ISO `...Z` string or null). | records, ingest |
| A4 | P1 | The migration has the unique partial index on `(image_meta->>'sha256') WHERE image_meta IS NOT NULL AND deleted_at IS NULL`, and `notes.id` is the primary key. | ingest race handling, int test |
| A5 | P1 | `tests/integration/setup.ts` exports `openTestDb(): Db`, `closeTestDb(db)`, `truncateAll(db)` (phase 1 Step 14). | int test |
| A6 | P2 | `src/notes/types.ts` exports `Origin`, `Note` (wire shape; `deleted_at` is **absent** on a live note), `NoteError { code }`, and re-exports `ImageMeta` from phase 1's schema. | ingest, tests |
| A7 | P2 | `src/notes/service.ts` exports `class NotesService` (constructor `{ db, dataDir, events }`) with: **(a)** `newId(): Promise<string>` (an id no note has); **(b)** `create({ body, origin?, image?: { path, meta }, allowEmpty?, id? }): Promise<Note>`, which throws `NoteError('conflict')` when `id` is taken and `NoteError('duplicate_image')` when a live note already has that sha256, parses tags and emits `created`; **(c)** `getOne(id, { includeDeleted? }): Promise<Note \| null>`; **(d)** `restore(id): Promise<Note>` (emits `restored`); **(e)** `delete(id)` (soft; int test only); **(f)** `findBySha256(sha, { includeDeleted? })` (int test only). P2 computes `Note.image.available` as "the file exists under `dataDir`". Raw storage reads that the service does not expose (`image_path`, `image_meta`, deleted state by sha256 or id) live in this phase's `src/images/records.ts`, reading through `Db`, never writing. | ingest, records, tests |
| A8 | P2 | `src/background.ts` exists as a no-op `startBackground(deps: AppDeps): Promise<StopBackground>`; `src/daemon.ts` calls it after the HTTP server listens and awaits the stop function in `stop()`. `AppDeps = { config: Config; db: Db; events: NoteEvents; service: NotesService }` (`src/deps.ts`). This phase replaces the file body only. | background |

**Leaves alone (owned by others):** `package.json` / `package-lock.json` / migrations (P1); `src/notes/*`, `src/mcp/*`, `src/http/*`, `src/main.ts` (P2/P5/P6); `src/notes/repo.ts` list filters, `src/http/images.ts`, `src/mcp/imageTools.ts` (P5); `web/**` (P7/P8).

## Files

| File | Action | What changes |
|---|---|---|
| `src/images/probe.ts` | create | magic-byte sniffing, sha256, EXIF date, width/height, HEIC decode helper |
| `src/images/store.ts` | create | data-dir layout, path rules, byte-exact no-clobber writes, move with EXDEV fallback |
| `src/images/derive.ts` | create | lazy thumb/preview/display getters with an in-flight promise map |
| `src/images/records.ts` | create | read-only image lookups by sha256 / id (`image_path`, `image_meta`, deleted state) |
| `src/images/ingest.ts` | create | `ingestImage`, `locateImage`, `imageDeps`, dedupe and restore, write-then-insert race handling |
| `src/images/inbox.ts` | create | chokidar watcher, serial queue, failures to `inbox/failed/` |
| `src/background.ts:1` | replace body | P2's no-op becomes "ensure data dirs + start inbox watcher" |
| `tests/fixtures/images/exif.jpg` | create (binary) | 64×48 JPEG, EXIF DateTimeOriginal `2024:10:30 14:05:09` |
| `tests/fixtures/images/plain.png` | create (binary) | 40×30 PNG, no EXIF |
| `tests/fixtures/images/photo.heic` | create (binary) | 64×48 HEVC HEIC, same EXIF date |
| `tests/fixtures/images/make-fixtures.py` | create | how the three fixtures were made |
| `tests/helpers/fixtures.ts` | create | fixture paths + temp dir helper |
| `tests/helpers/fakeNotes.ts` | create | in-memory `ImageNotes` + `ImageRecords` with the schema's unique rules (raises P2's `NoteError('conflict' / 'duplicate_image')`) |
| `tests/unit/images/probe.test.ts` | create | probe and sniff |
| `tests/unit/images/store.test.ts` | create | paths, byte-exact writes, EXDEV fallback |
| `tests/unit/images/derive.test.ts` | create | thumb, preview, display, concurrency, cache wipe |
| `tests/unit/images/ingest.test.ts` | create | dedupe, restore, move/copy, insert failure cleanup, races |
| `tests/unit/images/inbox.test.ts` | create | startup files, drops, stability wait, ignores, failures, duplicates |
| `tests/integration/images.int.test.ts` | create | the same against Postgres and the real notes service |

## Implementation Steps

### Step 1: Fixtures
**Files:** `tests/fixtures/images/exif.jpg`, `plain.png`, `photo.heic`, `make-fixtures.py` (new)
**Change:** Commit three tiny fixtures (1012, 131 and 692 bytes). Node cannot encode HEVC, so they are committed rather than generated. Write them from the base64 below, which is exactly what `make-fixtures.py` produced (deterministic), and check the sha256:

```bash
mkdir -p tests/fixtures/images && cd tests/fixtures/images
base64 -d > exif.jpg <<'B64'
/9j/4AAQSkZJRgABAQAAAQABAAD/4QBgRXhpZgAATU0AKgAAAAgAAgEQAAIAAAALAAAAJodpAAQAAAABAAAAMgAAAABGaXh0dXJl
Q2FtAAAAAZADAAIAAAAUAAAARAAAAAAyMDI0OjEwOjMwIDE0OjA1OjA5AP/bAEMABgQFBgUEBgYFBgcHBggKEAoKCQkKFA4PDBAX
FBgYFxQWFhodJR8aGyMcFhYgLCAjJicpKikZHy0wLSgwJSgpKP/bAEMBBwcHCggKEwoKEygaFhooKCgoKCgoKCgoKCgoKCgoKCgo
KCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKP/AABEIADAAQAMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAAAAQID
BAUGBwgJCgv/xAC1EAACAQMDAgQDBQUEBAAAAX0BAgMABBEFEiExQQYTUWEHInEUMoGRoQgjQrHBFVLR8CQzYnKCCQoWFxgZGiUm
JygpKjQ1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3
uLm6wsPExcbHyMnK0tPU1dbX2Nna4eLj5OXm5+jp6vHy8/T19vf4+fr/xAAfAQADAQEBAQEBAQEBAAAAAAAAAQIDBAUGBwgJCgv/
xAC1EQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3
ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TF
xsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/APnuK09quxWntWpFae1XYrT2r7WpiThwuMMuG06c
VcitPatWK09quxWntXFPEn0mFxhlQ2ntV2K09q1IrT2q7Fae1cc8SfS4XGGXFae1XIrT2rVitParsVp7Vx1MSfS4XGHDxWntVyK0
9q1YrT2q7Dae1aTxJ/NGFxhlRWntV2K09q1IrT2q7Fae1cdTEn0uFxhlw2ntVyK09q1YrT2q7Fae1cdTEn0mFxhlRWntV2K09q1I
rT2q7Fae1cU8SfS4XGHDxWntV2K09q1YrT2q5Fae1a1MSfzThcYZcVp7VditPatSK09quw2ntXHPEn0mFxhlRWntV2K09q1YrT2q
5Fae1cc8SfS4XGGXDae1XIrT2rVitParsVp7VxVMSfSYXGH/2Q==
B64
base64 -d > plain.png <<'B64'
iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAASklEQVR4nO3PMQ6AMAzAQCNVBX7dp7MiZuQuzpRkse6ANWHCCe/l
c/7+H1xsmcG9K5xYCyfWwom1cGItnFgLJ9bCibVwYi2cWJoHuaEC5Ls5JT8AAAAASUVORK5CYII=
B64
base64 -d > photo.heic <<'B64'
AAAAHGZ0eXBoZWljAAAAAG1pZjFoZWljbWlhZgAAAb5tZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAA
ADRpbG9jAAAAAERAAAIAAQAAAAAB4gABAAAAAAAAAHAAAgAAAAACUgABAAAAAAAAAGIAAAA4aWluZgAAAAAAAgAAABVpbmZlAgAA
AAABAABodmMxAAAAABVpbmZlAgAAAQACAABFeGlmAAAAAA5waXRtAAAAAAABAAAA/WlwcnAAAADdaXBjbwAAAHZodmNDAQNwAAAA
kAAAAAAAHvAA/P34+AAADwNgAAEAGEABDAH//wNwAAADAJAAAAMAAAMAHroCQGEAAQAqQgEBA3AAAAMAkAAAAwAAAwAeoCCBBZbq
5Ka5uAhoMCAAAAMDIAAAAwAhYgABAAZEAcFzwIkAAAATY29scm5jbHgAAQANAAaAAAAAFGlzcGUAAAAAAAAAQAAAAEAAAAAoY2xh
cAAAAEAAAAABAAAAMAAAAAEAAAAAAAAAAv////AAAAACAAAAEHBpeGkAAAAAAwgICAAAABhpcG1hAAAAAAAAAAEAAQWBAgMFhAAA
ABppcmVmAAAAAAAAAA5jZHNjAAIAAQABAAAA2m1kYXQAAABsKAGvE4D1RT3jVcGz+wXR36dgj4OWdrkffvOEYd3tvcZbCGPR3Lj8
DXT/5J1yGtYiPuA+Cr9D48w7wnYih1yygn+H0dfkZubvnocY4+TcqjQSxPAFQhxjo5UyWm11WStPFcFbTKhcoXZq5JOAAAAABkV4
aWYAAE1NACoAAAAIAAIBEAACAAAACwAAACaHaQAEAAAAAQAAADIAAAAARml4dHVyZUNhbQAAAAGQAwACAAAAFAAAAEQAAAAAMjAy
NDoxMDozMCAxNDowNTowOQA=
B64
sha256sum -c <<'SUM'
3e535b52b051ed822a68c15c15395a9e7f482c04aeb11eba86b209e539a64d3b  exif.jpg
528cd794a2c3cb469b0ff0fc0ecc282c8e7ba006b04c48c7a008d3a43168f6cc  plain.png
1f0797afd499c879f5c10186c5ff260c500124592e8f7ead289de63563b7c830  photo.heic
SUM
```

**Code** (`tests/fixtures/images/make-fixtures.py`):
```python
"""Regenerate the image fixtures in this directory.

    python3 -m venv /tmp/fx-venv && /tmp/fx-venv/bin/pip install pillow pillow-heif
    /tmp/fx-venv/bin/python tests/fixtures/images/make-fixtures.py tests/fixtures/images

Made with Pillow 13.0.0 + pillow-heif 1.8.1 (libheif 1.23.6, x265 4.3). Node cannot write
HEVC (sharp's prebuilt libheif has no HEVC encoder), which is why these are committed.
Regenerating may change bytes (and sha256), not the properties the tests rely on.
"""
import sys

import pillow_heif
from PIL import Image


def gradient(w: int, h: int) -> Image.Image:
    im = Image.new("RGB", (w, h))
    px = im.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = (x * 255 // w, y * 255 // h, 128)
    return im


def main(out: str) -> None:
    exif = Image.Exif()
    exif[0x0110] = "FixtureCam"  # Model (IFD0)
    exif.get_ifd(0x8769)[0x9003] = "2024:10:30 14:05:09"  # ExifIFD DateTimeOriginal, no offset
    gradient(64, 48).save(f"{out}/exif.jpg", "JPEG", quality=80, exif=exif.tobytes())
    gradient(40, 30).save(f"{out}/plain.png", "PNG")
    pillow_heif.register_heif_opener()
    gradient(64, 48).save(f"{out}/photo.heic", "HEIF", quality=50, exif=exif.tobytes())


if __name__ == "__main__":
    main(sys.argv[1])
```
**Impact:** none on the build. vitest does not pick up `.py` or binary files.

### Step 2: `src/images/probe.ts`
**File:** `src/images/probe.ts:1` (new)
**Change:** Sniff the mime by magic bytes (file-type) and accept only supported image mimes. Width and height come from sharp metadata (display-oriented), with no pixel decode, HEIC included. EXIF `DateTimeOriginal` is read by exifr from sharp's extracted EXIF block, which avoids exifr's HEIC parsing bug. `decodeHeicToJpeg` wraps heic-convert behind `createRequire` with a local type, so `@types/heic-convert` is not needed.
**Code:**
```ts
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import exifr from 'exifr';
import { fileTypeFromBuffer, fileTypeFromFile } from 'file-type';
import sharp from 'sharp';

/** Mime types notesd accepts as image notes (detected by magic bytes, never by extension). */
export const SUPPORTED_IMAGE_MIMES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
  'image/tiff',
]);

/** Originals a browser can show as-is. Everything else gets a `display.jpg` derivative. */
export const BROWSER_DISPLAYABLE_MIMES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
]);

const HEIF_MIMES: ReadonlySet<string> = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);

export function isBrowserDisplayable(mime: string): boolean {
  return BROWSER_DISPLAYABLE_MIMES.has(mime);
}

export function isHeifMime(mime: string): boolean {
  return HEIF_MIMES.has(mime);
}

export class UnsupportedImageError extends Error {
  readonly detectedMime: string | null;
  constructor(detectedMime: string | null) {
    super(
      detectedMime
        ? `unsupported file type ${detectedMime}: not an image notesd can store`
        : 'unrecognised file type: not an image notesd can store',
    );
    this.name = 'UnsupportedImageError';
    this.detectedMime = detectedMime;
  }
}

export type SniffResult = { mime: string; ext: string };

export type ImageProbe = {
  mime: string;
  /** Extension file-type reports for the detected mime, lower-case, no dot. */
  mimeExt: string;
  width: number;
  height: number;
  /** EXIF DateTimeOriginal as an ISO-8601 UTC string, null when absent or unparseable. */
  taken_at: string | null;
};

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function toSniff(ft: { mime: string; ext: string } | undefined): SniffResult | null {
  if (!ft || !SUPPORTED_IMAGE_MIMES.has(ft.mime)) return null;
  return { mime: ft.mime, ext: ft.ext.toLowerCase() };
}

/** Supported image type of a buffer by magic bytes, or null. */
export async function sniffImageBytes(bytes: Uint8Array): Promise<SniffResult | null> {
  return toSniff(await fileTypeFromBuffer(bytes));
}

/** Supported image type of a file by magic bytes, or null. Reads only the file header. */
export async function sniffImageFile(path: string): Promise<SniffResult | null> {
  return toSniff(await fileTypeFromFile(path));
}

type HeicConvertFn = (opts: {
  buffer: ArrayBufferLike | Uint8Array;
  format: 'JPEG' | 'PNG';
  quality?: number;
}) => Promise<ArrayBuffer | Uint8Array>;

const requireCjs = createRequire(import.meta.url);
let heicConvertFn: HeicConvertFn | null = null;

/**
 * Decode an HEVC-coded HEIC/HEIF to a full-resolution JPEG.
 * sharp's prebuilt libvips reads HEIC headers (size, EXIF) but cannot decode HEVC pixels
 * ("Support for this compression format has not been built in: HEVC"); heic-convert
 * (libheif compiled to WASM) can. libheif applies the container's rotation, so the
 * output is display-oriented and carries no EXIF.
 */
export async function decodeHeicToJpeg(bytes: Uint8Array, quality = 0.92): Promise<Buffer> {
  heicConvertFn ??= requireCjs('heic-convert') as HeicConvertFn;
  const out = await heicConvertFn({ buffer: bytes, format: 'JPEG', quality });
  return Buffer.from(out instanceof Uint8Array ? out : new Uint8Array(out));
}

/** "2024:10:30 14:05:09" (+ optional "+07:00") -> ISO UTC. No offset means process-local time. */
export function exifDateToIso(value: unknown, offset?: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== 'string') return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  if (y === 0 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const off = typeof offset === 'string' ? /^([+-])(\d{2}):?(\d{2})$/.exec(offset.trim()) : null;
  let ms: number;
  if (off) {
    const sign = off[1] === '-' ? -1 : 1;
    const offMin = sign * (Number(off[2]) * 60 + Number(off[3]));
    ms = Date.UTC(y, mo - 1, d, h, mi, s) - offMin * 60_000;
  } else {
    ms = new Date(y, mo - 1, d, h, mi, s).getTime();
  }
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** EXIF taken date from the raw EXIF block sharp extracted ("Exif\0\0" + TIFF). */
async function readTakenAt(exif: Buffer | undefined): Promise<string | null> {
  if (!exif || exif.length < 8) return null;
  const tiff = exif.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? exif.subarray(6) : exif;
  try {
    const tags = (await exifr.parse(tiff, {
      pick: ['DateTimeOriginal', 'OffsetTimeOriginal'],
      reviveValues: false,
    })) as { DateTimeOriginal?: unknown; OffsetTimeOriginal?: unknown } | undefined;
    if (!tags) return null;
    return exifDateToIso(tags.DateTimeOriginal, tags.OffsetTimeOriginal);
  } catch {
    return null;
  }
}

/**
 * Mime (magic bytes), display-oriented width/height, EXIF taken_at.
 * Throws UnsupportedImageError for anything that is not a supported image.
 *
 * EXIF is read from sharp's extracted EXIF block rather than by exifr on the whole
 * file: exifr 7.1.3 reports "Malformed EXIF data" on libheif-written HEIC files, while
 * sharp extracts the block from JPEG, PNG, WebP, AVIF, HEIC and TIFF alike.
 */
export async function probeImage(bytes: Uint8Array): Promise<ImageProbe> {
  const sniff = await sniffImageBytes(bytes);
  if (!sniff) {
    const ft = await fileTypeFromBuffer(bytes);
    throw new UnsupportedImageError(ft?.mime ?? null);
  }
  let width = 0;
  let height = 0;
  let exif: Buffer | undefined;
  try {
    const meta = await sharp(bytes).metadata();
    width = meta.autoOrient?.width ?? meta.width ?? 0;
    height = meta.autoOrient?.height ?? meta.height ?? 0;
    exif = meta.exif;
  } catch (err) {
    if (!isHeifMime(sniff.mime)) throw err;
  }
  if ((width === 0 || height === 0) && isHeifMime(sniff.mime)) {
    const meta = await sharp(await decodeHeicToJpeg(bytes)).metadata();
    width = meta.width ?? 0;
    height = meta.height ?? 0;
  }
  if (width === 0 || height === 0) throw new UnsupportedImageError(sniff.mime);
  return { mime: sniff.mime, mimeExt: sniff.ext, width, height, taken_at: await readTakenAt(exif) };
}
```
**Impact:** new module. Nothing imports it yet.

### Step 3: `src/images/store.ts`
**File:** `src/images/store.ts:1` (new)
**Change:** Data-dir layout and path rules. The extension is the original filename's, lower-cased and limited to `[a-z0-9]{1,8}`, else file-type's ext for the mime. `YYYY/MM` is the process-local date at save time. Writes go to a temp sibling and are renamed into place, so nothing ever sees a half-written original, and they refuse to overwrite an existing file (originals are never modified). A move falls back to copy, rename, then unlink the source on `EXDEV`.
**Code:**
```ts
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type DataDirs = {
  root: string;
  images: string;
  cache: string;
  inbox: string;
  failed: string;
};

export function dataDirs(dataDir: string): DataDirs {
  const root = path.resolve(dataDir);
  return {
    root,
    images: path.join(root, 'images'),
    cache: path.join(root, 'cache'),
    inbox: path.join(root, 'inbox'),
    failed: path.join(root, 'inbox', 'failed'),
  };
}

/** Create images/, cache/, inbox/ and inbox/failed/ under the data dir if missing. */
export async function ensureDataDirs(dataDir: string): Promise<DataDirs> {
  const dirs = dataDirs(dataDir);
  for (const d of [dirs.images, dirs.cache, dirs.failed]) await mkdir(d, { recursive: true });
  return dirs;
}

const SAFE_EXT = /^[a-z0-9]{1,8}$/;

/** Extension of the stored original: the original filename's, lower-cased, else the mime's. */
export function chooseExt(originalName: string | null | undefined, mimeExt: string): string {
  if (originalName) {
    const ext = path.extname(originalName).slice(1).toLowerCase();
    if (SAFE_EXT.test(ext)) return ext;
  }
  return mimeExt.toLowerCase();
}

/** `images/YYYY/MM/<id>.<ext>`, forward slashes, YYYY/MM in process-local time of `savedAt`. */
export function originalRelPath(id: string, ext: string, savedAt: Date): string {
  const yyyy = String(savedAt.getFullYear()).padStart(4, '0');
  const mm = String(savedAt.getMonth() + 1).padStart(2, '0');
  return `images/${yyyy}/${mm}/${id}.${ext}`;
}

/** Absolute path of a data-dir-relative path. Refuses anything that escapes the data dir. */
export function resolveInDataDir(dataDir: string, rel: string): string {
  const root = path.resolve(dataDir);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path escapes the data dir: ${rel}`);
  }
  return abs;
}

export function cacheDirFor(dataDir: string, id: string): string {
  return path.join(dataDirs(dataDir).cache, id);
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

export async function removeQuietly(p: string): Promise<void> {
  await rm(p, { force: true, recursive: true }).catch(() => undefined);
}

export class DestinationExistsError extends Error {
  constructor(dest: string) {
    super(`refusing to overwrite existing file ${dest}`);
    this.name = 'DestinationExistsError';
  }
}

function tmpSibling(dest: string): string {
  return `${dest}.${process.pid}.${randomUUID()}.tmp`;
}

async function prepareDest(dest: string): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  if (await fileExists(dest)) throw new DestinationExistsError(dest);
}

/** Write bytes byte for byte to a new file: temp sibling, then rename, so no reader sees a partial file. */
export async function writeNewFile(dest: string, bytes: Uint8Array): Promise<void> {
  await prepareDest(dest);
  const tmp = tmpSibling(dest);
  try {
    await writeFile(tmp, bytes, { flag: 'wx' });
    await rename(tmp, dest);
  } catch (err) {
    await removeQuietly(tmp);
    throw err;
  }
}

/** Copy a file to a new destination (source untouched). */
export async function copyIntoNewFile(src: string, dest: string): Promise<void> {
  await prepareDest(dest);
  const tmp = tmpSibling(dest);
  try {
    await copyFile(src, tmp);
    await rename(tmp, dest);
  } catch (err) {
    await removeQuietly(tmp);
    throw err;
  }
}

export type MoveFs = {
  rename: (from: string, to: string) => Promise<void>;
  unlink: (p: string) => Promise<void>;
};

const realMoveFs: MoveFs = { rename, unlink };

/**
 * Move a file to a new destination. rename() when on the same filesystem; on EXDEV
 * (inbox on another mount) copy to a temp sibling, rename into place, then unlink the source.
 */
export async function moveIntoNewFile(src: string, dest: string, fs: MoveFs = realMoveFs): Promise<void> {
  await prepareDest(dest);
  try {
    await fs.rename(src, dest);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
  }
  await copyIntoNewFile(src, dest);
  await fs.unlink(src);
}
```
**Impact:** new module.

### Step 4: `src/images/derive.ts`
**File:** `src/images/derive.ts:1` (new)
**Change:** Lazy derivative getters return absolute file paths and generate on first request into `cache/<id>/`. Concurrent requests for the same output path share one promise (an in-flight `Map`). Output is written to a temp sibling and renamed, so a reader never gets a partial file and a wiped cache simply regenerates.
- `display.jpg` is made only for non-browser formats (HEIC/HEIF/TIFF). HEVC goes through heic-convert. Everything else, including AV1-coded HEIF and TIFF, goes through sharp `.rotate()`, then JPEG q92 with mozjpeg.
- `thumb.webp` is 480 px wide, never enlarged, WebP q80.
- `preview.jpg` has a long edge of at most 1568 px, flattened on white (for alpha PNGs), and walks JPEG quality 85→35 until it is at most 3 750 000 bytes. That is the raw budget whose base64 stays under Claude's 5 MB image limit, since MCP image content is base64. At 1568 px a JPEG lands far below this, so the loop is a guard.
- For HEIC, thumb and preview are cut from `display.jpg`, so the expensive WASM decode happens once per image.
**Code:**
```ts
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { decodeHeicToJpeg, isBrowserDisplayable, isHeifMime } from './probe.js';
import { cacheDirFor, fileExists, removeQuietly } from './store.js';

export const THUMB_WIDTH = 480;
export const PREVIEW_LONG_EDGE = 1568;
/**
 * Claude rejects images over 5 MB. MCP image content is base64 (4/3 inflation), so the raw
 * JPEG budget is 3.75 MB: its base64 stays under 5,000,000 bytes.
 */
export const PREVIEW_MAX_BYTES = 3_750_000;
const PREVIEW_QUALITIES = [85, 75, 65, 50, 35] as const;
const DISPLAY_QUALITY = 92;

/** What the derivative getters need to know about an image note. */
export type ImageSource = {
  id: string;
  mime: string;
  /** Absolute path of the original. */
  originalPath: string;
};

export type DerivativePaths = { dir: string; thumb: string; preview: string; display: string };

export function derivativePaths(dataDir: string, id: string): DerivativePaths {
  const dir = cacheDirFor(dataDir, id);
  return {
    dir,
    thumb: path.join(dir, 'thumb.webp'),
    preview: path.join(dir, 'preview.jpg'),
    display: path.join(dir, 'display.jpg'),
  };
}

export class OriginalMissingError extends Error {
  readonly id: string;
  constructor(id: string, originalPath: string) {
    super(`original of ${id} is not on this machine (${originalPath})`);
    this.name = 'OriginalMissingError';
    this.id = id;
  }
}

/** One generation per output path at a time; concurrent callers share the promise. */
const inFlight = new Map<string, Promise<string>>();

async function nonEmptyFile(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

function ensureDerivative(out: string, make: (tmp: string) => Promise<void>): Promise<string> {
  const running = inFlight.get(out);
  if (running) return running;
  const job = (async () => {
    if (await nonEmptyFile(out)) return out;
    await mkdir(path.dirname(out), { recursive: true });
    const tmp = `${out}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await make(tmp);
      await rename(tmp, out);
    } catch (err) {
      await removeQuietly(tmp);
      throw err;
    }
    return out;
  })().finally(() => inFlight.delete(out));
  inFlight.set(out, job);
  return job;
}

async function assertOriginal(src: ImageSource): Promise<void> {
  if (!(await fileExists(src.originalPath))) throw new OriginalMissingError(src.id, src.originalPath);
}

async function isHevc(originalPath: string): Promise<boolean> {
  try {
    const meta = await sharp(originalPath).metadata();
    return meta.compression === 'hevc';
  } catch {
    return true;
  }
}

/**
 * The browser-viewable full-resolution file: the original itself for JPEG/PNG/GIF/WebP/AVIF,
 * else `cache/<id>/display.jpg` (HEIC/HEIF/TIFF), generated on first request.
 */
export async function getDisplay(dataDir: string, src: ImageSource): Promise<{ path: string; mime: string }> {
  await assertOriginal(src);
  if (isBrowserDisplayable(src.mime)) return { path: src.originalPath, mime: src.mime };
  const out = derivativePaths(dataDir, src.id).display;
  const file = await ensureDerivative(out, async (tmp) => {
    if (isHeifMime(src.mime) && (await isHevc(src.originalPath))) {
      await writeFile(tmp, await decodeHeicToJpeg(await readFile(src.originalPath), DISPLAY_QUALITY / 100));
      return;
    }
    await sharp(src.originalPath, { failOn: 'none' })
      .rotate()
      .jpeg({ quality: DISPLAY_QUALITY, mozjpeg: true })
      .toFile(tmp);
  });
  return { path: file, mime: 'image/jpeg' };
}

/** A sharp pipeline over decodable pixels: the original, or display.jpg when sharp cannot decode it. */
async function decodable(dataDir: string, src: ImageSource): Promise<Sharp> {
  if (isBrowserDisplayable(src.mime)) return sharp(src.originalPath, { failOn: 'none' }).rotate();
  const display = await getDisplay(dataDir, src);
  return sharp(display.path, { failOn: 'none' }).rotate();
}

/** `cache/<id>/thumb.webp`: 480 px wide (never enlarged), WebP. */
export async function getThumb(dataDir: string, src: ImageSource): Promise<string> {
  await assertOriginal(src);
  const out = derivativePaths(dataDir, src.id).thumb;
  return ensureDerivative(out, async (tmp) => {
    const img = await decodable(dataDir, src);
    await img.resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 80 }).toFile(tmp);
  });
}

/** `cache/<id>/preview.jpg`: long edge <= 1568 px, JPEG, under PREVIEW_MAX_BYTES. What Claude sees. */
export async function getPreview(dataDir: string, src: ImageSource): Promise<string> {
  await assertOriginal(src);
  const out = derivativePaths(dataDir, src.id).preview;
  return ensureDerivative(out, async (tmp) => {
    const img = await decodable(dataDir, src);
    const resized = await img
      .resize({ width: PREVIEW_LONG_EDGE, height: PREVIEW_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .toBuffer();
    let jpeg: Buffer | null = null;
    for (const quality of PREVIEW_QUALITIES) {
      jpeg = await sharp(resized).jpeg({ quality, mozjpeg: true }).toBuffer();
      if (jpeg.length <= PREVIEW_MAX_BYTES) break;
    }
    if (!jpeg || jpeg.length > PREVIEW_MAX_BYTES) {
      throw new Error(`preview of ${src.id} stays over ${PREVIEW_MAX_BYTES} bytes`);
    }
    await writeFile(tmp, jpeg);
  });
}
```
**Impact:** new module. Originals are only ever read (Invariant 6).

### Step 5: `src/images/records.ts`
**File:** `src/images/records.ts:1` (new)
**Change:** The two raw reads ingestion and serving need and phase 2's service does not expose
(it returns wire `Note`s, which carry no `image_path`/`sha256`). Read-only, through phase 1's
`Db` and schema; the notes service stays the only writer (index Seams). `bySha256` uses the
indexed expression `image_meta->>'sha256'` (phase 1 handoff) and prefers the live note, then the
most recently deleted one. `byId` normalises the id, includes soft-deleted notes, and returns
null for an unknown id or a note without an image.
**Code:**
```ts
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { notes, type ImageMeta, type NoteRow } from '../db/schema.js';
import { normalizeId } from '../notes/ids.js';

/** Raw storage fields of an image note (not a wire shape). */
export type ImageRecord = {
  id: string;
  /** Relative to the data dir: images/YYYY/MM/<id>.<ext>. */
  image_path: string;
  image_meta: ImageMeta;
  /** ISO string, or null for a live note. */
  deleted_at: string | null;
};

export interface ImageRecords {
  /** The live note holding these bytes, else the most recently deleted one, else null. */
  bySha256(sha256: string): Promise<ImageRecord | null>;
  /** Case/dash-tolerant id; soft-deleted notes included; null when unknown or not an image note. */
  byId(id: string): Promise<ImageRecord | null>;
}

function toRecord(row: NoteRow): ImageRecord | null {
  if (row.imagePath === null || row.imageMeta === null) return null;
  return {
    id: row.id,
    image_path: row.imagePath,
    image_meta: row.imageMeta,
    deleted_at: row.deletedAt === null ? null : row.deletedAt.toISOString(),
  };
}

export function dbImageRecords(db: Db): ImageRecords {
  return {
    async bySha256(sha256) {
      const rows = await db
        .select()
        .from(notes)
        .where(and(isNotNull(notes.imagePath), eq(sql`${notes.imageMeta} ->> 'sha256'`, sha256)))
        .orderBy(sql`${notes.deletedAt} is not null`, desc(notes.deletedAt))
        .limit(1);
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async byId(input) {
      const id = normalizeId(input);
      if (id === null) return null;
      const rows = await db.select().from(notes).where(eq(notes.id, id)).limit(1);
      return rows[0] ? toRecord(rows[0]) : null;
    },
  };
}
```
**Impact:** none outside this phase; phase 5 reaches it only through `imageDeps(app)`.

### Step 5b: `src/images/ingest.ts`
**File:** `src/images/ingest.ts:1` (new)
**Change:** `ingestImage(deps, input)` works in this order:
1. Read the bytes (the input buffer, or the file at `path`) and take their sha256.
2. Take an in-process per-sha lock, so two concurrent ingests of the same bytes in this daemon run one after the other and the second sees the first's row.
3. `records.bySha256` → on a hit, `reuseExisting`. A live match is returned (`created:false`) via `notes.getOne`. A soft-deleted match goes through `notes.restore` (the service emits `restored`). If this machine lacks that note's original (the GPD ingested it), the identical bytes are put at its `image_path`, which is safe because the sha256 matches. With `move:true` the source is always consumed, and never when it *is* the stored original.
4. On a miss: probe (throws `UnsupportedImageError`, writing nothing), build `image_meta`, **reserve the id first** (`await notes.newId()`, phase 2), write the original to `images/YYYY/MM/<id>.<ext>`, then `notes.create({ id, body, origin, image: { path, meta }, allowEmpty: true })`.
5. If the insert fails, the file is removed, or a moved source is moved back to its path so the inbox can file it under `failed/`. `NoteError('duplicate_image')` means another host inserted the same bytes in the meantime (look it up again and return that note, `created:false`); `NoteError('conflict')` means an id clash (retry with a new id, at most 5 attempts). Any other error is rethrown.

`locateImage(deps, id)` turns `records.byId` into the `ImageSource` the getters take, plus `available`, `host`, `deleted` and `relPath` for phase 5's routes. `imageDeps(app)` builds `ImageDeps` from phase 2's `AppDeps`, so `background.ts` and phase 5 never assemble it by hand.

The id has to exist before the file is written so the file can be named after it, and the write has to happen before the insert so a committed row never points at a missing file. Phase 2's `create({ id })` supports exactly this.
**Code:**
```ts
import { readFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppDeps } from '../deps.js';
import type { NotesService } from '../notes/service.js';
import { NoteError, type ImageMeta, type Note, type Origin } from '../notes/types.js';
import type { ImageSource } from './derive.js';
import { probeImage, sha256Hex } from './probe.js';
import { dbImageRecords, type ImageRecord, type ImageRecords } from './records.js';
import {
  chooseExt,
  copyIntoNewFile,
  fileExists,
  moveIntoNewFile,
  originalRelPath,
  removeQuietly,
  resolveInDataDir,
  writeNewFile,
} from './store.js';

/** The slice of the notes service image ingestion uses. All writes go through it. */
export type ImageNotes = Pick<NotesService, 'create' | 'getOne' | 'restore' | 'newId'>;

export type ImageDeps = {
  dataDir: string;
  notes: ImageNotes;
  /** Raw image lookups (read-only). */
  records: ImageRecords;
  /** Defaults to os.hostname(). Tests override it. */
  hostname?: () => string;
  /** Defaults to new Date(). Decides images/YYYY/MM. */
  now?: () => Date;
};

/** ImageDeps for the running daemon (background.ts, phase 5's routes and MCP tools). */
export function imageDeps(app: AppDeps): ImageDeps {
  return { dataDir: app.config.dataDir, notes: app.service, records: dbImageRecords(app.db) };
}
type IngestCommon = {
  /** Name the file had on the user's side. Its extension (lower-cased) names the stored file. */
  originalName?: string | null;
  /** Note text. Defaults to ''. Hashtags in it become tags as for any note. */
  body?: string;
  origin?: Origin | null;
};

export type IngestInput =
  | (IngestCommon & { bytes: Uint8Array; path?: undefined; move?: undefined })
  | (IngestCommon & {
      path: string;
      bytes?: undefined;
      /** Rename the file into the store instead of copying it. On success the source is always consumed. */
      move?: boolean;
    });

export type IngestResult = { note: Note; created: boolean };

/** Where an image note's original lives on this machine, and whether it is here. */
export type LocatedImage = ImageSource & {
  /** `image_path` as stored: relative to the data dir. */
  relPath: string;
  available: boolean;
  /** Host that ingested the file (`image_meta.host`). */
  host: string | null;
  deleted: boolean;
  meta: ImageMeta;
};

const MAX_ID_ATTEMPTS = 5;

/** Serialises ingests of the same bytes inside this process (the DB index covers other hosts). */
const shaLocks = new Map<string, Promise<unknown>>();

async function withShaLock<T>(sha256: string, fn: () => Promise<T>): Promise<T> {
  const prev = shaLocks.get(sha256) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  shaLocks.set(sha256, tail);
  try {
    return await run;
  } finally {
    if (shaLocks.get(sha256) === tail) shaLocks.delete(sha256);
  }
}

/** Put a file's bytes at `dest` from wherever the caller's input lives. */
async function placeOriginal(dest: string, bytes: Uint8Array, sourcePath: string | null, move: boolean): Promise<void> {
  if (sourcePath === null) await writeNewFile(dest, bytes);
  else if (move) await moveIntoNewFile(sourcePath, dest);
  else await copyIntoNewFile(sourcePath, dest);
}

/** Undo placeOriginal after a failed insert: a moved source goes back where it was. */
async function unplaceOriginal(dest: string, sourcePath: string | null, move: boolean): Promise<void> {
  if (sourcePath !== null && move) {
    await moveIntoNewFile(dest, sourcePath).catch(() => removeQuietly(dest));
    return;
  }
  await removeQuietly(dest);
}

/**
 * The bytes are already a note. Return it (restoring it when soft-deleted). If this machine
 * lacks the original (the note was ingested on another host), the identical bytes are put at
 * the note's image_path here. With move=true the source is consumed either way.
 */
async function reuseExisting(
  deps: ImageDeps,
  existing: ImageRecord,
  bytes: Uint8Array,
  sourcePath: string | null,
  move: boolean,
): Promise<IngestResult> {
  const abs = resolveInDataDir(deps.dataDir, existing.image_path);
  if (!(await fileExists(abs))) {
    await placeOriginal(abs, bytes, sourcePath, move);
  } else if (sourcePath !== null && move && path.resolve(sourcePath) !== abs) {
    await unlink(sourcePath).catch(() => undefined);
  }
  const note = existing.deleted_at !== null ? await deps.notes.restore(existing.id) : await deps.notes.getOne(existing.id);
  if (!note) throw new Error(`image note ${existing.id} vanished during ingest`);
  return { note, created: false };
}

/**
 * Store an image and create its note, or return the note that already holds these bytes.
 *
 * sha256 of the bytes -> a non-deleted match is returned unchanged (created: false); a
 * soft-deleted match is restored and returned (created: false). Otherwise: probe (mime by
 * magic bytes, size, EXIF taken_at), generate the id, write the original byte for byte to
 * images/YYYY/MM/<id>.<ext>, then create the note through the notes service. If the insert
 * fails the file is removed (or moved back to its source); NoteError('duplicate_image') is a
 * concurrent ingest of the same bytes (return the winner), NoteError('conflict') an id clash
 * (retry with a new id).
 *
 * Throws UnsupportedImageError (from probe.ts) for anything that is not a supported image.
 */
export async function ingestImage(deps: ImageDeps, input: IngestInput): Promise<IngestResult> {
  const sourcePath = input.path !== undefined ? path.resolve(input.path) : null;
  const move = sourcePath !== null && input.move === true;
  const bytes: Uint8Array = sourcePath !== null ? await readFile(sourcePath) : input.bytes!;
  const sha256 = sha256Hex(bytes);

  return withShaLock(sha256, async () => {
    const existing = await deps.records.bySha256(sha256);
    if (existing) return reuseExisting(deps, existing, bytes, sourcePath, move);

    const probe = await probeImage(bytes);
    const nameSource = input.originalName ?? (sourcePath !== null ? path.basename(sourcePath) : null);
    const originalName = nameSource ? path.basename(nameSource) : null;
    const ext = chooseExt(originalName, probe.mimeExt);
    const savedAt = (deps.now ?? (() => new Date()))();
    const meta: ImageMeta = {
      sha256,
      mime: probe.mime,
      width: probe.width,
      height: probe.height,
      bytes: bytes.byteLength,
      taken_at: probe.taken_at,
      original_name: originalName,
      host: (deps.hostname ?? os.hostname)(),
    };

    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
      const id = await deps.notes.newId();
      const relPath = originalRelPath(id, ext, savedAt);
      const abs = resolveInDataDir(deps.dataDir, relPath);
      if (await fileExists(abs)) continue;
      await placeOriginal(abs, bytes, sourcePath, move);
      try {
        const note = await deps.notes.create({
          id,
          body: input.body ?? '',
          origin: input.origin ?? null,
          image: { path: relPath, meta },
          allowEmpty: true,
        });
        return { note, created: true };
      } catch (err) {
        await unplaceOriginal(abs, sourcePath, move);
        if (!(err instanceof NoteError) || (err.code !== 'duplicate_image' && err.code !== 'conflict')) throw err;
        if (err.code === 'duplicate_image') {
          const winner = await deps.records.bySha256(sha256);
          if (winner && winner.deleted_at === null) return reuseExisting(deps, winner, bytes, sourcePath, move);
        }
      }
    }
    throw new Error(`could not allocate a free note id in ${MAX_ID_ATTEMPTS} attempts`);
  });
}

/** Locate an image note's original. null when the id is unknown or the note has no image. */
export async function locateImage(deps: Pick<ImageDeps, 'dataDir' | 'records'>, id: string): Promise<LocatedImage | null> {
  const rec = await deps.records.byId(id);
  if (!rec) return null;
  const originalPath = resolveInDataDir(deps.dataDir, rec.image_path);
  return {
    id: rec.id,
    mime: rec.image_meta.mime,
    originalPath,
    relPath: rec.image_path,
    available: await fileExists(originalPath),
    host: rec.image_meta.host ?? null,
    deleted: rec.deleted_at !== null,
    meta: rec.image_meta,
  };
}
```
**Impact:** this is the only path by which image notes are created. All writes go through the notes service, never the repo, per the Seams.

### Step 6: `src/images/inbox.ts` and `src/background.ts`
**File:** `src/images/inbox.ts:1` (new)
**Change:** The watcher uses chokidar on `<dataDir>/inbox` with `depth: 0`. The `ignored` function drops anything not directly in the inbox (so `failed/` and any subfolder), directories, dotfiles, `~$` lock files, and partial downloads (`.crdownload .part .partial .tmp .download .opdownload .!ut`). A file is taken when its size has been stable for 2 s through `awaitWriteFinish`. Files found during the initial scan get the same wait from `waitStable`, because chokidar does not apply `awaitWriteFinish` to the initial scan. Files are handled one at a time in a promise queue:
- non-images (by magic bytes) are left in place with one `info` line;
- images go to `ingest(absPath)`;
- on any error the file moves to `inbox/failed/<name>`, or `<stem>-<epoch>[-n]<ext>` if that name is taken, with one `error` line.

Logs go to stdout and stderr, so journald collects them.
**Code:**
```ts
import { mkdir, stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type { IngestResult } from './ingest.js';
import { sniffImageFile } from './probe.js';
import { fileExists, moveIntoNewFile } from './store.js';

export type InboxLogger = {
  info: (msg: string) => void;
  error: (msg: string) => void;
};

export type InboxWatcherOptions = {
  /** Absolute path of `<dataDir>/inbox`. */
  inboxDir: string;
  /** Absolute path of `<dataDir>/inbox/failed`. */
  failedDir: string;
  /** Ingest one file; expected to move it into the store (move: true). */
  ingest: (absPath: string) => Promise<IngestResult>;
  log?: InboxLogger;
  /** How long the size must stay unchanged before a file is taken. Default 2000 ms. */
  stabilityThresholdMs?: number;
  /** Size polling interval while waiting. Default 200 ms. */
  pollIntervalMs?: number;
};

export type InboxWatcher = {
  /** Resolves when every file seen so far has been handled. */
  idle: () => Promise<void>;
  close: () => Promise<void>;
};

const PARTIAL_SUFFIXES = ['.crdownload', '.part', '.partial', '.tmp', '.download', '.opdownload', '.!ut'];

/** Dotfiles and in-progress downloads are never touched. */
export function isIgnoredInboxName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith('.') || lower.startsWith('~$')) return true;
  return PARTIAL_SUFFIXES.some((s) => lower.endsWith(s));
}

const consoleLog: InboxLogger = {
  info: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
};

/** `failed/<name>`, or `failed/<stem>-<epoch ms>[-n]<ext>` when the name is taken. */
async function failedTarget(failedDir: string, name: string): Promise<string> {
  let candidate = path.join(failedDir, name);
  if (!(await fileExists(candidate))) return candidate;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const stamp = Date.now();
  for (let n = 0; ; n++) {
    candidate = path.join(failedDir, `${stem}-${stamp}${n ? `-${n}` : ''}${ext}`);
    if (!(await fileExists(candidate))) return candidate;
  }
}

/** Wait until size and mtime hold still for `stableMs`. false if the file disappears. */
async function waitStable(absPath: string, stableMs: number, pollMs: number): Promise<boolean> {
  let last = '';
  let since = Date.now();
  for (;;) {
    let sig: string;
    try {
      const s = await stat(absPath);
      sig = `${s.size}:${s.mtimeMs}`;
    } catch {
      return false;
    }
    if (sig !== last) {
      last = sig;
      since = Date.now();
    } else if (Date.now() - since >= stableMs) {
      return true;
    }
    await sleep(pollMs);
  }
}

/**
 * Watch `<dataDir>/inbox` (top level only). Every image that appears — and every image already
 * there at startup — is ingested once its size has been stable for `stabilityThresholdMs`.
 * Files that are not images stay where they are. A failed ingest moves the file to
 * `inbox/failed/` and logs one line. Files are handled one at a time, in arrival order.
 */
export async function startInboxWatcher(opts: InboxWatcherOptions): Promise<InboxWatcher> {
  const inboxDir = path.resolve(opts.inboxDir);
  const failedDir = path.resolve(opts.failedDir);
  const log = opts.log ?? consoleLog;
  await mkdir(failedDir, { recursive: true });

  const stabilityMs = opts.stabilityThresholdMs ?? 2000;
  const pollMs = opts.pollIntervalMs ?? 200;
  const seen = new Set<string>();
  let queue: Promise<void> = Promise.resolve();
  let ready = false;

  async function handle(absPath: string, checkStable: boolean): Promise<void> {
    const name = path.basename(absPath);
    try {
      if (checkStable && !(await waitStable(absPath, stabilityMs, pollMs))) return;
      if (!(await fileExists(absPath))) return;
      const sniff = await sniffImageFile(absPath);
      if (!sniff) {
        log.info(`[inbox] ignored ${name}: not an image`);
        return;
      }
      const { note, created } = await opts.ingest(absPath);
      log.info(`[inbox] ${name} -> ${note.id}${created ? '' : ' (already stored)'}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!(await fileExists(absPath))) {
        log.error(`[inbox] failed ${name}: ${msg}`);
        return;
      }
      try {
        const target = await failedTarget(failedDir, name);
        await moveIntoNewFile(absPath, target);
        log.error(`[inbox] failed ${name}: ${msg} -> inbox/failed/${path.basename(target)}`);
      } catch (moveErr) {
        const moveMsg = moveErr instanceof Error ? moveErr.message : String(moveErr);
        log.error(`[inbox] failed ${name}: ${msg}; could not move it to inbox/failed/: ${moveMsg}`);
      }
    } finally {
      seen.delete(absPath);
    }
  }

  function enqueue(absPath: string): void {
    const p = path.resolve(absPath);
    if (path.dirname(p) !== inboxDir || isIgnoredInboxName(path.basename(p)) || seen.has(p)) return;
    seen.add(p);
    // chokidar's awaitWriteFinish does not hold back the initial scan, so files found
    // before 'ready' get the same stable-size wait here.
    const checkStable = !ready;
    queue = queue.then(() => handle(p, checkStable));
  }

  const watcher: FSWatcher = watch(inboxDir, {
    depth: 0,
    ignoreInitial: false,
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: stabilityMs,
      pollInterval: pollMs,
    },
    ignored: (p: string, stats?: { isDirectory(): boolean }) => {
      const abs = path.resolve(p);
      if (abs === inboxDir) return false;
      if (path.dirname(abs) !== inboxDir) return true;
      if (stats?.isDirectory()) return true;
      return isIgnoredInboxName(path.basename(abs));
    },
  });
  watcher.on('add', (p: string) => enqueue(p));
  watcher.on('error', (err: unknown) => {
    log.error(`[inbox] watcher error: ${err instanceof Error ? err.message : String(err)}`);
  });
  await new Promise<void>((resolve) => {
    watcher.once('ready', () => {
      ready = true;
      resolve();
    });
  });

  return {
    idle: async () => {
      let current: Promise<void>;
      do {
        current = queue;
        await current;
      } while (current !== queue);
    },
    close: async () => {
      await watcher.close();
      await queue;
    },
  };
}
```

**File:** `src/background.ts:1` (replace P2's no-op body entirely; keep P2's exports `startBackground(deps: AppDeps)` and `StopBackground`, see A8)
**Change:** Create `images/ cache/ inbox/ inbox/failed/`, start the inbox watcher with `move: true` and `origin: { source: 'inbox' }`, and return a stop function that closes the watcher and waits for the in-flight file.
**Code:**
```ts
import type { AppDeps } from './deps.js';
import { imageDeps, ingestImage } from './images/ingest.js';
import { startInboxWatcher } from './images/inbox.js';
import { ensureDataDirs } from './images/store.js';

export type StopBackground = () => Promise<void>;

/**
 * Long-running work beside the HTTP server. Iteration 2: the inbox watcher.
 * Creates images/, cache/, inbox/, inbox/failed/ under the data dir first (idempotent; the
 * daemon already made them, but tests call this without startDaemon).
 */
export async function startBackground(deps: AppDeps): Promise<StopBackground> {
  const img = imageDeps(deps);
  const dirs = await ensureDataDirs(img.dataDir);
  const inbox = await startInboxWatcher({
    inboxDir: dirs.inbox,
    failedDir: dirs.failed,
    ingest: (absPath) => ingestImage(img, { path: absPath, move: true, origin: { source: 'inbox' } }),
  });
  console.log(`[notesd] watching ${dirs.inbox}`);
  return async () => {
    await inbox.close();
  };
}
```
**Impact:** `notesd` now watches `<dataDir>/inbox` from startup and ingests whatever is already there. P2's tests that start `main` against a temp `NOTES_DATA_DIR` get an empty inbox watched, which is harmless. The watcher holds the event loop open until `stop()`; phase 2's `daemon.stop()` awaits the stop function first (A8), and `main.ts` calls `daemon.stop()` on SIGTERM/SIGINT.

### Step 7: Test helpers
**File:** `tests/helpers/fixtures.ts:1` (new)
**Code:**
```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/images');

/** 64x48 JPEG, EXIF DateTimeOriginal 2024:10:30 14:05:09, no offset. */
export const JPEG_EXIF = path.join(FIXTURES_DIR, 'exif.jpg');
/** 40x30 PNG, no EXIF. */
export const PNG_PLAIN = path.join(FIXTURES_DIR, 'plain.png');
/** 64x48 HEVC-coded HEIC (libheif/x265), EXIF DateTimeOriginal 2024:10:30 14:05:09. */
export const HEIC_PHOTO = path.join(FIXTURES_DIR, 'photo.heic');

export function fixtureBytes(p: string): Promise<Buffer> {
  return readFile(p);
}

export async function tempDir(prefix = 'mcp-notes-img-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
```

**File:** `tests/helpers/fakeNotes.ts:1` (new). This is an in-memory `ImageNotes` + `ImageRecords` with the schema's unique rules (PK id, live sha256), raising phase 2's `NoteError('conflict')` / `NoteError('duplicate_image')` as the real service does. It lets the ingest and inbox logic be unit-tested without Postgres.
**Code:**
```ts
import type { ImageNotes } from '../../src/images/ingest.js';
import type { ImageRecord, ImageRecords } from '../../src/images/records.js';
import { generateId } from '../../src/notes/ids.js';
import { NoteError, type ImageMeta, type Note, type Origin } from '../../src/notes/types.js';

type Row = {
  id: string;
  body: string;
  origin: Origin | null;
  image_path: string | null;
  image_meta: ImageMeta | null;
  created_at: string;
  deleted_at: string | null;
};

/**
 * In-memory stand-in for the slice of the notes service ingestion uses, plus the raw image
 * lookups, with the same unique rules as the schema: primary key on id
 * (NoteError 'conflict'), unique sha256 among non-deleted notes (NoteError 'duplicate_image').
 */
export class FakeNotes implements ImageNotes, ImageRecords {
  rows = new Map<string, Row>();
  /** Called inside create() before the uniqueness checks; lets a test interleave a competing insert. */
  beforeInsert: ((id: string) => Promise<void> | void) | null = null;
  failNextCreate: Error | null = null;

  private toNote(r: Row): Note {
    const note: Note = {
      id: r.id,
      body: r.body,
      tags: [],
      created_at: r.created_at,
      updated_at: r.created_at,
      origin: r.origin,
      image: r.image_meta
        ? {
            mime: r.image_meta.mime,
            width: r.image_meta.width,
            height: r.image_meta.height,
            bytes: r.image_meta.bytes,
            taken_at: r.image_meta.taken_at,
            original_name: r.image_meta.original_name,
            host: r.image_meta.host,
            available: true,
          }
        : null,
    };
    // As phase 2's rowToNote: deleted_at is present only on deleted notes.
    if (r.deleted_at !== null) note.deleted_at = r.deleted_at;
    return note;
  }

  private toRecord(r: Row): ImageRecord {
    return { id: r.id, image_path: r.image_path!, image_meta: r.image_meta!, deleted_at: r.deleted_at };
  }

  async newId(): Promise<string> {
    for (;;) {
      const id = generateId();
      if (!this.rows.has(id)) return id;
    }
  }

  async create(input: Parameters<ImageNotes['create']>[0]): Promise<Note> {
    if (this.failNextCreate) {
      const err = this.failNextCreate;
      this.failNextCreate = null;
      throw err;
    }
    const id = input.id ?? (await this.newId());
    await this.beforeInsert?.(id);
    if (this.rows.has(id)) throw new NoteError('conflict', `note ${id} already exists`);
    const sha = input.image?.meta.sha256;
    if (sha && [...this.rows.values()].some((r) => r.deleted_at === null && r.image_meta?.sha256 === sha)) {
      throw new NoteError('duplicate_image', 'a live note already holds these bytes');
    }
    const row: Row = {
      id,
      body: input.body,
      origin: input.origin ?? null,
      image_path: input.image?.path ?? null,
      image_meta: input.image?.meta ?? null,
      created_at: new Date().toISOString(),
      deleted_at: null,
    };
    this.rows.set(id, row);
    return this.toNote(row);
  }

  async getOne(id: string, opts?: { includeDeleted?: boolean }): Promise<Note | null> {
    const r = this.rows.get(id);
    if (!r) return null;
    return r.deleted_at === null || opts?.includeDeleted ? this.toNote(r) : null;
  }

  async restore(id: string): Promise<Note> {
    const r = this.rows.get(id);
    if (!r) throw new NoteError('not_found', `no note ${id}`);
    r.deleted_at = null;
    return this.toNote(r);
  }

  softDelete(id: string): void {
    const r = this.rows.get(id);
    if (r) r.deleted_at = new Date().toISOString();
  }

  async bySha256(sha256: string): Promise<ImageRecord | null> {
    const matches = [...this.rows.values()].filter((r) => r.image_meta?.sha256 === sha256);
    const live = matches.find((r) => r.deleted_at === null);
    const pick = live ?? matches.sort((a, b) => (b.deleted_at ?? '').localeCompare(a.deleted_at ?? ''))[0];
    return pick ? this.toRecord(pick) : null;
  }

  async byId(id: string): Promise<ImageRecord | null> {
    const r = this.rows.get(id);
    return r && r.image_path && r.image_meta ? this.toRecord(r) : null;
  }
}
```
**Impact:** `tests/helpers/` contains no `*.test.ts`, so vitest does not collect it. Phase 1's `tsconfig.json` includes `tests/**/*.ts`, so it is typechecked. If `Parameters<ImageNotes['create']>[0]` does not resolve under the implementer's TS version, import `CreateNoteInput` from phase 2's `src/notes/service.ts` instead (phase 2 exports it).

### Step 8: Unit tests
**File:** `tests/unit/images/probe.test.ts:1` (new)
```ts
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  exifDateToIso,
  isBrowserDisplayable,
  probeImage,
  sha256Hex,
  sniffImageBytes,
  UnsupportedImageError,
} from '../../../src/images/probe.js';
import { fixtureBytes, HEIC_PHOTO, JPEG_EXIF, PNG_PLAIN } from '../../helpers/fixtures.js';

const localIso = (y: number, mo: number, d: number, h: number, mi: number, s: number) =>
  new Date(y, mo - 1, d, h, mi, s).toISOString();

describe('exifDateToIso', () => {
  it('reads an EXIF date as process-local time when no offset is given', () => {
    expect(exifDateToIso('2024:10:30 14:05:09')).toBe(localIso(2024, 10, 30, 14, 5, 9));
  });
  it('applies OffsetTimeOriginal', () => {
    expect(exifDateToIso('2024:10:30 14:05:09', '+07:00')).toBe('2024-10-30T07:05:09.000Z');
    expect(exifDateToIso('2024:10:30 14:05:09', '-02:30')).toBe('2024-10-30T16:35:09.000Z');
  });
  it('returns null for blank or zeroed dates', () => {
    expect(exifDateToIso('0000:00:00 00:00:00')).toBeNull();
    expect(exifDateToIso('')).toBeNull();
    expect(exifDateToIso(undefined)).toBeNull();
    expect(exifDateToIso('2024:13:01 00:00:00')).toBeNull();
  });
});

describe('probeImage', () => {
  it('JPEG with EXIF: mime, size, taken_at', async () => {
    const p = await probeImage(await fixtureBytes(JPEG_EXIF));
    expect(p).toEqual({
      mime: 'image/jpeg',
      mimeExt: 'jpg',
      width: 64,
      height: 48,
      taken_at: localIso(2024, 10, 30, 14, 5, 9),
    });
  });

  it('PNG without EXIF: taken_at null', async () => {
    const p = await probeImage(await fixtureBytes(PNG_PLAIN));
    expect(p).toEqual({ mime: 'image/png', mimeExt: 'png', width: 40, height: 30, taken_at: null });
  });

  it('HEIC: size from the header, EXIF date, no pixel decode needed', async () => {
    const p = await probeImage(await fixtureBytes(HEIC_PHOTO));
    expect(p.mime).toBe('image/heic');
    expect(p.mimeExt).toBe('heic');
    expect([p.width, p.height]).toEqual([64, 48]);
    expect(p.taken_at).toBe(localIso(2024, 10, 30, 14, 5, 9));
  });

  it('reports display-oriented size for EXIF-rotated JPEGs', async () => {
    const rotated = await sharp({ create: { width: 30, height: 20, channels: 3, background: '#0a0' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const p = await probeImage(rotated);
    expect([p.width, p.height]).toEqual([20, 30]);
  });

  it('rejects non-images by magic bytes, whatever the name', async () => {
    await expect(probeImage(Buffer.from('just some text, not a picture'))).rejects.toBeInstanceOf(
      UnsupportedImageError,
    );
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
    await expect(probeImage(pdf)).rejects.toThrow(/application\/pdf/);
  });
});

describe('sniff + helpers', () => {
  it('sniffs supported images only', async () => {
    expect(await sniffImageBytes(await fixtureBytes(HEIC_PHOTO))).toEqual({ mime: 'image/heic', ext: 'heic' });
    expect(await sniffImageBytes(Buffer.from('hello'))).toBeNull();
  });
  it('knows which originals a browser can show', () => {
    expect(isBrowserDisplayable('image/jpeg')).toBe(true);
    expect(isBrowserDisplayable('image/avif')).toBe(true);
    expect(isBrowserDisplayable('image/heic')).toBe(false);
    expect(isBrowserDisplayable('image/tiff')).toBe(false);
  });
  it('sha256Hex is the hex digest', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
```

**File:** `tests/unit/images/store.test.ts:1` (new)
```ts
import { statSync } from 'node:fs';
import { readFile, unlink as fsUnlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chooseExt,
  DestinationExistsError,
  ensureDataDirs,
  fileExists,
  moveIntoNewFile,
  originalRelPath,
  resolveInDataDir,
  writeNewFile,
} from '../../../src/images/store.js';
import { tempDir } from '../../helpers/fixtures.js';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ dir, cleanup } = await tempDir()));
afterEach(async () => cleanup());

describe('paths', () => {
  it('chooseExt prefers the original filename, lower-cased', () => {
    expect(chooseExt('IMG_0001.HEIC', 'heic')).toBe('heic');
    expect(chooseExt('photo.JPEG', 'jpg')).toBe('jpeg');
    expect(chooseExt('noext', 'png')).toBe('png');
    expect(chooseExt(null, 'png')).toBe('png');
    expect(chooseExt('weird.<script>', 'gif')).toBe('gif');
  });
  it('originalRelPath uses local YYYY/MM of the save time', () => {
    expect(originalRelPath('A-B32', 'jpg', new Date(2026, 0, 5, 10))).toBe('images/2026/01/A-B32.jpg');
  });
  it('resolveInDataDir refuses escapes', () => {
    expect(resolveInDataDir(dir, 'images/2026/01/A-B32.jpg')).toBe(path.join(dir, 'images/2026/01/A-B32.jpg'));
    expect(() => resolveInDataDir(dir, '../etc/passwd')).toThrow(/escapes/);
  });
  it('ensureDataDirs creates the layout', async () => {
    const dirs = await ensureDataDirs(dir);
    for (const d of [dirs.images, dirs.cache, dirs.inbox, dirs.failed]) {
      expect(statSync(d).isDirectory()).toBe(true);
    }
  });
});

describe('writes', () => {
  it('writeNewFile is byte-exact and refuses to overwrite', async () => {
    const dest = path.join(dir, 'a/b/c.bin');
    const bytes = Buffer.from([0, 1, 2, 255, 254]);
    await writeNewFile(dest, bytes);
    expect(Buffer.compare(await readFile(dest), bytes)).toBe(0);
    await expect(writeNewFile(dest, Buffer.from('x'))).rejects.toBeInstanceOf(DestinationExistsError);
  });

  it('moveIntoNewFile renames on the same filesystem', async () => {
    const src = path.join(dir, 'src.bin');
    await writeFile(src, 'payload');
    const dest = path.join(dir, 'x/dest.bin');
    await moveIntoNewFile(src, dest);
    expect(await fileExists(src)).toBe(false);
    expect(await readFile(dest, 'utf8')).toBe('payload');
  });

  it('moveIntoNewFile falls back to copy + unlink on EXDEV', async () => {
    const src = path.join(dir, 'src.bin');
    await writeFile(src, 'cross-device');
    const dest = path.join(dir, 'y/dest.bin');
    const unlink = vi.fn((p: string) => fsUnlink(p));
    const rename = vi.fn(async () => {
      throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
    });
    await moveIntoNewFile(src, dest, { rename, unlink });
    expect(rename).toHaveBeenCalledOnce();
    expect(unlink).toHaveBeenCalledWith(src);
    expect(await readFile(dest, 'utf8')).toBe('cross-device');
    expect(await fileExists(src)).toBe(false);
  });
});
```

**File:** `tests/unit/images/derive.test.ts:1` (new)
```ts
import { readdirSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  derivativePaths,
  getDisplay,
  getPreview,
  getThumb,
  OriginalMissingError,
  PREVIEW_LONG_EDGE,
  PREVIEW_MAX_BYTES,
  type ImageSource,
} from '../../../src/images/derive.js';
import { HEIC_PHOTO, JPEG_EXIF, PNG_PLAIN, tempDir } from '../../helpers/fixtures.js';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ dir, cleanup } = await tempDir()));
afterEach(async () => cleanup());

async function place(fixture: string, id: string, mime: string, ext: string): Promise<ImageSource> {
  const originalPath = path.join(dir, 'images/2026/10', `${id}.${ext}`);
  await mkdir(path.dirname(originalPath), { recursive: true });
  await copyFile(fixture, originalPath);
  return { id, mime, originalPath };
}

describe('getThumb', () => {
  it('writes cache/<id>/thumb.webp, never enlarged', async () => {
    const src = await place(PNG_PLAIN, 'P-0001', 'image/png', 'png');
    const out = await getThumb(dir, src);
    expect(out).toBe(derivativePaths(dir, 'P-0001').thumb);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(40);
  });

  it('scales wide images to 480 px', async () => {
    const originalPath = path.join(dir, 'images/2026/10/W-0001.jpg');
    await mkdir(path.dirname(originalPath), { recursive: true });
    await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#345' } })
      .jpeg()
      .toFile(originalPath);
    const out = await getThumb(dir, { id: 'W-0001', mime: 'image/jpeg', originalPath });
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([480, 240]);
  });

  it('leaves the original byte-identical', async () => {
    const src = await place(JPEG_EXIF, 'J-0001', 'image/jpeg', 'jpg');
    const before = await readFile(src.originalPath);
    await getThumb(dir, src);
    await getPreview(dir, src);
    expect(Buffer.compare(await readFile(src.originalPath), before)).toBe(0);
  });

  it('throws OriginalMissingError when the original is not here', async () => {
    const src = { id: 'G-0001', mime: 'image/jpeg', originalPath: path.join(dir, 'images/nope.jpg') };
    await expect(getThumb(dir, src)).rejects.toBeInstanceOf(OriginalMissingError);
  });
});

describe('getPreview', () => {
  it('caps the long edge at 1568 and stays under the byte budget', async () => {
    const originalPath = path.join(dir, 'images/2026/10/B-0001.png');
    await mkdir(path.dirname(originalPath), { recursive: true });
    const noise = Buffer.alloc(3000 * 2000 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
    await sharp(noise, { raw: { width: 3000, height: 2000, channels: 3 } }).png().toFile(originalPath);
    const out = await getPreview(dir, { id: 'B-0001', mime: 'image/png', originalPath });
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(PREVIEW_LONG_EDGE);
    expect((await stat(out)).size).toBeLessThanOrEqual(PREVIEW_MAX_BYTES);
  });

  it('regenerates after the cache is wiped', async () => {
    const src = await place(JPEG_EXIF, 'R-0001', 'image/jpeg', 'jpg');
    const first = await getPreview(dir, src);
    await rm(path.join(dir, 'cache'), { recursive: true, force: true });
    const second = await getPreview(dir, src);
    expect(second).toBe(first);
    expect((await stat(second)).size).toBeGreaterThan(0);
  });

  it('concurrent requests share one generation', async () => {
    const src = await place(JPEG_EXIF, 'C-0001', 'image/jpeg', 'jpg');
    const outs = await Promise.all(Array.from({ length: 8 }, () => getPreview(dir, src)));
    expect(new Set(outs).size).toBe(1);
    const leftovers = readdirSync(path.dirname(outs[0]!)).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    expect((await sharp(outs[0]!).metadata()).format).toBe('jpeg');
  });
});

describe('getDisplay', () => {
  it('returns the original for browser-displayable formats', async () => {
    const src = await place(JPEG_EXIF, 'D-0001', 'image/jpeg', 'jpg');
    expect(await getDisplay(dir, src)).toEqual({ path: src.originalPath, mime: 'image/jpeg' });
  });

  it('HEIC gets a full-resolution display.jpg, and thumb/preview derive from it', async () => {
    const src = await place(HEIC_PHOTO, 'H-0001', 'image/heic', 'heic');
    const display = await getDisplay(dir, src);
    expect(display).toEqual({ path: derivativePaths(dir, 'H-0001').display, mime: 'image/jpeg' });
    const meta = await sharp(display.path).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 64, 48]);
    expect((await sharp(await getThumb(dir, src)).metadata()).format).toBe('webp');
    expect((await sharp(await getPreview(dir, src)).metadata()).format).toBe('jpeg');
  });

  it('TIFF gets a display.jpg through sharp', async () => {
    const originalPath = path.join(dir, 'images/2026/10/T-0001.tif');
    await mkdir(path.dirname(originalPath), { recursive: true });
    await writeFile(
      originalPath,
      await sharp({ create: { width: 20, height: 10, channels: 3, background: '#f00' } }).tiff().toBuffer(),
    );
    const display = await getDisplay(dir, { id: 'T-0001', mime: 'image/tiff', originalPath });
    expect(display.mime).toBe('image/jpeg');
    expect((await sharp(display.path).metadata()).width).toBe(20);
  });
});
```

**File:** `tests/unit/images/ingest.test.ts:1` (new)
```ts
import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ingestImage, locateImage, type ImageDeps } from '../../../src/images/ingest.js';
import { sha256Hex, UnsupportedImageError } from '../../../src/images/probe.js';
import { fileExists } from '../../../src/images/store.js';
import { FakeNotes } from '../../helpers/fakeNotes.js';
import { fixtureBytes, HEIC_PHOTO, JPEG_EXIF, PNG_PLAIN, tempDir } from '../../helpers/fixtures.js';

let dir: string;
let cleanup: () => Promise<void>;
let notes: FakeNotes;
let deps: ImageDeps;
const SAVED = new Date(2026, 9, 30, 9, 0, 0);

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  notes = new FakeNotes();
  deps = { dataDir: dir, notes, records: notes, hostname: () => 'lenovo', now: () => SAVED };
});
afterEach(async () => cleanup());

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out.push(path.relative(root, path.join(e.parentPath, e.name)));
  }
  return out.sort();
}

describe('ingestImage', () => {
  it('stores the original byte for byte and records the metadata', async () => {
    const bytes = await fixtureBytes(JPEG_EXIF);
    const { note, created } = await ingestImage(deps, { bytes, originalName: 'IMG_0001.JPG', body: 'hello #cat' });
    expect(created).toBe(true);
    const rec = (await notes.byId(note.id))!;
    expect(rec.image_path).toBe(`images/2026/10/${note.id}.jpg`);
    expect(Buffer.compare(await readFile(path.join(dir, rec.image_path)), bytes)).toBe(0);
    expect(rec.image_meta).toMatchObject({
      mime: 'image/jpeg',
      width: 64,
      height: 48,
      bytes: bytes.byteLength,
      original_name: 'IMG_0001.JPG',
      host: 'lenovo',
    });
    expect(rec.image_meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.image_meta.taken_at).toBe(new Date(2024, 9, 30, 14, 5, 9).toISOString());
    expect(note.body).toBe('hello #cat');
  });

  it('the same bytes twice return the same note', async () => {
    const bytes = await fixtureBytes(PNG_PLAIN);
    const a = await ingestImage(deps, { bytes, originalName: 'a.png' });
    const b = await ingestImage(deps, { bytes, originalName: 'b.png' });
    expect(b).toEqual({ note: a.note, created: false });
    expect(await listFiles(path.join(dir, 'images'))).toHaveLength(1);
  });

  it('concurrent ingests of the same bytes create one note', async () => {
    const bytes = await fixtureBytes(PNG_PLAIN);
    const results = await Promise.all(Array.from({ length: 5 }, () => ingestImage(deps, { bytes })));
    expect(new Set(results.map((r) => r.note.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await listFiles(path.join(dir, 'images'))).toHaveLength(1);
  });

  it('a soft-deleted duplicate is restored and returned', async () => {
    const bytes = await fixtureBytes(PNG_PLAIN);
    const first = await ingestImage(deps, { bytes });
    notes.softDelete(first.note.id);
    const again = await ingestImage(deps, { bytes });
    expect(again.created).toBe(false);
    expect(again.note.id).toBe(first.note.id);
    expect(again.note.deleted_at).toBeUndefined();
  });

  it('a duplicate whose original is missing here gets the bytes put back', async () => {
    const bytes = await fixtureBytes(PNG_PLAIN);
    const first = await ingestImage(deps, { bytes });
    const rec = (await notes.byId(first.note.id))!;
    await rm(path.join(dir, rec.image_path));
    const again = await ingestImage(deps, { bytes });
    expect(again.created).toBe(false);
    expect(Buffer.compare(await readFile(path.join(dir, rec.image_path)), bytes)).toBe(0);
  });

  it('path + move: renames the source into the store', async () => {
    const src = path.join(dir, 'drop', 'IMG_9.HEIC');
    await mkdir(path.dirname(src), { recursive: true });
    await copyFile(HEIC_PHOTO, src);
    const { note } = await ingestImage(deps, { path: src, move: true, origin: { source: 'inbox' } });
    expect(await fileExists(src)).toBe(false);
    const rec = (await notes.byId(note.id))!;
    expect(rec.image_path).toBe(`images/2026/10/${note.id}.heic`);
    expect(rec.image_meta.mime).toBe('image/heic');
    expect(rec.image_meta.original_name).toBe('IMG_9.HEIC');
    expect(note.origin).toEqual({ source: 'inbox' });
    expect(Buffer.compare(await readFile(path.join(dir, rec.image_path)), await fixtureBytes(HEIC_PHOTO))).toBe(0);
  });

  it('path without move: copies, source untouched', async () => {
    const src = path.join(dir, 'shot.png');
    await copyFile(PNG_PLAIN, src);
    await ingestImage(deps, { path: src });
    expect(await fileExists(src)).toBe(true);
  });

  it('path + move on a duplicate consumes the source', async () => {
    await ingestImage(deps, { bytes: await fixtureBytes(PNG_PLAIN) });
    const src = path.join(dir, 'dup.png');
    await copyFile(PNG_PLAIN, src);
    const r = await ingestImage(deps, { path: src, move: true });
    expect(r.created).toBe(false);
    expect(await fileExists(src)).toBe(false);
  });

  it('rejects non-images and writes nothing', async () => {
    await expect(ingestImage(deps, { bytes: Buffer.from('not an image'), originalName: 'x.jpg' })).rejects.toBeInstanceOf(
      UnsupportedImageError,
    );
    expect(notes.rows.size).toBe(0);
    expect(await fileExists(path.join(dir, 'images'))).toBe(false);
  });

  it('removes the written file when the insert fails', async () => {
    notes.failNextCreate = new Error('connection reset');
    await expect(ingestImage(deps, { bytes: await fixtureBytes(PNG_PLAIN) })).rejects.toThrow('connection reset');
    expect(await listFiles(dir)).toEqual([]);
  });

  it('moves the source back when the insert fails after a move', async () => {
    const src = path.join(dir, 'keep.png');
    await copyFile(PNG_PLAIN, src);
    notes.failNextCreate = new Error('db down');
    await expect(ingestImage(deps, { path: src, move: true })).rejects.toThrow('db down');
    expect(await fileExists(src)).toBe(true);
    expect(await listFiles(path.join(dir, 'images')).catch(() => [])).toEqual([]);
  });

  it('a concurrent insert of the same bytes by another host resolves to that note', async () => {
    const bytes = await fixtureBytes(PNG_PLAIN);
    // Another host inserts the same bytes between our lookup and our insert.
    notes.beforeInsert = async () => {
      notes.beforeInsert = null;
      const relPath = 'images/2026/10/G-PD1.png';
      notes.rows.set('G-PD1', {
        id: 'G-PD1',
        body: '',
        origin: null,
        image_path: relPath,
        image_meta: {
          sha256: sha256Hex(bytes),
          mime: 'image/png',
          width: 40,
          height: 30,
          bytes: bytes.byteLength,
          taken_at: null,
          original_name: null,
          host: 'gpd',
        },
        created_at: new Date().toISOString(),
        deleted_at: null,
      });
    };
    const r = await ingestImage(deps, { bytes });
    expect(r).toMatchObject({ created: false, note: { id: 'G-PD1' } });
    // the loser's file is gone; the winner's original was missing here, so the bytes were placed at its path
    expect(await listFiles(path.join(dir, 'images'))).toEqual(['2026/10/G-PD1.png']);
  });

  it('retries with a new id when the id is taken', async () => {
    let calls = 0;
    notes.beforeInsert = (id) => {
      calls++;
      if (calls === 1) {
        notes.rows.set(id, {
          id,
          body: 'squatter',
          origin: null,
          image_path: null,
          image_meta: null,
          created_at: new Date().toISOString(),
          deleted_at: null,
        });
      }
    };
    const r = await ingestImage(deps, { bytes: await fixtureBytes(JPEG_EXIF) });
    expect(r.created).toBe(true);
    expect(calls).toBe(2);
    expect(await listFiles(path.join(dir, 'images'))).toHaveLength(1);
  });
});

describe('locateImage', () => {
  it('reports availability and host', async () => {
    const { note } = await ingestImage(deps, { bytes: await fixtureBytes(PNG_PLAIN) });
    const loc = (await locateImage(deps, note.id))!;
    expect(loc).toMatchObject({ id: note.id, mime: 'image/png', available: true, host: 'lenovo', deleted: false });
    await rm(loc.originalPath);
    expect((await locateImage(deps, note.id))!.available).toBe(false);
    expect(await locateImage(deps, 'X-XXX')).toBeNull();
  });
});
```

**File:** `tests/unit/images/inbox.test.ts:1` (new). It uses a 150 ms stability threshold. The whole file runs in about 1.5 s.
```ts
import { statSync } from 'node:fs';
import { appendFile, copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isIgnoredInboxName, startInboxWatcher, type InboxWatcher } from '../../../src/images/inbox.js';
import { ingestImage, type ImageDeps } from '../../../src/images/ingest.js';
import { ensureDataDirs, fileExists, type DataDirs } from '../../../src/images/store.js';
import { FakeNotes } from '../../helpers/fakeNotes.js';
import { JPEG_EXIF, PNG_PLAIN, tempDir } from '../../helpers/fixtures.js';

let dir: string;
let cleanup: () => Promise<void>;
let dirs: DataDirs;
let notes: FakeNotes;
let deps: ImageDeps;
let watcher: InboxWatcher | null;
let logs: string[];

const FAST = { stabilityThresholdMs: 150, pollIntervalMs: 30 };

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  dirs = await ensureDataDirs(dir);
  notes = new FakeNotes();
  deps = { dataDir: dir, notes, records: notes, hostname: () => 'lenovo' };
  watcher = null;
  logs = [];
});
afterEach(async () => {
  await watcher?.close();
  await cleanup();
});

function start(ingest = (p: string) => ingestImage(deps, { path: p, move: true, origin: { source: 'inbox' } })) {
  return startInboxWatcher({
    inboxDir: dirs.inbox,
    failedDir: dirs.failed,
    ingest,
    log: { info: (m) => logs.push(m), error: (m) => logs.push(m) },
    ...FAST,
  });
}

async function until(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(25);
  }
}

describe('isIgnoredInboxName', () => {
  it('skips dotfiles and partial downloads', () => {
    for (const n of ['.DS_Store', '.x.jpg', 'a.jpg.crdownload', 'b.PART', 'c.tmp', 'd.jpg.download', '~$e.png']) {
      expect(isIgnoredInboxName(n)).toBe(true);
    }
    for (const n of ['IMG_1.HEIC', 'shot.png', 'a.partial.jpg']) expect(isIgnoredInboxName(n)).toBe(false);
  });
});

describe('startInboxWatcher', () => {
  it('ingests files already present at startup', async () => {
    await copyFile(JPEG_EXIF, path.join(dirs.inbox, 'early.jpg'));
    watcher = await start();
    await until(() => notes.rows.size === 1);
    await watcher.idle();
    expect(await fileExists(path.join(dirs.inbox, 'early.jpg'))).toBe(false);
    const [row] = [...notes.rows.values()];
    expect(row!.origin).toEqual({ source: 'inbox' });
    expect(row!.image_meta!.original_name).toBe('early.jpg');
  });

  it('ingests a dropped image and moves it into the store', async () => {
    watcher = await start();
    await copyFile(PNG_PLAIN, path.join(dirs.inbox, 'drop.png'));
    await until(() => notes.rows.size === 1);
    await watcher.idle();
    expect(await readdir(dirs.inbox)).toEqual(['failed']);
    const [row] = [...notes.rows.values()];
    expect(await fileExists(path.join(dir, row!.image_path!))).toBe(true);
  });

  it('waits for a growing file to settle', async () => {
    const seen: number[] = [];
    watcher = await start(async (p) => {
      seen.push(statSync(p).size);
      return ingestImage(deps, { path: p, move: true });
    });
    const target = path.join(dirs.inbox, 'slow.png');
    const full = await readFile(PNG_PLAIN);
    await writeFile(target, full.subarray(0, 20));
    for (let i = 20; i < full.length; i += 20) {
      await sleep(40);
      await appendFile(target, full.subarray(i, i + 20));
    }
    await until(() => notes.rows.size === 1);
    expect(seen).toEqual([full.length]);
  });

  it('ignores non-images, dotfiles, partial downloads and the failed/ folder', async () => {
    watcher = await start();
    await writeFile(path.join(dirs.inbox, 'notes.txt'), 'plain text');
    await copyFile(PNG_PLAIN, path.join(dirs.inbox, '.hidden.png'));
    await copyFile(PNG_PLAIN, path.join(dirs.inbox, 'big.png.crdownload'));
    await copyFile(PNG_PLAIN, path.join(dirs.failed, 'old.png'));
    await mkdir(path.join(dirs.inbox, 'sub'));
    await copyFile(PNG_PLAIN, path.join(dirs.inbox, 'sub', 'nested.png'));
    await sleep(600);
    await watcher.idle();
    expect(notes.rows.size).toBe(0);
    expect((await readdir(dirs.inbox)).sort()).toEqual(
      ['.hidden.png', 'big.png.crdownload', 'failed', 'notes.txt', 'sub'].sort(),
    );
    expect(logs.some((l) => l.includes('ignored notes.txt'))).toBe(true);
  });

  it('moves a file whose ingest fails to inbox/failed/ and logs it', async () => {
    watcher = await start(async () => {
      throw new Error('database unreachable');
    });
    await copyFile(PNG_PLAIN, path.join(dirs.inbox, 'boom.png'));
    await until(() => fileExists(path.join(dirs.failed, 'boom.png')));
    await watcher.idle();
    expect(await fileExists(path.join(dirs.inbox, 'boom.png'))).toBe(false);
    expect(logs.some((l) => l.includes('failed boom.png: database unreachable -> inbox/failed/boom.png'))).toBe(true);
  });

  it('a duplicate dropped later is consumed without a second note', async () => {
    watcher = await start();
    await copyFile(PNG_PLAIN, path.join(dirs.inbox, 'one.png'));
    await until(() => notes.rows.size === 1);
    await copyFile(PNG_PLAIN, path.join(dirs.inbox, 'two.png'));
    await until(async () => !(await fileExists(path.join(dirs.inbox, 'two.png'))));
    await watcher.idle();
    expect(notes.rows.size).toBe(1);
    expect(logs.some((l) => l.includes('(already stored)'))).toBe(true);
  });
});
```
**Impact:** this adds 50 unit tests, all filesystem-only, in temp dirs (Invariant 11).

### Step 9: Integration test
**File:** `tests/integration/images.int.test.ts:1` (new)
**Change:** The same guarantees against the real service and the `mcp-notes-pg-test` Postgres: byte-exact store plus the wire `image` shape, a double ingest giving one note, soft-deleted restore, the service rejecting a second live sha256 with `NoteError('duplicate_image')` (which proves A7b's error contract end to end), the HEIC display derivative, a missing original reported as `available:false` while the note still loads, and a file dropped into a temp inbox through `startBackground(AppDeps)` becoming a note with `origin {source:'inbox'}`. Names are phase 1's and phase 2's actual exports (reconciled).
**Code:**
```ts
import { existsSync } from 'node:fs';
import { copyFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import sharp from 'sharp';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startBackground, type StopBackground } from '../../src/background.js';
import type { AppDeps } from '../../src/deps.js';
import { derivativePaths, getDisplay, getPreview, getThumb } from '../../src/images/derive.js';
import { ingestImage, locateImage, type ImageDeps } from '../../src/images/ingest.js';
import { sha256Hex } from '../../src/images/probe.js';
import { dbImageRecords } from '../../src/images/records.js';
import { NoteEvents } from '../../src/notes/events.js';
import { NotesService } from '../../src/notes/service.js';
import { NoteError } from '../../src/notes/types.js';
import { fixtureBytes, HEIC_PHOTO, JPEG_EXIF, PNG_PLAIN, tempDir } from '../helpers/fixtures.js';
import { closeTestDb, openTestDb, testDatabaseUrl, truncateAll } from './setup.js';

const db = openTestDb();
let dir: string;
let cleanup: () => Promise<void>;
let notes: NotesService;
let deps: ImageDeps;
let stop: StopBackground | null;

beforeEach(async () => {
  await truncateAll(db);
  ({ dir, cleanup } = await tempDir('mcp-notes-int-img-'));
  notes = new NotesService({ db, dataDir: dir, events: new NoteEvents() });
  deps = { dataDir: dir, notes, records: dbImageRecords(db), hostname: () => 'lenovo' };
  stop = null;
});
afterEach(async () => {
  await stop?.();
  await cleanup();
});
afterAll(async () => {
  await closeTestDb(db);
});

async function until(cond: () => Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(50);
  }
}

describe('image ingest against Postgres', () => {
  it('stores bytes exactly and the note carries the image shape', async () => {
    const bytes = await fixtureBytes(JPEG_EXIF);
    const { note, created } = await ingestImage(deps, { bytes, originalName: 'IMG_1.JPG', body: 'first #photo' });
    expect(created).toBe(true);
    expect(note.tags).toEqual(['photo']);
    expect(note.image).toMatchObject({
      mime: 'image/jpeg',
      width: 64,
      height: 48,
      bytes: bytes.byteLength,
      original_name: 'IMG_1.JPG',
      host: 'lenovo',
      available: true,
      taken_at: new Date(2024, 9, 30, 14, 5, 9).toISOString(),
    });
    const loc = (await locateImage(deps, note.id))!;
    expect(Buffer.compare(await readFile(loc.originalPath), bytes)).toBe(0);
    expect(loc.relPath).toMatch(new RegExp(`^images/\\d{4}/\\d{2}/${note.id}\\.jpg$`));
  });

  it('ingesting the same bytes twice returns one note', async () => {
    const bytes = await fixtureBytes(PNG_PLAIN);
    const a = await ingestImage(deps, { bytes, originalName: 'a.png' });
    const b = await ingestImage(deps, { bytes, originalName: 'b.png' });
    expect(b.created).toBe(false);
    expect(b.note.id).toBe(a.note.id);
  });

  it('a soft-deleted duplicate is restored', async () => {
    const bytes = await fixtureBytes(PNG_PLAIN);
    const a = await ingestImage(deps, { bytes });
    await notes.delete(a.note.id);
    const b = await ingestImage(deps, { bytes });
    expect(b).toMatchObject({ created: false, note: { id: a.note.id } });
    expect(b.note.deleted_at ?? null).toBeNull();
  });

  it('the sha256 unique index rejects a second live note with the same bytes', async () => {
    const { note } = await ingestImage(deps, { bytes: await fixtureBytes(PNG_PLAIN) });
    const rec = (await deps.records.byId(note.id))!;
    const err = await notes
      .create({ body: '', image: { path: 'images/2000/01/X-XXX.png', meta: rec.image_meta }, allowEmpty: true })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(NoteError);
    expect((err as NoteError).code).toBe('duplicate_image');
  });

  it('HEIC gets a display derivative; thumb and preview follow', async () => {
    const { note } = await ingestImage(deps, { bytes: await fixtureBytes(HEIC_PHOTO), originalName: 'IMG_2.HEIC' });
    const loc = (await locateImage(deps, note.id))!;
    expect(loc.relPath.endsWith('.heic')).toBe(true);
    const display = await getDisplay(dir, loc);
    expect(display).toEqual({ path: derivativePaths(dir, note.id).display, mime: 'image/jpeg' });
    expect((await sharp(display.path).metadata()).format).toBe('jpeg');
    expect((await sharp(await getThumb(dir, loc)).metadata()).format).toBe('webp');
    expect((await sharp(await getPreview(dir, loc)).metadata()).format).toBe('jpeg');
  });

  it('a missing original is reported, the note still loads', async () => {
    const { note } = await ingestImage(deps, { bytes: await fixtureBytes(PNG_PLAIN) });
    const loc = (await locateImage(deps, note.id))!;
    await rm(loc.originalPath);
    expect((await locateImage(deps, note.id))!.available).toBe(false);
    expect((await notes.getOne(note.id))!.image!.available).toBe(false);
  });
});

describe('inbox via startBackground', () => {
  it('a file dropped in <dataDir>/inbox becomes an image note', async () => {
    const app: AppDeps = {
      config: { databaseUrl: testDatabaseUrl(), port: 0, host: '127.0.0.1', dataDir: dir },
      db,
      events: new NoteEvents(),
      service: notes,
    };
    stop = await startBackground(app);
    const dropped = path.join(dir, 'inbox', 'phone.jpg');
    await copyFile(JPEG_EXIF, dropped);
    const sha = sha256Hex(await fixtureBytes(JPEG_EXIF));
    let found = null as string | null;
    await until(async () => {
      found = (await notes.findBySha256(sha))?.id ?? null;
      return found !== null;
    });
    const note = (await notes.getOne(found!))!;
    expect(note.origin).toEqual({ source: 'inbox' });
    expect(note.image!.original_name).toBe('phone.jpg');
    await until(async () => !existsSync(dropped));
  });
});
```
**Impact:** it runs under `npm run test:int` only, with a temp `NOTES_DATA_DIR`-style dir and never `~/mcp-notes-data` (Invariant 11).

## Verification

**Build:** `npm run typecheck && npm run build`
**Tests:** `npm test` (adds `tests/unit/images/*`, 49 tests: the prototype's 50 minus the removed `isUniqueViolation` test) and `npm run test:int` (adds `tests/integration/images.int.test.ts`, 7 tests)
**Manual check:** run the daemon on a test port against a temp data dir: `NOTESD_PORT=7399 NOTES_DATA_DIR=$(mktemp -d) node dist/main.js`. Then `cp tests/fixtures/images/photo.heic $NOTES_DATA_DIR/inbox/IMG_1.HEIC`. Within about 3 s the log shows `[inbox] IMG_1.HEIC -> X-XXX`, the file sits at `$NOTES_DATA_DIR/images/YYYY/MM/X-XXX.heic` with `cmp` equal to the fixture, and `echo hi > $NOTES_DATA_DIR/inbox/a.txt` logs `ignored a.txt: not an image` and leaves the file in place. Do not use port 7317 (Invariant 10).
**Exit criteria:**
- Ingesting the same bytes twice returns one note (`created:false` the second time), including when the first was soft-deleted (it is restored).
- HEIC gets `cache/<id>/display.jpg` (full resolution, JPEG). JPEG/PNG get none, and their display is the original.
- Dropping a file into a temp inbox creates a note and empties the inbox, while a non-image stays put.
- The stored original's bytes equal the input's bytes.
- `npm run typecheck`, `npm test`, `npm run test:int` and `npm run build` are green.

## Handoffs

- **Phase 2 (resolved by the reconciler).** This plan now calls phase 2's real API (A6–A8): `newId`, `create({ id, image: { path, meta }, allowEmpty })` with `NoteError` codes, `getOne`, `restore`, `startBackground(deps: AppDeps)`. The raw reads phase 2 does not expose live in `src/images/records.ts` (read-only). Phase 2 is not edited.
- **Phase 1 (resolved).** Phase 1 pins sharp 0.35.3, heic-convert 2.1.0, exifr 7.1.3, file-type 22.3.0, chokidar 6.0.0 (invariant 8: phase 1's pins win). The code here uses only APIs present in sharp 0.35.x (`metadata().autoOrient`, `.rotate()`, `.webp()`, `.jpeg()`), and chokidar 6.0.0 is the version it was verified on. `tsconfig.json` includes `tests/**/*.ts`. `setup.ts` exports are phase 1's (A5).
- **Phase 5.** Route `/thumb` → `getThumb` (serve as `image/webp`). `/preview` → `getPreview` (`image/jpeg`). `/display` → `getDisplay` (use the returned `mime`). `/original` → `loc.originalPath` with `loc.mime`. Map `locateImage` → `null` to a 404, `!loc.available` to 404 `{ error: 'not_on_this_machine', host: loc.host }`, `OriginalMissingError` to the same 404, and `UnsupportedImageError` on upload to 415. MCP `create_image` must pass `move: false`, because Claude's screenshot path belongs to the user. `view_images` should read `getPreview` and base64 it. The upload size limit for multipart is phase 5's to set; ingest holds the whole file in memory.
- **Phase 5 / R2 (not done here).** `has_image` and `taken_from`/`taken_to` filters, HTTP routes, and the MCP image tools.
- **Phase 8 / R3.** The display derivative is JPEG with no colour-profile conversion from HEIC's Display P3 (libheif hands out raw RGB). Colours may look slightly flatter than on the phone. If that matters later, convert through an ICC-aware path. Iteration 2 does not require it.

## Rollback

Delete `src/images/` (including `records.ts`), `tests/fixtures/images/`, `tests/helpers/{fixtures,fakeNotes}.ts`, `tests/unit/images/` and `tests/integration/images.int.test.ts`, then restore `src/background.ts` to phase 2's no-op (`git checkout <phase-2 commit> -- src/background.ts`), or `git revert` this phase's commit. No schema, dependency or config changes to undo. Files that tests or manual runs wrote live only in temp dirs. If the daemon ran with this phase against the real data dir, the stored originals and notes stay valid data: delete the notes through MCP if unwanted.
