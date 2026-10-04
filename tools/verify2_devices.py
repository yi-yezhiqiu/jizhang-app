"""adb 批处理执行器（给 verify2_e2e.mjs 用）。

Node 在本沙箱里无法用 Piped stdio 启动子进程（spawn EPERM），
所以由 node 把要在设备上执行的动作写成 JSON，python 依次执行 adb
并把每条的输出写回结果文件；node 只读写文件，不捕获子进程管道。
"""
import json
import subprocess
import sys
import time

ADB = r"D:\android-sdk\platform-tools\adb.exe"


def run_adb(args):
    p = subprocess.run([ADB] + args, capture_output=True, text=False)
    out = p.stdout.decode("utf-8", "replace") if p.stdout else ""
    err = p.stderr.decode("utf-8", "replace") if p.stderr else ""
    return {"args": args, "code": p.returncode, "stdout": out, "stderr": err}


def main():
    if len(sys.argv) < 3:
        print("usage: py verify2_devices.py <spec.json> <result.json>")
        return 2
    spec_path, result_path = sys.argv[1], sys.argv[2]
    with open(spec_path, "r", encoding="utf-8") as fh:
        spec = json.load(fh)

    results = []
    for item in spec:
        kind = item.get("kind")
        if kind == "adb":
            results.append(run_adb(item.get("args", [])))
        elif kind == "sleep":
            time.sleep(item.get("seconds", 0.3))
            results.append({"args": ["sleep"], "code": 0, "stdout": "", "stderr": ""})
        elif kind == "screencap":
            out = item.get("out")
            with open(out, "wb") as fh:
                p = subprocess.run([ADB, "exec-out", "screencap", "-p"], stdout=fh)
            results.append({"args": ["screencap"], "code": p.returncode, "stdout": out,
                            "stderr": "" if p.returncode == 0 else "screencap failed"})
        else:
            results.append({"args": [str(kind)], "code": 1, "stdout": "", "stderr": "unknown action"})

    with open(result_path, "w", encoding="utf-8") as fh:
        json.dump(results, fh, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
