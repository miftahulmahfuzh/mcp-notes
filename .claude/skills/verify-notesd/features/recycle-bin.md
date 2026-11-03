# Recycle bin

## Sub-features
- Lists soft-deleted notes and images. Restore. Delete forever (hard delete, the only one in the app).

## How to get to it (user POV)
Wall sidebar `Recycle bin`; each item has restore and delete-forever (check, then cross to cancel).

## Driving it with verify.sh
```sh
$V api RUN DELETE /api/notes/<id>
$V api RUN GET /api/bin                       # the note is listed
$V api RUN DELETE /api/bin/notes/<id>         # hard delete (same-origin; verify.sh sends Origin)
$V sql RUN "select count(*) from notes where id = '<id>'"   # 0
```

## Gotchas
- Bin routes are same-origin only. A 403 from a request without `Origin` is correct behavior.
