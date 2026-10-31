import os from 'node:os';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { chatImages, type ChatImageRow, type ChatImageSource } from '../db/schema.js';
import type { AppDeps } from '../deps.js';
import { getPreview, OriginalMissingError, type ImageSource } from '../images/derive.js';
import { probeImage, sha256Hex, UnsupportedImageError, type ImageProbe } from '../images/probe.js';
import { DestinationExistsError, fileExists, removeQuietly, resolveInDataDir, writeNewFile } from '../images/store.js';
import { generateId, normalizeId } from '../notes/ids.js';
import type { ChatTurnImage } from './backend.js';

/** `<dataDir>/chat-images/`: originals of pasted chat images. */
export const CHAT_IMAGES_SUBDIR = 'chat-images';
/** Upload cap for one pasted chat image. */
export const MAX_CHAT_IMAGE_BYTES = 50 * 1024 * 1024;
/** At most this many images go with one chat message. */
export const MAX_CHAT_IMAGES_PER_MESSAGE = 4;
const MAX_ID_ATTEMPTS = 20;

export interface ChatImageStoreDeps {
  db: Db;
  dataDir: string;
  /** Defaults to os.hostname(). */
  hostname?: () => string;
  /** Defaults to `() => new Date()`. Names the YYYY/MM folder and `created_at`. */
  now?: () => Date;
  /** Passed to generateId. Defaults to crypto.randomInt. */
  random?: (max: number) => number;
}

/** The store over the daemon's own db and data dir. No AppDeps field: built from `deps.db` + `config.dataDir`. */
export function chatImageStoreFor(app: AppDeps): ChatImageStoreDeps {
  return { db: app.db, dataDir: app.config.dataDir };
}

/** `chat-images/YYYY/MM/<id>.<ext>`, forward slashes, YYYY/MM in process-local time of `savedAt`. */
export function chatImageRelPath(id: string, ext: string, savedAt: Date): string {
  const yyyy = String(savedAt.getFullYear()).padStart(4, '0');
  const mm = String(savedAt.getMonth() + 1).padStart(2, '0');
  return `${CHAT_IMAGES_SUBDIR}/${yyyy}/${mm}/${id}.${ext}`;
}

/** The derivative cache key: `cache/c_<id>/`. Prefixed so it never equals a note image's `cache/<id>/`. */
export function chatImageCacheId(id: string): string {
  return `c_${id}`;
}

export type ChatImageVariant = 'original' | 'display' | 'thumb' | 'preview';

export function chatImageUrl(id: string, variant: ChatImageVariant): string {
  return `/api/chat/images/${id}/${variant}`;
}

/** The wire shape of a chat image (upload result, `GET /api/chat/images/:id`). */
export interface ChatImage {
  id: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  original_name: string | null;
  host: string | null;
  source: ChatImageSource;
  created_at: string;
  /** The original exists under this machine's data dir. */
  available: boolean;
  urls: Record<ChatImageVariant, string>;
}

export function toChatImage(row: ChatImageRow, available: boolean): ChatImage {
  return {
    id: row.id,
    mime: row.mime,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    original_name: row.originalName,
    host: row.host,
    source: row.source,
    created_at: row.createdAt.toISOString(),
    available,
    urls: {
      original: chatImageUrl(row.id, 'original'),
      display: chatImageUrl(row.id, 'display'),
      thumb: chatImageUrl(row.id, 'thumb'),
      preview: chatImageUrl(row.id, 'preview'),
    },
  };
}

export type ChatImageInputErrorCode = 'not_an_image' | 'too_large';

/** The uploaded bytes cannot become a chat image. HTTP: too_large -> 413, not_an_image -> 415. */
export class ChatImageInputError extends Error {
  override name = 'ChatImageInputError';
  constructor(
    readonly code: ChatImageInputErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type ChatImageLookupErrorCode = 'unknown_image' | 'not_on_this_machine' | 'unreadable_image';

/** An `image_ids` entry of a chat request cannot be sent. HTTP: 400 / 409 / 422. */
export class ChatImageLookupError extends Error {
  override name = 'ChatImageLookupError';
  constructor(
    readonly code: ChatImageLookupErrorCode,
    readonly imageId: string,
    message: string,
  ) {
    super(message);
  }
}

export async function findChatImage(db: Db, id: string): Promise<ChatImageRow | null> {
  const rows = await db.select().from(chatImages).where(eq(chatImages.id, id)).limit(1);
  return rows[0] ?? null;
}

async function findChatImageBySha(db: Db, sha256: string): Promise<ChatImageRow | null> {
  const rows = await db.select().from(chatImages).where(eq(chatImages.sha256, sha256)).limit(1);
  return rows[0] ?? null;
}

/** Serialises ingests of the same bytes inside this process (the unique index covers other hosts). */
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

/**
 * Known bytes whose original is missing here (stored by the other laptop, or deleted by hand):
 * the identical bytes go back to the row's path, so this machine can serve and send it. True when
 * the original is on disk afterwards.
 */
async function ensureLocalCopy(deps: ChatImageStoreDeps, row: ChatImageRow, bytes: Uint8Array): Promise<boolean> {
  const abs = resolveInDataDir(deps.dataDir, row.path);
  if (await fileExists(abs)) return true;
  try {
    await writeNewFile(abs, bytes);
  } catch (err) {
    if (!(err instanceof DestinationExistsError)) throw err;
  }
  return true;
}

export interface IngestChatImageInput {
  bytes: Uint8Array;
  /** The client's file name, kept for display only. */
  originalName: string | null;
  source: ChatImageSource;
  /** Default MAX_CHAT_IMAGE_BYTES. */
  maxBytes?: number;
}

export interface IngestChatImageResult {
  image: ChatImage;
  /** False when the same bytes were already stored: `image` is that row. */
  created: boolean;
}

/**
 * Store one pasted image: sha256 dedupe (existing row returned, its file healed when missing),
 * probe by magic bytes, write `chat-images/YYYY/MM/<id>.<ext>`, insert. A new id is free in
 * `chat_images` only (its own id space). A lost insert race (same bytes from another process or
 * host) removes this process's file and returns the winner.
 */
export async function ingestChatImage(deps: ChatImageStoreDeps, input: IngestChatImageInput): Promise<IngestChatImageResult> {
  const maxBytes = input.maxBytes ?? MAX_CHAT_IMAGE_BYTES;
  const size = input.bytes.byteLength;
  if (size === 0) throw new ChatImageInputError('not_an_image', 'the uploaded file is empty');
  if (size > maxBytes) throw new ChatImageInputError('too_large', `file is ${size} bytes; the limit is ${maxBytes}`);
  const sha256 = sha256Hex(input.bytes);

  return withShaLock(sha256, async (): Promise<IngestChatImageResult> => {
    const existing = await findChatImageBySha(deps.db, sha256);
    if (existing !== null) {
      return { image: toChatImage(existing, await ensureLocalCopy(deps, existing, input.bytes)), created: false };
    }

    let probe: ImageProbe;
    try {
      probe = await probeImage(input.bytes);
    } catch (err) {
      if (err instanceof UnsupportedImageError) throw new ChatImageInputError('not_an_image', `not an image: ${err.message}`);
      throw err;
    }

    const savedAt = (deps.now ?? (() => new Date()))();
    const host = (deps.hostname ?? os.hostname)();
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const id = generateId(deps.random);
      if ((await findChatImage(deps.db, id)) !== null) continue;
      const rel = chatImageRelPath(id, probe.mimeExt, savedAt);
      const abs = resolveInDataDir(deps.dataDir, rel);
      try {
        await writeNewFile(abs, input.bytes);
      } catch (err) {
        if (err instanceof DestinationExistsError) continue; // a stray file from a crashed run: take another id
        throw err;
      }
      let inserted: ChatImageRow[];
      try {
        inserted = await deps.db
          .insert(chatImages)
          .values({
            id,
            path: rel,
            sha256,
            mime: probe.mime,
            width: probe.width,
            height: probe.height,
            bytes: size,
            originalName: input.originalName,
            host,
            source: input.source,
            createdAt: savedAt,
          })
          .onConflictDoNothing()
          .returning();
      } catch (err) {
        await removeQuietly(abs);
        throw err;
      }
      const row = inserted[0];
      if (row !== undefined) return { image: toChatImage(row, true), created: true };
      // Conflict: the same bytes landed meanwhile (sha256), or the id was just taken. Either way this file goes.
      await removeQuietly(abs);
      const holder = await findChatImageBySha(deps.db, sha256);
      if (holder !== null) {
        return { image: toChatImage(holder, await ensureLocalCopy(deps, holder, input.bytes)), created: false };
      }
    }
    throw new Error('Could not find a free chat image id.');
  });
}

export interface LocatedChatImage {
  row: ChatImageRow;
  /** What the derive.ts getters take; `id` is the `c_<id>` cache key. */
  source: ImageSource;
  available: boolean;
}

/** A chat image by id (any spelling `normalizeId` accepts), or null. */
export async function locateChatImage(
  deps: Pick<ChatImageStoreDeps, 'db' | 'dataDir'>,
  rawId: string,
): Promise<LocatedChatImage | null> {
  const id = normalizeId(rawId);
  if (id === null) return null;
  const row = await findChatImage(deps.db, id);
  if (row === null) return null;
  const originalPath = resolveInDataDir(deps.dataDir, row.path);
  return {
    row,
    source: { id: chatImageCacheId(row.id), mime: row.mime, originalPath },
    available: await fileExists(originalPath),
  };
}

/**
 * The images of one chat request, deduped (first spelling wins), in request order, each with its
 * `preview` derivative generated. Throws ChatImageLookupError for an unknown id, an original that
 * is not on this machine, or a preview that cannot be made.
 */
export async function resolveTurnImages(
  deps: Pick<ChatImageStoreDeps, 'db' | 'dataDir'>,
  rawIds: readonly string[],
): Promise<ChatTurnImage[]> {
  const out: ChatTurnImage[] = [];
  const seen = new Set<string>();
  for (const raw of rawIds) {
    const id = normalizeId(raw);
    if (id === null) throw new ChatImageLookupError('unknown_image', raw, `no pasted image ${raw}`);
    if (seen.has(id)) continue;
    seen.add(id);
    const loc = await locateChatImage(deps, id);
    if (loc === null) throw new ChatImageLookupError('unknown_image', id, `no pasted image ${id}`);
    if (!loc.available) {
      throw new ChatImageLookupError(
        'not_on_this_machine',
        id,
        `pasted image ${id} is stored on ${loc.row.host ?? 'another machine'}, not on this one`,
      );
    }
    let previewPath: string;
    try {
      previewPath = await getPreview(deps.dataDir, loc.source);
    } catch (err) {
      if (err instanceof OriginalMissingError) {
        throw new ChatImageLookupError('not_on_this_machine', id, `pasted image ${id} is not on this machine`);
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new ChatImageLookupError('unreadable_image', id, `could not prepare pasted image ${id}: ${reason}`);
    }
    out.push({
      id,
      previewPath,
      previewMime: 'image/jpeg',
      width: loc.row.width,
      height: loc.row.height,
      originalName: loc.row.originalName,
    });
  }
  return out;
}
