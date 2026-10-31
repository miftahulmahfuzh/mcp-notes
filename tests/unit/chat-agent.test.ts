import { randomUUID } from 'node:crypto';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import {
  createAgentChatBackend,
  type AgentChatConfig,
  type AgentChatOptions,
  type QueryFn,
} from '../../src/chat/agent.js';
import type { ChatEvent, ChatRequest, ChatTurn, ChatTurnImage } from '../../src/chat/backend.js';
import { allowedChatTools } from '../../src/chat/status.js';

// ---------- fake SDK messages ----------

const SESSION = 'sess-claude-1';

function textDelta(text: string, parent: string | null = null): SDKMessage {
  return {
    type: 'stream_event',
    parent_tool_use_id: parent,
    uuid: randomUUID(),
    session_id: SESSION,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  } as unknown as SDKMessage;
}

function assistant(content: unknown[], extra: Record<string, unknown> = {}, parent: string | null = null): SDKMessage {
  return {
    type: 'assistant',
    parent_tool_use_id: parent,
    uuid: randomUUID(),
    session_id: SESSION,
    message: {
      id: `msg_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    ...extra,
  } as unknown as SDKMessage;
}

function toolUse(name: string, input: unknown, parent: string | null = null): SDKMessage {
  return assistant([{ type: 'tool_use', id: `toolu_${randomUUID()}`, name, input }], {}, parent);
}

function assistantError(error: string, text: string): SDKMessage {
  return assistant([{ type: 'text', text }], { error });
}

function success(sessionId = SESSION): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done',
    num_turns: 1,
    duration_ms: 1,
    duration_api_ms: 1,
    session_id: sessionId,
    uuid: randomUUID(),
  } as unknown as SDKMessage;
}

function errorResult(text: string, sessionId = SESSION): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: true,
    result: text,
    num_turns: 1,
    duration_ms: 1,
    duration_api_ms: 1,
    session_id: sessionId,
    uuid: randomUUID(),
  } as unknown as SDKMessage;
}

function maxTurnsResult(sessionId = SESSION): SDKMessage {
  return {
    type: 'result',
    subtype: 'error_max_turns',
    is_error: true,
    errors: [],
    num_turns: 24,
    duration_ms: 1,
    duration_api_ms: 1,
    session_id: sessionId,
    uuid: randomUUID(),
  } as unknown as SDKMessage;
}

// ---------- fake query ----------

type Script = (options: Options) => AsyncGenerator<SDKMessage>;

function scripted(messages: SDKMessage[]): Script {
  return async function* () {
    for (const m of messages) yield m;
  };
}

/** Yields `before`, then waits for the run's abort, then throws like the SDK does. */
function hangs(before: SDKMessage[]): Script {
  return async function* (options) {
    for (const m of before) yield m;
    const signal = options.abortController?.signal;
    if (!signal) throw new Error('fake query: no abortController passed');
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
    const err = new Error('Claude Code process aborted by user');
    err.name = 'AbortError';
    throw err;
  };
}

function throwsAfter(before: SDKMessage[], message: string): Script {
  return async function* () {
    for (const m of before) yield m;
    throw new Error(message);
  };
}

type QueryCall = Parameters<QueryFn>[0];

function fakeQuery(...scripts: Script[]): { query: QueryFn; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const query: QueryFn = (params) => {
    calls.push(params);
    const script = scripts[calls.length - 1];
    if (!script) throw new Error(`fake query: unexpected call #${calls.length}`);
    return script(params.options);
  };
  return { query, calls };
}

function optionsOf(calls: { options: Options }[], i: number): Options {
  const call = calls[i];
  if (!call) throw new Error(`no query call #${i}`);
  return call.options;
}

// ---------- backend under test ----------

const GLM = { baseUrl: 'https://api.z.ai/api/anthropic', apiKey: 'glm-key', model: 'glm-5.3' };
const CHAT: AgentChatConfig = { brain: 'claude', maxTurns: 24, timeoutMs: 180_000, claudeBin: '/opt/claude/bin/claude', glm: GLM };
const MCP_URL = 'http://127.0.0.1:7317/mcp';

function backend(query: QueryFn, chat: Partial<AgentChatConfig> = {}, extra: Partial<AgentChatOptions> = {}) {
  return createAgentChatBackend({
    chat: { ...CHAT, ...chat },
    cwd: '/data/chat',
    mcpUrl: () => MCP_URL,
    query,
    now: () => new Date('2026-10-30T03:00:00Z'),
    baseEnv: { PATH: '/usr/bin', HOME: '/home/owner', ANTHROPIC_API_KEY: 'sk-ant-should-not-leak' },
    log: () => {},
    ...extra,
  });
}

function req(
  message: string,
  threadId: string | null = null,
  signal = new AbortController().signal,
  images: ChatTurnImage[] = [],
): ChatRequest {
  return { message, images, threadId, signal };
}

async function collect(turn: ChatTurn): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of turn.events) out.push(e);
  return out;
}

async function collectUntilError(turn: ChatTurn): Promise<{ events: ChatEvent[]; error: Error }> {
  const events: ChatEvent[] = [];
  try {
    for await (const e of turn.events) events.push(e);
  } catch (err) {
    return { events, error: err as Error };
  }
  throw new Error('expected the turn to fail');
}

const deltas = (events: ChatEvent[]): string =>
  events.filter((e) => e.type === 'delta').map((e) => e.text).join('');

// ---------- tests ----------

describe('agent chat backend: streaming', () => {
  it('streams top-level text deltas in order and reports the session as the thread', async () => {
    const { query } = fakeQuery(
      scripted([textDelta('You saved '), textDelta('A-B32 '), textDelta('sub', 'toolu_sub'), textDelta('on Monday.'), success()]),
    );
    const turn = await backend(query).reply(req('what did i save?'));
    const events = await collect(turn);
    expect(events).toEqual([
      { type: 'delta', text: 'You saved ' },
      { type: 'delta', text: 'A-B32 ' },
      { type: 'delta', text: 'on Monday.' },
    ]);
    expect(turn.end()).toEqual({ threadId: SESSION, brain: 'claude' });
  });

  it('passes note ids through untouched', async () => {
    const { query } = fakeQuery(scripted([textDelta('See A-B32 and 7-QX0.'), success()]));
    const turn = await backend(query).reply(req('ids'));
    expect(deltas(await collect(turn))).toBe('See A-B32 and 7-QX0.');
  });

  it('end() refuses before the events finished', async () => {
    const { query } = fakeQuery(scripted([success()]));
    const turn = await backend(query).reply(req('x'));
    expect(() => turn.end()).toThrow(/before events finished/);
  });

  it('fails when the agent ends without a result', async () => {
    const { query } = fakeQuery(scripted([textDelta('half')]));
    const { error } = await collectUntilError(await backend(query).reply(req('x')));
    expect(error.message).toMatch(/without an answer/);
  });
});

describe('agent chat backend: status captions', () => {
  it('maps tool_use to captions, clears them when text resumes, and starts a new paragraph after a tool', async () => {
    const { query } = fakeQuery(
      scripted([
        textDelta('Let me look.'),
        toolUse('mcp__notes__search', { query: 'seer' }),
        toolUse('mcp__notes__search', { query: 'seer week' }),
        toolUse('mcp__notes__get', { ids: ['A-B32', 'B-C43', 'C-D54'] }),
        toolUse('Read', { file_path: '/etc/passwd' }, 'toolu_sub'),
        textDelta(' Found A-B32.'),
        toolUse('mcp__notes__view_images', { ids: ['A-B32', 'B-C43', 'C-D54', 'D-E65'] }),
        toolUse('WebSearch', { query: 'Verity' }),
        textDelta('Done.'),
        success(),
      ]),
    );
    const events = await collect(await backend(query).reply(req('summarize #seer')));
    expect(events).toEqual([
      { type: 'delta', text: 'Let me look.' },
      { type: 'status', text: 'searching notes' },
      { type: 'status', text: 'reading 3 notes' },
      { type: 'status', text: '' },
      { type: 'delta', text: '\n\nFound A-B32.' },
      { type: 'status', text: 'looking at 4 photos' },
      { type: 'status', text: 'searching the web' },
      { type: 'status', text: '' },
      { type: 'delta', text: '\n\nDone.' },
    ]);
  });

  it('does not add a paragraph break before the first text', async () => {
    const { query } = fakeQuery(
      scripted([toolUse('mcp__notes__list', {}), textDelta('Nothing this week.'), success()]),
    );
    const events = await collect(await backend(query).reply(req('this week?')));
    expect(events).toEqual([
      { type: 'status', text: 'searching notes' },
      { type: 'status', text: '' },
      { type: 'delta', text: 'Nothing this week.' },
    ]);
  });
});

describe('agent chat backend: run options', () => {
  it('isolates the run to the notes MCP server plus web tools, on the owner login', async () => {
    const { query, calls } = fakeQuery(scripted([success()]));
    await collect(await backend(query).reply(req('hello')));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe('hello');
    const o = optionsOf(calls, 0);
    expect(o.cwd).toBe('/data/chat');
    expect(o.settingSources).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.mcpServers).toEqual({ notes: { type: 'http', url: MCP_URL, alwaysLoad: true } });
    expect(o.tools).toEqual(['WebSearch', 'WebFetch']);
    expect(o.allowedTools).toEqual(allowedChatTools());
    expect(o.permissionMode).toBe('dontAsk');
    expect(o.includePartialMessages).toBe(true);
    expect(o.maxTurns).toBe(24);
    expect(o.pathToClaudeCodeExecutable).toBe('/opt/claude/bin/claude');
    expect(o.resume).toBeUndefined();
    expect(o.model).toBeUndefined();
    expect(o.systemPrompt).toEqual(expect.stringContaining('2026-10-30'));
    expect(o.env?.HOME).toBe('/home/owner');
    expect(o.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(o.env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(o.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    expect(o.abortController).toBeInstanceOf(AbortController);
  });

  it('resumes the given thread and reports the session the SDK returns', async () => {
    const { query, calls } = fakeQuery(scripted([textDelta('Same thread.'), success('sess-old')]));
    const turn = await backend(query).reply(req('and last month?', 'sess-old'));
    await collect(turn);
    expect(optionsOf(calls, 0).resume).toBe('sess-old');
    expect(turn.end()).toEqual({ threadId: 'sess-old', brain: 'claude' });
  });

  it('reads the MCP url at run time, not at construction', async () => {
    let port: number | null = null;
    const { query, calls } = fakeQuery(scripted([success()]));
    const b = createAgentChatBackend({
      chat: CHAT,
      cwd: '/data/chat',
      mcpUrl: () => {
        if (port === null) throw new Error('not listening');
        return `http://127.0.0.1:${port}/mcp`;
      },
      query,
      log: () => {},
    });
    port = 40123;
    await collect(await b.reply(req('x')));
    expect(optionsOf(calls, 0).mcpServers).toEqual({
      notes: { type: 'http', url: 'http://127.0.0.1:40123/mcp', alwaysLoad: true },
    });
  });
});

describe('agent chat backend: guardrails', () => {
  it('stops the run when the client disconnects', async () => {
    const { query, calls } = fakeQuery(hangs([textDelta('Working')]));
    const client = new AbortController();
    const turn = await backend(query).reply(req('x', null, client.signal));
    const it = turn.events[Symbol.asyncIterator]();
    expect(await it.next()).toEqual({ done: false, value: { type: 'delta', text: 'Working' } });
    const pending = it.next();
    client.abort();
    await expect(pending).rejects.toThrow(/request was closed/);
    expect(optionsOf(calls, 0).abortController?.signal.aborted).toBe(true);
  });

  it('never starts a run for an already-closed request', async () => {
    const { query, calls } = fakeQuery(scripted([textDelta('x'), success()]));
    const client = new AbortController();
    client.abort();
    const { events, error } = await collectUntilError(await backend(query).reply(req('x', null, client.signal)));
    expect(events).toEqual([]);
    expect(error.message).toMatch(/request was closed/);
    expect(calls).toHaveLength(0);
  });

  it('a newer reply() supersedes the run in flight', async () => {
    const { query, calls } = fakeQuery(hangs([textDelta('first')]), scripted([textDelta('second'), success('sess-2')]));
    const b = backend(query);
    const first = await b.reply(req('one'));
    const it = first.events[Symbol.asyncIterator]();
    await it.next();
    const pending = it.next();
    const second = await b.reply(req('two'));
    await expect(pending).rejects.toThrow(/newer message/);
    expect(optionsOf(calls, 0).abortController?.signal.aborted).toBe(true);
    expect(deltas(await collect(second))).toBe('second');
    expect(second.end().threadId).toBe('sess-2');
  });

  it('stops at the wall-clock timeout', async () => {
    const { query, calls } = fakeQuery(hangs([textDelta('slow')]));
    const { events, error } = await collectUntilError(await backend(query, { timeoutMs: 30 }).reply(req('x')));
    expect(deltas(events)).toBe('slow');
    expect(error.message).toMatch(/no answer within 30 ms/);
    expect(optionsOf(calls, 0).abortController?.signal.aborted).toBe(true);
  });

  it('close() stops the run in flight', async () => {
    const { query } = fakeQuery(hangs([]));
    const b = backend(query);
    const turn = await b.reply(req('x'));
    const pending = collectUntilError(turn);
    await new Promise((r) => setTimeout(r, 5));
    b.close();
    expect((await pending).error.message).toMatch(/shutting down/);
  });

  it('passes maxTurns and reports the cap without a fallback', async () => {
    const { query, calls } = fakeQuery(scripted([maxTurnsResult()]));
    const { error } = await collectUntilError(await backend(query, { maxTurns: 7 }).reply(req('x')));
    expect(optionsOf(calls, 0).maxTurns).toBe(7);
    expect(error.message).toMatch(/7-turn cap/);
    expect(calls).toHaveLength(1);
  });
});

describe('agent chat backend: GLM fallback', () => {
  it('retries once on GLM after a usage-limit error before any text, on the same thread', async () => {
    const { query, calls } = fakeQuery(
      scripted([
        toolUse('mcp__notes__search', {}),
        assistantError('rate_limit', 'Claude AI usage limit reached'),
        errorResult('Claude AI usage limit reached'),
      ]),
      scripted([textDelta('From GLM: A-B32.'), success('sess-glm')]),
    );
    const turn = await backend(query).reply(req('summarize', 'sess-old'));
    const events = await collect(turn);
    expect(events).toEqual([
      { type: 'status', text: 'searching notes' },
      { type: 'status', text: '' },
      { type: 'delta', text: 'From GLM: A-B32.' },
    ]);
    expect(calls).toHaveLength(2);
    const glm = optionsOf(calls, 1);
    expect(glm.env?.ANTHROPIC_BASE_URL).toBe(GLM.baseUrl);
    expect(glm.env?.ANTHROPIC_AUTH_TOKEN).toBe('glm-key');
    expect(glm.env?.ANTHROPIC_MODEL).toBe('glm-5.3');
    expect(glm.model).toBe('glm-5.3');
    expect(glm.resume).toBe('sess-old');
    expect(calls[1]?.prompt).toBe('summarize');
    expect(turn.end()).toEqual({ threadId: 'sess-glm', brain: 'glm' });
  });

  it('retries on an auth failure named only in the result text', async () => {
    const { query, calls } = fakeQuery(
      scripted([errorResult('Not logged in · Please run /login')]),
      scripted([textDelta('ok'), success('sess-glm')]),
    );
    const turn = await backend(query).reply(req('x'));
    await collect(turn);
    expect(calls).toHaveLength(2);
    expect(turn.end().brain).toBe('glm');
  });

  it('retries when the SDK throws an auth error before any text', async () => {
    const { query, calls } = fakeQuery(
      throwsAfter([], 'Claude Code process exited with code 1: Invalid API key · Fix external API key'),
      scripted([textDelta('ok'), success('sess-glm')]),
    );
    const turn = await backend(query).reply(req('x'));
    await collect(turn);
    expect(calls).toHaveLength(2);
    expect(turn.end().brain).toBe('glm');
  });

  it('never retries after text has streamed', async () => {
    const { query, calls } = fakeQuery(
      scripted([textDelta('Partial answer'), assistantError('rate_limit', 'usage limit reached'), errorResult('usage limit reached')]),
      scripted([textDelta('dup'), success()]),
    );
    const { events, error } = await collectUntilError(await backend(query).reply(req('x')));
    expect(deltas(events)).toBe('Partial answer');
    expect(error.message).toMatch(/usage limit/);
    expect(calls).toHaveLength(1);
  });

  it('does not retry an error that is not auth or a limit', async () => {
    const { query, calls } = fakeQuery(
      scripted([assistantError('overloaded', 'Overloaded'), errorResult('API Error: 529 Overloaded')]),
      scripted([textDelta('dup'), success()]),
    );
    const { error } = await collectUntilError(await backend(query).reply(req('x')));
    expect(error.message).toMatch(/Overloaded/);
    expect(calls).toHaveLength(1);
  });

  it('does not retry when GLM is not configured', async () => {
    const { query, calls } = fakeQuery(scripted([assistantError('rate_limit', 'limit'), errorResult('Claude AI usage limit reached')]));
    const { error } = await collectUntilError(await backend(query, { glm: null }).reply(req('x')));
    expect(error.message).toMatch(/usage limit/);
    expect(calls).toHaveLength(1);
  });

  it('does not retry after a stop', async () => {
    const { query, calls } = fakeQuery(hangs([]), scripted([success()]));
    const client = new AbortController();
    const turn = await backend(query).reply(req('x', null, client.signal));
    const pending = collectUntilError(turn);
    await new Promise((r) => setTimeout(r, 5));
    client.abort();
    expect((await pending).error.message).toMatch(/request was closed/);
    expect(calls).toHaveLength(1);
  });
});

describe('agent chat backend: CHAT_BRAIN=glm', () => {
  it('runs on GLM only and labels the turn glm', async () => {
    const { query, calls } = fakeQuery(scripted([textDelta('glm here'), success('sess-g')]));
    const turn = await backend(query, { brain: 'glm' }).reply(req('x'));
    await collect(turn);
    const o = optionsOf(calls, 0);
    expect(o.env?.ANTHROPIC_BASE_URL).toBe(GLM.baseUrl);
    expect(o.env?.ANTHROPIC_AUTH_TOKEN).toBe('glm-key');
    expect(o.model).toBe('glm-5.3');
    expect(turn.end()).toEqual({ threadId: 'sess-g', brain: 'glm' });
  });

  it('never falls back from GLM', async () => {
    const { query, calls } = fakeQuery(
      scripted([assistantError('rate_limit', 'limit'), errorResult('rate limit exceeded')]),
      scripted([success()]),
    );
    const { error } = await collectUntilError(await backend(query, { brain: 'glm' }).reply(req('x')));
    expect(error.message).toMatch(/rate limit/);
    expect(calls).toHaveLength(1);
  });

  it('fails clearly when glm is selected but not configured', async () => {
    const { query, calls } = fakeQuery(scripted([success()]));
    const { error } = await collectUntilError(await backend(query, { brain: 'glm', glm: null }).reply(req('x')));
    expect(error.message).toMatch(/LLM_BASE_URL/);
    expect(calls).toHaveLength(0);
  });
});

// ---------- pasted images ----------

const RED: ChatTurnImage = { id: 'U-PL1', previewPath: '/cache/c_U-PL1/preview.jpg', previewMime: 'image/jpeg', width: 40, height: 30, originalName: 'red.png' };
const BLUE: ChatTurnImage = { id: 'V-QM2', previewPath: '/cache/c_V-QM2/preview.jpg', previewMime: 'image/jpeg', width: 8, height: 8, originalName: null };
const PREVIEWS: Record<string, Uint8Array> = {
  [RED.previewPath]: new Uint8Array([1, 2, 3]),
  [BLUE.previewPath]: new Uint8Array([4, 5, 6, 7]),
};

async function readPreview(absPath: string): Promise<Uint8Array> {
  const bytes = PREVIEWS[absPath];
  if (bytes === undefined) throw new Error(`ENOENT: no such file, open '${absPath}'`);
  return bytes;
}

async function sentMessages(prompt: QueryCall['prompt'] | undefined): Promise<SDKUserMessage[]> {
  if (prompt === undefined || typeof prompt === 'string') throw new Error('expected a user-message stream');
  const out: SDKUserMessage[] = [];
  for await (const m of prompt) out.push(m);
  return out;
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

describe('agent chat backend: pasted images', () => {
  it('sends one user message: an image block per image in order, then the text naming each upload id', async () => {
    const { query, calls } = fakeQuery(scripted([textDelta('Red and blue.'), success()]));
    const turn = await backend(query, {}, { readPreview }).reply(req('what are these?', null, undefined, [RED, BLUE]));
    expect(deltas(await collect(turn))).toBe('Red and blue.');
    const sent = await sentMessages(calls[0]?.prompt);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe('user');
    expect(sent[0]?.parent_tool_use_id).toBeNull();
    expect(sent[0]?.message.role).toBe('user');
    expect(sent[0]?.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64(PREVIEWS[RED.previewPath]!) } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64(PREVIEWS[BLUE.previewPath]!) } },
      {
        type: 'text',
        text:
          'what are these?\n\nThe owner attached 2 images to this message. They are shown above in this order, with these upload ids:\n' +
          '[image upload:U-PL1]\n[image upload:V-QM2]',
      },
    ]);
  });

  it('sends an image with no text', async () => {
    const { query, calls } = fakeQuery(scripted([success()]));
    await collect(await backend(query, {}, { readPreview }).reply(req('', null, undefined, [RED])));
    const sent = await sentMessages(calls[0]?.prompt);
    const content = sent[0]?.message.content;
    expect(Array.isArray(content) ? content.at(-1) : null).toEqual({
      type: 'text',
      text: 'The owner attached 1 image to this message. It is shown above, and its upload id is:\n[image upload:U-PL1]',
    });
  });

  it('keeps a text-only message a plain string prompt', async () => {
    const { query, calls } = fakeQuery(scripted([success()]));
    await collect(await backend(query, {}, { readPreview }).reply(req('hello')));
    expect(calls[0]?.prompt).toBe('hello');
  });

  it('the GLM retry sends the same images again on a fresh stream, reading each preview once', async () => {
    const reads: string[] = [];
    const counting = async (p: string): Promise<Uint8Array> => {
      reads.push(p);
      return readPreview(p);
    };
    const { query, calls } = fakeQuery(
      scripted([assistantError('rate_limit', 'You have hit your usage limit'), errorResult('usage limit reached')]),
      scripted([textDelta('From GLM.'), success('sess-glm')]),
    );
    const turn = await backend(query, {}, { readPreview: counting }).reply(req('look', null, undefined, [RED]));
    expect(deltas(await collect(turn))).toBe('From GLM.');
    expect(calls).toHaveLength(2);
    const first = await sentMessages(calls[0]?.prompt);
    const second = await sentMessages(calls[1]?.prompt);
    expect(second).toEqual(first);
    expect(reads).toEqual([RED.previewPath]);
    expect(turn.end()).toEqual({ threadId: 'sess-glm', brain: 'glm' });
  });

  it('fails the turn before any SDK call when a preview cannot be read, without a fallback', async () => {
    const { query, calls } = fakeQuery(scripted([success()]));
    const missing: ChatTurnImage = { ...RED, id: 'W-RN3', previewPath: '/cache/c_W-RN3/preview.jpg' };
    const { events, error } = await collectUntilError(
      await backend(query, {}, { readPreview }).reply(req('x', null, undefined, [missing])),
    );
    expect(events).toEqual([]);
    expect(error.message).toMatch(/Could not read pasted image W-RN3/);
    expect(calls).toHaveLength(0);
  });
});
