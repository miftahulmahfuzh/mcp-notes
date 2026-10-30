import type { Note, TagCount } from './types';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function check(res: Response): Promise<Response> {
  if (res.ok) return res;
  let msg = `${res.status} ${res.statusText}`.trim();
  try {
    const j: unknown = await res.json();
    if (j && typeof j === 'object' && typeof (j as { error?: unknown }).error === 'string') {
      msg = (j as { error: string }).error;
    }
  } catch {
    // body was not JSON; keep the status line
  }
  throw new ApiError(res.status, msg);
}

const enc = encodeURIComponent;
const JSON_HEADERS = { 'content-type': 'application/json' };

/** Phase 6: `GET /api/notes` → `{ notes, next_cursor }`. One page of 2000 covers this owner's notes. */
export async function fetchNotes(): Promise<Note[]> {
  const res = await check(await fetch('/api/notes?limit=2000'));
  const j = (await res.json()) as { notes: Note[]; next_cursor: string | null };
  return j.notes;
}

/** Phase 6: `GET /api/tags` → `[{ tag, count, last_used }]`. */
export async function fetchTags(): Promise<TagCount[]> {
  const res = await check(await fetch('/api/tags'));
  return (await res.json()) as TagCount[];
}

export async function createNote(body: string): Promise<Note> {
  const res = await check(await fetch('/api/notes', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ body }) }));
  return (await res.json()) as Note;
}

export async function updateNote(id: string, body: string): Promise<Note> {
  const res = await check(await fetch(`/api/notes/${enc(id)}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ body }) }));
  return (await res.json()) as Note;
}

export async function deleteNote(id: string): Promise<void> {
  const res = await fetch(`/api/notes/${enc(id)}`, { method: 'DELETE' });
  if (res.status === 404) return;
  await check(res);
}

export function postChat(message: string, threadId: string | undefined, signal: AbortSignal): Promise<Response> {
  const payload: { message: string; thread_id?: string } = { message };
  if (threadId) payload.thread_id = threadId;
  return fetch('/api/chat', {
    method: 'POST',
    headers: { ...JSON_HEADERS, accept: 'text/event-stream' },
    body: JSON.stringify(payload),
    signal,
  });
}

export type ImageFileVariant = 'thumb' | 'display' | 'original' | 'preview';

/** `/api/images/<imageId>/<variant>` — serves any image row's file (phase 2). */
export function imageUrl(imageId: string, variant: ImageFileVariant): string {
  return `/api/images/${enc(imageId)}/${variant}`;
}

/** `GET /api/images/<imageId>` → the image's wire `NoteImage` JSON. */
export function imageInfoUrl(imageId: string): string {
  return `/api/images/${enc(imageId)}`;
}

/** Phase 3: `POST /api/notes/:id/images` → 201 `{ note, attached: true }` or 200 `{ note, attached: false }` (bytes already live in `note`). */
export interface AttachResult {
  note: Note;
  attached: boolean;
}

/** Attach one image file to an existing live note (multipart `file`). */
export async function attachImage(noteId: string, file: File): Promise<AttachResult> {
  const form = new FormData();
  form.append('file', file, file.name || 'pasted-image');
  const res = await check(await fetch(`/api/notes/${enc(noteId)}/images`, { method: 'POST', body: form }));
  return (await res.json()) as AttachResult;
}

/** Soft-remove one image from its note (to the bin). Returns the owner note without it. */
export async function removeImage(imageId: string): Promise<Note> {
  const res = await check(await fetch(`/api/images/${enc(imageId)}`, { method: 'DELETE' }));
  return (await res.json()) as Note;
}
