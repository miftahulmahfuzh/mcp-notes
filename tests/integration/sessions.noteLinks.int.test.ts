import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mcpToolDeps } from '../../src/http/app.js';
import { sessionsApiRoutes } from '../../src/http/sessionsApi.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type { NoteEvent } from '../../src/notes/events.js';
import type { SessionsReadOverrides } from '../../src/sessions/readModel.js';
import { DETAIL_MAX_NOTES } from '../../src/sessions/view.js';
import { createApiHarness, type ApiHarness } from './helpers/api-harness.js';
import { seedGraph, THIS_HOST, writeTranscript } from './helpers/sessionsSeed.js';
import { truncateAll } from './setup.js';

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };
type LinkResult = { note_id: string; node_id: string; session_id: string; linked: boolean; changed: boolean; made: boolean };
type DetailNotes = { notes: Array<{ id: string; kind: string; excerpt: string }> };

const overrides: SessionsReadOverrides = {
  host: THIS_HOST,
  timeZone: 'Asia/Jakarta',
  commitLinks: async () => new Map(),
  live: async () => [],
  search: async () => ({ mode: 'text', fallback: null, hits: [] }),
};

let h: ApiHarness;
let client: Client;
let transcript: { file: string; cleanup: () => Promise<void> };
const seen: NoteEvent[] = [];

function text(r: ToolResult): string {
  return r.content.map((c) => c.text ?? '').join('\n');
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

async function callJson<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const r = await call(name, args);
  expect(r.isError ?? false, text(r)).toBe(false);
  return JSON.parse(text(r)) as T;
}

async function detailNotes(nodeId = 'A0-3G'): Promise<DetailNotes['notes']> {
  return (await callJson<DetailNotes>('session_get', { node_id: nodeId })).notes;
}

async function linkRows(noteId: string): Promise<number> {
  const res = await h.deps.db.execute<{ n: number }>(sql`select count(*)::int as n from note_session_links where note_id = ${noteId}`);
  return res.rows[0]?.n ?? 0;
}

async function backdate(id: string, iso: string): Promise<void> {
  await h.deps.db.execute(sql`update notes set created_at = ${iso}::timestamptz where id = ${id}`);
}

beforeAll(async () => {
  h = await createApiHarness();
  transcript = await writeTranscript();
  h.events.on((e) => seen.push(e));
  const server = createMcpServer(mcpToolDeps(h.deps, overrides));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'note-links-in-process', version: '0.0.0' });
  await client.connect(clientSide);
});

afterAll(async () => {
  await client.close();
  await truncateAll(h.deps.db);
  await transcript.cleanup();
  await h.close();
});

beforeEach(async () => {
  await truncateAll(h.deps.db);
  await seedGraph(h.deps.db, transcript.file);
  seen.length = 0;
});

describe('link_note / unlink_note', () => {
  it('links a note (any id case, no dash) and session_get lists it as linked, without touching the note', async () => {
    const note = await h.notes.create({ body: 'a finding from elsewhere #links', origin: { cwd: '/elsewhere' } });
    seen.length = 0; // drop the create's own event: only link_note's (none) should follow
    const res = await callJson<LinkResult>('link_note', { note_id: note.id.replace('-', '').toLowerCase(), node_id: 'a03g' });
    expect(res).toEqual({ note_id: note.id, node_id: 'A0-3G', session_id: 'sess-root', linked: true, changed: true, made: false });
    expect(await detailNotes()).toEqual([expect.objectContaining({ id: note.id, kind: 'linked', excerpt: 'a finding from elsewhere #links' })]);
    const after = await h.notes.getOne(note.id);
    expect(after?.origin).toEqual(note.origin);
    expect(after?.updated_at).toBe(note.updated_at);
    expect(after?.body).toBe(note.body);
    expect(seen).toEqual([]);
  });

  it('linking twice is a no-op success', async () => {
    const note = await h.notes.create({ body: 'twice' });
    await callJson<LinkResult>('link_note', { note_id: note.id, node_id: 'A0-3G' });
    const again = await callJson<LinkResult>('link_note', { note_id: note.id, node_id: 'A0-3G' });
    expect(again).toMatchObject({ linked: true, changed: false });
    expect(await linkRows(note.id)).toBe(1);
    expect((await detailNotes()).map((n) => n.id)).toEqual([note.id]);
  });

  it('unlink removes the link; unlinking again is a no-op success', async () => {
    const note = await h.notes.create({ body: 'unlink me' });
    await callJson<LinkResult>('link_note', { note_id: note.id, node_id: 'A0-3G' });
    const off = await callJson<LinkResult>('unlink_note', { note_id: note.id, node_id: 'A0-3G' });
    expect(off).toMatchObject({ note_id: note.id, node_id: 'A0-3G', linked: false, changed: true });
    expect(await detailNotes()).toEqual([]);
    const again = await callJson<LinkResult>('unlink_note', { note_id: note.id, node_id: 'A0-3G' });
    expect(again).toMatchObject({ linked: false, changed: false });
    expect(await linkRows(note.id)).toBe(0);
    expect(seen).toEqual([expect.objectContaining({ op: 'created' })]);
  });

  it('an unknown or malformed note id is refused', async () => {
    const unknown = await call('link_note', { note_id: 'Z-ZZZ', node_id: 'A0-3G' });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toMatch(/^not_found: Note Z-ZZZ does not exist/);
    const bad = await call('link_note', { note_id: 'not a note', node_id: 'A0-3G' });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/^invalid_id:/);
    const unlinkUnknown = await call('unlink_note', { note_id: 'Z-ZZZ', node_id: 'A0-3G' });
    expect(text(unlinkUnknown)).toMatch(/^not_found: Note Z-ZZZ does not exist/);
  });

  it('a deleted note cannot be linked, drops out of session detail, and can still be unlinked', async () => {
    const gone = await h.notes.create({ body: 'deleted before linking' });
    await h.notes.delete(gone.id);
    const res = await call('link_note', { note_id: gone.id, node_id: 'A0-3G' });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(new RegExp(`^deleted: Note ${gone.id} is deleted`));
    expect(await linkRows(gone.id)).toBe(0);

    const later = await h.notes.create({ body: 'deleted after linking' });
    await callJson<LinkResult>('link_note', { note_id: later.id, node_id: 'A0-3G' });
    await h.notes.delete(later.id);
    expect(await detailNotes()).toEqual([]);
    expect(await callJson<LinkResult>('unlink_note', { note_id: later.id, node_id: 'A0-3G' })).toMatchObject({ changed: true });
  });

  it('an unknown node answers not_found, a note id as node id answers invalid_node_id', async () => {
    const note = await h.notes.create({ body: 'x' });
    for (const name of ['link_note', 'unlink_note']) {
      const missing = await call(name, { note_id: note.id, node_id: 'ZZ-ZZ' });
      expect(missing.isError).toBe(true);
      expect(text(missing)).toMatch(/^not_found: no session ZZ-ZZ/);
      const bad = await call(name, { note_id: note.id, node_id: 'A-B32' });
      expect(bad.isError).toBe(true);
      expect(text(bad)).toMatch(/^invalid_node_id:/);
    }
    expect(await linkRows(note.id)).toBe(0);
  });

  it('made ∪ linked: newest first, a note both made and linked is listed once as made', async () => {
    const made = await h.notes.create({ body: 'made here', origin: { claude_session: 'sess-root' } });
    const linked = await h.notes.create({ body: 'linked here' });
    const both = await h.notes.create({ body: 'made and linked', origin: { claude_session: 'sess-root' } });
    const elsewhere = await h.notes.create({ body: 'made in a child', origin: { claude_session: 'sess-b1' } });
    await backdate(made.id, '2026-11-01T00:00:00Z');
    await backdate(linked.id, '2026-11-02T00:00:00Z');
    await backdate(both.id, '2026-11-03T00:00:00Z');
    await callJson<LinkResult>('link_note', { note_id: linked.id, node_id: 'A0-3G' });
    const bothRes = await callJson<LinkResult>('link_note', { note_id: both.id, node_id: 'A0-3G' });
    expect(bothRes).toMatchObject({ changed: true, made: true });

    expect((await detailNotes()).map((n) => [n.id, n.kind])).toEqual([
      [both.id, 'made'],
      [linked.id, 'linked'],
      [made.id, 'made'],
    ]);
    // Linking the child's note to the root does not move it out of the child.
    await callJson<LinkResult>('link_note', { note_id: elsewhere.id, node_id: 'A0-3G' });
    expect((await detailNotes('B1-22')).map((n) => [n.id, n.kind])).toEqual([[elsewhere.id, 'made']]);
    expect((await detailNotes()).find((n) => n.id === elsewhere.id)?.kind).toBe('linked');
    // The HTTP detail the wall reads (Phase 2's input) carries the same list and kinds.
    const app = new Hono();
    app.route('/', sessionsApiRoutes(h.deps, overrides));
    const res = await app.request('/api/sessions/A0-3G');
    expect(res.status).toBe(200);
    const body = (await res.json()) as DetailNotes;
    expect(body.notes.map((n) => [n.id, n.kind])).toEqual((await detailNotes()).map((n) => [n.id, n.kind]));
  });

  it('DETAIL_MAX_NOTES caps the union, not each half', async () => {
    await h.deps.db.execute(sql`
      insert into notes (id, body, origin, created_at, updated_at)
      select 'M-' || lpad(g::text, 3, '0'), 'made ' || g, '{"claude_session":"sess-root"}'::jsonb,
             '2026-01-01T00:00:00Z'::timestamptz + g * interval '1 minute', now()
      from generate_series(1, ${DETAIL_MAX_NOTES}) g`);
    const newest = await h.notes.create({ body: 'newest, linked' });
    await callJson<LinkResult>('link_note', { note_id: newest.id, node_id: 'A0-3G' });
    const notes = await detailNotes();
    expect(notes).toHaveLength(DETAIL_MAX_NOTES);
    expect(notes[0]).toMatchObject({ id: newest.id, kind: 'linked' });
    expect(notes.some((n) => n.id === 'M-001')).toBe(false);
  });

  it('purging a note or removing a session drops its links', async () => {
    const note = await h.notes.create({ body: 'to be purged' });
    await callJson<LinkResult>('link_note', { note_id: note.id, node_id: 'A0-3G' });
    await callJson<LinkResult>('link_note', { note_id: note.id, node_id: 'B1-22' });
    expect(await linkRows(note.id)).toBe(2);
    await h.deps.db.execute(sql`delete from cc_sessions where session_id = 'sess-b1'`);
    expect(await linkRows(note.id)).toBe(1);
    await h.notes.delete(note.id);
    await h.notes.purgeNote(note.id);
    expect(await linkRows(note.id)).toBe(0);
  });
});
