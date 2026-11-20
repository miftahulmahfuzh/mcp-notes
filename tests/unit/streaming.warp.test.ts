import { describe, expect, it, vi } from 'vitest';
import { noPeersAtAll, torrentThroughWarp, WARP_ATTEMPT, WarpHolds, type TorrentWarp } from '../../src/directStream/torrentWarp.js';
import { NO_FILE_LIST } from '../../src/directStream/torrent/source.js';
import type { TorrentResolve } from '../../src/directStream/torrent/source.js';
import type { ResolveAttempt } from '../../src/directStream/types.js';
import { readWarpAnswer, scriptWarp, type WarpState, type WarpSwitch } from '../../src/streaming/warp.js';

const noPeers = (name: string): ResolveAttempt => ({ provider: `Torrent: ${name}`, outcome: 'no_stream', took_s: 20, detail: `${NO_FILE_LIST} (No peer sent the file list within 20 s.)` });
const index: ResolveAttempt = { provider: 'Index: torrentio', outcome: 'resolved', took_s: 1, detail: '3 torrents' };
const failed = (attempts: ResolveAttempt[]): Extract<TorrentResolve, { ok: false }> => ({ ok: false, error: 'no_source', attempts });
const played = { ok: true, torrent: {}, source: {}, attempts: [{ provider: 'Torrent: A', outcome: 'resolved', took_s: 4, detail: 'plays' }] } as unknown as TorrentResolve;

function fakeWarp(start: WarpState, o: { setFails?: boolean } = {}): WarpSwitch & { calls: string[] } {
  let now = { ...start };
  const calls: string[] = [];
  return {
    calls,
    status: async () => {
      calls.push('status');
      return now;
    },
    set: async (on) => {
      calls.push(on ? 'on' : 'off');
      if (o.setFails) return { ...now, ok: false, error: 'did_not_switch', changed: false };
      now = { ...now, warp: on ? 'connected' : 'disconnected', changed: true };
      return now;
    },
  };
}
const office: WarpState = { ok: true, warp: 'disconnected', ssid: 'Employee' };

describe('a torrent play that found no peer at all', () => {
  it('is every torrent tried ending at the file list, never a torrent that answered', () => {
    expect(noPeersAtAll([index, noPeers('A'), noPeers('B')])).toBe(true);
    expect(noPeersAtAll([index, noPeers('A'), { provider: 'Torrent: B', outcome: 'skipped', took_s: null, detail: 'another torrent was chosen' }])).toBe(true);
    expect(noPeersAtAll([index, noPeers('A'), { provider: 'Torrent: B', outcome: 'dubbed', took_s: 9, detail: 'its audio is es' }])).toBe(false);
    expect(noPeersAtAll([index, { ...noPeers('A'), detail: 'the swarm sent too little of the file to read it within 30 s' }])).toBe(false);
    expect(noPeersAtAll([index])).toBe(false);
  });
});

describe('WARP for a torrent play on the office network', () => {
  it('adds one hint line, switching nothing, without the automatic flip', async () => {
    const sw = fakeWarp(office);
    const again = vi.fn();
    const out = await torrentThroughWarp({ switch: sw, auto: false }, new WarpHolds(sw), failed([index, noPeers('A')]), again);
    expect(out.ok).toBe(false);
    expect(out.attempts.at(-1)).toMatchObject({ provider: WARP_ATTEMPT, outcome: 'skipped' });
    expect(out.attempts.at(-1)?.detail).toContain('/warp on');
    expect(sw.calls).toEqual(['status']);
    expect(again).not.toHaveBeenCalled();
  });

  it('adds nothing on another network, with WARP already on, or when a peer answered', async () => {
    for (const [state, attempts] of [
      [{ ...office, ssid: 'kosan_baruu' }, [noPeers('A')]],
      [{ ...office, ssid: null }, [noPeers('A')]],
      [{ ...office, warp: 'connected' }, [noPeers('A')]],
      [office, [{ ...noPeers('A'), outcome: 'dubbed', detail: 'dub' }]],
    ] as Array<[WarpState, ResolveAttempt[]]>) {
      const first = failed(attempts);
      const sw = fakeWarp(state);
      expect(await torrentThroughWarp({ switch: sw, auto: true }, new WarpHolds(sw), first, vi.fn())).toBe(first);
      expect(sw.calls.filter((c) => c !== 'status')).toEqual([]);
    }
  });

  it('with the flip: switches WARP on, asks again, and keeps it on when that played', async () => {
    const sw = fakeWarp(office);
    const out = await torrentThroughWarp({ switch: sw, auto: true }, new WarpHolds(sw), failed([index, noPeers('A')]), async () => played);
    expect(out.ok).toBe(true);
    expect(sw.calls).toEqual(['status', 'on']);
    expect(out.attempts.map((a) => a.provider)).toEqual(['Index: torrentio', 'Torrent: A', WARP_ATTEMPT, 'Torrent: A']);
    expect(out.attempts[2]?.detail).toContain('WARP stays on');
  });

  it('with the flip: puts WARP back off when the second ask found nothing either', async () => {
    const sw = fakeWarp(office);
    const out = await torrentThroughWarp({ switch: sw, auto: true }, new WarpHolds(sw), failed([noPeers('A')]), async () => failed([noPeers('A')]));
    expect(out.ok).toBe(false);
    expect(sw.calls).toEqual(['status', 'on', 'off']);
    expect(out.attempts.find((a) => a.provider === WARP_ATTEMPT)?.detail).toContain('put back off');
  });

  it('with the flip: asks nothing again when WARP would not switch on', async () => {
    const again = vi.fn();
    const sw = fakeWarp(office, { setFails: true });
    const out = await torrentThroughWarp({ switch: sw, auto: true } satisfies TorrentWarp, new WarpHolds(sw), failed([noPeers('A')]), again);
    expect(again).not.toHaveBeenCalled();
    expect(out.attempts.at(-1)).toMatchObject({ provider: WARP_ATTEMPT, outcome: 'error' });
  });
});

describe('WARP held by two torrent asks at once', () => {
  const later = (): { open: () => void; wait: Promise<void> } => {
    let open = (): void => undefined;
    const wait = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { open, wait };
  };

  it('is switched on once, stays on while the other still asks, and goes off only when the last let go', async () => {
    const sw = fakeWarp(office);
    const holds = new WarpHolds(sw);
    const warp = { switch: sw, auto: true };
    const slow = later();
    const b = torrentThroughWarp(warp, holds, failed([noPeers('B')]), async () => {
      await slow.wait;
      return failed([noPeers('B')]);
    });
    const a = await torrentThroughWarp(warp, holds, failed([noPeers('A')]), async () => failed([noPeers('A')]));
    expect(a.attempts.find((x) => x.provider === WARP_ATTEMPT)?.detail).toContain('stays on while another torrent play asks through it');
    expect(sw.calls.filter((c) => c !== 'status')).toEqual(['on']);
    slow.open();
    const out = await b;
    expect(out.attempts.find((x) => x.provider === WARP_ATTEMPT)?.detail).toContain('put back off');
    expect(sw.calls.filter((c) => c !== 'status')).toEqual(['on', 'off']);
  });

  it('stays on when one of them played through it, though the other found nothing', async () => {
    const sw = fakeWarp(office);
    const holds = new WarpHolds(sw);
    const warp = { switch: sw, auto: true };
    const slow = later();
    const b = torrentThroughWarp(warp, holds, failed([noPeers('B')]), async () => {
      await slow.wait;
      return failed([noPeers('B')]);
    });
    expect((await torrentThroughWarp(warp, holds, failed([noPeers('A')]), async () => played)).ok).toBe(true);
    slow.open();
    expect((await b).attempts.find((x) => x.provider === WARP_ATTEMPT)?.detail).toContain('another torrent play plays through it');
    expect(sw.calls.filter((c) => c !== 'status')).toEqual(['on']);
  });

  it('never switches off a WARP the owner turned on, whatever the asks find', async () => {
    const sw = fakeWarp({ ...office, warp: 'connected' });
    const holds = new WarpHolds(sw);
    const again = vi.fn();
    await torrentThroughWarp({ switch: sw, auto: true }, holds, failed([noPeers('A')]), again);
    await torrentThroughWarp({ switch: sw, auto: true }, holds, failed([noPeers('B')]), again);
    expect(again).not.toHaveBeenCalled();
    expect(sw.calls).toEqual(['status', 'status']);
  });
});

describe('the WARP switch over warp.mjs', () => {
  it('reads the script\'s answer', () => {
    expect(readWarpAnswer({ ok: true, warp: 'connected', ssid: 'Employee', changed: true })).toEqual({ ok: true, warp: 'connected', ssid: 'Employee', changed: true });
    expect(readWarpAnswer({ ok: false, warp: 'disconnected', ssid: null, error: 'did_not_switch' })).toEqual({ ok: false, warp: 'disconnected', ssid: null, error: 'did_not_switch' });
    expect(readWarpAnswer('nonsense')).toEqual({ ok: false, warp: 'unknown', ssid: null, error: 'bad_output' });
  });

  it('never throws when the script cannot run', async () => {
    const sw = scriptWarp({ nodeBin: '/nonexistent/node', timeoutMs: 2000 });
    const out = await sw.status();
    expect(out).toMatchObject({ ok: false, warp: 'unknown', ssid: null });
    expect(out.error).toContain('warp script failed');
  });
});
