#!/usr/bin/env node
// A fake Windows side for the VLC health monitor (src/movies/vlc/health.ts). It prints what
// tasklist.exe and powershell.exe printed on this machine (MEASURED 2026-11-14), from a JSON state
// file that is read again on every call, so a test changes "Windows" by rewriting the file.
//   node fake-windows.mjs tasklist <tasklist args>
//        -> one CSV row per vlc.exe ("vlc.exe","<pid>","Console","1","<KB> K"), or the INFO line
//   node fake-windows.mjs powershell -NoProfile -NonInteractive -EncodedCommand <base64 UTF-16LE>
//        -> a script with Get-WinEvent: the events as one JSON array; otherwise the process detail array
// Env: FAKE_WIN_STATE  JSON file { "vlc": [{ pid, ws, priv, handles, started, cmd }],
//                                  "events": [{ time, id, provider, props, message }] }
//      FAKE_WIN_CALLS  optional: append one line per call (tasklist | powershell:processes | powershell:events)
import { appendFileSync, readFileSync } from 'node:fs';

const [mode, ...args] = process.argv.slice(2);
let state = { vlc: [], events: [] };
try {
  state = JSON.parse(readFileSync(process.env.FAKE_WIN_STATE ?? '', 'utf8'));
} catch {
  // no state file: no VLC, no events
}
const vlc = Array.isArray(state.vlc) ? state.vlc : [];
const events = Array.isArray(state.events) ? state.events : [];
const note = (what) => {
  if (process.env.FAKE_WIN_CALLS) appendFileSync(process.env.FAKE_WIN_CALLS, `${what}\n`);
};

if (mode === 'tasklist') {
  note('tasklist');
  if (vlc.length === 0) {
    process.stdout.write('INFO: No tasks are running which match the specified criteria.\r\n');
  } else {
    for (const p of vlc) {
      const kb = Math.round(Number(p.ws ?? 0) / 1024).toLocaleString('en-US');
      process.stdout.write(`"vlc.exe","${p.pid}","Console","1","${kb} K"\r\n`);
    }
  }
  process.exit(0);
}

if (mode === 'powershell') {
  const i = args.indexOf('-EncodedCommand');
  const script = i >= 0 ? Buffer.from(args[i + 1] ?? '', 'base64').toString('utf16le') : '';
  if (script.includes('Get-WinEvent')) {
    note('powershell:events');
    process.stdout.write(`${JSON.stringify(events)}\r\n`);
  } else {
    note('powershell:processes');
    const out = vlc.map((p) => ({
      pid: p.pid,
      ws: p.ws,
      priv: p.priv ?? null,
      handles: p.handles ?? null,
      started: p.started ?? null,
      cmd: p.cmd ?? null,
    }));
    process.stdout.write(`${JSON.stringify(out)}\r\n`);
  }
  process.exit(0);
}

console.error(`fake-windows: unknown mode ${mode}`);
process.exit(2);
