/* t7 专项实测：键盘弹起时「取出超额」的 toast 是否真的在键盘上方。
   目标坐标全部现场测量，不用页面里不可靠的 visualViewport。

   用法: node tools/verify2_toast_kb.mjs */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.CDP_PORT || 9222;
const DPR = 2.625;
const OUT = 'verify2-out';
fs.mkdirSync(path.join(OUT, '_dev'), { recursive: true });

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let devSeq = 0;
function runDevice(actions) {
  const n = ++devSeq;
  const spec = path.join(OUT, '_dev', `tk-spec-${n}.json`);
  const res = path.join(OUT, '_dev', `tk-res-${n}.json`);
  fs.writeFileSync(spec, JSON.stringify(actions, null, 1), 'utf8');
  const r = spawnSync('python', ['tools/verify2_devices.py', spec, res], { stdio: 'ignore' });
  if (r.status !== 0) throw new Error('device runner exit ' + r.status);
  return JSON.parse(fs.readFileSync(res, 'utf8'));
}
function adbText(args) {
  const [r] = runDevice([{ kind: 'adb', args }]);
  if (!r || r.code !== 0) throw new Error('adb failed ' + JSON.stringify(args) + ' :: ' + (r && r.stderr));
  return r.stdout;
}
function shot(name) {
  const [r] = runDevice([{ kind: 'screencap', out: path.resolve(OUT, name) }]);
  log(`  [shot] ${name} :: ${r && r.stdout ? r.stdout : '(fail)'}`);
}
function tapCss(x, y, note) {
  const px = Math.round(x * DPR), py = Math.round(y * DPR);
  runDevice([{ kind: 'adb', args: ['shell', 'input', 'tap', String(px), String(py)] }, { kind: 'sleep', seconds: 0.4 }]);
  log(`  [tap] css(${x},${y}) ${note || ''}`);
}
function typeText(s) {
  runDevice([{ kind: 'adb', args: ['shell', 'input', 'text', s] }, { kind: 'sleep', seconds: 0.3 }]);
  log(`  [type] ${s}`);
}

/* ---- 键盘几何：从 IME 窗口 frame 取（物理 px → CSS px） ---- */
function imeFrame() {
  const out = adbText(['shell', 'dumpsys', 'window', 'windows']);
  const idx = out.indexOf('u0 InputMethod');
  if (idx < 0) return { found: false };
  const seg = out.slice(idx, idx + 6000);
  const m = /frame=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(seg);
  if (!m) return { found: true, parsed: false, raw: seg.slice(0, 300) };
  const [l, t, r, b] = [m[1], m[2], m[3], m[4]].map(Number);
  return { found: true, parsed: true, left: l, top: t, right: r, bottom: b,
           topCss: Math.round((t / DPR) * 100) / 100, heightCss: Math.round(((b - t) / DPR) * 100) / 100 };
}
function imeShown() {
  return /mInputShown=true/.test(adbText(['shell', 'dumpsys', 'input_method']));
}

/* ---- CDP ---- */
async function getTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  const list = await res.json();
  const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!p) throw new Error('no debuggable page');
  return p;
}
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result); }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', (e) => rej(new Error('ws error ' + (e.message || 'x'))));
  });
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

const SNAPSHOT = `(function(){
  var toast = document.getElementById('toast');
  var tr = toast ? toast.getBoundingClientRect() : null;
  var cs = toast ? getComputedStyle(toast) : null;
  var saved = document.getElementById('savedMask');
  var sheet = saved && !saved.hidden ? saved.querySelector('.sheet') : null;
  var sr = sheet ? sheet.getBoundingClientRect() : null;
  var input = document.getElementById('savedAmountInput');
  var ir = input ? input.getBoundingClientRect() : null;
  var ok = document.getElementById('savedOk');
  var or_ = ok ? ok.getBoundingClientRect() : null;
  return JSON.stringify({
    bodyClass: document.body.className,
    sheetKbOpen: document.body.classList.contains('sheet-kb-open'),
    toast: tr ? { text: String(toast.textContent).trim(), hidden: toast.hidden,
                  top: Math.round(tr.top), bottom: Math.round(tr.bottom),
                  left: Math.round(tr.left), right: Math.round(tr.right),
                  height: Math.round(tr.height),
                  cssBottom: cs ? cs.bottom : null } : null,
    savedMaskShown: !!(saved && !saved.hidden),
    sheet: sr ? { top: Math.round(sr.top), bottom: Math.round(sr.bottom) } : null,
    amountInput: ir ? { top: Math.round(ir.top), bottom: Math.round(ir.bottom) } : null,
    okBtn: or_ ? { top: Math.round(or_.top), bottom: Math.round(or_.bottom) } : null,
    activeEl: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
    innerHeight: window.innerHeight
  });
})()`;

/* ================= 开始 ================= */
const report = { steps: [] };
function step(name, data) { report.steps.push({ name, ...data }); log(`  >> ${name}: ${JSON.stringify(data)}`); }

log('=== 准备：确保在攒钱页、存在一个有已攒但未达目标的目标 ===');
await ev(`document.querySelector('.tab[data-page=goals]').click(); 'ok'`);
await sleep(600);

const prep = await ev(`(function(){
  /* 这个专项只关心「取出超额」的提示位置，所以把已攒压到目标以下（超过目标时 estimate 会走 done），
     并把弹层全部关掉，避免上一轮遗留状态让后续取坐标取到 0。 */
  ['goalMask','savedMask','editMask','dateMask','confirmMask'].forEach(function(id){
    var el = document.getElementById(id); if (el) el.hidden = true;
  });
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  document.body.classList.remove('sheet-kb-open', 'kb-open');

  var g = Store.Savings.all()[0];
  if (!g) { Store.Savings.add({ name: 'toast测试', targetAmount: '6000', icon: '🎯' }); g = Store.Savings.all()[0]; }
  /* 清掉这个目标原有的攒钱记录，再重新存 500，保证已攒 = 500 < 目标 6000 */
  Store.Records.all().forEach(function(r){ if (String(r.goalId) === String(g.id)) Store.Records.remove(r.id); });
  Store.Savings.deposit(g.id, '500');
  document.querySelector('.tab[data-page=goals]').click();
  return JSON.stringify({ id: g.id, target: g.targetAmount, saved: Store.Savings.savedAmount(g.id),
                          goalCount: Store.Savings.all().length });
})()`);
step('prep', JSON.parse(prep));
await sleep(700);

const goal = { id: JSON.parse(prep).id, saved: JSON.parse(prep).saved, target: JSON.parse(prep).target };
step('goal', { id: goal.id, saved: goal.saved / 100, target: goal.target / 100 });

/* 打开「取出」弹层：等到 .goal-op 真的渲染出来再取坐标 */
let ob = null;
for (let i = 0; i < 12 && !ob; i++) {
  const r = await ev(`(function(){var e=document.querySelectorAll('.goal-op')[1];if(!e)return 'none';var r=e.getBoundingClientRect();
    if(r.width<=0||r.height<=0) return 'zero';
    return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),dis:e.disabled});})()`);
  if (r && r !== 'none' && r !== 'zero') ob = JSON.parse(r);
  else await sleep(300);
}
if (!ob || ob.dis) throw new Error('取出按钮不可用: ' + JSON.stringify(ob));
step('out-button', ob);
tapCss(ob.x, ob.y, '取出');
await sleep(800);
const afterOpen = JSON.parse(await ev(SNAPSHOT));
step('after-open-out-sheet', { savedMaskShown: afterOpen.savedMaskShown, sheet: afterOpen.sheet,
                               amountInput: afterOpen.amountInput, okBtn: afterOpen.okBtn });
if (!afterOpen.savedMaskShown) throw new Error('取出弹层没打开，后续测量无意义');

/* 聚焦输入框 → 键盘弹起 */
await ev(`document.getElementById('savedAmountInput').focus(); 'ok'`);
await sleep(1400);
const kbShown = imeShown();
const ime1 = imeFrame();
step('keyboard-open', { mInputShown: kbShown, ime: ime1, page: JSON.parse(await ev(SNAPSHOT)) });
shot('T01-out-sheet-keyboard.png');

/* 输入超额金额并点「确定」（保持键盘） */
typeText('9999');
await sleep(400);
step('after-typing', JSON.parse(await ev(SNAPSHOT)));

const okRect = JSON.parse(await ev(`(function(){var e=document.getElementById('savedOk');var r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),top:Math.round(r.top),bottom:Math.round(r.bottom)});})()`));
step('ok-button-while-keyboard', okRect);

/* 「确定」是可点的；此刻键盘还开着，先把键盘几何量下来（点击之后键盘可能很快收起，
   之后再读 IME 就不代表用户看到提示那一刻了）。 */
const imeBefore = imeFrame();
step('keyboard-frame-before-tap', imeBefore);
const kbTopCss = imeBefore.topCss;

/* 真实触摸「确定」：设备批处理里只有 tap，尽快返回；返回后立刻读页面（toast 只显示 1900ms）。 */
const batch = runDevice([
  { kind: 'adb', args: ['shell', 'input', 'tap', String(Math.round(okRect.x * DPR)), String(Math.round(okRect.y * DPR))] },
]);
log(`  [tap] css(${okRect.x},${okRect.y}) 确定（超额取出）`);
const snapAfter = JSON.parse(await ev(SNAPSHOT));
log('  >> 点击后立刻读页面（键盘测量取点击前的那一次）');

/* 再补一次键盘状态与截图（时序更晚，只作为补充信息） */
const batch2 = runDevice([
  { kind: 'sleep', seconds: 0.15 },
  { kind: 'adb', args: ['shell', 'dumpsys', 'input_method'] },
  { kind: 'screencap', out: path.resolve(OUT, 'T02-over-withdraw-toast-keyboard.png') },
]);
const imShownAfter = /mInputShown=true/.test(batch2[1].stdout || '');
log(`  [shot] T02-over-withdraw-toast-keyboard.png :: ${batch2[2] && batch2[2].stdout ? batch2[2].stdout : ''}`);
const snapLater = JSON.parse(await ev(SNAPSHOT));
step('immediately-after-confirm', { snapshotImmediatelyAfterTap: snapAfter.toast,
                                    keyboardShownRightAfterTap: imShownAfter });
/* 顺带把 IME frame 的原始文本落盘，便于证明解析结果 */
report.imeFrameRaw = String(batch2[1].stdout || '').split('\n').filter(function (l) { return /InputMethod|frame=\[/.test(l); }).slice(0, 40);

/* 判定 */
const tr = snapAfter.toast;
const kbTop = kbTopCss;
const savedUnchanged = (await ev(`Store.Savings.savedAmount(${JSON.stringify(goal.id)})`));
const recCount = await ev(`Store.Records.all().filter(function(r){return r.goalId}).length`);
const verdict = {
  toastText: tr ? tr.text : null,
  toastHidden: tr ? tr.hidden : null,
  toastTop: tr ? tr.top : null,
  toastBottom: tr ? tr.bottom : null,
  toastHeight: tr ? tr.height : null,
  toastLeft: tr ? tr.left : null,
  toastRight: tr ? tr.right : null,
  toastCssBottom: tr ? tr.cssBottom : null,
  sheetKbOpenAtMeasure: snapAfter.sheetKbOpen,
  bodyClassAtMeasure: snapAfter.bodyClass,
  activeElAtMeasure: snapAfter.activeEl,
  innerHeight: snapAfter.innerHeight,
  keyboardTopCssMeasuredBeforeTap: kbTop === undefined ? null : kbTop,
  keyboardTopPhysical: imeBefore.top === undefined ? null : imeBefore.top,
  keyboardHeightCss: imeBefore.heightCss === undefined ? null : imeBefore.heightCss,
  keyboardShownBeforeTap: true,
  keyboardShownRightAfterTap: imShownAfter,
  toastVisibleInDom: tr ? !tr.hidden : false,
  toastNonZeroRect: tr ? (tr.height > 0 && tr.bottom > tr.top) : false,
  toastFullyAboveKeyboard: (tr && !tr.hidden && tr.height > 0 && kbTop != null) ? (tr.bottom <= kbTop) : null,
  toastOnScreen: (tr && tr.height > 0) ? (tr.top >= 0 && tr.bottom <= snapAfter.innerHeight) : false,
  savedAmountUnchangedYuan: savedUnchanged / 100,
  savingsRecordCount: recCount,
};
step('VERDICT(点击后立刻)', verdict);
report.verdict = verdict;
report.verdictLater = {
  toastHidden: snapLater.toast ? snapLater.toast.hidden : null,
  toastTop: snapLater.toast ? snapLater.toast.top : null,
  bodyClass: snapLater.bodyClass,
  keyboardShown: imShownAfter,
  note: '这一份是更晚的时序（+150ms 与截图之后），toast 可能已经到 1900ms 消失、键盘可能已收起',
};
report.imeBeforeTap = imeBefore;
fs.writeFileSync(path.join(OUT, 'toast-keyboard-result.json'), JSON.stringify(report, null, 1), 'utf8');
log('\n=== toast-keyboard result written to ' + path.join(OUT, 'toast-keyboard-result.json') + ' ===');
log('VERDICT: ' + JSON.stringify(verdict, null, 1));
S.ws.close();
