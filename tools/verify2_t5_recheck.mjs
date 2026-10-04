/* verify2 独立复核 t5 三项改动（自造数据，不复用实现者的测试文件）。
   做法：把**真实的** store.js 与 app.js 一起加载进 node vm，
   用最小 DOM stub 顶掉 document/localStorage，这样连渲染路径也真的跑起来。

   覆盖 t6 要求的 2)3)4)5)6)7) 与 8) 的一部分。
   用法: node tools/verify2_t5_recheck.mjs */
import fs from 'node:fs';
import vm from 'node:vm';

const STORE_SRC = fs.readFileSync('app/src/main/assets/www/js/store.js', 'utf8');
const APP_SRC = fs.readFileSync('app/src/main/assets/www/js/app.js', 'utf8');
const DOM = JSON.parse(fs.readFileSync('verify2-out/dom-ids.json', 'utf8'));

const results = [];
function check(id, desc, pass, detail) {
  results.push({ id, desc, pass: !!pass, detail: String(detail === undefined ? '' : detail) });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${id}] ${desc}${detail !== undefined ? ' :: ' + detail : ''}`);
}

/* ---------------- DOM stub ---------------- */
function makeEl(id, tag = 'div') {
  const el = {
    id, tagName: String(tag).toUpperCase(),
    textContent: '', innerHTML: '', value: '', hidden: false,
    className: '', disabled: false, style: { setProperty() {}, removeProperty() {} },
    children: [], _listeners: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
                 toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) this._s.add(c); else this._s.delete(c); },
                 contains(c) { return this._s.has(c); } },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, focus() { doc.activeElement = this; }, blur() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    contains() { return false; },
  };
  return el;
}

const els = new Map();
for (const id of DOM.ids) els.set(id, makeEl(id, DOM.tags[id] || 'div'));
for (const [id, ex] of Object.entries(DOM.extra || {})) {
  const el = els.get(id);
  if (el && ex.className) el.className = ex.className;
}

const doc = {
  readyState: 'complete',
  activeElement: null,
  body: makeEl('body', 'body'),
  documentElement: makeEl('html', 'html'),
  getElementById: (id) => els.get(id) || null,
  querySelector: (sel) => {
    const m = /^#([\w-]+)$/.exec(sel);
    if (m) return els.get(m[1]) || null;
    return null;
  },
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
  createElement: (t) => makeEl('', t),
};

const storage = new Map();
const sandbox = {
  console, JSON, Date, Math, Number, String, Array, Object, parseInt, parseFloat, isNaN,
  RegExp, Error, TypeError, isFinite, Boolean, Set, Map, Promise, encodeURIComponent, decodeURIComponent,
  document: doc,
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  requestAnimationFrame: () => 0,
  Event: function (t) { this.type = t; },
  CustomEvent: function (t) { this.type = t; },
};
sandbox.window = sandbox;
sandbox.global = sandbox;
sandbox.navigator = { userAgent: 'node-vm' };
sandbox.addEventListener = () => {};
sandbox.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
vm.createContext(sandbox);

/* 先只加载 store.js：这样测试可以在 app.js 触发渲染之前把数据灌好 */
vm.runInContext(STORE_SRC, sandbox, { filename: 'store.js' });
const S = sandbox.Store;

/* ---------------- 2) 已攒自动汇总：存500 + 存300 + 取200 = 600 ---------------- */
const addRes = S.Savings.add({ name: '换新手机', targetAmount: '5000', icon: '📱' });
const goal = S.Savings.all()[0];
const d1 = S.Savings.deposit(goal.id, '500');
const d2 = S.Savings.deposit(goal.id, '300');
const w1 = S.Savings.withdraw(goal.id, '200');
const saved = S.Savings.savedAmount(goal.id);
const savedTotal = S.Savings.savedTotal();
check('t6-2-savedAmount-600',
  '已攒自动汇总：存入 500 + 存入 300 + 取出 200 → savedAmount = 600 元',
  addRes.ok && d1.ok && d2.ok && w1.ok && saved === 60000,
  `savedAmount=${saved}分=${saved / 100}元 d1=${JSON.stringify(d1)} d2=${JSON.stringify(d2)} w1=${JSON.stringify(w1)}`);
check('t6-2b-savedTotal-600', 'savedTotal 与单目标已攒同步 = 600 元', savedTotal === 60000,
  `savedTotal=${savedTotal}分=${savedTotal / 100}元`);
const recsNow = S.Records.all();
check('t6-2c-record-shape',
  '三条攒钱记录的形状：存入=expense/in、取出=income/out，且 categoryId=null',
  recsNow.length === 3 &&
  recsNow.filter((r) => r.savingsKind === 'in').every((r) => r.type === 'expense' && r.categoryId === null) &&
  recsNow.filter((r) => r.savingsKind === 'out').every((r) => r.type === 'income' && r.categoryId === null),
  JSON.stringify(recsNow.map((r) => ({ a: r.amount, t: r.type, k: r.savingsKind, c: r.categoryId, g: r.goalId }))));
check('t6-2d-goal-has-no-savedField', '目标对象里不再存「已攒」字段（只有元数据）',
  goal.savedAmount === undefined && goal.saved === undefined &&
  JSON.stringify(Object.keys(goal).sort()) === JSON.stringify(['createdAt', 'icon', 'id', 'name', 'targetAmount', 'targetDate', 'updatedAt']),
  JSON.stringify(Object.keys(goal).sort()));

/* ---------------- 3) 取出超限拦截 ---------------- */
const beforeCount = S.Records.all().length;
const over = S.Savings.withdraw(goal.id, '700');
const afterCount = S.Records.all().length;
const savedAfterOver = S.Savings.savedAmount(goal.id);
check('t6-3-over-withdraw-rejected',
  '已攒 600 时取出 700 被拒，且不产生记录',
  over.ok === false && afterCount === beforeCount && savedAfterOver === 60000,
  `ok=${over.ok} msg="${over.msg}" 记录数 ${beforeCount}→${afterCount} savedAmount=${savedAfterOver / 100}元`);
check('t6-3b-msg-actionable',
  '拒绝提示给出明确上限（含「不能超过当前已攒 ¥600」与「最多可取 ¥600」）',
  /不能超过当前已攒 ¥600/.test(over.msg) && /最多可取 ¥600/.test(over.msg), over.msg);
const zeroW = S.Savings.withdraw(goal.id, '0');
const negW = S.Savings.withdraw(goal.id, '-5');
check('t6-3c-invalid-amounts-rejected', '取出 0 / 负数也被拒',
  zeroW.ok === false && negW.ok === false &&
  S.Records.all().length === beforeCount,
  `zero="${zeroW.msg}" neg="${negW.msg}" 记录数=${S.Records.all().length}`);
const exact = S.Savings.withdraw(goal.id, '600');
check('t6-3d-exact-allowed', '正好取完 600/600 允许，已攒归零',
  exact.ok === true && S.Savings.savedAmount(goal.id) === 0,
  `ok=${exact.ok} savedAmount=${S.Savings.savedAmount(goal.id)}`);
/* 回到 600 的状态，供后面「可支配」断言使用 */
S.Savings.deposit(goal.id, '600');

/* ---------------- 4) 攒钱不进统计（最关键）+ 5) 可支配 ---------------- */
const inc = S.Categories.byType('income')[0];        // 工资
const exp = S.Categories.byType('expense')[0];       // 餐饮
const mk = S.Stats.monthKey();
S.Records.add({ date: mk + '-05', type: 'expense', amount: 100, categoryId: exp.id });
S.Records.add({ date: mk + '-06', type: 'income', amount: 3000, categoryId: inc.id });
/* 上面 deposit 出来的 600 是攒钱记录，不该影响统计 */
const byMonth = S.Records.byMonth(mk);
const totals = S.Stats.totals(byMonth);
check('t6-4-totals-only-real',
  '有攒钱记录时 Stats.totals 的支出只算真实支出的 100（收入 3000、结余 2900）',
  totals.expense === 10000 && totals.income === 300000 && totals.balance === 290000,
  `expense=${totals.expense / 100} income=${totals.income / 100} balance=${totals.balance / 100}（分：${JSON.stringify(totals)}）`);
check('t6-4b-totals-same-without-savings',
  '对照：把攒钱记录从列表里剔除后 totals 完全一致（证明攒钱不参与）',
  (function () {
    const realOnly = byMonth.filter((r) => !r.goalId);
    const t2 = S.Stats.totals(realOnly);
    return t2.expense === totals.expense && t2.income === totals.income && t2.balance === totals.balance;
  })(), JSON.stringify(S.Stats.totals(byMonth.filter((r) => !r.goalId))));

const byCatExp = S.Stats.byCategory(byMonth, 'expense');
const byCatInc = S.Stats.byCategory(byMonth, 'income');
check('t6-4c-byCategory-no-savings',
  'byCategory 不出现攒钱记录（支出组只有餐饮 100，收入组只有工资 3000）',
  byCatExp.length === 1 && byCatExp[0].name === '餐饮' && byCatExp[0].total === 10000 && byCatExp[0].count === 1 &&
  byCatInc.length === 1 && byCatInc[0].name === '工资' && byCatInc[0].total === 300000 && byCatInc[0].count === 1,
  `支出=${JSON.stringify(byCatExp.map((x) => ({ n: x.name, t: x.total / 100, c: x.count })))} 收入=${JSON.stringify(byCatInc.map((x) => ({ n: x.name, t: x.total / 100, c: x.count })))}`);
const daily = S.Stats.dailyExpense(mk);
check('t6-4d-dailyExpense-no-savings',
  '每日支出柱状图跳过攒钱存入（合计 100，且只有 5 号那天有值）',
  daily.reduce((a, b) => a + b, 0) === 10000 && daily[4] === 10000 && daily.filter((v) => v > 0).length === 1,
  `合计=${daily.reduce((a, b) => a + b, 0) / 100}元 非零天数=${daily.filter((v) => v > 0).length}`);

const allTotals = S.Stats.totals(S.Records.all());
const savedTotal2 = S.Savings.savedTotal();
const disposable = allTotals.balance - savedTotal2;
const manualBalance = 3000 - 100;   // 真实收入 − 真实支出
const manualDisposable = manualBalance - 600;
check('t6-5-disposable-handcalc',
  '可支配 = 总余额 − savedTotal，与手算一致（2900 − 600 = 2300）',
  allTotals.balance === manualBalance * 100 && savedTotal2 === 60000 && disposable === manualDisposable * 100,
  `实测 总余额=${allTotals.balance / 100} savedTotal=${savedTotal2 / 100} 可支配=${disposable / 100}；手算 2900 − 600 = ${manualDisposable}`);
/* 负数不截断：再攒 5000 */
S.Savings.deposit(goal.id, '5000');
const negDisposable = S.Stats.totals(S.Records.all()).balance - S.Savings.savedTotal();
check('t6-5b-disposable-can-be-negative',
  '可支配可以为负且不被截断（余额 2900 − 已攒 5600 = −2700）',
  negDisposable === -270000,
  `实测 disposable=${negDisposable / 100} 元（分：${negDisposable}）`);

/* ---------------- 6) 分类排序 ---------------- */
const expBefore = S.Categories.byType('expense').map((c) => c.name);
const moved = S.Categories.move(S.Categories.byType('expense')[0].id, 1);
const expAfter = S.Categories.byType('expense').map((c) => c.name);
check('t6-6-in-group-move-changes-order',
  '同组内下移后 Categories.byType 顺序真的改变（前两名互换）',
  moved.ok === true && expAfter[0] === expBefore[1] && expAfter[1] === expBefore[0] &&
  expAfter.length === expBefore.length,
  `before=${JSON.stringify(expBefore)} after=${JSON.stringify(expAfter)} move=${JSON.stringify(moved)}`);
const storedCats = JSON.parse(storage.get('jizhang.categories.v1')).map((c) => c.name);
const storedWithType = JSON.parse(storage.get('jizhang.categories.v1'));
/* 存储里是「全部支出组 + 全部收入组」的交错数组，byType 是按 type 过滤出来的；
   一致性应比对 byType('expense') + byType('income') 的拼接 */
const expectedConcat = S.Categories.byType('expense').map((c) => c.name)
  .concat(S.Categories.byType('income').map((c) => c.name));
check('t6-6b-localStorage-order-matches',
  'localStorage 里 jizhang.categories.v1 的数组顺序 = byType(expense) + byType(income) 拼接（同组顺序一致，收入组开头无支出项）',
  JSON.stringify(storedCats) === JSON.stringify(expectedConcat) &&
  storedWithType.filter((c) => c.type === 'income')[0].name === S.Categories.byType('income')[0].name,
  `stored=${JSON.stringify(storedCats)} expected=${JSON.stringify(expectedConcat)}`);
const incNamesBefore = S.Categories.byType('income').map((c) => c.name);
const expList = S.Categories.byType('expense');
const crossDown = S.Categories.move(expList[expList.length - 1].id, 1);
const crossUp = S.Categories.move(expList[0].id, -1);
check('t6-6c-cross-group-blocked',
  '跨组移动被阻止：支出组最后一个再下移、第一个再上移都返回失败',
  crossDown.ok === false && crossUp.ok === false,
  `down="${crossDown.msg}" up="${crossUp.msg}"`);
check('t6-6d-other-group-untouched',
  '移动只影响本组，收入组顺序不变',
  JSON.stringify(S.Categories.byType('income').map((c) => c.name)) === JSON.stringify(incNamesBefore),
  JSON.stringify(S.Categories.byType('income').map((c) => c.name)));
/* 这一段前面的 6c 已经对当前第一位做过一次「上移」并返回「已经是第一个了」，
   所以这里不再重复断言边界，只验一个完整的 下移→上移 可逆循环：
   取目前的第二位（餐饮）下移一格，再上移一格，应回到原位。 */
const cycleName = S.Categories.byType('expense')[1].name;
const cycleId = S.Categories.byType('expense')[1].id;
const beforeCycle = S.Categories.byType('expense').map((c) => c.name);   // 以「循环开始前」为基准，别用更早的 expBefore
const downOne = S.Categories.move(cycleId, 1);
const orderAfterDown = S.Categories.byType('expense').map((c) => c.name);
const upOne = S.Categories.move(cycleId, -1);
const orderAfterUp = S.Categories.byType('expense').map((c) => c.name);
check('t6-6e-move-cycle-reversible',
  '同一个分类 下移一格 → 再上移一格 可回到原位（下移/上移都真的生效）',
  downOne.ok === true && upOne.ok === true &&
  orderAfterDown[2] === cycleName && orderAfterDown[1] !== cycleName &&
  orderAfterUp[1] === cycleName && JSON.stringify(orderAfterUp) === JSON.stringify(beforeCycle),
  `item=${cycleName} down=${JSON.stringify(downOne)} 下移后=${JSON.stringify(orderAfterDown)} up=${JSON.stringify(upOne)} 上移后=${JSON.stringify(orderAfterUp)} 基准=${JSON.stringify(beforeCycle)}`);

/* ---------------- 7) 旧数据兼容 + 真实渲染 app.js ----------------
   注意：本 App 的 amount 一律按「分」存整数（store.js 的 toCents），
   所以存量 fixture 也必须用分，否则就是在测一个不存在的历史数据形态。 */
const rawRecs = JSON.parse(storage.get('jizhang.records.v1'));
rawRecs.push({ id: 'legacy-no-goal-field', amount: 123400, type: 'expense', categoryId: null,
               date: mk + '-07', note: '存量数据', createdAt: 1 });
rawRecs.push({ id: 'legacy-goal-null', amount: 55500, type: 'expense', categoryId: null,
               goalId: null, date: mk + '-08', note: '', createdAt: 2 });
storage.set('jizhang.records.v1', JSON.stringify(rawRecs));

let renderErr = null;
let summaryHtml = '';
let listHtml = '';
try {
  /* 现在加载真实的 app.js：它在末尾会自己 init() → renderHome() → 渲染汇总条与流水 */
  vm.runInContext(APP_SRC, sandbox, { filename: 'app.js' });
  summaryHtml = els.get('summaryBar').innerHTML;
  listHtml = els.get('listScroll').innerHTML;
} catch (e) {
  renderErr = e && (e.stack || e.message || String(e));
}
check('t6-7-legacy-render-no-throw',
  '含「没有 goalId 字段」与「goalId=null」的存量记录时，真实 app.js 的渲染不抛错',
  renderErr === null, renderErr ? renderErr.split('\n').slice(0, 4).join(' | ') : 'no exception');
const legacyTotals = S.Stats.totals(S.Records.all());
check('t6-7b-legacy-counted-in-totals',
  '存量记录照常进统计（支出 = 100 + 1234 + 555 = 1889 元，未被当成攒钱）',
  legacyTotals.expense === 188900,
  `实测 expense=${legacyTotals.expense / 100} 元（期望 1889）`);
check('t6-7c-legacy-rendered-as-expense',
  '存量记录在流水里按普通记录渲染（出现「未分类」而不是「攒钱」）',
  /未分类/.test(listHtml) && !/攒钱/.test(listHtml.split('存量数据')[0] || ''),
  `listHtml 含「未分类」=${/未分类/.test(listHtml)}；含行「${(listHtml.match(/<div class="rec-cat">[^<]*<\/div>/g) || []).join(' ')}` + '"');
check('t6-7d-summary-bar-real-only',
  '汇总条（真实渲染结果）只含真实收支：支出 1889 / 收入 3000 / 结余 1111 / 可支配 −4489',
  (function () {
    const nums = (summaryHtml.match(/>(-?[\d.]+)</g) || []).map((s) => s.replace(/[><]/g, ''));
    const bal = S.Stats.totals(S.Records.all()).balance;
    const disp = bal - S.Savings.savedTotal();
    return nums.includes('1889') && nums.includes('3000') && nums.includes(String(bal / 100)) &&
           nums.includes(String(disp / 100)) && String(disp / 100) === '-4489';
  })(),
  `summaryBar 数值=${(summaryHtml.match(/>(-?[\d.]+)</g) || []).map((s) => s.replace(/[><]/g, '')).join(',')}；手算 收入3000−支出1889=1111，1111−5600=−4489`);

/* 攒钱记录在流水里仍然渲染成「攒钱 + 目标名」 */
check('t6-7e-savings-still-labelled',
  '同一份渲染结果里，攒钱记录仍标成「攒钱」且副标题是目标名',
  /攒钱/.test(listHtml) && /换新手机/.test(listHtml),
  `含「攒钱」=${/攒钱/.test(listHtml)} 含目标名=${/换新手机/.test(listHtml)}`);

const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
fs.writeFileSync('verify2-out/t6-recheck-result.json', JSON.stringify({
  task: 't6 独立复核（verify2 自造数据，加载真实 store.js + app.js）',
  source_files: {
    'store.js': 'app/src/main/assets/www/js/store.js',
    'app.js': 'app/src/main/assets/www/js/app.js',
  },
  pass, fail, results,
}, null, 1), 'utf8');
console.log(`\n=== t6 recheck: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
