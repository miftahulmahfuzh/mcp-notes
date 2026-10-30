import { useEffect, useRef, useState } from 'react';
import { ImageSquare, Paperclip } from '@phosphor-icons/react';
import type { Note } from '../types';
import { attachImage, type AttachResult } from '../api';
import { flashNote } from '../lib/flash';

/** Moved to lib/flash (shared with the wall's deep link); re-exported for existing importers. */
export { flashNote };

/** Phase 5: `POST /api/images` → 201 `{ note, created: true }` or 200 `{ note, created: false }`. */
export type UploadResult = { note: Note; created: boolean };

type FileSource = FileList | ArrayLike<File> | null | undefined;

/** The image files of a FileList, in order. */
export function imageFiles(files: FileSource): File[] {
  return Array.from(files ?? []).filter((f) => f.type.startsWith('image/'));
}

/** The first image file, or null (the paste rule, Notes Wall.dc.html:222). */
export function firstImageFile(files: FileSource): File | null {
  return imageFiles(files)[0] ?? null;
}

/** True only for drags that carry files (not text or links). */
export function hasFiles(dt: Pick<DataTransfer, 'types'> | null | undefined): boolean {
  return !!dt && Array.from(dt.types ?? []).includes('Files');
}

/** POST /api/images (multipart `file`) → {note, created}. Throws on a non-2xx response. */
export async function uploadImage(file: File, fetchImpl: typeof fetch = fetch): Promise<UploadResult> {
  const form = new FormData();
  form.append('file', file, file.name || 'pasted-image');
  const res = await fetchImpl('/api/images', { method: 'POST', body: form });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`upload failed: ${res.status} ${detail}`.trim());
  }
  return (await res.json()) as UploadResult;
}

export interface DropOverlayProps {
  /** Call once per note returned by POST /api/images. App inserts it and switches text -> all. */
  onImageAdded: (note: Note) => void;
  /** The note open in the big editor, or null. When set, files attach to it instead of making new notes. */
  target?: string | null;
  /** Called once per attach (target set) with the server's result and the note id it was sent to. */
  onAttached?: (result: AttachResult, target: string) => void;
}

export function DropOverlay({ onImageAdded, target = null, onAttached }: DropOverlayProps) {
  const [dragging, setDragging] = useState(false);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const addedRef = useRef(onImageAdded);
  const attachedRef = useRef(onAttached);
  const targetRef = useRef<string | null>(target);

  useEffect(() => {
    addedRef.current = onImageAdded;
    attachedRef.current = onAttached;
    targetRef.current = target;
  }, [onImageAdded, onAttached, target]);

  useEffect(() => {
    const enqueue = (files: File[]) => {
      const to = targetRef.current;
      for (const file of files) {
        queue.current = queue.current.then(async () => {
          try {
            if (to) {
              const result = await attachImage(to, file);
              attachedRef.current?.(result, to);
            } else {
              const result = await uploadImage(file);
              addedRef.current(result.note);
              if (!result.created) flashNote(result.note.id);
            }
          } catch (err) {
            console.error(to ? '[attach]' : '[upload]', file.name, err);
          }
        });
      }
    };

    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      setDragging(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (!e.relatedTarget) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      setDragging(false);
      enqueue(imageFiles(e.dataTransfer?.files));
    };
    const onPaste = (e: ClipboardEvent) => {
      const file = firstImageFile(e.clipboardData?.files);
      if (!file) return;
      e.preventDefault();
      enqueue([file]);
    };

    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('drop', onDrop);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('drop', onDrop);
      document.removeEventListener('paste', onPaste);
    };
  }, []);

  if (!dragging) return null;
  return (
    <div
      data-drop-overlay={target ? 'attach' : 'new'}
      style={{
        position: 'fixed',
        inset: 10,
        border: '1px dashed rgba(236,235,228,.5)',
        zIndex: 70,
        pointerEvents: 'none',
        display: 'grid',
        placeItems: 'center',
        fontSize: 48,
        color: '#ecebe4',
        background: 'rgba(18,18,17,.6)',
      }}
    >
      {target ? <Paperclip weight="duotone" /> : <ImageSquare weight="duotone" />}
    </div>
  );
}
