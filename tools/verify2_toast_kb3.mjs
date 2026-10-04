/* t7 专项（决定性证据）：让 toast 与键盘出现在**同一帧**里。
   办法：不用 dumpsys（每次约 500ms，会把时机拖没），只用截图：
     1) 键盘弹起后截一帧（证明键盘在）
     2) CDP 点「确定」（极快），随后**连续**截若干帧，把 toast 那一帧抓下来

   用法: node tools/verify2_toast_kb3.mjs */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.CDP_PORT || 9222;
const OUT = 'verify2-out';
fs.mkdirSync(path.join(OUT, '_dev'), { recursive: true });
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
function device(actions) {
  const n = ++seq;
  const spec = path.join(OUT, '_dev', `tk3-${n}-s.json`);
  const res = path.join(OUT, '_dev', `tk3-${n}-r.json`);
  fs.writeFileSync(spec, JSON.stringify(actions, null, 1), 'utf8');
  const r = spawnSync('python', ['tools/verify2_devices.py', spec, res], { stdio: 'ignore' });
  if (r.status !== 0) throw new Error('device runner exit ' + r.status);
  return JSON.parse(fs.readFileSync(res, 'utf8'));
}
function adbText(args) {
  const [r] = device([{ kind: 'adb', args }]);
  return r.stdout || '';
}
function grab(name) {
  const abs = path.resolve(OUT, name);
  const [r] = device([{ kind: 'screencap', out: abs }]);
  const st = r && r.stdout ? 'ok' : 'fail';
  log(`  [frame] ${name} ${st}`);
  return abs;
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
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result); }
  });
  const ready = new Promise((res, rej) => { ws.addEventListener('open', () => res()); ws.addEventListener('error', (e) => rej(new Error('ws ' + (e.message || 'x')))); });
  function send(method, params) {
    return new Promise((resolve, reject) => {
      const myId = ++id; pending.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
      setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('timeout ' + method)); } }, 15000);
    });
  }
  return { ws, ready, send };
}

const page = await getTarget();
const S = connect(page.webSocketDebuggerUrl);
await S.ready;
const ev = async (expr) => {
  const r = await S.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('page exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result ? r.result.value : undefined;
};
async function clickAt(x, y) {
  const base = { x, y, button: 'left', clickCount: 1, buttons: 1 };
  await S.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await S.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
  await S.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
}

/* 准备 */
await ev(`document.querySelector('.tab[data-page=goals]').click(); 'ok'`);
await sleep(700);
await ev(`(function(){
  ['goalMask','savedMask','editMask','dateMask','confirmMask'].forEach(function(id){var e=document.getElementById(id);if(e)e.hidden=true;});
  if (document.activeElement&&document.activeElement.blur) document.activeElement.blur();
  document.body.classList.remove('sheet-kb-open','kb-open');
  var g=Store.Savings.all()[0];
  if(!g){Store.Savings.add({name:'toast测试',targetAmount:'6000',icon:'🎯'});g=Store.Savings.all()[0];}
  Store.Records.all().forEach(function(r){if(String(r.goalId)===String(g.id))Store.Records.remove(r.id);});
  Store.Savings.deposit(g.id,'500');
  document.querySelector('.tab[data-page=goals]').click();
  return 'prepped';
})()`);
await sleep(700);

const ob = JSON.parse(await ev(`(function(){var e=document.querySelectorAll('.goal-op')[1];var r=e.getBoundingClientRect();
  return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});})()`));
device([{ kind: 'adb', args: ['shell', 'input', 'tap', String(Math.round(ob.x * 2.625)), String(Math.round(ob.y * 2.625))] }, { kind: 'sleep', seconds: 0.7 }]);
log(`  [tap] 取出 css(${ob.x},${ob.y})`);

await ev(`document.getElementById('savedAmountInput').focus(); 'ok'`);
await sleep(1400);
device([{ kind: 'adb', args: ['shell', 'input', 'text', '9999'] }, { kind: 'sleep', seconds: 0.35 }]);
log('  [type] 9999');
const shown = /mInputShown=true/.test(adbText(['shell', 'dumpsys', 'input_method']));
log(`  键盘 mInputShown=${shown}`);

const ok = JSON.parse(await ev(`(function(){var e=document.getElementById('savedOk');var r=e.getBoundingClientRect();
  return JSON.stringify({cx:r.left+r.width/2,cy:r.top+r.height/2,top:Math.round(r.top),bottom:Math.round(r.bottom)});})()`));

grab('T10-keyboard-up-before-click.png');
await clickAt(Math.round(ok.cx), Math.round(ok.cy));
log(`  [cdp-click] 确定 css(${Math.round(ok.cx)},${Math.round(ok.cy)})`);

/* 连续抓帧，尽量把「toast + 键盘同框」那一帧抓到 */
const frames = [];
for (let i = 0; i < 4; i++) {
  const name = `T11-after-click-frame${i}.png`;
  device([{ kind: 'sleep', seconds: 0.12 }, { kind: 'screencap', out: path.resolve(OUT, name) }]);
  const snap = await ev(`(function(){var t=document.getElementById('toast');var r=t?t.getBoundingClientRect():null;
    return JSON.stringify({hidden:t?t.hidden:null, top:r?Math.round(r.top):null, bottom:r?Math.round(r.bottom):null,
      opacity:t?getComputedStyle(t).opacity:null, bodyClass:document.body.className});})()`);
  frames.push({ name, page: JSON.parse(snap) });
  log(`  [frame] ${name} :: ${snap}`);
}

fs.writeFileSync(path.join(OUT, 'toast-keyboard-frames.json'), JSON.stringify({
  okButton: ok, keyboardShownBeforeClick: shown, frames,
}, null, 1), 'utf8');
log('\n=== frames recorded; 下一步用像素量每帧键盘上沿 ===');
S.ws.close();
