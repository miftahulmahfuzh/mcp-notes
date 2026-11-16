#!/usr/bin/env bash
# /report-stream-bug: collect what is known about a direct-stream play into one folder.
#   collect.sh [SNAPSHOT_DIR] [--wall URL] [--data-dir DIR] [--log FILE] [--hours N]
#              [--reference URL] [--host-scheme https|http]
# SNAPSHOT_DIR is an absolute folder the player's report button made: the script adds to it and asks
# for no new snapshot. Without it the daemon is asked for a snapshot of the stream on screen or the
# last session. --log reads the daemon's lines from a file instead of journalctl (a throwaway daemon).
# It writes only into the evidence folder, and never writes or prints a signed address or a token:
# the measurement keeps hosts, statuses, sizes and times, and the daemon's lines lose every query.
set -uo pipefail

# PHASE-1 CONTRACT (routes): the only place this skill names the daemon's evidence routes. The JSON
# field names and the snapshot's file names are FIELDS in diagnose.mjs. The snapshot route is
# same-origin only: every call sends `Origin: <the origin of $WALL>` (phase 1's rule for scripts).
# The snapshot answers 200 {ok, dir, session_id, complete, records, player_lines}; the evidence route
# answers {host, file, records}.
ROUTE_HEALTH=/health
ROUTE_SNAPSHOT=/api/stream/evidence/snapshot
SNAPSHOT_BODY='{}'
ROUTE_EVIDENCE=/api/stream/evidence
EVIDENCE_LIMIT=2000

HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
WALL="${NOTESD_WALL_URL:-http://localhost:${NOTESD_PORT:-7317}}"
HOURS=6
REFERENCE=""
HOST_SCHEME=https
LOG_FILE=""
DATA_DIR_ARG=""
SNAP=""
usage() { sed -n '2,4p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --wall|--data-dir|--log|--hours|--reference|--host-scheme)
      [[ $# -ge 2 ]] || { echo "$1 needs a value" >&2; exit 2; }
      case "$1" in
        --wall) WALL="$2" ;;
        --data-dir) DATA_DIR_ARG="$2" ;;
        --log) LOG_FILE="$2" ;;
        --hours) HOURS="$2" ;;
        --reference) REFERENCE="$2" ;;
        --host-scheme) HOST_SCHEME="$2" ;;
      esac
      shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown argument: $1" >&2; usage; exit 2 ;;
    *)
      [[ -z "$SNAP" ]] || { echo "one snapshot folder only (got $SNAP and $1)" >&2; exit 2; }
      SNAP="$1"; shift ;;
  esac
done
[[ "$HOURS" =~ ^[0-9]+$ ]] || { echo "--hours needs a whole number" >&2; exit 2; }
[[ "$HOST_SCHEME" == https || "$HOST_SCHEME" == http ]] || { echo "--host-scheme is https or http" >&2; exit 2; }
if [[ -n "$SNAP" ]]; then
  [[ "$SNAP" == /* && -d "$SNAP" ]] || { echo "the snapshot folder must be an absolute path to an existing folder: $SNAP" >&2; exit 2; }
  SNAP="${SNAP%/}"
fi
WALL="${WALL%/}"
ORIGIN="$(node -e 'console.log(new URL(process.argv[1]).origin)' "$WALL" 2>/dev/null)" \
  || { echo "--wall is not an address: $WALL" >&2; exit 2; }

if [[ -n "$DATA_DIR_ARG" ]]; then
  DATA_DIR="$DATA_DIR_ARG"
elif [[ -n "$SNAP" && "$(basename "$(dirname "$SNAP")")" == stream-reports ]]; then
  DATA_DIR="$(dirname "$(dirname "$(dirname "$SNAP")")")"
else
  DATA_DIR="${NOTES_DATA_DIR:-$HOME/mcp-notes-data}"
fi

MISSING=()
missing() { MISSING+=("$*"); }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== notesd"
DAEMON=0
code="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$WALL$ROUTE_HEALTH" 2>/dev/null)"
if [[ "$code" == 200 ]]; then
  DAEMON=1
  echo "the daemon at $WALL answers"
else
  echo "the daemon at $WALL did not answer (systemctl --user status notesd)"
fi

OUT=""
SID=""
if [[ -n "$SNAP" ]]; then
  OUT="$SNAP"
  SID="$(node "$HERE/diagnose.mjs" session-id "$OUT")"
  echo "the snapshot folder handed in: $OUT (session ${SID:-unknown})"
  [[ $DAEMON -eq 1 ]] || missing "the daemon at $WALL did not answer: no records newer than the snapshot, and the stream host was not measured through the session"
elif [[ $DAEMON -eq 1 ]]; then
  code="$(curl -s -m 15 -o "$TMP/answer.json" -w '%{http_code}' -X POST \
    -H "Origin: $ORIGIN" -H 'content-type: application/json' --data "$SNAPSHOT_BODY" \
    "$WALL$ROUTE_SNAPSHOT" 2>/dev/null)"
  if [[ "$code" =~ ^2 ]]; then OUT="$(node "$HERE/diagnose.mjs" answer-dir "$TMP/answer.json")"; fi
  if [[ -n "$OUT" && -d "$OUT" ]]; then
    cp "$TMP/answer.json" "$OUT/snapshot-answer.json"
    SID="$(node "$HERE/diagnose.mjs" session-id "$OUT")"
    echo "a new snapshot: $OUT (session ${SID:-unknown})"
  else
    missing "no snapshot: $ROUTE_SNAPSHOT answered HTTP $code $(head -c 300 "$TMP/answer.json" 2>/dev/null | tr '\n' ' ')"
    OUT=""
  fi
else
  missing "no snapshot and no session: the daemon at $WALL did not answer"
fi
if [[ -z "$OUT" ]]; then
  OUT="$DATA_DIR/movies/stream-reports/$(date -u +%Y%m%d-%H%M%S)-collect"
  mkdir -p "$OUT"
  echo "no snapshot; collecting into $OUT"
fi

if [[ $DAEMON -eq 1 && -n "$SID" ]]; then
  code="$(curl -s -m 15 -o "$OUT/evidence-latest.json" -w '%{http_code}' -H "Origin: $ORIGIN" \
    "$WALL$ROUTE_EVIDENCE?session=$SID&limit=$EVIDENCE_LIMIT" 2>/dev/null)"
  if [[ "$code" == 200 ]]; then
    echo "the daemon's records for the session: evidence-latest.json"
  else
    rm -f "$OUT/evidence-latest.json"
    missing "the daemon's records for session $SID: $ROUTE_EVIDENCE answered HTTP $code"
  fi
elif [[ -z "$SID" ]]; then
  missing "no session id: the evidence below is the log's last lines, of any session"
fi

EVLOG="$DATA_DIR/movies/stream-evidence-$(hostname).jsonl"
EVOLD="${EVLOG%.jsonl}.1.jsonl"
if [[ -f "$EVLOG" || -f "$EVOLD" ]]; then
  if [[ -n "$SID" ]]; then
    cat "$EVOLD" "$EVLOG" 2>/dev/null | grep -F "\"$SID\"" | tail -n "$EVIDENCE_LIMIT" >"$OUT/evidence-tail.jsonl"
  else
    tail -n 400 "$EVLOG" >"$OUT/evidence-tail.jsonl" 2>/dev/null
  fi
  echo "evidence log: $(wc -l <"$OUT/evidence-tail.jsonl") lines from $EVLOG (evidence-tail.jsonl)"
else
  missing "no evidence log at $EVLOG"
fi

# Cut every query string off an address: a resolver's detail can name a signed address.
REDACT='s#(https?://[^[:space:]?"]+)\?[^[:space:]"]*#\1?<query removed>#g'
LINES='direct stream|stream evidence'
if [[ -n "$LOG_FILE" ]]; then
  if [[ -r "$LOG_FILE" ]]; then
    grep -iE "$LINES" "$LOG_FILE" | tail -n 400 | sed -E "$REDACT" >"$OUT/notesd.log"
  else
    missing "the daemon log $LOG_FILE cannot be read"
  fi
elif command -v journalctl >/dev/null; then
  journalctl --user -u notesd --since "-${HOURS}h" --no-pager 2>/dev/null | grep -iE "$LINES" | tail -n 400 | sed -E "$REDACT" >"$OUT/notesd.log"
else
  missing "no journalctl here and no --log: the daemon's lines were not read"
fi
if [[ -s "$OUT/notesd.log" ]]; then
  echo "daemon lines about direct streaming: $(wc -l <"$OUT/notesd.log") (notesd.log)"
else
  missing "no daemon line about direct streaming in the last $HOURS h"
fi

HOST="$(node "$HERE/diagnose.mjs" top-host "$OUT")"
NET_ARGS=()
[[ -n "$REFERENCE" ]] && NET_ARGS+=(--reference "$REFERENCE")
[[ -n "$SID" ]] && NET_ARGS+=(--session "$SID")
[[ $DAEMON -eq 1 ]] && NET_ARGS+=(--daemon "$WALL")
[[ -n "$HOST" ]] && NET_ARGS+=(--host "$HOST" --host-scheme "$HOST_SCHEME")
echo "== measuring: a reference download${SID:+, the stream through session $SID}${HOST:+, the first answer of $HOST}"
node "$HERE/netcheck.mjs" ${NET_ARGS[@]+"${NET_ARGS[@]}"} >"$OUT/network.json" \
  || { rm -f "$OUT/network.json"; missing "the network measurement did not run"; }

: >"$OUT/missing.txt"
for m in ${MISSING[@]+"${MISSING[@]}"}; do printf '%s\n' "$m" >>"$OUT/missing.txt"; done
echo
node "$HERE/diagnose.mjs" summary "$OUT" >"$OUT/summary.txt" || echo "the summary could not be written" >&2
cat "$OUT/summary.txt"
echo
echo "evidence: $OUT"
ls -1 "$OUT"
