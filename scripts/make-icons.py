"""Generates the PWA icon set. Deterministic: same input, same bytes.

Run: python3 scripts/make-icons.py
"""
import pathlib
from PIL import Image, ImageDraw, ImageFont

OUT = pathlib.Path(__file__).resolve().parent.parent / "public" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

BG_TOP = (28, 38, 56)
BG_BOTTOM = (12, 15, 20)
ACCENT = (79, 156, 249)
ACCENT_SOFT = (123, 108, 246)
LINE = (222, 232, 245)

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/SFNS.ttf",
]


def font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if pathlib.Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def gradient(size: int, radius_ratio: float) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    grad = Image.new("RGBA", (size, size))
    pixels = grad.load()
    for y in range(size):
        t = y / max(size - 1, 1)
        row = tuple(round(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3))
        for x in range(size):
            pixels[x, y] = (*row, 255)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(size * radius_ratio), fill=255
    )
    img.paste(grad, (0, 0), mask)
    return img


def draw_cube(draw: ImageDraw.ImageDraw, cx: float, cy: float, half: float, accent: bool) -> None:
    """Isometric wireframe cube: top face bright, body edges in the cool grey."""
    dx, dy = half * 0.866, half * 0.5
    top = (cx, cy - dy * 2)
    upper_left = (cx - dx, cy - dy)
    upper_right = (cx + dx, cy - dy)
    center = (cx, cy)
    lower_left = (cx - dx, cy + dy)
    lower_right = (cx + dx, cy + dy)
    bottom = (cx, cy + dy * 2)
    top_color = ACCENT if accent else LINE
    width = max(2, int(half * 0.16))
    for a, b, color in [
        (top, upper_left, top_color),
        (top, upper_right, top_color),
        (upper_left, center, top_color),
        (upper_right, center, top_color),
        (upper_left, lower_left, LINE),
        (upper_right, lower_right, LINE),
        (center, bottom, LINE),
        (lower_left, bottom, LINE),
        (lower_right, bottom, LINE),
    ]:
        draw.line([a, b], fill=color, width=width, joint="curve")
    r = width * 0.75
    for point in (top, upper_left, upper_right, center, lower_left, lower_right, bottom):
        draw.ellipse([point[0] - r, point[1] - r, point[0] + r, point[1] + r], fill=LINE)


def build(size: int, *, maskable: bool, cube_scale: float, text: bool) -> Image.Image:
    img = gradient(size, 0.2237 if not maskable else 0.5)
    draw = ImageDraw.Draw(img)
    if maskable:
        # Maskable icons may be cropped to a circle: keep content inside the safe zone.
        draw_cube(draw, size * 0.5, size * 0.42, size * 0.14, accent=True)
        return img
    draw_cube(draw, size * 0.5, size * 0.40, size * 0.155 * cube_scale, accent=True)
    if text:
        f = font(int(size * 0.21))
        label = "3D"
        left, top, right, bottom = draw.textbbox((0, 0), label, font=f)
        draw.text(
            (size / 2 - (right - left) / 2 - left, size * 0.635),
            label,
            font=f,
            fill=(233, 240, 250),
        )
    return img


def main() -> None:
    targets = [
        ("icon-192.png", 192, dict(maskable=False, cube_scale=1.0, text=True)),
        ("icon-512.png", 512, dict(maskable=False, cube_scale=1.0, text=True)),
        ("icon-maskable-512.png", 512, dict(maskable=True, cube_scale=1.0, text=False)),
        ("apple-touch-icon.png", 180, dict(maskable=False, cube_scale=1.0, text=True)),
        ("favicon-32.png", 32, dict(maskable=False, cube_scale=1.05, text=False)),
    ]
    for name, size, kwargs in targets:
        img = build(size, **kwargs)
        path = OUT / name
        img.save(path, "PNG", optimize=True)
        print(f"{path.relative_to(OUT.parent.parent)} {size}x{size} {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
