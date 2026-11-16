import Hls, { ErrorTypes, Events, type MediaPlaylist } from 'hls.js';
import {
  audioTrackIndex,
  BUFFER_AHEAD_S,
  networkRecovery,
  reportRefusal,
  UPSTREAM_HEADER,
  type EngineRequest,
  type PlayerEngine,
} from './engine';

/** X-Notesd-Upstream of a failed load: hls.js's default XhrLoader hands the XMLHttpRequest over as `networkDetails`. */
function upstreamOf(details: unknown): string | null {
  const d = details as { getResponseHeader?: (name: string) => string | null; headers?: { get?: (name: string) => string | null } } | null | undefined;
  if (typeof d?.getResponseHeader === 'function') return d.getResponseHeader(UPSTREAM_HEADER);
  if (typeof d?.headers?.get === 'function') return d.headers.get(UPSTREAM_HEADER);
  return null;
}

export function createHlsEngine({ video, src, startAt, handlers, audioTrack, bufferAheadS = BUFFER_AHEAD_S }: EngineRequest): PlayerEngine {
  if (!Hls.isSupported()) {
    handlers.onFatal('hls_unsupported');
    return { setQuality() {}, setEmbeddedSubtitle() {}, destroy() {} };
  }
  // hls.js sizes its forward buffer from maxBufferLength and the bitrate, capped at
  // maxMaxBufferLength (up to 600 s by default). Both are bufferAheadS, so a play keeps exactly that
  // much loaded ahead (R1.8): 120 s, or 30 s under ?muted=1 so the expiry checks (playcheck.mjs,
  // player.steps.mjs J3) still find segments not yet loaded when the token expires.
  const hls = new Hls({
    startPosition: startAt > 0 ? startAt : -1,
    maxBufferLength: bufferAheadS,
    maxMaxBufferLength: bufferAheadS,
  });
  let subtitleTracks: MediaPlaylist[] = [];
  let mediaRecovered = false;
  let manifestParsed = false;
  // R1.7: after a fatal network error, load again from where the film is. Before the manifest was
  // read there is nothing to continue, so the manifest is asked for again.
  const network = networkRecovery(handlers, () => {
    if (!manifestParsed) {
      hls.loadSource(src);
      return;
    }
    hls.startLoad(video.currentTime > 0 ? video.currentTime : startAt > 0 ? startAt : -1);
  });

  hls.on(Events.MANIFEST_PARSED, (_event, data) => {
    manifestParsed = true;
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

  hls.on(Events.FRAG_LOADED, () => {
    network.loaded();
  });

  hls.on(Events.ERROR, (_event, data) => {
    if (reportRefusal(handlers, data.response?.code, upstreamOf(data.networkDetails))) {
      // A refresh replaces this engine, or the session is over: no restart either way.
      network.stop();
      return;
    }
    if (!data.fatal) return;
    if (data.type === ErrorTypes.NETWORK_ERROR) {
      network.fail(`${data.type} ${data.details}`);
      return;
    }
    if (data.type === ErrorTypes.MEDIA_ERROR && !mediaRecovered) {
      mediaRecovered = true;
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
      network.stop();
      hls.destroy();
    },
  };
}
