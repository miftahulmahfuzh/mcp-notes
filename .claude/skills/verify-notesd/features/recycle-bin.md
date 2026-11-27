# Recycle bin

## Sub-features
- Lists soft-deleted notes and images, most recently deleted first. Restore. Delete forever (hard
  delete, the only one in the app).
- A photo removed from a note: restored alone into its note, or refused with `already in <id>`;
  purged alone (`DELETE /api/bin/images/:id`). Integration: `tests/integration/bin.int.test.ts`.
- The six-second undo bar after a delete (`deleted A-B32`, `removed image`, `removed file`). Unit:
  `web/src/components/UndoBar.test.tsx`.
- Same-origin only: a bin write without the wall's `Origin` is 403 `forbidden_origin`. Unit:
  `tests/unit/sameOrigin.test.ts`.

## How to get to it (user POV)
The rail's Trash icon (`Rail.tsx`, `BIN_TIP`); each item has restore and delete-forever (check,
then cross to cancel). A card's Delete note shows the Undo bar for six seconds.

## Driving it with verify.sh
```sh
$V api RUN DELETE /api/notes/<id>
$V api RUN GET /api/bin                       # the note is listed
$V api RUN DELETE /api/bin/notes/<id>         # hard delete (same-origin; verify.sh sends Origin)
$V sql RUN "select count(*) from notes where id = '<id>'"   # 0

# One photo: remove, restore, remove again, purge
$V api RUN DELETE /api/images/<imageId>
$V api RUN POST /api/images/<imageId>/restore
$V api RUN DELETE /api/images/<imageId>
$V api RUN DELETE /api/bin/images/<imageId>

# The guard: plain curl, because `$V api` always sends Origin
curl -s -X DELETE -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$(cat <run dir>/port)/api/bin/notes/<id>"   # 403
```
Undo, in a steps file: click a card's `Delete note`, then `Undo`, and wait for the card's text again.

## Gotchas
- Bin routes are same-origin only. A 403 from a request without `Origin` is correct behavior.
