#!/usr/bin/env node
// Stands in for claude/streaming/direct/cli.mjs in tests and in `verify.sh up --direct-stream`: it opens
// no Chrome and reaches no provider. Its state is the folder named by DIRECT_STREAM_FAKE_DIR:
//   upstream.json  {"origin": ...} of the fixture stream host (upstream.mjs) its answers point at
//   mode           hls (default) | dash | dash_film | hls_token | no_source | no_chrome: the next resolve's answer
//                  (dash_film: the playable film under <dir>/film, at the address that carries the
//                  token in <dir>/token; upstream.mjs refuses every older token. hls_token: raises
//                  <dir>/token by one and answers upstream.mjs's tokened HLS film under that token,
//                  with a Korean original-language audio track)
//   calls.jsonl    one line per call, appended: {"at", "args"}
// `resolve` answers like the real CLI, reading --providers and skipping browser-only rows: with two or
// more usable providers the first is a bot_check and the second resolves; with one, it resolves; with
// none, no_source. `open` answers {"ok": true}.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { currentFilmToken, FIXTURE_ORIGIN, FIXTURE_REFERER, FIXTURE_USER_AGENT } from './upstream.mjs';

const dir = process.env.DIRECT_STREAM_FAKE_DIR;
const args = process.argv.slice(2);

function print(value, code = 0) {
  console.log(JSON.stringify(value, null, 2));
  process.exitCode = code;
}

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

function main() {
  if (!dir) return print({ ok: false, error: 'fake_not_configured', detail: 'set DIRECT_STREAM_FAKE_DIR' }, 2);
  appendFileSync(path.join(dir, 'calls.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), args })}\n`);
  if (args[0] === 'open') return print({ ok: true, url: args[1] ?? null, fullscreen: args.includes('--fullscreen') });
  if (args[0] !== 'resolve') return print({ ok: false, error: 'usage', detail: `unknown command ${args[0] ?? ''}` }, 2);
  const positional = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      i++;
      continue;
    }
    positional.push(args[i]);
  }
  const [kind, id, season, episode] = positional;
  const ref = {
    kind,
    tmdb_id: Number(id),
    season: season === undefined ? null : Number(season),
    episode: episode === undefined ? null : Number(episode),
  };
  const modeFile = path.join(dir, 'mode');
  const mode = (existsSync(modeFile) ? readFileSync(modeFile, 'utf8').trim() : '') || 'hls';
  const providersFile = flag('--providers');
  const providers = providersFile
    ? JSON.parse(readFileSync(providersFile, 'utf8'))
        .filter((p) => !p.browser_only)
        .map((p) => p.name)
    : [];
  if (mode === 'no_chrome') return print({ ok: false, ...ref, source: null, error: 'no_chrome', detail: 'fake: Chrome is not installed', attempts: [] }, 1);
  if (mode === 'no_source' || providers.length === 0) {
    return print(
      {
        ok: false,
        ...ref,
        source: null,
        error: 'no_source',
        attempts: providers.slice(0, 2).map((name) => ({ provider: name, outcome: 'no_stream', took_s: 0.5, detail: 'fake: nothing captured' })),
      },
      1,
    );
  }
  const { origin } = JSON.parse(readFileSync(path.join(dir, 'upstream.json'), 'utf8'));
  const chosen = providers.length > 1 ? providers[1] : providers[0];
  const attempts = providers.length > 1 ? [{ provider: providers[0], outcome: 'bot_check', took_s: 1.2, detail: 'fake: Just a moment...' }] : [];
  attempts.push({ provider: chosen, outcome: 'resolved', took_s: 2.5, detail: '' });
  let manifestUrl = mode === 'dash_film' ? `${origin}/film/t${currentFilmToken(dir)}/manifest.mpd` : mode === 'dash' ? `${origin}/dash/manifest.mpd` : `${origin}/hls/master.m3u8`;
  if (mode === 'hls_token') {
    const next = currentFilmToken(dir) + 1;
    writeFileSync(path.join(dir, 'token'), `${next}\n`);
    manifestUrl = `${origin}/tok/t${next}/master.m3u8`;
  }
  return print({
    ok: true,
    ...ref,
    source: {
      provider: chosen,
      embed_url: `https://embed.fixture/${kind}/${id}`,
      manifest_url: manifestUrl,
      manifest_kind: mode === 'dash' || mode === 'dash_film' ? 'dash' : 'hls',
      headers: { referer: FIXTURE_REFERER, origin: FIXTURE_ORIGIN, user_agent: FIXTURE_USER_AGENT },
      subtitles: [{ url: `${origin}/subs/en.srt`, lang: 'en', label: 'English', format: 'srt', source: 'request' }],
      best_height: 1080,
      en_subtitle: true,
      took_s: 2.5,
      ...(mode === 'hls_token' ? { audio: { languages: ['en', 'ko'], tracks: 2, original: true, track: { lang: 'ko', label: 'Korean' } } } : {}),
    },
    attempts,
  });
}

main();
