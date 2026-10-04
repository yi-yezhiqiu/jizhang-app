"""从 index.html 抽出所有 id 与标签，给 DOM stub 用（避免 PowerShell 引号问题）。"""
import re
import sys

html = open(r"app\src\main\assets\www\index.html", encoding="utf-8").read()
ids = sorted(set(re.findall(r'id="([^"]+)"', html)))
tags = {}
for m in re.finditer(r"<(\w+)([^>]*?)>", html):
    tag, attrs = m.group(1), m.group(2)
    im = re.search(r'id="([^"]+)"', attrs)
    if im:
        tags[im.group(1)] = tag
# 每个 id 上是否有 type / class 之类的属性（sanitizeAmount 等需要）
extra = {}
for m in re.finditer(r"<(\w+)([^>]*?)>", html):
    attrs = m.group(2)
    im = re.search(r'id="([^"]+)"', attrs)
    if not im:
        continue
    i = im.group(1)
    e = {}
    tm = re.search(r'type="([^"]+)"', attrs)
    if tm:
        e["type"] = tm.group(1)
    cm = re.search(r'class="([^"]+)"', attrs)
    if cm:
        e["className"] = cm.group(1)
    extra[i] = e

print(ids)
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    import json
    json.dump({"ids": ids, "tags": tags, "extra": extra}, fh, ensure_ascii=False, indent=1)
print("wrote", sys.argv[1], len(ids), "ids")
