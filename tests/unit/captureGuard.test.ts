import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { captureGuard, decodeImageBase64 } from '../../src/http/capture.js';

function app(): Hono {
  const a = new Hono();
  a.use('/c', captureGuard);
  a.post('/c', (c) => c.json({ ok: true }));
  return a;
}

async function post(url: string, headers: Record<string, string>): Promise<Response> {
  return app().request(url, { method: 'POST', headers, body: '{}' });
}

const good = { 'content-type': 'application/json', 'x-notes-capture': '1' };

describe('captureGuard', () => {
  it('lets the hook through: loopback, no Origin, header, JSON', async () => {
    expect((await post('http://127.0.0.1:7317/c', good)).status).toBe(200);
    expect((await post('http://localhost:7317/c', { ...good, 'content-type': 'application/json; charset=utf-8' })).status).toBe(200);
    expect((await post('http://127.0.0.1:7317/c', { ...good, origin: 'http://localhost:7317' })).status).toBe(200);
  });

  it('refuses a non-loopback host, a foreign Origin, a missing header, non-JSON', async () => {
    expect(await (await post('http://notes.example/c', good)).json()).toEqual({ error: 'forbidden_host' });
    expect(await (await post('http://127.0.0.1:7317/c', { ...good, origin: 'https://evil.example' })).json()).toEqual({ error: 'forbidden_origin' });
    expect((await post('http://127.0.0.1:7317/c', { ...good, origin: 'null' })).status).toBe(403);
    const noHeader = await post('http://127.0.0.1:7317/c', { 'content-type': 'application/json' });
    expect(noHeader.status).toBe(403);
    expect(await noHeader.json()).toEqual({ error: 'capture_header_required' });
    expect((await post('http://127.0.0.1:7317/c', { ...good, 'x-notes-capture': '0' })).status).toBe(403);
    expect((await post('http://127.0.0.1:7317/c', { ...good, 'content-type': 'text/plain' })).status).toBe(415);
  });
});

describe('decodeImageBase64', () => {
  it('decodes strict base64 and refuses anything else', () => {
    expect(decodeImageBase64('aGk=')?.toString()).toBe('hi');
    expect(decodeImageBase64('aG\nk=')?.toString()).toBe('hi');
    expect(decodeImageBase64('aGk')).toBeNull();
    expect(decodeImageBase64('a$k=')).toBeNull();
    expect(decodeImageBase64('')).toBeNull();
  });
});
