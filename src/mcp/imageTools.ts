import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ImageInputError, ingestFromPath, resolveImageFile, toolImageDeps } from '../http/imageAccess.js';
import { normalizeId } from '../notes/ids.js';
import type { Note } from '../notes/types.js';
import type { ToolDeps } from './tools.js';

export const VIEW_IMAGES_MAX = 8;

type Content = CallToolResult['content'][number];

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

/** The metadata text block that accompanies every image view_images returns. */
export function describeImageNote(note: Note): string {
  const lines = [`id: ${note.id}`, `saved: ${note.created_at}`];
  if (note.image) {
    lines.push(`taken: ${note.image.taken_at ?? 'unknown (no EXIF date)'}`);
    lines.push(
      `image: ${note.image.width}x${note.image.height} ${note.image.mime}, ${formatBytes(note.image.bytes)}` +
        (note.image.original_name ? `, original name ${note.image.original_name}` : ''),
    );
  }
  lines.push(`tags: ${note.tags.length > 0 ? note.tags.map((t) => `#${t}`).join(' ') : 'none'}`);
  lines.push(`body: ${note.body.trim() === '' ? '(empty)' : note.body}`);
  return lines.join('\n');
}

export function registerImageTools(server: McpServer, deps: ToolDeps): void {
  const img = toolImageDeps(deps);

  server.registerTool(
    'create_image',
    {
      title: 'Create image note',
      description:
        'Save a local image file (screenshot, photo, PNG/JPEG/WebP/GIF/HEIC/TIFF...) as an image note. ' +
        'Give an absolute path (~/ is expanded). The file is COPIED byte for byte into the notes store; the source is left where it is. ' +
        'Optional body is the note text; #hashtags in it become tags. ' +
        'If the exact same file was saved before, the existing note is returned (created: false) instead of a duplicate. ' +
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
        `Look at the pictures of image notes. Takes 1 to ${VIEW_IMAGES_MAX} note ids (any case, dash optional). ` +
        'For each id returns its metadata (id, saved date, EXIF taken date, dimensions, tags, body) followed by the picture itself, ' +
        'downscaled to at most 1568 px on the long edge. Find ids first with list/search (has_image: true). ' +
        'Text notes, unknown ids and images whose file lives on another machine come back as a text line saying so. ' +
        `For more than ${VIEW_IMAGES_MAX} images, call again with the next batch.`,
      inputSchema: {
        ids: z
          .array(z.string().min(1))
          .min(1)
          .max(VIEW_IMAGES_MAX)
          .describe(`Note ids, 1 to ${VIEW_IMAGES_MAX}.`),
      },
    },
    async ({ ids }): Promise<CallToolResult> => {
      const found = await deps.service.get(ids, { includeDeleted: true });
      const byId = new Map(found.notes.map((n) => [n.id, n]));
      const content: Content[] = [];
      for (const raw of ids) {
        const id = normalizeId(raw);
        const note = id ? byId.get(id) : undefined;
        if (!note) {
          content.push(text(`${raw}: no such note.`));
          continue;
        }
        if (note.deleted_at !== undefined) {
          content.push(text(`${note.id}: this note is deleted (restore it to view it).`));
          continue;
        }
        if (!note.image) {
          content.push(text(`${describeImageNote(note)}\n(text note: it has no image)`));
          continue;
        }
        let resolved;
        try {
          resolved = await resolveImageFile(img, note.id, 'preview');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          content.push(text(`${describeImageNote(note)}\n(the preview could not be generated: ${msg})`));
          continue;
        }
        if (resolved.status === 'ok') {
          const data = (await readFile(resolved.file.absPath)).toString('base64');
          content.push(text(describeImageNote(note)));
          content.push({ type: 'image', data, mimeType: resolved.file.mime });
        } else if (resolved.status === 'not_on_this_machine') {
          content.push(
            text(
              `${describeImageNote(note)}\n(image not on this machine: the file lives on ${resolved.host ?? 'another machine'})`,
            ),
          );
        } else {
          content.push(text(`${note.id}: no image available.`));
        }
      }
      return { content };
    },
  );
}
