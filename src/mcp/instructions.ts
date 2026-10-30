/** Local IANA timezone of the daemon, e.g. Asia/Jakarta. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * MCP server instructions: Claude reads these once per session. Phase 5 appends one paragraph
 * about image notes to `sections`.
 */
export function buildInstructions(timeZone: string = localTimeZone()): string {
  const sections = [
    `mcp-notes is the user's personal note store: plain-text notes kept in Postgres and shared by every Claude Code session on this machine (and the user's other laptop, which uses the same database). Use these tools whenever the user asks to save, find, read, change, summarise or compare their notes, usually through the /n skill.`,

    `Notes. A note is a single plain-text body: no title, no fields, no other structure. Put everything in the body. Tags are the #hashtags written in the body (#seer, #v250, #from_phone); the server re-parses them from the body on every write and lower-cases them. To tag a note, write the hashtag into its body (update or append); to untag it, remove the hashtag from the body. Tag filters accept "seer" or "#seer". Every note returned has id, body, tags, created_at and updated_at (ISO 8601, UTC), origin (where it was saved from: cwd, repo, claude_session; may be null) and image (null for text notes).`,

    `Ids. Ids look like A-B32: one character from 0-9/A-Z, a dash, three characters from 0-9/A-Z. The server generates them; never invent one. Lookup is case-insensitive and tolerates a missing dash, so "ab32", "a-b32" and "AB32" all find A-B32. When you mention a note to the user, quote its id in the canonical A-B32 form.`,

    `Writing. create needs a non-empty body; when saving from a repository pass origin {cwd, repo, claude_session} so the note remembers where it came from. update replaces the whole body (read the note first with get, then send the full new text); append adds text at the end after a blank line. Every body change keeps the previous body as a revision: revisions(id) lists them and revert(id, revision) brings one back, keeping the body it replaces as a new revision. delete is soft: the note leaves list, search and tags but restore(id) brings it back; list with deleted="only" finds deleted notes.`,

    `Reading. get takes one or several ids. list returns notes newest first, filtered by tags (tags_any: at least one; tags_all: every one) and a date range (from/to, on the created or updated date), with paging via limit and next_cursor. search adds full-text matching on the body with the "simple" configuration: exact words and code tokens, no stemming; it understands "quoted phrases", OR and -exclusions, and ranks by relevance, then recency. tags lists every tag with its note count and the time it was last used.`,

    `Dates. from and to accept YYYY-MM-DD or a full ISO 8601 datetime. A YYYY-MM-DD value means the whole day in the daemon's local timezone, ${timeZone}: from starts at that day's midnight and to includes the whole day. Datetimes are exact.`,

    `Comparisons and summaries ("this week vs last week", "#seer vs #v250", "what was my last note about X") are your job, not the server's: call list or search once per side with the right filters, page with next_cursor if needed, then compare or summarise the results yourself.`,

    `Images. Some notes are image notes: a photo or screenshot saved on the laptop that stored it. Every note returned by get/list/search has an image field: null for text notes, otherwise {mime, width, height, bytes, taken_at, original_name, host, available}. To look at pictures, find the ids first, then call view_images with up to 8 ids; it returns each picture plus its metadata. "Show me pictures I saved on 30 oct" means list with has_image: true and from/to for that day, then view_images on the ids. "Photos taken last week" uses taken_from/taken_to (the camera's EXIF date) instead. To save a local image file (for example a screenshot path you have), call create_image with its absolute path and optional body text; the file is copied, not moved, and saving the same file again returns the existing note. available: false means the file lives on another machine (host): the note's text is still there, but its picture cannot be viewed here.`,
  ];
  return sections.join('\n\n');
}
