import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WARP_TOOL_NAME } from '../chat/status.js';
import { OFFICE_SSID, type WarpSwitch } from '../streaming/warp.js';
import { run, type ToolDeps } from './tools.js';

export const WARP_OFF = 'warp_off: the WARP switch is not running on this server (the daemon was started without it).';

const DESCRIPTION =
  "Cloudflare WARP on the owner's Windows machine: read it, or switch it on or off. " +
  'action status (the default) only reads; on and off switch it and wait until it is there (up to 20 s). ' +
  'Answers warp (connected, disconnected, connecting, unknown, or not_installed), ssid (the Wi-Fi network the machine is on, null when none), ' +
  'changed (whether this call switched it) and, when it could not switch, error. ' +
  `WARP carries the whole machine's traffic through Cloudflare. On the office network (SSID ${OFFICE_SSID}) torrent peers are not reached without it: ` +
  'the owner says "warp on" there before a torrent play (TM, TS), and "warp off" when done. ' +
  'Some streaming sites refuse WARP (lk21), so a site play may need it off. Call on or off only when the owner asks; say what the answer says, with the SSID.';

/** `warp`: status | on | off, through warp.mjs (`deps.warp`). */
export function registerWarpTool(server: McpServer, deps: Pick<ToolDeps, 'warp'>): void {
  server.registerTool(
    WARP_TOOL_NAME,
    {
      title: 'Cloudflare WARP: status, on, off',
      description: DESCRIPTION,
      inputSchema: {
        action: z.enum(['status', 'on', 'off']).optional().describe('status (default) reads; on and off switch it.'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ action }) =>
      run(async () => {
        const warp: WarpSwitch | null | undefined = deps.warp;
        if (!warp) throw new Error(WARP_OFF);
        if (action === 'on' || action === 'off') return warp.set(action === 'on');
        return warp.status();
      }),
  );
}
