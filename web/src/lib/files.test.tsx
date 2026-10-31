// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { extensionOf, fileKind, formatBytes, hasAttachments, noteRevealable, pastedFiles, routeFiles, typeLabel } from './files';

const png = new File(['p'], 'shot.png', { type: 'image/png' });
const heic = new File(['h'], 'IMG_1.HEIC', { type: 'image/heic' });
const svg = new File(['s'], 'logo.svg', { type: 'image/svg+xml' });
const pdf = new File(['%PDF'], 'contract.pdf', { type: 'application/pdf' });
const untyped = new File(['?'], 'IMG_2.heic', { type: '' });
const txt = new File(['t'], 'a.txt', { type: 'text/plain' });

describe('routeFiles', () => {
  it('keeps order; supported images take the image path, everything else is a file', () => {
    expect(routeFiles([pdf, png, svg, heic, untyped, txt]).map((r) => [r.kind, r.file.name])).toEqual([
      ['file', 'contract.pdf'],
      ['image', 'shot.png'],
      ['file', 'logo.svg'],
      ['image', 'IMG_1.HEIC'],
      ['file', 'IMG_2.heic'],
      ['file', 'a.txt'],
    ]);
  });
  it('is empty for nothing', () => {
    expect(routeFiles(null)).toEqual([]);
    expect(routeFiles(undefined)).toEqual([]);
    expect(routeFiles([])).toEqual([]);
  });
});

describe('pastedFiles', () => {
  it('with a note open, every pasted file attaches', () => {
    expect(pastedFiles([txt, png, pdf], true)).toEqual([txt, png, pdf]);
  });
  it('without a note open, only the first image counts and non-images are ignored', () => {
    expect(pastedFiles([txt, png, heic], false)).toEqual([png]);
    expect(pastedFiles([txt, pdf], false)).toEqual([]);
    expect(pastedFiles(null, false)).toEqual([]);
  });
});

describe('formatBytes', () => {
  it('formats B, KB, MB, GB with one decimal under 10', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(10 * 1024)).toBe('10 KB');
    expect(formatBytes(1048000)).toBe('1023 KB');
    expect(formatBytes(1048575)).toBe('1 MB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3 GB');
  });
  it('is empty for nonsense', () => {
    expect(formatBytes(-1)).toBe('');
    expect(formatBytes(Number.NaN)).toBe('');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('');
  });
});

describe('typeLabel / extensionOf / fileKind', () => {
  it('labels by extension, then known mime, then subtype, then FILE', () => {
    expect(extensionOf('report.PDF')).toBe('pdf');
    expect(extensionOf('Makefile')).toBe('');
    expect(typeLabel('application/pdf', 'report.PDF')).toBe('PDF');
    expect(typeLabel('application/pdf', 'report')).toBe('PDF');
    expect(typeLabel('audio/mpeg', 'voice')).toBe('MPEG');
    expect(typeLabel('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'x')).toBe('FILE');
    expect(typeLabel('', 'x')).toBe('FILE');
  });
  it('picks an icon kind by extension first, then mime family', () => {
    expect(fileKind('application/octet-stream', 'deck.pptx')).toBe('slides');
    expect(fileKind('application/octet-stream', 'sheet.xlsx')).toBe('sheet');
    expect(fileKind('application/zip', 'bundle.zip')).toBe('archive');
    expect(fileKind('application/pdf', 'scan')).toBe('pdf');
    expect(fileKind('audio/mpeg', 'voice.mp3')).toBe('audio');
    expect(fileKind('video/mp4', 'clip.mp4')).toBe('video');
    expect(fileKind('text/plain', 'notes')).toBe('text');
    expect(fileKind('application/octet-stream', 'blob.bin')).toBe('other');
  });
});

describe('hasAttachments / noteRevealable', () => {
  const local = { available: true };
  const away = { available: false };
  it('counts images and files, local or not, for the empty-note rule', () => {
    expect(hasAttachments({ images: [] })).toBe(false);
    expect(hasAttachments({ images: [], files: [] })).toBe(false);
    expect(hasAttachments({ images: [away] })).toBe(true);
    expect(hasAttachments({ images: [], files: [away] })).toBe(true);
  });
  it('follows the note route: files decide when there are any, else images; neither is never revealable', () => {
    expect(noteRevealable({ images: [], files: [] })).toBe(false);
    expect(noteRevealable({ images: [away], files: [away] })).toBe(false);
    expect(noteRevealable({ images: [local] })).toBe(true);
    expect(noteRevealable({ images: [away], files: [local] })).toBe(true);
    // The route opens the files folder, which is not on this machine: a local image does not help.
    expect(noteRevealable({ images: [local], files: [away] })).toBe(false);
  });
});
