/* verify2 端到端实测驱动（单 Node 进程，自己连 CDP + 驱动 adb）。
   用法: node tools/verify2_e2e.mjs [phase]
     phase = goals | entry | all (默认 all)
   证据写到 verify2-out/：截图 png + JSON 探针。 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.CDP_PORT || 9222;
const OUT = 'verify2-out';
const DPR = 2.625;
const PHASE = process.argv[2] || 'all';

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 本沙箱禁止 node 用管道启动子进程（spawn EPERM），所以设备动作统一写成
   spec 文件交给 python 执行；node 只读写文件。 */
const TMP_DIR = path.join(OUT, '_dev');
fs.mkdirSync(TMP_DIR, { recursive: true });
let devSeq = 0;
let lastDeviceLog = [];

function runDevice(actions) {
  const n = ++devSeq;
  const specPath = path.join(TMP_DIR, `spec-${n}.json`);
  const rsPath = path.join(TMP_DIR, `res-${n}.json`);
  fs.writeFileSync(specPath, JSON.stringify(actions, null, 1), 'utf8');
  const r = spawnSync('python', ['tools/verify2_devices.py', specPath, rsPath], { stdio: 'ignore' });
  if (r.error) throw new Error('python device runner failed: ' + r.error.message);
  if (r.status !== 0) throw new Error('python device runner exit ' + r.status);
  const results = JSON.parse(fs.readFileSync(rsPath, 'utf8'));
  lastDeviceLog = results;
  return results;
}
function adbText(args) {
  const [r] = runDevice([{ kind: 'adb', args }]);
  if (!r || r.code !== 0) throw new Error('adb failed: ' + JSON.stringify(args) + ' :: ' + (r && r.stderr));
  return r.stdout;
}
function adbBatch(actions) { return runDevice(actions); }

/* 设备动作缓冲：一个 python 调用里连续执行 tap/type/sleep，省去每步一次进程启动。
   读页面状态（CDP）之前必须 flushDevice()。 */
let buf = [];
function tapCss(x, y, note) {
  const px = Math.round(x * DPR), py = Math.round(y * DPR);
  buf.push({ kind: 'adb', args: ['shell', 'input', 'tap', String(px), String(py)] });
  buf.push({ kind: 'sleep', seconds: 0.35 });
  log(`  [tap] css(${x},${y}) -> phys(${px},${py}) ${note || ''}`);
}
function typeText(s) {
  buf.push({ kind: 'adb', args: ['shell', 'input', 'text', String(s)] });
  buf.push({ kind: 'sleep', seconds: 0.25 });
  log(`  [type] ${s}`);
}
function keyevent(k) { buf.push({ kind: 'adb', args: ['shell', 'input', 'keyevent', k] }); }
function sleepDev(sec) { buf.push({ kind: 'sleep', seconds: sec }); }
function queueAdb(args) { buf.push({ kind: 'adb', args }); }
function flushDevice() {
  if (!buf.length) return [];
  const actions = buf; buf = [];
  const res = runDevice(actions);
  for (const r of res) if (r.code !== 0 && r.args[0] !== 'screencap') log(`  [dev-warn] exit ${r.code} :: ${JSON.stringify(r.args)} :: ${r.stderr}`);
  return res;
}
function shot(name) {
  flushDevice();
  const out = path.resolve(OUT, name);
  const [r] = runDevice([{ kind: 'screencap', out }]);
  log(`  [shot] ${name} :: ${r && r.stdout ? r.stdout : '(fail)'}`);
  return r;
}
function saveJson(name, obj) {
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj, null, 1), 'utf8');
  log(`  [json] ${name}`);
}

/* ---------------- CDP ---------------- */
async function getTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  const list = await res.json();
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no debuggable page');
  return page;
}
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', (e) => rej(new Error('ws error: ' + (e.message || 'x'))));
  });
  function send(method, params) {
    return new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
      setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('timeout ' + method)); } }, 20000);
    });
  }
  return { ws, ready, send };
}

const READ_EXPR = fs.readFileSync('tools/verify2_probe.js', 'utf8');

const results = [];
function check(id, desc, pass, detail) {
  results.push({ id, desc, pass: !!pass, detail });
  log(`${pass ? '  PASS' : '  FAIL'} [${id}] ${desc}${detail ? ' :: ' + detail : ''}`);
}

let S = null;
let page = null;

/* WebView 偶尔会把一次 Runtime.evaluate 拖过超时（实测发生在 KEYCODE_BACK 之后）。
   这里统一做「重连 + 重试」，避免单次抖动把整轮实测打断。 */
async function reconnect() {
  if (S) { try { S.ws.close(); } catch {} }
  for (let i = 0; i < 6; i++) {
    try {
      page = await getTarget();
      S = connect(page.webSocketDebuggerUrl);
      await S.ready;
      log('  [cdp] reconnected');
      return true;
    } catch (e) {
      await sleep(700);
    }
  }
  return false;
}

async function ev(expr, tries = 3) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await S.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('page exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result ? r.result.value : undefined;
    } catch (e) {
      lastErr = e;
      if (!/timeout|WebSocket is not open|socket|closed/i.test(e.message)) throw e;
      log(`  [cdp] ${e.message} -> reconnect (try ${i + 1}/${tries})`);
      if (!(await reconnect())) break;
    }
  }
  throw lastErr;
}
async function probe() {
  const v = await ev(READ_EXPR);
  return typeof v === 'string' ? JSON.parse(v) : v;
}
async function mouseClick(x, y) {
  const base = { x, y, button: 'left', clickCount: 1, buttons: 1 };
  await S.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await S.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
  await sleep(70);
  await S.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
}
/* 元素中心（CSS 坐标） */
async function centerOf(sel, idx = 0) {
  return ev(`(function(){var e=document.querySelectorAll(${JSON.stringify(sel)})[${idx}];if(!e)return null;var r=e.getBoundingClientRect();return {x:(r.left+r.width/2),y:(r.top+r.height/2),w:r.width,h:r.height,txt:e.textContent.trim(),dis:!!e.disabled};})()`);
}
/* 真实触摸：用 adb input tap 打到元素中心 */
async function tapEl(sel, idx = 0, note = '') {
  const c = await centerOf(sel, idx);
  if (!c) throw new Error('element not found: ' + sel + '[' + idx + ']');
  tapCss(Math.round(c.x), Math.round(c.y), `${note} ${sel}[${idx}] "${c.txt}"`);
  return c;
}
function DPR_VAL() { return DPR; }

/* 键盘上沿（CSS px）：**像素测量**，不靠 dumpsys。
   试过的两条弯路，记下来免得再走：
     1. 读页面的 visualViewport —— 本机键盘弹起时它也恒等于 915，完全测不到；
     2. 读 dumpsys window 里 InputMethod 窗口的 frame —— 拿到的是窗口外框 [0,128][1080,2400]，
        换算成 48.76 CSS px，明显是状态栏内缩而不是键盘表面（键盘实际从 y≈1633 物理像素开始）。
   可靠做法：截一帧图，从下往上扫每行平均亮度，键盘面板（≈240）与被遮罩的页面（≈147）
   亮度差异极大，跳变那一行就是键盘上沿。 */
function keyboardTopCss(screenshotName) {
  const name = screenshotName || `_kbprobe-${Date.now()}.png`;
  const abs = path.resolve(OUT, name);
  runDevice([{ kind: 'screencap', out: abs }]);
  const jsonOut = path.resolve(OUT, '_dev', 'kb-measure.json');
  // 本沙箱里 node 无法用管道捕获子进程输出（spawn EPERM），所以让 python 把结果写成文件
  const r = spawnSync('python', ['tools/verify2_measure_keyboard.py', abs, String(DPR), jsonOut], { stdio: 'ignore' });
  if (r.status !== 0 || !fs.existsSync(jsonOut)) {
    return { css: null, physical: null, error: 'measure failed status=' + r.status };
  }
  const m = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
  return { css: m.keyboard_top_css, physical: m.keyboard_top_physical,
           heightCss: m.keyboard_height_css, screenshot: name };
}

function kbShown() {
  const out = adbText(['shell', 'dumpsys', 'input_method']);
  return /mInputShown=true/.test(out);
}
/* 用键盘输入框注入文本（WebView 无法用 adb input text 打中文） */
async function setValue(sel, val, idx = 0) {
  return ev(`(function(){var e=document.querySelectorAll(${JSON.stringify(sel)})[${idx}];if(!e)return 'no-el';e.focus();e.value=${JSON.stringify(val)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return e.value;})()`);
}

async function recall() {
  return ev(`(function(){
    var sb = document.querySelector('.summary-bar');
    var items = [].slice.call(document.querySelectorAll('.summary-bar .sum-item'));
    var vals = [].slice.call(document.querySelectorAll('.summary-bar .sum-value'));
    var goals = Store.Savings.all();
    var k = Store.Stats.monthKey();
    return JSON.stringify({
      summaryTexts: items.map(function(e){return e.textContent.replace(/\\s+/g,' ').trim()}),
      summaryCols: items.length ? new Set(items.map(function(e){return Math.round(e.getBoundingClientRect().left)})).size : 0,
      summaryClipped: vals.filter(function(e){return e.scrollWidth > e.clientWidth + 1}).map(function(e){return e.textContent}),
      summaryWidths: vals.map(function(e){return e.clientWidth}),
      goals: goals.map(function(g){return {id:g.id,name:g.name,icon:g.icon,target:g.targetAmount,date:g.targetDate,saved:Store.Savings.savedAmount(g.id),est:Store.Savings.estimate(g)}}),
      savedTotal: Store.Savings.savedTotal(),
      recCount: Store.Records.all().length,
      month: k,
      monthTotals: Store.Stats.totals(Store.Records.byMonth(k)),
      allTotals: Store.Stats.totals(Store.Records.all()),
      disposable: Store.Stats.totals(Store.Records.all()).balance - Store.Savings.savedTotal(),
      savingsRecs: Store.Records.all().filter(function(r){return r.goalId}).map(function(r){return {amount:r.amount,type:r.type,kind:r.savingsKind,goalId:r.goalId,cat:r.categoryId}}),
      expOrder: Store.Categories.byType('expense').map(function(c){return c.name}),
      incOrder: Store.Categories.byType('income').map(function(c){return c.name}),
      chipLabels: [].slice.call(document.querySelectorAll('.cat-chip')).map(function(e){return e.textContent.replace(/\\s+/g,'').replace(/[▲▼×]/g,'')}),
      recLabels: [].slice.call(document.querySelectorAll('.rec')).slice(0,4).map(function(e){return e.textContent.replace(/\\s+/g,' ').trim()}),
      toast: (function(){ var el=document.getElementById('toast'); return el?{text:String(el.textContent).trim(),hidden:el.hidden}:null; })(),
      toastRect: (function(){
        var el=document.getElementById('toast'); if(!el) return null;
        var r=el.getBoundingClientRect();
        return {text:String(el.textContent).trim(), hidden:el.hidden,
                top:Math.round(r.top), bottom:Math.round(r.bottom),
                left:Math.round(r.left), right:Math.round(r.right),
                height:Math.round(r.height)};
      })()
    });
  })()`).then((s) => (typeof s === 'string' ? JSON.parse(s) : s));
}

/* ---------------- 工具：等待 ---------------- */
async function waitFor(fn, timeout = 6000, interval = 250) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) return null;
    await sleep(interval);
  }
}

/* ---------------- 场景 ---------------- */
async function relaunch() {
  adbBatch([
    { kind: 'adb', args: ['shell', 'am', 'force-stop', 'com.jizhang.app'] },
    { kind: 'sleep', seconds: 0.5 },
    { kind: 'adb', args: ['shell', 'am', 'start', '-n', 'com.jizhang.app/.MainActivity'] },
    { kind: 'sleep', seconds: 3.5 },
  ]);
  const pid = adbText(['shell', 'pidof', 'com.jizhang.app']).trim();
  adbBatch([
    { kind: 'adb', args: ['forward', '--remove-all'] },
    { kind: 'adb', args: ['forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`] },
  ]);
  log(`  relaunched, pid=${pid}, CDP forwarded`);
  return pid;
}

async function phaseGoals() {
  log('\n=== phase goals ===');
  /* 1. 清数据重装版重跑 */
  adbText(['shell', 'pm', 'clear', 'com.jizhang.app']);
  const pid = await relaunch();
  page = await getTarget();
  S = connect(page.webSocketDebuggerUrl);
  await S.ready;

  log('  建立基线/灌数据');
  const seed = await ev(`(function(){
    var res = [];
    function addRec(date, type, amount, catId) { var r = Store.Records.add({date:date,type:type,amount:amount,categoryId:catId}); res.push(r.ok); }
    var exp = Store.Categories.byType('expense')[0], inc = Store.Categories.byType('income')[0];
    ['2026-09','2026-08','2026-07'].forEach(function(m){ addRec(m+'-10','income',10000,inc.id); addRec(m+'-15','expense',5000,exp.id); });
    addRec('2026-10-02','income',8000,inc.id);
    addRec('2026-10-03','expense',3000,exp.id);
    return JSON.stringify({ok:res.filter(Boolean).length, total:res.length});
  })()`);
  log('  seed => ' + seed);

  /* 触屏切页 -> 首页 */
  await ev(`document.querySelector('.tab[data-page=home]').click(); 'ok'`);
  await sleep(500);
  let st = await recall();
  check('g1-summary-cols', '汇总条 4 列不挤压（4 列、4 个等宽且未截断）',
    st.summaryCols === 4 && st.summaryClipped.length === 0,
    `cols=${st.summaryCols} widths=${JSON.stringify(st.summaryWidths)} clipped=${JSON.stringify(st.summaryClipped)}`);
  check('g2-summary-values', '首页汇总为真实收支（支出3000/收入8000/结余5000）',
    st.summaryTexts[0].indexOf('3000') >= 0 && st.summaryTexts[1].indexOf('8000') >= 0 && st.summaryTexts[2].indexOf('5000') >= 0,
    JSON.stringify(st.summaryTexts));
  check('g3-disposable-20000', '可支配 = 3 个月结余合计 20000',
    st.disposable === 2000000 && st.summaryTexts[3].indexOf('20000') >= 0,
    `disposable=${st.disposable} text=${st.summaryTexts[3]}`);
  shot('E01-home-seeded.png');

  /* 2. 真实触摸切到攒钱页 */
  tapCss(257, 875, 'bottom tab 攒钱');
  sleepDev(0.8);
  flushDevice();
  st = await recall();
  let pr = await probe();
  check('g4-goals-page', '触摸底部「攒钱」进入攒钱目标页（空态）',
    pr.page === 'page-goals' && pr.goalCards.length === 0,
    `page=${pr.page} cards=${pr.goalCards.length}`);
  shot('E02-goals-empty.png');

  /* 3. 新建目标：真实触摸 ＋新建 -> 注入名称/金额 -> 触摸 保存（一次） */
  await tapEl('#addGoalBtn', 0, '新建');
  sleepDev(0.7);
  flushDevice();
  pr = await probe();
  const noKbSheet = pr.sheets[0];
  check('g5-goalmask-open', '新建目标弹层打开且完整可见（未聚焦输入框时贴底）',
    pr.masksVisible.indexOf('goalMask') >= 0 && noKbSheet && noKbSheet.b > 700,
    `sheet=${JSON.stringify(noKbSheet)}`);
  shot('E03-goalmask-nokb.png');

  /* 聚焦名称 -> 键盘弹起 -> sheet 抬到键盘上方 */
  await ev(`document.getElementById('goalName').focus(); 'ok'`);
  sleepDev(1.2);
  flushDevice();
  pr = await probe();
  const kbSheet = pr.sheets[0];
  const kbOn = kbShown();
  check('g6-sheet-lifted-above-keyboard', '键盘弹起时目标弹层抬到键盘上方（body.sheet-kb-open，sheet 底边 <= 键盘上沿估算 480）',
    kbOn && pr.bodyClass.indexOf('sheet-kb-open') >= 0 && kbSheet && kbSheet.b <= 480,
    `kbShown=${kbOn} bodyClass="${pr.bodyClass}" sheet=${JSON.stringify(kbSheet)}`);
  check('g7-save-visible-with-keyboard', '键盘弹起时「保存」按钮仍在键盘上方可见',
    pr.sheetActions[0] && pr.sheetActions[0].b <= 480 && pr.sheetActions[0].t > 0,
    JSON.stringify(pr.sheetActions[0]));
  shot('E04-goalmask-keyboard.png');
  await setValue('#goalName', '换新手机');
  await setValue('#goalAmount', '6000');
  await sleep(250);
  shot('E05-goalmask-filled.png');
  const saveC = await centerOf('#goalSave');
  tapCss(Math.round(saveC.x), Math.round(saveC.y), '保存（一次触摸）');
  sleepDev(1.2);
  flushDevice();
  st = await recall();
  pr = await probe();
  check('g8-create-goal-single-tap', '一次触摸「保存」即创建成功（弹层关闭、键盘收起）',
    pr.masksVisible.length === 0 && pr.bodyClass === '' && st.goals.length === 1,
    `masks=${JSON.stringify(pr.masksVisible)} bodyClass="${pr.bodyClass}" goals=${st.goals.length}`);
  check('g9-goal-fields', '目标字段持久化正确（名称/图标/目标金额6000/无日期）',
    st.goals[0] && st.goals[0].name === '换新手机' && st.goals[0].target === 600000 && st.goals[0].date === null,
    JSON.stringify(st.goals[0]));
  check('g10-estimate-2-months', '按最近三个月真实结余估算「还需约 2 个月」(6000/5000->ceil=2)',
    st.goals[0] && st.goals[0].est.status === 'ok' && st.goals[0].est.monthsNeeded === 2 && st.goals[0].est.dataMonths.join(',') === '2026-09,2026-08,2026-07',
    JSON.stringify(st.goals[0] && st.goals[0].est));
  shot('E06-goal-created.png');

  /* 4. 存入 2500：真实触摸 存入 -> 聚焦输入 -> adb 输入 -> 触摸 确定 */
  await tapEl('.goal-op', 0, '存入');
  sleepDev(0.8);
  flushDevice();
  pr = await probe();
  check('g11-savedmask-open', '「存入」打开存入弹层（标题/提示正确）',
    pr.masksVisible.indexOf('savedMask') >= 0 && pr.sheetTitles[0] === '存入金额',
    `masks=${JSON.stringify(pr.masksVisible)} titles=${JSON.stringify(pr.sheetTitles)}`);
  shot('E07-savedmask-nokb.png');
  await ev(`document.getElementById('savedAmountInput').focus(); 'ok'`);
  sleepDev(1.2);
  typeText('2500');
  sleepDev(0.5);
  flushDevice();
  pr = await probe();
  let v = await ev(`document.getElementById('savedAmountInput').value`);
  const kbOn2 = kbShown();
  check('g12-savedmask-kb-visible', '存入弹层键盘弹起后输入框与「确定」都在键盘上方（这是修复的核心 bug）',
    kbOn2 && pr.bodyClass.indexOf('sheet-kb-open') >= 0 && pr.sheetInputs[0].b <= 480 && pr.sheetActions[0].b <= 480 && pr.sheetActions[0].t > 0,
    `kb=${kbOn2} bodyClass="${pr.bodyClass}" input=${JSON.stringify(pr.sheetInputs[0])} actions=${JSON.stringify(pr.sheetActions[0])}`);
  shot('E08-savedmask-keyboard.png');
  const okC = await centerOf('#savedOk');
  tapCss(Math.round(okC.x), Math.round(okC.y), '确定（一次触摸）');
  sleepDev(1.2);
  flushDevice();
  st = await recall();
  check('g13-deposit-applied', '一次触摸「确定」成功存入 2500（已攒 2500，弹层关闭）',
    st.goals[0] && st.goals[0].saved === 250000 && st.savedTotal === 250000,
    `saved=${st.goals[0] && st.goals[0].saved} savedTotal=${st.savedTotal} inputValue=${v}`);
  check('g14-deposit-record-shape', '存入落成一条 goalId+savingsKind=in 的 expense 记录，且无分类',
    st.savingsRecs.length === 1 && st.savingsRecs[0].type === 'expense' && st.savingsRecs[0].kind === 'in' && st.savingsRecs[0].cat === null,
    JSON.stringify(st.savingsRecs));
  check('g15-estimate-after-deposit', '存入后估算更新（余 3500 / 月均 5000 -> 1 个月）',
    st.goals[0].est.monthsNeeded === 1 && st.goals[0].est.remaining === 350000,
    JSON.stringify(st.goals[0].est));
  shot('E09-after-deposit.png');

  /* 5. 攒钱记录不进统计 + 可支配扣减 */
  await ev(`document.querySelector('.tab[data-page=home]').click(); 'ok'`);
  await sleep(600);
  st = await recall();
  check('g16-saving-not-in-stats', '攒钱记录不进「本月支出/收入/结余」（仍为 3000/8000/5000）',
    st.monthTotals.expense === 300000 && st.monthTotals.income === 800000 && st.monthTotals.balance === 500000,
    JSON.stringify(st.monthTotals));
  check('g17-disposable-minor-saving', '可支配 = 总余额 − 已攒 = 17500',
    st.disposable === 1750000 && st.summaryTexts[3].indexOf('17500') >= 0,
    `disposable=${st.disposable} text=${st.summaryTexts[3]}`);
  check('g18-list-renders-saving', '流水里攒钱记录渲染为「攒钱 + 目标名」，不是消费分类',
    st.recLabels.some((t) => t.indexOf('攒钱') >= 0 && t.indexOf('换新手机') >= 0),
    JSON.stringify(st.recLabels));
  shot('E10-home-after-deposit.png');

  /* 6. 取出 2000：真实触摸 取出 -> 输入 -> 确定 */
  await ev(`document.querySelector('.tab[data-page=goals]').click(); 'ok'`);
  await sleep(600);
  const outBtn = await ev(`(function(){var e=document.querySelectorAll('.goal-op')[1];if(!e)return null;var r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,dis:e.disabled,txt:e.textContent.trim()};})()`);
  check('g19-out-enabled', '有已攒后「取出」按钮变可用', outBtn && !outBtn.dis, JSON.stringify(outBtn));
  await tapEl('.goal-op', 1, '取出');
  sleepDev(0.8);
  flushDevice();
  pr = await probe();
  check('g20-out-sheet', '取出弹层标题/提示正确',
    pr.masksVisible.indexOf('savedMask') >= 0 && pr.sheetTitles[0] === '取出金额',
    `titles=${JSON.stringify(pr.sheetTitles)}`);
  await ev(`document.getElementById('savedAmountInput').focus(); 'ok'`);
  sleepDev(1.2);
  typeText('2000');
  sleepDev(0.5);
  flushDevice();
  const okC2 = await centerOf('#savedOk');
  tapCss(Math.round(okC2.x), Math.round(okC2.y), '确定（取出，一次触摸）');
  sleepDev(1.2);
  flushDevice();
  st = await recall();
  check('g21-withdraw-applied', '取出 2000 后已攒 = 500，且落成 income + savingsKind=out 记录',
    st.goals[0].saved === 50000 && st.savedTotal === 50000 && st.savingsRecs.length === 2 &&
      st.savingsRecs[1].type === 'income' && st.savingsRecs[1].kind === 'out',
    `saved=${st.goals[0].saved} recs=${JSON.stringify(st.savingsRecs)}`);
  check('g22-withdraw-not-in-stats', '取出也不进收支统计（本月收入仍 8000、支出仍 3000、可支配 19500）',
    st.monthTotals.income === 800000 && st.monthTotals.expense === 300000 && st.disposable === 1950000,
    JSON.stringify({ m: st.monthTotals, disposable: st.disposable }));
  shot('E11-after-withdraw.png');

  /* 7. 取出超额被拦（不改数据） */
  await tapEl('.goal-op', 1, '取出');
  sleepDev(0.8);
  flushDevice();
  await ev(`document.getElementById('savedAmountInput').focus(); 'ok'`);
  sleepDev(1.0);
  typeText('9999');
  sleepDev(0.4);
  flushDevice();
  /* ---- 队长点名要的「最关键」一条：键盘弹起时校验提示 toast 是否真的在键盘上方 ----
     关键时序：键盘上沿必须在**点击之前**量（点完键盘很快收起，之后量到的不是用户看到提示那一刻）；
     toast 只在 1900ms 内可见，所以点击用 CDP 鼠标事件（比 adb tap 快），点完立刻读页面。 */
  const okC3 = await centerOf('#savedOk');
  const kbProbeShot = 'E12a-keyboard-up-before-confirm.png';
  const kbRef = keyboardTopCss(kbProbeShot);      // 此刻键盘是弹起的（上面刚验过 mInputShown=true）
  const kbShownBefore = kbShown();
  await mouseClick(Math.round(okC3.x), Math.round(okC3.y));
  log(`  [rmb/cdp-click] 确定（超额取出）css(${Math.round(okC3.x)},${Math.round(okC3.y)})`);
  st = await recall();
  const toastTxt = st.toast ? st.toast.text : '';
  const tr = st.toastRect;
  const guardPx = await ev(`(function(){var v=getComputedStyle(document.body).getPropertyValue('--sheet-guard');return v?parseFloat(v):null})()`);
  check('g23-over-withdraw-blocked', '取出超过已攒被拦（弹层仍开、无新记录、已攒不变 500）',
    st.goals[0].saved === 50000 && st.savingsRecs.length === 2 && toastTxt.indexOf('不能超过') >= 0,
    `saved=${st.goals[0].saved} recs=${st.savingsRecs.length} toast="${toastTxt}"`);
  check('g23a-toast-above-keyboard',
    '校验提示 toast 出现在键盘上方（键盘上沿取自点击前的像素实测；toast 取自点击后立刻的 DOM 实测）',
    !!tr && !tr.hidden && tr.height > 0 && kbRef.css !== null && tr.bottom <= kbRef.css && tr.top >= 0,
    `toast top=${tr && tr.top} bottom=${tr && tr.bottom} height=${tr && tr.height}；键盘上沿=${kbRef.css} CSS px（物理 ${kbRef.physical}，来源：点击前截图像素测量，mInputShown=${kbShownBefore}）；两者间隙=${tr && kbRef.css !== null ? Math.round(kbRef.css - tr.bottom) : '?'} CSS px；文案="${toastTxt}"`);
  shot('E12-over-withdraw.png');
  saveJson('probe-toast-vs-keyboard.json', {
    toast: tr,
    toastBottomCss: tr ? tr.bottom : null,
    keyboardTopCss: kbRef.css,
    keyboardTopPhysical: kbRef.physical,
    keyboardShownBeforeClick: kbShownBefore,
    sheetGuardPx: guardPx,
    gapCss: tr && kbRef.css !== null ? Math.round(kbRef.css - tr.bottom) : null,
    measurement: '键盘上沿 = 点击前截图 E12a 的像素扫描（键盘面板亮度 ≈240 vs 被遮页面 ≈147 的跳变行）；toast 矩形 = 点击后立刻的 getBoundingClientRect()',
    note: '键盘在点击后约 45ms 内收起，所以「键盘在屏」的那一帧与「toast 在屏」的那一帧不重叠；本项验证的是 toast 相对键盘上沿的位置关系。',
  });

  /* 关闭弹层：键盘开着时点「取消」（真实触摸），不用 KEYCODE_BACK
     —— 实测 KEYCODE_BACK 会把 Activity 退到桌面，WebView 的 DevTools 桥随之卡死（/json 超时） */
  const cancelC = await centerOf('#savedCancel');
  tapCss(Math.round(cancelC.x), Math.round(cancelC.y), '取消（关掉取出弹层）');
  sleepDev(0.8);
  flushDevice();
  pr = await probe();
  check('g24-mask-closed-by-cancel', '键盘开着时点「取消」一次即可关闭弹层并清掉键盘态',
    pr.masksVisible.length === 0 && pr.bodyClass === '',
    `masks=${JSON.stringify(pr.masksVisible)} bodyClass="${pr.bodyClass}"`);

  /* 8. 补存到目标 -> 达成态；再验证负数可支配 */
  await tapEl('.goal-op', 0, '存入');
  sleepDev(0.8);
  flushDevice();
  await ev(`document.getElementById('savedAmountInput').focus(); 'ok'`);
  sleepDev(1.0);
  typeText('5500');
  sleepDev(0.4);
  flushDevice();
  const okC4 = await centerOf('#savedOk');
  tapCss(Math.round(okC4.x), Math.round(okC4.y), '确定（补存到 6000）');
  sleepDev(1.2);
  flushDevice();
  st = await recall();
  check('g25-goal-reached', '已攒达到目标金额 6000 -> 达成态（saved == target，卡片显示已达成）',
    st.goals[0].saved === 600000 && st.goals[0].est.status === 'done',
    JSON.stringify({ saved: st.goals[0].saved, est: st.goals[0].est }));
  const reachedTxt = await ev(`(function(){var c=document.querySelector('.goal-card');return c?c.textContent.replace(/\\s+/g,' ').trim():null})()`);
  check('g26-reached-card-text', '达成卡片文案为「已达成 🎉」且不再显示估算行',
    reachedTxt && reachedTxt.indexOf('已达成') >= 0 && reachedTxt.indexOf('还需') < 0,
    reachedTxt);
  shot('E13-goal-reached.png');

  await ev(`document.querySelector('.tab[data-page=home]').click(); 'ok'`);
  await sleep(500);
  st = await recall();
  const negTxt = st.summaryTexts[3];
  check('g27-disposable-negative-not-clamped', '可支配可为负且不截断（余额 20000−已攒 6000 = 14000）',
    st.disposable === 1400000 && negTxt.indexOf('14000') >= 0,
    `disposable=${st.disposable} text=${negTxt}`);

  return { pid, seed };
}

/* ---------------- 追加场景：补存到达成 + 负数可支配（不重跑前面） ---------------- */
async function phaseReach() {
  log('\n=== phase reach（补存到目标达成 / 可支配可为负） ===');
  page = await getTarget();
  S = connect(page.webSocketDebuggerUrl);
  await S.ready;
  await ev(`document.querySelector('.tab[data-page=goals]').click(); 'ok'`);
  await sleep(600);
  let st = await recall();
  log('  当前: ' + JSON.stringify({ saved: st.goals[0] && st.goals[0].saved, recs: st.savingsRecs.length }));
  const pr0 = await probe();
  check('r0-precondition', '前置状态：1 个目标、已攒 500、弹层已关',
    st.goals.length === 1 && st.goals[0].saved === 50000 && pr0.masksVisible.length === 0,
    JSON.stringify({ goals: st.goals.length, saved: st.goals[0] && st.goals[0].saved, masks: pr0.masksVisible }));

  await tapEl('.goal-op', 0, '存入');
  sleepDev(0.8);
  flushDevice();
  await ev(`document.getElementById('savedAmountInput').focus(); 'ok'`);
  sleepDev(1.1);
  typeText('5500');
  sleepDev(0.5);
  flushDevice();
  const c = await centerOf('#savedOk');
  tapCss(Math.round(c.x), Math.round(c.y), '确定（补存 5500）');
  sleepDev(1.3);
  flushDevice();
  st = await recall();
  const reachedTxt = await ev(`(function(){var c=document.querySelector('.goal-card');return c?c.textContent.replace(/\\s+/g,' ').trim():null})()`);
  check('r1-goal-reached', '补存 5500 后已攒 = 目标 6000 -> 达成态（est.status=done）',
    st.goals[0].saved === 600000 && st.goals[0].est.status === 'done',
    JSON.stringify({ saved: st.goals[0].saved, est: st.goals[0].est }));
  check('r2-reached-card-text', '达成卡片显示「已达成 🎉」且不再显示估算行',
    reachedTxt && reachedTxt.indexOf('已达成') >= 0 && reachedTxt.indexOf('还需') < 0,
    reachedTxt);
  shot('E13-goal-reached.png');

  await ev(`document.querySelector('.tab[data-page=home]').click(); 'ok'`);
  await sleep(600);
  st = await recall();
  check('r3-disposable-after-reach', '可支配 = 总余额 20000 − 已攒 6000 = 14000（随已攒继续扣减）',
    st.disposable === 1400000 && st.summaryTexts[3].indexOf('14000') >= 0,
    `disposable=${st.disposable} text=${st.summaryTexts[3]}`);
  shot('E14-home-after-reach.png');
  return { ok: true };
}

/* ---------------- 首页键盘适配 + 记一笔一次触摸 ---------------- */
async function phaseEntry() {
  log('\n=== phase entry（首页键盘适配 / 收支切换 / 一次触摸保存） ===');
  page = await getTarget();
  S = connect(page.webSocketDebuggerUrl);
  await S.ready;
  /* 清干净上一轮留下的弹层/键盘态，否则首页会被遮罩挡住（实测过：点了金额框却命中 savedMaskTitle） */
  await ev(`(function(){
    ['goalMask','savedMask','editMask','dateMask','confirmMask'].forEach(function(id){var e=document.getElementById(id);if(e)e.hidden=true;});
    if (document.activeElement&&document.activeElement.blur) document.activeElement.blur();
    document.body.classList.remove('sheet-kb-open','kb-open');
    return 'cleaned';
  })()`);
  await ev(`document.querySelector('.tab[data-page=home]').click(); 'ok'`);
  await sleep(700);
  sleepDev(0.4);
  flushDevice();
  const clean = await probe();
  check('e0-home-clean', '前置：首页在最前、无弹层遮挡（金额框的命中测试落在金额框本身）',
    clean.page === 'page-home' && clean.masksVisible.length === 0 &&
    clean.amountHitTest && clean.amountHitTest.isAmountInput,
    `page=${clean.page} masks=${JSON.stringify(clean.masksVisible)} 命中=${clean.amountHitTest && clean.amountHitTest.elementAtPoint}`);

  let pr = clean;
  check('e1-baseline-catstrip', '键盘未弹起：分类条完整可见',    pr.bodyClass === '' && pr.catItemCount > 0,
    `bodyClass="${pr.bodyClass}" catItems=${pr.catItemCount} ${JSON.stringify(pr.catItemTexts.slice(0, 4))}`);
  shot('E20-entry-baseline.png');

  /* 真实触摸金额框 -> 键盘 */
  const ai = await centerOf('#amountInput');
  tapCss(Math.round(ai.x), Math.round(ai.y), '金额输入框');
  sleepDev(1.3);
  flushDevice();
  pr = await probe();
  const kb = kbShown();
  check('e2-amount-visible-with-keyboard', '键盘弹起时金额行仍在屏幕内、且该点命中的就是金额输入框（未被键盘/其他元素遮挡）',
    kb && pr.amount && pr.amount.b <= 915 && pr.amountHitTest && pr.amountHitTest.isAmountInput,
    `kb=${kb} 金额框=${JSON.stringify(pr.amount)} 金额行=${JSON.stringify(pr.amountRowRect)} 命中的元素=${pr.amountHitTest && pr.amountHitTest.elementAtPoint}`);
  check('e3-type-toggle-present-with-keyboard', '键盘弹起时「支出/收入」切换仍在屏内且未被禁用',
    pr.typeSeg && pr.typeSeg.count === 2 && pr.typeSeg.items.every((b) => !b.disabled && b.top >= 0 && b.bottom <= 915),
    JSON.stringify(pr.typeSeg));
  shot('E21-entry-keyboard.png');

  /* 触摸「收入」分段按钮，验证一次触摸即切换 */
  const incomeBtn = pr.typeSeg.items.find((b) => b.type === 'income') || pr.typeSeg.items[1];
  tapCss(incomeBtn.cx, incomeBtn.cy, '收入');
  sleepDev(0.7);
  flushDevice();
  const activeType = await ev(`(function(){var b=document.querySelector('#typeSwitch .seg-btn.is-active, #typeSwitch button.is-active');return b?b.getAttribute('data-type'):null})()`);
  const activeTxt = await ev(`(function(){var b=document.querySelector('#typeSwitch .is-active');return b?b.textContent.trim():null})()`);
  check('e4-type-toggle-one-tap', '键盘弹起时一次触摸切到「收入」',
    activeType === 'income', `activeType=${activeType} text=${activeTxt}`);
  shot('E22-entry-income-selected.png');

  /* 输入金额（键盘在切「收入」后被收起，需重新聚焦金额框） */
  await ev(`document.getElementById('amountInput').focus(); 'ok'`);
  sleepDev(1.2);
  flushDevice();
  typeText('123');
  sleepDev(0.5);
  flushDevice();
  const before = await ev(`Store.Records.all().length`);
  const sbNow = await ev(`(function(){var e=document.getElementById('saveBtn');var r=e.getBoundingClientRect();
    return JSON.stringify({cx:Math.round(r.left+r.width/2),cy:Math.round(r.top+r.height/2),top:Math.round(r.top),bottom:Math.round(r.bottom),
      amountVal:document.getElementById('amountInput').value, catId:Store.Categories.byType(document.querySelector('#typeSwitch .is-active').getAttribute('data-type'))[0].id,
      activeType:document.querySelector('#typeSwitch .is-active').getAttribute('data-type')});})()`);
  const sb = JSON.parse(sbNow);
  log('  保存前现场：' + sbNow);
  check('e4b-entry-zone-state-before-save', '键盘弹起时记账面板元素仍在屏内（金额行/保存键都可见）',
    sb.top > 0 && sb.bottom <= 915 && sb.amountVal === '123',
    `saveBtn=${sb.top}..${sb.bottom} amountVal="${sb.amountVal}" activeType=${sb.activeType}`);
  tapCss(sb.cx, sb.cy, '保存（一次触摸）');
  sleepDev(1.2);
  flushDevice();
  const after = await ev(`Store.Records.all().length`);
  const top = await ev(`(function(){var r=Store.Records.sorted()[0];return JSON.stringify({amount:r.amount,type:r.type,goalId:r.goalId,note:r.note})})()`);
  const stillKb = kbShown();
  check('e5-save-one-tap-no-duplicate', '一次触摸「保存」只记下一笔（记录数恰好 +1，无重复）',
    after === before + 1, `before=${before} after=${after} 新增=${after - before} 最新记录=${top}`);
  check('e6-save-keeps-keyboard', '保存后键盘仍保持弹起（保存是纯写入，不主动收键盘）',
    stillKb === true, `keyboardShown=${stillKb}`);
  const amtVal = await ev(`document.getElementById('amountInput').value`);
  const noteVal = await ev(`document.getElementById('noteInput').value`);
  check('e7-save-clears-inputs', '保存后金额框与备注框都清空（便于连续记账）',
    amtVal === '' && noteVal === '', `amountInput="${amtVal}" noteInput="${noteVal}"`);
  shot('E23-entry-after-save.png');

  /* 收键盘：让输入框失焦（不用 KEYCODE_BACK —— 它会把 Activity 退到桌面，
     WebView 的 DevTools 桥随之卡死，实测 /json 超时）。 */
  await ev(`(function(){ if(document.activeElement) document.activeElement.blur(); return 'blurred'; })()`);
  sleepDev(0.9);
  flushDevice();
  const kbAfter = kbShown();
  const msg = await ev(`document.querySelector('.summary-bar').textContent.replace(/\\s+/g,' ').trim()`);
  log('  收键盘后：kbShown=' + kbAfter + ' 汇总条=' + msg);
  const sumVisible = await ev(`(function(){var e=document.querySelector('.summary-bar');var r=e.getBoundingClientRect();return r.height>0})()`);
  check('e8-summary-back-after-close', '键盘收起后 body.kb-open 清除、汇总条重新出现', sumVisible === true && kbAfter === false,
    `keyboardShown=${kbAfter} summary="${msg}"`);
  shot('E24-entry-kb-closed.png');
  return { ok: true };
}

/* ---------------- 设置页分类排序 ---------------- */
async function phaseSettings() {
  log('\n=== phase settings（分类排序 ▲▼） ===');
  page = await getTarget();
  S = connect(page.webSocketDebuggerUrl);
  await S.ready;
  await ev(`document.querySelector('.tab[data-page=settings]').click(); 'ok'`);
  await sleep(700);

  const before = await ev(`JSON.stringify({exp:Store.Categories.byType('expense').map(function(c){return c.name}),inc:Store.Categories.byType('income').map(function(c){return c.name})})`);
  log('  before: ' + before);
  const chips0 = await ev(`JSON.stringify([].slice.call(document.querySelectorAll('.cat-chip')).map(function(e){return e.textContent.replace(/\\s+/g,'').replace(/[▲▼×]/g,'')}))`);
  log('  chips: ' + chips0);
  const disabledFirst = await ev(`(function(){var b=document.querySelectorAll('.chip-move')[0];return b?b.disabled:null})()`);
  const bounds = await ev(`(function(){
    var rows=[].slice.call(document.querySelectorAll('.cat-chip-row'));
    return JSON.stringify(rows.map(function(row){
      var chips=[].slice.call(row.querySelectorAll('.cat-chip'));
      var firstUp=chips[0].querySelectorAll('.chip-move')[0].disabled;
      var lastDown=chips[chips.length-1].querySelectorAll('.chip-move')[1].disabled;
      return {count:chips.length, firstUpDisabled:firstUp, lastDownDisabled:lastDown};
    }));
  })()`);
  check('s1-boundaries-disabled', '每组第一个的 ▲ 与最后一个的 ▼ 都禁用（到顶/到底）',
    disabledFirst === true && JSON.parse(bounds).every((r) => r.firstUpDisabled && r.lastDownDisabled),
    `rows=${bounds}`);

  /* 触摸收入组第二项的 ▲（把「奖金」上移到第一位） */
  const target = await ev(`(function(){
    var chips=[].slice.call(document.querySelectorAll('.cat-chip'));
    for (var i=0;i<chips.length;i++){
      var label=chips[i].textContent.replace(/\\s+/g,'').replace(/[▲▼×]/g,'');
      if (label==='🎉奖金'){
        var b=chips[i].querySelectorAll('.chip-move')[0];
        var r=b.getBoundingClientRect();
        return JSON.stringify({i:i,x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),dis:b.disabled});
      }
    }
    return null;
  })()`);
  log('  奖金 ▲ -> ' + target);
  const t = JSON.parse(target);
  tapCss(t.x, t.y, '奖金上移');
  sleepDev(0.9);
  flushDevice();
  const afterUp = await ev(`JSON.stringify({inc:Store.Categories.byType('income').map(function(c){return c.name}),chips:[].slice.call(document.querySelectorAll('.cat-chip')).map(function(e){return e.textContent.replace(/\\s+/g,'').replace(/[▲▼×]/g,'')}).slice(-5)})`);
  log('  after up: ' + afterUp);
  const au = JSON.parse(afterUp);
  check('s2-move-up-works', '一次触摸 ▲ 上移生效（数据顺序 + 设置页 DOM 渲染顺序）',
    au.inc[0] === '奖金' && au.chips[0] === '🎉奖金',
    JSON.stringify(au));

  /* 触摸它自己的 ▼ 还原 */
  const target2 = await ev(`(function(){
    var chips=[].slice.call(document.querySelectorAll('.cat-chip'));
    for (var i=0;i<chips.length;i++){
      var label=chips[i].textContent.replace(/\\s+/g,'').replace(/[▲▼×]/g,'');
      if (label==='🎉奖金'){
        var b=chips[i].querySelectorAll('.chip-move')[1];
        var r=b.getBoundingClientRect();
        return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});
      }
    }
    return null;
  })()`);
  const t2 = JSON.parse(target2);
  tapCss(t2.x, t2.y, '奖金下移（还原）');
  sleepDev(0.9);
  flushDevice();
  const afterDown = await ev(`JSON.stringify({inc:Store.Categories.byType('income').map(function(c){return c.name}),chips:[].slice.call(document.querySelectorAll('.cat-chip')).map(function(e){return e.textContent.replace(/\s+/g,'').replace(/[▲▼×]/g,'')}).slice(-5)})`);
  log('  after down: ' + afterDown);
  const ad = JSON.parse(afterDown);
  check('s3-move-down-restores', '一次触摸 ▼ 下移生效并可还原为原始顺序',
    ad.inc[0] === '工资' && ad.chips[0] === '💰工资',
    JSON.stringify(ad));
  shot('E30-settings-order.png');

  /* 记账页分类条顺序与设置页一致。
     注意：分类条渲染的是**当前选中的收支类型**的分类（上次操作可能把类型切成了「收入」），
     所以要和 byType(当前类型) 比，而不是固定拿支出组比。 */
  await ev(`document.querySelector('.tab[data-page=home]').click(); 'ok'`);
  await sleep(600);
  const activeType = await ev(`(function(){var b=document.querySelector('#typeSwitch .is-active');return b?b.getAttribute('data-type'):null})()`);
  const strip = await ev(`JSON.stringify([].slice.call(document.querySelectorAll('#catStrip .cat-item')).map(function(e){return e.textContent.replace(/\s+/g,'')}))`);
  const dataIcons = await ev(`JSON.stringify(Store.Categories.byType(${JSON.stringify('PLACEHOLDER')}).map(function(c){return c.icon+c.name}))`.replace('"PLACEHOLDER"', 'document.querySelector("#typeSwitch .is-active").getAttribute("data-type")'));
  const settingsDom = await ev(`JSON.stringify([].slice.call(document.querySelectorAll('.cat-chip-row')).map(function(r){return [].slice.call(r.querySelectorAll('.cat-chip')).map(function(c){return c.textContent.replace(/\s+/g,'').replace(/[▲▼×]/g,'')})}))`);
  const storedOrder = await ev(`JSON.stringify(JSON.parse(localStorage.getItem('jizhang.categories.v1')).map(function(c){return c.icon+c.name}))`);
  log('  activeType: ' + activeType);
  log('  strip(记账页分类条): ' + strip);
  log('  dataIcons(byType): ' + dataIcons);
  log('  settingsDom: ' + settingsDom);
  const incomeDom = JSON.parse(settingsDom)[1];
  const expenseDom = JSON.parse(settingsDom)[0];
  const incomeStored = JSON.parse(storedOrder).slice(-JSON.parse(settingsDom)[1].length);
  check('s4-three-places-consistent', '三处顺序一致：localStorage 数组 / 设置页 DOM / 记账页分类条（按当前收支类型比对）',
    JSON.stringify(JSON.parse(strip)) === JSON.stringify(JSON.parse(dataIcons)) &&
    JSON.stringify(incomeDom) === JSON.stringify(incomeStored) &&
    JSON.stringify(expenseDom) === JSON.stringify(JSON.parse(storedOrder).slice(0, expenseDom.length)),
    `activeType=${activeType} strip=${strip.slice(0, 90)} dataIcons=${String(dataIcons).slice(0, 90)}`);
  check('s4b-strip-matches-data', '记账页分类条的图标+名称顺序 = Store.byType(当前类型) 的顺序',
    JSON.stringify(JSON.parse(strip)) === JSON.stringify(JSON.parse(dataIcons)),
    `strip=${strip} dataIcons=${dataIcons}`);
  check('s4c-settings-dom-matches-store', '设置页两组 DOM 顺序 = localStorage 数组顺序（支出组在前、收入组在后）',
    JSON.stringify(expenseDom) === JSON.stringify(JSON.parse(storedOrder).slice(0, expenseDom.length)) &&
    JSON.stringify(incomeDom) === JSON.stringify(incomeStored),
    `expenseDom=${JSON.stringify(expenseDom).slice(0, 80)} incomeDom=${JSON.stringify(incomeDom)}`);
  shot('E31-entry-strip.png');
  return { ok: true };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();
  if (PHASE === 'goals' || PHASE === 'all') await phaseGoals();
  if (PHASE === 'reach') await phaseReach();
  if (PHASE === 'entry' || PHASE === 'all') await phaseEntry();
  if (PHASE === 'settings' || PHASE === 'all') await phaseSettings();
  const summary = { phase: PHASE, seconds: Math.round((Date.now() - t0) / 1000), pass: results.filter((r) => r.pass).length, fail: results.filter((r) => !r.pass).length, results };
  saveJson(`e2e-${PHASE}-result.json`, summary);
  log(`\n=== ${PHASE}: ${summary.pass} passed, ${summary.fail} failed (${summary.seconds}s) ===`);
  if (summary.fail) for (const r of results.filter((x) => !x.pass)) log(`FAIL ${r.id}: ${r.desc} :: ${r.detail}`);
  if (S) S.ws.close();
  process.exit(summary.fail ? 1 : 0);
}

main().catch((e) => { console.error('DRIVER ERROR: ' + e.stack); process.exit(2); });
