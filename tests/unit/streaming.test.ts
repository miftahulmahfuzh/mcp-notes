import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_STREAMING_CLI, scriptRunner } from '../../src/streaming/service.js';
import { existsSync } from 'node:fs';

describe('scriptRunner', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'streaming-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const script = async (body: string): Promise<string> => {
    const file = path.join(dir, 'cli.mjs');
    await writeFile(file, body);
    return file;
  };

  it('points at the script in the repository by default', () => {
    expect(DEFAULT_STREAMING_CLI.endsWith(path.join('claude', 'streaming', 'cli.mjs'))).toBe(true);
    expect(existsSync(DEFAULT_STREAMING_CLI)).toBe(true);
  });

  it('passes the site and the arguments and returns the printed JSON', async () => {
    const cliPath = await script('console.log(JSON.stringify({ ok: true, argv: process.argv.slice(2) }));');
    expect(await scriptRunner({ cliPath })('lk21', ['--play', 'ready or not', '2019'])).toEqual({ ok: true, argv: ['lk21', '--play', 'ready or not', '2019'] });
  });

  it('returns the answer of a script that exits 1 with one', async () => {
    const cliPath = await script('console.log(JSON.stringify({ ok: false, error: "HTTP 403" })); process.exitCode = 1;');
    expect(await scriptRunner({ cliPath })('idlix', ['x'])).toEqual({ ok: false, error: 'HTTP 403' });
  });

  it('throws when the script prints nothing or no JSON', async () => {
    await expect(scriptRunner({ cliPath: await script('process.exitCode = 1;') })('idlix', ['x'])).rejects.toThrow(/streaming script failed/);
    await expect(scriptRunner({ cliPath: await script('console.log("oops");') })('idlix', ['x'])).rejects.toThrow(/printed no JSON/);
  });

  it('keeps the last lines of a crashed script\'s stderr in its error, with no secret in them', async () => {
    const body = [
      'for (let i = 1; i <= 30; i++) console.error(`noise line ${i}`);',
      'console.error("fetching https://sub.wyzie.ru/search?id=tt1&key=wyzie-secret-123 and /api/stream/dl/x?tok=abc123def");',
      'console.error("OPENROUTER_API_KEY=sk-or-v1-0123456789abcdefABCDEF0123456789");',
      'console.error("magnet:?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01&dn=Film");',
      'throw new TypeError("Cannot read properties of undefined (reading \'frames\')");',
    ].join('\n');
    const err = await scriptRunner({ cliPath: await script(body) })('idlix', ['x']).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toMatch(/^streaming script failed: Command failed/);
    expect(message).toContain("TypeError: Cannot read properties of undefined (reading 'frames')");
    expect(message).toContain('stderr:');
    expect(message).not.toContain('noise line 1 ');
    expect(message).not.toMatch(/wyzie-secret|tok=|abc123def|sk-or-v1|btih/);
    expect(message.length).toBeLessThan(1_500);
  });

  it('gives up on a script that hangs', async () => {
    const cliPath = await script('setTimeout(() => {}, 60000);');
    await expect(scriptRunner({ cliPath, timeoutMs: 300 })('idlix', ['x'])).rejects.toThrow(/streaming script failed/);
  });
});
