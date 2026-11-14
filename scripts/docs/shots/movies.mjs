// Pictures for docs/guide/movies.md. Run by scripts/docs/capture.mjs:
//
//   npm run docs:shots -- movies
//   DOCS_SHOTS_CHAT=1 npm run docs:shots -- movies    also retake chat-answer.png and chat-movie-id.png
//
// The instance is `verify.sh up --movies`: a generated video library, a fake TMDB that draws its own
// posters and a fake vlc.exe / curl.exe. Nothing here reaches a real VLC, TMDB or video folder.
// The two chat pictures need one answer from the wall's chat, which is a real, billed Claude run, so
// they are retaken only when DOCS_SHOTS_CHAT=1; without it the pictures in the repo are kept.
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const up = ['--movies'];

const KILLING = 'movie-467905'; // How to Make a Killing
const OLDBOY = 'movie-990004';
const MOBLAND = 'tv-247718';
const VIEWPORT = { width: 1280, height: 800 };
const TALL = { width: 1280, height: 1060 };
const REVIEW =
  'Glen Powell is having too much fun and so was I. The plan gets sillier with every cousin, and the ' +
  'last twenty minutes still land. Margaret Qualley steals the two scenes she is in. Rewatch with A.';

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

/** Play one file in the fake VLC up to `seconds`, then let VLC "exit" so the play closes there. */
async function playTo({ v, fetchJson }, fileId, seconds) {
  await fetchJson('POST', `/api/movies/files/${fileId}/play`, {});
  await until(`the play of file ${fileId}`, async () => (await fetchJson('GET', '/api/movies/player')).current?.file_id === fileId);
  await v('vlc', 'at', String(seconds));
  await until(`file ${fileId} at ${seconds} s`, async () => ((await fetchJson('GET', '/api/movies/player')).current?.position ?? 0) >= seconds);
  await v('vlc', 'quit');
  await until(`the play of file ${fileId} to close`, async () => (await fetchJson('GET', '/api/movies/player')).current === null);
}

const fileOf = (detail, season, episode) => detail.files.find((f) => !f.deleted && f.season === season && f.episode === episode);

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

  // A finished film with stars and a review, a series one and a half episodes in. Oldboy stays unwatched;
  // the fixture already has a film in a Done folder and two deleted films from VLC's recent list.
  const killing = await fetchJson('GET', `/api/movies/${KILLING}`);
  await playTo(ctx, killing.files.find((f) => !f.deleted).id, 900);
  await fetchJson('POST', `/api/movies/${KILLING}/user`, { rating: 4, review: REVIEW });
  const mobland = await fetchJson('GET', `/api/movies/${MOBLAND}`);
  await playTo(ctx, fileOf(mobland, 1, 1).id, 930);
  await playTo(ctx, fileOf(mobland, 1, 2).id, 412);
}

async function postersLoaded(page) {
  await page.locator('img[src*="/t/p/"]').first().waitFor();
  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll('img[src*="/t/p/"]')];
    return imgs.length > 0 && imgs.every((img) => img.complete && img.naturalWidth > 0);
  });
}

export default async ({ page, base, shot, clip, v, fetchJson }) => {
  // The poster grid in mixed states.
  await page.goto(`${base}/movies`);
  await page.getByRole('list', { name: 'Posters' }).waitFor();
  await postersLoaded(page);
  await shot('grid');

  // A film: facts, Play, watched flag, stars, review, credits, cast. A taller window, so the whole
  // page is in one picture with the pill where it really sits.
  await page.setViewportSize(TALL);
  await page.goto(`${base}/movies/${KILLING}`);
  await page.getByRole('textbox', { name: 'Review' }).waitFor();
  await page.getByRole('region', { name: 'Cast' }).waitFor();
  await postersLoaded(page);
  await shot('film');

  // A series: one row per episode, each with its movie id and progress. Scrolled to the end first,
  // so the rows sit above the pill.
  await page.goto(`${base}/movies/${MOBLAND}`);
  const episodes = page.getByRole('region', { name: 'Episodes' });
  await episodes.getByText('Eye for an Eye').waitFor();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await shot('episodes', { locator: episodes });

  // Continue on the series resumes S01E02 in the (fake) VLC; the page follows the position.
  await page.getByRole('button', { name: /^Continue/ }).click();
  await page.getByText(/playing in VLC · /).waitFor();
  await v('vlc', 'at', '520');
  await page.getByText(/playing in VLC · 8:4\d/).waitFor({ timeout: 20000 });
  await page.mouse.move(640, 240);
  await page.evaluate(() => window.scrollTo(0, 0));
  await postersLoaded(page);
  await shot('playing');
  await page.setViewportSize(VIEWPORT);
  await v('vlc', 'quit');
  await until('the play to close', async () => (await fetchJson('GET', '/api/movies/player')).current === null);

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

  // Filtering the grid: state pills, the kind icons, the text filter.
  await clip('filter', async (tab) => {
    await tab.goto(`${base}/movies`);
    await tab.getByRole('list', { name: 'Posters' }).waitFor();
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

  // Play on a film: VLC starts, the page shows the position, and Play becomes Resume when VLC exits.
  // After every still, because it leaves Oldboy in progress.
  await clip('play', async (tab) => {
    await tab.goto(`${base}/movies/${OLDBOY}`);
    await tab.getByRole('button', { name: 'Play', exact: true }).waitFor();
    await postersLoaded(tab);
    await tab.waitForTimeout(600);
    await tab.getByRole('button', { name: 'Play', exact: true }).click();
    await tab.getByText(/playing in VLC · /).waitFor();
    await v('vlc', 'at', '300');
    await tab.getByText(/playing in VLC · 5:\d\d/).waitFor({ timeout: 20000 });
    await tab.waitForTimeout(900);
    await v('vlc', 'quit');
    await tab.getByRole('button', { name: /^Resume at 5:/ }).waitFor({ timeout: 20000 });
    await tab.getByRole('button', { name: /^Resume at 5:/ }).hover();
    await tab.waitForTimeout(1200);
  });

  // One chat answer with movie ids, and the pop-up an id opens. One billed message: see the header.
  if (process.env.DOCS_SHOTS_CHAT === '1') {
    await page.goto(`${base}/movies/${MOBLAND}`);
    const ask = page.getByTestId('movies-pill').getByRole('textbox', { name: 'Ask about MobLand' });
    await ask.fill('Which episode did I stop in, and which one is next? Two short sentences.');
    await page.getByTestId('movies-pill').getByRole('button', { name: 'Send' }).click();
    const link = page.locator('.answer-body [data-movie-link]').first();
    await link.waitFor({ timeout: 180000 });
    await page.waitForFunction(() => !document.querySelector('.answer-body')?.textContent?.includes('▍'), null, { timeout: 180000 });
    await page.mouse.move(640, 120);
    await shot('chat-answer', { locator: page.locator('.answer') });
    await link.click();
    const popup = page.getByRole('dialog', { name: /^Movie M-/ });
    await popup.getByRole('button', { name: /^(Play|Resume|Continue)/ }).waitFor();
    await postersLoaded(page);
    await shot('chat-movie-id', { locator: popup });
  }
};
