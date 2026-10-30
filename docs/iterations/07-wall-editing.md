# Iteration 7 — Wall editing: big editor, several images per note, recycle bin, open file location, collapsible answer panel

One `/analyze` run. Everything below the line is the owner's request, verbatim input for
/analyze Step 0.

---

Build mcp-notes iteration 7 ("Wall editing"). The "Fixed decisions" table in docs/ROADMAP.md is
binding except where this brief explicitly changes it (one change: a note may now hold several
images; see R1). Iterations 1–6 are on main (plans in docs/plans/).

The owner's request, as written:

> mcp-notes features
> - add expand button to note item, so, i can:
> 1. click add new note, and type in in the small note for short text, but if i need to typed in
>    long text, i can click "zoom in" button, and we can edit text in a big pop up modal. dropping
>    an image when this modal pop will automatically attach this image into the note that we are
>    editing.
> - add a delete button to note item . deleting an image note will move it to our own "recycle
>   bin" so i can easily check "deleted" image if needed
> - for image note, can we add a "open file location" button that will open windows explorer and
>   open the dir path and select the file?

Decisions already made with the owner:
  - A note can hold several images (like Google Keep), not one. Dropping an image into a note
    that already has images adds another.
  - The recycle bin holds every deleted note, text and image, not only image notes.

There is no Claude Design mock for these screens. Follow the existing design language exactly
(docs/design/claude-design/Notes Wall.dc.html and the shipped web/): #121211 canvas, #ecebe4
text, Host Grotesk + Geist Mono, icon-only controls (Phosphor duotone from the npm package) with
the custom tooltip, hairlines, no shadows, no rounded cards, the giant heading. No text on
buttons.

R1 — Several images per note. Move from `notes.image_path` / `notes.image_meta` (one image) to a
per-image table: each image keeps its own byte-exact original, sha256, metadata (mime, width,
height, bytes, EXIF taken_at, original name, host), position in the note, and its own soft-delete
time. The migration is lossless for every existing note, including soft-deleted ones, and runs
on the live Neon database; keep the old columns until the new table is proven (drop them in a
later migration, not this one, unless the plan shows a safe drop). Files on disk do not move.
  - Dedupe stays by sha256 per live image: dropping a file that already lives in a note returns
    that note instead of a duplicate (and, in the editor, says so quietly rather than attaching a
    second copy).
  - The wire Note carries `images: [...]` in order, each with its own id, URLs and `available`.
    Every consumer moves to it: wall cards show the first image as the cover with a small
    Geist Mono count when there are more; the "Photos." gallery shows one tile per image; the
    photo modal steps through images (within a note, then across notes) and shows which image of
    the note it is; the full-screen tab takes an image, not a note; `view_images` returns every
    image of the notes asked for (still capped); `list`/`search` `has_image` means "at least one
    image"; EXIF taken-date filters match if any image matches. Derived files (thumb, preview,
    display) become per image. Embeddings are unaffected (they embed text).
  - Ingestion: HTTP upload, the inbox folder and `create_image` still create one new note per
    file. New: HTTP and MCP ways to attach an image to an existing note (an `attach_image` MCP
    tool taking a note id and a local path), and to remove one image from a note (soft, to the
    bin).

R2 — The big editor. Every note card gets an expand icon (Phosphor arrows-out-simple or similar).
It opens a large modal editor on that same note: a wide, tall text area in the wall's type
(Host Grotesk, generous size), the note id with copy-id, tag chips, and the note's images as a
strip with a per-image remove icon. Text saves the way cards do (on blur and on close, only if
changed), and the card on the wall reflects it at once. Esc closes. The "+" sticker still
creates a note in place on the wall; expanding it from there is the "zoom in" the owner
describes. While the editor is open:
  - dropping or pasting an image attaches it to the note being edited (not a new note); the
    drop overlay says so by its icon (an "attach" icon, not the new-note image icon);
  - attaching an image to a text note while the wall is in "Notes." (text only) switches the wall
    to "Everything." on close, so the note does not vanish, following the existing rule for
    drops;
  - an emptied note is not deleted while the editor is open; on close, the existing rule applies
    (an empty note with no images is soft-deleted).

R3 — Delete button and recycle bin. Every note card, the editor, and the photo modal get a delete
icon (Phosphor trash). Deleting is soft and needs no confirmation; a quiet undo (an icon button
with a tooltip, in the style of the existing "copied" label, for a few seconds) restores it.
The recycle bin is a new view reached by a trash icon on the rail (and in the expanded sidebar),
with the giant heading "Deleted." It lists deleted notes newest-deleted first in the same wall
style, with deleted images also as a gallery grid at the top: whole deleted notes and single
images removed from a live note. Each entry has restore and "delete forever". Delete forever is
the one destructive action: it asks for confirmation (a small inline confirm, icon-only, in the
design's style), then removes the database rows and the original files plus their derived files.
It is UI-only: no MCP tool can delete forever, so Claude can never destroy data. Tag filters
apply in the bin too. Tags and counts in the sidebar keep counting live notes only.

R4 — Open file location. Photo cards, the photo modal and the editor's image strip get a folder
icon (Phosphor folder-open). Clicking it asks notesd to open Windows Explorer with the image's
original selected: notesd converts the path with `wslpath -w` and runs
`explorer.exe /select,<windows path>` (WSL interop works from the systemd user unit; this was
checked). Rules:
  - The endpoint only accepts requests whose Origin is notesd's own page, so another site open
    in the browser cannot trigger it; it takes an image id, never a path.
  - The icon shows only when the file is on this machine and the daemon runs under WSL with
    interop available (report this through a small capabilities endpoint); otherwise it is not
    rendered.
  - explorer.exe's exit code is meaningless (it returns 1 on success); judge success by the spawn
    only, and never block the request on Explorer.

R6 — Collapsible answer panel. Added by the owner after this brief was first written:

> make it so the overlay claude answer can be collapsed and expanded. by default it would be in
> its expanded state, if user click the collapse button, it will collapse to only show the
> query. e.g:
> ```
> cari notes yang membahas fitur . claude
> ```
> right now , we only have `x` button that closes the overlay permanently

  - The answer panel's header gets a collapse/expand icon (Phosphor caret-down / caret-up, or
    similar), next to pin and dismiss, with a tooltip. Icon only.
  - Collapsed, the panel shrinks to its header line alone: the query, then " · " and the brain
    (or the live status caption while it is still answering), plus its icons, sitting just above
    the chat bar. Expanded shows the full answer, as today.
  - Every new answer opens expanded. Collapsing does not stop a streaming answer; it keeps
    streaming and the status caption keeps updating in the collapsed line.
  - Clicking the collapsed line (not only the icon) expands it. Pin, dismiss and Esc keep their
    current meaning; dismiss still closes it for good and starts a new thread next time.
  - Used-note outlines and dimming on the wall stay while collapsed, since the answer is still
    the current one.

R5 — Tests. Unit and component tests for the editor (save on blur/close, attach on drop and
paste, empty-on-close rule, mode switch), the bin (restore, undo, delete-forever confirm), and
the reveal button's visibility rules. Integration tests for the migration (an iteration-6
shaped database with live and deleted image notes migrates losslessly and every image is still
served), attach/remove image, per-image dedupe, the bin endpoints, delete forever (rows and files
gone, nothing else touched), the Origin check, and the reveal command line (with the spawn
faked). Update the README sections and GIF-free text that describe photos, the gallery and the
modal so they match the new behaviour.

Acceptance (in the browser at http://localhost:7317, and through `/n`):
  - "+" → type a line → expand → write three paragraphs → drop two screenshots → close: one note
    with the text and two images; the wall shows the cover and "2".
  - Delete that note from its card → it is gone from the wall → undo brings it back → delete
    again → it is in "Deleted." → restore → back on the wall with both images.
  - Remove one image in the editor → it appears in the bin's image grid → restore puts it back in
    the note at its old position.
  - Delete forever on a deleted note asks first, then the files are gone from
    ~/mcp-notes-data/images.
  - The folder icon on a photo opens Explorer with that file selected.
  - /n show me the pictures in note <id>  → Claude sees every image of that note.
  - /n attach ~/Pictures/Screenshots/<file>.png to note <id>
  - Ask in the chat bar → collapse while it streams → the line shows "<query> · <status>" and
    then "<query> · claude" → click it → the full answer is there.

Out of scope: rich text or markdown rendering in notes, reordering images by drag (order is
attach order; removing and restoring keeps position), image editing or cropping, a bin auto-purge
timer, mobile layout, sync of images to other machines.
