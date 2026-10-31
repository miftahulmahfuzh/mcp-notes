import { useCallback, useMemo, useRef, useState } from 'react';
import { chatImageUrl, uploadChatImage, type ChatImageUpload } from '../api';
import type { ChatBarImage } from '../components/ChatBar';

/** Images per message; matches the server's MAX_CHAT_IMAGES_PER_MESSAGE. */
export const MAX_CHAT_IMAGES = 4;

const TOO_MANY = `at most ${MAX_CHAT_IMAGES} images per message`;

export interface PendingChatImage extends ChatBarImage {
  /** The chat image id once uploaded; for a note image, the `note_images` id. */
  id: string | null;
  /** 'note': a picture that already lives in a note (referenced, never uploaded). Absent: a pasted upload. */
  source?: 'note';
}

export interface ChatImages {
  images: PendingChatImage[];
  /** Ids of the uploaded images, in paste order, without repeats. Pictures from notes are in `noteIds`. */
  readyIds: string[];
  /** Ids of the note images attached with `addNote`, without repeats. */
  noteIds: string[];
  /** True while any image is uploading or failed: the message waits (or the failed one is removed). */
  blocked: boolean;
  /** Upload each file at once; past MAX_CHAT_IMAGES a file shows as failed. */
  add: (files: File[]) => void;
  /** Attach a picture that already lives in a note, by its image id: no upload, no copy. */
  addNote: (imageId: string) => void;
  remove: (key: string) => void;
  /** After sending. */
  clear: () => void;
}

let keySeq = 0;
const nextKey = (): string => `chat-img-${++keySeq}`;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useChatImages(upload: (file: File) => Promise<ChatImageUpload> = uploadChatImage): ChatImages {
  const [images, setImages] = useState<PendingChatImage[]>([]);
  // Synchronous mirror: add() counts against the cap and late upload results check membership.
  const ref = useRef<PendingChatImage[]>([]);

  const commit = useCallback((next: PendingChatImage[]) => {
    ref.current = next;
    setImages(next);
  }, []);

  /** Apply an upload's outcome, unless the image was removed (or the bar cleared) meanwhile. */
  const patch = useCallback(
    (key: string, change: Partial<PendingChatImage>) => {
      if (!ref.current.some((i) => i.key === key)) return;
      commit(ref.current.map((i) => (i.key === key ? { ...i, ...change } : i)));
    },
    [commit],
  );

  const add = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      const next = [...ref.current];
      for (const file of files) {
        const key = nextKey();
        const label = file.name || 'pasted image';
        if (next.length >= MAX_CHAT_IMAGES) {
          next.push({ key, label, state: 'failed', id: null, thumbUrl: null, error: TOO_MANY });
          continue;
        }
        next.push({ key, label, state: 'uploading', id: null, thumbUrl: null, error: null });
        upload(file).then(
          (r) => patch(key, { state: 'ready', id: r.image.id, thumbUrl: chatImageUrl(r.image.id, 'thumb'), error: null }),
          (err: unknown) => patch(key, { state: 'failed', error: messageOf(err) }),
        );
      }
      commit(next);
    },
    [upload, patch, commit],
  );

  const addNote = useCallback(
    (imageId: string) => {
      if (ref.current.some((i) => i.source === 'note' && i.id === imageId)) return;
      const key = nextKey();
      if (ref.current.length >= MAX_CHAT_IMAGES) {
        commit([...ref.current, { key, label: 'image from a note', state: 'failed', id: null, thumbUrl: null, error: TOO_MANY, source: 'note' }]);
        return;
      }
      commit([
        ...ref.current,
        { key, label: `image ${imageId} from a note`, state: 'ready', id: imageId, thumbUrl: `/api/images/${imageId}/thumb`, error: null, source: 'note' },
      ]);
    },
    [commit],
  );

  const remove = useCallback((key: string) => commit(ref.current.filter((i) => i.key !== key)), [commit]);

  const clear = useCallback(() => commit([]), [commit]);

  const readyIds = useMemo(() => {
    const ids: string[] = [];
    for (const i of images) if (i.source !== 'note' && i.state === 'ready' && i.id !== null && !ids.includes(i.id)) ids.push(i.id);
    return ids;
  }, [images]);

  const noteIds = useMemo(() => {
    const ids: string[] = [];
    for (const i of images) if (i.source === 'note' && i.state === 'ready' && i.id !== null && !ids.includes(i.id)) ids.push(i.id);
    return ids;
  }, [images]);

  const blocked = images.some((i) => i.state !== 'ready');

  return { images, readyIds, noteIds, blocked, add, addNote, remove, clear };
}
