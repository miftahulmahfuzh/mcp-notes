#!/usr/bin/env bash
# doc-check.sh: README.md, CLAUDE.md and the feature map name every Movies env var, HTTP route and
# MCP tool the code has, and README names none the code lacks. Prints one OK line or the gaps.
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$ROOT"
FEAT=.claude/skills/verify-notesd/features
ENV_RE='NOTESD_MOVIES[A-Z_]*|NOTESD_VLC_[A-Z_]+|NOTESD_CURL_EXE|NOTESD_FFPROBE_BIN|NOTESD_TASKLIST_EXE|NOTESD_POWERSHELL_EXE|TMDB_[A-Z_]+'
# Where the movies env vars are read: src/config.ts, plus phase 9's two probe-read overrides in the health monitor.
ENV_SOURCES='src/config.ts src/movies/vlc/health.ts'
bad=0
miss() { echo "doc-check: $*" >&2; bad=1; }

# 1. Env vars the movies config reads <-> README Configuration rows.
# shellcheck disable=SC2086
mapfile -t vars < <(grep -ohE "\\b($ENV_RE)\\b" $ENV_SOURCES | sort -u)
[ "${#vars[@]}" -ge 20 ] || miss "$ENV_SOURCES read only ${#vars[@]} movie env vars (${vars[*]:-none})"
for v in "${vars[@]}"; do
  grep -qE '^\| `'"$v"'`' README.md || miss "README Configuration has no row for $v"
done
mapfile -t doc_vars < <(grep -oE '^\| `('"$ENV_RE"')`' README.md | tr -d '|` ' | sort -u)
for v in "${doc_vars[@]}"; do
  printf '%s\n' "${vars[@]}" | grep -qx "$v" || miss "README documents $v, which $ENV_SOURCES do not read"
done

# 2. /api/movies paths <-> README HTTP API rows ("| `GET /api/movies/:id` |", query string allowed). The paths are
#    every '/api/movies…' string literal in the movie routers (phase 4 keeps some in *_PATH constants such as
#    '/api/movies/:id{[a-z]+-[0-9]+}'), with Hono's `{regex}` param constraints stripped. Methods are not compared.
#    A literal with a `*` is a comment about a wildcard middleware, not a route.
mapfile -t routes < <(cat src/http/moviesApi.ts src/http/moviesPlayApi.ts \
  | grep -oE "['\"\`]/api/movies[^'\"\`]*" | cut -c2- | grep -v '[*]' | sed -E 's/\{[^}]*\}//g' | sort -u)
[ "${#routes[@]}" -ge 10 ] || miss "found only ${#routes[@]} /api/movies paths in src/http/movies*Api.ts"
for p in "${routes[@]}"; do
  grep -qE '^\| `(GET|POST|PUT|PATCH|DELETE) '"$p"'(\?[^`]*)?`' README.md || miss "README HTTP API has no row for $p"
done
mapfile -t doc_routes < <(grep -oE '^\| `(GET|POST|PUT|PATCH|DELETE) /api/movies[^`?]*' README.md | sed -E 's/^\| `[A-Z]+ //' | sort -u)
for p in "${doc_routes[@]}"; do
  printf '%s\n' "${routes[@]}" | grep -qxF "$p" || miss "README documents $p, which no movies router serves"
done

# 3. Registered movies_* MCP tools <-> README MCP tool rows. The names live in MOVIE_TOOL_NAMES
#    (src/chat/status.ts); src/mcp/movieTools.ts destructures that list and registers one tool per name.
mapfile -t tools < <(sed -n '/^export const MOVIE_TOOL_NAMES = \[/,/\]/p' src/chat/status.ts | grep -oE 'movies_[a-z_]+' | sort -u)
[ "${#tools[@]}" -ge 6 ] || miss "found only ${#tools[@]} movies_* names in MOVIE_TOOL_NAMES (src/chat/status.ts)"
registered="$(grep -cE '^\s*server\.registerTool\(' src/mcp/movieTools.ts || true)"
grep -q 'MOVIE_TOOL_NAMES' src/mcp/movieTools.ts && [ "$registered" = "${#tools[@]}" ] \
  || miss "src/mcp/movieTools.ts registers $registered tools for ${#tools[@]} MOVIE_TOOL_NAMES"
for t in "${tools[@]}"; do
  grep -qE '^\| `'"$t"'`' README.md || miss "README MCP tools has no row for $t"
done
mapfile -t doc_tools < <(grep -oE '^\| `movies_[a-z_]+`' README.md | tr -d '|` ' | sort -u)
for t in "${doc_tools[@]}"; do
  printf '%s\n' "${tools[@]}" | grep -qx "$t" || miss "README documents tool $t, which is not in MOVIE_TOOL_NAMES"
done

# 4. Tour section, CLAUDE.md bullet, feature map entry.
grep -qE '^## Movies$' README.md || miss "README has no '## Movies' section"
grep -qF '](#movies)' README.md || miss "README Contents does not link #movies"
line="$(grep -E '^- \*\*Movies\*\*' CLAUDE.md || true)"
[ -n "$line" ] || miss "CLAUDE.md has no '- **Movies**' architecture bullet"
for s in src/movies/repo.ts NOTESD_MOVIES src/http/moviesApi.ts src/mcp/movieTools.ts /movies curl.exe verify.sh; do
  grep -qF -- "$s" <<<"$line" || miss "CLAUDE.md's Movies bullet does not mention $s"
done
for h in '## Sub-features' '## How to get to it (user POV)' '## Driving it with verify.sh' '## Gotchas'; do
  grep -qxF -- "$h" "$FEAT/movies.md" || miss "features/movies.md lacks '$h'"
done
grep -qF '[movies.md](movies.md)' "$FEAT/README.md" || miss "features/README.md has no movies.md row"

if [ "$bad" != 0 ]; then echo "doc-check: FAIL" >&2; exit 1; fi
echo "doc-check: OK (${#vars[@]} env vars, ${#routes[@]} routes, ${#tools[@]} tools)"
