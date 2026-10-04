"""Generate the OpenCat application icon set.

The mark is a rounded "app tile" with a violet-to-indigo gradient and a white
database cylinder whose top disc carries two ears and a pair of eyes: a database
client that reads as a cat without becoming a cartoon.

Run from the repository root:

    python tools/make_icons.py
"""

from __future__ import annotations

import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

# --- geometry ---------------------------------------------------------------

SIZE = 1024
SS = 4  # supersampling factor
S = SIZE * SS

VIOLET = (124, 58, 237)
INDIGO = (67, 56, 202)
DEEP = (49, 46, 129)

OUT_DIR = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"
ASSET_DIR = Path(__file__).resolve().parent.parent / "assets"


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def make_gradient(size: int, top: tuple, bottom: tuple) -> Image.Image:
    """A diagonal linear gradient."""
    img = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(size - 1, 1)
        # Blend towards the darker corner diagonally for a softer look.
        base = tuple(int(lerp(top[i], bottom[i], t)) for i in range(3))
        draw.line([(0, y), (size, y)], fill=base)
    return img.convert("RGBA")


def rounded_mask(size: int, radius_ratio: float = 0.225) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    radius = int(size * radius_ratio)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def draw_mark(size: int) -> Image.Image:
    """The white database-with-ears glyph, drawn on a transparent canvas."""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    u = size / 1024.0  # design grid is 1024x1024

    def sc(value: float) -> float:
        """Scale one design-grid coordinate."""
        return value * u

    def box(x0: float, y0: float, x1: float, y1: float) -> list[float]:
        return [sc(x0), sc(y0), sc(x1), sc(y1)]

    def pts(*pairs: float) -> list[tuple[float, float]]:
        it = iter(pairs)
        return [(sc(x), sc(y)) for x, y in zip(it, it)]

    draw = ImageDraw.Draw(layer)
    white = (255, 255, 255, 255)

    # --- ears (drawn first so the cylinder hides their base) ---------------
    draw.polygon(pts(292, 486, 388, 224, 492, 430), fill=white)
    draw.polygon(pts(532, 430, 636, 224, 732, 486), fill=white)
    ear_tint = (109, 40, 217, 110)
    draw.polygon(pts(348, 462, 392, 302, 452, 442), fill=ear_tint)
    draw.polygon(pts(572, 442, 632, 302, 676, 462), fill=ear_tint)

    # --- cylinder -----------------------------------------------------------
    left, right = sc(268), sc(756)
    top_cy, mid_cy, bot_cy = sc(470), sc(624), sc(760)
    rx, ry = sc(244), sc(80)
    band_ry = sc(34)

    # barrel
    draw.rectangle([left, top_cy, right, bot_cy], fill=white)
    draw.ellipse([left, bot_cy - ry, right, bot_cy + ry], fill=white)

    # disc separators
    for cy in (mid_cy, sc(722)):
        draw.ellipse(
            [left, cy - band_ry, right, cy + band_ry],
            outline=(124, 58, 237, 80),
            width=max(1, int(sc(9))),
        )

    # lid
    draw.ellipse([left, top_cy - ry, right, top_cy + ry], fill=white)
    draw.ellipse(
        [left + sc(36), top_cy - ry + sc(28), right - sc(36), top_cy + ry - sc(28)],
        fill=(238, 234, 254, 255),
    )

    # --- eyes on the lid ----------------------------------------------------
    for cx in (sc(430), sc(594)):
        er_x, er_y = sc(26), sc(33)
        draw.ellipse(
            [cx - er_x, top_cy - er_y, cx + er_x, top_cy + er_y],
            fill=(49, 46, 129, 255),
        )
        gx, gy, gr = cx - sc(9), top_cy - sc(12), sc(9)
        draw.ellipse([gx - gr, gy - gr, gx + gr, gy + gr], fill=white)

    return layer


def build_icon(size: int) -> Image.Image:
    """Compose one square icon at `size` pixels."""
    big = SIZE * SS // 4  # draw at 4x the requested size
    scale = big / 1024.0

    background = make_gradient(big, VIOLET, INDIGO)
    mask = rounded_mask(big)

    # A soft highlight in the upper-left keeps the tile from looking flat.
    glow = Image.new("L", (big, big), 0)
    ImageDraw.Draw(glow).ellipse(
        [-big * 0.25, -big * 0.45, big * 0.85, big * 0.55], fill=90
    )
    glow = glow.filter(ImageFilter.GaussianBlur(big * 0.09))
    background = Image.composite(Image.new("RGBA", (big, big), (255, 255, 255, 255)), background, glow)

    tile = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    tile.paste(background, (0, 0), mask)

    mark = draw_mark(big)
    tile.alpha_composite(mark)

    # A subtle bottom shadow grounds the glyph.
    shade = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(shade).ellipse(
        [big * 0.24, big * 0.78, big * 0.76, big * 0.90], fill=(30, 27, 75, 70)
    )
    shade = shade.filter(ImageFilter.GaussianBlur(big * 0.02))
    shade.putalpha(Image.composite(shade.getchannel("A"), Image.new("L", (big, big), 0), mask))
    tile.alpha_composite(shade)

    return tile.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ASSET_DIR.mkdir(parents=True, exist_ok=True)

    master = build_icon(1024)
    master.save(ASSET_DIR / "logo.png")
    master.save(OUT_DIR / "icon.png")

    sizes = {
        "32x32.png": 32,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "icon-512.png": 512,
        "Square30x30Logo.png": 30,
        "Square44x44Logo.png": 44,
        "Square71x71Logo.png": 71,
        "Square89x89Logo.png": 89,
        "Square107x107Logo.png": 107,
        "Square142x142Logo.png": 142,
        "Square150x150Logo.png": 150,
        "Square284x284Logo.png": 284,
        "Square310x310Logo.png": 310,
        "StoreLogo.png": 50,
    }
    for name, px in sizes.items():
        build_icon(px).save(OUT_DIR / name)

    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    master.save(OUT_DIR / "icon.ico", sizes=[(s, s) for s in ico_sizes])

    print(f"wrote {len(sizes) + 3} icon files to {OUT_DIR}")
    for path in sorted(OUT_DIR.iterdir()):
        print(f"  {path.name}: {os.path.getsize(path)} bytes")


if __name__ == "__main__":
    main()
