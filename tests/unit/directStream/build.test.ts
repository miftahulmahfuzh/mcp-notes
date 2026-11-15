import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config.js';
import type { Db } from '../../../src/db/client.js';
import type { DirectStreamRunner } from '../../../src/directStream/runner.js';
import { DirectStreamService, buildDirectStreamService } from '../../../src/directStream/service.js';

const URL_A = 'postgres://u:p@127.0.0.1:5432/a';
const db = {} as Db;
const pageBase = (): string => 'http://localhost:7317';
const config = (env: Record<string, string>) => loadConfig({ env: { DATABASE_URL: URL_A, ...env }, envFile: false });

describe('buildDirectStreamService', () => {
  it('builds nothing while any switch is off, so nothing can reach the resolver or Chrome', () => {
    const calls: string[][] = [];
    const runner: DirectStreamRunner = async (args) => {
      calls.push(args);
      return { ok: true };
    };
    const movies = { host: 'host-a' };
    expect(buildDirectStreamService(config({ NOTESD_DIRECT_STREAM: 'off' }), db, { movies, pageBase }, { runner })).toBeNull();
    expect(buildDirectStreamService(config({ NOTESD_MOVIES: 'off' }), db, { movies, pageBase }, { runner })).toBeNull();
    expect(buildDirectStreamService(config({}), db, { movies: null, pageBase }, { runner })).toBeNull();
    const { directStream: _absent, ...withoutSection } = config({});
    expect(buildDirectStreamService(withoutSection, db, { movies, pageBase }, { runner })).toBeNull();
    expect(calls).toEqual([]);
  });

  it('builds the service when direct streaming and movies are both on', () => {
    const svc = buildDirectStreamService(config({}), db, { movies: { host: 'host-a' }, pageBase });
    expect(svc).toBeInstanceOf(DirectStreamService);
    expect(svc?.host).toBe('host-a');
  });
});
