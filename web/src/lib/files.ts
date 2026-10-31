/**
 * Note files on the wall (R2, phase 5): which dropped / pasted / picked file takes which upload
 * path, how a file chip names its size and type, and the empty-note / reveal rules that count files.
 * Pure: no fetch, no DOM beyond the File objects handed in.
 */

type FileSource = FileList | ArrayLike<File> | null | undefined;

/**
 * The image types the image path (`POST /api/notes/:id/images`) accepts. Mirrors
 * `SUPPORTED_IMAGE_MIMES` in src/images/probe.ts. Everything else goes to `/files`, including
 * image/svg+xml, image/bmp and a file the browser reports with no type (Windows often does this for
 * HEIC). The server's `/files` hands bytes it sniffs as a supported image to the image path (plan
 * Decisions: "Client routing of attached files").
 */
export const ATTACHABLE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
  'image/tiff',
]);

/** One file to attach to an open note, and the upload path it takes. */
export type RoutedFile = { kind: 'image' | 'file'; file: File };

/** Every file, in order: supported images keep the image path, anything else becomes a note file. */
export function routeFiles(files: FileSource): RoutedFile[] {
  return Array.from(files ?? []).map((file): RoutedFile => ({
    kind: ATTACHABLE_IMAGE_TYPES.has(file.type.toLowerCase()) ? 'image' : 'file',
    file,
  }));
}

/**
 * What a ctrl-v hands on. With a note open (`attaching`), every pasted file attaches to it. Otherwise
 * only the first image counts, because it becomes a new photo note. Any other pasted file is left
 * alone (outside the editor a pasted PDF is ignored, as before).
 */
export function pastedFiles(files: FileSource, attaching: boolean): File[] {
  const all = Array.from(files ?? []);
  if (attaching) return all;
  const image = all.find((f) => f.type.startsWith('image/'));
  return image ? [image] : [];
}

const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

/** `0 B`, `1023 B`, `1 KB`, `1.5 KB`, `12 KB`, `5 MB`. Empty for a negative or non-finite size. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let v = bytes / 1024;
  let i = 0;
  // 1023.5 rounds to 1024 below, so step up to the next unit instead of printing "1024 KB".
  while (v >= 1023.5 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i += 1;
  }
  const s = v < 10 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v));
  return `${s} ${BYTE_UNITS[i]}`;
}

/** The lower-case extension of a file name (`report.PDF` → `pdf`), or '' when there is none. */
export function extensionOf(name: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

const MIME_LABELS: Record<string, string> = {
  'application/pdf': 'PDF',
  'application/zip': 'ZIP',
  'application/json': 'JSON',
  'text/plain': 'TXT',
  'text/csv': 'CSV',
  'text/markdown': 'MD',
};

/** The chip's short type: the extension upper-cased, else a known mime label, else the mime subtype, else `FILE`. */
export function typeLabel(mime: string, name: string): string {
  const ext = extensionOf(name);
  if (ext) return ext.toUpperCase();
  const m = mime.toLowerCase();
  const known = MIME_LABELS[m];
  if (known) return known;
  const sub = (m.split('/')[1] ?? '').split(/[+;]/)[0] ?? '';
  return sub && sub.length <= 8 ? sub.toUpperCase() : 'FILE';
}

export type FileKind = 'pdf' | 'image' | 'audio' | 'video' | 'archive' | 'sheet' | 'slides' | 'doc' | 'code' | 'text' | 'other';

const EXT_KIND: Record<string, FileKind> = {
  pdf: 'pdf',
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  tar: 'archive',
  gz: 'archive',
  tgz: 'archive',
  xz: 'archive',
  xls: 'sheet',
  xlsx: 'sheet',
  csv: 'sheet',
  ods: 'sheet',
  ppt: 'slides',
  pptx: 'slides',
  odp: 'slides',
  doc: 'doc',
  docx: 'doc',
  odt: 'doc',
  rtf: 'doc',
  js: 'code',
  ts: 'code',
  tsx: 'code',
  jsx: 'code',
  py: 'code',
  go: 'code',
  rs: 'code',
  java: 'code',
  c: 'code',
  cpp: 'code',
  h: 'code',
  sh: 'code',
  sql: 'code',
  json: 'code',
  yaml: 'code',
  yml: 'code',
  toml: 'code',
  html: 'code',
  css: 'code',
  txt: 'text',
  md: 'text',
  log: 'text',
};

/** Which icon a chip shows: by extension first (mimes are often generic), then by mime family. */
export function fileKind(mime: string, name: string): FileKind {
  const ext = extensionOf(name);
  const byExt = ext ? EXT_KIND[ext] : undefined;
  if (byExt) return byExt;
  const m = mime.toLowerCase();
  if (m === 'application/pdf') return 'pdf';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('text/')) return 'text';
  return 'other';
}

/** Structural: the wire `Note` (Phase 4 types `files` as optional on the web) and test fixtures fit. */
export type Attachable = {
  images: ReadonlyArray<{ available: boolean }>;
  files?: ReadonlyArray<{ available: boolean }>;
};

/** The empty-note rule's "has something besides text": any live image or any live file (local or not). */
export function hasAttachments(note: Attachable): boolean {
  return note.images.length > 0 || (note.files?.length ?? 0) > 0;
}

/**
 * The note-level "Show in Explorer" can do something here. Mirrors Phase 4's `POST /api/notes/:id/reveal`:
 * a note with live files opens its files folder (so some file must be on this machine); a note with no
 * files selects its first image (so some image must be local); a note with neither is 404 `not_found`.
 */
export function noteRevealable(note: Attachable): boolean {
  const files = note.files ?? [];
  if (files.length > 0) return files.some((f) => f.available);
  return note.images.some((i) => i.available);
}
