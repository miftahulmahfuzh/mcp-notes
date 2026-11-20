import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs script without type declarations
import { main, readSsid, setWarp, warpAllowed, warpState } from '../../../claude/streaming/warp.mjs';

const NETSH_OFFICE = [
  'There is 1 interface on the system: ',
  '',
  '    Name                   : Wi-Fi',
  '    State                  : connected',
  '    SSID                   : Employee',
  '    BSSID                  : 86:25:d8:93:c4:40',
  '    Profile                : Employee ',
  '',
].join('\r\n');

/** A WARP that goes where it is told, or never with `stuck`; a netsh that names `ssid`. */
function fake(start: 'Connected' | 'Disconnected', o: { installed?: boolean; stuck?: boolean; netsh?: string | null } = {}) {
  const calls: string[] = [];
  let state: string = start;
  let clock = 0;
  const deps = {
    cli: async (args: string[]) => {
      calls.push(args[0]!);
      if (args[0] === 'connect' && !o.stuck) state = 'Connected';
      if (args[0] === 'disconnect' && !o.stuck) state = 'Disconnected';
      return args[0] === 'status' ? `Status update: ${state}\n` : 'Success\n';
    },
    netsh: async () => (o.netsh === undefined ? NETSH_OFFICE : o.netsh),
    installed: () => o.installed !== false,
    env: {},
    sleep: async (ms: number) => void (clock += ms),
    now: () => clock,
  };
  return { deps, calls, state: () => state };
}

describe('warp.mjs: the owner\'s switch', () => {
  it('reads the SSID of the connected Wi-Fi interface, not the BSSID', () => {
    expect(readSsid(NETSH_OFFICE)).toBe('Employee');
    expect(readSsid(NETSH_OFFICE.replace('connected', 'disconnected'))).toBeNull();
    expect(readSsid('There are no wireless interfaces on the system.')).toBeNull();
    expect(readSsid(null)).toBeNull();
  });

  it('reads the state and the network', async () => {
    expect(await warpState(fake('Disconnected').deps)).toEqual({ ok: true, warp: 'disconnected', ssid: 'Employee' });
    expect(await warpState(fake('Connected', { installed: false, netsh: null }).deps)).toEqual({ ok: true, warp: 'not_installed', ssid: null });
  });

  it('switches on and off, and changes nothing when it already is there', async () => {
    const off = fake('Disconnected');
    expect(await setWarp(true, off.deps)).toEqual({ ok: true, warp: 'connected', ssid: 'Employee', changed: true });
    expect(off.state()).toBe('Connected');
    expect(await setWarp(true, off.deps)).toEqual({ ok: true, warp: 'connected', ssid: 'Employee', changed: false });
    expect(await setWarp(false, off.deps)).toMatchObject({ ok: true, warp: 'disconnected', changed: true });
  });

  it('works with NOTESD_STREAM_WARP=off: that switch is for what runs by itself', async () => {
    const f = fake('Disconnected');
    expect(warpAllowed({ NOTESD_STREAM_WARP: 'off' })).toBe(false);
    expect(warpAllowed({})).toBe(true);
    expect(await setWarp(true, { ...f.deps, env: { NOTESD_STREAM_WARP: 'off' } })).toMatchObject({ ok: true, changed: true });
  });

  it('answers not_installed, and did_not_switch with a WARP that stays where it was', async () => {
    expect(await setWarp(true, fake('Disconnected', { installed: false }).deps)).toMatchObject({ ok: false, error: 'not_installed' });
    const stuck = fake('Disconnected', { stuck: true });
    expect(await setWarp(true, stuck.deps)).toMatchObject({ ok: false, error: 'did_not_switch', warp: 'disconnected', changed: false });
    // Half way is nowhere: it was asked for what it was.
    expect(stuck.calls.at(-2)).toBe('disconnect');
  });

  it('main takes status, on and off, and answers usage for anything else', async () => {
    const f = fake('Connected');
    expect(await main(['status'], f.deps)).toMatchObject({ warp: 'connected' });
    expect(await main(['off'], f.deps)).toMatchObject({ warp: 'disconnected', changed: true });
    expect(await main(['toggle'], f.deps)).toMatchObject({ ok: false, error: 'usage' });
  });
});
