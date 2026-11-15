import Hls, { ErrorTypes, Events, type MediaPlaylist } from 'hls.js';
import { audioTrackIndex, reportRefusal, UPSTREAM_HEADER, type EngineRequest, type PlayerEngine } from './engine';

/** X-Notesd-Upstream of a failed load: hls.js's default XhrLoader hands the XMLHttpRequest over as `networkDetails`. */
function upstreamOf(details: unknown): string | null {
  const d = details as { getResponseHeader?: (name: string) => string | null; headers?: { get?: (name: string) => string | null } } | null | undefined;
  if (typeof d?.getResponseHeader === 'function') return d.getResponseHeader(UPSTREAM_HEADER);
  if (typeof d?.headers?.get === 'function') return d.headers.get(UPSTREAM_HEADER);
  return null;
}

export function createHlsEngine({ video, src, startAt, handlers, audioTrack }: EngineRequest): PlayerEngine {
  if (!Hls.isSupported()) {
    handlers.onFatal('hls_unsupported');
    return { setQuality() {}, setEmbeddedSubtitle() {}, destroy() {} };
  }
  // hls.js grows its forward buffer with the bitrate (up to 600 s, a whole low-bitrate film): hold
  // it at maxBufferLength's 30 s, so no more than that is pulled through the pass-through ahead of
  // the play, and J3's expiry check (player.steps.mjs) finds segments not yet loaded.
  const hls = new Hls({ startPosition: startAt > 0 ? startAt : -1, maxMaxBufferLength: 30 });
  let subtitleTracks: MediaPlaylist[] = [];
  let recovered = false;

  hls.on(Events.MANIFEST_PARSED, (_event, data) => {
    subtitleTracks = data.subtitleTracks;
    // The original-language audio, never the manifest's default when that is a dub.
    const audio = audioTrackIndex(data.audioTracks.map((t) => ({ lang: t.lang ?? null, label: t.name })), audioTrack);
    if (audio !== -1) hls.audioTrack = audio;
    handlers.onReady({
      qualities: data.levels.map((level, index) => ({
        index,
        height: level.height > 0 ? level.height : null,
        bitrate: level.bitrate > 0 ? level.bitrate : null,
      })),
      subtitles: subtitleTracks.map((track, index) => ({ index, label: track.name, lang: track.lang ?? null })),
    });
  });

  hls.on(Events.ERROR, (_event, data) => {
    if (reportRefusal(handlers, data.response?.code, upstreamOf(data.networkDetails))) return;
    if (!data.fatal) return;
    if (data.type === ErrorTypes.MEDIA_ERROR && !recovered) {
      recovered = true;
      hls.recoverMediaError();
      return;
    }
    handlers.onFatal(`${data.type} ${data.details}`);
  });

  hls.loadSource(src);
  hls.attachMedia(video);

  return {
    setQuality(index) {
      hls.currentLevel = index;
    },
    setEmbeddedSubtitle(index) {
      const track = index === null ? undefined : subtitleTracks[index];
      if (track === undefined) {
        hls.subtitleTrack = -1;
        hls.subtitleDisplay = false;
        return;
      }
      hls.setSubtitleOption(track);
      hls.subtitleDisplay = true;
    },
    destroy() {
      hls.destroy();
    },
  };
}
