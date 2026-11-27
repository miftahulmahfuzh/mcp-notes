import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdversaryService } from '../../../src/adversary/service.js';
import { startAdversary } from '../../../src/adversary/start.js';
import { REPLY_EMBED_KICK_MS as FROM_BACKGROUND } from '../../../src/background.js';
import { DEFAULT_ADVERSARY_CONFIG, DEFAULT_MOVIES_CONFIG, DEFAULT_SESSIONS_CONFIG } from '../../../src/config.js';
import type { Db } from '../../../src/db/client.js';
import { startEgressLine } from '../../../src/db/egressStart.js';
import type { AppDeps } from '../../../src/deps.js';
import { startStreamJobs } from '../../../src/directStream/startJobs.js';
import { startEmbeddingWorkers } from '../../../src/embeddings/start.js';
import type { Embedder } from '../../../src/embeddings/embedder.js';
import type { ImageEmbedder } from '../../../src/embeddings/imageEmbedder.js';
import type { EmbeddingWorker } from '../../../src/embeddings/worker.js';
import { startImagesBackground } from '../../../src/images/start.js';
import type { MoviesService } from '../../../src/movies/service.js';
import { startMoviesSync } from '../../../src/movies/start.js';
import type { SessionIngester } from '../../../src/sessions/ingest.js';
import { REPLY_EMBED_KICK_MS, SUMMARY_DUE_MARGIN_MS, startSessionsBackground, type SessionsBackgroundIo } from '../../../src/sessions/start.js';
import type { Summarizer } from '../../../src/sessions/summarize.js';
import { DEFAULT_SUMMARY_IDLE_MS } from '../../../src/sessions/summaryWorker.js';
import { startConfig } from '../../helpers/startConfig.js';

const db = {} as Db;

function deps(over: Partial<AppDeps> = {}): AppDeps {
  return { config: startConfig(), db, events: {} as never, service: {} as never, embedder: null, imageEmbedder: null, chat: {} as never, adversary: null, movies: null, ...over };
}

function lines() {
  const out: string[] = [];
  return { out, log: (l: string) => out.push(l) };
}

describe('startImagesBackground', () => {
  it('makes the data dirs, copies the legacy images in before the inbox watches, and closes the inbox', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'notesd-images-start-'));
    const order: string[] = [];
    const l = lines();
    const close = vi.fn(async () => {});
    const watched: string[] = [];
    const images = await startImagesBackground(deps({ config: startConfig({ dataDir }) }), {
      reconcile: async () => {
        order.push('reconcile');
        return 3;
      },
      watch: (async (o: { inboxDir: string }) => {
        order.push('watch');
        watched.push(o.inboxDir);
        return { close };
      }) as never,
      log: l.log,
    });
    expect(order).toEqual(['reconcile', 'watch']);
    expect(watched).toEqual([join(dataDir, 'inbox')]);
    expect(l.out).toEqual(['[notesd] legacy images reconciled into note_images: 3', `[notesd] watching ${join(dataDir, 'inbox')}`]);
    await images.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('a failed copy never blocks the inbox', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'notesd-images-start-'));
    const errors: string[] = [];
    const watch = vi.fn(async () => ({ close: async () => {} }));
    await startImagesBackground(deps({ config: startConfig({ dataDir }) }), {
      reconcile: async () => Promise.reject(new Error('no image_path column')),
      watch: watch as never,
      log: () => {},
      error: (l) => errors.push(l),
    });
    expect(errors).toEqual(['[notesd] legacy image reconcile failed: no image_path column']);
    expect(watch).toHaveBeenCalledTimes(1);
  });
});

describe('startEmbeddingWorkers', () => {
  const worker = (): EmbeddingWorker => ({ close: vi.fn(async () => {}) }) as unknown as EmbeddingWorker;

  it('starts no worker without an embedder, and says so for each', () => {
    const l = lines();
    const notes = vi.fn();
    const images = vi.fn();
    const w = startEmbeddingWorkers(deps(), { notes: notes as never, images: images as never, log: l.log });
    expect(notes).not.toHaveBeenCalled();
    expect(images).not.toHaveBeenCalled();
    expect(l.out).toEqual([
      '[notesd] embeddings off: OPENROUTER_API_KEY is not set, search stays full text',
      '[notesd] image search off: OPENROUTER_API_KEY is not set, similar_images cannot compare pictures',
    ]);
    expect(w.closers()).toEqual([undefined, undefined]);
  });

  it('starts each worker with its embedder and closes both', async () => {
    const l = lines();
    const a = worker();
    const b = worker();
    const w = startEmbeddingWorkers(deps({ embedder: { model: 'text-3' } as Embedder, imageEmbedder: { model: 'gemini' } as ImageEmbedder }), {
      notes: (() => a) as never,
      images: (() => b) as never,
      log: l.log,
    });
    expect(l.out).toEqual(['[notesd] embedding notes with text-3', '[notesd] embedding images with gemini']);
    await Promise.all(w.closers());
    expect(a.close).toHaveBeenCalled();
    expect(b.close).toHaveBeenCalled();
  });
});

describe('startSessionsBackground', () => {
  afterEach(() => vi.useRealTimers());

  const on = (over: Partial<AppDeps> = {}) => deps({ config: startConfig({ sessions: { ...DEFAULT_SESSIONS_CONFIG, enabled: true, claudeHome: '/fake/claude' } }), ...over });

  function fakes() {
    const observers: { onBatch?: () => void; onPassComplete?: (p: { sessionIds: string[] }) => void }[] = [];
    const order: string[] = [];
    const ingest = {
      forkBackfill: undefined,
      addObserver: (o: (typeof observers)[number]) => observers.push(o),
      close: vi.fn(async () => order.push('ingest.close')),
    } as unknown as SessionIngester;
    const links = { close: vi.fn(async () => order.push('links.close')) };
    const replies = { kick: vi.fn(), close: vi.fn(async () => {}) };
    const summaries = { kick: vi.fn(), close: vi.fn(async () => {}) };
    const io: SessionsBackgroundIo = {
      ingest: vi.fn(() => ingest) as never,
      links: vi.fn(() => links) as never,
      replies: vi.fn(() => replies) as never,
      summaries: vi.fn(() => summaries) as never,
      host: () => 'pc',
    };
    return { io, observers, order, ingest, links, replies, summaries };
  }

  it('keeps the background exports', () => {
    expect(FROM_BACKGROUND).toBe(REPLY_EMBED_KICK_MS);
  });

  it('starts nothing with NOTESD_SESSIONS=off', () => {
    const f = fakes();
    const l = lines();
    const s = startSessionsBackground(deps(), null, { ...f.io, log: l.log });
    expect(f.io.ingest).not.toHaveBeenCalled();
    expect(f.io.summaries).not.toHaveBeenCalled();
    expect(l.out).toEqual(['[notesd] session ingest off: NOTESD_SESSIONS=off']);
    s.halt();
  });

  it('ingests, links, embeds replies and summarizes, kicking the reply worker on each read', () => {
    const f = fakes();
    const l = lines();
    const d = on({ embedder: { model: 'text-3' } as Embedder });
    startSessionsBackground(d, { model: 'haiku' } as Summarizer, { ...f.io, log: l.log });
    expect(l.out).toEqual([
      '[notesd] ingesting Claude Code sessions from /fake/claude/projects as pc',
      '[notesd] embedding session replies with text-3',
      '[notesd] session summaries: haiku, session embeddings: text-3',
    ]);
    expect((f.io.replies as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ debounceMs: REPLY_EMBED_KICK_MS });
    f.observers[0]!.onBatch!();
    expect(f.replies.kick).toHaveBeenCalledTimes(1);
    f.observers[0]!.onPassComplete!({ sessionIds: [] });
    expect(f.replies.kick).toHaveBeenCalledTimes(1);
    f.observers[0]!.onPassComplete!({ sessionIds: ['s'] });
    expect(f.replies.kick).toHaveBeenCalledTimes(2);
    d.kickSummaries!();
    expect(f.summaries.kick).toHaveBeenCalledTimes(1);
  });

  it('wakes the summary worker once a session has been quiet for the idle time, re-armed by each read', () => {
    vi.useFakeTimers();
    const f = fakes();
    startSessionsBackground(on(), { model: 'haiku' } as Summarizer, { ...f.io, log: () => {} });
    const batch = f.observers[0]!.onBatch!;
    batch();
    vi.advanceTimersByTime(DEFAULT_SUMMARY_IDLE_MS);
    batch();
    vi.advanceTimersByTime(DEFAULT_SUMMARY_IDLE_MS + SUMMARY_DUE_MARGIN_MS - 1);
    expect(f.summaries.kick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(f.summaries.kick).toHaveBeenCalledTimes(1);
  });

  it('while the old shared database is not copied in, the billed reply vectors and summaries wait', () => {
    const f = fakes();
    const l = lines();
    const d = on({ embedder: { model: 'text-3' } as Embedder, importPending: true });
    startSessionsBackground(d, { model: 'haiku' } as Summarizer, { ...f.io, log: l.log });
    expect(f.io.replies).not.toHaveBeenCalled();
    expect(f.io.summaries).not.toHaveBeenCalled();
    expect(d.kickSummaries).toBeUndefined();
    expect(l.out.slice(1)).toEqual([
      '[notesd] session reply vectors wait: the old shared database is not copied in yet',
      '[notesd] session summaries wait: the old shared database is not copied in yet',
    ]);
  });

  it('with neither a summarizer nor an embedder, no summary worker', () => {
    const f = fakes();
    const l = lines();
    startSessionsBackground(on(), null, { ...f.io, log: l.log });
    expect(f.io.summaries).not.toHaveBeenCalled();
    expect(l.out).toContain('[notesd] session summaries and session embeddings off');
  });

  it('halt stops the summary timer and drops kickSummaries; the linker closes after the ingester', async () => {
    vi.useFakeTimers();
    const f = fakes();
    const d = on();
    const s = startSessionsBackground(d, { model: 'haiku' } as Summarizer, { ...f.io, log: () => {} });
    f.observers[0]!.onBatch!();
    s.halt();
    expect(d.kickSummaries).toBeUndefined();
    vi.advanceTimersByTime(DEFAULT_SUMMARY_IDLE_MS * 2);
    expect(f.summaries.kick).not.toHaveBeenCalled();
    vi.useRealTimers();
    await Promise.all(s.closers());
    expect(f.order).toEqual(['ingest.close', 'links.close']);
    expect(f.summaries.close).toHaveBeenCalled();
  });
});

describe('startAdversary and startMoviesSync', () => {
  it('say why they are off', () => {
    const l = lines();
    startAdversary(deps(), l.log);
    startAdversary(deps({ config: startConfig({ adversary: { ...DEFAULT_ADVERSARY_CONFIG, enabled: true } }) }), l.log);
    startMoviesSync(deps(), l.log);
    expect(l.out).toEqual(['[notesd] adversary off: NOTESD_ADVERSARY=off', '[notesd] adversary off: no reviewer could be built', '[notesd] movies off: NOTESD_MOVIES=off']);
  });

  it('start the reviewer and the library poll loop', () => {
    const l = lines();
    const adversary = { host: 'pc', start: vi.fn() } as unknown as AdversaryService;
    startAdversary(deps({ adversary }), l.log);
    expect(adversary.start).toHaveBeenCalled();
    expect(l.out[0]).toMatch(/^\[notesd\] adversary reviewer on as pc: a pass every \d+ s/);
    const movies = { host: 'pc', tmdb: null, start: vi.fn() } as unknown as MoviesService;
    startMoviesSync(deps({ movies, config: startConfig({ movies: { ...DEFAULT_MOVIES_CONFIG, roots: ['/v'], scanMs: 60_000 } }) }), l.log);
    expect(movies.start).toHaveBeenCalled();
    expect(l.out[1]).toBe('[notesd] movies on as pc: scanning /v every 60 s, TMDB off (no TMDB_API_READ_ACCESS_TOKEN or TMDB_API_KEY)');
    startMoviesSync(deps({ movies, config: startConfig({ movies: { ...DEFAULT_MOVIES_CONFIG, roots: [] } }) }), l.log);
    expect(l.out[2]).toBe('[notesd] movies on as pc: NOTESD_MOVIES_ROOTS is empty, nothing is scanned');
  });
});

describe('startStreamJobs', () => {
  function stream() {
    const order: string[] = [];
    let releaseTorrents: (n: number) => void = () => {};
    const job = (name: string) => ({ startLine: () => `${name} line`, start: vi.fn(() => order.push(`${name}.start`)), close: vi.fn(async () => order.push(`${name}.close`)) });
    const d = deps({
      streamCanary: job('canary') as never,
      trending: job('trending') as never,
      trackerLists: job('trackers') as never,
      streamCache: { host: 'pc', start: vi.fn(async () => (order.push('cache.start'), 2)), close: vi.fn(async () => order.push('cache.close')) } as never,
      streamPreviews: { start: vi.fn(() => order.push('previews.start')), close: vi.fn(async () => order.push('previews.close')) } as never,
      torrents: {
        host: 'pc',
        root: '/t',
        uploadKbps: 64,
        keepDays: 7,
        start: vi.fn(() => (order.push('torrents.start'), new Promise<number>((r) => (releaseTorrents = r)))),
        close: vi.fn(async () => order.push('torrents.close')),
      } as never,
      streamDownloads: { host: 'pc', start: vi.fn(async () => (order.push('downloads.start'), 1)), close: vi.fn(async () => order.push('downloads.close')) } as never,
      cacheShelf: { start: vi.fn(async () => (order.push('shelf.start'), 0)), close: vi.fn(async () => order.push('shelf.close')) } as never,
    });
    return { d, order, release: (n: number) => releaseTorrents(n) };
  }

  it('starts every part in order, and the downloads only after the torrents have started', async () => {
    const s = stream();
    const l = lines();
    startStreamJobs(s.d, l.log, l.log);
    expect(s.order).toEqual(['canary.start', 'trending.start', 'trackers.start', 'cache.start', 'previews.start', 'torrents.start', 'shelf.start']);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.order).not.toContain('downloads.start');
    s.release(3);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.order).toContain('downloads.start');
    expect(l.out).toEqual([
      'canary line',
      'trending line',
      'trackers line',
      '[notesd] stream cache: carrying on 2 unfinished download(s) on pc',
      '[notesd] torrents on as pc: downloads in /t, upload capped at 64 kB/s, 3 download(s) not played for 7 days cleared',
      '[notesd] downloads: carrying on 1 download(s) on pc',
    ]);
  });

  it('a torrent start that fails is one line, and the downloads still carry on', async () => {
    const s = stream();
    (s.d.torrents as unknown as { start: () => Promise<number> }).start = () => Promise.reject(new Error('port in use'));
    const errors: string[] = [];
    startStreamJobs(s.d, () => {}, (l) => errors.push(l));
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toEqual(['[notesd] torrents: could not start: port in use']);
    expect(s.order).toContain('downloads.start');
  });

  it('closes the previews, then the downloads, before every other closer', async () => {
    const s = stream();
    const jobs = startStreamJobs(s.d, () => {}, () => {});
    s.order.length = 0;
    await jobs.closeFirst();
    expect(s.order).toEqual(['previews.close', 'downloads.close']);
    await Promise.all(jobs.closers());
    expect(s.order.slice(2)).toEqual(['canary.close', 'trending.close', 'trackers.close', 'cache.close', 'torrents.close', 'shelf.close']);
  });

  it('starts nothing when the Stream side is absent', async () => {
    const jobs = startStreamJobs(deps(), () => {}, () => {});
    await jobs.closeFirst();
    expect(jobs.closers().every((c) => c === undefined)).toBe(true);
  });
});

describe('startEgressLine', () => {
  afterEach(() => vi.useRealTimers());
  it('logs nothing for a database without the meter, and its stop is safe', () => {
    vi.useFakeTimers();
    const l = lines();
    const stop = startEgressLine(db, l.log, 1_000);
    vi.advanceTimersByTime(5_000);
    expect(l.out).toEqual([]);
    stop();
  });
});
