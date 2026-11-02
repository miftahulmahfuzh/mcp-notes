import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatThreadDetail, ChatTimelinePage } from '../../src/chat/types.js';
import { createApiHarness, type ApiHarness } from './helpers/api-harness.js';
import { createScriptedChatBackend, type ScriptedChatBackend } from './helpers/scripted-chat.js';
import { parseSse } from './helpers/sse.js';
import { truncateAll } from './setup.js';

interface Done {
  thread_id: string;
  user_message_id: string;
  assistant_message_id: string;
}

let f: ApiHarness;
let fake: ScriptedChatBackend;

beforeAll(async () => {
  fake = createScriptedChatBackend();
  f = await createApiHarness({ chat: fake, sseHeartbeatMs: 50 });
});

afterAll(async () => {
  await f.close();
});

beforeEach(async () => {
  await truncateAll(f.deps.db);
});

async function ask(payload: Record<string, unknown>, answer = 'ok'): Promise<Done> {
  fake.push({ steps: [{ type: 'delta', text: answer }], end: { brain: 'claude' } });
  const res = await f.sendJson('POST', '/api/chat', payload);
  expect(res.status).toBe(200);
  const messages = parseSse(await res.text());
  const last = messages.at(-1);
  expect(last?.event).toBe('done');
  return last!.data as Done;
}

async function thread(id: string): Promise<ChatThreadDetail> {
  const res = await f.request(`/api/chat/threads/${id}`);
  expect(res.status).toBe(200);
  return (await res.json()) as ChatThreadDetail;
}

async function timeline(query: string): Promise<ChatTimelinePage> {
  const res = await f.request(`/api/chat/messages${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as ChatTimelinePage;
}

describe('POST /api/chat with a project', () => {
  it('creates a project thread, continues it, and tells the brain the project', async () => {
    const d1 = await ask({ message: 'what did the orch do?', project: 'mcp-notes' }, 'It landed p3.');
    expect((await thread(d1.thread_id)).thread.project).toBe('mcp-notes');
    const first = fake.requests.at(-1)!.turn.text;
    expect(first.startsWith('<project>\nrepo: mcp-notes\n')).toBe(true);
    expect(first).toContain('sessions_search');

    const d2 = await ask({ message: 'and p4?', thread_id: d1.thread_id, project: 'mcp-notes' });
    expect(d2.thread_id).toBe(d1.thread_id);
    const second = fake.requests.at(-1)!.turn.text;
    expect(second.startsWith('<project>\nrepo: mcp-notes\n')).toBe(true);
    expect(second).toContain('): It landed p3.');
  });

  it('leaves wall chat alone: no project, no block', async () => {
    const d = await ask({ message: 'what did I save?' });
    expect((await thread(d.thread_id)).thread.project).toBeNull();
    expect(fake.requests.at(-1)!.turn.text).not.toContain('<project>');
  });

  it('never moves a thread to another project', async () => {
    const p = await ask({ message: 'p', project: 'mcp-notes' });
    const other = await ask({ message: 'q', thread_id: p.thread_id, project: 'seer' });
    expect(other.thread_id).not.toBe(p.thread_id);
    expect((await thread(other.thread_id)).thread.project).toBe('seer');

    const wallFromProject = await ask({ message: 'r', thread_id: p.thread_id });
    expect(wallFromProject.thread_id).not.toBe(p.thread_id);
    expect((await thread(wallFromProject.thread_id)).thread.project).toBeNull();

    const projectFromWall = await ask({ message: 's', thread_id: wallFromProject.thread_id, project: 'mcp-notes' });
    expect(projectFromWall.thread_id).not.toBe(wallFromProject.thread_id);
    expect((await thread(projectFromWall.thread_id)).thread.project).toBe('mcp-notes');
  });

  it('refuses a bad project key before writing anything', async () => {
    for (const project of ['', '   ', '<x>', 'a\nb', 'x'.repeat(201)]) {
      const res = await f.sendJson('POST', '/api/chat', { message: 'hi', project });
      expect(res.status).toBe(400);
    }
    expect((await timeline('?include_deleted=1')).messages).toEqual([]);
  });
});

describe('GET /api/chat/messages?project=', () => {
  it("lists only that project's threads, pages inside the project, and leaves the unfiltered timeline whole", async () => {
    await ask({ message: 'w1' }, 'wa1');
    const p1 = await ask({ message: 'p1', project: 'mcp-notes' }, 'pa1');
    await ask({ message: 's1', project: 'seer' }, 'sa1');
    await ask({ message: 'p2', thread_id: p1.thread_id, project: 'mcp-notes' }, 'pa2');
    await ask({ message: 'w2' }, 'wa2');

    const all = await timeline('?project=mcp-notes');
    expect(all.messages.map((m) => m.text)).toEqual(['p1', 'pa1', 'p2', 'pa2']);
    expect(new Set(all.messages.map((m) => m.thread_id))).toEqual(new Set([p1.thread_id]));
    expect(all.next_before).toBeNull();

    const page1 = await timeline('?project=mcp-notes&limit=2');
    expect(page1.messages.map((m) => m.text)).toEqual(['p2', 'pa2']);
    expect(page1.next_before).not.toBeNull();
    const page2 = await timeline(`?project=mcp-notes&limit=2&before=${encodeURIComponent(page1.next_before!)}`);
    expect(page2.messages.map((m) => m.text)).toEqual(['p1', 'pa1']);
    expect(page2.next_before).toBeNull();

    expect((await timeline('?project=seer')).messages.map((m) => m.text)).toEqual(['s1', 'sa1']);
    expect((await timeline('?project=nothing-here')).messages).toEqual([]);
    expect((await timeline('')).messages.map((m) => m.text)).toEqual(['w1', 'wa1', 'p1', 'pa1', 's1', 'sa1', 'p2', 'pa2', 'w2', 'wa2']);
  });

  it('refuses a bad project filter', async () => {
    for (const q of ['?project=', '?project=%3Cx%3E', '?project=a%0Ab']) {
      expect((await f.request(`/api/chat/messages${q}`)).status).toBe(400);
    }
  });
});
