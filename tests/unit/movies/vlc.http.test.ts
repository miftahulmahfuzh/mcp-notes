import { describe, expect, it } from 'vitest';
import { curlStatusReader, interpretCurl, parseStatusJson, type ExecFn } from '../../../src/movies/vlc/http.js';

const EP = { port: 47318, password: 'pw' };
const STATUS = JSON.stringify({ state: 'playing', time: 1210, length: 7198, position: 0.168, information: {} });

describe('interpretCurl', () => {
  it('exit 7 means VLC is gone', () => {
    expect(interpretCurl({ exitCode: 7, stdout: '' })).toEqual({ kind: 'gone' });
  });
  it('401 means the port is someone else\'s', () => {
    expect(interpretCurl({ exitCode: 0, stdout: '\n401' })).toEqual({ kind: 'unauthorized' });
  });
  it('200 with status.json is a status', () => {
    expect(interpretCurl({ exitCode: 0, stdout: `${STATUS}\n200` })).toEqual({ kind: 'ok', status: { state: 'playing', time: 1210, length: 7198 } });
  });
  it('a timeout or junk is an error, not gone', () => {
    expect(interpretCurl({ exitCode: 28, stdout: '' })).toEqual({ kind: 'error', message: 'curl exited 28' });
    expect(interpretCurl({ exitCode: 0, stdout: 'nope\n200' })).toEqual({ kind: 'error', message: 'unreadable status.json' });
  });
});

describe('parseStatusJson', () => {
  it('rejects an unknown state and clamps junk numbers to 0', () => {
    expect(parseStatusJson(JSON.stringify({ state: 'buffering' }))).toBeNull();
    expect(parseStatusJson(JSON.stringify({ state: 'stopped', time: -1, length: 'x' }))).toEqual({ state: 'stopped', time: 0, length: 0 });
  });
});

describe('curlStatusReader', () => {
  it('runs curl.exe against Windows loopback with Basic auth and the command in the query', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { exitCode: 0, stdout: `${STATUS}\n200` };
    };
    const reader = curlStatusReader(exec);
    await reader.status('/mnt/c/Windows/System32/curl.exe', EP);
    await reader.command('/mnt/c/Windows/System32/curl.exe', EP, { command: 'seek', val: 1200.9 });
    await reader.command('/mnt/c/Windows/System32/curl.exe', EP, { command: 'pl_play' });
    expect(calls).toEqual([
      ['/mnt/c/Windows/System32/curl.exe', '-s', '-m', '2', '-w', '\\n%{http_code}', '-u', ':pw', 'http://127.0.0.1:47318/requests/status.json'],
      ['/mnt/c/Windows/System32/curl.exe', '-s', '-m', '2', '-w', '\\n%{http_code}', '-u', ':pw', 'http://127.0.0.1:47318/requests/status.json?command=seek&val=1200'],
      ['/mnt/c/Windows/System32/curl.exe', '-s', '-m', '2', '-w', '\\n%{http_code}', '-u', ':pw', 'http://127.0.0.1:47318/requests/status.json?command=pl_play'],
    ]);
  });
});
