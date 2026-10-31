import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OUTBOX_MAX_PER_RUN,
  runCapture,
  spool,
  type CapturePayload,
  type FetchLike,
} from '../../../claude/hooks/notes-capture.mjs';
import { RED_PNG_16, SESSION, assistantText, commandEntry, imagePromptEntry, jsonl, plainPromptEntry, skillBodyEntry } from './fixtures.js';

let tmp: string;
let env: Record<string, string>;
let transcript: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'notes-capture-'));
  env = { HOME: tmp, XDG_STATE_HOME: path.join(tmp, 'state'), NOTESD_PORT: '7499' };
  transcript = path.join(tmp, 'session.jsonl');
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const outbox = (): string => path.join(tmp, 'state', 'notes-capture', 'outbox');
const logFile = (): string => path.join(tmp, 'state', 'notes-capture', 'capture.log');

async function outboxFiles(): Promise<string[]> {
  try {
    return (await readdir(outbox())).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
  } catch {
    return [];
  }
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: CapturePayload;
}

function fakeFetch(responder: (call: Call, n: number) => Response | Promise<Response>): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const call: Call = {
      url,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: JSON.parse(String(init.body)) as CapturePayload,
    };
    calls.push(call);
    return responder(call, calls.length);
  };
  return { fetchImpl, calls };
}

const created = (): Response => new Response(JSON.stringify({ thread_id: 't', user_message_id: 'U', assistant_message_id: 'A' }), { status: 201 });
const down = (): never => {
  throw new TypeError('fetch failed');
};

function fakeClock(start = Date.parse('2026-10-31T01:00:00.000Z')): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

function input(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { session_id: SESSION, transcript_path: transcript, cwd: '/tmp/notes-demo', hook_event_name: 'Stop', ...extra };
}

function payload(uuid: string): CapturePayload {
  return {
    claude_session: SESSION,
    user_uuid: uuid,
    prompt: '/n x',
    answer: 'y',
    prompt_timestamp: '2026-10-30T11:53:23.611Z',
    answered_at: '2026-10-30T11:53:30.000Z',
    cwd: null,
    images: [],
  };
}

describe('runCapture', () => {
  it('posts a /n turn with the typed prompt, the final answer, timestamps and the header', async () => {
    const prompt = commandEntry('show me the notes tagged #agentic');
    await writeFile(transcript, jsonl([prompt, skillBodyEntry(), assistantText('Two notes: A-B32, C-D45.')]));
    const { fetchImpl, calls } = fakeFetch(() => created());
    const clock = fakeClock();
    const result = await runCapture({ input: input({ last_assistant_message: 'Two notes: A-B32, C-D45.' }), env, fetchImpl, ...clock });
    expect(result.outcome).toBe('delivered');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:7499/api/capture/claude-code');
    expect(calls[0]!.headers['x-notes-capture']).toBe('1');
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(calls[0]!.body).toEqual({
      claude_session: SESSION,
      user_uuid: prompt.uuid,
      prompt: '/n show me the notes tagged #agentic',
      answer: 'Two notes: A-B32, C-D45.',
      prompt_timestamp: prompt.timestamp,
      answered_at: '2026-10-31T01:00:00.000Z',
      cwd: '/tmp/notes-demo',
      images: [],
    });
    expect(await outboxFiles()).toEqual([]);
  });

  it('sends pasted images, at most 8, supported types only', async () => {
    const images = [
      { media_type: 'image/svg+xml', data: 'PHN2Zz4=' },
      ...Array.from({ length: 9 }, () => ({ media_type: 'image/png', data: RED_PNG_16 })),
    ];
    await writeFile(transcript, jsonl([imagePromptEntry('/n like this [Image #1]', images), assistantText('Found 3.')]));
    const { fetchImpl, calls } = fakeFetch(() => created());
    await runCapture({ input: input({ last_assistant_message: 'Found 3.' }), env, fetchImpl, ...fakeClock() });
    expect(calls[0]!.body.images).toHaveLength(8);
    expect(calls[0]!.body.images.every((i) => i.media_type === 'image/png' && i.data_base64 === RED_PNG_16)).toBe(true);
  });

  it('ignores a turn that is not /n (no POST, nothing spooled)', async () => {
    await writeFile(transcript, jsonl([plainPromptEntry('fix the build'), assistantText('done')]));
    const { fetchImpl, calls } = fakeFetch(() => created());
    const result = await runCapture({ input: input({ last_assistant_message: 'done' }), env, fetchImpl, ...fakeClock() });
    expect(result.outcome).toBe('skipped');
    expect(calls).toHaveLength(0);
    expect(await outboxFiles()).toEqual([]);
  });

  it('waits for a lagging transcript and takes the answer from last_assistant_message', async () => {
    const prompt = commandEntry('x');
    await writeFile(transcript, jsonl([prompt]));
    const clock = fakeClock();
    let reads = 0;
    const readText = async (file: string): Promise<string> => {
      reads += 1;
      if (reads === 3) await writeFile(transcript, jsonl([prompt, assistantText('The final answer.')]));
      return readFile(file, 'utf8');
    };
    const { fetchImpl, calls } = fakeFetch(() => created());
    await runCapture({ input: input({ last_assistant_message: 'The final answer.' }), env, fetchImpl, readText, ...clock });
    expect(reads).toBe(3);
    expect(calls[0]!.body.answer).toBe('The final answer.');
  });

  it('uses the transcript answer when the hook input has none', async () => {
    await writeFile(transcript, jsonl([commandEntry('x'), assistantText('From the transcript.')]));
    const { fetchImpl, calls } = fakeFetch(() => created());
    await runCapture({ input: input(), env, fetchImpl, ...fakeClock() });
    expect(calls[0]!.body.answer).toBe('From the transcript.');
  });

  it('gives up waiting after 3 s and still captures', async () => {
    await writeFile(transcript, jsonl([commandEntry('x')]));
    const clock = fakeClock();
    const start = clock.now();
    const { fetchImpl, calls } = fakeFetch(() => created());
    await runCapture({ input: input({ last_assistant_message: 'never written' }), env, fetchImpl, ...clock });
    expect(clock.now() - start).toBeGreaterThanOrEqual(3000);
    expect(clock.now() - start).toBeLessThan(3500);
    expect(calls[0]!.body.answer).toBe('never written');
  });

  it('a missing transcript posts nothing and does not throw', async () => {
    const { fetchImpl, calls } = fakeFetch(() => created());
    const result = await runCapture({ input: input({ last_assistant_message: 'x' }), env, fetchImpl, ...fakeClock() });
    expect(result.outcome).toBe('skipped');
    expect(calls).toHaveLength(0);
  });

  it('daemon down: spools to the outbox (0600), and a later run delivers it', async () => {
    const prompt = commandEntry('remember me');
    await writeFile(transcript, jsonl([prompt, assistantText('ok')]));
    const first = await runCapture({ input: input({ last_assistant_message: 'ok' }), env, fetchImpl: fakeFetch(down).fetchImpl, ...fakeClock() });
    expect(first.outcome).toBe('spooled');
    expect(await outboxFiles()).toEqual([`${String(prompt.uuid)}.json`]);
    const file = path.join(outbox(), `${String(prompt.uuid)}.json`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8')).prompt).toBe('/n remember me');

    await writeFile(transcript, jsonl([prompt, assistantText('ok'), plainPromptEntry('unrelated'), assistantText('sure')]));
    const { fetchImpl, calls } = fakeFetch(() => created());
    const second = await runCapture({ input: input({ last_assistant_message: 'sure' }), env, fetchImpl, ...fakeClock() });
    expect(second.outcome).toBe('skipped');
    expect(second.drained.delivered).toBe(1);
    expect(calls.map((c) => c.body.user_uuid)).toEqual([prompt.uuid]);
    expect(await outboxFiles()).toEqual([]);
  });

  it('removes on 200 duplicate, keeps on 503/429/404, drops and logs on 400', async () => {
    const cases: [number, boolean][] = [[200, false], [503, true], [429, true], [404, true], [400, false]];
    for (const [status, kept] of cases) {
      await rm(outbox(), { recursive: true, force: true });
      await spool(outbox(), payload(`u-${status}`));
      const { fetchImpl } = fakeFetch(() => new Response('{"error":"x"}', { status }));
      await runCapture({ input: {}, env, fetchImpl, ...fakeClock() });
      expect(await outboxFiles()).toEqual(kept ? [`u-${status}.json`] : []);
    }
    expect(await readFile(logFile(), 'utf8')).toMatch(/drop u-400\.json: HTTP 400/);
  });

  it('stops draining at the first network failure', async () => {
    for (const id of ['a1', 'a2', 'a3']) await spool(outbox(), payload(id));
    const { fetchImpl, calls } = fakeFetch(down);
    const result = await runCapture({ input: {}, env, fetchImpl, ...fakeClock() });
    expect(calls).toHaveLength(1);
    expect(result.drained).toMatchObject({ kept: 3, stoppedEarly: true });
    expect(await outboxFiles()).toHaveLength(3);
  });

  it(`attempts at most ${OUTBOX_MAX_PER_RUN} files per run, oldest first`, async () => {
    const t0 = Date.now() / 1000 - 3600;
    for (let i = 0; i < 25; i += 1) {
      const file = await spool(outbox(), payload(`f${String(i).padStart(2, '0')}`));
      await utimes(file, t0 + i, t0 + i);
    }
    const { fetchImpl, calls } = fakeFetch(() => created());
    const result = await runCapture({ input: {}, env, fetchImpl, now: Date.now, sleep: async () => undefined });
    expect(calls).toHaveLength(OUTBOX_MAX_PER_RUN);
    expect(calls[0]!.body.user_uuid).toBe('f00');
    expect(result.drained).toMatchObject({ delivered: 20, kept: 5 });
    expect(await outboxFiles()).toEqual(['f20.json', 'f21.json', 'f22.json', 'f23.json', 'f24.json']);
  });

  it('drops outbox files older than 14 days without posting them', async () => {
    const file = await spool(outbox(), payload('old'));
    const fifteenDaysAgo = Date.now() / 1000 - 15 * 86_400;
    await utimes(file, fifteenDaysAgo, fifteenDaysAgo);
    const { fetchImpl, calls } = fakeFetch(() => created());
    await runCapture({ input: {}, env, fetchImpl, now: Date.now, sleep: async () => undefined });
    expect(calls).toHaveLength(0);
    expect(await outboxFiles()).toEqual([]);
    expect(await readFile(logFile(), 'utf8')).toMatch(/drop old\.json: older than 14 days/);
  });

  it('a replayed turn reuses the same outbox name (idempotent spool)', async () => {
    const prompt = commandEntry('again');
    await writeFile(transcript, jsonl([prompt, assistantText('ok')]));
    const { fetchImpl } = fakeFetch(down);
    await runCapture({ input: input({ last_assistant_message: 'ok' }), env, fetchImpl, ...fakeClock() });
    await runCapture({ input: input({ last_assistant_message: 'ok' }), env, fetchImpl, ...fakeClock() });
    expect(await outboxFiles()).toEqual([`${String(prompt.uuid)}.json`]);
  });
});
