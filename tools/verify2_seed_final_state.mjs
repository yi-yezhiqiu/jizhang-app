/* 把设备上的 App 数据重置成一份干净、有代表性的状态，交给队长做最终截图核验。
   不放任何「测试」痕迹：3 个月真实收支 + 1 个进行中的攒钱目标。

   用法: node tools/verify2_seed_final_state.mjs */
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
  const spec = path.join(OUT, '_dev', `fs-${n}-s.json`);
  const res = path.join(OUT, '_dev', `fs-${n}-r.json`);
  fs.writeFileSync(spec, JSON.stringify(actions, null, 1), 'utf8');
  const r = spawnSync('python', ['tools/verify2_devices.py', spec, res], { stdio: 'ignore' });
  if (r.status !== 0) throw new Error('device runner exit ' + r.status);
  return JSON.parse(fs.readFileSync(res, 'utf8'));
}
function adbText(args) {
  const [r] = device([{ kind: 'adb', args }]);
  return r.stdout || '';
}
function shot(name) {
  const [r] = device([{ kind: 'screencap', out: path.resolve(OUT, name) }]);
  log(`  [shot] ${name} :: ${r && r.stdout ? r.stdout : ''}`);
}

async function target() {
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

/* 清数据 + 重启 + 重新建立 CDP */
adbText(['shell', 'pm', 'clear', 'com.jizhang.app']);
device([
  { kind: 'adb', args: ['shell', 'am', 'start', '-n', 'com.jizhang.app/.MainActivity'] },
  { kind: 'sleep', seconds: 3.5 },
]);
const pid = adbText(['shell', 'pidof', 'com.jizhang.app']).trim();
device([
  { kind: 'adb', args: ['forward', '--remove-all'] },
  { kind: 'adb', args: ['forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`] },
]);
await sleep(1500);
log(`app restarted, pid=${pid}`);

const page = await target();
const S = connect(page.webSocketDebuggerUrl);
await S.ready;
const ev = async (expr) => {
  const r = await S.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('page exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result ? r.result.value : undefined;
};

const seeded = await ev(`(function(){
  function addRec(date, type, amount, catId){ return Store.Records.add({date:date,type:type,amount:amount,categoryId:catId}).ok; }
  var exp = Store.Categories.byType('expense')[0], inc = Store.Categories.byType('income')[0];
  ['2026-09','2026-08','2026-07'].forEach(function(m){
    addRec(m+'-10', 'income', 10000, inc.id);
    addRec(m+'-15', 'expense', 5000, exp.id);
  });
  addRec('2026-10-02', 'income', 8000, inc.id);
  addRec('2026-10-03', 'expense', 3000, exp.id);
  var g = Store.Savings.add({ name: '换新手机', targetAmount: '6000', targetDate: '2027-03-31', icon: '📱' });
  var goal = Store.Savings.all()[0];
  Store.Savings.deposit(goal.id, '2500');
  var k = Store.Stats.monthKey();
  return JSON.stringify({
    month: k,
    monthTotals: Store.Stats.totals(Store.Records.byMonth(k)),
    goal: { id: goal.id, name: goal.name, target: goal.targetAmount, date: goal.targetDate, icon: goal.icon,
            saved: Store.Savings.savedAmount(goal.id), est: Store.Savings.estimate(goal) },
    recCount: Store.Records.all().length,
    disposable: Store.Stats.totals(Store.Records.all()).balance - Store.Savings.savedTotal()
  });
})()`);
log('seeded => ' + seeded);

await ev(`document.querySelector('.tab[data-page=goals]').click(); 'ok'`);
await sleep(800);
shot('FINAL-01-goals.png');
await ev(`document.querySelector('.tab[data-page=home]').click(); 'ok'`);
await sleep(800);
shot('FINAL-02-home.png');
await ev(`document.querySelector('.tab[data-page=settings]').click(); 'ok'`);
await sleep(800);
shot('FINAL-03-settings.png');
await ev(`document.querySelector('.tab[data-page=goals]').click(); 'ok'`);
await sleep(500);
shot('FINAL-04-goals-again.png');

fs.writeFileSync(path.join(OUT, 'final-state.json'), JSON.stringify({
  pid, seeded: JSON.parse(seeded),
  note: '设备已留成这个状态交给队长做最终截图核验；未 adb emu kill，模拟器仍在运行。',
}, null, 1), 'utf8');
log('\n=== 设备已重置为交付状态（见 verify2-out/final-state.json）===');
S.ws.close();
