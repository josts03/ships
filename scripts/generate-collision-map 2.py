"""
Generate collision_map.png from the current polygon/zone/dock definitions.
This creates a 2400x1792 RGB PNG where:
  black  (0,0,0)       = land (island + coastline zones)
  yellow (255,215,0)   = yellow dock
  purple (139,92,246)  = purple dock
  white  (255,255,255) = navigable water

Run from the project root:
  python3 scripts/generate-collision-map.py
"""

import struct
import zlib
import math
import sys
import os

# ── Dimensions ──────────────────────────────────────────────────────────────

CW, CH = 1024, 768          # logical canvas
IMG_W, IMG_H = 2400, 1792   # collision map (= background.png size)
SX = IMG_W / CW             # ~2.3438
SY = IMG_H / CH             # ~2.3333

# ── Game data (mirrors Map.js) ───────────────────────────────────────────────

ISLAND_POLYGON = [
    (235, 325), (290, 305), (355, 310), (410, 330), (435, 370),
    (425, 420), (385, 455), (320, 465), (255, 450), (220, 415), (215, 375),
]

COASTLINE_ZONES = [
    # name,  x,   y,   w,    h
    ('A',   0,   0,   130,  200),
    ('B',   420, 0,   604,  55 ),
    ('C',   0,   0,   1024, 40 ),
    # D, E, F are off-canvas (y > 768) – included so the map boundary is clean
    ('D',   680, 870, 344,  50 ),
    ('E',   950, 700, 74,   170),
    ('F',   680, 920, 344,  100),
]

DOCK_DEFS = [
    # id, cx, cy,  color
    (1,  185,  90,  'yellow'),
    (2,  340,  72,  'yellow'),
    (3,  310,  455, 'purple'),
    (4,  490,  350, 'purple'),
    (5,  762,  630, 'yellow'),  # bottom-right dock
    (6,  895,  620, 'yellow'),  # bottom-right dock
]
DOCK_RADIUS_CANVAS = 10  # small enough that CLUSTER_R=55 (image-space) won't split a dock

# ── PNG encoder ──────────────────────────────────────────────────────────────

def _png_chunk(name: bytes, data: bytes) -> bytes:
    crc = zlib.crc32(name + data) & 0xFFFFFFFF
    return struct.pack('>I', len(data)) + name + data + struct.pack('>I', crc)

def write_png(path: str, width: int, height: int, raw: bytearray) -> None:
    """Write a raw IDAT bytearray (filter-byte + RGB rows) to a PNG file."""
    sig  = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    comp = zlib.compress(bytes(raw), 6)
    with open(path, 'wb') as f:
        f.write(sig)
        f.write(_png_chunk(b'IHDR', ihdr))
        f.write(_png_chunk(b'IDAT', comp))
        f.write(_png_chunk(b'IEND', b''))

# ── Pixel buffer helpers ─────────────────────────────────────────────────────

ROW_STRIDE = 1 + IMG_W * 3   # filter byte + RGB per row

def make_white_buffer() -> bytearray:
    row = bytes([0]) + bytes([255, 255, 255] * IMG_W)
    buf = bytearray(row * IMG_H)
    return buf

def set_pixel(buf: bytearray, x: int, y: int, r: int, g: int, b: int) -> None:
    if 0 <= x < IMG_W and 0 <= y < IMG_H:
        i = y * ROW_STRIDE + 1 + x * 3
        buf[i]   = r
        buf[i+1] = g
        buf[i+2] = b

def fill_rect(buf: bytearray, x1: int, y1: int, w: int, h: int,
              r: int, g: int, b: int) -> None:
    """Fast rectangle fill using row-level slice assignment."""
    x1c = max(0, x1);  x2c = min(IMG_W, x1 + w)
    y1c = max(0, y1);  y2c = min(IMG_H, y1 + h)
    if x1c >= x2c or y1c >= y2c:
        return
    row_pixels = bytes([r, g, b]) * (x2c - x1c)
    for y in range(y1c, y2c):
        base = y * ROW_STRIDE + 1 + x1c * 3
        buf[base : base + len(row_pixels)] = row_pixels

def fill_circle(buf: bytearray, cx: int, cy: int, radius: int,
                r: int, g: int, b: int) -> None:
    """Filled circle (Bresenham-ish, row-by-row)."""
    for dy in range(-radius, radius + 1):
        dx = int(math.sqrt(max(0, radius * radius - dy * dy)))
        fill_rect(buf, cx - dx, cy + dy, dx * 2 + 1, 1, r, g, b)

# ── Polygon fill (scanline) ──────────────────────────────────────────────────

def poly_to_img(poly_canvas):
    """Scale canvas-space polygon to image-space integer coords."""
    return [(int(round(x * SX)), int(round(y * SY))) for x, y in poly_canvas]

def fill_polygon(buf: bytearray, poly: list, r: int, g: int, b: int) -> None:
    """Scanline fill for a simple polygon (image-space coords)."""
    ys = [p[1] for p in poly]
    y_min, y_max = max(0, min(ys)), min(IMG_H - 1, max(ys))

    for y in range(y_min, y_max + 1):
        intersections = []
        n = len(poly)
        for i in range(n):
            x0, y0 = poly[i]
            x1, y1 = poly[(i + 1) % n]
            if (y0 <= y < y1) or (y1 <= y < y0):
                # x at this scan line
                t = (y - y0) / (y1 - y0)
                xi = x0 + t * (x1 - x0)
                intersections.append(xi)
        intersections.sort()
        for k in range(0, len(intersections) - 1, 2):
            x_l = max(0, int(math.ceil(intersections[k])))
            x_r = min(IMG_W - 1, int(math.floor(intersections[k + 1])))
            if x_l <= x_r:
                row_pixels = bytes([r, g, b]) * (x_r - x_l + 1)
                base = y * ROW_STRIDE + 1 + x_l * 3
                buf[base : base + len(row_pixels)] = row_pixels

# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    out_path = os.path.join(
        os.path.dirname(__file__), '..', 'assets', 'map', 'collision_map.png'
    )
    out_path = os.path.normpath(out_path)

    print(f"Generating {IMG_W}×{IMG_H} collision map → {out_path}")

    buf = make_white_buffer()
    print("  Buffer allocated.")

    # 1. Coastline zones → black
    for name, x, y, w, h in COASTLINE_ZONES:
        ix, iy = int(x * SX), int(y * SY)
        iw, ih = int(w * SX), int(h * SY)
        fill_rect(buf, ix, iy, iw, ih, 0, 0, 0)
        print(f"  Zone {name} filled.")

    # 2. Island polygon → black
    island_img = poly_to_img(ISLAND_POLYGON)
    fill_polygon(buf, island_img, 0, 0, 0)
    print("  Island polygon filled.")

    # 3. Docks → colored circles (drawn last so they overwrite land)
    YELLOW = (255, 215, 0)
    PURPLE = (139, 92, 246)
    dock_r = int(DOCK_RADIUS_CANVAS * ((SX + SY) / 2))  # ~51 px image-space
    for did, cx, cy, color_name in DOCK_DEFS:
        color = YELLOW if color_name == 'yellow' else PURPLE
        icx, icy = int(cx * SX), int(cy * SY)
        fill_circle(buf, icx, icy, dock_r, *color)
        print(f"  Dock {did} ({color_name}) at img ({icx},{icy}) filled.")

    # 4. Write PNG
    write_png(out_path, IMG_W, IMG_H, buf)
    size_kb = os.path.getsize(out_path) // 1024
    print(f"Done! {size_kb} KB written to {out_path}")
    print()
    print("To regenerate: python3 scripts/generate-collision-map.py")
    print("Replace assets/map/collision_map.png with your hand-drawn version at any time.")

if __name__ == '__main__':
    main()
