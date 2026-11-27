# The wall

## Sub-features
- Notes grid, newest edited first; `?note=A-B32` scrolls to and highlights a note.
- Live updates: a write from anywhere (MCP, API) appears without reload (SSE `/api/events`).
- Big note editor (codename bigger-view-on-note, `NoteEditor.tsx`), tag suggestions, copy id.
- Sidebar (`Toggle sidebar`, or Alt+B anywhere but focus mode): view buttons, Projects, Chat history,
  Seer Adversarial, the tag list. Rail: the view cycle, Movies, Projects, Chat history, Seer
  Adversarial, Recycle bin (the bin is on the rail only, `Rail.tsx`).
- Three views (Notes, Photos, Everything) with their `h1` and count line, and the automatic view
  switches. Unit: `web/src/lib/filter.test.tsx`, `web/src/App.test.tsx`.
- Tag filters: AND matching, the rail's chips, `Clear filters`, the filter carried into the bin.
  Unit: `web/src/lib/filter.test.tsx`, `web/src/lib/binFilter.test.tsx`.
- Inline edit and the empty-note rule (a new note left empty goes to the bin).
- Show on wall (the editor's crosshair) and the deep-link edge cases: a deleted note opens the bin,
  an unknown id shows `no note X`, `?note=M-23T4` goes to Movies, a note picture's id opens the
  picture. Unit: `web/src/App.deeplink.test.tsx`, `web/src/App.notelinks.test.tsx`,
  `web/src/lib/route.test.tsx`.
- Picking up the other machine's edits: a poll every 5 minutes while visible, and on focus when the
  last load is older than 60 s. Unit: `web/src/hooks/pollers.test.tsx`.
- Static fallback: `/history`, `/projects?...`, `/movies/M-xxxx` answer the web app's `index.html`;
  an unbuilt web app answers 503. Unit: `tests/unit/static.test.ts`.
- With no editor open, a drop or paste keeps only the types the image path takes (`ATTACHABLE_IMAGE_TYPES`): SVG and
  BMP are never posted to `/api/images`. Proven by `npx vitest run web/src/components/DropOverlay.test.tsx
  web/src/lib/files.test.tsx` and a `$V ui` drop of svg+bmp+png that makes exactly one POST.

## How to get to it (user POV)
Open `URL` from `up`. Every control is an icon button with an aria-label.

## Driving it with verify.sh
`$V up --web`, then a steps file. Live update example:
```js
export default async ({ page, base, shot, log }) => {
  await page.goto(base + '/')
  await fetch(base + '/api/notes', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'arrived live #sse' }) })
  await page.getByText('arrived live').first().waitFor({ timeout: 5000 })   // no reload
  await shot('live')
  log('note written over the API appears on an open wall without reload')
}
```

Views and tag filters, in one steps file:
```js
export default async ({ page, base, shot, log }) => {
  for (const body of ['one #red #big', 'two #red'])
    await fetch(base + '/api/notes', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body }) })
  await page.goto(base + '/')
  await page.getByRole('button', { name: /\(click to switch\)$/ }).click()   // the rail's view cycle
  log('h1 after one click: ' + await page.locator('h1').first().textContent())
  await shot('views')
}
```
Then click the sidebar's tag rows and read the count line (`N of M notes.`); with both `#red` and
`#big` selected only `one` is left. The bin's own filter: `$V api RUN GET '/api/bin?tag=red'`.

Static fallback: `$V api RUN GET /history` and `$V api RUN GET /movies/M-0000` both answer
`text/html` (the app's `index.html`).

## Gotchas
- Always `up --web` for web changes, or you are testing an old bundle.
- Check `NN-ui-*.txt` for `console.error` / `pageerror` lines even when the run passes.
- Layout claims (no horizontal scroll, pill at bottom) need a screenshot AND a measured assertion
  (`page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)`), not just a picture.
