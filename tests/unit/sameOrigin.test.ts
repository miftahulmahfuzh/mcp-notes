import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { isLoopbackUrl, isSameOrigin, sameOriginOnly } from '../../src/http/sameOrigin.js';

function guarded(): Hono {
  const app = new Hono();
  app.use('/guarded', sameOriginOnly);
  app.post('/guarded', (c) => c.json({ ok: true }));
  return app;
}

async function post(url: string, origin?: string): Promise<Response> {
  return guarded().request(url, { method: 'POST', headers: origin === undefined ? {} : { origin } });
}

describe('sameOriginOnly', () => {
  it("lets notesd's own page through on every loopback spelling", async () => {
    expect((await post('http://localhost:7317/guarded', 'http://localhost:7317')).status).toBe(200);
    expect((await post('http://127.0.0.1:7317/guarded', 'http://127.0.0.1:7317')).status).toBe(200);
    expect((await post('http://[::1]:7317/guarded', 'http://[::1]:7317')).status).toBe(200);
  });

  it('refuses a request without an Origin', async () => {
    const res = await post('http://localhost:7317/guarded');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden_origin' });
  });

  it('refuses a foreign, cross-port, cross-spelling or unparseable Origin', async () => {
    for (const origin of ['https://evil.example', 'http://localhost:9999', 'http://127.0.0.1:7317', 'null', 'not a url', '']) {
      const res = await post('http://localhost:7317/guarded', origin);
      expect(res.status, origin).toBe(403);
      expect(await res.json(), origin).toEqual({ error: 'forbidden_origin' });
    }
  });

  it('refuses a non-loopback host even when the Origin matches it', async () => {
    expect((await post('http://notes.example.com/guarded', 'http://notes.example.com')).status).toBe(403);
  });
});

describe('isLoopbackUrl / isSameOrigin', () => {
  it('recognises loopback hosts only', () => {
    expect(isLoopbackUrl('http://localhost:7317/x')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1/')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:1/')).toBe(true);
    expect(isLoopbackUrl('http://192.168.1.2/')).toBe(false);
    expect(isLoopbackUrl('garbage')).toBe(false);
  });

  it('compares scheme, host and port', () => {
    expect(isSameOrigin('http://localhost:7317', 'http://localhost:7317/api/x')).toBe(true);
    expect(isSameOrigin('https://localhost:7317', 'http://localhost:7317/api/x')).toBe(false);
    expect(isSameOrigin(undefined, 'http://localhost:7317/api/x')).toBe(false);
  });
});
