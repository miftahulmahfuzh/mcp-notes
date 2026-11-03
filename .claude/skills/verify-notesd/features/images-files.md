# Photos and files in notes

## Sub-features
- Upload an image: original kept byte for byte; thumb/display/preview derived. HEIC kept, JPEG made for viewing.
- Same bytes uploaded twice: the existing note is returned (`created: false`).
- Attach, remove, restore, move images between notes (MCP); non-image files (`/api/files`).
- Inbox: files dropped in `<data dir>/inbox` are ingested.
- Full-screen viewer `/full/:imageId`.

## How to get to it (user POV)
Wall: drop or paste an image anywhere, `Attach files` in the editor, `Show full screen`.
Claude Code: `/n` with a picture, `/migrate`. MCP `create_image`, `attach_image`, `view_images`, ...

## Driving it with verify.sh
```sh
$V upload RUN /api/images tests/fixtures/images/plain.png "#pics first"   # 201, note with images[0]
$V upload RUN /api/images tests/fixtures/images/plain.png                 # 200, created:false
$V api RUN GET /api/images/<imageId>/thumb      # 200 image/webp, bytes saved as NN-*.bin
$V api RUN GET /api/images/<imageId>/original   # sha256 printed: must equal `sha256sum <fixture>`
$V sql RUN "select id, mime, bytes, host from note_images"
```
HEIC: upload `tests/fixtures/images/photo.heic`, then check both the original and a JPEG variant.

## Gotchas
- Variants are `thumb`, `display`, `preview`, `original`. The original's sha256 matching the fixture proves "never re-encoded".
- `not_on_this_machine` / `available:false` needs a row from another host; not producible here.
