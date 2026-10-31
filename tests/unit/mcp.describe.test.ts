import { describe, expect, it } from 'vitest';
import { describeImage, describeNote, filesLine } from '../../src/mcp/imageTools.js';
import type { Note, NoteFile, NoteImage } from '../../src/notes/types.js';

function file(over: Partial<NoteFile> = {}): NoteFile {
  return {
    id: 'F-1L3',
    note_id: 'A-B32',
    position: 0,
    name: 'report.pdf',
    mime: 'application/pdf',
    bytes: 1258291,
    host: 'lenovo',
    available: true,
    extraction_status: 'none',
    urls: { download: '/api/files/F-1L3/download' },
    ...over,
  };
}

const image: NoteImage = {
  id: 'A-B32',
  note_id: 'A-B32',
  position: 0,
  mime: 'image/png',
  width: 10,
  height: 20,
  bytes: 2048,
  taken_at: null,
  original_name: null,
  host: 'lenovo',
  available: true,
  urls: { thumb: '', display: '', original: '', preview: '' },
};

function note(files: NoteFile[]): Note {
  return {
    id: 'A-B32',
    body: 'quarterly #finance',
    tags: ['finance'],
    created_at: '2026-10-31T00:00:00.000Z',
    updated_at: '2026-10-31T00:00:00.000Z',
    origin: null,
    images: [image],
    files,
  };
}

describe('files in MCP text', () => {
  it('lists every file as name (mime, size), before the body', () => {
    const n = note([file(), file({ id: 'G-2M4', name: 'notes.txt', mime: 'text/plain', bytes: 3000 })]);
    expect(filesLine(n)).toBe('files: report.pdf (application/pdf, 1.2 MB); notes.txt (text/plain, 3 KB)');
    const text = describeNote(n).split('\n');
    expect(text.indexOf('files: report.pdf (application/pdf, 1.2 MB); notes.txt (text/plain, 3 KB)')).toBe(text.length - 2);
    expect(describeImage(n, image, 1, 1)).toContain('files: report.pdf (application/pdf, 1.2 MB)');
  });

  it('adds no line for a note without files', () => {
    expect(filesLine(note([]))).toBeNull();
    expect(describeNote(note([]))).not.toContain('files:');
  });
});
