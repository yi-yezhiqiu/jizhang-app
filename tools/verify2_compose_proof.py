"""把「点击前（键盘在）」与「点击后（toast 在）」两张截图裁剪后并排拼成一张对照图。

用法: python tools/verify2_compose_proof.py <before.png> <after.png> <out.png> [y0] [y1]
"""
import sys

from PIL import Image, ImageDraw

before_p, after_p, out_p = sys.argv[1], sys.argv[2], sys.argv[3]
y0 = int(sys.argv[4]) if len(sys.argv) > 4 else 380
y1 = int(sys.argv[5]) if len(sys.argv) > 5 else 1750

a = Image.open(before_p).convert("RGB")
b = Image.open(after_p).convert("RGB")
w = a.size[0]
ca = a.crop((0, y0, w, y1))
cb = b.crop((0, y0, w, y1))

gap = 20
h = ca.size[1]
canvas = Image.new("RGB", (w * 2 + gap, h + 60), (255, 255, 255))
canvas.paste(ca, (0, 60))
canvas.paste(cb, (w + gap, 60))

d = ImageDraw.Draw(canvas)
d.text((10, 10), "BEFORE click: keyboard up (no toast)", fill=(0, 0, 0))
d.text((w + gap + 10, 10), "AFTER click: toast visible (keyboard gone)", fill=(0, 0, 0))
canvas.save(out_p)
print("wrote", out_p, canvas.size)
