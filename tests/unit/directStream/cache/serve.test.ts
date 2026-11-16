import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileResponse, parseRange } from '../../../../src/directStream/cache/serve.js';

describe('parseRange', () => {
  it('reads one range against a size', () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
  });
  it('refuses what cannot be served', () => {
    expect(parseRange('bytes=100-', 100)).toBe('invalid');
    expect(parseRange('bytes=9-1', 100)).toBe('invalid');
    expect(parseRange('bytes=0-1,5-6', 100)).toBe('invalid');
    expect(parseRange('items=0-1', 100)).toBe('invalid');
  });
});

describe('fileResponse', () => {
  let dir: string;
  let file: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'cache-serve-'));
    file = path.join(dir, 'v-00001.ts');
    await writeFile(file, Buffer.from(Array.from({ length: 100 }, (_, i) => i)));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('answers the whole file, a range, and 416 past the end', async () => {
    const whole = await fileResponse(file, 'v-00001.ts', null);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('video/mp2t');
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect((await whole.arrayBuffer()).byteLength).toBe(100);
    const part = await fileResponse(file, 'v-00001.ts', 'bytes=10-19');
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 10-19/100');
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    const past = await fileResponse(file, 'v-00001.ts', 'bytes=200-');
    expect(past.status).toBe(416);
    expect(past.headers.get('content-range')).toBe('bytes */100');
  });
});
