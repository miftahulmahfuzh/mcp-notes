/** One image of a note, as the server sends it (src/notes/types.ts, phase 2). */
export interface NoteImage {
  id: string;
  note_id: string;
  position: number;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  taken_at: string | null;
  original_name: string | null;
  host: string | null;
  /** The original exists under this machine's data dir. */
  available: boolean;
  /** `/api/images/<id>/<variant>`. */
  urls: { thumb: string; display: string; original: string; preview: string };
  /** Present only on removed images (bin listings). */
  deleted_at?: string;
}

export interface Note {
  id: string;
  body: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  origin: Record<string, unknown> | null;
  /** Live images, ascending `position`. Empty for a text note. */
  images: NoteImage[];
}

/** One image in the gallery / photo modal: `k` is 1-based within its note of `n` images. */
export interface PhotoItem {
  note: Note;
  image: NoteImage;
  k: number;
  n: number;
}

export interface TagCount {
  tag: string;
  count: number;
  last_used: string | null;
}

export type Mode = 'text' | 'images' | 'all';
