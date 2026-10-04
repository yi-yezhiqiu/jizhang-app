"""点完立刻读状态，避免时序把键盘"等没"了。

用法: python tools/tap_probe.py <x> <y>
"""
import json
import subprocess
import sys
import time

ADB = r"D:\android-sdk\platform-tools\adb.exe"


def adb(args, binary=False):
    p = subprocess.run([ADB] + args, capture_output=True)
    if binary:
        return p.stdout
    return (p.stdout or b"").decode("utf-8", "replace")


def ime_shown():
    out = adb(["shell", "dumpsys", "input_method"])
    for line in out.splitlines():
        if "mInputShown=" in line:
            return line.strip()
    return "(not found)"


def main():
    x, y = sys.argv[1], sys.argv[2]
    print("before:", ime_shown())

    # 点击后立刻连续采样，抓键盘出现的瞬间
    p = subprocess.Popen([ADB, "shell", "input", "tap", str(x), str(y)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    samples = []
    t0 = time.time()
    while time.time() - t0 < 4.0:
        samples.append((round(time.time() - t0, 2), ime_shown()))
        time.sleep(0.25)
    p.wait()

    print("samples after tap:")
    for t, s in samples:
        print(f"  t={t}s  {s}")


if __name__ == "__main__":
    main()
