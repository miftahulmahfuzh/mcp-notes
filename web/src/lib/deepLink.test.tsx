import { describe, expect, it } from 'vitest';
import { deepLinkFromLocation, normalizeNoteId, parseDeepLink } from './deepLink';

describe('normalizeNoteId', () => {
  it.each([
    ['A-B32', 'A-B32'],
    ['a-b32', 'A-B32'],
    ['ab32', 'A-B32'],
    ['AB32', 'A-B32'],
    [' a-b32 ', 'A-B32'],
    ['0-000', '0-000'],
    ['z9zz', 'Z-9ZZ'],
  ])('%j -> %s', (input, out) => {
    expect(normalizeNoteId(input)).toBe(out);
  });

  it.each(['', 'A', 'A-B3', 'A-B323', 'AB-32', 'A--B32', 'A_B32', 'Ä-B32', 'A-B32x', 'top', '/full/A-B32'])('%j -> null', (input) => {
    expect(normalizeNoteId(input)).toBeNull();
  });
});

describe('parseDeepLink', () => {
  it.each([
    ['?note=a-b32', '', 'A-B32'],
    ['?note=FZH5', '', 'F-ZH5'],
    ['?x=1&note=%20c-d45', '', 'C-D45'],
    ['', '#F-ZH5', 'F-ZH5'],
    ['', '#fzh5', 'F-ZH5'],
    ['', '#a%2Db32', 'A-B32'],
    ['?note=A-B32', '#C-D45', 'C-D45'],
    ['?note=A-B32', '#top', 'A-B32'],
  ])('search %j, hash %j -> %s', (search, hash, out) => {
    expect(parseDeepLink(search, hash)).toBe(out);
  });

  it.each([
    ['', ''],
    ['', '#'],
    ['?note=', ''],
    ['?note=hello', ''],
    ['?id=A-B32', ''],
    ['', '#%E0%A4%A'],
    ['?note=hello', '#welcome'],
  ])('search %j, hash %j -> null', (search, hash) => {
    expect(parseDeepLink(search, hash)).toBeNull();
  });

  it('reads a Location-like object', () => {
    expect(deepLinkFromLocation({ search: '?note=k-f07', hash: '' })).toBe('K-F07');
  });
});
