import type { EpisodeView, FileView, MoviesStatusResponse, PlayerState, TitleDetail, TitleKind, TitleListItem, TmdbHitView, UnmatchedFile } from '../moviesApi';

export const HOST = 'lenovo';
const ISO = '2026-11-10T12:00:00.000Z';
const NO_PROGRESS = { position_s: null, duration_s: null, ratio: null };

/** A wire `FileView`: a 1 h unwatched file on this host, present. */
export function makeFile(id: number, over: Partial<FileView> = {}): FileView {
  const base: FileView = {
    id,
    title_id: null,
    host: HOST,
    path: `/lib/f${id}.mkv`,
    name: `f${id}.mkv`,
    size: 2_000_000_000,
    duration_s: 3600,
    season: null,
    episode: null,
    absolute_episode: null,
    status: 'matched',
    reason: null,
    source: 'scan',
    first_seen_at: ISO,
    last_seen_at: ISO,
    deleted_at: null,
    moved_at: null,
    done_at: null,
    watched_at: null,
    deleted: false,
    available: true,
    unavailable_reason: null,
    state: 'unwatched',
    progress: NO_PROGRESS,
    resume_position_s: 0,
    last_played_at: null,
    finished_at: null,
  };
  return { ...base, ...over };
}

/** A wire `TitleListItem`; the kind follows the id (`tv-` / `movie-`). */
export function makeItem(id: string, title: string, over: Partial<TitleListItem> = {}): TitleListItem {
  const kind: TitleKind = id.startsWith('tv-') ? 'tv' : 'movie';
  const base: TitleListItem = {
    id,
    movie_id: null,
    kind,
    tmdb_id: Number(id.slice(id.indexOf('-') + 1)),
    title,
    year: 2026,
    poster_url: null,
    state: 'unwatched',
    watched: false,
    watched_at: null,
    rating: null,
    progress: kind === 'movie' ? { kind: 'movie', ...NO_PROGRESS } : { kind: 'tv', episodes_finished: 0, episodes_total: null, episodes_present: 0 },
    last_played_at: null,
    finished_at: null,
    present_here: true,
    file_count: 1,
    deleted_file_count: 0,
    created_at: ISO,
  };
  return { ...base, ...over };
}

function detailOf(item: TitleListItem, over: Partial<TitleDetail>): TitleDetail {
  return {
    ...item,
    original_title: item.title,
    release_date: null,
    overview: '',
    runtime_min: null,
    genres: [],
    backdrop_url: null,
    season_count: null,
    episode_count: null,
    review: '',
    review_note_id: null,
    companies: [],
    directors: [],
    writers: [],
    producers: [],
    creators: [],
    cast: [],
    files: [],
    seasons: [],
    unplaced_files: [],
    plays: [],
    metadata_fetched_at: ISO,
    ...over,
  };
}

function episodeOf(season: number, episode: number, name: string, file: FileView | null): EpisodeView {
  return {
    movie_id: `M-0S${season}${episode}`,
    season,
    episode,
    name,
    air_date: null,
    runtime_min: 50,
    overview: null,
    still_url: null,
    state: file?.state ?? 'unwatched',
    has_file: file !== null,
    present_here: file?.available ?? false,
    deleted: file?.deleted ?? false,
    progress: file?.progress ?? NO_PROGRESS,
    last_played_at: file?.last_played_at ?? null,
    finished_at: null,
    file_id: file?.id ?? null,
    files: file ? [file] : [],
  };
}

export const KILLING_ITEM = makeItem('movie-467905', 'How to Make a Killing', {
  movie_id: 'M-23T4',
  poster_url: 'https://image.tmdb.org/t/p/w342/kill.jpg',
  state: 'in_progress',
  progress: { kind: 'movie', position_s: 2700, duration_s: 6720, ratio: 0.4 },
  last_played_at: '2026-11-13T14:00:00.000Z',
});

export const MOBLAND_ITEM = makeItem('tv-247718', 'MobLand', {
  movie_id: 'M-8TR4',
  year: 2025,
  state: 'in_progress',
  progress: { kind: 'tv', episodes_finished: 1, episodes_total: 4, episodes_present: 1 },
  file_count: 2,
  deleted_file_count: 1,
  last_played_at: '2026-11-12T20:00:00.000Z',
});

export const DOG_ITEM = makeItem('movie-9001', 'The Dog Stars', {
  year: 2025,
  poster_url: 'https://image.tmdb.org/t/p/w342/dog.jpg',
  state: 'dropped',
  present_here: false,
  file_count: 0,
  deleted_file_count: 1,
  last_played_at: '2026-10-01T20:00:00.000Z',
});

/** In server order on purpose (not the page's): the page sorts. */
export const TITLES: TitleListItem[] = [DOG_ITEM, MOBLAND_ITEM, KILLING_ITEM];

export const KILLING_FILE = makeFile(11, {
  title_id: 'movie-467905',
  name: 'How.to.Make.a.Killing.2026.1080p.WEB-DL.x265.6CH-Pahe.in.mkv',
  duration_s: 6720,
  state: 'in_progress',
  progress: { position_s: 2700, duration_s: 6720, ratio: 2700 / 6720 },
  resume_position_s: 2700,
  last_played_at: '2026-11-13T14:00:00.000Z',
});

export const MOVIE: TitleDetail = detailOf(KILLING_ITEM, {
  poster_url: 'https://image.tmdb.org/t/p/w500/kill.jpg',
  release_date: '2026-02-20',
  overview: 'A disinherited heir plots his way back into the family fortune.',
  runtime_min: 112,
  genres: ['Comedy', 'Crime'],
  companies: [{ id: 3172, name: 'Blumhouse Productions', logo_url: null, origin_country: 'US' }],
  directors: [{ person_id: 1, name: 'Ava Director', profile_url: null, job: 'Director' }],
  writers: [{ person_id: 1, name: 'Ava Director', profile_url: null, job: 'Screenplay' }],
  producers: [{ person_id: 2, name: 'Pat Producer', profile_url: null, job: 'Producer' }],
  cast: [
    { person_id: 3, name: 'Glen Example', profile_url: null, character: 'Becket' },
    { person_id: 4, name: 'Mara Example', profile_url: null, character: 'Julia' },
  ],
  files: [KILLING_FILE],
});

const E1 = makeFile(21, {
  title_id: 'tv-247718',
  name: 'MobLand.S01E01.Stick.or.Twist.mkv',
  season: 1,
  episode: 1,
  deleted: true,
  deleted_at: '2026-11-01T10:00:00.000Z',
  available: false,
  unavailable_reason: 'deleted',
  state: 'finished',
  progress: { position_s: 2950, duration_s: 3000, ratio: 0.98 },
});
const E2 = makeFile(22, {
  title_id: 'tv-247718',
  name: 'MobLand.S01E02.mkv',
  season: 1,
  episode: 2,
  state: 'in_progress',
  progress: { position_s: 1200, duration_s: 3000, ratio: 0.4 },
  resume_position_s: 1200,
  last_played_at: '2026-11-12T20:00:00.000Z',
});
const E3 = makeFile(23, {
  title_id: 'tv-247718',
  name: 'MobLand.S01E03.mkv',
  season: 1,
  episode: 3,
  host: 'gpd',
  available: false,
  unavailable_reason: 'not_on_this_machine',
});

export const SERIES: TitleDetail = detailOf(MOBLAND_ITEM, {
  release_date: '2025-03-30',
  overview: 'Two crime families clash in London.',
  season_count: 2,
  episode_count: 5,
  creators: [{ person_id: 5, name: 'Ronan Creator', profile_url: null, job: 'Creator' }],
  files: [E1, E2, E3],
  seasons: [
    {
      season: 1,
      episodes: [episodeOf(1, 1, 'Stick or Twist', E1), episodeOf(1, 2, 'Episode Two', E2), episodeOf(1, 3, 'Episode Three', E3), episodeOf(1, 4, 'Episode Four', null)],
    },
    { season: 2, episodes: [episodeOf(2, 1, 'Season Two Opener', null)] },
  ],
});

export const UNMATCHED: UnmatchedFile[] = [
  {
    id: 31,
    host: HOST,
    path: '/lib/Done/docker_es/clip-0412.mp4',
    name: 'clip-0412.mp4',
    size: 4_000_000,
    duration_s: 42,
    status: 'unmatched',
    reason: 'too_short',
    parsed: null,
    first_seen_at: ISO,
    last_seen_at: ISO,
    available: true,
  },
  {
    id: 32,
    host: HOST,
    path: '/lib/Nezha (2019)/Ne.Zha.2.2025.1080p.mkv',
    name: 'Ne.Zha.2.2025.1080p.mkv',
    size: 3_000_000_000,
    duration_s: 8640,
    status: 'unmatched',
    reason: 'low_confidence',
    parsed: { title: 'Ne Zha 2', year: 2025, season: null, episode: null, absolute_episode: null, kind_hint: 'movie' },
    first_seen_at: ISO,
    last_seen_at: ISO,
    available: true,
  },
];

export const STATUS: MoviesStatusResponse = {
  host: HOST,
  roots: ['/lib'],
  done_dirs: ['Done'],
  scan_ms: 120000,
  min_seconds: 900,
  scanning: true,
  running: false,
  tmdb: 'ok',
  next_pass_at: ISO,
  last_pass: null,
  counts: { titles: 3, files_here: 3, unmatched_here: 2, pending_here: 0 },
};

export const PLAYER_IDLE: PlayerState = { available: true, reason: null, current: null };

export const PLAYING: PlayerState = {
  available: true,
  reason: null,
  current: { play_id: 7, file_id: 11, title_id: 'movie-467905', name: 'How.to.Make.a.Killing.2026.1080p.mkv', port: 47318, state: 'playing', position: 2710, duration: 6720, started_at: ISO, last_read_at: ISO },
};

export const SEARCH: TmdbHitView[] = [
  { kind: 'movie', tmdb_id: 1125510, title_id: 'movie-1125510', title: 'Ne Zha 2', original_title: 'Ne Zha 2', year: 2025, overview: '', poster_url: null, in_library: false },
];
