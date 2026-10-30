#!/usr/bin/env bash
# Integration tests against real Postgres in Docker.
#
# Starts (or reuses) two containers, waits for them, then runs the integration suite:
#   mcp-notes-pg-test        pgvector/pgvector:pg16  127.0.0.1:55433  notes schema (drizzle/*.sql)
#   mcp-notes-pg-connectors  pgvector/pgvector:pg16  127.0.0.1:55435  one database per connector,
#                            rebuilt from the sibling repos' migrations by the connectors globalSetup
# Exports TEST_DATABASE_URL and TEST_CONNECTORS_URL. Extra args go to vitest.
# A container created from another image than the one named here is removed and recreated.
#
# Never touches the Neon databases or any other container (seer-pg uses 55432,
# mcp-notes-pg-demo uses 55434).
set -euo pipefail

cd "$(dirname "$0")/.."

PG_PASSWORD=mcpnotes

NOTES_CONTAINER=mcp-notes-pg-test
NOTES_IMAGE=pgvector/pgvector:pg16
NOTES_PORT=55433
NOTES_DB=mcp_notes_test

CONNECTORS_CONTAINER=mcp-notes-pg-connectors
CONNECTORS_IMAGE=pgvector/pgvector:pg16
CONNECTORS_PORT=55435
CONNECTORS_DB=postgres

if ! command -v docker >/dev/null 2>&1; then
  echo "test-int: docker is not on PATH; integration tests need it." >&2
  exit 1
fi

# ensure_container NAME IMAGE HOST_PORT DB
# A container that exists but was created from another image (e.g. mcp-notes-pg-test from the
# days of plain postgres:16) is removed and recreated: both containers hold test data only.
ensure_container() {
  local name=$1 image=$2 port=$3 db=$4 state current ready=0
  # docker inspect prints a blank line on stdout for an unknown container, so the
  # exit status decides "missing", not the output.
  if ! state="$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)"; then
    state=missing
  fi
  if [ "$state" != missing ]; then
    current="$(docker inspect -f '{{.Config.Image}}' "$name")"
    if [ "$current" != "$image" ]; then
      echo "test-int: $name runs $current, not $image; recreating it (it holds test data only)"
      docker rm -f "$name" >/dev/null
      state=missing
    fi
  fi
  case "$state" in
    true)
      ;;
    false)
      echo "test-int: starting existing container $name"
      docker start "$name" >/dev/null
      ;;
    missing)
      echo "test-int: creating container $name ($image on 127.0.0.1:$port)"
      docker run -d \
        --name "$name" \
        -e POSTGRES_PASSWORD="$PG_PASSWORD" \
        -e POSTGRES_DB="$db" \
        -p "127.0.0.1:$port:5432" \
        "$image" >/dev/null
      ;;
    *)
      echo "test-int: unexpected state '$state' for $name" >&2
      exit 1
      ;;
  esac

  # -h 127.0.0.1 skips the entrypoint's socket-only bootstrap server, so "ready"
  # means the real server is accepting TCP connections.
  for _ in $(seq 1 60); do
    if docker exec "$name" pg_isready -q -h 127.0.0.1 -U postgres -d "$db" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  if [ "$ready" != 1 ]; then
    echo "test-int: $name did not become ready in 60s" >&2
    docker logs --tail 30 "$name" >&2 || true
    exit 1
  fi
}

ensure_container "$NOTES_CONTAINER" "$NOTES_IMAGE" "$NOTES_PORT" "$NOTES_DB"
export TEST_DATABASE_URL="postgres://postgres:${PG_PASSWORD}@127.0.0.1:${NOTES_PORT}/${NOTES_DB}"

if [ "${CHAT_LIVE_TEST:-}" != 1 ]; then
  ensure_container "$CONNECTORS_CONTAINER" "$CONNECTORS_IMAGE" "$CONNECTORS_PORT" "$CONNECTORS_DB"
  export TEST_CONNECTORS_URL="postgres://postgres:${PG_PASSWORD}@127.0.0.1:${CONNECTORS_PORT}/${CONNECTORS_DB}"
fi

export VITEST_INTEGRATION=1
exec node_modules/.bin/vitest run "$@"
