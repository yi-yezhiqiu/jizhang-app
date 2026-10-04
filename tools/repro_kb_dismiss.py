"""复现用户报告的场景：弹层键盘弹起后，不点确定、直接用系统返回键/收起键收键盘，
   观察界面状态是否复位。

用法: python tools/repro_kb_dismiss.py
"""
import json
import subprocess
import sys
import time

ADB = r"D:\android-sdk\platform-tools\adb.exe"
NODE = r"D:\nodejs\node.exe"
CDP = r"D:\手机记账app\tools\cdp_eval.mjs"

OPEN_SHEET = """(function(){
  var tabs=document.querySelectorAll('.tab');
  for(var i=0;i<tabs.length;i++){ if(tabs[i].getAttribute('data-page')==='goals') tabs[i].click(); }
  var btns=document.querySelectorAll('button');
  var dep=null;
  for(var i=0;i<btns.length;i++){ if((btns[i].textContent||'').trim()==='存入') dep=btns[i]; }
  if(!dep) return 'NO_BTN';
  dep.click();
  var inp=document.getElementById('savedAmountInput');
  var m=document.getElementById('savedMask');
  if(!inp||m.hidden) return 'SHEET_NOT_OPEN';
  var r=inp.getBoundingClientRect();
  var d=window.devicePixelRatio||1;
  return JSON.stringify({x:Math.round((r.left+r.right)/2*d), y:Math.round((r.top+r.bottom)/2*d)});
})()"""

STATE = """(function(){
  var a=document.activeElement;
  var vv=window.visualViewport;
  var sheet=document.querySelector('#savedMask .sheet');
  var sr=sheet?sheet.getBoundingClientRect():null;
  return JSON.stringify({
    bodyClass: document.body.className||'(空)',
    sheetKbOpen: document.body.classList.contains('sheet-kb-open'),
    active: a?(a.id||a.tagName):null,
    innerH: window.innerHeight,
    vvH: vv?Math.round(vv.height):null,
    sheetTop: sr?Math.round(sr.top):null,
    sheetBottom: sr?Math.round(sr.bottom):null,
    sheetOpen: !document.getElementById('savedMask').hidden,
    maskCount: document.querySelectorAll('.mask:not([hidden])').length
  });
})()"""


def sh(args):
    p = subprocess.run(args, capture_output=True)
    return (p.stdout or b"").decode("utf-8", "replace").strip()


def cdp(expr):
    p = subprocess.run([NODE, CDP, expr], capture_output=True)
    return (p.stdout or b"").decode("utf-8", "replace").strip()


def ime():
    out = sh([ADB, "shell", "dumpsys", "input_method"])
    for line in out.splitlines():
        if "mInputShown=" in line:
            return line.split("mInputShown=")[1].split()[0]
    return "?"


def state(tag):
    print(f"--- {tag} ---")
    print("   IME:", ime())
    print("   ", cdp(STATE))


# 1) 打开弹层并点出键盘
res = cdp(OPEN_SHEET)
if not res.startswith("{"):
    print("打开失败:", res)
    sys.exit(1)
pt = json.loads(res)
subprocess.run([ADB, "shell", "input", "tap", str(pt["x"]), str(pt["y"])],
               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(2.0)
state("键盘弹起后（基线）")

# 2) 用返回键收键盘（模拟用户按系统收起键）
print()
print("=== 动作：按系统返回键收起键盘（不点确定）===")
subprocess.run([ADB, "shell", "input", "keyevent", "KEYCODE_BACK"],
               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for i in range(6):
    time.sleep(0.5)
    print(f"   t={round((i+1)*0.5,1)}s  IME={ime()}")
state("返回键之后")

# 3) 再等 2 秒，看是否有延迟复位
print()
print("=== 再等 2 秒看是否有延迟复位 ===")
time.sleep(2.0)
state("延迟后")
