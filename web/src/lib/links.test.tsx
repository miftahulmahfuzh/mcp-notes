import { describe, expect, it } from 'vitest';
import { segmentLinks } from './links';

describe('segmentLinks: markdown links', () => {
  it('turns [label](https://...) into a link showing the label', () => {
    expect(segmentLinks('Read the [BookBrowse summary](https://www.bookbrowse.com/x?id=1) for more.')).toEqual([
      { kind: 'text', text: 'Read the ' },
      { kind: 'link', text: 'BookBrowse summary', href: 'https://www.bookbrowse.com/x?id=1' },
      { kind: 'text', text: ' for more.' },
    ]);
  });
  it('accepts http and keeps balanced parentheses inside the URL', () => {
    expect(segmentLinks('[Foo](http://en.wikipedia.org/wiki/Foo_(bar))')).toEqual([
      { kind: 'link', text: 'Foo', href: 'http://en.wikipedia.org/wiki/Foo_(bar)' },
    ]);
  });
  it('shows the URL when the label is empty', () => {
    expect(segmentLinks('[](https://a.com)')).toEqual([{ kind: 'link', text: 'https://a.com', href: 'https://a.com' }]);
  });
  it('leaves non-http schemes as plain text', () => {
    const s = '[x](javascript:alert(1)) and javascript:alert(1), ftp://x.com, mailto:a@b.c';
    expect(segmentLinks(s)).toEqual([{ kind: 'text', text: s }]);
  });
  it('leaves brackets that are not links alone', () => {
    expect(segmentLinks('a [1] b and range [0, 5) ok')).toEqual([{ kind: 'text', text: 'a [1] b and range [0, 5) ok' }]);
  });
});

describe('segmentLinks: bare URLs', () => {
  it('links bare URLs and leaves trailing punctuation outside', () => {
    expect(segmentLinks('See https://example.com/a, then https://example.com/b.')).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'link', text: 'https://example.com/a', href: 'https://example.com/a' },
      { kind: 'text', text: ', then ' },
      { kind: 'link', text: 'https://example.com/b', href: 'https://example.com/b' },
      { kind: 'text', text: '.' },
    ]);
  });
  it.each([';', ':', '!', '?'])('drops a trailing %s', (p) => {
    expect(segmentLinks(`go https://a.com/x${p}`)).toEqual([
      { kind: 'text', text: 'go ' },
      { kind: 'link', text: 'https://a.com/x', href: 'https://a.com/x' },
      { kind: 'text', text: p },
    ]);
  });
  it('drops an unbalanced closing parenthesis but keeps a balanced one', () => {
    expect(segmentLinks('(see https://example.com/c)')).toEqual([
      { kind: 'text', text: '(see ' },
      { kind: 'link', text: 'https://example.com/c', href: 'https://example.com/c' },
      { kind: 'text', text: ')' },
    ]);
    expect(segmentLinks('https://en.wikipedia.org/wiki/Foo_(bar).')).toEqual([
      { kind: 'link', text: 'https://en.wikipedia.org/wiki/Foo_(bar)', href: 'https://en.wikipedia.org/wiki/Foo_(bar)' },
      { kind: 'text', text: '.' },
    ]);
  });
  it('does not link a scheme with no host', () => {
    expect(segmentLinks('https:// alone and https://')).toEqual([{ kind: 'text', text: 'https:// alone and https://' }]);
  });
  it('returns no segments for empty text', () => {
    expect(segmentLinks('')).toEqual([]);
  });
});

describe('segmentLinks: streaming', () => {
  it.each([
    ['Read the [BookBrowse summ', 'Read the BookBrowse summ'],
    ['Read the [x]', 'Read the x'],
    ['Read the [x](https://bo', 'Read the x'],
    ['Read the [x](https://w/Foo_(ba', 'Read the x'],
  ])('renders the unfinished link %j as its label only', (input, shown) => {
    expect(segmentLinks(input, { streaming: true })).toEqual([{ kind: 'text', text: shown }]);
  });
  it('still links the complete links before the unfinished one', () => {
    expect(segmentLinks('[a](https://a.com) and [b', { streaming: true })).toEqual([
      { kind: 'link', text: 'a', href: 'https://a.com' },
      { kind: 'text', text: ' and b' },
    ]);
  });
  it('once done, a lone [ is literal text and a truncated link to http(s) is a link', () => {
    expect(segmentLinks('Read the [x')).toEqual([{ kind: 'text', text: 'Read the [x' }]);
    expect(segmentLinks('Read the [x](https://bo')).toEqual([
      { kind: 'text', text: 'Read the ' },
      { kind: 'link', text: 'x', href: 'https://bo' },
    ]);
    expect(segmentLinks('Read the [x](javascr')).toEqual([{ kind: 'text', text: 'Read the x' }]);
  });
});
