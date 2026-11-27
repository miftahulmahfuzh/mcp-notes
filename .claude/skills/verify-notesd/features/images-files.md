# Photos and files in notes

## Sub-features
- Upload an image: original kept byte for byte; thumb/display/preview derived. HEIC kept, JPEG made for viewing.
- Same bytes uploaded twice: the existing note is returned (`created: false`).
- Attach, remove, restore, move images between notes (MCP); non-image files (`/api/files`).
- Inbox: files dropped in `<data dir>/inbox` are ingested once their size has held for 2 s. Unit:
  `tests/unit/images/inbox.test.ts`.
- Full-screen viewer `/full/:imageId`: a click flips fit and 1:1, drag pans, a placeholder for a
  missing picture. Unit: `web/src/fullscreen/FullscreenApp.test.tsx`.
- The photo modal and image viewer: arrows, wrap versus stop, Esc layering, editing the text,
  Delete image (which closes the modal). Unit: `web/src/components/PhotoModal.test.tsx`,
  `PhotoModal.edit.test.tsx`, `PhotoModal.delete.test.tsx`, `Lightbox.test.tsx`.
- Attaching in the big editor by drop or paste: `already in <id>` for bytes already stored, the
  `(too large)` notice, file chips. Unit: `web/src/components/DropOverlay.test.tsx`,
  `FileChips.test.tsx`, `NoteEditor.test.tsx`; integration: `tests/integration/files.int.test.ts`.
- Open file location (Show in Explorer) and `GET /api/capabilities` (`{reveal, movies_playback}`).
  The harness cannot open Explorer. Unit: `tests/unit/reveal.test.ts`,
  `web/src/components/RevealMounts.test.tsx`; integration: `tests/integration/reveal.int.test.ts`,
  `tests/integration/files.reveal.int.test.ts`.
- Pictures pasted into Claude Code: the notes-prompt hook saves them, the notes-paste hook rewrites
  the prompt, and the server refuses `pasted_image` without them (`pasted_image_unresolved`). See
  `claude-code.md`.
- `/migrate`: a skill-only flow driven by the model, with no test. Prove it by a manual run on a
  scratch folder against a throwaway daemon, never on the owner's folders.
- The legacy photo copy at start (runs once, idempotent): the `[notesd] legacy images reconciled`
  line in `daemon.log`.

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

```sh
# Files on a note: the second upload of the same bytes is not attached again
$V upload RUN /api/notes/<id>/files tests/fixtures/images/plain.png   # 201
$V upload RUN /api/notes/<id>/files tests/fixtures/images/plain.png   # 200, attached:false
# Inbox
cp tests/fixtures/images/plain.png <run dir>/data/inbox/ && sleep 4
grep '\[inbox\]' <run dir>/daemon.log                                # "[inbox] plain.png -> <id>", "(already stored)" for known bytes
# Capabilities: reveal follows the host (true under WSL, where Explorer exists), playback is off
$V api RUN GET /api/capabilities                                      # {"reveal":true,"movies_playback":false} on WSL
```
Full screen, in a steps file: `page.goto(base + '/full/<imageId>')`, click the picture, and check
its `data-fit` attribute flips from `fit` to `actual`.

## Gotchas
- Variants are `thumb`, `display`, `preview`, `original`. The original's sha256 matching the fixture proves "never re-encoded".
- `not_on_this_machine` / `available:false` needs a row from another host; not producible here.
