#!/usr/bin/env bash
# /trace-vlc-bug: collect everything known about VLC on this machine into one folder. Read only,
# except --probe, which plays a paused notesd VLC for 6 s and pauses it again.
#   trace.sh [--hours N] [--front] [--probe] [--wall URL]
set -uo pipefail

HOURS=6
FRONT=0
PROBE=0
WALL="${NOTESD_WALL_URL:-http://localhost:${NOTESD_PORT:-7317}}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hours) HOURS="$2"; shift 2 ;;
    --front) FRONT=1; shift ;;
    --probe) PROBE=1; shift ;;
    --wall) WALL="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ "$HOURS" =~ ^[0-9]+$ ]] || { echo "--hours needs a whole number" >&2; exit 2; }

HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
DATA_DIR="${NOTES_DATA_DIR:-$HOME/mcp-notes-data}"
OUT="$DATA_DIR/movies/vlc-traces/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
POWERSHELL="${NOTESD_POWERSHELL_EXE:-/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe}"

echo "== notesd"
if curl -s -m 5 "$WALL/api/movies/player" -o "$OUT/player.json"; then
  echo "player: $(head -c 600 "$OUT/player.json")"
else
  echo "player: the daemon at $WALL did not answer (systemctl --user status notesd)"
fi
if curl -s -m 10 "$WALL/api/movies/player/health?limit=240" -o "$OUT/health.json"; then
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (r.error) { console.log("health: " + JSON.stringify(r)); process.exit(0); }
    console.log(`health: sampling=${r.sampling} every ${r.interval_ms} ms, log ${r.log_file}`);
    const mb = (n) => (n === null || n === undefined ? "?" : Math.round(n / 1048576) + " MB");
    for (const run of (r.runs ?? []).slice(-5)) console.log(`  vlc pid ${run.pid} ours=${run.ours} ${run.first_at} .. ${run.last_at}: private ${mb(run.private_first)} -> ${mb(run.private_last)}, growth per paused minute ${mb(run.private_growth_per_paused_min)}, longest pause ${run.paused_s_max ?? 0} s`);
    const last = (r.samples ?? []).filter((s) => s.play).at(-1);
    if (last) console.log(`  last sample of the followed play ${last.ts}: ${JSON.stringify(last.play)}`);
    for (const g of r.gpu_resets ?? []) console.log(`  GPU RESET ${g.time} (event ${g.event_id}) while vlc pid ${g.vlc_pids.join(",")} ran; play then: ${g.play ? `${g.play.state} at ${g.play.position_s} s, paused ${g.play.paused_s ?? 0} s` : "none followed"}`);
    for (const s of r.stalls ?? []) console.log(`  VIDEO STALL ${s.phase} ${s.ts} play ${s.play_id} at ${s.position_s} s${s.outcome ? " -> " + s.outcome : ""}${s.gpu_events.length ? "; driver events before it: " + s.gpu_events.map((e) => `${e.time} ${e.event_id}`).join(", ") : ""}`);
    for (const h of r.hangs ?? []) console.log(`  HANG ${h.phase} ${h.ts} play ${h.play_id} silent ${h.silent_s} s${h.outcome ? " -> " + h.outcome : ""}`);
    for (const i of r.incidents ?? []) console.log(`  INCIDENT ${i.ts}: the daemon died while sampling; last sample ${i.last_sample_at}; Windows faults: ${i.events.map((e) => `${e.application} ${e.exception_code ?? ""}`).join(", ") || "none"}; driver events: ${(i.gpu_events ?? []).length}`);
  ' "$OUT/health.json" || echo "health: unreadable (see $OUT/health.json)"
else
  echo "health: the daemon at $WALL did not answer"
fi
journalctl --user -u notesd --since "-${HOURS}h" --no-pager 2>/dev/null | grep -iE "vlc|\[movies\]" >"$OUT/notesd.log" || true
echo "daemon log lines about VLC in the last $HOURS h: $(wc -l <"$OUT/notesd.log") (notesd.log)"
grep -iE "plays without video|stopped answering|display driver event|hang ended|video stall ended" "$OUT/notesd.log" | tail -20 || true
HEALTH_LOG="$DATA_DIR/movies/vlc-health-$(hostname).jsonl"
[[ -f "$HEALTH_LOG" ]] && tail -n 400 "$HEALTH_LOG" >"$OUT/vlc-health-tail.jsonl"

echo
if [[ -x "$POWERSHELL" ]] && command -v wslpath >/dev/null; then
  ARGS=(-OutDir "$(wslpath -w "$OUT")" -Hours "$HOURS")
  [[ $FRONT -eq 1 ]] && ARGS+=(-Front)
  [[ $PROBE -eq 1 ]] && ARGS+=(-Probe)
  "$POWERSHELL" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$(wslpath -w "$HERE/collect.ps1")" "${ARGS[@]}" 2>&1 | tr -d '\r'
else
  echo "no powershell.exe or wslpath here: the Windows side was not read (this is not WSL, or interop is off)"
fi

echo
echo "evidence: $OUT"
ls -1 "$OUT"
