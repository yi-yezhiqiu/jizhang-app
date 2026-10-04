/* t7 专项（快速版）：键盘保持弹起时，超额取出 toast 的精确坐标 + 键盘上沿对照。
   要点：点击「确定」后键盘可能很快收起，所以：
     - 键盘几何在点击**之前**量（那时 mInputShown=true）
     - 点击用 CDP 鼠标事件精确打到按钮中心，点击后**立刻**读 toast（toast 只显示 1900ms）

   用法: node tools/verify2_toast_kb2.mjs */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.CDP_PORT || 9222;
const OUT = 'verify2-out';
fs.mkdirSync(path.join(OUT, '_dev'), { recursive: true });
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
function runDevice(actions) {
  const n = ++seq;
  const spec = path.join(OUT, '_dev', `tk2-${n}-s.json`);
  const res = path.join(OUT, '_dev', `tk2-${n}-r.json`);
  fs.writeFileSync(spec, JSON.stringify(actions, null, 1), 'utf8');
  const r = spawnSync('python', ['tools/verify2_devices.py', spec, res], { stdio: 'ignore' });
  if (r.status !== 0) throw new Error('device runner exit ' + r.status);
  return JSON.parse(fs.readFileSync(res, 'utf8'));
}
function adbText(args) {
  const [r] = runDevice([{ kind: 'adb', args }]);
  if (!r || r.code !== 0) throw new Error('adb failed ' + JSON.stringify(args));
  return r.stdout;
}
function shot(name) {
  const [r] = runDevice([{ kind: 'screencap', out: path.resolve(OUT, name) }]);
  log(`  [shot] ${name} :: ${r && r.stdout ? r.stdout : ''}`);
}

/* ---- 键盘几何：从 dumpsys window 里取 InputMethod 窗口的 frame ---- */
function imeInfo() {
  const out = adbText(['shell', 'dumpsys', 'window', 'windows']);
  const idx = out.indexOf('u0 InputMethod');
  const seg = idx >= 0 ? out.slice(idx, idx + 6000) : '';
  const frames = [...seg.matchAll(/frame=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/g)]
    .map((m) => ({ l: +m[1], t: +m[2], r: +m[3], b: +m[4] }));
  const shown = /mInputShown=true/.test(adbText(['shell', 'dumpsys', 'input_method']));
  const appFrame = (() => {
    const i = out.indexOf('com.jizhang.app');
    const s = i >= 0 ? out.slice(i, i + 4000) : '';
    const m = /frame=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(s);
    return m ? { t: +m[2], b: +m[4] } : null;
  })();
  return { mInputShown: shown, imeFrames: frames, appWindowFrame: appFrame };
}

async function getTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  const list = await res.json();
  const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!p) throw new Error('no debuggable page');
  return p;
}
function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result); }
  });
  const ready = new Promise((res, rej) => { ws.addEventListener('open', () => res()); ws.addEventListener('error', (e) => rej(new Error('ws ' + (e.message || 'x')))); });
  function send(method, params) {
    return new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
      setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('timeout ' + method)); } }, 15000);
    });
  }
  return { ws, ready, send };
}

const page = await getTarget();
const S = connect(page.webSocketDebuggerUrl);
await S.ready;
async function ev(expr) {
  const r = await S.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('page exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result ? r.result.value : undefined;
}
async function clickAt(x, y) {
  const base = { x, y, button: 'left', clickCount: 1, buttons: 1 };
  await S.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await S.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
  await S.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
}

const OUT_SNAP = `(function(){
  var t=document.getElementById('toast');
  var tr=t?t.getBoundingClientRect():null;
  var cs=t?getComputedStyle(t):null;
  var ok=document.getElementById('savedOk'); var kr=ok?ok.getBoundingClientRect():null;
  var input=document.getElementById('savedAmountInput');
  return JSON.stringify({
    bodyClass: document.body.className,
    sheetKbOpen: document.body.classList.contains('sheet-kb-open'),
    activeEl: document.activeElement?(document.activeElement.id||document.activeElement.tagName):null,
    toast: tr?{text:String(t.textContent).trim(), hidden:t.hidden, top:Math.round(tr.top), bottom:Math.round(tr.bottom),
               left:Math.round(tr.left), right:Math.round(tr.right), height:Math.round(tr.height), cssBottom:cs?cs.bottom:null,
               opacity:cs?cs.opacity:null}:null,
    okBtn: kr?{top:Math.round(kr.top), bottom:Math.round(kr.bottom), cx:Math.round(kr.left+kr.width/2), cy:Math.round(kr.top+kr.height/2)}:null,
    inputValue: input?input.value:null,
    innerHeight: window.innerHeight
  });
})()`;

const report = { steps: [] };
const step = (name, data) => { report.steps.push({ name, ...data }); log(`  >> ${name}: ${JSON.stringify(data)}`); };

/* 1) 准备：一个已攒 < 目标 的目标 */
await ev(`document.querySelector('.tab[data-page=goals]').click(); 'ok'`);
await sleep(700);
const prep = JSON.parse(await ev(`(function(){
  ['goalMask','savedMask','editMask','dateMask','confirmMask'].forEach(function(id){var e=document.getElementById(id);if(e)e.hidden=true;});
  if (document.activeElement&&document.activeElement.blur) document.activeElement.blur();
  document.body.classList.remove('sheet-kb-open','kb-open');
  var g=Store.Savings.all()[0];
  if(!g){Store.Savings.add({name:'toast测试',targetAmount:'6000',icon:'🎯'});g=Store.Savings.all()[0];}
  Store.Records.all().forEach(function(r){if(String(r.goalId)===String(g.id))Store.Records.remove(r.id);});
  Store.Savings.deposit(g.id,'500');
  document.querySelector('.tab[data-page=goals]').click();
  return JSON.stringify({id:g.id,target:g.targetAmount,saved:Store.Savings.savedAmount(g.id)});
})()`));
step('prep', prep);
await sleep(700);

/* 2) 打开取出弹层 */
const ob = JSON.parse(await ev(`(function(){var e=document.querySelectorAll('.goal-op')[1];var r=e.getBoundingClientRect();
  return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),dis:e.disabled});})()`));
step('out-btn', ob);
runDevice([{ kind: 'adb', args: ['shell', 'input', 'tap', String(Math.round(ob.x * 2.625)), String(Math.round(ob.y * 2.625))] }, { kind: 'sleep', seconds: 0.7 }]);
log(`  [tap] 取出 css(${ob.x},${ob.y})`);

/* 3) 聚焦输入 → 键盘弹起；量下键盘几何 */
await ev(`document.getElementById('savedAmountInput').focus(); 'ok'`);
await sleep(1300);
const kb = imeInfo();
step('keyboard-before-click', kb);
runDevice([{ kind: 'adb', args: ['shell', 'input', 'text', '9999'] }, { kind: 'sleep', seconds: 0.3 }]);
log('  [type] 9999');
const okRect = JSON.parse(await ev(`(function(){var e=document.getElementById('savedOk');var r=e.getBoundingClientRect();
  return JSON.stringify({cx:r.left+r.width/2, cy:r.top+r.height/2, top:Math.round(r.top), bottom:Math.round(r.bottom)});})()`));
step('ok-btn-while-kb', okRect);
shot('T03-before-click-keyboard.png');

/* 4) 用 CDP 鼠标事件点「确定」，紧接着立刻读页面 */
await clickAt(Math.round(okRect.cx), Math.round(okRect.cy));
log(`  [cdp-click] 确定 css(${Math.round(okRect.cx)},${Math.round(okRect.cy)})`);
const snapNow = JSON.parse(await ev(OUT_SNAP));
step('immediately-after-click', snapNow);
shot('T04-toast-with-keyboard.png');

/* 5) 再量一次键盘（更晚时序，作为对照） */
const kbAfter = imeInfo();
step('keyboard-after-click-later', kbAfter);

/* 6) 判定：键盘几何以点击前那次为准；toast 以点击后立刻那次为准 */
const kbTopCss = kb.imeFrames.length ? Math.round((kb.imeFrames[0].t / 2.625) * 100) / 100 : null;
const tr = snapNow.toast;
const verdict = {
  toast: tr,
  toastRectTopBottom: tr ? [tr.top, tr.bottom] : null,
  keyboardFramesPhysical: kb.imeFrames,
  keyboardTopCssFromFrame: kbTopCss,
  keyboardShownBeforeClick: kb.mInputShown,
  keyboardShownAfterClickLater: kbAfter.mInputShown,
  bodyClassAtToast: snapNow.bodyClass,
  sheetKbOpenAtToast: snapNow.sheetKbOpen,
  activeElAtToast: snapNow.activeEl,
  innerHeight: snapNow.innerHeight,
};
step('VERDICT', verdict);
report.verdict = verdict;
report.screen = { physicalHeight: 2400, dpr: 2.625, innerHeightCss: snapNow.innerHeight };
fs.writeFileSync(path.join(OUT, 'toast-keyboard-result2.json'), JSON.stringify(report, null, 1), 'utf8');
log('\n=== written ' + path.join(OUT, 'toast-keyboard-result2.json') + ' ===');
S.ws.close();
