#!/usr/bin/env node
// A fake subtitle service in the shape of Stremio's OpenSubtitles add-on, for `verify.sh up --torrent`
// (TORRENT_STREAM_SOURCE phase 6). It answers /subtitles/<movie|series>/<id>[/<extra>].json and serves the
// .srt files it lists. <state>/mode picks the answers:
//   ok (default)  by hash: a hash-matched entry (9001), an id entry (9002), a French one; by id: 9002 and the French one
//   id_only       the hash request answers 500; by id as in ok
//   empty         every list is empty
//   error         every list answers 500
//   wyzie         as ok, and the fake Wyzie Subs below lists an English file
//   sync          as wyzie, and the fake Wyzie Synced below fits a subtitle
// Every request is one line of <state>/requests.jsonl: {at, path, user_agent, mode}.
// <state>/delay-ms, when present, holds every answer back that many milliseconds (a slow subtitle service).
//
// It is also a fake Wyzie Subs (the phase 6 addendum; never the real one): GET /search?id=&language=en&format=srt
// &key= answers Wyzie's list, and /c/<id> the file. Only in mode `wyzie` does the list hold an English file (7001,
// beside a machine-translated one the daemon must drop); in `error` it answers 503, otherwise []. A request without
// the key `--wyzie-key` names answers 401. Its requests are lines of <state>/wyzie-requests.jsonl:
// {at, path, id, season, episode, source, has_key, user_agent, mode}; the key and the token are never written.
//
// And a fake Wyzie Synced (WYZIE_SYNCED_BRIEF): POST /sync with the JSON body {key, id, language, speech, covered,
// season?, episode?}. In mode `sync` it answers 200 with a download address (/c/7002, "Synced subtitle line") once
// the file <state>/sync-go exists (it waits up to 90 s for it, so a script can watch the page take the new file);
// while <state>/sync-refuse exists it answers 422 instead. In every other mode: 404 "No subtitles found". A body
// without the key: 401. Each request is a line of wyzie-requests.jsonl with `path: "/sync"`, the id, `language`,
// `spans` (how many stretches of speech), `speech_s` (their sum), `covered` and `has_key`; never the key.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? null);
};
const state = flag('--state');
const info = flag('--info');
const wyzieKey = flag('--wyzie-key');
if (!state || !info) {
  console.error('usage: fake-subs.mjs --state DIR --info FILE');
  process.exit(2);
}
mkdirSync(state, { recursive: true });

const srt = (line) => `1\r\n00:00:01,000 --> 00:00:30,000\r\n${line}\r\n\r\n2\r\n00:00:31,000 --> 00:00:59,000\r\n${line} (2)\r\n`;
const WYZIE_TOKEN = 'fake-wyzie-token';
const FILES = { 'hash.srt': srt('Service subtitle by hash'), 'id.srt': srt('Service subtitle by id'), 'french.srt': srt('Sous-titre') };

function mode() {
  const file = path.join(state, 'mode');
  return (existsSync(file) ? readFileSync(file, 'utf8').trim() : '') || 'ok';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sync(req, res, now) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body = {};
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    // An unreadable body is a request without a key.
  }
  const send = (status, answer) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer));
  };
  const hasKey = wyzieKey !== null && body.key === wyzieKey;
  const speech = Array.isArray(body.speech) ? body.speech : [];
  appendFileSync(
    path.join(state, 'wyzie-requests.jsonl'),
    `${JSON.stringify({ at: new Date().toISOString(), path: '/sync', id: body.id ?? null, language: body.language ?? null, season: body.season ?? null, episode: body.episode ?? null, spans: speech.length, speech_s: Math.round(speech.reduce((sum, s) => sum + (s[1] - s[0]), 0)), covered: body.covered ?? null, has_key: hasKey, user_agent: req.headers['user-agent'] ?? null, mode: now })}\n`,
  );
  if (!hasKey) return send(401, { error: 'key required' });
  if (now !== 'sync') return send(404, { error: 'No subtitles found' });
  if (existsSync(path.join(state, 'sync-refuse'))) return send(422, { error: "Couldn't sync" });
  for (let i = 0; i < 360 && !existsSync(path.join(state, 'sync-go')); i++) await sleep(250);
  return send(200, {
    url: `http://${req.headers.host}/c/7002?format=srt&tok=${WYZIE_TOKEN}`,
    offset: -0.9,
    fps: null,
    confidence: 1,
    inSync: false,
    subtitle: { release: 'fixture.synced', fileName: 'fixture.synced.srt', source: 'charlie', isHearingImpaired: false, format: 'srt' },
    tried: 1,
  });
}

const delayMs = () => {
  try {
    return Math.max(0, Number(readFileSync(path.join(state, 'delay-ms'), 'utf8').trim()) || 0);
  } catch {
    return 0;
  }
};

const server = http.createServer((req, res) => {
  const wait = delayMs();
  if (wait > 0) setTimeout(() => handle(req, res), wait);
  else handle(req, res);
});

function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://fake.local');
  const now = mode();
  const pathname = decodeURIComponent(url.pathname);
  if (pathname === '/sync' && req.method === 'POST') {
    void sync(req, res, now);
    return;
  }
  if (pathname === '/search' || pathname.startsWith('/c/')) {
    const q = url.searchParams;
    const hasKey = wyzieKey !== null && q.get('key') === wyzieKey;
    appendFileSync(
      path.join(state, 'wyzie-requests.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), path: pathname, id: q.get('id'), season: q.get('season'), episode: q.get('episode'), source: q.get('source'), has_key: hasKey, user_agent: req.headers['user-agent'] ?? null, mode: now })}\n`,
    );
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (pathname === '/c/7001') return q.get('tok') === WYZIE_TOKEN ? send(200, srt('Wyzie subtitle line'), 'application/x-subrip') : send(403, { error: 'bad token' });
    if (pathname === '/c/7002') return q.get('tok') === WYZIE_TOKEN ? send(200, srt('Synced subtitle line'), 'application/x-subrip') : send(403, { error: 'bad token' });
    if (pathname !== '/search') return send(404, { error: 'not found' });
    if (!hasKey) return send(401, { error: 'key required' });
    if (now === 'error') return send(503, { error: 'Source temporarily offline' });
    if (now !== 'wyzie' && now !== 'sync') return send(200, []);
    const item = (id, extra) => ({ id, format: 'srt', encoding: 'UTF-8', display: 'English', language: 'en', isHearingImpaired: false, source: 'charlie', release: 'fixture', releases: ['fixture'], origin: null, fileName: 'fixture.srt', downloadCount: 10, ai: false, ...extra });
    return send(200, [
      item('ai-en', { url: `http://${req.headers.host}/translate?id=${q.get('id')}`, source: 'ai', ai: true }),
      item('7001', { url: `http://${req.headers.host}/c/7001?format=srt&tok=${WYZIE_TOKEN}` }),
    ]);
  }
  appendFileSync(path.join(state, 'requests.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), path: pathname, user_agent: req.headers['user-agent'] ?? null, mode: now })}\n`);
  const origin = `http://${req.headers.host}`;
  const file = /^\/files\/([a-z]+\.srt)$/.exec(pathname);
  if (file && FILES[file[1]]) {
    res.writeHead(200, { 'content-type': 'application/x-subrip' });
    res.end(FILES[file[1]]);
    return;
  }
  const list = /^\/subtitles\/(movie|series)\/(tt\d+(?::\d+:\d+)?)(\/[^/]+)?\.json$/.exec(pathname);
  if (!list) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"err":"not found"}');
    return;
  }
  const byHash = list[3] !== undefined && /videoHash=[0-9a-f]{16}&videoSize=\d+/.test(list[3]);
  if (now === 'error' || (now === 'id_only' && byHash)) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"err":"fake failure"}');
    return;
  }
  const entry = (id, name, m, lang = 'eng') => ({ id, url: `${origin}/files/${name}`, lang, m, g: '1', SubEncoding: 'UTF-8', subtitleFileName: name });
  const subtitles = now === 'empty' ? [] : [...(byHash ? [entry('9001', 'hash.srt', 'h')] : []), entry('9002', 'id.srt', 'i'), entry('9003', 'french.srt', 'i', 'fre')];
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ subtitles, cacheMaxAge: 0 }));
}
server.listen(0, '127.0.0.1', () => {
  writeFileSync(info, JSON.stringify({ origin: `http://127.0.0.1:${server.address().port}` }));
});
