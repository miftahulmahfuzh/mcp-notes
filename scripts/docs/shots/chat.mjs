// Pictures for docs/guide/chat.md: the chat bar on the wall and the chat history page.
//
//   node scripts/docs/capture.mjs chat                        history pictures only (free)
//   DOCS_CHAT_BILLED=1 node scripts/docs/capture.mjs chat     every picture
//   DOCS_CHAT_BILLED=1 DOCS_CHAT_STEPS=reply node ...         only that billed step (answer, image, reply)
//
// The chat bar runs a real Claude agent on the owner's login, so the steps that send a message are
// BILLED. They are off unless DOCS_CHAT_BILLED=1, and there are exactly three of them (marked
// "BILLED" below). Without the flag the history page pictures are retaken from the seeded `/n`
// captures alone (history.png, history-actions.gif, and paste.png, which sends nothing) and
// answer.png, working.png, image-note.png and history-reply.png are left as they are.
//
// The questions only ask about the seeded notes. Do not add questions about spending, runs, Seer or
// movies: those tools read the owner's real databases, even from a throwaway daemon.
import sharp from 'sharp';

const BILLED = process.env.DOCS_CHAT_BILLED === '1';
/** Which billed steps to run when BILLED: any of answer, image, reply. Default: all three. */
const STEPS = new Set((process.env.DOCS_CHAT_STEPS ?? 'answer,image,reply').split(',').map((s) => s.trim()));
const billed = (step) => BILLED && STEPS.has(step);
/** One agent run may take a while; CHAT_TIMEOUT_MS is 180 s. */
const ANSWER_MS = 200_000;

const NOTES = [
  'Sourdough, loaf 14. 78% hydration, 20% wholemeal, bulk 5h at 26C. Crumb finally open but the base is pale: preheat the dutch oven 15 minutes longer next time. #baking #sourdough',
  'Sourdough, loaf 15. Same dough, oven preheated 60 min. Base is properly brown now. Scored too shallow, the ear did not lift. Try a 30 degree blade angle. #baking #sourdough',
  'Starter feeding: 1:5:5 at night keeps it from peaking before morning in this heat. 1:2:2 only when baking the same day. #baking #sourdough',
  'Lisbon in March, rough plan: 3 nights Alfama, 2 nights Sintra. Book the Pena Palace slot ahead, mornings sell out. Tram 28 before 9am or not at all. #travel #lisbon',
  'Lisbon food list from Ines: Cervejaria Ramiro (go at 5pm, no queue), Manteigaria over Belem for pasteis, Taberna da Rua das Flores for dinner but cash only. #travel #lisbon #food',
  'Flight to Lisbon: TP1351 out 14 March 07:40, back 19 March 21:15. Seat 14A both ways. Passport expires in August, renew after the trip. #travel #lisbon',
  'Reading: The Overstory. "The best time to plant a tree was twenty years ago. The second best time is now" shows up as a chapter epigraph. Halfway through, the Patricia chapters carry it. #reading',
  'Reading queue: Piranesi, The Dawn of Everything, A Month in the Country. Finish The Overstory first. #reading',
  'Bike: rear derailleur skips in gears 4 and 5 under load. Cable stretch, half a turn on the barrel adjuster fixed it on the stand. Check again after a wet ride. #bike',
  'Bike service log: new chain at 4,200 km, brake pads (rear) at 4,350 km. Next: bottom bracket feels gritty, book the shop before April. #bike',
  'Postgres: `SELECT pg_size_pretty(pg_database_size(current_database()))` for the size, and autovacuum was not running on the events table because of a long idle transaction. Kill idle-in-transaction sessions over 10 minutes. #postgres #work',
  'Standup notes: the import job doubles rows when it is retried. Idempotency key = source file sha + row number. Dana owns the fix, I review on Thursday. #work',
  'Gift ideas for Mum: the blue enamel teapot she pointed at in the market, or a year of the garden magazine. Birthday is 2 May. #family',
  'Balcony: basil bolts if it gets afternoon sun. Moved the pot behind the railing. Tomatoes need the bigger planter by the end of the month. #garden',
  'Apartment wifi drops every evening around 8. Router log shows DFS channel switches. Pinned 5 GHz to channel 44 and it has held for three days. #home',
];

/** `/n` exchanges as the notes-capture hook posts them. `{0}`... are note indexes into NOTES. */
const CAPTURES = [
  {
    hoursAgo: 50,
    prompt: '/n what did i write about the starter feeding ratio?',
    answer:
      'One note covers it: {2}. You feed 1:5:5 at night so the starter does not peak before morning in the heat, and 1:2:2 only when you bake the same day.',
  },
  {
    hoursAgo: 49,
    prompt: '/n save: derailleur fix was half a turn on the barrel adjuster, check after a wet ride #bike',
    answer: 'Saved as {8}, tagged #bike.',
  },
  {
    hoursAgo: 26,
    prompt: '/n here is the whiteboard from the import job review, keep the two action items with my standup note',
    answer:
      'I read the whiteboard (upload:{img}). It has two action items: "idempotency key = file sha + row" and "backfill the doubled rows". Both are already in {11}, so I appended only the backfill line there.',
    image: true,
  },
  {
    hoursAgo: 25,
    prompt: '/n summarize my lisbon notes',
    answer:
      'Three notes. {3} is the plan: 3 nights in Alfama and 2 in Sintra, with the Pena Palace slot booked ahead. {4} is the food list from Ines. {5} has the flights: out 14 March 07:40, back 19 March 21:15.',
  },
  {
    hoursAgo: 3,
    prompt: '/n when is the bottom bracket due?',
    answer: 'Before April. {9} says it feels gritty and that you meant to book the shop.',
  },
];

/** A made-up whiteboard photo, so no fixture file and nothing of the owner's is needed. */
async function whiteboardPng() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640">
    <rect width="960" height="640" fill="#f4f1ea"/>
    <rect x="18" y="18" width="924" height="604" fill="none" stroke="#b9b2a3" stroke-width="6" rx="10"/>
    <g font-family="Comic Sans MS, Segoe Print, cursive" fill="#1d3a8a">
      <text x="60" y="110" font-size="46">Import job review</text>
      <text x="60" y="200" font-size="34">1. idempotency key = file sha + row</text>
      <text x="60" y="270" font-size="34">2. backfill the doubled rows</text>
      <text x="60" y="340" font-size="34" fill="#a3262a">owner: Dana   review: Thu</text>
    </g>
    <g fill="none" stroke="#1d7a46" stroke-width="5">
      <rect x="90" y="420" width="190" height="110" rx="8"/>
      <rect x="400" y="420" width="190" height="110" rx="8"/>
      <rect x="700" y="420" width="190" height="110" rx="8"/>
      <path d="M280 475 H400 M590 475 H700"/>
    </g>
    <g font-family="Comic Sans MS, Segoe Print, cursive" font-size="28" fill="#1d7a46">
      <text x="125" y="485">files</text><text x="440" y="485">dedupe</text><text x="745" y="485">events</text>
    </g>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function captureExchange(base, body) {
  const res = await fetch(`${base}/api/capture/claude-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-notes-capture': '1' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`capture -> ${res.status} ${await res.text()}`);
  return res.json();
}

export const up = [];

export async function seed({ base, fetchJson }) {
  const ids = [];
  for (const body of NOTES) ids.push((await fetchJson('POST', '/api/notes', { body })).id);

  const png = (await whiteboardPng()).toString('base64');
  for (const [i, c] of CAPTURES.entries()) {
    const promptAt = new Date(Date.now() - c.hoursAgo * 3600_000);
    const fill = (text, img) => text.replace(/\{(\d+)\}/g, (_m, n) => ids[Number(n)]).replace('{img}', img ?? '');
    const body = {
      claude_session: `docs-chat-${i}`,
      user_uuid: `docs-chat-user-${i}`,
      prompt: c.prompt,
      answer: fill(c.answer),
      prompt_timestamp: promptAt.toISOString(),
      answered_at: new Date(promptAt.getTime() + 9000).toISOString(),
      cwd: '/home/demo/import-job',
      images: c.image ? [{ media_type: 'image/png', data_base64: png }] : [],
    };
    if (!c.image) {
      await captureExchange(base, body);
      continue;
    }
    // The answer names the picture by its upload id, which exists only once the picture is stored.
    const upload = new FormData();
    upload.append('file', new Blob([Buffer.from(png, 'base64')], { type: 'image/png' }), 'whiteboard.png');
    upload.append('source', 'claude_code');
    const stored = await (await fetch(`${base}/api/chat/images`, { method: 'POST', headers: { origin: base }, body: upload })).json();
    await captureExchange(base, { ...body, answer: fill(c.answer, stored.image.id) });
  }
}

/** Pastes the whiteboard picture into the focused chat bar, the way Ctrl+V of a screenshot does. */
async function pasteWhiteboard(page, bar) {
  const b64 = (await whiteboardPng()).toString('base64');
  await bar.focus();
  await bar.evaluate((el, data) => {
    const bytes = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'whiteboard.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, b64);
  await page.locator('.chatbar-thumb[data-image-state="ready"]').waitFor();
}

/** Waits for the open answer to finish: the chips row or the brain caption only show once done. */
async function answerDone(page) {
  await page.waitForFunction(
    () => {
      const body = document.querySelector('.answer .answer-body');
      return body !== null && body.textContent.trim() !== '' && !body.textContent.includes('▍');
    },
    undefined,
    { timeout: ANSWER_MS },
  );
}

async function wallShots({ page, base, shot }) {
  await page.goto(base + '/');
  const bar = page.getByLabel('Ask about your notes');
  const send = page.getByRole('button', { name: 'Send' });
  await bar.waitFor();
  await page.getByText('loaf 15').first().waitFor();

  if (billed('answer')) {
    // BILLED 1 of 3: an answer from the seeded notes. Note ids become links, the cards it used are outlined.
    await bar.fill('what did I change between my last two sourdough loaves, and what should I try next?');
    await send.click();
    await answerDone(page);
    await page.mouse.move(0, 0);
    await shot('answer');
  }

  // Free: a pasted picture waits in the pill as a thumbnail until the question is sent.
  await pasteWhiteboard(page, bar);
  await bar.fill('make this picture a note. caption: whiteboard from the import job review #work');
  await shot('paste', { locator: page.locator('form.chatbar') });
  if (!billed('image')) return;

  // BILLED 2 of 3: the pasted picture, sent as a follow-up in the same thread, becomes a note.
  await send.click();
  // The status line while a tool runs, on the collapsed header. Best effort: a fast run may skip it.
  try {
    await page.locator('.answer .answer-status').waitFor({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Collapse', exact: true }).click();
    await page.locator('.answer.collapsed .answer-status').waitFor({ timeout: 5_000 });
    await shot('working', { locator: page.locator('.answer') });
  } catch {
    console.log('chat: no status line seen in time; working.png not retaken');
  }
  const expand = page.getByRole('button', { name: 'Expand', exact: true });
  if (await expand.count()) await expand.click();
  await answerDone(page);
  await shot('image-note', { locator: page.locator('.answer') });
}

async function historyShots({ page, base, shot, clip, fetchJson }) {
  const { messages } = await fetchJson('GET', '/api/chat/messages?limit=200');
  const byText = (needle) => messages.find((m) => m.role === 'user' && m.text.includes(needle));
  const answerTo = (q) => messages.find((m) => m.thread_id === q.thread_id && m.role === 'assistant');
  const bubble = (p, m) => p.locator(`[data-msg="${m.id}"]`);
  const centre = (locator) => locator.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const whiteboard = byText('whiteboard from the import job review, keep');
  const lisbonAnswer = answerTo(byText('summarize my lisbon notes'));

  // The timeline: `/n` exchanges with their "claude code" badge, a pasted picture, ids as links.
  await page.goto(base + '/history');
  await bubble(page, whiteboard).waitFor();
  await bubble(page, whiteboard).locator('.bubble-thumb img').waitFor();
  await centre(bubble(page, answerTo(whiteboard)));
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);
  await shot('history');

  if (billed('reply')) {
    // BILLED 3 of 3: a reply to a "claude code" bubble. It starts a new wall thread that quotes it.
    await centre(bubble(page, lisbonAnswer));
    await bubble(page, lisbonAnswer).hover();
    await bubble(page, lisbonAnswer).getByRole('button', { name: /^Reply to message/ }).click();
    const replyButtons = await page.locator('[data-action="reply"]').count();
    await page.getByLabel('Ask about your notes').fill('which of these needs booking before I fly?');
    await page.getByRole('button', { name: 'Send' }).click();
    // The streaming bubbles are local and have no actions; the two server rows that replace them do.
    await page.waitForFunction((n) => document.querySelectorAll('[data-action="reply"]').length >= n + 2, replyButtons, { timeout: ANSWER_MS });
    await page.locator('.msg-quote').first().waitFor();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.mouse.move(0, 0);
    await page.waitForTimeout(500);
    await shot('history-reply');
  }

  // Edit (the old text is kept, the bubble says "edited"), delete with its answer, undo.
  await clip('history-actions', async (tab) => {
    const q = bubble(tab, byText('bottom bracket'));
    await tab.goto(base + '/history');
    await q.waitFor();
    await centre(q);
    await tab.waitForTimeout(500);
    await q.hover();
    await q.getByRole('button', { name: /^Edit message/ }).click();
    const editor = tab.getByRole('textbox', { name: 'Edit message' });
    await editor.fill('/n when is the bottom bracket');
    await editor.pressSequentially(' service due?', { delay: 40 });
    await tab.waitForTimeout(300);
    await editor.press('Enter');
    await q.locator('.msg-edited').waitFor();
    await tab.waitForTimeout(700);
    await q.hover();
    await q.getByRole('button', { name: /^Delete message/ }).click();
    await tab.waitForTimeout(700);
    await tab.getByRole('button', { name: 'Question and answer' }).click();
    await tab.waitForTimeout(1000);
    await tab.getByRole('button', { name: 'Undo' }).click();
    await q.waitFor();
    await tab.waitForTimeout(600);
  });
}

export default async (ctx) => {
  if (!BILLED) console.log('chat: DOCS_CHAT_BILLED is not 1, so no message is sent; answer.png, working.png, image-note.png and history-reply.png are not retaken');
  await wallShots(ctx);
  await historyShots(ctx);
};
