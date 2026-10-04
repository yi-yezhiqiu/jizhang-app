"""一次完成：打开存入弹层 → 取坐标 → 真实点击 → 连续采样键盘状态。

关键点：打开弹层后立刻点击，中间不让任何其它动作破坏弹层状态。

用法: python tools/open_and_tap.py
"""
import json
import re
import subprocess
import sys
import time

ADB = r"D:\android-sdk\platform-tools\adb.exe"
NODE = r"D:\nodejs\node.exe"
CDP = r"D:\手机记账app\tools\cdp_eval.mjs"

OPEN_GOALS_AND_SHEET = """(function(){
  var tabs=document.querySelectorAll('.tab');
  for(var i=0;i<tabs.length;i++){ if(tabs[i].getAttribute('data-page')==='goals') tabs[i].click(); }
  var btns=document.querySelectorAll('button');
  var dep=null;
  for(var i=0;i<btns.length;i++){ if((btns[i].textContent||'').trim()==='存入') dep=btns[i]; }
  if(!dep) return 'NO_DEPOSIT_BTN';
  dep.click();
  var m=document.getElementById('savedMask');
  var inp=document.getElementById('savedAmountInput');
  if(!inp||m.hidden) return 'SHEET_NOT_OPEN';
  var r=inp.getBoundingClientRect();
  var d=window.devicePixelRatio||1;
  return JSON.stringify({x:Math.round((r.left+r.right)/2*d), y:Math.round((r.top+r.bottom)/2*d),
                         cssTop:Math.round(r.top), cssBottom:Math.round(r.bottom)});
})()"""

STATE = """(function(){
  var a=document.activeElement;
  var vv=window.visualViewport;
  return JSON.stringify({
    bodyClass: document.body.className||'(空)',
    active: a?(a.id||a.tagName):null,
    innerH: window.innerHeight,
    vvH: vv?Math.round(vv.height):null,
    sheetOpen: !document.getElementById('savedMask').hidden
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
            return line.strip()
    return "(not found)"


print("=== 步骤1：打开存入弹层并取坐标 ===")
res = cdp(OPEN_GOALS_AND_SHEET)
print("  ", res)
if not res.startswith("{"):
    print("无法打开弹层，终止")
    sys.exit(1)
pt = json.loads(res)
print(f"   输入框 CSS y={pt['cssTop']}..{pt['cssBottom']}，将点击物理点 ({pt['x']}, {pt['y']})")

print("=== 步骤2：点击前状态 ===", ime())
print("  ", cdp(STATE))

print("=== 步骤3：真实点击 + 连续采样 ===")
p = subprocess.Popen([ADB, "shell", "input", "tap", str(pt["x"]), str(pt["y"])],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
t0 = time.time()
while time.time() - t0 < 3.5:
    print(f"   t={round(time.time()-t0,2)}s  {ime()}")
    time.sleep(0.3)
p.wait()

print("=== 步骤4：点击后页面状态 ===")
print("  ", cdp(STATE))
