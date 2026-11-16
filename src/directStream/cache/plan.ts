import { createHash } from 'node:crypto';
import {
  initName,
  keyName,
  localMaster,
  localMediaPlaylist,
  segmentExt,
  segmentName,
  type ByteRange,
  type HlsMedia,
  type HlsRendition,
  type HlsVariant,
  type MasterVariant,
  type TrackPrefix,
} from './hls.js';

/** A plain file is downloaded in chunks of this size, each its own resumable file. */
export const MP4_CHUNK_BYTES = 4 * 1024 * 1024;

export function chunkName(index: number): string {
  return `c-${String(index).padStart(5, '0')}.bin`;
}

/** One file of a cache and where it comes from. Addresses live in memory only, never on disk. */
export interface CacheFile {
  url: string;
  range: ByteRange | null;
  /** A media segment (or a plain-file chunk): counted in segments_total. */
  counts: boolean;
  /** Seconds into the title, for the download order; -1 for keys and init sections (first). */
  start: number;
}

/** What one resolve's source becomes on disk. */
export interface CachePlan {
  kind: 'hls' | 'mp4';
  provider: string;
  height: number | null;
  audioLang: string | null;
  durationS: number | null;
  /** A plain file's size; null for HLS. */
  size: number | null;
  /** A plain file's chunk size; null for HLS. */
  chunkBytes: number | null;
  files: Map<string, CacheFile>;
  /** Download order: keys and init sections, then by time, audio beside video. */
  order: string[];
  /** EXT-X-GAP segments: counted done, never downloaded. */
  gaps: number;
  segmentsTotal: number;
  /** Local playlists, written before any segment. */
  playlists: { name: string; text: string }[];
  /**
   * The source's shape (provider, rendition, every segment's duration and range): two resolves
   * with the same signature name the same segments by index, so the files on disk carry over.
   */
  signature: string;
}

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const shape = (m: HlsMedia): unknown[] =>
  m.segments.map((s) => [Math.round(s.duration * 1000), s.range?.offset ?? null, s.range?.length ?? null, s.gap, s.key, s.map]);

export interface HlsPlanInput {
  provider: string;
  /** Null: the manifest was a media playlist. */
  variant: HlsVariant | null;
  /** The separate audio rendition, with `audio` its playlist; both null when the audio is muxed. */
  audioRendition: HlsRendition | null;
  video: HlsMedia;
  audio: HlsMedia | null;
  independentSegments: boolean;
  bestHeight: number | null;
  audioLang: string | null;
}

export function hlsPlan(input: HlsPlanInput): CachePlan {
  const files = new Map<string, CacheFile>();
  let gaps = 0;
  let segmentsTotal = 0;
  const addTrack = (media: HlsMedia, prefix: TrackPrefix): void => {
    const ext = segmentExt(media);
    media.maps.forEach((m, k) => files.set(initName(prefix, k), { url: m.url, range: m.range, counts: false, start: -1 }));
    media.keys.forEach((key, k) => {
      if (key.url !== null) files.set(keyName(prefix, k), { url: key.url, range: null, counts: false, start: -1 });
    });
    let at = 0;
    media.segments.forEach((s, i) => {
      segmentsTotal += 1;
      if (s.gap) gaps += 1;
      else files.set(segmentName(prefix, i + 1, ext), { url: s.url, range: s.range, counts: true, start: at });
      at += s.duration;
    });
  };
  addTrack(input.video, 'v');
  if (input.audio !== null) addTrack(input.audio, 'a');
  const order = [...files.entries()].sort(([an, a], [bn, b]) => a.start - b.start || an.localeCompare(bn)).map(([name]) => name);
  const audioRendition = input.audio === null ? null : input.audioRendition;
  const variant: MasterVariant = input.variant ?? { bandwidth: 1, averageBandwidth: null, width: null, height: null, codecs: null, frameRate: null };
  const height = input.variant?.height ?? input.bestHeight;
  const playlists = [
    { name: 'master.m3u8', text: localMaster(variant, audioRendition, input.independentSegments) },
    { name: 'video.m3u8', text: localMediaPlaylist(input.video, 'v') },
    ...(input.audio === null ? [] : [{ name: 'audio.m3u8', text: localMediaPlaylist(input.audio, 'a') }]),
  ];
  const durationS = Math.round(input.video.segments.reduce((t, s) => t + s.duration, 0) * 1000) / 1000;
  return {
    kind: 'hls',
    provider: input.provider,
    height,
    audioLang: input.audioLang,
    durationS,
    size: null,
    chunkBytes: null,
    files,
    order,
    gaps,
    segmentsTotal,
    playlists,
    signature: digest({ provider: input.provider, kind: 'hls', height, video: shape(input.video), audio: input.audio === null ? null : shape(input.audio) }),
  };
}

export interface Mp4PlanInput {
  provider: string;
  url: string;
  /** Bytes, from the host's Content-Range; above 0. */
  size: number;
  chunkBytes: number;
  bestHeight: number | null;
  audioLang: string | null;
}

export function mp4Plan(input: Mp4PlanInput): CachePlan {
  const files = new Map<string, CacheFile>();
  const chunks = Math.max(1, Math.ceil(input.size / input.chunkBytes));
  for (let i = 1; i <= chunks; i += 1) {
    const offset = (i - 1) * input.chunkBytes;
    files.set(chunkName(i), { url: input.url, range: { offset, length: Math.min(input.chunkBytes, input.size - offset) }, counts: true, start: i });
  }
  return {
    kind: 'mp4',
    provider: input.provider,
    height: input.bestHeight,
    audioLang: input.audioLang,
    durationS: null,
    size: input.size,
    chunkBytes: input.chunkBytes,
    files,
    order: [...files.keys()],
    gaps: 0,
    segmentsTotal: chunks,
    playlists: [],
    signature: digest({ provider: input.provider, kind: 'mp4', size: input.size, chunkBytes: input.chunkBytes }),
  };
}
