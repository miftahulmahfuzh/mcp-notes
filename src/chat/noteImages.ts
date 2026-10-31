import { getPreview, OriginalMissingError } from '../images/derive.js';
import { locateImage, type ImageDeps } from '../images/ingest.js';
import { normalizeId } from '../notes/ids.js';
import type { ChatTurnImage } from './backend.js';
import { ChatImageLookupError } from './images.js';

/**
 * The pictures of one chat request that already live in notes (the "chat about this image"
 * button), deduped, in request order, each with its `preview` derivative generated. They are
 * referenced, never copied: nothing is written to `chat_images`. Each carries `note` (its note's
 * id and its 1-based place among the note's live images) so the model knows which note holds it.
 * Throws ChatImageLookupError for an unknown or removed image, a deleted note, an original that
 * is not on this machine, or a preview that cannot be made.
 */
export async function resolveTurnNoteImages(deps: ImageDeps, rawIds: readonly string[]): Promise<ChatTurnImage[]> {
  const out: ChatTurnImage[] = [];
  const seen = new Set<string>();
  for (const raw of rawIds) {
    const id = normalizeId(raw);
    if (id === null) throw new ChatImageLookupError('unknown_image', raw, `no note image ${raw}`);
    if (seen.has(id)) continue;
    seen.add(id);
    const loc = await locateImage(deps, id);
    if (loc === null || loc.deleted) throw new ChatImageLookupError('unknown_image', id, `no image ${id} in a live note`);
    if (!loc.available) {
      throw new ChatImageLookupError('not_on_this_machine', id, `image ${id} is stored on ${loc.host ?? 'another machine'}, not on this one`);
    }
    const note = await deps.notes.getOne(loc.noteId);
    const index = note === null ? -1 : note.images.findIndex((image) => image.id === id);
    if (note === null || index < 0) throw new ChatImageLookupError('unknown_image', id, `no image ${id} in a live note`);
    let previewPath: string;
    try {
      previewPath = await getPreview(deps.dataDir, loc);
    } catch (err) {
      if (err instanceof OriginalMissingError) {
        throw new ChatImageLookupError('not_on_this_machine', id, `image ${id} is not on this machine`);
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new ChatImageLookupError('unreadable_image', id, `could not prepare image ${id}: ${reason}`);
    }
    out.push({
      id,
      previewPath,
      previewMime: 'image/jpeg',
      width: loc.meta.width,
      height: loc.meta.height,
      originalName: loc.meta.original_name ?? null,
      note: { id: note.id, k: index + 1, n: note.images.length },
    });
  }
  return out;
}
