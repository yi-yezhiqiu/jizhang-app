/* t7 专项：写入攒钱记录 -> adb shell am force-stop -> 重启 -> 确认数据仍在。
   记录前后真实返回值。

   用法: node tools/verify2_persist_restart.mjs */
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
  const spec = path.join(OUT, '_dev', `pr-${n}-s.json`);
  const res = path.join(OUT, '_dev', `pr-${n}-r.json`);
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

async function attach() {
  const page = await target();
  const S = connect(page.webSocketDebuggerUrl);
  await S.ready;
  const ev = async (expr) => {
    const r = await S.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result ? r.result.value : undefined;
  };
  return { S, ev };
}

const SUMMARY = `(function(){
  return JSON.stringify({
    goals: Store.Savings.all().map(function(g){ return {id:g.id, name:g.name, icon:g.icon, target:g.targetAmount,
      saved: Store.Savings.savedAmount(g.id)}; }),
    savedTotal: Store.Savings.savedTotal(),
    savingsRecCount: Store.Records.all().filter(function(r){return r.goalId}).length,
    savingsRecs: Store.Records.all().filter(function(r){return r.goalId}).map(function(r){
      return {id:r.id, amount:r.amount, type:r.type, kind:r.savingsKind, goalId:r.goalId, date:r.date}; }),
    allRecCount: Store.Records.all().length,
    lsKeys: Object.keys(localStorage).sort()
  });
})()`;

const report = { steps: [] };
const step = (name, data) => { report.steps.push({ name, ...data }); log(`  >> ${name}: ${JSON.stringify(data)}`); };

/* ---------- 阶段 1：写入一笔攒钱记录 ---------- */
log('=== 阶段1：写入攒钱记录 ===');
let A = await attach();
const pre = JSON.parse(await A.ev(SUMMARY));
step('before-write', pre);

const writeRes = JSON.parse(await A.ev(`(function(){
  var g = Store.Savings.all()[0];
  if (!g) { Store.Savings.add({name:'重启持久化测试', targetAmount:'10000', icon:'🐷'}); g = Store.Savings.all()[0]; }
  var res = Store.Savings.deposit(g.id, '1234.56');
  return JSON.stringify({depositRes: res, goalId: g.id});
})()`));
step('write-deposit', writeRes);
const goalId = writeRes.goalId;
await sleep(800);   // 给 localStorage 落盘留时间

const after = JSON.parse(await A.ev(SUMMARY));
step('after-write', after);
const savedAfterWrite = after.goals.find((g) => g.id === goalId).saved;
const recCountAfterWrite = after.savingsRecCount;
shot('P01-after-write.png');
A.S.ws.close();

/* ---------- 阶段 2：force-stop + 重启 ---------- */
log('=== 阶段2：adb shell am force-stop com.jizhang.app + 重启 ===');
const pidBefore = adbText(['shell', 'pidof', 'com.jizhang.app']).trim();
device([
  { kind: 'adb', args: ['shell', 'am', 'force-stop', 'com.jizhang.app'] },
  { kind: 'sleep', seconds: 1.5 },
]);
const pidAfterStop = adbText(['shell', 'pidof', 'com.jizhang.app']).trim();
step('force-stop', { pidBefore, pidAfterStop, stopped: pidAfterStop === '' });

device([
  { kind: 'adb', args: ['shell', 'am', 'start', '-n', 'com.jizhang.app/.MainActivity'] },
  { kind: 'sleep', seconds: 4 },
]);
const pidAfterStart = adbText(['shell', 'pidof', 'com.jizhang.app']).trim();
step('restart', { pidAfterStart, isNewProcess: pidAfterStart !== '' && pidAfterStart !== pidBefore });
device([
  { kind: 'adb', args: ['forward', '--remove-all'] },
  { kind: 'adb', args: ['forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pidAfterStart}`] },
]);
await sleep(1500);

/* ---------- 阶段 3：重新读数据 ---------- */
log('=== 阶段3：重启后重新读取 ===');
let B = await attach();
const post = JSON.parse(await B.ev(SUMMARY));
step('after-restart', post);
const goalPost = post.goals.find((g) => g.id === goalId);
shot('P02-after-restart.png');

const verdict = {
  goalId,
  savedAfterWrite_cents: savedAfterWrite,
  savedAfterRestart_cents: goalPost ? goalPost.saved : null,
  savedSurvived: goalPost ? goalPost.saved === savedAfterWrite : false,
  goalMetaSurvived: goalPost ? (goalPost.name && goalPost.target > 0) : false,
  savingsRecCountAfterWrite: recCountAfterWrite,
  savingsRecCountAfterRestart: post.savingsRecCount,
  recCountSurvived: post.savingsRecCount === recCountAfterWrite,
  allRecCountBefore: pre.allRecCount,
  allRecCountAfterRestart: post.allRecCount,
  allRecordsSurvived: post.allRecCount === after.allRecCount,
  localStorageKeysBefore: pre.lsKeys,
  localStorageKeysAfterRestart: post.lsKeys,
  keysSurvived: JSON.stringify(pre.lsKeys) === JSON.stringify(post.lsKeys),
  depositedAmountYuan: 1234.56,
  savedYuan: goalPost ? goalPost.saved / 100 : null,
  processRestarted: pidAfterStart !== '' && pidAfterStart !== pidBefore,
};
step('VERDICT-force-stop-only', verdict);
report.verdict = verdict;

/* ---------- 阶段 4：追加最严场景 —— APK 覆盖安装 + force-stop + 重启 ----------
   （impl2 观察到过一次「覆盖安装 + force-stop 后刚写入的 localStorage 丢失」，
     这里正面验证这个组合，攒钱数据不能丢。） */
log('\n=== 阶段4：adb install -r（覆盖安装）+ force-stop + 重启 ===');
const install = adbText(['install', '-r', path.resolve('build/jizhang.apk')]);
log('  install -r => ' + install.trim().split('\n').join(' | '));
const pidAfterInstall = adbText(['shell', 'pidof', 'com.jizhang.app']).trim();
device([
  { kind: 'adb', args: ['shell', 'am', 'force-stop', 'com.jizhang.app'] },
  { kind: 'sleep', seconds: 1.5 },
]);
const pidStopped2 = adbText(['shell', 'pidof', 'com.jizhang.app']).trim();
device([
  { kind: 'adb', args: ['shell', 'am', 'start', '-n', 'com.jizhang.app/.MainActivity'] },
  { kind: 'sleep', seconds: 4 },
]);
const pidAfterStart2 = adbText(['shell', 'pidof', 'com.jizhang.app']).trim();
device([
  { kind: 'adb', args: ['forward', '--remove-all'] },
  { kind: 'adb', args: ['forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pidAfterStart2}`] },
]);
await sleep(1500);
const C = await attach();
const post2 = JSON.parse(await C.ev(SUMMARY));
const goalPost2 = post2.goals.find((g) => g.id === goalId);
shot('P03-after-reinstall-restart.png');
C.S.ws.close();

const verdict2 = {
  installResult: install.trim(),
  pidAfterInstall,
  pidStoppedByForceStop: pidStopped2 === '',
  pidAfterRestart: pidAfterStart2,
  savedAfterRestart_cents: goalPost2 ? goalPost2.saved : null,
  savedSurvived: goalPost2 ? goalPost2.saved === savedAfterWrite : false,
  savingsRecCountAfterReinstallRestart: post2.savingsRecCount,
  recCountSurvived: post2.savingsRecCount === recCountAfterWrite,
  allRecCountAfterReinstallRestart: post2.allRecCount,
  localStorageKeysAfterReinstallRestart: post2.lsKeys,
  keysSurvived: JSON.stringify(pre.lsKeys) === JSON.stringify(post2.lsKeys),
};
step('VERDICT-reinstall-plus-force-stop', verdict2);
report.verdict2 = verdict2;
fs.writeFileSync(path.join(OUT, 'persist-restart-result.json'), JSON.stringify(report, null, 1), 'utf8');
log('\n=== written ' + path.join(OUT, 'persist-restart-result.json') + ' ===');
B.S.ws.close();
