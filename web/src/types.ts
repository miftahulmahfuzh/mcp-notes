export interface NoteImageMeta {
  mime: string;
  width: number;
  height: number;
  bytes: number;
  taken_at: string | null;
  original_name: string | null;
  host: string | null;
  available: boolean;
}

export interface Note {
  id: string;
  body: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  origin: Record<string, unknown> | null;
  image: NoteImageMeta | null;
}

export interface TagCount {
  tag: string;
  count: number;
  last_used: string | null;
}

export type Mode = 'text' | 'images' | 'all';
