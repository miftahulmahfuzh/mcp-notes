import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_STRATEGY, runPaste, uploadIdFrom, type FetchLike } from '../../../claude/hooks/notes-paste.mjs';
import { BLUE_DATA, RED_PNG_16, SESSION, assistantText, imagePromptEntry, jsonl, plainPromptEntry } from './fixtures.js';

let tmp: string;
let transcript: string;
let env: Record<string, string>;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'notes-paste-'));
  transcript = path.join(tmp, 's.jsonl');
  env = { HOME: tmp, XDG_STATE_HOME: path.join(tmp, 'state'), NOTESD_PORT: '7499' };
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

interface Upload {
  url: string;
  header: string | null;
  bytes: Buffer;
  type: string;
  source: unknown;
}

function fakeUpload(response: () => Response): { fetchImpl: FetchLike; uploads: Upload[] } {
  const uploads: Upload[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const form = init.body as FormData;
    const file = form.get('file') as File;
    uploads.push({
      url,
      header: new Headers(init.headers).get('x-notes-capture'),
      bytes: Buffer.from(await file.arrayBuffer()),
      type: file.type,
      source: form.get('source'),
    });
    return response();
  };
  return { fetchImpl, uploads };
}

const ok = (id = 'C-K7F'): Response => new Response(JSON.stringify({ id }), { status: 201 });

function hookInput(toolInput: Record<string, unknown>, toolName = 'mcp__notes__similar_images'): Record<string, unknown> {
  return { session_id: SESSION, transcript_path: transcript, hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput };
}

async function twoImageTranscript(pasteIds: number[] | null = [1, 2]): Promise<void> {
  await writeFile(
    transcript,
    jsonl([
      imagePromptEntry('/n like these [Image #1] [Image #2]', [
        { media_type: 'image/png', data: RED_PNG_16 },
        { media_type: 'image/jpeg', data: BLUE_DATA },
      ], pasteIds),
      assistantText('Looking.'),
    ]),
  );
}

const noSleep = async (): Promise<void> => undefined;

describe('runPaste', () => {
  it('defaults to the updatedInput strategy', () => {
    expect(DEFAULT_STRATEGY).toBe('updatedInput');
  });

  it('uploads image N and rewrites pasted_image to upload_id', async () => {
    await twoImageTranscript();
    const { fetchImpl, uploads } = fakeUpload(() => ok());
    const out = await runPaste({ input: hookInput({ pasted_image: 2, limit: 5 }), env, fetchImpl, sleep: noSleep });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.url).toBe('http://127.0.0.1:7499/api/chat/images');
    expect(uploads[0]!.header).toBe('1');
    expect(uploads[0]!.type).toBe('image/jpeg');
    expect(uploads[0]!.bytes.equals(Buffer.from(BLUE_DATA, 'base64'))).toBe(true);
    expect(uploads[0]!.source).toBe('claude_code');
    expect(out).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { limit: 5, upload_id: 'C-K7F' } },
    });
  });

  it('accepts "1" and falls back to block order when the paste ids do not match', async () => {
    await twoImageTranscript([3, 4]);
    const { fetchImpl, uploads } = fakeUpload(() => ok());
    await runPaste({ input: hookInput({ pasted_image: '1' }), env, fetchImpl, sleep: noSleep });
    expect(uploads[0]!.bytes.equals(Buffer.from(RED_PNG_16, 'base64'))).toBe(true);
  });

  it('uses the latest image-carrying prompt even after a text-only prompt', async () => {
    await writeFile(
      transcript,
      jsonl([
        imagePromptEntry('/n like this [Image #1]', [{ media_type: 'image/png', data: RED_PNG_16 }]),
        assistantText('Found some.'),
        plainPromptEntry('/n and with more results?'),
      ]),
    );
    const { fetchImpl, uploads } = fakeUpload(() => ok());
    const out = await runPaste({ input: hookInput({ pasted_image: 1, limit: 20 }), env, fetchImpl, sleep: noSleep });
    expect(uploads).toHaveLength(1);
    expect(out?.hookSpecificOutput.updatedInput).toEqual({ limit: 20, upload_id: 'C-K7F' });
  });

  it('allows the call unchanged when there is no pasted image (the server explains)', async () => {
    await writeFile(transcript, jsonl([plainPromptEntry('/n find similar'), assistantText('…')]));
    const { fetchImpl, uploads } = fakeUpload(() => ok());
    const out = await runPaste({ input: hookInput({ pasted_image: 1 }), env, fetchImpl, sleep: noSleep });
    expect(uploads).toHaveLength(0);
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
  });

  it('allows the call unchanged when the upload fails', async () => {
    await twoImageTranscript();
    const { fetchImpl } = fakeUpload(() => new Response('{"error":"boom"}', { status: 500 }));
    const out = await runPaste({ input: hookInput({ pasted_image: 1 }), env, fetchImpl, sleep: noSleep });
    expect(out?.hookSpecificOutput.updatedInput).toBeUndefined();
    expect(out?.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('deny strategy: uploads, then denies with the upload_id and the exact arguments', async () => {
    await twoImageTranscript();
    const { fetchImpl } = fakeUpload(() => ok('D-0Q1'));
    const out = await runPaste({ input: hookInput({ pasted_image: 1, limit: 3 }), env: { ...env, NOTES_PASTE_STRATEGY: 'deny' }, fetchImpl, sleep: noSleep });
    expect(out?.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out?.hookSpecificOutput.permissionDecisionReason).toContain('upload_id D-0Q1');
    expect(out?.hookSpecificOutput.permissionDecisionReason).toContain('{"limit":3,"upload_id":"D-0Q1"}');
  });

  it('create_image and attach_image: uploads the picture and rewrites pasted_image to image_id', async () => {
    await twoImageTranscript();
    for (const [tool, args, expected] of [
      ['mcp__notes__create_image', { pasted_image: 2, body: 'a red square #pic' }, { body: 'a red square #pic', image_id: 'C-K7F' }],
      ['mcp__notes__attach_image', { id: 'A-B32', pasted_image: '1' }, { id: 'A-B32', image_id: 'C-K7F' }],
    ] as const) {
      const { fetchImpl, uploads } = fakeUpload(() => ok());
      const out = await runPaste({ input: hookInput({ ...args }, tool), env, fetchImpl, sleep: noSleep });
      expect(uploads).toHaveLength(1);
      expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: expected } });
    }
  });

  it('create_image with a pasted image that cannot be found or uploaded is allowed unchanged (the server explains)', async () => {
    await writeFile(transcript, jsonl([plainPromptEntry('hello'), assistantText('hi')]));
    const { fetchImpl, uploads } = fakeUpload(() => ok());
    const out = await runPaste({ input: hookInput({ pasted_image: 1 }, 'mcp__notes__create_image'), env, fetchImpl, sleep: noSleep });
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
    expect(uploads).toHaveLength(0);
  });

  it('deny strategy on create_image names the tool and image_id', async () => {
    await twoImageTranscript();
    const { fetchImpl } = fakeUpload(() => ok('D-0Q1'));
    const out = await runPaste({
      input: hookInput({ pasted_image: 1 }, 'mcp__notes__create_image'),
      env: { ...env, NOTES_PASTE_STRATEGY: 'deny' },
      fetchImpl,
      sleep: noSleep,
    });
    const reason = out?.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain('image_id D-0Q1');
    expect(reason).toContain('Call mcp__notes__create_image again');
    expect(reason).toContain('{"image_id":"D-0Q1"}');
  });

  it('stays out of other tools and of calls without pasted_image', async () => {
    await twoImageTranscript();
    const { fetchImpl, uploads } = fakeUpload(() => ok());
    expect(await runPaste({ input: hookInput({ pasted_image: 1 }, 'mcp__notes__search'), env, fetchImpl, sleep: noSleep })).toBeNull();
    expect(await runPaste({ input: hookInput({ upload_id: 'C-K7F' }), env, fetchImpl, sleep: noSleep })).toBeNull();
    expect(await runPaste({ input: hookInput({ pasted_image: 0 }), env, fetchImpl, sleep: noSleep })).toBeNull();
    expect(uploads).toHaveLength(0);
  });

  it('reads the upload id from the response shapes P3 may use', () => {
    expect(uploadIdFrom({ id: 'A-B32' })).toBe('A-B32');
    expect(uploadIdFrom({ upload_id: 'A-B32' })).toBe('A-B32');
    expect(uploadIdFrom({ image: { id: 'A-B32' } })).toBe('A-B32');
    expect(uploadIdFrom({ id: 'nope' })).toBeNull();
  });
});
