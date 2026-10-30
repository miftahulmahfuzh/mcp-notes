---
name: migrate
description: Move every image in a directory into one new mcp-notes image note, tag it, then delete the original directory to free disk. Use whenever the user types "/migrate <dir_path> <tags>", e.g. "/migrate C:\Users\GPD\Downloads\Telegram Desktop\sun27 #ai_image", or asks to move/migrate/import a folder of pictures into their notes and remove the folder.
argument-hint: <dir_path> <#tag> [#tag ...]
---

# /migrate — a folder of images into one note, then delete the folder

`/migrate <dir_path> <tags>` puts every image file in `<dir_path>` into ONE new image note of the
`notes` MCP server (`mcp__notes__*`), tags that note, and then removes the original directory so
the pictures are stored only once. The notes store keeps its own byte-for-byte copy.

## Arguments

- `<dir_path>`: first argument. A Windows path (`C:\Users\GPD\Downloads\Telegram Desktop\sun27`)
  or a Linux path. It may contain spaces and may be quoted; everything before the first
  `#tag` token is the path. Convert `X:\a\b` to `/mnt/x/a/b` (drive letter lower-cased, `\` to
  `/`). Expand `~`.
- `<tags>`: every `#word` token after the path. At least one is required; if none were given,
  ask once and stop. Tags are written into the note body.

## Steps

1. Resolve the path and `ls -la` it. Refuse and stop, deleting nothing, if it does not exist, is
   not a directory, or is a dangerous target: `/`, `/mnt/<drive>`, `$HOME`, a drive root,
   `Downloads`, `Desktop`, `Documents`, or any path with fewer than three components.
2. Find the image files (PNG, JPEG, WebP, GIF, HEIC, TIFF, BMP, AVIF) in the directory, in
   natural filename order (`s2` before `s10`: `ls -v`). Non-recursive unless the user says
   otherwise. If there are no images, stop and say so.
3. If the directory also holds non-image files or subdirectories, list them and tell the user
   they are not migrated. Then ask before step 6, because deleting the directory would destroy
   them. Only continue to delete when the directory held nothing but the migrated images, or the
   user confirms.
4. Create the note: `create_image` with the first image's absolute path, a one-line body
   saying what it is plus the directory's base name and the file range, a blank line, then the
   tags on the last line. Pass `origin` (`cwd`, and `repo` only when in a git repo). Check
   the existing tags with `tags` if unsure about spelling.
5. Attach every remaining image with `attach_image` to that note's id, strictly one at a time
   and in order (the order is the attach order). Pass `origin`. If `attached: false` comes back
   for a file, it already lives in another note: record which note, and do not count it as a
   failure of the migration. If any call errors, stop; do NOT delete anything; report what was
   and was not saved.
6. Verify before deleting: `get` the note and compare its `images` with the files: same count
   (minus those reported `attached: false`, which live in another note) and each
   `original_name` and `bytes` matching the source file. Only when everything matches, run
   `rm -r -- "<dir>"` on exactly that directory and confirm it is gone.
7. Reply short: the note id as a wall link, the number of images, the tags, the directory
   removed and the disk space freed, and anything skipped or already stored elsewhere.

## Rules

- This command always deletes the original directory; that is its purpose, and the user's
  invocation is the authorization. Never delete on a partial or unverified migration.
- Delete only the directory named in the arguments, never a parent.
- Follow the `n` skill for note conventions: plain-text body, no markdown, hashtags on the last
  line, no secrets, note ids written as `[A-B32](<wall>/?note=A-B32)` in replies and bare in
  tool arguments.
- One note for the whole directory, not one note per image, unless the user asks otherwise.
