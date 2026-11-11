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

# Both containers hold test data only, so they run without durability. Every integration
# file truncates every table, and each truncate waited on a disk sync: MEASURED 2026-11-11 on
# session-fork-awareness, the truncates sat in DataFileImmediateSync, and three suites on one
# WSL disk took ~30 minutes where one alone takes ~5. A container started without these
# settings is recreated, the same way as one on the wrong image.
PG_FAST=(-c fsync=off -c synchronous_commit=off -c full_page_writes=off)

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
    elif [ "$(docker inspect -f '{{join .Config.Cmd " "}}' "$name")" != "postgres ${PG_FAST[*]}" ]; then
      echo "test-int: $name runs with durability on; recreating it with fsync off (test data only)"
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
        "$image" postgres "${PG_FAST[@]}" >/dev/null
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

# One database per checkout. The integration suite truncates every table and the connector
# setup drops and recreates its databases WITH (FORCE), so two checkouts sharing a database
# (swarm phases, parallel /task sessions, an integrator's throwaway worktree) fail each other's
# runs with errors that read like their own regressions. MEASURED 2026-11-11 on
# session-fork-awareness: phases 2 and 5 ran test:int at the same moment on one database.
# The main checkout keeps the plain names; a linked worktree gets `_wt_<hash of its path>`,
# and TEST_DB_SUFFIX overrides both. Each worktree database records its path as its comment,
# so the ones whose worktree is gone are dropped here, in both containers.
psql_in() { docker exec -i "$1" psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres -tA "${@:2}"; }

TOP="$(git rev-parse --show-toplevel)"
MAIN="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
if [ -n "${TEST_DB_SUFFIX+x}" ]; then
  SUFFIX="$TEST_DB_SUFFIX"
elif [ "$TOP" = "$MAIN" ]; then
  SUFFIX=""
else
  SUFFIX="_wt_$(printf '%s' "$TOP" | sha1sum | cut -c1-10)"
fi
if ! [[ "$SUFFIX" =~ ^[a-z0-9_]*$ ]]; then
  echo "test-int: TEST_DB_SUFFIX must be lower-case letters, digits and _ (got '$SUFFIX')" >&2
  exit 1
fi
export TEST_DB_SUFFIX="$SUFFIX"

# prune_worktree_dbs: drop every _wt_ database whose recorded worktree no longer exists.
prune_worktree_dbs() {
  local name path suffix
  psql_in "$NOTES_CONTAINER" -F '|' -c \
    "select datname, coalesce(shobj_description(oid, 'pg_database'), '') from pg_database where datname like '${NOTES_DB}\\_wt\\_%'" |
  while IFS='|' read -r name path; do
    [ -n "$name" ] || continue
    [ -n "$path" ] && [ -d "$path" ] && continue
    suffix="${name#"$NOTES_DB"}"
    echo "test-int: dropping $name and its connector databases (worktree ${path:-unknown} is gone)"
    psql_in "$NOTES_CONTAINER" -c "drop database if exists $name with (force)"
    if docker inspect "$CONNECTORS_CONTAINER" >/dev/null 2>&1 &&
       [ "$(docker inspect -f '{{.State.Running}}' "$CONNECTORS_CONTAINER")" = true ]; then
      psql_in "$CONNECTORS_CONTAINER" -c "select datname from pg_database where datname like 'connectors\\_%${suffix}'" |
        while read -r db; do
          [ -n "$db" ] && psql_in "$CONNECTORS_CONTAINER" -c "drop database if exists $db with (force)"
        done
    fi
  done
}

ensure_container "$NOTES_CONTAINER" "$NOTES_IMAGE" "$NOTES_PORT" "$NOTES_DB"
prune_worktree_dbs
NOTES_DB="${NOTES_DB}${SUFFIX}"
if [ -z "$(psql_in "$NOTES_CONTAINER" -c "select 1 from pg_database where datname = '$NOTES_DB'")" ]; then
  echo "test-int: creating database $NOTES_DB for $TOP"
  psql_in "$NOTES_CONTAINER" -c "create database $NOTES_DB"
fi
if [ -n "$SUFFIX" ]; then
  psql_in "$NOTES_CONTAINER" -c "comment on database $NOTES_DB is '${TOP//\'/\'\'}'"
fi
export TEST_DATABASE_URL="postgres://postgres:${PG_PASSWORD}@127.0.0.1:${NOTES_PORT}/${NOTES_DB}"

if [ "${CHAT_LIVE_TEST:-}" != 1 ]; then
  ensure_container "$CONNECTORS_CONTAINER" "$CONNECTORS_IMAGE" "$CONNECTORS_PORT" "$CONNECTORS_DB"
  # The admin URL stays on `postgres`; tests/integration/connectors/siblings.ts appends
  # TEST_DB_SUFFIX to each connector database it rebuilds.
  export TEST_CONNECTORS_URL="postgres://postgres:${PG_PASSWORD}@127.0.0.1:${CONNECTORS_PORT}/${CONNECTORS_DB}"
fi

export VITEST_INTEGRATION=1
exec node_modules/.bin/vitest run "$@"
