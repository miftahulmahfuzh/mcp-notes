import type { SubtitleContext } from '../../../../../src/directStream/torrent/subtitles/chain.js';

/** The fields of phase 3's SubtitleContext a tier test does not care about. */
export const REST_OF_CONTEXT = {
  probe: { container: 'mov,mp4,m4a,3gp,3g2,mj2', video: { codec: 'h264', height: 720 }, audio: [{ codec: 'aac', lang: 'eng' }], subtitles: [], durationS: 120, direct: true },
  audioLang: 'en',
  resumeS: null,
  localBase: 'http://127.0.0.1:1',
  signal: new AbortController().signal,
  deadline: Number.MAX_SAFE_INTEGER,
} satisfies Partial<SubtitleContext>;
