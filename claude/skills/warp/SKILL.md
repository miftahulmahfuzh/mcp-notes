---
name: warp
description: Read or switch Cloudflare WARP on the owner's Windows machine from Claude Code, and say which Wi-Fi network it is on. Use whenever the user types "/warp", "/warp on", "/warp off" or "/warp status" in any Claude Code session, and for a plain request to the same effect, such as "turn warp on", "is warp on?", "switch off cloudflare warp", "which wifi am I on?". On the office network (SSID Employee) torrent peers are not reached without WARP, so "warp on" comes before a torrent play (TM, TS) there.
argument-hint: '[status | on | off]'
---

# /warp — Cloudflare WARP: status, on, off

The text after `/warp` is `on`, `off` or `status`; nothing is `status`. WARP carries the whole
machine's traffic through Cloudflare, so switch it only when the user asked.

Call the notes MCP tool `warp` with `action` set to that word. When the tool is not there (the
daemon is down), run the same switch directly:

```sh
node ~/mcp-notes/claude/streaming/warp.mjs status   # or on, off
```

Both answer one JSON object: `warp` (`connected`, `disconnected`, `connecting`, `unknown`,
`not_installed`), `ssid` (the Wi-Fi network, null when none), `changed` (whether this call switched
it) and, when it could not switch, `error` (`not_installed`, `did_not_switch`).

Answer in one or two lines: WARP's state and the network, for example "WARP is on (Wi-Fi:
Employee)." When it could not switch, say so and what it is now.

## Why it exists

On the office network (SSID `Employee`) no torrent peer answers; through WARP the firewall sees one
tunnel to Cloudflare instead of the peers. A torrent play that found no peer at all there switches
WARP on by itself and asks once more (attempt `WARP`); WARP stays on only when that played. Some streaming sites refuse WARP's addresses (lk21): when a site
play fails with WARP on, the streaming command already asks it once more with WARP off.
`docs/guide/streaming.md` ("Cloudflare WARP for torrents") has the measurement and the rules.
