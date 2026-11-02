/**
 * Opt-in live suite: one real Claude message and one real GLM message through the Agent SDK
 * backend. Run with `npm run test:live` (CHAT_LIVE_TEST=1 on top of scripts/test-int.sh, which
 * provides the Docker Postgres). Never part of `npm test` or `npm run test:int`.
 *
 * The daemon runs in-process on port 0 against the Docker test database, never the installed
 * one on 7317: the test seeds a note and the agent may write, and that must not reach the
 * owner's Neon data. The daemon is started with the stub chat backend because only its /mcp is
 * used; the Agent backend under test is built here so each brain can be forced.
 *
 * Needs: the `claude` CLI (NOTESD_CLAUDE_BIN or `claude` on PATH) logged in, and LLM_BASE_URL,
 * LLM_API_KEY, LLM_MODEL in .env.local (a worktree carries a symlink to ~/mcp-notes/.env.local).
 * No session is persisted (`persistSession: false`): each turn's context is the composed prompt.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentChatBackend } from '../../src/chat/agent.js';
import type { ChatBrain, ChatTurnEnd, ChatTurnImage } from '../../src/chat/backend.js';
import { createStubChatBackend } from '../../src/chat/stub.js';
import { loadConfig, type Config } from '../../src/config.js';
import { CHAT_SUBDIR, startDaemon, type RunningDaemon } from '../../src/daemon.js';
import { testDatabaseUrl } from '../integration/setup.js';

/** Per-turn wall clock for the test; the backend's own CHAT_TIMEOUT_MS (default 180 s) fires first. */
const TURN_TIMEOUT_MS = 240_000;

interface LiveAnswer {
  text: string;
  statuses: string[];
  end: ChatTurnEnd;
}

const root = mkdtempSync(join(tmpdir(), 'notesd-live-'));
const dataDir = join(root, 'data');
const tag = `live${randomBytes(4).toString('hex')}`;
const codeword = `kestrel-${randomBytes(3).toString('hex')}`;

let config: Config;
let daemon: RunningDaemon | undefined;
let noteId: string;

beforeAll(async () => {
  config = loadConfig({
    env: {
      ...process.env,
      DATABASE_URL: testDatabaseUrl(),
      NOTESD_PORT: '0',
      NOTES_DATA_DIR: dataDir,
      CHAT_BRAIN: 'claude',
      // Never ingest the real ~/.claude into the test database.
      NOTESD_SESSIONS: 'off',
    },
  });
  daemon = await startDaemon(config, { chat: createStubChatBackend({ delayMs: 0 }), embedder: null, imageEmbedder: null });
  const note = await daemon.deps.service.create({
    body: `Live chat check. The codeword is ${codeword}. #${tag}`,
    origin: null,
  });
  noteId = note.id;
});

afterAll(async () => {
  await daemon?.stop();
  rmSync(root, { recursive: true, force: true });
});

async function ask(brain: ChatBrain, message: string, images: ChatTurnImage[] = []): Promise<LiveAnswer> {
  if (daemon === undefined) throw new Error('daemon did not start');
  const chat: Config['chat'] = { ...config.chat, brain };
  const mcpUrl = `http://127.0.0.1:${daemon.port}/mcp`;
  const backend = createAgentChatBackend({
    chat,
    cwd: join(dataDir, CHAT_SUBDIR),
    mcpUrl: () => mcpUrl,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
  try {
    const turn = await backend.reply({ turn: { text: message, images }, signal: controller.signal });
    let text = '';
    const statuses: string[] = [];
    for await (const event of turn.events) {
      if (event.type === 'delta') text += event.text;
      else if (event.text !== '') statuses.push(event.text);
    }
    return { text, statuses, end: turn.end() };
  } finally {
    clearTimeout(timer);
    backend.close();
  }
}

function codewordPrompt(): string {
  return (
    `Find my note tagged #${tag} and tell me the codeword written in it. ` +
    'Answer in one short sentence and quote the note id.'
  );
}

function expectNotesAnswer(answer: LiveAnswer, brain: ChatBrain): void {
  expect(answer.end.brain).toBe(brain);
  expect(answer.text).toContain(codeword);
  expect(answer.text.toUpperCase()).toContain(noteId);
  expect(answer.statuses.length).toBeGreaterThan(0);
}

describe('chat brain, live', () => {
  it('answers a notes question on Claude, through the notes MCP tools', async () => {
    const answer = await ask('claude', codewordPrompt());
    expectNotesAnswer(answer, 'claude');
  });

  it('answers the same notes question on GLM', async () => {
    if (config.chat.glm === null) {
      throw new Error('LLM_BASE_URL, LLM_API_KEY and LLM_MODEL must be set in .env.local for the GLM live test.');
    }
    const answer = await ask('glm', codewordPrompt());
    expectNotesAnswer(answer, 'glm');
  });

  it('sees an image pasted into the chat bar and names its upload id (Claude)', async () => {
    const previewPath = join(root, 'red-preview.jpg');
    await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 220, g: 20, b: 20 } } })
      .jpeg()
      .toFile(previewPath);
    const answer = await ask(
      'claude',
      'What single colour fills the image I attached? Answer in one short sentence and quote its upload id.',
      [{ id: 'L-IV1', previewPath, previewMime: 'image/jpeg', width: 64, height: 64, originalName: 'red.jpg' }],
    );
    expect(answer.end.brain).toBe('claude');
    expect(answer.text).toMatch(/red/i);
    expect(answer.text.toUpperCase()).toContain('L-IV1');
  });
});
