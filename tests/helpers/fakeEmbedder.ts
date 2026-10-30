import { EMBEDDING_DIMENSIONS, EMBEDDING_MAX_CHARS, EMBEDDING_MODEL } from '../../src/embeddings/constants.js';
import { EmbeddingError, type EmbedOptions, type Embedder } from '../../src/embeddings/embedder.js';

/**
 * Synonym groups: group i is concept axis i. Entries are matched lower-case against tokens; an
 * entry ending in `*` matches every token with that prefix ("auth*" -> auth, authentication).
 * An exact entry beats a prefix; a longer prefix beats a shorter one; earlier groups win ties.
 */
export type Lexicon = readonly (readonly string[])[];

/**
 * A small default covering the brief's two usage examples, for phase 3's write-path tests.
 * Phase 4's labelled set passes its own lexicon.
 */
export const DEFAULT_LEXICON: Lexicon = [
  ['arango*'],
  ['credential*', 'password*', 'passwd', 'secret*', 'apikey*'],
  ['vault*', 'keychain*', 'bitwarden'],
  ['auth*', 'login*', 'logon', 'signin', 'sso'],
  ['fail*', 'broke', 'broken', 'break*', 'error*', 'crash*', 'accident*', 'incident*', 'outage*'],
  ['resume*', 'sleep*', 'slept', 'suspend*', 'wake*', 'woke', 'hibernat*'],
  ['laptop*', 'notebook*', 'thinkpad'],
  ['tired*', 'fatigue*', 'exhaust*', 'drowsy'],
];

/** Function words dropped before embedding, so they do not make every text look alike. */
export const DEFAULT_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'in', 'on', 'at', 'of', 'to',
  'for', 'and', 'or', 'but', 'it', 'its', 'this', 'that', 'these', 'those', 'with', 'we', 'have',
  'has', 'had', 'our', 'my', 'me', 'i', 'you', 'do', 'did', 'does', 'any', 'about', 'there',
  'here', 'what', 'which', 'so', 'as', 'by', 'from', 'if', 'not', 'no',
]);

/** Weight of one unknown token relative to one concept hit (1.0). */
export const DEFAULT_TAIL_WEIGHT = 0.25;

export interface FakeEmbedderOptions {
  lexicon?: Lexicon;
  /** Default EMBEDDING_DIMENSIONS, so vectors fit the vector(1536) column. */
  dimensions?: number;
  /** Default EMBEDDING_MODEL, so stored rows count as current. */
  model?: string;
  stopwords?: Iterable<string>;
  tailWeight?: number;
  delayMs?: number;
}

/** Lower-case, NFKC, split on anything that is not a letter or digit, drop stopwords. */
export function tokenize(text: string, stopwords: ReadonlySet<string> = DEFAULT_STOPWORDS): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token !== '' && !stopwords.has(token));
}

/** Cosine similarity; 0 when either vector is all zeros. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error(`cosine: widths differ (${a.length} vs ${b.length})`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

interface ConceptIndex {
  exact: Map<string, number>;
  prefixes: Array<{ prefix: string; axis: number }>;
}

function indexLexicon(lexicon: Lexicon): ConceptIndex {
  const exact = new Map<string, number>();
  const prefixes: Array<{ prefix: string; axis: number }> = [];
  lexicon.forEach((group, axis) => {
    for (const raw of group) {
      const entry = raw.trim().toLowerCase();
      if (entry.endsWith('*')) {
        const prefix = entry.slice(0, -1);
        if (prefix !== '') prefixes.push({ prefix, axis });
      } else if (entry !== '' && !exact.has(entry)) {
        exact.set(entry, axis);
      }
    }
  });
  prefixes.sort((a, b) => b.prefix.length - a.prefix.length || a.axis - b.axis);
  return { exact, prefixes };
}

function conceptAxis(index: ConceptIndex, token: string): number | null {
  const hit = index.exact.get(token);
  if (hit !== undefined) return hit;
  for (const { prefix, axis } of index.prefixes) {
    if (token.startsWith(prefix)) return axis;
  }
  return null;
}

function scriptedFailure(): EmbeddingError {
  return new EmbeddingError('fake embedder: scripted failure');
}

/**
 * Deterministic offline Embedder for unit and integration tests. Same validation as the real
 * client (empty batch / empty input throws before anything is recorded), same clamp, same
 * model id and width by default.
 */
export class FakeEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;
  /** Every batch that would have reached the network, in call order (failed ones included). */
  readonly calls: string[][] = [];
  /** Wait this long inside every recorded call, before failing or answering. */
  delayMs: number;

  private readonly index: ConceptIndex;
  private readonly conceptCount: number;
  private readonly stopwords: ReadonlySet<string>;
  private readonly tailWeight: number;
  private failuresLeft = 0;
  private failure: Error = scriptedFailure();
  private failPredicate: ((input: string) => boolean) | null = null;
  private failPredicateError: Error = scriptedFailure();

  constructor(opts: FakeEmbedderOptions = {}) {
    const lexicon = opts.lexicon ?? DEFAULT_LEXICON;
    this.model = opts.model ?? EMBEDDING_MODEL;
    this.dimensions = opts.dimensions ?? EMBEDDING_DIMENSIONS;
    this.conceptCount = lexicon.length;
    // concept axes + at least one tail axis + the bias axis
    if (!Number.isInteger(this.dimensions) || this.dimensions < this.conceptCount + 2) {
      throw new Error(
        `fake embedder: ${this.dimensions} dimensions cannot hold ${this.conceptCount} concept groups (need >= ${this.conceptCount + 2})`,
      );
    }
    this.index = indexLexicon(lexicon);
    this.stopwords = opts.stopwords === undefined ? DEFAULT_STOPWORDS : new Set(opts.stopwords);
    this.tailWeight = opts.tailWeight ?? DEFAULT_TAIL_WEIGHT;
    this.delayMs = opts.delayMs ?? 0;
  }

  /** The next `n` recorded calls reject with `error` (default: an EmbeddingError). */
  failNext(n = 1, error?: Error): void {
    this.failuresLeft = n;
    this.failure = error ?? scriptedFailure();
  }

  /** While set, a recorded call rejects when any of its inputs matches. Null clears it. */
  failWhen(pred: ((input: string) => boolean) | null, error?: Error): void {
    this.failPredicate = pred;
    this.failPredicateError = error ?? scriptedFailure();
  }

  /** Clears calls, scripted failures and the delay. */
  reset(): void {
    this.calls.length = 0;
    this.failuresLeft = 0;
    this.failPredicate = null;
    this.delayMs = 0;
  }

  /** The vector embed() would return for `text`. Synchronous; records nothing; never fails. */
  vectorFor(text: string): number[] {
    const clamped = text.trim().slice(0, EMBEDDING_MAX_CHARS);
    const v = new Array<number>(this.dimensions).fill(0);
    const tailStart = this.conceptCount;
    const tailSize = this.dimensions - this.conceptCount - 1;
    for (const token of tokenize(clamped, this.stopwords)) {
      const axis = conceptAxis(this.index, token);
      if (axis !== null) {
        v[axis] = (v[axis] ?? 0) + 1;
      } else {
        const tail = tailStart + (fnv1a(token) % tailSize);
        v[tail] = (v[tail] ?? 0) + this.tailWeight;
      }
    }
    const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
    if (norm === 0) {
      v[this.dimensions - 1] = 1;
      return v;
    }
    return v.map((x) => x / norm);
  }

  async embed(inputs: readonly string[], _opts?: EmbedOptions): Promise<number[][]> {
    if (inputs.length === 0) throw new EmbeddingError('embedding needs at least one input');
    inputs.forEach((text, i) => {
      if (text.trim() === '') throw new EmbeddingError(`embedding input ${i} is empty`);
    });
    const batch = [...inputs];
    this.calls.push(batch);
    if (this.delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw this.failure;
    }
    const pred = this.failPredicate;
    if (pred !== null && batch.some((input) => pred(input))) throw this.failPredicateError;
    return batch.map((text) => this.vectorFor(text));
  }
}

export function createFakeEmbedder(opts: FakeEmbedderOptions = {}): FakeEmbedder {
  return new FakeEmbedder(opts);
}
