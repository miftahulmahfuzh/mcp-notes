import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseTranscript } from '../../../claude/hooks/lib/transcript.mjs';
import {
  CONTEXT_HEADER,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MEMO_MAX_AGE_MS,
  TOOLS_HINT,
  TRANSCRIPT_POLL_MS,
  TRANSCRIPT_WAIT_MS,
  buildContext,
  imagesSettled,
  isNotesPromptInput,
  placeholderNumbers,
  runPrompt,
  selectForContext,
  type FetchLike,
  type PromptImage,
} from '../../../claude/hooks/notes-prompt.mjs';
import { RED_PNG_16, SESSION, assistantText, commandEntry, imagePromptEntry, jsonl, plainPromptEntry } from './fixtures.js';

const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../claude/hooks/notes-prompt.mjs');

let tmp: string;
let transcript: string;
let env: Record<string, string>;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'notes-prompt-'));
  transcript = path.join(tmp, 's.jsonl');
  env = { HOME: tmp, XDG_STATE_HOME: path.join(tmp, 'state'), NOTESD_PORT: '7499' };
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const stateRoot = (): string => path.join(tmp, 'state', 'notes-capture');
const memoDir = (): string => path.join(stateRoot(), 'prompt-images');
const memoPath = (): string => path.join(memoDir(), `${SESSION}.json`);
const logPath = (): string => path.join(stateRoot(), 'prompt.log');

/** Distinct fake picture bytes (the hook never decodes them). */
const pic = (label: string): string => Buffer.from(`pasted-picture-${label}`).toString('base64');
const A = pic('a');
const B = pic('b');
const C = pic('c');

function png(data: string): { media_type: string; data: string } {
  return { media_type: 'image/png', data };
}

interface Daemon {
  fetchImpl: FetchLike;
  uploads: string[];
  urls: string[];
  sources: unknown[];
}

/** A fake POST /api/chat/images: answers {id} by the uploaded bytes, 500 for `fail`, 415 for unknown bytes. */
function fakeDaemon(ids: Record<string, string>, opts: { fail?: Set<string>; onUpload?: () => void; throws?: boolean } = {}): Daemon {
  const uploads: string[] = [];
  const urls: string[] = [];
  const sources: unknown[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    if (opts.throws === true) throw new TypeError('fetch failed');
    const form = init.body as FormData;
    const file = form.get('file') as File;
    const data = Buffer.from(await file.arrayBuffer()).toString('base64');
    uploads.push(data);
    urls.push(url);
    sources.push(form.get('source'));
    opts.onUpload?.();
    if (opts.fail?.has(data) === true) return new Response('{"error":"boom"}', { status: 500 });
    const id = ids[data];
    if (id === undefined) return new Response('{"error":"unknown"}', { status: 415 });
    return new Response(JSON.stringify({ id }), { status: 201 });
  };
  return { fetchImpl, uploads, urls, sources };
}

/** A fake clock: `sleep` advances it, so polling loops run instantly. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; advance: (ms: number) => void } {
  let t = Date.now();
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function hookInput(prompt: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: SESSION,
    transcript_path: transcript,
    cwd: '/tmp/notes-demo',
    permission_mode: 'default',
    hook_event_name: 'UserPromptSubmit',
    prompt,
    ...extra,
  };
}

function contextOf(out: unknown): string {
  const output = out as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
  return output.hookSpecificOutput.additionalContext;
}

describe('pure helpers', () => {
  it('isNotesPromptInput takes only /n prompts', () => {
    expect(isNotesPromptInput({ prompt: '/n save that image' })).toBe(true);
    expect(isNotesPromptInput({ prompt: '/n' })).toBe(true);
    expect(isNotesPromptInput({ prompt: 'hello' })).toBe(false);
    expect(isNotesPromptInput({ prompt: '/notes' })).toBe(false);
    expect(isNotesPromptInput({ prompt: 3 })).toBe(false);
    expect(isNotesPromptInput(null)).toBe(false);
  });

  it('placeholderNumbers returns the distinct [Image #N] numbers ascending', () => {
    expect(placeholderNumbers('/n save [Image #3] and [Image #1] [Image #3]')).toEqual([1, 3]);
    expect(placeholderNumbers('/n no pictures')).toEqual([]);
  });

  it('imagesSettled looks at the last human prompt and its paste ids', () => {
    const older = imagePromptEntry('x [Image #1]', [png(A)], [1]);
    const current = imagePromptEntry('/n y [Image #2]', [png(B)], [2]);
    expect(imagesSettled(parseTranscript(jsonl([older])), [])).toBe(true);
    expect(imagesSettled(parseTranscript(jsonl([older])), [2])).toBe(false);
    expect(imagesSettled(parseTranscript(jsonl([older, assistantText('ok'), current, assistantText('…')])), [2])).toBe(true);
    expect(imagesSettled(parseTranscript(jsonl([older, plainPromptEntry('later')])), [1])).toBe(false);
  });

  it('selectForContext keeps the caps: type, 20 MB each, 48 MB base64 for uploads only, 8 overall', () => {
    const big = 'A'.repeat(26_000_000);
    const tooBig = 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8);
    const c = (key: string, data: string, media = 'image/png', paste = 1): PromptImage => ({ key, media_type: media, data_base64: data, paste_id: paste });
    expect(selectForContext([c('u:0', A), c('u:1', A, 'image/bmp')], new Map()).map((s) => s.key)).toEqual(['u:0']);
    expect(selectForContext([c('u:0', A), c('u:1', tooBig)], new Map()).map((s) => s.key)).toEqual(['u:0']);
    expect(selectForContext([c('u:0', big), c('u:1', big)], new Map()).map((s) => s.key)).toEqual(['u:1']);
    const withMemo = selectForContext([c('u:0', big), c('u:1', big)], new Map([['u:0', 'G-AAA']]));
    expect(withMemo.map((s) => [s.key, s.id])).toEqual([
      ['u:1', null],
      ['u:0', 'G-AAA'],
    ]);
    const many = Array.from({ length: 12 }, (_, i) => c(`u:${i}`, pic(String(i)), 'image/png', i + 1));
    const picked = selectForContext(many, new Map());
    expect(picked).toHaveLength(MAX_IMAGES);
    expect(picked.map((s) => s.order)).toEqual([11, 10, 9, 8, 7, 6, 5, 4]);
  });

  it('buildContext dedupes ids, marks the latest, or says the latest is missing', () => {
    expect(buildContext([], null)).toBeNull();
    expect(
      buildContext(
        [
          { paste_id: 1, id: 'G-0NC' },
          { paste_id: 2, id: 'G-AAA' },
          { paste_id: 3, id: 'G-0NC' },
        ],
        null,
      ),
    ).toBe(
      [
        `${CONTEXT_HEADER}[Image #2] = G-AAA; [Image #3] = G-0NC (latest).`,
        '"That image" or "this image" means the latest one, G-0NC, unless the user names another id or [Image #N].',
        TOOLS_HINT,
      ].join('\n'),
    );
    const missing = buildContext([{ paste_id: 1, id: 'G-AAA' }], { paste_id: null });
    expect(missing).toContain('The latest pasted image could not be stored');
    expect(missing).not.toContain('(latest)');
  });
});

describe('runPrompt: not /n', () => {
  it('does no I/O at all and returns null', async () => {
    let reads = 0;
    let fetches = 0;
    let ticks = 0;
    const io = {
      readText: async (): Promise<string> => {
        reads += 1;
        return '';
      },
      fetchImpl: (async () => {
        fetches += 1;
        return new Response('{}');
      }) as FetchLike,
      sleep: async (): Promise<void> => {
        ticks += 1;
      },
      now: (): number => {
        ticks += 1;
        return 0;
      },
    };
    for (const input of [hookInput('hello'), hookInput('/notes list'), hookInput('please /n save'), hookInput(''), { prompt: 1 }, {}, null, 'text']) {
      expect(await runPrompt({ input, env, ...io })).toBeNull();
    }
    expect(reads).toBe(0);
    expect(fetches).toBe(0);
    expect(ticks).toBe(0);
    expect(existsSync(path.join(tmp, 'state'))).toBe(false);
  });
});

describe('runPrompt: /n', () => {
  it('stores the image pasted with /n and names it as the latest', async () => {
    const entry = imagePromptEntry('/n make that image a new note\n[Image #1]', [png(RED_PNG_16)]);
    await writeFile(transcript, jsonl([entry]));
    const daemon = fakeDaemon({ [RED_PNG_16]: 'G-0NC' });
    const clock = fakeClock();
    const out = await runPrompt({ input: hookInput('/n make that image a new note\n[Image #1]'), env, fetchImpl: daemon.fetchImpl, ...clock });
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: [
          `${CONTEXT_HEADER}[Image #1] = G-0NC (latest).`,
          '"That image" or "this image" means the latest one, G-0NC, unless the user names another id or [Image #N].',
          TOOLS_HINT,
        ].join('\n'),
      },
    });
    expect(daemon.urls).toEqual(['http://127.0.0.1:7499/api/chat/images']);
    expect(daemon.sources).toEqual(['claude_code']);
    expect(JSON.parse(await readFile(memoPath(), 'utf8'))).toEqual({ [`${String(entry.uuid)}:0`]: 'G-0NC' });
  });

  it('back-fills pictures from earlier non-/n turns, uploading newest first', async () => {
    await writeFile(
      transcript,
      jsonl([
        imagePromptEntry('look at these [Image #1] [Image #2]', [png(A), png(B)], [1, 2]),
        assistantText('Nice.'),
        plainPromptEntry('thanks'),
        assistantText('Any time.'),
        commandEntry('make the second image a note'),
      ]),
    );
    const daemon = fakeDaemon({ [A]: 'G-AAA', [B]: 'G-BBB' });
    const out = await runPrompt({ input: hookInput('/n make the second image a note'), env, fetchImpl: daemon.fetchImpl, ...fakeClock() });
    expect(daemon.uploads).toEqual([B, A]);
    expect(contextOf(out).split('\n')[0]).toBe(`${CONTEXT_HEADER}[Image #1] = G-AAA; [Image #2] = G-BBB (latest).`);
  });

  it('the memo prevents a second upload of the same pictures', async () => {
    await writeFile(transcript, jsonl([imagePromptEntry('/n save [Image #1] [Image #2]', [png(A), png(B)])]));
    const daemon = fakeDaemon({ [A]: 'G-AAA', [B]: 'G-BBB' });
    const first = await runPrompt({ input: hookInput('/n save [Image #1] [Image #2]'), env, fetchImpl: daemon.fetchImpl, ...fakeClock() });
    const second = await runPrompt({ input: hookInput('/n save [Image #1] [Image #2]'), env, fetchImpl: daemon.fetchImpl, ...fakeClock() });
    expect(daemon.uploads).toHaveLength(2);
    expect(second).toEqual(first);
  });

  it('waits for a lagging transcript until the current prompt\'s picture is written', async () => {
    const older = imagePromptEntry('look [Image #1]', [png(A)], [1]);
    const current = imagePromptEntry('/n save this [Image #2]', [png(B)], [2]);
    const texts = [jsonl([older, assistantText('ok')]), jsonl([older, assistantText('ok')]), jsonl([older, assistantText('ok'), current])];
    let reads = 0;
    const readText = async (): Promise<string> => texts[Math.min(reads++, texts.length - 1)]!;
    const daemon = fakeDaemon({ [A]: 'G-AAA', [B]: 'G-BBB' });
    const out = await runPrompt({ input: hookInput('/n save this [Image #2]'), env, fetchImpl: daemon.fetchImpl, readText, ...fakeClock() });
    expect(reads).toBe(3);
    expect(contextOf(out).split('\n')[0]).toBe(`${CONTEXT_HEADER}[Image #1] = G-AAA; [Image #2] = G-BBB (latest).`);
  });

  it('never calls an older picture the latest when the current one never shows up', async () => {
    const older = imagePromptEntry('look [Image #1]', [png(A)], [1]);
    let reads = 0;
    const readText = async (): Promise<string> => {
      reads += 1;
      return jsonl([older, assistantText('ok')]);
    };
    const daemon = fakeDaemon({ [A]: 'G-AAA' });
    const out = await runPrompt({ input: hookInput('/n save this [Image #2]'), env, fetchImpl: daemon.fetchImpl, readText, ...fakeClock() });
    expect(reads).toBe(TRANSCRIPT_WAIT_MS / TRANSCRIPT_POLL_MS + 1);
    const context = contextOf(out);
    expect(context.split('\n')[0]).toBe(`${CONTEXT_HEADER}[Image #1] = G-AAA.`);
    expect(context).toContain('The latest pasted image ([Image #2]) could not be stored');
    expect(context).not.toContain('(latest)');
    expect(await readFile(logPath(), 'utf8')).toContain('[Image #2] not in the transcript');
  });

  it('says the latest could not be stored when its upload fails, and marks no older one', async () => {
    await writeFile(transcript, jsonl([imagePromptEntry('/n save [Image #1] [Image #2]', [png(A), png(B)])]));
    const daemon = fakeDaemon({ [A]: 'G-AAA', [B]: 'G-BBB' }, { fail: new Set([B]) });
    const out = await runPrompt({ input: hookInput('/n save [Image #1] [Image #2]'), env, fetchImpl: daemon.fetchImpl, ...fakeClock() });
    const context = contextOf(out);
    expect(context.split('\n')[0]).toBe(`${CONTEXT_HEADER}[Image #1] = G-AAA.`);
    expect(context).toContain('([Image #2]) could not be stored');
    expect(context).not.toContain('(latest)');
    expect(await readFile(logPath(), 'utf8')).toContain('image #2: Error: upload failed: HTTP 500');
    const memo = JSON.parse(await readFile(memoPath(), 'utf8')) as Record<string, string>;
    expect(Object.values(memo)).toEqual(['G-AAA']);
  });

  it('a newest picture outside the caps (bmp) is reported missing, not skipped silently', async () => {
    await writeFile(transcript, jsonl([imagePromptEntry('/n save [Image #1] [Image #2]', [png(A), { media_type: 'image/bmp', data: B }])]));
    const daemon = fakeDaemon({ [A]: 'G-AAA', [B]: 'G-BBB' });
    const out = await runPrompt({ input: hookInput('/n save [Image #1] [Image #2]'), env, fetchImpl: daemon.fetchImpl, ...fakeClock() });
    expect(daemon.uploads).toEqual([A]);
    expect(contextOf(out)).toContain('([Image #2]) could not be stored');
  });

  it('names at most 8 pictures, the newest, across turns', async () => {
    const data = Array.from({ length: 10 }, (_, i) => pic(`n${i}`));
    const ids = Object.fromEntries(data.map((d, i) => [d, `G-00${i}`]));
    await writeFile(
      transcript,
      jsonl([
        imagePromptEntry('first five', data.slice(0, 5).map(png), [1, 2, 3, 4, 5]),
        assistantText('ok'),
        imagePromptEntry('five more', data.slice(5).map(png), [6, 7, 8, 9, 10]),
        assistantText('ok'),
        commandEntry('save the last one'),
      ]),
    );
    const daemon = fakeDaemon(ids);
    const out = await runPrompt({ input: hookInput('/n save the last one'), env, fetchImpl: daemon.fetchImpl, ...fakeClock() });
    expect(daemon.uploads).toEqual(data.slice(2).reverse());
    expect(contextOf(out).split('\n')[0]).toBe(
      `${CONTEXT_HEADER}${[3, 4, 5, 6, 7, 8, 9].map((n) => `[Image #${n}] = G-00${n - 1}`).join('; ')}; [Image #10] = G-009 (latest).`,
    );
  });

  it('the same bytes pasted twice are named once, by their newest paste', async () => {
    await writeFile(
      transcript,
      jsonl([imagePromptEntry('a [Image #1] [Image #2]', [png(RED_PNG_16), png(A)], [1, 2]), assistantText('ok'), imagePromptEntry('/n again [Image #3]', [png(RED_PNG_16)], [3])]),
    );
    const daemon = fakeDaemon({ [RED_PNG_16]: 'G-0NC', [A]: 'G-AAA' });
    const out = await runPrompt({ input: hookInput('/n again [Image #3]'), env, fetchImpl: daemon.fetchImpl, ...fakeClock() });
    expect(contextOf(out).split('\n')[0]).toBe(`${CONTEXT_HEADER}[Image #2] = G-AAA; [Image #3] = G-0NC (latest).`);
  });

  it('stops uploading when the time budget is spent, newest stored first', async () => {
    await writeFile(transcript, jsonl([imagePromptEntry('/n save [Image #1] [Image #2] [Image #3]', [png(A), png(B), png(C)])]));
    const clock = fakeClock();
    const daemon = fakeDaemon({ [A]: 'G-AAA', [B]: 'G-BBB', [C]: 'G-CCC' }, { onUpload: () => clock.advance(5000) });
    const out = await runPrompt({ input: hookInput('/n save [Image #1] [Image #2] [Image #3]'), env, fetchImpl: daemon.fetchImpl, ...clock });
    expect(daemon.uploads).toEqual([C, B]);
    expect(contextOf(out).split('\n')[0]).toBe(`${CONTEXT_HEADER}[Image #2] = G-BBB; [Image #3] = G-CCC (latest).`);
    expect(await readFile(logPath(), 'utf8')).toContain('upload budget spent; 1 pasted image(s) not stored');
  });

  it('returns null when nothing could be stored (daemon down) or there are no pictures', async () => {
    await writeFile(transcript, jsonl([imagePromptEntry('/n save [Image #1]', [png(A)])]));
    const down = fakeDaemon({}, { throws: true });
    expect(await runPrompt({ input: hookInput('/n save [Image #1]'), env, fetchImpl: down.fetchImpl, ...fakeClock() })).toBeNull();
    expect(await readFile(logPath(), 'utf8')).toContain('image #1: TypeError: fetch failed');
    await writeFile(transcript, jsonl([commandEntry('list my notes')]));
    const daemon = fakeDaemon({});
    expect(await runPrompt({ input: hookInput('/n list my notes'), env, fetchImpl: daemon.fetchImpl, ...fakeClock() })).toBeNull();
    expect(daemon.uploads).toEqual([]);
  });

  it('returns null and logs when the transcript is missing or unreadable', async () => {
    const daemon = fakeDaemon({});
    let reads = 0;
    const readText = async (): Promise<string> => {
      reads += 1;
      throw new Error('ENOENT');
    };
    expect(await runPrompt({ input: hookInput('/n save it'), env, fetchImpl: daemon.fetchImpl, readText, ...fakeClock() })).toBeNull();
    expect(reads).toBe(TRANSCRIPT_WAIT_MS / TRANSCRIPT_POLL_MS + 1);
    expect(await runPrompt({ input: hookInput('/n save it', { transcript_path: undefined }), env, fetchImpl: daemon.fetchImpl, ...fakeClock() })).toBeNull();
    const log = await readFile(logPath(), 'utf8');
    expect(log).toContain('transcript unreadable');
    expect(log).toContain('no transcript_path');
  });

  it('prunes memo files older than 14 days and keeps fresh ones', async () => {
    await mkdir(memoDir(), { recursive: true });
    const old = path.join(memoDir(), 'old-session.json');
    const fresh = path.join(memoDir(), 'fresh-session.json');
    await writeFile(old, '{}');
    await writeFile(fresh, '{}');
    const past = new Date(Date.now() - MEMO_MAX_AGE_MS - 60_000);
    await utimes(old, past, past);
    await writeFile(transcript, jsonl([imagePromptEntry('/n save [Image #1]', [png(A)])]));
    await runPrompt({ input: hookInput('/n save [Image #1]'), env, fetchImpl: fakeDaemon({ [A]: 'G-AAA' }).fetchImpl, ...fakeClock() });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(memoPath())).toBe(true);
  });

  it('an unsafe session id still answers but keeps no memo', async () => {
    await writeFile(transcript, jsonl([imagePromptEntry('/n save [Image #1]', [png(A)])]));
    const out = await runPrompt({
      input: hookInput('/n save [Image #1]', { session_id: '../escape' }),
      env,
      fetchImpl: fakeDaemon({ [A]: 'G-AAA' }).fetchImpl,
      ...fakeClock(),
    });
    expect(contextOf(out)).toContain('[Image #1] = G-AAA (latest)');
    expect(existsSync(memoDir())).toBe(false);
  });
});

describe('notes-prompt.mjs as a process', () => {
  function runHook(stdin: string, extraEnv: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [HOOK], { env: { ...process.env, ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(stdin);
    });
  }

  it('prints nothing and touches no state for a prompt that is not /n', async () => {
    const run = await runHook(JSON.stringify(hookInput('what is the weather')));
    expect(run).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(existsSync(path.join(tmp, 'state'))).toBe(false);
  });

  it('prints exactly one JSON line with the context on /n', async () => {
    await writeFile(transcript, jsonl([imagePromptEntry('/n save that [Image #1]', [png(RED_PNG_16)])]));
    let hits = 0;
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        hits += 1;
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'G-0NC', created: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const run = await runHook(JSON.stringify(hookInput('/n save that [Image #1]')), { NOTESD_PORT: String(port) });
      expect(run.code).toBe(0);
      expect(run.stderr).toBe('');
      const lines = run.stdout.split('\n').filter((line) => line !== '');
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]!) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
      expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('[Image #1] = G-0NC (latest)');
      expect(hits).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('exits 0 with empty stdout when the daemon is down, and logs', async () => {
    await writeFile(transcript, jsonl([imagePromptEntry('/n save that [Image #1]', [png(RED_PNG_16)])]));
    const run = await runHook(JSON.stringify(hookInput('/n save that [Image #1]')), { NOTESD_PORT: '1' });
    expect(run).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(await readFile(logPath(), 'utf8')).toContain('image #1:');
  });

  it('exits 0 with empty stdout on garbage stdin', async () => {
    const run = await runHook('{ not json');
    expect(run).toEqual({ code: 0, stdout: '', stderr: '' });
    expect((await readdir(stateRoot())).includes('prompt.log')).toBe(true);
  });
});
