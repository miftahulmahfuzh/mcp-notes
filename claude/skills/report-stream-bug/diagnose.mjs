#!/usr/bin/env node
/**
 * /report-stream-bug's reading of an evidence folder: what it holds, what is missing, and which known
 * cause it matches. The known-causes table in SKILL.md is RULES below in prose; change both together,
 * with a fixture folder under tests/fixtures/stream-report/<cause>/ and its test.
 *   diagnose.mjs classify DIR          one JSON object: cause, label, signals
 *   diagnose.mjs summary DIR           the text collect.sh prints and saves as summary.txt
 *   diagnose.mjs note DIR [what seen]  a plain-text note body whose last line carries #stream-bug
 *   diagnose.mjs session-id DIR        the session id the folder is about, or nothing
 *   diagnose.mjs top-host DIR          the stream host most of the session's answers came from, or nothing
 *   diagnose.mjs torrent-hash DIR      the info hash of the torrent the session plays from, or nothing
 *   diagnose.mjs torrent-sample FILE   one line of torrent.json from the torrent route's answer in FILE
 *   diagnose.mjs answer-dir FILE       the folder a snapshot answer names, or nothing
 * Times in the evidence are UTC.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * PHASE-1 CONTRACT (fields and files): every name phase 1's evidence log, snapshot folder and routes
 * use (src/directStream/evidence.ts), and the name of phase 4's report marker, in this one place.
 * Nothing else in this skill names one (collect.sh holds the routes).
 */
export const FIELDS = {
  files: { session: 'session.json', evidence: 'evidence.jsonl', player: 'player.json', report: 'report.json' },
  /** One line of stream-evidence-<host>.jsonl, of a snapshot's evidence.jsonl, and of GET /api/stream/evidence's `records`. */
  record: {
    type: 'type',
    at: 'at',
    session: 'session',
    host: 'stream_host',
    path: 'path',
    status: 'status',
    answer: 'answer',
    ttfbMs: 'ttfb_ms',
    bytes: 'bytes',
    durationMs: 'duration_ms',
    kbps: 'kbps',
    outcome: 'outcome',
    error: 'error',
    text: 'text',
    ref: 'ref',
    provider: 'provider',
    attempts: 'attempts',
    refreshes: 'refreshes',
  },
  /** `type`: a pass-through answer, a page line, a session made / refreshed / whose refresh failed. */
  types: { request: 'request', player: 'player', session: 'session' },
  /** `outcome` values of a failed answer (`aborted` is the player going away, e.g. a seek: not a failure). */
  failedOutcomes: ['error', 'refused'],
  /** GET /api/stream/evidence answers `{host, file, records}`. */
  evidenceList: 'records',
  /** session.json: `{session_id, host, taken_at, live, source, sessions}`; `source` is null once the session ended. */
  snapshot: { id: 'session_id', live: 'live', source: 'source', sessions: 'sessions' },
  /** session.json's `source` (phase 1's SessionSource; `cache` {id, state} is added by phase 6 for a play from the cache). */
  source: { ref: 'ref', provider: 'provider', attempts: 'attempts', hosts: 'hosts', refreshes: 'refreshes', cache: 'cache', torrent: 'torrent' },
  /** GET /api/stream/torrent/<info hash>: the fields a sample keeps (never `file_url`). */
  torrent: ['state', 'progress', 'bytes_done', 'file_length', 'duration_s', 'peers', 'down_kbps', 'in_swarm', 'error'],
  /** player.json: `{session_id, lines: [player records]}`. */
  player: { list: 'lines' },
  /** report.json (phase 4's report button): the page's own view, the only copy of it once the session had ended. */
  report: { id: 'session_id', page: 'page', title: 'title', error: 'error', errors: 'errors', log: 'log' },
  /** POST /api/stream/evidence/snapshot's answer: `{ok, dir, session_id, complete, records, player_lines}`. */
  snapshotAnswer: { dir: 'dir', session: 'session_id', complete: 'complete' },
};

/** The files collect.sh itself writes into the folder. */
export const COLLECTED = {
  answer: 'snapshot-answer.json',
  latest: 'evidence-latest.json',
  tail: 'evidence-tail.jsonl',
  network: 'network.json',
  daemonLog: 'notesd.log',
  /** One JSON line per sample of the session's torrent, a few seconds apart: `{at, state, bytes_done, peers, down_kbps, ...}`. */
  torrent: 'torrent.jsonl',
  missing: 'missing.txt',
};

export const CAUSES = {
  connection_slow: 'This connection is slow',
  host_slow: 'The stream host is slow or far',
  token_expired: 'The token expired',
  provider_broken: "The provider's stream is broken",
  session_ended: 'The session ended',
  torrent_swarm_slow: 'The torrent swarm is slow or thin',
  new: 'New: not in the known causes',
};

export const THRESHOLDS = {
  /** A reference download under this is a slow connection: a 1080p stream needs about 5 Mbps. */
  referenceSlowMbps: 5,
  /** The stream host's median rate over media answers under this is a slow host. */
  hostSlowMbps: 3,
  /** ... or under this share of the reference. */
  hostToReference: 0.25,
  /** A first byte slower than this (median during the play, or the host's root now) is a far host. */
  farMs: 1500,
  /** An answer at least this big is media; playlists and keys are left out of the rate. */
  mediaBytes: 262_144,
  /** The player gives up after this many refreshes on one page. */
  maxRefreshes: 3,
  /** A swarm must deliver this many times the film's bitrate to play without stalls (the start, seeks and bursts need headroom). */
  swarmHeadroom: 1.5,
  /** A swarm with this many peers or fewer is thin: one of them leaving shows on screen. */
  fewPeers: 5,
  /** A step of a play (an index, a torrent's file list and header, a subtitle tier) that took this long is named in the summary. */
  slowStepS: 5,
};

const R = FIELDS.record;
const SRC = FIELDS.source;
const AUTH_REFUSED = new Set([401, 403, 410]);
const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v !== '' ? v : null);
const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s !== '') : []);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validId = (v) => (typeof v === 'string' && SESSION_ID.test(v) ? v : null);
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const statusOf = (r) => num(r[R.status]);
const errorOf = (r) => str(r[R.error]);
const tsOf = (r) => {
  const t = Date.parse(r[R.at]);
  return Number.isNaN(t) ? null : t;
};
const where = (r) => `${str(r[R.host]) ?? '?'}${str(r[R.path]) ?? ''}`;
const when = (r) => str(r[R.at]) ?? 'an unknown time';
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return '?';
  }
};

export function median(values) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** A request record's rate in Mbps, from `kbps`, else bytes over duration; null when neither is there. */
export function rateMbps(record) {
  const kbps = num(record[R.kbps]);
  if (kbps !== null) return round(kbps / 1000);
  const bytes = num(record[R.bytes]);
  const ms = num(record[R.durationMs]);
  return bytes !== null && ms !== null && ms > 0 ? round((bytes * 8) / (ms / 1000) / 1e6) : null;
}

/** A pass-through answer (not a page line, not a session record). */
function isPass(r) {
  return r[R.type] === FIELDS.types.request;
}

/** An answer that failed: notesd refused it or broke off, or the stream host answered 4xx/5xx (416 aside). */
function failed(r) {
  if (FIELDS.failedOutcomes.includes(r[R.outcome])) return true;
  const s = statusOf(r);
  return s !== null && s >= 400 && s !== 416;
}

/** A page line's text: a player record's `text`, or a plain string. */
function textOf(item) {
  if (typeof item === 'string') return item;
  return isObject(item) ? str(item[R.text]) : null;
}

/**
 * Everything in an evidence folder, normalized once: the session (from the snapshot's source, else
 * its last session record, else phase 4's report.json), its pass-through records and page lines
 * (merged from the snapshot, the daemon's newer records, the log tail and report.json, deduplicated,
 * this session's only, before the measurement started), the measurement, the daemon's lines, and
 * what is missing.
 */
export function readFolder(dir) {
  const missing = [];
  const file = (name) => path.join(dir, name);
  const readJson = (name) => {
    if (!existsSync(file(name))) return undefined;
    try {
      return JSON.parse(readFileSync(file(name), 'utf8'));
    } catch {
      missing.push(`${name} is not valid JSON`);
      return undefined;
    }
  };
  const readJsonl = (name) => {
    if (!existsSync(file(name))) return [];
    const out = [];
    for (const line of readFileSync(file(name), 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // A torn last line, as a log being written can leave: skipped.
      }
    }
    return out;
  };
  const readLines = (name) => (existsSync(file(name)) ? readFileSync(file(name), 'utf8').split('\n').filter((l) => l.trim() !== '') : []);

  missing.push(...readLines(COLLECTED.missing));

  const sessionFile = readJson(FIELDS.files.session);
  const answer = readJson(COLLECTED.answer);
  const reportFile = readJson(FIELDS.files.report);
  const snap = isObject(sessionFile) ? sessionFile : null;
  const source = snap !== null && isObject(snap[FIELDS.snapshot.source]) ? snap[FIELDS.snapshot.source] : null;
  const sessionRecords = snap !== null && Array.isArray(snap[FIELDS.snapshot.sessions]) ? snap[FIELDS.snapshot.sessions].filter(isObject) : [];
  const page = isObject(reportFile) && isObject(reportFile[FIELDS.report.page]) ? reportFile[FIELDS.report.page] : null;
  const complete =
    source !== null && snap[FIELDS.snapshot.live] === true && !(isObject(answer) && answer[FIELDS.snapshotAnswer.complete] === false);
  if (snap === null) missing.push(`${FIELDS.files.session}: no snapshot of the session (the daemon did not answer, or knew no session)`);
  else if (!complete) missing.push(`${FIELDS.files.session}: the session had ended when the snapshot was taken, so its source, attempts and hosts are not known`);
  const sessionId =
    (snap !== null ? validId(snap[FIELDS.snapshot.id]) : null) ??
    (isObject(answer) ? validId(answer[FIELDS.snapshotAnswer.session]) : null) ??
    (isObject(reportFile) ? validId(reportFile[FIELDS.report.id]) : null);

  const last = sessionRecords.at(-1) ?? null;
  const cache = source === null ? null : source[SRC.cache];
  const session =
    source === null && last === null && page === null
      ? null
      : {
          title: str(page?.[FIELDS.report.title]) ?? str(source?.[SRC.ref]) ?? str(last?.[R.ref]),
          provider: str(source?.[SRC.provider]) ?? str(last?.[R.provider]),
          attempts: Array.isArray(source?.[SRC.attempts]) ? source[SRC.attempts].length : num(last?.[R.attempts]),
          hosts: strings(source?.[SRC.hosts]),
          refreshes: num(source?.[SRC.refreshes]) ?? num(last?.[R.refreshes]),
          cache: isObject(cache) ? str(cache.id) : str(cache),
          torrent: isObject(source?.[SRC.torrent]) ? { infoHash: str(source[SRC.torrent].info_hash), name: str(source[SRC.torrent].name), index: str(source[SRC.torrent].index) } : null,
          steps: Array.isArray(source?.[SRC.attempts]) ? source[SRC.attempts].filter(isObject) : [],
        };
  const onTorrent = session !== null && (session.torrent !== null || session.provider === 'Torrent');

  const networkFile = readJson(COLLECTED.network);
  const network = isObject(networkFile) ? networkFile : null;
  if (network === null) missing.push(`${COLLECTED.network}: no network measurement`);
  else if (onTorrent) {
    // A torrent has no stream host to measure: its swarm is sampled instead (torrent.jsonl).
  } else if (network.stream === null || network.stream === undefined) {
    missing.push(`the stream host was not measured through the session (${network.stream_skipped ?? 'not asked'})`);
  } else if (network.stream.ok !== true && network.stream.reason === 'session_ended') {
    missing.push('the session has ended: the stream host was measured only by its first answer, not through the session');
  }
  const cutoff = typeof network?.measured_at === 'string' ? Date.parse(network.measured_at) : Number.NaN;

  const latest = readJson(COLLECTED.latest);
  const latestList = Array.isArray(latest) ? latest : isObject(latest) && Array.isArray(latest[FIELDS.evidenceList]) ? latest[FIELDS.evidenceList] : [];
  const seen = new Set();
  const records = [];
  for (const r of [...readJsonl(FIELDS.files.evidence), ...latestList, ...readJsonl(COLLECTED.tail)]) {
    if (!isObject(r)) continue;
    const key = JSON.stringify(r);
    if (seen.has(key)) continue;
    seen.add(key);
    if (sessionId !== null && r[R.session] !== undefined && r[R.session] !== sessionId) continue;
    const t = tsOf(r);
    // collect.sh's own requests through the session are not evidence of the play.
    if (t !== null && !Number.isNaN(cutoff) && t >= cutoff) continue;
    records.push(r);
  }
  records.sort((a, b) => (tsOf(a) ?? 0) - (tsOf(b) ?? 0));
  const passes = records.filter(isPass);
  const fromRecords = records.filter((r) => r[R.type] === FIELDS.types.player).map(textOf);
  const playerFile = readJson(FIELDS.files.player);
  const fromPlayer = isObject(playerFile) && Array.isArray(playerFile[FIELDS.player.list]) ? playerFile[FIELDS.player.list].map(textOf) : [];
  const fromPage = page === null ? [] : [...strings(page[FIELDS.report.log]), ...strings(page[FIELDS.report.errors])];
  const playerLines = [...new Set([...fromRecords, ...fromPlayer, ...fromPage].filter((t) => t !== null))];
  const torrentSamples = readJsonl(COLLECTED.torrent).filter(isObject);
  if (onTorrent && torrentSamples.length === 0) missing.push(`${COLLECTED.torrent}: the session plays from a torrent, and its swarm was not sampled (the daemon did not answer, or the session had ended)`);
  if (passes.length === 0 && !onTorrent) missing.push('no pass-through record of this session: the evidence log is empty for it, the play never reached the stream host, or it played from a ready cache');

  return {
    dir,
    sessionId,
    session,
    complete,
    passes,
    playerLines,
    network,
    onTorrent,
    torrentSamples,
    daemonLines: readLines(COLLECTED.daemonLog),
    missing: [...new Set(missing)],
  };
}

/** A daemon line's own clock ("Nov 17 03:47:06", local time), or ''. */
const clockOf = (line) => /^[A-Z][a-z]{2} +\d+ [\d:]{8}/.exec(line)?.[0] ?? '';

/**
 * What the daemon's lines say beyond the session: every start of the daemon (a restart ends every session and
 * every play in flight), and every torrent play with its outcome. A play that never started has no session, so
 * these lines are its only trace.
 */
export function daemonFacts(ev) {
  const starts = [];
  const plays = [];
  for (const line of ev.daemonLines) {
    if (/direct stream: on, \d+ providers in the seed/.test(line)) starts.push(clockOf(line));
    const m = /torrent: (TMDB .+?): (\d+) candidate\(s\), (none played|playing (.+))$/.exec(line);
    if (m !== null) plays.push({ at: clockOf(line), ref: m[1], candidates: Number(m[2]), played: m[4] ?? null });
  }
  return { starts, plays };
}

/** The session's torrent as its samples show it: the film's bitrate, what the swarm delivers, and how many peers. */
export function torrentFacts(ev) {
  const xs = ev.torrentSamples;
  if (xs.length === 0) return null;
  const last = xs.at(-1);
  const first = xs[0];
  const length = num(last.file_length);
  const duration = num(last.duration_s);
  const dt = (Date.parse(last.at) - Date.parse(first.at)) / 1000;
  const done = num(last.bytes_done) !== null && num(first.bytes_done) !== null ? last.bytes_done - first.bytes_done : null;
  const measured = xs.length >= 2 && dt > 0 && done !== null && done >= 0 ? round((done * 8) / dt / 1e6) : null;
  const reported = median(xs.map((x) => num(x.down_kbps)));
  return {
    state: str(last.state),
    progress: num(last.progress),
    bitrateMbps: length !== null && duration !== null && duration > 0 ? round((length * 8) / duration / 1e6) : null,
    // Bytes on disk between the samples when there are two; else the rate the engine reports.
    swarmMbps: measured ?? (reported === null ? null : round(reported / 1000)),
    peers: Math.max(...xs.map((x) => num(x.peers) ?? 0)),
  };
}

/** The numbers the rules and the summary read. */
export function facts(ev) {
  const failures = ev.passes.filter(failed);
  const media = ev.passes.filter((r) => (num(r[R.bytes]) ?? 0) >= THRESHOLDS.mediaBytes);
  const ref = ev.network?.reference ?? null;
  const stream = ev.network?.stream ?? null;
  const probe = ev.network?.host_probe ?? null;
  const byHost = new Map();
  for (const r of ev.passes) {
    const h = str(r[R.host]);
    if (h === null) continue;
    const e = byHost.get(h) ?? { host: h, answers: 0, failed: 0, rates: [], ttfbs: [] };
    e.answers += 1;
    if (failures.includes(r)) e.failed += 1;
    if ((num(r[R.bytes]) ?? 0) >= THRESHOLDS.mediaBytes) e.rates.push(rateMbps(r));
    e.ttfbs.push(num(r[R.ttfbMs]));
    byHost.set(h, e);
  }
  return {
    failures,
    lastFailure: failures.at(-1) ?? null,
    hostMbps: median(media.map(rateMbps)),
    ttfbMs: median(ev.passes.map((r) => num(r[R.ttfbMs]))),
    referenceMeasured: ref !== null,
    referenceMbps: ref?.ok === true ? num(ref.mbps) : null,
    referenceError: ref === null || ref.ok === true ? null : (str(ref.error) ?? `HTTP ${ref.status}`),
    streamNowMbps: stream?.ok === true ? num(stream.mbps) : null,
    probeMs: probe?.ok === true ? num(probe.ttfb_ms) : null,
    refreshes: ev.session?.refreshes ?? null,
    hosts: [...byHost.values()]
      .sort((a, b) => b.answers - a.answers)
      .map((e) => ({ host: e.host, answers: e.answers, failed: e.failed, mbps: median(e.rates), ttfb_ms: median(e.ttfbs) })),
  };
}

const says = (ev, re) => ev.playerLines.filter((l) => re.test(l));

/** The known causes, in the order they are tried; the first that answers signals wins. */
export const RULES = [
  {
    cause: 'session_ended',
    test(ev) {
      const lines = says(ev, /session (has )?ended|session is over|session_over|unknown_session/i);
      const refused = ev.passes.filter((r) => errorOf(r) === 'unknown_session');
      if (lines.length === 0 && refused.length === 0) return null;
      return [
        ...lines.slice(-2).map((l) => `the player said: ${l}`),
        ...(refused.length > 0 ? [`${refused.length} request(s) refused by notesd as unknown_session`] : []),
      ];
    },
  },
  {
    // A torrent session has no stream host and no token: its supply is the swarm.
    cause: 'torrent_swarm_slow',
    test(ev, f) {
      if (!ev.onTorrent) return null;
      // A slow or dead connection explains a slow swarm: connection_slow answers that.
      if (f.referenceError !== null || (f.referenceMbps !== null && f.referenceMbps < THRESHOLDS.referenceSlowMbps)) return null;
      const t = torrentFacts(ev);
      const title = ev.session?.title ?? null;
      const failedTries = daemonFacts(ev).plays.filter((p) => p.played === null && (title === null || p.ref === title));
      const stalls = says(ev, /stalled at|waiting for the swarm|recovering/i);
      const short = t !== null && t.swarmMbps !== null && t.bitrateMbps !== null && t.state !== 'ready' && t.swarmMbps < t.bitrateMbps * THRESHOLDS.swarmHeadroom;
      const thin = t !== null && t.state !== 'ready' && t.peers <= THRESHOLDS.fewPeers;
      if (!short && !(thin && (stalls.length > 0 || failedTries.length > 0))) return null;
      const slow = (ev.session?.steps ?? []).filter((a) => String(a.provider ?? '').startsWith('Torrent: ') && (num(a.took_s) ?? 0) >= THRESHOLDS.slowStepS);
      return [
        ...(t.swarmMbps !== null && t.bitrateMbps !== null
          ? [`the swarm delivers ${t.swarmMbps} Mbps and the film needs ${t.bitrateMbps} Mbps${short ? `: under ${THRESHOLDS.swarmHeadroom} times the film's bitrate, so it cannot stay ahead of the picture` : ''}`]
          : []),
        `${t.peers} peer(s) connected${thin ? ` (${THRESHOLDS.fewPeers} or fewer is a thin swarm)` : ''}; ${t.progress === null ? '?' : Math.round(t.progress * 100)}% of the file is on disk`,
        ...slow.map((a) => `${a.provider} took ${a.took_s} s to give its file list and header`),
        ...(failedTries.length > 0 ? [`${failedTries.length} earlier torrent play(s) of it found no torrent that played in time (${failedTries.map((p) => p.at).join(', ')})`] : []),
        ...stalls.slice(-2).map((l) => `the player said: ${l}`),
        ...(f.referenceMbps !== null ? [`the reference host gave ${f.referenceMbps} Mbps: this connection is not the limit`] : []),
      ];
    },
  },
  {
    cause: 'token_expired',
    test(ev, f) {
      const last = f.lastFailure;
      const lastRefused = last !== null && AUTH_REFUSED.has(statusOf(last) ?? 0);
      const lines = says(ev, /refused before it played|refreshed stream was refused|token/i);
      if (!lastRefused && lines.length === 0) return null;
      const refused = ev.passes.filter((r) => AUTH_REFUSED.has(statusOf(r) ?? 0));
      return [
        ...(lastRefused ? [`the stream host answered ${statusOf(last)} at ${when(last)} for ${where(last)}`] : []),
        `${refused.length} answer(s) refused with 401, 403 or 410`,
        `refreshes: ${f.refreshes ?? 'unknown'} (the player gives up after ${THRESHOLDS.maxRefreshes})`,
        ...lines.slice(-2).map((l) => `the player said: ${l}`),
      ];
    },
  },
  {
    cause: 'provider_broken',
    test(ev, f) {
      const last = f.lastFailure;
      const s = last === null ? null : statusOf(last);
      const broken = s !== null && (s === 404 || (s >= 500 && s < 600));
      const lines = says(ev, /manifestParsingError|manifestIncompatibleCodecsError|levelEmptyError|fragParsingError|fragDecryptError|keyLoadError|bufferAppendError/i);
      if (!broken && lines.length === 0) return null;
      return [
        ...(broken ? [`the stream host answered ${s} at ${when(last)} for ${where(last)}`] : []),
        ...lines.slice(-2).map((l) => `the player said: ${l}`),
      ];
    },
  },
  {
    cause: 'connection_slow',
    test(ev, f) {
      if (f.referenceError !== null) return [`the reference download failed (${f.referenceError}): this connection is down or very slow`];
      if (f.referenceMbps === null || f.referenceMbps >= THRESHOLDS.referenceSlowMbps) return null;
      return [
        `the reference host gave ${f.referenceMbps} Mbps, under ${THRESHOLDS.referenceSlowMbps}`,
        ...(f.hostMbps !== null ? [`the stream host gave ${f.hostMbps} Mbps during the play (median of media answers)`] : []),
      ];
    },
  },
  {
    cause: 'host_slow',
    test(ev, f) {
      if (f.referenceMbps === null) return null;
      const out = [];
      if (f.hostMbps !== null && f.hostMbps < THRESHOLDS.hostSlowMbps) {
        out.push(`the stream host gave ${f.hostMbps} Mbps during the play (median of media answers), under ${THRESHOLDS.hostSlowMbps}`);
      } else if (f.hostMbps !== null && f.hostMbps / f.referenceMbps < THRESHOLDS.hostToReference) {
        out.push(`the stream host gave ${f.hostMbps} Mbps during the play, under a quarter of the reference`);
      }
      if (f.streamNowMbps !== null && f.streamNowMbps < THRESHOLDS.hostSlowMbps) out.push(`through the session now it gave ${f.streamNowMbps} Mbps`);
      if (f.ttfbMs !== null && f.ttfbMs > THRESHOLDS.farMs) out.push(`its first byte took ${f.ttfbMs} ms (median during the play), over ${THRESHOLDS.farMs}`);
      if (f.probeMs !== null && f.probeMs > THRESHOLDS.farMs) out.push(`its root answered in ${f.probeMs} ms now`);
      if (out.length === 0) return null;
      return [...out, `the reference host gave ${f.referenceMbps} Mbps`];
    },
  },
];

export function classify(ev) {
  const f = facts(ev);
  for (const rule of RULES) {
    const signals = rule.test(ev, f);
    if (signals !== null) return { cause: rule.cause, label: CAUSES[rule.cause], signals };
  }
  const signals = [
    f.referenceMeasured
      ? `reference ${f.referenceMbps ?? '?'} Mbps, stream host ${f.hostMbps ?? '?'} Mbps, first byte ${f.ttfbMs ?? '?'} ms: none of the known signatures`
      : 'no reference measurement: this connection and the stream host cannot be told apart',
    ...ev.playerLines.slice(-2).map((l) => `the player said: ${l}`),
  ];
  return { cause: 'new', label: CAUSES.new, signals };
}

export function topHost(ev) {
  const hosts = facts(ev).hosts;
  if (hosts.length > 0) return hosts[0].host;
  return ev.session?.hosts[0] ?? null;
}

export function summarize(ev, cls = classify(ev)) {
  const f = facts(ev);
  const s = ev.session;
  const lines = [`stream bug evidence: ${ev.dir}`];
  lines.push(
    ev.sessionId === null
      ? 'session: unknown'
      : `session: ${ev.sessionId}${s?.title ? ` (${s.title})` : ''}${s?.provider ? ` from ${s.provider}` : ''}` +
          `${s?.cache ? ` (played from this machine's cache ${s.cache})` : ''}` +
          `${s?.attempts != null ? `, ${s.attempts} provider attempt(s)` : ''}${f.refreshes !== null ? `, ${f.refreshes} refresh(es)` : ''}` +
          `${ev.complete ? '' : ', ended before the snapshot'}`,
  );
  lines.push(`pass-through answers: ${ev.passes.length} (${f.failures.length} failed); player lines: ${ev.playerLines.length}; daemon log lines: ${ev.daemonLines.length}`);
  if (f.lastFailure !== null) {
    const lf = f.lastFailure;
    lines.push(`  last failure: ${when(lf)} status ${statusOf(lf) ?? '-'} answer ${num(lf[R.answer]) ?? '-'}${errorOf(lf) ? ` error ${errorOf(lf)}` : ''} ${where(lf)}`);
  }
  for (const h of f.hosts.slice(0, 3)) {
    lines.push(`stream host ${h.host}: ${h.answers} answers, ${h.failed} failed, median ${h.mbps ?? '?'} Mbps, first byte ${h.ttfb_ms ?? '?'} ms`);
  }
  const ref = ev.network?.reference ?? null;
  lines.push(
    ref === null
      ? 'reference download: not measured'
      : ref.ok === true
        ? `reference download: ${ref.mbps} Mbps, first byte ${ref.ttfb_ms} ms (${hostOf(ref.url)})`
        : `reference download: failed (${ref.error ?? `HTTP ${ref.status}`})`,
  );
  const st = ev.network?.stream ?? null;
  const tf = torrentFacts(ev);
  if (ev.onTorrent) {
    lines.push(
      tf === null
        ? `torrent ${s?.torrent?.name ?? '?'}: not sampled`
        : `torrent ${s?.torrent?.name ?? '?'}: ${tf.state ?? '?'}, ${tf.progress === null ? '?' : Math.round(tf.progress * 100)}% on disk, ${tf.peers} peer(s), swarm ${tf.swarmMbps ?? '?'} Mbps, film ${tf.bitrateMbps ?? '?'} Mbps`,
    );
  } else lines.push(
    st === null
      ? `the stream now: not measured (${ev.network?.stream_skipped ?? 'no measurement'})`
      : st.ok === true
        ? `the stream now, through the session: ${st.mbps} Mbps over ${st.segments_ok} segment(s) from ${st.host}`
        : `the stream now: not measured (${st.reason ?? st.error ?? 'failed'})`,
  );
  const p = ev.network?.host_probe ?? null;
  if (p !== null) lines.push(p.ok === true ? `${p.host} answered its root with HTTP ${p.status} in ${p.ttfb_ms} ms` : `${p.host} did not answer its root (${p.error})`);
  for (const a of s?.steps ?? []) {
    if ((num(a.took_s) ?? 0) >= THRESHOLDS.slowStepS) lines.push(`slow step: ${a.provider} ${a.outcome} after ${a.took_s} s${str(a.detail) ? ` (${String(a.detail).slice(0, 120)})` : ''}`);
  }
  const df = daemonFacts(ev);
  if (df.starts.length > 0) lines.push(`daemon starts in the log window (each ends every session and every play in flight): ${df.starts.slice(-5).join(', ')}`);
  for (const p of df.plays.slice(-6)) lines.push(`torrent play ${p.at}: ${p.ref}, ${p.candidates} candidate(s), ${p.played === null ? 'none played' : `playing ${p.played}`}`);
  for (const l of ev.playerLines.slice(-5)) lines.push(`player: ${l}`);
  lines.push(`cause: ${cls.label} (${cls.cause})`);
  for (const sig of cls.signals) lines.push(`  - ${sig}`);
  if (ev.missing.length > 0) {
    lines.push('missing:');
    for (const m of ev.missing) lines.push(`  - ${m}`);
  }
  return `${lines.join('\n')}\n`;
}

/** A plain-text note body (no markdown) in the /n style: what, cause, evidence, folder, hashtags last. */
export function noteBody(ev, what = '', cls = classify(ev)) {
  const f = facts(ev);
  const s = ev.session;
  const name = s?.title ?? (ev.sessionId !== null ? `session ${ev.sessionId.slice(0, 6)}` : 'a direct-stream play');
  const provider = s?.provider ?? null;
  const at = (ev.passes.length > 0 ? str(ev.passes.at(-1)[R.at]) : null) ?? str(ev.network?.measured_at);
  const lines = [`Stream bug: ${name}${provider !== null ? ` from ${provider}` : ''}${at !== null ? `, ${at} UTC` : ''}.`];
  if (what.trim() !== '') lines.push(`What was seen: ${what.trim()}`);
  if (s?.cache) lines.push(`It played from this machine's cache ${s.cache}.`);
  lines.push(`Cause: ${cls.label}.`);
  for (const sig of cls.signals) lines.push(`- ${sig}`);
  const tf = torrentFacts(ev);
  lines.push(
    ev.onTorrent
      ? `Network: reference ${f.referenceMbps ?? 'not measured'} Mbps; torrent ${s?.torrent?.name ?? 'unknown'}: swarm ${tf?.swarmMbps ?? '?'} Mbps, film ${tf?.bitrateMbps ?? '?'} Mbps, ${tf?.peers ?? '?'} peer(s).`
      : `Network: reference ${f.referenceMbps ?? 'not measured'} Mbps; stream host ${f.hosts[0]?.host ?? 'unknown'} median ${f.hostMbps ?? '?'} Mbps, first byte ${f.ttfbMs ?? '?'} ms.`,
  );
  const df = daemonFacts(ev);
  const tries = df.plays.filter((p) => s?.title == null || p.ref === s.title);
  if (tries.length > 0) lines.push(`Torrent plays of it in the daemon's log: ${tries.map((p) => `${p.at} ${p.played === null ? 'none played' : 'played'}`).join('; ')}.`);
  if (df.starts.length > 0) lines.push(`Daemon starts in the log window: ${df.starts.slice(-5).join(', ')}.`);
  if (ev.missing.length > 0) lines.push(`Not known: ${ev.missing.join('; ')}.`);
  lines.push(`Evidence folder: ${ev.dir}`);
  lines.push('', '#stream-bug #direct-stream #mcp-notes');
  return lines.join('\n');
}

function main(argv) {
  const [cmd, target, ...rest] = argv;
  const usage = () => {
    process.stderr.write('usage: diagnose.mjs classify|summary|note|session-id|top-host|torrent-hash DIR [what seen] | answer-dir FILE | torrent-sample FILE\n');
    process.exit(2);
  };
  if (target === undefined) usage();
  switch (cmd) {
    case 'classify':
      process.stdout.write(`${JSON.stringify(classify(readFolder(target)), null, 2)}\n`);
      break;
    case 'summary':
      process.stdout.write(summarize(readFolder(target)));
      break;
    case 'note':
      process.stdout.write(`${noteBody(readFolder(target), rest.join(' '))}\n`);
      break;
    case 'session-id': {
      const id = readFolder(target).sessionId;
      if (id !== null) process.stdout.write(`${id}\n`);
      break;
    }
    case 'top-host': {
      const host = topHost(readFolder(target));
      if (host !== null) process.stdout.write(`${host}\n`);
      break;
    }
    case 'torrent-hash': {
      const hash = readFolder(target).session?.torrent?.infoHash ?? null;
      if (hash !== null && /^[0-9a-f]{40}$/.test(hash)) process.stdout.write(`${hash}\n`);
      break;
    }
    case 'torrent-sample': {
      try {
        const answer = JSON.parse(readFileSync(target, 'utf8'));
        if (isObject(answer) && typeof answer.info_hash === 'string') {
          process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...Object.fromEntries(FIELDS.torrent.map((k) => [k, answer[k] ?? null])) })}\n`);
        }
      } catch {
        // Not JSON: no sample.
      }
      break;
    }
    case 'answer-dir': {
      try {
        const answer = JSON.parse(readFileSync(target, 'utf8'));
        const dir = answer?.[FIELDS.snapshotAnswer.dir];
        if (typeof dir === 'string' && path.isAbsolute(dir)) process.stdout.write(`${dir}\n`);
      } catch {
        // Not JSON: no folder.
      }
      break;
    }
    default:
      usage();
  }
}

function isMain() {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) main(process.argv.slice(2));
