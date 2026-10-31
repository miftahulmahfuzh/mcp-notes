import { describe, expect, it } from 'vitest';
import {
  displayFileName,
  FALLBACK_FILE_NAME,
  isSafeFileName,
  MAX_FILE_NAME_BYTES,
  MAX_FILE_NAME_CHARS,
  sanitizeFileName,
  withNameSuffix,
} from '../../src/files/name.js';

describe('sanitizeFileName', () => {
  it('keeps an ordinary name', () => {
    expect(sanitizeFileName('report.pdf')).toBe('report.pdf');
    expect(sanitizeFileName('Laporan Keuangan Q3 (final).xlsx')).toBe('Laporan Keuangan Q3 (final).xlsx');
  });

  it('keeps only the basename, whatever the separator', () => {
    expect(sanitizeFileName('/home/u/docs/report.pdf')).toBe('report.pdf');
    expect(sanitizeFileName('C:\\Users\\me\\report.pdf')).toBe('report.pdf');
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
  });

  it('replaces Windows-forbidden characters and drops control characters', () => {
    expect(sanitizeFileName('a:b*c?d"e<f>g|h.txt')).toBe('a_b_c_d_e_f_g_h.txt');
    expect(sanitizeFileName('tab\there\u0000\u0085.txt')).toBe('tabhere.txt');
  });

  it('removes surrounding spaces and trailing dots', () => {
    expect(sanitizeFileName('  notes.txt  ')).toBe('notes.txt');
    expect(sanitizeFileName('trailing. . ')).toBe('trailing');
  });

  it('prefixes Windows reserved device names, with or without an extension', () => {
    expect(sanitizeFileName('CON')).toBe('_CON');
    expect(sanitizeFileName('con.txt')).toBe('_con.txt');
    expect(sanitizeFileName('LPT1.log')).toBe('_LPT1.log');
    expect(sanitizeFileName('nul.tar.gz')).toBe('_nul.tar.gz');
    expect(sanitizeFileName('console.txt')).toBe('console.txt');
    expect(sanitizeFileName('com10.txt')).toBe('com10.txt');
  });

  it('falls back when nothing usable is left', () => {
    for (const raw of ['', '   ', '..', '.', null, undefined, '/', '\u0001']) {
      expect(sanitizeFileName(raw)).toBe(FALLBACK_FILE_NAME);
    }
  });

  it('keeps dotfiles', () => {
    expect(sanitizeFileName('.env')).toBe('.env');
  });

  it('normalises to NFC', () => {
    expect(sanitizeFileName('e\u0301.txt')).toBe('\u00e9.txt');
  });

  it('cuts long names to 120 code points and keeps the extension', () => {
    const name = sanitizeFileName(`${'a'.repeat(300)}.pdf`);
    expect(Array.from(name)).toHaveLength(MAX_FILE_NAME_CHARS);
    expect(name.endsWith('.pdf')).toBe(true);
  });

  it('cuts multi-byte names by bytes too, never splitting a character', () => {
    const name = sanitizeFileName(`${'\u{1F600}'.repeat(100)}.txt`);
    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
    expect(name.endsWith('.txt')).toBe(true);
    // A lone surrogate (a split emoji) makes encodeURIComponent throw.
    expect(() => encodeURIComponent(name)).not.toThrow();
  });

  it('treats an over-long extension as part of the stem', () => {
    const name = sanitizeFileName(`x.${'y'.repeat(200)}`);
    expect(Array.from(name)).toHaveLength(MAX_FILE_NAME_CHARS);
    expect(name.startsWith('x.')).toBe(true);
  });

  it('is always a safe single segment', () => {
    for (const raw of ['a/b', 'a\\b', 'CON', '..', 'x'.repeat(500), 'a:b', '\u0000']) {
      expect(isSafeFileName(sanitizeFileName(raw))).toBe(true);
    }
  });
});

describe('withNameSuffix', () => {
  it('numbers clashes before the extension', () => {
    expect(withNameSuffix('notes.txt', 1)).toBe('notes.txt');
    expect(withNameSuffix('notes.txt', 2)).toBe('notes (2).txt');
    expect(withNameSuffix('archive.tar.gz', 3)).toBe('archive.tar (3).gz');
    expect(withNameSuffix('.env', 2)).toBe('.env (2)');
    expect(withNameSuffix('README', 12)).toBe('README (12)');
  });
});

describe('displayFileName', () => {
  it('keeps the user name (minus control characters), else the safe name', () => {
    expect(displayFileName('C:\\x\\re:port?.txt', 're_port_.txt')).toBe('re:port?.txt');
    expect(displayFileName('a\u0000b.txt', 'ab.txt')).toBe('ab.txt');
    expect(displayFileName('', 'file')).toBe('file');
    expect(displayFileName(null, 'file')).toBe('file');
  });
});

describe('isSafeFileName', () => {
  it('refuses separators, dot names, forbidden and control characters', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a:b', 'a\u0000b', 'x'.repeat(256)]) {
      expect(isSafeFileName(bad)).toBe(false);
    }
    expect(isSafeFileName('notes (2).txt')).toBe(true);
  });
});
