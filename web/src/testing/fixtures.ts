import type { Note, NoteFile, NoteImage } from '../types';
import { tagsOf } from '../lib/text';

const ISO = '2026-10-30T01:00:00.000Z';

/** A wire `NoteImage` (600x400 JPEG on 'lenovo', available). `note_id` defaults to `id` (a note's first image). */
export function makeImage(id: string, over: Partial<NoteImage> = {}): NoteImage {
  const base: NoteImage = {
    id,
    note_id: id,
    position: 0,
    mime: 'image/jpeg',
    width: 600,
    height: 400,
    bytes: 1,
    taken_at: null,
    original_name: null,
    host: 'lenovo',
    available: true,
    urls: {
      thumb: `/api/images/${id}/thumb`,
      display: `/api/images/${id}/display`,
      original: `/api/images/${id}/original`,
      preview: `/api/images/${id}/preview`,
    },
  };
  return { ...base, ...over };
}

/** A wire `NoteFile` (2 KB PDF on 'lenovo', available). `note_id` defaults to `id`. Phase 5. */
export function makeFile(id: string, over: Partial<NoteFile> = {}): NoteFile {
  const base: NoteFile = {
    id,
    note_id: id,
    position: 0,
    name: 'report.pdf',
    mime: 'application/pdf',
    bytes: 2048,
    host: 'lenovo',
    available: true,
    extraction_status: 'none',
    urls: { download: `/api/files/${id}/download` },
  };
  return { ...base, ...over };
}

export type MakeNoteOpts = {
  /** Image ids (made with this note's id and positions 0..n-1) or ready images. */
  images?: Array<string | NoteImage>;
  /** Defaults to the body's hashtags. */
  tags?: string[];
  created?: string;
  /** Defaults to `created`. */
  updated?: string;
  /** Ready files (Phase 5). Defaults to none. */
  files?: NoteFile[];
};

/** A wire `Note`. */
export function makeNote(id: string, body: string, opts: MakeNoteOpts = {}): Note {
  const created = opts.created ?? ISO;
  const images = (opts.images ?? []).map((im, i) => (typeof im === 'string' ? makeImage(im, { note_id: id, position: i }) : im));
  return {
    id,
    body,
    tags: opts.tags ?? tagsOf(body),
    created_at: created,
    updated_at: opts.updated ?? created,
    origin: null,
    images,
    files: opts.files ?? [],
  };
}
