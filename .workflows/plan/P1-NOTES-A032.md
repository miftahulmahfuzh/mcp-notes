> Adopted from `/home/miftah/.worktrees/mcp-notes/wall-editing/.workflows/orchestration/wall-editing/PLAN.md` phase 10. Source: `.workflows/plan/wall-editing/phase-10.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 10: Docs, Neon migration 0002, full verification

**Plan set:** `WALL_EDITING_PLAN.md`
**Analysis:** `docs/analyzer/20261030-153729-W7ED_code_analyzer.md`
**Satisfies:** R5 (the README half: the photo, gallery and modal text matches the new behaviour; suite and build green on the merged tree) and R1's last clause ("the migration … runs on the live Neon database": Steps 7–9 apply phase 1's migration 0002 to Neon and verify it).
**Depends on:** Phase 9, Phase 11, and through them phases 1–8
**Difficulty:** NORMAL
**Package:** docs (`README.md`, `claude/skills/n/SKILL.md`, `docs/INSTALL.md`), Neon

---

## Goal

After this phase the README, the `/n` skill and INSTALL describe iteration 7 as built:

- several photos per note
- the big editor
- delete and the recycle bin
- open file location
- the collapsible answer panel
- the multi-line chat bar
- the new HTTP routes and MCP tools
- the `note_images` storage

The whole tree is proven green: typecheck, unit, integration and build. Migration 0002 is applied to the live Neon database, and a read-only before/after check shows every legacy image has exactly one identical `note_images` row. The installed daemon is not restarted.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:** documentation only, as new README sections:

- "The big editor"
- "Deleting and the recycle bin"
- "Open file location"
- new INSTALL section "7. Several images per note (iteration 7)"

The Neon database gains `note_images` and one more `drizzle.__drizzle_migrations` row. Phase 1 wrote that migration; this phase only applies it.
**Signature changes:** none. No source file is edited.
**Requires (from earlier phases):**
- Phase 1: `drizzle/0002_note_images.sql` and `drizzle/meta/_journal.json` entry `idx: 2`. The migration creates `note_images` with indexes `note_images_pkey`, `note_images_path_uniq`, `note_images_note_position_idx`, `note_images_sha256_live_uniq` and `note_images_taken_at_idx`, plus one FK to `notes(id)` with `ON DELETE CASCADE`. It also has the hand-appended legacy copy `INSERT … SELECT`. Row values must match the contract: `id = note_id = notes.id`, `position = 0`, `created_at = notes.created_at`, and `deleted_at` null except on sha clash, where it takes `notes.deleted_at`.
- Phase 2: the startup `reconcileLegacyImages` in `src/background.ts`. INSTALL documents it. `view_images` accepts note ids or image ids and caps at 8 with an overflow line. `/full/:imageId` and the `/api/notes/:id/:variant` alias keep working. `GET /api/images/:imageId[/variant]` exists.
- Phase 3: MCP `attach_image {id, path, origin?}` returns `{note, attached}`. `remove_image {image_id}` and `restore_image {image_id}` exist. The HTTP routes are `POST /api/notes/:id/images`, `DELETE /api/images/:imageId` and `POST /api/images/:imageId/restore`, which returns 409 with `note_id`.
- Phase 4: `GET /api/bin?tag=`, `POST /api/notes/:id/restore`, and `DELETE /api/bin/notes/:id` / `DELETE /api/bin/images/:imageId` behind `sameOriginOnly`. No MCP purge tool exists.
- Phase 5: `GET /api/capabilities` returns `{reveal}`. `POST /api/images/:imageId/reveal` is the reveal route. `NOTESD_EXPLORER_BIN` resolves first, then PATH, then `/mnt/c/Windows/explorer.exe`. The result is cached per process.
- Phases 6–9: the UI described in the plan index Contract "Web" section, as quoted in the README text below:
  - cover plus Geist Mono count
  - one gallery tile per image
  - modal `i / len` and `k/n`
  - `ArrowsOutSimple` expand, tooltip `Expand note`, at the right end of the card's id line (after the date), followed by the Trash (`Delete note`)
  - editor with strip (per-image remove `Remove image`)
  - `Paperclip` overlay
  - Trash on card, editor and modal (tooltip `Delete note`)
  - `UndoBar` with `deleted A-B32` / `removed image` for 6 s, above the right end of the chat bar, undo tooltip `Undo`
  - `Deleted.` bin (rail/sidebar tooltip `Recycle bin` / `Back to the wall`) with the image grid on top, restore, and the `Check` (`Delete forever`) / `X` (`Cancel`) inline confirm
  - `FolderOpen` with `data-tip="Show in Explorer"`, gated on `caps.reveal && image.available`, on wall cards with photos, the modal toolbar and the editor strip; not on gallery tiles
- Phase 11: caret collapse beside pin and dismiss, with `data-tip` `Collapse`/`Expand`. Click on the collapsed line expands it. The query is shown on one line with an ellipsis and a tooltip. The textarea bar sends on Enter, inserts a newline on Shift+Enter, is IME-safe, grows to 6 lines and then scrolls.

**Leaves alone (owned by others):** every file under `src/`, `web/`, `tests/`, `drizzle/`, `scripts/` and `deploy/`, plus `docs/ROADMAP.md` and `src/mcp/instructions.ts` (phases 2/3). It also leaves the installed systemd unit and the running daemon alone.

## Files

| File | Action | What changes |
|---|---|---|
| `README.md` | modify | Contents (`:14-19`). "Why it is different" bullets (`:70-77`). Three views (`:94-102`). Writing a note (`:115-120`) plus a new "The big editor". Adding photos (`:124-136`). Photo modal and full-screen (`:140-151`) plus new "Deleting and the recycle bin" and "Open file location". Looking at pictures (`:174-178`). More things to ask (`:205-211`). The chat bar (`:215-230`). Install comment (`:321`). A second machine (`:355-360`). Configuration (`:404`). Diagram (`:415-424`). MCP tools (`:432-450`). HTTP API (`:469-479`). Storage (`:483-495`). Limitations (`:499-518`). Roadmap (`:522-531`). About the screenshots (`:549-552`) |
| `claude/skills/n/SKILL.md` | modify | description (`:3`), "What a note is" (`:25`), Tools (`:29-38`), Images (`:158-168`), Deleting (`:170-173`) |
| `docs/INSTALL.md` | modify | new section "7. Several images per note (iteration 7)" before "Uninstall" (`:266`), two Troubleshooting bullets (after `:290`) |
| Neon (`drizzle.__drizzle_migrations`, `note_images`) | migrate | `npm run db:migrate` applies phase 1's 0002 |
| `.env.local` (worktree root) | symlink, untracked | `ln -sf /home/miftah/mcp-notes/.env.local .env.local` (invariant 8). It is gitignored and never committed |

The line numbers are the worktree's current `README.md`, `SKILL.md` and `INSTALL.md`. No other phase edits these three files, so the numbers still hold after phases 1–9 and 11 land. Apply the README edits bottom-up (Step 1r first, Step 1a last) so earlier line numbers stay valid. Better still, anchor each edit on the quoted "old" text, which is unique.

## Implementation Steps

### Step 0: Preconditions
**File:** none
**Change:** confirm the tree is the merged set and clean.
```sh
cd /home/miftah/.worktrees/mcp-notes/wall-editing
git status --short                       # empty
ls drizzle/0002_note_images.sql          # exists (phase 1)
node -e "console.log(require('./drizzle/meta/_journal.json').entries.map(e=>e.tag))"
# [ '0000_init', '0001_note_embeddings', '0002_note_images' ]
grep -n "reconcileLegacyImages" src/background.ts     # one call (phase 2)
grep -n "'attach_image'\|'remove_image'\|'restore_image'" src/mcp/imageTools.ts   # three registrations (phase 3)
grep -rnE "registerTool\(\s*'(purge|delete_forever)" src/mcp/ ; echo "exit $?"   # no MCP purge tool (phase 4); grep exits 1
grep -n "NOTESD_EXPLORER_BIN" src/http/reveal.ts         # phase 5
```
If any check fails, the owning phase has not landed. Stop and report which phase.

### Step 1: README.md
**File:** `README.md`

Each sub-step replaces the quoted lines with the block shown. Every block is complete.

#### Step 1a: Contents, `README.md:14-19`
Old (lines 14–19):
```
- [A tour of the wall](#a-tour-of-the-wall)
  - [Three views: notes, photos, everything](#three-views-notes-photos-everything)
  - [Tags](#tags)
  - [Writing a note](#writing-a-note)
  - [Adding photos](#adding-photos)
  - [The photo modal and the full-screen tab](#the-photo-modal-and-the-full-screen-tab)
```
New:
```markdown
- [A tour of the wall](#a-tour-of-the-wall)
  - [Three views: notes, photos, everything](#three-views-notes-photos-everything)
  - [Tags](#tags)
  - [Writing a note](#writing-a-note)
  - [The big editor](#the-big-editor)
  - [Adding photos](#adding-photos)
  - [The photo modal and the full-screen tab](#the-photo-modal-and-the-full-screen-tab)
  - [Deleting and the recycle bin](#deleting-and-the-recycle-bin)
  - [Open file location](#open-file-location)
```

#### Step 1b: "Why it is different", `README.md:70-77`
Old: the three bullets starting `- **Photos stay byte for byte.**`, `- **Claude can see your photos.**` and `- **Nothing is lost by editing.**` (lines 70–77).
New:
```markdown
- **Photos stay byte for byte.** Originals are never re-encoded or resized. The wall shows a
  thumbnail and the modal a display copy, but the full-screen tab shows the original pixels at
  1:1, and the file on disk is exactly the file you dropped. HEIC photos from a phone are kept as
  HEIC, with a full-resolution JPEG made only for viewing. A note can hold several photos, kept
  in the order you added them.
- **Claude can see your photos.** A tool returns a preview sized for Claude's image input, so
  "what's in the pictures I saved on Sunday?" gets a real answer about the pictures, and "show me
  the pictures in note A-B32" shows Claude every picture in that note.
- **Nothing is lost by editing.** Every update, append, revert and delete keeps the previous body
  in `note_revisions`. Claude can list revisions and revert. Deleted notes and removed photos go
  to a recycle bin on the wall. Only "delete forever" in that bin removes anything for good, and
  no tool Claude has can do that.
```

#### Step 1c: Three views, `README.md:94-102`
Old: lines 94–102 (the paragraph `The wall opens on text notes only, …`, the `views.gif` line, and the two-column table).
New:
```markdown
The wall opens on text notes only, with photo notes hidden. The rail button cycles through the
three views: text only ("Notes."), photos only ("Photos.", a contact-sheet gallery with one tile
per photo, so a note with three photos gives three tiles), and everything mixed ("Everything.").
The giant heading always tells you which one you're in. On the wall a photo note shows its first
photo as the cover, with a small count in the corner when it holds more than one.

![Cycling the three views](docs/readme/views.gif)

| Photos only | Everything |
|---|---|
| ![The gallery](docs/readme/gallery.jpg) | ![Text and photo notes mixed](docs/readme/wall-all.jpg) |

The recording and both stills were made before iteration 7. Every photo note in them holds one
photo, so no card shows a count, and the cards lack the expand, delete and folder icons
described below.
```

#### Step 1d: Writing a note, plus the new "The big editor", `README.md:115-120`
Old: lines 115–120 (the paragraph `The round "+" sticker …` and the `write.gif` line).
New:
```markdown
The round "+" sticker (or the pencil on the rail) creates a note with a server-made id and opens
it for typing. Text is saved when the field loses focus. Clear the text of a note that has no
photos and it is deleted when you leave it (softly: it goes to the recycle bin, with its last
body kept as a revision). Text size follows length, so a three-word note reads like a sticky and
a paragraph reads like a paragraph.

![Writing a note, copying its id, filtering by its tag](docs/readme/write.gif)

The recording shows the inline flow, which is unchanged. It was made before cards had the expand
and delete icons.

### The big editor

Every card has an expand icon at the right end of its id line, beside the trash icon. It opens
the same note in a large editor:

- a wide, tall text area in the wall's type
- the note id with its copy button
- the tag chips
- the note's photos as a strip, each with a remove icon and the folder icon (see
  [Open file location](#open-file-location))

For a long note, press "+", type the first line, then expand it and keep writing.

- Text saves the way cards do: when the text area loses focus and when the editor closes, and
  only if it changed. The card on the wall shows the change at once.
- Esc closes it.
- While the editor is open, a dropped or pasted image is attached to this note instead of
  becoming a new one. The drop overlay shows a paperclip instead of the usual image icon to say
  so. A file that already lives in a note is not attached twice. The editor quietly says which
  note holds it.
- If you attach a photo to a text note while the wall is on "Notes.", the wall switches to
  "Everything." when you close the editor, so the note stays in sight.
- Emptying the text does not delete the note while the editor is open. On close, a note with no
  text and no photos goes to the recycle bin, the same rule as on the wall.
- Removing a photo from the strip is soft. The photo goes to the recycle bin's photo grid, and
  restoring it puts it back at the same place in the note.

The editor has no recording yet.
```

#### Step 1e: Adding photos, `README.md:124-136`
Old: lines 124–136 (the paragraph `Drop image files anywhere on the page, …`, the `drop.gif` line, `Two other ways in, both handy from Claude Code:` and its two bullets).
New:
```markdown
Drop image files anywhere on the page, or paste a screenshot. Each file becomes a new photo
note. If you are in the text-only view, the wall switches to everything so you can see the new
note. To add a photo to a note that already exists, open it in [the big editor](#the-big-editor)
and drop it there. Each photo is stored once (dedupe by sha256, per photo). Dropping a file that
is already in a note returns that note instead of a copy, and brings the note back from the
recycle bin if it was deleted.

![Dropping a photo onto the wall](docs/readme/drop.gif)

Three other ways in, all handy from Claude Code:

- **The inbox folder.** Anything dropped into `~/mcp-notes-data/inbox` becomes a photo note, and
  the file is moved into the store.
- **The `create_image` tool.** Claude Code often has a screenshot path at hand: "save this
  screenshot as a note about the login bug".
- **The `attach_image` tool.** It adds a local file to a note that already exists: "attach
  ~/Pictures/Screenshots/login-bug-2.png to note A-B32".
```

#### Step 1f: Photo modal and full-screen tab, plus the two new sections, `README.md:140-151`
Old: lines 140–151, from `Click a photo for the modal: …` through `![Fit, 1:1 and panning in the full-screen tab](docs/readme/fullscreen.gif)`.
New:
```markdown
Click a photo for the modal: the display copy, the note's text, its tags and id. The
previous/next buttons and the arrow keys step one photo at a time, through every photo of a note
and then on to the next note, within the current filter. The meta line shows where you are
overall (`4 / 12`) and, for a note with several photos, which of that note's photos this is
(`2/3`). Esc closes it. The modal also has the delete icon, which sends the note to the recycle
bin, and the folder icon.

![The photo modal](docs/readme/modal.jpg)

![Stepping through photos in the modal](docs/readme/photos.gif)

Both were captured before iteration 7, when a note held one photo. They show neither the `2/3`
position nor the delete and folder icons.

"Show full screen" opens the photo alone in a new tab, titled with its id. A note's first photo
shares the note's id, so old `/full/<note id>` links still open it. The tab fits the window by
default. Click to toggle 1:1 device pixels and drag to pan. This tab shows the original with no
film-tone filter. It's the place to check focus and grain.

![Fit, 1:1 and panning in the full-screen tab](docs/readme/fullscreen.gif)

### Deleting and the recycle bin

Every card, the big editor and the photo modal have a trash icon. Deleting needs no confirmation
and is soft. For six seconds a quiet line above the right end of the chat bar says
`deleted A-B32`, with an undo icon beside it. Click the icon and the note is back. Removing one photo in the editor works the
same way (`removed image`).

The trash icon on the rail (and in the open sidebar) switches to the recycle bin, headed
"Deleted.". It holds every deleted note, text and photo alike:

- at the top, a grid of deleted photos: the photos of deleted notes, and single photos removed
  from a note that is still on the wall;
- below, the deleted notes in the wall's style, most recently deleted first.

Tag filters work in the bin too. The sidebar's tags and counts keep counting live notes only.

Each entry has two icons, restore and delete forever:

- Restore puts a note back on the wall, or puts a removed photo back into its note at its old
  position. Restoring a photo of a deleted note brings the note back with it.
- If the same file has since been added to another note, restoring the photo is refused, and
  the message says which note holds it.
- In the grid, the tile of a deleted note acts on the whole note.

Delete forever is the only destructive action in mcp-notes. It asks first, inline: the two icons
turn into a check (delete forever) and a cross (cancel). Once confirmed, it removes the database
rows: either the note with its photos, revisions and embedding, or the one photo. It also removes
the original files and their derived copies in `cache/`, and nothing else. Delete forever exists
only on the wall. No MCP tool can delete anything for good, so Claude can never destroy data.

The bin has no recording yet.

### Open file location

Photo cards on the wall, the photo modal and the editor's photo strip have a folder icon ("Show
in Explorer"). Gallery tiles don't; open the photo and use the modal's. Clicking it opens Windows Explorer on the folder that holds the original, with the
file selected. `notesd` turns the stored path into a Windows path with `wslpath -w` and starts
`explorer.exe /select,<path>`. It does not wait for Explorer, whose exit code means nothing.

The icon appears only when this can work: the original must be on this machine, and `notesd`
must run under WSL with Windows interop available (`GET /api/capabilities` answers
`{"reveal":true}`). The endpoint takes a photo id, never a path. It refuses any request whose
`Origin` is not the wall's own page, so another site open in the browser cannot trigger it.
```

#### Step 1g: Looking at pictures, `README.md:174-178`
Old: lines 174–178 (the paragraph `` `list` filtered by `has_image` … Claude noticed.`` and the `cc-photos.gif` line).
New:
```markdown
`list` filtered by `has_image` and the saved date, then `view_images`, which hands Claude the
previews. In this demo the sample captions came from a design mock-up and don't match the stock
photos. Claude noticed.

![/n show me some pictures that i saved on 26 oct, give your comments on them](docs/readme/cc-photos.gif)

`view_images` takes note ids or photo ids. A note id stands for every photo of that note, in
order, so "/n show me the pictures in note A-B32" lets Claude see all of them. A call returns at
most eight. Past eight, it names the photo ids still to view, and Claude can ask for those next.
The recording was made before notes could hold several photos, but the calls it shows work the
same way today.
```

#### Step 1h: More things to ask, `README.md:205-211`
Old: lines 205–211 (the fenced block with five `/n` lines).
New:
````markdown
```
/n let's get this session insights up until now and save it as a new note
/n check note A-B32 . i just copy paste it in a markdown format. please remove the markdown formatting in it. also add tag #agentic to it
/n summarize our notes on #seer this week. compare it to #v250
/n what did A-B32 say before i edited it yesterday? put it back
/n save ~/Pictures/Screenshots/login-bug.png as a note, tag it #seer #bug
/n attach ~/Pictures/Screenshots/login-bug-2.png to note A-B32
/n show me the pictures in note A-B32
/n remove the second picture from note A-B32
```
````

#### Step 1i: The chat bar, `README.md:215-230`
Old: lines 215–220 (the first paragraph, `The pill at the bottom of the wall …` through `hidden.`). Replace it with the block below. Keep lines 222–227 (`Behind it is the Claude Agent SDK …`) unchanged.
New for lines 215–220:
```markdown
The pill at the bottom of the wall is a natural-language command line. Its answer streams into a
panel that rises above it, which you can pin or dismiss. A terse status line ("searching
notes", "looking at 2 photos", "reading expenses", "reading runs", "reading seer", "searching
the web") shows what the agent is doing. Notes the answer mentions are outlined on the wall and
the rest dim. Chips under the answer jump to each note, switching the view if that note is
hidden.

The bar takes several lines. Shift+Enter starts a new line and Enter sends, but not while an
input method is still composing. The bar grows upward one line at a time up to about six lines,
then scrolls inside, and drops back to one line after sending. Newlines reach the agent as you
typed them. The panel always sits above the bar, whatever its height.

The caret icon next to pin and dismiss collapses the panel to its header line. That line shows
the question on one line (newlines become spaces, a long question is cut with an ellipsis, and
the full text is in the tooltip). After the question comes the status while it is still
answering, or the brain that answered. A collapsed answer keeps streaming. Click the line to open
it again. Every new answer opens expanded, and the notes it used stay outlined on the wall while
it is collapsed. Dismiss still closes the panel for good and starts a new thread next time.
```
Then replace lines 229–230:
```
The recordings below are real runs against the demo instance. The time spent waiting for the
answer is sped up 1.8×.
```
with:
```markdown
The recordings below are real runs against the demo instance. The time spent waiting for the
answer is sped up 1.8×. They were made before the bar took several lines and before the panel
could collapse.
```

#### Step 1j: Install on WSL comment, `README.md:321`
Old:
```
npm run db:migrate                         # once, against the direct (unpooled) host
```
New:
```
npm run db:migrate                         # against the direct (unpooled) host; again after a pull that adds drizzle/*.sql
```

#### Step 1k: A second machine, `README.md:355-360`
Old: lines 355–360 (the paragraph `The text database is shared, …`).
New:
```markdown
The text database is shared, so a second laptop can run its own `notesd` against it. Clone the
repo there, copy the same `.env.local`, and run `scripts/install.sh` (no `db:migrate` and no
`embed:backfill`: the schema and the embeddings are already there). Notes, tags, revisions, the
recycle bin, search by meaning and the chat bar work the same. Photos do not move: a photo made
on one machine shows "not on this machine" on the other, by design, and its folder icon is
hidden there. The connectors need the three sibling repos (or `*_DIR` pointing at them) on that
machine too.
```

#### Step 1l: Configuration, after `README.md:404`
Insert one row after the `NOTES_DATA_DIR` row (line 404):
```markdown
| `NOTESD_EXPLORER_BIN` | `explorer.exe` on `PATH`, else `/mnt/c/Windows/explorer.exe` | The Windows Explorer binary "open file location" starts. The systemd unit's `PATH` has no `/mnt/c`, so the fallback is what normally runs. |
```

#### Step 1m: How it works diagram, `README.md:415-424`
Old: the fenced diagram (lines 415–424).
New (box widths checked: the `notesd` box is 31 columns and the Postgres box is 18, the same as before):
````markdown
```
 Claude Code (/n, any repo) ──MCP──┐
                                   │     ┌─────────────────────────────┐     ┌────────────────┐
 Browser http://localhost:7317 ────┼────▶│ notesd  (Hono, 127.0.0.1)   │────▶│ Postgres       │
   wall · gallery · modal · chat   │     │  /mcp  streamable HTTP      │     │ notes          │
   editor · recycle bin            │     │  /api  JSON, SSE, upload    │     │ note_images    │
                                   │     │  /     the web app          │     │ note_revisions │
 ~/mcp-notes-data/inbox ──watch────┘     │  one notes service + events │     └────────────────┘
                                         │  explorer.exe /select (WSL) │────▶ ~/mcp-notes-data
                                         └─────────────────────────────┘      images · cache
```
````

#### Step 1n: MCP tools, `README.md:432-450`
Old: lines 432–450 (the tool table, `The 15 connector tools are listed …`, and the instructions paragraph).
New:
```markdown
| Tool | What it does |
|---|---|
| `create` | New note from text, with optional origin `{cwd, repo, claude_session}` |
| `get` | One or several notes by id |
| `update` | Replace a note's body |
| `append` | Add text to the end of a note |
| `delete`, `restore` | Soft delete (to the recycle bin) and undo it |
| `list` | Filter by tags (any or all), created/updated date range, `has_image` (at least one photo), EXIF taken-date range (matches when any photo of the note matches). Newest first, paged |
| `search` | By meaning and by words: full text (Postgres `simple` config, so ids and code tokens still rank first) blended with vector similarity, tag match and recency, after the same filters. `mode: "text"` for exact words only |
| `related` | The notes nearest in meaning to a note `id`, each with a similarity score, never the note itself |
| `tags` | Every tag with its count and last use |
| `revisions`, `revert` | A note's earlier bodies, and putting one back |
| `create_image` | New photo note from a local file path, with optional text. The same file again returns the note that already holds it |
| `attach_image` | Add a local file to an existing note `id` as its next photo. Returns `{note, attached}`; `attached: false` when the file is already in a note, which is returned instead |
| `remove_image`, `restore_image` | Take one photo out of its note by photo id (soft, it goes to the recycle bin), and put it back at its old position |
| `view_images` | Previews of up to 8 photos as image content, each after a text block with its ids, "image k of n" and metadata. Takes note ids (every photo of the note, in order) or photo ids; past 8 it lists the photo ids still to view |

Every note in a result carries `images`: its photos in order, each with its own id, metadata,
URLs and `available` (false when the file lives on another machine). No tool deletes anything
for good: `delete` and `remove_image` are soft, and `restore` / `restore_image` undo them.
Delete forever exists only in the wall's recycle bin.

The 15 connector tools are listed under [Connectors](#connectors-spending-runs-seer).

The server also sends Claude short instructions: what mcp-notes is, how ids look, that
comparisons are Claude's job, and that the connectors are read-only and the curated tools come first.
```

#### Step 1o: HTTP API, `README.md:469-479`
Old: the route table (lines 469–479).
New:
```markdown
| Route | |
|---|---|
| `GET /health` | `{"ok":true}` |
| `GET /api/notes?has_image=&tag=&limit=&cursor=` | Live notes, newest first, each with its `images` |
| `GET/PATCH/DELETE /api/notes/:id`, `POST /api/notes` | One note. `DELETE` is soft (to the recycle bin) |
| `POST /api/notes/:id/restore` | Bring a deleted note back |
| `GET /api/tags` | Tags with counts, live notes only |
| `GET /api/events` | Server-sent events, `event: note` on every change |
| `POST /api/images` | Multipart upload (`file`, optional `body`), returns `{note, created}` |
| `POST /api/notes/:id/images` | Multipart `file`, attached to that live note: 201 `{note, attached: true}`, or 200 with the note that already holds the file |
| `GET /api/images/:imageId` | One photo's metadata and URLs, whatever its state |
| `GET /api/images/:imageId/original` · `/display` · `/thumb` · `/preview` | The photo in each form, photos in the bin included; 404 `not_on_this_machine` when the file lives elsewhere |
| `GET /api/notes/:id/original` · `/display` · `/thumb` · `/preview` | The same for a live note's first photo, kept for older links |
| `DELETE /api/images/:imageId` | Remove one photo from its note (soft), returns the note |
| `POST /api/images/:imageId/restore` | Put a removed photo back; 409 `duplicate_image` with the holder's `note_id` when the file is in another note now |
| `GET /api/bin?tag=` | The recycle bin, `{notes, images}`, newest deleted first |
| `DELETE /api/bin/notes/:id` · `DELETE /api/bin/images/:imageId` | Delete forever: rows and files. 409 `not_deleted` for anything not in the bin; 403 `forbidden_origin` unless the request comes from the wall's own page |
| `GET /api/capabilities` | `{"reveal": true}` when "open file location" can work on this machine |
| `POST /api/images/:imageId/reveal` | Open Explorer with the original selected; 202 as soon as `explorer.exe` has started. Same-origin requests only |
| `POST /api/chat` | Streams `status` and `delta` events, then `done` with the `thread_id` and the brain that answered |
| `/full/:imageId` | The full-screen photo page |
```

#### Step 1p: Where things are stored, `README.md:483-495`
Old: lines 483–495 (the fenced block and `` `cache/` can be deleted at any time. … ``).
New:
````markdown
```
Postgres   notes(id, body, tags[], origin, created_at, updated_at, deleted_at,
                 image_path, image_meta)        legacy: read only at start-up, dropped later
           note_images(id, note_id, path, sha256, mime, width, height, bytes, taken_at,
                       original_name, host, position, created_at, deleted_at)
           note_revisions(note_id, body, saved_at)
           note_embeddings(note_id, embedding vector(1536), body_sha256, model, attempts, next_attempt_at, …)
~/mcp-notes-data/
  images/YYYY/MM/<imageId>.<ext>   originals, byte for byte
  cache/<imageId>/thumb.webp       480 px wide, for the wall and gallery
  cache/<imageId>/preview.jpg      long edge 1568 px, what Claude sees
  cache/<imageId>/display.jpg      full resolution, only for HEIC/HEIF/TIFF
  inbox/                           drop files here; failures go to inbox/failed/
```

Each photo is one `note_images` row with its own id, in the same `A-B32` form as note ids. A
note's first photo takes the note's own id. That is how photos saved before iteration 7 kept
their file names, their `cache/` folders and their links when migration 0002 copied them in.
Photos added later get a fresh id. `position` is the order photos were added in. Removing a
photo sets its `deleted_at` and keeps its position. Dedupe is by `sha256` among photos that have
not been removed. The two `notes` image columns are the iteration 6 layout. New code never
writes them. At start-up `notesd` copies any photo an older daemon stored there into
`note_images` (it does nothing when there is nothing new), and a later migration drops them.

`cache/` can be deleted at any time. Everything in it is rebuilt on demand. Delete forever
removes a photo's original and its `cache/<imageId>/` folder, and nothing else.
````

#### Step 1q: Limitations, `README.md:499-518`
Insert these three bullets after the `- **Connectors are read-only.** …` bullet (line 509):
```markdown
- **Delete forever is final.** It removes the rows and the files, with no undo. Everything else
  (deleting a note, removing a photo) waits in the recycle bin until you restore it or delete it
  forever. Nothing is purged on a timer.
- **Open file location is for Windows.** It needs `notesd` under WSL with interop, and the
  original on this machine. Anywhere else the folder icon is not shown.
- **Photo order is the order you added them.** There is no drag to reorder, no cropping and no
  image editing, and notes stay plain text with no markdown rendering.
```

#### Step 1r: Roadmap and About the screenshots, `README.md:530` and `README.md:549-552`
Old line 530:
```
| 7 | A second machine (the GPD), weekly digest, … | later |
```
New (two rows):
```markdown
| 7 | Wall editing: big editor, several photos per note, recycle bin, open file location, collapsible answer, multi-line chat bar | done |
| 8 | A second machine (the GPD), weekly digest, … | later |
```
After line 552 (the end of the paragraph `The screenshots and recordings come from a throwaway instance …`), append one blank line and this paragraph:
```markdown
All of them were captured before iteration 7. The wall, gallery and modal in them show one photo
per note, with no photo count and no expand, delete or folder icons. The chat bar is one line and
the answer panel has no collapse icon. The text above describes the current behaviour, and the
captions say where a picture shows the older look. The big editor, the recycle bin and open file
location have no screenshots yet.
```

**Impact:** docs only. Keep every existing image reference: all sixteen files in `docs/readme/` stay linked, and no new GIF is added. `grep -o 'docs/readme/[a-z-]*\.[a-z]*' README.md | wc -l` must still print 16 (15 lines; the gallery table row holds two).

### Step 2: claude/skills/n/SKILL.md
**File:** `claude/skills/n/SKILL.md`

#### Step 2a: frontmatter description, `SKILL.md:3`
Replace line 3 with:
```yaml
description: The user's personal notes system, mcp-notes, reached through the `notes` MCP server, which also reads the user's own apps read-only — expense-tracking (spending in rupiah), run-insights (Apple Watch runs, the app's run analyses and weekly/monthly reviews, coach Nina) and Seer (trading lab, leaderboard, positions, Sera methods). Use whenever the user types "/n <request>" from any repo, and when they ask to save, find, read, edit, tag, delete, restore, compare or summarize their notes or look at, attach or remove pictures in them ("save this session's insights as a note", "what was my last #v250 note", "check note A-B32", "summarize #seer this week vs last week", "show me the pictures I saved on 30 oct", "show me the pictures in note A-B32", "attach this screenshot to note A-B32"), or ask about their spending, expenses, runs or Seer ("how is my spending this week", "how did yesterday's run go", "compare my running this month with last month", "what are the best Sera methods so far", "what's on the Seer leaderboard").
```

#### Step 2b: What a note is, `SKILL.md:25`
Replace line 25 (`- A note may carry an image (a local file on the machine that saved it). Results say so.`) with:
```markdown
- A note may hold several images (local files on the machine that saved them), in the order
  they were added. Every note in a result has an `images` list (empty for a text note). Each
  image has its own image id (the same `A-B32` form as note ids; a note's first image has the
  note's own id), a `position`, metadata (`mime`, size, `taken_at`, `original_name`, `host`) and
  `available`.
```

#### Step 2c: Tools, `SKILL.md:29-38`
Replace lines 29–38 with:
```markdown
The spine tools are `create`, `get` (one or several ids), `update` (full body replace),
`append`, `delete` (soft), `restore`, `list` (tag any/all filters, created/updated date range,
newest first, limit + cursor), `search` (ranked by meaning and by words, with tag and date
filters; `mode: "text"` for exact words only), `related` (the notes nearest in meaning to one
note id, with a similarity score), `tags` (every tag with count and last-used date),
`revisions` and `revert`. The image tools are `create_image` (a new note from a local file
path), `attach_image` (add a local file to an existing note), `remove_image` and
`restore_image` (take one image out of its note, softly, and put it back), `view_images` (see
the images of notes, or single images), and the `has_image` / taken-date filters on `list` and
`search`. Use them as described under Images. Always follow each tool's own schema and
description for parameter names and formats; they win over anything written here.
```

#### Step 2d: Images, `SKILL.md:158-168`
Replace lines 158–168 (from `## Images` through the `available`/host bullet) with:
```markdown
## Images

If one of these tools is missing, the installed `notesd` is older than this skill. Say so and
suggest re-running `scripts/install.sh` in `~/mcp-notes` instead of working around it.

- "Show me the pictures I saved on 30 oct" → `list` with `has_image: true` and that saved-date
  range (or `taken_from` / `taken_to` when the user means when the photo was taken), then
  `view_images` on those note ids so you actually see them. Comment on what you see, per note id.
- "Show me the pictures in note A-B32" → `view_images` with that note id. A note id stands for
  every image of the note, in order, and each image comes with "image k of n". At most 8 images
  come back per call. When there are more, the last text line lists the image ids not shown:
  call `view_images` again with those ids before you say anything about "all" of them.
- A screenshot or image path at hand ("save this screenshot") → `create_image` with the absolute
  path, a short body and hashtags. It makes a new note.
- "Attach this screenshot to note A-B32", "add ~/Pictures/x.png to A-B32" → `attach_image` with
  the note id and the absolute path (expand `~`), plus `origin`. `attached: false` means the
  file is already in a note, and the returned note is the one that holds it. That may be a
  different note, or one that was deleted and is now restored. Say which note, and do not
  attach the file again.
- "Remove the second picture from A-B32" → `get` the note, pick the image from its `images`
  list by position, and call `remove_image` with that image's id (not the note id). Removal is
  soft: the image goes to the recycle bin on the wall, and `restore_image` with the same image
  id puts it back at its old place. Reply with the note id and the image id.
- An image whose file is not on this machine (`available: false`) still has its note and
  metadata. Say the file lives on the machine that saved it (`host`) instead of treating it as
  an error.
```

#### Step 2e: Deleting, `SKILL.md:170-173`
Replace lines 170–173 with:
```markdown
## Deleting

Delete only when the user asks, and only the notes or images they named. `delete` (a note) and
`remove_image` (one image) are soft. Both land in the recycle bin on the wall ("Deleted." at
http://localhost:7317). Reply with the ids and say `restore` / `restore_image` brings them back.

You cannot delete anything for good, and must not try another way (files, SQL, the HTTP API).
If the user asks to delete permanently, empty the bin or free disk space, tell them that
"delete forever" is in the wall's recycle bin, behind an inline confirm, and only there.
```
**Impact:** the skill is symlinked into `~/.claude/skills/n` from whichever checkout last ran `install.sh`, which is `~/mcp-notes`, i.e. main. The new text reaches sessions only after the set lands and the owner re-runs `install.sh`. Nothing here changes the live skill.

### Step 3: docs/INSTALL.md
**File:** `docs/INSTALL.md`

#### Step 3a: new section 7, inserted before `## Uninstall` (`INSTALL.md:266`)
Insert this block, followed by one blank line, directly above line 266:
````markdown
## 7. Several images per note (iteration 7)

Iteration 7 moves photos from two columns on `notes` (`image_path`, `image_meta`) into their own
table, `note_images`, with one row per photo, so a note can hold several. Migration
`drizzle/0002_note_images.sql` creates the table and copies every existing photo into it, from
live and deleted notes alike. Each copied row takes its note's id, so files, `cache/` folders and
links stay as they are. The migration only adds. The old columns and their indexes stay (a later
migration drops them), and nothing on disk moves.

Once per database (the second machine skips the migrate, because the schema is shared):

```sh
cd ~/mcp-notes
git pull
npm run db:migrate          # applies drizzle/0002_note_images.sql: note_images, its indexes, the copy
scripts/install.sh          # rebuild and restart notesd on the new code
```

The migration is safe to run while the old `notesd` is still up. That daemon never reads the new
table and keeps working. A photo it takes in between the migrate and the restart lands only in
the old columns. To cover that, the new `notesd` copies any such photo into `note_images` every
time it starts. It runs the same statement as the migration, which is idempotent and does
nothing when there is nothing to copy. The same happens on the second machine when its `notesd`
first starts on the new code. Until then, photos that machine takes in reach `note_images` at the
next start of a new-code `notesd` on either machine, so run `scripts/install.sh` on both soon
after the pull.

### Open file location

The folder icon on photos asks `notesd` to run `explorer.exe /select,<windows path>`, with the
path converted by `wslpath -w`. The icon is offered only when all of these hold:

- `notesd` runs under WSL with interop, meaning `/proc/sys/fs/binfmt_misc/WSLInterop` (or
  `WSLInterop-late`) exists;
- `wslpath` is found;
- Explorer is found: `NOTESD_EXPLORER_BIN` if set, else `explorer.exe` on `PATH`, else
  `/mnt/c/Windows/explorer.exe`.

The unit's `PATH` has no `/mnt/c`, so the last one is what normally runs, and the unit file
needs no change. To point it elsewhere, add a drop-in, which survives `install.sh`:

```sh
systemctl --user edit notesd        # add:  [Service]
                                    #       Environment=NOTESD_EXPLORER_BIN=/mnt/c/Windows/explorer.exe
systemctl --user restart notesd
```

Check it:

```sh
curl -s http://127.0.0.1:7317/api/capabilities    # {"reveal":true}
```

`{"reveal":false}` hides the icon. The daemon works the answer out once per start, so restart
`notesd` after fixing interop. `notesd` judges success by the spawn alone (Explorer exits with 1
even when it worked) and never waits for Explorer.

### Recycle bin

Deleting a note or removing a photo is soft, from the wall and from Claude alike. "Delete
forever" exists only in the wall's recycle bin. It deletes the rows, then removes the original
and its `cache/<imageId>/` folder from `~/mcp-notes-data`. Its endpoints accept only requests
from the wall's own page (the same `Origin` on a loopback host), so a plain `curl` gets 403
`forbidden_origin`. No MCP tool can delete for good, and nothing is purged automatically.
````

#### Step 3b: Troubleshooting, after `INSTALL.md:290` (the end of the file)
Append these two bullets to the Troubleshooting list:
```markdown
- No folder icon on photos: `curl -s http://127.0.0.1:7317/api/capabilities`. `{"reveal":false}`
  means interop, `wslpath` or Explorer was not found when the daemon started (see "Open file
  location" in section 7). On a machine that does not hold the original, the icon is hidden by
  design.
- A photo saved just before the restart onto the new code shows as a text note: restart
  `notesd` once more (`systemctl --user restart notesd`). The start-up copy picks the photo up.
```
**Impact:** docs only.

### Step 4: Commit the docs
**File:** the three docs only.
```sh
cd /home/miftah/.worktrees/mcp-notes/wall-editing
git diff --name-only            # exactly: README.md, claude/skills/n/SKILL.md, docs/INSTALL.md
git add README.md claude/skills/n/SKILL.md docs/INSTALL.md
git commit -m "docs(wall-editing): README, /n skill and INSTALL for iteration 7

Photos per note, big editor, recycle bin, open file location, collapsible
answer panel, multi-line chat bar; new routes and MCP tools; note_images
storage; migration 0002 and the start-up reconcile in INSTALL. Existing
screenshots kept and marked where they show the one-image look.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Step 5: Full verification of the merged tree
**File:** none. Do **not** create `.env.local` before this step. The suites must not see it, and `tests/integration/setup.ts` refuses a Neon URL anyway.
```sh
cd /home/miftah/.worktrees/mcp-notes/wall-editing
npm run typecheck
npm test
npm run test:int
npm run build
```
Expected: all four exit 0. `test:int` must list the new integration files: `migration0002.int.test.ts`, `imageRepo.int.test.ts` and `bin.int.test.ts` (phases 1, 4), plus `reveal.int.test.ts` (phase 5). `npm test` must include the new component tests: `NoteEditor`, `Bin`, `UndoBar`, `RevealButton` and `ChatBar` (phases 7, 8, 9, 11).

**On a failure:** do not edit source and do not continue to Step 6. Find the owning phase from `git log --format='%h %s' -- <failing file>` and the plan index "Owns" lines. Report the failing test name, the error and the owning phase to the coordinator. The fix lands as a separate commit whose subject names that phase, for example `fix(wall-editing phase 6): …`. Then re-run this whole step.

### Step 6: Link `.env.local` (invariant 8)
```sh
cd /home/miftah/.worktrees/mcp-notes/wall-editing
ln -sf /home/miftah/mcp-notes/.env.local .env.local
git status --short              # prints nothing: .env.local is gitignored
```

### Step 7: Before-check on Neon (read-only)
Run it from the worktree root, so `pg` and `dotenv` resolve from `node_modules`. It prints counts only, never a URL or a secret.
```sh
cd /home/miftah/.worktrees/mcp-notes/wall-editing
node --input-type=module <<'EOF'
import pg from 'pg';
import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

config({ path: '.env.local', quiet: true });
const url = [process.env.DATABASE_URL_UNPOOLED, process.env.DATABASE_URL]
  .map((u) => u?.trim())
  .find((u) => u && !new URL(u).host.includes('-pooler'));
if (!url) throw new Error('no direct (unpooled) Postgres URL in .env.local');
const dataDir = process.env.NOTES_DATA_DIR || join(homedir(), 'mcp-notes-data');

const c = new pg.Client({ connectionString: url });
await c.connect();
const q = async (s) => (await c.query(s)).rows;

const table = (await q("select to_regclass('public.note_images')::text as t"))[0].t;
const migrations = (await q('select count(*)::int as n from drizzle.__drizzle_migrations'))[0].n;
const [legacy] = await q(`
  select count(*)::int                                                         as image_path_not_null,
         count(*) filter (where image_meta is not null)::int                   as with_meta,
         count(*) filter (where image_meta is null)::int                       as path_without_meta,
         count(*) filter (where image_meta is not null and deleted_at is null)::int     as live,
         count(*) filter (where image_meta is not null and deleted_at is not null)::int as deleted,
         count(distinct image_meta->>'sha256')::int                            as distinct_sha
    from notes
   where image_path is not null`);
const paths = await q('select image_path as p from notes where image_path is not null');
const filesPresent = paths.filter((r) => existsSync(join(dataDir, r.p))).length;

console.log(JSON.stringify({
  table,
  migrations,
  ...legacy,
  extra_same_sha: legacy.with_meta - legacy.distinct_sha,
  files_present: filesPresent,
}, null, 2));
await c.end();
EOF
```
**Expected:** `table: null`, `migrations: 2`, `path_without_meta: 0`, and `live + deleted = with_meta = image_path_not_null`. `extra_same_sha` is the number of legacy rows that will be copied with `deleted_at` set: deleted notes whose photo is also in another note. It is often 0. Record the whole printed object in the phase report.

- `migrations` is not 2, or `table` is not null: stop. The database is not in the state this phase expects. Report it and do not migrate.
- `path_without_meta` is above 0: the contract's reconcile skips those rows, so Step 9's count check would differ from the exit-criteria query. Stop and report it to phase 1's owner before migrating.

### Step 8: Apply migration 0002 to Neon
Run this only after Steps 5 and 7 pass. `drizzle.config.ts` picks the direct (non-`-pooler`) host by itself. Do not run `scripts/install.sh` or `systemctl --user restart notesd`. The installed daemon stays on main's code.
```sh
cd /home/miftah/.worktrees/mcp-notes/wall-editing
export MIGRATE_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)   # Step 9 reads it; record it in the phase report
npm run db:migrate
```
**Expected output:**
```
> mcp-notes@0.1.0 db:migrate
> drizzle-kit migrate

Reading config file '/home/miftah/.worktrees/mcp-notes/wall-editing/drizzle.config.ts'
Using 'pg' driver for database querying
[✓] migrations applied successfully!
```
drizzle-kit applies pending migrations in one transaction. If it fails, nothing is applied: Step 9 shows `table: null` and `migrations: 2`. Report the error to phase 1's owner, and do not retry by hand-editing SQL.

### Step 9: After-check on Neon (read-only, self-asserting)
```sh
cd /home/miftah/.worktrees/mcp-notes/wall-editing
node --input-type=module <<'EOF'
import pg from 'pg';
import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

config({ path: '.env.local', quiet: true });
const url = [process.env.DATABASE_URL_UNPOOLED, process.env.DATABASE_URL]
  .map((u) => u?.trim())
  .find((u) => u && !new URL(u).host.includes('-pooler'));
if (!url) throw new Error('no direct (unpooled) Postgres URL in .env.local');
const dataDir = process.env.NOTES_DATA_DIR || join(homedir(), 'mcp-notes-data');

const c = new pg.Client({ connectionString: url });
await c.connect();
const q = async (s) => (await c.query(s)).rows;
const one = async (s) => (await q(s))[0];

const table = (await one("select to_regclass('public.note_images')::text as t")).t;
const migrations = (await one('select count(*)::int as n from drizzle.__drizzle_migrations')).n;
const indexes = (await q("select indexname from pg_indexes where tablename = 'note_images' order by 1"))
  .map((r) => r.indexname);
const fks = (await q(`select confdeltype from pg_constraint
                       where conrelid = 'public.note_images'::regclass and contype = 'f'`))
  .map((r) => r.confdeltype);
const legacyIndexes = (await q(`select indexname from pg_indexes
                                 where tablename = 'notes'
                                   and indexname in ('notes_image_sha256_live_uniq', 'notes_image_taken_at_idx')
                                 order by 1`)).map((r) => r.indexname);

const legacy = await one(`
  select count(*)::int                               as image_path_not_null,
         count(*) filter (where image_meta is not null)::int as with_meta,
         count(distinct image_meta->>'sha256')::int  as distinct_sha
    from notes where image_path is not null`);
const imageRows = (await one('select count(*)::int as n from note_images')).n;

const missing = await q(`
  select n.id, n.created_at
    from notes n
   where n.image_path is not null and n.image_meta is not null
     and not exists (select 1 from note_images i where i.id = n.id)
   order by n.created_at`);

const notLegacy = (await one(`
  select count(*)::int as n
    from note_images i
   where not exists (select 1 from notes n
                      where n.id = i.id and n.image_path is not null and n.image_meta is not null)`)).n;

const mismatched = (await one(`
  select count(*)::int as n
    from notes n join note_images i on i.id = n.id
   where n.image_path is not null and n.image_meta is not null
     and (   i.note_id       is distinct from n.id
          or i.path          is distinct from n.image_path
          or i.sha256        is distinct from n.image_meta->>'sha256'
          or i.mime          is distinct from n.image_meta->>'mime'
          or i.width         is distinct from (n.image_meta->>'width')::int
          or i.height        is distinct from (n.image_meta->>'height')::int
          or i.bytes         is distinct from (n.image_meta->>'bytes')::int
          or i.taken_at      is distinct from (n.image_meta->>'taken_at')::timestamptz
          or i.original_name is distinct from n.image_meta->>'original_name'
          or i.host          is distinct from n.image_meta->>'host'
          or i.position      is distinct from 0
          or i.created_at    is distinct from n.created_at)`)).n;

const split = await q(`
  select (n.deleted_at is not null) as note_deleted,
         count(*) filter (where i.deleted_at is null)::int     as image_live,
         count(*) filter (where i.deleted_at is not null)::int as image_removed
    from note_images i join notes n on n.id = i.note_id
   group by 1 order by 1`);
const removedOff = (await one(`
  select count(*)::int as n
    from note_images i join notes n on n.id = i.note_id
   where i.deleted_at is not null
     and (n.deleted_at is null or i.deleted_at <> n.deleted_at)`)).n;

const paths = await q('select image_path as p from notes where image_path is not null');
const filesPresent = paths.filter((r) => existsSync(join(dataDir, r.p))).length;

const extra = legacy.with_meta - legacy.distinct_sha;
const removedTotal = split.reduce((s, r) => s + r.image_removed, 0);
const liveNotesRemoved = split.filter((r) => !r.note_deleted).reduce((s, r) => s + r.image_removed, 0);
const wantIndexes = [
  'note_images_note_position_idx',
  'note_images_path_uniq',
  'note_images_pkey',
  'note_images_sha256_live_uniq',
  'note_images_taken_at_idx',
];

const failures = [];
if (table !== 'note_images') failures.push(`table is ${table}`);
if (migrations !== 3) failures.push(`drizzle migrations = ${migrations}, want 3`);
if (JSON.stringify(indexes) !== JSON.stringify(wantIndexes)) failures.push(`indexes ${JSON.stringify(indexes)}`);
if (JSON.stringify(fks) !== JSON.stringify(['c'])) failures.push(`foreign keys ${JSON.stringify(fks)}, want one ON DELETE CASCADE`);
if (legacyIndexes.length !== 2) failures.push(`legacy notes indexes ${JSON.stringify(legacyIndexes)}, want both kept`);
// MIGRATE_START is written by Step 8 just before `db:migrate` (drizzle's own created_at is the
// migration's generation time, not when it ran). Unset: every missing row counts as a defect.
const migrateStart = process.env.MIGRATE_START ? new Date(process.env.MIGRATE_START) : null;
const earlyMissing = missing.filter((m) => migrateStart === null || new Date(m.created_at) < migrateStart);
if (earlyMissing.length) failures.push(`${earlyMissing.length} legacy notes created before the migration without a note_images row (phase 1 defect)`);
if (notLegacy) failures.push(`${notLegacy} note_images rows that are not a legacy copy`);
if (mismatched) failures.push(`${mismatched} rows whose metadata differs from notes.image_meta`);
// Late ingests by the old daemon (listed in `missing`) have no row until the start-up reconcile; they
// are new sha256 values (the old daemon dedupes by sha), so they do not change `extra`.
if (imageRows !== legacy.with_meta - missing.length) failures.push(`note_images ${imageRows} != legacy ${legacy.with_meta} - missing ${missing.length}`);
if (imageRows !== legacy.image_path_not_null - missing.length) failures.push(`note_images ${imageRows} != notes with image_path ${legacy.image_path_not_null} - missing ${missing.length}`);
if (liveNotesRemoved) failures.push(`${liveNotesRemoved} images of live notes copied as removed`);
if (removedTotal !== extra) failures.push(`removed images ${removedTotal} != same-sha extras ${extra}`);
if (removedOff) failures.push(`${removedOff} removed images whose deleted_at is not their note's deleted_at`);

console.log(JSON.stringify({
  table, migrations, indexes, fks, legacyIndexes,
  legacy, extra_same_sha: extra, note_images: imageRows,
  missing, not_legacy: notLegacy, mismatched, split, removed_off: removedOff,
  files_present: filesPresent,
}, null, 2));
console.log(failures.length ? `FAIL\n- ${failures.join('\n- ')}` : 'OK');
process.exitCode = failures.length ? 1 : 0;
await c.end();
EOF
```
**Expected:** the last line is `OK`, with exit code 0, and:
- `migrations: 3`, `table: "note_images"`, and the five indexes listed above.
- `fks: ["c"]`, and both legacy `notes` indexes kept. Invariant 4: nothing was altered or dropped.
- `note_images` equals `legacy.with_meta`, which equals `legacy.image_path_not_null`. That is the exit-criteria count.
- `missing: []`, `not_legacy: 0`, `mismatched: 0`. Every legacy note has exactly one row, with `id = note id` and identical metadata.
- The `split` lines up with Step 7. For `note_deleted: false`, expect `image_live = live` from Step 7 and `image_removed = 0`. For `note_deleted: true`, expect `image_live = deleted - extra_same_sha` and `image_removed = extra_same_sha`. `removed_off: 0`.
- `files_present` is the same number as in Step 7. The migration touches no file.

**If `missing` is non-empty:** the installed (old) daemon took in a photo after the migration committed, and each listed note's `created_at` is later than `MIGRATE_START` (Step 8; run Step 9 in the same shell, or `export MIGRATE_START=<recorded value>` first). That is expected, not a defect, and the script still prints `OK` (the count checks subtract `missing`). Phase 2's start-up `reconcileLegacyImages` copies them when the owner restarts onto the new code. Any `missing` id created **before** the migration is a phase 1 defect and is a `FAIL` line. Report it, and do not hand-insert rows.

**Any other `FAIL` line:** report the full output to phase 1's owner, who owns the copy statement. Rollback is in the Rollback section.

Then re-run `npm run db:migrate` once. It prints the same success line and changes nothing. Re-run Step 9: `migrations` is still 3 and the result is `OK`.

### Step 10: Leave the daemon alone
```sh
systemctl --user show notesd -p ActiveEnterTimestamp     # unchanged from before Step 8
systemctl --user cat notesd | grep ExecStart             # still points at ~/mcp-notes (main), not this worktree
```
Do not run `scripts/install.sh`, `systemctl --user restart notesd` or `npm start` on port 7317. The owner runs `cd ~/mcp-notes && git pull && scripts/install.sh` after the set lands (INSTALL §3 and §7).

## Verification

**Build:** `npm run typecheck && npm run build`
**Tests:** `npm test` and `npm run test:int`
**Manual check:**
- `git show --stat HEAD` for this phase's commit lists exactly `README.md`, `claude/skills/n/SKILL.md` and `docs/INSTALL.md`.
- `grep -o 'docs/readme/[a-z-]*\.[a-z]*' README.md | wc -l` prints `16`, so every existing screenshot reference is kept.
- `grep -n 'image_path' README.md` shows only the storage block and its legacy paragraph.
- `grep -n 'attach_image\|remove_image\|restore_image' README.md claude/skills/n/SKILL.md` hits both files. `grep -n 'delete forever' claude/skills/n/SKILL.md` shows that Claude cannot do it.
- `grep -n '0002' docs/INSTALL.md` shows the migrate step.
- Every `#anchor` in the Contents resolves: `the-big-editor`, `deleting-and-the-recycle-bin` and `open-file-location` exist as `###` headings.
- Steps 7 and 9 outputs are recorded in the phase report, and Step 9 ends in `OK`.
- The installed daemon's `ActiveEnterTimestamp` is unchanged.

**Exit criteria:**
- Typecheck, `npm test`, `test:int` and `build` are green on the merged tree.
- Neon has `note_images` with one row per legacy image: `select count(*) from note_images` equals `select count(*) from notes where image_path is not null`, every row has `id = note_id = notes.id` and identical metadata, and `drizzle.__drizzle_migrations` has 3 rows.
- README, `/n` skill and INSTALL describe iteration 7.
- The installed daemon has not been restarted.

## Handoffs

- **Phase 1 (reconciled):** Step 9 matches phase 1's `LEGACY_COPY_SQL` exactly. Per sha256 the candidates are ranked live note first, then `deleted_at desc`, then id; rank 1 gets `deleted_at = null` (Neon's `note_images` starts empty, so no live row pre-exists), every other rank gets `coalesce(notes.deleted_at, now())`. The legacy partial index allows at most one live note per sha, and it ranks first, so every rank > 1 is a deleted note and takes that note's `deleted_at` (never `now()`). Hence `removed = with_meta - distinct_sha`, `removed_off = 0` and no live note's image is removed. A Step 9 `FAIL` on Neon is fixed by a phase-1 follow-up commit on a fresh Docker check first, never by editing Neon by hand.
- **Phase 2 (reconciled):** INSTALL §7, the README storage paragraph and Troubleshooting say that `notesd` runs the reconcile **at every start** and that it is idempotent. Phase 2 logs `[notesd] legacy images reconciled into note_images: <n>` on every start (and `[notesd] legacy image reconcile failed: …` on error, without blocking the daemon). Quoting the first line in INSTALL's §7 is optional; the text above stays correct either way.
- **Phase 2/3 (`src/mcp/instructions.ts`):** the server instructions (`:16,30`) still describe `image` today. Phases 2 and 3 own updating them to `images[]`, `attach_image`, `remove_image`/`restore_image` and `view_images` taking image ids. This phase only checks, in Step 0, that the three tools are registered.
- **Phase 5 (reconciled):** phase 5 reads `NOTESD_EXPLORER_BIN` straight from `process.env` in `nodeProbe` (no `src/config.ts` key), so INSTALL's systemd drop-in (`Environment=`) is the documented way and needs no `.env.local` sentence.
- **Phases 7–9 (reconciled):** the README quotes the reconciled UI: the undo text `deleted A-B32` / `removed image` for 6 s above the right end of the chat bar, the `Paperclip` overlay, the `Check`/`X` confirm, "Show in Explorer" on wall photo cards, the modal and the editor strip (not gallery tiles), and the expand icon at the right end of the card's id line next to the trash icon.
- **Phase 11:** the README chat-bar paragraph (Step 1i) follows the Contract's R6/R7 bullets. Same rule as above.
- **docs/ROADMAP.md:** not touched. Its iteration table already lists 7 "Wall editing". The README Roadmap row is aligned to it (Step 1r).
- **After landing (owner, not this phase):** `cd ~/mcp-notes && git pull && scripts/install.sh` on this laptop, then `scripts/install.sh` on the second machine. That restarts both daemons onto the new code and runs the start-up reconcile.
- **New screenshots/GIFs** of the editor, the bin, the multi-line bar and the collapsed panel are out of scope for this set (text only, per the phase scope). They would make a later docs task.

## Rollback

- **Docs:** `git revert <phase-10 commit>`. It touches only `README.md`, `claude/skills/n/SKILL.md` and `docs/INSTALL.md`.
- **Neon:** on the direct host, run `drop table note_images;`. The legacy columns were never altered, so main's code works unchanged. To let a later `db:migrate` re-apply 0002, also run `delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations);`. Until any new-code daemon runs, no photo exists only in `note_images`, because the installed daemon still writes the old columns. After a new-code daemon has run, dropping the table loses attachments made since then (their files stay on disk).
- **`.env.local`:** it is an untracked, gitignored symlink. `rm .env.local` removes it.
