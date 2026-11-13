#!/usr/bin/env python3
"""make_db.py - build the Ethanol app's text and image data for NBT Evo.

The reference gauge app ships text and image "databases" built with python3 + Pillow. We do not yet know
that exact packaging format, so this script produces the raw inputs (a strings file and a menu icon PNG)
into data_out/ and documents what still has to be packed. [RECONCILE] the final container format against
the gauge app's make_db.py / the files it copies to the unit.

Run:  python3 make_db.py        (Pillow optional; without it the icon step is skipped with a note)
"""
import os

OUT = "data_out"

# Caption/label strings the XML references. Kept here so translations are one edit.
STRINGS = {
    "app.title": "Ethanol",
    "menu.ethanol": "Ethanol",
    "row.ethanol": "Ethanol",
    "row.source": "Source",
    "row.fuel": "In tank",
    "row.addE85": "Add E85",
    "row.addPump": "Add pump",
    "row.result": "Result",
}


def write_strings():
    path = os.path.join(OUT, "strings.txt")
    with open(path, "w") as f:
        for k in sorted(STRINGS):
            f.write("%s=%s\n" % (k, STRINGS[k]))
    print("wrote", path)


def write_icon():
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        print("Pillow not installed; skipping icon. `pip3 install Pillow` to build ethanol_icon.png")
        return
    # a simple round "E" badge; replace with a real asset before shipping.
    size = 48
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse((2, 2, size - 2, size - 2), fill=(32, 160, 80, 255))
    d.text((17, 14), "E", fill=(255, 255, 255, 255))
    path = os.path.join(OUT, "ethanol_icon.png")
    img.save(path)
    print("wrote", path)


def main():
    os.makedirs(OUT, exist_ok=True)
    write_strings()
    write_icon()
    print("\nNext: pack %s/ into the unit's expected DB format and copy alongside libEthanolApp.so" % OUT)


if __name__ == "__main__":
    main()
