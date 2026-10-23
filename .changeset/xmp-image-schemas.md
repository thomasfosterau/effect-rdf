---
'@thomasfosterau/effect-xmp': minor
---

`effect-xmp` reads more of the XMP found in files: `Packet.find` / `findAll` find UTF-32 packets (either byte order; `Packet.Encoding` gains `'utf-32be'` and `'utf-32le'`), and `Extract.png` inflates a zlib-compressed `iTXt` chunk with the platform's `DecompressionStream`, up to `maxXmpBytes` (default `Extract.DEFAULT_MAX_XMP_BYTES`, 4 MiB) so a deflate bomb fails instead of exhausting memory (`Extract.pngResult`, which is synchronous, still fails on one, now saying to use `Extract.png`). New `Photoshop`, `Exif` and `Tiff` modules give typed getters and setters for those schemas' common properties.
