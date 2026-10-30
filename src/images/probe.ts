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
