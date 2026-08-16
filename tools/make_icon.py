"""Genera el icono oficial de Smart Set Architect: build/icon.png + build/icon.ico.

Diseño: gradiente diagonal violeta -> cian sobre fondo redondeado, con tres
ondas de audio blancas (identidad visual de la app) y halo neón cian.
"""
import math
import os

from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "build")

VIOLET = (139, 92, 246)
CYAN = (6, 182, 212)
WHITE = (255, 255, 255)


def gradient(size: int, c1, c2) -> Image.Image:
    img = Image.new("RGB", (size, size), (0, 0, 0))
    px = img.load()
    for y in range(size):
        t = y / max(size - 1, 1)
        r = int(c1[0] + (c2[0] - c1[0]) * t)
        g = int(c1[1] + (c2[1] - c1[1]) * t)
        b = int(c1[2] + (c2[2] - c1[2]) * t)
        for x in range(size):
            px[x, y] = (r, g, b)
    return img


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def wave_points(width: int, height: int, center_y: float, amp: float, freq: float, phase: float):
    pts = []
    for x in range(0, width, 2):
        y = center_y + amp * math.sin(2 * math.pi * freq * x / width + phase)
        pts.append((x, y))
    return pts


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    bg = gradient(SIZE, VIOLET, CYAN)
    mask = rounded_mask(SIZE, int(SIZE * 0.18))
    icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    icon.paste(bg, (0, 0), mask)

    draw = ImageDraw.Draw(icon, "RGBA")
    margins = int(SIZE * 0.16)
    draw_area = (margins, int(SIZE * 0.30), SIZE - margins, int(SIZE * 0.74))
    width = draw_area[2] - draw_area[0]

    # Halo neón cian detrás de las ondas (trazo grueso difuminado)
    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow, "RGBA")
    for i, (cy, amp, freq, phase) in enumerate(
        [
            (int(SIZE * 0.52), int(SIZE * 0.075), 1.6, 0.0),
            (int(SIZE * 0.52), int(SIZE * 0.15), 1.6, 0.55),
            (int(SIZE * 0.52), int(SIZE * 0.225), 1.6, 1.1),
        ]
    ):
        # enmarcar dentro del área de dibujo
        a = amp
        pts = []
        for x in range(draw_area[0], draw_area[2], 2):
            y = cy + a * math.sin(2 * math.pi * freq * (x - draw_area[0]) / width + phase)
            pts.append((x, y))
        gd.line(pts, fill=(120, 220, 255, 90), width=int(SIZE * 0.07), joint="curve")
    glow = glow.filter(ImageFilter.GaussianBlur(int(SIZE * 0.035)))
    icon.alpha_composite(glow)

    draw = ImageDraw.Draw(icon, "RGBA")
    for i, (cy, amp, freq, phase) in enumerate(
        [
            (int(SIZE * 0.52), int(SIZE * 0.075), 1.6, 0.0),
            (int(SIZE * 0.52), int(SIZE * 0.15), 1.6, 0.55),
            (int(SIZE * 0.52), int(SIZE * 0.225), 1.6, 1.1),
        ]
    ):
        pts = []
        for x in range(draw_area[0], draw_area[2], 2):
            y = cy + amp * math.sin(2 * math.pi * freq * (x - draw_area[0]) / width + phase)
            pts.append((x, y))
        draw.line(pts, fill=WHITE + (235,), width=int(SIZE * 0.030), joint="curve")

    # Punto de brillo (playhead) sobre la onda central
    cx = SIZE // 2
    cy = int(SIZE * 0.52) + int(SIZE * 0.15) * math.sin(2 * math.pi * 1.6 * 0.5 + 0.55)
    pr = int(SIZE * 0.028)
    draw.ellipse((cx - pr, cy - pr, cx + pr, cy + pr), fill=WHITE, outline=(0, 0, 0, 40), width=2)

    png_path = os.path.join(OUT_DIR, "icon.png")
    icon.save(png_path, "PNG")

    # ICO multiresolución (Windows: exe, instalador y accesos directos)
    ico_path = os.path.join(OUT_DIR, "icon.ico")
    icon.save(
        ico_path,
        "ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print("OK ->", png_path, os.path.getsize(png_path), "bytes")
    print("OK ->", ico_path, os.path.getsize(ico_path), "bytes")


if __name__ == "__main__":
    main()