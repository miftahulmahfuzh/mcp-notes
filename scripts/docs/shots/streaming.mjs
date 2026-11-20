// Pictures for docs/guide/streaming.md. Run by scripts/docs/capture.mjs:
//
//   npm run docs:shots -- streaming
//
// They show notesd's own player page (/stream/<session id>) in a throwaway daemon's real build. No
// provider, no torrent swarm and no Chrome on Windows is touched: the session, the pass-through,
// the session's preview frames, the torrent's status and its file route are answered here by
// Playwright, in the shapes the daemon gives the page (the same fakes as
// .claude/skills/verify-notesd/scripts/stream/*.steps.mjs).
//
// The film is the trailer of Sintel (© Blender Foundation, CC BY 3.0, durian.blender.org), fetched
// once from download.blender.org into ~/.local/state/notesd-verify/.docs-film (DOCS_SHOTS_FILM_DIR)
// and cut into a two-rendition HLS stream with ffmpeg. Offline, a generated test picture stands in.
//
//   player.png             a cloud stream: the title, the English subtitle the page draws, the controls
//   player.gif             the quality menu, the subtitle delay key, a seek
//   player-preview.png     the pointer on the timeline: the frame of that time from the stream's own preview track
//   player-torrent.png     a torrent session: the magnet, peers and speed beside the title, the bar of what is on disk
//   player-fetching.png    a seek past what is on disk: "Fetching this part from peers"
//
// Downloads and the season story (stream-downloads-season-story), on the fake library and TMDB of --direct-stream:
// GET /api/stream/downloads and GET /api/stream/disk are answered here in the daemon's shapes, so a season is seen
// downloading with no swarm; the story is a row seed() puts in movie_stories, read like any stored story (no model).
//   download-bars.png      MobLand on the Stream side: season 1 downloading, E01 and E02 running, E03 queued
//   download-menu.png      the season row's caret: "Choose how to download MobLand"
//   season-story.png       the season's story pop-up: a section per episode, one with no recap found, the source
//   cache-downloading.png  the Cache page's Downloading view: the bars and why each row downloads
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const up = ['--direct-stream'];

const SERIES_KEY = 'tv-247718'; // MobLand in the fixture library
const FILM_KEY = 'movie-467905'; // How to Make a Killing in the fixture library
const STORY_DELETE_SQL = `delete from movie_stories where title_id = '${SERIES_KEY}' and season = 1 and episode = 0`;
const STORY_SQL = `insert into movie_stories (title_id, season, episode, text, sections, sources, origin, model, written_at) values (
  '${SERIES_KEY}', 1, 0, 'Season 1 of MobLand.',
  '[{"episode":1,"name":"Stick or Twist","text":"Harry Da Souza, the Harrigans'' fixer, is called in when a London crime family loses a son, and the night ends with a body nobody can explain.","found":true},
    {"episode":2,"name":"Eye for an Eye","text":"Conrad answers the killing with one of his own, and Harry is sent to keep the Stevensons from striking back before the deal is done.","found":true},
    {"episode":3,"name":"Lie Down with Dogs","text":"","found":false}]'::jsonb,
  '[{"url":"https://en.wikipedia.org/wiki/MobLand","title":"MobLand","site":"Wikipedia"},{"url":"https://mobland.fandom.com/wiki/Season_1","title":"Season 1","site":"MobLand Wiki"}]'::jsonb,
  'web', 'sonnet', now())`;

/** Stores the two fixture titles (as a click on a listed title does), then keeps a season story for MobLand (as the web writer would). */
export async function seed({ v, fetchJson }) {
  await fetchJson('POST', '/api/movies/ensure', { kind: 'tv', tmdb_id: 247718 });
  await fetchJson('POST', '/api/movies/ensure', { kind: 'movie', tmdb_id: 467905 });
  await v('exec', STORY_DELETE_SQL);
  await v('exec', STORY_SQL);
}

/** One row of GET /api/stream/downloads for an episode of MobLand's season 1, as phase 4 answers it. */
function downloadRow(episode, state, progress, total) {
  const running = state === 'running';
  return {
    id: '00000000-0000-4000-8000-00000000000' + episode,
    host: 'verify',
    available: true,
    title_id: SERIES_KEY,
    kind: 'tv',
    tmdb_id: 247718,
    season: 1,
    episode,
    state,
    via: 'auto',
    info_hash: null,
    batch: '00000000-0000-4000-8000-0000000000b1',
    source: running ? 'torrent' : null,
    source_id: running ? '5f1c7a4be0d94c1f8a3a52c1d0b7e6a9f4c2d811' : null,
    progress,
    bytes_done: Math.round(total * progress),
    bytes_total: total,
    peers: running ? 27 : null,
    down_kbps: running ? 4800 : null,
    error: null,
    detail: null,
    created_at: '2026-11-20T12:00:00.000Z',
    updated_at: '2026-11-20T12:04:00.000Z',
    finished_at: null,
  };
}

const DOWNLOADS = [downloadRow(1, 'running', 0.71, 1_480_000_000), downloadRow(2, 'running', 0.34, 1_390_000_000), downloadRow(3, 'queued', 0, 1_420_000_000)];

/** GET /api/stream/disk as phase 5 answers it: MobLand's season 1 asked for, and a film a pause is caching. */
function diskView(series, film) {
  const episode = (n, name, bytes, progress, state) => ({
    season: 1,
    episode: n,
    movie_id: null,
    name,
    bytes,
    kinds: state === 'queued' ? [] : ['torrent'],
    watched: false,
    playing: false,
    in_use: state !== 'queued',
    downloading: { progress, why: 'asked', state },
  });
  const episodes = [episode(1, 'Stick or Twist', 1_050_000_000, 0.71, 'running'), episode(2, 'Eye for an Eye', 473_000_000, 0.34, 'running'), episode(3, 'Lie Down with Dogs', 0, 0, 'queued')];
  const seasonBytes = episodes.reduce((n, e) => n + e.bytes, 0);
  const rollup = { count: 3, progress: (0.71 + 0.34 + 0) / 3, why: ['asked'], state: 'running' };
  const mobland = {
    title_id: SERIES_KEY,
    movie_id: series.movie_id ?? null,
    kind: 'tv',
    tmdb_id: 247718,
    title: 'MobLand',
    year: 2025,
    poster_url: series.poster_url ?? null,
    stored: true,
    bytes: seasonBytes,
    torrent_bytes: seasonBytes,
    cloud_bytes: 0,
    kinds: ['torrent'],
    watched: false,
    not_interested: false,
    playing: false,
    in_use: true,
    shared_bytes: 0,
    downloading: rollup,
    seasons: [{ season: 1, bytes: seasonBytes, shared_bytes: 0, kinds: ['torrent'], watched: false, playing: false, in_use: true, downloading: rollup, episodes }],
  };
  const paused = {
    title_id: FILM_KEY,
    movie_id: film.movie_id ?? null,
    kind: 'movie',
    tmdb_id: 467905,
    title: 'How to Make a Killing',
    year: 2026,
    poster_url: film.poster_url ?? null,
    stored: true,
    bytes: 612_000_000,
    torrent_bytes: 0,
    cloud_bytes: 612_000_000,
    kinds: ['cloud'],
    watched: false,
    not_interested: false,
    playing: false,
    in_use: true,
    shared_bytes: 0,
    downloading: { count: 1, progress: 0.48, why: ['pause'], state: 'running' },
    seasons: [],
  };
  return {
    host: 'verify',
    total_bytes: mobland.bytes + paused.bytes,
    torrent_bytes: mobland.bytes,
    cloud_bytes: paused.bytes,
    unnamed_bytes: 0,
    budget_bytes: 40 * 1024 ** 3,
    titles: [mobland, paused],
    bulk: { watched: { bytes: 0, titles: 0 }, not_interested: { bytes: 0, titles: 0 } },
    pending: [],
    undo_ms: 10_000,
    downloading: 4,
  };
}

const DIR = process.env.DOCS_SHOTS_FILM_DIR ?? path.join(os.homedir(), '.local/state/notesd-verify/.docs-film');
const TRAILER = 'https://download.blender.org/durian/trailer/sintel_trailer-720p.mp4';
const FILM = path.join(DIR, 'film.mp4');
const HLS = path.join(DIR, 'hls');
const TITLE = 'Sintel (2010)';
const TORRENT = { hash: '08ada5a7a6183aae1e09d831df6748d566095a10', name: 'Sintel.2010.1080p.BluRay.x264.AAC' };
/** The share of the torrent's file "on disk". */
const ON_DISK = 0.45;
const TYPES = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.vtt': 'text/vtt', '.jpg': 'image/jpeg' };
/** The trailer's length, and the preview frames of session D1: one every PREVIEW_EVERY_S, 240×135, side by side in one sheet. */
const FILM_S = 52;
const PREVIEW_EVERY_S = 10;
const PREVIEW_W = 240;
const PREVIEW_H = 135;
/** Where the stream's own preview track would have its sheet: served by the faked pass-through like the stream's other files. */
const SHEET = 'thumbs/sheet.jpg';

// The trailer's own lines, at about the seconds they are said.
const CUES = [
  [11, 16, 'What brings you to the land of the gatekeepers?'],
  [17, 20.5, "I'm searching for someone."],
  [21, 25, 'Someone very dear? A kindred spirit?'],
  [25.5, 28, 'A dragon.'],
  [29, 34, 'A dangerous quest for a lone hunter.'],
  [35, 41, "I've been alone for as long as I can remember."],
];

const stamp = (s) => '00:00:' + s.toFixed(3).padStart(6, '0');

async function ffmpeg(...args) {
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { maxBuffer: 16 * 1024 * 1024 });
}

/** The film as one MP4 (the torrent session's file) and as HLS in 720p and 360p (the cloud session's stream). Made once. */
async function makeFilm() {
  if (existsSync(path.join(DIR, '.done'))) return;
  mkdirSync(HLS, { recursive: true });
  const src = path.join(DIR, 'src.mp4');
  if (!existsSync(src)) {
    try {
      const res = await fetch(TRAILER, { headers: { 'user-agent': 'notesd-docs-shots' }, signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      writeFileSync(src + '.part', Buffer.from(await res.arrayBuffer()));
      renameSync(src + '.part', src);
    } catch (err) {
      console.log('streaming: the Sintel trailer could not be fetched (' + err.message + '); a test picture stands in');
      await ffmpeg('-f', 'lavfi', '-i', 'testsrc2=duration=52:size=1280x720:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=52', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src);
    }
  }
  await ffmpeg('-i', src, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-g', '48', '-keyint_min', '48', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', FILM);
  await run(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', FILM,
      '-filter_complex', '[0:v]split=2[hi][lo0];[lo0]scale=-2:360[lo]',
      '-map', '[hi]', '-map', '0:a', '-map', '[lo]', '-map', '0:a',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
      '-b:v:0', '2600k', '-b:v:1', '700k', '-c:a', 'aac', '-b:a', '96k',
      '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
      '-var_stream_map', 'v:0,a:0,name:720 v:1,a:1,name:360',
      '-master_pl_name', 'master.m3u8', '-hls_segment_filename', 'v%v/seg%03d.ts', 'v%v/index.m3u8',
    ],
    { cwd: HLS },
  );
  writeFileSync(path.join(HLS, 'en.vtt'), 'WEBVTT\n\n' + CUES.map(([from, to, text]) => stamp(from) + ' --> ' + stamp(to) + '\n' + text + '\n').join('\n'));
  writeFileSync(path.join(DIR, '.done'), '');
}

/** The preview sheet of session D1: a frame every PREVIEW_EVERY_S seconds of the film, side by side in one JPEG. Made once. */
async function makeSheet() {
  const file = path.join(HLS, SHEET);
  if (existsSync(file)) return;
  mkdirSync(path.dirname(file), { recursive: true });
  const frames = Math.ceil(FILM_S / PREVIEW_EVERY_S);
  await ffmpeg('-i', FILM, '-vf', `fps=1/${PREVIEW_EVERY_S},scale=${PREVIEW_W}:${PREVIEW_H},tile=${frames}x1`, '-frames:v', '1', '-q:v', '4', file + '.part.jpg');
  renameSync(file + '.part.jpg', file);
}

/** SessionInfo as GET /api/stream/sessions/:id answers it. */
function session(id) {
  const common = { session_id: id, kind: 'movie', tmdb_id: 45745, season: null, episode: null, title: TITLE, created_at: null, refreshed_at: null, expires_at: null, cached: null, preview_rev: 0 };
  if (id === 'T1') {
    return {
      ...common,
      provider: 'Torrent',
      manifest_kind: 'mp4',
      manifest_url: '/api/stream/torrent/' + TORRENT.hash + '/f/0',
      subtitles: [{ url: '/api/stream/sessions/T1/p?u=en.vtt', lang: 'en', label: 'English', format: 'vtt', source: 'request', english: true }],
      best_height: 720,
      resume_s: 12,
      torrent: { info_hash: TORRENT.hash, name: TORRENT.name, index: 'Torrentio', state: 'downloading', seeds: 52 },
    };
  }
  return {
    ...common,
    provider: 'VidFast',
    manifest_kind: 'hls',
    manifest_url: '/api/stream/sessions/D1/p?u=master.m3u8',
    subtitles: [{ url: '/api/stream/sessions/D1/p?u=en.vtt', lang: 'en', label: 'English', format: 'vtt', source: 'request', english: true }],
    best_height: 720,
    resume_s: 29,
    preview_rev: 1,
  };
}

/** GET /api/stream/sessions/:id/previews: D1 lists the frames of its own preview track, through the pass-through; T1 has none. */
function previews(id) {
  if (id !== 'D1') return { state: 'none', rev: 0, source: null, cues: [] };
  const url = '/api/stream/sessions/D1/p?u=' + encodeURIComponent(SHEET) + '&img=1';
  const cues = [];
  for (let k = 0; k * PREVIEW_EVERY_S < FILM_S; k++) {
    cues.push({ start_s: k * PREVIEW_EVERY_S, end_s: Math.min((k + 1) * PREVIEW_EVERY_S, FILM_S), url, x: k * PREVIEW_W, y: 0, w: PREVIEW_W, h: PREVIEW_H });
  }
  return { state: 'ready', rev: 1, source: 'provider', cues };
}

/** Every address of a playlist comes back through the pass-through, as the daemon rewrites it. */
function playlist(file, id) {
  const dir = path.dirname(path.relative(HLS, file));
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => (line === '' || line.startsWith('#') ? line : '/api/stream/sessions/' + id + '/p?u=' + encodeURIComponent(path.posix.join(dir, line))))
    .join('\n');
}

/** The daemon's stream routes for sessions D1 (a cloud stream) and T1 (a torrent), answered from the film on disk. */
async function fakeDaemon(page) {
  const film = readFileSync(FILM);
  const cut = Math.floor(film.length * ON_DISK);
  const state = { released: false };
  await page.route('**/api/stream/sessions/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const m = /^\/api\/stream\/sessions\/(D1|T1)(?:\/(p|previews))?$/.exec(url.pathname);
    if (!m) return route.fulfill({ status: 404, json: { error: 'not_found' } });
    if (m[2] === 'previews') return route.fulfill({ json: previews(m[1]) });
    if (m[2] === 'p') {
      const file = path.join(HLS, url.searchParams.get('u') ?? '');
      const ext = path.extname(file);
      const headers = { 'x-notesd-upstream': '200' };
      if (ext === '.m3u8') return route.fulfill({ status: 200, headers, contentType: TYPES[ext], body: playlist(file, m[1]) });
      return route.fulfill({ status: 200, headers, contentType: TYPES[ext] ?? 'application/octet-stream', body: readFileSync(file) });
    }
    if (req.method() === 'GET') return route.fulfill({ json: session(m[1]) });
    return route.fulfill({ status: 404, json: { error: 'not_found' } });
  });
  await page.route('**/api/stream/torrent/**', async (route) => {
    const req = route.request();
    const m = /^\/api\/stream\/torrent\/([0-9a-f]{40})(\/map|\/f\/0)?$/.exec(new URL(req.url()).pathname);
    if (!m) return route.fulfill({ status: 404, json: { error: 'not_found' } });
    if (m[2] === undefined) return route.fulfill({ json: { info_hash: m[1], state: 'downloading', peers: 23, down_kbps: 25600, up_kbps: 800, progress: ON_DISK } });
    if (m[2] === '/map') return route.fulfill({ json: { duration_s: 52, ranges: [[0, 52 * ON_DISK]] } });
    const asked = /bytes=(\d+)-(\d*)/.exec(req.headers()['range'] ?? '');
    const start = asked ? Number(asked[1]) : 0;
    let end = asked && asked[2] !== '' ? Math.min(Number(asked[2]), film.length - 1) : film.length - 1;
    if (start >= cut) {
      // Not on disk yet: the answer waits for its pieces, as the daemon's file route does.
      while (!state.released) await new Promise((r) => setTimeout(r, 200));
      return route.abort().catch(() => {});
    }
    end = Math.min(end, cut - 1);
    await route
      .fulfill({ status: 206, headers: { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-range': 'bytes ' + start + '-' + end + '/' + film.length }, body: film.subarray(start, end + 1) })
      .catch(() => {});
  });
  return state;
}

async function playing(page, pastS) {
  await page.waitForFunction(() => window.notesdStream?.stage === 'ready', null, { timeout: 30_000 });
  await page.waitForFunction(
    (past) => {
      const v = document.querySelector('video');
      return !!v && !v.paused && v.currentTime > past;
    },
    pastS,
    { timeout: 30_000 },
  );
}

/** The controls hide after 2.5 s without the mouse. */
async function wake(page) {
  await page.mouse.move(600, 420);
  await page.mouse.move(640, 440);
}

const captionShown = () => (document.querySelector('.st-caption')?.textContent ?? '').trim() !== '';

export default async ({ page, base, shot, clip, fetchJson }) => {
  await makeFilm();
  await makeSheet();

  // A cloud stream: the English subtitle on by default, drawn by the page over the picture.
  await fakeDaemon(page);
  await page.goto(base + '/stream/D1');
  await playing(page, 30);
  await page.waitForFunction(captionShown, null, { timeout: 20_000 });
  await wake(page);
  await page.waitForTimeout(400);
  await shot('player');

  // The pointer on the timeline at 0:40: the frame of that time from the stream's own preview track, and the time under it.
  await page.waitForFunction(() => window.notesdStream?.previews?.state === 'ready', null, { timeout: 10_000 });
  const seek = await page.locator('.st-seek').boundingBox();
  if (seek === null) throw new Error('streaming: the timeline is not on the page');
  await page.mouse.move(seek.x + (seek.width * 40) / FILM_S, seek.y + seek.height / 2, { steps: 8 });
  await page.locator('.st-preview .st-preview-frame').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(300);
  await shot('player-preview');
  await wake(page);

  // The menus and keys, in a fresh tab.
  await clip('player', async (tab) => {
    await fakeDaemon(tab);
    await tab.goto(base + '/stream/D1');
    await playing(tab, 30);
    await tab.waitForFunction(captionShown, null, { timeout: 20_000 });
    await wake(tab);
    await tab.waitForTimeout(900);
    await tab.getByRole('button', { name: 'Quality', exact: true }).click();
    await tab.waitForTimeout(1100);
    await tab.getByRole('menuitemradio', { name: '360p', exact: true }).click();
    await tab.waitForTimeout(1300);
    // H: the subtitles 50 ms later, as in VLC.
    for (let i = 0; i < 5; i++) {
      await tab.keyboard.press('h');
      await tab.waitForTimeout(200);
    }
    await tab.waitForTimeout(1100);
    await tab.keyboard.press('ArrowRight');
    await wake(tab);
    await tab.waitForTimeout(2200);
  }, { width: 800, fps: 8 });

  // A torrent session: the magnet, the peers and the speed beside the title; the thick grey bar is what is on disk.
  await page.goto(base + '/stream/T1');
  await playing(page, 13);
  const mark = page.locator('.st-top .st-torrent');
  await mark.waitFor({ state: 'attached', timeout: 10_000 });
  await page.waitForFunction(() => (document.querySelector('.st-top .st-torrent')?.getAttribute('aria-label') ?? '').includes('peers'), null, { timeout: 10_000 });
  await page.waitForFunction(captionShown, null, { timeout: 20_000 });
  await wake(page);
  await page.waitForTimeout(400);
  await shot('player-torrent');

  // A seek past what is on disk waits for its pieces.
  await page.getByLabel('Position').evaluate((el) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '44');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.getByRole('status', { name: 'Fetching this part from peers' }).waitFor({ timeout: 20_000 });
  await wake(page);
  await page.waitForTimeout(400);
  await shot('player-fetching');
  await page.goto('about:blank');

  // Downloads and the season story, with the downloads and the disk answered here.
  const series = await fetchJson('GET', '/api/movies/' + SERIES_KEY);
  const film = await fetchJson('GET', '/api/movies/' + FILM_KEY).catch(() => ({}));
  await page.route('**/api/stream/downloads**', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { host: 'verify', active: true, downloads: DOWNLOADS } }) : route.fulfill({ status: 404, json: { error: 'not_found' } }),
  );
  await page.route('**/api/stream/disk', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: diskView(series, film) }) : route.fulfill({ status: 404, json: { error: 'not_found' } }),
  );

  await page.goto(base + '/movies/' + SERIES_KEY + '?side=stream');
  const season = page.locator('.mv-season[data-season="1"]');
  const head = season.locator('.mv-season-head');
  await head.locator('[role="progressbar"]').waitFor({ timeout: 20_000 });
  await season.locator('li[data-episode="S01E02"] [role="progressbar"]').waitFor({ timeout: 10_000 });
  await season.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shot('download-bars');

  await head.getByRole('button', { name: /^Choose how to download / }).click();
  await page.getByRole('menu', { name: /^Choose how to download / }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(200);
  await shot('download-menu');
  await page.keyboard.press('Escape');

  await head.getByRole('button', { name: /story of S01$/ }).click();
  const story = page.getByRole('dialog', { name: /^Story of / });
  await story.getByRole('heading', { name: /^S01E03 · / }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(200);
  await shot('season-story', { locator: story });
  await page.keyboard.press('Escape');

  await page.goto(base + '/movies/cache');
  await page.getByRole('button', { name: /^Downloading/ }).click();
  await page.locator('li.cp-episode [role="progressbar"]').first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  await shot('cache-downloading');
  await page.goto('about:blank');
};
