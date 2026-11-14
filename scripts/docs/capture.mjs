#!/usr/bin/env node
// Retake the pictures in docs/guide from a throwaway daemon. Never the live one on 7317.
//
//   npm run docs:shots -- wall movies     retake those guides' pictures
//   npm run docs:shots -- --all           retake every guide's pictures
//   npm run docs:shots -- --keep wall     leave the instance up afterwards (prints RUN and URL)
//   npm run docs:shots -- --run RUN wall  drive an instance that is already up (no seed, no down)
//   npm run docs:shots -- --no-build wall trust web/dist as built (several captures at once must not rebuild it)
//
// Each name is scripts/docs/shots/<name>.mjs and writes docs/guide/img/<name>/*.{png,gif}:
//
//   export const up = ['--movies']                      // extra `verify.sh up` flags
//   export async function seed({ v, base, fetchJson })  // optional: fill the instance first
//   export default async ({ page, base, shot, clip, v, fetchJson }) => { ... }
//
//   shot(name, { locator, fullPage })   PNG of the viewport, of one element, or of the whole page
//   clip(name, async (page) => {...})   GIF of what the callback does in a fresh tab
//   v(sub, ...args)                     `verify.sh <sub> RUN ...args`, resolved with its stdout
//   fetchJson(method, path, body)       same-origin JSON request against the instance
//
// The instance is the verify-notesd one (.claude/skills/verify-notesd): its own database, port,
// data dir and CLAUDE_HOME, so the pictures only ever show seeded data.
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import sharp from 'sharp';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VERIFY = path.join(ROOT, '.claude/skills/verify-notesd/scripts/verify.sh');
const SHOTS_DIR = path.join(ROOT, 'scripts/docs/shots');
const IMG_DIR = path.join(ROOT, 'docs/guide/img');
const VIEWPORT = { width: 1280, height: 800 };
const GIF_WIDTH = 960;
const GIF_FPS = 10;

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const runAt = args.indexOf('--run');
const existingRun = runAt >= 0 ? args[runAt + 1] : null;
const names = args.includes('--all')
  ? readdirSync(SHOTS_DIR).filter((f) => f.endsWith('.mjs')).map((f) => f.slice(0, -4))
  : args.filter((a, i) => !a.startsWith('--') && (runAt < 0 || i !== runAt + 1));
if (names.length === 0) {
  console.error('usage: capture.mjs [--keep] [--run RUN] <name>... | --all');
  process.exit(2);
}

async function verify(...argv) {
  const { stdout } = await run(VERIFY, argv, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function toGif(webm, gif) {
  const filter = `fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=5`;
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-filter_complex', filter, gif]);
}

async function capture(name, webBuilt) {
  const mod = await import(pathToFileURL(path.join(SHOTS_DIR, `${name}.mjs`)).href);
  const out = path.join(IMG_DIR, name);
  mkdirSync(out, { recursive: true });

  let id = existingRun;
  let base;
  if (id) {
    base = `http://127.0.0.1:${(await run('cat', [path.join(os.homedir(), '.local/state/notesd-verify', id, 'port')])).stdout.trim()}`;
  } else {
    // The pictures must show the checkout's own web app, so the first instance rebuilds it.
    const up = await verify('up', ...(webBuilt ? [] : ['--web']), ...(mod.up ?? []));
    id = /^RUN=(.+)$/m.exec(up)[1];
    base = /^URL=(.+)$/m.exec(up)[1];
  }
  console.log(`${name}: RUN=${id} URL=${base}`);

  const v = (sub, ...rest) => verify(sub, id, ...rest);
  const fetchJson = async (method, route, body) => {
    const res = await fetch(base + route, {
      method,
      headers: { origin: base, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };

  const browser = await chromium.launch();
  try {
    if (!existingRun && mod.seed) await mod.seed({ v, base, fetchJson, root: ROOT });

    const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'dark' });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log(`${name}: pageerror ${e.message}`));

    const shot = async (shotName, { locator, fullPage = false } = {}) => {
      const file = path.join(out, `${shotName}.png`);
      const png = locator ? await locator.screenshot() : await page.screenshot({ fullPage });
      // The wall's grain makes a plain PNG several times larger; a palette keeps the repo light.
      await sharp(png).png({ palette: true, quality: 90, effort: 8 }).toFile(file);
      console.log(`${name}: ${path.relative(ROOT, file)}`);
    };

    const clip = async (clipName, act) => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'notesd-clip-'));
      const recording = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'dark', recordVideo: { dir, size: VIEWPORT } });
      const tab = await recording.newPage();
      try {
        await act(tab);
      } finally {
        const video = tab.video();
        await recording.close();
        const file = path.join(out, `${clipName}.gif`);
        await toGif(await video.path(), file);
        rmSync(dir, { recursive: true, force: true });
        console.log(`${name}: ${path.relative(ROOT, file)}`);
      }
    };

    await mod.default({ page, base, shot, clip, v, fetchJson, root: ROOT });
    await context.close();
  } finally {
    await browser.close();
    if (existingRun || keep) console.log(`${name}: left up. ${VERIFY} down ${id}`);
    else await verify('down', id).catch((e) => console.error(`${name}: down failed: ${e.message}`));
  }
}

let webBuilt = args.includes('--no-build');
let failed = 0;
for (const name of names) {
  try {
    await capture(name, webBuilt);
  } catch (err) {
    failed += 1;
    console.error(`${name}: FAILED ${err?.stack ?? err}`);
  }
  webBuilt = true;
}
process.exit(failed === 0 ? 0 : 1);
