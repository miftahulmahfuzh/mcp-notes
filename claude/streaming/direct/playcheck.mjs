#!/usr/bin/env node
// Playback probe for direct streaming. For one provider and one title it asks a throwaway daemon
// for a stream session, opens the session's player page in the streaming Chrome MUTED and in a
// NORMAL window (never full screen, never with sound), reads what the <video> does the way the
// spike's play.mjs did, and prints one JSON report with a verdict.
//
//   node playcheck.mjs setup --dir <state dir> [--gate-port 47399]
//   node playcheck.mjs run --daemon http://127.0.0.1:<port> --dir <state dir>
//        --check play|dash|vidnest|subtitle|expiry --provider <seed name> movie|tv <tmdbId> [season episode]
//        [--watch-s 15] [--timeout-s 90] [--expire-after-s 45] [--gate-port 47399] [--host 127.0.0.1|localhost]
//   node playcheck.mjs findings --dir <state dir> --file <findings.md>
//   node playcheck.mjs audit --file <findings.md> --seed <providers.seed.json>
//
// `setup` writes <dir>/cli.mjs, the resolver CLI the throwaway daemon runs (NOTESD_DIRECT_STREAM_CLI);
// see playgate.mjs. The live daemon on 7317 is refused.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { evaluateInChrome, sleep } from '../chrome.mjs';
import { NEXT_FILE, OPENED_FILE, startGate } from './playgate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A text track that is on. The player page keeps its tracks `hidden` and draws the lines itself; `showing` is a browser drawing them. */
const isOn = (mode) => mode === 'showing' || mode === 'hidden';

export const CHECKS = ['play', 'dash', 'vidnest', 'subtitle', 'expiry'];
/** A run counts as played when the video advanced this many seconds at a real resolution. */
export const MIN_ADVANCE_S = 10;
/** After a refresh the film may start up to this many seconds before where it stopped. */
export const RESUME_TOLERANCE_S = 10;
export const SAMPLE_MS = 1500;
export const DEFAULT_GATE_PORT = 47399;
export const RESULTS_FILE = 'results.jsonl';
export const BLOCK_BEGIN = '<!-- playcheck:begin -->';
export const BLOCK_END = '<!-- playcheck:end -->';
const DECIDED = ['plays', 'browser_only', 'needs_fix'];
const PLAYABLE_SEGMENTS = ['ts', 'id3', 'fmp4', 'aac'];
const NO_SOURCE_ATTEMPTS = 3;
const LIVE_DAEMON_PORT = '7317';

class UsageError extends Error {}

// What runs in the page. None of these starts playback or touches the sound.

export const GUARD_EXPRESSION = `(() => { const v = document.querySelector('video'); return { origin: location.origin, playing: Boolean(v && !v.paused && !v.ended) }; })()`;

export const STATE_EXPRESSION = `(() => {
  const v = document.querySelector('video');
  const w = window.notesdStream || null;
  const state = w ? { kind: w.kind ?? null, levels: w.levels ?? null, level: w.level ?? null, errors: w.errors ?? null, refreshes: w.refreshes ?? null } : null;
  const fullscreen = Boolean(document.fullscreenElement) || (innerWidth >= screen.width && innerHeight >= screen.height);
  if (!v) return { stage: 'no_video', origin: location.origin, state, fullscreen };
  const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : {};
  const b = v.buffered;
  const tracks = Array.from(v.textTracks || []).map((t) => ({ kind: t.kind, label: t.label, language: t.language, mode: t.mode, cues: t.cues ? t.cues.length : null, active_cues: t.activeCues ? t.activeCues.length : null }));
  return {
    stage: 'video', origin: location.origin,
    playing: !v.paused && !v.ended && v.currentTime > 0, paused: v.paused, t: Math.round(v.currentTime * 10) / 10,
    duration_s: Number.isFinite(v.duration) ? Math.round(v.duration) : null,
    w: v.videoWidth, h: v.videoHeight, muted: v.muted,
    frames: q.totalVideoFrames ?? null, dropped: q.droppedVideoFrames ?? null,
    buffered_s: b.length ? Math.round((b.end(b.length - 1) - v.currentTime) * 10) / 10 : 0,
    error: v.error ? { code: v.error.code, message: v.error.message } : null,
    tracks, state, fullscreen,
  };
})()`;

export const PAUSE_EXPRESSION = `(() => { const v = document.querySelector('video'); if (v) { v.muted = true; v.pause(); } return 'paused'; })()`;

export function navigateExpression(url) {
  return `location.assign(${JSON.stringify(url)}); 'navigating'`;
}

// Reading a manifest and a segment.

const round1 = (n) => Math.round(n * 10) / 10;
const uniqDesc = (xs) => [...new Set(xs)].sort((a, b) => b - a);

function attrs(text) {
  const out = {};
  for (const m of text.matchAll(/([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g)) out[m[1]] = m[3] ?? m[2];
  return out;
}

/** What a manifest says about encryption, DRM, subtitle tracks and heights. */
export function classifyManifest(text, kind) {
  if (kind === 'dash') {
    const drm = /<ContentProtection\b/i.test(text);
    const subtitles = [];
    for (const m of text.matchAll(/<AdaptationSet\b([^>]*)>/gi)) {
      const a = m[1];
      if (/contentType="text"|mimeType="(text\/vtt|application\/ttml\+xml)"/i.test(a)) {
        subtitles.push({ lang: /\blang="([^"]*)"/i.exec(a)?.[1] ?? '', label: /\blabel="([^"]*)"/i.exec(a)?.[1] ?? '' });
      }
    }
    const heights = [...text.matchAll(/<Representation\b[^>]*\bheight="(\d+)"/gi)].map((m) => Number(m[1]));
    return { kind: 'dash', encryption: drm ? 'cenc' : 'none', drm, key_formats: [], subtitles, heights: uniqDesc(heights) };
  }
  const keys = [...text.matchAll(/^#EXT-X-(?:SESSION-)?KEY:(.*)$/gm)].map((m) => attrs(m[1]));
  const live = keys.filter((k) => k.METHOD && k.METHOD !== 'NONE');
  const keyFormats = [...new Set(live.map((k) => k.KEYFORMAT ?? 'identity'))];
  const encryption = live.length === 0 ? 'none' : [...new Set(live.map((k) => k.METHOD.toLowerCase()))].join('+');
  const subtitles = [...text.matchAll(/^#EXT-X-MEDIA:(.*)$/gm)]
    .map((m) => attrs(m[1]))
    .filter((a) => a.TYPE === 'SUBTITLES')
    .map((a) => ({ lang: a.LANGUAGE ?? '', label: a.NAME ?? '' }));
  const heights = [...text.matchAll(/RESOLUTION=\d+x(\d+)/g)].map((m) => Number(m[1]));
  return { kind: 'hls', encryption, drm: keyFormats.some((f) => f !== 'identity'), key_formats: keyFormats, subtitles, heights: uniqDesc(heights) };
}

/** What the first bytes of a segment are. Anything not a media container is a disguised or scrambled segment. */
export function segmentFormat(bytes) {
  const b = bytes;
  const ascii = (i, n) => String.fromCharCode(...b.slice(i, i + n));
  let format = 'unknown';
  if (b[0] === 0x47 && (b.length < 189 || b[188] === 0x47)) format = 'ts';
  else if (ascii(0, 3) === 'ID3') format = 'id3';
  else if (['ftyp', 'styp', 'moof', 'sidx', 'moov'].includes(ascii(4, 4))) format = 'fmp4';
  else if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) format = 'aac';
  else if (b[0] === 0x89 && ascii(1, 3) === 'PNG') format = 'disguised_png';
  else if (b[0] === 0xff && b[1] === 0xd8) format = 'disguised_jpeg';
  else if (ascii(0, 4) === 'GIF8') format = 'disguised_gif';
  return { format, head: Buffer.from(b.slice(0, 8)).toString('hex') };
}

function firstUriAfter(text, tag) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const at = lines.findIndex((l) => l.startsWith(tag));
  if (at === -1) return null;
  return lines.slice(at + 1).find((l) => l !== '' && !l.startsWith('#')) ?? null;
}

/** Reads the manifest (and for HLS the first variant and the head of its first segment) through the daemon's pass-through. */
export async function inspectStream(deps, manifestUrl, kind) {
  const master = await deps.fetchText(manifestUrl);
  if (!master.ok) return { manifest: null, segment: null, manifest_status: master.status };
  if (kind === 'dash') return { manifest: classifyManifest(master.text, 'dash'), segment: null, manifest_status: master.status };
  let media = master.text;
  let mediaUrl = manifestUrl;
  const variant = /#EXT-X-STREAM-INF/.test(master.text) ? firstUriAfter(master.text, '#EXT-X-STREAM-INF') : null;
  if (variant) {
    mediaUrl = new URL(variant, manifestUrl).href;
    const v = await deps.fetchText(mediaUrl);
    media = v.ok ? v.text : '';
  }
  const segUri = firstUriAfter(media, '#EXTINF');
  const segment = segUri ? segmentFormat(await deps.fetchHead(new URL(segUri, mediaUrl).href)) : null;
  const text = media === master.text ? master.text : `${master.text}\n${media}`;
  return { manifest: classifyManifest(text, 'hls'), segment, manifest_status: master.status };
}

// Deciding.

export function isEnglish(track) {
  const lang = String(track?.lang ?? track?.language ?? '').toLowerCase();
  return lang === 'en' || lang === 'eng' || lang.startsWith('en-') || /english/i.test(String(track?.label ?? ''));
}

function englishOffered(r) {
  return (r.session?.subtitles ?? []).some(isEnglish) || (r.manifest?.subtitles ?? []).some(isEnglish);
}

function subtitleSource(r) {
  const separate = (r.session?.subtitles ?? []).some(isEnglish);
  const inManifest = (r.manifest?.subtitles ?? []).some(isEnglish);
  if (separate && inManifest) return 'separate+manifest';
  if (inManifest) return 'manifest';
  return separate ? 'separate' : 'none';
}

/** The named reason a stream cannot be played outside its own page, or null when there is none. */
export function browserOnlyCause(manifest, segment, errors) {
  if (manifest?.drm) return 'drm';
  if (manifest && !['none', 'aes-128'].includes(manifest.encryption)) return 'encrypted_segments';
  if (errors.some((e) => /keyLoad|keySystem|KEY_SYSTEM|EME|MEDIA_KEYERR|protection/i.test(e))) {
    return manifest?.encryption === 'aes-128' ? 'encrypted_segments' : 'drm';
  }
  if (segment && !PLAYABLE_SEGMENTS.includes(segment.format)) return 'obfuscated_segments';
  return null;
}

/** One summary of the samples a run took. t0: when the play was asked for (ms). */
export function summarize(samples, t0) {
  const video = samples.filter((s) => s.stage === 'video');
  const playing = video.filter((s) => s.playing);
  const first = playing[0] ?? null;
  const last = video.at(-1) ?? null;
  const errors = [
    ...new Set(video.flatMap((s) => [...(s.state?.errors ?? []), ...(s.error ? [`video error ${s.error.code}: ${s.error.message}`] : [])])),
  ];
  const tracks = last?.tracks ?? [];
  const english = tracks.filter(isEnglish).sort((a, b) => Number(isOn(b.mode)) - Number(isOn(a.mode)))[0] ?? null;
  return {
    seconds_to_first_frame: first ? round1((first.at - t0) / 1000) : null,
    advanced_s: first ? round1(Math.max(...playing.map((s) => s.t)) - first.t) : 0,
    playing_at_end: last?.playing === true,
    width: last?.w ?? null,
    height: last?.h ?? null,
    best_height: video.length ? Math.max(...video.map((s) => s.h ?? 0)) : null,
    frames: last?.frames ?? null,
    dropped: last?.dropped ?? null,
    buffered_s: last?.buffered_s ?? null,
    kind: last?.state?.kind ?? null,
    levels: last?.state?.levels ?? null,
    refreshes: last?.state?.refreshes ?? null,
    english_track: english ? { label: english.label, language: english.language, mode: english.mode, cues: english.cues, active_cues: english.active_cues } : null,
    text_tracks: tracks.length,
    muted_always: video.every((s) => s.muted === true),
    fullscreen_ever: samples.some((s) => s.fullscreen === true),
    errors,
  };
}

/**
 * The verdict of one run, by fixed rules:
 * - inconclusive: the run could not look (Chrome, the tab, the daemon, the session, a stop for
 *   sound or full screen), the check did not apply (a DASH check served HLS, no English track
 *   offered), or the expiry was never reached. Run it again; it decides nothing.
 * - no_source: the provider did not resolve this time. Not browser_only.
 * - plays: the video advanced MIN_ADVANCE_S at a real height and is playing at the end; a
 *   subtitle check also needs an English track showing with cues; an expiry check needs the
 *   first source refused, a second resolve served, and playback continuing near where it stopped.
 * - browser_only: it did not play, and the manifest, the first segment or the player's errors
 *   name a cause no pass-through can remove: drm, encrypted_segments, obfuscated_segments.
 * - needs_fix: it did not play (or the subtitle or the refresh failed) with no such cause: the
 *   fault is ours until shown otherwise.
 */
export function decide(check, r) {
  if (r.error) return { verdict: 'inconclusive', cause: r.error };
  if (!r.play?.ok) {
    if (r.play?.error === 'no_source') return { verdict: 'no_source', cause: 'no_source' };
    return { verdict: 'inconclusive', cause: r.play?.error ?? `play answered HTTP ${r.play?.status ?? 'nothing'}` };
  }
  if (check === 'dash' && r.session?.manifest_kind !== 'dash') return { verdict: 'inconclusive', cause: `not_dash (${r.session?.manifest_kind ?? 'no session'})` };
  if (check === 'expiry') {
    const e = r.expiry;
    if (!e || e.first_refused === 0) return { verdict: 'inconclusive', cause: 'expiry_not_reached' };
    if (!e.refreshed) return { verdict: 'needs_fix', cause: 'no_refresh' };
    if (e.restarted) return { verdict: 'needs_fix', cause: 'restarted_from_start' };
    if (!e.resumed) return { verdict: 'needs_fix', cause: 'stalled_after_refresh' };
    return { verdict: 'plays', cause: null };
  }
  const s = r.summary;
  const played = Boolean(s && s.playing_at_end && s.advanced_s >= MIN_ADVANCE_S && (s.height ?? 0) > 0);
  if (!played) {
    const cause = browserOnlyCause(r.manifest, r.segment, s?.errors ?? []);
    return cause ? { verdict: 'browser_only', cause } : { verdict: 'needs_fix', cause: s?.errors?.[0] ?? 'no_progress' };
  }
  if (check === 'subtitle') {
    if (!englishOffered(r)) return { verdict: 'inconclusive', cause: 'no_english_offered' };
    const t = s.english_track;
    if (t && isOn(t.mode) && (t.cues ?? 0) > 0) return { verdict: 'plays', cause: null };
    return { verdict: 'needs_fix', cause: t ? `english_track_${t.mode}_${t.cues ?? 0}_cues` : 'english_track_missing' };
  }
  return { verdict: 'plays', cause: null };
}

function finish(report, error = null, detail = null) {
  if (error) {
    report.error = error;
    report.detail = detail;
  }
  const { verdict, cause } = decide(report.check, report);
  report.verdict = verdict;
  report.cause = cause;
  report.subtitle_source = subtitleSource(report);
  return report;
}

// Running.

function chromeOriginFor(daemon, host) {
  const u = new URL(daemon);
  if (host) u.hostname = host;
  return u.origin;
}

function sessionIdFromUrl(url) {
  try {
    return /\/stream\/([A-Za-z0-9_-]+)/.exec(new URL(url).pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Samples the page every SAMPLE_MS until done(samples), a safety stop, or timeoutS. */
async function watch(deps, origin, timeoutS, done) {
  const samples = [];
  const start = deps.now();
  while (deps.now() - start < timeoutS * 1000) {
    await deps.sleep(SAMPLE_MS);
    let s;
    try {
      s = await deps.evaluate(origin, STATE_EXPRESSION, { timeoutS: 20 });
    } catch (err) {
      s = { stage: 'eval_error', error: String(err?.message ?? err) };
    }
    const sample = { ...(s ?? { stage: 'empty' }), at: deps.now() };
    samples.push(sample);
    if (sample.stage === 'video' && sample.muted !== true && sample.paused === false) return { samples, stop: 'not_muted' };
    if (sample.fullscreen === true) return { samples, stop: 'went_full_screen' };
    if (done(samples)) return { samples, stop: null };
  }
  return { samples, stop: null };
}

function maxPlayingT(samples) {
  const ts = samples.filter((s) => s.stage === 'video' && s.playing).map((s) => s.t);
  return ts.length ? Math.max(...ts) : 0;
}

/** Phase A: play until the gate refuses the first source. Phase B: until the second source plays on. */
async function watchExpiry(deps, origin, gate, opts) {
  const tok = (n) => gate.stats().tokens.find((t) => t.n === n);
  const a = await watch(deps, origin, opts.expireAfterS + 90, () => (tok(1)?.refused ?? 0) > 0);
  const tBefore = maxPlayingT(a.samples);
  const reached = (tok(1)?.refused ?? 0) > 0;
  let b = { samples: [], stop: null };
  if (!a.stop && reached) {
    b = await watch(deps, origin, 120, (samples) => {
      const two = samples.slice(-2);
      return (tok(2)?.served ?? 0) >= 3 && two.length === 2 && two.every((s) => s.playing) && two[1].t > two[0].t && two[1].t > tBefore;
    });
  }
  const after = b.samples.filter((s) => s.stage === 'video' && s.playing);
  const tMinAfter = after.length ? Math.min(...after.map((s) => s.t)) : null;
  const last = b.samples.at(-1) ?? null;
  const refreshed = gate.stats().tokens.length >= 2 && (tok(2)?.served ?? 0) > 0;
  const restarted = tMinAfter !== null && tMinAfter < tBefore - RESUME_TOLERANCE_S;
  return {
    samples: [...a.samples, ...b.samples],
    stop: a.stop ?? b.stop ?? null,
    expiry: {
      expire_after_s: opts.expireAfterS,
      first_refused: tok(1)?.refused ?? 0,
      second_served: tok(2)?.served ?? 0,
      tokens: gate.stats().tokens.length,
      t_before: tBefore,
      t_min_after: tMinAfter,
      t_end: last?.t ?? null,
      refreshes: last?.state?.refreshes ?? null,
      refreshed,
      restarted,
      resumed: refreshed && !restarted && last?.playing === true && (last?.t ?? 0) > tBefore,
    },
  };
}

/**
 * One check of one provider. opts: { daemon, dir, check, provider, ref, watchS, timeoutS,
 * expireAfterS, gatePort, host }. deps: { now, sleep, evaluate, fetchJson, fetchText, fetchHead,
 * readOpened, writeNext, startGate }.
 */
export async function runCheck(opts, deps) {
  const { daemon, check, provider, ref } = opts;
  const chromeOrigin = chromeOriginFor(daemon, opts.host);
  const report = {
    check, provider, ref, at: new Date(deps.now()).toISOString(), chrome_origin: chromeOrigin,
    error: null, detail: null, verdict: null, cause: null, play: null, session_id: null, session: null,
    manifest: null, segment: null, manifest_status: null, subtitle_source: null, summary: null, expiry: null, samples: [],
  };
  let gate = null;
  let navigated = false;
  try {
    await deps.writeNext({ only: provider });
    if (check === 'expiry') gate = await deps.startGate({ port: opts.gatePort, expireAfterS: opts.expireAfterS });
    let guard;
    try {
      guard = await deps.evaluate(chromeOrigin, GUARD_EXPRESSION, { timeoutS: 30 });
    } catch (err) {
      return finish(report, err?.code === 'no_tab' ? 'daemon_not_reachable_from_windows' : (err?.code ?? 'chrome_failed'), String(err?.message ?? err));
    }
    if (guard?.origin !== chromeOrigin && guard?.playing) return finish(report, 'foreign_tab_playing', guard.origin);
    const openedBefore = (await deps.readOpened()).length;
    const t0 = deps.now();
    const body = ref.kind === 'tv' ? { kind: 'tv', tmdb_id: ref.tmdbId, season: ref.season, episode: ref.episode } : { kind: 'movie', tmdb_id: ref.tmdbId };
    const play = await deps.fetchJson(`${daemon}/api/stream/play`, { method: 'POST', body });
    report.play = { ok: play.ok, status: play.status, error: play.body?.error ?? null, attempts: play.body?.attempts ?? null };
    if (!play.ok) return finish(report);
    const opened = await deps.readOpened();
    const sessionId = opened.length > openedBefore ? sessionIdFromUrl(opened.at(-1)?.url) : null;
    if (!sessionId) return finish(report, 'no_open_recorded', 'the daemon answered the play but did not run the CLI open command with a /stream/<id> address');
    report.session_id = sessionId;
    const session = await deps.fetchJson(`${daemon}/api/stream/sessions/${sessionId}`, {});
    if (!session.ok || !session.body?.manifest_url) return finish(report, 'session_unreadable', `HTTP ${session.status}`);
    report.session = {
      manifest_kind: session.body.manifest_kind,
      subtitles: (session.body.subtitles ?? []).map(({ lang, label }) => ({ lang, label })),
      resume_s: session.body.resume_s ?? null,
    };
    Object.assign(report, await inspectStream(deps, new URL(session.body.manifest_url, daemon).href, session.body.manifest_kind));
    await deps.evaluate(chromeOrigin, navigateExpression(`${chromeOrigin}/stream/${sessionId}?muted=1`), { show: true, windowState: 'normal', timeoutS: 30 });
    navigated = true;
    if (check === 'expiry') {
      const watched = await watchExpiry(deps, chromeOrigin, gate, opts);
      report.samples = watched.samples;
      report.expiry = watched.expiry;
      report.error = watched.stop;
    } else {
      const offered = englishOffered(report);
      const watched = await watch(deps, chromeOrigin, opts.timeoutS, (samples) => {
        const s = summarize(samples, t0);
        return s.advanced_s >= opts.watchS && (check !== 'subtitle' || !offered || (s.english_track?.cues ?? 0) > 0);
      });
      report.samples = watched.samples;
      report.error = watched.stop;
    }
    report.summary = summarize(report.samples, t0);
    return finish(report);
  } catch (err) {
    return finish(report, report.error ?? 'playcheck_failed', String(err?.message ?? err));
  } finally {
    if (navigated) await deps.evaluate(chromeOrigin, PAUSE_EXPRESSION, { timeoutS: 20 }).catch(() => {});
    if (gate) await gate.close();
  }
}

// The findings block.

function refLabel(ref) {
  return ref?.kind === 'tv' ? `tv ${ref.tmdbId} S${ref.season}E${ref.episode}` : `movie ${ref?.tmdbId}`;
}

/** The generated table: the latest result per check and provider, with how many runs it took. */
export function renderBlock(results) {
  const groups = new Map();
  for (const r of results) {
    const key = `${r.check}|${r.provider}`;
    const g = groups.get(key) ?? { latest: r, attempts: 0 };
    g.attempts += 1;
    g.latest = r;
    groups.set(key, g);
  }
  const rows = [...groups.values()].sort(
    (a, b) => CHECKS.indexOf(a.latest.check) - CHECKS.indexOf(b.latest.check) || a.latest.provider.localeCompare(b.latest.provider),
  );
  const data = rows.map(({ latest: r, attempts }) => ({ check: r.check, provider: r.provider, verdict: r.verdict, cause: r.cause, attempts, at: r.at }));
  const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  const line = ({ latest: r, attempts }) => {
    const s = r.summary ?? {};
    const t = s.english_track;
    const video = s.width && s.height ? `${s.width}x${s.height}` : '';
    const sub = `${r.subtitle_source ?? 'none'}${t ? `: ${t.label || t.language} ${t.mode}, ${t.cues ?? 0} cues` : ''}`;
    const levels = (s.levels ?? r.manifest?.heights ?? []).join(' ');
    const expiry = r.expiry ? `refused ${r.expiry.first_refused}, refreshed ${r.expiry.refreshed}, on at ${r.expiry.t_min_after ?? '-'} s (stopped at ${r.expiry.t_before} s)` : '';
    const frames = s.frames == null ? '' : `${s.dropped ?? 0}/${s.frames}`;
    const cells = [r.check, r.provider, refLabel(r.ref), `**${r.verdict}**`, r.cause, r.session?.manifest_kind, video, s.advanced_s, s.seconds_to_first_frame, frames, s.buffered_s, sub, levels, expiry, attempts, String(r.at).slice(0, 16)];
    return `| ${cells.map(cell).join(' | ')} |`;
  };
  return [
    BLOCK_BEGIN,
    `<!-- playcheck:rows ${JSON.stringify(data).replace(/--/g, '-\\u002d')} -->`,
    '',
    '| Check | Provider | Title | Verdict | Cause | Kind | Video | Played s | First frame s | Dropped/frames | Buffered s | English subtitle | Levels | Expiry | Runs | When (UTC) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(line),
    '',
    BLOCK_END,
  ].join('\n');
}

/** The findings text with the block replaced, or placed under `## Playback`, or appended with that heading. */
export function replaceBlock(markdown, block) {
  const b = markdown.indexOf(BLOCK_BEGIN);
  const e = markdown.indexOf(BLOCK_END);
  if (b !== -1 && e > b) return markdown.slice(0, b) + block + markdown.slice(e + BLOCK_END.length);
  const heading = /^## Playback[^\n]*$/m.exec(markdown);
  if (heading) {
    const at = heading.index + heading[0].length;
    return `${markdown.slice(0, at)}\n\n${block}${markdown.slice(at)}`;
  }
  return `${markdown.replace(/\s*$/, '')}\n\n## Playback\n\n${block}\n`;
}

/** What is missing for R7.3: a decided row per check, browser_only rows marked in the seed, needs_fix rows in the Fixes table. */
export function auditFindings(markdown, seed) {
  const m = /<!-- playcheck:rows (.*?) -->/s.exec(markdown);
  if (!m) return ['the findings file has no playcheck block under ## Playback (run playcheck.mjs findings)'];
  const rows = JSON.parse(m[1]);
  const problems = [];
  for (const check of ['dash', 'vidnest', 'subtitle', 'expiry']) {
    const ok = rows.some((r) => r.check === check && (DECIDED.includes(r.verdict) || (r.verdict === 'no_source' && r.attempts >= NO_SOURCE_ATTEMPTS)));
    if (!ok) problems.push(`the ${check} check has no decided result (plays, browser_only, needs_fix, or no_source after ${NO_SOURCE_ATTEMPTS} runs)`);
  }
  const byName = new Map(seed.map((p) => [p.name, p]));
  for (const r of rows) {
    if (r.verdict === 'browser_only' && byName.get(r.provider)?.browser_only !== true) {
      problems.push(`${r.provider} is browser_only in the findings but browser_only is not true in the seed`);
    }
    if (r.verdict === 'needs_fix' && !markdown.includes(`| ${r.check}/${r.provider} |`)) {
      problems.push(`${r.check}/${r.provider} needs a fix but has no row in the Fixes table`);
    }
  }
  return problems;
}

// The command line.

/** Writes <dir>/cli.mjs (the resolver CLI the throwaway daemon runs), next.json and opened.jsonl. */
export async function setup({ dir, gatePort }) {
  const abs = path.resolve(dir);
  await mkdir(abs, { recursive: true });
  const cli = path.join(abs, 'cli.mjs');
  const config = { cli: path.join(HERE, 'cli.mjs'), dir: abs, gate: `http://127.0.0.1:${gatePort}` };
  await writeFile(
    cli,
    [
      '// Written by playcheck.mjs setup: the resolver CLI a playcheck daemon runs in place of',
      '// claude/streaming/direct/cli.mjs. It never opens Chrome; see playgate.mjs.',
      `import { wrapperMain } from ${JSON.stringify(pathToFileURL(path.join(HERE, 'playgate.mjs')).href)};`,
      `process.exitCode = await wrapperMain(${JSON.stringify(config)}, process.argv.slice(2));`,
      '',
    ].join('\n'),
  );
  await writeFile(path.join(abs, NEXT_FILE), '{ "only": null }\n');
  await writeFile(path.join(abs, OPENED_FILE), '', { flag: 'a' });
  return { ok: true, dir: abs, cli, env: { NOTESD_DIRECT_STREAM: 'on', NOTESD_DIRECT_STREAM_CLI: cli } };
}

const RUN_OPTIONS = {
  daemon: { type: 'string' },
  dir: { type: 'string' },
  check: { type: 'string' },
  provider: { type: 'string' },
  'watch-s': { type: 'string', default: '15' },
  'timeout-s': { type: 'string', default: '90' },
  'expire-after-s': { type: 'string', default: '45' },
  'gate-port': { type: 'string', default: String(DEFAULT_GATE_PORT) },
  host: { type: 'string' },
};

/** The run arguments, checked once; runCheck trusts what this returns. */
export function parseRunArgs(args) {
  const { values: v, positionals: p } = parseArgs({ args, options: RUN_OPTIONS, allowPositionals: true });
  const fail = (message) => {
    throw new UsageError(message);
  };
  const daemon = String(v.daemon ?? '').replace(/\/$/, '');
  const d = /^http:\/\/(127\.0\.0\.1|localhost):(\d+)$/.exec(daemon);
  if (!d) fail('--daemon http://127.0.0.1:<port> is required (the URL verify.sh up printed)');
  if (d[2] === LIVE_DAEMON_PORT) fail('playcheck never drives the live daemon on 7317');
  if (!v.dir) fail('--dir is required (the folder setup wrote)');
  if (!CHECKS.includes(v.check)) fail(`--check must be one of ${CHECKS.join(', ')}`);
  if (!v.provider) fail('--provider <seed name> is required');
  if (v.check === 'vidnest' && v.provider !== 'VidNest') fail('--check vidnest plays the VidNest provider');
  if (v.host !== undefined && v.host !== '127.0.0.1' && v.host !== 'localhost') fail('--host is 127.0.0.1 or localhost');
  const int = (x, name) => {
    const n = Number(x);
    if (x === undefined || !Number.isInteger(n) || n < 0) fail(`${name} must be a whole number`);
    return n;
  };
  const [kind, id, season, episode] = p;
  if (kind !== 'movie' && kind !== 'tv') fail('the title is <movie|tv> <tmdbId> [season episode]');
  const ref = kind === 'tv'
    ? { kind, tmdbId: int(id, 'tmdbId'), season: int(season, 'season'), episode: int(episode, 'episode') }
    : { kind, tmdbId: int(id, 'tmdbId') };
  return {
    daemon,
    dir: path.resolve(v.dir),
    check: v.check,
    provider: v.provider,
    ref,
    watchS: int(v['watch-s'], '--watch-s'),
    timeoutS: int(v['timeout-s'], '--timeout-s'),
    expireAfterS: int(v['expire-after-s'], '--expire-after-s'),
    gatePort: int(v['gate-port'], '--gate-port'),
    host: v.host ?? null,
  };
}

async function fetchJson(url, { method = 'GET', body } = {}) {
  const headers = { origin: new URL(url).origin };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

async function fetchText(url) {
  const res = await fetch(url);
  return { ok: res.ok, status: res.status, text: res.ok ? await res.text() : '' };
}

async function fetchHead(url) {
  const res = await fetch(url, { headers: { range: 'bytes=0-511' } });
  const reader = res.body?.getReader();
  const chunks = [];
  let size = 0;
  while (reader && size < 512) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader?.cancel().catch(() => {});
  return new Uint8Array(Buffer.concat(chunks).subarray(0, 512));
}

function defaultDeps(dir) {
  return {
    now: Date.now,
    sleep,
    evaluate: evaluateInChrome,
    fetchJson,
    fetchText,
    fetchHead,
    readOpened: async () =>
      (await readFile(path.join(dir, OPENED_FILE), 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    writeNext: (next) => writeFile(path.join(dir, NEXT_FILE), `${JSON.stringify(next)}\n`),
    startGate,
  };
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  return 0;
}

const USAGE = 'usage: playcheck.mjs setup|run|findings|audit (see the comment at the top of the file)';

export async function main(argv) {
  const [command, ...args] = argv;
  try {
    if (command === 'setup') {
      const { values } = parseArgs({ args, options: { dir: { type: 'string' }, 'gate-port': { type: 'string', default: String(DEFAULT_GATE_PORT) } } });
      if (!values.dir) throw new UsageError('--dir is required');
      return print(await setup({ dir: values.dir, gatePort: Number(values['gate-port']) }));
    }
    if (command === 'run') {
      const opts = parseRunArgs(args);
      const report = await runCheck(opts, defaultDeps(opts.dir));
      await appendFile(path.join(opts.dir, RESULTS_FILE), `${JSON.stringify(report)}\n`);
      return print({ ...report, samples: report.samples.length });
    }
    if (command === 'findings') {
      const { values } = parseArgs({ args, options: { dir: { type: 'string' }, file: { type: 'string' } } });
      if (!values.dir || !values.file) throw new UsageError('findings needs --dir and --file');
      const results = (await readFile(path.join(values.dir, RESULTS_FILE), 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (results.length === 0) throw new UsageError(`no results in ${path.join(values.dir, RESULTS_FILE)}`);
      const markdown = await readFile(values.file, 'utf8');
      await writeFile(values.file, replaceBlock(markdown, renderBlock(results)));
      return print({ ok: true, file: values.file, results: results.length });
    }
    if (command === 'audit') {
      const { values } = parseArgs({ args, options: { file: { type: 'string' }, seed: { type: 'string' } } });
      if (!values.file || !values.seed) throw new UsageError('audit needs --file and --seed');
      const problems = auditFindings(await readFile(values.file, 'utf8'), JSON.parse(await readFile(values.seed, 'utf8')));
      print({ ok: problems.length === 0, problems });
      return problems.length === 0 ? 0 : 1;
    }
    throw new UsageError(USAGE);
  } catch (err) {
    if (err instanceof UsageError) {
      print({ ok: false, error: 'usage', detail: err.message });
      return 1;
    }
    throw err;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
