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
const CLOUDFLARE_DOWN = /\b(Error code 52\d|52\d: )/;
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

// Two hosts of one provider (player.vidplus.to and player2.vidplus.pro) share a name label.
function relatedHosts(a, b) {
  const labels = (host) => host.split('.').filter((label) => label.length > 3);
  return labels(a).some((label) => labels(b).includes(label));
}

function inspectSummary(reports, embedUrl) {
  if (!Array.isArray(reports)) return null;
  const videos = reports.flatMap((report) => (Array.isArray(report?.videos) ? report.videos : []));
  const root = reports[0] ?? {};
  const rootUrl = String(root.url ?? '');
  // The tab ended on Chrome's own error page (DNS, time-out) or on Cloudflare's "origin is down" page.
  const errorPage = rootUrl.startsWith('chrome-error:') || CLOUDFLARE_DOWN.test(`${root.title ?? ''} ${root.text ?? ''}`);
  // The tab left the provider (an advert page took it over): what that page says is not the provider's answer.
  const away = !errorPage && hostOf(rootUrl) !== '' && hostOf(embedUrl) !== '' && !relatedHosts(hostOf(rootUrl), hostOf(embedUrl));
  return {
    error_page: errorPage,
    away,
    videos: videos.length,
    blob_videos: videos.filter((v) => String(v.src ?? '').startsWith('blob:') && Number(v.ready_state ?? 0) >= 1).length,
    started_videos: videos.filter((v) => Number(v.current_time ?? 0) > 0).length,
    root_iframes: Number(root.iframes ?? 0),
    title: String(root.title ?? '').slice(0, 80),
    text: reports
      .filter((report, index) => !(away && index === 0))
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
    inspect: inspectSummary(raw.inspect, String(raw.url ?? '')),
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
  if (evidence.some((e) => e.inspect?.error_page) || (evidence.length > 0 && evidence.every((e) => e.requests <= 1))) return fail('unreachable');
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
    // Smashy's shape (2026-11-19): its /tv/{id}/{season}/{episode} forwards to an address its player refuses.
    out.push(join(`${before}${after}`, add(query, 's={season}&e={episode}')));
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
  candidates = 4,
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

/**
 * The rows with their evidence and verdict worked out again from the raw sniffs they keep, so a
 * report always names causes by the current diagnose(), whenever the results were measured.
 */
export function rediagnose(results) {
  const again = (run) => (run ? { ...run, evidence: evidenceOf(run.raw) ?? run.evidence } : run);
  const rows = results.rows.map((row) => {
    const film = again(row.film);
    const recent = again(row.recent);
    const long = again(row.long);
    return { ...row, film, recent, long, verdict: diagnose({ name: row.name, standard: film, long, other: recent }) };
  });
  return { ...results, rows };
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
  const results = rediagnose(mergeResults(resultsFiles.map(readJson)));
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
        candidates: Number(flags.candidates ?? 4),
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
    const after = applySeed(before, rediagnose(mergeResults(positional.map(readJson))));
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
