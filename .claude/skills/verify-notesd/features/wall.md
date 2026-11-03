# The wall

## Sub-features
- Notes grid, newest edited first; `?note=A-B32` scrolls to and highlights a note.
- Live updates: a write from anywhere (MCP, API) appears without reload (SSE `/api/events`).
- Big note editor (codename bigger-view-on-note, `NoteEditor.tsx`), tag suggestions, copy id.
- Sidebar (`Toggle sidebar`), font toggle, Projects link, chat history, recycle bin.

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

## Gotchas
- Always `up --web` for web changes, or you are testing an old bundle.
- Check `NN-ui-*.txt` for `console.error` / `pageerror` lines even when the run passes.
- Layout claims (no horizontal scroll, pill at bottom) need a screenshot AND a measured assertion
  (`page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)`), not just a picture.
