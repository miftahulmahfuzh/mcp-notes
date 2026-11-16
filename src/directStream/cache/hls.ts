import { absoluteHttp } from '../rewrite.js';

/**
 * HLS as the stream cache reads and writes it. Pure functions: a master playlist's renditions; a
 * media playlist's segments with their keys, init sections and byte ranges (every address made
 * absolute against the playlist's own address, the rule rewrite.ts uses for the pass-through); the
 * choice of rendition and audio; and the local playlists that name the cached files. What a cache
 * cannot hold throws HlsUnsupported. Messages never carry an address (they can hold a token).
 */

export interface ByteRange {
  length: number;
  offset: number;
}

export interface HlsVariant {
  url: string;
  bandwidth: number;
  averageBandwidth: number | null;
  width: number | null;
  height: number | null;
  codecs: string | null;
  frameRate: string | null;
  /** The AUDIO group the variant plays with; null: none (the audio is muxed, or there is none). */
  audioGroup: string | null;
}

export interface HlsRendition {
  type: string;
  groupId: string;
  name: string | null;
  language: string | null;
  isDefault: boolean;
  channels: string | null;
  /** Null: no URI (the rendition is muxed into the variant), or not http(s). */
  url: string | null;
}

export interface HlsMaster {
  variants: HlsVariant[];
  media: HlsRendition[];
  independentSegments: boolean;
}

/** An AES-128 key (the only method a cache holds). */
export interface HlsKey {
  /** The key file to download; null for a `data:` URI, kept as it is in `inline`. */
  url: string | null;
  inline: string | null;
  iv: string | null;
  keyFormat: string | null;
  keyFormatVersions: string | null;
}

export interface HlsMap {
  url: string;
  range: ByteRange | null;
}

export interface HlsSegment {
  url: string;
  duration: number;
  /** What follows the comma of #EXTINF. */
  title: string;
  range: ByteRange | null;
  /** Index into HlsMedia.keys; null: not encrypted. */
  key: number | null;
  /** Index into HlsMedia.maps; null: no init section. */
  map: number | null;
  /** #EXT-X-DISCONTINUITY, #EXT-X-PROGRAM-DATE-TIME, #EXT-X-GAP, #EXT-X-BITRATE lines before it, verbatim. */
  tags: string[];
  gap: boolean;
}

export interface HlsMedia {
  version: number | null;
  targetDuration: number;
  mediaSequence: number;
  discontinuitySequence: number | null;
  independentSegments: boolean;
  /** The #EXT-X-START attribute list, verbatim. */
  start: string | null;
  keys: HlsKey[];
  maps: HlsMap[];
  segments: HlsSegment[];
}

export type HlsUnsupportedReason = 'drm' | 'live' | 'not_a_playlist' | 'empty';

export class HlsUnsupported extends Error {
  override readonly name = 'HlsUnsupported';
  constructor(
    readonly reason: HlsUnsupportedReason,
    message: string,
  ) {
    super(message);
  }
}

const ATTRIBUTE = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;

/** `NAME="x",BANDWIDTH=1` to a map; quotes are taken off. */
export function parseAttributes(list: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of list.matchAll(ATTRIBUTE)) {
    const raw = m[2] ?? '';
    out.set(m[1] ?? '', raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw);
  }
  return out;
}

function playlistLines(text: string): string[] {
  return text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** True for any HLS playlist: it starts with #EXTM3U (after a BOM). Its name and content type do not matter (VidNest's master.txt). */
export function isPlaylist(text: string): boolean {
  return text.replace(/^﻿/, '').trimStart().startsWith('#EXTM3U');
}

export function isMaster(text: string): boolean {
  return /^\s*#EXT-X-STREAM-INF:/m.test(text);
}

function splitTag(line: string): [string, string] {
  const colon = line.indexOf(':');
  return colon === -1 ? [line, ''] : [line.slice(0, colon), line.slice(colon + 1)];
}

function numberOr<T extends number | null>(value: string | undefined, fallback: T): number | T {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function parseMaster(text: string, base: string): HlsMaster {
  if (!isPlaylist(text)) throw new HlsUnsupported('not_a_playlist', 'the manifest is not an HLS playlist');
  const variants: HlsVariant[] = [];
  const media: HlsRendition[] = [];
  let independentSegments = false;
  let pending: Map<string, string> | null = null;
  for (const line of playlistLines(text)) {
    if (line.startsWith('#')) {
      const [tag, value] = splitTag(line);
      if (tag === '#EXT-X-INDEPENDENT-SEGMENTS') independentSegments = true;
      else if (tag === '#EXT-X-STREAM-INF') pending = parseAttributes(value);
      else if (tag === '#EXT-X-MEDIA') {
        const a = parseAttributes(value);
        const uri = a.get('URI');
        media.push({
          type: a.get('TYPE') ?? '',
          groupId: a.get('GROUP-ID') ?? '',
          name: a.get('NAME') ?? null,
          language: a.get('LANGUAGE') ?? null,
          isDefault: a.get('DEFAULT') === 'YES',
          channels: a.get('CHANNELS') ?? null,
          url: uri === undefined ? null : absoluteHttp(uri, base),
        });
      }
      continue;
    }
    if (pending === null) continue;
    const url = absoluteHttp(line, base);
    if (url !== null) {
      const resolution = /^(\d+)x(\d+)$/.exec(pending.get('RESOLUTION') ?? '');
      variants.push({
        url,
        bandwidth: numberOr(pending.get('BANDWIDTH'), 0),
        averageBandwidth: numberOr(pending.get('AVERAGE-BANDWIDTH'), null),
        width: resolution === null ? null : Number(resolution[1]),
        height: resolution === null ? null : Number(resolution[2]),
        codecs: pending.get('CODECS') ?? null,
        frameRate: pending.get('FRAME-RATE') ?? null,
        audioGroup: pending.get('AUDIO') ?? null,
      });
    }
    pending = null;
  }
  if (variants.length === 0) throw new HlsUnsupported('empty', 'the master playlist names no rendition');
  return { variants, media, independentSegments };
}

/**
 * The rendition to cache: the tallest, or the tallest not above `maxHeight`; among equal heights the
 * widest bandwidth. With no rendition at or under `maxHeight`, the shortest one. Renditions without
 * a RESOLUTION count only when none has one, and then by bandwidth.
 */
export function pickVariant(variants: readonly HlsVariant[], maxHeight: number | null): HlsVariant {
  const better = (a: HlsVariant, b: HlsVariant): number => (b.height ?? -1) - (a.height ?? -1) || b.bandwidth - a.bandwidth;
  const sized = variants.filter((v) => v.height !== null).sort(better);
  const tallest = sized[0];
  if (tallest === undefined) {
    const widest = [...variants].sort(better)[0];
    if (widest === undefined) throw new HlsUnsupported('empty', 'the master playlist names no rendition');
    return widest;
  }
  if (maxHeight === null) return tallest;
  return sized.find((v) => (v.height ?? 0) <= maxHeight) ?? sized[sized.length - 1] ?? tallest;
}

/** What audio a cache wants: the resolver's original-language track, and the title's original language. */
export interface AudioWanted {
  track: { lang: string | null; label: string | null } | null;
  lang: string | null;
}

/**
 * The audio rendition a cache takes from a variant's group, as the player would pick it
 * (web/src/stream/engine.ts audioTrackIndex): the session's original-language track (same LANGUAGE
 * and NAME, else same LANGUAGE; a track without a language by its NAME), else the title's original
 * language by primary subtag, else the group's DEFAULT, else its first. Null: no group, or an empty one.
 */
export function pickAudio(media: readonly HlsRendition[], group: string | null, wanted: AudioWanted): HlsRendition | null {
  if (group === null) return null;
  const tracks = media.filter((m) => m.type === 'AUDIO' && m.groupId === group);
  if (tracks.length === 0) return null;
  const lower = (s: string | null): string => (s ?? '').toLowerCase();
  const track = wanted.track;
  if (track !== null) {
    const exact = tracks.find((m) => lower(m.language) === lower(track.lang) && (m.name ?? '') === (track.label ?? ''));
    if (exact !== undefined) return exact;
    const near = track.lang === null ? tracks.find((m) => m.name === track.label) : tracks.find((m) => lower(m.language) === lower(track.lang));
    if (near !== undefined) return near;
  }
  if (wanted.lang !== null) {
    const want = wanted.lang.toLowerCase();
    const original = tracks.find((m) => (lower(m.language).split(/[-_]/)[0] ?? '') === want);
    if (original !== undefined) return original;
  }
  return tracks.find((m) => m.isDefault) ?? tracks[0] ?? null;
}

function parseRangeTag(value: string): { length: number; offset: number | null } {
  const m = /^(\d+)(?:@(\d+))?$/.exec(value.trim());
  if (m === null) throw new HlsUnsupported('not_a_playlist', 'a byte range is malformed');
  return { length: Number(m[1]), offset: m[2] === undefined ? null : Number(m[2]) };
}

function keyIndex(media: HlsMedia, a: Map<string, string>, base: string): number | null {
  const method = (a.get('METHOD') ?? 'NONE').toUpperCase();
  if (method === 'NONE') return null;
  const keyFormat = a.get('KEYFORMAT') ?? null;
  if (method !== 'AES-128' || (keyFormat !== null && keyFormat.toLowerCase() !== 'identity')) {
    throw new HlsUnsupported('drm', `the stream is encrypted with ${method}${keyFormat === null ? '' : ` (${keyFormat})`}, which a cache cannot hold`);
  }
  const uri = a.get('URI') ?? '';
  const inline = /^data:/i.test(uri) ? uri : null;
  const url = inline === null ? absoluteHttp(uri, base) : null;
  if (inline === null && url === null) throw new HlsUnsupported('drm', 'an AES-128 key has no http(s) address');
  const key: HlsKey = { url, inline, iv: a.get('IV') ?? null, keyFormat, keyFormatVersions: a.get('KEYFORMATVERSIONS') ?? null };
  const same = media.keys.findIndex(
    (k) => k.url === key.url && k.inline === key.inline && k.iv === key.iv && k.keyFormat === key.keyFormat && k.keyFormatVersions === key.keyFormatVersions,
  );
  if (same !== -1) return same;
  media.keys.push(key);
  return media.keys.length - 1;
}

function mapIndex(media: HlsMedia, a: Map<string, string>, base: string): number {
  const url = absoluteHttp(a.get('URI') ?? '', base);
  if (url === null) throw new HlsUnsupported('not_a_playlist', 'an EXT-X-MAP has no http(s) address');
  const raw = a.get('BYTERANGE');
  let range: ByteRange | null = null;
  if (raw !== undefined) {
    const r = parseRangeTag(raw);
    range = { length: r.length, offset: r.offset ?? 0 };
  }
  const same = media.maps.findIndex((m) => m.url === url && m.range?.offset === range?.offset && m.range?.length === range?.length);
  if (same !== -1) return same;
  media.maps.push({ url, range });
  return media.maps.length - 1;
}

/**
 * A media playlist. Throws HlsUnsupported for DRM (SAMPLE-AES, another KEYFORMAT), a live
 * playlist (no #EXT-X-ENDLIST), no segment, or a playlist that is malformed.
 */
export function parseMedia(text: string, base: string): HlsMedia {
  if (!isPlaylist(text)) throw new HlsUnsupported('not_a_playlist', 'the playlist does not start with #EXTM3U');
  const media: HlsMedia = {
    version: null,
    targetDuration: 0,
    mediaSequence: 0,
    discontinuitySequence: null,
    independentSegments: false,
    start: null,
    keys: [],
    maps: [],
    segments: [],
  };
  let key: number | null = null;
  let map: number | null = null;
  let duration: number | null = null;
  let title = '';
  let range: { length: number; offset: number | null } | null = null;
  let tags: string[] = [];
  let gap = false;
  let ended = false;
  let previous: { url: string; end: number } | null = null;
  for (const line of playlistLines(text)) {
    if (!line.startsWith('#')) {
      const url = absoluteHttp(line, base);
      if (url === null) throw new HlsUnsupported('not_a_playlist', 'a segment address is not http(s)');
      if (duration === null) throw new HlsUnsupported('not_a_playlist', 'a segment has no #EXTINF');
      let segmentRange: ByteRange | null = null;
      if (range !== null) {
        const offset: number | null = range.offset ?? (previous !== null && previous.url === url ? previous.end : null);
        if (offset === null) throw new HlsUnsupported('not_a_playlist', 'a byte range without an offset follows no range of the same file');
        segmentRange = { length: range.length, offset };
        previous = { url, end: offset + range.length };
      } else previous = null;
      media.segments.push({ url, duration, title, range: segmentRange, key, map, tags, gap });
      duration = null;
      title = '';
      range = null;
      tags = [];
      gap = false;
      continue;
    }
    const [tag, value] = splitTag(line);
    switch (tag) {
      case '#EXT-X-VERSION':
        media.version = numberOr(value, null);
        break;
      case '#EXT-X-TARGETDURATION':
        media.targetDuration = numberOr(value, 0);
        break;
      case '#EXT-X-MEDIA-SEQUENCE':
        media.mediaSequence = numberOr(value, 0);
        break;
      case '#EXT-X-DISCONTINUITY-SEQUENCE':
        media.discontinuitySequence = numberOr(value, null);
        break;
      case '#EXT-X-INDEPENDENT-SEGMENTS':
        media.independentSegments = true;
        break;
      case '#EXT-X-START':
        media.start = value;
        break;
      case '#EXT-X-ENDLIST':
        ended = true;
        break;
      case '#EXTINF': {
        const comma = value.indexOf(',');
        const d = Number(comma === -1 ? value : value.slice(0, comma));
        if (!Number.isFinite(d) || d < 0) throw new HlsUnsupported('not_a_playlist', 'an #EXTINF duration is malformed');
        duration = d;
        title = comma === -1 ? '' : value.slice(comma + 1);
        break;
      }
      case '#EXT-X-BYTERANGE':
        range = parseRangeTag(value);
        break;
      case '#EXT-X-KEY':
        key = keyIndex(media, parseAttributes(value), base);
        break;
      case '#EXT-X-MAP':
        map = mapIndex(media, parseAttributes(value), base);
        break;
      case '#EXT-X-GAP':
        tags.push(line);
        gap = true;
        break;
      case '#EXT-X-DISCONTINUITY':
      case '#EXT-X-PROGRAM-DATE-TIME':
      case '#EXT-X-BITRATE':
        tags.push(line);
        break;
      default:
        // EXT-X-PLAYLIST-TYPE (the copy is always VOD), EXT-X-DATERANGE, cue marks and unknown tags are dropped.
        break;
    }
  }
  if (!ended) throw new HlsUnsupported('live', 'the playlist has no #EXT-X-ENDLIST: a live stream cannot be cached');
  if (media.segments.length === 0) throw new HlsUnsupported('empty', 'the playlist lists no segment');
  return media;
}

/** `v`: the video playlist's files; `a`: the separate audio rendition's. */
export type TrackPrefix = 'v' | 'a';

/** The local name of the i-th segment (1-based position in its playlist). */
export function segmentName(prefix: TrackPrefix, index: number, ext: string): string {
  return `${prefix}-${String(index).padStart(5, '0')}.${ext}`;
}

/** The local name of the k-th init section (k from 0). */
export function initName(prefix: TrackPrefix, k: number): string {
  return `${prefix}-init-${k + 1}.mp4`;
}

/** The local name of the k-th key (k from 0). */
export function keyName(prefix: TrackPrefix, k: number): string {
  return `${prefix}-key-${k + 1}.key`;
}

/** A playlist's segment extension on disk: fMP4 (an init section) is m4s, raw ADTS audio aac, the rest MPEG-TS. */
export function segmentExt(media: HlsMedia): 'm4s' | 'aac' | 'ts' {
  if (media.maps.length > 0) return 'm4s';
  const first = media.segments[0];
  return first !== undefined && /\.aac$/i.test(new URL(first.url).pathname) ? 'aac' : 'ts';
}

function formatDuration(d: number): string {
  return Number.isInteger(d) ? d.toFixed(1) : String(Number(d.toFixed(6)));
}

function keyLine(k: HlsKey, index: number, prefix: TrackPrefix): string {
  const attrs = ['METHOD=AES-128', `URI="${k.inline ?? keyName(prefix, index)}"`];
  if (k.iv !== null) attrs.push(`IV=${k.iv}`);
  if (k.keyFormat !== null) attrs.push(`KEYFORMAT="${k.keyFormat}"`);
  if (k.keyFormatVersions !== null) attrs.push(`KEYFORMATVERSIONS="${k.keyFormatVersions}"`);
  return `#EXT-X-KEY:${attrs.join(',')}`;
}

/**
 * The local copy of a media playlist: every segment by its position, named relatively, VOD with
 * ENDLIST. The media sequence is kept (a key without IV uses it), byte ranges become files.
 */
export function localMediaPlaylist(media: HlsMedia, prefix: TrackPrefix): string {
  const ext = segmentExt(media);
  const longest = media.segments.reduce((max, s) => Math.max(max, s.duration), 0);
  const out = [
    '#EXTM3U',
    `#EXT-X-VERSION:${Math.max(media.version ?? 3, media.maps.length > 0 ? 6 : 3)}`,
    `#EXT-X-TARGETDURATION:${Math.max(media.targetDuration, Math.ceil(longest))}`,
    `#EXT-X-MEDIA-SEQUENCE:${media.mediaSequence}`,
  ];
  if (media.discontinuitySequence !== null) out.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${media.discontinuitySequence}`);
  out.push('#EXT-X-PLAYLIST-TYPE:VOD');
  if (media.independentSegments) out.push('#EXT-X-INDEPENDENT-SEGMENTS');
  if (media.start !== null) out.push(`#EXT-X-START:${media.start}`);
  let key: number | null = null;
  let map: number | null = null;
  media.segments.forEach((s, i) => {
    for (const tag of s.tags) if (tag === '#EXT-X-DISCONTINUITY') out.push(tag);
    if (s.key !== key) {
      const k = s.key === null ? undefined : media.keys[s.key];
      out.push(k === undefined ? '#EXT-X-KEY:METHOD=NONE' : keyLine(k, s.key ?? 0, prefix));
      key = s.key;
    }
    if (s.map !== null && s.map !== map) out.push(`#EXT-X-MAP:URI="${initName(prefix, s.map)}"`);
    map = s.map;
    for (const tag of s.tags) if (tag !== '#EXT-X-DISCONTINUITY') out.push(tag);
    out.push(`#EXTINF:${formatDuration(s.duration)},${s.title}`, segmentName(prefix, i + 1, ext));
  });
  out.push('#EXT-X-ENDLIST', '');
  return out.join('\n');
}

const quoted = (s: string): string => s.replace(/"/g, "'");

/** What the local master names of the cached variant. */
export type MasterVariant = Pick<HlsVariant, 'bandwidth' | 'averageBandwidth' | 'width' | 'height' | 'codecs' | 'frameRate'>;

/** The local master: the one cached variant (video.m3u8), with its audio rendition (audio.m3u8) when that is separate. */
export function localMaster(variant: MasterVariant, audio: HlsRendition | null, independentSegments: boolean): string {
  const out = ['#EXTM3U', '#EXT-X-VERSION:3'];
  if (independentSegments) out.push('#EXT-X-INDEPENDENT-SEGMENTS');
  if (audio !== null) {
    const attrs = ['TYPE=AUDIO', 'GROUP-ID="audio"', `NAME="${quoted(audio.name ?? 'Audio')}"`];
    if (audio.language !== null) attrs.push(`LANGUAGE="${quoted(audio.language)}"`);
    attrs.push('DEFAULT=YES', 'AUTOSELECT=YES');
    if (audio.channels !== null) attrs.push(`CHANNELS="${quoted(audio.channels)}"`);
    attrs.push('URI="audio.m3u8"');
    out.push(`#EXT-X-MEDIA:${attrs.join(',')}`);
  }
  const inf = [`BANDWIDTH=${Math.max(1, Math.round(variant.bandwidth))}`];
  if (variant.averageBandwidth !== null) inf.push(`AVERAGE-BANDWIDTH=${variant.averageBandwidth}`);
  if (variant.width !== null && variant.height !== null) inf.push(`RESOLUTION=${variant.width}x${variant.height}`);
  if (variant.codecs !== null) inf.push(`CODECS="${quoted(variant.codecs)}"`);
  if (variant.frameRate !== null) inf.push(`FRAME-RATE=${variant.frameRate}`);
  if (audio !== null) inf.push('AUDIO="audio"');
  out.push(`#EXT-X-STREAM-INF:${inf.join(',')}`, 'video.m3u8', '');
  return out.join('\n');
}
