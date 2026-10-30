import type { Bin, Note, TagCount } from './types';

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

/** `GET /api/bin?tag=a&tag=b` → deleted notes + deleted images, tag AND filter on the owning note. */
export async function fetchBin(tags: string[] = []): Promise<Bin> {
  const qs = tags.length ? '?' + tags.map((t) => `tag=${enc(t)}`).join('&') : '';
  const res = await check(await fetch(`/api/bin${qs}`));
  return (await res.json()) as Bin;
}

/** `POST /api/notes/:id/restore` → the live note. A note that is already live (409 not_deleted) is returned as it is. */
export async function restoreNote(id: string): Promise<Note> {
  const res = await fetch(`/api/notes/${enc(id)}/restore`, { method: 'POST' });
  if (res.status === 409) {
    const live = await check(await fetch(`/api/notes/${enc(id)}`));
    return (await live.json()) as Note;
  }
  await check(res);
  return (await res.json()) as Note;
}

/** 409 from `POST /api/images/:id/restore`: the same bytes already live in note `noteId`. */
export class DuplicateImageError extends ApiError {
  readonly noteId: string;
  constructor(noteId: string) {
    super(409, 'duplicate_image');
    this.name = 'DuplicateImageError';
    this.noteId = noteId;
  }
}

/** `POST /api/images/:imageId/restore` → the owning note (restored too when it was deleted). */
export async function restoreImage(imageId: string): Promise<Note> {
  const res = await fetch(`/api/images/${enc(imageId)}/restore`, { method: 'POST' });
  if (res.status === 409) {
    const j = (await res.json().catch(() => null)) as { error?: string; note_id?: string } | null;
    if (j?.error === 'duplicate_image' && typeof j.note_id === 'string') throw new DuplicateImageError(j.note_id);
    throw new ApiError(409, j?.error ?? 'conflict');
  }
  await check(res);
  return (await res.json()) as Note;
}

export type PurgeResult = { purged: string; files: number };

// Purge is guarded by sameOriginOnly on the server. These requests go out from the page itself, so
// the browser adds the page's Origin header to the DELETE. Never call them from anywhere else.

/** `DELETE /api/bin/notes/:id`: delete a deleted note forever (rows, originals, derived files). */
export async function purgeNote(id: string): Promise<PurgeResult> {
  const res = await check(await fetch(`/api/bin/notes/${enc(id)}`, { method: 'DELETE' }));
  return (await res.json()) as PurgeResult;
}

/** `DELETE /api/bin/images/:imageId`: delete a removed image forever (row, original, derived files). */
export async function purgeImage(imageId: string): Promise<PurgeResult> {
  const res = await check(await fetch(`/api/bin/images/${enc(imageId)}`, { method: 'DELETE' }));
  return (await res.json()) as PurgeResult;
}

/** Phase 9: what this notesd can do on this machine (`GET /api/capabilities`). */
export interface Capabilities {
  /** True only when notesd runs under WSL with interop and can launch explorer.exe. */
  reveal: boolean;
}

/** Phase 9: `GET /api/capabilities` → `{ reveal }`. Anything other than `reveal: true` reads as false. */
export async function fetchCapabilities(): Promise<Capabilities> {
  const res = await check(await fetch('/api/capabilities'));
  const j: unknown = await res.json();
  const reveal = !!j && typeof j === 'object' && (j as { reveal?: unknown }).reveal === true;
  return { reveal };
}

/** Phase 9: `POST /api/images/<imageId>/reveal` → 202. notesd spawns Explorer and does not wait for it. */
export async function revealImage(imageId: string): Promise<void> {
  await check(await fetch(`/api/images/${enc(imageId)}/reveal`, { method: 'POST' }));
}
