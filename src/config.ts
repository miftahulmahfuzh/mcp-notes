import { existsSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseDotenv } from 'dotenv'
import type { ChatBrain } from './chat/backend.js'

/**
 * Repo root, resolved from this module's own location so the daemon finds
 * `.env.local` no matter which cwd systemd or a test runner starts it from.
 * `src/config.ts` (tsx, vitest) and `dist/config.js` (built) both sit one
 * level below the root.
 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const DEFAULT_PORT = 7317
export const LOOPBACK_HOST = '127.0.0.1'
export const DEFAULT_DATA_DIR = '~/mcp-notes-data'
export const DEFAULT_CHAT_MAX_TURNS = 24
export const DEFAULT_CHAT_TIMEOUT_MS = 180_000
/** A bare name is looked up on PATH by the SDK; the systemd unit sets an absolute path. */
export const DEFAULT_CLAUDE_BIN = 'claude'

/** The GLM endpoint for the fallback brain (z.ai), from `.env.local`'s `LLM_*` keys. */
export interface GlmConfig {
  /** `LLM_BASE_URL` -> the child's `ANTHROPIC_BASE_URL`. */
  baseUrl: string
  /** `LLM_API_KEY` -> the child's `ANTHROPIC_AUTH_TOKEN`. Never logged. */
  apiKey: string
  /** `LLM_MODEL`, e.g. `glm-5.3`. */
  model: string
}

export interface ChatConfig {
  /** `CHAT_BRAIN`, default `claude`. `glm` runs GLM only (no fallback). */
  brain: ChatBrain
  /** `CHAT_MAX_TURNS`, default 24. Integer >= 1. */
  maxTurns: number
  /** `CHAT_TIMEOUT_MS`, default 180000. Wall clock per chat message. Integer >= 1. */
  timeoutMs: number
  /** `NOTESD_CLAUDE_BIN`, default `claude`. A path is ~-expanded and made absolute. */
  claudeBin: string
  /** Set when all three `LLM_*` keys are; null otherwise (Claude runs then have no fallback). */
  glm: GlmConfig | null
}

/** What `loadConfig` returns for `chat` when no chat key is set. Tests build `Config` literals with it. */
export const DEFAULT_CHAT_CONFIG: ChatConfig = {
  brain: 'claude',
  maxTurns: DEFAULT_CHAT_MAX_TURNS,
  timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
  claudeBin: DEFAULT_CLAUDE_BIN,
  glm: null,
}

/** OpenRouter embeddings: semantic search, `related`, and the embedding worker. */
export interface EmbeddingsConfig {
  /** `OPENROUTER_API_KEY`, trimmed; null when unset or blank (semantic features off). Never logged. */
  apiKey: string | null
}

/** What `loadConfig` returns for `embeddings` without OPENROUTER_API_KEY. Tests build `Config` literals with it. */
export const DEFAULT_EMBEDDINGS_CONFIG: EmbeddingsConfig = { apiKey: null }

/** The dword (daily-words) connector's write identity: src/connectors/dword/user.ts resolves it. */
export interface DwordConfig {
  /** `DWORD_USER_EMAIL`, trimmed; null when unset or blank. Every dword tool then refuses with
   * "daily-words user not configured" instead of writing. Never logged. */
  userEmail: string | null
}

/** What `loadConfig` returns for `dword` without DWORD_USER_EMAIL. Tests build `Config` literals with it. */
export const DEFAULT_DWORD_CONFIG: DwordConfig = { userEmail: null }

export const DEFAULT_CLAUDE_HOME = '~/.claude'
export const DEFAULT_WORKTREES_DIR = '~/.worktrees'
/** Relative to `claudeHome`: where the swarm skill installs its script (`install.sh` in ~/claude-commands). */
export const DEFAULT_SWARM_SCRIPT_REL = path.join('skills', 'swarm', 'swarm.py')

/** Claude Code session ingest (src/sessions/ingest.ts) and the live registry (src/sessions/registry.ts). */
export interface SessionsConfig {
  /** Absolute. `CLAUDE_HOME`, default ~/.claude: transcripts in `projects/`, live registry in `sessions/`. Read only. */
  claudeHome: string
  /** Absolute. `NOTES_WORKTREES_DIR`, default ~/.worktrees: `<dir>/<repo>/<slug>` maps a worktree session to `<repo>`. */
  worktreesDir: string
  /** `NOTESD_SESSIONS`, default on. `off` (or 0/false/no) starts no session ingest. */
  enabled: boolean
  /**
   * `NOTESD_SWARM_SCRIPT`, default `<claudeHome>/skills/swarm/swarm.py`. Absolute. Not checked here:
   * a missing file makes every orch node's `unfinished` null, never an error. Null turns the
   * check off (the test literal `DEFAULT_SESSIONS_CONFIG` uses null).
   */
  swarmScript: string | null
}

/**
 * Sessions off, default paths. Tests build `Config` literals with it, so no test that builds a
 * Config by hand ever reads the real ~/.claude.
 */
export const DEFAULT_SESSIONS_CONFIG: SessionsConfig = {
  claudeHome: path.join(homedir(), '.claude'),
  worktreesDir: path.join(homedir(), '.worktrees'),
  enabled: false,
  swarmScript: null,
}

export const DEFAULT_ADVERSARY_DAILY_CAP = 15
export const DEFAULT_ADVERSARY_GATHER_MODEL = 'sonnet'
export const DEFAULT_ADVERSARY_VERDICT_MODEL = 'opus'
export const DEFAULT_ADVERSARY_GATHER_MAX_TURNS = 20
export const DEFAULT_ADVERSARY_STOCK_TIMEOUT_MS = 420_000
export const DEFAULT_ADVERSARY_POLL_MS = 600_000

/** The streaming tools, streaming_find and streaming_play (src/streaming/*). */
export interface StreamingConfig {
  /** `NOTESD_STREAMING`, default on. `off`: the tools answer streaming_off and no script is ever run. */
  enabled: boolean
}

/** The Stream side's daily trending list (src/directStream/trending/). */
export interface TrendingConfig {
  /**
   * `NOTESD_TRENDING`, default on: once a day the torrent indexes' most seeded films and series that the owner has
   * not seen are listed on the Stream side. `off`, or unset in a literal: nothing is asked.
   */
  enabled: boolean
  /** `NOTESD_TRENDING_SIZE`, default 100: titles of each kind (films, series) on the list. */
  size: number
  /** DEFAULT_TRENDING_SKIP_LANGUAGES: TMDB original-language codes whose titles never make the list, and leave it at once. */
  skipLanguages: string[]
}

export const DEFAULT_TRENDING_SIZE = 100
/** Hindi and the other languages of Indian cinema the owner does not want recommended. */
export const DEFAULT_TRENDING_SKIP_LANGUAGES = ['hi', 'ta', 'te', 'ml', 'kn', 'bn', 'mr', 'pa']

/** Trending off. Tests build `Config` literals with it (or leave `trending` out, which is the same). */
export const DEFAULT_TRENDING_CONFIG: TrendingConfig = { enabled: false, size: DEFAULT_TRENDING_SIZE, skipLanguages: DEFAULT_TRENDING_SKIP_LANGUAGES }

export const DEFAULT_STREAM_FRESH_DAYS = 7
/** `claude/streaming/direct/cli.mjs` in this checkout: the resolver the daemon runs (direct streaming phase 1). */
export const DEFAULT_DIRECT_STREAM_CLI = path.join(REPO_ROOT, 'claude', 'streaming', 'direct', 'cli.mjs')

/** The public index that maps a TMDB id to an anime's AniList id and episodes (src/directStream/anime.ts). */
export const DEFAULT_ANIME_MAP_URL = 'https://api.ani.zip'
/** Stremio's OpenSubtitles add-on: English subtitles by IMDb id and file hash, no key (src/directStream/torrent/subtitles/service.ts). */
export const DEFAULT_TORRENT_SUBTITLE_URL = 'https://opensubtitles-v3.strem.io'
/** Wyzie Subs: asked before the add-on when WYZIE_API_KEY is set (src/directStream/torrent/subtitles/wyzie.ts). */
export const DEFAULT_TORRENT_WYZIE_URL = 'https://sub.wyzie.io'

/** The model that looks at a stream's picture before it plays (src/directStream/picture.ts). */
export const DEFAULT_STREAM_PICTURE_MODEL = 'haiku'
/** The cloud provider tried first: the quickest to a stream of those measured (2026-11-18). */
export const DEFAULT_STREAM_FIRST_PROVIDER = 'cinemaos.live'
/** `NOTESD_FFMPEG_BIN`: the one ffmpeg, for the picture check's frames and for the torrent source (remux, subtitle extraction, Whisper's audio cuts). */
export const DEFAULT_FFMPEG_BIN = 'ffmpeg'

/** Direct streaming (src/directStream/*): the provider registry, resolves, sessions and the pass-through. */
export interface DirectStreamConfig {
  /**
   * `NOTESD_DIRECT_STREAM`, default on. It also needs NOTESD_MOVIES on. `off`: every /api/stream/*
   * route answers direct_stream_off, the seed is not loaded and the resolver is never run.
   */
  enabled: boolean
  /** `NOTESD_STREAM_FRESH_DAYS`, default 7: how long a stream source verified on this host counts as playable. */
  freshDays: number
  /** `NOTESD_DIRECT_STREAM_CLI`, absolute, default DEFAULT_DIRECT_STREAM_CLI: the resolver script run as `node <cli>`. */
  cli: string
  /**
   * `NOTESD_ANIME_MAP_URL`, default https://api.ani.zip: the index that maps a Japanese title's
   * TMDB id to the AniList id and episode the anime embeds are keyed by (src/directStream/anime.ts).
   * `off`: null, no lookup, and an anime is resolved like any other series.
   */
  animeMapUrl?: string | null
  /**
   * `NOTESD_STREAM_CACHE_DIR`, absolute: the folder holding this host's stream caches, one folder per
   * cache id (src/directStream/cache/). Null or unset: `<dataDir>/movies/stream-cache`.
   */
  cacheDir?: string | null
  /**
   * `NOTESD_STREAM_PICTURE_MODEL`, default haiku: the Agent SDK alias or model id that looks at two
   * frames of a stream before its first play of a title and says whether it is a proper copy, a
   * cinema recording or carries a burned-in advert (src/directStream/picture.ts). One call per title
   * and provider, on the owner's login. `off`, null or unset: no stream is looked at.
   */
  pictureModel?: string | null
  /** `NOTESD_FFMPEG_BIN`, default `ffmpeg` on PATH: reads the frames the picture check looks at. */
  ffmpegBin?: string
  /**
   * `NOTESD_STREAM_AUDIO_CHECK`, default on: before a cloud provider's first play of a foreign-language
   * title, ~30 s of its audio is passed through Whisper to hear which language is actually spoken, and a
   * provider serving a dub is passed over for one that serves the original (src/directStream/audioLang.ts).
   * Runs only when Whisper is installed and the title's original language is known and is not English.
   * `off` or unset in a literal: no cloud stream's audio is heard.
   */
  audioCheck?: boolean
  /**
   * `NOTESD_STREAM_AHEAD`, default on: while an episode of a series is watched, the next one is
   * downloaded to this machine (src/directStream/ahead.ts). `off` or unset in a literal: never.
   */
  ahead?: boolean
  /**
   * `NOTESD_STREAM_WARP`, default on: a torrent play that found no peer at all on the office network
   * (SSID Employee) with Cloudflare WARP off switches it on and asks again
   * (src/directStream/torrentWarp.ts); the streaming command's site retry reads the same variable.
   * `off` or unset in a literal: the daemon never reads or switches WARP for a play.
   */
  warp?: boolean
  /**
   * DEFAULT_STREAM_FIRST_PROVIDER: the cloud provider every resolve tries before the others, while it
   * keeps working (claude/streaming/direct/order.mjs). Null or unset in a literal: none, the providers
   * are ordered by what was measured.
   */
  firstProvider?: string | null
  /**
   * `NOTESD_STREAM_CANARY`, default on: a few minutes after start and once a day, every cloud provider is asked
   * for one known film out of sight, to keep its health on this host current (src/directStream/canary.ts).
   * `off` or unset in a literal: nothing is asked.
   */
  canary?: boolean
  /** The daily trending list. Unset in a literal: off. */
  trending?: TrendingConfig
  /**
   * `NOTESD_STREAM_PREVIEWS`, default on: seek previews (src/directStream/previews/), sprite sheets made in the
   * background by one niced ffmpeg from the part of a film that is on this machine and listed per stream session.
   * `off`, or unset in a literal: nothing is made and GET /api/stream/sessions/:id/previews answers no frame.
   */
  previews?: boolean
}

/** Direct streaming off. Tests build `Config` literals with it (or leave `directStream` out, which is the same). */
export const DEFAULT_DIRECT_STREAM_CONFIG: DirectStreamConfig = {
  enabled: false,
  freshDays: DEFAULT_STREAM_FRESH_DAYS,
  cli: DEFAULT_DIRECT_STREAM_CLI,
  cacheDir: null,
  previews: false,
}

/** `claude/streaming/torrent/whisper.py` in this checkout: the Whisper worker the torrent source runs (torrent phase 8). */
export const DEFAULT_TORRENT_WHISPER_SCRIPT = path.join(REPO_ROOT, 'claude', 'streaming', 'torrent', 'whisper.py')
/** `claude/streaming/torrent/vad.py` in this checkout: the speech detector Wyzie Synced runs with Whisper's Python. */
export const DEFAULT_TORRENT_VAD_SCRIPT = path.join(REPO_ROOT, 'claude', 'streaming', 'torrent', 'vad.py')
export const DEFAULT_TORRENT_WHISPER_MODEL = 'small'
export const DEFAULT_TORRENT_WHISPER_THREADS = 8
/** Five minutes of audio per Whisper run: cues come in steps of this, well ahead of the picture (a 5-minute stretch took 2.5 s on 8 threads). */
export const DEFAULT_TORRENT_WHISPER_STRETCH_S = 300
export const MIN_TORRENT_WHISPER_STRETCH_S = 5

/**
 * Whisper, the last subtitle tier of a torrent session (src/directStream/torrent/subtitles/whisper.ts).
 * Off carries nothing else: no folder, no model, no worker.
 */
export type TorrentWhisperConfig =
  | { enabled: false }
  | {
      /** `NOTESD_TORRENT_WHISPER`, default on. `off`: no Whisper tier and no worker. */
      enabled: true
      /** `NOTESD_TORRENT_WHISPER_DIR`, absolute, default `<dataDir>/whisper`: `venv/`, `models/` and `hf/` (scripts/install.sh fills it). */
      dir: string
      /** `NOTESD_TORRENT_WHISPER_PYTHON`, absolute, default `<dir>/venv/bin/python`. */
      python: string
      /** `NOTESD_TORRENT_WHISPER_MODEL`, default `small`: a faster-whisper model name or Hugging Face repo id. */
      model: string
      /** DEFAULT_TORRENT_WHISPER_THREADS: CPU threads of the worker. */
      threads: number
      /** `NOTESD_TORRENT_WHISPER_STRETCH_S`, default 300, at least 5: seconds of audio per Whisper run. */
      stretchS: number
    }

/** Whisper off. DEFAULT_TORRENT_CONFIG carries it, so no test that builds a Config literal ever starts a worker. */
export const DEFAULT_TORRENT_WHISPER_CONFIG: TorrentWhisperConfig = { enabled: false }

export const DEFAULT_TORRENT_UPLOAD_KBPS = 100
export const DEFAULT_TORRENT_KEEP_DAYS = 7
/** `NOTESD_TORRENT_BUDGET_GB`: the torrent folder is kept under this many GiB. */
export const DEFAULT_TORRENT_BUDGET_GB = 40

/** The JSON torrent indexes the finder asks (src/directStream/torrent/find/). */
export const TORRENT_INDEX_NAMES = ['torrentio', 'apibay', 'eztv', 'torrentsdb', 'peerflix', 'knaben', 'bitsearch', 'torrentscsv'] as const
export type TorrentIndexName = (typeof TORRENT_INDEX_NAMES)[number]

/**
 * What the torrent finder is told (torrent phase 3). A field left unset keeps the finder's own default, so
 * the defaults live in one place (phase 2's find/ module).
 */
export interface TorrentFinderConfig {
  /** `NOTESD_TORRENT_MIN_SEEDS`: a candidate with fewer seeds is never picked. */
  minSeeds?: number
  /** `NOTESD_TORRENT_MAX_GB`, as bytes: a bigger release is left out. */
  maxSizeBytes?: number
  /** How long one index may take to answer; unset: the finder's DEFAULT_INDEX_TIMEOUT_MS. */
  indexTimeoutMs?: number
  /** `NOTESD_TORRENT_<NAME>_URL` per index: an address replaces the finder's, `off` (null) never asks that index. */
  indexes: Partial<Record<TorrentIndexName, string | null>>
}

export const DEFAULT_TORRENT_FINDER_CONFIG: TorrentFinderConfig = { indexes: {} }

/**
 * Each index's address setting, spelled out (not built from the name) so `npm run docs:check` finds the names in the
 * code. tests/unit/config.torrentFinder.test.ts checks that verify.sh names every one, so no throwaway daemon asks a
 * real index.
 */
export const TORRENT_INDEX_URL_KEYS: Record<TorrentIndexName, string> = {
  torrentio: 'NOTESD_TORRENT_TORRENTIO_URL',
  apibay: 'NOTESD_TORRENT_APIBAY_URL',
  eztv: 'NOTESD_TORRENT_EZTV_URL',
  torrentsdb: 'NOTESD_TORRENT_TORRENTSDB_URL',
  peerflix: 'NOTESD_TORRENT_PEERFLIX_URL',
  knaben: 'NOTESD_TORRENT_KNABEN_URL',
  bitsearch: 'NOTESD_TORRENT_BITSEARCH_URL',
  torrentscsv: 'NOTESD_TORRENT_TORRENTSCSV_URL',
}

/** The finder's settings; a bad number or a non-http address throws ConfigError. */
export function parseTorrentFinder(env: Record<string, string | undefined>): TorrentFinderConfig {
  const indexes: Partial<Record<TorrentIndexName, string | null>> = {}
  for (const name of TORRENT_INDEX_NAMES) {
    const key = TORRENT_INDEX_URL_KEYS[name]
    const value = (env[key] ?? '').trim()
    if (value === '') continue
    if (value.toLowerCase() === 'off') {
      indexes[name] = null
      continue
    }
    if (!/^https?:\/\/[^\s]+$/.test(value)) throw new ConfigError(`${key} must be an http(s) address or off (got ${value})`)
    indexes[name] = value.replace(/\/+$/, '')
  }
  const optional = (name: string): number | undefined => {
    const raw = env[name]
    return raw === undefined || raw.trim() === '' ? undefined : parsePositiveInt(name, raw, 1)
  }
  const maxGb = optional('NOTESD_TORRENT_MAX_GB')
  return {
    minSeeds: optional('NOTESD_TORRENT_MIN_SEEDS'),
    maxSizeBytes: maxGb === undefined ? undefined : maxGb * 1024 ** 3,
    indexes,
  }
}

/** `claude/streaming/torrent/cli.mjs` in this checkout: the torrent sites script the daemon runs (torrent phase 9). */
export const DEFAULT_TORRENT_SITES_CLI = path.join(REPO_ROOT, 'claude', 'streaming', 'torrent', 'cli.mjs')

/** Where 1337x and ext.to are by default. claude/streaming/torrent/sites/*.mjs default to the same addresses (a test compares them). */
export const TORRENT_SITE_ORIGIN_DEFAULTS = { '1337x': 'https://1337x.la', ext: 'https://ext.to', rutracker: 'https://rutracker.net' } as const

/**
 * The torrent sites the finder falls back on when the JSON indexes give nothing usable, asked through
 * the streaming Chrome (src/directStream/torrent/find-sites.ts).
 */
export interface TorrentSitesConfig {
  /**
   * Each site's address, scheme and host only: `NOTESD_TORRENT_1337X_ORIGIN` (default
   * https://1337x.la), `NOTESD_TORRENT_EXT_ORIGIN` (default https://ext.to) and
   * `NOTESD_TORRENT_RUTRACKER_ORIGIN` (default https://rutracker.net, the mirror this network reaches). Null:
   * `off`, the site is never asked.
   */
  origins: { '1337x': string | null; ext: string | null; rutracker: string | null }
  /** `NOTESD_TORRENT_SITES_CLI`, absolute, default DEFAULT_TORRENT_SITES_CLI: the script run as `node <cli>`. */
  cli: string
}

export const DEFAULT_TORRENT_SITES_CONFIG: TorrentSitesConfig = {
  origins: { ...TORRENT_SITE_ORIGIN_DEFAULTS },
  cli: DEFAULT_TORRENT_SITES_CLI,
}

/** Torrents as a direct-streaming source (src/directStream/torrent/*). They also need direct streaming on. */
export interface TorrentConfig {
  /**
   * `NOTESD_TORRENT`, default on. `off`: AppDeps.torrents is null, no swarm is joined, and every
   * /api/stream/torrent route answers torrent_off.
   */
  enabled: boolean
  /** `NOTESD_TORRENT_DIR`, absolute, default `<dataDir>/movies/torrents`: one folder per info hash. Always resolved. */
  dir: string
  /** `NOTESD_TORRENT_UPLOAD_KBPS`, default 100: the upload cap in kB/s (1 kB = 1000 bytes), all torrents together. */
  uploadKbps: number
  /** `NOTESD_TORRENT_KEEP_DAYS`, default 7: a download not played for this many days is deleted with its files. */
  keepDays: number
  /**
   * `NOTESD_TORRENT_BUDGET_GB`, default 40: the torrent folder (downloads, remuxes, cue files) is kept under this many
   * GiB; the prune deletes whole torrents, least recently played first, until it is (src/directStream/torrent/service.ts).
   */
  budgetGb: number
  /**
   * `NOTESD_TORRENT_SUBTITLE_WAIT_MS`, default 1500 (source.ts SUBTITLE_HEAD_MS): how long a torrent play may wait
   * for its subtitle before it starts without one; the search then goes on behind the play. Unset: the default.
   */
  subtitleWaitMs?: number
  /** `NOTESD_TORRENT_DISCOVERY`, default on. `off`: no DHT and no trackers; peers come only from `peers`. */
  discovery: boolean
  /** `NOTESD_TORRENT_PEERS`: `host:port` addresses (comma-separated) added as a peer to every torrent. Empty by default. */
  peers: string[]
  /**
   * `NOTESD_TORRENT_TRACKER_LISTS`, default on: once a day the public tracker lists (ngosang `trackers_best`,
   * newtrackon `stable`) are read and the UDP trackers on them that answer a BEP 15 connect are added to every
   * torrent opened and every scrape (src/directStream/torrent/trackerLists.ts). Needs `discovery`. Unset (a Config
   * literal, DEFAULT_TORRENT_CONFIG): off.
   */
  trackerLists?: boolean
  /** The finder's settings (torrent phase 3); unset: the finder's defaults. */
  finder?: TorrentFinderConfig
  /** `NOTESD_FFMPEG_BIN`, default `ffmpeg` on PATH; a path is ~-expanded and made absolute (torrent phase 3). */
  ffmpegBin: string
  /**
   * `NOTESD_TORRENT_REMUX`, default on: a torrent file Chrome cannot play as is (MKV, AC3/E-AC3/DTS sound, HEVC)
   * plays as an ffmpeg remux (src/directStream/torrent/remux.ts). `off`: such a file is `unplayable` and the next
   * torrent is tried.
   */
  remux: boolean
  /**
   * `NOTESD_TORRENT_SUBTITLE_URL`, default https://opensubtitles-v3.strem.io: the subtitle service a
   * torrent without an English subtitle file asks, by the file's OpenSubtitles hash and then by the
   * IMDb id (Stremio's OpenSubtitles add-on; no key). `off`: null, and that tier is not in the chain.
   */
  subtitleUrl: string | null
  /**
   * `WYZIE_API_KEY`, trimmed; null when unset or blank. With a key, the subtitle service tier asks
   * Wyzie Subs before the add-on. Never logged, never written into attempts or kept files.
   */
  wyzieKey: string | null
  /** `NOTESD_TORRENT_WYZIE_URL`, default https://sub.wyzie.io: where Wyzie Subs is asked. `off`: null, never asked. */
  wyzieUrl: string | null
  /**
   * Wyzie Synced (src/directStream/torrent/subtitles/synced.ts): a subtitle from outside the torrent is re-timed
   * against the film's audio after the play starts. `NOTESD_TORRENT_WYZIE_SYNC`, default on; null or unset: `off`,
   * or no key, or Wyzie's address is `off`. `python` is Whisper's (`NOTESD_TORRENT_WHISPER_PYTHON`, default
   * `<NOTESD_TORRENT_WHISPER_DIR>/venv/bin/python`), read whether or not the Whisper tier is on: its package
   * carries the speech detector.
   */
  wyzieSync?: { python: string } | null
  /** 1337x and ext.to, the finder's fallback (phase 9). Unset: DEFAULT_TORRENT_SITES_CONFIG. */
  sites?: TorrentSitesConfig
  /** Whisper, the last subtitle tier (torrent phase 8). */
  whisper: TorrentWhisperConfig
}

/**
 * Torrents off. Tests build `Config` literals with it (or leave `torrent` out, which is the same). Its
 * folder is under the OS temp folder, so a test that turns torrents on without a folder never writes into
 * the owner's data directory.
 */
export const DEFAULT_TORRENT_CONFIG: TorrentConfig = {
  enabled: false,
  dir: path.join(tmpdir(), 'notesd-torrents'),
  uploadKbps: DEFAULT_TORRENT_UPLOAD_KBPS,
  keepDays: DEFAULT_TORRENT_KEEP_DAYS,
  budgetGb: DEFAULT_TORRENT_BUDGET_GB,
  discovery: true,
  peers: [],
  finder: DEFAULT_TORRENT_FINDER_CONFIG,
  ffmpegBin: DEFAULT_FFMPEG_BIN,
  remux: false,
  subtitleUrl: null,
  wyzieKey: null,
  wyzieUrl: null,
  wyzieSync: null,
  sites: DEFAULT_TORRENT_SITES_CONFIG,
  whisper: DEFAULT_TORRENT_WHISPER_CONFIG,
}

/** Seer Adversarial reviewer (src/adversary/*). */
export interface AdversaryConfig {
  /** `NOTESD_ADVERSARY`, default on. `off` starts no reviewer (deps.adversary is null). */
  enabled: boolean
  /** `ADVERSARY_DAILY_CAP`, default 15. Deep reviews per WIB day, counted in this machine's database. */
  dailyCap: number
  /** `ADVERSARY_GATHER_MODEL`, default `sonnet`. Agent SDK alias or model id for the gathering stage. */
  gatherModel: string
  /** `ADVERSARY_VERDICT_MODEL`, default `opus`. Agent SDK alias or model id for the verdict. */
  verdictModel: string
  /** `ADVERSARY_GATHER_MAX_TURNS`, default 20. Turn cap of the gathering stage per stock. */
  gatherMaxTurns: number
  /** `ADVERSARY_STOCK_TIMEOUT_MS`, default 420000. Wall clock per stock, both stages. */
  stockTimeoutMs: number
  /** `ADVERSARY_POLL_MS`, default 600000. Pause between automatic passes. */
  pollMs: number
  /** `NOTESD_SEER_DISPATCH`, default on. Start Seer's GitHub nightly from this machine once its data is fetchable. */
  dispatchNightly: boolean
}

/** Reviewer off, default limits. Tests build `Config` literals with it, so no hand-built config ever reviews. */
export const DEFAULT_ADVERSARY_CONFIG: AdversaryConfig = {
  enabled: false,
  dailyCap: DEFAULT_ADVERSARY_DAILY_CAP,
  gatherModel: DEFAULT_ADVERSARY_GATHER_MODEL,
  verdictModel: DEFAULT_ADVERSARY_VERDICT_MODEL,
  gatherMaxTurns: DEFAULT_ADVERSARY_GATHER_MAX_TURNS,
  stockTimeoutMs: DEFAULT_ADVERSARY_STOCK_TIMEOUT_MS,
  pollMs: DEFAULT_ADVERSARY_POLL_MS,
  dispatchNightly: false,
}

export const DEFAULT_MOVIES_SCAN_MS = 120_000
export const DEFAULT_MOVIES_MIN_SECONDS = 900
export const DEFAULT_MOVIES_DONE_DIRS: readonly string[] = ['Done']
export const DEFAULT_TMDB_API_BASE = 'https://api.themoviedb.org/3'
export const DEFAULT_TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p'
export const DEFAULT_FFPROBE_BIN = 'ffprobe'
export const DEFAULT_VLC_BIN = '/mnt/c/Program Files/VideoLAN/VLC/vlc.exe'
export const DEFAULT_VLC_HTTP_PORT = 47318
export const DEFAULT_VLC_POLL_MS = 5_000
export const DEFAULT_CURL_EXE = '/mnt/c/Windows/System32/curl.exe'
/** NOTESD_VLC_HEALTH_MS default: one vlc.exe sample every 30 s (src/movies/vlc/health.ts). */
export const DEFAULT_VLC_HEALTH_MS = 30_000
/** A non-zero NOTESD_VLC_HEALTH_MS below this is rejected: one PowerShell detail read takes ~0.5 s. */
export const MIN_VLC_HEALTH_MS = 5_000
export const DEFAULT_MOVIES_FALLBACK_MODEL = 'haiku'
/** The model that writes a story (src/movies/story.ts, webStory.ts) and a genre's guide (guides.ts). */
export const DEFAULT_MOVIES_STORY_MODEL = 'sonnet'

/** TMDB credentials and hosts (src/movies/tmdb.ts). Secrets are never logged. */
export interface TmdbConfig {
  /** `TMDB_API_READ_ACCESS_TOKEN` (v4 bearer), trimmed; null when unset or blank. Preferred. */
  token: string | null
  /** `TMDB_API_KEY` (v3 `api_key=`), trimmed; null when unset or blank. Used when there is no token. */
  apiKey: string | null
  /** `TMDB_API_BASE`, no trailing slash. Tests point it at a fixture server. */
  apiBase: string
  /** `TMDB_IMAGE_BASE`, no trailing slash. Poster URLs are `<imageBase>/<size><poster_path>`. */
  imageBase: string
}

/** The Windows VLC notesd launches and reads (src/movies/vlc/*). */
export interface VlcConfig {
  /** `NOTESD_VLC_BIN`. A bare name is a PATH lookup; a path is ~-expanded and made absolute. */
  bin: string
  /** `NOTESD_VLC_INI`: VLC's `vlc-qt-interface.ini`, absolute. Null turns the recents backfill off. */
  ini: string | null
  /** `NOTESD_VLC_HTTP_PORT`, 1-65535: the port of the HTTP interface of a VLC notesd starts. */
  httpPort: number
  /** `NOTESD_VLC_POLL_MS`: how often a playing VLC is read. */
  pollMs: number
  /** `NOTESD_CURL_EXE`: the Windows curl that reaches VLC's loopback-only HTTP interface. */
  curlExe: string
  /**
   * `NOTESD_VLC_HEALTH_MS`: how often every vlc.exe on this host is sampled into the health log.
   * 0 turns the health log, crash incidents and hang detection off.
   */
  healthMs: number
  /**
   * `NOTESD_VLC_EXTRA_ARGS`, split on whitespace (no quoting): appended to every VLC notesd starts,
   * before the file. Never `--http-*`, `--extraintf`, `--intf` or `-I` (notesd owns the HTTP interface).
   */
  extraArgs: string[]
}

/** The movies library (src/movies/*). */
export interface MoviesConfig {
  /** `NOTESD_MOVIES`, default on. `off` scans nothing and spawns nothing. */
  enabled: boolean
  /** `NOTESD_MOVIES_ROOTS`, `:`-separated absolute directories, scanned recursively. Empty: nothing is scanned. */
  roots: string[]
  /** `NOTESD_MOVIES_DONE_DIRS`, `:`-separated folder names (not paths), matched case-insensitively below a root. */
  doneDirs: string[]
  /** `NOTESD_MOVIES_SCAN_MS`: pause between sync passes. */
  scanMs: number
  /** `NOTESD_MOVIES_MIN_SECONDS`: shorter videos stay out of the library (unmatched, too_short). */
  minSeconds: number
  tmdb: TmdbConfig
  /** `NOTESD_FFPROBE_BIN`. A bare name is a PATH lookup; a path is ~-expanded and made absolute. */
  ffprobeBin: string
  vlc: VlcConfig
  /**
   * `NOTESD_MOVIES_FALLBACK_MODEL`: Agent SDK alias or model id that names a file TMDB could not match.
   * `off` gives null: no Haiku fallback (phase 3 then builds none; verify.sh pins it off).
   */
  fallbackModel: string | null
  /**
   * `NOTESD_MOVIES_STORY_MODEL`: Agent SDK alias or model id that writes a story when the owner asks for one
   * (src/movies/story.ts): a season's from published recaps found with WebSearch (webStory.ts), an episode's or a
   * film's from the web first and from its dialogue when the web has none. `off` gives null: no story is written
   * (stored ones are still shown; verify.sh pins it off).
   */
  storyModel?: string | null
}

/** Movies off, no roots, no TMDB credentials, no VLC ini. Tests build `Config` literals with it. */
export const DEFAULT_MOVIES_CONFIG: MoviesConfig = {
  enabled: false,
  roots: [],
  doneDirs: [...DEFAULT_MOVIES_DONE_DIRS],
  scanMs: DEFAULT_MOVIES_SCAN_MS,
  minSeconds: DEFAULT_MOVIES_MIN_SECONDS,
  tmdb: { token: null, apiKey: null, apiBase: DEFAULT_TMDB_API_BASE, imageBase: DEFAULT_TMDB_IMAGE_BASE },
  ffprobeBin: DEFAULT_FFPROBE_BIN,
  vlc: {
    bin: DEFAULT_VLC_BIN,
    ini: null,
    httpPort: DEFAULT_VLC_HTTP_PORT,
    pollMs: DEFAULT_VLC_POLL_MS,
    curlExe: DEFAULT_CURL_EXE,
    healthMs: DEFAULT_VLC_HEALTH_MS,
    extraArgs: [],
  },
  fallbackModel: DEFAULT_MOVIES_FALLBACK_MODEL,
  storyModel: DEFAULT_MOVIES_STORY_MODEL,
}

export interface Config {
  /** Runtime connection string: this machine's own Postgres in production (see `loadConfig`). */
  databaseUrl: string
  /**
   * True when `databaseUrl` is this machine's own Postgres named in `.env.local` (what
   * scripts/install.sh sets up): the daemon waits for it at start and applies the migrations. False
   * or absent for a Neon host and for a URL the real environment handed in (tests, a throwaway
   * daemon), whose caller looks after its own schema.
   */
  localDatabase?: boolean
  /**
   * The old shared database (IMPORT_DATABASE_URL), read once: what it holds is copied into
   * `databaseUrl` as soon as it answers (src/db/sharedImport.ts). Null or absent: nothing to copy.
   */
  importDatabaseUrl?: string | null
  /** `NOTESD_PORT`, default 7317. 0 means "any free port" (tests). */
  port: number
  /** Always 127.0.0.1. The daemon has no auth, so it never listens anywhere else. */
  host: typeof LOOPBACK_HOST
  /** Absolute path. `NOTES_DATA_DIR`, default ~/mcp-notes-data. Not created here. */
  dataDir: string
  /** The chat bar brain (POST /api/chat). */
  chat: ChatConfig
  /** Note embeddings via OpenRouter. `apiKey: null` turns semantic features off. */
  embeddings: EmbeddingsConfig
  /** Claude Code session ingest. `enabled: false` starts nothing (DEFAULT_SESSIONS_CONFIG in tests). */
  sessions: SessionsConfig
  /** Seer Adversarial reviewer. `enabled: false` starts nothing (DEFAULT_ADVERSARY_CONFIG in tests). */
  adversary: AdversaryConfig
  /** The dword (daily-words) connector's write identity. `userEmail: null` means every dword write refuses. */
  dword: DwordConfig
  /** The movies library. `enabled: false` starts nothing (DEFAULT_MOVIES_CONFIG in tests). */
  movies: MoviesConfig
  /** The streaming tools. Absent (a config built by a test) is the same as `enabled: false`. */
  streaming?: StreamingConfig
  /** Direct streaming. Absent (a config built by a test) is the same as `enabled: false`. */
  directStream?: DirectStreamConfig
  /** Torrents (direct streaming's torrent source). Absent (a config built by a test) is the same as `enabled: false`. */
  torrent?: TorrentConfig
}

export interface LoadConfigOptions {
  /** Environment to read. Defaults to `process.env`. Never mutated. */
  env?: NodeJS.ProcessEnv
  /**
   * Dotenv file merged under `env` (real env wins). Defaults to
   * `<REPO_ROOT>/.env.local`; `false` skips it. A missing file is not an error.
   */
  envFile?: string | false
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

function readEnvFile(file: string | false): Record<string, string> {
  if (file === false || !existsSync(file)) return {}
  return parseDotenv(readFileSync(file))
}

function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2))
  return p
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new ConfigError(`NOTESD_PORT must be an integer 0-65535, got "${raw}"`)
  }
  const port = Number(trimmed)
  if (port > 65535) {
    throw new ConfigError(`NOTESD_PORT must be an integer 0-65535, got "${raw}"`)
  }
  return port
}

/** True when `url` parses and its host is a Neon pooler host (`...-pooler...`). */
export function isPooledUrl(url: string): boolean {
  try {
    return new URL(url).host.includes('-pooler')
  } catch {
    return false
  }
}

/**
 * The runtime database URL.
 * 1. `DATABASE_URL` in the real environment (`options.env` / `process.env`) wins outright:
 *    tests and test-port runs point the daemon at the Docker Postgres this way.
 * 2. Otherwise, of `DATABASE_URL` and `DATABASE_URL_UNPOOLED` (file merged under env), the
 *    pooled one if either is pooled, else whichever exists. The owner's `.env.local` has the two
 *    key names swapped, so the choice goes by host, never by name.
 */
function pickDatabaseUrl(
  realEnv: Record<string, string | undefined>,
  merged: Record<string, string | undefined>,
): string | undefined {
  const explicit = realEnv.DATABASE_URL?.trim()
  if (explicit) return explicit
  const candidates = [merged.DATABASE_URL, merged.DATABASE_URL_UNPOOLED]
    .map((v) => v?.trim())
    .filter((v): v is string => !!v)
  return candidates.find(isPooledUrl) ?? candidates[0]
}

/**
 * The URL of the old shared database to copy from once, or null. With `DATABASE_URL` set in the
 * real environment (tests, a throwaway daemon) only the real environment counts, so such a run
 * never reads the database that `.env.local` names.
 */
function pickImportDatabaseUrl(
  realEnv: Record<string, string | undefined>,
  merged: Record<string, string | undefined>,
): string | null {
  const env = realEnv.DATABASE_URL?.trim() ? realEnv : merged
  return env.IMPORT_DATABASE_URL?.trim() || null
}

function isNeonHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === 'neon.tech' || host.endsWith('.neon.tech')
  } catch {
    return false
  }
}

function parseHost(raw: string | undefined): typeof LOOPBACK_HOST {
  if (raw === undefined || raw.trim() === '' || raw.trim() === LOOPBACK_HOST) return LOOPBACK_HOST
  throw new ConfigError(
    `NOTESD_HOST is "${raw}". notesd has no auth and binds ${LOOPBACK_HOST} only; ` +
      'unset NOTESD_HOST or set it to 127.0.0.1.',
  )
}

function parseBrain(raw: string | undefined): ChatBrain {
  const value = raw?.trim().toLowerCase() ?? ''
  if (value === '' || value === 'claude') return 'claude'
  if (value === 'glm') return 'glm'
  throw new ConfigError(`CHAT_BRAIN must be "claude" or "glm", got "${raw}"`)
}

function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1 || !Number.isSafeInteger(Number(trimmed))) {
    throw new ConfigError(`${name} must be a positive integer, got "${raw}"`)
  }
  return Number(trimmed)
}

function parseBin(raw: string | undefined, fallback: string): string {
  const value = raw?.trim() || fallback
  // A bare command name stays a PATH lookup; anything with a slash is a path.
  return value.includes('/') ? path.resolve(expandHome(value)) : value
}

const GLM_KEYS = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'] as const

function parseGlm(env: Record<string, string | undefined>): { glm: GlmConfig | null; missing: string[] } {
  const values = GLM_KEYS.map((key) => env[key]?.trim() ?? '')
  const missing = GLM_KEYS.filter((_, i) => values[i] === '')
  if (missing.length > 0) return { glm: null, missing }
  const [baseUrl = '', apiKey = '', model = ''] = values
  return { glm: { baseUrl, apiKey, model }, missing }
}

function parseChat(env: Record<string, string | undefined>): ChatConfig {
  const brain = parseBrain(env.CHAT_BRAIN)
  const { glm, missing } = parseGlm(env)
  if (brain === 'glm' && glm === null) {
    throw new ConfigError(
      `CHAT_BRAIN=glm needs ${missing.join(', ')} (set them in ${path.join(REPO_ROOT, '.env.local')}).`,
    )
  }
  return {
    brain,
    maxTurns: parsePositiveInt('CHAT_MAX_TURNS', env.CHAT_MAX_TURNS, DEFAULT_CHAT_MAX_TURNS),
    timeoutMs: parsePositiveInt('CHAT_TIMEOUT_MS', env.CHAT_TIMEOUT_MS, DEFAULT_CHAT_TIMEOUT_MS),
    claudeBin: parseBin(env.NOTESD_CLAUDE_BIN, DEFAULT_CLAUDE_BIN),
    glm,
  }
}

function parseEmbeddings(env: Record<string, string | undefined>): EmbeddingsConfig {
  const apiKey = env.OPENROUTER_API_KEY?.trim() ?? ''
  return { apiKey: apiKey === '' ? null : apiKey }
}

function parseDword(env: Record<string, string | undefined>): DwordConfig {
  const userEmail = env.DWORD_USER_EMAIL?.trim() ?? ''
  return { userEmail: userEmail === '' ? null : userEmail }
}

function parseSwitch(name: string, raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase() ?? ''
  if (value === '' || value === 'on' || value === '1' || value === 'true' || value === 'yes') return true
  if (value === 'off' || value === '0' || value === 'false' || value === 'no') return false
  throw new ConfigError(`${name} must be "on" or "off", got "${raw}"`)
}

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._[\]-]*$/

function parseModel(name: string, raw: string | undefined, fallback: string): string {
  const value = raw?.trim() ?? ''
  if (value === '') return fallback
  if (!MODEL_NAME.test(value)) throw new ConfigError(`${name} must be a model alias or id such as "opus", got "${raw}"`)
  return value
}

export function parseAdversary(env: Record<string, string | undefined>): AdversaryConfig {
  return {
    enabled: parseSwitch('NOTESD_ADVERSARY', env.NOTESD_ADVERSARY),
    dailyCap: parsePositiveInt('ADVERSARY_DAILY_CAP', env.ADVERSARY_DAILY_CAP, DEFAULT_ADVERSARY_DAILY_CAP),
    gatherModel: parseModel('ADVERSARY_GATHER_MODEL', env.ADVERSARY_GATHER_MODEL, DEFAULT_ADVERSARY_GATHER_MODEL),
    verdictModel: parseModel('ADVERSARY_VERDICT_MODEL', env.ADVERSARY_VERDICT_MODEL, DEFAULT_ADVERSARY_VERDICT_MODEL),
    gatherMaxTurns: parsePositiveInt('ADVERSARY_GATHER_MAX_TURNS', env.ADVERSARY_GATHER_MAX_TURNS, DEFAULT_ADVERSARY_GATHER_MAX_TURNS),
    stockTimeoutMs: parsePositiveInt('ADVERSARY_STOCK_TIMEOUT_MS', env.ADVERSARY_STOCK_TIMEOUT_MS, DEFAULT_ADVERSARY_STOCK_TIMEOUT_MS),
    pollMs: parsePositiveInt('ADVERSARY_POLL_MS', env.ADVERSARY_POLL_MS, DEFAULT_ADVERSARY_POLL_MS),
    dispatchNightly: parseSwitch('NOTESD_SEER_DISPATCH', env.NOTESD_SEER_DISPATCH),
  }
}

function parseSwarmScript(raw: string | undefined, claudeHome: string): string {
  const value = raw?.trim() ?? ''
  if (value === '') return path.join(claudeHome, DEFAULT_SWARM_SCRIPT_REL)
  return path.resolve(expandHome(value))
}

export function parseSessions(env: Record<string, string | undefined>): SessionsConfig {
  const claudeHome = path.resolve(expandHome(env.CLAUDE_HOME?.trim() || DEFAULT_CLAUDE_HOME))
  return {
    claudeHome,
    worktreesDir: path.resolve(expandHome(env.NOTES_WORKTREES_DIR?.trim() || DEFAULT_WORKTREES_DIR)),
    enabled: parseSwitch('NOTESD_SESSIONS', env.NOTESD_SESSIONS),
    swarmScript: parseSwarmScript(env.NOTESD_SWARM_SCRIPT, claudeHome),
  }
}

function parseSecret(raw: string | undefined): string | null {
  const value = raw?.trim() ?? ''
  return value === '' ? null : value
}

function parseAbsolutePaths(name: string, raw: string | undefined): string[] {
  const out: string[] = []
  for (const part of (raw ?? '').split(':')) {
    const value = part.trim()
    if (value === '') continue
    const expanded = expandHome(value)
    if (!path.isAbsolute(expanded)) throw new ConfigError(`${name} takes absolute paths separated by ":", got "${value}"`)
    const resolved = path.resolve(expanded)
    if (!out.includes(resolved)) out.push(resolved)
  }
  return out
}

function parseFolderNames(name: string, raw: string | undefined, fallback: readonly string[]): string[] {
  const names = (raw ?? '')
    .split(':')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (names.length === 0) return [...fallback]
  for (const n of names) {
    if (n.includes('/') || n === '.' || n === '..') throw new ConfigError(`${name} takes folder names, not paths, got "${n}"`)
  }
  return names
}

function parseOptionalAbsolutePath(name: string, raw: string | undefined): string | null {
  const value = raw?.trim() ?? ''
  if (value === '') return null
  const expanded = expandHome(value)
  if (!path.isAbsolute(expanded)) throw new ConfigError(`${name} must be an absolute path, got "${raw}"`)
  return path.resolve(expanded)
}

function parseHttpBase(name: string, raw: string | undefined, fallback: string): string {
  const value = raw?.trim() ?? ''
  if (value === '') return fallback
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConfigError(`${name} must be an http(s) URL, got "${raw}"`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ConfigError(`${name} must be an http(s) URL, got "${raw}"`)
  return value.replace(/\/+$/, '')
}

function parseTcpPort(name: string, raw: string | undefined, fallback: number): number {
  const port = parsePositiveInt(name, raw, fallback)
  if (port > 65535) throw new ConfigError(`${name} must be an integer 1-65535, got "${raw}"`)
  return port
}

function parseVlcHealthMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_VLC_HEALTH_MS
  const trimmed = raw.trim()
  const value = Number(trimmed)
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(value) || (value !== 0 && value < MIN_VLC_HEALTH_MS)) {
    throw new ConfigError(`NOTESD_VLC_HEALTH_MS must be 0 (off) or an integer of at least ${MIN_VLC_HEALTH_MS}, got "${raw}"`)
  }
  return value
}

/** notesd's own VLC flags: an extra argument may not replace them, or tracking breaks. */
const RESERVED_VLC_ARG = /^(--http-|--extraintf(=|$)|--intf(=|$)|-I$)/

function parseVlcExtraArgs(raw: string | undefined): string[] {
  const args = (raw ?? '')
    .trim()
    .split(/\s+/)
    .filter((a) => a !== '')
  for (const a of args) {
    if (RESERVED_VLC_ARG.test(a)) {
      throw new ConfigError(`NOTESD_VLC_EXTRA_ARGS must not set ${a}: notesd owns VLC's HTTP interface`)
    }
  }
  return args
}

export function parseMovies(env: Record<string, string | undefined>): MoviesConfig {
  return {
    enabled: parseSwitch('NOTESD_MOVIES', env.NOTESD_MOVIES),
    roots: parseAbsolutePaths('NOTESD_MOVIES_ROOTS', env.NOTESD_MOVIES_ROOTS),
    doneDirs: parseFolderNames('NOTESD_MOVIES_DONE_DIRS', env.NOTESD_MOVIES_DONE_DIRS, DEFAULT_MOVIES_DONE_DIRS),
    scanMs: parsePositiveInt('NOTESD_MOVIES_SCAN_MS', env.NOTESD_MOVIES_SCAN_MS, DEFAULT_MOVIES_SCAN_MS),
    minSeconds: parsePositiveInt('NOTESD_MOVIES_MIN_SECONDS', env.NOTESD_MOVIES_MIN_SECONDS, DEFAULT_MOVIES_MIN_SECONDS),
    tmdb: {
      token: parseSecret(env.TMDB_API_READ_ACCESS_TOKEN),
      apiKey: parseSecret(env.TMDB_API_KEY),
      apiBase: parseHttpBase('TMDB_API_BASE', env.TMDB_API_BASE, DEFAULT_TMDB_API_BASE),
      imageBase: parseHttpBase('TMDB_IMAGE_BASE', env.TMDB_IMAGE_BASE, DEFAULT_TMDB_IMAGE_BASE),
    },
    ffprobeBin: parseBin(env.NOTESD_FFPROBE_BIN, DEFAULT_FFPROBE_BIN),
    vlc: {
      bin: parseBin(env.NOTESD_VLC_BIN, DEFAULT_VLC_BIN),
      ini: parseOptionalAbsolutePath('NOTESD_VLC_INI', env.NOTESD_VLC_INI),
      httpPort: parseTcpPort('NOTESD_VLC_HTTP_PORT', env.NOTESD_VLC_HTTP_PORT, DEFAULT_VLC_HTTP_PORT),
      pollMs: parsePositiveInt('NOTESD_VLC_POLL_MS', env.NOTESD_VLC_POLL_MS, DEFAULT_VLC_POLL_MS),
      curlExe: parseBin(env.NOTESD_CURL_EXE, DEFAULT_CURL_EXE),
      healthMs: parseVlcHealthMs(env.NOTESD_VLC_HEALTH_MS),
      extraArgs: parseVlcExtraArgs(env.NOTESD_VLC_EXTRA_ARGS),
    },
    fallbackModel:
      env.NOTESD_MOVIES_FALLBACK_MODEL?.trim().toLowerCase() === 'off'
        ? null
        : parseModel('NOTESD_MOVIES_FALLBACK_MODEL', env.NOTESD_MOVIES_FALLBACK_MODEL, DEFAULT_MOVIES_FALLBACK_MODEL),
    storyModel:
      env.NOTESD_MOVIES_STORY_MODEL?.trim().toLowerCase() === 'off'
        ? null
        : parseModel('NOTESD_MOVIES_STORY_MODEL', env.NOTESD_MOVIES_STORY_MODEL, DEFAULT_MOVIES_STORY_MODEL),
  }
}

export function parseDirectStream(env: Record<string, string | undefined>): DirectStreamConfig {
  return {
    enabled: parseSwitch('NOTESD_DIRECT_STREAM', env.NOTESD_DIRECT_STREAM),
    freshDays: parsePositiveInt('NOTESD_STREAM_FRESH_DAYS', env.NOTESD_STREAM_FRESH_DAYS, DEFAULT_STREAM_FRESH_DAYS),
    cli: parseOptionalAbsolutePath('NOTESD_DIRECT_STREAM_CLI', env.NOTESD_DIRECT_STREAM_CLI) ?? DEFAULT_DIRECT_STREAM_CLI,
    animeMapUrl: parseUrlOrOff('NOTESD_ANIME_MAP_URL', env.NOTESD_ANIME_MAP_URL, DEFAULT_ANIME_MAP_URL),
    cacheDir: parseOptionalAbsolutePath('NOTESD_STREAM_CACHE_DIR', env.NOTESD_STREAM_CACHE_DIR),
    pictureModel:
      env.NOTESD_STREAM_PICTURE_MODEL?.trim().toLowerCase() === 'off'
        ? null
        : parseModel('NOTESD_STREAM_PICTURE_MODEL', env.NOTESD_STREAM_PICTURE_MODEL, DEFAULT_STREAM_PICTURE_MODEL),
    ffmpegBin: parseBin(env.NOTESD_FFMPEG_BIN, DEFAULT_FFMPEG_BIN),
    ahead: env.NOTESD_STREAM_AHEAD?.trim().toLowerCase() !== 'off',
    warp: env.NOTESD_STREAM_WARP?.trim().toLowerCase() !== 'off',
    firstProvider: DEFAULT_STREAM_FIRST_PROVIDER,
    audioCheck: parseSwitch('NOTESD_STREAM_AUDIO_CHECK', env.NOTESD_STREAM_AUDIO_CHECK),
    canary: parseSwitch('NOTESD_STREAM_CANARY', env.NOTESD_STREAM_CANARY),
    previews: parseSwitch('NOTESD_STREAM_PREVIEWS', env.NOTESD_STREAM_PREVIEWS),
    trending: parseTrending(env),
  }
}

export function parseTrending(env: Record<string, string | undefined>): TrendingConfig {
  return {
    enabled: parseSwitch('NOTESD_TRENDING', env.NOTESD_TRENDING),
    size: parsePositiveInt('NOTESD_TRENDING_SIZE', env.NOTESD_TRENDING_SIZE, DEFAULT_TRENDING_SIZE),
    skipLanguages: [...DEFAULT_TRENDING_SKIP_LANGUAGES],
  }
}

/** An address setting: unset or blank is `fallback`, `off` is null, anything else must be an http(s) address (trailing slashes dropped). */
function parseUrlOrOff(name: string, raw: string | undefined, fallback: string): string | null {
  const value = (raw ?? '').trim()
  if (value === '') return fallback
  if (value.toLowerCase() === 'off') return null
  if (!/^https?:\/\/[^\s]+$/.test(value)) throw new ConfigError(`${name} must be an http(s) address or off (got ${value})`)
  return value.replace(/\/+$/, '')
}

const PEER_ADDRESS = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/

function parsePeers(raw: string | undefined): string[] {
  const out: string[] = []
  for (const part of (raw ?? '').split(',')) {
    const value = part.trim()
    if (value === '') continue
    const m = PEER_ADDRESS.exec(value)
    const port = m === null ? 0 : Number(m[1])
    if (port < 1 || port > 65535) throw new ConfigError(`NOTESD_TORRENT_PEERS takes host:port addresses separated by ",", got "${value}"`)
    if (!out.includes(value)) out.push(value)
  }
  return out
}

/** `dataDir` is the resolved NOTES_DATA_DIR: the default folder is under it. */
export function parseTorrent(env: Record<string, string | undefined>, dataDir: string): TorrentConfig {
  const wyzieKey = (env.WYZIE_API_KEY ?? '').trim() || null
  const wyzieUrl = parseUrlOrOff('NOTESD_TORRENT_WYZIE_URL', env.NOTESD_TORRENT_WYZIE_URL, DEFAULT_TORRENT_WYZIE_URL)
  const sync = parseSwitch('NOTESD_TORRENT_WYZIE_SYNC', env.NOTESD_TORRENT_WYZIE_SYNC)
  return {
    enabled: parseSwitch('NOTESD_TORRENT', env.NOTESD_TORRENT),
    dir: parseOptionalAbsolutePath('NOTESD_TORRENT_DIR', env.NOTESD_TORRENT_DIR) ?? path.join(dataDir, 'movies', 'torrents'),
    uploadKbps: parsePositiveInt('NOTESD_TORRENT_UPLOAD_KBPS', env.NOTESD_TORRENT_UPLOAD_KBPS, DEFAULT_TORRENT_UPLOAD_KBPS),
    keepDays: parsePositiveInt('NOTESD_TORRENT_KEEP_DAYS', env.NOTESD_TORRENT_KEEP_DAYS, DEFAULT_TORRENT_KEEP_DAYS),
    budgetGb: parsePositiveInt('NOTESD_TORRENT_BUDGET_GB', env.NOTESD_TORRENT_BUDGET_GB, DEFAULT_TORRENT_BUDGET_GB),
    ...(env.NOTESD_TORRENT_SUBTITLE_WAIT_MS === undefined || env.NOTESD_TORRENT_SUBTITLE_WAIT_MS.trim() === ''
      ? {}
      : { subtitleWaitMs: parsePositiveInt('NOTESD_TORRENT_SUBTITLE_WAIT_MS', env.NOTESD_TORRENT_SUBTITLE_WAIT_MS, 1500) }),
    discovery: parseSwitch('NOTESD_TORRENT_DISCOVERY', env.NOTESD_TORRENT_DISCOVERY),
    peers: parsePeers(env.NOTESD_TORRENT_PEERS),
    trackerLists: parseSwitch('NOTESD_TORRENT_TRACKER_LISTS', env.NOTESD_TORRENT_TRACKER_LISTS),
    finder: parseTorrentFinder(env),
    ffmpegBin: parseBin(env.NOTESD_FFMPEG_BIN, DEFAULT_FFMPEG_BIN),
    remux: parseSwitch('NOTESD_TORRENT_REMUX', env.NOTESD_TORRENT_REMUX),
    subtitleUrl: parseUrlOrOff('NOTESD_TORRENT_SUBTITLE_URL', env.NOTESD_TORRENT_SUBTITLE_URL, DEFAULT_TORRENT_SUBTITLE_URL),
    wyzieKey,
    wyzieUrl,
    wyzieSync: sync && wyzieKey !== null && wyzieUrl !== null ? { python: whisperPython(env, dataDir) } : null,
    sites: parseTorrentSites(env),
    whisper: parseTorrentWhisper(env, dataDir),
  }
}

const WHISPER_MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

const whisperDir = (env: Record<string, string | undefined>, dataDir: string): string =>
  parseOptionalAbsolutePath('NOTESD_TORRENT_WHISPER_DIR', env.NOTESD_TORRENT_WHISPER_DIR) ?? path.join(dataDir, 'whisper')

/** The Python of Whisper's environment, whether or not the Whisper tier is on (Wyzie Synced runs its speech detector with it). */
function whisperPython(env: Record<string, string | undefined>, dataDir: string): string {
  return parseOptionalAbsolutePath('NOTESD_TORRENT_WHISPER_PYTHON', env.NOTESD_TORRENT_WHISPER_PYTHON) ?? path.join(whisperDir(env, dataDir), 'venv', 'bin', 'python')
}

export function parseTorrentWhisper(env: Record<string, string | undefined>, dataDir: string): TorrentWhisperConfig {
  if (!parseSwitch('NOTESD_TORRENT_WHISPER', env.NOTESD_TORRENT_WHISPER)) return { enabled: false }
  const dir = whisperDir(env, dataDir)
  const model = env.NOTESD_TORRENT_WHISPER_MODEL?.trim() || DEFAULT_TORRENT_WHISPER_MODEL
  if (!WHISPER_MODEL_NAME.test(model) || model.includes('..')) {
    throw new ConfigError(`NOTESD_TORRENT_WHISPER_MODEL must be a model name such as small or a repo id, got "${env.NOTESD_TORRENT_WHISPER_MODEL}"`)
  }
  const stretchS = parsePositiveInt('NOTESD_TORRENT_WHISPER_STRETCH_S', env.NOTESD_TORRENT_WHISPER_STRETCH_S, DEFAULT_TORRENT_WHISPER_STRETCH_S)
  if (stretchS < MIN_TORRENT_WHISPER_STRETCH_S) {
    throw new ConfigError(`NOTESD_TORRENT_WHISPER_STRETCH_S must be at least ${MIN_TORRENT_WHISPER_STRETCH_S}, got "${env.NOTESD_TORRENT_WHISPER_STRETCH_S}"`)
  }
  return {
    enabled: true,
    dir,
    python: whisperPython(env, dataDir),
    model,
    threads: DEFAULT_TORRENT_WHISPER_THREADS,
    stretchS,
  }
}

export function parseTorrentSites(env: Record<string, string | undefined>): TorrentSitesConfig {
  return {
    origins: {
      '1337x': parseTorrentSiteOrigin('NOTESD_TORRENT_1337X_ORIGIN', env.NOTESD_TORRENT_1337X_ORIGIN, TORRENT_SITE_ORIGIN_DEFAULTS['1337x']),
      ext: parseTorrentSiteOrigin('NOTESD_TORRENT_EXT_ORIGIN', env.NOTESD_TORRENT_EXT_ORIGIN, TORRENT_SITE_ORIGIN_DEFAULTS.ext),
      rutracker: parseTorrentSiteOrigin('NOTESD_TORRENT_RUTRACKER_ORIGIN', env.NOTESD_TORRENT_RUTRACKER_ORIGIN, TORRENT_SITE_ORIGIN_DEFAULTS.rutracker),
    },
    cli: parseOptionalAbsolutePath('NOTESD_TORRENT_SITES_CLI', env.NOTESD_TORRENT_SITES_CLI) ?? DEFAULT_TORRENT_SITES_CLI,
  }
}

/** A torrent site's address: unset or blank is the default, `off` is null, anything else must be scheme and host only. */
function parseTorrentSiteOrigin(name: string, raw: string | undefined, fallback: string): string | null {
  const value = (raw ?? '').trim()
  if (value === '') return fallback
  if (value.toLowerCase() === 'off') return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConfigError(`${name} must be a site address such as https://1337x.la, or off (got "${raw}")`)
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== value.replace(/\/+$/, '')) {
    throw new ConfigError(`${name} must be a site address such as https://1337x.la (scheme and host, no path), or off (got "${raw}")`)
  }
  return url.origin
}

/**
 * Builds the daemon config from `.env.local` plus the process environment.
 * Chat keys: CHAT_BRAIN, CHAT_MAX_TURNS, CHAT_TIMEOUT_MS, NOTESD_CLAUDE_BIN, LLM_BASE_URL,
 * LLM_API_KEY, LLM_MODEL. Embeddings key: OPENROUTER_API_KEY (unset or blank: semantic search and
 * the embedding worker are off, `related` answers only from vectors already stored; note writes are
 * unaffected). Sessions keys: CLAUDE_HOME, NOTES_WORKTREES_DIR, NOTESD_SESSIONS,
 * NOTESD_SWARM_SCRIPT. Adversary keys: NOTESD_ADVERSARY, ADVERSARY_DAILY_CAP,
 * ADVERSARY_GATHER_MODEL, ADVERSARY_VERDICT_MODEL, ADVERSARY_GATHER_MAX_TURNS,
 * ADVERSARY_STOCK_TIMEOUT_MS, ADVERSARY_POLL_MS, NOTESD_SEER_DISPATCH. Egress key: NOTESD_EGRESS_METER
 * (read by src/db/client.ts; `off` disables the query meter and the Neon quota breaker). Dword key: DWORD_USER_EMAIL
 * (unset or blank: every dword_vocab_add / dword_journal_add write tool refuses with "daily-words
 * user not configured"; dword_schema/dword_sql are unaffected, since they need no user id).
 * Movies keys: NOTESD_MOVIES, NOTESD_MOVIES_ROOTS, NOTESD_MOVIES_DONE_DIRS, NOTESD_MOVIES_SCAN_MS,
 * NOTESD_MOVIES_MIN_SECONDS, TMDB_API_READ_ACCESS_TOKEN, TMDB_API_KEY, TMDB_API_BASE, TMDB_IMAGE_BASE,
 * NOTESD_FFPROBE_BIN, NOTESD_VLC_BIN, NOTESD_VLC_INI, NOTESD_VLC_HTTP_PORT, NOTESD_VLC_POLL_MS,
 * NOTESD_CURL_EXE, NOTESD_VLC_HEALTH_MS, NOTESD_VLC_EXTRA_ARGS, NOTESD_MOVIES_FALLBACK_MODEL
 * (relative roots or ini, a path as a Done folder name, a non-http TMDB base, a port above 65535,
 * a health interval of 1-4999 ms or an extra VLC arg that sets the HTTP interface throw ConfigError).
 * Direct streaming keys: NOTESD_DIRECT_STREAM, NOTESD_STREAM_FRESH_DAYS, NOTESD_DIRECT_STREAM_CLI, NOTESD_ANIME_MAP_URL,
 * NOTESD_STREAM_CACHE_DIR (a freshness window below 1, a relative resolver path or a relative cache folder throw ConfigError).
 * Stream canary key: NOTESD_STREAM_CANARY (default on). Seek previews key: NOTESD_STREAM_PREVIEWS (default on).
 * Torrent keys: NOTESD_TORRENT, NOTESD_TORRENT_DIR, NOTESD_TORRENT_UPLOAD_KBPS, NOTESD_TORRENT_KEEP_DAYS, NOTESD_TORRENT_BUDGET_GB, NOTESD_TORRENT_SUBTITLE_WAIT_MS,
 * NOTESD_TORRENT_TRACKER_LISTS (on or off; anything else throws ConfigError),
 * NOTESD_TORRENT_DISCOVERY, NOTESD_TORRENT_PEERS (a relative folder, a cap or keep of 0, a peer without a port throw ConfigError),
 * NOTESD_TORRENT_MIN_SEEDS, NOTESD_TORRENT_MAX_GB, NOTESD_TORRENT_TORRENTIO_URL,
 * NOTESD_TORRENT_APIBAY_URL, NOTESD_TORRENT_EZTV_URL, NOTESD_TORRENT_TORRENTSDB_URL, NOTESD_TORRENT_PEERFLIX_URL,
 * NOTESD_TORRENT_KNABEN_URL, NOTESD_TORRENT_BITSEARCH_URL, NOTESD_TORRENT_TORRENTSCSV_URL (a number below 1 or a non-http address throw ConfigError),
 * NOTESD_FFMPEG_BIN.
 * Torrent Whisper keys: NOTESD_TORRENT_WHISPER, NOTESD_TORRENT_WHISPER_DIR, NOTESD_TORRENT_WHISPER_PYTHON,
 * NOTESD_TORRENT_WHISPER_MODEL, NOTESD_TORRENT_WHISPER_STRETCH_S (a relative
 * folder or Python, a model name with spaces or `..`, or a stretch under 5 s throw ConfigError).
 * Other keys are ignored. Throws `ConfigError` when neither DATABASE_URL nor DATABASE_URL_UNPOOLED is set,
 * on a bad port, on a non-loopback host, on a bad chat key, on CHAT_BRAIN=glm without LLM_*,
 * or on a NOTESD_SESSIONS value other than on/off.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const fromFile = readEnvFile(options.envFile ?? path.join(REPO_ROOT, '.env.local'))
  const realEnv: Record<string, string | undefined> = options.env ?? process.env
  const env: Record<string, string | undefined> = { ...fromFile, ...realEnv }

  const databaseUrl = pickDatabaseUrl(realEnv, env)
  if (!databaseUrl) {
    throw new ConfigError(
      `DATABASE_URL is not set. Put the Neon connection strings in ${path.join(REPO_ROOT, '.env.local')} ` +
        'or export DATABASE_URL.',
    )
  }

  const dataDirRaw = env.NOTES_DATA_DIR?.trim() || DEFAULT_DATA_DIR
  const dataDir = path.resolve(expandHome(dataDirRaw))

  return {
    databaseUrl,
    localDatabase: !realEnv.DATABASE_URL?.trim() && !isNeonHost(databaseUrl),
    importDatabaseUrl: pickImportDatabaseUrl(realEnv, env),
    port: parsePort(env.NOTESD_PORT),
    host: parseHost(env.NOTESD_HOST),
    dataDir,
    chat: parseChat(env),
    embeddings: parseEmbeddings(env),
    sessions: parseSessions(env),
    adversary: parseAdversary(env),
    dword: parseDword(env),
    movies: parseMovies(env),
    streaming: { enabled: parseSwitch('NOTESD_STREAMING', env.NOTESD_STREAMING) },
    directStream: parseDirectStream(env),
    torrent: parseTorrent(env, dataDir),
  }
}
