import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectFileMime, FALLBACK_MIME, isValidMime } from '../../src/files/mime.js';
import { fileRelPath, filesDirFor, isNoteFileRelPath, removeNoteFile, removeNoteFolderIfEmpty } from '../../src/files/store.js';
import { attachmentDisposition, DOWNLOAD_CSP } from '../../src/http/files.js';

let dataDir: string;
beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'notes-files-unit-'));
});
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('file paths', () => {
  it('builds files/<noteId>/<name> only for a canonical id and a safe name', () => {
    expect(fileRelPath('A-B32', 'notes.txt')).toBe('files/A-B32/notes.txt');
    expect(fileRelPath('A-B32', 'notes (2).txt')).toBe('files/A-B32/notes (2).txt');
    expect(() => fileRelPath('ab32', 'notes.txt')).toThrow();
    expect(() => fileRelPath('../x', 'notes.txt')).toThrow();
    expect(() => fileRelPath('A-B32', '../notes.txt')).toThrow();
    expect(() => fileRelPath('A-B32', '..')).toThrow();
    expect(() => fileRelPath('A-B32', 'a:b')).toThrow();
  });

  it('recognises only one safe segment inside the note folder', () => {
    expect(isNoteFileRelPath('A-B32', 'files/A-B32/notes.txt')).toBe(true);
    expect(isNoteFileRelPath('A-B32', 'files/C-D45/notes.txt')).toBe(false);
    expect(isNoteFileRelPath('A-B32', 'files/A-B32/../C-D45/x.txt')).toBe(false);
    expect(isNoteFileRelPath('A-B32', 'files/A-B32/sub/x.txt')).toBe(false);
    expect(isNoteFileRelPath('A-B32', 'images/2026/10/A-B32.png')).toBe(false);
  });

  it('resolves the note folder inside the data dir', () => {
    expect(filesDirFor(dataDir, 'A-B32')).toBe(path.join(path.resolve(dataDir), 'files', 'A-B32'));
    expect(() => filesDirFor(dataDir, '..')).toThrow();
  });
});

describe('removeNoteFile / removeNoteFolderIfEmpty', () => {
  it('removes a named file of the note, then the empty folder', async () => {
    const dir = path.join(dataDir, 'files', 'A-B32');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'a.txt'), 'a');
    expect(await removeNoteFile(dataDir, 'A-B32', 'files/A-B32/a.txt')).toBe(1);
    expect(await removeNoteFile(dataDir, 'A-B32', 'files/A-B32/a.txt')).toBe(0);
    expect(await removeNoteFolderIfEmpty(dataDir, 'A-B32')).toBe(true);
    expect(await removeNoteFolderIfEmpty(dataDir, 'A-B32')).toBe(false);
  });

  it('refuses paths of another note, outside the folder, and directories', async () => {
    const dir = path.join(dataDir, 'files', 'C-D45');
    await mkdir(path.join(dir, 'sub'), { recursive: true });
    await writeFile(path.join(dir, 'keep.txt'), 'k');
    expect(await removeNoteFile(dataDir, 'A-B32', 'files/C-D45/keep.txt')).toBe(0);
    expect(await removeNoteFile(dataDir, 'C-D45', 'files/C-D45/../C-D45/keep.txt')).toBe(0);
    expect(await removeNoteFile(dataDir, 'C-D45', 'files/C-D45/sub')).toBe(0);
    expect(await removeNoteFolderIfEmpty(dataDir, 'C-D45')).toBe(false);
    expect((await readdir(dir)).sort()).toEqual(['keep.txt', 'sub']);
  });

  it('removes a symlink without following it', async () => {
    const dir = path.join(dataDir, 'files', 'E-F67');
    await mkdir(dir, { recursive: true });
    const outside = path.join(dataDir, 'outside.txt');
    await writeFile(outside, 'o');
    await symlink(outside, path.join(dir, 'link.txt'));
    expect(await removeNoteFile(dataDir, 'E-F67', 'files/E-F67/link.txt')).toBe(1);
    expect(await readdir(dataDir)).toContain('outside.txt');
  });
});

describe('detectFileMime', () => {
  it('prefers magic bytes, then the extension, else octet-stream', async () => {
    expect(await detectFileMime(Buffer.from('%PDF-1.4\n%fake\n'), 'whatever.bin')).toBe('application/pdf');
    expect(await detectFileMime(Buffer.from('hello'), 'notes.txt')).toBe('text/plain');
    expect(await detectFileMime(Buffer.from('a,b\n1,2\n'), 'DATA.CSV')).toBe('text/csv');
    expect(await detectFileMime(Buffer.from('not really a png'), 'fake.png')).toBe(FALLBACK_MIME);
    expect(await detectFileMime(Buffer.from('???'), 'noext')).toBe(FALLBACK_MIME);
  });

  it('validates header-safe mime strings', () => {
    expect(isValidMime('application/pdf')).toBe(true);
    expect(isValidMime('text/plain; charset=utf-8')).toBe(false);
    expect(isValidMime('text/html\r\nX: y')).toBe(false);
  });
});

describe('download headers', () => {
  it('is always an attachment with an ASCII fallback and an RFC 5987 name', () => {
    expect(attachmentDisposition('report.pdf')).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
    expect(attachmentDisposition('résumé "final" (v2)*.pdf')).toBe(
      `attachment; filename="r_sum_ _final_ (v2)*.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22%20%28v2%29%2A.pdf`,
    );
    expect(attachmentDisposition('a\r\nb.txt')).toBe(`attachment; filename="a__b.txt"; filename*=UTF-8''a%0D%0Ab.txt`);
  });

  it('sandboxes downloads', () => {
    expect(DOWNLOAD_CSP).toContain('sandbox');
    expect(DOWNLOAD_CSP).toContain("default-src 'none'");
  });
});
