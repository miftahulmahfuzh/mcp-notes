/**
 * Playlist and manifest rewriting for the pass-through (src/directStream/passThrough.ts). Every
 * address in an HLS playlist or a DASH manifest is made absolute against the address it was fetched
 * from and replaced by the pass-through route, so the player asks notesd for everything and notesd
 * adds the headers the stream host checks. `urls` lists the absolute addresses found, so the session
 * can allow their hosts (a host joins a session only by appearing in something fetched through it).
 */

export interface Rewritten {
  text: string;
  /** Every absolute http(s) address the text named, in order. */
  urls: string[];
}

/** The absolute http(s) address `ref` names (against `base` when given), or null. */
export function absoluteHttp(ref: string, base?: string): string | null {
  try {
    const url = base === undefined ? new URL(ref) : new URL(ref, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** DASH template identifiers: `$RepresentationID$`, `$Number$`, `$Number%05d$`, `$Time$`, `$Bandwidth$`, `$SubNumber$`, `$$`. */
const TEMPLATE_TOKEN = /(\$(?:RepresentationID|Number|Bandwidth|Time|SubNumber)?(?:%0\d+[dxXo])?\$)/;

/** encodeURIComponent, except DASH template identifiers stay as they are, so the player can still fill them in. */
export function encodeTarget(target: string): string {
  return target
    .split(TEMPLATE_TOKEN)
    .map((part, i) => (i % 2 === 1 ? part : encodeURIComponent(part)))
    .join('');
}

/** The pass-through address of `target` in session `sessionId`, relative to the daemon's origin. */
export function proxiedUrl(sessionId: string, target: string, options: { vtt?: boolean } = {}): string {
  return `/api/stream/sessions/${sessionId}/p?u=${encodeTarget(target)}${options.vtt === true ? '&vtt=1' : ''}`;
}

/**
 * An HLS playlist (master or media) with every address line and every `URI="..."` attribute
 * (EXT-X-MEDIA, EXT-X-KEY, EXT-X-MAP, EXT-X-I-FRAME-STREAM-INF, ...) sent through the pass-through.
 * A URI that is not http(s) after resolving (`skd://`, `data:`) is left as it is.
 */
export function rewriteHls(text: string, base: string, sessionId: string): Rewritten {
  const urls: string[] = [];
  const through = (ref: string): string | null => {
    const abs = absoluteHttp(ref, base);
    if (abs === null) return null;
    urls.push(abs);
    return proxiedUrl(sessionId, abs);
  };
  const lines = text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (trimmed === '') return line;
    if (trimmed.startsWith('#')) {
      return line.replace(/URI="([^"]*)"/g, (whole: string, ref: string) => {
        const proxied = through(ref);
        return proxied === null ? whole : `URI="${proxied}"`;
      });
    }
    return through(trimmed) ?? line;
  });
  return { text: lines.join('\n'), urls };
}

const XML_UNESCAPES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

function xmlUnescape(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_UNESCAPES[m] ?? m);
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const DASH_TAG = /<(\/?)([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const DASH_ATTR = /(\s)([A-Za-z_][\w.:-]*)(\s*=\s*)(?:"([^"]*)"|'([^']*)')/g;
/** Attributes that hold an address, per element (local name). `xlink:href` counts on every element. */
const URL_ATTRIBUTES: Record<string, readonly string[]> = {
  SegmentTemplate: ['media', 'initialization', 'index'],
  SegmentURL: ['media', 'index'],
  Initialization: ['sourceURL'],
  RepresentationIndex: ['sourceURL'],
  BitstreamSwitching: ['sourceURL'],
};
/** Elements whose text is an address. */
const TEXT_URL_ELEMENTS = new Set(['BaseURL', 'Location']);

/**
 * A DASH manifest with `BaseURL` and `Location` texts, segment templates (`media`, `initialization`,
 * `index`), `SegmentURL`, `Initialization`, `RepresentationIndex`, `BitstreamSwitching` and
 * `xlink:href` sent through the pass-through. A `BaseURL` is resolved against the base in force for
 * its parent element and becomes that element's base, as DASH nests them. Template identifiers
 * (`$Number%05d$`) are kept for the player to fill in.
 */
export function rewriteDash(text: string, base: string, sessionId: string): Rewritten {
  const urls: string[] = [];
  const resolve = (ref: string, against: string): string | null => {
    const abs = absoluteHttp(ref.trim(), against);
    if (abs !== null) urls.push(abs);
    return abs;
  };
  // bases[i] is the base in force inside the i-th open element; bases[0] is the manifest's address.
  const bases: string[] = [base];
  const tag = new RegExp(DASH_TAG.source, 'g');
  let out = '';
  let last = 0;
  for (let m = tag.exec(text); m !== null; m = tag.exec(text)) {
    const whole = m[0];
    const closing = m[1] === '/';
    const rawName = m[2] ?? '';
    const attrs = m[3] ?? '';
    const selfClosing = m[4] === '/';
    const name = rawName.includes(':') ? rawName.slice(rawName.indexOf(':') + 1) : rawName;
    out += text.slice(last, m.index);
    last = m.index + whole.length;
    if (closing) {
      if (bases.length > 1) bases.pop();
      out += whole;
      continue;
    }
    const current = bases[bases.length - 1] ?? base;
    if (TEXT_URL_ELEMENTS.has(name) && !selfClosing) {
      const end = text.indexOf('</', last);
      const closeEnd = end === -1 ? -1 : text.indexOf('>', end);
      if (closeEnd === -1) {
        out += whole;
        continue;
      }
      const inner = text.slice(last, end);
      const abs = resolve(xmlUnescape(inner), current);
      out += whole + (abs === null ? inner : xmlEscape(proxiedUrl(sessionId, abs))) + text.slice(end, closeEnd + 1);
      last = closeEnd + 1;
      tag.lastIndex = last;
      // A BaseURL sets the base of its parent element (the one on top of `bases`) for what follows.
      if (abs !== null && name === 'BaseURL') bases[bases.length - 1] = abs;
      continue;
    }
    const wanted = URL_ATTRIBUTES[name] ?? [];
    const rewritten = attrs.replace(
      DASH_ATTR,
      (attr: string, space: string, attrName: string, eq: string, dq: string | undefined, sq: string | undefined) => {
        if (!wanted.includes(attrName) && attrName !== 'xlink:href') return attr;
        const abs = resolve(xmlUnescape(dq ?? sq ?? ''), current);
        return abs === null ? attr : `${space}${attrName}${eq}"${xmlEscape(proxiedUrl(sessionId, abs))}"`;
      },
    );
    out += `<${rawName}${rewritten}${selfClosing ? '/' : ''}>`;
    if (!selfClosing) bases.push(current);
  }
  return { text: out + text.slice(last), urls };
}

/** SubRip to WebVTT (a page shows only WebVTT). A file that already is WebVTT is returned as it is. */
export function srtToVtt(text: string): string {
  const body = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (body.trimStart().startsWith('WEBVTT')) return body;
  return `WEBVTT\n\n${body.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2').trim()}\n`;
}
