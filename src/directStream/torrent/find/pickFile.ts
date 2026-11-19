import { baseName, covers, extensionOf, namesNumber, parseEpisodeRef, stripExtension, SUBTITLE_EXTENSIONS, VIDEO_EXTENSIONS } from './release.js';
import type { FilePick, TorrentFileLike, TorrentQuery, TvQuery } from './types.js';

/** A video smaller than this is skipped when a bigger one exists (samples, previews). */
export const MIN_VIDEO_BYTES = 50 * 1024 * 1024;

const EXTRA_FOLDER = /^(?:extras?|featurettes?|bonus|behind the scenes|deleted scenes|interviews?|trailers?|samples?)(?![a-z])/i;
const EXTRA_FILE = /(?<![a-z])(?:sample|trailer|featurette)(?![a-z])/i;
const SUBS_FOLDER = /^(?:subs?|subtitles?)$/i;

function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter((s) => s.length > 0);
}

function folderOf(path: string): string {
  return segments(path).slice(0, -1).join('/');
}

function hasExtension(path: string, list: readonly string[]): boolean {
  const ext = extensionOf(path);
  return ext !== null && list.includes(ext);
}

function isExtra(path: string): boolean {
  const parts = segments(path);
  return parts.slice(0, -1).some((p) => EXTRA_FOLDER.test(p.trim())) || EXTRA_FILE.test(stripExtension(parts[parts.length - 1] ?? ''));
}

function largest(files: readonly TorrentFileLike[]): TorrentFileLike | null {
  let best: TorrentFileLike | null = null;
  for (const f of files) if (best === null || f.length > best.length) best = f;
  return best;
}

/** The season of the nearest folder that names exactly one season. */
function folderSeason(path: string): number | null {
  for (const folder of segments(path).slice(0, -1).reverse()) {
    const ref = parseEpisodeRef(folder);
    if (ref.season !== null && ref.seasonTo === null) return ref.season;
  }
  return null;
}

function seasonOf(path: string): number | null {
  return parseEpisodeRef(stripExtension(baseName(path))).season ?? folderSeason(path);
}

function matchesEpisode(path: string, query: TvQuery, oneSeason: boolean): boolean {
  const stem = stripExtension(baseName(path));
  const ref = parseEpisodeRef(stem);
  if (ref.episode !== null) {
    const season = ref.season ?? folderSeason(path);
    // A name that says its season may number the episode within it (`alt`); a bare number never does.
    if (season !== null) return (season === query.season && covers(ref, query.episode)) || (query.alt != null && season === query.alt.season && covers(ref, query.alt.episode));
    if (query.absoluteEpisode != null && ref.episode === query.absoluteEpisode) return true;
    return oneSeason && covers(ref, query.episode);
  }
  return query.absoluteEpisode != null && namesNumber(stem, query.absoluteEpisode);
}

function inSubsFolder(path: string, videoFolder: string): boolean {
  const folders = segments(path).slice(0, -1);
  const at = folders.findIndex((f) => SUBS_FOLDER.test(f));
  if (at < 0) return false;
  const above = folders.slice(0, at).join('/');
  return above === '' || videoFolder === above || videoFolder.startsWith(`${above}/`);
}

function subtitlesFor(
  files: readonly TorrentFileLike[],
  video: TorrentFileLike,
  episode: { query: TvQuery; oneSeason: boolean } | null,
  pack: boolean,
): number[] {
  const videoFolder = folderOf(video.path);
  const videoStem = stripExtension(baseName(video.path)).toLowerCase();
  return files
    .filter((f) => hasExtension(f.path, SUBTITLE_EXTENSIONS))
    .filter((f) => folderOf(f.path) === videoFolder || inSubsFolder(f.path, videoFolder))
    .filter((f) => {
      if (!pack || episode === null) return true;
      return segments(f.path).some((s) => stripExtension(s).toLowerCase().startsWith(videoStem)) || matchesEpisode(f.path, episode.query, episode.oneSeason);
    })
    .map((f) => f.index);
}

/** The video to play and its subtitle files; null when the torrent holds no fitting video. */
export function pickFile(files: readonly TorrentFileLike[], query: TorrentQuery): FilePick | null {
  const videos = files.filter((f) => hasExtension(f.path, VIDEO_EXTENSIONS) && !isExtra(f.path));
  const big = videos.filter((f) => f.length >= MIN_VIDEO_BYTES);
  const pool = big.length > 0 ? big : videos;
  if (pool.length === 0) return null;
  if (query.kind === 'movie') {
    const film = largest(pool);
    return film === null ? null : { video: film.index, subtitles: subtitlesFor(files, film, null, false) };
  }
  const oneSeason = pool.every((f) => {
    const season = seasonOf(f.path);
    return season === null || season === query.season;
  });
  const matching = pool.filter((f) => matchesEpisode(f.path, query, oneSeason));
  const [only] = pool;
  const lone = pool.length === 1 && only !== undefined && parseEpisodeRef(stripExtension(baseName(only.path))).episode === null ? only : null;
  // A first season's pack whose files carry a bare number and nothing else ("[SubsPlease] Sousou no Frieren - 14
  // [1080p].mkv", "Frieren 14.mkv"): in season 1 the running number is the episode's own. Only when exactly one
  // file names it: a "5.1" in every name must not make every file episode 5.
  const bare =
    matching.length === 0 && lone === null && oneSeason && query.season === 1 && query.absoluteEpisode == null && query.alt == null
      ? pool.filter((f) => namesNumber(stripExtension(baseName(f.path)), query.episode))
      : [];
  const video = matching.length > 0 ? largest(matching) : (lone ?? (bare.length === 1 ? (bare[0] ?? null) : null));
  if (video === null) return null;
  return { video: video.index, subtitles: subtitlesFor(files, video, { query, oneSeason }, pool.length > 1) };
}
