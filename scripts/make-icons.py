"""Renders icons/icon{16,32,48,128}.png: a rounded tile with a heavy "B" and a light "r".

Usage: python3 scripts/make-icons.py   (needs Pillow and the Inter font, or pass font paths)
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
BOLD = sys.argv[1] if len(sys.argv) > 1 else "/usr/share/fonts/opentype/inter/Inter-Black.otf"
LIGHT = sys.argv[2] if len(sys.argv) > 2 else "/usr/share/fonts/opentype/inter/Inter-Light.otf"
TOP, BOTTOM = (20, 150, 128), (12, 104, 92)  # teal gradient
SCALE = 8  # supersampling factor for smooth edges


def render(size: int) -> Image.Image:
    big = size * SCALE
    gradient = Image.new("RGB", (1, big))
    for y in range(big):
        t = y / (big - 1)
        gradient.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)))
    tile = gradient.resize((big, big))

    mask = Image.new("L", (big, big), 0)
    inset = round(big * (0.02 if size <= 16 else 0.06))
    ImageDraw.Draw(mask).rounded_rectangle((inset, inset, big - inset, big - inset), radius=round(big * 0.22), fill=255)
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    img.paste(tile, (0, 0), mask)

    draw = ImageDraw.Draw(img)
    font_size = round(big * 0.66)
    heavy = ImageFont.truetype(BOLD, font_size)
    light = ImageFont.truetype(LIGHT, font_size)
    b_box = draw.textbbox((0, 0), "B", font=heavy)
    r_box = draw.textbbox((0, 0), "r", font=light)
    gap = round(big * 0.02)
    width = (b_box[2] - b_box[0]) + gap + (r_box[2] - r_box[0])
    x = (big - width) / 2 - b_box[0]
    baseline = big * 0.5 + (b_box[3] - b_box[1]) / 2
    draw.text((x, baseline), "B", font=heavy, fill="white", anchor="ls")
    x_r = x + b_box[2] + gap - r_box[0]
    draw.text((x_r, baseline), "r", font=light, fill=(255, 255, 255, 215), anchor="ls")
    return img.resize((size, size), Image.LANCZOS)


for size in (16, 32, 48, 128):
    render(size).save(ROOT / "icons" / f"icon{size}.png")
    print(f"icons/icon{size}.png")
