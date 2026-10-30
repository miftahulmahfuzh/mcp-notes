import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '../../../src/embeddings/constants.js';
import { EmbeddingError } from '../../../src/embeddings/embedder.js';
import { cosine, createFakeEmbedder, tokenize } from '../../helpers/fakeEmbedder.js';

const ARANGO_NOTE = 'arango root password is in the vault';
const ARANGO_QUERY = 'ArangoDB credentials';
const LOGIN_NOTE = 'the login broke after the laptop slept';
const LOGIN_QUERY = 'have we seen auth failures after resume before?';
const UNRELATED = 'bought groceries: rice, eggs, chili';

function norm(v: readonly number[]): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

describe('fake embedder', () => {
  it('defaults to the real model id and width', () => {
    const e = createFakeEmbedder();
    expect(e.model).toBe(EMBEDDING_MODEL);
    expect(e.dimensions).toBe(EMBEDDING_DIMENSIONS);
  });

  it('is deterministic across calls and instances, and unit length', async () => {
    const a = createFakeEmbedder();
    const b = createFakeEmbedder();
    const [v1] = await a.embed([ARANGO_NOTE]);
    const [v2] = await b.embed([ARANGO_NOTE]);
    expect(v1).toEqual(v2);
    expect(v1).toEqual(a.vectorFor(ARANGO_NOTE));
    expect(v1).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(norm(v1!)).toBeCloseTo(1, 10);
  });

  it('puts the brief usage examples closest to their notes without word overlap', () => {
    const e = createFakeEmbedder();
    const q1 = e.vectorFor(ARANGO_QUERY);
    const q2 = e.vectorFor(LOGIN_QUERY);
    expect(cosine(q1, e.vectorFor(ARANGO_NOTE))).toBeGreaterThan(cosine(q1, e.vectorFor(LOGIN_NOTE)));
    expect(cosine(q1, e.vectorFor(ARANGO_NOTE))).toBeGreaterThan(cosine(q1, e.vectorFor(UNRELATED)));
    expect(cosine(q2, e.vectorFor(LOGIN_NOTE))).toBeGreaterThan(cosine(q2, e.vectorFor(ARANGO_NOTE)));
    expect(cosine(q2, e.vectorFor(LOGIN_NOTE))).toBeGreaterThan(cosine(q2, e.vectorFor(UNRELATED)));
    expect(cosine(q1, e.vectorFor(ARANGO_NOTE))).toBeGreaterThan(0.5);
  });

  it('gives a shared unknown token a small, non-zero similarity', () => {
    const e = createFakeEmbedder();
    const s = cosine(e.vectorFor('ERR_ZX9_QUUX happened'), e.vectorFor('saw ERR_ZX9_QUUX again'));
    expect(s).toBeGreaterThan(0);
  });

  it('accepts a custom lexicon and width, with prefix entries', () => {
    const e = createFakeEmbedder({ lexicon: [['kube*', 'k8s'], ['cat', 'kitten']], dimensions: 16 });
    expect(e.vectorFor('k8s')).toHaveLength(16);
    expect(cosine(e.vectorFor('kubernetes'), e.vectorFor('k8s'))).toBeCloseTo(1, 10);
    expect(cosine(e.vectorFor('kitten'), e.vectorFor('kubectl'))).toBeCloseTo(0, 10);
  });

  it('refuses a width that cannot hold the lexicon', () => {
    expect(() => createFakeEmbedder({ lexicon: [['a'], ['b'], ['c']], dimensions: 4 })).toThrow(/cannot hold/);
  });

  it('never returns a zero vector', () => {
    const e = createFakeEmbedder();
    const v = e.vectorFor('the and of');
    expect(norm(v)).toBeCloseTo(1, 10);
    expect(v[EMBEDDING_DIMENSIONS - 1]).toBe(1);
  });

  it('tokenizes on non-letters and drops stopwords', () => {
    expect(tokenize('The ArangoDB root-password, is IN vault!')).toEqual(['arangodb', 'root', 'password', 'vault']);
  });

  it('validates like the real client, recording nothing', async () => {
    const e = createFakeEmbedder();
    await expect(e.embed([])).rejects.toBeInstanceOf(EmbeddingError);
    await expect(e.embed(['ok', ' '])).rejects.toThrow(/input 1 is empty/);
    expect(e.calls).toEqual([]);
  });

  it('records batches and fails the next n calls on request', async () => {
    const e = createFakeEmbedder();
    e.failNext(2);
    await expect(e.embed(['a1'])).rejects.toBeInstanceOf(EmbeddingError);
    await expect(e.embed(['a2'])).rejects.toBeInstanceOf(EmbeddingError);
    await expect(e.embed(['a3', 'a4'])).resolves.toHaveLength(2);
    expect(e.calls).toEqual([['a1'], ['a2'], ['a3', 'a4']]);
  });

  it('fails a call whose inputs match failWhen, with a custom error', async () => {
    const e = createFakeEmbedder();
    const boom = new EmbeddingError('boom');
    e.failWhen((input) => input.includes('poison'), boom);
    await expect(e.embed(['fine', 'has poison'])).rejects.toBe(boom);
    await expect(e.embed(['fine'])).resolves.toHaveLength(1);
    e.failWhen(null);
    await expect(e.embed(['has poison'])).resolves.toHaveLength(1);
  });

  it('waits delayMs before answering, and reset clears state', async () => {
    const e = createFakeEmbedder({ delayMs: 30 });
    const started = Date.now();
    await e.embed(['slow']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    e.failNext(5);
    e.reset();
    expect(e.calls).toEqual([]);
    expect(e.delayMs).toBe(0);
    await expect(e.embed(['ok'])).resolves.toHaveLength(1);
  });
});
