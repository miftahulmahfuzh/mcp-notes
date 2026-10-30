import { describe, expect, it } from 'vitest';
import { createSSEParser, readSSE } from './sse';
import type { SSEEvent } from './sse';

function collect(chunks: string[]): SSEEvent[] {
  const out: SSEEvent[] = [];
  const p = createSSEParser((e) => out.push(e));
  chunks.forEach((c) => p.push(c));
  p.end();
  return out;
}

describe('createSSEParser', () => {
  it('parses named events with JSON data', () => {
    expect(collect(['event: delta\ndata: {"text":"hi"}\n\nevent: done\ndata: {"thread_id":"t1"}\n\n'])).toEqual([
      { event: 'delta', data: '{"text":"hi"}', id: undefined },
      { event: 'done', data: '{"thread_id":"t1"}', id: undefined },
    ]);
  });
  it('handles events split across chunks, CRLF line endings, and a CRLF split between chunks', () => {
    expect(collect(['event: del', 'ta\r', '\ndata: {"te', 'xt":"a"}\r\n\r\n'])).toEqual([
      { event: 'delta', data: '{"text":"a"}', id: undefined },
    ]);
  });
  it('ignores comments (heartbeats), joins multi-line data, defaults the event name', () => {
    expect(collect([': ping\n\ndata: one\ndata: two\nid: 7\n\n'])).toEqual([{ event: 'message', data: 'one\ntwo', id: '7' }]);
  });
  it('flushes a final event without a trailing blank line on end()', () => {
    expect(collect(['event: done\ndata: {}'])).toEqual([{ event: 'done', data: '{}', id: undefined }]);
  });
  it('drops events with no data', () => {
    expect(collect(['event: note\n\n'])).toEqual([]);
  });
});

describe('readSSE', () => {
  it('reads a byte stream, including a multi-byte char split across chunks', async () => {
    const bytes = new TextEncoder().encode('event: delta\ndata: {"text":"café ▍"}\n\n');
    const cut = bytes.indexOf(0xc3) + 1; // split inside "é"
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, cut));
        c.enqueue(bytes.slice(cut));
        c.close();
      },
    });
    const out: SSEEvent[] = [];
    await readSSE(stream, (e) => out.push(e));
    expect(out).toEqual([{ event: 'delta', data: '{"text":"café ▍"}', id: undefined }]);
  });
});
