#!/usr/bin/env bash
# Integration tests against a real Postgres in Docker.
#
# Starts (or reuses) the container mcp-notes-pg-test (postgres:16, 127.0.0.1:55433),
# waits for it, then runs the integration suite with TEST_DATABASE_URL pointing at it.
# The suite's globalSetup applies drizzle/*.sql. Extra args go to vitest.
#
# Never touches the Neon database or any other container (seer-pg uses 55432).
set -euo pipefail

cd "$(dirname "$0")/.."

CONTAINER=mcp-notes-pg-test
IMAGE=postgres:16
HOST_PORT=55433
PG_PASSWORD=mcpnotes
PG_DB=mcp_notes_test

if ! command -v docker >/dev/null 2>&1; then
  echo "test-int: docker is not on PATH; integration tests need it." >&2
  exit 1
fi

# docker inspect prints a blank line on stdout for an unknown container, so the
# exit status decides "missing", not the output.
if ! state="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)"; then
  state=missing
fi
case "$state" in
  true)
    ;;
  false)
    echo "test-int: starting existing container $CONTAINER"
    docker start "$CONTAINER" >/dev/null
    ;;
  missing)
    echo "test-int: creating container $CONTAINER ($IMAGE on 127.0.0.1:$HOST_PORT)"
    docker run -d \
      --name "$CONTAINER" \
      -e POSTGRES_PASSWORD="$PG_PASSWORD" \
      -e POSTGRES_DB="$PG_DB" \
      -p "127.0.0.1:$HOST_PORT:5432" \
      "$IMAGE" >/dev/null
    ;;
  *)
    echo "test-int: unexpected state '$state' for $CONTAINER" >&2
    exit 1
    ;;
esac

# -h 127.0.0.1 skips the entrypoint's socket-only bootstrap server, so "ready"
# means the real server is accepting TCP connections.
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -q -h 127.0.0.1 -U postgres -d "$PG_DB" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "${ready:-0}" != 1 ]; then
  echo "test-int: $CONTAINER did not become ready in 60s" >&2
  docker logs --tail 30 "$CONTAINER" >&2 || true
  exit 1
fi

export TEST_DATABASE_URL="postgres://postgres:${PG_PASSWORD}@127.0.0.1:${HOST_PORT}/${PG_DB}"
export VITEST_INTEGRATION=1
exec node_modules/.bin/vitest run "$@"
