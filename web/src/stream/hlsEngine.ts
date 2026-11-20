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

/**
 * A torrent remux's playlist (src/directStream/torrent/remux.ts) is an EVENT playlist that grows while the file
 * downloads. Its address says so (`remux=1`) and names the film's full length (`total_s`) when the probe knew it.
 */
export interface GrowingPlaylist {
  totalS: number | null;
}

export function growingPlaylist(src: string): GrowingPlaylist | null {
  const q = src.indexOf('?');
  if (q === -1) return null;
  const params = new URLSearchParams(src.slice(q + 1));
  if (params.get('remux') !== '1') return null;
  const total = Number(params.get('total_s'));
  return { totalS: Number.isFinite(total) && total > 0 ? total : null };
}

export function createHlsEngine({ video, src, startAt, handlers, audioTrack, bufferAheadS = BUFFER_AHEAD_S }: EngineRequest): PlayerEngine {
  if (!Hls.isSupported()) {
    handlers.onFatal('hls_unsupported');
    return { setQuality() {}, setEmbeddedSubtitle() {}, destroy() {} };
  }
  // hls.js sizes its forward buffer from maxBufferLength and the bitrate, capped at
  // maxMaxBufferLength (up to 600 s by default). Both are bufferAheadS, so a play keeps exactly that
  // much loaded ahead (R1.8): 120 s, or 30 s under ?muted=1 so the expiry check (verify's
  // player.steps.mjs J3) still find segments not yet loaded when the token expires.
  const growing = growingPlaylist(src);
  const hls = new Hls({
    // A growing remux starts at the resume position or at 0: hls.js would start a live playlist at its edge.
    startPosition: growing !== null ? Math.max(0, startAt) : startAt > 0 ? startAt : -1,
    maxBufferLength: bufferAheadS,
    maxMaxBufferLength: bufferAheadS,
    // hls.js's latency controller pulls a play that is past the end of a live playlist back to the live edge on every
    // reload. A growing remux is a film: a seek past what is remuxed waits there until the remux reaches it.
    ...(growing !== null ? { latencyController: undefined } : {}),
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
  // The film's full length from the probe, so the timeline is the whole film and a seek past the remux is possible.
  hls.attachMedia(growing !== null && growing.totalS !== null ? { media: video, overrides: { duration: growing.totalS } } : video);

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
