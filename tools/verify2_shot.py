"""verify2 截图工具：adb exec-out screencap -> 直接写宿主机文件。
PowerShell 的 > 会把二进制重编码成 UTF-16 破坏 PNG，因此走 python 的二进制管道。"""
import subprocess
import sys

ADB = r"D:\android-sdk\platform-tools\adb.exe"

def main():
    if len(sys.argv) < 2:
        print("usage: py shot.py <out.png>")
        return 2
    out = sys.argv[1]
    with open(out, "wb") as fh:
        p = subprocess.run([ADB, "exec-out", "screencap", "-p"], stdout=fh)
    print("wrote %s (adb exit=%d)" % (out, p.returncode))
    return 0

if __name__ == "__main__":
    sys.exit(main())
