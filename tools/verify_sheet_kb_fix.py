"""验证弹层键盘态修复：真实触摸弹起键盘 → 量位置 → 收键盘 → 看是否复位。

用法: python tools/verify_sheet_kb_fix.py
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

MEASURE = """(function(){
  var sheet=document.querySelector('#savedMask .sheet');
  var inp=document.getElementById('savedAmountInput');
  var ok=document.getElementById('savedOk');
  var r=sheet.getBoundingClientRect();
  var ri=inp?inp.getBoundingClientRect():null;
  var ro=ok?ok.getBoundingClientRect():null;
  var cs=getComputedStyle(sheet);
  return JSON.stringify({
    bodyClass: document.body.className||'(空)',
    sheetKbOpen: document.body.classList.contains('sheet-kb-open'),
    sheetPaddingBottom: cs.paddingBottom,
    guardVar: document.body.style.getPropertyValue('--sheet-guard')||'(未设置)',
    sheetTop: Math.round(r.top), sheetBottom: Math.round(r.bottom),
    inputTop: ri?Math.round(ri.top):null, inputBottom: ri?Math.round(ri.bottom):null,
    okTop: ro?Math.round(ro.top):null, okBottom: ro?Math.round(ro.bottom):null,
    innerH: window.innerHeight,
    active: document.activeElement?(document.activeElement.id||document.activeElement.tagName):null,
    sheetOpen: !document.getElementById('savedMask').hidden
  });
})()"""


def sh(args):
    p = subprocess.run(args, capture_output=True)
    return (p.stdout or b"").decode("utf-8", "replace").strip()


def cdp(expr=None, path=None):
    args = [NODE, CDP]
    args += ["--file", path] if path else [expr]
    p = subprocess.run(args, capture_output=True)
    return (p.stdout or b"").decode("utf-8", "replace").strip()


def ime():
    out = sh([ADB, "shell", "dumpsys", "input_method"])
    for line in out.splitlines():
        if "mInputShown=" in line:
            return line.split("mInputShown=")[1].split()[0]
    return "?"


def measure(tag):
    print(f"--- {tag} ---")
    print("   IME:", ime())
    print("   ", cdp(MEASURE))


print("=== 1) 打开存入弹层 ===")
res = cdp(OPEN_SHEET)
print("   ", res)
if not res.startswith("{"):
    print("打开失败，终止")
    sys.exit(1)
pt = json.loads(res)

measure("键盘未弹起（基线）")

print("=== 2) 真实触摸输入框，弹起键盘 ===")
subprocess.run([ADB, "shell", "input", "tap", str(pt["x"]), str(pt["y"])],
               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(2.5)
measure("键盘弹起后")

print("=== 3) 按返回键收起键盘（不点确定）===")
subprocess.run([ADB, "shell", "input", "keyevent", "KEYCODE_BACK"],
               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)
measure("收键盘后 t=1.5s")
time.sleep(2.0)
measure("收键盘后 t=3.5s")
