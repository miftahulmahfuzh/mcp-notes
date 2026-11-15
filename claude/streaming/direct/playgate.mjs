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
