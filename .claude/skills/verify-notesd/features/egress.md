# Egress meter and quota breaker

Proof: start a throwaway daemon, then `curl http://127.0.0.1:<port>/api/debug/egress` (loopback only).

- Returns `enabled`, a `quota` block (`tripped`) and `top[]`: per query shape calls, rows and bytes, sorted by bytes.
- `NOTESD_EGRESS_METER=off` returns `{enabled:false}`; the notes API still works. ETag 304 fingerprinting stays on.
- An unchanged `GET /api/notes`, `/api/tags` or `/api/projects/:repo/sessions` with `If-None-Match` answers 304 and costs one aggregate query; any write changes the ETag.
- A Neon 53000 "exceeded the quota" error trips the breaker for 30 minutes (unit-tested in `tests/unit/db-quota.test.ts`; not reproducible against local Postgres).
- Web pollers are visible-only: notes 300 s (60 s stale on focus), graph 30 to 120 s, projects and adversary 120 s.
