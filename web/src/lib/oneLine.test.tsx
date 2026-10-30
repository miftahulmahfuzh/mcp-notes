import { describe, expect, it } from 'vitest';
import { oneLine } from './oneLine';

describe('oneLine', () => {
  it('leaves a single-line query unchanged', () => {
    expect(oneLine('cari notes yang membahas fitur')).toBe('cari notes yang membahas fitur');
  });

  it('turns each run of newlines into one space', () => {
    expect(oneLine('cari notes\nyang membahas\n\nfitur')).toBe('cari notes yang membahas fitur');
  });

  it('handles CRLF and CR line breaks and the spaces around them', () => {
    expect(oneLine('one  \r\n\r\n  two\rthree')).toBe('one two three');
  });

  it('trims leading and trailing breaks', () => {
    expect(oneLine('\n\nhello\n')).toBe('hello');
  });

  it('keeps inner spacing within a line', () => {
    expect(oneLine('a  b\nc')).toBe('a  b c');
  });
});
