import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  attachFromPath,
  ImageInputError,
  ingestFromPath,
  resolveImageFile,
  toolAttachDeps,
  toolImageDeps,
  type ResolveResult,
} from '../http/imageAccess.js';
import type { ImageDeps } from '../images/ingest.js';
import { normalizeId } from '../notes/ids.js';
import type { Note, NoteImage } from '../notes/types.js';
import { errorResult, run, type ToolDeps } from './tools.js';

/** Most ids per call, and most images returned per call. */
export const VIEW_IMAGES_MAX = 8;

type Content = CallToolResult['content'][number];

/** One image to show: its note, the image, and its 1-based place among the note's live images. */
type ViewItem = { note: Note; image: NoteImage; k: number; n: number };

const originShape = z
  .object({
    cwd: z.string().optional().describe('Working directory the note was saved from.'),
    repo: z.string().optional().describe('Repository name or remote.'),
    claude_session: z.string().optional().describe('Claude Code session id.'),
  })
  .optional()
  .describe('Where this note came from. Pass the current cwd/repo when saving from a repo.');

function text(t: string): Content {
  return { type: 'text', text: t };
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function tagLine(note: Note): string {
  return `tags: ${note.tags.length > 0 ? note.tags.map((t) => `#${t}`).join(' ') : 'none'}`;
}

function bodyLine(note: Note): string {
  return `body: ${note.body.trim() === '' ? '(empty)' : note.body}`;
}

/** The metadata block for a note without an image. */
export function describeNote(note: Note): string {
  return [`id: ${note.id}`, `saved: ${note.created_at}`, tagLine(note), bodyLine(note)].join('\n');
}

/** The metadata text block that precedes every image view_images returns. */
export function describeImage(note: Note, image: NoteImage, k: number, n: number): string {
  return [
    `id: ${note.id}`,
    `image: ${image.id} (image ${k} of ${n})`,
    `saved: ${note.created_at}`,
    `taken: ${image.taken_at ?? 'unknown (no EXIF date)'}`,
    `size: ${image.width}x${image.height} ${image.mime}, ${formatBytes(image.bytes)}` +
      (image.original_name ? `, original name ${image.original_name}` : ''),
    tagLine(note),
    bodyLine(note),
  ].join('\n');
}

/** Text block + picture for one image, or a text block saying why there is no picture. */
async function viewOne(img: ImageDeps, item: ViewItem): Promise<Content[]> {
  const head = describeImage(item.note, item.image, item.k, item.n);
  let resolved: ResolveResult;
  try {
    resolved = await resolveImageFile(img, item.image.id, 'preview');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [text(`${head}\n(the preview could not be generated: ${msg})`)];
  }
  if (resolved.status === 'ok') {
    const data = (await readFile(resolved.file.absPath)).toString('base64');
    return [text(head), { type: 'image', data, mimeType: resolved.file.mime }];
  }
  if (resolved.status === 'not_on_this_machine') {
    return [text(`${head}\n(image not on this machine: the file lives on ${resolved.host ?? 'another machine'})`)];
  }
  return [text(`${head}\n(no image available)`)];
}

export function registerImageTools(server: McpServer, deps: ToolDeps): void {
  const img = toolImageDeps(deps);

  server.registerTool(
    'create_image',
    {
      title: 'Create image note',
      description:
        'Save a local image file (screenshot, photo, PNG/JPEG/WebP/GIF/HEIC/TIFF...) as a new note with that one image. ' +
        'Give an absolute path (~/ is expanded). The file is COPIED byte for byte into the notes store; the source is left where it is. ' +
        'Optional body is the note text; #hashtags in it become tags. ' +
        'If the exact same file already lives in a note, that note is returned (created: false) instead of a duplicate. ' +
        'Non-image files are refused. Returns { note, created }.',
      inputSchema: {
        path: z.string().min(1).describe('Absolute path to the image file, or a path starting with ~/.'),
        body: z.string().optional().describe('Text for the note. #hashtags become tags.'),
        origin: originShape,
      },
    },
    async ({ path, body, origin }): Promise<CallToolResult> => {
      try {
        const { note, created } = await ingestFromPath(img, path, body, { ...(origin ?? {}), source: 'mcp' });
        return { content: [text(JSON.stringify({ note, created }, null, 2))] };
      } catch (err) {
        if (err instanceof ImageInputError) {
          return { isError: true, content: [text(`create_image refused (${err.code}): ${err.message}`)] };
        }
        throw err;
      }
    },
  );

  server.registerTool(
    'view_images',
    {
      title: 'View images',
      description:
        `Look at the pictures in notes. Takes 1 to ${VIEW_IMAGES_MAX} ids (any case, dash optional): a note id shows every image of that note in order, ` +
        "an image id (from a note's images[].id) shows that one image. " +
        'Each picture comes after its metadata (note id, image id and "image k of n", saved date, EXIF taken date, dimensions, tags, body), ' +
        'downscaled to at most 1568 px on the long edge. Find ids first with list/search (has_image: true means at least one image). ' +
        `At most ${VIEW_IMAGES_MAX} images come back per call; a last text line lists the image ids left out, to pass to the next call. ` +
        'Text notes, deleted notes, removed images, unknown ids and images whose file lives on another machine come back as a text line saying so.',
      inputSchema: {
        ids: z
          .array(z.string().min(1))
          .min(1)
          .max(VIEW_IMAGES_MAX)
          .describe(`Note ids or image ids, 1 to ${VIEW_IMAGES_MAX}.`),
      },
    },
    async ({ ids }): Promise<CallToolResult> => {
      const found = await deps.service.get(ids, { includeDeleted: true });
      const byId = new Map(found.notes.map((n) => [n.id, n]));
      const content: Content[] = [];
      const seen = new Set<string>();
      const overflow: string[] = [];
      let shown = 0;

      for (const raw of ids) {
        const id = normalizeId(raw);
        if (id === null) {
          content.push(text(`${raw}: no such note or image.`));
          continue;
        }
        let items: ViewItem[];
        const note = byId.get(id);
        if (note) {
          if (note.deleted_at !== undefined) {
            content.push(text(`${note.id}: this note is deleted (restore it to view it).`));
            continue;
          }
          if (note.images.length === 0) {
            content.push(text(`${describeNote(note)}\n(text note: it has no image)`));
            continue;
          }
          items = note.images.map((image, i) => ({ note, image, k: i + 1, n: note.images.length }));
        } else {
          const rec = await img.records.byImageId(id);
          if (!rec) {
            content.push(text(`${raw}: no such note or image.`));
            continue;
          }
          if (rec.note_deleted_at !== null) {
            content.push(text(`${id}: this image belongs to note ${rec.note_id}, which is deleted (restore the note to view it).`));
            continue;
          }
          if (rec.deleted_at !== null) {
            content.push(text(`${id}: this image was removed from note ${rec.note_id}.`));
            continue;
          }
          const owner = await deps.service.getOne(rec.note_id);
          const index = owner ? owner.images.findIndex((i) => i.id === id) : -1;
          const image = owner ? owner.images[index] : undefined;
          if (!owner || !image) {
            content.push(text(`${raw}: no such note or image.`));
            continue;
          }
          items = [{ note: owner, image, k: index + 1, n: owner.images.length }];
        }
        for (const item of items) {
          if (seen.has(item.image.id)) continue;
          seen.add(item.image.id);
          if (shown >= VIEW_IMAGES_MAX) {
            overflow.push(item.image.id);
            continue;
          }
          shown += 1;
          content.push(...(await viewOne(img, item)));
        }
      }

      if (overflow.length > 0) {
        content.push(
          text(
            `${overflow.length} more image(s) not shown (at most ${VIEW_IMAGES_MAX} per call): ${overflow.join(', ')}. Call view_images again with these ids.`,
          ),
        );
      }
      return { content };
    },
  );

  const attach = toolAttachDeps(deps);

  server.registerTool(
    'attach_image',
    {
      title: 'Attach image to note',
      description:
        'Add a local image file (screenshot, photo, PNG/JPEG/WebP/GIF/HEIC/TIFF...) to an existing note; a note can hold several images, kept in attach order. ' +
        'Give the note id and an absolute path (~/ is expanded). The file is COPIED byte for byte into the notes store; the source is left where it is. ' +
        'If the exact same file already lives in a note (this one or another), nothing is copied and that note is returned with attached: false: tell the user which note holds it (a deleted holder note is restored). ' +
        'The note must not be deleted (restore it first). Non-image files are refused. Returns { note, attached }; a new image is the last entry of note.images.',
      inputSchema: {
        id: z.string().min(1).describe('Note id like A-B32 to attach to. Case-insensitive; the dash may be omitted.'),
        path: z.string().min(1).describe('Absolute path to the image file, or a path starting with ~/.'),
        origin: originShape,
      },
    },
    async ({ id, path }): Promise<CallToolResult> => {
      try {
        const result = await attachFromPath(attach, id, path);
        return { content: [text(JSON.stringify(result, null, 2))] };
      } catch (err) {
        if (err instanceof ImageInputError) {
          return { isError: true, content: [text(`attach_image refused (${err.code}): ${err.message}`)] };
        }
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'remove_image',
    {
      title: 'Remove image from note',
      description:
        "Take one image out of its note. This is soft and reversible: the image moves to the recycle bin, its file stays on disk, and restore_image(image_id) puts it back at the same position. " +
        "Pass the image's id (each entry of a note's images has one; the first image of a note saved from a picture has the note's own id). " +
        'Removing an image that is already removed changes nothing. Returns { note }: the owning note without that image.',
      inputSchema: {
        image_id: z.string().min(1).describe('Image id like A-B32 (from note.images[].id). Case-insensitive; the dash may be omitted.'),
      },
    },
    async ({ image_id }): Promise<CallToolResult> => run(async () => ({ note: await deps.service.removeImage(image_id) })),
  );

  server.registerTool(
    'restore_image',
    {
      title: 'Restore removed image',
      description:
        'Undo remove_image: put a removed image back into its note at its old position. If the note itself was deleted it is restored too. ' +
        'Refused (duplicate_image) when the same picture has since been saved again and is live in another note; the error names that note. ' +
        'Returns { note }.',
      inputSchema: {
        image_id: z.string().min(1).describe('Id of the removed image, like A-B32. Case-insensitive; the dash may be omitted.'),
      },
    },
    async ({ image_id }): Promise<CallToolResult> => run(async () => ({ note: await deps.service.restoreImage(image_id) })),
  );
}
