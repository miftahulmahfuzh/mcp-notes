# Phase 6: Readable links in the answer panel

**Plan set:** `CONNECTORS_PLAN.md`
**Analysis:** `docs/analyzer/20261030-124712-C5N7_code_analyzer.md`
**Satisfies:** R4 — the answer panel never shows raw markdown link syntax
**Depends on:** none
**Difficulty:** EASY
**Package:** `web/src`

---

## Goal

Chat answers that cite web pages show real, underlined, caption-style links instead of raw
`[BookBrowse summary](https://…)` text. Markdown links show their label, bare `http(s)://` URLs show
the URL, both open in a new tab, and an unfinished link while streaming shows as plain label text
until it completes. The system prompt is not changed (reconciliation decision, index line 196).

## Interface Contract

**Deletes:** nothing
**Renames:** nothing
**Creates:** `web/src/lib/links.ts`: `type LinkSegment`, `function segmentLinks(text: string, opts?: { streaming?: boolean }): LinkSegment[]`; CSS classes `.answer-link`, `.answer-link:hover` (`web/src/styles.css`); test files `web/src/lib/links.test.tsx`, `web/src/components/AnswerPanel.test.tsx`
**Signature changes:** none. `AnswerPanelProps` is unchanged, so `web/src/App.tsx:182` needs no edit.
**Requires (from earlier phases):** nothing
**Leaves alone (owned by others):** `src/**` including `src/chat/prompt.ts` (Phase 5 / Phase 1), `claude/**` (Phase 5), `src/connectors/**` (Phases 1–4), `web/src/lib/text.ts` (not modified: a separate file avoids clashing with its existing `Segment` type), `web/src/App.tsx`

## Files

| File | Action | What changes |
|---|---|---|
| `web/src/lib/links.ts` | create | pure link segmenter |
| `web/src/lib/links.test.tsx` | create | unit tests for the segmenter (node env, no pragma needed) |
| `web/src/components/AnswerPanel.tsx` | modify | lines 1 (imports) and 35–39 (paragraph rendering) |
| `web/src/components/AnswerPanel.test.tsx` | create | jsdom render tests: real `<a>`, no `](` in the text, streaming behaviour |
| `web/src/styles.css` | modify | insert `.answer-link` rules after line 109 (`.answer-body p { margin: 0; }`) |

## Implementation Steps

### Step 1: Link segmenter
**File:** `web/src/lib/links.ts` (new)
**Change:** A pure function in the `segmentBody` idiom (`web/src/lib/text.ts:20`). One regex pass handles
markdown links (`[label](http(s)://…)`, one level of balanced parentheses in the URL) and bare URLs (not
preceded by a word char or `/`), then trims trailing punctuation and unbalanced `)`/`]` from bare URLs.
A link is only emitted when the URL passes `HREF_OK` (`^https?://` plus a host char), so `javascript:`,
`ftp:`, `mailto:` and a host-less `https://` stay text. A `$`-anchored `PENDING` regex finds an unfinished
markdown link at the end of the paragraph: while streaming it is replaced by its label; once done, a lone
`[lab` stays literal and a truncated `[lab](https://…` becomes a link. The regexes avoid nested ambiguous
quantifiers (checked: 5,000 unclosed `(` and a 60,000-char unterminated label run in under 1 ms).
**Code:**
```ts
// Link segmentation for the chat answer panel (R4). Same idiom as segmentBody in ./text:
// a pure function that splits text into typed segments the component maps to elements.
// Only http(s) becomes a link; every other scheme stays plain text.

export type LinkSegment =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; href: string };

const URL_BODY = '(?:[^\\s()<>]|\\([^\\s()<>]*\\))+';
const MD_SRC = `\\[([^\\]\\n]*)\\]\\((https?:\\/\\/${URL_BODY})\\)`;
const BARE_SRC = '(?<![\\w/])https?:\\/\\/[^\\s<>]+';
const PENDING = /\[([^\]\n]*)(?:\](?:\(((?:[^\s()]|\([^\s()]*\))*(?:\([^\s()]*)?))?)?$/;
const HREF_OK = /^https?:\/\/[^\s/?#()<>]/i;
const TRAILING = '.,;:!?\'"*`';

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url.at(-1);
    if (last === undefined) return url;
    if (TRAILING.includes(last)) url = url.slice(0, -1);
    else if (last === ')' && count(url, ')') > count(url, '(')) url = url.slice(0, -1);
    else if (last === ']' && count(url, ']') > count(url, '[')) url = url.slice(0, -1);
    else return url;
  }
}

function pushText(out: LinkSegment[], text: string): void {
  if (text === '') return;
  const prev = out.at(-1);
  if (prev && prev.kind === 'text') prev.text += text;
  else out.push({ kind: 'text', text });
}

function scan(s: string, out: LinkSegment[]): void {
  let at = 0;
  for (const m of s.matchAll(new RegExp(`${MD_SRC}|${BARE_SRC}`, 'gi'))) {
    const start = m.index ?? 0;
    const mdHref = m[2];
    if (mdHref !== undefined) {
      pushText(out, s.slice(at, start));
      out.push({ kind: 'link', text: m[1] || mdHref, href: mdHref });
      at = start + m[0].length;
      continue;
    }
    const url = trimUrl(m[0]);
    if (!HREF_OK.test(url)) continue;
    pushText(out, s.slice(at, start));
    out.push({ kind: 'link', text: url, href: url });
    at = start + url.length;
  }
  pushText(out, s.slice(at));
}

/**
 * Splits one paragraph of answer text into plain text and links.
 * - `[label](http(s)://...)` becomes a link showing `label` (the URL when the label is empty).
 * - A bare `http(s)://...` becomes a link showing the URL; trailing `. , ; : ! ? ' " * \``
 *   and unbalanced `)` / `]` stay outside it.
 * - `streaming`: an unfinished markdown link at the very end (`[lab`, `[lab]`, `[lab](https://bo`)
 *   is shown as its label only, so raw markup never flashes before it completes.
 *   Once done, a lone `[lab` is literal text and a truncated `[lab](https://...` is a link.
 */
export function segmentLinks(text: string, opts: { streaming?: boolean } = {}): LinkSegment[] {
  const out: LinkSegment[] = [];
  let body = text;
  let tail: LinkSegment | null = null;
  const p = PENDING.exec(text);
  if (p) {
    const label = p[1] ?? '';
    const partial = p[2];
    if (opts.streaming) {
      body = text.slice(0, p.index);
      tail = label ? { kind: 'text', text: label } : null;
    } else if (partial !== undefined) {
      body = text.slice(0, p.index);
      if (HREF_OK.test(partial)) tail = { kind: 'link', text: label || partial, href: partial };
      else tail = label ? { kind: 'text', text: label } : null;
    }
  }
  scan(body, out);
  if (tail) {
    if (tail.kind === 'text') pushText(out, tail.text);
    else out.push(tail);
  }
  return out;
}
```
**Impact:** new file, no callers until Step 3.

### Step 2: Segmenter unit tests
**File:** `web/src/lib/links.test.tsx` (new). It runs in node, as `web/src/lib/text.test.tsx` does, so no
jsdom pragma. The `.tsx` extension is needed because `vitest.config.ts` only picks up `web/src/**/*.test.tsx`.
**Code:**
```tsx
import { describe, expect, it } from 'vitest';
import { segmentLinks } from './links';

describe('segmentLinks: markdown links', () => {
  it('turns [label](https://...) into a link showing the label', () => {
    expect(segmentLinks('Read the [BookBrowse summary](https://www.bookbrowse.com/x?id=1) for more.')).toEqual([
      { kind: 'text', text: 'Read the ' },
      { kind: 'link', text: 'BookBrowse summary', href: 'https://www.bookbrowse.com/x?id=1' },
      { kind: 'text', text: ' for more.' },
    ]);
  });
  it('accepts http and keeps balanced parentheses inside the URL', () => {
    expect(segmentLinks('[Foo](http://en.wikipedia.org/wiki/Foo_(bar))')).toEqual([
      { kind: 'link', text: 'Foo', href: 'http://en.wikipedia.org/wiki/Foo_(bar)' },
    ]);
  });
  it('shows the URL when the label is empty', () => {
    expect(segmentLinks('[](https://a.com)')).toEqual([{ kind: 'link', text: 'https://a.com', href: 'https://a.com' }]);
  });
  it('leaves non-http schemes as plain text', () => {
    const s = '[x](javascript:alert(1)) and javascript:alert(1), ftp://x.com, mailto:a@b.c';
    expect(segmentLinks(s)).toEqual([{ kind: 'text', text: s }]);
  });
  it('leaves brackets that are not links alone', () => {
    expect(segmentLinks('a [1] b and range [0, 5) ok')).toEqual([{ kind: 'text', text: 'a [1] b and range [0, 5) ok' }]);
  });
});

describe('segmentLinks: bare URLs', () => {
  it('links bare URLs and leaves trailing punctuation outside', () => {
    expect(segmentLinks('See https://example.com/a, then https://example.com/b.')).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'link', text: 'https://example.com/a', href: 'https://example.com/a' },
      { kind: 'text', text: ', then ' },
      { kind: 'link', text: 'https://example.com/b', href: 'https://example.com/b' },
      { kind: 'text', text: '.' },
    ]);
  });
  it.each([';', ':', '!', '?'])('drops a trailing %s', (p) => {
    expect(segmentLinks(`go https://a.com/x${p}`)).toEqual([
      { kind: 'text', text: 'go ' },
      { kind: 'link', text: 'https://a.com/x', href: 'https://a.com/x' },
      { kind: 'text', text: p },
    ]);
  });
  it('drops an unbalanced closing parenthesis but keeps a balanced one', () => {
    expect(segmentLinks('(see https://example.com/c)')).toEqual([
      { kind: 'text', text: '(see ' },
      { kind: 'link', text: 'https://example.com/c', href: 'https://example.com/c' },
      { kind: 'text', text: ')' },
    ]);
    expect(segmentLinks('https://en.wikipedia.org/wiki/Foo_(bar).')).toEqual([
      { kind: 'link', text: 'https://en.wikipedia.org/wiki/Foo_(bar)', href: 'https://en.wikipedia.org/wiki/Foo_(bar)' },
      { kind: 'text', text: '.' },
    ]);
  });
  it('does not link a scheme with no host', () => {
    expect(segmentLinks('https:// alone and https://')).toEqual([{ kind: 'text', text: 'https:// alone and https://' }]);
  });
  it('returns no segments for empty text', () => {
    expect(segmentLinks('')).toEqual([]);
  });
});

describe('segmentLinks: streaming', () => {
  it.each([
    ['Read the [BookBrowse summ', 'Read the BookBrowse summ'],
    ['Read the [x]', 'Read the x'],
    ['Read the [x](https://bo', 'Read the x'],
    ['Read the [x](https://w/Foo_(ba', 'Read the x'],
  ])('renders the unfinished link %j as its label only', (input, shown) => {
    expect(segmentLinks(input, { streaming: true })).toEqual([{ kind: 'text', text: shown }]);
  });
  it('still links the complete links before the unfinished one', () => {
    expect(segmentLinks('[a](https://a.com) and [b', { streaming: true })).toEqual([
      { kind: 'link', text: 'a', href: 'https://a.com' },
      { kind: 'text', text: ' and b' },
    ]);
  });
  it('once done, a lone [ is literal text and a truncated link to http(s) is a link', () => {
    expect(segmentLinks('Read the [x')).toEqual([{ kind: 'text', text: 'Read the [x' }]);
    expect(segmentLinks('Read the [x](https://bo')).toEqual([
      { kind: 'text', text: 'Read the ' },
      { kind: 'link', text: 'x', href: 'https://bo' },
    ]);
    expect(segmentLinks('Read the [x](javascr')).toEqual([{ kind: 'text', text: 'Read the x' }]);
  });
});
```
**Impact:** none outside tests.

### Step 3: Render links in the answer panel
**File:** `web/src/components/AnswerPanel.tsx:1` (imports) and `:35-39` (the `.answer-body` block)
**Change:** Keep `text.split('\n\n')` → one `<p>` per paragraph. Inside each `<p>`, map `segmentLinks`
output to text fragments and `<a className="answer-link" target="_blank" rel="noreferrer noopener">`.
Only the last paragraph is segmented with `streaming: true` (when `!done`), so an earlier paragraph's
stray `[` is never hidden. The cursor `' ▍'` becomes a separate trailing text child of the last paragraph
while streaming. The visible text and `textContent` stay the same as before.
**Code (whole file after the change):**
```tsx
import { Fragment } from 'react';
import { PushPin, X } from '@phosphor-icons/react';
import { segmentLinks } from '../lib/links';

export interface AnswerPanelProps {
  left: number;
  query: string;
  text: string;
  done: boolean;
  /** Tool caption while streaming; '' for none. */
  status: string;
  /** Brain that answered, shown once done; null for none. */
  brain: string | null;
  pinned: boolean;
  usedIds: string[];
  onTogglePin: () => void;
  onClose: () => void;
  onJump: (id: string) => void;
}

export function AnswerPanel({ left, query, text, done, status, brain, pinned, usedIds, onTogglePin, onClose, onJump }: AnswerPanelProps) {
  const parts = text.split('\n\n');
  const caption = done ? (brain ?? '') : status;
  return (
    <div className="answer" style={{ left, width: `min(680px, calc(100vw - ${left}px - 16px))` }}>
      <div className="answer-head">
        <span className="answer-q">{query}</span>
        {caption && <span className="answer-status">{caption}</span>}
        <span className="spacer" />
        <button type="button" className={pinned ? 'pbtn on' : 'pbtn'} data-tip={pinned ? 'Unpin' : 'Pin'} aria-label={pinned ? 'Unpin' : 'Pin'} onClick={onTogglePin}>
          <PushPin weight="duotone" />
        </button>
        <button type="button" className="pbtn hov" data-tip="Dismiss" aria-label="Dismiss" onClick={onClose}>
          <X weight="duotone" />
        </button>
      </div>
      <div className="answer-body">
        {parts.map((t, i) => {
          const streaming = !done && i === parts.length - 1;
          return (
            <p key={i}>
              {segmentLinks(t, { streaming }).map((s, j) =>
                s.kind === 'link' ? (
                  <a key={j} className="answer-link" href={s.href} target="_blank" rel="noreferrer noopener">
                    {s.text}
                  </a>
                ) : (
                  <Fragment key={j}>{s.text}</Fragment>
                ),
              )}
              {streaming ? ' ▍' : ''}
            </p>
          );
        })}
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
**Impact:** answer text that holds no links renders exactly as before. Nothing else imports anything changed.

### Step 4: Link style
**File:** `web/src/styles.css`, insert after line 109 (`.answer-body p { margin: 0; }`), still inside the
`/* answer panel */` block.
**Change:** Caption family: `var(--mono)`, 12px (the 10.5px caption size is hard to read inside 15px body
text, so this goes slightly larger). Underline as in the design's `a` rule (`docs/design/claude-design/Notes Wall.dc.html:17`:
underline, `text-underline-offset: 2px`, `text-decoration-thickness: 1px`). The text uses `--text`, the
underline `--dim`, and hover brightens both to `--fg`. The design's hover is `#fff`, which is not a token,
so `--fg` stands in for it. `overflow-wrap: anywhere` keeps long bare URLs from widening the panel
(`.answer` scrolls on overflow). No new colors.
**Code:**
```css
.answer-link { font-family: var(--mono); font-size: 12px; color: var(--text); text-decoration: underline; text-decoration-color: var(--dim); text-decoration-thickness: 1px; text-underline-offset: 2px; overflow-wrap: anywhere; }
.answer-link:hover { color: var(--fg); text-decoration-color: var(--fg); }
```
**Impact:** visual only; the class is not used anywhere else.

### Step 5: Panel render tests
**File:** `web/src/components/AnswerPanel.test.tsx` (new, jsdom pragma on line 1, same setup as `NoteCard.test.tsx`)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { AnswerPanel } from './AnswerPanel';
import type { AnswerPanelProps } from './AnswerPanel';

afterEach(cleanup);

function props(over: Partial<AnswerPanelProps> = {}): AnswerPanelProps {
  return {
    left: 0,
    query: 'what did I read',
    text: '',
    done: true,
    status: '',
    brain: null,
    pinned: false,
    usedIds: [],
    onTogglePin: vi.fn(),
    onClose: vi.fn(),
    onJump: vi.fn(),
    ...over,
  };
}

function renderPanel(over: Partial<AnswerPanelProps> = {}) {
  return render(<AnswerPanel {...props(over)} />);
}

function body(container: HTMLElement): HTMLElement {
  const el = container.querySelector('.answer-body');
  if (!(el instanceof HTMLElement)) throw new Error('no .answer-body');
  return el;
}

describe('AnswerPanel links', () => {
  it('renders markdown links and bare URLs as real anchors that open in a new tab', () => {
    const { container } = renderPanel({
      text: 'Try the [BookBrowse summary](https://www.bookbrowse.com/x).\n\nAlso https://example.com/a, which helps.',
    });
    const links = [...body(container).querySelectorAll('a')];
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['BookBrowse summary', 'https://www.bookbrowse.com/x'],
      ['https://example.com/a', 'https://example.com/a'],
    ]);
    for (const a of links) {
      expect(a.className).toBe('answer-link');
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noreferrer noopener');
    }
    expect(body(container).querySelectorAll('p')).toHaveLength(2);
    expect(body(container).textContent).not.toContain('](');
  });

  it('keeps a javascript: link as text, with no anchor', () => {
    const { container } = renderPanel({ text: 'bad [x](javascript:alert(1)) here' });
    expect(body(container).querySelector('a')).toBeNull();
  });

  it('shows an unfinished link as plain label text while streaming, with the cursor', () => {
    const { container, rerender } = renderPanel({ text: 'See the [BookBrowse summ', done: false });
    expect(body(container).querySelector('a')).toBeNull();
    expect(body(container).textContent).toBe('See the BookBrowse summ ▍');

    rerender(<AnswerPanel {...props({ text: 'See the [BookBrowse summary](https://bo', done: false })} />);
    expect(body(container).querySelector('a')).toBeNull();
    expect(body(container).textContent).toBe('See the BookBrowse summary ▍');

    rerender(<AnswerPanel {...props({ text: 'See the [BookBrowse summary](https://bookbrowse.com/s).', done: true })} />);
    const a = body(container).querySelector('a');
    expect(a?.textContent).toBe('BookBrowse summary');
    expect(a?.getAttribute('href')).toBe('https://bookbrowse.com/s');
    expect(body(container).textContent).toBe('See the BookBrowse summary.');
  });

  it('puts the cursor only on the last paragraph while streaming', () => {
    const { container } = renderPanel({ text: 'one https://a.com\n\ntwo', done: false });
    const ps = [...body(container).querySelectorAll('p')].map((p) => p.textContent);
    expect(ps).toEqual(['one https://a.com', 'two ▍']);
  });
});
```
**Impact:** none outside tests.

## Verification

**Setup:** the worktree has no `node_modules`. Run `npm ci` at the worktree root before any other command.
**Build:** `npm run typecheck` (the web side is `tsc -p tsconfig.web.json`) and `npm run build:web`
**Tests:** `npx vitest run web/src/lib/links.test.tsx web/src/components/AnswerPanel.test.tsx`, then `npm test`
(Pre-checked during planning: both new files pass, 23 tests, and `tsc -p tsconfig.web.json` is clean on a scratch copy of the tree with these exact files.)
**Manual check:** `npm run dev:web` with the daemon running. Ask the chat bar something that needs a web
search, e.g. "summarize The Women by Kristin Hannah, cite sources". While the answer streams, no `[`,
`](` or partial URL should flash. Once done, the cited sources show as underlined mono links that open
in a new tab. A long bare URL wraps inside the panel.
**Exit criteria:** markdown links `[text](https://…)` render as an underlined `<a>` showing the text, and
bare `http(s)://` URLs render as underlined links. Both have `target="_blank"` and `rel="noreferrer noopener"`
and are styled with `.answer-link`. The rendered answer text never contains `](` for an http(s) link.
Unfinished links while streaming show as plain label text. `javascript:` and other schemes never become anchors.

## Handoffs

- None required. Out of R4's scope and left alone on purpose: the system prompt's link guidance
  (`src/chat/prompt.ts`, Phase 5's area), which the index decided to leave unchanged for links.
- Not done (possible follow-up, no phase owns it): `<https://…>` autolinks keep their angle brackets as
  text around the link, and markdown link titles `[x](url "title")` are not parsed (they stay plain text).
  Neither has shown up in real answers.

## Rollback

Delete `web/src/lib/links.ts`, `web/src/lib/links.test.tsx` and `web/src/components/AnswerPanel.test.tsx`.
Revert `web/src/components/AnswerPanel.tsx` and the two `.answer-link` lines in `web/src/styles.css`
(`git checkout <base> -- web/src/components/AnswerPanel.tsx web/src/styles.css`). No other phase depends
on any of it.
