# Phase 2: Resolve probe campaign: 24 providers, failures, episodes, token lifetime

**Plan set:** `DIRECT_STREAMING_PLAN.md`
**Analysis:** `.workflows/analyze/20261115-182932-Z85Y_code_analyzer.md`
**Satisfies:** R7 — the brief's untested list becomes measured work, not assumptions (the resolve half: the other 18 providers, why three returned nothing, series episodes, token lifetime)
**Criteria:** R7.1, R7.2
**Depends on:** Phase 1
**Difficulty:** HARD
**Package:** `claude/streaming/direct`

---

## Goal

After this phase there is one re-runnable command, `claude/streaming/direct/campaign.mjs`, that
probes every seed provider through phase 1's resolver against three known titles, names why each
failing provider fails, finds the episode template of each provider that serves a series, and
measures how long a captured manifest keeps answering. Its output fills
`docs/plans/2026-11-15-direct-streaming-findings.md` (generated tables plus a machine-readable
timings block for phase 10) and the seed's `tv`, `en_subtitle`, `browser_only` and `notes`
fields. The phase session runs it once, live, against the owner's streaming Chrome: nothing is
shown and nothing plays with sound.

The phase has two halves, kept apart in this plan:

| Half | What | Where |
| --- | --- | --- |
| Deterministic (Steps 1–5) | `campaign.mjs`, its unit test with a fake sniffer and fake fetch, the findings template, the sniffer's read-only `-Inspect` switch | committed code, proven by `npm test` |
| Live (Step 6) | the run on the owner's laptop, reading the raw results, any sniffer fix a finding demands, the hand-written sections, `apply-seed` | committed data (findings file, seed), proven by `campaign.mjs check` |

## Interface Contract

**Deletes:** none
**Renames:** none
**Creates:**
- `claude/streaming/direct/known-titles.json` (**reconciler:** the one known-titles file, shape `[{ label, kind: "movie" | "tv", tmdb_id, season?, episode? }]`: Fight Club 550, Sinners 1233413, Breaking Bad S02E03; phase 8 reads it too).
- `claude/streaming/direct/campaign.mjs` with the CLI commands `run`, `lifetime`, `lifetime-status`, `report`, `apply-seed`, `check`, and the exports `KNOWN_TITLES_FILE`, `loadTitles`, `TITLES` (loaded from that file), `CONTROL_EPISODE`, `SPIKE_SILENT`, `LONG_SNIFF`, `CAUSES`, `LIFETIME_SCHEDULE_MIN`, `CampaignAbort`, `isEnglish`, `readManifest`, `requestHeaders`, `evidenceOf`, `diagnose`, `episodeTemplates`, `runCampaign`, `claimedExpiry`, `firstUri`, `checkStream`, `watchLifetime`, `lifetimeReport`, `percentile`, `timings`, `mergeResults`, `replaceBlock`, `readBlock`, `renderFindings`, `applySeed`, `checkFindings`, `main`.
- `docs/plans/2026-11-15-direct-streaming-findings.md` with generated blocks delimited by `<!-- campaign:<name>:begin -->` / `<!-- campaign:<name>:end -->` for `providers`, `diagnosis`, `episodes`, `lifetime`, `timings`, and a `## Playback` heading left for phase 6.
- The timings block schema (read by phase 10): a fenced `json` object `{ schema: 1, measured_at, host, long_sniff_seconds, resolve_s: { n, p50, p90, max }, fail_s: { n, p50, p90, max }, providers: { <name>: { tried, resolved, median_s, max_s, fail_median_s, cause, en_subtitle, episodes } }, token_lifetime: { provider, started_at, claimed_minutes, last_ok_min, first_failure_min, finished } | null }`.
- `tests/unit/scripts/directCampaign.test.ts`.

**Signature changes:**
- `sniffEmbed(url, options)` (phase 1, `sniff.mjs`): `options` gains `inspect: boolean` (default false). With it the result gains `inspect: Array<{ url, title, text, videos: [{ src, ready_state, paused, current_time, muted }], iframes }>` (root page first, then each cross-origin frame); without it `inspect` is absent or `null`. Every other field is unchanged.
- `sniff.ps1` (phase 1) gains the `[switch]$Inspect` parameter. It only reads the DOM; it clicks nothing and starts nothing.

**Requires (from earlier phases):** all from phase 1, planned against the index's Shared contracts because phase 1's files do not exist yet:
- `resolve.mjs` exports `resolveTitle(ref, { providers, health, sniff })`; `ref` is `{ kind: 'movie' | 'tv', tmdbId, season, episode }`; it fills `{id}`, `{season}`, `{episode}` into the provider's `movie` / `tv` template, calls `sniff(url, options)` once per provider it tries, never mutates the providers it is given, and returns the CLI JSON shape (`ok`, `source` with `manifest_url`, `manifest_kind`, `headers.{referer,origin,user_agent}`, `subtitles[{url,lang,label,format}]`, `best_height`, `took_s`; `attempts[{provider,outcome,took_s,detail}]`; `error` when `ok: false`). An empty `health` (`{}`) is accepted. A provider with `browser_only: true` is skipped, so the campaign passes copies with `browser_only: false`.
- A sniff that fails to reach Chrome surfaces as either a thrown error whose `code` or message starts with `no_chrome` / `chrome_not_reachable`, a result `error` with that code, or an attempt `detail` starting with it. The campaign handles all three.
- `sniff.mjs` exports `sniffEmbed(url, options)` returning the spike's JSON shape (`url, took_s, requests, clicks, popups_closed, frames: ["<type> <url>"], hosts: ["<host> <count>"], hits[]`) plus `user_agent` and `bot_check`; `options.seconds` maps to `sniff.ps1 -Seconds`. If phase 1 named the option differently, the reconciler renames `LONG_SNIFF.seconds` here.
- `sniff.ps1` and `sniff.mjs` as phase 1's plan writes them (Steps 2 and 3 of `phase-1.md`): `Send-Cdp`, `Wait-Reply($id, $timeoutMs)`, `$pageSessions` (the tab's session first, then every attached page or frame), the media-state block before `Close-Tab`, and the final `Write-Output ([ordered]@{ ... } | ConvertTo-Json -Depth 6 -Compress)`; `sniffEmbed` builds `args` and returns `parseSniffReply(stdout)`. Steps 4 and 5 quote those lines.
- `providers.seed.json` is the 24 fmovies entries in the analysis's order with the analysis's names (`VidNest` … `MovieVault`; `CloudPlay` is `vidsrc.cc`, `VidSrc` is `vidsrc.me`), templates using `{id}`, `tv: null`, `browser_only: false`, `en_subtitle: null`, `notes: ""`.
- Phase 1's tests assert the seed's shape and count, not the values of `tv`, `en_subtitle`, `browser_only` or `notes`, which this phase fills.

**Leaves alone (owned by others):** `src/**`, `web/**` (phases 3–5, 7–10); `order.mjs`, `resolve.mjs`, `cli.mjs` (phase 1; imported, not edited); the existing `claude/streaming/{cli,cdp.ps1,chrome,play,match}.mjs` and `sites/`; the findings file's `## Playback` section and `playcheck.mjs` (phase 6); `templates.mjs` (phase 8); `docs/guide/**` (no guide section is this phase's); `.claude/skills/verify-notesd/features/**` (nothing user-facing changes).

## Files

| File | Action | What changes |
|---|---|---|
| `claude/streaming/direct/known-titles.json` | create | the known titles (shared with phase 8) |
| `claude/streaming/direct/campaign.mjs` | create | the campaign: probing, diagnosis, episode templates, token lifetime watcher, findings writer, seed writer, checker; titles from `known-titles.json` |
| `tests/unit/scripts/directCampaign.test.ts` | create | unit tests with a fake sniffer and a fake fetch, through phase 1's real `resolveTitle` |
| `docs/plans/2026-11-15-direct-streaming-findings.md` | create | the full template (Step 3); the live run fills its generated blocks and hand sections (Step 6) |
| `claude/streaming/direct/sniff.ps1` | modify (after phase 1) | `-Inspect` switch: read the DOM of phase 1's `$pageSessions` (the tab, then each attached frame) before the tab closes, add `inspect` to the output |
| `claude/streaming/direct/sniff.mjs` | modify (after phase 1) | pass `-Inspect` when `options.inspect`, return `inspect` from `parseSniffReply` |
| `claude/streaming/direct/providers.seed.json` | modify (live, by `apply-seed`) | `tv`, `en_subtitle`, `browser_only`, `notes` from the measured results |

## Implementation Steps

### Step 1: The campaign script
**File:** `claude/streaming/direct/campaign.mjs:1` (new file)
**Change:** One module that is both the CLI and the library the unit test imports. It never reads an
environment variable (the docs check would then demand a configuration row), never opens a window
and never plays anything: every Chrome contact goes through phase 1's `sniffEmbed`, every stream
contact is a plain `fetch` from WSL with the headers the real Chrome sent (invariant 3).

How each part works:

- **Probing.** `probe` calls phase 1's `resolveTitle` with a one-provider list and a recording
  wrapper around the sniffer, so the outcome is classified exactly as the daemon will classify it
  and the raw sniff (requests, frames, hosts, clicks, inspect) is kept for diagnosis. A resolved
  source's manifest is fetched once from Node with the captured headers: that gives the subtitle
  tracks and heights inside the manifest (`#EXT-X-MEDIA:TYPE=SUBTITLES`, `RESOLUTION=`, DASH
  `AdaptationSet` / `height=`), and `node_fetch_status` says whether the pass-through approach works
  for that provider.
- **Titles.** Fight Club (movie 550), Sinners (movie 1233413, 2025), Breaking Bad S02E03 (tv
  1396), read from `claude/streaming/direct/known-titles.json` (the one list of known titles; phase
  8's `/update-cloud-source` probes read the same file). S01E99 is the control: Breaking Bad's first season has seven episodes, so a template that
  also "resolves" S01E99 ignores the episode and is rejected (`ignores_episode`). `--recent` and
  `--series` override the titles.
- **Diagnosis** (the named causes, checked in this order by `diagnose`):

  | Cause | Named when |
  | --- | --- |
  | `bot_check` | the resolver's outcome was `bot_check`, or the sniff's `bot_check` flag was set |
  | `error` | every run of the provider errored (the sniff or PowerShell failed; `detail` says how) |
  | `unreachable` | every run saw at most one request: the embed host did not answer |
  | `not_found` | the recent film resolved but Fight Club did not, or a frame's text says not found / no sources / unavailable / 404 |
  | `blob_media` | a `<video>` plays from a `blob:` address (MSE) and no manifest the sniffer recognises was requested |
  | `frame_not_attached` | the page has iframes but the sniffer attached to none of them |
  | `click_missed` | a `<video>` or player frame exists, nothing started, and the sniffer's clicks did not start it |
  | `no_player` | no video element and no player frame in any frame the sniffer could read |
  | `undiagnosed` | no inspection was run (`--no-diagnose`); `check` rejects it |

  Notes on a resolved provider: `slow_start` (only the 90 s sniff resolved), `needed_click` (the
  stream came after the sniffer clicked), `not_reproduced` (one of the spike's three silent
  providers resolves now).
- **The long sniff.** Every provider that does not resolve Fight Club, and Videasy, VidKing and
  CloudPlay always, get a second sniff with `{ seconds: 90, inspect: true }`.
- **Episodes.** `episodeTemplates(movieTemplate)` derives candidates from the film template
  (`/movie/` → `/tv/`, or `type=movie` → `type=tv`, then `/{season}/{episode}`,
  `?season={season}&episode={episode}`, `-{season}-{episode}`, or `s={season}&e={episode}` for
  query ids). Up to `--candidates` (default 3) are tried in order, only for providers that resolved
  a film; the first that resolves S02E03 and fails S01E99 is the provider's episode template.
- **Token lifetime, bounded.** `lifetime` resolves one manifest (VidFast, Fight Club by default),
  then re-requests the master playlist, its first variant and that variant's first segment
  (`Range: bytes=0-1023`) from Node with the captured headers at minutes 0, 2, 5, 10, 20, 40, 60,
  90, 120, 180, 240, 300, 360, 420 (capped by `--max-min`, default 420). A failure is retried once
  after 30 s, then ends the watch. Each check is one JSON line in the log, so the watch runs
  detached (`setsid nohup`) and the phase session reads it whenever it likes: the session never
  waits on it beyond the T+60 check (Step 6). The claimed expiry is read from the address (a
  10- or 13-digit epoch in a query value, a path segment, a base64url segment, or a JWT's `exp`).
- **Findings.** `report` (and `run` when it probed the whole seed or `--findings` is given)
  replaces only the content between the `campaign:<name>` markers; hand-written text outside them
  survives. `report` accepts several results files and merges them by provider (later wins), so a
  `run --only <name>` after a sniffer fix updates one row. Without `--lifetime`, the existing
  lifetime block and the timings' `token_lifetime` are kept.
- **Raw results stay out of git.** Manifest addresses carry tokens, so `results.json` and the
  lifetime log go to `~/.local/state/notesd-direct-campaign/`; the findings carry hosts, kinds,
  heights, seconds and templates only.

**File:** `claude/streaming/direct/known-titles.json` (new; created first, read by `loadTitles`
below and by phase 8's `loadKnownTitles`):
```json
[
  { "label": "Fight Club (1999)", "kind": "movie", "tmdb_id": 550 },
  { "label": "Sinners (2025)", "kind": "movie", "tmdb_id": 1233413 },
  { "label": "Breaking Bad S02E03", "kind": "tv", "tmdb_id": 1396, "season": 2, "episode": 3 }
]
```
**Code:**
```js
#!/usr/bin/env node
// The resolve probe campaign for direct streaming. It probes every seed provider through the same
// resolver the daemon uses, against known titles, names why a provider fails, looks for each
// provider's episode address, measures how long a captured manifest keeps answering, and writes
// the tables of docs/plans/2026-11-15-direct-streaming-findings.md. Resolving only: the streaming
// Chrome stays minimized, nothing is shown and nothing plays with sound.
//
// Usage:
//   campaign.mjs run [--only A,B] [--recent <tmdbId>] [--series <tmdbId>:<season>:<episode>]
//                    [--candidates <n>] [--no-diagnose] [--no-episodes] [--out <dir>]
//                    [--findings <file>] [--seed <file>]
//   campaign.mjs lifetime [--log <file.jsonl>] [--provider VidFast] [--tmdb 550] [--max-min 420]
//   campaign.mjs lifetime-status <file.jsonl>
//   campaign.mjs report <results.json>... [--lifetime <file.jsonl>] [--findings <file>]
//   campaign.mjs apply-seed <results.json>... [--seed <file>]
//   campaign.mjs check [--findings <file>] [--seed <file>]
// Prints one JSON object on stdout; progress goes to stderr.
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveTitle } from './resolve.mjs';
import { sniffEmbed } from './sniff.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SEED_FILE = path.join(HERE, 'providers.seed.json');
export const FINDINGS_FILE = path.resolve(HERE, '../../../docs/plans/2026-11-15-direct-streaming-findings.md');
const STATE_DIR = path.join(os.homedir(), '.local', 'state', 'notesd-direct-campaign');

/**
 * The known titles, one file shared with /update-cloud-source's probes (phase 8 reads the same
 * file): `[{ label, kind, tmdb_id, season?, episode? }]`. The first film is the control film, the
 * second the recent one, the first episode the series.
 */
export const KNOWN_TITLES_FILE = path.join(HERE, 'known-titles.json');

export function loadTitles(file = KNOWN_TITLES_FILE) {
  const rows = JSON.parse(readFileSync(file, 'utf8'));
  const films = rows.filter((r) => r.kind === 'movie');
  const series = rows.find((r) => r.kind === 'tv' && Number.isInteger(r.season) && Number.isInteger(r.episode));
  if (films.length < 2 || series === undefined) throw new Error(`${file}: needs two films and one episode`);
  const ref = (r) => ({ kind: r.kind, tmdbId: r.tmdb_id, season: r.season ?? null, episode: r.episode ?? null, label: r.label });
  return { film: ref(films[0]), recent: ref(films[1]), episode: ref(series) };
}

export const TITLES = loadTitles();
// An episode the series does not have (its first season has seven): a template that still
// resolves it ignores the episode it is given.
export const CONTROL_EPISODE = { season: 1, episode: 99 };
// The spike saw nothing from these in 35 s; they always get the long, inspected sniff.
export const SPIKE_SILENT = ['Videasy', 'VidKing', 'CloudPlay'];
export const LONG_SNIFF = { seconds: 90, inspect: true };
// The named causes of a failure, in the order diagnose() checks them.
export const CAUSES = ['bot_check', 'error', 'unreachable', 'not_found', 'blob_media', 'frame_not_attached', 'click_missed', 'no_player'];
export const LIFETIME_SCHEDULE_MIN = [0, 2, 5, 10, 20, 40, 60, 90, 120, 180, 240, 300, 360, 420];
const CHROME_DOWN = ['no_chrome', 'chrome_not_reachable'];
const NOT_FOUND_TEXT = /\b(not found|no sources?|unavailable|could not be found|does ?n[o']t exist|404)\b/i;
const RETRY_MS = 30_000;

/** The streaming Chrome is not there: no provider result would mean anything, so the run stops. */
export class CampaignAbort extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};
const chromeDown = (text) => CHROME_DOWN.find((code) => String(text ?? '').startsWith(code)) ?? null;
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const readJsonl = (file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
const tilde = (file) => (file.startsWith(os.homedir()) ? `~${file.slice(os.homedir().length)}` : file);
const stamp = (date) => date.toISOString().replace(/[:.]/g, '-');
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A subtitle track (or a bare language / name) that is English. */
export function isEnglish(track) {
  const lang = typeof track === 'string' ? track : String(track?.lang ?? '');
  const label = typeof track === 'string' ? track : String(track?.label ?? '');
  return /^(en|eng)([-_].*)?$/i.test(lang.trim()) || /english/i.test(label);
}

/** The heights and subtitle languages a manifest names (HLS master or DASH MPD). */
export function readManifest(text, kind) {
  const heights = new Set();
  const langs = [];
  if (kind === 'dash') {
    for (const m of text.matchAll(/\bheight="(\d+)"/g)) heights.add(Number(m[1]));
    for (const m of text.matchAll(/<AdaptationSet\b[^>]*>/g)) {
      if (/contentType="text"|mimeType="(text\/vtt|application\/ttml\+xml)"/.test(m[0])) {
        langs.push(/\blang="([^"]+)"/.exec(m[0])?.[1] ?? '?');
      }
    }
  } else {
    for (const m of text.matchAll(/RESOLUTION=\d+x(\d+)/g)) heights.add(Number(m[1]));
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('#EXT-X-MEDIA:') || !/TYPE=SUBTITLES/.test(line)) continue;
      langs.push(/LANGUAGE="([^"]+)"/.exec(line)?.[1] ?? /NAME="([^"]+)"/.exec(line)?.[1] ?? '?');
    }
  }
  return { heights: [...heights].sort((a, b) => b - a), subtitle_langs: langs };
}

/** The headers the real Chrome's manifest request carried, as fetch() wants them. Nothing invented. */
export function requestHeaders(headers = {}) {
  const out = {};
  if (headers.referer) out.referer = headers.referer;
  if (headers.origin) out.origin = headers.origin;
  if (headers.user_agent) out['user-agent'] = headers.user_agent;
  return out;
}

function inspectSummary(reports) {
  if (!Array.isArray(reports)) return null;
  const videos = reports.flatMap((report) => (Array.isArray(report?.videos) ? report.videos : []));
  const root = reports[0] ?? {};
  return {
    videos: videos.length,
    blob_videos: videos.filter((v) => String(v.src ?? '').startsWith('blob:') && Number(v.ready_state ?? 0) >= 1).length,
    started_videos: videos.filter((v) => Number(v.current_time ?? 0) > 0).length,
    root_iframes: Number(root.iframes ?? 0),
    title: String(root.title ?? '').slice(0, 80),
    text: reports
      .map((report) => String(report?.text ?? ''))
      .filter(Boolean)
      .join(' | ')
      .slice(0, 200),
  };
}

/** What a sniff saw, cut to what diagnosis and the findings need. No tokenized address. */
export function evidenceOf(raw) {
  if (!raw) return null;
  const frames = (Array.isArray(raw.frames) ? raw.frames : []).map(String).filter((f) => f.startsWith('iframe '));
  return {
    requests: Number(raw.requests ?? 0),
    frames: frames.length,
    frame_hosts: [...new Set(frames.map((f) => hostOf(f.slice('iframe '.length))).filter(Boolean))],
    hosts: Array.isArray(raw.hosts) ? raw.hosts.slice(0, 6).map(String) : [],
    clicks: Number(raw.clicks ?? 0),
    popups_closed: Number(raw.popups_closed ?? 0),
    bot_check: raw.bot_check === true,
    took_s: typeof raw.took_s === 'number' ? raw.took_s : null,
    inspect: inspectSummary(raw.inspect),
  };
}

// One provider, one title, through the resolver the daemon uses. The raw sniff is kept.
async function probe(provider, ref, sniff, extra = {}) {
  const raws = [];
  const recording = async (url, options = {}) => {
    const raw = await sniff(url, { ...options, ...extra });
    raws.push(raw);
    return raw;
  };
  let result;
  try {
    result = await resolveTitle(ref, { providers: [{ ...provider, browser_only: false }], health: {}, sniff: recording });
  } catch (err) {
    const down = CHROME_DOWN.includes(err?.code) ? err.code : chromeDown(err?.message);
    if (down) throw new CampaignAbort(down, String(err?.message ?? err));
    const detail = String(err?.message ?? err).slice(0, 200);
    return { ok: false, source: null, attempt: { provider: provider.name, outcome: 'error', took_s: null, detail }, raw: raws.at(-1) ?? null };
  }
  const attempt = result?.attempts?.[0] ?? null;
  const down = CHROME_DOWN.includes(result?.error) ? result.error : chromeDown(attempt?.detail);
  if (down) throw new CampaignAbort(down, String(attempt?.detail ?? ''));
  return { ok: result?.ok === true && Boolean(result.source), source: result?.source ?? null, attempt, raw: raws.at(-1) ?? null };
}

async function checkManifest(source, fetchImpl) {
  try {
    const res = await fetchImpl(source.manifest_url, { headers: requestHeaders(source.headers) });
    const text = await res.text();
    return { status: res.status, ...readManifest(text, source.manifest_kind) };
  } catch (err) {
    return { status: `error: ${String(err?.message ?? err).slice(0, 80)}`, heights: [], subtitle_langs: [] };
  }
}

async function probeSummary(provider, ref, sniff, fetchImpl, extra = {}) {
  const { ok, source, attempt, raw } = await probe(provider, ref, sniff, extra);
  const summary = {
    outcome: ok ? 'resolved' : String(attempt?.outcome ?? 'error'),
    detail: String(attempt?.detail ?? ''),
    took_s: ok ? source.took_s ?? attempt?.took_s ?? null : attempt?.took_s ?? raw?.took_s ?? null,
    manifest_kind: null,
    manifest_host: null,
    best_height: null,
    subtitle_langs: [],
    en_subtitle: null,
    node_fetch_status: null,
    needed_click: Number(raw?.clicks ?? 0) > 0,
    evidence: evidenceOf(raw),
    raw,
  };
  if (ok) {
    const manifest = await checkManifest(source, fetchImpl);
    const tracks = Array.isArray(source.subtitles) ? source.subtitles : [];
    summary.manifest_kind = source.manifest_kind;
    summary.manifest_host = hostOf(source.manifest_url);
    summary.best_height = Math.max(Number(source.best_height ?? 0), manifest.heights[0] ?? 0) || null;
    summary.subtitle_langs = [...tracks.map((t) => t.lang || t.label || '?'), ...manifest.subtitle_langs];
    summary.en_subtitle = tracks.some(isEnglish) || manifest.subtitle_langs.some(isEnglish);
    summary.node_fetch_status = manifest.status;
  }
  return summary;
}

/**
 * Why a provider did not resolve Fight Club, by name. `standard` is the resolver's own sniff,
 * `long` the 90 s inspected one, `other` the recent film. `cause` is null when Fight Club resolved.
 */
export function diagnose({ name, standard, long = null, other = null }) {
  if (standard.outcome === 'resolved') {
    const note = SPIKE_SILENT.includes(name) ? 'not_reproduced' : standard.needed_click ? 'needed_click' : '';
    return { cause: null, note };
  }
  if (long?.outcome === 'resolved') return { cause: null, note: 'slow_start' };
  const runs = [standard, long].filter(Boolean);
  const evidence = runs.map((run) => run.evidence).filter(Boolean);
  const fail = (cause) => ({ cause, note: '' });
  if (runs.some((run) => run.outcome === 'bot_check') || evidence.some((e) => e.bot_check)) return fail('bot_check');
  if (runs.every((run) => run.outcome === 'error')) return fail('error');
  if (evidence.length > 0 && evidence.every((e) => e.requests <= 1)) return fail('unreachable');
  if (other?.outcome === 'resolved' || evidence.some((e) => NOT_FOUND_TEXT.test(e.inspect?.text ?? ''))) return fail('not_found');
  const seen = long?.evidence?.inspect ?? standard.evidence?.inspect ?? null;
  if (!seen) return fail('undiagnosed');
  if (seen.blob_videos > 0) return fail('blob_media');
  if (seen.root_iframes > 0 && evidence.every((e) => e.frames === 0)) return fail('frame_not_attached');
  if (seen.videos > 0 || seen.root_iframes > 0) return fail('click_missed');
  return fail('no_player');
}

/** Candidate episode templates for a film template, most likely first. [] when there is no film marker. */
export function episodeTemplates(movieTemplate) {
  const at = movieTemplate.indexOf('?');
  let pathPart = at === -1 ? movieTemplate : movieTemplate.slice(0, at);
  let query = at === -1 ? '' : movieTemplate.slice(at + 1);
  if (/\/movie(\/|$)/.test(pathPart)) pathPart = pathPart.replace(/\/movie(\/|$)/, '/tv$1');
  else if (/(^|&)type=movie(&|$)/.test(query)) query = query.replace(/(^|&)type=movie(&|$)/, '$1type=tv$2');
  else return [];
  const join = (p, q) => (q ? `${p}?${q}` : p);
  const add = (q, extra) => (q ? `${q}&${extra}` : extra);
  const out = [];
  if (pathPart.includes('{id}')) {
    const end = pathPart.indexOf('{id}') + '{id}'.length;
    const before = pathPart.slice(0, end);
    const after = pathPart.slice(end);
    out.push(join(`${before}/{season}/{episode}${after}`, query));
    out.push(join(`${before}${after}`, add(query, 'season={season}&episode={episode}')));
    out.push(join(`${before}-{season}-{episode}${after}`, query));
  } else if (query.includes('{id}')) {
    out.push(join(pathPart, add(query, 'season={season}&episode={episode}')));
    out.push(join(pathPart, add(query, 's={season}&e={episode}')));
  }
  return [...new Set(out)];
}

async function findEpisode(provider, sniff, fetchImpl, { ref, candidates, log }) {
  const tried = [];
  for (const template of episodeTemplates(provider.movie).slice(0, candidates)) {
    const withTv = { ...provider, tv: template };
    log(`${provider.name}: ${ref.label} via ${template}`);
    const summary = await probeSummary(withTv, ref, sniff, fetchImpl);
    if (summary.outcome !== 'resolved') {
      tried.push({ template, outcome: summary.outcome, control: null });
      continue;
    }
    const control = await probeSummary(withTv, { ...ref, ...CONTROL_EPISODE }, sniff, fetchImpl);
    if (control.outcome === 'resolved') {
      tried.push({ template, outcome: 'ignores_episode', control: 'resolved' });
      continue;
    }
    tried.push({ template, outcome: 'resolved', control: control.outcome });
    return { template, summary, control_outcome: control.outcome, tried, skipped: '' };
  }
  return { template: null, summary: null, control_outcome: null, tried, skipped: '' };
}

/**
 * Probes every provider against the titles. `sniff` is phase 1's sniffEmbed (a fake in tests),
 * `fetchImpl` reads a resolved manifest from WSL. `onRow` gets the results so far after each
 * provider, so a long run that dies keeps what it measured.
 */
export async function runCampaign({
  providers,
  sniff,
  fetchImpl,
  titles = TITLES,
  diagnoseFailures = true,
  episodes = true,
  candidates = 3,
  now = () => new Date(),
  host = os.hostname(),
  log = () => {},
  onRow = () => {},
}) {
  const results = { schema: 1, measured_at: now().toISOString(), host, titles, long_sniff_seconds: LONG_SNIFF.seconds, rows: [] };
  for (const provider of providers) {
    log(`${provider.name}: ${titles.film.label}`);
    const film = await probeSummary(provider, titles.film, sniff, fetchImpl);
    log(`${provider.name}: ${titles.recent.label}`);
    const recent = await probeSummary(provider, titles.recent, sniff, fetchImpl);
    let long = null;
    if (diagnoseFailures && (film.outcome !== 'resolved' || SPIKE_SILENT.includes(provider.name))) {
      log(`${provider.name}: ${titles.film.label}, ${LONG_SNIFF.seconds} s, inspected`);
      long = await probeSummary(provider, titles.film, sniff, fetchImpl, LONG_SNIFF);
    }
    const verdict = diagnose({ name: provider.name, standard: film, long, other: recent });
    const resolved = [film, recent, long].some((run) => run?.outcome === 'resolved');
    let episode = { template: null, summary: null, control_outcome: null, tried: [], skipped: 'no film resolved' };
    if (!episodes) episode = { ...episode, skipped: 'episodes not probed' };
    else if (resolved) episode = await findEpisode(provider, sniff, fetchImpl, { ref: titles.episode, candidates, log });
    results.rows.push({ name: provider.name, movie_template: provider.movie, resolved, film, recent, long, verdict, episode });
    onRow(results);
  }
  return results;
}

/** The expiry a manifest address claims for itself, or null: an epoch in a query value or path segment, base64url-wrapped or a JWT's exp. */
export function claimedExpiry(url, nowMs) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const horizon = nowMs + 7 * 86_400_000;
  const found = [];
  const scanDigits = (text, source) => {
    for (const m of text.matchAll(/(?<!\d)(\d{13}|\d{10})(?!\d)/g)) {
      const ms = m[1].length === 13 ? Number(m[1]) : Number(m[1]) * 1000;
      if (ms > nowMs && ms < horizon) found.push({ ms, source });
    }
  };
  const pieces = [...parsed.searchParams.entries()];
  for (const segment of parsed.pathname.split('/')) if (segment) pieces.push(['path', segment]);
  for (const [key, value] of pieces) {
    scanDigits(value, key);
    for (const m of value.matchAll(/eyJ[A-Za-z0-9_-]+\.(eyJ[A-Za-z0-9_-]+)/g)) {
      try {
        const exp = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')).exp;
        if (typeof exp === 'number' && exp * 1000 > nowMs && exp * 1000 < horizon) found.push({ ms: exp * 1000, source: `${key}:jwt` });
      } catch {
        // not a token
      }
    }
    if (/^[A-Za-z0-9_-]{16,}={0,2}$/.test(value)) scanDigits(Buffer.from(value, 'base64url').toString('latin1'), `${key}:base64`);
  }
  if (found.length === 0) return null;
  const first = found.sort((a, b) => a.ms - b.ms)[0];
  return { at: new Date(first.ms).toISOString(), source: first.source, minutes: Math.round((first.ms - nowMs) / 60_000) };
}

/** The first address a playlist names (a variant or a segment), resolved against its base. */
export function firstUri(text, base) {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    try {
      return new URL(t, base).href;
    } catch {
      return null;
    }
  }
  return null;
}

/** One lifetime check: the manifest, its first variant and that variant's first segment still answer. */
export async function checkStream(source, headers, fetchImpl) {
  const out = { ok: false, master: null, variant: null, segment: null };
  try {
    const res = await fetchImpl(source.manifest_url, { headers });
    const text = await res.text();
    out.master = res.status;
    const isDash = source.manifest_kind === 'dash';
    if (!res.ok || !(isDash ? text.includes('<MPD') : text.startsWith('#EXTM3U'))) return out;
    if (isDash) {
      out.ok = true;
      return out;
    }
    let playlist = text;
    let base = res.url || source.manifest_url;
    if (!/#EXTINF/.test(playlist)) {
      const variantUrl = firstUri(playlist, base);
      if (!variantUrl) {
        out.ok = true;
        return out;
      }
      const variant = await fetchImpl(variantUrl, { headers });
      playlist = await variant.text();
      base = variant.url || variantUrl;
      out.variant = variant.status;
      if (!variant.ok || !playlist.startsWith('#EXTM3U')) return out;
    }
    const segmentUrl = firstUri(playlist, base);
    if (!segmentUrl) {
      out.ok = true;
      return out;
    }
    const segment = await fetchImpl(segmentUrl, { headers: { ...headers, range: 'bytes=0-1023' } });
    await segment.arrayBuffer().catch(() => null);
    out.segment = segment.status;
    out.ok = segment.ok;
    return out;
  } catch (err) {
    out.error = String(err?.message ?? err).slice(0, 120);
    return out;
  }
}

/**
 * Resolves one manifest, then re-requests it on LIFETIME_SCHEDULE_MIN (capped at maxMin) until a
 * check fails twice in a row, 30 s apart. Every event is one line through `write`.
 */
export async function watchLifetime({ provider, ref = TITLES.film, sniff, fetchImpl, sleep = sleepMs, now = () => Date.now(), scheduleMin = LIFETIME_SCHEDULE_MIN, maxMin = 420, write }) {
  const probed = await probe(provider, ref, sniff);
  if (!probed.ok) {
    write({ event: 'no_source', provider: provider.name, outcome: probed.attempt?.outcome ?? 'error', at: new Date(now()).toISOString() });
    return;
  }
  const { source } = probed;
  const startMs = now();
  write({
    event: 'start',
    provider: provider.name,
    tmdb_id: ref.tmdbId,
    manifest_kind: source.manifest_kind,
    manifest_host: hostOf(source.manifest_url),
    started_at: new Date(startMs).toISOString(),
    claimed_expiry: claimedExpiry(source.manifest_url, startMs),
  });
  const headers = requestHeaders(source.headers);
  const schedule = scheduleMin.filter((minute) => minute <= maxMin);
  for (const minute of schedule) {
    const wait = startMs + minute * 60_000 - now();
    if (wait > 0) await sleep(wait);
    let check = await checkStream(source, headers, fetchImpl);
    if (!check.ok) {
      await sleep(RETRY_MS);
      check = await checkStream(source, headers, fetchImpl);
    }
    write({ event: 'check', minute, at: new Date(now()).toISOString(), ...check });
    if (!check.ok) {
      write({ event: 'end', reason: 'failed', minute });
      return;
    }
  }
  write({ event: 'end', reason: 'schedule_done', minute: schedule.at(-1) ?? 0 });
}

/** What a lifetime log measured so far. */
export function lifetimeReport(lines) {
  const start = lines.find((line) => line.event === 'start');
  if (!start) {
    const none = lines.find((line) => line.event === 'no_source');
    return none ? { provider: none.provider, no_source: none.outcome } : null;
  }
  const checks = lines.filter((line) => line.event === 'check');
  const good = checks.filter((check) => check.ok);
  const failed = checks.find((check) => !check.ok) ?? null;
  const end = lines.find((line) => line.event === 'end') ?? null;
  return {
    provider: start.provider,
    manifest_kind: start.manifest_kind,
    manifest_host: start.manifest_host,
    started_at: start.started_at,
    claimed_expiry: start.claimed_expiry?.at ?? null,
    claimed_minutes: start.claimed_expiry?.minutes ?? null,
    last_ok_min: good.length ? Math.max(...good.map((check) => check.minute)) : null,
    first_failure_min: failed ? failed.minute : null,
    first_failure: failed ? { master: failed.master, variant: failed.variant, segment: failed.segment, error: failed.error ?? null } : null,
    checks: checks.length,
    finished: end !== null,
    end_reason: end?.reason ?? 'running',
  };
}

/** Nearest-rank percentile, rounded to 0.1 s; null for no values. */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index] * 10) / 10;
}

const spread = (values) => ({ n: values.length, p50: percentile(values, 50), p90: percentile(values, 90), max: values.length ? Math.max(...values) : null });

/** The machine-readable timings phase 10 sets its probe budgets from. */
export function timings(results, lifetime = null) {
  const resolvedS = [];
  const failedS = [];
  const providers = {};
  for (const row of results.rows) {
    const runs = [row.film, row.recent, row.long, row.episode?.summary].filter(Boolean);
    const ok = runs.filter((run) => run.outcome === 'resolved' && typeof run.took_s === 'number').map((run) => run.took_s);
    const bad = runs.filter((run) => run.outcome !== 'resolved' && typeof run.took_s === 'number').map((run) => run.took_s);
    resolvedS.push(...ok);
    failedS.push(...bad);
    const resolvedRuns = runs.filter((run) => run.outcome === 'resolved');
    providers[row.name] = {
      tried: runs.length,
      resolved: resolvedRuns.length,
      median_s: percentile(ok, 50),
      max_s: ok.length ? Math.max(...ok) : null,
      fail_median_s: percentile(bad, 50),
      cause: row.verdict.cause,
      en_subtitle: resolvedRuns.length ? resolvedRuns.some((run) => run.en_subtitle === true) : null,
      episodes: Boolean(row.episode?.template),
    };
  }
  return {
    schema: 1,
    measured_at: results.measured_at,
    host: results.host,
    long_sniff_seconds: results.long_sniff_seconds ?? LONG_SNIFF.seconds,
    resolve_s: spread(resolvedS),
    fail_s: spread(failedS),
    providers,
    token_lifetime: lifetime && lifetime.started_at
      ? {
          provider: lifetime.provider,
          started_at: lifetime.started_at,
          claimed_minutes: lifetime.claimed_minutes,
          last_ok_min: lifetime.last_ok_min,
          first_failure_min: lifetime.first_failure_min,
          finished: lifetime.finished,
        }
      : null,
  };
}

/** Several results files as one, by provider: a later file's row replaces an earlier one's. */
export function mergeResults(list) {
  const order = [];
  const rows = new Map();
  for (const results of list) {
    for (const row of results.rows) {
      if (!rows.has(row.name)) order.push(row.name);
      rows.set(row.name, row);
    }
  }
  const latest = [...list].sort((a, b) => String(a.measured_at).localeCompare(String(b.measured_at))).at(-1);
  return { ...latest, rows: order.map((name) => rows.get(name)) };
}

const BEGIN = (name) => `<!-- campaign:${name}:begin -->`;
const END = (name) => `<!-- campaign:${name}:end -->`;

/** Replaces what is between one block's markers; everything outside is kept as it is. */
export function replaceBlock(text, name, body) {
  const a = text.indexOf(BEGIN(name));
  const b = text.indexOf(END(name));
  if (a === -1 || b === -1 || b < a) throw new Error(`the findings file has no ${name} block`);
  return `${text.slice(0, a + BEGIN(name).length)}\n${body.trim()}\n${text.slice(b)}`;
}

export function readBlock(text, name) {
  const a = text.indexOf(BEGIN(name));
  const b = text.indexOf(END(name));
  if (a === -1 || b === -1 || b < a) throw new Error(`the findings file has no ${name} block`);
  return text.slice(a + BEGIN(name).length, b).trim();
}

const cell = (run) =>
  !run || run.outcome !== 'resolved'
    ? '—'
    : [run.manifest_kind ?? '?', run.best_height ? `${run.best_height}p` : '?p', run.en_subtitle ? 'en' : 'no en', `${run.took_s ?? '?'} s`].join(' · ');
const filmRun = (row) => (row.film?.outcome === 'resolved' ? row.film : row.long?.outcome === 'resolved' ? row.long : row.film);
const tick = (text) => `\`${text}\``;

function renderProviders(results, resultsFiles) {
  const t = results.titles;
  const lines = [
    `Measured ${results.measured_at} on \`${results.host}\`. Raw results: ${resultsFiles.map((f) => tick(tilde(f))).join(', ')}.`,
    '',
    `| Provider | ${t.film.label} | ${t.recent.label} | ${t.episode.label} | Cause or note |`,
    '| --- | --- | --- | --- | --- |',
  ];
  for (const row of results.rows) {
    const ep = row.episode?.template ? `${tick(row.episode.template)} ${row.episode.summary?.took_s ?? '?'} s` : `— (${row.episode?.skipped || 'no template resolved'})`;
    lines.push(`| ${row.name} | ${cell(filmRun(row))} | ${cell(row.recent)} | ${ep} | ${row.verdict.cause ?? row.verdict.note ?? ''} |`);
  }
  return lines.join('\n');
}

function evidenceCells(run) {
  const e = run?.evidence;
  if (!run) return '| — | — | — | — | — | — | — | — |';
  if (!e) return `| ${run.outcome} | — | — | — | — | — | — | — |`;
  const seen = e.inspect;
  const videos = seen ? `${seen.videos} (${seen.blob_videos} blob, ${seen.started_videos} started), ${seen.root_iframes} iframes` : 'not inspected';
  const text = seen?.text ? seen.text.replace(/\|/g, '/').slice(0, 80) : '';
  return `| ${run.outcome} | ${e.requests} | ${e.frames} ${e.frame_hosts.length ? `(${e.frame_hosts.join(', ')})` : ''} | ${e.clicks} | ${e.popups_closed} | ${e.bot_check ? 'yes' : 'no'} | ${videos} | ${text} |`;
}

function renderDiagnosis(results) {
  const rows = results.rows.filter((row) => row.verdict.cause || SPIKE_SILENT.includes(row.name));
  const lines = [
    '| Provider | Sniff | Outcome | Requests | Frames (hosts) | Clicks | Ads closed | Bot check | Videos | Page text | Cause |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    const cause = row.verdict.cause ?? row.verdict.note ?? '';
    lines.push(`| ${row.name} | standard ${evidenceCells(row.film)} ${cause} |`);
    if (row.long) lines.push(`| ${row.name} | ${results.long_sniff_seconds ?? LONG_SNIFF.seconds} s, inspected ${evidenceCells(row.long)} ${cause} |`);
  }
  if (rows.length === 0) lines.push('| — | — | — | — | — | — | — | — | — | — | every provider resolved |');
  return lines.join('\n');
}

function renderEpisodes(results) {
  const probed = results.rows.filter((row) => row.episode && row.episode.tried.length > 0);
  const lines = [
    `Episode: ${results.titles.episode.label}; control: S${String(CONTROL_EPISODE.season).padStart(2, '0')}E${CONTROL_EPISODE.episode} (must not resolve).`,
    '',
    '| Provider | Episode template | Episode | Control | Candidates tried |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const row of probed) {
    const ep = row.episode;
    const tried = ep.tried.map((t) => `${tick(t.template)} ${t.outcome}`).join('<br>');
    lines.push(`| ${row.name} | ${ep.template ? tick(ep.template) : '—'} | ${ep.template ? cell(ep.summary) : '—'} | ${ep.control_outcome ?? '—'} | ${tried} |`);
  }
  const skipped = results.rows.filter((row) => !row.episode || row.episode.tried.length === 0).map((row) => row.name);
  if (skipped.length) lines.push('', `Not probed (no film resolved, or episodes off): ${skipped.join(', ')}.`);
  return lines.join('\n');
}

function renderLifetime(report, logFile) {
  if (!report) return '_No lifetime log given._';
  if (report.no_source) return `${report.provider} did not resolve when the watch started (${report.no_source}); no lifetime measured. Log: ${tick(tilde(logFile))}.`;
  return [
    '| Provider | Started (UTC) | Claimed expiry | Valid at least (min) | First failure (min) | Checks | State |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    `| ${report.provider} (${report.manifest_kind}, ${report.manifest_host}) | ${report.started_at} | ${report.claimed_expiry ? `${report.claimed_expiry} (${report.claimed_minutes} min)` : 'none in the address'} | ${report.last_ok_min ?? '—'} | ${report.first_failure_min ?? '—'} | ${report.checks} | ${report.end_reason} |`,
    '',
    `Log: ${tick(tilde(logFile))}.${report.first_failure ? ` First failure: master ${report.first_failure.master}, variant ${report.first_failure.variant}, segment ${report.first_failure.segment}${report.first_failure.error ? `, ${report.first_failure.error}` : ''}.` : ''}`,
  ].join('\n');
}

/** The findings file with its generated blocks replaced. Without `lifetime`, the lifetime block and the timings' token_lifetime stay as they were. */
export function renderFindings(text, { results, lifetime = null, lifetimeLog = null, resultsFiles = [] }) {
  let keptLifetime = null;
  if (!lifetime) {
    try {
      keptLifetime = JSON.parse(readBlock(text, 'timings').replace(/^```json\s*/, '').replace(/```$/, '').trim()).token_lifetime ?? null;
    } catch {
      keptLifetime = null;
    }
  }
  const data = timings(results, lifetime);
  if (!lifetime) data.token_lifetime = keptLifetime;
  let out = replaceBlock(text, 'providers', renderProviders(results, resultsFiles));
  out = replaceBlock(out, 'diagnosis', renderDiagnosis(results));
  out = replaceBlock(out, 'episodes', renderEpisodes(results));
  if (lifetime) out = replaceBlock(out, 'lifetime', renderLifetime(lifetime, lifetimeLog ?? ''));
  out = replaceBlock(out, 'timings', `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``);
  return out;
}

/** The seed with the measured fields filled; providers the results do not name stay as they were. */
export function applySeed(seed, results) {
  const rows = new Map(results.rows.map((row) => [row.name, row]));
  const date = String(results.measured_at).slice(0, 10);
  return seed.map((provider) => {
    const row = rows.get(provider.name);
    if (!row) return provider;
    const resolvedRuns = [row.film, row.recent, row.long, row.episode?.summary].filter((run) => run?.outcome === 'resolved');
    const best = resolvedRuns[0] ?? null;
    const what = best
      ? `resolved ${best.manifest_kind} ${best.best_height ?? '?'}p${best.en_subtitle ? ' en' : ''} in ${best.took_s ?? '?'} s`
      : row.verdict.cause ?? 'no stream';
    const extras = [row.verdict.cause && best ? `Fight Club: ${row.verdict.cause}` : '', row.verdict.note, row.episode?.template ? 'episodes' : ''].filter(Boolean);
    return {
      ...provider,
      tv: row.episode?.template ?? provider.tv,
      en_subtitle: resolvedRuns.length ? resolvedRuns.some((run) => run.en_subtitle === true) : provider.en_subtitle,
      browser_only: row.verdict.cause === 'blob_media' ? true : provider.browser_only,
      notes: `campaign ${date}: ${what}${extras.length ? `; ${extras.join(', ')}` : ''}`,
    };
  });
}

const tableRows = (block) =>
  block
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .slice(2)
    .map((line) => line.trim().split('|').slice(1, -1).map((c) => c.trim()));
const untick = (text) => text.replace(/^`|`$/g, '');
const RESOLVED_CELL = /^[a-z0-9]+ · /;

function sectionOf(text, heading) {
  const at = text.indexOf(`\n${heading}\n`);
  if (at === -1) return null;
  const rest = text.slice(at + heading.length + 2);
  const next = rest.search(/^#{2,3} /m);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Every reason the findings file and the seed do not yet say what R7.1 and R7.2 ask. [] when done. */
export function checkFindings(text, seed) {
  const problems = [];
  const block = (name) => {
    try {
      return readBlock(text, name);
    } catch (err) {
      problems.push(err.message);
      return '';
    }
  };
  const providerRows = tableRows(block('providers'));
  for (const provider of seed) {
    const row = providerRows.find((r) => r[0] === provider.name);
    if (!row) {
      problems.push(`providers: no row for ${provider.name}`);
      continue;
    }
    const resolved = RESOLVED_CELL.test(row[1] ?? '') || RESOLVED_CELL.test(row[2] ?? '');
    if (!resolved && !CAUSES.includes(row[4] ?? '')) problems.push(`providers: ${provider.name} neither resolved nor names a cause (${row[4] || 'empty'})`);
  }
  const episodeRows = tableRows(block('episodes')).filter((r) => r.length >= 5);
  for (const provider of seed.filter((p) => p.tv)) {
    const row = episodeRows.find((r) => r[0] === provider.name);
    if (!row || untick(row[1] ?? '') !== provider.tv) problems.push(`episodes: ${provider.name}'s seed tv template is not the one the findings record`);
  }
  for (const row of episodeRows) {
    const template = untick(row[1] ?? '');
    if (template && template !== '—' && !seed.some((p) => p.name === row[0] && p.tv === template)) problems.push(`seed: ${row[0]} resolved an episode but the seed's tv is not ${template}`);
  }
  if (!tableRows(block('lifetime')).some((r) => /^\d+$/.test(r[3] ?? ''))) problems.push('lifetime: no measured minutes');
  try {
    const data = JSON.parse(block('timings').replace(/^```json\s*/, '').replace(/```$/, '').trim());
    const named = Object.keys(data.providers ?? {});
    for (const provider of seed) if (!named.includes(provider.name)) problems.push(`timings: no entry for ${provider.name}`);
    if (!data.token_lifetime || typeof data.token_lifetime.last_ok_min !== 'number') problems.push('timings: no token_lifetime');
  } catch {
    problems.push('timings: the block is not JSON');
  }
  for (const name of SPIKE_SILENT) {
    const section = sectionOf(text, `### ${name}`);
    const cause = section ? /^\*\*Cause:\*\*\s+`?([a-z_]+)`?/m.exec(section)?.[1] : null;
    if (!cause || ![...CAUSES, 'not_reproduced'].includes(cause)) problems.push(`why three: ${name} has no named cause`);
  }
  if (text.includes('_To fill')) problems.push('a "_To fill" placeholder is left');
  return problems;
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!key.startsWith('no-') && next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { positional, flags };
}

const print = (value) => console.log(JSON.stringify(value, null, 2));

function writeFindings(file, resultsFiles, lifetimeLog) {
  const results = mergeResults(resultsFiles.map(readJson));
  const lifetime = lifetimeLog ? lifetimeReport(readJsonl(lifetimeLog)) : null;
  writeFileSync(file, renderFindings(readFileSync(file, 'utf8'), { results, lifetime, lifetimeLog, resultsFiles }));
  return results;
}

const tally = (results) => {
  const out = { resolved: 0 };
  for (const row of results.rows) {
    if (row.resolved) out.resolved++;
    if (row.verdict.cause) out[row.verdict.cause] = (out[row.verdict.cause] ?? 0) + 1;
  }
  return out;
};

/** The CLI. `io` swaps the sniffer, fetch and clock in tests. Returns the exit code. */
export async function main(command, argv, io = {}) {
  const { sniff = sniffEmbed, fetchImpl = fetch, sleep = sleepMs, now = () => new Date(), log = (line) => process.stderr.write(`${line}\n`) } = io;
  const { positional, flags } = parseArgs(argv);
  const seedFile = typeof flags.seed === 'string' ? flags.seed : SEED_FILE;
  const findingsFile = typeof flags.findings === 'string' ? flags.findings : FINDINGS_FILE;

  if (command === 'run') {
    const seed = readJson(seedFile);
    const only = typeof flags.only === 'string' ? flags.only.split(',').map((s) => s.trim()).filter(Boolean) : null;
    const unknown = (only ?? []).filter((name) => !seed.some((p) => p.name === name));
    if (unknown.length) {
      print({ ok: false, error: `unknown provider: ${unknown.join(', ')}` });
      return 2;
    }
    const providers = only ? seed.filter((p) => only.includes(p.name)) : seed;
    const titles = { ...TITLES };
    if (typeof flags.recent === 'string') titles.recent = { ...TITLES.recent, tmdbId: Number(flags.recent), label: `TMDB movie ${flags.recent}` };
    if (typeof flags.series === 'string') {
      const [id, season, episode] = flags.series.split(':').map(Number);
      titles.episode = { kind: 'tv', tmdbId: id, season, episode, label: `TMDB tv ${id} S${season}E${episode}` };
    }
    const outDir = typeof flags.out === 'string' ? flags.out : path.join(STATE_DIR, stamp(now()));
    mkdirSync(outDir, { recursive: true });
    const resultsFile = path.join(outDir, 'results.json');
    const save = (results) => writeFileSync(resultsFile, `${JSON.stringify(results, null, 2)}\n`);
    let results;
    try {
      results = await runCampaign({
        providers,
        sniff,
        fetchImpl,
        titles,
        diagnoseFailures: flags['no-diagnose'] !== true,
        episodes: flags['no-episodes'] !== true,
        candidates: Number(flags.candidates ?? 3),
        now,
        log,
        onRow: save,
      });
    } catch (err) {
      if (err instanceof CampaignAbort) {
        print({ ok: false, error: err.code, detail: err.message, results: existsSync(resultsFile) ? resultsFile : null });
        return 3;
      }
      throw err;
    }
    save(results);
    // A partial run would drop the other providers' rows, so it writes the findings only when asked.
    const writes = !only || typeof flags.findings === 'string';
    if (writes) writeFindings(findingsFile, [resultsFile], typeof flags.lifetime === 'string' ? flags.lifetime : null);
    print({ ok: true, results: resultsFile, findings: writes ? findingsFile : null, providers: results.rows.length, ...tally(results) });
    return 0;
  }

  if (command === 'lifetime') {
    const seed = readJson(seedFile);
    const name = typeof flags.provider === 'string' ? flags.provider : 'VidFast';
    const provider = seed.find((p) => p.name === name);
    if (!provider) {
      print({ ok: false, error: `unknown provider: ${name}` });
      return 2;
    }
    const logFile = typeof flags.log === 'string' ? flags.log : path.join(STATE_DIR, `lifetime-${stamp(now())}.jsonl`);
    mkdirSync(path.dirname(logFile), { recursive: true });
    const ref = { ...TITLES.film, tmdbId: Number(flags.tmdb ?? TITLES.film.tmdbId) };
    try {
      await watchLifetime({
        provider,
        ref,
        sniff,
        fetchImpl,
        sleep,
        now: () => now().getTime(),
        maxMin: Number(flags['max-min'] ?? 420),
        write: (line) => appendFileSync(logFile, `${JSON.stringify(line)}\n`),
      });
    } catch (err) {
      if (err instanceof CampaignAbort) {
        print({ ok: false, error: err.code, detail: err.message, log: logFile });
        return 3;
      }
      throw err;
    }
    print({ ok: true, log: logFile, ...lifetimeReport(readJsonl(logFile)) });
    return 0;
  }

  if (command === 'lifetime-status') {
    if (!positional[0]) {
      print({ ok: false, error: 'usage: lifetime-status <file.jsonl>' });
      return 2;
    }
    print({ ok: true, log: positional[0], ...lifetimeReport(readJsonl(positional[0])) });
    return 0;
  }

  if (command === 'report') {
    if (positional.length === 0) {
      print({ ok: false, error: 'usage: report <results.json>... [--lifetime <file.jsonl>] [--findings <file>]' });
      return 2;
    }
    const results = writeFindings(findingsFile, positional, typeof flags.lifetime === 'string' ? flags.lifetime : null);
    print({ ok: true, findings: findingsFile, providers: results.rows.length, ...tally(results) });
    return 0;
  }

  if (command === 'apply-seed') {
    if (positional.length === 0) {
      print({ ok: false, error: 'usage: apply-seed <results.json>... [--seed <file>]' });
      return 2;
    }
    const before = readJson(seedFile);
    const after = applySeed(before, mergeResults(positional.map(readJson)));
    writeFileSync(seedFile, `${JSON.stringify(after, null, 2)}\n`);
    const changed = after.filter((p, i) => JSON.stringify(p) !== JSON.stringify(before[i])).map((p) => p.name);
    print({ ok: true, seed: seedFile, changed });
    return 0;
  }

  if (command === 'check') {
    const problems = checkFindings(readFileSync(findingsFile, 'utf8'), readJson(seedFile));
    print({ ok: problems.length === 0, findings: findingsFile, problems });
    return problems.length === 0 ? 0 : 1;
  }

  print({ ok: false, error: 'usage: campaign.mjs run|lifetime|lifetime-status|report|apply-seed|check (see the header of campaign.mjs)' });
  return 2;
}

// Reached through a symlink when the skills folder links it, so compare real paths.
function isMain() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const [command, ...rest] = process.argv.slice(2);
  process.exitCode = await main(command ?? '', rest);
}
```
**Impact:** new file only. Imports phase 1's `resolve.mjs` and `sniff.mjs`; changes neither. No
environment variable is read, so `docs:check` needs no configuration row.

### Step 2: Unit test with a fake sniffer and a fake fetch
**File:** `tests/unit/scripts/directCampaign.test.ts:1` (new file)
**Change:** Drives `runCampaign` through phase 1's real `resolveTitle` (only the sniffer and fetch
are fake), so the test fails if the campaign and the resolver disagree. Asserts what a reader of
the results and the findings sees: 24 rows, each resolved with its numbers or a named cause; each
cause path; episode template choice with the control; the lifetime measurement on a fake clock;
the findings render and check; the seed fill. No network, no Chrome, instant.
**Code:**
```ts
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAUSES,
  CampaignAbort,
  FINDINGS_FILE,
  SEED_FILE,
  applySeed,
  checkFindings,
  claimedExpiry,
  episodeTemplates,
  lifetimeReport,
  main,
  readManifest,
  renderFindings,
  runCampaign,
  watchLifetime,
  // @ts-expect-error -- plain .mjs scripts without type declarations
} from '../../../claude/streaming/direct/campaign.mjs';

const seed: any[] = JSON.parse(readFileSync(SEED_FILE, 'utf8'));

const MASTER = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="subs/en.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=3840x2160,SUBTITLES="subs"',
  'hi/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=854x480,SUBTITLES="subs"',
  'lo/index.m3u8',
  '',
].join('\n');
const MEDIA = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg0.ts\n#EXT-X-ENDLIST\n';

const reply = (status: number, body: string) => ({
  status,
  ok: status >= 200 && status < 300,
  url: '',
  text: async () => body,
  arrayBuffer: async () => new ArrayBuffer(0),
});

const fakeFetch = async (url: string) => {
  if (url.includes('/index.m3u8')) return reply(200, MEDIA);
  if (url.includes('.m3u8')) return reply(200, MASTER);
  if (url.endsWith('.ts')) return reply(206, 'x');
  return reply(404, '');
};

type Shape = { manifest?: boolean; requests?: number; frames?: string[]; bot?: boolean; inspect?: unknown; clicks?: number };
const sniffed = (url: string, shape: Shape, options: any) => ({
  url,
  took_s: 2.4,
  requests: shape.requests ?? 40,
  clicks: shape.clicks ?? 0,
  popups_closed: 0,
  frames: shape.frames ?? ['iframe https://player.example/e/1'],
  hosts: ['player.example 30', 'cdn.example 10'],
  hits: shape.manifest
    ? [
        {
          at_s: 2.4,
          type: 'XHR',
          url: `https://cdn.example/hls/${encodeURIComponent(url)}/master.m3u8`,
          referer: 'https://player.example/',
          origin: 'https://player.example',
          document: url,
          status: 200,
          mime: 'application/vnd.apple.mpegurl',
        },
      ]
    : [],
  user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0',
  bot_check: shape.bot === true,
  inspect: options?.inspect ? (shape.inspect ?? [{ url, title: '', text: '', videos: [], iframes: 0 }]) : null,
});

const isControl = (url: string) => /(^|[^0-9])99([^0-9]|$)/.test(url);

/** One behaviour per embed host; every other provider resolves films and honours the episode. */
async function fakeSniff(url: string, options: any = {}) {
  const host = new URL(url).host;
  switch (host) {
    case 'player.videasy.net':
      return sniffed(url, { requests: 6, inspect: [{ url, title: 'Videasy', text: '', videos: [{ src: 'blob:https://player.videasy.net/1', ready_state: 4, paused: false, current_time: 3 }], iframes: 0 }] }, options);
    case 'www.vidking.net':
      return sniffed(url, { requests: 4, bot: true }, options);
    case 'vidsrc.cc':
      if (url.includes('/tv/')) return sniffed(url, { manifest: !isControl(url) && url.includes('/2/3') }, options);
      return sniffed(url, { manifest: Number(options.seconds ?? 0) >= 90 }, options);
    case 'vidup.to':
      return sniffed(url, { manifest: true }, options);
    case 'vidsrc.me':
      return sniffed(url, { requests: 0, frames: [] }, options);
    case '111movies.com':
      return sniffed(url, { inspect: [{ url, title: '111movies', text: 'Sorry, this movie is not found', videos: [], iframes: 0 }] }, options);
    case 'hexa.watch':
      return sniffed(url, { frames: [], inspect: [{ url, title: 'Hexa', text: '', videos: [], iframes: 1 }] }, options);
    case 'rivestream.org':
      return sniffed(url, { clicks: 4, inspect: [{ url, title: 'Rive', text: '', videos: [{ src: '', ready_state: 0, paused: true, current_time: 0 }], iframes: 0 }] }, options);
    case 'spencerdevs.xyz':
      return sniffed(url, {}, options);
    case 'vidsrc.wtf':
      throw new Error('powershell: the sniffer crashed');
    default:
      return sniffed(url, { manifest: !isControl(url) }, options);
  }
}

const run = () => runCampaign({ providers: seed, sniff: fakeSniff, fetchImpl: fakeFetch, now: () => new Date('2026-11-15T12:00:00Z'), host: 'test-host' });

describe('direct streaming probe campaign', () => {
  it('writes, for every one of the 24 seed providers, what it resolved or the named cause', async () => {
    expect(seed).toHaveLength(24);
    const results = await run();
    expect(results.rows.map((row: any) => row.name)).toEqual(seed.map((p) => p.name));
    for (const row of results.rows) {
      const film = [row.film, row.long, row.recent].find((r: any) => r?.outcome === 'resolved');
      if (film) {
        expect(film.manifest_kind).toBe('hls');
        expect(film.best_height).toBe(2160);
        expect(film.en_subtitle).toBe(true);
        expect(typeof film.took_s).toBe('number');
      } else {
        expect(CAUSES).toContain(row.verdict.cause);
      }
    }
  });

  it('names each cause from the evidence', async () => {
    const results = await run();
    const by = (name: string) => results.rows.find((row: any) => row.name === name).verdict;
    expect(by('Videasy').cause).toBe('blob_media');
    expect(by('VidKing').cause).toBe('bot_check');
    expect(by('VidSrc').cause).toBe('unreachable');
    expect(by('Movies111').cause).toBe('not_found');
    expect(by('StreamVault').cause).toBe('frame_not_attached');
    expect(by('MovieVault').cause).toBe('click_missed');
    expect(by('MediaHub').cause).toBe('no_player');
    expect(by('HyperLink').cause).toBe('error');
    expect(by('CloudPlay')).toEqual({ cause: null, note: 'slow_start' });
    expect(by('VidFast')).toEqual({ cause: null, note: '' });
  });

  it('keeps an episode template only when it serves the episode and fails the control', async () => {
    const results = await run();
    const by = (name: string) => results.rows.find((row: any) => row.name === name).episode;
    expect(by('CloudPlay').template).toBe('https://vidsrc.cc/v2/embed/tv/{id}/{season}/{episode}');
    expect(by('CloudPlay').control_outcome).not.toBe('resolved');
    expect(by('VidFast').template).toBe('https://vidfast.pro/tv/{id}/{season}/{episode}?autoPlay=true');
    expect(by('VidUp').template).toBeNull();
    expect(by('VidUp').tried.map((t: any) => t.outcome)).toEqual(['ignores_episode', 'ignores_episode', 'ignores_episode']);
    expect(by('Videasy').skipped).toBe('no film resolved');
  });

  it('derives episode candidates for every seed template', () => {
    for (const provider of seed) {
      const candidates = episodeTemplates(provider.movie);
      expect(candidates.length).toBeGreaterThanOrEqual(2);
      for (const c of candidates) {
        expect(c).toContain('{id}');
        expect(c).toContain('{season}');
        expect(c).toContain('{episode}');
        expect(c).not.toMatch(/\/movie(\/|\?|$)|type=movie/);
      }
    }
    expect(episodeTemplates('https://vidsrc.me/embed/movie?tmdb={id}')[0]).toBe('https://vidsrc.me/embed/tv?tmdb={id}&season={season}&episode={episode}');
    expect(episodeTemplates('https://rivestream.org/embed?type=movie&id={id}')[0]).toBe('https://rivestream.org/embed?type=tv&id={id}&season={season}&episode={episode}');
  });

  it('stops the run when the streaming Chrome is not there', async () => {
    const down = async () => {
      throw Object.assign(new Error('no_chrome: chrome.exe was not found'), { code: 'no_chrome' });
    };
    await expect(runCampaign({ providers: seed.slice(0, 1), sniff: down, fetchImpl: fakeFetch })).rejects.toBeInstanceOf(CampaignAbort);
  });

  it('reads heights and English subtitle tracks from HLS and DASH manifests', () => {
    expect(readManifest(MASTER, 'hls')).toEqual({ heights: [2160, 480], subtitle_langs: ['en'] });
    const mpd = '<MPD><AdaptationSet contentType="video"><Representation height="1080"/></AdaptationSet><AdaptationSet contentType="text" lang="eng"></AdaptationSet></MPD>';
    expect(readManifest(mpd, 'dash')).toEqual({ heights: [1080], subtitle_langs: ['eng'] });
  });

  it('measures how long a manifest keeps answering, on a schedule, with a claimed expiry', async () => {
    let t = Date.parse('2026-11-15T12:00:00Z');
    const start = t;
    const expires = Math.floor(start / 1000) + 6 * 3600;
    const sniff = async (url: string) => ({
      ...sniffed(url, { manifest: false }, {}),
      hits: [{ at_s: 2, type: 'XHR', url: `https://cdn.example/hls/master.m3u8?expires=${expires}`, referer: 'https://vidfast.vc/', origin: 'https://vidfast.vc', document: url, status: 200, mime: 'application/vnd.apple.mpegurl' }],
    });
    const fetchAt = async (url: string) => ((t - start) / 60_000 >= 40 ? reply(403, '') : fakeFetch(url));
    const lines: any[] = [];
    await watchLifetime({
      provider: seed.find((p) => p.name === 'VidFast'),
      sniff,
      fetchImpl: fetchAt,
      sleep: async (ms: number) => {
        t += ms;
      },
      now: () => t,
      scheduleMin: [0, 5, 20, 40, 60],
      maxMin: 60,
      write: (line: any) => lines.push(line),
    });
    const report = lifetimeReport(lines);
    expect(report).toMatchObject({ provider: 'VidFast', claimed_minutes: 360, last_ok_min: 20, first_failure_min: 40, end_reason: 'failed', checks: 4 });
    expect(report.first_failure.master).toBe(403);
    expect(claimedExpiry('https://cdn.example/x/master.m3u8', start)).toBeNull();
  });

  it('fills the findings template so the checker accepts the tables, and flags hand sections left open', async () => {
    const results = await run();
    const lifetime = { provider: 'VidFast', manifest_kind: 'hls', manifest_host: 'cdn.example', started_at: '2026-11-15T12:00:00.000Z', claimed_expiry: null, claimed_minutes: null, last_ok_min: 60, first_failure_min: null, first_failure: null, checks: 7, finished: false, end_reason: 'running' };
    const template = readFileSync(FINDINGS_FILE, 'utf8');
    const text = renderFindings(template, { results, lifetime, lifetimeLog: '/tmp/lifetime.jsonl', resultsFiles: ['/tmp/results.json'] });
    expect(text).toContain('## Why three returned nothing');
    expect(text).toContain('## Playback');
    const filled = applySeed(seed, results);
    const problems = checkFindings(text, filled);
    expect(problems.filter((p: string) => /^(providers|episodes|seed|lifetime|timings):/.test(p))).toEqual([]);
    const timings = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)![1]!);
    expect(Object.keys(timings.providers)).toHaveLength(24);
    // Seconds come from phase 1's resolver; only their presence is this phase's to assert.
    expect(typeof timings.resolve_s.p50).toBe('number');
    expect(timings.token_lifetime.last_ok_min).toBe(60);
    // Rendering again without a lifetime keeps the measured one.
    const again = renderFindings(text, { results, resultsFiles: ['/tmp/results.json'] });
    expect(again).toContain('| 60 |');
  });

  it('fills the seed fields the campaign measured and leaves the rest', async () => {
    const results = await run();
    const filled = applySeed(seed, results);
    const by = (name: string) => filled.find((p: any) => p.name === name);
    expect(filled).toHaveLength(24);
    expect(by('CloudPlay').tv).toBe('https://vidsrc.cc/v2/embed/tv/{id}/{season}/{episode}');
    expect(by('VidUp').tv).toBeNull();
    expect(by('Videasy').browser_only).toBe(true);
    expect(by('VidFast').en_subtitle).toBe(true);
    expect(by('VidKing').en_subtitle).toBeNull();
    expect(by('VidFast').movie).toBe(seed.find((p) => p.name === 'VidFast').movie);
    for (const provider of filled) expect(provider.notes).toMatch(/^campaign 2026-11-15: /);
  });

  it('runs from the command line against a scratch findings file', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'campaign-'));
    const findings = path.join(dir, 'findings.md');
    writeFileSync(findings, readFileSync(FINDINGS_FILE, 'utf8'));
    const out: string[] = [];
    const original = console.log;
    console.log = (text: string) => out.push(text);
    try {
      const code = await main('run', ['--only', 'VidFast,VidKing', '--out', dir, '--findings', findings], { sniff: fakeSniff, fetchImpl: fakeFetch, log: () => {} });
      expect(code).toBe(0);
    } finally {
      console.log = original;
    }
    const printed = JSON.parse(out.join('\n'));
    expect(printed).toMatchObject({ ok: true, providers: 2, resolved: 1, bot_check: 1 });
    const results = JSON.parse(readFileSync(path.join(dir, 'results.json'), 'utf8'));
    // Seed order, not --only order.
    expect(results.rows.map((row: any) => row.name)).toEqual(seed.filter((p) => ['VidFast', 'VidKing'].includes(p.name)).map((p) => p.name));
    expect(readFileSync(findings, 'utf8')).toMatch(/\| VidKing \| — \| — \| — \(no film resolved\) \| bot_check \|/);
  });
});
```
**Impact:** new test file only; runs in `npm test`. It needs phase 1's `resolve.mjs`,
`sniff.mjs` and seed, which `depends_on: [1]` guarantees.

### Step 3: The findings template
**File:** `docs/plans/2026-11-15-direct-streaming-findings.md:1` (new file)
**Change:** The full template: how it was measured, the generated blocks, the cause definitions,
the diagnostic procedure, three hand sections with a `**Cause:**` line each, the token lifetime
method, sniffer changes (with the `-Inspect` entry already written), the timings block, and the
`## Playback` heading for phase 6. Every `_To fill` marks hand work for Step 6; `campaign.mjs
check` fails while one is left.
**Code:**
````markdown
# Direct streaming: findings

**Started:** 2026-11-15
**Plan:** `.workflows/plan/DIRECT_STREAMING_PLAN.md` (phase 2 writes everything above **Playback**; phase 6 writes **Playback**)
**Brief:** `docs/plans/2026-11-15-direct-streaming-design.md`

The brief left these untested: the other 18 providers, why three providers returned nothing,
series episodes, how long a manifest's token lives, and playback (DASH, VidNest, subtitles in our
player). This file holds what was measured on the owner's laptop through the streaming Chrome.

The tables between `<!-- campaign:... -->` markers are generated by
`claude/streaming/direct/campaign.mjs`. Rerun the command; never edit them by hand.

## How it was measured

- `node claude/streaming/direct/campaign.mjs run` probes all 24 seed providers and writes the
  tables below; `report <results.json>... --lifetime <log.jsonl>` rewrites them from saved results
  (a later file's row replaces an earlier one's, so `run --only <name>` after a fix updates one
  row); `apply-seed <results.json>...` fills `tv`, `en_subtitle`, `browser_only` and `notes` in
  `claude/streaming/direct/providers.seed.json`; `check` confirms this file and the seed agree.
- Each provider is probed through the resolver the daemon uses (`resolveTitle` with that one
  provider), so a provider counts as resolved exactly when `/direct-stream` would play it.
- Titles: Fight Club (TMDB movie 550), Sinners (TMDB movie 1233413, 2025) as the recent film,
  Breaking Bad S02E03 (TMDB tv 1396) as the series episode. Breaking Bad S01E99 is the control: the
  first season has seven episodes, so a template that also resolves S01E99 ignores the episode.
- A provider that does not resolve Fight Club, and Videasy, VidKing and CloudPlay always, get a
  second sniff of 90 s with `-Inspect`: the sniffer reads every frame's video elements, iframes and
  visible text before it closes the tab. Nothing is clicked by the inspection.
- Each resolved manifest is fetched once from WSL with the headers the real Chrome sent, for the
  subtitle tracks and heights it names and to see whether the pass-through approach works for that
  provider (`node_fetch_status` in the raw results).
- The streaming Chrome (`notesd-stream-chrome`, port 9333) stays minimized and muted. No window was
  brought forward and nothing played with sound.
- Raw results carry manifest addresses with tokens, so they stay in
  `~/.local/state/notesd-direct-campaign/`, outside git. Each table names the files it came from.

## Providers

A cell reads `kind · best height · en / no en · seconds to the manifest`. `—` means the title did
not resolve; the last column then names why (see **Failure causes**), or carries a note on a
provider that did resolve.

<!-- campaign:providers:begin -->
_Not measured yet._
<!-- campaign:providers:end -->

## Failure causes

| Cause | Meaning | Evidence that names it |
| --- | --- | --- |
| `bot_check` | the embed answered with a bot check; skipped, never worked around | the resolver's outcome, or the sniffer's `bot_check` flag (a "Just a moment" title or a challenge frame) |
| `error` | the sniff itself failed | every run errored; the raw result's `detail` says how |
| `unreachable` | the embed host did not answer | at most one request in every run |
| `not_found` | the provider does not have this title | the recent film resolved but Fight Club did not, or a frame's text says not found, no sources, unavailable or 404 |
| `blob_media` | the video plays through MSE from addresses the sniffer does not recognise as a stream | a `<video>` with a `blob:` source and data, and no manifest request; such a provider cannot feed our player and is `browser_only` |
| `frame_not_attached` | the player is in a frame the sniffer never attached to | the page has iframes, the sniffer saw none |
| `click_missed` | a player is there and waits; the sniffer's clicks at the page centre did not start it | a video element or player frame, nothing started, clicks sent |
| `no_player` | the page shows no player at all | no video element and no iframe in any readable frame |

Notes on a provider that resolved: `slow_start` (only the 90 s sniff resolved), `needed_click`
(the stream came after the sniffer clicked), `not_reproduced` (one of the spike's three silent
providers resolves now).

## Why three returned nothing

In the spike, Videasy, VidKing and CloudPlay (`vidsrc.cc`) gave no stream in 35 s, each with under
ten requests. The procedure, for each of them:

1. **Request count and hosts.** The standard sniff's `requests` and top hosts. At most one request
   means the host did not answer (`unreachable`); a handful on the embed host alone means the page
   stopped early (a check, an error page, or a script that waits).
2. **Bot check.** The sniffer's `bot_check` flag and the page title (`bot_check`).
3. **Frames.** Which frames the sniffer attached to, against the iframes the page has
   (`frame_not_attached`).
4. **Longer wait.** The 90 s sniff: a stream that shows up only there is `slow_start`.
5. **Click needed.** The sniffer clicks the page centre after 8 s, up to four times; a stream after
   a click is `needed_click`, a player still waiting after them is `click_missed`.
6. **Blob or MSE-only media.** The inspection's video elements: a `blob:` source with data and no
   manifest request is `blob_media`.
7. **Another title.** The recent film resolving where Fight Club did not is `not_found`.

The generated evidence, one line per sniff:

<!-- campaign:diagnosis:begin -->
_Not measured yet._
<!-- campaign:diagnosis:end -->

### Videasy

**Cause:** _To fill: one cause from **Failure causes**, or `not_reproduced`._

**Evidence:** _To fill: the numbers from the evidence table that name the cause, what the raw
result shows beyond them (hosts, the frame addresses, the page text), and whether a sniffer change
followed (see **Sniffer changes**)._

### VidKing

**Cause:** _To fill: one cause from **Failure causes**, or `not_reproduced`._

**Evidence:** _To fill: as for Videasy._

### CloudPlay

**Cause:** _To fill: one cause from **Failure causes**, or `not_reproduced`._

**Evidence:** _To fill: as for Videasy._

## Series episodes

The fmovies chunk holds film templates only. For each provider that resolved a film, the campaign
tries up to three episode templates derived from its film template, and keeps the first that
resolves the episode and fails the control.

<!-- campaign:episodes:begin -->
_Not measured yet._
<!-- campaign:episodes:end -->

**Reading:** _To fill: how many providers serve episodes, which template shapes worked, and any
provider that resolved the episode only through a template that ignores it._

## Token lifetime

`campaign.mjs lifetime` resolves Fight Club through VidFast, then re-requests the master playlist,
its first variant and that variant's first segment (the first KiB) from WSL, with the headers the
real Chrome sent, at minutes 0, 2, 5, 10, 20, 40, 60, 90, 120, 180, 240, 300, 360 and 420. A
failure is retried once after 30 s, then ends the watch. The claimed expiry is read from the
address itself. The watch runs detached; the phase 2 session recorded what it had measured by the
time it wrote this file (at least the T+60 check). Phase 6 reruns
`campaign.mjs report ... --lifetime <log>` to replace the table with the finished watch.

<!-- campaign:lifetime:begin -->
_Not measured yet._
<!-- campaign:lifetime:end -->

**Reading:** _To fill: the measured lower bound, the claimed expiry, whether they agree, and what
it means for a session's lifetime and the player's refresh (phase 3 and 4)._

## Sniffer changes

- `-Inspect` (phase 2): `sniff.ps1 -Inspect` / `sniffEmbed(url, { inspect: true })` reads, in the
  page and each frame the sniffer attached to, the video elements (source, ready state, position),
  the iframe count, the title and the first 300 characters of visible text, just before the tab
  closes. It clicks nothing and plays nothing. Without it the sniffer behaves as before. Added
  because `blob_media` and `frame_not_attached` cannot be told apart from network requests alone.
- _To fill: every change a finding demanded (what, which finding, and the rerun that confirmed
  it), or "No other change."_

## Timings

For phase 10's probe budgets. Seconds are from opening the embed to the resolver's answer.
`resolve_s` covers runs that resolved, `fail_s` runs that did not (bounded by the sniff time).
`providers.<name>.median_s` is that provider's median over its resolved runs.

<!-- campaign:timings:begin -->
```json
{}
```
<!-- campaign:timings:end -->

## Playback

Phase 6 fills this section: whether DASH (VidLink), VidNest and an English subtitle track play in
the daemon's player page, with the measured numbers, and a forced-expiry check of
refresh-and-continue.
````
**Impact:** new file under `docs/plans/`, which the docs check does not scan (it reads README,
CLAUDE.md and `docs/guide/`).

### Step 4: The sniffer's `-Inspect` switch
**File:** `claude/streaming/direct/sniff.ps1` (as phase 1's plan writes it, `phase-1.md` Step 2;
the anchors below are quoted from there)
**Change:** Three insertions, all inert unless `-Inspect` is passed. Phase 1 already keeps every
session that holds a document in `$pageSessions` (the tab first, then each attached page or
frame), so no new session list is needed.

4a. In the `param(...)` block, phase 1's last parameter is `  [switch]$KeepTab`. Make it
`  [switch]$KeepTab,` and add after it:
```powershell
  # Before the tab closes, read what the page and each attached frame show (video elements, iframe
  # count, title, visible text). Read-only: nothing is clicked and nothing is played.
  [switch]$Inspect
```

4b. After phase 1's `function New-Hit(...) { ... }` and before its main loop
`while ((Get-Date) -lt $deadline) {`:
```powershell
$InspectJs = @'
(() => {
  const videosIn = (doc) => Array.from(doc.querySelectorAll('video')).map((v) => ({
    src: String(v.currentSrc || v.src || '').slice(0, 120),
    ready_state: v.readyState,
    paused: v.paused,
    current_time: Math.round(v.currentTime || 0),
    muted: v.muted,
  }));
  const videos = videosIn(document);
  for (const frame of Array.from(document.querySelectorAll('iframe'))) {
    try { if (frame.contentDocument) videos.push(...videosIn(frame.contentDocument)); } catch (e) {}
  }
  const text = document.body ? document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  return JSON.stringify({ url: location.href.slice(0, 200), title: document.title.slice(0, 120), text,
    videos, iframes: document.querySelectorAll('iframe').length });
})()
'@

# What one page or frame shows, or $null when it cannot be read (gone, or never answered).
function Get-FrameReport([string]$session) {
  try {
    $reply = Wait-Reply (Send-Cdp 'Runtime.evaluate' @{ expression = $InspectJs; returnByValue = $true } $session) 1500
    $value = $reply.result.result.value
    if ($value) { return ($value | ConvertFrom-Json) }
  } catch { }
  return $null
}
```

4c. After phase 1's media-state block (the `foreach ($session in @($pageSessions | Select-Object
-First 12)) { ... }` that fills `$media`) and before its `Close-Tab` line:
```powershell
$inspectReports = $null
if ($Inspect) {
  $inspectReports = New-Object System.Collections.ArrayList
  foreach ($session in @($pageSessions | Select-Object -First 12)) {
    $report = Get-FrameReport $session
    if ($report) { [void]$inspectReports.Add($report) }
  }
}
```
and in phase 1's final `Write-Output ([ordered]@{ ... } | ConvertTo-Json -Depth 6 -Compress)`,
after its last key `  hits = $outHits`, add:
```powershell
  inspect = $(if ($Inspect) { @($inspectReports) } else { $null })
```
(`-Depth 6` already covers `inspect[].videos[]`.)
**Impact:** without `-Inspect`, output gains `"inspect": null` and nothing else changes; the root
report is first in the array (phase 1 adds the tab's session to `$pageSessions` first), as
`inspectSummary` expects. `Wait-Reply` returns `$null` after its time-out, and phase 1's
`$cts.CancelAfter(($Seconds + 60) * 1000)` bounds the whole run. With `-Inspect` the worst case
after the watch is bodies (8 x 3 s) + media state (12 x 1.5 s) + inspection (12 x 1.5 s) = 60 s,
exactly that margin, so 4b also widens it: put `if ($Inspect) { $cts.CancelAfter(($Seconds + 90) * 1000) }`
as the first line of the 4b insertion (phase 1's `sniffEmbed` time-out, `(seconds + 90) * 1000`,
still covers it because PowerShell starts after the call).

### Step 5: Pass `inspect` through `sniffEmbed`
**File:** `claude/streaming/direct/sniff.mjs` (as phase 1's plan writes it, `phase-1.md` Step 3)
**Change:** Two lines. In `sniffEmbed`, right after phase 1's
`const args = [ ... '-BotGrace', String(botGraceS), ];` (the array already carries `-Seconds`
from `options.seconds`), add:
```js
  if (options.inspect === true) args.push('-Inspect');
```
In `parseSniffReply`, phase 1 returns a newly built object ending with `hits: list(reply.hits),`;
add after that line (PowerShell may flatten a one-element array, which `list` undoes):
```js
    inspect: reply.inspect === null || reply.inspect === undefined ? null : list(reply.inspect),
```
**Impact:** phase 1's resolver never passes `inspect`, so `/direct-stream` and the daemon are
unchanged. Phase 1's unit tests keep passing (`inspect` is a new optional field). Run
`npx vitest run tests/unit/scripts/` after this step.

### Step 6: The live campaign (the phase session, on the owner's laptop)
**File:** `docs/plans/2026-11-15-direct-streaming-findings.md`, `claude/streaming/direct/providers.seed.json`
**Change:** This is the measured half. It needs the owner's Windows Chrome, the network and about
one to two hours of wall clock (24 providers × at most 35 s + 35 s + 90 s + 4 × 35 s, most far
less). Nothing is shown and nothing plays with sound. Run it in this order:

1. **Preconditions.** Steps 1–5 landed and `npx vitest run tests/unit/scripts/` passes.
   `node claude/streaming/direct/cli.mjs resolve movie 550` prints `"ok": true` (phase 1's live
   check). `curl -sI https://www.themoviedb.org/movie/1233413 | grep -i '^location'` names
   `1233413-sinners`; if not, pick a 2025 film's TMDB id and pass it as `--recent <id>` below.
2. **Start the lifetime watch first, detached**, so it overlaps the campaign and its one resolve
   does not share the Chrome with a probe:
   ```sh
   S=~/.local/state/notesd-direct-campaign; mkdir -p "$S"
   LOG="$S/lifetime-$(date -u +%Y%m%dT%H%M%SZ).jsonl"
   setsid nohup node claude/streaming/direct/campaign.mjs lifetime --log "$LOG" --max-min 420 > "$LOG.out" 2>&1 < /dev/null &
   ```
   Wait (Monitor, until-loop) until `grep -q '"event":"check"' "$LOG"`, then
   `node claude/streaming/direct/campaign.mjs lifetime-status "$LOG"` shows `checks: 1`. A
   `no_source` line means VidFast did not resolve: restart with `--provider` set to a provider the
   campaign shows resolving an HLS stream.
3. **Run the campaign** in the background:
   `node claude/streaming/direct/campaign.mjs run 2> "$S/run.log"`. It prints the results path
   and writes the findings tables. Exit 3 (`no_chrome`, `chrome_not_reachable`) means Chrome was
   not reachable: fix that, rerun.
4. **Read the raw results for every failure**, the spike's three first:
   `jq '.rows[] | select(.name=="Videasy") | {film: .film.raw, long: .long.raw, verdict}' <results.json>`.
   Confirm the named cause against the raw frames, hosts, hits and inspection. Where a finding
   demands a sniffer fix (for example: a manifest arrives under an address or mime type the
   sniffer's patterns miss, or a player frame is never attached), make the smallest change in
   `sniff.ps1` / `sniff.mjs`, keep `npx vitest run tests/unit/scripts/` passing, rerun only that
   provider with `run --only <name> --out "$S/rerun-<name>"`, and record the change under
   **Sniffer changes**. Never change the client to get past a bot check: `bot_check` stays a cause.
5. **Wait for the lifetime lower bound, bounded.** If the campaign finished before the watch's
   T+60 check, wait for it (Monitor until `grep -q '"minute":60' "$LOG"` or an `"event":"end"`
   line); never longer. The watch keeps running detached to T+420 (only HTTP requests from WSL);
   phase 6 refreshes the table from the same log.
6. **Write the tables and the seed:**
   ```sh
   node claude/streaming/direct/campaign.mjs report <results.json> [<rerun results.json>...] --lifetime "$LOG"
   node claude/streaming/direct/campaign.mjs apply-seed <results.json> [<rerun results.json>...]
   ```
7. **Fill every `_To fill`** in the findings: the three **Cause** / **Evidence** pairs, the
   episodes and lifetime **Reading** lines, and **Sniffer changes** (or "No other change."). Name
   the log path and the results paths in the text.
8. **Close:** `node claude/streaming/direct/campaign.mjs check` prints `"ok": true`; then
   `npm run typecheck`, `npm test`, `npm run docs:check`.

**Impact:** the seed's `tv`, `en_subtitle`, `browser_only` and `notes` now carry measured values,
so phase 1's resolver orders English-subtitle providers first from real data and skips
`blob_media` providers as `browser_only`. No code path changes.

## Principles applied

- Laziness protocol: the campaign drives phase 1's own `resolveTitle` with a one-provider list and a recording sniffer instead of re-implementing manifest classification, so "resolved" in the findings means what it means for `/direct-stream`.
- Build the lever: the findings tables are generated between markers and `campaign.mjs check` verifies the file and the seed agree, so the reviewer reruns `check` (and `report`) instead of trusting a hand-typed table of 24 rows; `apply-seed` writes the seed from the same results.
- Make illegal states unrepresentable: a failure's cause is one of the eight names in `CAUSES`, chosen by one ordered function (`diagnose`); free text cannot pass `check`, and `undiagnosed` (no inspection run) is rejected there.
- Fix root causes: "why three returned nothing" is answered from recorded evidence per cause (requests, frames, bot flag, long wait, clicks, `blob:` video), and the `-Inspect` switch exists because MSE-only media and an unattached frame cannot be told apart from network requests; a sniffer fix is made only when a finding demands it, and is recorded.
- Test behavior, not implementation: the unit test fakes only the outside world (Chrome sniff, fetch, clock) and runs the real resolver, asserting the rows, causes, templates, lifetime, findings and seed a reader sees.
- Sequence into verifiable units: Steps 1–5 end in `npm test`; the live Step 6 ends in `campaign.mjs check`.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npx vitest run tests/unit/scripts/directCampaign.test.ts tests/unit/scripts/` then `npm test` and `npm run docs:check`
**Proof:** the findings file and the seed are the artifact; the campaign is a script, so it is driven directly.
- Harness: `no harness`. `.claude/skills/verify-notesd` drives a throwaway daemon, and this phase touches no daemon code. Instead the campaign command is run against the real streaming Chrome (minimized, muted) and its outputs are checked with `campaign.mjs check`.
- Feature-map entries: none (nothing user-facing changes; the resolver's note in `features/streaming.md` is phase 1's)
- Journeys:
  - **J1** · traces R7.1, R7.2 — `npx vitest run tests/unit/scripts/directCampaign.test.ts` → passes when all tests pass, including "writes, for every one of the 24 seed providers, what it resolved or the named cause", "keeps an episode template only when it serves the episode and fails the control" and "measures how long a manifest keeps answering" (no network, no Chrome)
  - **J2** · traces R7.1, R7.2 — `node claude/streaming/direct/campaign.mjs check` → passes when it prints `"ok": true` and `"problems": []`: the findings' providers table has a row for each of the 24 seed providers that is either resolved (`kind · height · en|no en · s`) or names a cause from `CAUSES`; every seed provider with a `tv` template has the same template in the episodes table and vice versa; the lifetime table has a measured "Valid at least (min)"; the timings JSON names all 24 providers and has `token_lifetime.last_ok_min`; Videasy, VidKing and CloudPlay each have a named **Cause**; no `_To fill` is left
  - **J3** · traces R7.1 — `D=$(mktemp -d) && cp docs/plans/2026-11-15-direct-streaming-findings.md "$D/f.md" && node claude/streaming/direct/campaign.mjs run --only VidFast,VidKing --no-episodes --out "$D" --findings "$D/f.md" && grep -E '^\| (VidFast|VidKing) \|' "$D/f.md"` (live: the streaming Chrome on Windows, minimized, muted; about 1–3 minutes; free) → passes when the command prints `"ok": true, "providers": 2` and each grep line is either resolved (`hls · ...p · ... · N s`) or ends in a cause from `CAUSES` (VidKing: `bot_check` or another named cause), and `jq '.rows[0].film.node_fetch_status' "$D/results.json"` is `200` when VidFast resolved
  - **J4** · traces R7.2 — `D=$(mktemp -d) && node claude/streaming/direct/campaign.mjs lifetime --log "$D/l.jsonl" --max-min 2 && node claude/streaming/direct/campaign.mjs lifetime-status "$D/l.jsonl"` (live, about 2.5 minutes, HTTP only after one resolve) → passes when the status prints `"checks": 3`, `"last_ok_min": 2` and `"end_reason": "schedule_done"` (or a `first_failure_min` with the failing statuses, which is itself a measured lifetime), and `jq -c 'select(.event=="start") | .claimed_expiry' "$D/l.jsonl"` prints the claimed expiry or `null`
  - **J5** · traces R7.2 — `jq -r '.[] | select(.tv != null) | .name + " " + .tv' claude/streaming/direct/providers.seed.json` → passes when every printed template contains `{id}`, `{season}` and `{episode}` and each printed provider has that same template in the findings' "Series episodes" table (J2 checks the pairing mechanically)
- Neighbor check: phase 1's resolver after the sniffer change. `npx vitest run tests/unit/scripts/` passes (phase 1's tests and `streamingSites.test.ts`), and `node claude/streaming/direct/cli.mjs resolve movie 550` still prints `"ok": true` with a `source.provider` (live, minimized, no sound). Also `npm test` and `npm run docs:check` pass (no env var was added).
- Cost: no billed calls. J3, J4 and the neighbor check open tabs in the streaming Chrome (minimized, muted) and reach provider hosts; Step 6's full run takes one to two hours of wall clock.
**Exit criteria:** `campaign.mjs check` prints `"ok": true`; the findings file has a row for each of the 24 providers and the sections "Why three returned nothing" (each of the three with a named cause), "Series episodes" and "Token lifetime" with measured data; the seed carries the measured `tv`, `en_subtitle`, `browser_only` and `notes`; `npm run typecheck`, `npm test` and `npm run docs:check` pass.

## Handoffs

- **Phase 1:** the `-Inspect` switch and `inspect` option (Steps 4–5) edit phase 1's `sniff.ps1` and `sniff.mjs`; both steps quote phase 1's plan (`$pageSessions`, `Wait-Reply($id, $timeoutMs)`, the media-state block, `Close-Tab`, `parseSniffReply`'s object). Phase 1's tests must not pin the values of `tv`, `en_subtitle`, `browser_only` or `notes`.
- **Phase 8 (R4.1, reconciler):** `claude/streaming/direct/known-titles.json` is created here and is the one known-titles list; phase 8's `loadKnownTitles` reads the same file (shape `[{ label, kind, tmdb_id, season?, episode? }]`).
- **Phase 6 (R7.3):** owns the `## Playback` section, `playcheck.mjs` and `browser_only` for providers that resolve but do not play in our page. This phase sets `browser_only: true` only for `blob_media` (nothing our page could load). Phase 6 also refreshes the "Token lifetime" table from the detached watch's log, path recorded in the findings, with `campaign.mjs report <results.json> --lifetime <log>`, and records the forced-expiry check.
- **Phase 3:** session expiry and `refresh` should be set from the findings' measured token lifetime (the "Token lifetime" reading).
- **Phase 10 (R6.1):** reads the `campaign:timings` JSON block (schema in the Interface Contract; this schema is the contract) for its per-pass budget defaults: `resolve_s.p50` is its median resolve seconds and `fail_s.p50` its median failure seconds; the block has no "failed attempts before the one that resolved" figure, so phase 10 keeps the spike's 1 for it.
- **Phase 8 (R4.1):** may reuse `episodeTemplates` and the campaign's probe for new providers from `/update-cloud-source`; this phase does not build that.
- `claude/streaming/direct/` has no README or guide subsection for the campaign; the "Direct streaming" guide section is phase 3's (with "The resolver" from phase 1's draft) and its other subsections phases 4, 7, 8, 10's. No guide change is planned here.

## Rollback

Revert this phase's commits: `campaign.mjs`, its test and the findings file go; the seed returns to
phase 1's values (`tv: null`, `en_subtitle: null`, `browser_only: false`, `notes: ""`); `sniff.ps1`
and `sniff.mjs` lose `-Inspect` (inert without it). Stop a still-running watch with
`pkill -f 'campaign.mjs lifetime --log <that log>'` (only that exact command line). Raw results
in `~/.local/state/notesd-direct-campaign/` can be deleted; nothing reads them but this phase and
phase 6.
