import { describe, expect, it, vi } from 'vitest';
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MAX_CHARS,
  EMBEDDING_MODEL,
  OPENROUTER_EMBEDDINGS_URL,
} from '../../../src/embeddings/constants.js';
import { EmbeddingError, embeddingErrorText } from '../../../src/embeddings/embedder.js';
import {
  OPENROUTER_EMBED_MAX_BATCH,
  OPENROUTER_EMBED_TIMEOUT_MS,
  RESPONSE_SNIPPET_CHARS,
  createOpenRouterEmbedder,
  embedderFromConfig,
} from '../../../src/embeddings/openrouter.js';

const KEY = 'sk-or-v1-TEST-SECRET-0123456789';

interface SentBody {
  model: string;
  input: string[];
  encoding_format: string;
}

/** A 1536-wide vector whose first element is `seed`, so tests can tell vectors apart. */
function vec(seed: number, width = EMBEDDING_DIMENSIONS): number[] {
  return Array.from({ length: width }, (_, i) => (i === 0 ? seed : i / 1_000_000));
}

/** "note 7" -> 7 */
function seedOf(input: string): number {
  return Number(input.replace(/\D/g, ''));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeFetch(handler: (body: SentBody, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as SentBody;
    return handler(body, init ?? {});
  });
}

/** Answers every batch correctly, in order, with index set. */
function echoFetch() {
  return fakeFetch((body) =>
    json({ data: body.input.map((input, index) => ({ index, embedding: vec(seedOf(input)) })) }),
  );
}

function embedder(f: unknown, extra: { timeoutMs?: number; maxBatch?: number } = {}) {
  return createOpenRouterEmbedder({ apiKey: KEY, fetch: f as unknown as typeof fetch, ...extra });
}

/** Awaits a rejection, checks it is an EmbeddingError and that the key never leaks. */
async function failure(p: Promise<unknown>): Promise<EmbeddingError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(embeddingErrorText(err)).not.toContain(KEY);
    expect((err as Error).message).not.toContain(KEY);
    return err as EmbeddingError;
  }
  throw new Error('expected embed() to reject');
}

describe('createOpenRouterEmbedder', () => {
  it('exposes the model and width from the constants', () => {
    const e = embedder(echoFetch());
    expect(e.model).toBe(EMBEDDING_MODEL);
    expect(e.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(OPENROUTER_EMBED_TIMEOUT_MS).toBe(15_000);
  });

  it('refuses a blank key at construction, without a request', () => {
    const f = echoFetch();
    expect(() => createOpenRouterEmbedder({ apiKey: '  ', fetch: f as unknown as typeof fetch })).toThrow(EmbeddingError);
    expect(f).not.toHaveBeenCalled();
  });

  it('refuses a bad maxBatch', () => {
    expect(() => embedder(echoFetch(), { maxBatch: 0 })).toThrow(RangeError);
  });

  it('throws before any request on an empty batch or an empty input', async () => {
    const f = echoFetch();
    const e = embedder(f);
    expect((await failure(e.embed([]))).message).toMatch(/at least one input/);
    expect((await failure(e.embed(['note 1', '  \n ']))).message).toMatch(/input 1 is empty/);
    expect(f).not.toHaveBeenCalled();
  });

  it('posts the run-insights request shape', async () => {
    const f = echoFetch();
    await embedder(f).embed(['  note 1  ']);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(OPENROUTER_EMBEDDINGS_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` });
    expect(JSON.parse(String(init.body))).toEqual({ model: EMBEDDING_MODEL, input: ['note 1'], encoding_format: 'float' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('clamps each input to EMBEDDING_MAX_CHARS without a marker', async () => {
    const f = echoFetch();
    await embedder(f).embed([`note 1 ${'x'.repeat(EMBEDDING_MAX_CHARS + 500)}`]);
    const sent = JSON.parse(String((f.mock.calls[0] as [string, RequestInit])[1].body)) as SentBody;
    expect(sent.input[0]).toHaveLength(EMBEDDING_MAX_CHARS);
  });

  it('returns vectors in input order, placed by data[i].index', async () => {
    const f = fakeFetch((body) =>
      json({
        data: body.input
          .map((input, index) => ({ index, embedding: vec(seedOf(input)) }))
          .reverse(),
      }),
    );
    const out = await embedder(f).embed(['note 1', 'note 2', 'note 3']);
    expect(out.map((v) => v[0])).toEqual([1, 2, 3]);
  });

  it('falls back to position when the provider omits index', async () => {
    const f = fakeFetch((body) => json({ data: body.input.map((input) => ({ embedding: vec(seedOf(input)) })) }));
    const out = await embedder(f).embed(['note 4', 'note 5']);
    expect(out.map((v) => v[0])).toEqual([4, 5]);
  });

  it('splits a large call into maxBatch-sized requests and keeps order', async () => {
    const f = echoFetch();
    const inputs = ['note 1', 'note 2', 'note 3', 'note 4', 'note 5'];
    const out = await embedder(f, { maxBatch: 2 }).embed(inputs);
    expect(f).toHaveBeenCalledTimes(3);
    const sizes = f.mock.calls.map((c) => (JSON.parse(String((c as [string, RequestInit])[1].body)) as SentBody).input.length);
    expect(sizes).toEqual([2, 2, 1]);
    expect(out.map((v) => v[0])).toEqual([1, 2, 3, 4, 5]);
    expect(OPENROUTER_EMBED_MAX_BATCH).toBe(64);
  });

  it('fails the whole call when a later chunk fails', async () => {
    let n = 0;
    const f = fakeFetch((body) => {
      n += 1;
      return n === 2
        ? new Response('upstream sad', { status: 500 })
        : json({ data: body.input.map((input, index) => ({ index, embedding: vec(seedOf(input)) })) });
    });
    const err = await failure(embedder(f, { maxBatch: 1 }).embed(['note 1', 'note 2', 'note 3']));
    expect(err.message).toMatch(/returned 500/);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('wraps a transport failure with its cause', async () => {
    const cause = new TypeError('fetch failed');
    const f = vi.fn(async () => {
      throw cause;
    });
    const err = await failure(embedder(f).embed(['note 1']));
    expect(err.message).toBe('embedding request failed');
    expect(err.detail).toBe(cause);
    expect(embeddingErrorText(err)).toContain('fetch failed');
  });

  function hangingFetch() {
    return vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    );
  }

  it('times out with the configured ceiling', async () => {
    const err = await failure(embedder(hangingFetch(), { timeoutMs: 20 }).embed(['note 1']));
    expect(err.message).toBe('embedding request timed out after 20 ms');
  });

  it('honours a per-call timeout', async () => {
    const err = await failure(embedder(hangingFetch(), { timeoutMs: 60_000 }).embed(['note 1'], { timeoutMs: 15 }));
    expect(err.message).toBe('embedding request timed out after 15 ms');
  });

  it('reports a non-2xx status with a bounded snippet, even for an HTML body', async () => {
    const page = `<html>${'bad gateway '.repeat(200)}</html>`;
    const f = fakeFetch(() => new Response(page, { status: 502 }));
    const err = await failure(embedder(f).embed(['note 1']));
    expect(err.message).toMatch(/^embedding endpoint returned 502: <html>bad gateway/);
    expect(err.message.length).toBeLessThanOrEqual('embedding endpoint returned 502: '.length + RESPONSE_SNIPPET_CHARS);
    expect(err.detail).toEqual({ status: 502 });
  });

  it('reports a 401 without echoing the key', async () => {
    const f = fakeFetch(() => json({ error: { message: 'No auth credentials found', code: 401 } }, 401));
    const err = await failure(embedder(f).embed(['note 1']));
    expect(err.message).toMatch(/returned 401: .*No auth credentials found/);
  });

  it('reports a 200 body that is not JSON', async () => {
    const f = fakeFetch(() => new Response('definitely not json', { status: 200 }));
    expect((await failure(embedder(f).embed(['note 1']))).message).toBe(
      'embedding response was not valid JSON: definitely not json',
    );
  });

  it('reports a 200 JSON body without a data array', async () => {
    const f = fakeFetch(() => json({ error: { message: 'model overloaded' } }));
    expect((await failure(embedder(f).embed(['note 1']))).message).toMatch(/no data array: .*model overloaded/);
  });

  it('reports a vector count that does not match the inputs', async () => {
    const f = fakeFetch(() => json({ data: [{ index: 0, embedding: vec(1) }] }));
    expect((await failure(embedder(f).embed(['note 1', 'note 2']))).message).toMatch(/1 vector\(s\) for 2 input\(s\)/);
  });

  it('reports an item with no embedding array', async () => {
    const f = fakeFetch(() => json({ data: [{ index: 0, embedding: 'AAAA' }] }));
    expect((await failure(embedder(f).embed(['note 1']))).message).toMatch(/no vector at data\[0\]\.embedding/);
  });

  it('reports a repeated or out-of-range index', async () => {
    const dup = fakeFetch(() => json({ data: [{ index: 0, embedding: vec(1) }, { index: 0, embedding: vec(2) }] }));
    expect((await failure(embedder(dup).embed(['note 1', 'note 2']))).message).toMatch(/bad or repeated index 0 at data\[1\]/);
    const out = fakeFetch(() => json({ data: [{ index: 5, embedding: vec(1) }] }));
    expect((await failure(embedder(out).embed(['note 1']))).message).toMatch(/bad or repeated index 5/);
  });

  it('refuses a vector of the wrong width, naming both numbers', async () => {
    const f = fakeFetch(() => json({ data: [{ index: 0, embedding: vec(1, 1024) }] }));
    const err = await failure(embedder(f).embed(['note 1']));
    expect(err.message).toContain('1024 value(s)');
    expect(err.message).toContain(`vector(${EMBEDDING_DIMENSIONS})`);
  });

  it('refuses a non-finite or non-numeric element', async () => {
    const withNull = vec(1);
    (withNull as unknown[])[10] = null;
    const f = fakeFetch(() => json({ data: [{ index: 0, embedding: withNull }] }));
    expect((await failure(embedder(f).embed(['note 1']))).message).toMatch(/non-finite/);
  });
});

describe('embedderFromConfig', () => {
  it('is null without a key', () => {
    expect(embedderFromConfig({ apiKey: null })).toBeNull();
  });

  it('builds the OpenRouter embedder with a key, without a request', () => {
    const f = echoFetch();
    const e = embedderFromConfig({ apiKey: KEY }, { fetch: f as unknown as typeof fetch });
    expect(e).not.toBeNull();
    expect(e?.model).toBe(EMBEDDING_MODEL);
    expect(e?.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('embeddingErrorText', () => {
  it('includes the detail of an EmbeddingError', () => {
    const inner = new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 1.2.3.4:443') });
    expect(embeddingErrorText(new EmbeddingError('embedding request failed', inner))).toBe(
      'EmbeddingError: embedding request failed - detail: TypeError: fetch failed (connect ECONNREFUSED 1.2.3.4:443)',
    );
    expect(embeddingErrorText(new EmbeddingError('x', { status: 502 }))).toBe('EmbeddingError: x - detail: {"status":502}');
    expect(embeddingErrorText(new EmbeddingError('plain'))).toBe('EmbeddingError: plain');
  });

  it('formats other errors and non-errors', () => {
    expect(embeddingErrorText(new RangeError('r'))).toBe('RangeError: r');
    expect(embeddingErrorText('s')).toBe('s');
  });
});
