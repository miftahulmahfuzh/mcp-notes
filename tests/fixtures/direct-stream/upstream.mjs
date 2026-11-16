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
    const found = filmAnswer(url.pathname, state) ?? answer(url.pathname, alt);
    if (found === null) return reply(404, 'text/plain', 'not found');
    const [status, type, body] = found;
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
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
