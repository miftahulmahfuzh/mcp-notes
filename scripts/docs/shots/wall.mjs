// Pictures for docs/guide/wall.md: the wall, its views, the big editor, the photo modal and the bin.
//
//   npm run docs:shots -- wall
//
// Everything shown is seeded here. The photos are fixed Unsplash stock pictures (the same ones every
// run, none of them the owner's), cached under ~/.cache/notesd-docs-photos; a photo that cannot be
// downloaded and is not cached is replaced by a drawn placeholder, so a rerun never fails offline.
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const CACHE = path.join(os.homedir(), '.cache', 'notesd-docs-photos');

// Cache name -> Unsplash photo id. The captions in the seed below describe these pictures.
const PHOTOS = {
  tram: '1585208798174-6cedd86e019a',
  'river-dusk': '1513735492246-483525079686',
  riverside: '1555881400-74d7acaacd8b',
  beach: '1507525428034-b723cf961d3e',
  seedlings: '1466692476868-aef1dfb1e735',
  soil: '1416879595882-3373a0480b5b',
  footbridge: '1447752875215-b2761acb3c5d',
  desk: '1518455027359-f3f8164ba6bd',
  range: '1464822759023-fed622ff2c3b',
  forest: '1441974231531-c6227db76b6e',
  bread: '1509440159596-0249088772ff',
  coffee: '1495474472287-4d71bcdd2085',
  'kitchen-white': '1484154218962-a197022b5858',
  'kitchen-counter': '1556911220-bff31c812dba',
  'living-room': '1513694203232-719a280e022f',
  lake: '1493246507139-91e8fad9978e',
};

let offline = false;

/** A cached stock photo by name; downloaded once. */
async function photo(word) {
  mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `${word}.jpg`);
  if (existsSync(file) && statSync(file).size > 10_000) return file;
  // After one photo has failed three times the site is taken to be unreachable for this run.
  for (let attempt = 0; attempt < 3 && !offline; attempt++) {
    try {
      const url = `https://images.unsplash.com/photo-${PHOTOS[word]}?w=1600&h=1067&fit=crop&q=80&fm=jpg`;
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length < 10_000) throw new Error('short body');
      writeFileSync(file, bytes);
      return file;
    } catch (err) {
      console.log(`wall: photo ${word} attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt === 2) offline = true;
    }
  }
  // Offline and never cached: a drawn stand-in, kept out of the cache so the next run tries again.
  const hue = [...word].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) % 360, 7);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1067">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="hsl(${hue},35%,62%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},30%,22%)"/>
    </linearGradient></defs>
    <rect width="1600" height="1067" fill="url(#g)"/>
    <circle cx="${300 + ((hue * 53 + word.length * 97) % 1000)}" cy="${200 + ((hue * 17 + word.length * 41) % 200)}" r="120" fill="hsl(${(hue + 20) % 360},60%,80%)" opacity=".8"/>
    <path d="M0 820 L420 520 L760 760 L1080 480 L1600 800 L1600 1067 L0 1067 Z" fill="hsl(${(hue + 60) % 360},25%,16%)"/>
  </svg>`;
  const tmp = path.join(os.tmpdir(), `notesd-docs-${word}.jpg`);
  await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toFile(tmp);
  return tmp;
}

/** The JSON body of a `verify.sh upload` transcript. */
function uploaded(stdout) {
  const line = stdout.split('\n').find((l) => l.startsWith('{'));
  if (!line) throw new Error(`upload gave no JSON: ${stdout.slice(0, 300)}`);
  return JSON.parse(line);
}

// Text notes, oldest first. `days` = how long ago the note was written and last edited.
const TEXT_NOTES = [
  { days: 41, body: 'Bike service is due at 3,000 km. Chain was replaced at 1,850. #bike' },
  { days: 33, body: 'Read next: The Dispossessed, Piranesi, A Month in the Country. #books' },
  { days: 27, body: 'Flat white that finally worked: 18 g in, 36 g out, 28 seconds. Grind one step finer than for filter. #coffee #recipes' },
  { days: 21, body: 'Gift ideas for Dad: a decent headlamp, the bird book, new secateurs. #ideas' },
  { days: 16, body: 'Tomatoes went in on the 3rd. Water deeply twice a week, not a little every day. Pinch the side shoots once they reach the second truss. #garden' },
  { days: 12, body: 'wifi guest password is on the fridge #home' },
  {
    days: 9,
    body: 'From Mara\'s talk: "The backlog is a museum of good intentions." Worth repeating at the next planning meeting. #work #quotes',
  },
  { days: 6, body: 'Lisbon packing: adapter, rain shell, four rolls of film, the small tripod. Tram 28 early, before 8, or not at all. #trip #lisbon' },
  { days: 4, body: 'Compost bin is full. Turn it on Sunday. #garden' },
  {
    days: 3,
    body: 'Sourdough, loaf 14: 78% hydration was too slack to shape. Next time 72%, bulk 5 h at 24 C, cold proof overnight, bake 20 min lid on and 22 off. #recipes #bread',
  },
  { days: 2, body: 'Demo first, slides only if someone asks. #work' },
  { days: 1, body: 'call the plumber about the kitchen tap #home' },
  { days: 0, body: 'Lisbon day 2: Gulbenkian in the morning, then the ferry to Cacilhas for lunch. Book the Sintra train the night before. #trip #lisbon' },
];

// Photo notes: the first photo makes the note, the rest are attached to it in order.
const PHOTO_NOTES = [
  { key: 'bridge', days: 30, photos: ['footbridge'], body: 'The long way home. #walks' },
  { key: 'coffee', days: 24, photos: ['coffee'], body: 'Sunday. #coffee' },
  { key: 'desk', days: 18, photos: ['desk'], body: 'New corner by the window. #home' },
  { key: 'range', days: 8, photos: ['range'], body: 'Saturday, above the tree line. #walks' },
  { key: 'lisbon', days: 5, photos: ['tram', 'river-dusk', 'riverside', 'beach'], body: 'Scouting pictures for the trip. #trip #lisbon' },
  { key: 'bread', days: 3, photos: ['bread'], body: 'Loaf 14, the good one. #bread #recipes' },
  { key: 'garden', days: 2, photos: ['seedlings', 'soil'], body: 'Seed trays, week two. #garden' },
  { key: 'forest', days: 1, photos: ['forest'], body: '#walks' },
];

// The note the big editor is shown on: long text, three photos and two files.
const KITCHEN = {
  days: 0,
  photos: ['kitchen-white', 'kitchen-counter', 'living-room'],
  body: [
    'Kitchen renovation, where it stands.',
    '',
    'Three quotes are in (spreadsheet attached). Okafor & Lind is the middle price and the only one that includes moving the gas line. They can start the week of the 14th and need the tiles on site by then.',
    '',
    'Still to decide: oak or ash for the worktop, and whether the tall cupboard stays. Measure the alcove again before ordering, the plan says 61 cm and the tape said 59.',
    '',
    '#home #renovation',
  ].join('\n'),
};

// Deleted before the pictures are taken, so the recycle bin has something in it.
const BINNED = [
  { days: 14, body: 'Dentist moved to the 22nd, 9:40. #home' },
  { days: 7, body: 'Old router admin page: 192.168.1.1, sticker on the bottom. #home' },
];

function minimalPdf() {
  return Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  );
}

export async function seed({ v, fetchJson }) {
  const stamps = [];
  const stamp = (id, days) => stamps.push(`('${id}', ${days})`);

  for (const n of TEXT_NOTES) stamp((await fetchJson('POST', '/api/notes', { body: n.body })).id, n.days);

  const ids = {};
  for (const n of [...PHOTO_NOTES, { key: 'kitchen', ...KITCHEN }]) {
    const [first, ...rest] = n.photos;
    const { note } = uploaded(await v('upload', '/api/images', await photo(first), n.body));
    for (const word of rest) await v('upload', `/api/notes/${note.id}/images`, await photo(word));
    ids[n.key] = note.id;
    stamp(note.id, n.days);
  }

  // Two files on the kitchen note. Any file type becomes a chip; these two are made here.
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'notesd-docs-files-'));
  try {
    const csv = path.join(tmp, 'kitchen-quotes.csv');
    writeFileSync(csv, 'contractor,price,includes gas line,start\nOkafor & Lind,18400,yes,14th\nBrandt,16900,no,28th\nHale Joinery,21750,yes,7th\n');
    const pdf = path.join(tmp, 'floor-plan.pdf');
    writeFileSync(pdf, minimalPdf());
    await v('upload', `/api/notes/${ids.kitchen}/files`, csv);
    await v('upload', `/api/notes/${ids.kitchen}/files`, pdf);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // The bin: two deleted text notes, one deleted photo note, one photo removed from a live note.
  for (const n of BINNED) {
    const { id } = await fetchJson('POST', '/api/notes', { body: n.body });
    stamp(id, n.days);
    await fetchJson('DELETE', `/api/notes/${id}`);
  }
  const gone = uploaded(await v('upload', '/api/images', await photo('lake'), 'Same lake as last year, keep the old one. #walks'));
  await fetchJson('DELETE', `/api/notes/${gone.note.id}`);
  const lisbon = await fetchJson('GET', `/api/notes/${ids.lisbon}`);
  await fetchJson('DELETE', `/api/images/${lisbon.images[3].id}`);

  // Spread the notes over six weeks: a wall written in one minute would read "just now" on every card.
  await v(
    'exec',
    `update notes n set created_at = now() - make_interval(days => s.days, mins => (s.days * 37) % 600),
            updated_at = now() - make_interval(days => s.days, mins => (s.days * 37) % 600)
       from (values ${stamps.join(', ')}) as s(id, days) where n.id = s.id`,
  );
}

/** Every image inside the viewport has loaded (thumbnails further down are lazy and never load). */
async function imagesLoaded(page) {
  await page.waitForFunction(() =>
    [...document.images]
      .filter((img) => {
        const r = img.getBoundingClientRect();
        return r.bottom > 0 && r.top < innerHeight && r.width > 0;
      })
      .every((img) => img.complete && img.naturalWidth > 0),
  );
  await page.waitForTimeout(300);
}

const sidebarMode = (page, name) => page.locator('.side-modes').getByRole('button', { name, exact: true });

export default async ({ page, base, shot, clip, fetchJson }) => {
  const { notes } = await fetchJson('GET', '/api/notes?limit=200');
  const kitchen = notes.find((n) => n.body.startsWith('Kitchen renovation'));
  const lisbon = notes.find((n) => n.body.startsWith('Scouting pictures'));

  await page.goto(base + '/');
  await page.locator('.card').first().waitFor();

  // 1. Everything: text and photo notes mixed, rail collapsed.
  await page.getByRole('button', { name: 'Toggle sidebar' }).click();
  await sidebarMode(page, 'All notes').click();
  await page.getByRole('button', { name: 'Toggle sidebar' }).click();
  await page.getByRole('heading', { name: 'Everything.' }).hover(); // off the rail: no tooltip in the picture
  await imagesLoaded(page);
  await shot('everything');

  // 2. Tags: sidebar open, filtered by #lisbon.
  await page.getByRole('button', { name: 'Toggle sidebar' }).click();
  await page.locator('.side-tags').getByText('#lisbon', { exact: true }).click();
  await page.getByRole('heading', { name: '#lisbon' }).waitFor();
  await imagesLoaded(page);
  await shot('tags');

  // 3. Photos: one tile per photo.
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await sidebarMode(page, 'Image notes only').click();
  await page.getByRole('button', { name: 'Toggle sidebar' }).click();
  await page.getByRole('heading', { name: 'Photos.' }).hover();
  await imagesLoaded(page);
  await shot('photos');

  // 4. The photo modal on the second photo of a three-photo note.
  await page.locator(`[data-photo][data-note="${lisbon.id}"]`).nth(1).click();
  await page.locator('[data-modal="photo"] img').waitFor();
  await imagesLoaded(page);
  await shot('photo-modal');
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  // 5. The big editor: text, tag chips, two file chips and the photo strip.
  await page.getByRole('button', { name: 'Image notes only (click to switch)' }).click();
  await page.getByRole('heading', { name: 'Everything.' }).waitFor();
  await page.locator(`[data-note="${kitchen.id}"]`).getByRole('button', { name: 'Expand note' }).click();
  const editor = page.getByRole('dialog', { name: `Edit note ${kitchen.id}` });
  await editor.locator('[data-files] [data-file]').nth(1).waitFor();
  await editor.locator('[data-strip] img').nth(2).waitFor();
  await imagesLoaded(page);
  await shot('editor');
  await editor.getByRole('button', { name: 'Close', exact: true }).click();

  // 6. The recycle bin, with the removed photo asking "delete forever?" (check and cross).
  await page.getByRole('button', { name: 'Recycle bin' }).click();
  await page.getByRole('heading', { name: 'Deleted.' }).waitFor();
  await page.locator('[data-bin-note]').first().waitFor();
  await page.locator('[data-bin-image][data-kind="image"]').getByRole('button', { name: 'Delete image forever' }).click();
  await page.locator('[data-bin-image] [data-confirm]').waitFor();
  await page.getByRole('heading', { name: 'Deleted.' }).hover();
  await imagesLoaded(page);
  await shot('bin');
  await page.getByRole('button', { name: 'Cancel' }).click();

  // GIF: a note written over the API appears on an open wall, then changes as it is edited.
  await clip('live', async (tab) => {
    await tab.goto(base + '/');
    await tab.locator('.card').first().waitFor();
    await tab.waitForTimeout(500);
    const made = await fetchJson('POST', '/api/notes', { body: 'Sintra: 9:11 from Rossio, platform 2. #trip #lisbon' });
    await tab.locator(`[data-note="${made.id}"]`).waitFor();
    await tab.waitForTimeout(1100);
    await fetchJson('PATCH', `/api/notes/${made.id}`, {
      body: 'Sintra: 9:11 from Rossio, platform 2. Back on the 17:40. Pena first, it is the one with the queue. #trip #lisbon',
    });
    await tab.locator(`[data-note="${made.id}"]`).getByText('Pena first').waitFor();
    await tab.waitForTimeout(1200);
    await fetchJson('DELETE', `/api/notes/${made.id}`);
  });
};
