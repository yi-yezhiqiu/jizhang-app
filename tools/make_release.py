"""创建 GitHub Release 并上传 APK。

token 从环境变量 GH_TOKEN 读取，不写进这个文件。

用法: python tools/make_release.py
"""
import json
import os
import sys
import urllib.request
import urllib.error

REPO = "yi-yezhiqiu/jizhang-app"
TAG = "v1.0"
NAME = "v1.0 — 首个版本"
APK = r"D:\手机记账app\build\jizhang.apk"
ASSET_NAME = "JiZhang.apk"

BODY = """首个可安装版本。

## 功能

- **记一笔**：系统数字键盘、分类点选、日期快捷，记完保留分类与日期方便连续记账
- **流水**：按日分组带小计，点记录可编辑或删除
- **本月**：收支汇总、每日支出柱状图、分类占比排名、月份切换
- **攒钱目标**：按「存入 / 取出」逐笔记录，已攒金额自动汇总，
  并根据最近三个月的真实结余估算「还需几个月」
- **可支配金额**：总余额 − 已攒合计，即现在真正能动用的钱
- **分类管理**：增删分类，▲▼ 同组排序

## 特点

- **完全离线**：不发起任何网络请求，断网照常用
- **零权限**：`uses-permission` 数量为 0
- **无依赖**：原生 HTML/CSS/JS，无框架、无 npm 包、无 Maven 依赖
- **不用 Gradle**：手工 aapt2 打包，构建十几秒

## 安装

下载下方 `JiZhang.apk`，在手机上打开并按提示允许「安装未知应用」。

**系统要求**：Android 5.0（API 21）或更高（实测仅在 Android 15 上完整验证）。

## 注意

- 使用 **debug 签名**，仅供侧载自用，不上架应用商店
- **没有导出/备份功能**。卸载 App 或清除数据会**永久丢失所有记录**

## 校验

```
SHA256  {sha256}
大小    {size} 字节
```

详见 [README](../../blob/main/README.md)。
"""


def api(path, method="GET", data=None, raw=None, ctype="application/json"):
    token = os.environ.get("GH_TOKEN")
    if not token:
        sys.exit("缺少环境变量 GH_TOKEN")
    url = path if path.startswith("http") else "https://api.github.com" + path
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
    elif raw is not None:
        body = raw
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("User-Agent", "jizhang-release")
    req.add_header("Accept", "application/vnd.github+json")
    if body is not None:
        req.add_header("Content-Type", ctype)
        req.add_header("Content-Length", str(len(body)))
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            text = resp.read().decode("utf-8", "replace")
            return resp.status, (json.loads(text) if text.strip() else {})
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def main():
    import hashlib

    with open(APK, "rb") as fh:
        blob = fh.read()
    sha = hashlib.sha256(blob).hexdigest().upper()
    size = len(blob)
    print(f"APK: {size} 字节  SHA256={sha}")

    body = BODY.replace("{sha256}", sha).replace("{size}", str(size))

    # 1) 创建 release
    status, res = api(f"/repos/{REPO}/releases", "POST", {
        "tag_name": TAG,
        "target_commitish": "main",
        "name": NAME,
        "body": body,
        "draft": False,
        "prerelease": False,
    })
    print(f"[1] 创建 release -> HTTP {status}")
    if status == 422:
        print("    tag 已存在，尝试取回已有的 release")
        status2, res = api(f"/repos/{REPO}/releases/tags/{TAG}")
        print(f"    取回 -> HTTP {status2}")
        if status2 != 200:
            print("    ", res)
            return 1
    elif status not in (200, 201):
        print("    ", res)
        return 1

    release_id = res.get("id")
    upload_url = res.get("upload_url", "")
    print(f"    release id = {release_id}")
    print(f"    html_url   = {res.get('html_url')}")

    # 2) 上传 APK
    if "{" in upload_url:
        up = upload_url.split("{")[0]
    else:
        up = upload_url
    up = up + f"?name={ASSET_NAME}"
    status3, res3 = api(up, "POST", raw=blob, ctype="application/vnd.android.package-archive")
    print(f"[2] 上传 APK -> HTTP {status3}")
    if status3 in (200, 201):
        print(f"    资产地址: {res3.get('browser_download_url')}")
        print(f"    资产大小: {res3.get('size')} 字节")
    else:
        print("    ", res3)
        return 1

    print("\n完成。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
