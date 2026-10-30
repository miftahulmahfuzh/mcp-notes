export interface SSEEvent {
  event: string;
  data: string;
  id?: string;
}

/** Incremental text/event-stream parser (WHATWG rules: comments, multi-line data, CR/LF/CRLF). */
export function createSSEParser(onEvent: (e: SSEEvent) => void): { push(chunk: string): void; end(): void } {
  let buf = '';
  let event = '';
  let data: string[] = [];
  let lastId: string | undefined;

  const dispatch = () => {
    if (data.length > 0) onEvent({ event: event || 'message', data: data.join('\n'), id: lastId });
    event = '';
    data = [];
  };

  const line = (l: string) => {
    if (l === '') {
      dispatch();
      return;
    }
    if (l.startsWith(':')) return;
    const i = l.indexOf(':');
    const field = i < 0 ? l : l.slice(0, i);
    let value = i < 0 ? '' : l.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') lastId = value;
  };

  return {
    push(chunk: string) {
      buf += chunk;
      for (;;) {
        const idx = buf.search(/\r\n|\r|\n/);
        if (idx < 0) break;
        // A trailing lone CR may be the first half of a CRLF split across chunks.
        if (buf[idx] === '\r' && idx === buf.length - 1) break;
        const sepLen = buf.startsWith('\r\n', idx) ? 2 : 1;
        const l = buf.slice(0, idx);
        buf = buf.slice(idx + sepLen);
        line(l);
      }
    },
    end() {
      if (buf.endsWith('\r')) buf = buf.slice(0, -1);
      if (buf !== '') line(buf);
      buf = '';
      dispatch();
    },
  };
}

/** Reads a fetch body as SSE until it ends. Rejects if the stream errors or is aborted. */
export async function readSSE(body: ReadableStream<Uint8Array>, onEvent: (e: SSEEvent) => void): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  const p = createSSEParser(onEvent);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      p.push(dec.decode(value, { stream: true }));
    }
    p.push(dec.decode());
    p.end();
  } finally {
    reader.releaseLock();
  }
}
