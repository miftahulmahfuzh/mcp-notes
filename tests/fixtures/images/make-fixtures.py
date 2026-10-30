"""Regenerate the image fixtures in this directory.

    python3 -m venv /tmp/fx-venv && /tmp/fx-venv/bin/pip install pillow pillow-heif
    /tmp/fx-venv/bin/python tests/fixtures/images/make-fixtures.py tests/fixtures/images

Made with Pillow 13.0.0 + pillow-heif 1.8.1 (libheif 1.23.6, x265 4.3). Node cannot write
HEVC (sharp's prebuilt libheif has no HEVC encoder), which is why these are committed.
Regenerating may change bytes (and sha256), not the properties the tests rely on.
"""
import sys

import pillow_heif
from PIL import Image


def gradient(w: int, h: int) -> Image.Image:
    im = Image.new("RGB", (w, h))
    px = im.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = (x * 255 // w, y * 255 // h, 128)
    return im


def main(out: str) -> None:
    exif = Image.Exif()
    exif[0x0110] = "FixtureCam"  # Model (IFD0)
    exif.get_ifd(0x8769)[0x9003] = "2024:10:30 14:05:09"  # ExifIFD DateTimeOriginal, no offset
    gradient(64, 48).save(f"{out}/exif.jpg", "JPEG", quality=80, exif=exif.tobytes())
    gradient(40, 30).save(f"{out}/plain.png", "PNG")
    pillow_heif.register_heif_opener()
    gradient(64, 48).save(f"{out}/photo.heic", "HEIF", quality=50, exif=exif.tobytes())


if __name__ == "__main__":
    main(sys.argv[1])
