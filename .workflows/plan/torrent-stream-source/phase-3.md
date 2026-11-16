# Phase 3: A torrent session in direct streaming

**Plan set:** `TORRENT_STREAM_SOURCE_PLAN.md`
**Analysis:** `.workflows/analyze/20261116-192341-T7QK_code_analyzer.md`
**Satisfies:** R1, R2 — a play of a title with no cloud source (or one asked "from a torrent") streams a torrent of it in the player page
**Criteria:** R1.4, R1.6, R2.4, R2.5, R2.6, R2.9
**Depends on:** Phase 1, Phase 2
**Difficulty:** HARD
**Package:** `src/directStream`

---

## Goal

After this phase `direct_stream_play` (and `POST /api/stream/play`, the Movies page's Play, the player's previous/next
buttons) can make a stream session whose manifest is a torrent's video file served by this daemon: with
`provider: "torrent"` it asks only the torrent source, and without a provider it tries the torrent source after the
cloud providers answer `no_source` (or the resolve cannot run), listing every index and torrent tried in `attempts`. A
torrent whose file is in another language is `dubbed` and skipped, a file Chrome cannot play is `unplayable` and
skipped, a finished download of the title on this machine plays again from disk with no index and no swarm, the
session lets go of its torrent when the page closes, it moves to another torrent, it idles or it ends, and
`NOTESD_TORRENT=off` keeps every play exactly as it is today (a named torrent play answers `torrent_off`).

## Interface Contract

The reconciler reads this section to detect cross-phase conflicts. Be exact and exhaustive.

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `src/directStream/torrent/source.ts`: `TorrentSource` (class: `resolve(ref, TorrentResolveOptions)`,
  `next(ref, torrent, audioLang)`, `fromDisk(ref, { audioLang, resumeS? }) → { torrent, source, attempts } | null`,
  `hold(ref, torrent)`, `release(torrent)`, `state(torrent)`), `TorrentSourceOptions`, `TorrentResolveOptions`
  (`audioLang, imdbId, names?, resumeS?, cloudTried?, skip?`), `TitleNames`, `TorrentSwarm` (the narrow view of
  phase 1's `TorrentStreams` this phase calls: `open, use, release, find, filePath, localUrl, setDuration`),
  `OpenedTorrent`, `DownloadOnDisk`, `FindQuery` (= phase 2's `TorrentQuery`), `FindAnswer`, `FindTorrents`,
  `TorrentResolve`, `buildTorrentSource(config, torrents, wiring: { localBase, log?, tiers?, fallback? })`,
  `namesTorrent(provider)`, `torrentLabel(name)`, constants `TORRENT_PROVIDER` (`'Torrent'`), `MAX_TORRENT_TRIES` (5),
  `TORRENT_DEADLINE_MS` (90 000), `TORRENT_OPEN_TIMEOUT_MS` (20 000), `TORRENT_PROBE_TIMEOUT_MS` (30 000). Phase 1's
  `TorrentPick` is imported, not redefined.
- `src/directStream/torrent/probe.ts`: `MediaProbe` (subtitle streams carry `index, codec, lang, text, title, forced,
  hearingImpaired`), `ProbeFile` (`(url, timeoutMs) => Promise<MediaProbe>`), `ProbeError` (`code: 'timeout' | 'failed' |
  'bad_output'`), `parseProbe(raw)`, `ffprobeFile({ ffprobeBin })`, `normalizeAudioLang(tag)`, `audioLanguages(probe)`,
  `describeProbe(probe)`. (The shared contract's `probeFile(url)` is `ffprobeFile({ ffprobeBin })(url, timeoutMs)`.)
- `src/directStream/torrent/subtitles/chain.ts`: `SubtitleContext` (`ref, imdbId, infoHash, release, files, fileIndex,
  subtitleIndexes, handle, probe, audioLang, resumeS, cloudTried, localBase, signal, deadline`), `SubtitleTier`
  (`name, blocks, skip?, find`), `SubtitleChainResult` (`subtitles, attempts`), `SubtitleTierDeps` (`torrentDir,
  torrents, log`; phases 6-8 add fields), `buildSubtitleTiers(deps)` (answers `[]` in this phase, with a marked place
  per later phase), `runSubtitleChain(tiers, ctx, { log?, budgetMs?, now? })`, `SUBTITLE_BUDGET_MS` (40 000).
- `src/directStream/sessions.ts`: `SessionTorrent` (with `query` and `stop: AbortController`); `StreamSession.torrent`;
  `SessionStore.onEnd(listener)`, `SessionStore.createTorrent(...)`, `SessionStore.replaceTorrent(...)`,
  `SessionStore.live()`, `SessionStore.sweep()` (was private).
- `src/directStream/service.ts`: `SessionInfo.torrent`, `DirectStreamHooks.imdbId`, `DirectStreamHooks.titleNames`,
  `DirectStreamServiceOptions.torrent`, `DirectStreamWiring.torrent`, `DirectStreamService.letGo(id)`,
  `DirectStreamService.sweepTorrents()`, `TORRENT_IDLE_MS` (120 000).
- `src/directStream/types.ts`: resolve outcomes `'unplayable'` and `'skipped'` in `RESOLVE_OUTCOMES`; error code
  `'torrent_off'` in `DirectStreamErrorCode`.
- `src/directStream/evidence.ts`: `SessionSource.torrent`.
- `src/movies/tmdb.ts`: `TmdbTitleNames.imdbId(kind, tmdbId)`.
- `src/movies/streams.ts`: `MovieStreams.imdbId(target)`, `MovieStreams.titleNames(target)`.
- `src/config.ts`: `TorrentFinderConfig`, `TORRENT_INDEX_NAMES`, `TorrentIndexName`, `DEFAULT_TORRENT_FINDER_CONFIG`,
  `parseTorrentFinder(env)`, `DEFAULT_FFMPEG_BIN`, the fields `TorrentConfig.finder` (optional) and
  `TorrentConfig.ffmpegBin`; env vars `NOTESD_TORRENT_MIN_SEEDS`, `NOTESD_TORRENT_MAX_GB`,
  `NOTESD_TORRENT_INDEX_TIMEOUT_MS`, `NOTESD_TORRENT_TORRENTIO_URL`, `NOTESD_TORRENT_APIBAY_URL`,
  `NOTESD_TORRENT_EZTV_URL`, `NOTESD_TORRENT_YTS_URL`, `NOTESD_FFMPEG_BIN` (the one ffmpeg phases 5, 7 and 8 run).
- HTTP: 503 `torrent_off` from `POST /api/stream/play`; `GET /api/stream/sessions/:id` gains `torrent`; a
  `closed`/`ended` report to `POST /api/stream/sessions/:id/position` releases the session's torrent.
- Docs: the "Finding a torrent" part of `docs/guide/streaming.md` and the finder's proof line in the feature map
  (phase 2 touches no file outside `find/`).
- verify-notesd: `scripts/torrent/fake-index.mjs` (knobs `<run>/torrent/index-mode` and `<run>/torrent/candidates.json`;
  release names `<Title>.<Year>.<tail>` from the fake TMDB's `tmdb.json`), `scripts/direct-stream/torrent.sh`,
  `scripts/stream/torrent-play.steps.mjs`; the fake TMDB answers `/(movie|tv)/:id/external_ids`.

**Signature changes:**
- `SessionStore.create(...)` unchanged in parameters; every session it makes now has `torrent: null`.
- `StreamPositionDeps.directStream` gains the optional `letGo?(id: string): void`.

**Requires (from earlier phases):**
- Phase 1, `src/directStream/torrent/types.ts`: `TorrentFileInfo`, `TorrentHandle` (`read` end inclusive),
  `TorrentPick`, `TorrentDownload`.
- Phase 1, `TorrentStreams` (`AppDeps.torrents`, null when off) structurally assignable to this phase's `TorrentSwarm`:
  `open(pick, { timeoutMs }) → Promise<TorrentHandle>`, `use(infoHash, fileIndexes) → Promise<void>`,
  `release(infoHash) → Promise<void>`, `find(ref) → Promise<TorrentDownload | null>`, `filePath(infoHash, index) →
  Promise<string | null>`, `localUrl(infoHash, index)`, `setDuration(infoHash, seconds)`.
- Phase 1: the file route serves a `ready` download from disk without the engine; an unfinished download nothing holds
  answers 409 `not_in_swarm`.
- Phase 1: `config.torrent` (`TorrentConfig`: `enabled`, `dir`, ...), `NOTESD_TORRENT=off` pinned by `verify.sh` unless
  `--torrent`; `verify.sh up --torrent` (flag variable `torrent`, implies `--direct-stream` and `--movies`) writes
  `<run>/torrent/fixture.json` and `pack.json` with `trackers: []` (peers come from `NOTESD_TORRENT_PEERS`).
- Phase 2, `src/directStream/torrent/find/index.ts`: `findCandidates`, `defaultIndexes`, `pickFile`, `parseRelease`,
  `TorrentCandidate`, `TorrentQuery`, `TorrentIndex`, `IndexAttempt`.

**Leaves alone (owned by others):** `web/**` (phase 4, 5, 7); `src/directStream/torrent/{engine,store,service,types,serve}.ts`,
`src/http/streamTorrentApi.ts`, `src/background.ts`, the `stream_torrents` table (phase 1); everything under
`src/directStream/torrent/find/` (phase 2); `torrent/remux.ts` (phase 5); `subtitles/{files,service,borrow,embedded,whisper}.ts`
(phases 6-8); `claude/streaming/torrent/` (phase 9).

## Files

| File | Action | What changes |
|---|---|---|
| `src/directStream/types.ts:37,102` | modify | `unplayable` outcome; `torrent_off` error code |
| `src/directStream/sessions.ts` | modify (whole file below) | `SessionTorrent`, `StreamSession.torrent`, end listeners, `createTorrent`, `replaceTorrent`, `live`, public `sweep` |
| `src/directStream/torrent/probe.ts` | create | ffprobe through the file route, `MediaProbe`, `direct`, audio languages |
| `src/directStream/torrent/subtitles/chain.ts` | create | the subtitle context, tier shape, runner (stop rule, attempts, 40 s budget) and `buildSubtitleTiers`, shipped with no tier |
| `src/directStream/torrent/source.ts` | create | `TorrentSource`: find, open, `pickFile`, probe, dubbed/unplayable, subtitles, replay from disk, hold/release |
| `src/directStream/service.ts:8-33,53-78,92-123,138-160,193-213,247-256,291-295,356-359,367-370,405,439-443,478-481,723-763,785-834` | modify | the torrent branches, `letGo`, `sweepTorrents`, `SessionInfo.torrent`, the `imdbId` hook, wiring |
| `src/directStream/evidence.ts:170-235` | modify | `SessionSource.torrent` |
| `src/http/directStreamApi.ts:49-67,187-192,223-226` | modify | 503 `torrent_off`; `closed`/`ended` report calls `letGo` |
| `src/mcp/directStreamTools.ts:150-168,489,629-652` | modify | `provider: "torrent"`, `torrent_off`, the attempts wording |
| `src/mcp/instructions.ts:63` | modify | one sentence on the torrent source |
| `src/chat/prompt.ts:40` | modify | one sentence on the torrent source |
| `claude/skills/direct-stream/SKILL.md:132-170` | modify | torrent answers |
| `src/movies/tmdb.ts:120-125,336,911-914` | modify | `imdbId` from `external_ids` |
| `src/movies/streams.ts:161` | modify | `MovieStreams.imdbId`, `MovieStreams.titleNames` |
| `src/config.ts:268` and phase 1's `TorrentConfig` block | modify | `TorrentFinderConfig`, `parseTorrentFinder`, `TorrentConfig.finder`; `DEFAULT_FFMPEG_BIN`, `TorrentConfig.ffmpegBin` |
| `src/daemon.ts:28-36,189-207` | modify | build the torrent source lazily with its (empty) subtitle tiers; `imdbId` and `titleNames` hooks |
| `scripts/docs/httpRoutes.ts:223-237` | modify | play, session, source, position descriptions |
| `docs/guide/reference/{mcp-tools,http-api}.md` | regenerate | `npm run docs:gen` |
| `docs/guide/reference/configuration.md` (phase 1's torrent table) | modify | eight rows |
| `docs/guide/streaming.md` (under phase 1's Torrents heading; `:522-537`) | modify | subsection "Playing from a torrent" (with "Finding a torrent", handed over by phase 2); `torrent_off` row |
| `.claude/skills/verify-notesd/scripts/torrent/fake-index.mjs` | create | Torrentio-shaped fake index |
| `.claude/skills/verify-notesd/scripts/direct-stream/torrent.sh` | create | the journeys |
| `.claude/skills/verify-notesd/scripts/stream/torrent-play.steps.mjs` | create | the real player page on a torrent session |
| `.claude/skills/verify-notesd/scripts/movies/fake-tmdb.mjs:258` | modify | `external_ids` route |
| `.claude/skills/verify-notesd/scripts/verify.sh` (phase 1's `--torrent` blocks; `stop_run` `:465-470`) | modify | start/stop the fake index, its env |
| `.claude/skills/verify-notesd/features/direct-streaming.md` | modify | "Playing from a torrent" section |
| `tests/unit/directStream/torrentProbe.test.ts` | create | `parseProbe`, `direct`, languages (parity with `lang.mjs`) |
| `tests/unit/directStream/torrentSource.test.ts` | create | `TorrentSource` with a fake swarm, finder and probe |
| `tests/unit/directStream/torrentPlay.test.ts` | create | the service through its routes |
| `tests/unit/config.torrentFinder.test.ts` | create | the finder's settings, `NOTESD_FFMPEG_BIN` |
| `tests/unit/config.test.ts` (phase 1's whole-object torrent expectation) | modify | `finder`, `ffmpegBin` |
| `tests/unit/movies/tmdb.lists.test.ts:82` | modify | `imdbId` |
| `tests/unit/mcp.directStreamTools.test.ts:257` | modify | `provider: "torrent"`, `torrent_off` |

## Implementation Steps

Order: steps 1-3 build the leaf modules (each ends in a passing unit test file), steps 4-6 the session store and the
service branches (ending in `torrentPlay.test.ts`), steps 7-11 the edges (HTTP, MCP, TMDB, config, wiring), steps 12-15
docs and the harness. `npm run typecheck` must pass after every step from step 4 on.

**Note on the parallel picture-check work:** main has since landed it (commit `53806be`, "look at a stream's picture before it plays") with changes to `src/directStream/service.ts`
(a `vetted` resolve loop around `play`). Every edit below to `service.ts` is either a new private method or a change of
at most a few lines inside an existing method; when the merge meets the picture check's `play`, keep its loop and put
`this.sessionFor(ref, resumeS)` / the `namesTorrent` branch of step 6.2 where its loop asks `this.resolve(...)` without a
provider. Nothing in `torrent/source.ts` depends on that work.

### Step 1: The probe
**File:** `src/directStream/torrent/probe.ts` (new)
**Change:** ffprobe reads the header of the chosen file through the daemon's own file route (phase 1 blocks a range
request until its pieces arrive, so a dead torrent shows as a timeout). The answer is parsed once here into a
`MediaProbe`; `direct` says Chrome plays it as is. Language tags are brought to ISO 639-1 the same way
`claude/streaming/direct/lang.mjs` does (the daemon does not import from `claude/`; a test keeps the two in step).
**Code:**
```ts
import { execFile } from 'node:child_process';
import { z } from 'zod';

/**
 * What a torrent's chosen file holds, read by ffprobe through this daemon's file route
 * (`/api/stream/torrent/<hash>/f/<index>`; phase 1 answers a range as soon as its pieces are on disk).
 * Torrent phase 3 decides with it whether the file plays (`direct`) and in which language (`audio`);
 * phases 5 to 7 read the rest (the duration for the remux, the text subtitle tracks).
 */

export const PROBE_MAX_BUFFER = 4 * 1024 * 1024;

export interface MediaProbe {
  /** ffprobe's `format_name`, lower case: `mov,mp4,m4a,3gp,3g2,mj2`, `matroska,webm`, ... */
  container: string;
  /** The first real video stream (a cover picture is not one); null when there is none. */
  video: { codec: string; height: number | null } | null;
  /** Every audio stream in order; `lang` is the stream's language tag as written (`eng`), null when it has none. */
  audio: Array<{ codec: string; lang: string | null }>;
  /**
   * Every subtitle stream; `index` is ffprobe's stream index (ffmpeg's `0:<index>`), `text` is false for a picture
   * track (PGS, VobSub, DVB), `title` is its `tags.title`, `forced` and `hearingImpaired` its dispositions (phase 7
   * tells a full English track from a forced or SDH one by them).
   */
  subtitles: Array<{ index: number; codec: string; lang: string | null; text: boolean; title: string | null; forced: boolean; hearingImpaired: boolean }>;
  durationS: number | null;
  /**
   * Chrome's <video> plays the file as is: MP4 with H.264 video and AAC or MP3 audio, or WebM/Matroska with
   * VP8, VP9 or AV1 and Opus or Vorbis. Anything else needs phase 5's remux.
   */
  direct: boolean;
}

/** Reads one file over HTTP. Rejects with ProbeError. */
export type ProbeFile = (url: string, timeoutMs: number) => Promise<MediaProbe>;

export type ProbeErrorCode = 'timeout' | 'failed' | 'bad_output';

export class ProbeError extends Error {
  override name = 'ProbeError';

  constructor(
    readonly code: ProbeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const streamSchema = z.object({
  index: z.number().int(),
  codec_type: z.string().nullish(),
  codec_name: z.string().nullish(),
  height: z.number().int().nullish(),
  disposition: z.object({ attached_pic: z.number().nullish(), forced: z.number().nullish(), hearing_impaired: z.number().nullish() }).nullish(),
  tags: z.object({ language: z.string().nullish(), title: z.string().nullish() }).nullish(),
});

const probeSchema = z.object({
  streams: z.array(streamSchema).nullish(),
  format: z.object({ format_name: z.string().nullish(), duration: z.string().nullish() }).nullish(),
});

const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);
const WEBM_VIDEO = new Set(['vp8', 'vp9', 'av1']);
const WEBM_AUDIO = new Set(['opus', 'vorbis']);
const MP4_AUDIO = new Set(['aac', 'mp3']);

const present = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim());

function playsAsIs(container: string, video: MediaProbe['video'], audio: MediaProbe['audio']): boolean {
  if (video === null) return false;
  const formats = container.split(',');
  if (formats.includes('mp4')) return video.codec === 'h264' && audio.every((a) => MP4_AUDIO.has(a.codec));
  if (formats.includes('webm')) return WEBM_VIDEO.has(video.codec) && audio.every((a) => WEBM_AUDIO.has(a.codec));
  return false;
}

/** ffprobe's `-print_format json -show_format -show_streams` answer, validated once here. Throws ProbeError `bad_output`. */
export function parseProbe(raw: unknown): MediaProbe {
  const parsed = probeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProbeError('bad_output', `ffprobe printed an answer notesd cannot read: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'answer'}: ${i.message}`).join('; ')}`);
  }
  const streams = parsed.data.streams ?? [];
  const container = (parsed.data.format?.format_name ?? '').toLowerCase();
  const first = streams.find((s) => s.codec_type === 'video' && (s.disposition?.attached_pic ?? 0) !== 1);
  const video = first === undefined ? null : { codec: (first.codec_name ?? '').toLowerCase(), height: first.height ?? null };
  const audio = streams
    .filter((s) => s.codec_type === 'audio')
    .map((s) => ({ codec: (s.codec_name ?? '').toLowerCase(), lang: present(s.tags?.language) }));
  const subtitles = streams
    .filter((s) => s.codec_type === 'subtitle')
    .map((s) => {
      const codec = (s.codec_name ?? '').toLowerCase();
      return {
        index: s.index,
        codec,
        lang: present(s.tags?.language),
        text: TEXT_SUBTITLE_CODECS.has(codec),
        title: present(s.tags?.title),
        forced: (s.disposition?.forced ?? 0) === 1,
        hearingImpaired: (s.disposition?.hearing_impaired ?? 0) === 1,
      };
    });
  const duration = Number(parsed.data.format?.duration ?? Number.NaN);
  return {
    container,
    video,
    audio,
    subtitles,
    durationS: Number.isFinite(duration) && duration > 0 ? duration : null,
    direct: playsAsIs(container, video, audio),
  };
}

/** ffprobe on a URL. A run past `timeoutMs` is killed and rejects with `timeout`: the swarm sent too little in time. */
export function ffprobeFile(options: { ffprobeBin: string }): ProbeFile {
  return (url, timeoutMs) =>
    new Promise<MediaProbe>((resolve, reject) => {
      execFile(
        options.ffprobeBin,
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', url],
        { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: PROBE_MAX_BUFFER },
        (err, stdout) => {
          if (err !== null) {
            const killed = (err as { killed?: boolean }).killed === true;
            reject(new ProbeError(killed ? 'timeout' : 'failed', killed ? `ffprobe gave up after ${Math.round(timeoutMs / 1000)} s` : err.message));
            return;
          }
          let raw: unknown;
          try {
            raw = JSON.parse(stdout);
          } catch {
            reject(new ProbeError('bad_output', 'ffprobe did not print JSON'));
            return;
          }
          try {
            resolve(parseProbe(raw));
          } catch (parseErr) {
            reject(parseErr);
          }
        },
      );
    });
}

/** 639-2 (both forms) and common names -> 639-1. The same table as claude/streaming/direct/lang.mjs (a test compares them). */
const TO_TWO: ReadonlyMap<string, string> = new Map(
  Object.entries({
    en: ['eng', 'english'],
    ko: ['kor', 'korean'],
    ja: ['jpn', 'japanese'],
    zh: ['chi', 'zho', 'cmn', 'yue', 'cn', 'chinese', 'mandarin', 'cantonese'],
    es: ['spa', 'spanish', 'espanol', 'castellano', 'latino'],
    fr: ['fre', 'fra', 'french', 'francais'],
    de: ['ger', 'deu', 'german', 'deutsch'],
    it: ['ita', 'italian', 'italiano'],
    pt: ['por', 'portuguese', 'portugues'],
    ru: ['rus', 'russian'],
    hi: ['hin', 'hindi'],
    ta: ['tam', 'tamil'],
    te: ['tel', 'telugu'],
    ml: ['mal', 'malayalam'],
    kn: ['kan', 'kannada'],
    bn: ['ben', 'bengali'],
    mr: ['mar', 'marathi'],
    pa: ['pan', 'punjabi'],
    ur: ['urd', 'urdu'],
    id: ['ind', 'indonesian', 'bahasa'],
    ms: ['may', 'msa', 'malay'],
    th: ['tha', 'thai'],
    vi: ['vie', 'vietnamese'],
    tl: ['tgl', 'fil', 'tagalog', 'filipino'],
    tr: ['tur', 'turkish'],
    ar: ['ara', 'arabic'],
    fa: ['per', 'fas', 'persian', 'farsi'],
    he: ['heb', 'hebrew', 'iw'],
    pl: ['pol', 'polish'],
    nl: ['dut', 'nld', 'dutch'],
    sv: ['swe', 'swedish'],
    no: ['nor', 'nob', 'nno', 'nb', 'nn', 'norwegian'],
    da: ['dan', 'danish'],
    fi: ['fin', 'finnish'],
    is: ['ice', 'isl', 'icelandic'],
    cs: ['cze', 'ces', 'czech'],
    sk: ['slo', 'slk', 'slovak'],
    hu: ['hun', 'hungarian'],
    ro: ['rum', 'ron', 'romanian'],
    bg: ['bul', 'bulgarian'],
    el: ['gre', 'ell', 'greek'],
    uk: ['ukr', 'ukrainian'],
    sr: ['srp', 'serbian'],
    hr: ['hrv', 'croatian'],
    ca: ['cat', 'catalan'],
    la: ['lat', 'latin'],
  }).flatMap(([two, others]) => [[two, two] as const, ...others.map((other) => [other, two] as const)]),
);

/** Tags that name no language. */
const NO_LANGUAGE = new Set(['', 'und', 'unk', 'mul', 'zxx', 'mis', 'qaa', 'xx', 'unknown', 'undefined', 'default', 'original', 'audio']);

/** One language tag in the common form ("eng", "en-US", "English" are "en"); null when it names no language ("und"). */
export function normalizeAudioLang(tag: string | null): string | null {
  const text = (tag ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
  const head = text.split(/[-_\s(]/)[0] ?? '';
  if (NO_LANGUAGE.has(text) || NO_LANGUAGE.has(head)) return null;
  const known = TO_TWO.get(text) ?? TO_TWO.get(head);
  if (known !== undefined) return known;
  return /^[a-z]{2,3}$/.test(head) ? head : null;
}

/** The distinct languages the file's audio streams name, in order; empty when none names one. */
export function audioLanguages(probe: MediaProbe): string[] {
  const out: string[] = [];
  for (const a of probe.audio) {
    const lang = normalizeAudioLang(a.lang);
    if (lang !== null && !out.includes(lang)) out.push(lang);
  }
  return out;
}

/** `mp4 h264 720p / aac`: one line for an attempt's detail and the log. */
export function describeProbe(probe: MediaProbe): string {
  const format = probe.container.split(',')[0] || 'unknown';
  const video = probe.video === null ? 'no video' : `${probe.video.codec}${probe.video.height === null ? '' : ` ${probe.video.height}p`}`;
  const audio = probe.audio.map((a) => a.codec).join('+') || 'no audio';
  return `${format} ${video} / ${audio}`;
}
```
**Impact:** new module, no caller yet.

**Test:** `tests/unit/directStream/torrentProbe.test.ts` (new)
```ts
import { describe, expect, it } from 'vitest';
import { normalizeLang } from '../../../claude/streaming/direct/lang.mjs';
import { audioLanguages, describeProbe, normalizeAudioLang, parseProbe, ProbeError } from '../../../src/directStream/torrent/probe.js';

const mp4 = {
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', height: 720 },
    { index: 1, codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng' } },
    { index: 2, codec_type: 'video', codec_name: 'mjpeg', height: 300, disposition: { attached_pic: 1 } },
  ],
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '62.500000' },
};

describe('parseProbe', () => {
  it('reads an H.264/AAC MP4 as direct, its 720p picture, English audio and duration, and skips a cover picture', () => {
    const probe = parseProbe(mp4);
    expect(probe).toEqual({
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
      video: { codec: 'h264', height: 720 },
      audio: [{ codec: 'aac', lang: 'eng' }],
      subtitles: [],
      durationS: 62.5,
      direct: true,
    });
    expect(audioLanguages(probe)).toEqual(['en']);
    expect(describeProbe(probe)).toBe('mov h264 720p / aac');
  });

  it('marks an MKV with HEVC and E-AC3, and an MP4 with AC3 audio, as not direct', () => {
    const mkv = parseProbe({
      streams: [
        { index: 0, codec_type: 'video', codec_name: 'hevc', height: 1080 },
        { index: 1, codec_type: 'audio', codec_name: 'eac3', tags: { language: 'kor' } },
        { index: 2, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } },
        { index: 3, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng', title: 'English SDH' }, disposition: { hearing_impaired: 1 } },
      ],
      format: { format_name: 'matroska,webm', duration: '5400.0' },
    });
    expect(mkv.direct).toBe(false);
    expect(mkv.subtitles).toEqual([
      { index: 2, codec: 'subrip', lang: 'eng', text: true, title: null, forced: false, hearingImpaired: false },
      { index: 3, codec: 'hdmv_pgs_subtitle', lang: 'eng', text: false, title: 'English SDH', forced: false, hearingImpaired: true },
    ]);
    expect(parseProbe({ ...mp4, streams: [mp4.streams[0], { index: 1, codec_type: 'audio', codec_name: 'ac3' }] }).direct).toBe(false);
  });

  it('plays a WebM with VP9 and Opus as is, and a file with no video never', () => {
    expect(parseProbe({ streams: [{ index: 0, codec_type: 'video', codec_name: 'vp9', height: 1080 }, { index: 1, codec_type: 'audio', codec_name: 'opus' }], format: { format_name: 'matroska,webm' } }).direct).toBe(true);
    expect(parseProbe({ streams: [{ index: 0, codec_type: 'audio', codec_name: 'aac' }], format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' } }).direct).toBe(false);
  });

  it('rejects an answer of the wrong shape as bad_output', () => {
    expect(() => parseProbe({ streams: 'x' })).toThrow(ProbeError);
  });
});

describe('normalizeAudioLang', () => {
  it('agrees with the resolver\'s lang.mjs on every kind of tag', () => {
    for (const tag of ['eng', 'English', 'en-US', 'kor', 'Korean', 'jpn', 'chi', 'fre', 'ger', 'spa', 'por', 'hin', 'ind', 'tha', 'und', '', 'haw', 'xx', 'nob', 'Español']) {
      expect(normalizeAudioLang(tag)).toBe(normalizeLang(tag));
    }
  });
});
```

### Step 2: The subtitle chain, shipped empty
**File:** `src/directStream/torrent/subtitles/chain.ts` (new)
**Change:** the one `SubtitleContext` every tier of phases 6, 7 and 8 reads (one name per fact), the tier shape, the
runner with its stop rule, attempts and shared budget, and `buildSubtitleTiers` with a marked place for each later
phase's tiers. Decided at reconciliation: the chain stops at the first **non-empty** answer (every tier answers only
English tracks, or the torrent's one subtitle file that names no language, R3.1); the tiers that hold up a play share
one budget of 40 s from the moment the chain starts; the growing tiers never block and are not counted. Order:
`kept`, `files` (phase 6), `embedded` (phase 7), `service`, `borrow` (phase 6), `whisper` (phase 8). Later phases add
tiers and `SubtitleTierDeps` fields; they never change `SubtitleContext`, `SubtitleTier` or `runSubtitleChain`.
**Code:**
```ts
import type { CacheSubtitleView } from '../../cachePlay.js';
import type { ResolveAttempt, StreamRef } from '../../types.js';
import type { MediaProbe } from '../probe.js';
import type { TorrentStreams } from '../service.js';
import type { TorrentFileInfo, TorrentHandle } from '../types.js';

/**
 * Where a torrent session's English subtitle comes from (torrent phase 3 ships the chain; phase 6 adds kept, files,
 * service and borrow, phase 7 the embedded track, phase 8 Whisper). The chain stops at the first tier that answers
 * anything: every tier answers only English tracks, or the torrent's one subtitle file that names no language, which
 * the page shows by default.
 */

/** The tiers that hold up a play (`blocks: true`) share this budget, counted from the moment the chain starts. */
export const SUBTITLE_BUDGET_MS = 40_000;

/** What every subtitle tier knows about the play. TorrentSource builds it once per play; one name per fact. */
export interface SubtitleContext {
  ref: StreamRef;
  /** The title's IMDb id (`tt1727587`); null on a replay from disk. */
  imdbId: string | null;
  infoHash: string;
  /** The release name (the candidate's `name`; on a replay the download's recorded release, else the torrent's name). */
  release: string;
  /** Every file of the torrent; [] on a replay from disk (no swarm was joined). */
  files: readonly TorrentFileInfo[];
  /** The chosen video file's index in the torrent. */
  fileIndex: number;
  /** The subtitle files pickFile chose beside the video (downloaded with it); [] on a replay. */
  subtitleIndexes: readonly number[];
  /** The open torrent, to read bytes of its files (`end` inclusive); null on a replay from disk. */
  handle: Pick<TorrentHandle, 'read'> | null;
  /** The chosen file as ffprobe read it: its length, audio streams and subtitle streams. */
  probe: MediaProbe;
  /** The title's original language (TMDB's two-letter code), or null. */
  audioLang: string | null;
  /** Where the play starts, in seconds; null: from the start. */
  resumeS: number | null;
  /** The play asked the cloud providers first and none could stream the title (the fall-through after `no_source`). */
  cloudTried: boolean;
  /** This daemon's origin as ffmpeg reaches it (`http://127.0.0.1:<port>`); the file route is `localBase` + `localUrl`. */
  localBase: string;
  /** Aborted when the session lets go of the torrent (page closed, film ended, shuffle, idle, session end). A growing tier stops its work. */
  signal: AbortSignal;
  /** When the blocking tiers' shared budget runs out (ms since the epoch). Set by runSubtitleChain; a blocking tier caps its own waits at it. */
  deadline: number;
}

export interface SubtitleTier {
  readonly name: string;
  /**
   * true: the play waits for this tier's answer, within the shared SUBTITLE_BUDGET_MS (kept, files, service, borrow).
   * false: a growing tier that answers its track at once and fills it in the background (embedded, whisper).
   */
  readonly blocks: boolean;
  /** Why this tier is not asked for this play, or null; the chain records a `skipped` attempt with that reason. */
  skip?(ctx: SubtitleContext): string | null;
  /** The tier's tracks (WebVTT or cue-feed addresses on this daemon); [] for "none here". Throws for "this source failed". */
  find(ctx: SubtitleContext): Promise<CacheSubtitleView[]>;
}

export interface SubtitleChainResult {
  subtitles: CacheSubtitleView[];
  /** One `Subtitles: <tier>` attempt per tier reached: `resolved`, `no_stream`, `error` or `skipped`. */
  attempts: ResolveAttempt[];
}

/** What src/daemon.ts hands buildSubtitleTiers. Phases 6 to 8 add the fields their tiers need. */
export interface SubtitleTierDeps {
  /** config.torrent.dir: a torrent's sidecar folders live under `<dir>/<info hash>/` and go with it on prune. */
  torrentDir: string;
  /** Phase 1's TorrentStreams (AppDeps.torrents). */
  torrents: TorrentStreams;
  log: (line: string) => void;
  // Phase 6: subtitleUrl, fetch, lend, convertAss. Phase 7: embedded. Phase 8: whisper.
}

/** The daemon's subtitle tiers, in order. Phase 3: none. Each later phase inserts its tiers at its comment. */
export function buildSubtitleTiers(_deps: SubtitleTierDeps): SubtitleTier[] {
  return [
    // Phase 6: kept, files.
    // Phase 7: embedded.
    // Phase 6: service, borrow.
    // Phase 8: whisper.
  ];
}

const seconds = (ms: number): number => Math.round(ms / 100) / 10;
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function within<T>(work: Promise<T>, ms: number, budgetMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`gave up: the ${budgetMs / 1000} s subtitle budget ran out`)), Math.max(0, ms));
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * Asks the tiers in order and stops at the first that answers anything. A tier with a `skip` reason, or a blocking
 * tier that would start after the shared budget is spent, is a `skipped` attempt; a blocking tier still running when
 * the budget runs out, or one that throws, is an `error` attempt and the next is asked. Never throws.
 */
export async function runSubtitleChain(
  tiers: readonly SubtitleTier[],
  ctx: Omit<SubtitleContext, 'deadline'>,
  options: { log?: (line: string) => void; budgetMs?: number; now?: () => number } = {},
): Promise<SubtitleChainResult> {
  const now = options.now ?? (() => Date.now());
  const budgetMs = options.budgetMs ?? SUBTITLE_BUDGET_MS;
  const full: SubtitleContext = { ...ctx, deadline: now() + budgetMs };
  const attempts: ResolveAttempt[] = [];
  for (const tier of tiers) {
    const provider = `Subtitles: ${tier.name}`;
    const why = tier.skip?.(full) ?? null;
    if (why !== null) {
      attempts.push({ provider, outcome: 'skipped', took_s: 0, detail: why });
      continue;
    }
    const left = full.deadline - now();
    if (tier.blocks && left <= 0) {
      attempts.push({ provider, outcome: 'skipped', took_s: 0, detail: `the ${budgetMs / 1000} s subtitle budget was spent` });
      continue;
    }
    const started = now();
    try {
      const found = tier.blocks ? await within(tier.find(full), left, budgetMs) : await tier.find(full);
      const tookS = seconds(now() - started);
      if (found.length > 0) {
        attempts.push({ provider, outcome: 'resolved', took_s: tookS, detail: found.map((t) => t.label || 'a subtitle that names no language').join(', ') });
        return { subtitles: found, attempts };
      }
      attempts.push({ provider, outcome: 'no_stream', took_s: tookS, detail: 'no English subtitle here' });
    } catch (err) {
      options.log?.(`[notesd] torrent: the ${tier.name} subtitle tier failed for ${ctx.infoHash}: ${messageOf(err)}`);
      attempts.push({ provider, outcome: 'error', took_s: seconds(now() - started), detail: messageOf(err) });
    }
  }
  return { subtitles: [], attempts };
}
```
**Impact:** new module. The chain's tests are in step 3's file.

### Step 3: `TorrentSource`
**File:** `src/directStream/torrent/source.ts` (new)
**Change:** everything a torrent play does before the session exists, behind one class the service calls. The swarm,
the finder, the probe and the subtitle tiers are injected (tests fake all four). The swarm is typed by this phase's
own narrow `TorrentSwarm`, which phase 1's `TorrentStreams` must satisfy structurally.
**Code:**
```ts
import { DEFAULT_TORRENT_FINDER_CONFIG, TORRENT_INDEX_NAMES, type Config, type TorrentIndexName } from '../../config.js';
import type { SessionTorrent } from '../sessions.js';
import { isEnglish, refLabel, type ResolveAttempt, type ResolveOutcome, type ResolvedSource, type SourceAudio, type StreamRef } from '../types.js';
import { defaultIndexes, findCandidates, pickFile, type IndexAttempt, type TorrentCandidate, type TorrentIndex, type TorrentQuery } from './find/index.js';
import { audioLanguages, describeProbe, ffprobeFile, normalizeAudioLang, ProbeError, type MediaProbe, type ProbeFile } from './probe.js';
import { runSubtitleChain, type SubtitleTier } from './subtitles/chain.js';
import type { TorrentDownload, TorrentFileInfo, TorrentHandle, TorrentPick } from './types.js';

/**
 * The torrent source of direct streaming (torrent phase 3). DirectStreamService calls only this: it finds the
 * title's torrents by IMDb id (phase 2's findCandidates), opens each in turn in the swarm (phase 1's
 * TorrentStreams) until one holds a file that plays in the title's original language, and answers the session's
 * SessionTorrent and the ResolvedSource stand-in a session carries. Nothing here decides the order of the
 * candidates (phase 2 does) or how bytes are fetched (phase 1 does). It never runs inside
 * DirectStreamService.serial(): phase 6's borrow tier calls subtitleText, which queues there.
 */

/** The provider every torrent session carries (movie_plays, the stream on screen, the player). */
export const TORRENT_PROVIDER = 'Torrent';
/** Torrents opened per play (and per shuffle) before the answer is no_source. */
export const MAX_TORRENT_TRIES = 5;
/** A torrent play's whole budget: finding, opening and probing (the subtitle chain has its own, SUBTITLE_BUDGET_MS). */
export const TORRENT_DEADLINE_MS = 90_000;
/** One torrent's file list must arrive within this. */
export const TORRENT_OPEN_TIMEOUT_MS = 20_000;
/** ffprobe must have read the file's header within this. */
export const TORRENT_PROBE_TIMEOUT_MS = 30_000;
/** The least time a probe is given, even late in the budget. */
const PROBE_MIN_MS = 5_000;

/** True for the provider name that asks the torrent source ("torrent", any case). */
export const namesTorrent = (provider: string | null | undefined): boolean => (provider ?? '').trim().toLowerCase() === 'torrent';

/** An attempt's provider for one torrent: `Torrent: <release name>`. */
export const torrentLabel = (name: string): string => `${TORRENT_PROVIDER}: ${name}`;

export type FindQuery = TorrentQuery;
export type FindAnswer = Awaited<ReturnType<typeof findCandidates>>;
export type FindTorrents = (query: FindQuery, signal: AbortSignal) => Promise<FindAnswer>;

/** What open answers once the swarm sent the file list (nothing is selected yet): phase 1's TorrentHandle fits. */
export interface OpenedTorrent {
  readonly infoHash: string;
  readonly files: readonly TorrentFileInfo[];
  /** Phase 1's TorrentHandle.read (`end` inclusive); the subtitle tiers read bytes with it. Absent in tests' fakes. */
  read?: TorrentHandle['read'];
}

/** This host's record of a title's torrent download (phase 1's TorrentDownload fits). */
export type DownloadOnDisk = Pick<TorrentDownload, 'infoHash' | 'name' | 'fileIndex' | 'state'> & { release?: string | null };

/** The part of phase 1's TorrentStreams (AppDeps.torrents) this module calls. */
export interface TorrentSwarm {
  open(pick: TorrentPick, options: { timeoutMs: number }): Promise<OpenedTorrent>;
  /** Selects the files and marks the torrent in use (one more user). */
  use(infoHash: string, fileIndexes: readonly number[]): unknown;
  /** One user fewer; with none left the daemon leaves the swarm. Safe for a torrent opened and never used. */
  release(infoHash: string): unknown;
  find(ref: StreamRef): Promise<DownloadOnDisk | null>;
  /** The file's absolute path once it is whole on disk, else null. */
  filePath(infoHash: string, index: number): string | null | Promise<string | null>;
  /** `/api/stream/torrent/<hash>/f/<index>`. */
  localUrl(infoHash: string, index: number): string;
  /** The video's length once the probe knows it: `/map` then answers seconds (phase 4's grey bar). */
  setDuration(infoHash: string, seconds: number): unknown;
}

export interface TorrentSourceOptions {
  swarm: TorrentSwarm;
  find: FindTorrents;
  probe: ProbeFile;
  tiers: readonly SubtitleTier[];
  /** This daemon's origin as ffprobe reaches it (`http://127.0.0.1:<port>`); read at play time. */
  localBase: () => string;
  now?: () => number;
  log?: (line: string) => void;
}

/** The title's names and year, for the finder's title check and phase 9's 1337x search. */
export interface TitleNames {
  title: string;
  originalTitle: string | null;
  year: number | null;
}

export interface TorrentResolveOptions {
  /** The title's original language (TMDB's code); null: unknown. */
  audioLang: string | null;
  /** The title's IMDb id; null: no index can be asked. */
  imdbId: string | null;
  names?: TitleNames | null;
  /** Where the play starts, in seconds (phase 8's Whisper transcribes from there first). */
  resumeS?: number | null;
  /** The cloud providers were asked first and none could stream the title (phase 6's borrow tier then asks nothing). */
  cloudTried?: boolean;
  /** Info hashes not to try. */
  skip?: readonly string[];
}

export type TorrentResolve =
  | { ok: true; torrent: SessionTorrent; source: ResolvedSource; attempts: ResolveAttempt[] }
  | { ok: false; error: 'no_source'; attempts: ResolveAttempt[] };

/** What one play knows besides the candidate: the same for every torrent it tries. */
interface PlayFacts {
  audioLang: string | null;
  imdbId: string;
  resumeS: number | null;
  cloudTried: boolean;
}

type Tried =
  | { ok: true; torrent: SessionTorrent; source: ResolvedSource; attempt: ResolveAttempt; subtitleAttempts: ResolveAttempt[] }
  | { ok: false; attempt: ResolveAttempt };

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const seconds = (from: number, to: number): number => Math.round((to - from) / 100) / 10;
const pad = (n: number): string => String(n).padStart(2, '0');

/** An index's outcome as an attempt's: an index that listed torrents `resolved`, an empty one `no_stream`. */
const INDEX_OUTCOMES: Record<IndexAttempt['outcome'], ResolveOutcome> = { ok: 'resolved', empty: 'no_stream', error: 'error', bot_check: 'bot_check' };

function indexAttempt(a: IndexAttempt): ResolveAttempt {
  return { provider: `Index: ${a.index}`, outcome: INDEX_OUTCOMES[a.outcome], took_s: a.took_s, detail: a.detail };
}

/** The finder's query: the IMDb id, the title's names and year, its original language, and the episode for a series. */
function queryOf(ref: StreamRef, imdbId: string, names: TitleNames | null, audioLang: string | null): FindQuery {
  const common = { imdbId, title: names?.title ?? null, originalTitle: names?.originalTitle ?? null, year: names?.year ?? null, originalLanguage: audioLang };
  return ref.kind === 'movie' ? { ...common, kind: 'movie' } : { ...common, kind: 'tv', season: ref.season, episode: ref.episode };
}

/** Why a probed file is not played, or null when it plays: a dub first (original language only), then a file Chrome cannot play. */
function refusalOf(probe: MediaProbe, audioLang: string | null): { outcome: ResolveOutcome; detail: string } | null {
  const languages = audioLanguages(probe);
  if (audioLang !== null && languages.length > 0 && !languages.includes(audioLang)) {
    return { outcome: 'dubbed', detail: `its audio is ${languages.join(', ')}, not the original ${audioLang}` };
  }
  // Phase 5 replaces this refusal with the remux for a file ffmpeg can remux.
  if (!probe.direct) return { outcome: 'unplayable', detail: `${describeProbe(probe)}: Chrome does not play it as is` };
  return null;
}

/**
 * The ResolvedSource a torrent session carries, so whatever reads `session.source` (movie_plays, the stream on
 * screen, the evidence snapshot) reads the torrent's. Its manifest is the local, relative file route, so
 * `sourceHosts` finds no host and the pass-through refuses every address for the session, as for a cache.
 */
function standIn(torrent: SessionTorrent, probe: MediaProbe, audioLang: string | null, tookS: number | null): ResolvedSource {
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

export class TorrentSource {
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: TorrentSourceOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((line: string) => console.log(line));
  }

  /**
   * Finds the title's torrents and plays the first that works, trying at most MAX_TORRENT_TRIES within
   * TORRENT_DEADLINE_MS. `attempts` holds one `Index: <name>` per index asked, then per torrent tried one
   * `Torrent: <release>`, and after the one that plays its `Subtitles: <tier>` attempts. Never throws.
   */
  async resolve(ref: StreamRef, options: TorrentResolveOptions): Promise<TorrentResolve> {
    const started = this.now();
    if (options.imdbId === null) {
      return {
        ok: false,
        error: 'no_source',
        attempts: [{ provider: 'Index: all', outcome: 'error', took_s: 0, detail: 'no IMDb id is known for this title (TMDB has none or cannot be asked), and the torrent indexes are asked by it' }],
      };
    }
    const query = queryOf(ref, options.imdbId, options.names ?? null, options.audioLang);
    let found: FindAnswer;
    try {
      found = await this.opts.find(query, AbortSignal.timeout(TORRENT_DEADLINE_MS));
    } catch (err) {
      return { ok: false, error: 'no_source', attempts: [{ provider: 'Index: all', outcome: 'error', took_s: seconds(started, this.now()), detail: messageOf(err) }] };
    }
    const skip = new Set((options.skip ?? []).map((h) => h.toLowerCase()));
    const candidates = found.candidates.filter((c) => !skip.has(c.infoHash.toLowerCase()));
    // Phase 6 (R3.2): `candidates` is reordered here by the best three's file lists (orderByFileLists).
    const indexes = found.indexes.map(indexAttempt);
    const play: PlayFacts = { audioLang: options.audioLang, imdbId: options.imdbId, resumeS: options.resumeS ?? null, cloudTried: options.cloudTried === true };
    const out = await this.tryCandidates(ref, query, candidates, play, started + TORRENT_DEADLINE_MS);
    this.log(`[notesd] torrent: ${refLabel(ref)}: ${candidates.length} candidate(s), ${out.ok ? `playing ${out.torrent.name}` : 'none played'}`);
    return out.ok ? { ...out, attempts: [...indexes, ...out.attempts] } : { ok: false, error: 'no_source', attempts: [...indexes, ...out.attempts] };
  }

  /** The shuffle button: the session's remaining candidates, in their order, without asking the indexes again. */
  async next(ref: StreamRef, torrent: SessionTorrent, audioLang: string | null): Promise<TorrentResolve> {
    if (torrent.query === null || torrent.imdbId === null || torrent.candidates.length === 0) return { ok: false, error: 'no_source', attempts: [] };
    const play: PlayFacts = { audioLang, imdbId: torrent.imdbId, resumeS: null, cloudTried: false };
    return this.tryCandidates(ref, torrent.query, torrent.candidates, play, this.now() + TORRENT_DEADLINE_MS);
  }

  /**
   * R2.9: this host's finished download of the title, played from disk with no index asked and no swarm
   * joined. Null when there is none, it is not whole, or its file does not play (another language, a file
   * Chrome cannot play): the play then goes on as if there were none. `attempts` are the subtitle tiers' only.
   */
  async fromDisk(ref: StreamRef, options: { audioLang: string | null; resumeS?: number | null }): Promise<{ torrent: SessionTorrent; source: ResolvedSource; attempts: ResolveAttempt[] } | null> {
    let download: DownloadOnDisk | null;
    try {
      download = await this.opts.swarm.find(ref);
      if (download === null || download.state !== 'ready') return null;
      if ((await this.opts.swarm.filePath(download.infoHash, download.fileIndex)) === null) return null;
    } catch (err) {
      this.log(`[notesd] torrent: could not read this machine's downloads of ${refLabel(ref)}: ${messageOf(err)}`);
      return null;
    }
    const manifestUrl = this.opts.swarm.localUrl(download.infoHash, download.fileIndex);
    let probe: MediaProbe;
    try {
      probe = await this.opts.probe(`${this.opts.localBase()}${manifestUrl}`, TORRENT_PROBE_TIMEOUT_MS);
    } catch (err) {
      this.log(`[notesd] torrent: the download ${download.infoHash} of ${refLabel(ref)} could not be read: ${messageOf(err)}`);
      return null;
    }
    const refusal = refusalOf(probe, options.audioLang);
    if (refusal !== null) {
      this.log(`[notesd] torrent: the download ${download.infoHash} of ${refLabel(ref)} is not played again (${refusal.outcome}: ${refusal.detail})`);
      return null;
    }
    this.noteDuration(download.infoHash, probe);
    const stop = new AbortController();
    const chain = await runSubtitleChain(
      this.opts.tiers,
      {
        ref,
        imdbId: null,
        infoHash: download.infoHash,
        release: download.release ?? download.name,
        files: [],
        fileIndex: download.fileIndex,
        subtitleIndexes: [],
        handle: null,
        probe,
        audioLang: options.audioLang,
        resumeS: options.resumeS ?? null,
        cloudTried: false,
        localBase: this.opts.localBase(),
        signal: stop.signal,
      },
      { log: this.log },
    );
    const torrent: SessionTorrent = {
      infoHash: download.infoHash,
      fileIndex: download.fileIndex,
      selected: [download.fileIndex],
      name: download.name,
      index: null,
      seeds: null,
      state: 'ready',
      height: probe.video?.height ?? null,
      manifestUrl,
      manifestKind: 'mp4',
      subtitles: chain.subtitles,
      candidates: [],
      durationS: probe.durationS,
      candidate: null,
      held: false,
      imdbId: null,
      query: null,
      stop,
    };
    return { torrent, source: standIn(torrent, probe, options.audioLang, null), attempts: chain.attempts };
  }

  /** Takes the session's torrent again after a release (a reload of the page, a refresh). Throws when the swarm cannot open it. */
  async hold(ref: StreamRef, torrent: SessionTorrent): Promise<void> {
    const c = torrent.candidate;
    if (torrent.held || c === null) return;
    await this.opts.swarm.open({ infoHash: c.infoHash, trackers: c.trackers, name: c.name, ref, release: c.release }, { timeoutMs: TORRENT_OPEN_TIMEOUT_MS });
    await this.opts.swarm.use(c.infoHash, [...torrent.selected]);
    if (torrent.stop.signal.aborted) torrent.stop = new AbortController();
    torrent.held = true;
  }

  /** Lets go of the session's torrent (once), and stops its growing subtitle tiers. */
  release(torrent: SessionTorrent): void {
    torrent.stop.abort();
    if (!torrent.held) return;
    torrent.held = false;
    this.letGo(torrent.infoHash);
  }

  /** `ready` once the chosen file is whole on disk, else `downloading`. */
  async state(torrent: SessionTorrent): Promise<SessionTorrent['state']> {
    try {
      return (await this.opts.swarm.filePath(torrent.infoHash, torrent.fileIndex)) === null ? 'downloading' : 'ready';
    } catch {
      return torrent.state;
    }
  }

  private letGo(infoHash: string): void {
    void Promise.resolve()
      .then(() => this.opts.swarm.release(infoHash))
      .catch((err: unknown) => this.log(`[notesd] torrent: could not release ${infoHash}: ${messageOf(err)}`));
  }

  /** Phase 1's map turns bytes into seconds once it knows the length (the page's grey bar). */
  private noteDuration(infoHash: string, probe: MediaProbe): void {
    if (probe.durationS === null) return;
    const seconds = probe.durationS;
    void Promise.resolve()
      .then(() => this.opts.swarm.setDuration(infoHash, seconds))
      .catch((err: unknown) => this.log(`[notesd] torrent: could not record the length of ${infoHash}: ${messageOf(err)}`));
  }

  private async tryCandidates(ref: StreamRef, query: FindQuery, candidates: readonly TorrentCandidate[], play: PlayFacts, deadline: number): Promise<TorrentResolve> {
    const attempts: ResolveAttempt[] = [];
    for (const [i, c] of candidates.entries()) {
      const left = deadline - this.now();
      if (i >= MAX_TORRENT_TRIES || left <= 0) break;
      const tried = await this.tryOne(ref, query, c, play, left);
      attempts.push(tried.attempt);
      if (tried.ok) {
        attempts.push(...tried.subtitleAttempts);
        return { ok: true, torrent: { ...tried.torrent, candidates: candidates.slice(i + 1) }, source: tried.source, attempts };
      }
    }
    return { ok: false, error: 'no_source', attempts };
  }

  private async tryOne(ref: StreamRef, query: FindQuery, c: TorrentCandidate, play: PlayFacts, budgetMs: number): Promise<Tried> {
    const started = this.now();
    const audioLang = play.audioLang;
    const attempt = (outcome: ResolveOutcome, detail: string): ResolveAttempt => ({ provider: torrentLabel(c.name), outcome, took_s: seconds(started, this.now()), detail });
    const fail = (outcome: ResolveOutcome, detail: string): Tried => {
      this.letGo(c.infoHash);
      return { ok: false, attempt: attempt(outcome, detail) };
    };
    let opened: OpenedTorrent;
    try {
      opened = await this.opts.swarm.open({ infoHash: c.infoHash, trackers: c.trackers, name: c.name, ref, release: c.release }, { timeoutMs: Math.min(TORRENT_OPEN_TIMEOUT_MS, budgetMs) });
    } catch (err) {
      return fail('no_stream', `no file list from the swarm in time (${messageOf(err)})`);
    }
    try {
      const picked = pickFile(opened.files, query);
      if (picked === null) {
        return fail('no_stream', ref.kind === 'tv' ? `the torrent holds no file of S${pad(ref.season)}E${pad(ref.episode)}` : 'the torrent holds no video file');
      }
      const selected = [picked.video, ...picked.subtitles];
      await this.opts.swarm.use(c.infoHash, selected);
      const manifestUrl = this.opts.swarm.localUrl(c.infoHash, picked.video);
      const probeMs = Math.max(PROBE_MIN_MS, Math.min(TORRENT_PROBE_TIMEOUT_MS, budgetMs - (this.now() - started)));
      let probe: MediaProbe;
      try {
        probe = await this.opts.probe(`${this.opts.localBase()}${manifestUrl}`, probeMs);
      } catch (err) {
        return err instanceof ProbeError && err.code === 'timeout'
          ? fail('no_stream', `the swarm sent too little of the file to read it within ${Math.round(probeMs / 1000)} s`)
          : fail('error', `ffprobe could not read the file: ${messageOf(err)}`);
      }
      const refusal = refusalOf(probe, audioLang);
      if (refusal !== null) return fail(refusal.outcome, refusal.detail);
      this.noteDuration(c.infoHash, probe);
      const stop = new AbortController();
      const chain = await runSubtitleChain(
        this.opts.tiers,
        {
          ref,
          imdbId: play.imdbId,
          infoHash: c.infoHash,
          release: c.name,
          files: opened.files,
          fileIndex: picked.video,
          subtitleIndexes: picked.subtitles,
          handle: opened.read === undefined ? null : (opened as Pick<TorrentHandle, 'read'>),
          probe,
          audioLang,
          resumeS: play.resumeS,
          cloudTried: play.cloudTried,
          localBase: this.opts.localBase(),
          signal: stop.signal,
        },
        { log: this.log },
      );
      const torrent: SessionTorrent = {
        infoHash: c.infoHash,
        fileIndex: picked.video,
        selected,
        name: c.name,
        index: c.index,
        seeds: c.seeds,
        state: 'downloading',
        height: probe.video?.height ?? c.release.height ?? null,
        manifestUrl,
        manifestKind: 'mp4',
        subtitles: chain.subtitles,
        candidates: [],
        durationS: probe.durationS,
        candidate: c,
        held: true,
        imdbId: play.imdbId,
        query,
        stop,
      };
      torrent.state = await this.state(torrent);
      const tookS = seconds(started, this.now());
      return { ok: true, torrent, source: standIn(torrent, probe, audioLang, tookS), attempt: attempt('resolved', `${describeProbe(probe)}, ${c.seeds} seeds`), subtitleAttempts: chain.attempts };
    } catch (err) {
      return fail('error', messageOf(err));
    }
  }
}

/** The finder's index list from the settings: the default four at their addresses, minus the ones set `off`. */
function indexesOf(finder: NonNullable<Config['torrent']>['finder']): TorrentIndex[] {
  const set = finder?.indexes ?? {};
  const bases = Object.fromEntries(Object.entries(set).filter(([, v]) => v !== null && v !== undefined)) as Partial<Record<TorrentIndexName, string>>;
  const off = new Set(TORRENT_INDEX_NAMES.filter((name) => set[name] === null));
  return defaultIndexes({ bases, yts: !off.has('yts') }).filter((index) => !off.has(index.name as TorrentIndexName));
}

/** The daemon's torrent source, or null when torrents are off (`NOTESD_TORRENT=off`) or phase 1 built no TorrentStreams. */
export function buildTorrentSource(
  config: Config,
  torrents: TorrentSwarm | null,
  wiring: {
    localBase: () => string;
    log?: (line: string) => void;
    /** buildSubtitleTiers(...) in src/daemon.ts; none: a torrent session has no subtitle. */
    tiers?: readonly SubtitleTier[];
    /** 1337x and ext.to (phase 9), asked only when the JSON indexes leave no usable candidate. */
    fallback?: readonly TorrentIndex[];
  },
): TorrentSource | null {
  if (config.torrent?.enabled !== true || torrents === null) return null;
  const finder = config.torrent.finder ?? DEFAULT_TORRENT_FINDER_CONFIG;
  const indexes = indexesOf(finder);
  return new TorrentSource({
    swarm: torrents,
    find: (query, signal) =>
      findCandidates(query, {
        signal,
        indexes,
        ...(finder.minSeeds === undefined ? {} : { minSeeds: finder.minSeeds }),
        ...(finder.maxSizeBytes === undefined ? {} : { maxSizeBytes: finder.maxSizeBytes }),
        ...(finder.indexTimeoutMs === undefined ? {} : { timeoutMs: finder.indexTimeoutMs }),
        ...(wiring.fallback === undefined ? {} : { fallback: wiring.fallback }),
      }),
    probe: ffprobeFile({ ffprobeBin: config.movies.ffprobeBin }),
    tiers: wiring.tiers ?? [],
    localBase: wiring.localBase,
    ...(wiring.log === undefined ? {} : { log: wiring.log }),
  });
}
```
**Impact:** new module. Compiles only once phases 1 and 2 have landed (it imports `./types.js` and `./find/index.js`).

**Test:** `tests/unit/directStream/torrentSource.test.ts` (new). Behaviour through the public methods only; the swarm,
finder and probe are fakes that record what they were asked.
```ts
import { describe, expect, it } from 'vitest';
import type { CacheSubtitleView } from '../../../src/directStream/cachePlay.js';
import type { StreamRef } from '../../../src/directStream/types.js';
import { parseRelease, type TorrentCandidate } from '../../../src/directStream/torrent/find/index.js';
import { ProbeError, type MediaProbe } from '../../../src/directStream/torrent/probe.js';
import { runSubtitleChain, SUBTITLE_BUDGET_MS, type SubtitleTier } from '../../../src/directStream/torrent/subtitles/chain.js';
import { MAX_TORRENT_TRIES, TorrentSource, type DownloadOnDisk, type FindAnswer, type TorrentSwarm } from '../../../src/directStream/torrent/source.js';
import type { TorrentFileInfo } from '../../../src/directStream/torrent/types.js';

const FILM: StreamRef = { kind: 'movie', tmdbId: 467905 };
const EPISODE: StreamRef = { kind: 'tv', tmdbId: 247718, season: 1, episode: 2 };
const BASE = 'http://127.0.0.1:4321';

const h = (n: number): string => n.toString(16).padStart(40, '0');

const candidate = (infoHash: string, name: string, seeds = 40): TorrentCandidate => ({
  infoHash,
  name,
  fileName: null,
  fileIdx: null,
  seeds,
  sizeBytes: 700_000_000,
  index: 'torrentio',
  listedBy: ['torrentio'],
  site: null,
  trackers: ['http://127.0.0.1:1/announce'],
  scoped: false,
  release: parseRelease(name),
});

const file = (index: number, path: string, length = 500_000_000): TorrentFileInfo => ({ index, path, name: path.split('/').pop() ?? path, length });

const MP4_EN: MediaProbe = { container: 'mov,mp4,m4a,3gp,3g2,mj2', video: { codec: 'h264', height: 720 }, audio: [{ codec: 'aac', lang: 'eng' }], subtitles: [], durationS: 62, direct: true };
const MP4_DE: MediaProbe = { ...MP4_EN, audio: [{ codec: 'aac', lang: 'ger' }] };
const MP4_UNTAGGED: MediaProbe = { ...MP4_EN, audio: [{ codec: 'aac', lang: null }] };
const MKV: MediaProbe = { container: 'matroska,webm', video: { codec: 'hevc', height: 1080 }, audio: [{ codec: 'eac3', lang: 'eng' }], subtitles: [], durationS: 62, direct: false };

interface Fakes {
  candidates?: TorrentCandidate[];
  files?: Record<string, TorrentFileInfo[]>;
  failOpen?: string[];
  probes?: Record<string, MediaProbe | 'timeout'>;
  ready?: string[];
  disk?: DownloadOnDisk | null;
  tiers?: SubtitleTier[];
  onFind?: (query: unknown) => void;
}

function setup(o: Fakes = {}) {
  const calls: string[] = [];
  const probed: string[] = [];
  const durations: string[] = [];
  const swarm: TorrentSwarm = {
    open: async (pick) => {
      calls.push(`open ${pick.infoHash}`);
      if ((o.failOpen ?? []).includes(pick.infoHash)) throw new Error('no metadata within 20 s');
      return { infoHash: pick.infoHash, files: o.files?.[pick.infoHash] ?? [file(0, 'Film.2026.720p.mp4')] };
    },
    use: (infoHash, indexes) => {
      calls.push(`use ${infoHash} ${indexes.join(',')}`);
    },
    release: (infoHash) => {
      calls.push(`release ${infoHash}`);
    },
    find: async () => o.disk ?? null,
    filePath: (infoHash, index) => ((o.ready ?? []).includes(infoHash) ? `/data/torrents/${infoHash}/${index}` : null),
    localUrl: (infoHash, index) => `/api/stream/torrent/${infoHash}/f/${index}`,
    setDuration: (infoHash, s) => {
      durations.push(`${infoHash} ${s}`);
    },
  };
  let finds = 0;
  const answer: FindAnswer = { candidates: o.candidates ?? [], indexes: [{ index: 'torrentio', outcome: 'ok', detail: `${(o.candidates ?? []).length} candidates`, took_s: 0.3, listed: (o.candidates ?? []).length }], excluded: [] };
  const source = new TorrentSource({
    swarm,
    find: async (query) => {
      finds += 1;
      o.onFind?.(query);
      return answer;
    },
    probe: async (url) => {
      probed.push(url);
      const hash = /\/torrent\/([0-9a-f]+)\//.exec(url)?.[1] ?? '';
      const p = o.probes?.[hash] ?? MP4_EN;
      if (p === 'timeout') throw new ProbeError('timeout', 'ffprobe gave up after 30 s');
      return p;
    },
    tiers: o.tiers ?? [],
    localBase: () => BASE,
    log: () => undefined,
  });
  // Releases are handed to the swarm on the next tick.
  const settled = async (): Promise<string[]> => {
    await new Promise((r) => setTimeout(r, 0));
    return calls;
  };
  return { source, calls, settled, probed, durations, finds: () => finds };
}

describe('TorrentSource.resolve', () => {
  it('plays the first torrent that opens: the local file route, the Torrent stand-in, the index then the torrent in attempts', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.720p.WEB-DL.x264.AAC-GRP')] });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.torrent).toMatchObject({ infoHash: h(1), fileIndex: 0, name: 'Film.2026.720p.WEB-DL.x264.AAC-GRP', index: 'torrentio', seeds: 40, state: 'downloading', height: 720, manifestUrl: `/api/stream/torrent/${h(1)}/f/0`, manifestKind: 'mp4', held: true, imdbId: 'tt0467905' });
    expect(out.source).toMatchObject({ provider: 'Torrent', manifest_url: `/api/stream/torrent/${h(1)}/f/0`, manifest_kind: 'mp4', headers: { referer: null, origin: null, user_agent: null }, audio: { languages: ['en'], original: true } });
    expect(out.attempts.map((a) => [a.provider, a.outcome])).toEqual([
      ['Index: torrentio', 'resolved'],
      ['Torrent: Film.2026.720p.WEB-DL.x264.AAC-GRP', 'resolved'],
    ]);
    expect(t.probed).toEqual([`${BASE}/api/stream/torrent/${h(1)}/f/0`]);
    expect(await t.settled()).toEqual([`open ${h(1)}`, `use ${h(1)} 0`]);
    // The probe's length reaches phase 1's map (seconds for the page's grey bar).
    expect(t.durations).toEqual([`${h(1)} 62`]);
  });

  it('skips a file whose audio names only another language as dubbed, releases it, and plays the next (R1.6)', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.1080p.WEB-DL.x264.AAC-A'), candidate(h(2), 'Film.2026.720p.WEB-DL.x264.AAC-B')], probes: { [h(1)]: MP4_DE } });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    expect(out.ok && out.torrent.infoHash).toBe(h(2));
    expect(out.attempts.slice(1).map((a) => [a.outcome, a.detail])).toEqual([
      ['dubbed', 'its audio is de, not the original en'],
      ['resolved', 'mov h264 720p / aac, 40 seeds'],
    ]);
    expect(await t.settled()).toContain(`release ${h(1)}`);
  });

  it('plays a file whose audio names no language, since nothing says it is a dub', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.720p.WEB-DL.x264.AAC-A')], probes: { [h(1)]: MP4_UNTAGGED } });
    const out = await t.source.resolve(FILM, { audioLang: 'ko', imdbId: 'tt0467905' });
    expect(out.ok).toBe(true);
    expect(out.ok && out.source.audio).toEqual({ languages: [], tracks: 0, original: null, track: null });
  });

  it('answers unplayable for a file Chrome cannot play, and no_stream for a torrent with no file list in time', async () => {
    const t = setup({
      candidates: [candidate(h(1), 'Film.2026.1080p.BluRay.x265.EAC3-A'), candidate(h(2), 'Film.2026.720p.WEB-DL.x264.AAC-B'), candidate(h(3), 'Film.2026.720p.WEB-DL.x264.AAC-C')],
      probes: { [h(1)]: MKV },
      failOpen: [h(2)],
    });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    expect(out.ok && out.torrent.infoHash).toBe(h(3));
    expect(out.attempts.slice(1).map((a) => a.outcome)).toEqual(['unplayable', 'no_stream', 'resolved']);
    expect(out.attempts[1]?.detail).toBe('matroska hevc 1080p / eac3: Chrome does not play it as is');
    const calls = await t.settled();
    expect(calls).toContain(`release ${h(1)}`);
    expect(calls).toContain(`release ${h(2)}`);
  });

  it('answers no_stream when the swarm sends too little to probe in time', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.720p.WEB-DL.x264.AAC-A')], probes: { [h(1)]: 'timeout' } });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    expect(out.ok).toBe(false);
    expect(out.attempts[1]).toMatchObject({ provider: 'Torrent: Film.2026.720p.WEB-DL.x264.AAC-A', outcome: 'no_stream' });
  });

  it(`tries at most ${MAX_TORRENT_TRIES} torrents, and keeps the ones after the played one for the shuffle button`, async () => {
    const many = Array.from({ length: 8 }, (_, i) => candidate(h(i + 1), `Film.2026.720p.WEB-DL.x264.AAC-G${i + 1}`));
    const failing = setup({ candidates: many, failOpen: many.map((c) => c.infoHash) });
    const none = await failing.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    expect(none.attempts.filter((a) => a.provider.startsWith('Torrent: '))).toHaveLength(MAX_TORRENT_TRIES);
    const second = setup({ candidates: many, failOpen: [h(1)] });
    const out = await second.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    expect(out.ok && out.torrent.candidates.map((c) => c.infoHash)).toEqual(many.slice(2).map((c) => c.infoHash));
  });

  it('asks the finder by the IMDb id, the names, the year and the original language, and keeps the query for the shuffle button', async () => {
    const asked: unknown[] = [];
    const t = setup({ candidates: [candidate(h(1), 'Show.S01E02.720p.WEB-DL.x264.AAC-A')], files: { [h(1)]: [file(0, 'Show.S01E02.720p.mp4')] }, probes: { [h(1)]: MP4_UNTAGGED }, onFind: (q) => asked.push(q) });
    const out = await t.source.resolve(EPISODE, { audioLang: 'ko', imdbId: 'tt9999999', names: { title: 'Show', originalTitle: '쇼', year: 2025 } });
    expect(asked).toEqual([{ kind: 'tv', imdbId: 'tt9999999', title: 'Show', originalTitle: '쇼', year: 2025, originalLanguage: 'ko', season: 1, episode: 2 }]);
    expect(out.ok && out.torrent.query).toEqual(asked[0]);
  });

  it('chooses the asked episode\'s file inside a season pack (R1.4)', async () => {
    const pack = candidate(h(9), 'Show.S01.720p.WEB-DL.x264.AAC-PACK');
    const t = setup({
      candidates: [pack],
      files: {
        [h(9)]: [file(0, 'Show.S01/Show.S01E01.720p.mp4'), file(1, 'Show.S01/Show.S01E02.720p.mp4'), file(2, 'Show.S01/Show.S01E03.720p.mp4'), file(3, 'Show.S01/sample.mp4', 9_000_000)],
      },
    });
    const out = await t.source.resolve(EPISODE, { audioLang: 'en', imdbId: 'tt9999999' });
    expect(out.ok && out.torrent.fileIndex).toBe(1);
    expect(out.ok && out.torrent.manifestUrl).toBe(`/api/stream/torrent/${h(9)}/f/1`);
    expect((await t.settled()).find((c) => c.startsWith('use '))).toBe(`use ${h(9)} 1`);
  });

  it('asks no index without an IMDb id, and says why in attempts', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.720p.WEB-DL.x264.AAC-A')] });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: null });
    expect(out.ok).toBe(false);
    expect(out.attempts).toEqual([expect.objectContaining({ provider: 'Index: all', outcome: 'error' })]);
    expect(t.finds()).toBe(0);
    expect(await t.settled()).toEqual([]);
  });
});

describe('TorrentSource.next, hold and release', () => {
  it('moves to the next candidate without asking the indexes, and opens a released torrent again', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.720p.WEB-DL.x264.AAC-A'), candidate(h(2), 'Film.2026.720p.WEB-DL.x264.AAC-B')] });
    const first = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    if (!first.ok) throw new Error('expected a torrent');
    const next = await t.source.next(FILM, first.torrent, 'en');
    expect(next.ok && next.torrent.infoHash).toBe(h(2));
    expect(t.finds()).toBe(1);
    t.source.release(first.torrent);
    t.source.release(first.torrent);
    expect((await t.settled()).filter((c) => c === `release ${h(1)}`)).toHaveLength(1);
    await t.source.hold(FILM, first.torrent);
    expect(first.torrent.held).toBe(true);
    expect(t.calls.slice(-2)).toEqual([`open ${h(1)}`, `use ${h(1)} 0`]);
  });
});

describe('TorrentSource.fromDisk (R2.9)', () => {
  const disk: DownloadOnDisk = { infoHash: h(5), name: 'Film.2026.720p.WEB-DL.x264.AAC-A', fileIndex: 0, state: 'ready' };

  it('plays a whole download from disk: no index, no open, not held', async () => {
    const t = setup({ disk, ready: [h(5)] });
    const out = await t.source.fromDisk(FILM, { audioLang: 'en' });
    expect(out?.torrent).toMatchObject({ infoHash: h(5), state: 'ready', held: false, candidate: null, manifestUrl: `/api/stream/torrent/${h(5)}/f/0` });
    expect(out?.source.provider).toBe('Torrent');
    expect(t.finds()).toBe(0);
    expect(await t.settled()).toEqual([]);
  });

  it('passes over a download that is not whole, or whose file is a dub', async () => {
    expect(await setup({ disk: { ...disk, state: 'downloading' }, ready: [h(5)] }).source.fromDisk(FILM, { audioLang: 'en' })).toBeNull();
    expect(await setup({ disk, ready: [] }).source.fromDisk(FILM, { audioLang: 'en' })).toBeNull();
    expect(await setup({ disk, ready: [h(5)], probes: { [h(5)]: MP4_DE } }).source.fromDisk(FILM, { audioLang: 'en' })).toBeNull();
  });
});

describe('runSubtitleChain', () => {
  const english: CacheSubtitleView = { url: '/api/stream/torrent/x/sub/0.vtt', lang: 'en', label: 'English' };
  const ctx = { ref: FILM, imdbId: null, infoHash: h(1), release: 'Film', files: [], fileIndex: 0, subtitleIndexes: [], handle: null, probe: MP4_EN, audioLang: 'en', resumeS: null, cloudTried: false, localBase: BASE, signal: new AbortController().signal };
  const tier = (name: string, find: SubtitleTier['find'], extra: Partial<SubtitleTier> = {}): SubtitleTier => ({ name, blocks: true, find, ...extra });

  it('stops at the first tier that answers anything (a lone unnamed track too), with one attempt per tier asked', async () => {
    const lines: string[] = [];
    const lone: CacheSubtitleView = { url: '/lone.vtt', lang: null, label: '' };
    const out = await runSubtitleChain(
      [
        tier('broken', async () => Promise.reject(new Error('boom'))),
        tier('empty', async () => []),
        tier('files', async () => [lone]),
        tier('never', async () => Promise.reject(new Error('must not be asked'))),
      ],
      ctx,
      { log: (l) => lines.push(l) },
    );
    expect(out.subtitles).toEqual([lone]);
    expect(out.attempts.map((a) => `${a.provider}=${a.outcome}`)).toEqual(['Subtitles: broken=error', 'Subtitles: empty=no_stream', 'Subtitles: files=resolved']);
    expect(lines).toHaveLength(1);
    expect(await runSubtitleChain([], ctx)).toEqual({ subtitles: [], attempts: [] });
  });

  it('shares one 40 s budget among the blocking tiers, skips one past it, never counts a growing tier, and honours a tier\'s own skip', async () => {
    let now = 0;
    const out = await runSubtitleChain(
      [
        tier('borrow', async () => [english], { skip: () => 'Whisper covers English audio' }),
        tier('slow', async () => ((now += 41_000), [])),
        tier('service', async () => [english]),
        tier('whisper', async (c) => [{ ...english, url: `/cues/${c.deadline}` }], { blocks: false }),
      ],
      ctx,
      { now: () => now },
    );
    expect(out.attempts.map((a) => `${a.provider}=${a.outcome}`)).toEqual(['Subtitles: borrow=skipped', 'Subtitles: slow=no_stream', 'Subtitles: service=skipped', 'Subtitles: whisper=resolved']);
    expect(out.attempts[2]?.detail).toBe('the 40 s subtitle budget was spent');
    expect(out.subtitles[0]?.url).toBe(`/cues/${SUBTITLE_BUDGET_MS}`);
  });

  it('gives up on a blocking tier still running when the budget runs out', async () => {
    const out = await runSubtitleChain([tier('hung', () => new Promise(() => undefined))], ctx, { budgetMs: 20 });
    expect(out.attempts).toEqual([expect.objectContaining({ provider: 'Subtitles: hung', outcome: 'error' })]);
  });
});
```

### Step 4: Torrent sessions in the session store
**File:** `src/directStream/sessions.ts` (whole file; today 161 lines)
**Change:** `SessionTorrent` (the shared contract's shape plus `selected`, `candidate`, `held`, `imdbId`, `query`, `stop`), the field
`StreamSession.torrent`, end listeners (the service releases a session's torrent when the store drops it), a factory
that makes a torrent session with no cache (a session can never hold both), `replaceTorrent` for the shuffle button,
`live()`, and `sweep()` made public. `replaceSource` and `useCache` are unchanged.
**Code:**
```ts
import { randomBytes } from 'node:crypto';
import type { CacheSubtitleView, SessionCache } from './cachePlay.js';
import { absoluteHttp } from './rewrite.js';
import type { TorrentCandidate, TorrentQuery } from './torrent/find/index.js';
import type { ManifestKind, ResolveAttempt, ResolvedSource, StreamRef } from './types.js';

/** A session ends this long after its last request (the player fetches every few seconds while it plays). */
export const SESSION_IDLE_MS = 4 * 60 * 60 * 1000;
/** ... and this long after it began, whatever happens. */
export const SESSION_MAX_MS = 24 * 60 * 60 * 1000;
/** More live sessions than this: the least recently used goes. */
export const MAX_SESSIONS = 32;
/** 24 random bytes, base64url: 32 characters, 192 bits. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;

/**
 * The torrent a stream session plays from (torrent phase 3). Made by TorrentSource; the session's `source` is
 * then its stand-in (provider `Torrent`, the local manifest), `cache` is null and `allowedHosts` is empty.
 */
export interface SessionTorrent {
  /** Lower-case hex. */
  infoHash: string;
  /** The chosen video file's index in the torrent. */
  fileIndex: number;
  /** Every file this session selected (the video first, then its subtitle files): what a hold selects again. */
  selected: number[];
  /** The release name. */
  name: string;
  /** The index that listed the torrent (`Torrentio`, ...); null for a replay from disk. */
  index: string | null;
  /** The seed count the index listed; null for a replay from disk. */
  seeds: number | null;
  /** `ready`: the file is whole on disk; `downloading`: the file route fetches what is missing. Read again by every sessionInfo. */
  state: 'downloading' | 'ready';
  height: number | null;
  /** The local file route, relative to the daemon's origin: `/api/stream/torrent/<hash>/f/<index>`. */
  manifestUrl: string;
  /** `mp4` (the file as is); phase 5 adds `hls` for its remux. */
  manifestKind: Extract<ManifestKind, 'mp4' | 'hls'>;
  subtitles: CacheSubtitleView[];
  /** The candidates after this one, in the finder's order, for the shuffle button (switchSource). */
  candidates: TorrentCandidate[];
  durationS: number | null;
  /** The candidate this session opened, to open it again after a release; null: a replay from disk, which joins no swarm. */
  candidate: TorrentCandidate | null;
  /** True while this session holds a `use` of the torrent in the swarm; a release sets it false, a hold true again. */
  held: boolean;
  /** The title's IMDb id the torrent was found by; null for a replay from disk. */
  imdbId: string | null;
  /** The finder's query (IMDb id, names, year, episode) the shuffle button tries the rest with; null for a replay. */
  query: TorrentQuery | null;
  /**
   * Aborted when the session lets go of the torrent (TorrentSource.release): the growing subtitle tiers (phase 7's
   * extraction, phase 8's Whisper) stop their work. A torrent taken back gets a fresh one; a stopped growing track
   * starts over on the next play.
   */
  stop: AbortController;
}

/** One resolved title the player may stream. In memory only: a daemon restart ends every session. */
export interface StreamSession {
  readonly id: string;
  readonly ref: StreamRef;
  source: ResolvedSource;
  /** The last resolve's attempts, as the resolver printed them. */
  attempts: ResolveAttempt[];
  /** `URL.host` (with port) of every host this session may fetch. */
  allowedHosts: Set<string>;
  /** Where the player starts, in seconds; null: from the start. */
  resumeS: number | null;
  /** The title's original language (TMDB's code): the player picks that audio track; null: unknown. */
  audioLang: string | null;
  /**
   * The stream cache on this host the session plays from (phase 6); null: through the pass-through.
   * While set, `source` is cacheSource()'s stand-in (the cache's provider, its local manifest), and
   * `attempts` and `allowedHosts` are empty.
   */
  cache: SessionCache | null;
  /** The torrent the session plays from (torrent phase 3); null: not a torrent. Never set together with `cache`. */
  torrent: SessionTorrent | null;
  readonly createdAt: Date;
  refreshedAt: Date;
  /** Times a refresh replaced the source (a token expired); 0 for a fresh session. */
  refreshes: number;
  /** Providers this session left because their stream stalled (switchSource): no later resolve of the session tries them. */
  avoid: string[];
  lastUsedAt: Date;
}

function hostOf(url: string): string | null {
  const abs = absoluteHttp(url);
  return abs === null ? null : new URL(abs).host.toLowerCase();
}

/** The hosts a resolve returned: the manifest's and every subtitle track's. */
export function sourceHosts(source: ResolvedSource): Set<string> {
  const hosts = new Set<string>();
  for (const url of [source.manifest_url, ...source.subtitles.map((t) => t.url)]) {
    const host = hostOf(url);
    if (host !== null) hosts.add(host);
  }
  return hosts;
}

/** True when `url` is http(s) on a host this session may fetch. */
export function allows(session: StreamSession, url: string): boolean {
  const host = hostOf(url);
  return host !== null && session.allowedHosts.has(host);
}

/** Lets the session fetch `url`'s host. Called only with addresses named by an answer fetched through the session. */
export function learn(session: StreamSession, url: string): void {
  const host = hostOf(url);
  if (host !== null) session.allowedHosts.add(host);
}

export class SessionStore {
  private readonly sessions = new Map<string, StreamSession>();
  private readonly endListeners: Array<(session: StreamSession) => void> = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Called with every session the store drops (it expired, or more than MAX_SESSIONS live). A listener that throws is ignored. */
  onEnd(listener: (session: StreamSession) => void): void {
    this.endListeners.push(listener);
  }

  create(
    ref: StreamRef,
    source: ResolvedSource,
    attempts: ResolveAttempt[],
    resumeS: number | null = null,
    audioLang: string | null = null,
    cache: SessionCache | null = null,
  ): StreamSession {
    this.sweep();
    const at = this.now();
    const session: StreamSession = {
      id: randomBytes(24).toString('base64url'),
      ref,
      source,
      attempts,
      allowedHosts: sourceHosts(source),
      resumeS,
      audioLang,
      cache,
      torrent: null,
      createdAt: at,
      refreshedAt: at,
      refreshes: 0,
      avoid: [],
      lastUsedAt: at,
    };
    this.sessions.set(session.id, session);
    while (this.sessions.size > MAX_SESSIONS) {
      let oldest: StreamSession | null = null;
      for (const s of this.sessions.values()) if (oldest === null || s.lastUsedAt < oldest.lastUsedAt) oldest = s;
      if (oldest === null) break;
      this.drop(oldest);
    }
    return session;
  }

  /** A session on a torrent (torrent phase 3): `source` is TorrentSource's stand-in (a local manifest: no host is allowed), and no cache. */
  createTorrent(ref: StreamRef, source: ResolvedSource, attempts: ResolveAttempt[], resumeS: number | null, audioLang: string | null, torrent: SessionTorrent): StreamSession {
    const session = this.create(ref, source, attempts, resumeS, audioLang, null);
    session.torrent = torrent;
    return session;
  }

  /** The live session with this id, marked used now; null when the id is malformed, unknown or ended. */
  get(id: string): StreamSession | null {
    if (!SESSION_ID_PATTERN.test(id)) return null;
    const session = this.sessions.get(id);
    if (session === undefined) return null;
    const now = this.now();
    if (now.getTime() >= this.expiresAt(session).getTime()) {
      this.drop(session);
      return null;
    }
    session.lastUsedAt = now;
    return session;
  }

  /** The live session with this id, without marking it used (a snapshot must not keep a session alive); null like get(). */
  peek(id: string): StreamSession | null {
    if (!SESSION_ID_PATTERN.test(id)) return null;
    const session = this.sessions.get(id);
    if (session === undefined) return null;
    return this.now().getTime() >= this.expiresAt(session).getTime() ? null : session;
  }

  /** A refresh: the new source, its hosts added to the ones the session already had. A resolved source is never a cache's. */
  replaceSource(session: StreamSession, source: ResolvedSource, attempts: ResolveAttempt[]): void {
    session.source = source;
    session.attempts = attempts;
    session.cache = null;
    for (const host of sourceHosts(source)) session.allowedHosts.add(host);
    session.refreshedAt = this.now();
    session.refreshes += 1;
  }

  /** The shuffle button on a torrent session: the next torrent and its stand-in source. The caller released the old torrent. */
  replaceTorrent(session: StreamSession, source: ResolvedSource, torrent: SessionTorrent, attempts: ResolveAttempt[]): void {
    session.source = source;
    session.attempts = attempts;
    session.torrent = torrent;
    session.refreshedAt = this.now();
    session.refreshes += 1;
  }

  /** A refresh of a session whose cache can still be played: the cache as it is now (a download may have finished). Not counted in `refreshes` (no token was replaced). */
  useCache(session: StreamSession, cache: SessionCache): void {
    session.cache = cache;
    session.refreshedAt = this.now();
  }

  expiresAt(session: StreamSession): Date {
    return new Date(Math.min(session.lastUsedAt.getTime() + SESSION_IDLE_MS, session.createdAt.getTime() + SESSION_MAX_MS));
  }

  get size(): number {
    this.sweep();
    return this.sessions.size;
  }

  /** Every live session, the ended ones dropped first. */
  live(): StreamSession[] {
    this.sweep();
    return [...this.sessions.values()];
  }

  /** Drops every session that has ended. */
  sweep(): void {
    const now = this.now().getTime();
    for (const session of [...this.sessions.values()]) if (now >= this.expiresAt(session).getTime()) this.drop(session);
  }

  private drop(session: StreamSession): void {
    this.sessions.delete(session.id);
    for (const listener of this.endListeners) {
      try {
        listener(session);
      } catch {
        // A listener never stops a session from ending.
      }
    }
  }
}
```
**Impact:** every session now carries `torrent: null` unless made by `createTorrent`. No other module builds a
`StreamSession` literal (`grep allowedHosts` finds only `sessions.ts`, `service.ts`, `evidence.ts`).
`tests/unit/directStream/sessions.test.ts` keeps passing (the public behaviour of `create/get/peek/replaceSource/size`
is unchanged).

### Step 5: Types and the evidence view
**File:** `src/directStream/types.ts:32-38`
**Change:** the outcomes `unplayable` and `skipped`.
```ts
/**
 * How one provider's try ended, as claude/streaming/direct/cli.mjs reports it, and how one torrent's or one subtitle
 * tier's try ended (torrent phase 3). The skips are not health, and neither is `dubbed` (a stream was found, in another
 * language than the title's original): it is about the title, not the provider. `unplayable` is a torrent's file
 * Chrome cannot play as is (phase 5 remuxes it instead); `skipped` is a subtitle tier not asked, its detail says why
 * (the 40 s subtitle budget was spent, or the tier does not apply). The resolver prints neither.
 */
export const RESOLVE_OUTCOMES = [...STREAM_HEALTH_OUTCOMES, 'dubbed', 'skipped_browser_only', 'skipped_no_template', 'unplayable', 'skipped'] as const;
```
**File:** `src/directStream/types.ts:102`
```ts
export type DirectStreamErrorCode = 'no_source' | 'resolve_failed' | 'open_failed' | 'unknown_session' | 'no_episode' | 'no_subtitle' | 'torrent_off';
```
**Impact:** `runner.ts`'s zod enum accepts `unplayable` and `skipped` (harmless: the resolver never prints them). `recordHealth`
(`service.ts:709`) keeps only `STREAM_HEALTH_OUTCOMES` and only names in the registry, so neither a torrent attempt nor
an index attempt ever touches `stream_provider_health`. `updateSource.ts`'s `ProbeOutcome` widens by one value; nothing
switches on it exhaustively. The web pages print attempts as text (`grep skipped_browser_only web/src` finds nothing).

**File:** `src/directStream/evidence.ts:191-192` (inside `interface SessionSource`, after `cache`)
```ts
  /** The torrent the session plays from (torrent phase 3); null: not a torrent. */
  torrent: { info_hash: string; name: string; file_index: number; index: string | null; state: 'downloading' | 'ready' } | null;
```
**File:** `src/directStream/evidence.ts:229` (inside `sessionSource`, after the `cache:` line)
```ts
    torrent:
      session.torrent === null
        ? null
        : { info_hash: session.torrent.infoHash, name: session.torrent.name, file_index: session.torrent.fileIndex, index: session.torrent.index, state: session.torrent.state },
```
**Impact:** a snapshot's `session.json` names the torrent; `stream_host` of a torrent session's records is null (the
manifest is relative), as for a cache.

### Step 6: The service's torrent branches
**File:** `src/directStream/service.ts`

**6.1 Imports** (`:16`, replace the `sessions.js` import line; add one line after it)
```ts
import { SESSION_ID_PATTERN, SessionStore, type SessionTorrent, type StreamSession } from './sessions.js';
import { namesTorrent, TORRENT_PROVIDER, type TorrentSource } from './torrent/source.js';
```

**6.2 Hooks, `SessionInfo`, options, constant** — in `DirectStreamHooks` (`:76`, after `neighbors`):
```ts
  /**
   * The title's IMDb id (`tt0137523`; a series' own id for an episode), which the torrent indexes are asked by
   * (torrent phase 3). Null: none is known; the torrent source then asks no index.
   */
  imdbId?: (ref: StreamRef) => Promise<string | null>;
  /**
   * The title's names and year (the stored title), for the torrent finder's title check and phase 9's 1337x search
   * (torrent phase 3). Null: unknown; the finder then checks no title.
   */
  titleNames?: (ref: StreamRef) => Promise<{ title: string; originalTitle: string | null; year: number | null } | null>;
```
In `SessionInfo` (`:122`, after `cached`):
```ts
  /**
   * The torrent the session plays from (torrent phase 3): its info hash, the chosen file's index, the release
   * name, the index that listed it (null for a replay from disk), `ready` (the file is whole on disk) or
   * `downloading`, and the seed count listed (null for a replay). Then `provider` is `Torrent` and
   * `manifest_url` is the torrent's file route (`/api/stream/torrent/<hash>/f/<index>`). Null: not a torrent.
   */
  torrent: { info_hash: string; file_index: number; name: string; index: string | null; state: SessionTorrent['state']; seeds: number | null } | null;
```
In `DirectStreamServiceOptions` (`:159`, after `caches`):
```ts
  /**
   * The torrent source (torrent phase 3), read at play time because it is built from phase 1's TorrentStreams
   * after this service. Unset or null: torrents are off, and every play is exactly as without them.
   */
  torrent?: () => TorrentSource | null;
```
After `const NO_HEALTH = ...` (`:169`):
```ts
/** A torrent session no page asked about for this long lets go of its torrent (the page reports every 5 s, paused or not). */
export const TORRENT_IDLE_MS = 2 * 60_000;
const TORRENT_SWEEP_MS = 60_000;
```

**6.3 Constructor and fields** (`:201-213`): add the field after `private updatingSource ...`:
```ts
  /** Runs sweepTorrents every minute while a torrent session holds its torrent. */
  private torrentTimer: ReturnType<typeof setInterval> | null = null;
```
and the last line of the constructor body (after `this.evidence = opts.evidence ?? null;`):
```ts
    // A session the store drops (expired, or past MAX_SESSIONS) lets go of its torrent.
    this.sessions.onEnd((session) => this.letGoTorrent(session));
```

**6.4 `play`** (`:247-256`, whole method)
```ts
  async play(input: StreamRefInput, options: { resumeS?: number | null; provider?: string | null } = {}): Promise<PlayResult> {
    const ref = toStreamRef(input);
    const resumeS = options.resumeS ?? null;
    // The owner named a provider ("stream it from VidLink"): only that one is asked, and a cache is passed over.
    // "torrent" asks the torrent source alone: a finished download on this machine first, else the swarm.
    const only = options.provider ?? null;
    const session =
      only === null
        ? await this.sessionFor(ref, resumeS)
        : namesTorrent(only)
          ? ((await this.diskSession(ref, resumeS)) ?? (await this.torrentSession(ref, resumeS, null)))
          : await this.resolve(ref, { resumeS, only });
    return this.openPage(session);
  }

  /**
   * A play with no provider named: this host's stream cache, then this host's finished torrent download of the
   * title (R2.9: no index, no swarm), then the cloud providers, and after them the torrent source.
   */
  private async sessionFor(ref: StreamRef, resumeS: number | null): Promise<StreamSession> {
    return (await this.cachedSession(ref, resumeS)) ?? (await this.diskSession(ref, resumeS)) ?? (await this.resolveOrTorrent(ref, resumeS));
  }

  /**
   * The cloud resolve, and when no provider resolves the title (`no_source`) or the resolve could not run
   * (`resolve_failed`: a torrent needs no Chrome), the torrent source. Torrents off: exactly `resolve`.
   */
  private async resolveOrTorrent(ref: StreamRef, resumeS: number | null): Promise<StreamSession> {
    try {
      return await this.resolve(ref, { resumeS });
    } catch (err) {
      if (!(err instanceof DirectStreamError) || (err.code !== 'no_source' && err.code !== 'resolve_failed') || this.torrentSource() === null) throw err;
      return this.torrentSession(ref, resumeS, err);
    }
  }

  /**
   * A session on a torrent found and opened now. `cloud` is the cloud resolve's failure it follows, if any: its
   * attempts come first in the answer's. Throws `torrent_off`; `no_source` with every attempt (cloud, index,
   * torrent); or, after a cloud `resolve_failed`, that error again with the torrent attempts added. The
   * recordResolve hook is not called: a torrent says nothing of the title's cloud sources.
   */
  private async torrentSession(ref: StreamRef, resumeS: number | null, cloud: DirectStreamError | null): Promise<StreamSession> {
    const source = this.torrentSource();
    if (source === null) throw new DirectStreamError('torrent_off', 'Torrents are off on this machine (NOTESD_TORRENT=off).');
    const audioLang = await this.audioLang(ref);
    const imdbId = await this.imdbIdOf(ref);
    const namesHook = this.opts.hooks?.titleNames;
    const names = namesHook === undefined ? null : await this.hookValue('titleNames', () => namesHook(ref));
    const startS = await this.startAt(ref, resumeS);
    // Never inside serial(): the cloud resolve above has returned, and phase 6's borrow tier queues on serial().
    const out = await source.resolve(ref, { audioLang, imdbId, names, resumeS: startS, cloudTried: cloud !== null && cloud.code === 'no_source' });
    const attempts = [...(cloud?.attempts ?? []), ...out.attempts];
    if (!out.ok) {
      if (cloud !== null && cloud.code === 'resolve_failed') {
        throw new DirectStreamError('resolve_failed', cloud.message, { ...(cloud.reason === null ? {} : { reason: cloud.reason }), attempts });
      }
      throw new DirectStreamError('no_source', `No provider or torrent could stream ${refLabel(ref)}.`, { attempts });
    }
    const session = this.sessions.createTorrent(ref, out.source, attempts, startS, audioLang, out.torrent);
    this.watchTorrents();
    safeRecord(this.evidence, sessionRecord(session, 'created', null));
    return session;
  }

  /** A session on this host's finished torrent download of `ref` (R2.9), or null (torrents off, none, not whole, or its file does not play). */
  private async diskSession(ref: StreamRef, resumeS: number | null): Promise<StreamSession | null> {
    const source = this.torrentSource();
    if (source === null) return null;
    const audioLang = await this.audioLang(ref);
    const startS = await this.startAt(ref, resumeS);
    const disk = await source.fromDisk(ref, { audioLang, resumeS: startS });
    if (disk === null) return null;
    // A replay's attempts are only its subtitle tiers' (`Subtitles: <tier>`): no index, no torrent was tried.
    const session = this.sessions.createTorrent(ref, disk.source, disk.attempts, startS, audioLang, disk.torrent);
    safeRecord(this.evidence, sessionRecord(session, 'created', null));
    return session;
  }

  private torrentSource(): TorrentSource | null {
    return this.opts.torrent?.() ?? null;
  }

  private async imdbIdOf(ref: StreamRef): Promise<string | null> {
    const hook = this.opts.hooks?.imdbId;
    return hook === undefined ? null : this.hookValue('imdbId', () => hook(ref));
  }

  /** Lets go of the session's torrent, if it holds one: with no other user the daemon leaves the swarm. */
  private letGoTorrent(session: StreamSession): void {
    if (session.torrent !== null) this.torrentSource()?.release(session.torrent);
  }

  /** Takes a released torrent again (a reload of the page). A failure is logged: the page's refresh says it. */
  private async holdTorrent(session: StreamSession, torrent: SessionTorrent): Promise<void> {
    const source = this.torrentSource();
    if (source === null || torrent.held || torrent.candidate === null) return;
    await source.hold(session.ref, torrent);
    this.watchTorrents();
  }

  /**
   * The player page closed or the film ended (a `closed` / `ended` position report): the session lets go of its
   * torrent. A reload of the page takes it again (info, refresh). Unknown ids are ignored.
   */
  letGo(id: string): void {
    const session = this.sessions.peek(id);
    if (session !== null) this.letGoTorrent(session);
  }

  /**
   * What a timer runs every minute while a torrent session holds its torrent: ended sessions are dropped (their
   * torrents released by the store's end listener), and a torrent no page asked about for TORRENT_IDLE_MS is
   * released. The timer stops once no session holds a torrent.
   */
  sweepTorrents(): void {
    const now = this.now().getTime();
    let holding = false;
    for (const session of this.sessions.live()) {
      const torrent = session.torrent;
      if (torrent === null || !torrent.held) continue;
      if (now - session.lastUsedAt.getTime() >= TORRENT_IDLE_MS) this.letGoTorrent(session);
      else holding = true;
    }
    if (!holding && this.torrentTimer !== null) {
      clearInterval(this.torrentTimer);
      this.torrentTimer = null;
    }
  }

  private watchTorrents(): void {
    if (this.torrentTimer !== null) return;
    this.torrentTimer = setInterval(() => this.sweepTorrents(), TORRENT_SWEEP_MS);
    this.torrentTimer.unref();
  }
```

**6.5 `openPage`'s log line** (`:291-295`, replace the `this.log(...)` call)
```ts
    this.log(
      session.torrent !== null
        ? `[notesd] direct stream: playing ${refLabel(session.ref)} from the torrent ${session.torrent.name} (${session.torrent.state}${session.torrent.candidate === null ? ', from disk' : ''})`
        : session.cache === null
          ? `[notesd] direct stream: playing ${refLabel(session.ref)} from ${session.source.provider}`
          : `[notesd] direct stream: playing ${refLabel(session.ref)} from the cache ${session.cache.id} (${session.cache.state}, ${session.source.provider})`,
    );
```

**6.6 `info`** (`:356-359`, whole method)
```ts
  /** What the player page reads, or null for an unknown or ended id. A torrent session that let go of its torrent (the page closed and is back) takes it again. */
  async info(id: string): Promise<SessionInfo | null> {
    const session = this.sessions.get(id);
    if (session === null) return null;
    if (session.torrent !== null) {
      await this.holdTorrent(session, session.torrent).catch((err: unknown) => this.log(`[notesd] direct stream: could not open the torrent ${session.torrent?.name ?? ''} again: ${messageOf(err)}`));
    }
    return this.sessionInfo(session);
  }
```

**6.7 `refresh`** (`:369-370`: insert right after the `unknown_session` throw, before `if (session.cache !== null)`)
```ts
    if (session.torrent !== null) {
      // A torrent has no token to renew: the session keeps it, taking it again when it was let go.
      try {
        await this.holdTorrent(session, session.torrent);
      } catch (err) {
        safeRecord(this.evidence, sessionRecord(session, 'refresh_failed', messageOf(err)));
        throw new DirectStreamError('resolve_failed', `The torrent ${session.torrent.name} could not be opened again: ${messageOf(err)}`, { reason: 'torrent_gone' });
      }
      session.refreshedAt = this.now();
      safeRecord(this.evidence, sessionRecord(session, 'refreshed', null));
      return this.sessionInfo(session);
    }
```

**6.8 `cacheSession`** (`:405`, replace the one line)
```ts
    // A torrent session is never cached: its download is its own copy on this machine.
    if (session.torrent !== null || caches === null || caches.start === undefined || caches.standing === undefined) return answer(false, null);
```

**6.9 `switchSource`** (`:442`, insert after the `cached` line)
```ts
    if (session.torrent !== null) return this.nextTorrent(session, session.torrent);
```
and the new private method (place it right after `switchSource`):
```ts
  /**
   * The shuffle button on a torrent session: the next of the session's remaining candidates, without asking the
   * indexes again. The old torrent is released once the new one plays; `no_other_source` leaves the session as
   * it was. `from` is `Torrent: <release>`.
   */
  private async nextTorrent(session: StreamSession, torrent: SessionTorrent): Promise<SwitchSourceAnswer> {
    const from = `${TORRENT_PROVIDER}: ${torrent.name}`;
    const source = this.torrentSource();
    const out = source === null ? null : await source.next(session.ref, torrent, session.audioLang);
    if (out === null || !out.ok) {
      this.log(`[notesd] direct stream: ${refLabel(session.ref)} stalls on the torrent ${torrent.name} and no other torrent could be played`);
      return { switched: false, reason: 'no_other_source', from, session: await this.sessionInfo(session) };
    }
    this.letGoTorrent(session);
    this.sessions.replaceTorrent(session, out.source, out.torrent, out.attempts);
    this.watchTorrents();
    safeRecord(this.evidence, sessionRecord(session, 'switched', null));
    this.log(`[notesd] direct stream: ${refLabel(session.ref)} moved from the torrent ${torrent.name} to ${out.torrent.name}`);
    return { switched: true, reason: null, from, session: await this.sessionInfo(session) };
  }
```

**6.10 `switchEpisode`** (`:478-481`, replace these lines)
```ts
    const next = await this.sessionFor(ref, null);
    this.log(
      `[notesd] direct stream: ${refLabel(session.ref)} -> ${refLabel(next.ref)} (${to} episode) ${
        next.torrent !== null ? `from the torrent ${next.torrent.name}` : next.cache === null ? `from ${next.source.provider}` : `from the cache ${next.cache.id}`
      }`,
    );
```
(The page sends a `closed` report for the old session when it moves, so its torrent is released by `letGo`.)

**6.11 `sessionInfo`** (`:723-763`, whole method)
```ts
  private async sessionInfo(session: StreamSession): Promise<SessionInfo> {
    const { ref, source, cache, torrent } = session;
    // A cache's or a torrent's files come from their own routes on this daemon, never through the pass-through.
    const local = torrent ?? cache;
    const titleHook = this.opts.hooks?.titleLabel;
    const title = (titleHook === undefined ? null : await this.hookValue('titleLabel', () => titleHook(ref))) ?? refLabel(ref);
    const neighbors = await this.neighborsOf(ref);
    if (torrent !== null) torrent.state = (await this.torrentSource()?.state(torrent)) ?? torrent.state;
    return {
      session_id: session.id,
      kind: ref.kind,
      tmdb_id: ref.tmdbId,
      season: ref.kind === 'tv' ? ref.season : null,
      episode: ref.kind === 'tv' ? ref.episode : null,
      title,
      provider: source.provider,
      manifest_kind: source.manifest_kind,
      manifest_url: local === null ? proxiedUrl(session.id, source.manifest_url) : local.manifestUrl,
      subtitles:
        local === null
          ? source.subtitles.map((t) => {
              const srt = t.format === 'srt' || /\.srt$/i.test(new URL(t.url).pathname);
              return {
                url: proxiedUrl(session.id, t.url, { vtt: srt }),
                lang: t.lang,
                label: t.label,
                format: srt ? 'vtt' : t.format,
                source: t.source,
                english: isEnglish(t),
              };
            })
          : local.subtitles.map((t) => ({ url: t.url, lang: t.lang, label: t.label, format: 'vtt', source: 'request' as const, english: isEnglish(t) })),
      best_height: source.best_height,
      audio_lang: session.audioLang,
      audio: source.audio ?? null,
      resume_s: session.resumeS,
      prev_episode: neighbors.prev,
      next_episode: neighbors.next,
      created_at: session.createdAt.toISOString(),
      refreshed_at: session.refreshedAt.toISOString(),
      expires_at: this.sessions.expiresAt(session).toISOString(),
      cached: cache === null ? null : { id: cache.id, state: cache.state, height: cache.height },
      torrent:
        torrent === null
          ? null
          : { info_hash: torrent.infoHash, file_index: torrent.fileIndex, name: torrent.name, index: torrent.index, state: torrent.state, seeds: torrent.seeds },
    };
  }
```

**6.12 Wiring** (`:785-796` `DirectStreamWiring`, add after `caches`; and `:829` in `buildDirectStreamService`, add after
`caches: wiring.caches,`)
```ts
  /** Torrent phase 3: the torrent source, read at play time (built from phase 1's TorrentStreams after this service). */
  torrent?: () => TorrentSource | null;
```
```ts
    torrent: wiring.torrent,
```
**Impact:** with `torrent` unset or answering null every method behaves as before (the cloud branch of
`resolveOrTorrent` rethrows; `diskSession` answers null; `letGoTorrent` is a no-op). `subtitleText` and
`DirectStreamService.resolve` still resolve through the cloud only (the dialogue reads a cloud subtitle). The
recordResolve hook is called for the cloud resolve that precedes a torrent (a `no_source` still marks the title
stale on the Stream side) and never for a torrent resolve.

**Test:** `tests/unit/directStream/torrentPlay.test.ts` (new), through the real routes, as `cachePlay.test.ts` does.
```ts
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { DirectStreamRepo } from '../../../src/directStream/repo.js';
import { DirectStreamService, TORRENT_IDLE_MS } from '../../../src/directStream/service.js';
import { SessionStore } from '../../../src/directStream/sessions.js';
import { parseRelease, type TorrentCandidate } from '../../../src/directStream/torrent/find/index.js';
import type { MediaProbe } from '../../../src/directStream/torrent/probe.js';
import { TorrentSource, type DownloadOnDisk, type FindAnswer, type TorrentSwarm } from '../../../src/directStream/torrent/source.js';
import { directStreamRoutes } from '../../../src/http/directStreamApi.js';

const HEADERS = { origin: 'http://localhost', 'content-type': 'application/json' };
const PLAY_FILM = { kind: 'movie', tmdb_id: 467905 };
const h = (n: number): string => n.toString(16).padStart(40, '0');
const NO_SOURCE = { ok: false, error: 'no_source', detail: '', attempts: [{ provider: 'Alpha', outcome: 'no_stream', took_s: 2, detail: '' }] };
const NO_CHROME = { ok: false, error: 'no_chrome', detail: 'chrome.exe was not found', attempts: [] };
const RESOLVED = {
  ok: true,
  source: { provider: 'Alpha', manifest_url: 'https://up.example/hls/master.m3u8', manifest_kind: 'hls', subtitles: [], best_height: 1080 },
  attempts: [{ provider: 'Alpha', outcome: 'resolved', took_s: 1, detail: '' }],
};
const MP4_EN: MediaProbe = { container: 'mov,mp4,m4a,3gp,3g2,mj2', video: { codec: 'h264', height: 720 }, audio: [{ codec: 'aac', lang: 'eng' }], subtitles: [], durationS: 62, direct: true };

const candidate = (infoHash: string, name: string): TorrentCandidate => ({
  infoHash, name, fileName: null, fileIdx: null, seeds: 30, sizeBytes: 700_000_000, index: 'torrentio', listedBy: ['torrentio'], site: null, trackers: [], scoped: false, release: parseRelease(name),
});

interface Setup {
  resolve?: unknown;
  /** false: torrents off (no torrent source). */
  torrents?: boolean;
  candidates?: TorrentCandidate[];
  disk?: DownloadOnDisk | null;
  ready?: string[];
  now?: () => Date;
}

function setup(o: Setup = {}) {
  const runs: string[][] = [];
  const swarmCalls: string[] = [];
  const recorded: unknown[] = [];
  const swarm: TorrentSwarm = {
    open: async (pick) => {
      swarmCalls.push(`open ${pick.infoHash}`);
      return { infoHash: pick.infoHash, files: [{ index: 0, path: 'Film.2026.720p.mp4', name: 'Film.2026.720p.mp4', length: 1_000_000 }] };
    },
    use: (infoHash) => {
      swarmCalls.push(`use ${infoHash}`);
    },
    release: (infoHash) => {
      swarmCalls.push(`release ${infoHash}`);
    },
    find: async () => o.disk ?? null,
    filePath: (infoHash, index) => ((o.ready ?? []).includes(infoHash) ? `/t/${infoHash}/${index}` : null),
    localUrl: (infoHash, index) => `/api/stream/torrent/${infoHash}/f/${index}`,
    setDuration: () => undefined,
  };
  const answer: FindAnswer = { candidates: o.candidates ?? [candidate(h(1), 'Film.2026.720p.WEB-DL.x264.AAC-A')], indexes: [{ index: 'torrentio', outcome: 'ok', detail: '', took_s: 0.1, listed: 1 }], excluded: [] };
  const finds = vi.fn(async () => answer);
  const torrent = new TorrentSource({ swarm, find: finds, probe: async () => MP4_EN, tiers: [], localBase: () => 'http://127.0.0.1:4321', log: () => undefined });
  const sessions = new SessionStore(o.now);
  const svc = new DirectStreamService({
    repo: { providers: async () => [], healthFor: async () => [], recordAttempts: async () => undefined } as unknown as DirectStreamRepo,
    runner: async (args: string[]) => {
      runs.push(args);
      return args[0] === 'open' ? { ok: true } : (o.resolve ?? NO_SOURCE);
    },
    host: 'host-a',
    seedFile: 'unused.json',
    pageBase: () => 'http://localhost:4321',
    hooks: {
      originalLanguage: async () => 'en',
      imdbId: async () => 'tt0467905',
      recordResolve: async (_ref, result) => {
        recorded.push(result);
      },
    },
    torrent: () => (o.torrents === false ? null : torrent),
    sessions,
    ...(o.now === undefined ? {} : { now: o.now }),
    log: () => undefined,
  });
  const app = new Hono();
  app.route('/', directStreamRoutes({ directStream: svc }));
  const count = (verb: string): number => runs.filter((a) => a[0] === verb).length;
  const settled = async (): Promise<string[]> => {
    await new Promise((r) => setTimeout(r, 0));
    return swarmCalls;
  };
  return { app, svc, finds, recorded, settled, resolves: () => count('resolve'), opens: () => count('open') };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function post(app: Hono, path: string, body: unknown = {}): Promise<{ status: number; json: any }> {
  const res = await app.request(path, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

describe('a torrent session', () => {
  it('provider "Torrent" (any case) plays a torrent and asks no cloud provider: the local file route, provider Torrent (R2.4)', async () => {
    const t = setup({ resolve: RESOLVED });
    const { status, json } = await post(t.app, '/api/stream/play', { ...PLAY_FILM, provider: 'TORRENT' });
    expect(status).toBe(200);
    expect(json.session).toMatchObject({
      provider: 'Torrent',
      manifest_kind: 'mp4',
      manifest_url: `/api/stream/torrent/${h(1)}/f/0`,
      cached: null,
      torrent: { info_hash: h(1), file_index: 0, name: 'Film.2026.720p.WEB-DL.x264.AAC-A', index: 'torrentio', state: 'downloading', seeds: 30 },
    });
    expect(json.attempts.map((a: { provider: string }) => a.provider)).toEqual(['Index: torrentio', 'Torrent: Film.2026.720p.WEB-DL.x264.AAC-A']);
    expect([t.resolves(), t.opens()]).toEqual([0, 1]);
    expect(t.recorded).toEqual([]);
    // The pass-through serves nothing for it, as for a cache.
    const through = await t.app.request(`/api/stream/sessions/${json.session.session_id}/p?u=${encodeURIComponent('https://up.example/x.ts')}`);
    expect(through.status).toBe(403);
    expect(t.svc.evidenceSource(json.session.session_id)?.torrent).toEqual({ info_hash: h(1), name: 'Film.2026.720p.WEB-DL.x264.AAC-A', file_index: 0, index: 'torrentio', state: 'downloading' });
  });

  it('answers 503 torrent_off to a named torrent play while torrents are off, and runs nothing (R2.6)', async () => {
    const t = setup({ torrents: false });
    const { status, json } = await post(t.app, '/api/stream/play', { ...PLAY_FILM, provider: 'torrent' });
    expect(status).toBe(503);
    expect(json.error).toBe('torrent_off');
    expect([t.resolves(), t.opens()]).toEqual([0, 0]);
    expect(t.finds).not.toHaveBeenCalled();
  });

  it('with torrents off, a cloud no_source answers exactly as before: no index, no torrent in attempts (R2.6)', async () => {
    const t = setup({ torrents: false });
    const { status, json } = await post(t.app, '/api/stream/play', PLAY_FILM);
    expect(status).toBe(502);
    expect(json).toMatchObject({ error: 'no_source', attempts: NO_SOURCE.attempts });
    expect(t.finds).not.toHaveBeenCalled();
  });

  it('tries the torrent source after a cloud no_source: attempts are the cloud\'s, then the index, then the torrent (R2.5)', async () => {
    const t = setup();
    const { status, json } = await post(t.app, '/api/stream/play', PLAY_FILM);
    expect(status).toBe(200);
    expect(json.session.provider).toBe('Torrent');
    expect(json.attempts.map((a: { provider: string; outcome: string }) => `${a.provider} ${a.outcome}`)).toEqual([
      'Alpha no_stream',
      'Index: torrentio resolved',
      'Torrent: Film.2026.720p.WEB-DL.x264.AAC-A resolved',
    ]);
    expect(t.resolves()).toBe(1);
    // The cloud no_source was recorded (the title is stale on the Stream side); the torrent resolve was not.
    expect(t.recorded).toEqual([expect.objectContaining({ ok: false, error: 'no_source' })]);
  });

  it('answers no_source with the cloud, index and torrent attempts when no torrent plays either (R2.5)', async () => {
    const t = setup({ candidates: [] });
    const { status, json } = await post(t.app, '/api/stream/play', PLAY_FILM);
    expect(status).toBe(502);
    expect(json.error).toBe('no_source');
    expect(json.attempts.map((a: { provider: string }) => a.provider)).toEqual(['Alpha', 'Index: torrentio']);
  });

  it('goes on to the torrent source when the cloud resolve cannot run, and keeps that error when no torrent plays', async () => {
    const plays = setup({ resolve: NO_CHROME });
    expect((await post(plays.app, '/api/stream/play', PLAY_FILM)).json.session.provider).toBe('Torrent');
    const none = setup({ resolve: NO_CHROME, candidates: [] });
    const { status, json } = await post(none.app, '/api/stream/play', PLAY_FILM);
    expect(status).toBe(502);
    expect(json).toMatchObject({ error: 'resolve_failed', reason: 'no_chrome' });
    expect(json.attempts.map((a: { provider: string }) => a.provider)).toEqual(['Index: torrentio']);
  });

  it('plays a finished download from disk first: no resolve, no index, no swarm (R2.9)', async () => {
    const t = setup({ resolve: RESOLVED, disk: { infoHash: h(7), name: 'Film.2026.720p.WEB-DL.x264.AAC-D', fileIndex: 0, state: 'ready' }, ready: [h(7)] });
    const { status, json } = await post(t.app, '/api/stream/play', PLAY_FILM);
    expect(status).toBe(200);
    expect(json.attempts).toEqual([]);
    expect(json.session.torrent).toMatchObject({ info_hash: h(7), state: 'ready', index: null, seeds: null });
    expect(t.resolves()).toBe(0);
    expect(t.finds).not.toHaveBeenCalled();
    expect(await t.settled()).toEqual([]);
  });

  it('the shuffle button moves to the next candidate and releases the old torrent; with none left it stays', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.720p.WEB-DL.x264.AAC-A'), candidate(h(2), 'Film.2026.720p.WEB-DL.x264.AAC-B')] });
    const sid = (await post(t.app, '/api/stream/play', { ...PLAY_FILM, provider: 'torrent' })).json.session.session_id;
    const moved = await post(t.app, `/api/stream/sessions/${sid}/source`);
    expect(moved.json).toMatchObject({ switched: true, from: 'Torrent: Film.2026.720p.WEB-DL.x264.AAC-A', torrent: { info_hash: h(2) }, manifest_url: `/api/stream/torrent/${h(2)}/f/0` });
    expect(await t.settled()).toContain(`release ${h(1)}`);
    const stuck = await post(t.app, `/api/stream/sessions/${sid}/source`);
    expect(stuck.json).toMatchObject({ switched: false, reason: 'no_other_source', torrent: { info_hash: h(2) } });
    expect(t.resolves()).toBe(0);
  });

  it('never caches a torrent session', async () => {
    const t = setup();
    const sid = (await post(t.app, '/api/stream/play', { ...PLAY_FILM, provider: 'torrent' })).json.session.session_id;
    const answer = await post(t.app, `/api/stream/sessions/${sid}/cache`, { start: true });
    expect(answer.json).toMatchObject({ moved: false, cache: null, provider: 'Torrent' });
  });

  it('lets go of the torrent when the page closes, takes it again when the page comes back, and after an idle spell', async () => {
    let now = new Date('2026-11-16T12:00:00Z');
    const t = setup({ now: () => now });
    const sid = (await post(t.app, '/api/stream/play', { ...PLAY_FILM, provider: 'torrent' })).json.session.session_id;
    t.svc.letGo(sid);
    expect((await t.settled()).filter((c) => c === `release ${h(1)}`)).toHaveLength(1);
    const back = await t.app.request(`/api/stream/sessions/${sid}`);
    expect(back.status).toBe(200);
    expect((await t.settled()).slice(-2)).toEqual([`open ${h(1)}`, `use ${h(1)}`]);
    now = new Date(now.getTime() + TORRENT_IDLE_MS + 1_000);
    t.svc.sweepTorrents();
    expect((await t.settled()).filter((c) => c === `release ${h(1)}`)).toHaveLength(2);
    const refreshed = await post(t.app, `/api/stream/sessions/${sid}/refresh`);
    expect(refreshed.status).toBe(200);
    expect(refreshed.json.torrent.info_hash).toBe(h(1));
    expect((await t.settled()).slice(-2)).toEqual([`open ${h(1)}`, `use ${h(1)}`]);
  });
});
```

### Step 7: HTTP edges
**File:** `src/http/directStreamApi.ts:63-66` (inside `directStreamErrorResponse`, before `case 'no_episode':`)
```ts
    case 'torrent_off':
      return c.json({ error: 'torrent_off', message: err.message }, 503);
```
**File:** `src/http/directStreamApi.ts:187-192` (`StreamPositionDeps`)
```ts
export interface StreamPositionDeps {
  movies: MovieStreamsSource | null;
  /** `letGo`: the page closed or the film ended, so the session lets go of its torrent (torrent phase 3). */
  directStream?: { session(id: string): StreamSessionRef | null | Promise<StreamSessionRef | null>; letGo?(id: string): void } | null;
  /** The stream on screen (`GET /api/movies/player`); without it the reports are only stored. */
  live?: StreamLive | null;
}
```
**File:** `src/http/directStreamApi.ts:225` (after `const over = report.ended === true || report.closed === true;`)
```ts
    // Torrent phase 3: the page is gone or the film is over, so the session lets go of its torrent (a reload takes it again).
    if (over) service.letGo?.(session.id);
```
**Impact:** a cloud or cache session ignores `letGo` (no torrent). Nothing else in the route changes.

### Step 8: `direct_stream_play`
**File:** `src/mcp/directStreamTools.ts:153` (replace the `'provider asks one named provider only ...'` line of
`PLAY_DESCRIPTION`)
```ts
  'provider asks one named provider only (a name from direct_stream_sources) and passes over a cache: for "stream it from VidLink", or when the stream that started is a cinema recording or a dub and another provider is known to be clean. ' +
  'provider "torrent" asks only the torrent source: a torrent of the title found by its IMDb id, downloaded from the swarm while it plays and served by this daemon (for "stream it from a torrent"). ' +
```
**File:** `src/mcp/directStreamTools.ts:164` (replace the `'The error no_source means ...'` line)
```ts
  'The error no_source means no provider and no torrent could stream it, and nothing started: attempts lists each provider with its outcome (resolved, no_stream, bot_check, error, dubbed, unplayable, skipped_browser_only, skipped_no_template); when no provider resolved, the torrent source was tried before answering, and its attempts follow: "Index: <name>" for each torrent index asked and "Torrent: <release>" for each torrent tried (dubbed: its audio is another language; unplayable: Chrome cannot play the file as is; no_stream: no file list or too little data from the swarm in time). Offer /idlix or /lk21. ' +
  'When it plays from a torrent, play.session.provider is Torrent and play.session.torrent is { info_hash, file_index, name, index, state, seeds }; a title whose torrent download is whole on this machine plays again from disk with no index and no swarm asked (no Index: or Torrent: attempt). Attempts may also hold "Subtitles: <tier>" for each subtitle source asked. The error torrent_off means torrents are off on this machine (NOTESD_TORRENT=off). ' +
```
**File:** `src/mcp/directStreamTools.ts:489` (the `provider` field)
```ts
        provider: z.string().trim().min(1).max(60).optional().describe('Only when the owner names a provider ("stream it from VidLink"), or to leave a bad stream for a known good one: a name from direct_stream_sources. Only that provider is asked. "torrent" asks the torrent source only ("stream it from a torrent").'),
```
**File:** `src/mcp/directStreamTools.ts:632-641` (inside `catch`, replace the `no_source` block and add the `torrent_off` block
after it)
```ts
          if (failure.error === 'no_source') {
            return failJson({
              error: 'no_source',
              started: false,
              title: candidateView(await stored(), wall),
              ...picked,
              attempts: failure.attempts,
              next: 'No provider and no torrent could stream it, and nothing started. Tell the owner, one short line per attempt with its outcome (an "Index: " attempt is a torrent index asked, a "Torrent: " attempt one torrent tried), and offer /idlix or /lk21.',
            });
          }
          if (failure.error === 'torrent_off') {
            return failJson({
              error: 'torrent_off',
              started: false,
              title: candidateView(await stored(), wall),
              ...picked,
              message: failure.message,
              next: 'Nothing started: torrents are off on this machine (NOTESD_TORRENT=off). Say so in one line and offer to stream it from a cloud provider (call again without provider).',
            });
          }
```
**File:** `src/mcp/instructions.ts:63` — in the template string, replace the substring
`offer /idlix or /lk21). A stream always plays in the title's original language.` with:
```text
offer /idlix or /lk21). When no provider can stream a title the daemon tries a torrent of it before answering no_source (attempts then also list "Index: <name>" and "Torrent: <release>"), and provider "torrent" asks only the torrent source ("stream it from a torrent"); a title whose torrent download is whole on this machine plays again from disk; torrent_off means torrents are off on this machine. A stream always plays in the title's original language.
```
**File:** `src/chat/prompt.ts:40` — in the template string, replace the substring
`do not call again unless the owner asks. A stream always plays in the title's original language` with:
```text
do not call again unless the owner asks. The daemon tries a torrent of the title before answering no_source, so attempts may also list "Index: <name>" (a torrent index asked) and "Torrent: <release>" (a torrent tried); "stream it from a torrent" is direct_stream_play with provider "torrent", and torrent_off means torrents are off on this machine. A stream always plays in the title's original language
```
**File:** `claude/skills/direct-stream/SKILL.md:140` (after the `play.session.cached` bullet line) add:
```markdown
  When `play.session.torrent` is set (provider `Torrent`), say it plays from a torrent: name the release
  (`torrent.name`), and say it downloads while it plays (`state: "downloading"`) or plays from this laptop's
  disk (`ready`, no `Index:` or `Torrent:` attempt: no index and no swarm was asked).
```
and replace the `- **Error `no_source`:**` bullet (`:163-166`) with:
```markdown
- **Error `no_source`:** nothing started. Say no source could stream it, then one short line per
  attempt from `attempts` with its `outcome` (`no_stream`, `bot_check`, `error`, `dubbed`,
  `unplayable`, `skipped_browser_only`). The daemon tries a torrent before answering, so `attempts`
  may end with `Index: <name>` (a torrent index asked) and `Torrent: <release>` (a torrent tried;
  `unplayable`: Chrome cannot play its file). Offer `/idlix` or `/lk21`. Do not call again unless asked.
- **Error `torrent_off`:** torrents are off on this machine (`NOTESD_TORRENT=off`); say so and offer
  to stream it from a cloud provider (call again without `provider`).
```
and in Step 2 of the skill, wherever it explains `provider` (search for `provider` in the "Step 2" section), add the
sentence: `"stream it from a torrent" is \`provider: "torrent"\`: only the torrent source is asked.`
**Impact:** `npm run docs:gen` regenerates `docs/guide/reference/mcp-tools.md`.

**Test:** `tests/unit/mcp.directStreamTools.test.ts:257` (add after the `resolve_failed` test)
```ts
  it('passes provider "torrent" through to the service, and answers torrent_off when torrents are off', async () => {
    const f = fakeDeps();
    const c = await connect(f.deps);
    await c.call('direct_stream_play', { title: 'saltburn', provider: 'torrent' });
    expect(f.play.mock.calls).toEqual([[{ kind: 'movie', tmdbId: 930564 }, 'torrent']]);
    await c.close();
    const off = fakeDeps({ play: vi.fn(async () => { throw new DirectStreamError('torrent_off', 'Torrents are off on this machine (NOTESD_TORRENT=off).'); }) });
    const o = await connect(off.deps);
    const r = await o.call('direct_stream_play', { title: 'saltburn', provider: 'torrent' });
    expect(r.isError).toBe(true);
    expect(json(r)).toMatchObject({ error: 'torrent_off', started: false, title: { title: 'Saltburn' } });
    expect(json(r).next).toContain('without provider');
    await o.close();
  });
```

### Step 9: The IMDb id from TMDB
**File:** `src/movies/tmdb.ts:124` (in `interface TmdbTitleNames`, after `originalLanguage`)
```ts
  /** TMDB's `external_ids.imdb_id` of a film or series (`tt0137523`), in one request; null when TMDB has none or does not know the title. */
  imdbId(kind: TitleKind, tmdbId: number): Promise<string | null>;
```
**File:** `src/movies/tmdb.ts:336` (after `OriginalLanguageSchema`)
```ts
const ExternalIdsSchema = z.object({ imdb_id: text });
```
**File:** `src/movies/tmdb.ts:914` (in `createTmdbClient`'s returned object, after `originalLanguage`)
```ts
    async imdbId(kind, tmdbId) {
      const json = await getOrNull(`/${kind}/${tmdbId}/external_ids`, {});
      if (json === null) return null;
      const id = orNull(decode(ExternalIdsSchema, json, `${kind} ${tmdbId} external ids`).imdb_id);
      return id !== null && /^tt\d{5,10}$/.test(id) ? id : null;
    },
```
(The id is validated here, where it enters; the hook and `TorrentSource` trust it.)
**File:** `src/movies/streams.ts:161` (after `originalLanguage`)
```ts
  /**
   * The title's IMDb id for the torrent indexes (torrent phase 3): TMDB's external ids of the film or of the
   * series (an episode is found by the series' id with its season and episode). Not stored. Null when TMDB has
   * none, is not configured or cannot be reached.
   */
  async imdbId(target: StreamTarget): Promise<string | null> {
    try {
      const tmdb: (TmdbClient & Partial<TmdbTitleNames>) | null = this.movies.tmdb;
      if (tmdb === null || tmdb.imdbId === undefined) return null;
      return await tmdb.imdbId(target.kind, target.tmdbId);
    } catch (err) {
      if (!(err instanceof TmdbError)) this.log(`[notesd] direct stream: could not read the IMDb id of ${describeTarget(target)}: ${messageOf(err)}`);
      return null;
    }
  }

  /**
   * The title's names and year for the torrent finder (torrent phase 3): its title check leaves out a release that
   * names neither, and phase 9's 1337x search has nothing else to go by. The stored title row (ensured first, as
   * `animeRef` does); null when it is not stored and cannot be.
   */
  async titleNames(target: StreamTarget): Promise<{ title: string; originalTitle: string | null; year: number | null } | null> {
    try {
      const id = await this.ensureTitle(target);
      const row = id === null ? null : await this.movies.repo.titleById(id);
      if (row === null) return null;
      return { title: row.title, originalTitle: row.originalTitle === row.title ? null : row.originalTitle, year: row.year };
    } catch (err) {
      this.log(`[notesd] direct stream: could not read the names of ${describeTarget(target)}: ${messageOf(err)}`);
      return null;
    }
  }
```
**Test:** `tests/unit/movies/tmdb.lists.test.ts:82` (inside `describe('TmdbTitleNames')`)
```ts
  it("reads a title's IMDb id from its external ids, null when TMDB has none, a malformed one or does not know it", async () => {
    const f = routedFetch({
      '/movie/550/external_ids': { id: 550, imdb_id: 'tt0137523' },
      '/tv/1399/external_ids': { id: 1399, imdb_id: 'tt0944947', tvdb_id: 121361 },
      '/movie/1/external_ids': { id: 1, imdb_id: null },
      '/movie/2/external_ids': { id: 2, imdb_id: 'nm0000093' },
    });
    const client = createTmdbClient(CONFIG, f.fetch);
    expect(await client.imdbId('movie', 550)).toBe('tt0137523');
    expect(await client.imdbId('tv', 1399)).toBe('tt0944947');
    expect(await client.imdbId('movie', 1)).toBeNull();
    expect(await client.imdbId('movie', 2)).toBeNull();
    expect(await client.imdbId('movie', 404)).toBeNull();
  });
```

### Step 10: The finder's settings
**File:** `src/config.ts` — place right before phase 1's `TorrentConfig` interface (config.ts has no semicolons).
```ts
/** The JSON torrent indexes the finder asks (src/directStream/torrent/find/). */
export const TORRENT_INDEX_NAMES = ['torrentio', 'apibay', 'eztv', 'yts'] as const
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
  /** `NOTESD_TORRENT_INDEX_TIMEOUT_MS`: how long one index may take to answer. */
  indexTimeoutMs?: number
  /** `NOTESD_TORRENT_<NAME>_URL` per index: an address replaces the finder's, `off` (null) never asks that index. */
  indexes: Partial<Record<TorrentIndexName, string | null>>
}

export const DEFAULT_TORRENT_FINDER_CONFIG: TorrentFinderConfig = { indexes: {} }

/** The finder's settings; a bad number or a non-http address throws ConfigError. */
export function parseTorrentFinder(env: Record<string, string | undefined>): TorrentFinderConfig {
  const indexes: Partial<Record<TorrentIndexName, string | null>> = {}
  for (const name of TORRENT_INDEX_NAMES) {
    const key = `NOTESD_TORRENT_${name.toUpperCase()}_URL`
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
    indexTimeoutMs: optional('NOTESD_TORRENT_INDEX_TIMEOUT_MS'),
    indexes,
  }
}
```
The one ffmpeg every torrent phase runs (phase 5's remux, phase 7's extraction, phase 8's cutter) is this phase's
setting, beside `DEFAULT_FFPROBE_BIN` (`src/config.ts:268`); the probe keeps the existing `config.movies.ffprobeBin`
(`NOTESD_FFPROBE_BIN`), so both binaries have one owner here:
```ts
/** `NOTESD_FFMPEG_BIN`: the ffmpeg the torrent source runs (remux, subtitle extraction, Whisper's audio cuts). */
export const DEFAULT_FFMPEG_BIN = 'ffmpeg'
```
(main's picture check, commit `53806be`, defines the same constant and reads the same variable into
`DirectStreamConfig.ffmpegBin`; the merge keeps one constant and one configuration row.)

and in phase 1's code, these one-line additions, in this order (later phases append theirs after them: phase 5
`remux`, phase 6 `subtitleUrl`, phase 9 `sites`, phase 8 `whisper`):
```ts
  /** The finder's settings (torrent phase 3); unset: the finder's defaults. */
  finder?: TorrentFinderConfig
  /** `NOTESD_FFMPEG_BIN`, default `ffmpeg` on PATH; a path is ~-expanded and made absolute (torrent phase 3). */
  ffmpegBin: string
```
(fields of `interface TorrentConfig`),
```ts
  finder: DEFAULT_TORRENT_FINDER_CONFIG,
  ffmpegBin: DEFAULT_FFMPEG_BIN,
```
(in `DEFAULT_TORRENT_CONFIG`), and
```ts
    finder: parseTorrentFinder(env),
    ffmpegBin: parseBin(env.NOTESD_FFMPEG_BIN, DEFAULT_FFMPEG_BIN),
```
(in `parseTorrent`'s returned object; `parseBin` is the existing helper `NOTESD_FFPROBE_BIN` uses). Add the eight keys
to `loadConfig`'s doc comment's key list (the "Direct streaming keys" sentence). Phase 1's `tests/unit/config.test.ts`
whole-object expectation of the torrent config gains `finder: { indexes: {} }, ffmpegBin: 'ffmpeg'`.
**Test:** `tests/unit/config.torrentFinder.test.ts` (new)
```ts
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseTorrentFinder } from '../../src/config.js';

describe('parseTorrentFinder', () => {
  it('leaves every setting to the finder when nothing is set', () => {
    expect(parseTorrentFinder({})).toEqual({ indexes: {} });
  });

  it('reads the seed floor, the size cap in bytes, the index timeout, an index address and an index turned off', () => {
    expect(
      parseTorrentFinder({
        NOTESD_TORRENT_MIN_SEEDS: '8',
        NOTESD_TORRENT_MAX_GB: '12',
        NOTESD_TORRENT_INDEX_TIMEOUT_MS: '6000',
        NOTESD_TORRENT_TORRENTIO_URL: 'http://127.0.0.1:4555/',
        NOTESD_TORRENT_YTS_URL: 'OFF',
        NOTESD_TORRENT_APIBAY_URL: '',
      }),
    ).toEqual({ minSeeds: 8, maxSizeBytes: 12 * 1024 ** 3, indexTimeoutMs: 6000, indexes: { torrentio: 'http://127.0.0.1:4555', yts: null } });
  });

  it('rejects a bad number and an address that is not http(s)', () => {
    expect(() => parseTorrentFinder({ NOTESD_TORRENT_MIN_SEEDS: '0' })).toThrow(ConfigError);
    expect(() => parseTorrentFinder({ NOTESD_TORRENT_EZTV_URL: 'eztvx.to' })).toThrow(ConfigError);
  });

  it('reads the ffmpeg the torrent source runs', () => {
    const t = (env: Record<string, string>) => loadConfig({ env: { DATABASE_URL: 'postgres://u:p@localhost/db', ...env }, envFile: false }).torrent;
    expect(t({})?.ffmpegBin).toBe('ffmpeg');
    expect(t({ NOTESD_FFMPEG_BIN: '/opt/ff/bin/ffmpeg' })?.ffmpegBin).toBe('/opt/ff/bin/ffmpeg');
  });
});
```

### Step 11: Wiring in the daemon
**File:** `src/daemon.ts:31` (after `import { buildDirectStreamService } ...`)
```ts
import { buildTorrentSource, type TorrentSource } from './directStream/torrent/source.js';
import { buildSubtitleTiers } from './directStream/torrent/subtitles/chain.js';
```
**File:** `src/daemon.ts:189` (just before `const directStream = buildDirectStreamService(`)
```ts
  // Torrent phase 3: the torrent source, built on first use from phase 1's TorrentStreams (deps.torrents, null
  // with NOTESD_TORRENT=off). ffprobe reads a torrent's file through this daemon's own route on loopback.
  let torrentSource: TorrentSource | null = null;
  const torrentSourceOf = (): TorrentSource | null => {
    const torrents = deps.torrents ?? null;
    if (torrentSource === null && torrents !== null && config.torrent?.enabled === true) {
      torrentSource = buildTorrentSource(config, torrents, {
        localBase: () => `http://127.0.0.1:${boundPort ?? config.port}`,
        tiers: buildSubtitleTiers({
          torrentDir: config.torrent.dir,
          torrents,
          log: (line) => console.log(line),
          // Phase 6 adds subtitleUrl, fetch, lend, convertAss here; phase 7 embedded; phase 8 whisper (one line each).
        }),
        // Phase 5 adds `remux` and phase 9 `fallback` here (one line each).
      });
    }
    return torrentSource;
  };
```
**File:** `src/daemon.ts:195-206` (in the `buildDirectStreamService` wiring object: add `torrent` after `caches`, and the
`imdbId` hook after `neighbors`)
```ts
    torrent: torrentSourceOf,
```
```ts
            imdbId: (ref) => movieStreams.imdbId(ref),
            titleNames: (ref) => movieStreams.titleNames(ref),
```
**Impact:** with `NOTESD_TORRENT=off` (or phase 1's `deps.torrents` null) `torrentSourceOf` answers null on every call
and every play is as before. Phases 5, 6, 7, 8 and 9 each add one line (or one field) inside this block; their
merges meet here and are unions of lines, never edits of the same line. Phase 1 names the field `deps.torrents` and builds it in this file; the closure reads it at
play time, so the order of the two builds does not matter.

### Step 12: Route descriptions and generated references
**File:** `scripts/docs/httpRoutes.ts:224` (`'POST /api/stream/play'`), append before `400 \`invalid_json\``:
```text
`provider: "torrent"` (any case) asks only the torrent source (a finished download of the title on this machine first, with no index and no swarm; else a torrent found by the title's IMDb id and played from the swarm). Without a provider, a finished torrent download on this machine comes right after the stream cache, and when no provider resolves the title (or the resolve cannot run) the torrent source is tried before answering: `attempts` then go on with `Index: <name>` per torrent index asked and `Torrent: <release>` per torrent tried (`resolved`, `no_stream`, `dubbed`, `unplayable`, `error`). A torrent session has `provider` `Torrent` and `session.torrent` set. 503 `torrent_off` when `provider` is `torrent` and torrents are off (`NOTESD_TORRENT=off`).
```
`'GET /api/stream/sessions/:id'` (`:226`): add `torrent` to the field list and append:
```text
`torrent` is `{info_hash, file_index, name, index, state, seeds}` when the session plays from a torrent (`state` `ready` once the file is whole on this machine, else `downloading`; `index` and `seeds` null for a replay from disk), else null; then `manifest_url` is the torrent's file route (`/api/stream/torrent/<hash>/f/<index>`). Reading a torrent session whose page had closed takes its torrent again.
```
`'POST /api/stream/sessions/:id/refresh'` (`:230`), append: `A torrent session keeps its torrent, taking it again when it was let go; 502 \`resolve_failed\` with \`reason\` \`torrent_gone\` when the swarm cannot open it.`
`'POST /api/stream/sessions/:id/source'` (`:232`), append: `A torrent session moves to the next torrent the indexes listed (no index is asked again) and lets go of the old one; \`from\` is \`Torrent: <release>\`.`
`'POST /api/stream/sessions/:id/cache'` (`:234`), append: `A torrent session is never cached (\`moved: false\`, \`cache: null\`).`
`'POST /api/stream/sessions/:id/position'` (`:237`), append: `A \`closed\` or \`ended\` report also makes a torrent session let go of its torrent (the daemon leaves the swarm once nothing else uses it).`
Then run `npm run docs:gen` (regenerates `docs/guide/reference/http-api.md` and `mcp-tools.md`; never hand-edit them).

### Step 13: Configuration rows and the guide
**File:** `docs/guide/reference/configuration.md` — in the table where phase 1 lists `NOTESD_TORRENT` (append after its
last row):
```markdown
| `NOTESD_TORRENT_MIN_SEEDS` | the finder's own | A torrent with fewer seeds than this is never picked. See [streaming.md](../streaming.md#playing-from-a-torrent). |
| `NOTESD_TORRENT_MAX_GB` | the finder's own | A release bigger than this many GiB is left out. |
| `NOTESD_TORRENT_INDEX_TIMEOUT_MS` | the finder's own | How long one torrent index may take to answer before it counts as `error` and the others go on. |
| `NOTESD_TORRENT_TORRENTIO_URL` | the finder's own (Torrentio) | Address of the Torrentio index; `off` never asks it. `verify.sh up --torrent` points it at a fake. |
| `NOTESD_TORRENT_APIBAY_URL` | the finder's own (apibay) | Address of the apibay index; `off` never asks it. |
| `NOTESD_TORRENT_EZTV_URL` | the finder's own (EZTV) | Address of the EZTV index (series only); `off` never asks it. |
| `NOTESD_TORRENT_YTS_URL` | the finder's own (YTS) | Address of the YTS index (films only); `off` never asks it. |
| `NOTESD_FFMPEG_BIN` | `ffmpeg` | The `ffmpeg` the torrent source runs: phase 5's remux, phase 7's subtitle extraction and phase 8's audio cuts. A bare name is looked up on `PATH`. (`ffprobe` is the existing `NOTESD_FFPROBE_BIN`.) |
```
(`NOTESD_FFMPEG_BIN` is the name main's picture check (commit `53806be`, `DirectStreamConfig.ffmpegBin`) already reads; when this branch meets main, keep one row in `configuration.md` and one `DEFAULT_FFMPEG_BIN`, and let both fields read the one variable.)
**File:** `docs/guide/streaming.md` — under the "Torrents" heading phase 1 adds (one heading level below it), a new
subsection:
```markdown
### Playing from a torrent

A torrent is a source inside `/direct-stream`, not a command of its own.

- **When it is asked.** `direct_stream_play` with `provider: "torrent"` (any case; "stream it from a torrent") asks
  the torrent source alone, and passes over the stream cache. Without a provider a play looks, in order, at this
  machine's stream cache, at a finished torrent download of the title on this machine, at the cloud providers, and
  only when they answer `no_source` (or the resolve cannot run because the streaming Chrome is down: a torrent needs
  no Chrome) at the torrent source. The Movies page's Play and the player's previous and next buttons go the same way.
- **How a torrent is chosen.** The title's IMDb id comes from TMDB (`external_ids`; a series is asked by its own id
  with the season and episode). The finder asks the torrent indexes and ranks what they list. The daemon then tries at
  most five torrents in that order, within 90 seconds: the file list from the swarm (20 s at most), the film's file
  (an episode's file inside a season pack), and ffprobe reading its header through the daemon's file route. A file
  whose audio names only languages other than the title's original is `dubbed` and skipped, as a dubbed cloud stream
  is; a file Chrome cannot play as is (MKV, HEVC, AC3, DTS) is `unplayable` and skipped; a torrent with no file list
  or too little data in time is `no_stream`. The first that passes plays.
- **What the answer says.** `attempts` holds the cloud providers' outcomes, then `Index: <name>` for each index asked
  (`resolved` when it listed torrents, `no_stream` when it listed none, `error`, `bot_check`), then
  `Torrent: <release>` for each torrent tried. When none plays the answer is `no_source` with all of them; after a
  resolve that could not run it stays `resolve_failed` with the torrent attempts added.
- **The session.** `provider` is `Torrent`, `manifest_kind` `mp4`, `manifest_url` the torrent's file route
  (`/api/stream/torrent/<hash>/f/<index>`), and `session.torrent` names the info hash, the file, the release, the
  index, the seed count and whether the file is whole on disk (`ready`) or still downloading. The pass-through refuses
  every address for it. The play is recorded with the provider `Torrent`; a torrent play does not mark the title's
  Stream side verified (a cloud `no_source` before it still marks it stale).
- **The shuffle button** moves to the next torrent the indexes listed, without asking them again, and lets go of the
  old one. A torrent session is never moved into the stream cache: its download is already on this machine.
- **Leaving the swarm.** A session lets go of its torrent when the page closes or the film ends, when it moves to
  another torrent, after two minutes without a word from the page, and when the session ends; with no other session
  on it the daemon leaves the swarm. Reopening the page takes the torrent again.
- **Playing again from disk.** A title whose torrent download is whole on this machine plays from disk at once, with
  no index asked and no swarm joined (no `Index:` or `Torrent:` attempt, `torrent.state` `ready`). The file is read again first: one
  that turns out to be a dub, or that Chrome cannot play, is passed over and the play goes on as if it were not there.
- **Subtitles** come from the subtitle tiers, asked in order (the sections below add them: kept, files, embedded,
  service, borrow, whisper) until one answers anything; every tier answers only English tracks, or the torrent's one
  subtitle file that names no language. Each tier asked is an attempt `Subtitles: <tier>` (`resolved`, `no_stream`,
  `error`, or `skipped` with the reason). The tiers that hold up a play share one budget of 40 seconds from the moment
  the chain starts: one that would start after it is spent is `skipped`, and one still running when it runs out is an
  `error`. The growing tiers (the embedded track, Whisper) answer at once and fill their track in the background, so
  they are never counted.
- **Finding a torrent** (`src/directStream/torrent/find/`). The finder asks the JSON indexes all at once, each by the
  title's IMDb id and within its own timeout: Torrentio, apibay, EZTV for a series and YTS for a film (YTS timed out
  from this network once, so it can be turned off). Every request says it is notesd; a bot check is the outcome
  `bot_check` and is never worked around; an index that fails or times out is `error` and the others go on. It leaves
  out a release that names another title, a dub, a cinema recording (CAM, TS, TELESYNC, HDCAM) or 3D, another episode,
  fewer seeds than `NOTESD_TORRENT_MIN_SEEDS` or more than `NOTESD_TORRENT_MAX_GB`. A release Chrome plays as is
  (H.264, AAC, MP4, one audio track) comes before one that needs a remux, and among equals more seeds come first. For an
  episode it keeps a torrent of that episode or a pack that holds it, and picks the episode's file inside a pack
  (never a sample).
- **Off.** With `NOTESD_TORRENT=off` nothing above happens: no index is asked, no swarm joined, plays are exactly as
  without torrents, and a play with `provider: "torrent"` answers 503 `torrent_off`.
```
**File:** `docs/guide/streaming.md:528` (the "Direct streaming answers" table, after the `no_source` row)
```markdown
| `torrent_off` | A play asked for the torrent source (`provider: "torrent"`) while torrents are off on this machine (`NOTESD_TORRENT=off`) |
```
and change the `no_source` row's meaning to: `No provider resolved the title and no torrent played; \`attempts\` lists each provider's outcome, then each torrent index and torrent tried`.

### Step 14: The proof harness
**File:** `.claude/skills/verify-notesd/scripts/movies/fake-tmdb.mjs:258` (before the `// Trailers:` comment)
```js
  // Torrent phase 3: the IMDb id the torrent indexes are asked by. A title may name its own imdb_id; else tt + the TMDB id.
  if ((m = p.match(/^\/(movie|tv)\/(\d+)\/external_ids$/))) {
    const x = byId(m[1] === 'movie' ? movies : tvs, m[2])
    return x ? [200, { id: x.id, imdb_id: x.imdb_id ?? `tt${String(x.id).padStart(7, '0')}` }] : notFound()
  }
```
**File:** `.claude/skills/verify-notesd/scripts/torrent/fake-index.mjs` (new)
```js
// fake-index.mjs: a Torrentio stand-in for `verify.sh up --torrent` (torrent phase 3). It lists the loopback fixture
// torrents phase 1's --torrent mode seeds, so a throwaway daemon never asks a real index.
//   node fake-index.mjs --fixtures DIR --titles TMDB_JSON --port-file FILE --log FILE
// Every release it answers is named `<Title>.<Year>.<tail>` after the asked title (TMDB_JSON is the fake TMDB's
// tmdb.json; the fake TMDB answers an IMDb id `tt` + the TMDB id padded to 7 digits, or a title's own `imdb_id`), so
// the finder's title check keeps it.
// GET /stream/movie/<imdb id>.json answers DIR/fixture.json's torrent (a single film, fileIdx of its video), tail
// `720p.WEB-DL.x264.AAC-NOTESD`.
// GET /stream/series/<imdb id>:<season>:<episode>.json answers DIR/pack.json's torrent (a season pack, tail
// `S01.720p.WEB-DL.x264.AAC-NOTESD`) with no fileIdx, so the daemon picks the episode's file itself.
// DIR/candidates.json, when present, replaces both answers for every query: [{info_hash, name, seeds?, size_bytes?}],
// each `name` a release tail (phases 5, 6 and 8 hand out the torrents they seed under DIR/seed/ this way).
// DIR/index-mode picks the answer: ok (default) | empty ({"streams": []}) | error (HTTP 500).
// Every request is one JSON line in the log: {at, path, mode}.
import http from 'node:http'
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const opts = {}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 2) opts[argv[i].replace(/^--/, '')] = argv[i + 1]
if (!opts.fixtures || !opts.titles || !opts['port-file'] || !opts.log) {
  console.error('usage: node fake-index.mjs --fixtures DIR --titles TMDB_JSON --port-file FILE --log FILE')
  process.exit(2)
}

const read = (name) => {
  const file = path.join(opts.fixtures, name)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}
const mode = () => {
  const file = path.join(opts.fixtures, 'index-mode')
  return (existsSync(file) ? readFileSync(file, 'utf8').trim() : '') || 'ok'
}
const size = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(2)} MB`)

// The fake TMDB's titles by the IMDb id it hands out for them.
const tmdb = JSON.parse(readFileSync(opts.titles, 'utf8'))
const imdbOf = (x) => x.imdb_id ?? `tt${String(x.id).padStart(7, '0')}`
const titleOf = (imdb) => {
  for (const m of tmdb.movies ?? []) if (imdbOf(m) === imdb) return { name: m.title, year: (m.release_date ?? '').slice(0, 4) }
  for (const t of tmdb.tv ?? []) if (imdbOf(t) === imdb) return { name: t.name, year: (t.first_air_date ?? '').slice(0, 4) }
  return { name: 'Unknown Title', year: '2026' }
}
const dotted = (title) => `${title.name.replace(/[^A-Za-z0-9]+/g, '.').replace(/^\.|\.$/g, '')}${title.year ? `.${title.year}` : ''}`

// One Torrentio stream in its real shape: the release on the first title line, the file on the second for a pack,
// then seeds, size and the source index.
function stream(fixture, release, { fileIdx, fileName, seeds = 25 }) {
  const total = fixture.size_bytes ?? (fixture.files ?? []).reduce((n, f) => n + (f.length ?? 0), 0)
  const lines = [release, ...(fileIdx === undefined ? [] : [fileName]), `👤 ${seeds} 💾 ${size(total)} ⚙️ VerifyFixture`]
  return {
    name: 'Torrentio\n720p',
    title: lines.join('\n'),
    infoHash: fixture.info_hash,
    ...(fileIdx === undefined ? {} : { fileIdx }),
    behaviorHints: { bingeGroup: `torrentio|${fixture.info_hash}`, ...(fileName === undefined ? {} : { filename: fileName }) },
    sources: [...(fixture.trackers ?? []).map((t) => `tracker:${t}`), `dht:${fixture.info_hash}`],
  }
}

function answer(pathname) {
  if (mode() === 'empty') return [200, { streams: [] }]
  let m
  const listed = read('candidates.json')
  if ((m = pathname.match(/^\/stream\/(?:movie|series)\/(tt\d+)(?::\d+:\d+)?\.json$/)) && Array.isArray(listed)) {
    const title = dotted(titleOf(m[1]))
    return [200, { streams: listed.map((c) => stream(c, `${title}.${c.name}`, { seeds: c.seeds ?? 25 })) }]
  }
  if ((m = pathname.match(/^\/stream\/movie\/(tt\d+)\.json$/))) {
    const film = read('fixture.json')
    if (film === null) return [200, { streams: [] }]
    const video = (film.files ?? []).find((f) => /\.(mp4|mkv|webm)$/i.test(f.path)) ?? film.files?.[0]
    return [200, { streams: [stream(film, `${dotted(titleOf(m[1]))}.720p.WEB-DL.x264.AAC-NOTESD`, { fileIdx: video?.index ?? 0, fileName: video?.path.split('/').pop() })] }]
  }
  if ((m = pathname.match(/^\/stream\/series\/(tt\d+):(\d+):(\d+)\.json$/))) {
    const pack = read('pack.json')
    if (pack === null) return [200, { streams: [] }]
    return [200, { streams: [stream(pack, `${dotted({ ...titleOf(m[1]), year: '' })}.S01.720p.WEB-DL.x264.AAC-NOTESD`, {})] }]
  }
  return [404, { error: 'not found' }]
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const now = mode()
  appendFileSync(opts.log, `${JSON.stringify({ at: new Date().toISOString(), path: url.pathname, mode: now })}\n`)
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
    return
  }
  if (now === 'error') {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('fake index: mode error')
    return
  }
  const [status, body] = answer(url.pathname)
  res.writeHead(status, { 'content-type': 'application/json;charset=utf-8' })
  res.end(JSON.stringify(body))
})
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address()
  writeFileSync(`${opts['port-file']}.tmp`, String(port))
  renameSync(`${opts['port-file']}.tmp`, opts['port-file'])
  console.log(`fake torrent index on http://127.0.0.1:${port}`)
})
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => process.exit(0))
```
**File:** `.claude/skills/verify-notesd/scripts/verify.sh` — three additions to phase 1's `--torrent` mode (its flag
variable is assumed to be `torrent`, set to 1 by `--torrent`, which implies `--direct-stream`):

(a) in `cmd_up`, right after phase 1's block that seeds the fixture(s) under `$dir/torrent/` (phase 1's flag variable
is `torrent`; `--torrent` sets `movies=1`, so the fake TMDB and its `tmdb.json` are there):
```bash
  # --torrent (torrent phase 3): a fake Torrentio that lists the seeded fixture(s). Never a real index.
  if [ "$torrent" = 1 ]; then
    setsid node "$HERE/torrent/fake-index.mjs" --fixtures "$dir/torrent" --titles "$HERE/movies/tmdb.json" \
      --port-file "$dir/torrent/index.port" --log "$dir/torrent/index.jsonl" </dev/null >"$dir/torrent/index.out" 2>&1 &
    echo $! >"$dir/torrent-index.pid"
    for _ in $(seq 1 40); do [ -s "$dir/torrent/index.port" ] && break; sleep 0.25; done
    [ -s "$dir/torrent/index.port" ] || die "--torrent: the fake index did not start (log: $dir/torrent/index.out; verify.sh down $run)"
  fi
```
(b) in `cmd_up`'s env, after phase 1's `NOTESD_TORRENT` lines:
```bash
  # Torrent phase 3: the finder asks only the fake index on a --torrent run, and no index at all otherwise.
  if [ "$torrent" = 1 ]; then
    env+=(
      "NOTESD_TORRENT_TORRENTIO_URL=http://127.0.0.1:$(cat "$dir/torrent/index.port")"
      NOTESD_TORRENT_APIBAY_URL=off NOTESD_TORRENT_EZTV_URL=off NOTESD_TORRENT_YTS_URL=off NOTESD_TORRENT_MIN_SEEDS=1
    )
  else
    env+=(NOTESD_TORRENT_TORRENTIO_URL=off NOTESD_TORRENT_APIBAY_URL=off NOTESD_TORRENT_EZTV_URL=off NOTESD_TORRENT_YTS_URL=off)
  fi
```
(c) in `stop_run` (`:465-470`), next to the upstream host's lines:
```bash
  # --torrent: the fake index was started by `up`; keep its request log.
  if [ -f "$dir/torrent-index.pid" ]; then
    kill -TERM -- "-$(cat "$dir/torrent-index.pid")" 2>/dev/null || kill -TERM "$(cat "$dir/torrent-index.pid")" 2>/dev/null || true
    rm -f "$dir/torrent-index.pid"
  fi
  if [ -f "$dir/torrent/index.jsonl" ]; then cp "$dir/torrent/index.jsonl" "$dir/evidence/torrent-index-requests.jsonl"; fi
```
**File:** `.claude/skills/verify-notesd/scripts/direct-stream/torrent.sh` (new, `chmod +x`)
```bash
#!/usr/bin/env bash
# torrent.sh RUN [fallback|named|replay|dubbed|pack|off ...]: torrent phase 3's journeys on a throwaway daemon.
# On a `verify.sh up --web --torrent` run (phase 1's loopback fixture torrent, the fake index, the fake resolver):
#   fallback  the fake resolver answers no_source; POST /api/stream/play of How to Make a Killing (TMDB movie 467905)
#             answers 200 from the torrent: provider Torrent, manifest_url the fixture's file route, attempts = the
#             cloud's, then "Index: torrentio", then "Torrent: <release>" resolved; exactly one more resolve ran.
#   named     direct_stream_play over MCP with provider "torrent" for The Dog Stars (movie-990002) while the fake
#             resolver would answer (mode hls): started true, provider Torrent, no resolve ran, one more open naming
#             the session's page, and bytes 0-99 of manifest_url answer 206 with exactly 100 bytes.
#             The session id is kept in $RUN/torrent-journey/sid for torrent-play.steps.mjs.
#   replay    waits until the fixture is whole on disk, closes every session this script made (a closed position
#             report), waits until the daemon holds no peer of it, sets the fake index to answer HTTP 500, and plays
#             467905 again: 200 with no "Index: "/"Torrent: " attempt, torrent.state ready, no new index request, no
#             new resolve, still no peer, and the daemon's log says "from disk".
#   dubbed    Oldboy (TMDB movie 990004, original language ko) with provider torrent: 502 no_source, and its torrent
#             attempt is dubbed (the fixture's audio is English).
#   pack      MobLand (TMDB tv 247718) S01E02 with provider torrent: the session's torrent.file_index is the pack's
#             S01E02 file (phase 1's pack.json lists the files) and manifest_url ends in /f/<that index>.
# On a `verify.sh up --direct-stream` run (torrents off):
#   off       provider torrent answers 503 torrent_off and runs no resolve; a play without provider on a no_source
#             resolver answers 502 no_source whose attempts name no index and no torrent.
# No stage named: fallback named replay dubbed pack on a --torrent run, off otherwise. Ends with
# `torrent: PASS (<stages>)`; the first failed check stops it with `torrent: FAIL at <stage>`.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="$HERE/../verify.sh"
VERIFY_HOME="${VERIFY_HOME:-$HOME/.local/state/notesd-verify}"
RUN=${1:?usage: torrent.sh RUN [fallback|named|replay|dubbed|pack|off ...]}
shift
WANTED=("$@")
DIR="$VERIFY_HOME/$RUN"
DIRECT="$DIR/direct"
TOR="$DIR/torrent"
J="$DIR/torrent-journey"
[ -s "$DIRECT/upstream.json" ] || { echo "torrent: $RUN was not started with --direct-stream" >&2; exit 2; }
if [ ${#WANTED[@]} -eq 0 ]; then
  if [ -s "$TOR/index.port" ]; then WANTED=(fallback named replay dubbed pack); else WANTED=(off); fi
fi
ROOT="$(sed -n 's/^repo=//p' "$DIR/meta")"
URL="http://127.0.0.1:$(cat "$DIR/port")"
mkdir -p "$J"
STAGE=start
CODE=""
BODY=""

stage() { STAGE=$1; echo "== $STAGE"; }
ok() { echo "   ok  $*"; "$V" note "$RUN" "torrent journey $STAGE: $*"; }
fail() {
  echo "torrent: FAIL at $STAGE: $*" >&2
  "$V" note "$RUN" "torrent journey FAIL at $STAGE: $*" || true
  exit 1
}
# api METHOD PATH [JSON]: through verify.sh (evidence saved, same-origin Origin sent); sets CODE and BODY.
api() {
  local out
  out="$("$V" api "$RUN" "$@" 2>/dev/null)"
  CODE="$(sed -n 's/^< HTTP \([0-9]*\).*/\1/p' <<<"$out" | head -1)"
  BODY="$(sed '1,/^< HTTP /d' <<<"$out")"
}
# mcp TOOL JSON: through verify.sh (evidence saved); sets BODY to the tool's JSON answer.
mcp() {
  local out
  out="$(cd "$ROOT" && "$V" mcp "$RUN" "$1" "$2" 2>/dev/null || true)"
  BODY="$(sed '1d;/^< ERROR$/d' <<<"$out")"
}
calls_of() { if [ -f "$DIRECT/calls.jsonl" ]; then jq -s --arg v "$1" '[.[] | select(.args[0] == $v)] | length' "$DIRECT/calls.jsonl"; else echo 0; fi; }
index_asks() { if [ -f "$TOR/index.jsonl" ]; then wc -l <"$TOR/index.jsonl" | tr -d ' '; else echo 0; fi; }
need_torrent() { [ -s "$TOR/index.port" ] || fail "$RUN was not started with --torrent"; }
keep_sid() { echo "$1" >"$J/sid"; echo "$1" >>"$J/sids"; }
HASH() { jq -r .info_hash "$TOR/fixture.json"; }
peers() { curl -sS "$URL/api/stream/torrent/$(HASH)" | jq -r '.peers // 0'; }

for s in "${WANTED[@]}"; do
  case "$s" in
    fallback)
      stage fallback
      need_torrent
      echo no_source >"$DIRECT/mode"
      echo ok >"$TOR/index-mode"
      before=$(calls_of resolve)
      api POST /api/stream/play '{"kind":"movie","tmdb_id":467905}'
      [ "$CODE" = 200 ] || fail "play answered $CODE: $BODY"
      [ "$(jq -r .session.provider <<<"$BODY")" = Torrent ] || fail "provider is $(jq -r .session.provider <<<"$BODY")"
      [ "$(jq -r .session.torrent.info_hash <<<"$BODY")" = "$(HASH)" ] || fail "torrent is $(jq -c .session.torrent <<<"$BODY")"
      [[ "$(jq -r .session.manifest_url <<<"$BODY")" == "/api/stream/torrent/$(HASH)/f/"* ]] || fail "manifest_url is $(jq -r .session.manifest_url <<<"$BODY")"
      order="$(jq -r '[.attempts[] | (if (.provider | startswith("Index: ")) then "I" elif (.provider | startswith("Torrent: ")) then "T" else "C" end)] | join("")' <<<"$BODY")"
      [[ "$order" =~ ^C+I+T+$ ]] || fail "attempts are not cloud, then index, then torrent: $(jq -c '[.attempts[] | [.provider, .outcome]]' <<<"$BODY")"
      [ "$(jq -r '[.attempts[] | select(.provider | startswith("Torrent: "))][-1].outcome' <<<"$BODY")" = resolved ] || fail "the last torrent attempt did not resolve"
      [ "$(calls_of resolve)" = $((before + 1)) ] || fail "expected exactly one cloud resolve"
      keep_sid "$(jq -r .session.session_id <<<"$BODY")"
      ok "no_source fell through to the torrent $(HASH); attempts $order"
      ;;
    named)
      stage named
      need_torrent
      echo hls >"$DIRECT/mode"
      before=$(calls_of resolve)
      opens=$(calls_of open)
      mcp direct_stream_play '{"title":"movie-990002","provider":"torrent"}'
      [ "$(jq -r .started <<<"$BODY")" = true ] || fail "direct_stream_play did not start: $BODY"
      [ "$(jq -r .play.session.provider <<<"$BODY")" = Torrent ] || fail "provider is $(jq -r .play.session.provider <<<"$BODY")"
      [ "$(calls_of resolve)" = "$before" ] || fail "a cloud resolve ran for a play that named the torrent provider"
      [ "$(calls_of open)" = $((opens + 1)) ] || fail "the player page was not opened"
      sid="$(jq -r .play.session.session_id <<<"$BODY")"
      jq -e --arg sid "$sid" 'select(.args[0] == "open") | select(.args[1] | endswith("/stream/" + $sid))' "$DIRECT/calls.jsonl" >/dev/null || fail "no open named /stream/$sid"
      manifest="$(jq -r .play.session.manifest_url <<<"$BODY")"
      code="$(curl -sS -o "$J/range.bin" -w '%{http_code}' -H 'Range: bytes=0-99' "$URL$manifest")"
      [ "$code" = 206 ] && [ "$(wc -c <"$J/range.bin" | tr -d ' ')" = 100 ] || fail "bytes 0-99 of $manifest answered $code with $(wc -c <"$J/range.bin") bytes"
      keep_sid "$sid"
      ok "provider torrent played $manifest (206, 100 bytes), no resolve, the page opened"
      ;;
    replay)
      stage replay
      need_torrent
      for _ in $(seq 1 120); do [ "$(curl -sS "$URL/api/stream/torrent/$(HASH)" | jq -r .state)" = ready ] && break; sleep 1; done
      [ "$(curl -sS "$URL/api/stream/torrent/$(HASH)" | jq -r .state)" = ready ] || fail "the fixture is not whole on disk after 120 s"
      while read -r sid; do
        [ -n "$sid" ] && api POST "/api/stream/sessions/$sid/position" '{"position_s":5,"closed":true}'
      done <"$J/sids"
      for _ in $(seq 1 30); do [ "$(peers)" = 0 ] && break; sleep 1; done
      [ "$(peers)" = 0 ] || fail "the daemon still has $(peers) peer(s) of the fixture after every session closed"
      echo error >"$TOR/index-mode"
      echo no_source >"$DIRECT/mode"
      asks=$(index_asks)
      before=$(calls_of resolve)
      api POST /api/stream/play '{"kind":"movie","tmdb_id":467905}'
      [ "$CODE" = 200 ] || fail "the second play answered $CODE: $BODY"
      [ "$(jq '[.attempts[] | select(.provider | test("^(Index|Torrent): "))] | length' <<<"$BODY")" = 0 ] || fail "attempts name an index or a torrent: $(jq -c .attempts <<<"$BODY")"
      [ "$(jq -r .session.torrent.state <<<"$BODY")" = ready ] || fail "torrent is $(jq -c .session.torrent <<<"$BODY")"
      [ "$(index_asks)" = "$asks" ] || fail "an index was asked"
      [ "$(calls_of resolve)" = "$before" ] || fail "a cloud resolve ran"
      sleep 3
      [ "$(peers)" = 0 ] || fail "the replay joined the swarm ($(peers) peers)"
      grep -q "from the torrent .*from disk" "$DIR/daemon.log" || fail "the daemon's log has no 'from disk' play"
      keep_sid "$(jq -r .session.session_id <<<"$BODY")"
      echo ok >"$TOR/index-mode"
      ok "the second play came from disk: no index or torrent attempt, state ready, no index request, no resolve, no peer"
      ;;
    dubbed)
      stage dubbed
      need_torrent
      echo no_source >"$DIRECT/mode"
      echo ok >"$TOR/index-mode"
      api POST /api/stream/play '{"kind":"movie","tmdb_id":990004,"provider":"torrent"}'
      [ "$CODE" = 502 ] && [ "$(jq -r .error <<<"$BODY")" = no_source ] || fail "Oldboy answered $CODE: $BODY"
      [ "$(jq -r '[.attempts[] | select(.provider | startswith("Torrent: "))][0].outcome' <<<"$BODY")" = dubbed ] || fail "the torrent attempt is not dubbed: $(jq -c .attempts <<<"$BODY")"
      ok "Oldboy (ko): $(jq -r '[.attempts[] | select(.provider | startswith("Torrent: "))][0].detail' <<<"$BODY")"
      ;;
    pack)
      stage pack
      need_torrent
      [ -s "$TOR/pack.json" ] || fail "phase 1's --torrent mode wrote no pack.json"
      want="$(jq -r '[.files[] | select(.path | test("S01E02"; "i"))][0].index' "$TOR/pack.json")"
      api POST /api/stream/play '{"kind":"tv","tmdb_id":247718,"season":1,"episode":2,"provider":"torrent"}'
      [ "$CODE" = 200 ] || fail "MobLand S01E02 answered $CODE: $BODY"
      [ "$(jq -r .session.torrent.file_index <<<"$BODY")" = "$want" ] || fail "file_index is $(jq -r .session.torrent.file_index <<<"$BODY"), the S01E02 file is $want"
      [[ "$(jq -r .session.manifest_url <<<"$BODY")" == */f/"$want" ]] || fail "manifest_url is $(jq -r .session.manifest_url <<<"$BODY")"
      keep_sid "$(jq -r .session.session_id <<<"$BODY")"
      ok "the pack's S01E02 file (index $want) plays"
      ;;
    off)
      stage off
      [ ! -s "$TOR/index.port" ] || fail "$RUN is a --torrent run; off needs a plain --direct-stream run"
      before=$(calls_of resolve)
      api POST /api/stream/play '{"kind":"movie","tmdb_id":467905,"provider":"torrent"}'
      [ "$CODE" = 503 ] && [ "$(jq -r .error <<<"$BODY")" = torrent_off ] || fail "provider torrent answered $CODE: $BODY"
      [ "$(calls_of resolve)" = "$before" ] || fail "a resolve ran"
      echo no_source >"$DIRECT/mode"
      api POST /api/stream/play '{"kind":"movie","tmdb_id":467905}'
      [ "$CODE" = 502 ] && [ "$(jq -r .error <<<"$BODY")" = no_source ] || fail "the plain play answered $CODE: $BODY"
      [ "$(jq '[.attempts[] | select(.provider | test("^(Index|Torrent): "))] | length' <<<"$BODY")" = 0 ] || fail "attempts name an index or a torrent: $(jq -c .attempts <<<"$BODY")"
      ok "torrent_off, and no_source without any index or torrent attempt"
      ;;
    *) fail "unknown stage $s" ;;
  esac
done
echo "torrent: PASS (${WANTED[*]})"
"$V" note "$RUN" "torrent journey PASS (${WANTED[*]})"
```
**File:** `.claude/skills/verify-notesd/scripts/stream/torrent-play.steps.mjs` (new)
```js
// The real player page on a torrent session (torrent phase 3), on a `verify.sh up --web --torrent` run after
// `torrent.sh RUN named`:
//   SID=$(cat <run>/torrent-journey/sid) verify.sh ui RUN .claude/skills/verify-notesd/scripts/stream/torrent-play.steps.mjs
// Logs "TORRENT PAGE PASS" when the page plays (the video's time passes 2 s) from the torrent's file route
// (/api/stream/torrent/<hash>/f/<index>, answered 206) and fetched nothing through the pass-through. The first
// failed check throws.
function check(ok, what) {
  if (!ok) throw new Error(what)
}

export default async ({ page, base, shot, log }) => {
  const sid = process.env.SID
  check(sid, 'SID=<session id> is not set (torrent.sh RUN named writes it to <run>/torrent-journey/sid)')
  const res = await fetch(`${base}/api/stream/sessions/${sid}`)
  const info = await res.json().catch(() => null)
  check(res.status === 200 && info?.torrent, `the session answered ${res.status}: ${JSON.stringify(info)}`)
  check(info.manifest_url.startsWith(`/api/stream/torrent/${info.torrent.info_hash}/f/`), `manifest_url is ${info.manifest_url}`)
  const local = []
  const through = []
  page.on('response', (r) => {
    const u = new URL(r.url())
    if (u.pathname === info.manifest_url) local.push(r.status())
    if (/^\/api\/stream\/sessions\/[^/]+\/p$/.test(u.pathname)) through.push(u.pathname + u.search)
  })
  await page.goto(`${base}/stream/${sid}?muted=1`)
  await page.waitForFunction(() => {
    const v = document.querySelector('video')
    return v !== null && v.currentTime > 2
  }, null, { timeout: 60_000 })
  check(local.includes(206), `the file route answered ${local.join(', ') || 'nothing'}`)
  check(through.length === 0, `the page went through the pass-through: ${through.join(' ')}`)
  await page.locator('.st-stage').hover()
  await shot('torrent-page')
  log(`TORRENT PAGE PASS: ${info.torrent.name} plays from ${info.manifest_url} (${local.length} answers, ${local.filter((s) => s === 206).length} of them 206), none through the pass-through`)
}
```

### Step 15: The feature map
**File:** `.claude/skills/verify-notesd/features/direct-streaming.md` — new section before `## Gotchas`:
```markdown
## Playing from a torrent
- A play with `provider: "torrent"` (any case; `direct_stream_play`, `POST /api/stream/play`) asks only the torrent
  source; without a provider the order is the stream cache, a finished torrent download on this machine (no index, no
  swarm, no `Index:`/`Torrent:` attempt), the cloud providers, then on `no_source` or `resolve_failed` the torrent source. A torrent
  session: `provider: "Torrent"`, `manifest_kind: "mp4"`, `manifest_url` `/api/stream/torrent/<hash>/f/<index>`,
  `session.torrent` `{info_hash, file_index, name, index, state, seeds}`. Attempts after the cloud's:
  `Index: <name>` per index, `Torrent: <release>` per torrent (`resolved`, `no_stream`, `dubbed`, `unplayable`,
  `error`). The shuffle button moves to the next torrent; a `closed`/`ended` report, two idle minutes or the session's
  end release the torrent; reading the session again takes it back. `NOTESD_TORRENT=off`: 503 `torrent_off` for a
  named torrent play, everything else as before.
- Logic: `npx vitest run tests/unit/directStream/torrentProbe.test.ts tests/unit/directStream/torrentSource.test.ts tests/unit/directStream/torrentPlay.test.ts tests/unit/config.torrentFinder.test.ts tests/unit/mcp.directStreamTools.test.ts`.
- Finding a torrent (phase 2's finder, no route of its own): `npx vitest run tests/unit/directStream/torrent/find` over
  recorded index answers (dubs, cinema recordings and 3D left out, the seed floor, direct releases first, an episode or
  a pack that holds it, `bot_check`/`error` per index, every request sent as notesd).
- Throwaway daemon, a torrent run (`$V up --web --torrent`, note RUN): in this order,
  `.claude/skills/verify-notesd/scripts/direct-stream/torrent.sh RUN fallback named`, then
  `SID=$(cat ~/.local/state/notesd-verify/RUN/torrent-journey/sid) $V ui RUN .claude/skills/verify-notesd/scripts/stream/torrent-play.steps.mjs`
  (`TORRENT PAGE PASS`, screenshot `torrent-page`), then `torrent.sh RUN replay dubbed pack`. The fake index
  (`scripts/torrent/fake-index.mjs`, Torrentio-shaped, the finder's only index on a `--torrent` run) lists phase 1's
  loopback fixture(s) under a release name made of the asked title and year (from the fake TMDB's `tmdb.json`);
  `<run>/torrent/index-mode` switches it to `empty` or `error`, `<run>/torrent/candidates.json`
  (`[{info_hash, name, seeds?, size_bytes?}]`, `name` the release's tail after `<Title>.<Year>.`) replaces its answer
  for every query, and its requests are kept as `torrent-index-requests.jsonl` in the evidence.
- Torrents off (`$V up --direct-stream`): `torrent.sh RUN off`.
```

## Principles applied

- Laziness protocol: the subtitle chain ships as an empty list and a 15-line runner instead of a tier framework;
  replay from disk reuses phase 1's `find`/`filePath`/file route instead of a second record or a stream-cache entry;
  `sessionInfo` reuses the cache branch through `const local = torrent ?? cache` (both carry `manifestUrl` and
  `subtitles`) instead of a third copy of the subtitle mapping.
- Boundary discipline: ffprobe's JSON is validated once in `parseProbe`; the IMDb id is validated once in
  `TmdbClient.imdbId` (`/^tt\d{5,10}$/`) and trusted by the hook and `TorrentSource`; the finder's settings are
  parsed once in `parseTorrentFinder`, and unset ones are left `undefined` so the finder's defaults stay in one
  place (phase 2) instead of being copied into config.
- Make illegal states unrepresentable: a torrent session can only be made by `SessionStore.createTorrent`, which
  sets `cache: null`, so a session never holds both a cache and a torrent; `SessionTorrent.candidate: null` is what
  marks a replay from disk, so `hold` cannot reopen a swarm for it; `release` flips `held` once, so a session never
  releases a torrent twice (phase 1's `use`/`release` are counted).
- Test behavior, not implementation: `TorrentSource` and the service are tested through `resolve`/`fromDisk`/`next`
  and the real HTTP routes with fakes only at the swarm, finder and probe seams (what was opened, used, released,
  and what a caller reads), not by spying on private methods.
- Encode lessons in structure: the daemon cannot import `claude/streaming/direct/lang.mjs`, so `normalizeAudioLang`
  copies its table and `torrentProbe.test.ts` compares the two on a set of tags, so a language added to one and not
  the other fails `npm test` instead of silently skipping (or wrongly passing) a dub.
- Sequence into verifiable units: steps 1-3 each end in a test file that runs alone; step 6 ends in
  `torrentPlay.test.ts`; the harness steps end in journeys that can fail.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` (includes `tests/unit/docs/reference.test.ts`), then `npm run docs:check`
**Proof:** a throwaway daemon with phase 1's loopback fixture torrent, this phase's fake index and the fake resolver
plays a torrent session in the real player page, falls through to it on `no_source`, skips a dub, replays from disk,
and answers `torrent_off` with torrents off.
- Harness: `.claude/skills/verify-notesd` (`V=.claude/skills/verify-notesd/scripts/verify.sh`); torrent runs need
  phase 1's `up --torrent` (implies `--direct-stream`), `--web` so the page is this checkout's build.
- Feature-map entries: `features/direct-streaming.md` (the new "Playing from a torrent" section; the cloud play and
  "Playing from the cache" sections for the neighbor check)
- Journeys (RUN from `$V up --web --torrent`, RUN2 from `$V up --direct-stream`; run J1, J2, J3 in this order on RUN,
  then J4, J5, J6):
  - **J1** · traces R2.5 — `.claude/skills/verify-notesd/scripts/direct-stream/torrent.sh RUN fallback` → passes when it prints `ok  no_source fell through to the torrent <hash>` and the `POST /api/stream/play` evidence shows 200 with `session.provider: "Torrent"`, `session.torrent.info_hash` the fixture's, and `attempts` ordered cloud entries, then `Index: torrentio`, then `Torrent: How.to.Make.a.Killing.2026.720p.WEB-DL.x264.AAC-NOTESD` (the fake index names each release after the asked title, so the finder's title check keeps it) with outcome `resolved`
  - **J2** · traces R2.4 — `torrent.sh RUN named` then `SID=$(cat ~/.local/state/notesd-verify/RUN/torrent-journey/sid) $V ui RUN .claude/skills/verify-notesd/scripts/stream/torrent-play.steps.mjs` → passes when the MCP evidence shows `started: true`, `play.session.provider: "Torrent"`, `play.session.manifest_url` = `/api/stream/torrent/<hash>/f/<index>`, no new `resolve` line and one new `open` line naming `/stream/<sid>` in `direct/calls.jsonl`, `Range: bytes=0-99` on that URL answers 206 with 100 bytes, and the UI run logs `TORRENT PAGE PASS` (video time past 2 s, file route answered 206, nothing through `/p`) with screenshot `torrent-page`
  - **J3** · traces R2.9 — `torrent.sh RUN replay` → passes when it prints `ok  the second play came from disk`: the fixture's `GET /api/stream/torrent/<hash>` reads `state: "ready"` and `peers: 0` after the closed reports, the second play of TMDB movie 467905 answers 200 with no `Index: ` and no `Torrent: ` entry in `attempts` (only `Subtitles: <tier>` entries, none with this phase's empty chain) and `session.torrent.state: "ready"` while the fake index is set to HTTP 500, `torrent-index-requests` gains no line, `calls.jsonl` gains no `resolve`, `peers` stays 0, and `daemon.log` has `from the torrent ... from disk`
  - **J4** · traces R1.6 — `torrent.sh RUN dubbed` → passes when `POST /api/stream/play {"kind":"movie","tmdb_id":990004,"provider":"torrent"}` answers 502 `no_source` whose first `Torrent: ...` attempt has outcome `dubbed` and detail `its audio is en, not the original ko`
  - **J5** · traces R1.4 — `torrent.sh RUN pack` → passes when MobLand S01E02 with `provider: "torrent"` answers 200 with `session.torrent.file_index` equal to the index of the `S01E02` file in `<run>/torrent/pack.json` and `manifest_url` ending in `/f/<that index>`
  - **J6** · traces R2.6 — `torrent.sh RUN2 off` → passes when `provider: "torrent"` answers 503 `torrent_off` with no new `resolve` in `calls.jsonl`, and a plain play on the `no_source` fake answers 502 `no_source` whose `attempts` contain no `Index: ` or `Torrent: ` entry
- Neighbor check: a cloud play and a cache play must be untouched with torrents off — on RUN2,
  `.claude/skills/verify-notesd/scripts/direct-stream/journey.sh RUN2 seed hls refuse` ends without `FAIL`, and
  `.claude/skills/verify-notesd/scripts/direct-stream/cache-play.sh RUN2 ready` ends with `cache-play: PASS (ready)`;
  plus `npx vitest run tests/unit/directStream/cachePlay.test.ts tests/unit/directStream/sessions.test.ts` passes.
- Cost: none billed (fake resolver, fake index, fake TMDB, loopback swarm; no model call).
**Exit criteria:** `npm run typecheck`, `npm test` and `npm run docs:check` pass; J1-J6 pass on the throwaway daemons
and the neighbor check passes; `down` both runs.

## Handoffs

Reconciled against phases 1 and 2 as planned (they are the ground truth for their exports):

**From phase 1** (`TorrentStreams`, `AppDeps.torrents`, structurally assignable to this phase's `TorrentSwarm`):
- `open(pick: TorrentPick, { timeoutMs }) → Promise<TorrentHandle>` (phase 1's `TorrentPick { infoHash, trackers, name, ref, release? }`; `release` is the candidate's `ReleaseInfo`, stored nowhere). Idempotent per hash. A `ready` download of the same title answers a `DiskHandle` (`live: false`) without touching the engine.
- `use(infoHash, fileIndexes) → Promise<void>`, `release(infoHash) → Promise<void>` (counted; drops at once a torrent opened and never used; ignores an unknown hash).
- `find(ref) → Promise<TorrentDownload | null>` (camelCase: `infoHash, host, name, release, fileIndex, fileLength, state, durationS`; only rows with a chosen video, ready ones first).
- `filePath(infoHash, index) → Promise<string | null>`, `localUrl(infoHash, index)`, `setDuration(infoHash, seconds)` (called after every probe, so `/map` answers seconds for phase 4).
- The file route answers 409 `not_in_swarm` for an unfinished download nothing holds (it never rejoins a swarm by itself). This phase reads a file only while it holds the torrent, or a `ready` download from disk; a page that comes back takes the torrent again first (`info`, `refresh`).
- `down_kbps` is kilobits per second.
- Harness: `verify.sh up --torrent` (flag variable `torrent`) writes `<run>/torrent/fixture.json` and `pack.json` (`{info_hash, name, trackers: [], port, piece_length, files}`); trackers are always empty, discovery is off and every torrent gets the seeder from `NOTESD_TORRENT_PEERS`, so the fake index hands out any tracker list. The film's audio is tagged `eng` and lasts 120 s; the pack's episodes are `Fixture.Show.S01E01...mp4`, `...S01E02...mp4`. Its seeder also seeds every folder copied into `<run>/torrent/seed/<name>/` and writes `<run>/torrent/seeded/<name>.json` (same shape), which phases 5, 6 and 8 use.

**From phase 2** (`src/directStream/torrent/find/index.js`):
- `findCandidates(query: TorrentQuery, options: FindOptions) → Promise<FoundCandidates>` (`{ candidates, indexes: IndexAttempt[] { index, outcome, detail, took_s, listed }, excluded }`). `TorrentQuery` is a union: a `tv` query must carry `season` and `episode`. This phase passes `imdbId`, `title`, `originalTitle`, `year` and `originalLanguage` (the finder's title check needs them; phase 9's sites have no IMDb search). Settings map onto `minSeeds`, `maxSizeBytes`, `timeoutMs`, `bases`, `yts`, `indexes` (the default list minus the ones set `off`) and `fallback`.
- `pickFile(files, query) → { video, subtitles } | null`, `TorrentCandidate` (`infoHash, name, fileName, fileIdx, seeds, sizeBytes, index, listedBy, site, trackers, scoped, release`). Index names are lower case (`torrentio`, `apibay`, `eztv`, `yts`; phase 9 `1337x`, `ext`), so an attempt reads `Index: torrentio`.

**Left for later phases:**
- Phase 4 (R2.7): `SessionInfo.torrent` is `{ info_hash, file_index, name, index, state, seeds }` (`index`, `seeds` null on a replay); `switchSource` answers `from: "Torrent: <release>"`; the page turns its own automatic stall move off for a torrent session.
- Phase 5 (R2.8): replaces the `unplayable` branch of `refusalOf` for a file ffmpeg can remux, and adds `remux` to `TorrentSourceOptions` and to `buildTorrentSource`'s wiring (`src/daemon.ts`, one line in the wiring object).
- Phase 6 (R3.1-R3.3): inserts `kept`, `files`, `service`, `borrow` at the marked comments of `buildSubtitleTiers` and adds its fields to `SubtitleTierDeps` and to the `tiers` deps object in `src/daemon.ts`; R3.2 reorders `candidates` at the marked line of `resolve`. It must not change `SubtitleContext`, `SubtitleTier` or `runSubtitleChain` (this phase's, one name per fact).
- Phase 7 (R3.4, R3.5) inserts `embedded` after `files`; phase 8 (R3.6) inserts `whisper` last. Both are growing tiers (`blocks: false`): they answer at once and stop their work when `ctx.signal` aborts.
- Phase 9 (R1.7): passes `fallback` through `buildTorrentSource`'s wiring (`src/daemon.ts`, one line); the query already carries `title` and `year`.
- `TorrentSource.resolve` never runs inside `DirectStreamService.serial()` (phase 6's borrow tier calls `subtitleText`, which queues on it): `torrentSession` calls it after the cloud resolve has returned.
- R2.3 (phase 1's criterion) is only fully met with this phase's releases: a session lets go of its torrent on a
  `closed`/`ended` report, on the shuffle button, after `TORRENT_IDLE_MS` without a request and when the store drops
  it. Phase 1's proof of "leaves the swarm" can use J3's `peers: 0` read.

## Rollback

Revert this phase's merge. Nothing persistent is written by it (no table, no migration; phase 1's `stream_torrents`
rows stay valid). Without a revert, `NOTESD_TORRENT=off` turns every branch of this phase off: `buildTorrentSource`
answers null, `play` resolves as before and a named torrent play answers `torrent_off`.
