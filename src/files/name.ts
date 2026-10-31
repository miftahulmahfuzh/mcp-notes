import path from 'node:path';

/** Longest stored file name, in code points (the extension is kept when cutting). */
export const MAX_FILE_NAME_CHARS = 120;
/** And in UTF-8 bytes, so a suffix like " (12)" still fits the 255-byte limit of ext4 and NTFS. */
export const MAX_FILE_NAME_BYTES = 240;
/** Used when nothing usable is left of the user's name. */
export const FALLBACK_FILE_NAME = 'file';

/** Longest extension (with its dot) kept apart from the stem; anything longer is part of the stem. */
const MAX_EXT_CHARS = 17;
/** Longest display name kept, in code points. */
const MAX_DISPLAY_CHARS = 255;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const WINDOWS_FORBIDDEN = /[\/\\:*?"<>|]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i;
const UNSAFE = /[\u0000-\u001f\u007f\/\\:*?"<>|]/;

function codePoints(s: string): string[] {
  return Array.from(s);
}

function fits(name: string): boolean {
  return codePoints(name).length <= MAX_FILE_NAME_CHARS && Buffer.byteLength(name, 'utf8') <= MAX_FILE_NAME_BYTES;
}

/** The last segment of a path, whichever separator the client used. */
function baseName(raw: string | null | undefined): string {
  return (raw ?? '').split(/[\\/]/).pop() ?? '';
}

/** `{stem, ext}` with `ext` including its dot; `.env` and over-long extensions have no ext. */
function splitExt(name: string): { stem: string; ext: string } {
  const ext = path.posix.extname(name);
  if (ext === '' || ext.length > MAX_EXT_CHARS) return { stem: name, ext: '' };
  return { stem: name.slice(0, name.length - ext.length), ext };
}

/** Cuts `stem` by code points until `stem + ext` fits; an emptied stem becomes FALLBACK_FILE_NAME. */
function cut(stem: string, ext: string): string {
  const chars = codePoints(stem);
  while (chars.length > 0 && !fits(chars.join('') + ext)) chars.pop();
  const kept = chars.join('').replace(/[. ]+$/, '');
  return (kept === '' ? FALLBACK_FILE_NAME : kept) + ext;
}

/**
 * The name a file is stored under in `files/<noteId>/`: the basename only, NFC, control
 * characters dropped, Windows-forbidden characters (`/\:*?"<>|`) replaced by `_`, surrounding
 * spaces and trailing dots/spaces removed (Windows drops them), a Windows reserved device name
 * (CON, PRN, AUX, NUL, COM1-9, LPT1-9, with or without an extension) prefixed with `_`, and at
 * most MAX_FILE_NAME_CHARS code points / MAX_FILE_NAME_BYTES bytes with the extension kept.
 * Never empty, never `.` or `..`, never contains a separator.
 */
export function sanitizeFileName(raw: string | null | undefined): string {
  let name = baseName(raw)
    .normalize('NFC')
    .replace(CONTROL, '')
    .replace(WINDOWS_FORBIDDEN, '_')
    .trim()
    .replace(/[. ]+$/, '');
  if (name === '') name = FALLBACK_FILE_NAME;
  const firstSegment = name.split('.')[0]?.trim() ?? '';
  if (WINDOWS_RESERVED.test(firstSegment)) name = `_${name}`;
  if (!fits(name)) {
    const { stem, ext } = splitExt(name);
    name = cut(stem, ext);
  }
  return name;
}

/**
 * The name shown to people and put in Content-Disposition: the user's basename, NFC, control
 * characters removed, at most 255 code points. Falls back to the stored safe name.
 */
export function displayFileName(raw: string | null | undefined, safeName: string): string {
  const clean = baseName(raw).normalize('NFC').replace(CONTROL, '').trim();
  const kept = codePoints(clean).slice(0, MAX_DISPLAY_CHARS).join('');
  return kept === '' ? safeName : kept;
}

/** The k-th candidate for a name: k <= 1 is the name itself, then `stem (k).ext` (`notes (2).txt`). */
export function withNameSuffix(name: string, k: number): string {
  if (k <= 1) return name;
  const { stem, ext } = splitExt(name);
  return `${stem} (${k})${ext}`;
}

/** True for a single, Windows-safe path segment (what sanitizeFileName and withNameSuffix produce). */
export function isSafeFileName(name: string): boolean {
  if (name === '' || name === '.' || name === '..') return false;
  if (UNSAFE.test(name)) return false;
  return Buffer.byteLength(name, 'utf8') <= 255;
}
