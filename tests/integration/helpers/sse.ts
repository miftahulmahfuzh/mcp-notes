export interface SseMessage {
  event: string;
  data: unknown;
}

/** Reads from the stream until `done(accumulatedText)` is true. Throws after `timeoutMs`. */
export async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  done: (text: string) => boolean,
  timeoutMs = 3000,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  while (!done(text)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`readUntil timed out; got: ${JSON.stringify(text)}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`readUntil timed out; got: ${JSON.stringify(text)}`)),
        remaining,
      );
    });
    try {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    } finally {
      clearTimeout(timer);
    }
  }
  return text;
}

/** Parses `event:`/`data:` blocks; comment-only blocks (`: heartbeat`) are dropped. */
export function parseSse(text: string): SseMessage[] {
  const messages: SseMessage[] = [];
  for (const block of text.split('\n\n')) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) data.push(line.slice('data:'.length).replace(/^ /, ''));
    }
    if (data.length > 0) messages.push({ event, data: JSON.parse(data.join('\n')) as unknown });
  }
  return messages;
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
