import { PLAYLIST_MAX_BYTES, type FetchLike } from '../passThrough.js';
import { srtToVtt } from '../rewrite.js';
import type { StreamSession } from '../sessions.js';
import { isEnglish, type SubtitleTrack } from '../types.js';
import { parseMedia } from './hls.js';
import { fetchUpstream } from './upstream.js';

/** A subtitle playlist is read up to this many segments, eight at a time. */
const SUBTITLE_MAX_SEGMENTS = 1_500;
const SUBTITLE_PARALLEL = 8;

const decode = (body: Buffer): string => new TextDecoder().decode(body);

/** WebVTT segments of an HLS subtitle playlist as one file: one header, every segment's cues in order. */
export function joinVtt(parts: readonly string[]): string {
  const cues = parts
    .map((part) => {
      const body = part.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
      if (!body.trimStart().startsWith('WEBVTT')) return body.trim();
      const blank = body.indexOf('\n\n');
      return blank === -1 ? '' : body.slice(blank + 2).trim();
    })
    .filter((cue) => cue !== '');
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

async function readTrack(fetchImpl: FetchLike, session: StreamSession, track: SubtitleTrack, signal: AbortSignal): Promise<string | null> {
  const get = async (url: string): Promise<{ text: string; url: string } | null> => {
    const got = await fetchUpstream(fetchImpl, session, url, { range: null, maxBytes: PLAYLIST_MAX_BYTES, signal });
    return got.kind === 'ok' ? { text: decode(got.body), url: got.url } : null;
  };
  if (track.format === 'hls') {
    const playlist = await get(track.url);
    if (playlist === null) return null;
    const urls = parseMedia(playlist.text, playlist.url)
      .segments.slice(0, SUBTITLE_MAX_SEGMENTS)
      .map((s) => s.url);
    const parts: string[] = [];
    for (let i = 0; i < urls.length; i += SUBTITLE_PARALLEL) {
      const got = await Promise.all(urls.slice(i, i + SUBTITLE_PARALLEL).map((url) => get(url)));
      for (const g of got) if (g !== null) parts.push(g.text);
    }
    return parts.length === 0 ? null : joinVtt(parts);
  }
  if (track.format !== 'vtt' && track.format !== 'srt' && !/\.(vtt|srt)$/i.test(new URL(track.url).pathname)) return null;
  const file = await get(track.url);
  return file === null ? null : srtToVtt(file.text);
}

/** The source's English subtitle as WebVTT, or null when it has none that can be read. Throws only when `signal` was aborted. */
export async function englishSubtitle(fetchImpl: FetchLike, session: StreamSession, signal: AbortSignal): Promise<string | null> {
  const english = session.source.subtitles.filter((t) => isEnglish(t));
  const tracks = [...english.filter((t) => t.source === 'request'), ...english.filter((t) => t.source !== 'request')];
  for (const track of tracks) {
    let vtt: string | null;
    try {
      vtt = await readTrack(fetchImpl, session, track, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      vtt = null;
    }
    if (vtt !== null && /-->/.test(vtt)) return vtt;
  }
  return null;
}
