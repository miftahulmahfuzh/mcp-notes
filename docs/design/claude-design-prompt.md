# Claude Design prompt

Attach 3–6 references from ONE direction before sending (mixing directions averages into generic).
Candidate directions: darkroom / contact sheet (photo-first, near-black, mono captions),
terminal-brutalist, dense Swiss with visible grid lines.

---

```
Design the main screen of a personal, single-user, desktop-first notes app. It is NOT a product
for other people. Ignore usability conventions where they conflict with the rules below.

ANCHOR: match the visual language of the attached references (screenshots/gifs/video). They
decide palette, type, density and motion. Where the references and this prompt disagree, the
references win on look and this prompt wins on layout and behavior.

HARD BANS (these make a design look AI-generated):
- No cream/beige/off-white backgrounds, no terracotta/orange accent, no purple-blue gradients
- No Inter, no system-ui default stack, no serif-headline + sans-body "editorial" combo
- No Lucide icons, no shadcn look, no soft rounded cards with diffuse drop shadows
- No emoji, no illustrations, no empty-state mascots, no marketing copy
- No text on any button. Every control is an icon only (Phosphor, duotone weight), with a tooltip

LAYOUT:
1. Main area: a dense masonry wall of notes, like Google Keep but tighter. Each note is ONE text
   field. No title. #hashtags inside the text are rendered as inline chips. Image notes show the
   image (keep its aspect ratio, never crop to a square) with their text below.
2. Every note shows its short ID (format like A-B32) in a small monospace label, with a copy-id
   icon next to it. Clicking copies the ID to the clipboard with a brief, quiet confirmation.
   The ID is how the owner refers to notes when talking to the AI, so it must be easy to find.
3. Left sidebar, collapsed by default to a thin icon rail. Expanded it shows: one icon toggle
   "image notes only", then the list of all tags with counts. Clicking a tag filters the wall.
   Active filters stay visible in the rail when collapsed.
4. NO search bar anywhere.
5. Bottom: one long, full-width, single-line chat input pinned to the bottom edge. It is a
   natural-language command line to an AI agent ("summarize my #seer notes this week, compare
   to last week"). Its answer streams into a panel that rises above the bar, overlays the wall,
   and can be dismissed or pinned. Notes the answer used are highlighted on the wall.
6. Image viewer: clicking an image opens a full-screen viewer with fit / 1:1 pixel toggle,
   pan, zoom, previous/next, and an info overlay (dimensions, file size, date taken).
   Images are full original resolution; the viewer must feel like a photo tool, not a modal.
7. Creating notes: one icon adds a text note in place; drag-and-drop or paste of an image
   anywhere on the wall creates an image note.

Show these states: the default wall; sidebar expanded with a tag filter active; the chat answer
panel open with streamed text and highlighted notes; the image viewer at 1:1.
Dark mode is the primary mode.
```
