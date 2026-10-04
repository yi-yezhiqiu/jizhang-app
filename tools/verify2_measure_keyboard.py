"""从截图里量键盘上沿（像素级证据，不靠 dumpsys frame 的猜测）。

做法：键盘区域（浅色 #F*F*F* 一类的面板色）在整幅图里是一大片均匀亮区，
从上往下扫每一行的平均亮度，找到「亮度突然跳升并且之后保持高位」的那一行，
即键盘面板的上沿。同时输出该行前后的采样值，便于人工核对。

用法: python tools/verify2_measure_keyboard.py <png> [dpr] [out.json]
      给了 out.json 就把结果写文件（node 在本沙箱里无法用管道捕获子进程输出，
      只能靠文件回传）。
"""
import json
import sys

from PIL import Image

PNG = sys.argv[1]
DPR = float(sys.argv[2]) if len(sys.argv) > 2 else 2.625
OUT_JSON = sys.argv[3] if len(sys.argv) > 3 else None

im = Image.open(PNG).convert("L")
w, h = im.size
px = im.load()

# 每一行的平均亮度（只取中间 80% 宽度，避开左右边缘）
x0, x1 = int(w * 0.1), int(w * 0.9)
rows = []
for y in range(h):
    s = 0
    for x in range(x0, x1, 4):
        s += px[x, y]
    rows.append(s / ((x1 - x0) // 4 + 1))

# 键盘面板很亮（接近 240+），被遮挡的页面区域偏灰（~170）
THRESH = 225
kb_top = None
run = 0
for y in range(h - 1, -1, -1):
    if rows[y] >= THRESH:
        run += 1
    else:
        if run > 200:          # 从底部往上，连续亮点足够长才算键盘面板
            kb_top = y + 1
            break
        run = 0
if kb_top is None:
    for y in range(h):
        if rows[y] >= THRESH:
            kb_top = y
            break

result = {
    "image": f"{w}x{h}",
    "dpr": DPR,
    "keyboard_top_physical": kb_top,
    "keyboard_top_css": round(kb_top / DPR, 2) if kb_top is not None else None,
    "keyboard_height_physical": (h - kb_top) if kb_top is not None else None,
    "keyboard_height_css": round((h - kb_top) / DPR, 2) if kb_top is not None else None,
}
print(f"image {w}x{h}")
print(f"keyboard panel top (physical px) = {kb_top}")
if kb_top is not None:
    print(f"keyboard panel top (CSS px, /{DPR}) = {round(kb_top / DPR, 2)}")
    print(f"keyboard height (physical) = {h - kb_top}   (CSS = {round((h - kb_top) / DPR, 2)})")
print("\nrow brightness samples (y, avg) around the boundary:")
lo = max(0, (kb_top or 0) - 60)
for y in range(lo, min(h, (kb_top or 0) + 40), 10):
    mark = "  <== keyboard top" if kb_top is not None and abs(y - kb_top) < 5 else ""
    print(f"  y={y:5d}  css={round(y / DPR, 1):7.1f}  avg={rows[y]:6.1f}{mark}")

if OUT_JSON:
    with open(OUT_JSON, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=1)
    print(f"wrote {OUT_JSON}")
