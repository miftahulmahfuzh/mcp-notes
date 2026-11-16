import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildWhisperTier,
  cutArgs,
  firstStretch,
  parseCues,
  placeCues,
  whisperTask,
  WhisperTier,
  WorkerTranscriber,
  WHISPER_LABEL,
  type AudioCutter,
  type OpenWhisperFeed,
  type Transcriber,
  type WhisperContext,
  type WhisperCue,
  type WhisperFeed,
  type WhisperRequest,
} from '../../../../src/directStream/torrent/subtitles/whisper.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const FAKE_WORKER = path.join(REPO, 'tests', 'fixtures', 'torrent', 'fake-whisper.mjs');
const HASH = 'ab'.repeat(20);

let workDir: string;
beforeEach(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), 'notesd-whisper-'));
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class FakeFeed implements WhisperFeed {
  readonly url = `/api/stream/torrent/${HASH}/feed/0/whisper`;
  readonly cues: WhisperCue[] = [];
  completed = 0;
  async append(cues: readonly WhisperCue[]): Promise<void> {
    this.cues.push(...cues);
  }
  async complete(): Promise<void> {
    this.completed += 1;
  }
}

class FakeTranscriber implements Transcriber {
  readonly requests: WhisperRequest[] = [];
  stops = 0;
  /** Called with the request's number (from 1) before it answers. */
  onRequest: (n: number) => void = () => undefined;
  /** When set, each request waits for it (or for its signal). */
  gate: Promise<void> | null = null;
  async transcribe(request: WhisperRequest, signal: AbortSignal): Promise<WhisperCue[]> {
    this.requests.push(request);
    this.onRequest(this.requests.length);
    if (this.gate !== null) {
      await Promise.race([
        this.gate,
        new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
      ]);
    }
    if (signal.aborted) throw new Error('aborted');
    return [{ start_s: 1, end_s: 3, text: `line ${this.requests.length}` }];
  }
  async stop(): Promise<void> {
    this.stops += 1;
  }
}

/** Audio up to `endS`; the starts it was asked for land in `cuts`; starts in `fail` fail. */
function fakeCutter(endS: number, cuts: number[], fail: ReadonlySet<number> = new Set()): AudioCutter {
  return async ({ startS, lengthS }) => {
    cuts.push(startS);
    if (fail.has(startS)) return { ok: false, reason: 'the route closed' };
    return { ok: true, lengthS: Math.max(0, Math.min(lengthS, endS - startS)) };
  };
}

function ctx(over: Partial<WhisperContext> = {}): WhisperContext {
  return { infoHash: HASH, fileIndex: 0, audioLang: 'en', resumeS: null, probe: { durationS: 1000 }, signal: new AbortController().signal, ...over };
}

function tier(parts: { cutter: AudioCutter; transcriber: Transcriber; feed?: FakeFeed; openFeed?: OpenWhisperFeed; stretchS?: number }): WhisperTier {
  const feed = parts.feed ?? new FakeFeed();
  return new WhisperTier({
    stretchS: parts.stretchS ?? 300,
    workDirOf: () => workDir,
    fileUrl: (infoHash, fileIndex) => `http://127.0.0.1:1/api/stream/torrent/${infoHash}/f/${fileIndex}`,
    openFeed: parts.openFeed ?? (async () => feed),
    cutter: parts.cutter,
    transcriber: parts.transcriber,
    log: () => undefined,
  });
}

describe('WhisperTier', () => {
  it('answers a growing English (Whisper) track at once and fills it stretch by stretch from where the play starts', async () => {
    const cuts: number[] = [];
    const feed = new FakeFeed();
    const transcriber = new FakeTranscriber();
    const tracks = await tier({ cutter: fakeCutter(1000, cuts), transcriber, feed }).find(ctx({ resumeS: 650 }));
    expect(tracks).toEqual([{ url: feed.url, lang: 'en', label: WHISPER_LABEL, growing: true }]);
    await until(() => feed.completed === 1);
    expect(cuts).toEqual([600, 900, 300, 0]);
    expect(feed.cues.map((cue) => cue.start_s)).toEqual([601, 901, 301, 1]);
    expect(transcriber.stops).toBe(1);
  });

  it('answers before any stretch is transcribed', async () => {
    const controller = new AbortController();
    const transcriber = new FakeTranscriber();
    transcriber.gate = new Promise<void>(() => undefined);
    const feed = new FakeFeed();
    const tracks = await tier({ cutter: fakeCutter(1000, []), transcriber, feed }).find(ctx({ signal: controller.signal }));
    expect(tracks[0]?.growing).toBe(true);
    expect(feed.cues).toEqual([]);
    controller.abort();
    await until(() => transcriber.stops === 1);
  });

  it('transcribes an English title and translates any other into English', async () => {
    const english = new FakeTranscriber();
    await tier({ cutter: fakeCutter(300, []), transcriber: english }).find(ctx({ audioLang: 'en' }));
    await until(() => english.stops === 1);
    expect(english.requests.map((r) => [r.task, r.language])).toEqual([['transcribe', 'en']]);

    await rm(workDir, { recursive: true, force: true });
    const korean = new FakeTranscriber();
    await tier({ cutter: fakeCutter(300, []), transcriber: korean }).find(ctx({ audioLang: 'ko' }));
    await until(() => korean.stops === 1);
    expect(korean.requests.map((r) => [r.task, r.language])).toEqual([['translate', 'ko']]);
  });

  it('stops when the session releases the torrent, keeps what it made, and a later play carries on', async () => {
    const controller = new AbortController();
    const cuts: number[] = [];
    const feed = new FakeFeed();
    const transcriber = new FakeTranscriber();
    transcriber.onRequest = (n) => {
      if (n === 2) controller.abort();
    };
    await tier({ cutter: fakeCutter(1000, cuts), transcriber, feed }).find(ctx({ signal: controller.signal }));
    await until(() => transcriber.stops === 1);
    expect(cuts).toEqual([0, 300]);
    expect(feed.cues.map((cue) => cue.start_s)).toEqual([1]);
    expect(feed.completed).toBe(0);

    // notesd restarted: a new tier over the same folder, the same feed on disk.
    const cutsAgain: number[] = [];
    const again = new FakeTranscriber();
    await tier({ cutter: fakeCutter(1000, cutsAgain), transcriber: again, feed }).find(ctx());
    await until(() => feed.completed === 1);
    expect(cutsAgain).toEqual([300, 600, 900]);
    expect(feed.cues.map((cue) => cue.start_s)).toEqual([1, 301, 601, 901]);

    // Done to the end: a finished track, and nothing is cut or transcribed.
    const cutsDone: number[] = [];
    const tracks = await tier({ cutter: fakeCutter(1000, cutsDone), transcriber: new FakeTranscriber(), feed }).find(ctx());
    // Still a cue feed (growing: true); the page reads a finished feed once.
    expect(tracks).toEqual([{ url: feed.url, lang: 'en', label: WHISPER_LABEL, growing: true }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cutsDone).toEqual([]);
  });

  it('goes on while another session still plays the same file', async () => {
    const first = new AbortController();
    const second = new AbortController();
    const feed = new FakeFeed();
    const transcriber = new FakeTranscriber();
    transcriber.onRequest = (n) => {
      if (n === 1) first.abort();
    };
    const whisper = tier({ cutter: fakeCutter(900, []), transcriber, feed });
    await Promise.all([whisper.find(ctx({ signal: first.signal })), whisper.find(ctx({ signal: second.signal }))]);
    await until(() => feed.completed === 1);
    expect(feed.cues).toHaveLength(3);
  });

  it('finds the end of a film whose length the probe did not know', async () => {
    const cuts: number[] = [];
    const feed = new FakeFeed();
    await tier({ cutter: fakeCutter(700, cuts), transcriber: new FakeTranscriber(), feed }).find(ctx({ resumeS: 400, probe: { durationS: null } }));
    await until(() => feed.completed === 1);
    expect(cuts).toEqual([300, 600, 0]);
    expect(feed.cues.map((cue) => cue.start_s)).toEqual([301, 601, 1]);
  });

  it('gives up after three failed stretches in a row and leaves the track growing', async () => {
    const cuts: number[] = [];
    const feed = new FakeFeed();
    const transcriber = new FakeTranscriber();
    await tier({ cutter: fakeCutter(1000, cuts, new Set([0, 300, 600, 900])), transcriber, feed }).find(ctx());
    await until(() => transcriber.stops === 1);
    expect(cuts).toEqual([0, 300, 600]);
    expect(feed.completed).toBe(0);
    expect(transcriber.requests).toEqual([]);
  });

  it('answers nothing, and never throws, when no feed can be opened', async () => {
    const tracks = await tier({ cutter: fakeCutter(1000, []), transcriber: new FakeTranscriber(), openFeed: async () => Promise.reject(new Error('no feed route')) }).find(ctx());
    expect(tracks).toEqual([]);
  });
});

describe('buildWhisperTier', () => {
  const rest = { torrentDir: '/nowhere', ffmpegBin: 'ffmpeg', fileUrl: () => 'http://127.0.0.1:1/f', openFeed: async () => new FakeFeed() };

  it('builds no tier, and says so, when Whisper is off or its Python is not installed', async () => {
    const lines: string[] = [];
    expect(await buildWhisperTier({ ...rest, whisper: { enabled: false }, log: (line) => lines.push(line) })).toBeNull();
    const missing = { enabled: true as const, dir: workDir, python: path.join(workDir, 'venv', 'bin', 'python'), model: 'small', threads: 2, stretchS: 300 };
    expect(await buildWhisperTier({ ...rest, whisper: missing, log: (line) => lines.push(line) })).toBeNull();
    expect(lines[0]).toMatch(/torrent whisper: off/);
    expect(lines[1]).toMatch(/torrent whisper: no Python at /);
  });

  it('builds the tier when its Python is there, starting no worker', async () => {
    const lines: string[] = [];
    const built = await buildWhisperTier({ ...rest, whisper: { enabled: true, dir: workDir, python: FAKE_WORKER, model: 'small', threads: 2, stretchS: 300 }, log: (line) => lines.push(line) });
    expect(built?.name).toBe('whisper');
    expect(lines).toEqual(['[notesd] torrent whisper: on (model small, 2 threads, 300 s stretches)']);
    await built?.close();
  });
});

describe('helpers', () => {
  it('whisperTask: English is transcribed, the rest translated', () => {
    expect(whisperTask('en')).toEqual({ task: 'transcribe', language: 'en' });
    expect(whisperTask('ko')).toEqual({ task: 'translate', language: 'ko' });
    expect(whisperTask('jpn')).toEqual({ task: 'translate', language: null });
    expect(whisperTask(null)).toEqual({ task: 'translate', language: null });
  });

  it('firstStretch: the stretch that holds the start, the last one past the end', () => {
    expect(firstStretch(650, 300, 1000)).toBe(600);
    expect(firstStretch(null, 300, 1000)).toBe(0);
    expect(firstStretch(1200, 300, 1000)).toBe(900);
    expect(firstStretch(1200, 300, null)).toBe(1200);
  });

  it('placeCues: film time, a cue at most 7 s', () => {
    expect(placeCues([{ start_s: 0.5, end_s: 20.5, text: 'long' }, { start_s: 2, end_s: 3.25, text: 'short' }], 300)).toEqual([
      { start_s: 300.5, end_s: 307.5, text: 'long' },
      { start_s: 302, end_s: 303.25, text: 'short' },
    ]);
  });

  it('parseCues keeps only well-formed cues', () => {
    expect(parseCues([{ start_s: 1, end_s: 2, text: ' hi ' }, { start_s: 3, end_s: 2, text: 'back' }, { start_s: 'x', end_s: 2, text: 'y' }, null, { start_s: 4, end_s: 5, text: ' ' }])).toEqual([
      { start_s: 1, end_s: 2, text: 'hi' },
    ]);
    expect(parseCues('nope')).toEqual([]);
  });

  it('cutArgs: a ranged read of the route, the first audio stream, 16 kHz mono PCM', () => {
    const args = cutArgs({ url: 'http://127.0.0.1:7317/api/stream/torrent/x/f/0', startS: 300, lengthS: 300, out: '/tmp/s.wav' });
    expect(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 6)).toEqual(['-ss', '300', '-t', '300', '-i', 'http://127.0.0.1:7317/api/stream/torrent/x/f/0']);
    expect(args).toEqual(expect.arrayContaining(['-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le']));
    expect(args.at(-1)).toBe('/tmp/s.wav');
  });
});

describe('WorkerTranscriber (against the fake worker)', () => {
  async function wav(seconds: number): Promise<string> {
    const data = Buffer.alloc(Math.round(seconds * 32000));
    const head = Buffer.alloc(44);
    head.write('RIFF', 0, 'ascii');
    head.writeUInt32LE(36 + data.length, 4);
    head.write('WAVE', 8, 'ascii');
    head.write('fmt ', 12, 'ascii');
    head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20);
    head.writeUInt16LE(1, 22);
    head.writeUInt32LE(16000, 24);
    head.writeUInt32LE(32000, 28);
    head.writeUInt16LE(2, 32);
    head.writeUInt16LE(16, 34);
    head.write('data', 36, 'ascii');
    head.writeUInt32LE(data.length, 40);
    const file = path.join(workDir, `s-${seconds}.wav`);
    await writeFile(file, Buffer.concat([head, data]));
    return file;
  }

  function worker(env: Record<string, string> = {}): WorkerTranscriber {
    return new WorkerTranscriber({
      python: FAKE_WORKER,
      script: '/not/read/whisper.py',
      model: 'small',
      threads: 2,
      modelsDir: workDir,
      hfHome: workDir,
      env: { ...process.env, ...env },
      log: () => undefined,
    });
  }

  it('the fake worker is executable', async () => {
    expect((await stat(FAKE_WORKER)).mode & 0o111).not.toBe(0);
  });

  it('loads once and answers each stretch', async () => {
    const transcriber = worker();
    try {
      const signal = new AbortController().signal;
      const one = await transcriber.transcribe({ wav: await wav(5), task: 'transcribe', language: 'en' }, signal);
      const two = await transcriber.transcribe({ wav: await wav(3), task: 'translate', language: 'ko' }, signal);
      expect(one).toEqual([{ start_s: 0.5, end_s: 2.5, text: 'Whisper line 1 (transcribe, 5.0 s of audio)' }]);
      expect(two).toEqual([{ start_s: 0.5, end_s: 2.5, text: 'Whisper line 2 (translate, 3.0 s of audio)' }]);
    } finally {
      await transcriber.stop();
    }
  });

  it('a stretch the worker cannot do rejects with its reason', async () => {
    const transcriber = worker({ FAKE_WHISPER_MODE: 'error' });
    try {
      await expect(transcriber.transcribe({ wav: await wav(2), task: 'transcribe', language: 'en' }, new AbortController().signal)).rejects.toThrow(/told to fail/);
    } finally {
      await transcriber.stop();
    }
  });

  it('a worker that cannot load rejects with why', async () => {
    const transcriber = worker({ FAKE_WHISPER_MODE: 'not_ready' });
    await expect(transcriber.transcribe({ wav: await wav(2), task: 'transcribe', language: 'en' }, new AbortController().signal)).rejects.toThrow(/cannot be imported/);
    await transcriber.stop();
  });

  it('a dropped stretch rejects at once, and stop rejects what still waits', async () => {
    const log = path.join(workDir, 'requests.jsonl');
    const transcriber = worker({ FAKE_WHISPER_DELAY_MS: '5000', FAKE_WHISPER_LOG: log });
    const controller = new AbortController();
    const dropped = transcriber.transcribe({ wav: await wav(2), task: 'transcribe', language: 'en' }, controller.signal);
    // Wait until the fake has the request, then drop it.
    await until(() => existsSync(log), 5000);
    controller.abort();
    await expect(dropped).rejects.toThrow();
    const waiting = transcriber.transcribe({ wav: await wav(2), task: 'transcribe', language: 'en' }, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await transcriber.stop();
    await expect(waiting).rejects.toThrow(/stopped/);
    expect((await readFile(log, 'utf8')).trim().split('\n').length).toBeGreaterThanOrEqual(1);
  });
});
