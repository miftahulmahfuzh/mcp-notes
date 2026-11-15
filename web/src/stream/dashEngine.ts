import { MediaPlayer, type MediaInfo } from 'dashjs';
import { audioTrackIndex, reportRefusal, UPSTREAM_HEADER, type EngineRequest, type PlayerEngine } from './engine';

/** X-Notesd-Upstream of a response the interceptor saw (dash.js 5 lower-cases header names in `headers`). */
function upstreamOf(response: unknown): string | null {
  const headers = (response as { headers?: Record<string, string> | null } | null)?.headers;
  return headers?.[UPSTREAM_HEADER] ?? null;
}

function describe(event: unknown): string {
  try {
    const error = (event as { error?: unknown }).error ?? event;
    return JSON.stringify(error).slice(0, 200);
  } catch {
    return 'error';
  }
}

export function createDashEngine({ video, src, startAt, handlers, audioTrack }: EngineRequest): PlayerEngine {
  const player = MediaPlayer().create();
  let textTracks: MediaInfo[] = [];
  let live = true;

  player.updateSettings({ streaming: { text: { defaultEnabled: false } } });
  player.addResponseInterceptor(async (response) => {
    if (live) reportRefusal(handlers, response.status, upstreamOf(response));
    return response;
  });
  player.on(MediaPlayer.events.STREAM_INITIALIZED, () => {
    if (!live) return;
    textTracks = player.getTracksFor('text');
    // The original-language audio, never the manifest's default when that is a dub.
    const audioTracks = player.getTracksFor('audio');
    const audio = audioTrackIndex(audioTracks.map((t) => ({ lang: t.lang, label: t.labels[0]?.text ?? null })), audioTrack);
    if (audio !== -1 && audioTracks[audio] !== undefined) player.setCurrentTrack(audioTracks[audio]);
    handlers.onReady({
      qualities: player.getRepresentationsByType('video').map((rep, index) => ({
        index,
        height: rep.height > 0 ? rep.height : null,
        bitrate: rep.bandwidth > 0 ? rep.bandwidth : null,
      })),
      subtitles: textTracks.map((track, index) => ({
        index,
        label: track.labels[0]?.text ?? track.lang ?? `Track ${index + 1}`,
        lang: track.lang,
      })),
    });
  });
  player.on(MediaPlayer.events.ERROR, (event: unknown) => {
    if (live) handlers.onFatal(`dash ${describe(event)}`);
  });
  player.initialize(video, src, false, startAt > 0 ? startAt : undefined);

  return {
    setQuality(index) {
      if (index < 0) {
        player.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: true } } } });
        return;
      }
      player.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: false } } } });
      player.setRepresentationForTypeByIndex('video', index, true);
    },
    setEmbeddedSubtitle(index) {
      const track = index === null ? undefined : textTracks[index];
      if (track === undefined) {
        player.enableText(false);
        return;
      }
      player.setCurrentTrack(track);
      player.enableText(true);
    },
    destroy() {
      live = false;
      player.reset();
    },
  };
}
