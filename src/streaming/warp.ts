import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runJsonScript } from './service.js';

/** `claude/streaming/warp.mjs`, two folders up from src/streaming or dist/streaming: the one place WARP and the SSID are read and switched. */
export const DEFAULT_WARP_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'claude', 'streaming', 'warp.mjs');

/** A switch waits up to 20 s for WARP to get there, and Windows programs start slowly from WSL. */
export const WARP_TIMEOUT_MS = 60_000;

/** The office network: torrent peers are not reached on it (measured 2026-11-20), and WARP may carry them. */
export const OFFICE_SSID = 'Employee';

export type WarpStatus = 'connected' | 'disconnected' | 'connecting' | 'unknown' | 'not_installed';

/** What warp.mjs answers: WARP's state and the Wi-Fi network's name (null: no Wi-Fi connected). */
export interface WarpState {
  ok: boolean;
  warp: WarpStatus;
  ssid: string | null;
  /** After `set`: whether WARP was switched (false: it already was there, or it did not switch). */
  changed?: boolean;
  /** `not_installed`, `did_not_switch`, or why the script could not run. */
  error?: string;
}

/**
 * Cloudflare WARP on the Windows side. The daemon builds `scriptWarp()`; tests pass a fake. WARP carries the whole
 * machine's traffic: only the owner's switch (the `warp` tool, /warp) and the torrent play on the office network
 * (torrentWarp.ts) call `set`.
 */
export interface WarpSwitch {
  status(): Promise<WarpState>;
  set(on: boolean): Promise<WarpState>;
}

const STATUSES: readonly WarpStatus[] = ['connected', 'disconnected', 'connecting', 'unknown', 'not_installed'];

/** The script's answer as a WarpState; anything else is an `unknown` state with the reason. */
export function readWarpAnswer(raw: unknown): WarpState {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const warp = STATUSES.includes(o.warp as WarpStatus) ? (o.warp as WarpStatus) : 'unknown';
  const ssid = typeof o.ssid === 'string' && o.ssid !== '' ? o.ssid : null;
  return {
    ok: o.ok === true,
    warp,
    ssid,
    ...(typeof o.changed === 'boolean' ? { changed: o.changed } : {}),
    ...(typeof o.error === 'string' ? { error: o.error } : o.ok === true ? {} : { error: 'bad_output' }),
  };
}

export interface ScriptWarpOptions {
  nodeBin?: string;
  scriptPath?: string;
  timeoutMs?: number;
}

/** Runs `node warp.mjs status|on|off`. Never throws: a script that cannot run answers ok false with `unknown`. */
export function scriptWarp(options: ScriptWarpOptions = {}): WarpSwitch {
  const nodeBin = options.nodeBin ?? process.execPath;
  const scriptPath = options.scriptPath ?? DEFAULT_WARP_SCRIPT;
  const timeoutMs = options.timeoutMs ?? WARP_TIMEOUT_MS;
  const ask = async (action: string): Promise<WarpState> => {
    try {
      return readWarpAnswer(await runJsonScript({ label: 'warp script', nodeBin, argv: [scriptPath, action], timeoutMs }));
    } catch (err) {
      return { ok: false, warp: 'unknown', ssid: null, error: err instanceof Error ? err.message : String(err) };
    }
  };
  return { status: () => ask('status'), set: (on) => ask(on ? 'on' : 'off') };
}
