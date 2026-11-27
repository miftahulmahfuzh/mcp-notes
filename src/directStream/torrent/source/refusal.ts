import { isEnglish, type ResolveOutcome, type ResolvedSource, type SourceAudio } from '../../types.js';
import type { SessionTorrent } from '../../sessions.js';
import { audioLanguages, describeProbe, normalizeAudioLang, type MediaProbe } from '../probe.js';
import { canRemux, pickAudioStream, type TorrentRemux } from '../remux.js';
import { TORRENT_PROVIDER } from './constants.js';

/**
 * What a probed file is: whether it plays at all, in the original language (the never-dubbed rule lives in
 * refusalOf), and the ResolvedSource stand-in a torrent session carries. Pure.
 */

/**
 * A file Chrome plays as is AND whose default audio is the original: a dual-audio file whose original track is not
 * the first needs the remux to force it, or Chrome would play the dub. Single-audio, or the original at index 0, is fine.
 */
export function playsOriginalDirect(probe: MediaProbe, audioLang: string | null): boolean {
  if (!probe.direct) return false;
  if (audioLang === null || probe.audio.length <= 1) return true;
  return pickAudioStream(probe.audio, audioLang) === 0;
}

/**
 * Why a probed file is not played, or null when it plays: a dub first (original language only), then a file Chrome
 * cannot play that the remux cannot help either (the remux off, or video Chrome cannot decode).
 */
export function refusalOf(probe: MediaProbe, audioLang: string | null, remux: TorrentRemux | null): { outcome: ResolveOutcome; detail: string } | null {
  const languages = audioLanguages(probe);
  if (audioLang !== null && languages.length > 0 && !languages.includes(audioLang)) {
    return { outcome: 'dubbed', detail: `its audio is ${languages.join(', ')}, not the original ${audioLang}` };
  }
  // Direct, and the original track is the one Chrome would play: nothing to do.
  if (playsOriginalDirect(probe, audioLang)) return null;
  // A dual-audio file whose original is not the default: the remux maps the original track, so a dub never plays.
  // Without a remux it would, so it is refused rather than played in the wrong language.
  if (remux === null) {
    return probe.direct
      ? { outcome: 'dubbed', detail: `${describeProbe(probe)}: ${probe.audio.length} audio tracks and the original ${audioLang} is not the default; a remux is needed to force it, and the remux is off` }
      : { outcome: 'unplayable', detail: `${describeProbe(probe)}: Chrome does not play it as is` };
  }
  if (!canRemux(probe)) return { outcome: 'unplayable', detail: `${describeProbe(probe)}: Chrome does not play it as is, and a remux cannot make its video playable` };
  return null;
}

/**
 * The ResolvedSource a torrent session carries, so whatever reads `session.source` (movie_plays, the stream on
 * screen, the evidence snapshot) reads the torrent's. Its manifest is the local, relative file route, so
 * `sourceHosts` finds no host and the pass-through refuses every address for the session, as for a cache.
 */
export function standIn(torrent: SessionTorrent, probe: MediaProbe, audioLang: string | null, tookS: number | null): ResolvedSource {
  const languages = audioLanguages(probe);
  const original = audioLang === null ? undefined : probe.audio.find((a) => normalizeAudioLang(a.lang) === audioLang);
  const audio: SourceAudio = {
    languages,
    tracks: probe.audio.length > 1 ? probe.audio.length : 0,
    original: audioLang === null || languages.length === 0 ? null : languages.includes(audioLang),
    track: original === undefined ? null : { lang: original.lang, label: null },
  };
  return {
    provider: TORRENT_PROVIDER,
    embed_url: '',
    manifest_url: torrent.manifestUrl,
    manifest_kind: torrent.manifestKind,
    headers: { referer: null, origin: null, user_agent: null },
    subtitles: [],
    best_height: torrent.height,
    en_subtitle: torrent.subtitles.some((t) => isEnglish(t)),
    audio,
    took_s: tookS,
  };
}
