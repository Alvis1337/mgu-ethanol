#!/usr/bin/env python3
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Builds EthanolApp_ALL_Texts.zip (<lang>.txt with "id=text" lines, the format BMW's PluginsCoded apps use, as in
# NBT-AAD) and EthanolApp_ALL_Images.zip (<imageId>.png). Needs Pillow for the icon.
#   text 1 = menu row / screen title        image 56001 = 63x54 row icon
# Adapted from MGD4096/IDRIVE_GAUGE_APP make_db.py (PolyForm-Noncommercial); see idrive6/LICENSE.
import os
import zipfile

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))

# BMW language codes, ASCII titles (like NBT-AAD's text DB).
LANGS = {
    "de": "Deutsch", "en-UK": "English (UK)", "en-US": "English (US)",
    "es-ES": "Espanol", "es-US": "Espanol (US)", "fr-FR": "Francais", "fr-CA": "Francais (CA)",
    "it": "Italiano", "pt": "Portugues", "ru": "Russian", "pl": "Polski",
}
TITLE = "ETHANOL APP"


def make_icon(path):
    """63x54 RGBA row icon: a fuel drop with an 'E', in the near-white NBT-AAD's icons use."""
    w, h = 63, 54
    scale = 4
    im = Image.new("RGBA", (w * scale, h * scale), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    ink = (250, 250, 250, 248)
    cx = 31.5 * scale
    # teardrop: a triangle top over a circle bottom
    r = 15 * scale
    cy = 33 * scale
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=ink, width=3 * scale)
    d.polygon([(cx, 6 * scale), (cx - r, cy - 2 * scale), (cx + r, cy - 2 * scale)], fill=ink)
    # an "E" in the drop
    ex, ey, eh, ew = cx - 6 * scale, cy - 8 * scale, 16 * scale, 11 * scale
    lw = 3 * scale
    d.rectangle([ex, ey, ex + lw, ey + eh], fill=ink)
    d.rectangle([ex, ey, ex + ew, ey + lw], fill=ink)
    d.rectangle([ex, ey + eh // 2 - lw // 2, ex + ew - 2 * scale, ey + eh // 2 + lw // 2], fill=ink)
    d.rectangle([ex, ey + eh - lw, ex + ew, ey + eh], fill=ink)
    im.resize((w, h), Image.LANCZOS).save(path)


def main():
    with zipfile.ZipFile(os.path.join(HERE, "EthanolApp_ALL_Texts.zip"), "w", zipfile.ZIP_DEFLATED) as z:
        for lang, langname in LANGS.items():
            body = "100000=%s\n1=%s\n" % (langname, TITLE)
            z.writestr(lang + ".txt", body.encode("utf-8"))
    icon = os.path.join(HERE, "res", "row_icon_63x54.png")
    os.makedirs(os.path.dirname(icon), exist_ok=True)
    make_icon(icon)
    with zipfile.ZipFile(os.path.join(HERE, "EthanolApp_ALL_Images.zip"), "w", zipfile.ZIP_DEFLATED) as z:
        z.write(icon, "56001.png")
    print("wrote EthanolApp_ALL_Texts.zip, EthanolApp_ALL_Images.zip")


if __name__ == "__main__":
    main()
