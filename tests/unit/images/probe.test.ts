import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  exifDateToIso,
  isBrowserDisplayable,
  probeImage,
  sha256Hex,
  sniffImageBytes,
  UnsupportedImageError,
} from '../../../src/images/probe.js';
import { fixtureBytes, HEIC_PHOTO, JPEG_EXIF, PNG_PLAIN } from '../../helpers/fixtures.js';

const localIso = (y: number, mo: number, d: number, h: number, mi: number, s: number) =>
  new Date(y, mo - 1, d, h, mi, s).toISOString();

describe('exifDateToIso', () => {
  it('reads an EXIF date as process-local time when no offset is given', () => {
    expect(exifDateToIso('2024:10:30 14:05:09')).toBe(localIso(2024, 10, 30, 14, 5, 9));
  });
  it('applies OffsetTimeOriginal', () => {
    expect(exifDateToIso('2024:10:30 14:05:09', '+07:00')).toBe('2024-10-30T07:05:09.000Z');
    expect(exifDateToIso('2024:10:30 14:05:09', '-02:30')).toBe('2024-10-30T16:35:09.000Z');
  });
  it('returns null for blank or zeroed dates', () => {
    expect(exifDateToIso('0000:00:00 00:00:00')).toBeNull();
    expect(exifDateToIso('')).toBeNull();
    expect(exifDateToIso(undefined)).toBeNull();
    expect(exifDateToIso('2024:13:01 00:00:00')).toBeNull();
  });
});

describe('probeImage', () => {
  it('JPEG with EXIF: mime, size, taken_at', async () => {
    const p = await probeImage(await fixtureBytes(JPEG_EXIF));
    expect(p).toEqual({
      mime: 'image/jpeg',
      mimeExt: 'jpg',
      width: 64,
      height: 48,
      taken_at: localIso(2024, 10, 30, 14, 5, 9),
    });
  });

  it('PNG without EXIF: taken_at null', async () => {
    const p = await probeImage(await fixtureBytes(PNG_PLAIN));
    expect(p).toEqual({ mime: 'image/png', mimeExt: 'png', width: 40, height: 30, taken_at: null });
  });

  it('HEIC: size from the header, EXIF date, no pixel decode needed', async () => {
    const p = await probeImage(await fixtureBytes(HEIC_PHOTO));
    expect(p.mime).toBe('image/heic');
    expect(p.mimeExt).toBe('heic');
    expect([p.width, p.height]).toEqual([64, 48]);
    expect(p.taken_at).toBe(localIso(2024, 10, 30, 14, 5, 9));
  });

  it('reports display-oriented size for EXIF-rotated JPEGs', async () => {
    const rotated = await sharp({ create: { width: 30, height: 20, channels: 3, background: '#0a0' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const p = await probeImage(rotated);
    expect([p.width, p.height]).toEqual([20, 30]);
  });

  it('rejects non-images by magic bytes, whatever the name', async () => {
    await expect(probeImage(Buffer.from('just some text, not a picture'))).rejects.toBeInstanceOf(
      UnsupportedImageError,
    );
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
    await expect(probeImage(pdf)).rejects.toThrow(/application\/pdf/);
  });
});

describe('sniff + helpers', () => {
  it('sniffs supported images only', async () => {
    expect(await sniffImageBytes(await fixtureBytes(HEIC_PHOTO))).toEqual({ mime: 'image/heic', ext: 'heic' });
    expect(await sniffImageBytes(Buffer.from('hello'))).toBeNull();
  });
  it('knows which originals a browser can show', () => {
    expect(isBrowserDisplayable('image/jpeg')).toBe(true);
    expect(isBrowserDisplayable('image/avif')).toBe(true);
    expect(isBrowserDisplayable('image/heic')).toBe(false);
    expect(isBrowserDisplayable('image/tiff')).toBe(false);
  });
  it('sha256Hex is the hex digest', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
