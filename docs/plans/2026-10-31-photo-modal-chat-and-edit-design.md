# Photo modal: "chat about this image" and click-to-edit text

Date: 2026-10-31. Status: approved in discussion, implemented in the same change.

## Problem

1. A note can hold many images (e.g. B-SMK). In the big photo view the user needs the **note id**
   and the **image id**, and wants to hand one specific image to the chat agent without
   uploading a second copy of the file.
2. The photo version of the big view shows the note text read-only. The text version
   (`NoteEditor`) edits in place. The photo version should too.

## Feature A: "Chat about this image"

### Pointer, not copy

`chat_message_attachments` already has a `note_image` kind (rendered `[note image:ID]`). A chat
message therefore stores a **reference** to `note_images.id`; nothing is written to
`chat_images` and no file is copied. Derivatives live in `cache/<imageId>/` and are reused.

### Flow

1. `PhotoModal` gets a "Chat about this" icon. It calls `onChatAbout(image.id)`.
2. `App` closes the modal, switches to the history view on a fresh thread, and hands the
   image to the history composer as a *seed*.
3. The composer shows the image as a ready thumbnail (`/api/images/<id>/thumb`) in the bar,
   marked as a note image (no upload).
4. On send, `POST /api/chat` carries `note_image_ids: [...]` next to `image_ids`
   (combined cap stays `MAX_CHAT_IMAGES_PER_MESSAGE`).
5. The server validates each id (live image, live note, file on this machine), stores
   `note_image` attachments, and resolves the `preview` derivative for the model.

### What the agent sees

The current turn labels the picture with where it lives, computed at send time:

    [note image:IMG1 in note NOTE1, image 3 of 12]

So the agent knows the note id without any tool call. Later turns only show
`[note image:IMG1]` (the image id is stable; the note may change).

### `move_image` MCP tool

`move_image(image_id, to_note_id?, body?, origin?)`:

- no `to_note_id`: creates a new note (body optional, `#tags` parsed) and moves the image into it;
- with `to_note_id`: moves it to that live note, appended after its last image.

One transaction. It only rewrites `note_images.note_id` and `position`: **same image id, same
file, same sha256**, so there is no duplicate and the `sha256` live-unique index never fires
(attach-then-remove would have clashed). Source and target notes are touched; events:
`created` for a new note, `updated` for both. The source note stays, with fewer images.
Refused: removed image, deleted source or target note, moving into its own note.

The chat prompt gets one paragraph describing the "extract this image into its own note"
workflow: write the generation prompt from what you see, then `move_image` with that text as
`body`.

Known quirk: a note's first image shares the note's id. After a move, `view_images(thatId)`
still resolves the id as the *old note*. The label above always carries both ids; use it.

## Feature B: click-to-edit text in the photo modal

- The description `<p>` becomes click-to-edit. A click swaps in an auto-focused textarea,
  caret at the end; an empty body shows a placeholder to click.
- The textarea holds the **raw** body including `#hashtags` (the read-only view strips them;
  editing stripped text would delete tags on save). Tag chips still render below.
- Save on blur when changed, through `onSave(note, draft)`; same revision/tag/embedding path
  as the text version. No save button.
- `Esc` while editing saves and leaves edit mode, not the modal. Left/right arrows move the
  caret and do not change photo while editing. Switching photos while editing saves first.
- Emptying the text never deletes the note (it has an image).
- Multi-image notes: the body is shared by the whole note.

## Also

The meta footer shows the image id next to the note id (both copyable via Copy ID for the note).

## Testing

- service: `moveImage` new note / existing note / refusals / position / events.
- http: `note_image_ids` accepted, stored as `note_image` attachments, unknown id rejected.
- chat: label includes note id and position.
- web: PhotoModal edit mode (click, save on blur, Esc, arrows), chat button, composer seed.
