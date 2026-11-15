# Phase 6: Playback probe campaign: DASH, VidNest, subtitles, expiry

**Plan set:** `DIRECT_STREAMING_PLAN.md`
**Analysis:** `.workflows/analyze/20261115-182932-Z85Y_code_analyzer.md`
**Satisfies:** R7 — the brief's untested list becomes measured work: DASH playback, VidNest playback and subtitles in our own player
**Criteria:** R7.3
**Depends on:** Phase 2, Phase 4 (and through them 1 and 3)
**Difficulty:** HARD
**Package:** `claude/streaming/direct`

---

## Goal

After this phase, "does it play in our page?" is a command, not a guess. `playcheck.mjs` asks a
throwaway daemon for a stream session for one provider and one title, opens the player page in
the streaming Chrome muted and in a normal window, reads what the `<video>` did, and prints one
JSON report with a verdict decided by fixed rules. The findings file's Playback section records,
with measured numbers, whether DASH (VidLink), VidNest and an English subtitle play in our page
and whether refresh-and-continue survives a forced expiry. Every provider that cannot play
outside its own page for a named cause is `browser_only` in the seed.

The phase has two halves, kept apart in this plan:

- **Deterministic code** (Steps 1 to 5): `playcheck.mjs`, `playgate.mjs`, their unit test with
  fakes, the findings section template, the feature-map line. Built and tested with no network,
  no Chrome and no daemon.
- **The live campaign** (Steps 6 to 9): what the phase session runs on the owner's machine and
  records. Its results land in the findings file and the seed, and any `web/src/stream/*` fix a
  finding demands lands with a failing test first (Step 8).

## Decisions this plan makes

**Which daemon.** A throwaway one: `verify.sh up --web --direct-stream` from the worktree (its own
port, its own database `v_<run>` in `mcp-notes-pg-verify`, its own data dir), never the live daemon
on 7317 (`playcheck.mjs run` refuses `--daemon` on port 7317). `--direct-stream` (phase 3) turns
direct streaming on and implies `--movies` (R2.6 needs `deps.movies`); `--web` because the player
page is a `web/` bundle. Under `--direct-stream`, phase 3's `verify.sh` passes a caller's
`NOTESD_DIRECT_STREAM_CLI` through instead of its fake. So the real resolver runs behind it, but
through a wrapper this phase writes (`<dir>/cli.mjs`, named by `NOTESD_DIRECT_STREAM_CLI`, see
Interface Contract): the wrapper forwards `resolve` to the real
`claude/streaming/direct/cli.mjs`, pins it to the provider under test (`--only`), and turns the
daemon's `open <url> --fullscreen` into a recorded no-op, so `POST /api/stream/play` never puts
Chrome in full screen and never starts sound. playcheck then opens the page itself, muted.

**How Windows Chrome reaches it.** WSL2 forwards Windows loopback to listeners on WSL's
127.0.0.1 (that is how the live wall at `localhost:7317` is reached). playcheck opens the page at
`http://127.0.0.1:<port>`, the address `verify.sh up` prints. Using `127.0.0.1` and not
`localhost` matters: `cdp.ps1` picks a tab by host only (`Get-HostOf`, `claude/streaming/cdp.ps1:41`),
so a `localhost` origin could select the owner's own player tab of the live daemon. Before it
navigates anything, playcheck reads the chosen tab's origin and whether a video is playing in it,
and stops with `foreign_tab_playing` rather than take over a tab that is playing something else.
If Chrome cannot load the throwaway daemon, `cdp.ps1` answers `no_tab` and the report says
`daemon_not_reachable_from_windows`; `--host localhost` is the documented fallback.

**Muted, normal window, never full screen.** playcheck navigates with
`evaluateInChrome(origin, location.assign(...), { show: true, windowState: 'normal' })`. The window
is brought forward because Chrome pauses a muted video in a hidden or minimized tab; it is never
made full screen. The page is opened as `/stream/<id>?muted=1` (Phase 4 requirement). Every
sample checks `muted`; a video that is unmuted and not paused stops the run at once, pauses it,
and reports `not_muted`. A sample showing the window full screen stops the run with
`went_full_screen`. At the end of every run the video is paused.

**How expiry is forced.** Not by waiting six hours. For the expiry check, playcheck starts a
small gate on `127.0.0.1:47399` (`playgate.mjs`), and the wrapper sends each HLS source the real
resolve returned through it: the gate fetches with the headers the resolve captured (the same
rule as the pass-through, invariant 3) and rewrites playlists to come back through itself. The
first source is answered `410 Gone` once it is older than `--expire-after-s` (default 45), as a
stream host answers when its token has run out. The daemon's pass-through passes the 410 to the
page, the page asks for a refresh (R2.5), the daemon resolves again through the wrapper, the gate
registers a second source that never expires, and the page must continue near where it stopped.
The gate's counters (first source refused, second source served) are evidence independent of the
page's own state.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `claude/streaming/direct/playcheck.mjs`: the CLI (`setup`, `run`, `findings`, `audit`) and
  `CHECKS`, `MIN_ADVANCE_S`, `RESUME_TOLERANCE_S`, `SAMPLE_MS`, `DEFAULT_GATE_PORT`, `RESULTS_FILE`,
  `BLOCK_BEGIN`, `BLOCK_END`, `GUARD_EXPRESSION`, `STATE_EXPRESSION`, `PAUSE_EXPRESSION`,
  `navigateExpression`, `classifyManifest`, `segmentFormat`, `isEnglish`, `summarize`,
  `browserOnlyCause`, `decide`, `inspectStream`, `runCheck`, `parseRunArgs`, `renderBlock`,
  `replaceBlock`, `auditFindings`, `setup`, `main`.
- `claude/streaming/direct/playgate.mjs`: `wrapperMain`, `startGate`, `gateUrl`,
  `rewriteHlsPlaylist`, `withOnly`, `gateSource`, `OPENED_FILE`, `NEXT_FILE`.
- `tests/unit/scripts/playcheck.test.ts`.
- The `## Playback` section body of `docs/plans/2026-11-15-direct-streaming-findings.md` (a
  generated block between `<!-- playcheck:begin -->` / `<!-- playcheck:end -->` plus hand-written
  subsections).
- A "Live playback probe" bullet in `.claude/skills/verify-notesd/features/direct-streaming.md`.
- No environment variable is read by the new code (all paths are arguments), so
  `docs/guide/reference/configuration.md` and `scripts/docs/envVars.ts` are untouched.

**Signature changes:** none.

**Requires (from earlier phases):**
- **Phase 1:** `node claude/streaming/direct/cli.mjs resolve <movie|tv> <tmdbId> [s e] ... --only <name>`
  tries only that provider; its reply is the Shared-contracts JSON (`source.manifest_url`,
  `source.manifest_kind` `hls|dash`, `source.headers.{referer,origin,user_agent}`,
  `source.subtitles[].{url,lang,label,format}`), printed as one JSON object on stdout; a non-zero
  exit still prints that object. The daemon-facing `open` command is named `open <url> [--fullscreen]`.
  A seed provider with `"browser_only": true` resolves to outcome `skipped_browser_only`.
- **Phase 2:** the findings file exists with a `## Playback` heading (if it does not,
  `playcheck.mjs findings` appends the heading); its tables say which providers resolved an
  English subtitle and whether any carried it inside the manifest. Phase 2 owns `browser_only` for
  causes seen at resolve time (for example a blob-only player with no manifest on the network);
  this phase owns `browser_only` for causes seen at playback.
- **Phase 3 (all in phase 3's plan):**
  1. `NOTESD_DIRECT_STREAM_CLI`: absolute path of the resolver CLI the daemon's
     `DirectStreamRunner` runs, default `claude/streaming/direct/cli.mjs`, with its row in
     `configuration.md`. This is the only seam playcheck needs; without it the campaign cannot keep
     `open` from going full screen.
  2. `verify.sh up --direct-stream` turns direct streaming on (implying `--movies`) and passes a
     `NOTESD_DIRECT_STREAM_CLI` from the caller's environment through instead of its fake resolver.
     Every run without `--direct-stream` pins `NOTESD_DIRECT_STREAM=off`.
  3. `DirectStreamService.play` runs the CLI's `open` with an address whose path is
     `/stream/<sessionId>`; `refresh(id)` re-resolves through the same CLI `resolve` command.
  4. `GET /api/stream/sessions/:id` answers phase 3's `SessionInfo`
     (`{ session_id, manifest_url, manifest_kind, subtitles: [{ url, lang, label, format, source, english }], resume_s, ... }`),
     addresses relative to the daemon.
  5. The pass-through answers an upstream 401, 403 or 410 with the same status and
     `X-Notesd-Upstream: <status>` (R2.5's trigger: the page refreshes only when that header is
     there, so the expiry gate's 410, forwarded by the pass-through, carries it), and accepts a
     loopback upstream host when the session's resolve returned it.
  6. A change to a provider's `browser_only` in the seed reaches `stream_providers` the next time
     a daemon loads the seed (phase 3's `syncSeed` updates seed rows whose fields changed).
- **Phase 4 (all in phase 4's plan):**
  1. `/stream/<id>?muted=1` creates the `<video>` muted before any `play()`, never unmutes it, and
     never asks for full screen; its `start()` does nothing.
  2. The page publishes `window.notesdStream = { kind: 'hls' | 'dash' | 'mp4', levels: number[] (heights), level, errors: string[], refreshes: number, ... }`
     (read when present; every other measurement comes from the `<video>` itself).
  3. The page has a `<title>` that is neither empty nor its address or host (`cdp.ps1` ignores
     such a tab), and on a 401/403/410 from the stream route that carries `X-Notesd-Upstream` it
     calls `POST /api/stream/sessions/:id/refresh` and continues from its position.
- **Phase 5 (if it has landed; this phase does not depend on it):** `POST /api/stream/play` still
  answers 200 when TMDB has no details for the title (phase 5's Step 8: a TMDB miss records nothing
  and never throws). The throwaway daemon's TMDB is verify's fake (`scripts/movies/tmdb.json`),
  which has no entry for 550 or the other campaign titles, so on such a run no stream play or
  source row is written and `/position` answers 404 `unknown_title`, which the page ignores.

**Leaves alone (owned by others):** `src/**` including `src/movies/*` and `src/directStream/*`
(Phases 3, 5, 10), MCP tools (7, 8), `web/src/pages/*` and `web/src/components/movies/*` (9),
`claude/streaming/direct/{cli,resolve,order,sniff,campaign}.mjs` and `sniff.ps1` (1, 2),
`claude/streaming/{chrome.mjs,cdp.ps1}`, `.claude/skills/verify-notesd/scripts/*`, every findings
section other than Playback (2), seed fields other than `browser_only` and `notes` (1, 2).

## Files

| File | Action | What changes |
|---|---|---|
| `claude/streaming/direct/playgate.mjs` | create | the wrapper CLI body the throwaway daemon runs, and the expiry gate |
| `claude/streaming/direct/playcheck.mjs` | create | the probe: setup, run, findings, audit |
| `tests/unit/scripts/playcheck.test.ts` | create | decision rules, Chrome calls, wrapper, gate over loopback, findings block and audit |
| `docs/plans/2026-11-15-direct-streaming-findings.md` | modify (under `## Playback`, left by phase 2) | the template (Step 4), then the generated block and the answers (Step 9) |
| `.claude/skills/verify-notesd/features/direct-streaming.md` | modify (end of its "Driving it" section; file created by phase 3) | one bullet: how to run the live playback probe |
| `claude/streaming/direct/providers.seed.json` | modify (live, Step 9): `browser_only` and `notes` of each provider the campaign proves cannot play outside its own page | campaign result |
| `web/src/stream/*` | modify only if a finding demands it (Step 8) | each fix with a failing test first, recorded in the findings |

## Implementation Steps

### Step 1: The wrapper and the expiry gate
**File:** `claude/streaming/direct/playgate.mjs` (new)
**Change:** Two pieces the daemon side of the campaign needs. `wrapperMain` is what the
generated `<dir>/cli.mjs` calls: `open` is recorded in `<dir>/opened.jsonl` and never reaches
Chrome; `resolve` is pinned to the provider named in `<dir>/next.json` and, when a gate answers,
an HLS source is routed through it; any other command passes through. `startGate` is the
loopback pass-through that expires the first source it registered.
**Code:**
```js
// Two helpers for playcheck.mjs, in their own module because the throwaway daemon runs one of them.
// - wrapperMain: the resolver CLI a playcheck daemon runs in place of direct/cli.mjs (through the
//   generated <dir>/cli.mjs that NOTESD_DIRECT_STREAM_CLI names). `open` is recorded, never done,
//   so the daemon's play never takes the screen or starts sound; `resolve` is pinned to the
//   provider under test; while an expiry gate answers, an HLS source is sent through it.
// - startGate: a loopback pass-through that fetches with the headers the resolve captured and
//   rewrites playlists to come back through itself. It answers 410 for the first source it
//   registered once that source is older than the expiry it was started with, as a stream host
//   does when its token runs out. Later sources never expire, so a refresh can continue.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';

export const OPENED_FILE = 'opened.jsonl';
export const NEXT_FILE = 'next.json';

/** The gate address that fetches `url` for the source registered as `token`. */
export function gateUrl(gate, token, url) {
  return `${gate}/g/${token}?u=${encodeURIComponent(url)}`;
}

/** Every address in an HLS playlist (plain lines and URI="..." attributes) made absolute and passed through `through`. */
export function rewriteHlsPlaylist(text, base, through) {
  return text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (t === '') return line;
      if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${through(new URL(u, base).href)}"`);
      return through(new URL(t, base).href);
    })
    .join('\n');
}

/** `args` without any `--only <name>`, then `--only <only>` when a provider is pinned. */
export function withOnly(args, only) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--only') {
      i++;
      continue;
    }
    out.push(args[i]);
  }
  if (only) out.push('--only', only);
  return out;
}

/** The source with its HLS manifest sent through the gate, or unchanged when no gate takes it. */
export async function gateSource(gate, source, fetchImpl = fetch) {
  if (!gate || !source || source.manifest_kind !== 'hls') return source;
  try {
    const res = await fetchImpl(`${gate}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ headers: source.headers ?? {} }),
      signal: AbortSignal.timeout(2000),
    });
    if (res.status !== 200) return source;
    const { token } = await res.json();
    return { ...source, manifest_url: gateUrl(gate, token, source.manifest_url) };
  } catch {
    return source;
  }
}

function runCli(cli, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { maxBuffer: 8 * 1024 * 1024, timeout: 170_000 }, (err, stdout) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout ?? '') });
    });
  });
}

function parseReply(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    try {
      return JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? '');
    } catch {
      return null;
    }
  }
}

async function pinnedProvider(dir) {
  try {
    return JSON.parse(await readFile(path.join(dir, NEXT_FILE), 'utf8')).only ?? null;
  } catch {
    return null;
  }
}

/**
 * Runs one CLI command the daemon asked for. config: { cli, dir, gate }. Returns the exit code.
 * deps (tests): spawnCli(args) -> { code, stdout }, fetch, write(text).
 */
export async function wrapperMain(config, argv, deps = {}) {
  const spawnCli = deps.spawnCli ?? ((args) => runCli(config.cli, args));
  const fetchImpl = deps.fetch ?? fetch;
  const write = deps.write ?? ((text) => process.stdout.write(text));
  const [command, ...rest] = argv;
  if (command === 'open') {
    const url = rest.find((a) => !a.startsWith('--')) ?? null;
    await appendFile(path.join(config.dir, OPENED_FILE), `${JSON.stringify({ at: new Date().toISOString(), url, args: rest })}\n`);
    write(`${JSON.stringify({ ok: true, opened: false, url })}\n`);
    return 0;
  }
  if (command !== 'resolve') {
    const { code, stdout } = await spawnCli(argv);
    write(stdout);
    return code;
  }
  const { code, stdout } = await spawnCli(['resolve', ...withOnly(rest, await pinnedProvider(config.dir))]);
  const reply = parseReply(stdout);
  if (!reply) {
    write(stdout);
    return code;
  }
  const out = reply.ok && reply.source ? { ...reply, source: await gateSource(config.gate, reply.source, fetchImpl) } : reply;
  write(`${JSON.stringify(out)}\n`);
  return code;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => resolve(text));
    req.on('error', reject);
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Starts the gate on 127.0.0.1:`port` (0 = any free port). Resolves to { url, stats(), close() }.
 * stats(): { expire_after_s, tokens: [{ n, served, refused, first_at }] } in registration order.
 */
export function startGate({ port = 0, expireAfterS, now = Date.now, fetchImpl = fetch }) {
  const tokens = new Map();
  let base = '';
  const stats = () => ({
    expire_after_s: expireAfterS,
    tokens: [...tokens.values()].map(({ n, served, refused, firstAt }) => ({ n, served, refused, first_at: firstAt })),
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (req.method === 'POST' && url.pathname === '/register') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const n = tokens.size + 1;
        const token = `t${n}-${randomBytes(4).toString('hex')}`;
        tokens.set(token, { n, headers: body.headers ?? {}, firstAt: null, served: 0, refused: 0 });
        return send(res, 200, { token });
      }
      if (url.pathname === '/stats') return send(res, 200, stats());
      const match = /^\/g\/([^/]+)$/.exec(url.pathname);
      const target = url.searchParams.get('u');
      const tok = match ? tokens.get(match[1]) : undefined;
      if (!match || !tok || !target) return send(res, 404, { error: 'unknown_token' });
      if (tok.n === 1 && tok.firstAt !== null && now() - tok.firstAt >= expireAfterS * 1000) {
        tok.refused++;
        return send(res, 410, { error: 'expired_by_playcheck' });
      }
      tok.firstAt ??= now();
      const headers = { accept: '*/*' };
      if (tok.headers.referer) headers.referer = tok.headers.referer;
      if (tok.headers.origin) headers.origin = tok.headers.origin;
      if (tok.headers.user_agent) headers['user-agent'] = tok.headers.user_agent;
      if (req.headers.range) headers.range = req.headers.range;
      const upstream = await fetchImpl(target, { headers });
      tok.served++;
      const type = upstream.headers.get('content-type') ?? '';
      const out = { 'content-type': type || 'application/octet-stream' };
      for (const h of ['content-range', 'accept-ranges']) {
        const v = upstream.headers.get(h);
        if (v) out[h] = v;
      }
      if (/mpegurl/i.test(type) || /\.(m3u8|txt)(\?|$)/.test(target)) {
        const text = await upstream.text();
        if (text.startsWith('#EXTM3U')) {
          res.writeHead(upstream.status, { ...out, 'content-type': 'application/vnd.apple.mpegurl' });
          return res.end(rewriteHlsPlaylist(text, upstream.url || target, (abs) => gateUrl(base, match[1], abs)));
        }
        res.writeHead(upstream.status, out);
        return res.end(text);
      }
      res.writeHead(upstream.status, out);
      if (!upstream.body) return res.end();
      Readable.fromWeb(upstream.body)
        .on('error', () => res.destroy())
        .pipe(res);
    } catch (err) {
      if (!res.headersSent) send(res, 502, { error: 'gate_fetch_failed', detail: String(err?.message ?? err) });
      else res.destroy();
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        url: base,
        stats,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}
```
**Impact:** new file; nothing imports it except `playcheck.mjs` and the generated `<dir>/cli.mjs`.
It reads no environment variable (the env scan in `scripts/docs/reference.ts:233` stays clean).

### Step 2: The probe
**File:** `claude/streaming/direct/playcheck.mjs` (new)
**Change:** The CLI and every pure function the decision rests on. `run` never resolves or plays
on its own: it asks the daemon (`POST /api/stream/play`), learns the session from the wrapper's
`opened.jsonl`, inspects the manifest and first segment through the daemon's pass-through,
opens the page muted in a normal window, samples the `<video>` every 1.5 s, and decides.
**Code:**
```js
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
  const english = tracks.filter(isEnglish).sort((a, b) => Number(b.mode === 'showing') - Number(a.mode === 'showing'))[0] ?? null;
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
    if (t && t.mode === 'showing' && (t.cues ?? 0) > 0) return { verdict: 'plays', cause: null };
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
```
**Impact:** new file. It imports `evaluateInChrome` and `sleep` from `claude/streaming/chrome.mjs`
unchanged. It reads no environment variable.

### Step 3: Unit test with fakes
**File:** `tests/unit/scripts/playcheck.test.ts` (new)
**Change:** Proves the decision rules and what is asked of Chrome (muted address, normal window,
never full screen, paused at the end), the safety stops, the wrapper (open never reaches the CLI,
the provider pin, the gate routing) and the gate itself over real loopback sockets, and the
findings block and audit. Chrome, the daemon and the clock are fakes at their boundaries; nothing
reaches a provider.
**Code:**
```ts
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { BLOCK_BEGIN, BLOCK_END, GUARD_EXPRESSION, PAUSE_EXPRESSION, STATE_EXPRESSION, auditFindings, classifyManifest, decide, parseRunArgs, renderBlock, replaceBlock, runCheck, segmentFormat } from '../../../claude/streaming/direct/playcheck.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { gateUrl, startGate, wrapperMain } from '../../../claude/streaming/direct/playgate.mjs';

const DAEMON = 'http://127.0.0.1:7400';
const MASTER = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",LANGUAGE="en",URI="subs.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,SUBTITLES="s"',
  'v1080.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720',
  'v720.m3u8',
  '',
].join('\n');
const MEDIA = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg0.ts\n#EXT-X-ENDLIST\n';
const TS = new Uint8Array(376);
TS[0] = 0x47;
TS[188] = 0x47;
const MPD_DRM = '<MPD><Period><AdaptationSet contentType="video"><ContentProtection schemeIdUri="urn:uuid:edef8ba9"/><Representation height="1080"/></AdaptationSet></Period></MPD>';
const HLS_SESSION = {
  manifest_url: '/api/stream/sessions/s1/p?u=https%3A%2F%2Fcdn.example%2Fm.m3u8',
  manifest_kind: 'hls',
  subtitles: [{ url: '/api/stream/sessions/s1/p?u=sub', lang: 'en', label: 'English' }],
  resume_s: null,
};

function video(t: number, over: any = {}): any {
  return {
    stage: 'video', origin: DAEMON, playing: t > 0, paused: false, t, duration_s: 8340, w: 1920, h: 1080, muted: true,
    frames: 400, dropped: 0, buffered_s: 24, error: null, fullscreen: false,
    tracks: [{ kind: 'subtitles', label: 'English', language: 'en', mode: 'showing', cues: 1200, active_cues: 1 }],
    state: { kind: 'hls', levels: [1080, 720], level: 0, errors: [], refreshes: 0 },
    ...over,
  };
}

const opts = (check: string, provider: string, over: any = {}): any => ({
  daemon: DAEMON, dir: '/unused', check, provider, ref: { kind: 'movie', tmdbId: 550 },
  watchS: 10, timeoutS: 60, expireAfterS: 45, gatePort: 0, host: null, ...over,
});

interface FakeOptions {
  guard?: any;
  play?: any;
  session?: any;
  manifest?: string;
  gate?: (dtMs: number) => any;
}

function fakeDeps(sampleAt: (i: number) => any, o: FakeOptions = {}) {
  let clock = 0;
  let i = 0;
  const calls: any[] = [];
  const posted: any[] = [];
  const next: any[] = [];
  const opened: any[] = [];
  const deps = {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    evaluate: async (origin: string, expression: string, options: any = {}) => {
      calls.push({ origin, expression, options });
      if (expression === GUARD_EXPRESSION) return o.guard ?? { origin, playing: false };
      if (expression === STATE_EXPRESSION) return sampleAt(i++);
      return 'ok';
    },
    fetchJson: async (url: string, init: any = {}) => {
      if (url === `${DAEMON}/api/stream/play`) {
        posted.push(init.body);
        const reply = o.play ?? { ok: true, status: 200, body: { ok: true } };
        if (reply.ok) opened.push({ url: 'http://localhost:7400/stream/s1', args: ['--fullscreen'] });
        return reply;
      }
      if (url === `${DAEMON}/api/stream/sessions/s1`) return { ok: true, status: 200, body: o.session ?? HLS_SESSION };
      throw new Error(`unexpected fetch ${url}`);
    },
    fetchText: async (url: string) => ({ ok: true, status: 200, text: url.includes('?u=') ? (o.manifest ?? MASTER) : MEDIA }),
    fetchHead: async () => TS,
    readOpened: async () => [...opened],
    writeNext: async (value: any) => {
      next.push(value);
    },
    startGate: async () => {
      const armedAt = clock;
      return { url: 'http://127.0.0.1:47399', stats: () => o.gate!(clock - armedAt), close: async () => {} };
    },
  };
  return { deps, calls, posted, next };
}

const gateTimeline = (dt: number) =>
  dt < 30_000
    ? { tokens: [{ n: 1, served: 5, refused: 0 }] }
    : dt < 40_000
      ? { tokens: [{ n: 1, served: 9, refused: 2 }] }
      : { tokens: [{ n: 1, served: 9, refused: 2 }, { n: 2, served: 6, refused: 0 }] };

describe('playcheck: reading a stream', () => {
  it('reads encryption, DRM, subtitle tracks and heights from a manifest', () => {
    expect(classifyManifest(MASTER, 'hls')).toEqual({
      kind: 'hls', encryption: 'none', drm: false, key_formats: [], subtitles: [{ lang: 'en', label: 'English' }], heights: [1080, 720],
    });
    expect(classifyManifest('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"\n', 'hls')).toMatchObject({ encryption: 'sample-aes', drm: false });
    expect(classifyManifest('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"\n', 'hls')).toMatchObject({ drm: true });
    expect(classifyManifest(MPD_DRM, 'dash')).toMatchObject({ kind: 'dash', drm: true, encryption: 'cenc', heights: [1080] });
    expect(classifyManifest('<MPD><AdaptationSet contentType="text" lang="en" label="English"></AdaptationSet></MPD>', 'dash').subtitles).toEqual([
      { lang: 'en', label: 'English' },
    ]);
  });

  it('tells a media segment from a disguised one', () => {
    expect(segmentFormat(TS).format).toBe('ts');
    expect(segmentFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).format).toBe('disguised_png');
  });

  it('gives the page expressions that parse', () => {
    for (const expression of [GUARD_EXPRESSION, STATE_EXPRESSION, PAUSE_EXPRESSION]) {
      expect(() => new Function(`return ${expression}`)).not.toThrow();
    }
  });
});

describe('playcheck: one run', () => {
  it('plays one provider muted in a normal window and pauses it afterwards', async () => {
    const f = fakeDeps((i) => video(i === 0 ? 0 : i * 1.5));
    const report = await runCheck(opts('play', 'VidFast'), f.deps);
    expect(report).toMatchObject({ verdict: 'plays', cause: null, session_id: 's1', error: null, subtitle_source: 'separate+manifest' });
    expect(f.posted).toEqual([{ kind: 'movie', tmdb_id: 550 }]);
    expect(f.next).toEqual([{ only: 'VidFast' }]);
    const nav = f.calls.find((c) => c.expression.includes('location.assign'));
    expect(nav.expression).toContain(`${DAEMON}/stream/s1?muted=1`);
    expect(nav.options).toMatchObject({ show: true, windowState: 'normal' });
    expect(f.calls.some((c) => c.options?.windowState === 'fullscreen')).toBe(false);
    expect(f.calls.at(-1).expression).toBe(PAUSE_EXPRESSION);
    expect(report.summary).toMatchObject({ muted_always: true, fullscreen_ever: false, height: 1080 });
    expect(report.manifest).toMatchObject({ kind: 'hls', encryption: 'none', heights: [1080, 720] });
    expect(report.segment.format).toBe('ts');
  });

  it('stops and pauses at once when the video is heard', async () => {
    const f = fakeDeps(() => video(3, { muted: false }));
    const report = await runCheck(opts('play', 'VidFast'), f.deps);
    expect(report).toMatchObject({ verdict: 'inconclusive', cause: 'not_muted' });
    expect(f.calls.filter((c) => c.expression === STATE_EXPRESSION)).toHaveLength(1);
    expect(f.calls.at(-1).expression).toBe(PAUSE_EXPRESSION);
  });

  it('never takes over a tab that is playing something else', async () => {
    const f = fakeDeps(() => video(1), { guard: { origin: 'http://localhost:7317', playing: true } });
    const report = await runCheck(opts('play', 'VidFast'), f.deps);
    expect(report).toMatchObject({ verdict: 'inconclusive', cause: 'foreign_tab_playing' });
    expect(f.posted).toEqual([]);
  });

  it('answers no_source without opening the page when the provider does not resolve', async () => {
    const play = { ok: false, status: 502, body: { error: 'no_source', attempts: [{ provider: 'VidLink', outcome: 'no_stream' }] } };
    const f = fakeDeps(() => video(1), { play });
    const report = await runCheck(opts('dash', 'VidLink'), f.deps);
    expect(report).toMatchObject({ verdict: 'no_source', play: { attempts: play.body.attempts } });
    expect(f.calls.some((c) => c.expression.includes('location.assign'))).toBe(false);
  });

  it('marks a DASH stream that never plays and carries DRM as browser_only', async () => {
    const session = { manifest_url: '/api/stream/sessions/s1/p?u=mpd', manifest_kind: 'dash', subtitles: [], resume_s: null };
    const f = fakeDeps(() => video(0, { playing: false, w: 0, h: 0 }), { session, manifest: MPD_DRM });
    const report = await runCheck(opts('dash', 'VidLink'), f.deps);
    expect(report).toMatchObject({ verdict: 'browser_only', cause: 'drm' });
  });

  it('calls a stream that will not play for no named cause our fault', async () => {
    const f = fakeDeps(() => video(0, { playing: false, state: { errors: ['networkError manifestLoadError FATAL'] } }));
    const report = await runCheck(opts('vidnest', 'VidNest'), f.deps);
    expect(report).toMatchObject({ verdict: 'needs_fix', cause: 'networkError manifestLoadError FATAL' });
  });

  it('needs an English track showing with cues for the subtitle check', async () => {
    const hidden = [{ kind: 'subtitles', label: 'English', language: 'en', mode: 'disabled', cues: null, active_cues: null }];
    const f = fakeDeps((i) => video(i * 1.5, { tracks: hidden }));
    const report = await runCheck(opts('subtitle', 'VidLink'), f.deps);
    expect(report).toMatchObject({ verdict: 'needs_fix', cause: 'english_track_disabled_0_cues' });
  });

  it('passes the expiry check when a refreshed source plays on from where it stopped', async () => {
    const f = fakeDeps((i) => video(i * 1.5), { gate: gateTimeline });
    const report = await runCheck(opts('expiry', 'VidFast'), f.deps);
    expect(report.expiry).toMatchObject({ first_refused: 2, refreshed: true, restarted: false, resumed: true });
    expect(report).toMatchObject({ verdict: 'plays', cause: null });
  });

  it('fails the expiry check when the film starts again from the beginning', async () => {
    const f = fakeDeps((i) => video(i <= 22 ? i * 1.5 : (i - 22) * 1.5), { gate: gateTimeline });
    const report = await runCheck(opts('expiry', 'VidFast'), f.deps);
    expect(report).toMatchObject({ verdict: 'needs_fix', cause: 'restarted_from_start' });
  });

  it('decides an unresolved, a wrongly kinded and a scrambled run by rule', () => {
    expect(decide('dash', { play: { ok: true }, session: { manifest_kind: 'hls' } })).toEqual({ verdict: 'inconclusive', cause: 'not_dash (hls)' });
    const stuck = { playing_at_end: false, advanced_s: 0, height: 0, errors: [] };
    expect(decide('play', { play: { ok: true }, session: { manifest_kind: 'hls' }, manifest: { drm: false, encryption: 'none' }, segment: { format: 'disguised_png' }, summary: stuck })).toEqual({
      verdict: 'browser_only',
      cause: 'obfuscated_segments',
    });
  });

  it('checks run arguments once and refuses the live daemon', () => {
    expect(() => parseRunArgs(['--daemon', 'http://127.0.0.1:7317', '--dir', '/d', '--check', 'play', '--provider', 'VidFast', 'movie', '550'])).toThrow(/7317/);
    expect(() => parseRunArgs(['--daemon', DAEMON, '--dir', '/d', '--check', 'vidnest', '--provider', 'VidFast', 'movie', '550'])).toThrow(/VidNest/);
    expect(() => parseRunArgs(['--daemon', DAEMON, '--dir', '/d', '--check', 'play', '--provider', 'VidFast', 'tv', '1399'])).toThrow(/season/);
    expect(parseRunArgs(['--daemon', `${DAEMON}/`, '--dir', '/d', '--check', 'dash', '--provider', 'VidLink', 'movie', '550'])).toMatchObject({
      daemon: DAEMON, check: 'dash', ref: { kind: 'movie', tmdbId: 550 }, watchS: 15, expireAfterS: 45, gatePort: 47399, host: null,
    });
  });
});

describe('playcheck: the daemon side', () => {
  const resolved = {
    ok: true, kind: 'movie', tmdb_id: 550,
    source: {
      provider: 'VidFast', manifest_url: 'https://cdn.example/m.m3u8', manifest_kind: 'hls',
      headers: { referer: 'https://vidfast.vc/', origin: 'https://vidfast.vc', user_agent: 'UA' }, subtitles: [],
    },
    attempts: [],
  };

  it('records open without running the CLI or touching Chrome', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'playcheck-'));
    const spawned: string[][] = [];
    const out: string[] = [];
    const code = await wrapperMain({ cli: '/x/cli.mjs', dir, gate: '' }, ['open', 'http://localhost:7400/stream/s1', '--fullscreen'], {
      spawnCli: async (args: string[]) => {
        spawned.push(args);
        return { code: 0, stdout: '' };
      },
      write: (text: string) => out.push(text),
    });
    expect(code).toBe(0);
    expect(spawned).toEqual([]);
    expect(readFileSync(path.join(dir, 'opened.jsonl'), 'utf8')).toContain('"url":"http://localhost:7400/stream/s1"');
    expect(JSON.parse(out[0]!)).toEqual({ ok: true, opened: false, url: 'http://localhost:7400/stream/s1' });
  });

  it('pins resolve to the provider under test and sends an HLS source through an armed gate', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'playcheck-'));
    writeFileSync(path.join(dir, 'next.json'), '{"only":"VidFast"}');
    const spawned: string[][] = [];
    const out: string[] = [];
    await wrapperMain({ cli: '/x/cli.mjs', dir, gate: 'http://127.0.0.1:47399' }, ['resolve', 'movie', '550', '--only', 'VidLink', '--providers', '/p.json'], {
      spawnCli: async (args: string[]) => {
        spawned.push(args);
        return { code: 0, stdout: JSON.stringify(resolved) };
      },
      fetch: async () => new Response(JSON.stringify({ token: 't1-ab' }), { status: 200, headers: { 'content-type': 'application/json' } }),
      write: (text: string) => out.push(text),
    });
    expect(spawned).toEqual([['resolve', 'movie', '550', '--providers', '/p.json', '--only', 'VidFast']]);
    expect(JSON.parse(out[0]!).source.manifest_url).toBe(gateUrl('http://127.0.0.1:47399', 't1-ab', 'https://cdn.example/m.m3u8'));
  });

  it('leaves a source alone when no gate answers', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'playcheck-'));
    const out: string[] = [];
    await wrapperMain({ cli: '/x/cli.mjs', dir, gate: 'http://127.0.0.1:47399' }, ['resolve', 'movie', '550'], {
      spawnCli: async () => ({ code: 0, stdout: JSON.stringify(resolved) }),
      fetch: async () => {
        throw new Error('connection refused');
      },
      write: (text: string) => out.push(text),
    });
    expect(JSON.parse(out[0]!).source.manifest_url).toBe('https://cdn.example/m.m3u8');
  });

  it('the gate replays the captured headers, rewrites playlists, and expires only the first source', async () => {
    const seen: any[] = [];
    const upstream = http.createServer((req, res) => {
      seen.push({ url: req.url, referer: req.headers.referer, ua: req.headers['user-agent'] });
      if (req.url === '/master.m3u8') {
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080\nv.m3u8\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      res.end(Buffer.from([0x47, 0, 0, 0]));
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', () => done()));
    const up = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    let clock = 0;
    const gate = await startGate({ port: 0, expireAfterS: 45, now: () => clock });
    try {
      const register = async () => {
        const res = await fetch(`${gate.url}/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ headers: { referer: 'https://vidfast.vc/', user_agent: 'UA-from-chrome' } }),
        });
        return ((await res.json()) as { token: string }).token;
      };
      const t1 = await register();
      const first = await fetch(gateUrl(gate.url, t1, `${up}/master.m3u8`));
      expect(first.status).toBe(200);
      expect(await first.text()).toContain(gateUrl(gate.url, t1, `${up}/v.m3u8`));
      expect(seen[0]).toEqual({ url: '/master.m3u8', referer: 'https://vidfast.vc/', ua: 'UA-from-chrome' });
      clock = 45_000;
      expect((await fetch(gateUrl(gate.url, t1, `${up}/seg.ts`))).status).toBe(410);
      const t2 = await register();
      const again = await fetch(gateUrl(gate.url, t2, `${up}/seg.ts`));
      expect(again.status).toBe(200);
      expect(new Uint8Array(await again.arrayBuffer())[0]).toBe(0x47);
      expect(gate.stats().tokens.map((t: any) => [t.n, t.served, t.refused])).toEqual([[1, 1, 1], [2, 1, 0]]);
    } finally {
      await gate.close();
      upstream.close();
    }
  });
});

describe('playcheck: the findings block', () => {
  const result = (check: string, provider: string, verdict: string, cause: string | null, at: string): any => ({
    check, provider, ref: { kind: 'movie', tmdbId: 550 }, verdict, cause, at, summary: null, session: { manifest_kind: check === 'dash' ? 'dash' : 'hls' },
    manifest: null, subtitle_source: 'separate', expiry: null,
  });

  it('writes the table between its markers and audits it against the seed', () => {
    const results = [
      result('dash', 'VidLink', 'needs_fix', 'english_track_missing', '2026-11-16T10:00:00.000Z'),
      result('dash', 'VidLink', 'plays', null, '2026-11-16T11:00:00.000Z'),
      result('vidnest', 'VidNest', 'browser_only', 'obfuscated_segments', '2026-11-16T10:10:00.000Z'),
      result('subtitle', 'VidLink', 'plays', null, '2026-11-16T10:20:00.000Z'),
      result('expiry', 'VidFast', 'plays', null, '2026-11-16T10:30:00.000Z'),
    ];
    const block = renderBlock(results);
    expect(block.startsWith(BLOCK_BEGIN)).toBe(true);
    expect(block.endsWith(BLOCK_END)).toBe(true);
    expect(block).toContain('| dash | VidLink | movie 550 | **plays** |');
    expect(block).not.toContain('**needs_fix**');
    const md = replaceBlock('# Findings\n\n## Playback\n\nTo be filled by phase 6.\n\n## Other\n', block);
    expect(md.indexOf(BLOCK_BEGIN)).toBeGreaterThan(md.indexOf('## Playback'));
    expect(md.indexOf('## Other')).toBeGreaterThan(md.indexOf(BLOCK_END));
    expect(replaceBlock(md, block)).toBe(md);
    const seed = [
      { name: 'VidLink', browser_only: false },
      { name: 'VidNest', browser_only: false },
      { name: 'VidFast', browser_only: false },
    ];
    expect(auditFindings(md, seed)).toEqual(['VidNest is browser_only in the findings but browser_only is not true in the seed']);
    expect(auditFindings(md, seed.map((p) => (p.name === 'VidNest' ? { ...p, browser_only: true } : p)))).toEqual([]);
  });

  it('wants a decided row for every check and a Fixes row for an open fix', () => {
    const md = replaceBlock('## Playback\n', renderBlock([result('dash', 'VidLink', 'needs_fix', 'no_progress', '2026-11-16T10:00:00.000Z')]));
    expect(auditFindings(md, [{ name: 'VidLink', browser_only: false }])).toEqual([
      'the vidnest check has no decided result (plays, browser_only, needs_fix, or no_source after 3 runs)',
      'the subtitle check has no decided result (plays, browser_only, needs_fix, or no_source after 3 runs)',
      'the expiry check has no decided result (plays, browser_only, needs_fix, or no_source after 3 runs)',
      'dash/VidLink needs a fix but has no row in the Fixes table',
    ]);
  });
});
```
**Impact:** `npm test` gains one node test file. The gate test binds two loopback ports and
closes them. Each `.mjs` import stays on one line under its `// @ts-expect-error`, the pattern of
`tests/unit/scripts/streamingSites.test.ts:2-11`.

### Step 4: The findings section template
**File:** `docs/plans/2026-11-15-direct-streaming-findings.md`, under the `## Playback` heading
phase 2 leaves (replace whatever placeholder sits between that heading and the next `## `).
**Change:** The fixed text of the section, with the slots the live campaign fills. The generated
block is inserted later by `playcheck.mjs findings` right under the heading; everything below
the markers is written by hand in Step 9.
**Code:**
```markdown
## Playback

Measured with `claude/streaming/direct/playcheck.mjs` against a throwaway daemon started from the
worktree (`verify.sh up --web --direct-stream`: its own port, database and data dir; the real resolver
behind `NOTESD_DIRECT_STREAM_CLI`, wrapped so the daemon's play never opens Chrome itself). Each
run opens one session's player page in the streaming Chrome, muted, in a normal window, never
full screen, and samples the `<video>` every 1.5 s. The table between the markers is generated by
`node claude/streaming/direct/playcheck.mjs findings`; do not edit it by hand. Re-running a check
replaces its row and counts the run.

### How a result is decided

- **plays**: the video advanced at least 10 s at a real resolution and was playing at the end. A
  subtitle check also needs an English text track in mode `showing` with cues. An expiry check
  needs the first source refused by the gate, a second resolve served, and playback going on no
  more than 10 s before where it stopped.
- **browser_only**: it did not play, and a cause no pass-through can remove is named: `drm` (a
  DASH `ContentProtection`, an HLS key format other than identity, or a key-system error),
  `encrypted_segments` (SAMPLE-AES, or an AES-128 key the player cannot load) or
  `obfuscated_segments` (the first segment is not TS, fMP4, AAC or ID3, for example a PNG header).
  The provider is marked `"browser_only": true` in the seed with the cause in `notes`.
- **needs_fix**: it did not play, or the subtitle or the refresh failed, with no such cause. The
  fault is treated as ours. A fix in `web/src/stream` lands with a failing test first and a row
  in Fixes; a fault in the daemon's pass-through stays open with a task.
- **no_source**: the provider did not resolve during the run; after 3 runs at least 5 minutes
  apart it is recorded as "did not resolve during the campaign", not as browser_only.
- **inconclusive**: the run could not look (Chrome, tab, daemon, a stop for sound or full screen)
  or the check did not apply (a DASH check served HLS, no English track offered). It decides
  nothing and is run again.

### Answers

- DASH (VidLink, Fight Club 550): {verdict}. {resolution, seconds to first frame, dropped/frames, buffered s, levels}
- VidNest, HLS behind `master.txt` (Fight Club 550): {verdict}. {numbers}
- English subtitle from a separate `.srt`/`.vtt` ({provider}): {verdict}. {track label, mode, cue count}
- English subtitle inside the manifest: {provider and verdict, or "no provider in the seed carried one (phase 2 findings, and no playcheck run saw an English `EXT-X-MEDIA`/text `AdaptationSet`)"}
- Refresh and continue after a forced expiry (VidFast, gate at 45 s): {verdict}. {stopped at t_before s, went on at t_min_after s, gate counters}

### Marked browser_only

| Provider | Cause | Evidence |
| --- | --- | --- |

### Fixes

| Finding | Cause | Change | Test | Status |
| --- | --- | --- | --- | --- |
```
**Impact:** text only. Phase 2's other sections are not touched.

### Step 5: The feature-map line
**File:** `.claude/skills/verify-notesd/features/direct-streaming.md` (created by phase 3), last
bullet of its "Driving it" section.
**Change:** one bullet, so a later verifier knows the live probe exists and how to start it.
**Code:**
```markdown
- Live playback probe (owner's machine only; providers are live): `node claude/streaming/direct/playcheck.mjs setup --dir ~/.local/state/notesd-playcheck`, then `NOTESD_DIRECT_STREAM_CLI=$HOME/.local/state/notesd-playcheck/cli.mjs $V up --web --direct-stream`, then `node claude/streaming/direct/playcheck.mjs run --daemon <URL> --dir ~/.local/state/notesd-playcheck --check play|dash|vidnest|subtitle|expiry --provider <name> movie 550`. It prints one JSON report with a verdict. It brings the streaming Chrome to the front in a normal window, muted: say so before running it. Results go into the Playback section of `docs/plans/2026-11-15-direct-streaming-findings.md` with `playcheck.mjs findings`, and `playcheck.mjs audit` checks that section against the seed.
```
**Impact:** documentation of the harness; no behaviour change.

**Checkpoint (deterministic half done):** `npm run typecheck`, `npm test` (including
`npx vitest run tests/unit/scripts/playcheck.test.ts`) and `npm run docs:check` pass. Commit
Steps 1 to 5 before any live run. (While planning, the code of Steps 1 to 3 was run as written in
a scratch copy beside the real `chrome.mjs`: 20 tests pass, strict `tsc` is clean on the test,
`setup` writes a working `cli.mjs`, its `open` is recorded without Chrome, and `run` refuses
port 7317.)

### Step 6: Start the throwaway daemon (live)
**File:** none (commands). State dir `D=$HOME/.local/state/notesd-playcheck`.
**Change:** Run from the worktree root:
```sh
cd /home/miftah/.worktrees/mcp-notes/direct-streaming
V=.claude/skills/verify-notesd/scripts/verify.sh
PC=claude/streaming/direct/playcheck.mjs
D=$HOME/.local/state/notesd-playcheck
node $PC setup --dir "$D"
NOTESD_DIRECT_STREAM_CLI="$D/cli.mjs" $V up --web --direct-stream   # note RUN= and URL=
$V doctor "$RUN"
$V api "$RUN" GET /api/stream/sessions/nope
```
The `sessions/nope` call must answer 403 `unknown_session` (direct streaming is on), not 503
`direct_stream_off`. If it is 503, the run was not started with `--direct-stream`; if a play later
records no `open` in `$D/opened.jsonl` (the fake resolver ran instead of the wrapper), the variable
did not reach the daemon (Interface Contract, Phase 3 item 2): stop and report it, do not edit
`verify.sh` here.
Tell the owner before the first `run`: the streaming Chrome will come to the front in a normal
window, muted, about seven times over the next half hour.
**Impact:** none on the repo. The live daemon on 7317 is not touched.

### Step 7: Run the checks (live)
**File:** none (commands; every report is appended to `$D/results.jsonl`).
**Change:** In this order, one at a time:
```sh
# 1. Control: HLS that the spike already played. If this is not "plays", the page is broken; go to Step 8 first.
node $PC run --daemon "$URL" --dir "$D" --check play --provider VidFast movie 550
# 2. DASH through VidLink.
node $PC run --daemon "$URL" --dir "$D" --check dash --provider VidLink movie 550
# 3. VidNest, HLS behind master.txt.
node $PC run --daemon "$URL" --dir "$D" --check vidnest --provider VidNest movie 550
# 4. English subtitle from a separate file (VidLink sent one .srt in the spike).
node $PC run --daemon "$URL" --dir "$D" --check subtitle --provider VidLink movie 550 --watch-s 20
# 5. English subtitle inside the manifest: for each provider phase 2's findings list with an
#    in-manifest English track (and any run above whose report shows .subtitle_source "manifest"
#    or "separate+manifest"), run:
node $PC run --daemon "$URL" --dir "$D" --check subtitle --provider <that provider> movie 550 --watch-s 20
# 6. Refresh and continue after a forced expiry (an HLS provider; the gate needs HLS).
node $PC run --daemon "$URL" --dir "$D" --check expiry --provider VidFast movie 550 --expire-after-s 45
```
Decision rule per answer (from `decide`, repeated here for the session):
- `plays`: done for that check.
- `browser_only`: record it; Step 9 marks the seed.
- `needs_fix`: Step 8, then run the same command again.
- `no_source`: run again at least 5 minutes later, up to 3 runs in all; then it stands.
- `inconclusive`: read `.cause`. `not_muted`, `went_full_screen`: stop the campaign, the page
  breaks the Phase 4 contract; report it. `daemon_not_reachable_from_windows`: rerun with
  `--host localhost` (the foreign-tab guard still applies). `foreign_tab_playing`: the owner is
  watching something in the streaming Chrome; wait. `not_dash`: VidLink served HLS this time;
  record that and rerun later. `no_english_offered`: try the next provider with an English track.
  `expiry_not_reached`: the film did not play long enough; rerun after the control passes.
**Impact:** live requests to providers through the real resolver; one Chrome window in front per
run, muted. No sound, no full screen.

### Step 8: Fixes a finding demands (live, conditional)
**File:** `web/src/stream/*` only; which file depends on the finding.
**Change:** For each `needs_fix` result:
1. Read the report (`tail -1 $D/results.jsonl`): `.summary.errors`, the last samples,
   `.manifest`, `.segment`, `.play`, `.session`. Name the cause and the line it comes from.
2. If the cause is in the player page (`web/src/stream/*`): write a jsdom test beside the code
   (`web/src/stream/*.test.tsx`, first line `// @vitest-environment jsdom`, the fake player
   phase 4's tests use) that reproduces it and fails; make the smallest change that makes it
   pass; `npm run typecheck && npm test`; `npm run build:web` (the throwaway daemon serves
   `web/dist` from the worktree); run the same `playcheck.mjs run` command again until it passes.
   Add a row to the findings' Fixes table: `| <check>/<provider> | <cause> | <file:line, one line> | <test name> | fixed |`.
3. If the cause is in the daemon (`src/directStream/*`, the pass-through or the session): do not
   fix it here. Add a Fixes row with status `open, task <id>` and file the task with
   `/create-task` naming the report. The row stays `needs_fix`, which `audit` accepts only with
   that Fixes row.
4. If the page breaks the Phase 4 contract this plan relies on (`?muted=1` not honoured,
   `window.notesdStream` missing, no `<title>`), the fix is in `web/src/stream/*` and follows 2.
   A page that is not muted is fixed before any further live run.
No code is planned in advance for these: each is decided by a reproduction, never by guess.
**Impact:** each fix is its own commit with its test; the player's behaviour changes only where
a test shows it was wrong.

### Step 9: Record the findings, mark the seed, audit, tear down (live)
**File:** `docs/plans/2026-11-15-direct-streaming-findings.md` (Playback section),
`claude/streaming/direct/providers.seed.json` (the `browser_only` and `notes` fields of each
provider with a `browser_only` row).
**Change:**
```sh
node $PC findings --dir "$D" --file docs/plans/2026-11-15-direct-streaming-findings.md
```
Then fill the hand-written parts from the reports: the five "Answers" lines with their measured
numbers, one "Marked browser_only" row per `browser_only` result (provider, cause, the evidence:
`segment.head`, the manifest's key format or `ContentProtection`, or the player error). For each
such provider, edit its seed entry in place, keeping every other field and the file's existing
formatting:
```json
"browser_only": true,
"notes": "<existing notes, if any>; playback 2026-11-xx: browser_only (<cause>)"
```
Then:
```sh
node $PC audit --file docs/plans/2026-11-15-direct-streaming-findings.md --seed claude/streaming/direct/providers.seed.json
npx vitest run tests/unit/scripts
$V down "$RUN"
```
`audit` must print `{"ok":true,"problems":[]}`. The script tests include phase 1's seed checks,
so a malformed seed edit fails here.
**Impact:** the resolver now skips each marked provider (`skipped_browser_only`); the live daemon
picks the marks up when it next loads the seed (Interface Contract, Phase 3 item 6).

## Principles applied

- Laziness protocol: one wrapper CLI, written by `setup` and run through a single injectable path (`NOTESD_DIRECT_STREAM_CLI`), covers all three daemon-side needs: no Chrome on `open`, pinning the provider under test, and routing a source through the expiry gate. The alternative was three new daemon features (a resolve-only route, a provider field on `/api/stream/play`, a session-lifetime setting). The gate handles HLS only, because the expiry check needs one stream kind.
- Build the lever: the findings table is generated from the run reports (`playcheck.mjs findings`), not copied by hand. `playcheck.mjs audit` checks the section against the seed, so R7.3 has a command that can fail (J4).
- Boundary discipline: `parseRunArgs` checks every run argument once (check name, VidNest pinning, tv needs season and episode, the live port refused, the host value). `runCheck` and `decide` trust the typed options.
- Make illegal states unrepresentable: only `decide` assigns a verdict, from a closed list. The findings rows carry that verdict in a machine-readable comment, so a hand-typed "works" cannot enter the table. A `browser_only` row without the seed flag fails the audit.
- Fix root causes: Step 8 requires a named cause and a failing reproduction before any change to `web/src/stream`. A cause in the daemon is filed as a task, not patched from this phase.
- Test behavior, not implementation: the unit tests check what Chrome is asked to do (the muted address, a normal window, the pause at the end, nothing full screen), what the daemon is sent, and the verdicts. Chrome, the daemon and the clock are faked at their edges, and the gate is tested over real loopback sockets.

## Verification

**Build:** `npm run typecheck && npm run build`
**Tests:** `npm test` (includes `npx vitest run tests/unit/scripts/playcheck.test.ts`), `npm run docs:check`
**Proof:** the real player page in the real streaming Chrome, fed by a throwaway daemon from this
worktree with the real resolver. The findings section and the seed are the artifacts R7.3 names.
- Harness: `.claude/skills/verify-notesd`: `verify.sh up --web --direct-stream` with
  `NOTESD_DIRECT_STREAM_CLI=$D/cli.mjs` in the environment, as in Step 6. Shared setup for
  every journey:
  `cd /home/miftah/.worktrees/mcp-notes/direct-streaming && V=.claude/skills/verify-notesd/scripts/verify.sh && PC=claude/streaming/direct/playcheck.mjs && D=$HOME/.local/state/notesd-playcheck && node $PC setup --dir "$D" && NOTESD_DIRECT_STREAM_CLI="$D/cli.mjs" $V up --web --direct-stream`
  (use the printed `URL`; `$V down <RUN>` at the end).
- Feature-map entries: `features/direct-streaming.md`
- Journeys:
  - **J1** · traces R7.3 — `node $PC run --daemon "$URL" --dir "$D" --check dash --provider VidLink movie 550 > "$D/j1.json"; node -e 'const r=require(process.argv[1]); const ok=r.session?.manifest_kind==="dash" && ["plays","browser_only","needs_fix"].includes(r.verdict) && r.summary?.muted_always===true && r.summary?.fullscreen_ever===false; console.log(ok?"PASS":"FAIL", r.verdict, r.cause); process.exit(ok?0:1)' "$D/j1.json"` → passes when it prints `PASS <verdict>` and that verdict is the one in the `dash | VidLink` row of the findings Playback table. A difference is a finding: report both. A `no_source` or `not_dash` answer is inconclusive, not a fail: rerun later.
  - **J2** · traces R7.3 — `node $PC run --daemon "$URL" --dir "$D" --check vidnest --provider VidNest movie 550 > "$D/j2.json"; node -e 'const r=require(process.argv[1]); const ok=r.provider==="VidNest" && ["plays","browser_only","needs_fix"].includes(r.verdict) && r.summary?.muted_always===true && r.summary?.fullscreen_ever===false; console.log(ok?"PASS":"FAIL", r.verdict, r.cause, r.segment?.format); process.exit(ok?0:1)' "$D/j2.json"` → passes when it prints `PASS <verdict>` matching the `vidnest | VidNest` row of the findings table. If the verdict is `browser_only`, VidNest's seed entry also has `"browser_only": true`.
  - **J3** · traces R7.3 — `node $PC run --daemon "$URL" --dir "$D" --check subtitle --provider VidLink movie 550 --watch-s 20 > "$D/j3.json"; node -e 'const r=require(process.argv[1]); const t=r.summary?.english_track; const ok=(r.verdict==="plays" && t?.mode==="showing" && t.cues>0) || ["browser_only","needs_fix"].includes(r.verdict); console.log(ok?"PASS":"FAIL", r.verdict, r.subtitle_source, JSON.stringify(t)); process.exit(ok?0:1)' "$D/j3.json"` → passes when it prints `PASS` and the verdict matches the `subtitle | VidLink` row of the findings table. For `plays`, an English track is `showing` with more than 0 cues in our page.
  - **J4** · traces R7.3 — `node claude/streaming/direct/playcheck.mjs audit --file docs/plans/2026-11-15-direct-streaming-findings.md --seed claude/streaming/direct/providers.seed.json` (no daemon needed) → passes when it exits 0 and prints `{"ok":true,"problems":[]}`. That means the Playback block has a decided row for dash, vidnest, subtitle and expiry, every `browser_only` row's provider is `"browser_only": true` in the seed, and every open `needs_fix` has a Fixes row. Also `grep -c '^- ' docs/plans/2026-11-15-direct-streaming-findings.md` finds the five filled "Answers" lines with no `{verdict}` placeholder left (`grep -c '{verdict}'` prints 0).
- Neighbor check: phase 1's resolver with the edited seed. `npx vitest run tests/unit/scripts` passes (phase 1's seed and order tests, the streaming-site tests, and this phase's). For each provider this phase marked, `node claude/streaming/direct/cli.mjs resolve movie 550 --only <that provider>` prints `attempts[0].outcome` `skipped_browser_only` and opens no tab. With no provider marked, the vitest run alone is the check.
- Cost: no LLM turns. Each live run is one resolve (an out-of-sight tab, real provider requests) plus 20 to 120 s of muted playback in a normal Chrome window brought to the front. J1 to J3 bring that window forward three times, so tell the owner first.
**Exit criteria:** `npm run typecheck`, `npm test` and `npm run docs:check` pass. The findings
Playback section says, with measured numbers, whether DASH (VidLink), VidNest and an English
subtitle (a separate file, plus an in-manifest track if any provider carries one) play in our
page, and records the forced-expiry refresh-and-continue result. `playcheck.mjs audit` passes, so
every provider that cannot play outside its own page is `browser_only` in the seed.

## Handoffs

- **Phase 3 (settled by the reconciler):** `NOTESD_DIRECT_STREAM_CLI` (the runner's CLI path,
  default `claude/streaming/direct/cli.mjs`, with its `configuration.md` row), and
  `verify.sh up --direct-stream` letting the caller's `NOTESD_DIRECT_STREAM_CLI` through. The
  play's `open` address has path `/stream/<id>`; the session route is `SessionInfo`; an upstream
  401/403/410 is passed through with `X-Notesd-Upstream`; a loopback upstream is allowed when the
  resolve returned it; seed `browser_only` changes reach `stream_providers` on load.
- **Phase 4 (settled by the reconciler):** `?muted=1`, `window.notesdStream` with
  `{ kind, levels, level, errors, refreshes }`, a `<title>` that is not the address. The expiry run
  here (Step 7.6) is live evidence for phase 4's R2.5. Phase 4's verifier can cite the
  `expiry | VidFast` row. This phase does not claim R2.5.
- **Phase 2:** `browser_only` for causes seen at resolve time (blob-only players with no manifest
  on the network, a player that never requests one) stays with phase 2. This phase marks only
  playback causes (`drm`, `encrypted_segments`, `obfuscated_segments`). Phase 2 also leaves the
  `## Playback` heading. `findings` appends one if it is missing.
- **Phase 5 (settled by the reconciler):** a TMDB miss while ensuring the title records nothing and
  does not fail `POST /api/stream/play` (phase 5's Step 8). The campaign's daemon uses verify's
  fake TMDB, which lacks 550, so its plays write no stream play rows; that is expected here.
- **Daemon faults found live** (`src/directStream/*`) are filed as tasks from Step 8. They are
  not fixed in this phase.
- **Untested here, deliberately:** a full-screen play with sound is the owner's to run (index
  Decisions). DASH expiry is not exercised because the gate handles HLS only. If a DASH provider
  becomes the preferred source, its refresh needs its own check.

## Rollback

Delete `claude/streaming/direct/playcheck.mjs`, `claude/streaming/direct/playgate.mjs` and
`tests/unit/scripts/playcheck.test.ts`. Remove the Playback section body from the findings file
(the heading stays for phase 2's structure) and the bullet from `features/direct-streaming.md`.
To undo the seed marks, revert the `browser_only`/`notes` edits in `providers.seed.json`, one
commit. Revert each `web/src/stream` fix's own commit with its test. Delete `$HOME/.local/state/notesd-playcheck`.
Nothing in `src/` or the database changes in this phase.
