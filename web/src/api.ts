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

export const thumbUrl = (id: string): string => `/api/notes/${enc(id)}/thumb`;
export const displayUrl = (id: string): string => `/api/notes/${enc(id)}/display`;
export const originalUrl = (id: string): string => `/api/notes/${enc(id)}/original`;
