# The local database, the one-time copy, the bind guard

## Sub-features
- notesd runs on a Postgres on this machine: `scripts/install.sh` makes the `mcp-notes-pg` Docker
  container (`127.0.0.1:55437`, database `mcp_notes`) and points `DATABASE_URL` at it, keeping the
  old Neon address as `IMPORT_DATABASE_URL`. The daemon waits for it and applies `drizzle/` at
  every start (`src/db/localDb.ts`). Unit: `tests/unit/scripts/installLocalDb.test.ts`.
- The one-time copy (`src/db/sharedImport.ts`): the old database's rows are staged into the
  `import_stage` schema as soon as it answers (`[notesd] shared import: ... staged`), merged at the
  next start by each table's rule, then marked final in `app_settings` (`shared_import`).
  Integration: `tests/integration/sharedImport.int.test.ts` (stage, an interrupted stage, the merge
  rules).
- A `DATABASE_URL` from the real environment (tests, a throwaway daemon) is never migrated, waited
  for or copied into. Unit: `tests/unit/config.test.ts`.
- notesd binds `127.0.0.1` only: any other `NOTESD_HOST` refuses to start. Unit:
  `tests/unit/config.test.ts`.

## How to get to it (user POV)
Nothing to open: the daemon log at start (`journalctl --user -u notesd`) shows the wait, the
migrations and, once, the copy.

## Driving it with verify.sh
Not drivable: `verify.sh` hands the daemon its `DATABASE_URL` through the real environment, which
is exactly the case that is never treated as local or imported into. Prove changes here with
`npm run test:int -- tests/integration/sharedImport.int.test.ts` and
`npx vitest run tests/unit/scripts/installLocalDb.test.ts tests/unit/config.test.ts`. The bind
guard can be seen live: `NOTESD_HOST=0.0.0.0 $V up` fails to start, and `daemon.log` holds the
refusal.

## Gotchas
- Never run `scripts/install.sh` to prove a change here: it restarts the live daemon. Its database
  step is covered by `installLocalDb.test.ts`.
- A new table goes into `SHARED_IMPORT_TABLES` with a merge rule only if Neon could hold rows of it.
