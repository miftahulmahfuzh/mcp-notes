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

/** What the main area shows: the wall (text / images / all modes), the recycle bin, or the chat history page (phase 9). */
export type View = 'wall' | 'bin' | 'history';

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

/** Phase 7 wire: who wrote a chat message. */
export type ChatRole = 'user' | 'assistant';

/** Phase 7 wire: where an exchange happened. `claude_code` = captured `/n` exchange (phase 8). */
export type ChatSource = 'wall' | 'claude_code';

/** Phase 7 wire: what a message attachment points at. */
export type ChatAttachmentKind = 'chat_image' | 'note_image' | 'note_file';

/**
 * Phase 7 wire (`src/chat/types.ts` `ChatAttachmentView`): one attachment of a chat message.
 * `url` is the large form (lightbox / download); `thumb_url` is null for files. No dimensions.
 */
export interface ChatAttachment {
  kind: ChatAttachmentKind;
  id: string;
  url: string;
  thumb_url: string | null;
}

/**
 * Phase 7 wire (`ChatReplyPreview`): the quoted header of a reply (rendered by phase 10). A
 * deleted or vanished target has `deleted: true`, empty `text` and possibly `role: null`.
 */
export interface ChatReplyPreview {
  id: string;
  role: ChatRole | null;
  text: string;
  deleted: boolean;
}

/** Phase 7 wire: one persisted chat message (`GET /api/chat/messages`). Times are UTC ISO. */
export interface ChatMessage {
  /** 4-char `[0-9A-Z]` id, shown to the model as `[msg:ID]`. */
  id: string;
  thread_id: string;
  role: ChatRole;
  text: string;
  source: ChatSource;
  /** 'claude' | 'glm' for wall answers; null otherwise. */
  brain: string | null;
  reply_to: ChatReplyPreview | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  attachments: ChatAttachment[];
}

/** Phase 7 wire (`ChatTimelinePage`): one page, ascending. `next_before` is the cursor for older messages; null when there are none. */
export interface ChatPage {
  messages: ChatMessage[];
  next_before: string | null;
}

/** Phase 7 wire: `op` of `event: chat` on `/api/events` (`src/chat/events.ts` `ChatOp`). Past tense. */
export type ChatOp = 'created' | 'updated' | 'deleted' | 'restored';

/** Phase 7 wire: data of `event: chat` on `/api/events`. */
export interface ChatChange {
  op: ChatOp;
  thread_id: string;
  id: string;
}
