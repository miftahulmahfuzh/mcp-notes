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
