"""生成记账 App 的配色方案预览图。

用途：给用户挑选配色。直接画出真实界面的样子（顶部汇总条、流水列表、
记账面板、分类标签、底部导航），比只给色卡直观得多。

用法: python tools/make_palettes.py [输出目录]
"""

import os
import sys

from PIL import Image, ImageDraw, ImageFont

W, H = 900, 1600          # 单张预览图尺寸
OUT_DIR = sys.argv[1] if len(sys.argv) > 1 else "."

FONT_REG = r"C:\Windows\Fonts\msyh.ttc"
FONT_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"

_cache = {}


def font(size, bold=False):
    key = (size, bold)
    if key not in _cache:
        path = FONT_BOLD if bold else FONT_REG
        try:
            _cache[key] = ImageFont.truetype(path, size)
        except OSError:
            _cache[key] = ImageFont.load_default()
    return _cache[key]


SCHEMES = [
    {
        "id": "A",
        "name": "现存配色（深蓝灰）",
        "note": "偏冷、偏商务，就是你觉得像股票软件的那个",
        "bg": "#0f1620", "bg_soft": "#1a2332", "bg_input": "#212c3d",
        "line": "#2b3a4f", "text": "#eef2f7", "dim": "#93a1b5",
        "faint": "#64748b", "expense": "#f87171", "income": "#4ade80",
        "accent": "#4f9cf9",
    },
    {
        "id": "B",
        "name": "暖夜（深棕 + 琥珀）",
        "note": "暖色调，像笔记本与咖啡，最不像行情软件",
        "bg": "#1c1917", "bg_soft": "#292524", "bg_input": "#332e2b",
        "line": "#3f3936", "text": "#f5f1ec", "dim": "#a8a29e",
        "faint": "#78716c", "expense": "#fb923c", "income": "#86efac",
        "accent": "#f59e0b",
    },
    {
        "id": "C",
        "name": "墨色（纯灰黑 + 珊瑚）",
        "note": "去掉所有冷蓝，干净克制、偏高级感",
        "bg": "#101012", "bg_soft": "#1a1a1e", "bg_input": "#232328",
        "line": "#2e2e34", "text": "#f0f0f2", "dim": "#9a9aa2",
        "faint": "#6b6b73", "expense": "#ff8a80", "income": "#7ee0a8",
        "accent": "#e5e5e7",
    },
    {
        "id": "D",
        "name": "纸感（浅色 + 琥珀）",
        "note": "米白纸张感，白天看最舒服；夜里偏亮",
        "bg": "#faf7f2", "bg_soft": "#f2ede4", "bg_input": "#ffffff",
        "line": "#e2dbd0", "text": "#2b2622", "dim": "#7a7167",
        "faint": "#a89e92", "expense": "#d97706", "income": "#059669",
        "accent": "#b45309",
    },
    {
        "id": "E",
        "name": "深海（青绿 + 珊瑚）",
        "note": "深色但不冷，有生活感；青色做点缀",
        "bg": "#0b1a1c", "bg_soft": "#122528", "bg_input": "#1a3034",
        "line": "#264045", "text": "#ecf5f5", "dim": "#8fb0b2",
        "faint": "#5f8386", "expense": "#ff8a65", "income": "#34d399",
        "accent": "#2dd4bf",
    },
]


def draw_scheme(s):
    img = Image.new("RGB", (W, H), s["bg"])
    d = ImageDraw.Draw(img)

    def rr(box, r, fill, outline=None, width=1):
        d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)

    M = 36                      # 页面左右边距
    y = 0

    # ---- 状态栏占位 ----
    d.text((M, 28), "16:30", font=font(26, True), fill=s["text"])
    d.text((W - M - 60, 28), "86%", font=font(24), fill=s["dim"])
    y = 78

    # ---- 顶部：收支切换 + 日期 ----
    rr((M, y, M + 230, y + 74), 16, s["bg_input"])
    rr((M + 6, y + 6, M + 116, y + 68), 12, s["accent"])
    d.text((M + 34, y + 22), "支出", font=font(28, True), fill=s["bg"])
    d.text((M + 136, y + 22), "收入", font=font(28), fill=s["dim"])
    rr((W - M - 190, y + 8, W - M, y + 66), 14, s["bg_input"], s["line"])
    d.text((W - M - 168, y + 24), "今天 ▾", font=font(26), fill=s["dim"])
    y += 100

    # ---- 顶部汇总条 ----
    rr((0, y, W, y + 132), 0, s["bg_soft"])
    d.line((0, y + 132, W, y + 132), fill=s["line"], width=2)
    cols = [("10月支出", "1,286", s["expense"]),
            ("10月收入", "8,000", s["income"]),
            ("结余", "6,714", s["accent"])]
    for i, (label, val, col) in enumerate(cols):
        cx = W * (2 * i + 1) / 6
        d.text((cx, y + 26), label, font=font(24), fill=s["dim"], anchor="mm")
        d.text((cx, y + 78), val, font=font(40, True), fill=col, anchor="mm")
    y += 132 + 16

    # ---- 流水列表 ----
    d.text((M, y), "今天", font=font(26), fill=s["dim"])
    d.text((W - M, y), "-56", font=font(26), fill=s["dim"], anchor="ra")
    y += 48

    records = [
        ("🍜", "餐饮", "午餐", "-25", s["expense"]),
        ("🚌", "交通", "地铁", "-3", s["expense"]),
        ("💰", "工资", "月薪", "+8,000", s["income"]),
    ]
    for ico, cat, note, amt, col in records:
        rr((M, y, M + 84, y + 84), 18, s["bg_input"])
        d.text((M + 42, y + 42), ico, font=font(40), anchor="mm")
        d.text((M + 108, y + 16), cat, font=font(30), fill=s["text"])
        d.text((M + 108, y + 54), note, font=font(23), fill=s["faint"])
        d.text((W - M, y + 30), amt, font=font(34, True), fill=col, anchor="ra")
        y += 100
        d.line((M, y - 8, W, y - 8), fill=s["line"], width=1)

    # ---- 记账面板 ----
    panel_top = H - 560
    rr((0, panel_top, W, H), 0, s["bg_soft"])
    d.line((0, panel_top, W, panel_top), fill=s["line"], width=2)

    py = panel_top + 28
    # 金额
    d.text((M, py + 10), "¥", font=font(38), fill=s["faint"])
    d.text((W - M, py), "128.50", font=font(66, True), fill=s["text"], anchor="ra")
    py += 108

    # 分类标签（画一行半，体现可以横向滑动 + 右侧渐隐）
    cats = [("🍜", "餐饮", True), ("🚌", "交通", False), ("🛍️", "购物", False),
            ("🏠", "居住", False), ("🎮", "娱乐", False), ("💊", "医疗", False)]
    cx = M
    for ico, name, active in cats:
        bw = 132
        if cx + bw > W - 10:
            break
        if active:
            rr((cx, py, cx + bw, py + 118), 20, s["bg_input"], s["accent"], 3)
        else:
            rr((cx, py, cx + bw, py + 118), 20, s["bg_input"], s["line"], 2)
        d.text((cx + bw / 2, py + 40), ico, font=font(36), anchor="mm")
        d.text((cx + bw / 2, py + 86), name, font=font(24),
               fill=s["text"] if active else s["dim"], anchor="mm")
        cx += bw + 14
    # 右侧渐隐，暗示还有更多
    soft_rgb = tuple(int(s["bg_soft"][j:j + 2], 16) for j in (1, 3, 5))
    input_rgb = tuple(int(s["bg_input"][j:j + 2], 16) for j in (1, 3, 5))
    for i in range(40):
        a = i / 40.0
        col = tuple(int(round(input_rgb[k] * (1 - a) + soft_rgb[k] * a)) for k in range(3))
        d.line((W - 40 + i, py, W - 40 + i, py + 118), fill=col)
    py += 142

    # 备注 + 保存
    rr((M, py, W - M - 190, py + 92), 18, s["bg_input"], s["line"], 2)
    d.text((M + 28, py + 30), "备注（可不填）", font=font(28), fill=s["faint"])
    rr((W - M - 172, py, W - M, py + 92), 18, s["accent"])
    d.text((W - M - 86, py + 46), "保存", font=font(32, True), fill=s["bg"], anchor="mm")

    # ---- 底部导航 ----
    nav_top = H - 150
    rr((0, nav_top, W, H), 0, s["bg_soft"])
    d.line((0, nav_top, W, nav_top), fill=s["line"], width=2)
    for i, (ico, name, active) in enumerate([("✏️", "记一笔", True),
                                             ("📊", "本月", False),
                                             ("⚙️", "设置", False)]):
        cx = W * (2 * i + 1) / 6
        col = s["accent"] if active else s["faint"]
        d.text((cx, nav_top + 46), ico, font=font(34), anchor="mm")
        d.text((cx, nav_top + 96), name, font=font(23), fill=col, anchor="mm")

    return img


def draw_header(s, width, height):
    """为每张图配一条标题条"""
    img = Image.new("RGB", (width, height), "#ffffff")
    d = ImageDraw.Draw(img)
    d.rectangle((0, 0, 14, height), fill=s["accent"])
    d.text((34, 20), f"方案 {s['id']} · {s['name']}", font=font(40, True), fill="#111111")
    d.text((34, 78), s["note"], font=font(27), fill="#555555")
    return img


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    made = []

    for s in SCHEMES:
        body = draw_scheme(s)
        hdr = draw_header(s, W, 130)
        full = Image.new("RGB", (W, H + 130), "#ffffff")
        full.paste(hdr, (0, 0))
        full.paste(body, (0, 130))
        p = os.path.join(OUT_DIR, f"配色方案{s['id']}.png")
        full.save(p)
        made.append(p)
        print("已生成 " + p)

    # 一张总览：五个方案并排（缩略）
    thumb_w = 300
    scale = thumb_w / W
    thumb_h = int((H + 130) * scale)
    gap = 18
    grid = Image.new("RGB", (thumb_w * 5 + gap * 6, thumb_h + gap * 2 + 60), "#f2f2f2")
    gd = ImageDraw.Draw(grid)
    gd.text((gap, 18), "五种配色方案对比（点击单张可看全尺寸）",
            font=font(30, True), fill="#222222")
    for i, s in enumerate(SCHEMES):
        thumb = Image.open(made[i]).resize((thumb_w, thumb_h), Image.LANCZOS)
        grid.paste(thumb, (gap + i * (thumb_w + gap), 60 + gap))
    grid_path = os.path.join(OUT_DIR, "配色方案总览.png")
    grid.save(grid_path)
    print("已生成 " + grid_path)


if __name__ == "__main__":
    main()
