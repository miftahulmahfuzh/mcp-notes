import { beforeEach, describe, expect, it } from 'vitest';
import { fixedSsid, ssidFrom, StreamDownloads } from '../../../../src/directStream/downloads/service.js';
import type { TorrentFetch } from '../../../../src/directStream/downloads/types.js';
import { downloadWarpOf } from '../../../../src/directStream/downloads/warp.js';
import { WarpHolds } from '../../../../src/directStream/torrentWarp.js';
import { refLabel, type StreamRef } from '../../../../src/directStream/types.js';
import type { WarpStatus } from '../../../../src/streaming/warp.js';
import { MemoryDownloadRecords } from '../../../helpers/memoryDownloadRecords.js';
import { FakeCaches, FakeTorrents, FakeWarp } from './fakes.js';

const FILM: StreamRef = { kind: 'movie', tmdbId: 550 };
const EPISODE: StreamRef = { kind: 'tv', tmdbId: 1399, season: 1, episode: 2 };
const H1 = 'a1'.repeat(20);
const H2 = 'b2'.repeat(20);
const OTHER = 'c3'.repeat(20);
let clock: number;
beforeEach(() => {
  clock = Date.parse('2026-11-20T12:00:00Z');
});

const ok = (infoHash: string, name = 'Film.2026.1080p.WEB-DL'): TorrentFetch => ({ ok: true, handle: { infoHash, fileIndex: 0, name }, detail: `${name}, 1080p` });

function build(o: { repo?: MemoryDownloadRecords; torrents?: FakeTorrents | null; caches?: FakeCaches | null; ssid?: string | null; warp?: WarpStatus; warpOff?: boolean } = {}) {
  const repo = o.repo ?? new MemoryDownloadRecords();
  const torrents = o.torrents === undefined ? new FakeTorrents() : o.torrents;
  const caches = o.caches === undefined ? new FakeCaches() : o.caches;
  const playing: { hashes: string[] } = { hashes: [] };
  const sw = new FakeWarp({ warp: o.warp ?? 'disconnected', ssid: o.ssid === undefined ? 'kosan_baruu' : o.ssid });
  // The stream service's one WarpHolds: a torrent play asks through the same holders (R1.12).
  const holds = new WarpHolds(sw);
  if (torrents !== null) torrents.warpIsOn = () => sw.state.warp === 'connected';
  const swept: number[] = [];
  const lines: string[] = [];
  const downloads = new StreamDownloads({
    host: 'host-a',
    repo,
    torrents,
    caches,
    ssid: ssidFrom(sw, { ttlMs: 0 }),
    warp: o.warpOff === true ? null : downloadWarpOf(holds, sw),
    playingTorrents: () => playing.hashes,
    afterDone: () => void swept.push(clock),
    now: () => new Date(clock),
    log: (line) => void lines.push(line),
    every: () => () => undefined,
  });
  const drive = async (): Promise<void> => {
    await downloads.tick();
    await downloads.settled();
  };
  /** WARP switched on and off, in order (reads left out). */
  const switches = (): string[] => sw.calls.filter((c) => c !== 'status');
  return { downloads, repo, torrents: torrents as FakeTorrents, caches: caches as FakeCaches, playing, sw, holds, switches, swept, lines, drive };
}

/** A torrent fetch whose every swarm sent no file list: no peer at all. */
const NO_PEERS: TorrentFetch = { ok: false, error: 'no_source', detail: 'Torrent: Film.2026.1080p.WEB-DL: no_stream (no file list from the swarm in time)', noPeers: true };

/** On SSID Employee, a 1080p torrent whose peers answer only through WARP. */
function officeThroughWarp() {
  const t = build({ ssid: 'Employee' });
  t.torrents.answers.set('band:preferred', NO_PEERS);
  t.torrents.viaWarp.set('band:preferred', ok(H1));
  t.torrents.viaWarp.set(`hash:${H1}`, ok(H1));
  return t;
}

describe('R1.2 the order of a download with no source named', () => {
  it('takes a 1080p torrent with live seeds first, and keeps it', async () => {
    const t = build();
    t.torrents.answers.set('band:preferred', ok(H1));
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    expect(t.torrents.calls).toEqual(['fetch band:preferred', `keep ${H1} true`]);
    expect(t.caches.calls).toEqual([]);
    expect(t.repo.rows[0]).toMatchObject({ state: 'running', source: 'torrent', sourceId: H1 });
  });

  it('goes to the cloud at 1080p or lower when no 1080p torrent can be had', async () => {
    const t = build();
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    expect(t.torrents.calls).toEqual(['fetch band:preferred']);
    expect(t.caches.calls).toEqual([`request ${refLabel(FILM)} 1080`]);
    expect(t.repo.rows[0]).toMatchObject({ state: 'running', source: 'cloud' });
  });

  it('tries a torrent below 1080p only once the cloud failed', async () => {
    const t = build();
    t.torrents.answers.set('band:below', ok(H2, 'Film.2026.720p.WEB-DL'));
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    expect(t.torrents.calls).toEqual(['fetch band:preferred']);
    t.caches.set(FILM, { state: 'failed', running: false, error: 'no_source', errorDetail: 'no provider streams it' });
    await t.drive();
    expect(t.torrents.calls).toEqual(['fetch band:preferred', 'fetch band:below', `keep ${H2} true`]);
    expect(t.repo.rows[0]).toMatchObject({ state: 'running', source: 'torrent', sourceId: H2 });
  });

  it('finishes a cloud download when its cache is ready', async () => {
    const t = build();
    await t.downloads.request(EPISODE, { via: 'cloud' });
    await t.downloads.settled();
    expect(t.torrents.calls).toEqual([]);
    t.caches.set(EPISODE, { state: 'ready', running: false, progress: 1, bytes: 900 });
    await t.drive();
    expect(t.repo.rows[0]).toMatchObject({ state: 'done', source: 'cloud' });
    expect(t.swept).toHaveLength(1);
  });
});

describe('a download carries on the torrent this machine already holds part of', () => {
  it('opens the 1080p torrent fetched ahead by its info hash first, asking no index, and keeps it', async () => {
    const t = build();
    t.torrents.parts.set(refLabel(EPISODE), { infoHash: H2, height: 1080 });
    t.torrents.answers.set(`hash:${H2}`, ok(H2));
    t.torrents.answers.set('band:preferred', ok(H1));
    await t.downloads.request(EPISODE, { via: 'auto' });
    await t.downloads.settled();
    expect(t.torrents.calls).toEqual([`fetch hash:${H2}`, `keep ${H2} true`]);
    expect(t.repo.rows[0]).toMatchObject({ state: 'running', source: 'torrent', sourceId: H2 });
  });

  it('goes on with the planned order when the held torrent gives nothing', async () => {
    const t = build();
    t.torrents.parts.set(refLabel(EPISODE), { infoHash: H2, height: 1080 });
    t.torrents.answers.set('band:preferred', ok(H1));
    await t.downloads.request(EPISODE, { via: 'torrent' });
    await t.downloads.settled();
    expect(t.torrents.calls).toEqual([`fetch hash:${H2}`, 'fetch band:preferred', `keep ${H1} true`]);
    expect(t.repo.rows[0]).toMatchObject({ state: 'running', sourceId: H1 });
  });

  it('leaves a held torrent that is not 1080p, a cloud download and a torrent picked by hand as they are', async () => {
    const low = build();
    low.torrents.parts.set(refLabel(EPISODE), { infoHash: H2, height: 720 });
    low.torrents.answers.set('band:preferred', ok(H1));
    await low.downloads.request(EPISODE, { via: 'auto' });
    await low.downloads.settled();
    expect(low.torrents.calls).toEqual(['fetch band:preferred', `keep ${H1} true`]);

    const cloud = build();
    cloud.torrents.parts.set(refLabel(EPISODE), { infoHash: H2, height: 1080 });
    await cloud.downloads.request(EPISODE, { via: 'cloud' });
    await cloud.downloads.settled();
    expect(cloud.torrents.calls).toEqual([]);

    const picked = build();
    picked.torrents.parts.set(refLabel(EPISODE), { infoHash: H2, height: 1080 });
    picked.torrents.answers.set(`hash:${H1}`, ok(H1));
    await picked.downloads.request(EPISODE, { via: 'torrent', infoHash: H1 });
    await picked.downloads.settled();
    expect(picked.torrents.calls).toEqual([`fetch hash:${H1}`, `keep ${H1} true`]);
  });
});

describe('R1.4 the office network: a torrent download asks again through WARP before the cloud', () => {
  it('switches WARP on once when no peer answered, asks the torrents again, and downloads the 1080p torrent', async () => {
    const t = officeThroughWarp();
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    expect(t.torrents.calls).toEqual(['fetch band:preferred', `forget ${refLabel(FILM)}`, 'fetch band:preferred (WARP)', `keep ${H1} true`]);
    expect(t.switches()).toEqual(['on']);
    expect(t.caches.calls).toEqual([]);
    expect(t.repo.rows[0]).toMatchObject({ state: 'running', source: 'torrent', sourceId: H1 });
  });

  it('opens a torrent download carried on after a restart under the same rule, instead of waiting', async () => {
    const t = officeThroughWarp();
    const { row } = await t.repo.create('host-a', { ref: FILM, via: 'auto', infoHash: null, batch: null }, new Date(clock));
    await t.repo.on('host-a', row.id, { source: 'torrent', infoHash: H1 }, new Date(clock));
    t.torrents.answers.set(`hash:${H1}`, NO_PEERS);
    await t.downloads.start();
    await t.downloads.settled();
    expect(t.torrents.calls).toEqual([`fetch hash:${H1}`, `forget ${refLabel(FILM)}`, `fetch hash:${H1} (WARP)`, `keep ${H1} true`]);
    expect(t.switches()).toEqual(['on']);
    expect(t.repo.rows[0]).toMatchObject({ state: 'running', source: 'torrent', sourceId: H1 });
  });

  it('fails a torrent asked for by hand with no_peers_here once WARP did not reach a peer either', async () => {
    const t = build({ ssid: 'Employee' });
    t.torrents.answers.set('band:preferred', NO_PEERS);
    t.torrents.answers.set('band:below', NO_PEERS);
    await t.downloads.request(FILM, { via: 'torrent' });
    await t.downloads.settled();
    expect(t.switches()).toEqual(['on', 'off', 'on', 'off']);
    expect(t.caches.calls).toEqual([]);
    const [view] = await t.downloads.list();
    expect(view).toMatchObject({ state: 'failed', error: 'no_peers_here' });
    expect(view!.detail).toContain('through Cloudflare WARP');
  });

  it('never touches a WARP the owner turned on: the torrents are asked through it once, then the cloud', async () => {
    const t = build({ ssid: 'Employee', warp: 'connected' });
    t.torrents.answers.set('band:preferred', NO_PEERS);
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    expect(t.torrents.calls).toEqual(['fetch band:preferred (WARP)']);
    expect(t.switches()).toEqual([]);
    expect(t.caches.calls).toEqual([`request ${refLabel(FILM)} 1080`]);
  });

  it('switches nothing with NOTESD_STREAM_WARP=off: the torrent is tried, and the order goes on', async () => {
    const t = build({ ssid: 'Employee', warpOff: true });
    t.torrents.answers.set('band:preferred', NO_PEERS);
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    expect(t.torrents.calls).toEqual(['fetch band:preferred']);
    expect(t.switches()).toEqual([]);
    expect(t.caches.calls).toEqual([`request ${refLabel(FILM)} 1080`]);
  });

  it('asks nothing again on another network', async () => {
    const t = build({ ssid: 'kosan_baruu' });
    t.torrents.answers.set('band:preferred', NO_PEERS);
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    expect(t.torrents.calls).toEqual(['fetch band:preferred']);
    expect(t.switches()).toEqual([]);
    expect(t.caches.calls).toEqual([`request ${refLabel(FILM)} 1080`]);
  });
});

describe('R1.4 R1.12 switching WARP on did not reach a peer', () => {
  it('puts WARP back off, and only then goes on to the cloud', async () => {
    const t = build({ ssid: 'Employee' });
    t.torrents.answers.set('band:preferred', NO_PEERS);
    const warpAtCloud: string[] = [];
    const request = t.caches.request.bind(t.caches);
    t.caches.request = async (ref, maxHeight) => {
      warpAtCloud.push(t.sw.state.warp);
      return request(ref, maxHeight);
    };
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    expect(t.torrents.calls).toEqual(['fetch band:preferred', `forget ${refLabel(FILM)}`, 'fetch band:preferred (WARP)']);
    expect(t.switches()).toEqual(['on', 'off']);
    expect(warpAtCloud).toEqual(['disconnected']);
    expect(t.holds.ours).toBe(false);
    expect(t.repo.rows[0]).toMatchObject({ state: 'running', source: 'cloud' });
  });
});

describe('R1.12 a download lets go of the WARP it held', () => {
  it('puts WARP back off when the download is done', async () => {
    const t = officeThroughWarp();
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    expect(t.switches()).toEqual(['on']);
    t.torrents.whole.add(H1);
    await t.drive();
    expect(t.repo.rows[0]).toMatchObject({ state: 'done', source: 'torrent', sourceId: H1 });
    expect(t.switches()).toEqual(['on', 'off']);
    expect(t.holds.ours).toBe(false);
  });

  it('puts WARP back off when the download is cancelled', async () => {
    const t = officeThroughWarp();
    const asked = await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    await t.downloads.cancel(asked.download!.id);
    await t.downloads.settled();
    expect(t.switches()).toEqual(['on', 'off']);
    expect(t.holds.ours).toBe(false);
  });

  it('keeps WARP on when it pauses for a torrent playing on screen, and opens its torrent again through it after', async () => {
    const t = officeThroughWarp();
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    t.playing.hashes = [OTHER];
    await t.drive();
    expect((await t.downloads.list())[0]).toMatchObject({ state: 'paused', source: 'torrent', source_id: H1 });
    expect(t.switches()).toEqual(['on']);
    expect(t.holds.ours).toBe(false);
    t.playing.hashes = [];
    await t.drive();
    expect(t.torrents.calls.slice(-2)).toEqual([`fetch hash:${H1} (WARP)`, `keep ${H1} true`]);
    expect(t.switches()).toEqual(['on']);
    expect(t.repo.rows[0]).toMatchObject({ state: 'running' });
  });

  it('leaves WARP on while a torrent play still holds it, and the play letting go puts it back off', async () => {
    const t = officeThroughWarp();
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    // A torrent play asks through the same WARP: it joins the holders and switches nothing.
    expect(await t.holds.hold()).toMatchObject({ warp: 'connected' });
    t.torrents.whole.add(H1);
    await t.drive();
    expect(t.repo.rows[0]).toMatchObject({ state: 'done' });
    expect(t.switches()).toEqual(['on']);
    expect(await t.holds.release(false)).toMatchObject({ warp: 'disconnected' });
    expect(t.switches()).toEqual(['on', 'off']);
  });

  it('leaves WARP as it is when the daemon stops, as a torrent play’s WARP is', async () => {
    const t = officeThroughWarp();
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    await t.downloads.close();
    await t.downloads.settled();
    expect(t.switches()).toEqual(['on']);
    expect(t.repo.rows[0]).toMatchObject({ state: 'running', sourceId: H1 });
  });
});

describe('R1.5 a dub is left undownloaded', () => {
  it('goes on to the next band when the torrents found are dubs, and fails as dubbed when nothing else is left', async () => {
    const t = build({ caches: null });
    t.torrents.answers.set('band:preferred', { ok: false, error: 'dubbed', detail: 'Torrent: Film.2026.1080p.RUS: dubbed (its audio is ru, not the original en)' });
    t.torrents.answers.set('band:below', { ok: false, error: 'dubbed', detail: 'Torrent: Film.2026.720p.RUS: dubbed' });
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    expect(t.torrents.calls).toEqual(['fetch band:preferred', 'fetch band:below']);
    expect((await t.downloads.list())[0]).toMatchObject({ state: 'failed', error: 'dubbed' });
  });
});

describe('R1.6 a download the owner asked for is kept', () => {
  it('marks its torrent kept when it starts, and clears the mark when it is cancelled', async () => {
    const t = build();
    t.torrents.answers.set('band:preferred', ok(H1));
    const asked = await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    expect(t.torrents.kept.get(H1)).toBe(true);
    await t.downloads.cancel(asked.download!.id);
    expect(t.torrents.calls.slice(-2)).toEqual([`release ${H1}`, `keep ${H1} false`]);
    expect(await t.downloads.list()).toEqual([]);
  });

  it('asks the cache for the owner’s cache, never an auto one', async () => {
    const t = build();
    await t.downloads.request(FILM, { via: 'cloud' });
    await t.downloads.settled();
    expect(t.caches.calls).toEqual([`request ${refLabel(FILM)} 1080`]);
  });
});

describe('R1.7 a restart carries downloads on from what is on disk', () => {
  it('opens the same torrent again by its info hash, asking no index', async () => {
    const repo = new MemoryDownloadRecords();
    const before = build({ repo });
    before.torrents.answers.set('band:preferred', ok(H1));
    await before.downloads.request(FILM, { via: 'auto' });
    await before.downloads.settled();
    await before.downloads.close();
    expect(before.torrents.calls.at(-1)).toBe(`release ${H1}`);
    expect(repo.rows[0]).toMatchObject({ state: 'running', sourceId: H1 });
    const after = build({ repo });
    after.torrents.answers.set(`hash:${H1}`, ok(H1));
    expect(await after.downloads.start()).toBe(1);
    await after.downloads.settled();
    expect(after.torrents.calls).toEqual([`fetch hash:${H1}`, `keep ${H1} true`]);
    expect(repo.rows[0]).toMatchObject({ state: 'running', source: 'torrent', sourceId: H1 });
  });

  it('follows a cloud download’s cache again, and queued ones start in order', async () => {
    const repo = new MemoryDownloadRecords();
    const before = build({ repo, torrents: null });
    await before.downloads.request(FILM, { via: 'cloud' });
    await before.downloads.settled();
    await before.downloads.close();
    const after = build({ repo, torrents: null });
    expect(await after.downloads.start()).toBe(1);
    await after.downloads.settled();
    expect(after.caches.calls).toEqual([`request ${refLabel(FILM)} 1080`]);
    expect(repo.rows[0]).toMatchObject({ state: 'running', source: 'cloud' });
  });

  it('tries a carried-on torrent again a minute later when its swarm gives nothing, then fails', async () => {
    const t = build();
    const { row } = await t.repo.create('host-a', { ref: FILM, via: 'auto', infoHash: null, batch: null }, new Date(clock));
    await t.repo.on('host-a', row.id, { source: 'torrent', infoHash: H1 }, new Date(clock));
    await t.downloads.start();
    await t.downloads.settled();
    expect(t.repo.rows[0]).toMatchObject({ state: 'queued' });
    clock += 61_000;
    await t.drive();
    clock += 61_000;
    await t.drive();
    expect(t.torrents.calls.filter((c) => c === `fetch hash:${H1}`)).toHaveLength(3);
    expect(t.repo.rows[0]).toMatchObject({ state: 'failed', error: 'no_source' });
    expect(t.torrents.calls.at(-1)).toBe(`keep ${H1} false`);
  });
});

describe('R1.8 a torrent download finishes only once it is ready to play offline', () => {
  it('holds the torrent while its remux runs and its subtitle search goes on, then lets go and queues the previews', async () => {
    const t = build();
    t.torrents.answers.set('band:preferred', ok(H1));
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    t.torrents.whole.add(H1);
    t.torrents.remux.set(H1, 'running');
    t.torrents.searching.add(H1);
    await t.drive();
    expect(t.repo.rows[0]).toMatchObject({ state: 'running' });
    t.torrents.remux.set(H1, 'whole');
    await t.drive();
    expect(t.repo.rows[0]).toMatchObject({ state: 'running' });
    t.torrents.searching.delete(H1);
    await t.drive();
    expect(t.repo.rows[0]).toMatchObject({ state: 'done', source: 'torrent', sourceId: H1, bytesDone: 100 });
    expect(t.torrents.calls.at(-1)).toBe(`release ${H1}`);
    expect(t.swept).toHaveLength(1);
    expect(await t.downloads.list()).toEqual([]);
  });

  it('starts a failed remux again once, and finishes after a second failure (a play remuxes it from disk)', async () => {
    const t = build();
    t.torrents.answers.set('band:preferred', ok(H1));
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    t.torrents.whole.add(H1);
    t.torrents.remux.set(H1, 'failed');
    await t.drive();
    expect(t.torrents.calls.at(-1)).toBe(`retry remux ${H1}`);
    await t.drive();
    expect(t.repo.rows[0]).toMatchObject({ state: 'done' });
  });

  it('queues nothing for a title already whole here', async () => {
    const t = build();
    t.torrents.onDiskRefs.add(refLabel(FILM));
    expect(await t.downloads.request(FILM, { via: 'auto' })).toEqual({ download: null, created: false, onDisk: true });
    expect(t.repo.rows).toEqual([]);
  });
});

describe('R1.9 a torrent playing on screen comes first', () => {
  it('pauses the torrent download while another torrent plays, and carries it on when the play ends', async () => {
    const t = build();
    t.torrents.answers.set('band:preferred', ok(H1));
    t.torrents.answers.set(`hash:${H1}`, ok(H1));
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    t.playing.hashes = [OTHER];
    await t.drive();
    expect(t.torrents.calls).toEqual(['fetch band:preferred', `keep ${H1} true`, `release ${H1}`]);
    expect((await t.downloads.list())[0]).toMatchObject({ state: 'paused', source: 'torrent', source_id: H1 });
    await t.drive();
    expect(t.torrents.calls).toHaveLength(3);
    t.playing.hashes = [];
    await t.drive();
    expect(t.torrents.calls.slice(3)).toEqual([`fetch hash:${H1}`, `keep ${H1} true`]);
    expect(t.repo.rows[0]).toMatchObject({ state: 'running' });
  });

  it('starts no torrent download while a torrent plays, but a cloud one does', async () => {
    const t = build();
    t.playing.hashes = [OTHER];
    await t.downloads.request(FILM, { via: 'torrent' });
    await t.downloads.request(EPISODE, { via: 'cloud' });
    await t.downloads.settled();
    expect(t.torrents.calls).toEqual([]);
    expect(t.caches.calls).toEqual([`request ${refLabel(EPISODE)} 1080`]);
  });

  it('does not pause for the play of the very torrent it downloads', async () => {
    const t = build();
    t.torrents.answers.set('band:preferred', ok(H1));
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    t.playing.hashes = [H1];
    await t.drive();
    expect(t.repo.rows[0]).toMatchObject({ state: 'running' });
  });
});

describe('R1.11 a download nothing can give fails with a reason', () => {
  it('says no_source and what each step saw, in the list', async () => {
    const t = build();
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    t.caches.set(FILM, { state: 'failed', running: false, error: 'no_source', errorDetail: 'no provider streams it' });
    await t.drive();
    const [view] = await t.downloads.list();
    expect(view).toMatchObject({ state: 'failed', error: 'no_source', kind: 'movie', tmdb_id: 550 });
    expect(view!.detail).toBe('torrent 1080p: no_source (no torrent fits); cloud at 1080p or lower: no_source (no provider streams it); torrent below 1080p: no_source (no torrent fits)');
  });

  it('keeps the cache’s own code for a cloud download', async () => {
    const t = build();
    await t.downloads.request(EPISODE, { via: 'cloud' });
    await t.downloads.settled();
    t.caches.set(EPISODE, { state: 'failed', running: false, error: 'download_failed', errorDetail: 'six tries' });
    await t.drive();
    expect((await t.downloads.list())[0]).toMatchObject({ state: 'failed', error: 'download_failed', season: 1, episode: 2 });
  });

  it('refuses a malformed pick and a pick without via torrent', async () => {
    const t = build();
    await expect(t.downloads.request(FILM, { via: 'torrent', infoHash: 'nope' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(t.downloads.request(FILM, { via: 'auto', infoHash: H1 })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(t.downloads.cancel('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'unknown_download' });
  });
});

describe('the list reads progress live', () => {
  it('answers a running torrent’s bytes, peers and rate', async () => {
    const t = build();
    t.torrents.answers.set('band:preferred', ok(H1));
    await t.downloads.request(FILM, { via: 'auto' });
    await t.downloads.settled();
    expect((await t.downloads.list())[0]).toMatchObject({ state: 'running', progress: 0.4, bytes_done: 40, bytes_total: 100, peers: 5, down_kbps: 900, available: true });
  });

  it('lists a title’s finished download only for that title, and only while it is still whole here', async () => {
    const t = build();
    await t.downloads.request(EPISODE, { via: 'cloud' });
    await t.downloads.settled();
    t.caches.set(EPISODE, { state: 'ready', running: false, progress: 1, bytes: 900 });
    await t.drive();
    const title = { kind: 'tv' as const, tmdbId: 1399 };
    expect(await t.downloads.list()).toEqual([]);
    expect(await t.downloads.list(title)).toMatchObject([{ state: 'done', source: 'cloud', season: 1, episode: 2, progress: 1 }]);
    // Deleted on the Cache page: no longer on this machine, so no longer listed.
    t.caches.caches.clear();
    expect(await t.downloads.list(title)).toEqual([]);
  });
});

describe('R1.4 the SSID pinned by NOTESD_STREAM_DOWNLOAD_SSID', () => {
  it('answers the pinned value and reads nothing', async () => {
    expect(await fixedSsid('verify-home')()).toBe('verify-home');
  });
});
