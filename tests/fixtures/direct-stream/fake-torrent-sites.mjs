#!/usr/bin/env node
// Stands in for claude/streaming/torrent/cli.mjs in `verify.sh up --direct-stream`: it opens no
// Chrome and reaches no site. Its state is the folder named by TORRENT_SITES_FAKE_DIR:
//   mode         rows (default) | empty | bot_check | no_chrome: how every site answers
//                (rows: 1337x lists one release, ext.to none)
//   calls.jsonl  one line per call, appended: {"at", "args"}
// The release 1337x lists is the torrent TORRENT_SITES_FIXTURE names ({"info_hash", "trackers"?, "size_bytes"?}: the
// loopback-seeded fixture torrent under `up --torrent`), else a made-up Sintel. Its name is made from the asked
// `--title` and `--year` (`<Title>.<Year>.1080p.WEB-DL.x264-NOTESD`), so the finder's title check keeps it.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const dir = process.env.TORRENT_SITES_FAKE_DIR;
const fixtureFile = process.env.TORRENT_SITES_FIXTURE;
const args = process.argv.slice(2);
const DEFAULT_RELEASE = { info_hash: 'a779fa758f2229586eebc2e5960eb32fe5659596', name: 'Sintel.2010.720p.BluRay.x264-FIXTURE', trackers: [], size_bytes: 143_151_268 };

function print(value, code = 0) {
  console.log(JSON.stringify(value, null, 2));
  process.exitCode = code;
}

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

function main() {
  if (!dir) return print({ ok: false, error: 'fake_not_configured', detail: 'set TORRENT_SITES_FAKE_DIR' }, 2);
  appendFileSync(path.join(dir, 'calls.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), args })}\n`);
  if (args[0] === '--sites') return print([{ name: '1337x', label: '1337x' }, { name: 'ext', label: 'ext.to' }]);
  const [site, command] = args;
  const origin = flag('--origin') ?? (site === 'ext' ? 'https://ext.to' : 'https://1337x.la');
  const modeFile = path.join(dir, 'mode');
  const mode = (existsSync(modeFile) ? readFileSync(modeFile, 'utf8').trim() : '') || 'rows';
  if (mode === 'bot_check') return print({ ok: false, site, origin, error: 'bot_check', detail: 'fake: the page stayed on "Just a moment..."' }, 1);
  if (mode === 'no_chrome') return print({ ok: false, site, origin, error: 'no_chrome', detail: 'fake: chrome.exe was not found' }, 1);
  const release = fixtureFile && existsSync(fixtureFile) ? { ...DEFAULT_RELEASE, ...JSON.parse(readFileSync(fixtureFile, 'utf8')) } : DEFAULT_RELEASE;
  const pageUrl = `${origin}/torrent/1/fixture/`;
  if (command === 'search') {
    const title = flag('--title');
    const year = flag('--year');
    const name = title ? `${title.replace(/[^A-Za-z0-9]+/g, '.').replace(/^\.|\.$/g, '')}${year ? `.${year}` : ''}.1080p.WEB-DL.x264-NOTESD` : release.name;
    const rows = mode === 'rows' && site === '1337x' ? [{ name, page_url: pageUrl, seeds: 42, leeches: 3, size_bytes: release.size_bytes }] : [];
    return print({ ok: true, site, origin, url: `${origin}/category-search/fixture/Movies/1/`, rows, others: 0 });
  }
  if (command === 'magnets') {
    const originAt = args.indexOf('--origin');
    const urls = args.filter((arg, i) => /^https?:\/\//.test(arg) && i !== originAt + 1);
    return print({
      ok: true,
      site,
      origin,
      magnets: urls.map((url) =>
        url === pageUrl
          ? { page_url: url, info_hash: release.info_hash, trackers: release.trackers ?? [], magnet: `magnet:?xt=urn:btih:${release.info_hash}`, error: null }
          : { page_url: url, info_hash: null, trackers: [], magnet: null, error: 'fake: not the fixture page' },
      ),
    });
  }
  return print({ ok: false, site, origin, error: 'usage', detail: `fake: unknown command ${command ?? ''}` }, 2);
}

main();
