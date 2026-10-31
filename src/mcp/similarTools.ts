import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { IMAGE_EMBEDDING_MODEL } from '../embeddings/imageConstants.js';
import type { ImageEmbedder } from '../embeddings/imageEmbedder.js';
import { notePngForEmbedding, toEmbeddingPng } from '../embeddings/imageInput.js';
import { nearestImages, saveImageEmbedding, type NearestImage } from '../embeddings/imageRepo.js';
import { toolImageDeps } from '../http/imageAccess.js';
import { OriginalMissingError } from '../images/derive.js';
import { locateImage, type LocatedImage } from '../images/ingest.js';
import { fileExists } from '../images/store.js';
import { normalizeId } from '../notes/ids.js';
import { errorResult, jsonResult, type ToolDeps } from './tools.js';

export const SIMILAR_IMAGES_DEFAULT_LIMIT = 10;
export const SIMILAR_IMAGES_MAX_LIMIT = 50;
/** Note body characters shown per hit. */
export const SIMILAR_SNIPPET_CHARS = 200;

export const IMAGE_SEARCH_OFF =
  'semantic image search is off on this daemon (OPENROUTER_API_KEY is not set), so pictures cannot be compared. ' +
  'Use search, or list with has_image: true, to find photos by their note text instead.';

/**
 * Answer to a similar_images call that still carries pasted_image. With the notes-paste
 * PreToolUse hook installed (phase 8) the daemon never sees pasted_image: the hook uploads the
 * pasted image and rewrites the call to upload_id. Reaching this means the hook is missing, found
 * no pasted image, or could not upload it.
 */
export const PASTED_IMAGE_NEEDS_HOOK =
  'pasted_image could not be resolved: the call reached the server without an upload_id, so the ' +
  "Claude Code notes-paste hook did not upload a pasted image. Either the user's recent messages carry " +
  'no pasted image, or the hook is not installed (run scripts/install.sh in ~/mcp-notes, then restart ' +
  'Claude Code). Ask the user to paste the image again in the same message as the request, or call ' +
  'similar_images with image_id (a picture already in a note) or query (words) instead.';

/** A message for the model; the handler turns it into an isError result. */
class SimilarError extends Error {
  override name = 'SimilarError';
}

export interface SimilarArgs {
  image_id?: string | undefined;
  upload_id?: string | undefined;
  query?: string | undefined;
  pasted_image?: number | undefined;
  limit?: number | undefined;
}

export type SimilarSource = { image_id: string } | { upload_id: string } | { query: string };

export interface SimilarHit {
  image_id: string;
  note_id: string;
  /** 1 - cosine distance, 4 decimals: 1 = the same picture, near 0 = unrelated. */
  similarity: number;
  note: { body: string; tags: string[] };
  /** The image's file is on this machine (view_images can show it). */
  available: boolean;
}

export interface SimilarImagesResult {
  source: SimilarSource;
  model: string;
  hits: SimilarHit[];
  next: string;
}

/** How many of the four sources are set. */
export function countSources(args: SimilarArgs): number {
  return [args.image_id, args.upload_id, args.query, args.pasted_image].filter((v) => v !== undefined).length;
}

/** Whitespace collapsed, at most `max` characters, an ellipsis when cut, never half a surrogate pair. */
export function bodySnippet(body: string, max: number = SIMILAR_SNIPPET_CHARS): string {
  const text = body.trim().replace(/\s+/g, ' ');
  if (text.length <= max) return text;
  let cut = text.slice(0, Math.max(0, max - 1));
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function requireEmbedder(deps: ToolDeps): ImageEmbedder {
  const embedder = deps.imageEmbedder ?? null;
  if (embedder === null) throw new SimilarError(IMAGE_SEARCH_OFF);
  return embedder;
}

/** Embeds a stored note image now (the guarded upsert the worker does), like `related` does for notes. */
async function embedStoredImage(deps: ToolDeps, loc: LocatedImage): Promise<void> {
  const embedder = deps.imageEmbedder ?? null;
  if (embedder === null) {
    throw new SimilarError(`Image ${loc.id} has no image embedding yet and ${IMAGE_SEARCH_OFF}`);
  }
  const elsewhere =
    `Image ${loc.id} has no image embedding yet and its file lives on ${loc.host ?? 'another machine'}, so it cannot be embedded here; ` +
    "that machine's daemon embeds it in the background. Try again later, or describe the picture with query instead.";
  if (!loc.available) throw new SimilarError(elsewhere);
  let png: Uint8Array;
  try {
    png = await notePngForEmbedding(deps.dataDir, loc);
  } catch (err) {
    if (err instanceof OriginalMissingError) throw new SimilarError(elsewhere);
    throw new SimilarError(`Image ${loc.id} could not be prepared for embedding (${reason(err)}).`);
  }
  let vector: number[];
  try {
    vector = await embedder.embedImage(png);
  } catch (err) {
    throw new SimilarError(
      `Image ${loc.id} has no image embedding yet and embedding it now failed (${reason(err)}). The background job retries it; try again later.`,
    );
  }
  await saveImageEmbedding(deps.db, { imageId: loc.id, imageSha256: loc.meta.sha256, model: embedder.model, embedding: vector });
}

async function nearestFor(
  deps: ToolDeps,
  args: SimilarArgs,
  limit: number,
): Promise<{ source: SimilarSource; model: string; nearest: NearestImage[] }> {
  if (args.image_id !== undefined) {
    const id = normalizeId(args.image_id);
    if (id === null) {
      throw new SimilarError(`${args.image_id}: not an image id (image ids look like A-B32; take them from a note's images[].id).`);
    }
    const loc = await locateImage(toolImageDeps(deps), id);
    if (loc === null) {
      throw new SimilarError(`${id}: no such image. Image ids come from a note's images[].id (get, list or search with has_image: true).`);
    }
    // Without an embedder, existing vectors of the configured model still answer (as `related` does).
    const model = deps.imageEmbedder?.model ?? IMAGE_EMBEDDING_MODEL;
    let nearest = await nearestImages(deps.db, { source: { imageId: id }, model, limit });
    if (nearest === null) {
      await embedStoredImage(deps, loc);
      nearest = await nearestImages(deps.db, { source: { imageId: id }, model, limit });
      if (nearest === null) throw new SimilarError(`Image ${id} changed while it was being embedded. Try again.`);
    }
    return { source: { image_id: id }, model, nearest };
  }

  if (args.upload_id !== undefined) {
    const embedder = requireEmbedder(deps);
    const lookup = deps.chatUploads;
    if (lookup === undefined) throw new SimilarError('upload_id is not available on this daemon (it has no chat image store).');
    const upload = await lookup(args.upload_id);
    if (upload === null) {
      throw new SimilarError(`${args.upload_id}: no such chat upload. Upload ids appear in chat messages as [image upload:ID].`);
    }
    if (!(await fileExists(upload.absPath))) {
      throw new SimilarError(`Upload ${upload.id} was pasted on another machine; its file is not here, so it cannot be compared from this daemon.`);
    }
    let png: Uint8Array;
    try {
      png = await toEmbeddingPng(upload.absPath);
    } catch (err) {
      throw new SimilarError(`Upload ${upload.id} could not be read as an image (${reason(err)}).`);
    }
    let vector: number[];
    try {
      vector = await embedder.embedImage(png);
    } catch (err) {
      throw new SimilarError(`Embedding upload ${upload.id} failed (${reason(err)}). Try again in a moment.`);
    }
    // Embedded on the fly, never persisted: an upload is a question, not a note.
    const nearest = await nearestImages(deps.db, { source: { vector }, model: embedder.model, limit });
    return { source: { upload_id: upload.id }, model: embedder.model, nearest: nearest ?? [] };
  }

  if (args.query !== undefined) {
    const embedder = requireEmbedder(deps);
    const query = args.query.trim();
    if (query === '') throw new SimilarError('query is empty: describe the picture in words, e.g. "red top in a car".');
    let vector: number[];
    try {
      vector = await embedder.embedText(query);
    } catch (err) {
      throw new SimilarError(`Embedding the query failed (${reason(err)}). Try again in a moment.`);
    }
    const nearest = await nearestImages(deps.db, { source: { vector }, model: embedder.model, limit });
    return { source: { query }, model: embedder.model, nearest: nearest ?? [] };
  }

  throw new SimilarError(PASTED_IMAGE_NEEDS_HOOK);
}

/** Joins hits to their live notes; a hit whose note or image went away meanwhile is dropped. */
async function toHits(deps: ToolDeps, nearest: NearestImage[]): Promise<SimilarHit[]> {
  if (nearest.length === 0) return [];
  const found = await deps.service.get([...new Set(nearest.map((n) => n.noteId))]);
  const notes = new Map(found.notes.map((n) => [n.id, n]));
  const hits: SimilarHit[] = [];
  for (const n of nearest) {
    const note = notes.get(n.noteId);
    const image = note?.images.find((i) => i.id === n.imageId);
    if (note === undefined || image === undefined) continue;
    hits.push({
      image_id: n.imageId,
      note_id: n.noteId,
      similarity: n.similarity,
      note: { body: bodySnippet(note.body), tags: note.tags },
      available: image.available,
    });
  }
  return hits;
}

export function registerSimilarTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'similar_images',
    {
      title: 'Similar images',
      description:
        'Find the photos that look most like a picture, or that match a description of what is in it. Give exactly one of: ' +
        "image_id (a picture already in the notes, from a note's images[].id), " +
        'upload_id (an image pasted into the wall chat; the message names it [image upload:ID]), ' +
        'query (words describing the picture, e.g. "red top in a car"; words and pictures share one vector space), ' +
        'or pasted_image (Claude Code: the number of an image pasted into this conversation, 1 for the first). ' +
        'Returns { source, model, hits: [{ image_id, note_id, similarity, note: { body, tags }, available }] }, most similar first ' +
        '(similarity 1 = the same picture, near 0 = unrelated). Never returns the source image, a removed image or an image of a deleted note. ' +
        'It only measures likeness: call view_images with the top image ids and look before saying which ones match.',
      inputSchema: {
        image_id: z
          .string()
          .min(1)
          .optional()
          .describe("A picture already in the notes: an id from a note's images[].id, like A-B32. Case-insensitive; the dash may be omitted."),
        upload_id: z
          .string()
          .min(1)
          .optional()
          .describe('An image pasted into the wall chat: the ID from "[image upload:ID]" in the message.'),
        query: z
          .string()
          .min(1)
          .optional()
          .describe('Words describing what is IN the picture, e.g. "red top in a car". For words in the note text use search instead.'),
        pasted_image: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe(
            'Claude Code only: N of "[Image #N]" for an image pasted into the conversation, 1 for the first. ' +
              'A pasted image has no file path; the notes-paste hook uploads it and replaces this with upload_id ' +
              'before the call arrives.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(SIMILAR_IMAGES_MAX_LIMIT)
          .optional()
          .describe(`How many images to return, 1-${SIMILAR_IMAGES_MAX_LIMIT}. Default ${SIMILAR_IMAGES_DEFAULT_LIMIT}.`),
      },
      annotations: { readOnlyHint: true },
    },
    async (args): Promise<CallToolResult> => {
      const n = countSources(args);
      if (n !== 1) {
        return fail(`similar_images needs exactly one of image_id, upload_id, query or pasted_image (got ${n === 0 ? 'none' : n}).`);
      }
      if (args.pasted_image !== undefined) return fail(PASTED_IMAGE_NEEDS_HOOK);
      const limit = Math.min(Math.max(Math.trunc(args.limit ?? SIMILAR_IMAGES_DEFAULT_LIMIT), 1), SIMILAR_IMAGES_MAX_LIMIT);
      try {
        const { source, model, nearest } = await nearestFor(deps, args, limit);
        const hits = await toHits(deps, nearest);
        const result: SimilarImagesResult = {
          source,
          model,
          hits,
          next:
            hits.length > 0
              ? 'Call view_images with the top image_ids to look at them before saying which ones match.'
              : 'No other embedded picture to compare with yet. New images are embedded in the background within a minute; npm run embed:images:backfill embeds existing ones.',
        };
        return jsonResult(result);
      } catch (err) {
        if (err instanceof SimilarError) return fail(err.message);
        return errorResult(err);
      }
    },
  );
}
