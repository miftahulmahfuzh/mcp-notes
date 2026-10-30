# Phase 7: Web UI core: wall, rail, sidebar, header, inline edit, chat bar + answer panel, tooltips, live updates

**Plan set:** `NOTES_SPINE_IMAGES_UI_PLAN.md`
**Analysis:** `docs/analyzer/20261030-092006-K7N3_code_analyzer.md`
**Satisfies:** R3 (the Claude Design as a Vite + React + TS SPA served by `notesd`, on the real API). This phase covers every non-image part.
**Depends on:** Phase 6 (and, through it, 1 and 2). Phase 5's `/thumb` route is used only as a URL string, so it does not need to have landed for this phase to build or pass its tests.
**Difficulty:** HARD
**Package:** `web/`

---

## Goal

After this phase, `npm run build` builds `web/dist/`, and `notesd` serves at `/` a pixel-faithful build of
`docs/design/claude-design/Notes Wall.dc.html` (the **30a58fd** revision with the 3-way mode) wired
to the real `/api/*`: masonry wall, rail, tag sidebar, header, inline edit, the "+" sticker, the chat
bar streaming `/api/chat` into the answer panel with used-note highlighting, custom tooltips, and
live updates (SSE plus a 60 s refetch). Image notes appear on the wall in mode `all` as
`/api/notes/:id/thumb`. The gallery, modal, drop overlay and the not-on-this-machine image are
stub components with fixed file names and props. Phase 8 rewrites those files and nothing else of mine.

## Design source and the requirement change

The worktree already holds commit `30a58fd` ("3-way note visibility, text-only by default"). It
changes R3 and the design file, and it is binding for this phase:

- `mode: 'text' | 'images' | 'all'`, with `'text'` the default on every load. No persistence.
- Heading: `images` → `Photos.`; else the active tags joined by space (`#a #b`); else `text` → `Notes.`, `all` → `Everything.`.
- Count line: `images` → `${photos} photos.`; tags active → `${visible} of ${all} notes.`;
  `text` → `${visible} notes, ${all - visible} photo notes hidden.`; `all` → `${all} notes, ${withPhotos} with photos.`
- Rail: one button cycles text → images → all → text. Its icon is `TextAa` / `Images` / `SquaresFour`
  (duotone), it is inverted (bg `#ecebe4`, fg `#121211`) when the mode is not `text`, and its tooltip is `"<tip> (click to switch)"`.
  It has no hover style in the design.
- Sidebar: the three mode icons in a row (gap 4px, 40px, font-size 20px), the active one inverted,
  and `N photos` pushed right (`margin-left:auto`).
- Toggling a tag never changes the mode. "+" in `images` switches to `text`. Asking the chat in `images`
  switches to `all`. A jump to a note that the current mode hides switches to `all`. Adding an image in `text`
  switches to `all`. That last rule is phase 8's upload code, which reaches it through `onImageAdded`, described below.

## Deliberate, minimal deviations from the design (mock → real)

| Design | Here | Why |
|---|---|---|
| `newId()` client id; `+` inserts a local row | `POST /api/notes {body:''}` first, then the card is shown with the server id in edit mode at the top | ids are server-generated (index Decisions) |
| fake `date` strings | `relativeDate(created_at)` per card, refreshed each minute; `lastWhen` from the max `updated_at` | R3 "relative dates" |
| `last = notes[0]` | note with max `updated_at` | R3 "Last edited <id> <when> from real data" |
| fixed `usedIds` | ids found in the streamed answer text, matched case-insensitively against loaded notes | R3 |
| `highlight = chatOpen && streamed > 0` | `chatOpen && text.length > 0 && used.length > 0` | in the design the answer always cites notes. The iteration-3 stub reply cites none, and dimming the whole wall to .22 for a reply that uses no notes would be wrong |
| used-chips row always rendered when done | rendered only when done **and** at least one id was found | avoids an empty bordered strip |
| tag sidebar counts computed from notes | from `GET /api/tags` (sorted count desc, then name) | real data |
| tag row hover overrides an active row's bg (dark-on-dark) | hover applies only to inactive rows (`:not(.on):hover`) | design-tool artefact; text would vanish |
| the note being edited can be hidden by the tag filter | the note being edited is always kept visible | else "+" under a filter creates an invisible empty note that never blurs and is never deleted |
| empty `ask()` falls back to a canned question | an empty question is not sent | no fake data |

Everything else (colors, sizes, spacing, font sizes, letter-spacing, transitions, grain SVG, z-indexes) is copied verbatim into `web/src/styles.css`.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `web/index.html`, `web/vite.config.ts`, `web/tsconfig.json`, `tsconfig.web.json`
- `web/src/main.tsx`, `web/src/App.tsx`, `web/src/styles.css`, `web/src/types.ts`, `web/src/api.ts`
- `web/src/lib/{text,filter,usedIds,dates,sse}.ts`
- `web/src/hooks/{useNotes,useChat,useNow,useCopied}.ts`
- `web/src/components/{Rail,Sidebar,Header,Wall,NoteCard,AnswerPanel,ChatBar,Tooltip}.tsx`
- **Phase 8 seam stubs** (phase 8 rewrites these files in full and may keep or widen the props):
  - `web/src/components/NoteImage.tsx`: `export function NoteImage(props: { note: Note; className?: string; style?: CSSProperties }): JSX | null`. NoteCard renders it for `note.image != null`. The stub always renders `<img src=/api/notes/:id/thumb>`. Phase 8 adds the not-on-this-machine placeholder when `note.image.available === false`.
  - `web/src/components/Gallery.tsx`: `export interface GalleryProps { photos: Note[]; copiedId: string | null; onCopy: (id: string) => void }` and `export function Gallery(p: GalleryProps)`. App renders it instead of the wall when `mode === 'images'`. `photos` = image notes passing the tag filter, in wall order. Gallery owns the modal state and renders `PhotoModal` itself. Because App unmounts Gallery on every mode change, changing mode closes the modal (the design's `modal: -1` on mode change).
  - `web/src/components/PhotoModal.tsx`: `export interface PhotoModalProps { photos: Note[]; index: number; onIndex: (i: number) => void; onClose: () => void; copiedId: string | null; onCopy: (id: string) => void }`. Only Gallery uses it, so phase 8 may change these props freely.
  - `web/src/components/DropOverlay.tsx`: `export interface DropOverlayProps { onImageAdded: (note: Note) => void }`. App renders `<DropOverlay onImageAdded={...}/>` once, always mounted. Phase 8 owns the document-level dragover/dragleave/drop/paste listeners, the upload to `POST /api/images`, and the overlay markup. **`onImageAdded(note)`** is the mode seam: App prepends or replaces the note locally, switches `text → all` (any other mode is left alone), and schedules a refetch.
- Exported helpers phase 8 may import: `thumbUrl`, `displayUrl`, `originalUrl` (`web/src/api.ts`), `useCopied`/`copyText` (`web/src/hooks/useCopied.ts`), `tagsOf`/`segmentBody` (`web/src/lib/text.ts`), `relativeDate` (`web/src/lib/dates.ts`), types `Note`, `NoteImageMeta`, `Mode` (`web/src/types.ts`), CSS tokens `--film`, `--img-bg`, `--hover`, `--fg`, `--bg`, `--dim`, `--id`, `--text`, `--chip-bg`, `--chip`, `--line`, `--mono`, `--sans` in `web/src/styles.css` `:root`.
- Keyboard seam: App's document `keydown` handler (bubble phase) ignores events with `defaultPrevented`. Phase 8's PhotoModal must register its Esc/arrow handler with `{ capture: true }` and call `preventDefault()` on the keys it handles, so Esc closes the modal before the chat panel (design order).
- Tooltip seam: any element with `data-tip` (and optional `data-tip-side="right"`) gets the custom tooltip. Phase 8 adds only attributes.

**Signature changes:** `package.json` `scripts` only:
- `build`: `npm run build:server && npm run build:web` (was `build:server` alone, from phase 1)
- `build:web`: `vite build --config web/vite.config.ts` (new)
- `dev:web`: `vite --config web/vite.config.ts` (new)
- `typecheck`: `<phase-1 value> && tsc -p tsconfig.web.json` (appended)

**Vite multi-page decision:** `web/vite.config.ts` declares `build.rolldownOptions.input` as an **object** with a single `index` key. Phase 8 adds exactly one line, `fullscreen: resolve(root, 'fullscreen.html'),`, to that object and creates `web/fullscreen.html`. No conditional predeclaration: a missing input file would fail the build.

**Requires (from earlier phases):**
- Phase 1: deps installed: `vite`, `@vitejs/plugin-react`, `react`, `react-dom`, `@types/react`, `@types/react-dom`, `@phosphor-icons/react`, `@fontsource-variable/host-grotesk`, `@fontsource/geist-mono`, `jsdom`, `@testing-library/react`, `@testing-library/dom`, `vitest`, `typescript`, `@types/node`. Phase 1's pins (they win, invariant 8): vite 8.3.5, @vitejs/plugin-react 6.1.2, react/react-dom 19.2.8, @phosphor-icons/react 2.1.10, fontsource 5.3.0, jsdom 30.1.3, @testing-library/react 16.3.3. Code below targets Vite 8 (`rolldownOptions`).
- Phase 1: `vitest.config.ts` includes `web/src/**/*.test.tsx`. Tests choose jsdom per file with `// @vitest-environment jsdom`. Phase 1's `tsconfig.json` / `tsconfig.server.json` do **not** include `web/` (see Assumptions).
- Phase 1: `scripts.build:server` and `scripts.typecheck` exist. `.gitignore` has `web/dist`.
- Phase 2: wire `Note` shape exactly as in the index.
- Phase 6 (exact shapes, reconciled): `GET /api/notes?limit=2000` returns `{ notes: Note[], next_cursor: string | null }`. `GET /api/tags` returns `TagCount[]`. `POST /api/notes {body}` (201) / `PATCH /api/notes/:id {body}` return a bare `Note`. `DELETE /api/notes/:id` returns 200 `Note` (a 404 is tolerated). `GET /api/events` sends `event: note` frames after a `: connected` comment. `POST /api/chat {message, thread_id?}` streams `event: delta` `{text}` … `event: done` `{thread_id}`, or ends with `event: error` `{error}`. `/` serves `web/dist/index.html` and `/assets/*` serves from `web/dist/assets`.
- Phase 5 (URL only): `GET /api/notes/:id/thumb`.

**Leaves alone (owned by others):** `src/**`, `drizzle/**`, `tests/**`, `package-lock.json`, every `package.json` key other than `scripts`, `vitest.config.ts`, `tsconfig.json`, `tsconfig.server.json` (phase 1); `web/fullscreen.html`, `web/src/fullscreen/**`, the real contents of `Gallery/PhotoModal/DropOverlay/NoteImage.tsx`, upload code, gallery/modal/overlay CSS (phase 8).

## Assumptions

1. Phase 1's root `tsconfig.json` (and `tsconfig.server.json`) have an `include` that does not cover `web/`. **If it covers `web/`** (for example no `include` at all), the implementer adds `"exclude": ["web", "node_modules", "dist"]` to that file. That one line is the only permitted touch, and it is flagged for the reconciler.
2. Vite and Vitest resolve JSX settings from the **nearest** `tsconfig.json`. That is why `web/tsconfig.json` (extending `../tsconfig.web.json`) exists: `.tsx` under `web/` then gets `jsx: react-jsx` (automatic runtime) in both `vite build` and `vitest`, whatever the root tsconfig says.
3. Node's global `Response`, `ReadableStream`, `TextEncoder`/`TextDecoder` exist under Vitest's jsdom environment (Node 22). The tests rely on it.
4. Phase 1's test-int container URL (from `scripts/test-int.sh`) is used for the manual serve check, so nothing touches Neon or `~/mcp-notes-data`.

## Files

| File | Action | What changes |
|---|---|---|
| `package.json` | modify (`scripts` block only) | `build`, `build:web`, `dev:web`, `typecheck` |
| `tsconfig.web.json` | create | DOM + react-jsx config over `web/src` |
| `web/tsconfig.json` | create | extends `../tsconfig.web.json` so Vite/Vitest pick react-jsx |
| `web/vite.config.ts` | create | root `web/`, outDir `web/dist`, base `/`, input object, dev proxy |
| `web/index.html` | create | SPA shell |
| `web/src/main.tsx` | create | fonts, styles, root render |
| `web/src/styles.css` | create | tokens + every design style, verbatim values |
| `web/src/types.ts` | create | `Note`, `NoteImageMeta`, `TagCount`, `Mode` |
| `web/src/api.ts` | create | fetch client + image URL helpers |
| `web/src/lib/text.ts` | create | tag regex, `tagsOf`, `segmentBody`, font size, letter-spacing, rows |
| `web/src/lib/filter.ts` | create | AND filter, mode helpers, heading, count line, last edited |
| `web/src/lib/usedIds.ts` | create | id extraction from answer text |
| `web/src/lib/dates.ts` | create | `relativeDate` |
| `web/src/lib/sse.ts` | create | incremental SSE parser + `readSSE` over a fetch body |
| `web/src/hooks/useNow.ts` | create | minute tick |
| `web/src/hooks/useCopied.ts` | create | clipboard + 1.4 s "copied" state |
| `web/src/hooks/useNotes.ts` | create | load, SSE, 60 s refetch, debounce, local upserts |
| `web/src/hooks/useChat.ts` | create | POST `/api/chat`, stream parse, pin, close, thread id |
| `web/src/App.tsx` | create | state, mode rules, wiring |
| `web/src/components/Rail.tsx` | create | icon rail, mode cycle, filter chips, clear |
| `web/src/components/Sidebar.tsx` | create | mode row, photo count, tag list |
| `web/src/components/Header.tsx` | create | count line, last edited, heading, sticker |
| `web/src/components/Wall.tsx` | create | masonry section |
| `web/src/components/NoteCard.tsx` | create | card, inline editor, tag chips, id/copy/date |
| `web/src/components/AnswerPanel.tsx` | create | query line, pin, dismiss, paragraphs, used chips |
| `web/src/components/ChatBar.tsx` | create | pill form |
| `web/src/components/Tooltip.tsx` | create | document `mouseover` on `[data-tip]` |
| `web/src/components/Gallery.tsx` | create (stub, P8 rewrites) | placeholder section |
| `web/src/components/PhotoModal.tsx` | create (stub, P8 rewrites) | returns null |
| `web/src/components/DropOverlay.tsx` | create (stub, P8 rewrites) | returns null |
| `web/src/components/NoteImage.tsx` | create (stub, P8 rewrites) | thumb `<img>` |
| `web/src/lib/text.test.tsx` | create | font size by length, tag segmenting, tagsOf |
| `web/src/lib/filter.test.tsx` | create | AND filter, modes, heading, count line |
| `web/src/lib/usedIds.test.tsx` | create | used-id extraction |
| `web/src/lib/dates.test.tsx` | create | relative date formatting |
| `web/src/lib/sse.test.tsx` | create | SSE parser + `readSSE` |
| `web/src/components/NoteCard.test.tsx` | create | rendered font size, chip click, blur commit |
| `web/src/App.test.tsx` | create | real-data render, mode cycle, tag filter, chat stream + dimming |

All files except `package.json` are new, so their line references are "whole file". The `package.json` change lands inside the `"scripts"` object that phase 1 wrote.

## Implementation Steps

### Step 0: Preconditions
**File:** n/a
**Change:** Confirm `grep -c modeOpts "docs/design/claude-design/Notes Wall.dc.html"` prints `2` (the 30a58fd design is present). Confirm `ls node_modules/@phosphor-icons/react node_modules/@fontsource-variable/host-grotesk node_modules/@fontsource/geist-mono node_modules/vite node_modules/jsdom node_modules/@testing-library/react` succeeds. Read phase 1's `tsconfig.json` `include` (Assumption 1) and the current `scripts.typecheck` value.
**Impact:** none.

### Step 1: `package.json` scripts
**File:** `package.json`, the `"scripts"` object (phase 1)
**Change:** Set or replace these four keys. Leave every other key as is. `<P1_TYPECHECK>` is the exact existing `typecheck` string.
**Code:**
```json
"build": "npm run build:server && npm run build:web",
"build:web": "vite build --config web/vite.config.ts",
"dev:web": "vite --config web/vite.config.ts",
"typecheck": "<P1_TYPECHECK> && tsc -p tsconfig.web.json"
```
**Impact:** `npm run build` now also needs the web app to compile. `npm run typecheck` covers `web/src`.

### Step 2: `tsconfig.web.json` and `web/tsconfig.json`
**File:** `tsconfig.web.json` (new)
**Code:**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "useDefineForClassFields": true,
    "noUnusedLocals": true,
    "noFallthroughCasesInSwitch": true,
    "types": ["vite/client"]
  },
  "include": ["web/src"]
}
```
**File:** `web/tsconfig.json` (new)
**Code:**
```json
{
  "extends": "../tsconfig.web.json",
  "include": ["src"]
}
```
**Impact:** `web/vite.config.ts` is outside both includes on purpose (it is Node code). Vite loads it with its own transpile.

### Step 3: Vite config
**File:** `web/vite.config.ts` (new)
**Code:**
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const target = `http://127.0.0.1:${process.env.NOTESD_PORT || 7317}`;

export default defineConfig({
  root,
  base: '/',
  plugins: [react()],
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    assetsDir: 'assets',
    rolldownOptions: {
      // Phase 8 adds:  fullscreen: resolve(root, 'fullscreen.html'),
      input: {
        index: resolve(root, 'index.html'),
      },
    },
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': { target },
      '/mcp': { target },
      '/health': { target },
    },
  },
});
```
**Impact:** `vite build --config web/vite.config.ts` from the repo root writes `web/dist/index.html` + `web/dist/assets/*` (JS, CSS, woff2).

### Step 4: HTML shell
**File:** `web/index.html` (new)
**Code:**
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <link rel="icon" href="data:," />
    <title>Notes</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

### Step 5: Entry
**File:** `web/src/main.tsx` (new)
**Code:**
```tsx
import '@fontsource-variable/host-grotesk';
import '@fontsource/geist-mono/400.css';
import '@fontsource/geist-mono/500.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const el = document.getElementById('root');
if (!el) throw new Error('#root missing');
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```
**Impact:** fonts are bundled. The family names are `'Host Grotesk Variable'` and `'Geist Mono'` (checked in the 5.3.0 packages).

### Step 6: Stylesheet (tokens + verbatim design values)
**File:** `web/src/styles.css` (new)
**Code:**
```css
:root {
  --bg: #121211;
  --fg: #ecebe4;
  --text: #e4e3dc;
  --muted: #c9c8c0;
  --dim: #8a897f;
  --id: #bdbcb4;
  --chip: #d6d5cd;
  --placeholder: #7a7972;
  --hover: #222220;
  --chip-bg: #2a2a27;
  --card: #1a1a18;
  --img-bg: #1c1c1a;
  --panel: #191918;
  --line: rgba(236, 235, 228, .1);
  --line-12: rgba(236, 235, 228, .12);
  --line-14: rgba(236, 235, 228, .14);
  --line-25: rgba(236, 235, 228, .25);
  --ring: rgba(236, 235, 228, .85);
  --sans: 'Host Grotesk Variable', 'Host Grotesk', sans-serif;
  --mono: 'Geist Mono', monospace;
  --film: sepia(.14) saturate(1.12) contrast(1.05) brightness(.97);
  --col-w: 240px;
}

html, body { margin: 0; background: var(--bg); color: var(--fg); }
body::after {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 999;
  opacity: .07;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>");
}
a { color: var(--fg); text-decoration: underline; text-underline-offset: 2px; text-decoration-thickness: 1px; }
a:hover { color: #fff; }
input::placeholder { color: var(--placeholder); }
textarea:focus, input:focus, button:focus { outline: none; }
::selection { background: var(--fg); color: var(--bg); }

.app { min-height: 100vh; background: var(--bg); color: var(--fg); font-family: var(--sans); -webkit-font-smoothing: antialiased; }

/* icon buttons (40px round) */
.ibtn { width: 40px; height: 40px; border: 0; border-radius: 999px; background: transparent; color: var(--fg); font-size: 21px; cursor: pointer; display: grid; place-items: center; }
.ibtn.hov:hover { background: var(--hover); }
.ibtn.on { background: var(--fg); color: var(--bg); }

/* rail */
.rail { position: fixed; left: 0; top: 0; bottom: 0; width: 56px; border-right: 1px solid var(--line); display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 14px 0; z-index: 30; background: var(--bg); box-sizing: border-box; }
.rail-sep { width: 24px; height: 1px; background: var(--line-12); margin: 8px 0; }
.rail-chip { writing-mode: vertical-rl; transform: rotate(180deg); border: 0; border-radius: 999px; background: var(--fg); color: var(--bg); font-family: var(--mono); font-size: 11px; padding: 10px 4px; cursor: pointer; letter-spacing: .02em; }
.rail .clear { font-size: 19px; }

/* sidebar */
.side { position: fixed; left: 56px; top: 0; bottom: 0; width: 240px; border-right: 1px solid var(--line); background: var(--bg); z-index: 29; padding: 14px 12px 100px; box-sizing: border-box; overflow: auto; display: flex; flex-direction: column; gap: 18px; }
.side-modes { display: flex; align-items: center; gap: 4px; height: 40px; }
.side-modes .ibtn { font-size: 20px; }
.side-count { margin-left: auto; font-family: var(--mono); font-size: 11px; color: var(--dim); }
.side-sep { height: 1px; background: var(--line); }
.side-tags { display: flex; flex-direction: column; gap: 2px; }
.tagrow { display: flex; justify-content: space-between; align-items: baseline; padding: 7px 10px; border-radius: 999px; cursor: pointer; background: transparent; color: var(--chip); font-size: 13px; }
.tagrow.on { background: var(--fg); color: var(--bg); }
.tagrow:not(.on):hover { background: var(--hover); }
.tagrow .n { font-family: var(--mono); font-size: 11px; opacity: .7; }

/* main + header */
.main { padding: 0 20px 150px; transition: margin-left .2s; }
.hdr { position: relative; padding-top: 72px; display: grid; grid-template-columns: minmax(0, 220px) minmax(0, 1fr); align-items: end; gap: 24px; }
.hdr-p { margin: 0 0 18px; font-size: 12px; line-height: 1.5; color: var(--muted); max-width: 220px; text-wrap: pretty; }
.hdr h1 { margin: 0; font-weight: 400; font-size: clamp(72px, 13vw, 230px); line-height: .84; letter-spacing: -.06em; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-bottom: .24em; margin-bottom: -.24em; }
.sticker { position: absolute; left: 30%; bottom: -58px; width: 108px; height: 108px; border-radius: 999px; border: 0; background: var(--fg); color: var(--bg); font-size: 46px; cursor: pointer; transform: rotate(-14deg); display: grid; place-items: center; z-index: 5; }
.sticker:hover { transform: rotate(-4deg) scale(1.04); }
.rule { height: 1px; background: var(--line-12); margin-top: 26px; }

/* wall */
.wall { columns: var(--col-w); column-gap: 10px; padding-top: 30px; }
.card { break-inside: avoid; margin: 0 0 10px; background: var(--card); opacity: 1; outline: 1px solid transparent; outline-offset: 3px; transition: opacity .35s, outline-color .35s; }
.card.img { background: transparent; }
.card.dim { opacity: .22; }
.card.used { outline-color: var(--ring); }
.card-img { display: block; width: 100%; height: auto; filter: var(--film); background: var(--img-bg); }
.card-body { padding: 13px 14px 10px; }
.card.img .card-body { padding: 9px 2px 4px; }
.card-text { margin: 0 0 10px; line-height: 1.32; white-space: pre-wrap; text-wrap: pretty; cursor: text; color: var(--text); }
.card-edit { display: block; width: 100%; box-sizing: border-box; background: transparent; color: var(--fg); border: 0; resize: none; font: inherit; line-height: 1.32; padding: 0; margin: 0 0 10px; }
.tagchip { display: inline-block; font-size: 11px; line-height: 1; padding: 3px 7px 4px; border-radius: 999px; background: var(--chip-bg); color: var(--chip); cursor: pointer; vertical-align: .15em; letter-spacing: 0; }
.tagchip:hover { background: var(--fg); color: var(--bg); }
.card-meta { display: flex; align-items: center; gap: 4px; font-family: var(--mono); font-size: 10.5px; color: var(--dim); }
.card-id { color: var(--id); letter-spacing: .03em; }
.copybtn { border: 0; background: transparent; color: var(--id); font-size: 13px; padding: 3px; border-radius: 999px; cursor: pointer; display: grid; place-items: center; }
.copybtn:hover { background: var(--chip-bg); color: var(--fg); }
.copied { opacity: 0; transition: opacity .25s; }
.copied.on { opacity: 1; }
.card-date { margin-left: auto; }

/* answer panel */
.answer { position: fixed; bottom: 86px; max-height: 52vh; overflow: auto; background: var(--panel); border: 1px solid var(--line-14); z-index: 40; padding: 16px 20px 20px; box-sizing: border-box; }
.answer-head { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; }
.answer-q { font-family: var(--mono); font-size: 10.5px; color: var(--dim); }
.spacer { flex: 1; }
.pbtn { width: 32px; height: 32px; border: 0; border-radius: 999px; background: transparent; color: var(--fg); font-size: 16px; cursor: pointer; display: grid; place-items: center; }
.pbtn.on { background: var(--fg); color: var(--bg); }
.pbtn.hov:hover { background: var(--chip-bg); }
.answer-body { display: flex; flex-direction: column; gap: 10px; font-size: 15px; line-height: 1.5; color: var(--text); text-wrap: pretty; }
.answer-body p { margin: 0; }
.used-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--line); }
.usedchip { border: 1px solid var(--line-25); background: transparent; color: var(--fg); font-family: var(--mono); font-size: 10.5px; padding: 4px 8px; border-radius: 999px; cursor: pointer; }
.usedchip:hover { background: var(--fg); color: var(--bg); }

/* chat bar */
.chatbar { position: fixed; right: 16px; bottom: 16px; height: 54px; border-radius: 999px; background: var(--fg); display: flex; align-items: center; padding: 0 7px 0 24px; z-index: 41; box-sizing: border-box; }
.chatbar input { flex: 1; border: 0; background: transparent; color: var(--bg); font: inherit; font-size: 14px; height: 100%; }
.sendbtn { width: 40px; height: 40px; border-radius: 999px; border: 0; background: var(--bg); color: var(--fg); font-size: 18px; cursor: pointer; display: grid; place-items: center; }

/* tooltip */
.tip { position: fixed; background: var(--fg); color: var(--bg); font-size: 11px; padding: 4px 8px 5px; border-radius: 3px; pointer-events: none; z-index: 200; white-space: nowrap; }
```
**Impact:** Phase 8 puts gallery/modal/overlay CSS in its own file(s) imported from its components (for example `web/src/images.css`) and reuses these tokens. It does not need to edit this file.

### Step 7: Types
**File:** `web/src/types.ts` (new)
**Code:**
```ts
export interface NoteImageMeta {
  mime: string;
  width: number;
  height: number;
  bytes: number;
  taken_at: string | null;
  original_name: string | null;
  host: string | null;
  available: boolean;
}

export interface Note {
  id: string;
  body: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  origin: Record<string, unknown> | null;
  image: NoteImageMeta | null;
}

export interface TagCount {
  tag: string;
  count: number;
  last_used: string | null;
}

export type Mode = 'text' | 'images' | 'all';
```

### Step 8: API client
**File:** `web/src/api.ts` (new)
**Code:**
```ts
import type { Note, TagCount } from './types';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function check(res: Response): Promise<Response> {
  if (res.ok) return res;
  let msg = `${res.status} ${res.statusText}`.trim();
  try {
    const j: unknown = await res.json();
    if (j && typeof j === 'object' && typeof (j as { error?: unknown }).error === 'string') {
      msg = (j as { error: string }).error;
    }
  } catch {
    // body was not JSON; keep the status line
  }
  throw new ApiError(res.status, msg);
}

const enc = encodeURIComponent;
const JSON_HEADERS = { 'content-type': 'application/json' };

/** Phase 6: `GET /api/notes` → `{ notes, next_cursor }`. One page of 2000 covers this owner's notes. */
export async function fetchNotes(): Promise<Note[]> {
  const res = await check(await fetch('/api/notes?limit=2000'));
  const j = (await res.json()) as { notes: Note[]; next_cursor: string | null };
  return j.notes;
}

/** Phase 6: `GET /api/tags` → `[{ tag, count, last_used }]`. */
export async function fetchTags(): Promise<TagCount[]> {
  const res = await check(await fetch('/api/tags'));
  return (await res.json()) as TagCount[];
}

export async function createNote(body: string): Promise<Note> {
  const res = await check(await fetch('/api/notes', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ body }) }));
  return (await res.json()) as Note;
}

export async function updateNote(id: string, body: string): Promise<Note> {
  const res = await check(await fetch(`/api/notes/${enc(id)}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ body }) }));
  return (await res.json()) as Note;
}

export async function deleteNote(id: string): Promise<void> {
  const res = await fetch(`/api/notes/${enc(id)}`, { method: 'DELETE' });
  if (res.status === 404) return;
  await check(res);
}

export function postChat(message: string, threadId: string | undefined, signal: AbortSignal): Promise<Response> {
  const payload: { message: string; thread_id?: string } = { message };
  if (threadId) payload.thread_id = threadId;
  return fetch('/api/chat', {
    method: 'POST',
    headers: { ...JSON_HEADERS, accept: 'text/event-stream' },
    body: JSON.stringify(payload),
    signal,
  });
}

export const thumbUrl = (id: string): string => `/api/notes/${enc(id)}/thumb`;
export const displayUrl = (id: string): string => `/api/notes/${enc(id)}/display`;
export const originalUrl = (id: string): string => `/api/notes/${enc(id)}/original`;
```

### Step 9: Text helpers
**File:** `web/src/lib/text.ts` (new)
**Code:**
```ts
// Same rule as the server (src/notes/tags.ts): '#' + [A-Za-z0-9_-]+, not preceded by a word char.
const TAG_SRC = '(?<!\\w)#[A-Za-z0-9_-]+';

export function tagsOf(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(new RegExp(TAG_SRC, 'g'))) {
    const t = m[0].slice(1).toLowerCase();
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'tag'; text: string; tag: string };

/** Splits a body into plain text and tag chips. Odd indices of the split are the captured tags. */
export function segmentBody(body: string): Segment[] {
  const parts = body.split(new RegExp(`(${TAG_SRC})`, 'g'));
  const out: Segment[] = [];
  parts.forEach((p, i) => {
    if (i % 2 === 1) out.push({ kind: 'tag', text: p, tag: p.slice(1).toLowerCase() });
    else if (p !== '') out.push({ kind: 'text', text: p });
  });
  return out;
}

/** Design: image cards 13; text < 36 chars 26; < 80 chars 17; else 13.5. */
export function fontSizeFor(body: string, hasImage: boolean): number {
  if (hasImage) return 13;
  const len = body.length;
  if (len < 36) return 26;
  if (len < 80) return 17;
  return 13.5;
}

export function letterSpacingFor(fs: number): string {
  return fs > 20 ? '-0.03em' : '-0.005em';
}

export function rowsFor(len: number): number {
  return Math.max(3, Math.ceil(len / 28));
}
```

### Step 10: Filter and header helpers
**File:** `web/src/lib/filter.ts` (new)
**Code:**
```ts
import type { Mode, Note } from '../types';
import { tagsOf } from './text';

export const MODE_TIP: Record<Mode, string> = {
  text: 'Text notes only',
  images: 'Image notes only',
  all: 'All notes',
};
export const MODE_ORDER: Mode[] = ['text', 'images', 'all'];

export function nextMode(m: Mode): Mode {
  return m === 'text' ? 'images' : m === 'images' ? 'all' : 'text';
}

/** AND semantics: a note matches when it carries every active tag. */
export function matchesTags(note: Note, active: string[]): boolean {
  if (active.length === 0) return true;
  const t = tagsOf(note.body);
  return active.every((a) => t.includes(a));
}

/** Notes shown on the wall. `keepId` (the note being edited) is always kept. */
export function visibleOnWall(notes: Note[], mode: Mode, active: string[], keepId: string | null = null): Note[] {
  return notes.filter((n) => n.id === keepId || ((mode !== 'text' || !n.image) && matchesTags(n, active)));
}

export function photosOf(notes: Note[], active: string[]): Note[] {
  return notes.filter((n) => n.image && matchesTags(n, active));
}

export function headingFor(mode: Mode, active: string[]): string {
  if (mode === 'images') return 'Photos.';
  if (active.length) return active.map((t) => '#' + t).join(' ');
  return mode === 'text' ? 'Notes.' : 'Everything.';
}

export function countLineFor(mode: Mode, active: string[], all: Note[], visible: Note[], photos: Note[]): string {
  if (mode === 'images') return `${photos.length} photos.`;
  if (active.length) return `${visible.length} of ${all.length} notes.`;
  if (mode === 'text') return `${visible.length} notes, ${all.length - visible.length} photo notes hidden.`;
  return `${all.length} notes, ${all.filter((n) => n.image).length} with photos.`;
}

export function lastEdited(notes: Note[]): Note | null {
  let best: Note | null = null;
  let bestT = -Infinity;
  for (const n of notes) {
    const t = Date.parse(n.updated_at);
    if (!Number.isNaN(t) && t > bestT) {
      best = n;
      bestT = t;
    }
  }
  return best;
}

export function isHiddenByMode(note: Note | undefined, mode: Mode): boolean {
  return mode === 'images' || (mode === 'text' && !!note?.image);
}
```

### Step 11: Used-id extraction
**File:** `web/src/lib/usedIds.ts` (new)
**Code:**
```ts
// Note id: [0-9A-Z]-[0-9A-Z]{3}, matched case-insensitively and not inside a longer token.
const ID_RE = /(?<![0-9A-Za-z-])([0-9A-Za-z])-([0-9A-Za-z]{3})(?![0-9A-Za-z-])/g;

/** Ids of loaded notes mentioned in `text`, in order of first mention, returned in the notes' own casing. */
export function extractUsedIds(text: string, known: Iterable<string>): string[] {
  const byUpper = new Map<string, string>();
  for (const k of known) byUpper.set(k.toUpperCase(), k);
  const out: string[] = [];
  for (const m of text.matchAll(ID_RE)) {
    const id = byUpper.get(`${m[1]}-${m[2]}`.toUpperCase());
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}
```

### Step 12: Relative dates
**File:** `web/src/lib/dates.ts` (new)
**Code:**
```ts
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * just now (< 1 min, or a small future skew) / N min ago (< 60 min) / Today / Yesterday /
 * "Oct 28" (this year) / "Oct 28, 2025" (other years). `lower` lower-cases Today/Yesterday
 * for use mid-sentence ("Last edited A-B32 today.").
 */
export function relativeDate(iso: string, now: Date, lower = false): string {
  const d = new Date(iso);
  const t = d.getTime();
  if (Number.isNaN(t)) return '';
  const diff = now.getTime() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (t >= startToday.getTime()) return lower ? 'today' : 'Today';
  const startYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (t >= startYesterday.getTime()) return lower ? 'yesterday' : 'Yesterday';
  const md = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? md : `${md}, ${d.getFullYear()}`;
}
```

### Step 13: SSE parser
**File:** `web/src/lib/sse.ts` (new)
**Code:**
```ts
export interface SSEEvent {
  event: string;
  data: string;
  id?: string;
}

/** Incremental text/event-stream parser (WHATWG rules: comments, multi-line data, CR/LF/CRLF). */
export function createSSEParser(onEvent: (e: SSEEvent) => void): { push(chunk: string): void; end(): void } {
  let buf = '';
  let event = '';
  let data: string[] = [];
  let lastId: string | undefined;

  const dispatch = () => {
    if (data.length > 0) onEvent({ event: event || 'message', data: data.join('\n'), id: lastId });
    event = '';
    data = [];
  };

  const line = (l: string) => {
    if (l === '') {
      dispatch();
      return;
    }
    if (l.startsWith(':')) return;
    const i = l.indexOf(':');
    const field = i < 0 ? l : l.slice(0, i);
    let value = i < 0 ? '' : l.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') lastId = value;
  };

  return {
    push(chunk: string) {
      buf += chunk;
      for (;;) {
        const idx = buf.search(/\r\n|\r|\n/);
        if (idx < 0) break;
        // A trailing lone CR may be the first half of a CRLF split across chunks.
        if (buf[idx] === '\r' && idx === buf.length - 1) break;
        const sepLen = buf.startsWith('\r\n', idx) ? 2 : 1;
        const l = buf.slice(0, idx);
        buf = buf.slice(idx + sepLen);
        line(l);
      }
    },
    end() {
      if (buf.endsWith('\r')) buf = buf.slice(0, -1);
      if (buf !== '') line(buf);
      buf = '';
      dispatch();
    },
  };
}

/** Reads a fetch body as SSE until it ends. Rejects if the stream errors or is aborted. */
export async function readSSE(body: ReadableStream<Uint8Array>, onEvent: (e: SSEEvent) => void): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  const p = createSSEParser(onEvent);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      p.push(dec.decode(value, { stream: true }));
    }
    p.push(dec.decode());
    p.end();
  } finally {
    reader.releaseLock();
  }
}
```

### Step 14: Small hooks
**File:** `web/src/hooks/useNow.ts` (new)
**Code:**
```ts
import { useEffect, useState } from 'react';

/** Current time, re-rendered every `intervalMs` (relative dates refresh each minute). */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}
```
**File:** `web/src/hooks/useCopied.ts` (new)
**Code:**
```ts
import { useCallback, useEffect, useRef, useState } from 'react';

export function copyText(text: string): void {
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } finally {
      ta.remove();
    }
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(fallback);
  else fallback();
}

/** The id last copied, cleared after `ms` (design: 1.4 s "copied" fade). */
export function useCopied(ms = 1400): { copied: string | null; copy: (id: string) => void } {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const copy = useCallback(
    (id: string) => {
      copyText(id);
      setCopied(id);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(null), ms);
    },
    [ms],
  );
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { copied, copy };
}
```

### Step 15: Notes store (load, SSE, 60 s refetch, debounce)
**File:** `web/src/hooks/useNotes.ts` (new)
**Code:**
```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchNotes, fetchTags } from '../api';
import type { Note, TagCount } from '../types';

export interface NotesStore {
  notes: Note[];
  tags: TagCount[];
  loaded: boolean;
  error: string | null;
  /** Debounced (250 ms) refetch of notes + tags. */
  refetch: () => void;
  /** Replace a note in place, or insert it (at the top when `atTop`). */
  upsertLocal: (note: Note, atTop?: boolean) => void;
  removeLocal: (id: string) => void;
}

interface State {
  notes: Note[];
  tags: TagCount[];
  loaded: boolean;
  error: string | null;
}

const DEBOUNCE_MS = 250;
const POLL_MS = 60_000;

export function useNotes(): NotesStore {
  const [state, setState] = useState<State>({ notes: [], tags: [], loaded: false, error: null });
  // Bumped on every local mutation; a fetch that started before a mutation is discarded and retried.
  const gen = useRef(0);
  const refetchRef = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    let inFlight = false;
    let again = false;
    let timer: number | undefined;

    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), DEBOUNCE_MS);
    };

    const load = async (): Promise<void> => {
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      const g = gen.current;
      try {
        const [notes, tags] = await Promise.all([fetchNotes(), fetchTags()]);
        if (!alive) return;
        if (gen.current === g) setState({ notes, tags, loaded: true, error: null });
        else again = true;
      } catch (e) {
        if (alive) setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }));
      } finally {
        inFlight = false;
        if (alive && again) {
          again = false;
          schedule();
        }
      }
    };

    refetchRef.current = schedule;
    void load();
    const poll = window.setInterval(() => void load(), POLL_MS);

    let es: EventSource | null = null;
    if (typeof EventSource !== 'undefined') {
      es = new EventSource('/api/events');
      es.addEventListener('note', schedule);
      // After a daemon restart the browser reconnects; refetch what was missed.
      es.addEventListener('open', schedule);
    }

    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.clearInterval(poll);
      es?.close();
      refetchRef.current = () => {};
    };
  }, []);

  const refetch = useCallback(() => refetchRef.current(), []);

  const upsertLocal = useCallback((note: Note, atTop = false) => {
    gen.current += 1;
    setState((s) => {
      const i = s.notes.findIndex((n) => n.id === note.id);
      if (i >= 0) {
        const notes = s.notes.slice();
        notes[i] = note;
        return { ...s, notes };
      }
      return { ...s, notes: atTop ? [note, ...s.notes] : [...s.notes, note] };
    });
  }, []);

  const removeLocal = useCallback((id: string) => {
    gen.current += 1;
    setState((s) => ({ ...s, notes: s.notes.filter((n) => n.id !== id) }));
  }, []);

  return { ...state, refetch, upsertLocal, removeLocal };
}
```

### Step 16: Chat hook (POST + SSE over fetch)
**File:** `web/src/hooks/useChat.ts` (new)
**Code:**
```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { postChat } from '../api';
import { readSSE } from '../lib/sse';

export interface ChatState {
  open: boolean;
  pinned: boolean;
  query: string;
  text: string;
  done: boolean;
}

export interface Chat extends ChatState {
  ask: (message: string) => Promise<void>;
  close: () => void;
  togglePin: () => void;
}

function parse(data: string): Record<string, unknown> {
  try {
    const j: unknown = JSON.parse(data);
    return j && typeof j === 'object' ? (j as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function useChat(): Chat {
  const [st, setSt] = useState<ChatState>({ open: false, pinned: false, query: '', text: '', done: false });
  const threadId = useRef<string | undefined>(undefined);
  const ctrl = useRef<AbortController | null>(null);

  const ask = useCallback(async (message: string) => {
    const q = message.trim();
    if (!q) return;
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setSt((s) => ({ ...s, open: true, query: q, text: '', done: false }));

    const finish = (extra?: string) => {
      if (ctrl.current !== c) return;
      setSt((s) => ({ ...s, done: true, text: extra ? (s.text ? `${s.text}\n\n${extra}` : extra) : s.text }));
    };

    try {
      const res = await postChat(q, threadId.current, c.signal);
      if (!res.ok || !res.body) {
        finish(`Chat failed: ${res.status} ${res.statusText}`.trim());
        return;
      }
      let ended = false;
      await readSSE(res.body, (ev) => {
        if (ctrl.current !== c) return;
        if (ev.event === 'delta') {
          const t = parse(ev.data).text;
          if (typeof t === 'string' && t) setSt((s) => ({ ...s, text: s.text + t }));
        } else if (ev.event === 'done') {
          const id = parse(ev.data).thread_id;
          if (typeof id === 'string' && id) threadId.current = id;
          ended = true;
          finish();
        } else if (ev.event === 'error') {
          const d = parse(ev.data);
          const m = typeof d.message === 'string' ? d.message : typeof d.error === 'string' ? d.error : ev.data;
          ended = true;
          finish(`Chat failed: ${m}`);
        }
      });
      if (!ended) finish();
    } catch (e) {
      if (c.signal.aborted) return;
      finish(`Chat failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const close = useCallback(() => {
    ctrl.current?.abort();
    ctrl.current = null;
    setSt((s) => ({ ...s, open: false, pinned: false, text: '', done: false }));
  }, []);

  const togglePin = useCallback(() => setSt((s) => ({ ...s, pinned: !s.pinned })), []);

  useEffect(() => () => ctrl.current?.abort(), []);

  return { ...st, ask, close, togglePin };
}
```
**Impact:** the thread id survives across asks in one page load (iteration 4 resumes threads).

### Step 17: Tooltip
**File:** `web/src/components/Tooltip.tsx` (new)
**Code:**
```tsx
import { useEffect, useState } from 'react';

interface Tip {
  text: string;
  x: number;
  y: number;
  right: boolean;
}

/** Design: one document-level mouseover; `[data-tip]` above the element, or right of it with data-tip-side="right". */
export function Tooltip() {
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    const onOver = (e: MouseEvent) => {
      const target = e.target;
      const el = target instanceof Element ? target.closest<HTMLElement>('[data-tip]') : null;
      if (!el) {
        setTip((t) => (t ? null : t));
        return;
      }
      const r = el.getBoundingClientRect();
      const right = el.dataset.tipSide === 'right';
      setTip({
        text: el.dataset.tip ?? '',
        x: right ? r.right + 8 : r.left + r.width / 2,
        y: right ? r.top + r.height / 2 : r.top - 6,
        right,
      });
    };
    document.addEventListener('mouseover', onOver);
    return () => document.removeEventListener('mouseover', onOver);
  }, []);

  if (!tip || !tip.text) return null;
  return (
    <div
      className="tip"
      style={{ left: tip.x, top: tip.y, transform: tip.right ? 'translateY(-50%)' : 'translate(-50%,-100%)' }}
    >
      {tip.text}
    </div>
  );
}
```

### Step 18: Rail
**File:** `web/src/components/Rail.tsx` (new)
**Code:**
```tsx
import { Images, NotePencil, SidebarSimple, SquaresFour, TextAa, XCircle } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import type { Mode } from '../types';
import { MODE_TIP } from '../lib/filter';

export const MODE_ICON: Record<Mode, Icon> = { text: TextAa, images: Images, all: SquaresFour };

export interface RailProps {
  mode: Mode;
  active: string[];
  onToggleSide: () => void;
  onAdd: () => void;
  onCycleMode: () => void;
  onToggleTag: (tag: string) => void;
  onClear: () => void;
}

export function Rail({ mode, active, onToggleSide, onAdd, onCycleMode, onToggleTag, onClear }: RailProps) {
  const ModeIcon = MODE_ICON[mode];
  return (
    <nav className="rail">
      <button type="button" className="ibtn hov" data-tip="Toggle sidebar" data-tip-side="right" aria-label="Toggle sidebar" onClick={onToggleSide}>
        <SidebarSimple weight="duotone" />
      </button>
      <button type="button" className="ibtn hov" data-tip="New note" data-tip-side="right" aria-label="New note" onClick={onAdd}>
        <NotePencil weight="duotone" />
      </button>
      <button
        type="button"
        className={mode === 'text' ? 'ibtn' : 'ibtn on'}
        data-tip={`${MODE_TIP[mode]} (click to switch)`}
        data-tip-side="right"
        aria-label={`${MODE_TIP[mode]} (click to switch)`}
        onClick={onCycleMode}
      >
        <ModeIcon weight="duotone" />
      </button>
      <div className="rail-sep" />
      {active.map((t) => (
        <button key={t} type="button" className="rail-chip" data-tip="Remove filter" data-tip-side="right" onClick={() => onToggleTag(t)}>
          #{t}
        </button>
      ))}
      {active.length > 0 && (
        <button type="button" className="ibtn hov clear" data-tip="Clear filters" data-tip-side="right" aria-label="Clear filters" onClick={onClear}>
          <XCircle weight="duotone" />
        </button>
      )}
    </nav>
  );
}
```
**Impact:** the rail chips carry the tag text. That is content, not a button label, so invariant 12 holds.

### Step 19: Sidebar
**File:** `web/src/components/Sidebar.tsx` (new)
**Code:**
```tsx
import type { Mode, TagCount } from '../types';
import { MODE_ORDER, MODE_TIP } from '../lib/filter';
import { MODE_ICON } from './Rail';

export interface SidebarProps {
  mode: Mode;
  photoCount: number;
  tags: TagCount[];
  active: string[];
  onMode: (m: Mode) => void;
  onToggleTag: (tag: string) => void;
}

export function Sidebar({ mode, photoCount, tags, active, onMode, onToggleTag }: SidebarProps) {
  const sorted = tags.slice().sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  return (
    <aside className="side">
      <div className="side-modes">
        {MODE_ORDER.map((m) => {
          const I = MODE_ICON[m];
          return (
            <button key={m} type="button" className={m === mode ? 'ibtn on' : 'ibtn'} data-tip={MODE_TIP[m]} aria-label={MODE_TIP[m]} onClick={() => onMode(m)}>
              <I weight="duotone" />
            </button>
          );
        })}
        <span className="side-count">{photoCount} photos</span>
      </div>
      <div className="side-sep" />
      <div className="side-tags">
        {sorted.map((t) => (
          <div key={t.tag} className={active.includes(t.tag) ? 'tagrow on' : 'tagrow'} onClick={() => onToggleTag(t.tag)}>
            <span>#{t.tag}</span>
            <span className="n">{t.count}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}
```

### Step 20: Header
**File:** `web/src/components/Header.tsx` (new)
**Code:**
```tsx
import { Plus } from '@phosphor-icons/react';
import type { Note } from '../types';

export interface HeaderProps {
  heading: string;
  countLine: string;
  last: Note | null;
  lastWhen: string;
  showSticker: boolean;
  onJumpLast: () => void;
  onAdd: () => void;
}

export function Header({ heading, countLine, last, lastWhen, showSticker, onJumpLast, onAdd }: HeaderProps) {
  return (
    <header className="hdr">
      <p className="hdr-p">
        {countLine}
        {last && (
          <>
            {' '}Last edited{' '}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                onJumpLast();
              }}
            >
              {last.id}
            </a>{' '}
            {lastWhen}.
          </>
        )}{' '}
        Drop or paste an image anywhere to make a photo note.
      </p>
      <h1>{heading}</h1>
      {showSticker && (
        <button type="button" className="sticker" data-tip="New note" aria-label="New note" onClick={onAdd}>
          <Plus weight="duotone" />
        </button>
      )}
    </header>
  );
}
```

### Step 21: Note card with inline editor
**File:** `web/src/components/NoteCard.tsx` (new)
**Code:**
```tsx
import { memo, useEffect, useRef, useState } from 'react';
import { Check, Copy } from '@phosphor-icons/react';
import type { Note } from '../types';
import { fontSizeFor, letterSpacingFor, rowsFor, segmentBody } from '../lib/text';
import { relativeDate } from '../lib/dates';
import { NoteImage } from './NoteImage';

export interface NoteCardProps {
  note: Note;
  now: Date;
  editing: boolean;
  /** Chat highlight active and this note not used: opacity .22. */
  dim: boolean;
  /** Chat highlight active and this note used: outline ring. */
  used: boolean;
  copied: boolean;
  onCopy: (id: string) => void;
  onEdit: (id: string) => void;
  onCommit: (note: Note, draft: string) => void;
  onToggleTag: (tag: string) => void;
}

function CardEditor({ note, onCommit }: { note: Note; onCommit: (note: Note, draft: string) => void }) {
  const [draft, setDraft] = useState(note.body);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, []);
  return (
    <textarea
      ref={ref}
      className="card-edit"
      value={draft}
      rows={rowsFor(draft.length)}
      style={{ fontSize: fontSizeFor(draft, !!note.image) }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(note, draft)}
    />
  );
}

function NoteCardImpl({ note, now, editing, dim, used, copied, onCopy, onEdit, onCommit, onToggleTag }: NoteCardProps) {
  const hasImg = !!note.image;
  const fs = fontSizeFor(note.body, hasImg);
  const cls = ['card', hasImg ? 'img' : '', dim ? 'dim' : '', used ? 'used' : ''].filter(Boolean).join(' ');
  return (
    <article className={cls} data-note={note.id}>
      {hasImg && <NoteImage note={note} />}
      <div className="card-body">
        {editing ? (
          <CardEditor note={note} onCommit={onCommit} />
        ) : (
          <p className="card-text" style={{ fontSize: fs, letterSpacing: letterSpacingFor(fs) }} onClick={() => onEdit(note.id)}>
            {segmentBody(note.body).map((s, i) =>
              s.kind === 'tag' ? (
                <span
                  key={i}
                  className="tagchip"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleTag(s.tag);
                  }}
                >
                  {s.text}
                </span>
              ) : (
                <span key={i}>{s.text}</span>
              ),
            )}
          </p>
        )}
        <div className="card-meta">
          <span className="card-id">{note.id}</span>
          <button
            type="button"
            className="copybtn"
            data-tip="Copy ID"
            aria-label="Copy ID"
            onClick={(e) => {
              e.stopPropagation();
              onCopy(note.id);
            }}
          >
            {copied ? <Check weight="duotone" /> : <Copy weight="duotone" />}
          </button>
          <span className={copied ? 'copied on' : 'copied'}>copied</span>
          <span className="card-date">{relativeDate(note.created_at, now)}</span>
        </div>
      </div>
    </article>
  );
}

export const NoteCard = memo(NoteCardImpl);
```
**Impact:** the font size follows the draft's length while typing, as in the design (`n.fs` is computed from the live text).

### Step 22: Wall
**File:** `web/src/components/Wall.tsx` (new)
**Code:**
```tsx
import type { Note } from '../types';
import { NoteCard } from './NoteCard';

export interface WallProps {
  notes: Note[];
  now: Date;
  editingId: string | null;
  /** null = no chat highlight; else the set of used ids. */
  usedIds: Set<string> | null;
  copiedId: string | null;
  onCopy: (id: string) => void;
  onEdit: (id: string) => void;
  onCommit: (note: Note, draft: string) => void;
  onToggleTag: (tag: string) => void;
}

export function Wall({ notes, now, editingId, usedIds, copiedId, onCopy, onEdit, onCommit, onToggleTag }: WallProps) {
  return (
    <section className="wall">
      {notes.map((n) => (
        <NoteCard
          key={n.id}
          note={n}
          now={now}
          editing={editingId === n.id}
          dim={usedIds !== null && !usedIds.has(n.id)}
          used={usedIds !== null && usedIds.has(n.id)}
          copied={copiedId === n.id}
          onCopy={onCopy}
          onEdit={onEdit}
          onCommit={onCommit}
          onToggleTag={onToggleTag}
        />
      ))}
    </section>
  );
}
```

### Step 23: Answer panel and chat bar
**File:** `web/src/components/AnswerPanel.tsx` (new)
**Code:**
```tsx
import { PushPin, X } from '@phosphor-icons/react';

export interface AnswerPanelProps {
  left: number;
  query: string;
  text: string;
  done: boolean;
  pinned: boolean;
  usedIds: string[];
  onTogglePin: () => void;
  onClose: () => void;
  onJump: (id: string) => void;
}

export function AnswerPanel({ left, query, text, done, pinned, usedIds, onTogglePin, onClose, onJump }: AnswerPanelProps) {
  const parts = text.split('\n\n');
  return (
    <div className="answer" style={{ left, width: `min(680px, calc(100vw - ${left}px - 16px))` }}>
      <div className="answer-head">
        <span className="answer-q">{query}</span>
        <span className="spacer" />
        <button type="button" className={pinned ? 'pbtn on' : 'pbtn'} data-tip={pinned ? 'Unpin' : 'Pin'} aria-label={pinned ? 'Unpin' : 'Pin'} onClick={onTogglePin}>
          <PushPin weight="duotone" />
        </button>
        <button type="button" className="pbtn hov" data-tip="Dismiss" aria-label="Dismiss" onClick={onClose}>
          <X weight="duotone" />
        </button>
      </div>
      <div className="answer-body">
        {parts.map((t, i) => (
          <p key={i}>{t + (!done && i === parts.length - 1 ? ' ▍' : '')}</p>
        ))}
      </div>
      {done && usedIds.length > 0 && (
        <div className="used-row">
          {usedIds.map((id) => (
            <button key={id} type="button" className="usedchip" data-tip="Show on wall" onClick={() => onJump(id)}>
              {id}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```
**File:** `web/src/components/ChatBar.tsx` (new)
**Code:**
```tsx
import type { FormEvent } from 'react';
import { ArrowRight } from '@phosphor-icons/react';

export interface ChatBarProps {
  left: number;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
}

export function ChatBar({ left, value, onChange, onSubmit }: ChatBarProps) {
  return (
    <form className="chatbar" style={{ left }} onSubmit={onSubmit}>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Ask about your notes" aria-label="Ask about your notes" />
      <button type="submit" className="sendbtn" data-tip="Send" aria-label="Send">
        <ArrowRight weight="duotone" />
      </button>
    </form>
  );
}
```

### Step 24: Phase 8 seam stubs
**File:** `web/src/components/NoteImage.tsx` (new, rewritten by phase 8)
**Code:**
```tsx
import type { CSSProperties } from 'react';
import { thumbUrl } from '../api';
import type { Note } from '../types';

export interface NoteImageProps {
  note: Note;
  className?: string;
  style?: CSSProperties;
}

/** Phase 7 stub: always the thumbnail. Phase 8 adds the "not on this machine" placeholder when !note.image.available. */
export function NoteImage({ note, className = 'card-img', style }: NoteImageProps) {
  if (!note.image) return null;
  return (
    <img
      className={className}
      src={thumbUrl(note.id)}
      alt=""
      draggable={false}
      loading="lazy"
      style={{ aspectRatio: `${note.image.width} / ${note.image.height}`, ...style }}
    />
  );
}
```
**File:** `web/src/components/Gallery.tsx` (new, rewritten by phase 8)
**Code:**
```tsx
import type { Note } from '../types';

export interface GalleryProps {
  /** Image notes passing the tag filter, in wall order. */
  photos: Note[];
  copiedId: string | null;
  onCopy: (id: string) => void;
}

/** Phase 7 stub. Phase 8 renders the justified grid and owns PhotoModal state. */
export function Gallery({ photos }: GalleryProps) {
  return <section className="gallery" data-count={photos.length} style={{ paddingTop: 30 }} />;
}
```
**File:** `web/src/components/PhotoModal.tsx` (new, rewritten by phase 8)
**Code:**
```tsx
import type { Note } from '../types';

export interface PhotoModalProps {
  photos: Note[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  copiedId: string | null;
  onCopy: (id: string) => void;
}

/** Phase 7 stub. Phase 8 implements the modal; its keydown listener must use capture + preventDefault. */
export function PhotoModal(_props: PhotoModalProps) {
  return null;
}
```
**File:** `web/src/components/DropOverlay.tsx` (new, rewritten by phase 8)
**Code:**
```tsx
import type { Note } from '../types';

export interface DropOverlayProps {
  /** Call once per note returned by POST /api/images. App inserts it and switches text -> all. */
  onImageAdded: (note: Note) => void;
}

/** Phase 7 stub. Phase 8 owns drag/drop/paste listeners, upload, and the dashed overlay. */
export function DropOverlay(_props: DropOverlayProps) {
  return null;
}
```
**Impact:** `_props` is unused. `tsconfig.web.json` does not set `noUnusedParameters`, so this typechecks.

### Step 25: App
**File:** `web/src/App.tsx` (new)
**Code:**
```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { IconContext } from '@phosphor-icons/react';
import { createNote, deleteNote, updateNote } from './api';
import type { Mode, Note } from './types';
import { useNotes } from './hooks/useNotes';
import { useChat } from './hooks/useChat';
import { useNow } from './hooks/useNow';
import { useCopied } from './hooks/useCopied';
import { countLineFor, headingFor, isHiddenByMode, lastEdited, nextMode, photosOf, visibleOnWall } from './lib/filter';
import { extractUsedIds } from './lib/usedIds';
import { relativeDate } from './lib/dates';
import { tagsOf } from './lib/text';
import { Rail } from './components/Rail';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { Wall } from './components/Wall';
import { AnswerPanel } from './components/AnswerPanel';
import { ChatBar } from './components/ChatBar';
import { Tooltip } from './components/Tooltip';
import { Gallery } from './components/Gallery';
import { DropOverlay } from './components/DropOverlay';

const ICONS = { weight: 'duotone' as const, size: '1em', color: 'currentColor', mirrored: false };

function scrollToNote(id: string): void {
  const el = document.querySelector(`[data-note="${id}"]`);
  if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 140, behavior: 'smooth' });
}

export function App() {
  const { notes, tags, refetch, upsertLocal, removeLocal } = useNotes();
  const now = useNow();
  const chat = useChat();
  const { copied, copy } = useCopied();

  const [side, setSide] = useState(false);
  const [mode, setMode] = useState<Mode>('text');
  const [active, setActive] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [q, setQ] = useState('');

  const visible = useMemo(() => visibleOnWall(notes, mode, active, editing), [notes, mode, active, editing]);
  const photos = useMemo(() => photosOf(notes, active), [notes, active]);
  const photoCount = useMemo(() => notes.filter((n) => n.image).length, [notes]);
  const last = useMemo(() => lastEdited(notes), [notes]);
  const used = useMemo(() => extractUsedIds(chat.text, notes.map((n) => n.id)), [chat.text, notes]);
  const highlight = chat.open && chat.text.length > 0 && used.length > 0;
  const usedSet = useMemo(() => (highlight ? new Set(used) : null), [highlight, used]);

  const mainLeft = side ? 296 : 56;
  const chatLeft = mainLeft + 16;

  const toggleTag = useCallback((t: string) => {
    setActive((a) => (a.includes(t) ? a.filter((x) => x !== t) : [...a, t]));
  }, []);

  const jump = useCallback(
    (id: string) => {
      const note = notes.find((n) => n.id === id);
      if (isHiddenByMode(note, mode)) {
        setMode('all');
        window.setTimeout(() => scrollToNote(id), 50);
      } else {
        scrollToNote(id);
      }
    },
    [notes, mode],
  );

  const addNote = useCallback(async () => {
    try {
      const n = await createNote('');
      upsertLocal(n, true);
      setEditing(n.id);
      setMode((m) => (m === 'images' ? 'text' : m));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      console.error('create note failed', e);
    } finally {
      refetch();
    }
  }, [upsertLocal, refetch]);

  const commit = useCallback(
    async (note: Note, draft: string) => {
      setEditing((cur) => (cur === note.id ? null : cur));
      if (!draft.trim() && !note.image) {
        removeLocal(note.id);
        try {
          await deleteNote(note.id);
        } catch (e) {
          console.error('delete note failed', e);
        } finally {
          refetch();
        }
        return;
      }
      if (draft === note.body) return;
      upsertLocal({ ...note, body: draft, tags: tagsOf(draft), updated_at: new Date().toISOString() });
      try {
        upsertLocal(await updateNote(note.id, draft));
      } catch (e) {
        console.error('update note failed', e);
      } finally {
        refetch();
      }
    },
    [removeLocal, upsertLocal, refetch],
  );

  const onImageAdded = useCallback(
    (note: Note) => {
      upsertLocal(note, true);
      setMode((m) => (m === 'text' ? 'all' : m));
      refetch();
    },
    [upsertLocal, refetch],
  );

  const send = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!q.trim()) return;
    setMode((m) => (m === 'images' ? 'all' : m));
    void chat.ask(q);
    setQ('');
  };

  const { open: chatOpen, pinned, close: closeChat } = chat;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === 'Escape' && chatOpen && !pinned) closeChat();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [chatOpen, pinned, closeChat]);

  return (
    <IconContext.Provider value={ICONS}>
      <div className="app">
        <Rail
          mode={mode}
          active={active}
          onToggleSide={() => setSide((s) => !s)}
          onAdd={() => void addNote()}
          onCycleMode={() => setMode(nextMode)}
          onToggleTag={toggleTag}
          onClear={() => setActive([])}
        />
        {side && (
          <Sidebar mode={mode} photoCount={photoCount} tags={tags} active={active} onMode={setMode} onToggleTag={toggleTag} />
        )}
        <main className="main" style={{ marginLeft: mainLeft }}>
          <Header
            heading={headingFor(mode, active)}
            countLine={countLineFor(mode, active, notes, visible, photos)}
            last={last}
            lastWhen={last ? relativeDate(last.updated_at, now, true) : ''}
            showSticker={mode !== 'images'}
            onJumpLast={() => last && jump(last.id)}
            onAdd={() => void addNote()}
          />
          <div className="rule" />
          {mode === 'images' ? (
            <Gallery photos={photos} copiedId={copied} onCopy={copy} />
          ) : (
            <Wall
              notes={visible}
              now={now}
              editingId={editing}
              usedIds={usedSet}
              copiedId={copied}
              onCopy={copy}
              onEdit={setEditing}
              onCommit={commit}
              onToggleTag={toggleTag}
            />
          )}
        </main>
        {chat.open && (
          <AnswerPanel
            left={chatLeft}
            query={chat.query}
            text={chat.text}
            done={chat.done}
            pinned={chat.pinned}
            usedIds={used}
            onTogglePin={chat.togglePin}
            onClose={chat.close}
            onJump={jump}
          />
        )}
        <ChatBar left={chatLeft} value={q} onChange={setQ} onSubmit={send} />
        <DropOverlay onImageAdded={onImageAdded} />
        <Tooltip />
      </div>
    </IconContext.Provider>
  );
}
```
**Impact:** every icon also gets `weight="duotone"` explicitly, so the duotone weight does not depend on the Provider. If phase 1's Phosphor typings make `IconContext`'s value type reject `mirrored`, drop that key. It is optional in 2.1.x.

### Step 26: Pure-logic tests
**File:** `web/src/lib/text.test.tsx` (new)
**Code:**
```tsx
import { describe, expect, it } from 'vitest';
import { fontSizeFor, letterSpacingFor, rowsFor, segmentBody, tagsOf } from './text';

describe('fontSizeFor', () => {
  it('sizes text by length: <36 → 26, <80 → 17, else 13.5', () => {
    expect(fontSizeFor('a'.repeat(35), false)).toBe(26);
    expect(fontSizeFor('a'.repeat(36), false)).toBe(17);
    expect(fontSizeFor('a'.repeat(79), false)).toBe(17);
    expect(fontSizeFor('a'.repeat(80), false)).toBe(13.5);
  });
  it('uses 13 for image cards regardless of length', () => {
    expect(fontSizeFor('', true)).toBe(13);
    expect(fontSizeFor('a'.repeat(200), true)).toBe(13);
  });
  it('tightens letter-spacing above 20px', () => {
    expect(letterSpacingFor(26)).toBe('-0.03em');
    expect(letterSpacingFor(17)).toBe('-0.005em');
  });
  it('gives the editor at least 3 rows', () => {
    expect(rowsFor(0)).toBe(3);
    expect(rowsFor(28 * 5)).toBe(5);
  });
});

describe('tagsOf', () => {
  it('parses, lower-cases and dedupes tags, ignoring # inside words', () => {
    expect(tagsOf('#Seer and #seer, C# a#b #from_phone #v250 #ai-image')).toEqual(['seer', 'from_phone', 'v250', 'ai-image']);
  });
});

describe('segmentBody', () => {
  it('splits text and tag chips in order', () => {
    expect(segmentBody('#seer onboarding is long #UX!')).toEqual([
      { kind: 'tag', text: '#seer', tag: 'seer' },
      { kind: 'text', text: ' onboarding is long ' },
      { kind: 'tag', text: '#UX', tag: 'ux' },
      { kind: 'text', text: '!' },
    ]);
  });
  it('keeps a # inside a word as plain text', () => {
    expect(segmentBody('C# rocks #dev')).toEqual([
      { kind: 'text', text: 'C# rocks ' },
      { kind: 'tag', text: '#dev', tag: 'dev' },
    ]);
  });
  it('returns nothing for an empty body', () => {
    expect(segmentBody('')).toEqual([]);
  });
});
```
**File:** `web/src/lib/filter.test.tsx` (new)
**Code:**
```tsx
import { describe, expect, it } from 'vitest';
import type { Note } from '../types';
import { countLineFor, headingFor, isHiddenByMode, lastEdited, nextMode, photosOf, visibleOnWall } from './filter';

const img = { mime: 'image/jpeg', width: 600, height: 400, bytes: 1, taken_at: null, original_name: null, host: 'lenovo', available: true };
function note(id: string, body: string, opts: { image?: boolean; updated?: string } = {}): Note {
  return {
    id,
    body,
    tags: [],
    created_at: '2026-10-30T00:00:00Z',
    updated_at: opts.updated ?? '2026-10-30T00:00:00Z',
    origin: null,
    image: opts.image ? img : null,
  };
}

const notes = [
  note('A-AAA', '#seer #ux both'),
  note('B-BBB', '#seer only'),
  note('C-CCC', '#ux only'),
  note('D-DDD', 'photo #seer #ux', { image: true }),
];

describe('visibleOnWall', () => {
  it('applies tag filters with AND semantics', () => {
    expect(visibleOnWall(notes, 'all', ['seer', 'ux']).map((n) => n.id)).toEqual(['A-AAA', 'D-DDD']);
    expect(visibleOnWall(notes, 'all', ['seer']).map((n) => n.id)).toEqual(['A-AAA', 'B-BBB', 'D-DDD']);
  });
  it('hides image notes in text mode only', () => {
    expect(visibleOnWall(notes, 'text', []).map((n) => n.id)).toEqual(['A-AAA', 'B-BBB', 'C-CCC']);
    expect(visibleOnWall(notes, 'all', [])).toHaveLength(4);
  });
  it('always keeps the note being edited', () => {
    expect(visibleOnWall([...notes, note('E-EEE', '')], 'text', ['seer'], 'E-EEE').map((n) => n.id)).toContain('E-EEE');
  });
});

describe('modes and header', () => {
  it('cycles text → images → all → text', () => {
    expect(nextMode('text')).toBe('images');
    expect(nextMode('images')).toBe('all');
    expect(nextMode('all')).toBe('text');
  });
  it('picks the heading', () => {
    expect(headingFor('text', [])).toBe('Notes.');
    expect(headingFor('all', [])).toBe('Everything.');
    expect(headingFor('images', ['seer'])).toBe('Photos.');
    expect(headingFor('text', ['seer', 'ux'])).toBe('#seer #ux');
  });
  it('builds the count line per mode', () => {
    const textVis = visibleOnWall(notes, 'text', []);
    expect(countLineFor('text', [], notes, textVis, [])).toBe('3 notes, 1 photo notes hidden.');
    expect(countLineFor('all', [], notes, notes, [])).toBe('4 notes, 1 with photos.');
    expect(countLineFor('images', [], notes, [], photosOf(notes, []))).toBe('1 photos.');
    const tagged = visibleOnWall(notes, 'all', ['ux']);
    expect(countLineFor('all', ['ux'], notes, tagged, [])).toBe('3 of 4 notes.');
  });
  it('knows which notes a mode hides', () => {
    expect(isHiddenByMode(notes[0], 'images')).toBe(true);
    expect(isHiddenByMode(notes[3], 'text')).toBe(true);
    expect(isHiddenByMode(notes[0], 'text')).toBe(false);
    expect(isHiddenByMode(notes[3], 'all')).toBe(false);
  });
  it('finds the last edited note by updated_at', () => {
    const list = [note('A-AAA', 'x', { updated: '2026-10-29T10:00:00Z' }), note('B-BBB', 'y', { updated: '2026-10-30T09:00:00Z' })];
    expect(lastEdited(list)?.id).toBe('B-BBB');
    expect(lastEdited([])).toBeNull();
  });
});
```
**File:** `web/src/lib/usedIds.test.tsx` (new)
**Code:**
```tsx
import { describe, expect, it } from 'vitest';
import { extractUsedIds } from './usedIds';

describe('extractUsedIds', () => {
  const known = ['A-B32', 'K-F07', 'R-M14'];
  it('finds known ids case-insensitively, in first-mention order, deduped', () => {
    expect(extractUsedIds('see (k-f07), then A-B32 and again a-b32.', known)).toEqual(['K-F07', 'A-B32']);
  });
  it('ignores unknown ids, ids inside longer tokens, and dashless forms', () => {
    expect(extractUsedIds('Z-Z99 XA-B32 A-B32X AB32 R-M14-2', known)).toEqual([]);
  });
  it('returns nothing for empty text', () => {
    expect(extractUsedIds('', known)).toEqual([]);
  });
});
```
**File:** `web/src/lib/dates.test.tsx` (new)
**Code:**
```tsx
import { describe, expect, it } from 'vitest';
import { relativeDate } from './dates';

const now = new Date(2026, 9, 30, 15, 0, 0); // local time, Oct 30 2026 15:00
const at = (y: number, mo: number, d: number, h = 12, mi = 0, s = 0) => new Date(y, mo, d, h, mi, s).toISOString();

describe('relativeDate', () => {
  it('says just now under a minute and for small future skew', () => {
    expect(relativeDate(at(2026, 9, 30, 14, 59, 30), now)).toBe('just now');
    expect(relativeDate(at(2026, 9, 30, 15, 0, 5), now)).toBe('just now');
  });
  it('says N min ago under an hour', () => {
    expect(relativeDate(at(2026, 9, 30, 14, 46), now)).toBe('14 min ago');
    expect(relativeDate(at(2026, 9, 30, 14, 1), now)).toBe('59 min ago');
  });
  it('says Today, then Yesterday', () => {
    expect(relativeDate(at(2026, 9, 30, 9, 0), now)).toBe('Today');
    expect(relativeDate(at(2026, 9, 30, 0, 0), now)).toBe('Today');
    expect(relativeDate(at(2026, 9, 29, 23, 59), now)).toBe('Yesterday');
    expect(relativeDate(at(2026, 9, 29, 0, 0), now)).toBe('Yesterday');
  });
  it('lower-cases for mid-sentence use', () => {
    expect(relativeDate(at(2026, 9, 30, 9, 0), now, true)).toBe('today');
    expect(relativeDate(at(2026, 9, 29, 9, 0), now, true)).toBe('yesterday');
  });
  it('uses "Oct 28" this year and adds the year otherwise', () => {
    expect(relativeDate(at(2026, 9, 28), now)).toBe('Oct 28');
    expect(relativeDate(at(2026, 0, 3), now)).toBe('Jan 3');
    expect(relativeDate(at(2025, 11, 31), now)).toBe('Dec 31, 2025');
  });
  it('returns empty for an invalid date', () => {
    expect(relativeDate('nope', now)).toBe('');
  });
});
```
**File:** `web/src/lib/sse.test.tsx` (new)
**Code:**
```tsx
import { describe, expect, it } from 'vitest';
import { createSSEParser, readSSE } from './sse';
import type { SSEEvent } from './sse';

function collect(chunks: string[]): SSEEvent[] {
  const out: SSEEvent[] = [];
  const p = createSSEParser((e) => out.push(e));
  chunks.forEach((c) => p.push(c));
  p.end();
  return out;
}

describe('createSSEParser', () => {
  it('parses named events with JSON data', () => {
    expect(collect(['event: delta\ndata: {"text":"hi"}\n\nevent: done\ndata: {"thread_id":"t1"}\n\n'])).toEqual([
      { event: 'delta', data: '{"text":"hi"}', id: undefined },
      { event: 'done', data: '{"thread_id":"t1"}', id: undefined },
    ]);
  });
  it('handles events split across chunks, CRLF line endings, and a CRLF split between chunks', () => {
    expect(collect(['event: del', 'ta\r', '\ndata: {"te', 'xt":"a"}\r\n\r\n'])).toEqual([
      { event: 'delta', data: '{"text":"a"}', id: undefined },
    ]);
  });
  it('ignores comments (heartbeats), joins multi-line data, defaults the event name', () => {
    expect(collect([': ping\n\ndata: one\ndata: two\nid: 7\n\n'])).toEqual([{ event: 'message', data: 'one\ntwo', id: '7' }]);
  });
  it('flushes a final event without a trailing blank line on end()', () => {
    expect(collect(['event: done\ndata: {}'])).toEqual([{ event: 'done', data: '{}', id: undefined }]);
  });
  it('drops events with no data', () => {
    expect(collect(['event: note\n\n'])).toEqual([]);
  });
});

describe('readSSE', () => {
  it('reads a byte stream, including a multi-byte char split across chunks', async () => {
    const bytes = new TextEncoder().encode('event: delta\ndata: {"text":"café ▍"}\n\n');
    const cut = bytes.indexOf(0xc3) + 1; // split inside "é"
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, cut));
        c.enqueue(bytes.slice(cut));
        c.close();
      },
    });
    const out: SSEEvent[] = [];
    await readSSE(stream, (e) => out.push(e));
    expect(out).toEqual([{ event: 'delta', data: '{"text":"café ▍"}', id: undefined }]);
  });
});
```

### Step 27: Component tests
**File:** `web/src/components/NoteCard.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { Note } from '../types';
import { NoteCard } from './NoteCard';
import type { NoteCardProps } from './NoteCard';

afterEach(cleanup);

const now = new Date();
function note(body: string, image = false): Note {
  return {
    id: 'A-B32',
    body,
    tags: [],
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    origin: null,
    image: image ? { mime: 'image/jpeg', width: 600, height: 400, bytes: 1, taken_at: null, original_name: null, host: 'lenovo', available: true } : null,
  };
}

function renderCard(n: Note, over: Partial<NoteCardProps> = {}) {
  const props = {
    note: n,
    now,
    editing: false,
    dim: false,
    used: false,
    copied: false,
    onCopy: vi.fn(),
    onEdit: vi.fn(),
    onCommit: vi.fn(),
    onToggleTag: vi.fn(),
    ...over,
  };
  return { ...render(<NoteCard {...props} />), props };
}

describe('NoteCard', () => {
  it('renders the font size by text length', () => {
    const cases: Array<[string, boolean, string]> = [
      ['short #a', false, '26px'],
      ['a'.repeat(50), false, '17px'],
      ['a'.repeat(120), false, '13.5px'],
      ['a'.repeat(10), true, '13px'],
    ];
    for (const [body, image, fs] of cases) {
      const { container, unmount } = renderCard(note(body, image));
      expect((container.querySelector('.card-text') as HTMLElement).style.fontSize).toBe(fs);
      unmount();
    }
  });

  it('renders tag chips; clicking one toggles the filter without entering edit', () => {
    const { container, props } = renderCard(note('#seer onboarding'));
    const chip = container.querySelector('.tagchip') as HTMLElement;
    expect(chip.textContent).toBe('#seer');
    fireEvent.click(chip);
    expect(props.onToggleTag).toHaveBeenCalledWith('seer');
    expect(props.onEdit).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('.card-text') as HTMLElement);
    expect(props.onEdit).toHaveBeenCalledWith('A-B32');
  });

  it('shows id, copy button, relative date; marks copied', () => {
    const { container, getByLabelText, props } = renderCard(note('x'), { copied: true });
    expect(container.querySelector('.card-id')?.textContent).toBe('A-B32');
    expect(container.querySelector('.card-date')?.textContent).toBe('just now');
    expect(container.querySelector('.copied')?.className).toContain('on');
    fireEvent.click(getByLabelText('Copy ID'));
    expect(props.onCopy).toHaveBeenCalledWith('A-B32');
  });

  it('commits the draft on blur while editing', () => {
    const n = note('old');
    const { container, props } = renderCard(n, { editing: true });
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(ta.value).toBe('old');
    fireEvent.change(ta, { target: { value: '' } });
    fireEvent.blur(ta);
    expect(props.onCommit).toHaveBeenCalledWith(n, '');
  });

  it('renders the thumbnail for image notes with the image aspect ratio', () => {
    const { container } = renderCard(note('pic', true));
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/notes/A-B32/thumb');
    expect(img.style.aspectRatio).toBe('600 / 400');
  });
});
```
**File:** `web/src/App.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Note } from './types';
import { App } from './App';

const iso = new Date().toISOString();
const notes: Note[] = [
  { id: 'A-B32', body: '#seer onboarding is long', tags: ['seer'], created_at: iso, updated_at: iso, origin: null, image: null },
  { id: 'C-D45', body: 'buy fennel #kitchen', tags: ['kitchen'], created_at: iso, updated_at: iso, origin: null, image: null },
  {
    id: 'K-F07',
    body: 'River #walks',
    tags: ['walks'],
    created_at: iso,
    updated_at: iso,
    origin: null,
    image: { mime: 'image/jpeg', width: 600, height: 400, bytes: 10, taken_at: null, original_name: 'r.jpg', host: 'lenovo', available: true },
  },
];
const tags = [
  { tag: 'seer', count: 1, last_used: iso },
  { tag: 'kitchen', count: 1, last_used: iso },
  { tag: 'walks', count: 1, last_used: iso },
];

const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/notes')) return json({ notes, next_cursor: null });
      if (url.startsWith('/api/tags')) return json(tags);
      if (url.startsWith('/api/chat')) {
        return new Response('event: delta\ndata: {"text":"Look at a-b32"}\n\nevent: delta\ndata: {"text":" and Z-Z99."}\n\nevent: done\ndata: {"thread_id":"t1"}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response('not found', { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('renders real notes in text mode by default, hiding image notes', async () => {
    render(<App />);
    expect(await screen.findByText('onboarding is long')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Notes.');
    expect(screen.getByText(/2 notes, 1 photo notes hidden\./)).toBeTruthy();
    expect(document.querySelector('[data-note="K-F07"]')).toBeNull();
  });

  it('cycles modes text → images → all and shows image cards as thumbs in all', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    fireEvent.click(screen.getByLabelText('Text notes only (click to switch)'));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Photos.');
    expect(document.querySelector('.gallery')).not.toBeNull();
    fireEvent.click(screen.getByLabelText('Image notes only (click to switch)'));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Everything.');
    expect(document.querySelector('[data-note="K-F07"] img')?.getAttribute('src')).toBe('/api/notes/K-F07/thumb');
  });

  it('filters by a tag chip and shows it as an active rail chip', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    fireEvent.click(document.querySelector('[data-note="A-B32"] .tagchip') as HTMLElement);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('#seer');
    expect(document.querySelector('[data-note="C-D45"]')).toBeNull();
    expect(document.querySelector('.rail-chip')?.textContent).toBe('#seer');
    fireEvent.click(screen.getByLabelText('Clear filters'));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Notes.');
  });

  it('streams the chat answer, shows used-note chips, and dims non-used cards', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    fireEvent.change(screen.getByLabelText('Ask about your notes'), { target: { value: 'what about seer?' } });
    fireEvent.submit(document.querySelector('form.chatbar') as HTMLFormElement);
    expect(await screen.findByRole('button', { name: 'A-B32' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Z-Z99' })).toBeNull();
    expect(screen.getByText('what about seer?')).toBeTruthy();
    expect(screen.getByText('Look at a-b32 and Z-Z99.')).toBeTruthy();
    await waitFor(() => {
      expect(document.querySelector('[data-note="A-B32"]')?.className).toContain('used');
      expect(document.querySelector('[data-note="C-D45"]')?.className).toContain('dim');
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('.answer')).toBeNull();
  });
});
```
**Impact:** `EventSource` is undefined in jsdom, so `useNotes` skips SSE in tests. That guard exists for this reason. The 60 s interval is cleared on unmount by `cleanup()`.

## Verification

**Build:** `npm run build`. It runs `build:server` and then `build:web`, and must leave `web/dist/index.html` plus `web/dist/assets/*.js`, `*.css` and `*.woff2`.
**Tests:** `npm run typecheck && npm test && npm run test:int` all green. The new web tests run inside `npm test`.
**Manual check (served by the daemon, never on 7317, never Neon, never `~/mcp-notes-data`):**
```bash
npm run test:int                     # ensures the mcp-notes-pg-test container (55433) is up and migrated
export DATABASE_URL="<the URL scripts/test-int.sh uses for 55433>"
export NOTES_DATA_DIR="$(mktemp -d)" NOTESD_PORT=7399
node dist/main.js & PID=$!
sleep 1
curl -s localhost:7399/ | grep -q '<div id="root">' && echo index-ok
curl -s -o /dev/null -w '%{http_code}\n' "localhost:7399$(curl -s localhost:7399/ | grep -o '/assets/[^"]*\.js' | head -1)"   # 200
curl -s -XPOST localhost:7399/api/notes -H 'content-type: application/json' -d '{"body":"#seer phase 7 smoke test"}'
curl -s localhost:7399/api/notes | head -c 300
```
Open `http://localhost:7399` in the Windows browser and check against `Notes Wall.dc.html`:
- heading `Notes.` and the count line;
- the smoke note at 26px with a `#seer` chip, and clicking the chip filters;
- "+" adds a card in edit mode at the top with a real id; blur while it is empty makes it vanish (DELETE);
- edit and blur PATCHes (check `curl /api/notes`);
- copy-id shows a check and "copied" for 1.4 s;
- tooltips above controls and right of rail controls;
- the mode button cycles and inverts;
- the sidebar shows three mode icons, the photo count and tags with counts;
- the chat streams the stub reply with the ▍ cursor; pin and dismiss work; Esc closes when unpinned;
- a `curl -XPATCH` from another shell appears within about 1 s (SSE).

Finish with `kill $PID`.
**Exit criteria:** `npm run build` produces `web/dist`. The daemon on a test port serves the wall with real notes. All web component and unit tests are green. `typecheck`, `test` and `test:int` are green.

## Handoffs

- **Phase 8 (R3):** rewrite `web/src/components/{Gallery,PhotoModal,DropOverlay,NoteImage}.tsx` against the props above. Add `fullscreen: resolve(root, 'fullscreen.html'),` to `build.rolldownOptions.input` in `web/vite.config.ts`. Create `web/fullscreen.html` and `web/src/fullscreen/*`. Put gallery/modal/overlay styles in its own CSS file imported by those components. PhotoModal's keydown listener: `capture: true` + `preventDefault()`. Upload calls `onImageAdded(note)` for each created or deduped note; App does the `text → all` switch. The wall's film-tone filter is already on `.card-img` (`--film`). Phase 8 keeps it when it replaces NoteImage, and shows the placeholder on the wall when `image.available === false`.
- **Phase 6 (R3, resolved by the reconciler):** this client reads phase 6's exact shapes (`{ notes, next_cursor }`, bare `TagCount[]`, bare `Note`). `/api/events` must send `event: note` (named) frames: a frame without an event name is not caught by `addEventListener('note')`. The optional `has_image` param is not used here.
- **Phase 1:** if the root `tsconfig.json` includes `web/`, add `"exclude": ["web"]` (Assumption 1). The reconciler should prefer that phase 1 does this itself.
- Not done (scope): no persistence of mode, side or filters across reloads (R3 says text mode on every load); no auto-scroll of the answer panel; no visibility-change refetch.

## Rollback

`git revert` this phase's commit(s). That removes `web/` (except phase 8's files if phase 8 landed, in which case revert phase 8 first), `tsconfig.web.json`, and restores phase 1's `scripts` (`build` = `build:server`, `typecheck` without the web pass). No server, schema or dependency changes to undo.
