import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';

/** Stored when neither the bytes nor the extension say what a file is. */
export const FALLBACK_MIME = 'application/octet-stream';

/**
 * Extension fallback for text-like formats magic bytes cannot identify. Raster image extensions
 * are deliberately absent: bytes that really are a supported image never reach the file store
 * (they are stored as images), so a `.png` that lands here is not a PNG.
 */
export const EXTENSION_MIMES: Readonly<Record<string, string>> = {
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  jsonl: 'application/x-ndjson',
  ndjson: 'application/x-ndjson',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  ini: 'text/plain',
  conf: 'text/plain',
  env: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'text/plain',
  tsx: 'text/plain',
  py: 'text/x-python',
  go: 'text/plain',
  rs: 'text/plain',
  java: 'text/plain',
  c: 'text/plain',
  h: 'text/plain',
  cpp: 'text/plain',
  sh: 'application/x-sh',
  sql: 'application/sql',
  svg: 'image/svg+xml',
  ics: 'text/calendar',
  vcf: 'text/vcard',
  rtf: 'application/rtf',
  srt: 'text/plain',
  vtt: 'text/vtt',
};

const MIME_SHAPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

/** True for a bare `type/subtype` safe to put in a Content-Type header. */
export function isValidMime(mime: string): boolean {
  return MIME_SHAPE.test(mime);
}

/** Magic bytes first (file-type), then the name's extension, else FALLBACK_MIME. */
export async function detectFileMime(bytes: Uint8Array, name: string): Promise<string> {
  const sniffed = await fileTypeFromBuffer(bytes);
  if (sniffed !== undefined && isValidMime(sniffed.mime)) return sniffed.mime;
  const ext = path.extname(name).slice(1).toLowerCase();
  return EXTENSION_MIMES[ext] ?? FALLBACK_MIME;
}
