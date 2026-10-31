import sharp from 'sharp';
import { getPreview, type ImageSource } from '../images/derive.js';
import { IMAGE_EMBED_LONG_EDGE } from './imageConstants.js';

/**
 * The PNG an image is embedded from: EXIF-rotated, long edge <= IMAGE_EMBED_LONG_EDGE (never
 * enlarged), alpha flattened onto white. `input` is a file path or the encoded bytes of any
 * format sharp decodes (JPEG, PNG, WebP, GIF, AVIF, TIFF).
 */
export async function toEmbeddingPng(input: string | Uint8Array): Promise<Buffer> {
  const source = typeof input === 'string' ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  return sharp(source, { failOn: 'none' })
    .rotate()
    .resize({ width: IMAGE_EMBED_LONG_EDGE, height: IMAGE_EMBED_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();
}

/**
 * The PNG for a note image: its `preview` derivative (cache/<id>/preview.jpg, generated on first
 * use; already decoded from HEIC/TIFF, rotated and flattened) re-encoded by toEmbeddingPng.
 * Throws OriginalMissingError (src/images/derive.ts) when the original is not on this machine.
 */
export async function notePngForEmbedding(dataDir: string, src: ImageSource): Promise<Buffer> {
  const preview = await getPreview(dataDir, src);
  return toEmbeddingPng(preview);
}
