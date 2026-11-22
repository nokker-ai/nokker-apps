#!/usr/bin/env python3
"""Icône et écran de lancement iOS depuis le kit de marque (packages/brand/assets) — à relancer si la marque change.

Usage : python3 apps/mobile/scripts/brand_assets.py   (cairosvg + Pillow ; sorties versionnées dans ios/App/App/Assets.xcassets)
- AppIcon 1024×1024, opaque (exigence d'Apple), emblème sombre centré à 58 % sur #0B0B0C, comme l'icône « maskable ».
- Splash 2732×2732 (×3 fichiers du modèle Capacitor), même fond, emblème à 22 % : il reste lisible en portrait comme en
  paysage, recadré au centre par l'écran de lancement.
"""
import io
from pathlib import Path

import cairosvg
from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
BRAND = ROOT / "packages/brand/assets"
XC = ROOT / "apps/mobile/ios/App/App/Assets.xcassets"
BG = (11, 11, 12)


def emblem(px: int) -> Image.Image:
    png = cairosvg.svg2png(url=str(BRAND / "nokker-emblem-dark.svg"), output_width=px, output_height=px)
    return Image.open(io.BytesIO(png)).convert("RGBA")


def compose(size: int, ratio: float) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), BG + (255,))
    e = emblem(round(size * ratio))
    canvas.alpha_composite(e, ((size - e.width) // 2, (size - e.height) // 2))
    return canvas.convert("RGB")


def main() -> None:
    compose(1024, 0.58).save(XC / "AppIcon.appiconset/AppIcon-512@2x.png", optimize=True)
    splash = compose(2732, 0.22)
    for name in ("splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"):
        splash.save(XC / "Splash.imageset" / name, optimize=True)


if __name__ == "__main__":
    main()
