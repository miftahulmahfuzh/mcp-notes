import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { noteIdOf, runLink, type FetchLike } from '../../../claude/hooks/notes-link.mjs';

const SID = '0ef363d6-0bdd-4a15-aff7-71f0821bd6ee';
const ok = (value: unknown): unknown => [{ type: 'text', text: JSON.stringify(value, null, 2) }];

const call = (tool: string, toolInput: Record<string, unknown>, toolResponse: unknown): Record<string, unknown> => ({
  session_id: SID,
  cwd: '/work/repo',
  hook_event_name: 'PostToolUse',
  tool_name: `mcp__notes__${tool}`,
  tool_input: toolInput,
  tool_response: toolResponse,
});

describe('noteIdOf', () => {
  it('takes the id from the result for create and create_image', () => {
    expect(noteIdOf(call('create', { body: 'x' }, ok({ note: { id: 'A-B32' } })))).toBe('A-B32');
    expect(noteIdOf(call('create_image', { path: '/p.png' }, ok({ note: { id: '7-QX0' }, created: true })))).toBe('7-QX0');
    expect(noteIdOf(call('create', { body: 'x' }, { content: ok({ note: { id: 'A-B32' } }) }))).toBe('A-B32');
    expect(noteIdOf(call('create', { body: 'x' }, JSON.stringify({ note: { id: 'A-B32' } })))).toBe('A-B32');
  });

  it('takes the id from the input for update, append and attach_image', () => {
    expect(noteIdOf(call('update', { id: 'ab32', body: 'y' }, ok({ note: { id: 'A-B32' } })))).toBe('ab32');
    expect(noteIdOf(call('append', { id: 'A-B32', text: 'y' }, ok({ note: { id: 'A-B32' } })))).toBe('A-B32');
    expect(noteIdOf(call('attach_image', { id: 'A-B32', path: '/p.png' }, ok({ note_id: 'A-B32' })))).toBe('A-B32');
  });

  it('is null for failed calls and other tools', () => {
    expect(noteIdOf(call('update', { id: 'A-B32', body: 'y' }, [{ type: 'text', text: 'deleted: Note A-B32 is deleted.' }]))).toBeNull();
    expect(noteIdOf(call('attach_image', { id: 'A-B32' }, [{ type: 'text', text: 'attach_image refused (x): y' }]))).toBeNull();
    expect(noteIdOf(call('create', { body: 'x' }, { isError: true, content: ok({ note: { id: 'A-B32' } }) }))).toBeNull();
    expect(noteIdOf(call('get', { ids: ['A-B32'] }, ok({ notes: [{ id: 'A-B32' }] })))).toBeNull();
    expect(noteIdOf(call('delete', { id: 'A-B32' }, ok({ note: { id: 'A-B32' } })))).toBeNull();
    expect(noteIdOf(call('update', { id: 'not an id', body: 'y' }, ok({})))).toBeNull();
  });
});

describe('runLink', () => {
  let tmp: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'notes-link-'));
    env = { HOME: tmp, XDG_STATE_HOME: path.join(tmp, 'state'), NOTESD_PORT: '7499', CLAUDE_CODE_ENTRYPOINT: 'cli' };
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function fake(response: () => Response): { fetchImpl: FetchLike; calls: { url: string; header: string | null; body: unknown }[] } {
    const calls: { url: string; header: string | null; body: unknown }[] = [];
    return {
      calls,
      fetchImpl: async (url, init) => {
        calls.push({ url, header: new Headers(init.headers).get('x-notes-capture'), body: JSON.parse(String(init.body)) });
        return response();
      },
    };
  }

  it('posts the session and note id and returns null (no decision)', async () => {
    const { fetchImpl, calls } = fake(() => new Response('{}', { status: 200 }));
    const out = await runLink({ input: call('create', { body: 'x' }, ok({ note: { id: 'A-B32' } })), env, fetchImpl });
    expect(out).toBeNull();
    expect(calls).toEqual([{ url: 'http://127.0.0.1:7499/api/sessions/hook/link-note', header: '1', body: { session: SID, note: 'A-B32' } }]);
  });

  it('does no I/O for other tools, failed calls, non-cli sessions or a missing session id', async () => {
    const { fetchImpl, calls } = fake(() => new Response('{}', { status: 200 }));
    const created = call('create', { body: 'x' }, ok({ note: { id: 'A-B32' } }));
    await runLink({ input: call('get', { ids: ['A-B32'] }, ok({ notes: [] })), env, fetchImpl });
    await runLink({ input: call('update', { id: 'A-B32' }, [{ type: 'text', text: 'not_found: no' }]), env, fetchImpl });
    await runLink({ input: created, env: { ...env, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }, fetchImpl });
    await runLink({ input: { ...created, session_id: undefined }, env, fetchImpl });
    expect(calls).toHaveLength(0);
    expect(existsSync(path.join(tmp, 'state'))).toBe(false);
  });

  it('logs an HTTP failure or a daemon that is down, and tells the model to retry', async () => {
    const input = call('append', { id: 'A-B32', text: 'y' }, ok({ note: { id: 'A-B32' } }));
    const { fetchImpl } = fake(() => new Response('{"error":"unknown_session"}', { status: 404 }));
    const http: any = await runLink({ input, env, fetchImpl });
    expect(http.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(http.hookSpecificOutput.additionalContext).toMatch(/A-B32 was saved but NOT linked .*HTTP 404/);
    expect(http.hookSpecificOutput.additionalContext).toMatch(/link_note\(note_id: "A-B32"/);
    const down: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    const gone: any = await runLink({ input, env, fetchImpl: down });
    expect(gone.hookSpecificOutput.additionalContext).toMatch(/NOT linked .*fetch failed/);
    const log = await readFile(path.join(tmp, 'state', 'notes-capture', 'link.log'), 'utf8');
    expect(log).toMatch(/HTTP 404 .*unknown_session/);
    expect(log).toMatch(/fetch failed/);
  });
});
