// Pictures for docs/guide/movies.md. Run by scripts/docs/capture.mjs. They come from two places:
//
//   npm run docs:shots -- --live movies                       the owner's real library (most pictures)
//   DOCS_SHOTS_CHAT=1 npm run docs:shots -- --live movies     also the two chat pictures (billed)
//   npm run docs:shots -- movies                              unmatched.png and assign.png only
//
// The owner wants this guide to show their real library, so `live` below takes the grid, a film,
// a series, the trailer pop-up, the filter clip and the page of whatever VLC is playing from the
// daemon on 7317, and the Stream side (stream.png) when this machine has a verified title; no Play
// is pressed there. It only looks: it clicks filters, opens the trailer pop-up and reads pages. It
// never presses Play, never marks, rates or reviews, and never starts or stops a VLC. The chat
// pictures send real, billed questions (they are stored in the chat history), so they are retaken
// only with DOCS_SHOTS_CHAT=1.
//
// The unmatched list shows the names of files that could not be placed, which is not something to
// publish from a real disk, and assigning a title writes. Those two pictures therefore come from
// the throwaway instance (`verify.sh up --movies`: a generated library, a fake TMDB, a fake VLC),
// which is all the default export takes. It must never write a picture that `live` takes.
//
// play.gif needs a real play: a VLC opens on the owner's screen, a play is added to their history
// and the VLC they had open stops being followed. It is retaken only with DOCS_SHOTS_PLAY=1, on a
// film that is already in progress, and only the VLC it opened is closed afterwards:
//
//   DOCS_SHOTS_PLAY=1 npm run docs:shots -- --live movies
//
// chat-movie-id.png shows the pop-up following a play, so it needs both: one billed question on the
// series' page for the chip, then Continue in the pop-up, which is a real play of the series (it
// moves the open episode's resume point by a few seconds). It is retaken alone, and like the clip
// it closes only the VLC it opened:
//
//   DOCS_SHOTS_PLAY=popup npm run docs:shots -- --live movies
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const up = ['--movies'];

// The owner's library (--live): a finished film with stars and a review, and a series.
const LIVE_FILM = 'movie-10681'; // WALL·E
const LIVE_FILM_DIRECTOR = 'Andrew Stanton';
const LIVE_SERIES = 'tv-247718'; // MobLand
const LIVE_PLAY_FILM = 'movie-670'; // Oldboy: in progress already, so one more short play changes nothing
const TASKLIST = '/mnt/c/Windows/System32/tasklist.exe';
const TASKKILL = '/mnt/c/Windows/System32/taskkill.exe';
const VIEWPORT = { width: 1280, height: 800 };
const TALL = { width: 1280, height: 1060 };

async function until(what, fn, { tries = 80, everyMs = 500 } = {}) {
  for (let i = 0; i < tries; i++) {
    const value = await fn();
    if (value) return value;
    await sleep(everyMs);
  }
  throw new Error(`movies shots: gave up waiting for ${what}`);
}

/** A 16 minute, few-KB video: long enough to pass NOTESD_MOVIES_MIN_SECONDS. */
async function video(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=0x1d2630:s=32x18:r=1', '-t', '960', '-c:v', 'mpeg4', '-q:v', '31', '-an', file]);
}

export async function seed(ctx) {
  const { fetchJson } = ctx;
  // Three files the scan cannot place, so the unmatched list shows more than one reason.
  const { roots } = await fetchJson('GET', '/api/movies/status');
  const videos = roots.find((r) => r.endsWith('/Videos')) ?? roots[0];
  await video(path.join(videos, 'Bali.Family.Trip.Day.3.mp4')); // no TMDB match
  await video(path.join(videos, 'Oldboy.Returns.2019.1080p.WEB-DL.x265.mkv')); // a candidate, not a confident one
  writeFileSync(path.join(videos, 'Untitled.Download.part.mkv'), Buffer.alloc(4096, 7)); // ffprobe cannot read it

  // A new file is registered once two passes in a row saw the same size and mtime.
  await until(
    'the library sync',
    async () => {
      await fetchJson('POST', '/api/movies/sync');
      await sleep(2500);
      const { counts } = await fetchJson('GET', '/api/movies/status');
      return counts.titles >= 6 && counts.files_here >= 6 && counts.unmatched_here >= 4;
    },
    { tries: 30, everyMs: 0 },
  );
}

async function postersLoaded(page) {
  await page.locator('img[src*="/t/p/"]').first().waitFor();
  await page.waitForFunction(() => {
    // Posters are lazy: one below the fold never loads, and a long list (the Stream side) has many.
    const imgs = [...document.querySelectorAll('img[src*="/t/p/"]')].filter((img) => {
      const box = img.getBoundingClientRect();
      return box.bottom > 0 && box.top < window.innerHeight;
    });
    return imgs.length > 0 && imgs.every((img) => img.complete && img.naturalWidth > 0);
  });
}

/** The throwaway instance: only the two pictures that must not come from a real disk. */
export default async ({ page, base, shot }) => {
  // The unmatched list, one row per reason, and the dialog that assigns a title by hand.
  await page.goto(`${base}/movies/unmatched`);
  const unmatched = page.getByRole('region', { name: 'Unmatched files' });
  await unmatched.getByText('Bali.Family.Trip.Day.3.mp4', { exact: true }).waitFor();
  await shot('unmatched');
  await page.getByRole('button', { name: 'Assign a title to Oldboy.Returns.2019.1080p.WEB-DL.x265.mkv' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('option').first().waitFor();
  await dialog.getByRole('option').first().click();
  await postersLoaded(page);
  await shot('assign', { locator: dialog });
  await page.keyboard.press('Escape');
};

async function answerDone(page) {
  await page.locator('.answer-body').first().waitFor({ timeout: 180000 });
  await page.waitForFunction(
    () => {
      const body = document.querySelector('.answer-body');
      return body !== null && (body.textContent ?? '').trim().length > 40 && !body.textContent.includes('▍') && document.querySelector('.answer [role="status"]') === null;
    },
    null,
    { timeout: 240000 },
  );
  await page.waitForTimeout(1500);
}

async function vlcPids() {
  const { stdout } = await run(TASKLIST, ['/FI', 'IMAGENAME eq vlc.exe', '/FO', 'CSV', '/NH']);
  return stdout.split(/\r?\n/).map((line) => /^"vlc\.exe","(\d+)"/i.exec(line)?.[1]).filter(Boolean);
}

/** The play clip: one real play of LIVE_PLAY_FILM. Closes the VLC it opened and no other. */
async function playClip({ base, clip, fetchJson }) {
  const before = new Set(await vlcPids());
  let opened = [];
  try {
    await clip('play', async (tab) => {
      await tab.goto(`${base}/movies/${LIVE_PLAY_FILM}`);
      const play = tab.locator('button.mv-play');
      await play.waitFor();
      await postersLoaded(tab);
      await tab.waitForTimeout(900);
      await play.click();
      await tab.getByText(/playing in VLC · /).waitFor({ timeout: 40000 });
      opened = (await vlcPids()).filter((pid) => !before.has(pid));
      await tab.waitForTimeout(9000);
      // Without /F this asks the window to close, as its X does, so VLC exits cleanly.
      for (const pid of opened) await run(TASKKILL, ['/PID', pid]).catch(() => {});
      await tab.getByRole('button', { name: /^Resume at / }).waitFor({ timeout: 30000 });
      await tab.getByRole('button', { name: /^Resume at / }).hover();
      await tab.waitForTimeout(1500);
    });
  } finally {
    const left = (await vlcPids()).filter((pid) => opened.includes(pid));
    for (const pid of left) await run(TASKKILL, ['/PID', pid]).catch(() => {});
    const { current } = await fetchJson('GET', '/api/movies/player');
    console.log(`movies: play clip opened VLC ${opened.join(', ') || 'none'}; still running: ${left.join(', ') || 'none'}; followed now: ${current?.name ?? 'nothing'}`);
  }
}

/** A VLC this run opened: asked to close (no /F, as its X does), then reported with what the daemon follows now. */
async function closeOpened(what, opened, fetchJson) {
  for (const pid of opened) await run(TASKKILL, ['/PID', pid]).catch(() => {});
  await sleep(3000);
  const left = (await vlcPids()).filter((pid) => opened.includes(pid));
  for (const pid of left) await run(TASKKILL, ['/PID', pid]).catch(() => {});
  const { current } = await fetchJson('GET', '/api/movies/player');
  console.log(`movies: ${what} opened VLC ${opened.join(', ') || 'none'}; still running: ${left.join(', ') || 'none'}; followed now: ${current?.name ?? 'nothing'}`);
}

/** The pop-up of LIVE_SERIES while VLC plays it: one billed question, one real play. Closes the VLC it opened and no other. */
async function popupShot({ page, base, shot, fetchJson }) {
  const { movie_id: id } = await fetchJson('GET', `/api/movies/${LIVE_SERIES}`);
  await page.goto(`${base}/movies/${LIVE_SERIES}`);
  const pill = page.getByTestId('movies-pill');
  await pill.getByRole('textbox', { name: /^Ask about / }).fill('Which episode did I stop in, and which one is next? Two short sentences.');
  await pill.getByRole('button', { name: 'Send' }).click();
  await page.locator('.answer-body [data-movie-link]').first().waitFor({ timeout: 180000 });
  await answerDone(page);
  // The series' own chip: an episode's would play that episode, which may be the next one.
  const link = page.locator(`.answer-body [data-movie-link="${id}"]`).first();
  if ((await link.count()) === 0) throw new Error(`the answer has no ${id} chip: nothing was played, ask again`);
  await link.click();
  const popup = page.getByRole('dialog', { name: `Movie ${id}` });
  const play = popup.getByRole('button', { name: /^Continue/ });
  await play.waitFor();
  await postersLoaded(page);
  const before = new Set(await vlcPids());
  let opened = [];
  try {
    await play.click();
    await popup.locator('.mm-art.now.playing').waitFor({ timeout: 40000 });
    opened = (await vlcPids()).filter((pid) => !before.has(pid));
    await page.mouse.move(640, 60);
    // The outline and the dots pulse: taken at full strength, not mid-fade.
    await page.addStyleTag({ content: '.mm *, .mm *::before, .mm *::after { animation: none !important; }' });
    await page.waitForTimeout(1500);
    await shot('chat-movie-id', { locator: popup });
  } finally {
    if (opened.length === 0) opened = (await vlcPids()).filter((pid) => !before.has(pid));
    await closeOpened('pop-up picture', opened, fetchJson);
  }
}

/** The owner's real library, from the live daemon. Looks only, except with DOCS_SHOTS_PLAY: see the header. */
export async function live({ page, base, shot, clip, fetchJson }) {
  // Alone, so a retake of the clip does not also retake every still.
  if (process.env.DOCS_SHOTS_PLAY === '1') return playClip({ base, clip, fetchJson });
  if (process.env.DOCS_SHOTS_PLAY === 'popup') return popupShot({ page, base, shot, fetchJson });

  // The poster grid.
  await page.goto(`${base}/movies`);
  await page.getByRole('list', { name: 'Posters', exact: true }).waitFor();
  await postersLoaded(page);
  await shot('grid');

  // The Stream side: only titles verified to stream on this machine. It looks only: no Play, so no
  // Chrome opens and no source is re-checked. Kept as it is when the daemon has no Stream side yet
  // (404), direct streaming is off, or nothing is verified.
  const stream = await fetchJson('GET', '/api/movies/stream').catch(() => null);
  if (stream?.enabled === true && stream.titles.length > 0) {
    await page.goto(`${base}/movies?side=stream`);
    await page.getByRole('list', { name: 'Posters', exact: true }).waitFor();
    await postersLoaded(page);
    await page.mouse.move(640, 60);
    await shot('stream');
  } else {
    const why = stream === null ? 'this daemon has no Stream side' : stream.enabled ? 'nothing is verified to stream' : 'direct streaming is off';
    console.log(`movies: ${why}, stream.png is kept as it is`);
  }

  // A film: facts, Play, the trailer icon, watched flag, stars, review, credits, cast. A taller
  // window, so the whole page is in one picture with the pill where it really sits.
  await page.setViewportSize(TALL);
  await page.goto(`${base}/movies/${LIVE_FILM}`);
  await page.getByRole('textbox', { name: 'Review' }).waitFor();
  await page.getByRole('region', { name: 'Cast' }).waitFor();
  await postersLoaded(page);
  await page.mouse.move(640, 60);
  await shot('film');

  // The trailer pop-up over the film's page.
  await page.setViewportSize(VIEWPORT);
  await page.getByRole('button', { name: 'Watch the trailer' }).click();
  const trailer = page.getByRole('dialog', { name: /^Trailer of / });
  await trailer.locator('iframe').waitFor();
  await page.waitForTimeout(6000);
  await shot('trailer');
  await page.keyboard.press('Escape');
  await trailer.waitFor({ state: 'hidden' });

  // A series: one row per episode, each with its movie id and progress, and the season's trailer icon.
  await page.setViewportSize(TALL);
  await page.goto(`${base}/movies/${LIVE_SERIES}`);
  const episodes = page.getByRole('region', { name: 'Episodes' });
  await episodes.getByText(/^S01E01$/).first().waitFor();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await shot('episodes', { locator: episodes });
  await page.setViewportSize(VIEWPORT);

  // The page of the title VLC has open right now, if it has one. Nothing is started for it.
  const { current } = await fetchJson('GET', '/api/movies/player');
  if (current?.title_id) {
    await page.goto(`${base}/movies/${current.title_id}`);
    await page.getByText(/(playing|paused) in VLC · /).waitFor({ timeout: 20000 });
    await postersLoaded(page);
    await page.mouse.move(640, 60);
    await shot('playing');
  } else {
    console.log('movies: VLC has nothing open, playing.png is kept as it is');
  }

  // Filtering the grid: state pills, the kind icons, the text filter.
  await clip('filter', async (tab) => {
    await tab.goto(`${base}/movies`);
    await tab.getByRole('list', { name: 'Posters', exact: true }).waitFor();
    await postersLoaded(tab);
    await tab.waitForTimeout(700);
    const states = tab.getByRole('group', { name: 'State' });
    for (const name of [/^in progress/, /^finished/, /^gone/, /^all/]) {
      await states.getByRole('button', { name }).click();
      await tab.waitForTimeout(800);
    }
    await tab.getByRole('button', { name: 'Series' }).click();
    await tab.waitForTimeout(800);
    await tab.getByRole('button', { name: 'All kinds' }).click();
    await tab.getByRole('searchbox', { name: 'Filter titles' }).pressSequentially('old', { delay: 140 });
    await tab.waitForTimeout(1100);
  });

  // Two billed questions: a name on a film's page asking about itself, and one answer with movie
  // ids. The pop-up an id opens is popupShot's. See the header.
  if (process.env.DOCS_SHOTS_CHAT === '1') {
    await page.setViewportSize(TALL);
    await page.goto(`${base}/movies/${LIVE_FILM}`);
    await page.getByRole('region', { name: 'Cast' }).waitFor();
    await postersLoaded(page);
    await page.getByLabel('Credits').getByRole('button', { name: LIVE_FILM_DIRECTOR, exact: true }).first().click();
    await answerDone(page);
    await page.mouse.move(640, 60);
    await shot('ask-name');
    await page.setViewportSize(VIEWPORT);

    await page.goto(`${base}/movies/${LIVE_SERIES}`);
    const pill = page.getByTestId('movies-pill');
    await pill.getByRole('textbox', { name: /^Ask about / }).fill('Which episode did I stop in, and which one is next? Two short sentences.');
    await pill.getByRole('button', { name: 'Send' }).click();
    const link = page.locator('.answer-body [data-movie-link]').first();
    await link.waitFor({ timeout: 180000 });
    await answerDone(page);
    await page.mouse.move(640, 120);
    await shot('chat-answer', { locator: page.locator('.answer') });
  }
}
