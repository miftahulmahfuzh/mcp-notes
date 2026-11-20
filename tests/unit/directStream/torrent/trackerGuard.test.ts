import { describe, expect, it } from 'vitest';
import { guardTrackerRequest, installTrackerGuard, type TrackerClass } from '../../../../src/directStream/torrent/trackerGuard.js';

function fakeTracker(fail: () => Error) {
  class Fake {
    destroyed = false;
    async _request(_url: string, _params: unknown, _cb: (err: Error | null) => void): Promise<void> {
      await Promise.resolve();
      throw fail();
    }
  }
  return Fake as unknown as TrackerClass & (new () => { destroyed: boolean; _request: (u: string, p: unknown, cb: (err: Error | null) => void) => Promise<void> });
}

const abort = (): Error => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("the HTTP tracker guard (a tracker's late body never ends the daemon)", () => {
  it('drops an abort, and any rejection once the tracker was destroyed', async () => {
    const Fake = fakeTracker(abort);
    expect(guardTrackerRequest(Fake)).toBe(true);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const told: Array<Error | null> = [];
      const t = new Fake();
      const p = t._request('http://tracker.invalid/announce', {}, (err) => told.push(err));
      await p.catch(() => undefined);
      await settle();
      expect(told).toEqual([]);
      const gone = new (fakeTracker(() => new Error('socket hang up')))();
      guardTrackerRequest(gone.constructor as unknown as TrackerClass);
      gone.destroyed = true;
      await gone._request('u', {}, (err) => told.push(err)).catch(() => undefined);
      await settle();
      expect(told).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it("hands any other failure to the request's callback", async () => {
    const Fake = fakeTracker(() => new Error('socket hang up'));
    guardTrackerRequest(Fake);
    const told: Array<Error | null> = [];
    await new Fake()._request('u', {}, (err) => told.push(err)).catch(() => undefined);
    await settle();
    expect(told.map((e) => e?.message)).toEqual(['socket hang up']);
  });

  it('wraps once, and finds the HTTPTracker bittorrent-tracker loads', async () => {
    const Fake = fakeTracker(abort);
    guardTrackerRequest(Fake);
    const first = Fake.prototype._request;
    guardTrackerRequest(Fake);
    expect(Fake.prototype._request).toBe(first);
    expect(guardTrackerRequest({ prototype: {} })).toBe(false);
    const logged: string[] = [];
    expect(await installTrackerGuard((l) => void logged.push(l))).toBe(true);
    expect(logged).toEqual([]);
  });
});
