"""首页记账面板：真实触摸验证键盘弹起/收起行为。

用法: python tools/verify_home_kb_real.py
"""
import json
import subprocess
import sys
import time

ADB = r"D:\android-sdk\platform-tools\adb.exe"
NODE = r"D:\nodejs\node.exe"
CDP = r"D:\手机记账app\tools\cdp_eval.mjs"

HOME = """(function(){
  var tabs=document.querySelectorAll('.tab');
  for(var i=0;i<tabs.length;i++){ if(tabs[i].getAttribute('data-page')==='home') tabs[i].click(); }
  var ai=document.getElementById('amountInput');
  var r=ai.getBoundingClientRect();
  var d=window.devicePixelRatio||1;
  return JSON.stringify({x:Math.round((r.left+r.right)/2*d), y:Math.round((r.top+r.bottom)/2*d),
                         bridge:window.__jzIme?window.__jzIme.height():null});
})()"""

MEASURE = """(function(){
  var ez=document.getElementById('entryZone');
  var ai=document.getElementById('amountInput');
  var tr=document.getElementById('topRow');
  var r=ez.getBoundingClientRect();
  var ra=ai.getBoundingClientRect();
  var rt=tr.getBoundingClientRect();
  return JSON.stringify({
    kbOpen: document.body.classList.contains('kb-open'),
    bridgeH: window.__jzIme?window.__jzIme.height():null,
    entryTop: Math.round(r.top), entryBottom: Math.round(r.bottom),
    inlineBottom: ez.style.bottom||'(空)',
    amountVisible: ra.height>0 && getComputedStyle(ai).display!=='none',
    amountTop: Math.round(ra.top), amountBottom: Math.round(ra.bottom),
    重叠: Math.round(rt.bottom)>Math.round(r.top),
    可见行: [].filter.call(ez.children,function(c){return getComputedStyle(c).display!=='none';}).map(function(c){return c.id||c.className;}),
    active: document.activeElement?(document.activeElement.id||document.activeElement.tagName):null
  });
})()"""


def sh(a):
    p = subprocess.run(a, capture_output=True)
    return (p.stdout or b"").decode("utf-8", "replace").strip()


def cdp(e):
    p = subprocess.run([NODE, CDP, e], capture_output=True)
    return (p.stdout or b"").decode("utf-8", "replace").strip()


def ime():
    out = sh([ADB, "shell", "dumpsys", "input_method"])
    for line in out.splitlines():
        if "mInputShown=" in line:
            return line.split("mInputShown=")[1].split()[0]
    return "?"


def measure(tag):
    print(f"--- {tag} (IME={ime()}) ---")
    s = cdp(MEASURE)
    print("   ", s if s else "CDP 无响应")
    return s


res = cdp(HOME)
print("首页坐标:", res)
pt = json.loads(res)

measure("初始")
print("=== 触摸金额框 ===")
subprocess.run([ADB, "shell", "input", "tap", str(pt["x"]), str(pt["y"])],
               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(2.5)
measure("键盘弹起")

print("=== 按返回键收键盘 ===")
subprocess.run([ADB, "shell", "input", "keyevent", "KEYCODE_BACK"],
               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)
measure("收键盘 t=1.5s")
time.sleep(2.0)
measure("收键盘 t=3.5s")
