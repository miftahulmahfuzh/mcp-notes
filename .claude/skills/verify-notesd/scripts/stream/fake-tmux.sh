#!/usr/bin/env bash
# The tmux of every verify-notesd run (verify.sh pins NOTESD_TMUX_BIN to this file): it never
# reaches a tmux server. Each call is appended to $NOTESD_FAKE_TMUX_DIR/calls.log, one line per
# call, the arguments separated by tabs. `touch $NOTESD_FAKE_TMUX_DIR/down` makes it answer like a
# tmux with no server; `touch $NOTESD_FAKE_TMUX_DIR/fail-new-window` makes new-window fail.
set -u
dir="${NOTESD_FAKE_TMUX_DIR:?NOTESD_FAKE_TMUX_DIR is not set}"
mkdir -p "$dir"
(
  IFS=$'\t'
  printf '%s\n' "$*"
) >>"$dir/calls.log"
if [ "${1:-}" = "-S" ]; then shift 2; fi
if [ -e "$dir/down" ]; then
  echo "no server running on /tmp/tmux-fake/default" >&2
  exit 1
fi
case "${1:-}" in
  list-sessions) echo "100 verify" ;;
  show-environment) echo "PATH=/usr/local/bin:/usr/bin:/bin" ;;
  list-clients) ;;
  new-window)
    if [ -e "$dir/fail-new-window" ]; then
      echo "create window failed: fake tmux was told to fail" >&2
      exit 1
    fi
    n="$(grep -c "new-window" "$dir/calls.log")"
    echo "verify:$n %$n"
    ;;
  *) ;;
esac
exit 0
