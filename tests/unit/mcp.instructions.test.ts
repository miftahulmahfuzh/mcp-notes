import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import type { AppDeps } from '../../src/deps.js';
import { loopbackOnly, mcpToolDeps } from '../../src/http/app.js';
import { DEFAULT_WALL_URL, buildInstructions, wallUrlForPort } from '../../src/mcp/instructions.js';
import { handleMcpRequest } from '../../src/mcp/server.js';
import { toFilter, type ToolDeps } from '../../src/mcp/tools.js';
import type { NotesService } from '../../src/notes/service.js';

describe('buildInstructions', () => {
  it('explains ids, lookup, tags, dates and who does comparisons', () => {
    const text = buildInstructions('Asia/Jakarta');
    expect(text).toContain('A-B32');
    expect(text).toMatch(/case-insensitive/);
    expect(text).toMatch(/missing dash/);
    expect(text).toMatch(/#hashtags/);
    expect(text).toContain('Asia/Jakarta');
    expect(text).toMatch(/Comparisons and summaries/);
  });

  it('has exactly one connectors paragraph: read-only, the three systems, curated tools first', () => {
    const paragraphs = buildInstructions('Asia/Jakarta')
      .split('\n\n')
      .filter((p) => p.startsWith('Connectors.'));
    expect(paragraphs).toHaveLength(1);
    const p = paragraphs[0]!;
    expect(p).toMatch(/read-only/);
    for (const word of ['expense-tracking', 'run-insights', 'Seer', 'lab.sqlite', 'Asia/Jakarta', 'rupiah']) expect(p).toContain(word);
    expect(p).toContain('Prefer the curated tools');
    expect(p).toContain("only when they don't answer");
    expect(p).toContain('_schema before writing SQL');
    for (const name of ['expenses_spending', 'runs_review', 'seer_sera_best']) expect(p).toContain(name);
    expect(p).not.toContain('expenses_schema,');
  });

  it('says search understands meaning, offers mode "text" and explains the fallback', () => {
    const paragraphs = buildInstructions('Asia/Jakarta')
      .split('\n\n')
      .filter((p) => p.startsWith('Reading.'));
    expect(paragraphs).toHaveLength(1);
    const p = paragraphs[0]!;
    expect(p).toContain('search understands meaning, not only words');
    expect(p).toContain('mode "hybrid"');
    expect(p).toContain('mode "text"');
    expect(p).toContain('fallback');
    expect(p).toContain('ArangoDB credentials');
    expect(p).toMatch(/no stemming/);
  });

  it('has one Related paragraph that names related(id), the score and what it leaves out', () => {
    const paragraphs = buildInstructions('Asia/Jakarta')
      .split('\n\n')
      .filter((p) => p.startsWith('Related.'));
    expect(paragraphs).toHaveLength(1);
    const p = paragraphs[0]!;
    expect(p).toContain('related(id)');
    expect(p).toContain('similarity');
    expect(p).toContain('never the note itself or a deleted note');
  });

  it('has one Attaching paragraph: attach_image copies and dedupes, remove_image is soft, restore_image undoes it', () => {
    const paragraphs = buildInstructions('Asia/Jakarta')
      .split('\n\n')
      .filter((p) => p.startsWith('Attaching.'));
    expect(paragraphs).toHaveLength(1);
    const p = paragraphs[0]!;
    for (const word of ['attach_image(id, path)', 'remove_image(image_id)', 'restore_image(image_id)', 'attached: false', 'soft', 'old position']) {
      expect(p).toContain(word);
    }
    expect(p).toContain('copied, not moved');
    expect(p).toContain('Nothing you can call deletes a note or an image permanently');
  });

  it('has one Files paragraph: files are visible by name, type and size but not readable, and no tool writes them', () => {
    const text = buildInstructions('Asia/Jakarta');
    const paragraphs = text.split('\n\n').filter((p) => p.startsWith('Files.'));
    expect(paragraphs).toHaveLength(1);
    const p = paragraphs[0]!;
    expect(p).toContain('files array');
    expect(p).toContain('cannot open or read');
    expect(p).toContain('extraction_status');
    expect(p).toContain('No tool attaches, removes or restores files');
    const notes = text.split('\n\n').find((s) => s.startsWith('Notes.'))!;
    expect(notes).toContain('files (an array, empty when the note has none)');
    const order = text.split('\n\n').map((s) => s.split('.')[0]);
    expect(order.indexOf('Files')).toBe(order.indexOf('Attaching') + 1);
  });

  it('has one Similar images paragraph: the four sources, what it leaves out, view_images after', () => {
    const paragraphs = buildInstructions('Asia/Jakarta')
      .split('\n\n')
      .filter((p) => p.startsWith('Similar images.'));
    expect(paragraphs).toHaveLength(1);
    const p = paragraphs[0]!;
    for (const word of ['similar_images', 'image_id', 'upload_id', 'query', 'pasted_image', '[image upload:ID]', 'view_images']) {
      expect(p).toContain(word);
    }
    expect(p).toContain('never the source image, a removed image or an image of a deleted note');
    const order = buildInstructions('Asia/Jakarta').split('\n\n').map((s) => s.split('.')[0]);
    expect(order.indexOf('Similar images')).toBe(order.indexOf('Files') + 1);
  });
});

function linksParagraphs(text: string): string[] {
  return text.split('\n\n').filter((p) => p.startsWith('Links.'));
}

describe('Links paragraph', () => {
  it('has exactly one, after Ids, naming the default wall and the exact link form', () => {
    const text = buildInstructions('Asia/Jakarta');
    const paragraphs = linksParagraphs(text);
    expect(paragraphs).toHaveLength(1);
    const p = paragraphs[0]!;
    expect(DEFAULT_WALL_URL).toBe('http://localhost:7317');
    expect(p).toContain('http://localhost:7317');
    expect(p).toContain('[A-B32](http://localhost:7317/?note=A-B32)');
    expect(p).toContain('Every time you mention a note id to the user');
    expect(p).toContain('canonical id');
    expect(p).toContain('never put them in note bodies');
    expect(p).toContain('never in tool arguments');
    expect(p).toContain('code span');
    const order = text.split('\n\n').map((s) => s.split('.')[0]);
    expect(order.indexOf('Links')).toBe(order.indexOf('Ids') + 1);
  });

  it('uses a non-default port everywhere and never mentions 7317', () => {
    const text = buildInstructions('Asia/Jakarta', 'http://localhost:4321');
    const p = linksParagraphs(text)[0]!;
    expect(p).toContain('[A-B32](http://localhost:4321/?note=A-B32)');
    expect(p).toContain('is at http://localhost:4321,');
    expect(text).not.toContain('7317');
  });

  it('drops a trailing slash from the wall URL', () => {
    const p = linksParagraphs(buildInstructions('Asia/Jakarta', 'http://localhost:4321/'))[0]!;
    expect(p).toContain('[A-B32](http://localhost:4321/?note=A-B32)');
    expect(p).not.toContain('4321//');
  });
});

describe('wall URL from the configured port', () => {
  it('wallUrlForPort builds localhost URLs and refuses port 0 and non-ports', () => {
    expect(wallUrlForPort(7317)).toBe('http://localhost:7317');
    expect(wallUrlForPort(4321)).toBe('http://localhost:4321');
    expect(wallUrlForPort(0)).toBeUndefined();
    expect(wallUrlForPort(-1)).toBeUndefined();
    expect(wallUrlForPort(70000)).toBeUndefined();
    expect(wallUrlForPort(1.5)).toBeUndefined();
  });

  function appDeps(port: number): AppDeps {
    // Only config.port, config.dataDir, service and db are read by mcpToolDeps.
    return { config: { port, dataDir: '/nonexistent' }, service: {}, db: {} } as unknown as AppDeps;
  }

  it('mcpToolDeps carries Config.port into ToolDeps.wallUrl, and leaves it out for port 0', () => {
    expect(mcpToolDeps(appDeps(4321)).wallUrl).toBe('http://localhost:4321');
    expect(mcpToolDeps(appDeps(7317)).wallUrl).toBe('http://localhost:7317');
    expect('wallUrl' in mcpToolDeps(appDeps(0))).toBe(false);
    expect(mcpToolDeps(appDeps(4321)).dataDir).toBe('/nonexistent');
  });

  async function initializeInstructions(deps: ToolDeps): Promise<string> {
    // In-process: handleMcpRequest takes a web Request, so nothing listens on any port.
    const res = await handleMcpRequest(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'unit', version: '0' } },
        }),
      }),
      deps,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { instructions?: string } };
    return body.result?.instructions ?? '';
  }

  // Tool registration is lazy (no service, db or connector call happens on initialize), so fakes suffice.
  const fakeDeps = (wallUrl?: string): ToolDeps => ({
    service: {} as NotesService,
    dataDir: '/nonexistent',
    db: {} as Db,
    ...(wallUrl !== undefined ? { wallUrl } : {}),
  });

  it('the MCP initialize answer names the configured wall URL', async () => {
    const custom = await initializeInstructions(fakeDeps('http://localhost:4321'));
    expect(custom).toContain('[A-B32](http://localhost:4321/?note=A-B32)');
    expect(custom).not.toContain('7317');
    const fallback = await initializeInstructions(fakeDeps());
    expect(fallback).toContain('[A-B32](http://localhost:7317/?note=A-B32)');
  });
});

describe('toFilter', () => {
  it('maps snake_case args and applies the MCP default limit', () => {
    expect(toFilter({})).toEqual({ limit: 50 });
    expect(
      toFilter({ tags_any: ['a'], tags_all: ['b'], date_field: 'updated', from: '2026-10-01', to: '2026-10-31', deleted: 'only', limit: 5, cursor: 'c' }),
    ).toEqual({ tagsAny: ['a'], tagsAll: ['b'], dateField: 'updated', from: '2026-10-01', to: '2026-10-31', deleted: 'only', limit: 5, cursor: 'c' });
  });
});

describe('loopbackOnly', () => {
  const app = new Hono();
  app.use('*', loopbackOnly);
  app.post('/mcp', (c) => c.text('ok'));

  it('allows loopback hosts without or with a loopback Origin', async () => {
    expect((await app.request('http://localhost:7317/mcp', { method: 'POST' })).status).toBe(200);
    expect((await app.request('http://127.0.0.1:7317/mcp', { method: 'POST', headers: { origin: 'http://localhost:7317' } })).status).toBe(200);
  });

  it('blocks other hosts and foreign origins', async () => {
    expect((await app.request('http://notes.attacker.test/mcp', { method: 'POST' })).status).toBe(403);
    expect((await app.request('http://localhost:7317/mcp', { method: 'POST', headers: { origin: 'https://attacker.test' } })).status).toBe(403);
    expect((await app.request('http://localhost:7317/mcp', { method: 'POST', headers: { origin: 'null' } })).status).toBe(403);
  });
});
