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

/** One non-image file of a note, as the server sends it (src/notes/types.ts NoteFile). */
export interface NoteFile {
  id: string;
  note_id: string;
  position: number;
  /** The user's file name. */
  name: string;
  mime: string;
  bytes: number;
  host: string | null;
  /** The file exists under this machine's data dir. */
  available: boolean;
  extraction_status: 'none' | 'pending' | 'done' | 'failed' | 'unsupported';
  /** `/api/files/<id>/download`, always an attachment. */
  urls: { download: string };
  /** Present only on removed files. */
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
  /** Live files, ascending `position`. The server always sends it; optional on the web type by plan decision (read `note.files ?? []`). */
  files?: NoteFile[];
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

/** Phase 4 wire: one tile of the bin's image grid. */
export interface BinImage {
  image: NoteImage;
  note_id: string;
  /** 'note': an image of a deleted note (actions act on the note). 'image': removed from a live note (actions act on the image). */
  kind: 'note' | 'image';
  deleted_at: string;
}

/** Phase 4 wire: `GET /api/bin`. Both lists newest `deleted_at` first. */
export interface Bin {
  notes: Note[];
  images: BinImage[];
}

/** What the main area shows: the wall (text / images / all modes) or the recycle bin. */
export type View = 'wall' | 'bin';

/** A pasted chat image as the server sends it (`POST /api/chat/images`; src/chat/images.ts `ChatImage`). */
export interface ChatImage {
  id: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  original_name: string | null;
  host: string | null;
  source: 'wall' | 'claude_code';
  created_at: string;
  available: boolean;
  /** `/api/chat/images/<id>/<variant>`. */
  urls: { thumb: string; display: string; original: string; preview: string };
}
