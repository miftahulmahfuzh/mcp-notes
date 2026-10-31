import { describe, expect, it } from 'vitest';
import { segmentLinks } from './links';
import { segmentChat, wallNoteId, type ChatSegmentOptions } from './chatSegments';

const known =
  (...list: string[]) =>
  (id: string) =>
    list.includes(id);

function ids(text: string, opts: ChatSegmentOptions = {}): string[] {
  return segmentChat(text, opts).flatMap((s) => (s.kind === 'note' ? [s.id] : []));
}

describe('segmentChat: plain ids', () => {
  it('splits text around canonical ids', () => {
    expect(segmentChat('See A-B32, then C-D45.')).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'note', text: 'A-B32', id: 'A-B32' },
      { kind: 'text', text: ', then ' },
      { kind: 'note', text: 'C-D45', id: 'C-D45' },
      { kind: 'text', text: '.' },
    ]);
  });
  it('links a known id in any case, showing it as written', () => {
    expect(segmentChat('look at a-b32 now', { isKnown: known('A-B32') })).toEqual([
      { kind: 'text', text: 'look at ' },
      { kind: 'note', text: 'a-b32', id: 'A-B32' },
      { kind: 'text', text: ' now' },
    ]);
  });
  it('leaves unknown lower- or mixed-case words alone', () => {
    expect(ids('an x-ray, a T-shirt, e-Bay and a-b32', { isKnown: known('C-D45') })).toEqual([]);
  });
  it('links an unknown id written canonically (it may be past the page or in the bin)', () => {
    expect(ids('no note Z-Z99 here')).toEqual(['Z-Z99']);
  });
  it('needs the dash: no dashless ids, no years', () => {
    expect(ids('AB32, ab32, 2024 and 1-2-3', { isKnown: known('A-B32') })).toEqual([]);
  });
  it('does not link inside longer tokens', () => {
    expect(ids('AA-B32 A-B321 A-B32-C x-A-B32 A-B32x')).toEqual([]);
  });
  it('does not link code-ish tokens', () => {
    expect(ids('foo_A-B32 images/A-B32 a\\A-B32 A-B32.png user@A-B32 #A-B32 ?note=A-B32 [image upload:A-B32] A-B32_x A-B32/x')).toEqual([]);
  });
  it('links ids next to ordinary punctuation', () => {
    expect(ids('(A-B32) "C-D45" E-F56. K-F07: G-H19; [Q-R88] \'M-N11\'')).toEqual(['A-B32', 'C-D45', 'E-F56', 'K-F07', 'G-H19', 'Q-R88', 'M-N11']);
  });
  it('returns no segments for empty text, and segmentLinks output when there is no id', () => {
    expect(segmentChat('')).toEqual([]);
    const s = 'Read [x](https://a.com/y) and https://b.com, done.';
    expect(segmentChat(s)).toEqual(segmentLinks(s));
  });
});

describe('segmentChat: links', () => {
  it('keeps ids inside URLs and link targets part of the link', () => {
    expect(segmentChat('see https://example.com/notes/A-B32 and [x](https://e.com/?id=C-D45)')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'https://example.com/notes/A-B32', href: 'https://example.com/notes/A-B32' },
      { kind: 'text', text: ' and ' },
      { kind: 'link', text: 'x', href: 'https://e.com/?id=C-D45' },
    ]);
  });
  it('keeps an id that labels an external link part of that link', () => {
    expect(segmentChat('[A-B32](https://example.com/a)')).toEqual([{ kind: 'link', text: 'A-B32', href: 'https://example.com/a' }]);
  });
  it('turns markdown links to the wall into note links, keeping the label', () => {
    expect(segmentChat('[A-B32](http://localhost:7317/?note=A-B32) and [that one](http://127.0.0.1:9000/?note=c-d45)')).toEqual([
      { kind: 'note', text: 'A-B32', id: 'A-B32' },
      { kind: 'text', text: ' and ' },
      { kind: 'note', text: 'that one', id: 'C-D45' },
    ]);
  });
  it('turns a bare wall URL into a note link; trailing punctuation stays outside', () => {
    expect(segmentChat('open http://localhost:7317/?note=A-B32.')).toEqual([
      { kind: 'text', text: 'open ' },
      { kind: 'note', text: 'http://localhost:7317/?note=A-B32', id: 'A-B32' },
      { kind: 'text', text: '.' },
    ]);
  });
  it('leaves other wall URLs as links', () => {
    expect(segmentChat('http://localhost:7317/history')).toEqual([{ kind: 'link', text: 'http://localhost:7317/history', href: 'http://localhost:7317/history' }]);
    expect(segmentChat('http://localhost:7317/?note=hello')).toEqual([{ kind: 'link', text: 'http://localhost:7317/?note=hello', href: 'http://localhost:7317/?note=hello' }]);
  });
});

describe('wallNoteId', () => {
  it('reads ?note= and #id on loopback hosts and on this page host only, path / only', () => {
    expect(wallNoteId('http://localhost:9000/#a-b32')).toBe('A-B32');
    expect(wallNoteId('http://[::1]:7317/?note=ab32')).toBe('A-B32');
    expect(wallNoteId('http://wall.lan/?note=A-B32', 'wall.lan')).toBe('A-B32');
    expect(wallNoteId('https://example.com/?note=A-B32', 'wall.lan')).toBeNull();
    expect(wallNoteId('http://localhost:7317/full/A-B32')).toBeNull();
    expect(wallNoteId('not a url')).toBeNull();
  });
});

describe('segmentChat: code spans', () => {
  it('never links inside code spans of any fence length', () => {
    expect(ids('`A-B32` and ``x `C-D45` y`` but E-F56')).toEqual(['E-F56']);
  });
  it('once done, a stray backtick is literal', () => {
    expect(ids('a ` stray then A-B32')).toEqual(['A-B32']);
    expect(ids('see `A-B32 and C-D45 ')).toEqual(['A-B32', 'C-D45']);
  });
  it('while streaming, an open span links nothing after it', () => {
    expect(ids('see `A-B32 and C-D45 ', { streaming: true })).toEqual([]);
    expect(ids('E-F56 then `A-B32 and', { streaming: true })).toEqual(['E-F56']);
  });
});

describe('segmentChat: streaming', () => {
  it('never shows a half id or an id that may still grow', () => {
    expect(segmentChat('see A-B3', { streaming: true })).toEqual([{ kind: 'text', text: 'see A-B3' }]);
    expect(segmentChat('see A-B32', { streaming: true })).toEqual([{ kind: 'text', text: 'see A-B32' }]);
    expect(ids('see A-B32 ', { streaming: true })).toEqual(['A-B32']);
    expect(ids('see A-B32.', { streaming: true })).toEqual(['A-B32']);
    expect(ids('see A-B32')).toEqual(['A-B32']);
  });
  it('an unfinished wall link shows its label only, unlinked, until it completes', () => {
    expect(segmentChat('[A-B32](http://localhost:7317/?no', { streaming: true })).toEqual([{ kind: 'text', text: 'A-B32' }]);
    expect(segmentChat('[A-B32](http://localhost:7317/?note=A-B32)', { streaming: true })).toEqual([{ kind: 'note', text: 'A-B32', id: 'A-B32' }]);
  });
});
