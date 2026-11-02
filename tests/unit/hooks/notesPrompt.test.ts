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
  MAX_NODE_CONTEXT_CHARS,
  MAX_NODE_IDS,
  MEMO_MAX_AGE_MS,
  NODE_ID_CANDIDATE,
  NODE_CONTEXT_HEADER,
  NODE_TOOLS_HINT,
  TOOLS_HINT,
  TRANSCRIPT_POLL_MS,
  TRANSCRIPT_WAIT_MS,
  buildNodeContext,
  buildPendingContext,
  buildContext,
  imagesSettled,
  isNotesPromptInput,
  nodeIdCandidates,
  parseNodeContext,
  placeholderNumbers,
  runPrompt,
  selectForContext,
  type FetchLike,
  type PromptImage,
} from '../../../claude/hooks/notes-prompt.mjs';
import { NODE_ID_CANDIDATE_SOURCE, findNodeIdCandidates } from '../../../src/sessions/ids.js';
import { CONTEXT_HEADER as SERVER_CONTEXT_HEADER } from '../../../src/sessions/view.js';
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

/** Prompts with 2-2 dashed tokens that are NOT node-id candidates. */
const NEAR_MISSES = [
  'released on 2026-11-02',
  'meet at 10:30-11:00',
  'bump to 1.12-RC1 then v1.2.3-RC',
  'lower case a0-3g',
  'note A-B32 and image G-0NC',
  'pages 10-15',
  'AB-CD-EF',
  'see /p/A0-3G and C:\\x\\A0-3G',
  'open A0-3G.md',
  'SHA-256 COVID-19 UATP-2960',
  'x A0-3GZ',
  '_A0-3G',
];

/** /api/sessions/context `nodes[]` rows in the shape Phase 7 serves (text as its formatContext renders it). */
const NODE_TEXT = [
  'Session A0-3G "orch-project-session-graph-p8" (repo mcp-notes, branch main, host wsl; 2026-11-01 09:00-10:00)',
  'Summary: Planned phase 8: node ids in prompts resolve to context.',
  'Plan docs: docs/plans/PROJECT_SESSION_GRAPH_PLAN.md',
  'Commits: 8c259df chore(CLAUDE): add shortcut',
  'Transcript: /home/u/.claude/projects/-home-u-mcp-notes/b7c1.jsonl (resume with: claude --resume b7c1a2d3-0000-4000-8000-000000000001)',
].join('\n');
const NODE: Record<string, unknown> = { node_id: 'A0-3G', session_id: 'b7c1a2d3-0000-4000-8000-000000000001', text: NODE_TEXT };

const OTHER_HOST_TEXT = [
  'Session B1-2C "B1-2C" (repo mcp-notes, host gpd; 2026-10-30 07:00-08:00)',
  'Summary: not summarized yet.',
  'Transcript: on gpd, not readable from this machine.',
].join('\n');
const OTHER_HOST_NODE: Record<string, unknown> = { node_id: 'B1-2C', session_id: 'c9d8e7f6-0000-4000-8000-000000000002', text: OTHER_HOST_TEXT };

const NODE_BLOCK = [NODE_CONTEXT_HEADER, '', NODE_TEXT].join('\n') + `\n${NODE_TOOLS_HINT}`;

interface ContextDaemon {
  fetchImpl: FetchLike;
  urls: string[];
  methods: string[];
}

/**
 * A fake GET /api/sessions/context: answers {nodes, missing, context} with the rows whose node_id
 * was asked for (`lax`: every row), `status` as an error, or throws. Other URLs go to `images`
 * (the chat image fake). `context` is built the way Phase 7 builds it.
 */
function fakeContextDaemon(
  rows: Array<Record<string, unknown>>,
  opts: { status?: number; throws?: boolean; lax?: boolean; images?: Daemon } = {},
): ContextDaemon {
  const urls: string[] = [];
  const methods: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    if (!url.includes('/api/sessions/context')) {
      if (opts.images !== undefined) return opts.images.fetchImpl(url, init);
      throw new Error(`unexpected fetch ${url}`);
    }
    urls.push(url);
    methods.push(String(init.method));
    if (opts.throws === true) throw new TypeError('fetch failed');
    if (opts.status !== undefined) return new Response('{"error":"nope"}', { status: opts.status });
    const asked = (new URL(url).searchParams.get('ids') ?? '').split(',');
    const nodes = opts.lax === true ? rows : asked.flatMap((id) => rows.filter((row) => row.node_id === id));
    const missing = asked.filter((id) => !rows.some((row) => row.node_id === id));
    const context = nodes.length === 0 ? '' : [NODE_CONTEXT_HEADER, ...nodes.map((row) => String(row.text))].join('\n\n');
    return new Response(JSON.stringify({ nodes, missing, context }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, urls, methods };
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

  it('reads the transcript once and points the model at pasted_image for a picture the transcript does not hold yet', async () => {
    const older = imagePromptEntry('look [Image #1]', [png(A)], [1]);
    let reads = 0;
    const readText = async (): Promise<string> => {
      reads += 1;
      return jsonl([older, assistantText('ok')]);
    };
    const daemon = fakeDaemon({ [A]: 'G-AAA' });
    const out = await runPrompt({ input: hookInput('/n save this [Image #2]'), env, fetchImpl: daemon.fetchImpl, readText, ...fakeClock() });
    expect(reads).toBe(1);
    const context = contextOf(out);
    expect(context.split('\n')[0]).toBe(`${CONTEXT_HEADER}[Image #1] = G-AAA.`);
    expect(context).toContain('The latest pasted image ([Image #2]) has no id yet');
    expect(context).toContain('call create_image with pasted_image 2');
    expect(context).toContain('Do not use an older image in its place.');
    expect(context).not.toContain('(latest)');
    expect(await readFile(logPath(), 'utf8')).toContain('[Image #2] not in the transcript yet');
  });

  it('a session whose only picture is in the current prompt gets the pasted_image advice, with or without a transcript', async () => {
    const daemon = fakeDaemon({});
    const noFile = async (): Promise<string> => {
      throw new Error('ENOENT');
    };
    const first = await runPrompt({ input: hookInput('/n save [Image #1]'), env, fetchImpl: daemon.fetchImpl, readText: noFile, ...fakeClock() });
    expect(contextOf(first)).toBe(buildPendingContext(1));
    expect(contextOf(first)).toContain('call create_image with pasted_image 1');
    const empty = await runPrompt({ input: hookInput('/n save [Image #3]'), env, fetchImpl: daemon.fetchImpl, readText: async () => jsonl([assistantText('hi')]), ...fakeClock() });
    expect(contextOf(empty)).toBe(buildPendingContext(3));
    expect(daemon.uploads).toEqual([]);
  });

  it('a /n prompt with no [Image #N] and no stored picture still adds nothing', async () => {
    const daemon = fakeDaemon({});
    expect(await runPrompt({ input: hookInput('/n save it'), env, fetchImpl: daemon.fetchImpl, readText: async () => jsonl([assistantText('hi')]), ...fakeClock() })).toBeNull();
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

describe('node ids: candidates', () => {
  it('finds upper-case, whole-token 2-2 ids with a letter, distinct, in order, at most MAX_NODE_IDS', () => {
    expect(nodeIdCandidates('what did A0-3G decide?')).toEqual(['A0-3G']);
    expect(nodeIdCandidates('(A0-3G), B1-2C and A0-3G.')).toEqual(['A0-3G', 'B1-2C']);
    expect(nodeIdCandidates('`A0-3G` "B1-2C" [C2-3D] **D3-4E**')).toEqual(['A0-3G', 'B1-2C', 'C2-3D', 'D3-4E']);
    expect(nodeIdCandidates('http://localhost:7317/projects?repo=mcp-notes&node=A0-3G')).toEqual(['A0-3G']);
    expect(nodeIdCandidates('A0-3G.\nnext line')).toEqual(['A0-3G']);
    expect(MAX_NODE_IDS).toBe(5);
    expect(nodeIdCandidates('AA-1A AB-1B AC-1C AD-1D AE-1E AF-1F AG-1G')).toEqual(['AA-1A', 'AB-1B', 'AC-1C', 'AD-1D', 'AE-1E']);
  });

  it('is the same rule as src/sessions/ids.ts (Phase 1)', () => {
    expect(NODE_ID_CANDIDATE.source).toBe(NODE_ID_CANDIDATE_SOURCE);
    expect(NODE_CONTEXT_HEADER).toBe(SERVER_CONTEXT_HEADER);
    const corpus = [...NEAR_MISSES, 'what did A0-3G decide?', '(A0-3G), B1-2C and A0-3G.', 'AA-1A AB-1B AC-1C AD-1D AE-1E AF-1F AG-1G'];
    for (const prompt of corpus) expect(nodeIdCandidates(prompt), prompt).toEqual(findNodeIdCandidates(prompt));
  });

  it('ignores dates, times, versions, paths, file names, lower case, note ids and all-digit pairs', () => {
    for (const prompt of NEAR_MISSES) expect(nodeIdCandidates(prompt), prompt).toEqual([]);
    expect(nodeIdCandidates(3)).toEqual([]);
    expect(nodeIdCandidates(undefined)).toEqual([]);
    expect(nodeIdCandidates('')).toEqual([]);
  });
});

describe('node ids: parse and render', () => {
  it('parseNodeContext keeps only asked ids, in asked order, and keeps the server context only when nothing was dropped', () => {
    const both = { nodes: [OTHER_HOST_NODE, NODE], missing: [], context: 'SERVER' };
    expect(parseNodeContext(both, ['B1-2C', 'A0-3G'])).toEqual({
      nodes: [
        { node_id: 'B1-2C', text: OTHER_HOST_TEXT },
        { node_id: 'A0-3G', text: NODE_TEXT },
      ],
      context: 'SERVER',
    });
    expect(parseNodeContext({ nodes: [{ node_id: 'a0-3g', text: 'x' }, { node_id: 'ZZ-9Q', text: 'not asked' }, { text: 'no id' }], context: 'SERVER' }, ['A0-3G'])).toEqual({
      nodes: [{ node_id: 'A0-3G', text: 'x' }],
      context: '',
    });
    expect(parseNodeContext({ nope: true }, ['A0-3G'])).toEqual({ nodes: [], context: '' });
    expect(parseNodeContext(null, ['A0-3G'])).toEqual({ nodes: [], context: '' });
  });

  it('buildNodeContext uses the server context, rebuilds it when rows were dropped, caps it, and is null for none', () => {
    expect(buildNodeContext({ nodes: [], context: '' })).toBeNull();
    const node = { node_id: 'A0-3G', text: NODE_TEXT };
    expect(buildNodeContext({ nodes: [node], context: 'SERVER' })).toBe(`SERVER\n${NODE_TOOLS_HINT}`);
    expect(buildNodeContext({ nodes: [node], context: '' })).toBe(NODE_BLOCK);
    const text = buildNodeContext({ nodes: [{ node_id: 'A0-3G', text: 'x'.repeat(20_000) }], context: '' })!;
    expect(text.length).toBe(MAX_NODE_CONTEXT_CHARS + 1 + NODE_TOOLS_HINT.length);
  });
});

describe('runPrompt: node ids', () => {
  it('a prompt with no candidate does no I/O at all, near misses included', async () => {
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
    for (const prompt of NEAR_MISSES) {
      expect(await runPrompt({ input: hookInput(prompt), env, ...io }), prompt).toBeNull();
    }
    expect(reads).toBe(0);
    expect(fetches).toBe(0);
    expect(ticks).toBe(0);
    expect(existsSync(path.join(tmp, 'state'))).toBe(false);
  });

  it('an existing node id adds its context: one GET, no transcript read, no state', async () => {
    const daemon = fakeContextDaemon([NODE]);
    let reads = 0;
    const readText = async (): Promise<string> => {
      reads += 1;
      return '';
    };
    const out = await runPrompt({ input: hookInput('continue what A0-3G started'), env, fetchImpl: daemon.fetchImpl, readText, ...fakeClock() });
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: NODE_BLOCK } });
    expect(daemon.urls).toEqual(['http://127.0.0.1:7499/api/sessions/context?ids=A0-3G']);
    expect(daemon.methods).toEqual(['GET']);
    expect(reads).toBe(0);
    expect(existsSync(path.join(tmp, 'state'))).toBe(false);
  });

  it('a node id that does not exist adds nothing, even when the daemon answers with other rows', async () => {
    const strict = fakeContextDaemon([NODE]);
    expect(await runPrompt({ input: hookInput('what about ZZ-9Q?'), env, fetchImpl: strict.fetchImpl, ...fakeClock() })).toBeNull();
    expect(strict.urls).toEqual(['http://127.0.0.1:7499/api/sessions/context?ids=ZZ-9Q']);
    const lax = fakeContextDaemon([NODE], { lax: true });
    expect(await runPrompt({ input: hookInput('what about ZZ-9Q?'), env, fetchImpl: lax.fetchImpl, ...fakeClock() })).toBeNull();
    expect(existsSync(path.join(tmp, 'state'))).toBe(false);
  });

  it('several ids: one request, existing ones only, in prompt order, other-host transcript marked', async () => {
    const daemon = fakeContextDaemon([NODE, OTHER_HOST_NODE]);
    const out = await runPrompt({ input: hookInput('compare B1-2C with ZZ-9Q and A0-3G'), env, fetchImpl: daemon.fetchImpl, ...fakeClock() });
    expect(daemon.urls).toEqual(['http://127.0.0.1:7499/api/sessions/context?ids=B1-2C,ZZ-9Q,A0-3G']);
    expect(contextOf(out)).toBe([NODE_CONTEXT_HEADER, OTHER_HOST_TEXT, NODE_TEXT].join('\n\n') + `\n${NODE_TOOLS_HINT}`);
  });

  it('fails soft: HTTP error, network error or timeout give null and a log line', async () => {
    const notFound = fakeContextDaemon([], { status: 404 });
    expect(await runPrompt({ input: hookInput('A0-3G?'), env, fetchImpl: notFound.fetchImpl, ...fakeClock() })).toBeNull();
    const down = fakeContextDaemon([], { throws: true });
    expect(await runPrompt({ input: hookInput('A0-3G?'), env, fetchImpl: down.fetchImpl, ...fakeClock() })).toBeNull();
    const hang: FetchLike = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    expect(await runPrompt({ input: hookInput('A0-3G?'), env, fetchImpl: hang, contextTimeoutMs: 20, ...fakeClock() })).toBeNull();
    const log = await readFile(logPath(), 'utf8');
    expect(log).toContain('node ids A0-3G: Error: context failed: HTTP 404');
    expect(log).toContain('node ids A0-3G: TypeError: fetch failed');
    expect(log).toContain('TimeoutError');
  });

  it('/n with a picture and a node id: one output, pictures first, then the node', async () => {
    await writeFile(transcript, jsonl([imagePromptEntry('/n save [Image #1] for A0-3G', [png(RED_PNG_16)])]));
    const images = fakeDaemon({ [RED_PNG_16]: 'G-0NC' });
    const daemon = fakeContextDaemon([NODE], { images });
    const out = await runPrompt({ input: hookInput('/n save [Image #1] for A0-3G'), env, fetchImpl: daemon.fetchImpl, ...fakeClock() });
    expect(contextOf(out)).toBe(
      [
        `${CONTEXT_HEADER}[Image #1] = G-0NC (latest).`,
        '"That image" or "this image" means the latest one, G-0NC, unless the user names another id or [Image #N].',
        TOOLS_HINT,
        '',
        NODE_BLOCK,
      ].join('\n'),
    );
    expect(images.uploads).toEqual([RED_PNG_16]);
    expect(daemon.urls).toHaveLength(1);
  });

  it('/n with a node id and no picture adds only the node; an unknown node leaves /n output as before', async () => {
    const daemon = fakeContextDaemon([NODE]);
    const nodeOnly = await runPrompt({
      input: hookInput('/n note what A0-3G did'),
      env,
      fetchImpl: daemon.fetchImpl,
      readText: async () => jsonl([assistantText('hi')]),
      ...fakeClock(),
    });
    expect(contextOf(nodeOnly)).toBe(NODE_BLOCK);
    const noFile = async (): Promise<string> => {
      throw new Error('ENOENT');
    };
    const pending = await runPrompt({ input: hookInput('/n save [Image #1] for ZZ-9Q'), env, fetchImpl: daemon.fetchImpl, readText: noFile, ...fakeClock() });
    expect(contextOf(pending)).toBe(buildPendingContext(1));
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

  it('prints one JSON line with the node context for a prompt naming an existing node', async () => {
    const asked: string[] = [];
    const server = createServer((req, res) => {
      asked.push(String(req.url));
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ nodes: [NODE], missing: [], context: [NODE_CONTEXT_HEADER, NODE_TEXT].join('\n\n') }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const run = await runHook(JSON.stringify(hookInput('pick up where A0-3G left off')), { NOTESD_PORT: String(port) });
      expect(run.code).toBe(0);
      expect(run.stderr).toBe('');
      const lines = run.stdout.split('\n').filter((line) => line !== '');
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]!) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
      expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
      expect(parsed.hookSpecificOutput.additionalContext).toBe(NODE_BLOCK);
      expect(asked).toEqual(['/api/sessions/context?ids=A0-3G']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('exits 0 with empty stdout when the daemon is down for a node id, and logs', async () => {
    const run = await runHook(JSON.stringify(hookInput('pick up where A0-3G left off')), { NOTESD_PORT: '1' });
    expect(run).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(await readFile(logPath(), 'utf8')).toContain('node ids A0-3G:');
  });
});
