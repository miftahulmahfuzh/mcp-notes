import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCapture } from '../../claude/hooks/notes-capture.mjs';
import { runPaste } from '../../claude/hooks/notes-paste.mjs';
import { NODE_CONTEXT_HEADER, runPrompt } from '../../claude/hooks/notes-prompt.mjs';
import { sha256Hex } from '../../src/images/probe.js';
import { CWD, RED_PNG_16, SESSION, assistantText, commandEntry, imagePromptEntry, jsonl } from '../unit/hooks/fixtures.js';
import { insertTextNote, makeImage, originalPathOf, startHarness, type Harness } from './imageHarness.js';

type Entry = Record<string, unknown>;
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type PromptOutput = { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };
type NoteJson = { id: string; images: Array<{ id: string }> };

const N_PROMPT = '/n make that image a new note [Image #2]';

let h: Harness;
let livePort: string;
let client: Client;
let tmp: string;
let bluePng = '';
let greenPng = '';

beforeAll(async () => {
  h = await startHarness();
  const base = await h.listen();
  livePort = new URL(base).port;
  client = new Client({ name: 'prompt-hook-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  bluePng = (await makeImage('png', 16, 16, { r: 0, g: 0, b: 255 })).toString('base64');
  greenPng = (await makeImage('png', 16, 16, { r: 0, g: 200, b: 0 })).toString('base64');
});

beforeEach(async () => {
  await h.reset();
  tmp = await mkdtemp(path.join(os.tmpdir(), 'notes-prompt-int-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

afterAll(async () => {
  await client.close();
  await h.close();
});

function closedPort(): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 1;
      server.close(() => resolve(String(port)));
    });
  });
}

async function count(table: string): Promise<number> {
  const result = await h.deps.db.execute(sql.raw(`select count(*)::int as n from ${table}`));
  return Number((result.rows[0] as { n: number }).n);
}

/** The chat image id the daemon gave these bytes (sha256 is unique in chat_images). */
async function chatIdOf(base64: string): Promise<string> {
  const sha = sha256Hex(Buffer.from(base64, 'base64'));
  const result = await h.deps.db.execute(sql`select id from chat_images where sha256 = ${sha}`);
  const row = result.rows[0] as { id: string } | undefined;
  if (row === undefined) throw new Error(`no chat image with sha256 ${sha}`);
  return row.id;
}

/** Sleep advances a fake clock instead of waiting, so polls and budgets in the hook cost nothing. */
function virtualClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = Date.parse('2026-10-31T05:00:00.000Z');
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function countingFetch(): { fetchImpl: FetchLike; calls: () => number; uploads: () => number } {
  const urls: string[] = [];
  return {
    fetchImpl: (url, init) => {
      urls.push(url);
      return fetch(url, init);
    },
    calls: () => urls.length,
    uploads: () => urls.filter((u) => u.endsWith('/api/chat/images')).length,
  };
}

function countingRead(): { readText: (file: string) => Promise<string>; reads: () => number } {
  let n = 0;
  return {
    readText: (file) => {
      n += 1;
      return readFile(file, 'utf8');
    },
    reads: () => n,
  };
}

function hookEnv(port: string = livePort): Record<string, string> {
  return { HOME: tmp, XDG_STATE_HOME: path.join(tmp, 'state'), NOTESD_PORT: port };
}

async function writeTranscript(entries: Entry[]): Promise<string> {
  const file = path.join(tmp, 's.jsonl');
  await writeFile(file, jsonl(entries));
  return file;
}

async function submit(
  transcript: string,
  prompt: string,
  opts: { port?: string; fetchImpl?: FetchLike; readText?: (file: string) => Promise<string> } = {},
): Promise<PromptOutput | null> {
  const clock = virtualClock();
  const out = await runPrompt({
    input: { session_id: SESSION, transcript_path: transcript, cwd: CWD, hook_event_name: 'UserPromptSubmit', prompt },
    env: hookEnv(opts.port),
    fetchImpl: opts.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init)),
    readText: opts.readText ?? ((file: string) => readFile(file, 'utf8')),
    sleep: clock.sleep,
    now: clock.now,
  });
  return out as PromptOutput | null;
}

function contextOf(out: PromptOutput | null): string {
  expect(out).not.toBeNull();
  expect(out!.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
  return out!.hookSpecificOutput.additionalContext;
}

/** A non-/n turn pasting a blue image, an answer, then a /n turn pasting a red one. */
function twoTurnSession(): Entry[] {
  return [
    imagePromptEntry('what is in this picture? [Image #1]', [{ media_type: 'image/png', data: bluePng }], [1]),
    assistantText('A blue square.'),
    imagePromptEntry(N_PROMPT, [{ media_type: 'image/png', data: RED_PNG_16 }], [2]),
  ];
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

function textOf(r: ToolResult): string {
  return r.content.flatMap((c) => (c.type === 'text' && typeof c.text === 'string' ? [c.text] : [])).join('\n');
}

describe('notes-prompt hook against the real daemon', () => {
  it('a /n prompt stores every pasted image of the session and names the latest', async () => {
    const transcript = await writeTranscript(twoTurnSession());
    const ctx = contextOf(await submit(transcript, N_PROMPT));

    expect(await count('chat_images')).toBe(2);
    const blueId = await chatIdOf(bluePng);
    const redId = await chatIdOf(RED_PNG_16);
    expect(ctx).toContain(`[Image #1] = ${blueId}`);
    expect(ctx).toContain(`[Image #2] = ${redId} (latest)`);
    expect(ctx).not.toContain(`${blueId} (latest)`);
    expect(ctx.indexOf(blueId)).toBeLessThan(ctx.indexOf(redId));
    expect(ctx).toContain('create_image');
    expect(ctx).toContain('image_id');

    const sources = await h.deps.db.execute(sql`select distinct source from chat_images`);
    expect(sources.rows.map((r) => (r as { source: string }).source)).toEqual(['claude_code']);
    // The hook only stores pictures: no thread, no message, no note (invariant 4).
    expect(await count('chat_threads')).toBe(0);
    expect(await count('chat_messages')).toBe(0);
    expect(await count('notes')).toBe(0);
  });

  it('an image pasted in an earlier turn is "that image" when the /n prompt carries none', async () => {
    const transcript = await writeTranscript([
      imagePromptEntry('look at this [Image #1]', [{ media_type: 'image/png', data: bluePng }], [1]),
      assistantText('A blue square.'),
      commandEntry('please make that image as a new note then'),
    ]);
    const ctx = contextOf(await submit(transcript, '/n please make that image as a new note then'));
    expect(await count('chat_images')).toBe(1);
    expect(ctx).toContain(`${await chatIdOf(bluePng)} (latest)`);
  });

  it('the Stop capture of the same /n turn reuses the ids: no new chat image, one thread', async () => {
    const entries = twoTurnSession();
    const nTurn = entries[2]!;
    const transcript = await writeTranscript(entries);
    contextOf(await submit(transcript, N_PROMPT));
    const redId = await chatIdOf(RED_PNG_16);

    await writeFile(transcript, jsonl([...entries, assistantText('Saved it as a note.')]));
    const io = { sleep: async (): Promise<void> => undefined };
    const captured = await runCapture({
      input: { session_id: SESSION, transcript_path: transcript, last_assistant_message: 'Saved it as a note.' },
      env: hookEnv(),
      ...io,
    });
    expect(captured.outcome).toBe('delivered');
    expect(await count('chat_images')).toBe(2);
    expect(await count('chat_threads')).toBe(1);

    const keys = await h.deps.db.execute(sql`select external_key from chat_threads`);
    expect(keys.rows.map((r) => (r as { external_key: string }).external_key)).toEqual([`${SESSION}:${String(nTurn.uuid)}`]);
    const refs = await h.deps.db.execute(
      sql`select ref_id from chat_message_attachments where kind = 'chat_image' order by position`,
    );
    expect(refs.rows.map((r) => (r as { ref_id: string }).ref_id)).toEqual([redId]);

    const replay = await runCapture({
      input: { session_id: SESSION, transcript_path: transcript, last_assistant_message: 'Saved it as a note.' },
      env: hookEnv(),
      ...io,
    });
    expect(replay.outcome).toBe('delivered');
    expect(await count('chat_threads')).toBe(1);
    expect(await count('chat_images')).toBe(2);
  });

  it('a replay uploads nothing; a newly pasted image is the only upload and becomes the latest', async () => {
    const entries = twoTurnSession();
    const transcript = await writeTranscript(entries);
    const first = countingFetch();
    const ctx1 = contextOf(await submit(transcript, N_PROMPT, { fetchImpl: first.fetchImpl }));
    expect(first.uploads()).toBe(2);

    const second = countingFetch();
    const ctx2 = contextOf(await submit(transcript, N_PROMPT, { fetchImpl: second.fetchImpl }));
    expect(second.uploads()).toBe(0);
    expect(ctx2).toBe(ctx1);
    expect(await count('chat_images')).toBe(2);

    const later = '/n and this one too [Image #3]';
    await writeFile(
      transcript,
      jsonl([
        ...entries,
        assistantText('Done.'),
        imagePromptEntry(later, [{ media_type: 'image/png', data: greenPng }], [3]),
      ]),
    );
    const third = countingFetch();
    const ctx3 = contextOf(await submit(transcript, later, { fetchImpl: third.fetchImpl }));
    expect(third.uploads()).toBe(1);
    expect(await count('chat_images')).toBe(3);
    const greenId = await chatIdOf(greenPng);
    const redId = await chatIdOf(RED_PNG_16);
    expect(ctx3).toContain(`[Image #3] = ${greenId} (latest)`);
    expect(ctx3).not.toContain(`${redId} (latest)`);
  });

  it('a prompt that is not /n does no I/O and prints nothing', async () => {
    const transcript = await writeTranscript([
      imagePromptEntry('what about this one? [Image #1]', [{ media_type: 'image/png', data: bluePng }], [1]),
    ]);
    for (const prompt of ['what about this one? [Image #1]', '/new idea [Image #1]', '  please /n later']) {
      const net = countingFetch();
      const disk = countingRead();
      const out = await submit(transcript, prompt, { fetchImpl: net.fetchImpl, readText: disk.readText });
      expect(out, prompt).toBeNull();
      expect(net.calls(), prompt).toBe(0);
      expect(disk.reads(), prompt).toBe(0);
    }
    expect(await count('chat_images')).toBe(0);
  });

  it('a node id that does not exist adds nothing: one GET to the real /api/sessions/context, no failure, /n unchanged', async () => {
    const plain = await writeTranscript([assistantText('hi')]);
    const net = countingFetch();
    const disk = countingRead();
    const out = await submit(plain, 'what did ZZ-9Q decide?', { fetchImpl: net.fetchImpl, readText: disk.readText });
    expect(out).toBeNull();
    expect(net.calls()).toBe(1);
    expect(disk.reads()).toBe(0);
    // The route answered 2xx with a parseable body: the hook logged no failure.
    expect(existsSync(path.join(tmp, 'state', 'notes-capture', 'prompt.log'))).toBe(false);

    const transcript = await writeTranscript(twoTurnSession());
    const ctx = contextOf(await submit(transcript, `${N_PROMPT} ZZ-9Q`));
    expect(ctx).toContain('(latest)');
    expect(ctx).not.toContain(NODE_CONTEXT_HEADER);
  });


  it('daemon down: null, a log line, nothing remembered; the next /n prompt stores the images', async () => {
    const transcript = await writeTranscript(twoTurnSession());
    const down = await submit(transcript, N_PROMPT, { port: await closedPort() });
    expect(down).toBeNull();
    expect(await count('chat_images')).toBe(0);
    const log = await readFile(path.join(tmp, 'state', 'notes-capture', 'prompt.log'), 'utf8');
    expect(log.trim()).not.toBe('');

    const up = contextOf(await submit(transcript, N_PROMPT));
    expect(await count('chat_images')).toBe(2);
    expect(up).toContain(`${await chatIdOf(RED_PNG_16)} (latest)`);
  });

  it('create_image and attach_image accept the ids the hook named', async () => {
    const transcript = await writeTranscript(twoTurnSession());
    contextOf(await submit(transcript, N_PROMPT));
    const redId = await chatIdOf(RED_PNG_16);
    const blueId = await chatIdOf(bluePng);

    const first = await call('create_image', { image_id: redId.toLowerCase().replace('-', ''), body: 'pasted in claude code' });
    expect(first.isError, textOf(first)).toBeFalsy();
    const made = JSON.parse(textOf(first)) as { note: NoteJson; created: boolean };
    expect(made.created).toBe(true);
    const stored = await readFile(await originalPathOf(h, made.note.id));
    expect(Buffer.compare(stored, Buffer.from(RED_PNG_16, 'base64'))).toBe(0);
    // The chat image stays where it was; the note holds a copy.
    expect(await count('chat_images')).toBe(2);

    const again = await call('create_image', { image_id: redId });
    expect(again.isError, textOf(again)).toBeFalsy();
    const same = JSON.parse(textOf(again)) as { note: NoteJson; created: boolean };
    expect({ id: same.note.id, created: same.created }).toEqual({ id: made.note.id, created: false });
    expect(await count('notes')).toBe(1);

    const attached = await call('attach_image', { id: made.note.id, image_id: blueId });
    expect(attached.isError, textOf(attached)).toBeFalsy();
    const withTwo = JSON.parse(textOf(attached)) as { note: NoteJson; attached: boolean };
    expect(withTwo.attached).toBe(true);
    expect(withTwo.note.images).toHaveLength(2);

    const reattach = await call('attach_image', { id: made.note.id, image_id: blueId });
    expect(reattach.isError, textOf(reattach)).toBeFalsy();
    expect((JSON.parse(textOf(reattach)) as { attached: boolean }).attached).toBe(false);
    expect(await count('note_images')).toBe(2);
  });

  it('a picture pasted in the /n prompt itself: the prompt hook points at pasted_image, the PreToolUse hook turns it into image_id', async () => {
    // At UserPromptSubmit the current prompt is not in the transcript yet: only the older turn is.
    const before = await writeTranscript([imagePromptEntry('look [Image #1]', [{ media_type: 'image/png', data: bluePng }], [1]), assistantText('ok')]);
    const context = contextOf(await submit(before, '/n save this [Image #2]'));
    expect(context).toContain('The latest pasted image ([Image #2]) has no id yet');
    expect(context).toContain('call create_image with pasted_image 2');
    expect(context).not.toContain('(latest)');

    // By the time the model calls the tool the transcript holds the prompt.
    const after = await writeTranscript([
      imagePromptEntry('look [Image #1]', [{ media_type: 'image/png', data: bluePng }], [1]),
      assistantText('ok'),
      imagePromptEntry('/n save this [Image #2]', [{ media_type: 'image/png', data: RED_PNG_16 }], [2]),
    ]);
    const rewrite = await runPaste({
      input: {
        session_id: SESSION,
        transcript_path: after,
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__notes__create_image',
        tool_input: { pasted_image: 2, body: 'pasted in the prompt #fresh' },
      },
      env: hookEnv(),
      fetchImpl: (url: string, init: RequestInit) => fetch(url, init),
      readText: (file: string) => readFile(file, 'utf8'),
      sleep: async () => undefined,
    });
    const updated = rewrite?.hookSpecificOutput.updatedInput as { image_id?: string; pasted_image?: unknown; body?: string };
    expect(updated.pasted_image).toBeUndefined();
    expect(updated.body).toBe('pasted in the prompt #fresh');
    expect(updated.image_id).toBe(await chatIdOf(RED_PNG_16));

    const made = await call('create_image', updated as Record<string, unknown>);
    expect(made.isError, textOf(made)).toBeFalsy();
    const note = JSON.parse(textOf(made)) as { note: NoteJson; created: boolean };
    expect(note.created).toBe(true);
    const stored = await readFile(await originalPathOf(h, note.note.id));
    expect(Buffer.compare(stored, Buffer.from(RED_PNG_16, 'base64'))).toBe(0);
  });

  it('image_id refusals: unknown chat id, a note image id, both or neither inputs', async () => {
    const transcript = await writeTranscript(twoTurnSession());
    contextOf(await submit(transcript, N_PROMPT));
    const redId = await chatIdOf(RED_PNG_16);
    const blueId = await chatIdOf(bluePng);

    const unknown = await call('create_image', { image_id: 'Z-ZZZ' });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain('create_image refused (unknown_chat_image)');
    expect(textOf(unknown)).toContain('no pasted image');

    const made = JSON.parse(textOf(await call('create_image', { image_id: redId }))) as { note: NoteJson };
    const noteImageId = made.note.images[0]!.id;
    if (noteImageId !== redId && noteImageId !== blueId) {
      // A note image id is never looked up in the chat image space (invariant 3).
      const wrongSpace = await call('create_image', { image_id: noteImageId });
      expect(wrongSpace.isError).toBe(true);
      expect(textOf(wrongSpace)).toContain('unknown_chat_image');
    }

    const both = await call('create_image', { path: path.join(tmp, 'x.png'), image_id: redId });
    expect(both.isError).toBe(true);
    expect(textOf(both)).toContain('create_image refused (bad_arguments): give exactly one of path or image_id');

    await insertTextNote(h, 'T-XT9', 'a text note');
    const neither = await call('attach_image', { id: 'T-XT9' });
    expect(neither.isError).toBe(true);
    expect(textOf(neither)).toContain('attach_image refused (bad_arguments): give exactly one of path or image_id');
  });
});
