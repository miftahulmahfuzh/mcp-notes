import { describe, expect, it } from 'vitest';
import { CITATION_LOOKAHEAD, CitationFilter, parseLeadingCitation } from '../../src/chat/citation.js';

function run(chunks: string[]) {
  const filter = new CitationFilter();
  const out = chunks.map((chunk) => filter.push(chunk));
  const tail = filter.end();
  return { out, tail, text: filter.text, replyTo: filter.replyTo };
}

describe('parseLeadingCitation', () => {
  it('strips a leading marker and its following whitespace', () => {
    expect(parseLeadingCitation('[msg:k7f2]  Yes, that one.')).toEqual({ replyTo: 'K7F2', text: 'Yes, that one.' });
    expect(parseLeadingCitation('\n [msg:K7F2]Hi')).toEqual({ replyTo: 'K7F2', text: 'Hi' });
  });

  it('leaves text without a leading marker untouched', () => {
    expect(parseLeadingCitation('See [msg:K7F2] too')).toEqual({ replyTo: null, text: 'See [msg:K7F2] too' });
    expect(parseLeadingCitation('[1] first')).toEqual({ replyTo: null, text: '[1] first' });
    expect(parseLeadingCitation('[msg:K7F] short')).toEqual({ replyTo: null, text: '[msg:K7F] short' });
  });
});

describe('CitationFilter (streamed)', () => {
  it('strips a marker split across deltas and never emits any part of it', () => {
    const r = run(['[', 'msg:', 'K7', 'F2] Here', ' it is.']);
    expect(r.out).toEqual(['', '', '', 'Here', ' it is.']);
    expect(r.tail).toBe('');
    expect(r.replyTo).toBe('K7F2');
    expect(r.text).toBe('Here it is.');
  });

  it('releases an answer that does not start with [ immediately', () => {
    const r = run(['Hello', ' world']);
    expect(r.out).toEqual(['Hello', ' world']);
    expect(r.replyTo).toBeNull();
    expect(r.text).toBe('Hello world');
  });

  it('skips whitespace around the marker, also when it arrives in separate deltas', () => {
    const r = run(['  ', '[msg:k7f2]', '  ', '\n', 'Hi']);
    expect(r.out).toEqual(['', '', '', '', 'Hi']);
    expect(r.replyTo).toBe('K7F2');
    expect(r.text).toBe('Hi');
  });

  it('releases a bracket that cannot be a marker as soon as that is clear', () => {
    expect(run(['[1] first']).out).toEqual(['[1] first']);
    const r = run(['[msg:K7', '!']);
    expect(r.out).toEqual(['', '[msg:K7!']);
    expect(r.replyTo).toBeNull();
  });

  it('a marker later in the text is just text', () => {
    const r = run(['See ', '[msg:K7F2] too']);
    expect(r.out).toEqual(['See ', '[msg:K7F2] too']);
    expect(r.replyTo).toBeNull();
  });

  it('flushes a partial marker when the stream ends', () => {
    const r = run(['[ms']);
    expect(r.out).toEqual(['']);
    expect(r.tail).toBe('[ms');
    expect(r.text).toBe('[ms');
    expect(r.replyTo).toBeNull();
  });

  it('releases whitespace-only text once it passes the lookahead', () => {
    const r = run([' '.repeat(CITATION_LOOKAHEAD + 2)]);
    expect(r.out).toEqual([' '.repeat(CITATION_LOOKAHEAD + 2)]);
  });

  it('flush() with nothing held keeps waiting (tools usually run before the answer)', () => {
    const filter = new CitationFilter();
    expect(filter.flush()).toBe('');
    expect(filter.push('[msg:K7F2] ok')).toBe('ok');
    expect(filter.replyTo).toBe('K7F2');
  });

  it('flush() mid-prefix releases the held text and gives up on a marker', () => {
    const filter = new CitationFilter();
    expect(filter.push('[ms')).toBe('');
    expect(filter.flush()).toBe('[ms');
    expect(filter.push('g:K7F2]')).toBe('g:K7F2]');
    expect(filter.replyTo).toBeNull();
    expect(filter.text).toBe('[msg:K7F2]');
  });

  it('handles a marker glued to the text', () => {
    expect(run(['[msg:K7F2]Hello']).text).toBe('Hello');
  });
});
