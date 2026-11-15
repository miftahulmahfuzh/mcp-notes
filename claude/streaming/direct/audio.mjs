// Which languages a resolved stream speaks, so a dub is never played for the original. The
// manifest's audio tracks answer first; a stream with one muxed audio is asked through its first
// media segment (an MPEG-TS programme table, or an MP4 track header). Reads only: at most three
// small requests, with the headers the real Chrome's manifest request carried.
import { languagesOf, normalizeLang } from './lang.mjs';

/** A probe never holds a resolve up longer than this. */
export const AUDIO_PROBE_TIMEOUT_MS = 8_000;
/** Bytes of a segment read at most: the tables sit at its start. */
export const AUDIO_PROBE_BYTES = 1_000_000;

const TS_PACKET = 188;
/** MPEG-TS stream types that carry audio (MPEG-1/2, AAC ADTS and LATM, AC-3, E-AC-3, DTS, private data). */
const TS_AUDIO_TYPES = new Set([0x03, 0x04, 0x0f, 0x11, 0x06, 0x81, 0x82, 0x87]);
const MP4_CONTAINERS = new Set(['moov', 'trak', 'mdia']);

function attributes(text) {
  const out = {};
  for (const m of text.matchAll(/([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g)) out[m[1]] = m[3] ?? m[2];
  return out;
}

function xmlAttr(text, name) {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(text)?.[1] ?? null;
}

/** The audio tracks a manifest names: `[{ lang, label }]` (lang as written; null when it has none). */
export function manifestAudioTracks(kind, body) {
  const tracks = [];
  if (kind === 'hls') {
    for (const line of String(body).split(/\r?\n/)) {
      if (!line.startsWith('#EXT-X-MEDIA:')) continue;
      const a = attributes(line.slice('#EXT-X-MEDIA:'.length));
      if (a.TYPE === 'AUDIO') tracks.push({ lang: a.LANGUAGE ?? null, label: a.NAME ?? null });
    }
  } else if (kind === 'dash') {
    for (const m of String(body).matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/g)) {
      const attrs = m[1] ?? '';
      const inner = m[2] ?? '';
      const mime = xmlAttr(attrs, 'mimeType') ?? xmlAttr(inner, 'mimeType') ?? '';
      if (xmlAttr(attrs, 'contentType') !== 'audio' && !mime.startsWith('audio/')) continue;
      tracks.push({ lang: xmlAttr(attrs, 'lang'), label: /<Label>([^<]*)<\/Label>/.exec(inner)?.[1] ?? null });
    }
  }
  return tracks;
}

/** A track's language: its tag, else its name ("Korean"). */
function trackLanguage(track) {
  return normalizeLang(track.lang) ?? normalizeLang(track.label);
}

/** The payload of the first packet of `pid` that starts a section, after its pointer field; null when none. */
function tsSection(bytes, pid) {
  for (let at = 0; at + TS_PACKET <= bytes.length; at += TS_PACKET) {
    if (bytes[at] !== 0x47) {
      // Lost sync: find the next packet start.
      const next = bytes.indexOf(0x47, at + 1);
      if (next === -1) return null;
      at = next - TS_PACKET;
      continue;
    }
    const packetPid = ((bytes[at + 1] & 0x1f) << 8) | bytes[at + 2];
    const starts = (bytes[at + 1] & 0x40) !== 0;
    if (packetPid !== pid || !starts) continue;
    const control = (bytes[at + 3] >> 4) & 0x3;
    if ((control & 0x1) === 0) continue;
    let offset = at + 4;
    if ((control & 0x2) !== 0) offset += 1 + bytes[offset];
    offset += 1 + bytes[offset];
    if (offset >= at + TS_PACKET) continue;
    return bytes.subarray(offset, at + TS_PACKET);
  }
  return null;
}

/** The languages of the audio streams in an MPEG-TS segment's programme table, as written ("eng"). [] when it names none. */
export function tsAudioLanguages(bytes) {
  const pat = tsSection(bytes, 0);
  if (pat === null || pat[0] !== 0x00) return [];
  const patLength = ((pat[1] & 0x0f) << 8) | pat[2];
  let pmtPid = null;
  for (let at = 8; at + 4 <= Math.min(3 + patLength - 4, pat.length); at += 4) {
    const program = (pat[at] << 8) | pat[at + 1];
    if (program !== 0) {
      pmtPid = ((pat[at + 2] & 0x1f) << 8) | pat[at + 3];
      break;
    }
  }
  if (pmtPid === null) return [];
  const pmt = tsSection(bytes, pmtPid);
  if (pmt === null || pmt[0] !== 0x02) return [];
  const end = Math.min(3 + (((pmt[1] & 0x0f) << 8) | pmt[2]) - 4, pmt.length);
  const languages = [];
  let at = 12 + (((pmt[10] & 0x0f) << 8) | pmt[11]);
  while (at + 5 <= end) {
    const type = pmt[at];
    const infoLength = ((pmt[at + 3] & 0x0f) << 8) | pmt[at + 4];
    const infoEnd = Math.min(at + 5 + infoLength, end);
    for (let d = at + 5; d + 2 <= infoEnd; d += 2 + pmt[d + 1]) {
      // ISO_639_language_descriptor: three letters and an audio type.
      if (pmt[d] === 0x0a && pmt[d + 1] >= 3 && TS_AUDIO_TYPES.has(type)) {
        languages.push(String.fromCharCode(pmt[d + 2], pmt[d + 3], pmt[d + 4]));
      }
    }
    at = infoEnd;
  }
  return languages;
}

function mp4Boxes(bytes, start, end, visit) {
  let at = start;
  while (at + 8 <= end) {
    let size = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    let header = 8;
    if (size === 1 && at + 16 <= end) {
      size = Number(bytes.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header) return;
    const boxEnd = Math.min(at + size, end);
    visit(type, at + header, boxEnd);
    at += size;
  }
}

/** The languages of the sound tracks in an MP4 (or fragmented-MP4 init segment), as written ("kor"). */
export function mp4AudioLanguages(bytes) {
  const languages = [];
  const walk = (start, end, track) => {
    mp4Boxes(bytes, start, end, (type, from, to) => {
      if (type === 'trak') {
        const found = { lang: null, sound: false };
        walk(from, to, found);
        if (found.sound && found.lang !== null) languages.push(found.lang);
      } else if (MP4_CONTAINERS.has(type)) {
        walk(from, to, track);
      } else if (type === 'mdhd' && track !== null) {
        // version 0: 4 + 16 bytes before the packed language; version 1: 4 + 28.
        const at = from + (bytes[from] === 1 ? 32 : 20);
        if (at + 2 <= to) {
          const packed = bytes.readUInt16BE(at);
          const letters = [(packed >> 10) & 0x1f, (packed >> 5) & 0x1f, packed & 0x1f];
          if (letters.every((n) => n >= 1 && n <= 26)) track.lang = String.fromCharCode(...letters.map((n) => n + 0x60));
        }
      } else if (type === 'hdlr' && track !== null && from + 12 <= to) {
        track.sound = bytes.toString('latin1', from + 8, from + 12) === 'soun';
      }
    });
  };
  walk(0, bytes.length, null);
  return languages;
}

function absolute(address, base) {
  try {
    return new URL(address, base).href;
  } catch {
    return null;
  }
}

/** A media playlist's first thing to read: its init segment (`EXT-X-MAP`), else its first segment. */
export function firstSegment(playlist, base) {
  const map = /#EXT-X-MAP:[^\n]*URI="([^"]+)"/.exec(playlist)?.[1];
  if (map) return absolute(map, base);
  const line = playlist.split(/\r?\n/).find((l) => l.trim() !== '' && !l.startsWith('#'));
  return line === undefined ? null : absolute(line.trim(), base);
}

/** The first variant of a master playlist, or null when `body` is a media playlist already. */
export function firstVariant(body, base) {
  const lines = String(body).split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'));
  if (at === -1) return null;
  const uri = lines.slice(at + 1).find((l) => l.trim() !== '' && !l.startsWith('#'));
  return uri === undefined ? null : absolute(uri.trim(), base);
}

async function readSome(response, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    chunks.push(chunk);
    size += chunk.length;
    if (size >= limit) break;
  }
  return Buffer.concat(chunks).subarray(0, limit);
}

/**
 * The audio of a resolved source (pickSource's answer): `{ languages, tracks, named }`.
 * `languages` are the distinct languages it speaks, normalized ("ko"); [] when nothing says.
 * `tracks` is how many audio tracks the manifest names (0: one muxed audio) and `named` lists them
 * as written, each with its normalized `language`. Never throws: a failed read answers [].
 */
export async function probeAudio(found, { fetchImpl = fetch, timeoutMs = AUDIO_PROBE_TIMEOUT_MS } = {}) {
  const body = typeof found.manifest_body === 'string' ? found.manifest_body : '';
  const named = manifestAudioTracks(found.manifest_kind, body).map((t) => ({ ...t, language: trackLanguage(t) }));
  const fromManifest = languagesOf(named.map((t) => t.language));
  if (fromManifest.length > 0 || found.manifest_kind === 'dash') return { languages: fromManifest, tracks: named.length, named };
  const headers = {};
  if (found.headers?.referer) headers.referer = found.headers.referer;
  if (found.headers?.origin) headers.origin = found.headers.origin;
  if (found.headers?.user_agent) headers['user-agent'] = found.headers.user_agent;
  const signal = AbortSignal.timeout(timeoutMs);
  const get = async (url, extra = {}) => {
    const res = await fetchImpl(url, { headers: { ...headers, ...extra }, signal });
    if (!res.ok) throw new Error(`http_${res.status}`);
    return res;
  };
  try {
    let segment = found.manifest_url;
    if (found.manifest_kind === 'hls') {
      let playlist = body;
      let base = found.manifest_url;
      const variant = firstVariant(body, base);
      if (variant !== null) {
        playlist = await (await get(variant)).text();
        base = variant;
      } else if (!body.includes('#EXTINF')) {
        playlist = await (await get(base)).text();
        const inner = firstVariant(playlist, base);
        if (inner !== null) {
          playlist = await (await get(inner)).text();
          base = inner;
        }
      }
      segment = firstSegment(playlist, base);
      if (segment === null) return { languages: [], tracks: named.length, named };
    }
    const bytes = await readSome(await get(segment, { range: `bytes=0-${AUDIO_PROBE_BYTES - 1}` }), AUDIO_PROBE_BYTES);
    const raw = bytes[0] === 0x47 ? tsAudioLanguages(bytes) : mp4AudioLanguages(bytes);
    return { languages: languagesOf(raw), tracks: named.length, named };
  } catch {
    return { languages: [], tracks: named.length, named };
  }
}

/**
 * Whether a source's audio is the title's original language: true (one of its languages is),
 * false (it names languages and none is: a dub), null (nothing says, or no language was asked for).
 */
export function isOriginalAudio(languages, wanted) {
  const original = normalizeLang(wanted);
  if (original === null || languages.length === 0) return null;
  return languages.includes(original);
}
