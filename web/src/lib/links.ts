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
