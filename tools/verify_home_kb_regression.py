"""回归验证（稳健版）：首页记账面板键盘行为是否仍正常。

要点：
 · 每次点击前重新取坐标（键盘会改变布局，旧坐标会失效）
 · 点击后轮询等键盘真的弹起来，再继续
 · 不用返回键（返回键会触发页面导航、打断 CDP 连接），改用触摸其它区域收键盘

用法: python tools/verify_home_kb_regression.py
"""
import json
import subprocess
import sys
import time

ADB = r"D:\android-sdk\platform-tools\adb.exe"
NODE = r"D:\nodejs\node.exe"
CDP = r"D:\手机记账app\tools\cdp_eval.mjs"

ENSURE_HOME = """(function(){
  var tabs=document.querySelectorAll('.tab');
  for(var i=0;i<tabs.length;i++){ if(tabs[i].getAttribute('data-page')==='home') tabs[i].click(); }
  return 'home';
})()"""

AMOUNT_PT = """(function(){
  var ai=document.getElementById('amountInput');
  var r=ai.getBoundingClientRect();
  var d=window.devicePixelRatio||1;
  return JSON.stringify({x:Math.round((r.left+r.right)/2*d), y:Math.round((r.top+r.bottom)/2*d)});
})()"""

MEASURE = """(function(){
  var ez=document.getElementById('entryZone');
  var ai=document.getElementById('amountInput');
  var tr=document.getElementById('topRow');
  var r=ez.getBoundingClientRect();
  var ra=ai.getBoundingClientRect();
  var rt=tr.getBoundingClientRect();
  return JSON.stringify({
    bodyClass: document.body.className||'(空)',
    kbOpen: document.body.classList.contains('kb-open'),
    entryTop: Math.round(r.top), entryBottom: Math.round(r.bottom),
    amountVisible: ra.height>0 && getComputedStyle(ai).display!=='none',
    amountTop: Math.round(ra.top), amountBottom: Math.round(ra.bottom),
    topRowBottom: Math.round(rt.bottom),
    收发切换行与面板重叠: Math.round(rt.bottom) > Math.round(r.top),
    innerH: window.innerHeight,
    可见行: [].filter.call(ez.children, function(c){return getComputedStyle(c).display!=='none';}).map(function(c){return c.id||c.className;}),
    active: document.activeElement?(document.activeElement.id||document.activeElement.tagName):null
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


def wait_ime(want, timeout=6.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if ime() == want:
            return True
        time.sleep(0.3)
    return False


def tap(x, y):
    subprocess.run([ADB, "shell", "input", "tap", str(x), str(y)],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def measure(tag):
    s = cdp(MEASURE)
    if not s:
        print(f"--- {tag}: CDP 无响应（页面可能已重建）")
        return None
    print(f"--- {tag} (IME={ime()}) ---")
    print("   ", s)
    return s


print("=== 0) 回到首页 ===", cdp(ENSURE_HOME))
time.sleep(0.5)
measure("首页初始")

print("=== 1) 触摸金额框 ===")
pt = json.loads(cdp(AMOUNT_PT))
tap(pt["x"], pt["y"])
ok = wait_ime("true")
print(f"    键盘弹起: {ok}")
time.sleep(0.8)
measure("键盘弹起")

print("=== 2) 触摸顶部空白区收键盘（不用返回键）===")
tap(206, 60)   # 顶部收支切换行附近之外的空白
time.sleep(1.2)
if ime() == "true":
    # 换成触摸面板外的列表区
    tap(206, 300)
    time.sleep(1.2)
print(f"    键盘已收起: {ime()=='false'}")
time.sleep(1.0)
measure("收键盘后")

print("=== 3) 键盘弹起时收支切换是否可点 ===")
pt = json.loads(cdp(AMOUNT_PT))
tap(pt["x"], pt["y"])
wait_ime("true")
time.sleep(0.8)
res = cdp("""(function(){
  var btns=document.getElementById('typeSwitch').getElementsByTagName('button');
  var income=null;
  for(var i=0;i<btns.length;i++){ if(btns[i].getAttribute('data-type')==='income') income=btns[i]; }
  var before=document.querySelector('#typeSwitch .is-active').getAttribute('data-type');
  income.click();
  var after=document.querySelector('#typeSwitch .is-active').getAttribute('data-type');
  return JSON.stringify({切换前:before, 切换后:after, 切换成功:before!==after, 键盘仍在:document.body.classList.contains('kb-open')});
})()""")
print("   ", res)

print("=== 4) 一次触摸保存是否仍然只记一笔 ===")
res = cdp("""(function(){
  var ai=document.getElementById('amountInput');
  ai.value='88'; ai.dispatchEvent(new Event('input',{bubbles:true}));
  var btn=document.getElementById('saveBtn');
  var cnt=function(){return window.Store.Records.all().length;};
  var pos=function(){return Math.round(document.getElementById('entryZone').getBoundingClientRect().top);};
  var before={n:cnt(), top:pos()};
  var ts=new TouchEvent('touchstart',{bubbles:true,cancelable:true});
  btn.dispatchEvent(ts);
  var mid={n:cnt(), top:pos(), prevented:ts.defaultPrevented};
  btn.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
  var after={n:cnt(), top:pos()};
  return JSON.stringify({触摸前:before, 触摸后:mid, 点击后:after,
    位置未变: before.top===mid.top && mid.top===after.top,
    只记一笔: (mid.n-before.n)===1 && (after.n-mid.n)===0});
})()""")
print("   ", res)
