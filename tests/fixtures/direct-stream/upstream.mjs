// The stream host stand-in for direct-streaming tests (tests/integration/directStream.*) and for
// `verify.sh up --direct-stream`. Like VidFast's host it answers 403 unless the request carries the
// embed's Referer. It listens on two ports of 127.0.0.1: the fake resolver returns addresses on the
// first; the second is named only inside the playlists and the manifest, so a test can tell a host
// the resolve returned from one a playlist named.
//
//   node upstream.mjs --info FILE [--log FILE] [--state DIR]
//     writes {"origin", "alt_origin"} to FILE once listening; one JSON line per request to the log.
//
// A film whose token expires (--state DIR, or startUpstream({ state })): /film/t<N>/<file> serves
// DIR/film/<file> (a playable stream, e.g. make-dash-fixture.sh's) while N is the number in
// DIR/token (1 when the file is missing). Any other N answers 403 "token expired", as a stream
// host does once its signed address is too old. Raising DIR/token expires every address handed
// out before; the fake resolver (fake-cli.mjs, mode dash_film) hands out the current one.
//
// A tokened HLS film for the stream cache (state DIR): /tok/t<N>/master.m3u8 names 480 and 720
// renditions and two audio renditions (en, ko), each 12 segments of 4 s; 720 and 480 carry an
// AES-128 key. It answers only while N is the current token (DIR/token, as for the DASH film).
// DIR/token_uses holding K: each token answers K media requests (keys and segments) and refuses the
// rest with 403, a signed address that expired mid-download. DIR/fail_once lists file names
// (seg3.ts) answered 503 once each. DIR/delay_ms delays every media answer of the tokened film.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const FIXTURE_REFERER = 'https://embed.fixture/';
export const FIXTURE_ORIGIN = 'https://embed.fixture';
export const FIXTURE_USER_AGENT = 'FixtureChrome/1.0';
export const SEGMENT_BYTES = 1000;

const SEGMENT = Buffer.from(Array.from({ length: SEGMENT_BYTES }, (_, i) => i % 256));
const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello.\n';
const SRT = '1\r\n00:00:01,000 --> 00:00:03,000\r\nHello.\r\n';

// A player's seek-preview track and its pictures (fake-cli.mjs's <dir>/thumbs names the track a resolve answers).
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const THUMBS_VTT = ['WEBVTT', '', '00:00:00.000 --> 00:00:04.000', 'sprite-0.png#xywh=0,0,160,90', '', '00:00:04.000 --> 00:00:08.000', 'sprite-0.png#xywh=160,0,160,90', ''].join('\n');
const WHOLE_VTT = ['WEBVTT', '', '00:00:00.000 --> 00:00:04.000', 'sprite-0.png', '', '00:00:04.000 --> 00:00:08.000', 'sprite-1.png', ''].join('\n');
let bigVtt = null;

/** /thumbs/...: [status, type, body], or null (404). */
function thumbsAnswer(pathname) {
  switch (pathname) {
    case '/thumbs/thumbs.vtt':
      return [200, 'text/vtt', THUMBS_VTT];
    case '/thumbs/whole.vtt':
      return [200, 'text/vtt', WHOLE_VTT];
    case '/thumbs/words.vtt':
      return [200, 'text/vtt', VTT];
    case '/thumbs/page.vtt':
      return [200, 'text/html; charset=utf-8', '<!doctype html><title>Just a moment...</title>'];
    case '/thumbs/big.vtt':
      bigVtt ??= `WEBVTT\n\nNOTE ${'x'.repeat(3 * 1024 * 1024)}\n`;
      return [200, 'text/vtt', bigVtt];
    case '/thumbs/sprite-0.png':
    case '/thumbs/sprite-1.png':
      return [200, 'image/png', PNG_1PX];
    case '/thumbs/page.png':
      return [200, 'text/html; charset=utf-8', '<!doctype html><title>Not found</title>'];
    default:
      return null;
  }
}

function hlsMaster(alt) {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="subs/en.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720,SUBTITLES="subs"',
    '720/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1920x1080,SUBTITLES="subs"',
    `${alt}/hls/1080/index.m3u8`,
    '',
  ].join('\n');
}

function hlsMedia(quality) {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:4.0,',
    'seg1.ts',
    '#EXTINF:4.0,',
    `/hls/${quality}/seg2.ts`,
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
}

const SUB_PLAYLIST = ['#EXTM3U', '#EXT-X-TARGETDURATION:60', '#EXT-X-MEDIA-SEQUENCE:0', '#EXTINF:60.0,', 'en.vtt', '#EXT-X-ENDLIST', ''].join('\n');

export const TOKEN_SEGMENTS = 12;
const MPEGURL = 'application/vnd.apple.mpegurl';
const TOKEN_KEY = Buffer.alloc(16, 7);

function tokMaster() {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:4',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/en/index.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Korean",LANGUAGE="ko",DEFAULT=NO,AUTOSELECT=YES,URI="audio/ko/index.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480,AUDIO="aud"',
    '480/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,AUDIO="aud"',
    '720/index.m3u8',
    '',
  ].join('\n');
}

function tokMedia(prefix, keyed) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:4', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0'];
  if (keyed) lines.push('#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000001');
  for (let i = 1; i <= TOKEN_SEGMENTS; i++) lines.push('#EXTINF:4.0,', `${prefix}${i}.ts`);
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}

function stateNumber(state, name) {
  const file = path.join(state, name);
  if (!existsSync(file)) return 0;
  const n = Number(readFileSync(file, 'utf8').trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** True for a media file (key or segment) of the tokened film. */
function tokMediaPath(pathname) {
  return /^\/tok\/t\d+\/(?:(?:480|720)\/(?:seg\d+\.ts|key\.bin)|audio\/(?:en|ko)\/aseg\d+\.ts)$/.test(pathname);
}

/** /tok/t<N>/...: [status, type, body], or null when the path is not the tokened film's. `memo` counts per token. */
function tokenAnswer(pathname, state, memo) {
  const m = /^\/tok\/t(\d+)\/(.+)$/.exec(pathname);
  if (m === null || state === null) return null;
  const token = Number(m[1]);
  const rest = m[2];
  if (token !== currentFilmToken(state)) return [403, 'text/plain', 'token expired'];
  if (rest === 'master.m3u8') return [200, MPEGURL, tokMaster()];
  if (/^(480|720)\/index\.m3u8$/.test(rest)) return [200, MPEGURL, tokMedia('seg', true)];
  if (/^audio\/(en|ko)\/index\.m3u8$/.test(rest)) return [200, MPEGURL, tokMedia('aseg', false)];
  if (!tokMediaPath(pathname)) return [404, 'text/plain', 'not found'];
  const used = (memo.uses.get(token) ?? 0) + 1;
  memo.uses.set(token, used);
  const limit = stateNumber(state, 'token_uses');
  if (limit > 0 && used > limit) return [403, 'text/plain', 'token expired'];
  const failFile = path.join(state, 'fail_once');
  const failOnce = existsSync(failFile) ? readFileSync(failFile, 'utf8').split(/\s+/).filter(Boolean) : [];
  const name = rest.slice(rest.lastIndexOf('/') + 1);
  if (failOnce.includes(name) && !memo.failed.has(rest)) {
    memo.failed.add(rest);
    return [503, 'text/plain', 'busy'];
  }
  return rest.endsWith('key.bin') ? [200, 'application/octet-stream', TOKEN_KEY] : [200, 'video/mp2t', SEGMENT];
}

function dashManifest(alt) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT8S" minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">',
    `  <BaseURL>${alt}/dash/</BaseURL>`,
    '  <Period id="1">',
    '    <AdaptationSet mimeType="video/mp4" segmentAlignment="true">',
    '      <SegmentTemplate timescale="1000" duration="4000" startNumber="1" media="$RepresentationID$/seg-$Number%05d$.m4s" initialization="$RepresentationID$/init.mp4"/>',
    '      <Representation id="v720" bandwidth="800000" width="1280" height="720"/>',
    '    </AdaptationSet>',
    '    <AdaptationSet mimeType="audio/mp4" lang="en">',
    '      <Representation id="a1" bandwidth="128000">',
    '        <BaseURL>audio/a1.mp4</BaseURL>',
    '        <SegmentBase indexRange="0-99"><Initialization range="0-49"/></SegmentBase>',
    '      </Representation>',
    '    </AdaptationSet>',
    '  </Period>',
    '</MPD>',
    '',
  ].join('\n');
}

const FILM_TYPES = { '.mpd': 'application/dash+xml', '.m4s': 'video/iso.segment', '.mp4': 'video/mp4', '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.vtt': 'text/vtt' };

/** The token the film's addresses must carry now: the number in <state>/token, 1 without the file. */
export function currentFilmToken(state) {
  const file = path.join(state, 'token');
  const n = existsSync(file) ? Number(readFileSync(file, 'utf8').trim()) : 1;
  return Number.isInteger(n) && n > 0 ? n : 1;
}

/** /film/t<N>/<file> from <state>/film: 403 for a token that is not the current one; null when the path is not the film's. */
function filmAnswer(pathname, state) {
  const m = /^\/film\/t(\d+)\/([A-Za-z0-9_.-]+)$/.exec(pathname);
  if (m === null || state === null) return null;
  if (Number(m[1]) !== currentFilmToken(state)) return [403, 'text/plain', 'token expired'];
  const file = path.join(state, 'film', m[2]);
  if (!existsSync(file)) return [404, 'text/plain', 'not found'];
  return [200, FILM_TYPES[path.extname(file)] ?? 'application/octet-stream', readFileSync(file)];
}

/** [status, content type, body] for a path, or null (404). */
function answer(pathname, alt) {
  const thumbs = thumbsAnswer(pathname);
  if (thumbs !== null) return thumbs;
  if (pathname === '/hls/master.m3u8') return [200, 'application/vnd.apple.mpegurl', hlsMaster(alt)];
  const media = /^\/hls\/(720|1080)\/index\.m3u8$/.exec(pathname);
  if (media) return [200, 'application/vnd.apple.mpegurl', hlsMedia(media[1])];
  if (pathname === '/hls/subs/en.m3u8') return [200, 'application/vnd.apple.mpegurl', SUB_PLAYLIST];
  if (pathname === '/hls/subs/en.vtt' || pathname === '/subs/en.vtt') return [200, 'text/vtt', VTT];
  if (pathname === '/subs/en.srt') return [200, 'application/x-subrip', SRT];
  if (pathname === '/dash/manifest.mpd') return [200, 'application/dash+xml', dashManifest(alt)];
  if (pathname === '/expired.m3u8') return [410, 'text/plain', 'token expired'];
  if (/^\/(hls|dash)\/.+\.(ts|m4s|mp4)$/.test(pathname)) return [200, pathname.endsWith('.ts') ? 'video/mp2t' : 'video/mp4', SEGMENT];
  return null;
}

/** Starts the fixture host on two free ports of 127.0.0.1. `requests` lists every request it got. */
export async function startUpstream({ log = null, state = null } = {}) {
  const requests = [];
  let alt = '';
  const memo = { uses: new Map(), failed: new Set() };
  const handler = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    const entry = {
      method: req.method,
      host: req.headers.host ?? null,
      path: url.pathname,
      referer: req.headers.referer ?? null,
      origin: req.headers.origin ?? null,
      user_agent: req.headers['user-agent'] ?? null,
      range: req.headers.range ?? null,
      cookie: req.headers.cookie ?? null,
      status: 0,
    };
    const reply = (status, type, body, extra = {}) => {
      entry.status = status;
      requests.push(entry);
      if (log) appendFileSync(log, `${JSON.stringify(entry)}\n`);
      res.writeHead(status, { 'content-type': type, ...extra });
      res.end(body);
    };
    if (entry.referer !== FIXTURE_REFERER) return reply(403, 'text/plain', 'referer required');
    const found = filmAnswer(url.pathname, state) ?? tokenAnswer(url.pathname, state, memo) ?? answer(url.pathname, alt);
    if (found === null) return reply(404, 'text/plain', 'not found');
    const [status, type, body] = found;
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const send = () => {
      const range = /^bytes=(\d+)-(\d*)$/.exec(entry.range ?? '');
      if (status === 200 && range) {
        const start = Number(range[1]);
        const end = Math.min(range[2] === '' ? buf.length - 1 : Number(range[2]), buf.length - 1);
        return reply(206, type, buf.subarray(start, end + 1), {
          'content-range': `bytes ${start}-${end}/${buf.length}`,
          'accept-ranges': 'bytes',
          'content-length': String(end - start + 1),
        });
      }
      return reply(status, type, buf, { 'accept-ranges': 'bytes', 'content-length': String(buf.length) });
    };
    const delay = state !== null && tokMediaPath(url.pathname) ? stateNumber(state, 'delay_ms') : 0;
    if (delay > 0) setTimeout(send, delay);
    else send();
  };
  const listen = () =>
    new Promise((resolve) => {
      const server = http.createServer(handler);
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  const main = await listen();
  const second = await listen();
  const origin = `http://127.0.0.1:${main.address().port}`;
  alt = `http://127.0.0.1:${second.address().port}`;
  const close = () =>
    Promise.all(
      [main, second].map(
        (server) =>
          new Promise((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
          }),
      ),
    ).then(() => undefined);
  return { origin, altOrigin: alt, requests, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? (process.argv[i + 1] ?? null) : null;
  };
  const info = arg('--info');
  if (!info) {
    console.error('usage: upstream.mjs --info FILE [--log FILE] [--state DIR]');
    process.exit(2);
  }
  const up = await startUpstream({ log: arg('--log'), state: arg('--state') });
  writeFileSync(info, JSON.stringify({ origin: up.origin, alt_origin: up.altOrigin }));
  process.on('SIGTERM', () => {
    up.close().then(() => process.exit(0));
  });
}
