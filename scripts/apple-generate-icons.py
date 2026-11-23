"""Generate the repository's simple geometric notebook icon, without external packages."""
import json
import pathlib
import struct
import zlib

root = pathlib.Path(__file__).resolve().parents[1] / "apple"
size = 1024
rows = bytearray()
for y in range(size):
    rows.append(0)
    for x in range(size):
        color = (38, 76, 64)
        # Two pages and a fine spine; no text, brand assets or transparency.
        if 250 <= x <= 493 and 255 <= y <= 735 + (x - 250) // 18:
            color = (242, 237, 218)
        if 531 <= x <= 774 and 255 <= y <= 748 - (x - 531) // 18:
            color = (221, 224, 202)
        if 294 <= x <= 445 and any(abs(y - line) <= 6 for line in (365, 445, 525)):
            color = (130, 153, 131)
        if 579 <= x <= 718 and any(abs(y - line) <= 6 for line in (365, 445, 525)):
            color = (109, 139, 118)
        rows.extend(color)

def chunk(name, data):
    return struct.pack(">I", len(data)) + name + data + struct.pack(">I", zlib.crc32(name + data) & 0xFFFFFFFF)

png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b"")
for folder, platform in (("WatchApp", "watchos"), ("Wrapper", "ios")):
    catalog = root / folder / "Assets.xcassets"
    appicon = catalog / "AppIcon.appiconset"
    appicon.mkdir(parents=True, exist_ok=True)
    (catalog / "Contents.json").write_text(json.dumps({"info": {"author": "xcode", "version": 1}}, indent=2) + "\n")
    (appicon / "AppIcon.png").write_bytes(png)
    (appicon / "Contents.json").write_text(json.dumps({
        "images": [{"filename": "AppIcon.png", "idiom": "universal", "platform": platform, "size": "1024x1024"}],
        "info": {"author": "xcode", "version": 1}
    }, indent=2) + "\n")
print("Generated opaque 1024px watchOS and wrapper icon assets")
