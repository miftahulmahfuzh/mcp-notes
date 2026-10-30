# Claude Design prompt

Attach the anchor image (dark film-photo landing page: "The way kids see it.") before sending.

---

```
Design the main screen of a personal, single-user, desktop-first notes app. It is NOT a product
for other people. Ignore usability conventions where they conflict with the rules below.

ANCHOR: the attached image. Take from it:
- A near-black canvas (#111-ish), not pure black, with warm off-white text. Dark is the only mode.
- Warm, grainy, film-photo color: photos carry all the color; the UI itself has almost none.
- Huge, tight neo-grotesk display type next to very small body and caption text. The contrast
  in size is the whole typographic idea. Tiny captions with underlined inline links.
- Photos of varied sizes floating on black with lots of negative space, edge to edge, no frames,
  no borders, no rounded corners, no shadows.
- The pill-shaped input with a round arrow button at its end: use that shape for the chat bar.
- Hairline dividers only. One playful sticker-like object overlapping an edge is allowed.
Do NOT copy its text navigation: in this app every control is an icon.

HARD BANS (these make a design look AI-generated):
- No cream/beige backgrounds, no terracotta/orange accent, no purple-blue gradients
- No Inter, no system-ui default stack, no serif-headline + sans-body "editorial" combo
- No Lucide icons, no shadcn look, no soft rounded cards with diffuse drop shadows
- No emoji, no illustrations, no empty-state mascots, no marketing copy
- No text on any button. Every control is an icon only (Phosphor, duotone weight), with a tooltip

LAYOUT:
1. Main area: a dense, cluttered wall of notes, like Google Keep but on the anchor's black canvas.
   Each note is ONE text field. No title. #hashtags inside the text render as small inline chips.
   Image notes on this wall show the image (original aspect ratio, never cropped) with their text
   below. Varied note sizes are welcome; it should feel like a collage, not a spreadsheet.
2. Every note shows its short ID (format like A-B32) in a small monospace label, with a copy-id
   icon next to it. Clicking copies the ID to the clipboard with a brief, quiet confirmation.
   The ID is how the owner refers to notes when talking to the AI, so it must be easy to find.
3. Left sidebar, collapsed by default to a thin icon rail. Expanded it shows: one icon toggle
   "show image notes", then the list of all tags with counts. Clicking a tag filters the wall.
   Active filters stay visible in the rail when collapsed.
4. NO search bar anywhere.
5. Bottom: one long, full-width chat bar pinned to the bottom edge, in the anchor's pill shape
   with a round arrow-icon send button. It is a natural-language command line to an AI agent
   ("summarize my #seer notes this week, compare to last week"). Its answer streams into a panel
   that rises above the bar, overlays the wall, and can be dismissed or pinned. Notes the answer
   used are highlighted on the wall.
6. Creating notes: one icon adds a text note in place; drag-and-drop or paste of an image
   anywhere on the wall creates an image note.

IMAGE NOTES MODE (when "show image notes" is on in the sidebar):
7. The wall turns into a clean photo gallery grid: photos only, no text, no tags, no IDs, no
   captions. Tight even gutters, photos keep their aspect ratio. It should look like a contact
   sheet of the owner's photos and nothing else.
8. Clicking a photo opens a modal over the gallery: the picture shown much bigger, and beside or
   below it the note's description text, its tags as chips, and its ID with the copy-id icon.
   Modal controls, icons only: close, previous, next, copy ID, and "show full screen".
9. "Show full screen" opens a NEW BROWSER TAB containing only that image, full screen, on black,
   at original resolution: fitted to the window by default, click to toggle 1:1 pixels, drag to
   pan. No other UI in that tab. Images are never compressed; this tab is where the original
   is seen.

Show these screens/states:
- the default notes wall
- sidebar expanded with a tag filter active
- the chat answer panel open with streamed text and highlighted notes
- image notes mode: the clean photo gallery grid
- the photo modal open with description, tags and ID
- the full-screen image tab
```
