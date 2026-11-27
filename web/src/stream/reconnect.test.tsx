// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fakeVideo } from '../testing/streamFakes';
import { fakeHost, fakeSession } from './fakeHost';
import { Reconnect, sessionGone } from './reconnect';
import { SessionError } from './session';

function tab(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

function setup(currentTime = 0) {
  const memory = tab();
  const v = fakeVideo({ currentTime });
  const host = fakeHost(v.video, { memory });
  const reconnect = new Reconnect({ ...host, generation: () => 0, hasEngine: () => true, swapTo: async () => {} });
  return { host, reconnect, memory };
}

describe('Reconnect', () => {
  it('calls a session gone when the daemon is down or does not know it', () => {
    expect(sessionGone(new SessionError('network', 0))).toBe(true);
    expect(sessionGone(new SessionError('http_503', 503))).toBe(true);
    expect(sessionGone(new SessionError('unknown_session', 404))).toBe(true);
    expect(sessionGone(new SessionError('no_source', 404))).toBe(false);
    expect(sessionGone(new Error('network'))).toBe(false);
  });

  it("keeps the play in the tab's storage, so a reload finds it, with the last position reported", () => {
    const a = setup();
    a.reconnect.remember(fakeSession(), 12);
    a.reconnect.rememberPosition('S1', 95.5);
    // Another session's position is not this play's.
    a.reconnect.rememberPosition('S9', 300);
    const b = fakeHost(fakeVideo().video, { memory: a.memory });
    const reload = new Reconnect({ ...b, generation: () => 0, hasEngine: () => true, swapTo: async () => {} });
    expect(reload.readFromTab('S1')).toBe(true);
    expect(reload.continueAt()).toBe(95.5);
    expect(reload.readFromTab('S2')).toBe(false);
  });

  it('keeps a known position when the same session is remembered without one, and nothing for a session that names no title', () => {
    const t = setup();
    t.reconnect.remember(fakeSession(), 40);
    t.reconnect.remember(fakeSession(), null);
    expect(t.reconnect.continueAt()).toBe(40);
    t.reconnect.remember(fakeSession({ id: 'S2', ref: null }), 70);
    expect(t.reconnect.continueAt()).toBe(40);
  });

  it('carries on from the picture while the film is on the page, else from the last position seen', () => {
    const t = setup(120);
    t.reconnect.remember(fakeSession(), 40);
    expect(t.reconnect.continueAt()).toBe(40);
    t.host.lastPosition = 80;
    expect(t.reconnect.continueAt()).toBe(80);
    t.host.current = { ...t.host.current, stage: 'ready' };
    expect(t.reconnect.continueAt()).toBe(120);
  });

  it('stops a muted check, or a play it knows nothing of, at once', async () => {
    const t = setup();
    await t.reconnect.carryOn('unknown_session');
    expect((t.host.failures[0] as SessionError).code).toBe('unknown_session');
    await t.reconnect.endedOrCarryOn(new SessionError('session_over', 403));
    expect((t.host.failures[1] as SessionError).code).toBe('session_over');
    expect(t.reconnect.active).toBe(false);
  });
});
