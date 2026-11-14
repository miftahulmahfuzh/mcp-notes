#!/usr/bin/env node
// A fake vlc.exe for tests and verify runs: only VLC's HTTP status interface, on the port and
// password from argv, with Basic auth (empty user) like VLC 3. It does NOT honor --start-time
// unless FAKE_VLC_HONOR_START_TIME=1 and starts `stopped` unless FAKE_VLC_AUTOPLAY=1, which is
// what the 2026-11-14 probe saw from the real one; notesd must pl_play and seek itself.
//
// Env: FAKE_VLC_LOG (append one JSON line {pid, argv} per launch), FAKE_VLC_LENGTH (s, 7200),
// FAKE_VLC_SPEED (media seconds per wall second, 1), FAKE_VLC_HTTP_DELAY_MS (200),
// FAKE_VLC_NO_HTTP=1 (never listen), FAKE_VLC_LIFE_MS (exit after, 120000).
// GET /fake/quit (no auth) makes it exit, as closing the VLC window would.
import { appendFileSync } from 'node:fs';
import http from 'node:http';

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const env = process.env;
const port = Number(opt('--http-port'));
const password = opt('--http-password') ?? '';
const host = opt('--http-host') ?? '127.0.0.1';
const startArg = argv.find((a) => a.startsWith('--start-time='));
const startTime = startArg ? Number(startArg.slice('--start-time='.length)) : 0;
const file = argv[argv.length - 1] ?? '';
const LENGTH = Number(env.FAKE_VLC_LENGTH ?? 7200);
const SPEED = Number(env.FAKE_VLC_SPEED ?? 1);

if (env.FAKE_VLC_LOG) appendFileSync(env.FAKE_VLC_LOG, JSON.stringify({ pid: process.pid, argv }) + '\n');

let state = env.FAKE_VLC_AUTOPLAY === '1' ? 'playing' : 'stopped';
let loaded = state === 'playing';
let base = env.FAKE_VLC_HONOR_START_TIME === '1' ? startTime : 0;
let since = Date.now();

function now() {
  if (state !== 'playing') return base;
  const t = base + ((Date.now() - since) / 1000) * SPEED;
  if (t >= LENGTH) {
    state = 'stopped';
    loaded = false;
    base = 0;
    return 0;
  }
  return t;
}

function setTime(t) {
  base = Math.max(0, Math.min(LENGTH, t));
  since = Date.now();
}

function status() {
  const time = now();
  return {
    state,
    time: Math.floor(time),
    length: loaded ? LENGTH : 0,
    position: loaded ? time / LENGTH : 0,
    information: { category: { meta: { filename: file.split('\\').pop() } } },
  };
}

const expected = 'Basic ' + Buffer.from(':' + password).toString('base64');
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://fake');
  if (url.pathname === '/fake/quit') {
    res.end('bye');
    setTimeout(() => process.exit(0), 20);
    return;
  }
  if ((req.headers.authorization ?? '') !== expected) {
    res.writeHead(401);
    res.end();
    return;
  }
  if (url.pathname !== '/requests/status.json') {
    res.writeHead(404);
    res.end();
    return;
  }
  const cmd = url.searchParams.get('command');
  if (cmd === 'pl_play') {
    const t = now();
    loaded = true;
    state = 'playing';
    setTime(t);
  } else if (cmd === 'pl_pause') {
    const t = now();
    state = state === 'playing' ? 'paused' : 'playing';
    setTime(t);
  } else if (cmd === 'pl_stop') {
    state = 'stopped';
    loaded = false;
    setTime(0);
  } else if (cmd === 'seek') {
    now();
    setTime(Number(url.searchParams.get('val') ?? 0));
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(status()));
});
server.on('error', () => process.exit(1));

setTimeout(() => process.exit(0), Number(env.FAKE_VLC_LIFE_MS ?? 120000));
if (env.FAKE_VLC_NO_HTTP !== '1') setTimeout(() => server.listen(port, host), Number(env.FAKE_VLC_HTTP_DELAY_MS ?? 200));
