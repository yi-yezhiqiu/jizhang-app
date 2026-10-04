/* 攒钱模型 + 分类排序 的数据层测试（离线跑真实 store.js，不依赖模拟器/浏览器）。
   用法: node tools/test_savings_model.mjs
   退出码 0 = 全部通过；1 = 有失败。

   做法：把 app/src/main/assets/www/js/store.js 原样放进一个 vm 沙箱，
   沙箱里提供 localStorage 与 window。测的就是发到 APK 里的那份代码。 */

import fs from 'node:fs';
import vm from 'node:vm';

const STORE_PATH = new URL('../app/src/main/assets/www/js/store.js', import.meta.url);
const code = fs.readFileSync(STORE_PATH, 'utf8');

const mem = new Map();
const sandbox = {
  console,
  localStorage: {
    getItem: (k) => (mem.has(String(k)) ? mem.get(String(k)) : null),
    setItem: (k, v) => { mem.set(String(k), String(v)); },
    removeItem: (k) => { mem.delete(String(k)); },
    clear: () => mem.clear(),
    get length() { return mem.size; }
  }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const Store = sandbox.Store;

const KEY_RECORDS = 'jizhang.records.v1';
const KEY_CATS = 'jizhang.categories.v1';
const KEY_SAVINGS = 'jizhang.savingsGoals.v1';

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else {
    failures.push(name);
    console.log('  [FAIL] ' + name + '  ' + (detail === undefined ? '' : JSON.stringify(detail)));
  }
}
function section(title) { console.log('\n== ' + title + ' =='); }

function raw(key) { const v = mem.get(key); return v == null ? null : JSON.parse(v); }
function setRaw(key, value) { mem.set(key, JSON.stringify(value)); }
function reset() { mem.clear(); }

const U = Store.util;
const today = U.todayStr();
const monthNow = Store.Stats.monthKey();
const m1 = Store.Stats.shiftMonth(monthNow, -1);
const m2 = Store.Stats.shiftMonth(monthNow, -2);
const m3 = Store.Stats.shiftMonth(monthNow, -3);
function dayIn(month) { return month + '-05'; }

/* ============ (a) 目标对象去掉 savedAmount ============ */
section('(a) 目标对象字段');
reset();
const addA = Store.Savings.add({ name: '换新手机', targetAmount: '1000', targetDate: '2027-01-01', icon: '📱' });
const goalA = Store.Savings.all()[0];
check('创建目标成功', addA.ok === true, addA);
check('目标字段为 id/name/targetAmount/targetDate/icon/createdAt/updatedAt', (function () {
  const want = ['id', 'name', 'targetAmount', 'targetDate', 'icon', 'createdAt', 'updatedAt'].sort();
  return JSON.stringify(Object.keys(goalA).sort()) === JSON.stringify(want);
})(), Object.keys(goalA));
check('目标金额按分存整数', goalA.targetAmount === 100000 && Number.isInteger(goalA.targetAmount), goalA.targetAmount);
check('落库 JSON 里也没有已攒字段', raw(KEY_SAVINGS)[0].savedAmount === undefined, raw(KEY_SAVINGS)[0]);
const addB = Store.Savings.add({ name: '买相机', targetAmount: '500' });
const goalB = Store.Savings.get(Store.Savings.all()[1].id);
check('校验：空名/超大金额/负金额被拦', (function () {
  return Store.Savings.add({ name: '   ', targetAmount: '10' }).ok === false &&
    Store.Savings.add({ name: 'X', targetAmount: '0' }).ok === false &&
    Store.Savings.add({ name: 'X', targetAmount: '-3' }).ok === false &&
    Store.Savings.add({ name: '这个目标名字实在是太长了超过二十个字了啦啦啦啦', targetAmount: '1' }).ok === false &&
    Store.Savings.add({ name: 'X', targetAmount: '1', targetDate: '2027-13-40' }).ok === false;
})());

/* ============ (b) 记录新增可选字段 + 存量记录兼容 ============ */
section('(b) goalId / savingsKind 与存量记录兼容');
check('新建记录带 goalId=null / savingsKind=null', (function () {
  const r = Store.Records.add({ amount: '9.99', type: 'expense', categoryId: 'c_food', date: today });
  const rec = Store.Records.all().slice(-1)[0];
  return r.ok && rec.goalId === null && rec.savingsKind === null && rec.amount === 999;
})());

// 存量的"老数据"：既没有 goalId/savingsKind，目标对象上还残留 savedAmount
setRaw(KEY_RECORDS, [
  { id: 'r_old1', amount: 1234, type: 'expense', categoryId: 'c_food', date: today, note: '老记录', createdAt: 1 },
  { id: 'r_old2', amount: 500, type: 'income', categoryId: 'c_salary', date: today, note: '', createdAt: 2 }
]);
setRaw(KEY_SAVINGS, [{ id: 'g_old', name: '老目标', targetAmount: 100000, savedAmount: 66000, targetDate: null, icon: '🎯', createdAt: 1, updatedAt: 1 }]);
check('存量记录读取不报错，且不被当成攒钱记录', (function () {
  const rs = Store.Records.all();
  const t = Store.Stats.totals(rs);
  return rs.length === 2 && t.expense === 1234 && t.income === 500 && t.balance === -734;
})(), Store.Stats.totals(Store.Records.all()));
check('存量目标上的旧已攒字段不再被读取（按 0 处理）', (function () {
  const g = Store.Savings.get('g_old');
  return g !== null && Store.Savings.savedAmount('g_old') === 0 && Store.Savings.savedTotal() === 0;
})());
check('estimate 对存量目标不报错', (function () {
  const est = Store.Savings.estimate(Store.Savings.get('g_old'));
  return est.remaining === 100000 && typeof est.status === 'string';
})());
check('update 存量目标不会把旧字段写回', (function () {
  const r = Store.Savings.update('g_old', { name: '老目标改' });
  return r.ok && raw(KEY_SAVINGS)[0].name === '老目标改';
})());

/* ============ (c) 存入 / 取出 单笔模型 ============ */
section('(c) 存入 / 取出');
reset();
Store.Savings.add({ name: '目标A', targetAmount: '1000' });
Store.Savings.add({ name: '目标B', targetAmount: '500' });
const A = Store.Savings.all()[0].id;
const B = Store.Savings.all()[1].id;

const dep = Store.Savings.deposit(A, '300');
check('存入成功并返回本次金额（分）', dep.ok === true && dep.amount === 30000, dep);
check('存入记录 = expense + savingsKind=in + goalId + 无分类', (function () {
  const rec = Store.Records.all().slice(-1)[0];
  return rec.type === 'expense' && rec.savingsKind === 'in' && rec.goalId === A &&
    rec.categoryId === null && rec.amount === 30000 && Number.isInteger(rec.amount) &&
    /^\d{4}-\d{2}-\d{2}$/.test(rec.date) && rec.date === today;
})(), Store.Records.all().slice(-1)[0]);
check('存入金额必须 > 0', (function () {
  const a = Store.Savings.deposit(A, '0'), b = Store.Savings.deposit(A, ''), c = Store.Savings.deposit(A, '-5'),
    d = Store.Savings.deposit(A, 'abc'), e = Store.Savings.deposit('g_nope', '10');
  return a.ok === false && b.ok === false && c.ok === false && d.ok === false && e.ok === false &&
    a.msg.indexOf('大于 0') > 0 && e.msg === '目标不存在' && Store.Records.all().length === 1;
})());
check('已攒 = 存入之和（第一次 300）', Store.Savings.savedAmount(A) === 30000, Store.Savings.savedAmount(A));

const over = Store.Savings.withdraw(A, '400');
check('取出超过已攒被拦 + 明确文案', over.ok === false && over.msg.indexOf('不能超过当前已攒 ¥300') > 0 &&
  over.msg.indexOf('最多可取 ¥300') > 0 && Store.Records.all().length === 1, over);

const w1 = Store.Savings.withdraw(A, '100');
check('取出成功 = income + savingsKind=out', w1.ok === true && w1.savedAmount === 20000 && (function () {
  const rec = Store.Records.all().slice(-1)[0];
  return rec.type === 'income' && rec.savingsKind === 'out' && rec.goalId === A &&
    rec.categoryId === null && rec.amount === 10000 && Number.isInteger(rec.amount);
})(), Store.Records.all().slice(-1)[0]);
check('取出后已攒 = 存入 − 取出', Store.Savings.savedAmount(A) === 20000, Store.Savings.savedAmount(A));

const w2 = Store.Savings.withdraw(A, '200');
const w3 = Store.Savings.withdraw(A, '1');
check('取空后不能再取（文案明确）', w2.ok === true && Store.Savings.savedAmount(A) === 0 &&
  w3.ok === false && w3.msg.indexOf('还没有已攒金额') > 0, w3);

Store.Savings.deposit(B, '50');
check('savedTotal = 各目标已攒合计', Store.Savings.savedTotal() === 5000, Store.Savings.savedTotal());
check('savedAmount(其他目标) 互不影响', Store.Savings.savedAmount(A) === 0 && Store.Savings.savedAmount(B) === 5000 &&
  Store.Savings.savedAmount('g_nope') === 0);

/* ============ (d) 估算 remaining 用自动汇总值 ============ */
section('(d) estimate 用自动已攒');
reset();
Store.Savings.add({ name: '目标A', targetAmount: '1000' });
const GA = Store.Savings.all()[0].id;
check('remaining = 目标金额 − 自动已攒', (function () {
  const e0 = Store.Savings.estimate(Store.Savings.get(GA));
  Store.Savings.deposit(GA, '250');
  const e1 = Store.Savings.estimate(Store.Savings.get(GA));
  Store.Savings.withdraw(GA, '100');
  const e2 = Store.Savings.estimate(Store.Savings.get(GA));
  return e0.remaining === 100000 && e1.remaining === 75000 && e2.remaining === 85000;
})(), Store.Savings.estimate(Store.Savings.get(GA)));
check('存满后 status=done', (function () {
  Store.Savings.deposit(GA, '850');
  const est = Store.Savings.estimate(Store.Savings.get(GA));
  return est.remaining <= 0 && est.status === 'done' && est.monthsNeeded === 0;
})());
check('取回一部分后又回到未达成', (function () {
  Store.Savings.withdraw(GA, '1');
  const est = Store.Savings.estimate(Store.Savings.get(GA));
  return est.remaining === 100 && est.status !== 'done';
})());

// 近三个月口径：只看真实收支，空月不参与平均，只有攒钱记录的月也不算"有数据"
reset();
Store.Savings.add({ name: '目标A', targetAmount: '1000' });
const G2 = Store.Savings.all()[0].id;
Store.Records.add({ amount: '1000', type: 'income', categoryId: 'c_salary', date: dayIn(m1) });
Store.Records.add({ amount: '400', type: 'expense', categoryId: 'c_food', date: dayIn(m1) });
Store.Records.add({ amount: '200', type: 'income', categoryId: 'c_salary', date: dayIn(m2) });
Store.Savings.deposit(G2, '9');                     // 攒钱记录（今天）不应影响估算
setRaw(KEY_RECORDS, Store.Records.all().map(function (r) {
  if (r.date === today) r.date = dayIn(m3);         // 把这笔攒钱挪到 M-3
  return r;
}));
check('avgBalance 只统计真实收支，纯攒钱月不算数据月', (function () {
  const est = Store.Savings.estimate(Store.Savings.get(G2));
  return est.dataMonths.length === 2 && est.dataMonths.indexOf(m1) >= 0 && est.dataMonths.indexOf(m2) >= 0 &&
    est.dataMonths.indexOf(m3) < 0 && est.avgBalance === 40000 && est.status === 'ok' &&
    est.monthsNeeded === Math.ceil((100000 - 900) / 40000);
})(), Store.Savings.estimate(Store.Savings.get(G2)));

/* ============ (e) 不计入统计（硬要求） ============ */
section('(e) 统计口径');
reset();
Store.Savings.add({ name: '目标A', targetAmount: '100000' });
const G3 = Store.Savings.all()[0].id;
Store.Records.add({ amount: '100', type: 'expense', categoryId: 'c_food', date: today, note: '午饭' });
Store.Records.add({ amount: '3000', type: 'income', categoryId: 'c_salary', date: today, note: '工资' });
const before = Store.Stats.totals(Store.Records.byMonth(monthNow));
Store.Savings.deposit(G3, '500');                   // expense 一笔
Store.Savings.deposit(G3, '300');
Store.Savings.withdraw(G3, '200');                  // income 一笔
const rsAll = Store.Records.all();
const after = Store.Stats.totals(Store.Records.byMonth(monthNow));
check('存入/取出后 totals 完全不变', before.expense === after.expense && before.income === after.income &&
  before.balance === after.balance && after.expense === 10000 && after.income === 300000 && after.balance === 290000,
  { before, after });
check('totals 也跳过 type 与 savingsKind 相反的攒钱记录', (function () {
  const recs = [{ id: 'x', amount: 999, type: 'income', goalId: 'g1', savingsKind: 'in', date: today },
    { id: 'y', amount: 888, type: 'expense', goalId: 'g1', savingsKind: 'out', date: today },
    { id: 'z', amount: 111, type: 'expense', categoryId: 'c_food', date: today }];
  const t = Store.Stats.totals(recs);
  return t.expense === 111 && t.income === 0 && t.balance === -111;
})());
check('byCategory 跳过攒钱记录', (function () {
  const exp = Store.Stats.byCategory(rsAll, 'expense');
  const inc = Store.Stats.byCategory(rsAll, 'income');
  const expSum = exp.reduce(function (s, x) { return s + x.total; }, 0);
  return exp.length === 1 && exp[0].categoryId === 'c_food' && exp[0].total === 10000 &&
    inc.length === 1 && inc[0].total === 300000 && expSum === 10000;
})(), Store.Stats.byCategory(rsAll, 'expense'));
check('dailyExpense 跳过攒钱记录', (function () {
  const daily = Store.Stats.dailyExpense(monthNow);
  const sum = daily.reduce(function (s, x) { return s + x; }, 0);
  return sum === 10000;
})());
check('savedTotal / 可支配公式（可为负）', (function () {
  const total = Store.Stats.totals(rsAll);
  const disposable = total.balance - Store.Savings.savedTotal();
  return Store.Savings.savedTotal() === 60000 && disposable === 290000 - 60000;
})());
check('攒钱记录不写 lastUsed 分类', (function () {
  const m = JSON.parse(mem.get('jizhang.lastUsed.v1') || '{}');
  return m.expense === 'c_food' && m.income === 'c_salary';
})(), JSON.parse(mem.get('jizhang.lastUsed.v1') || '{}'));

/* ============ (f) 目标删除不影响流水记录 ============ */
section('(f) 删除目标');
check('删目标只删目标，攒钱记录仍在', (function () {
  const n = Store.Records.all().length;
  const r = Store.Savings.remove(G3);
  return r.ok && Store.Savings.all().length === 0 && Store.Records.all().length === n;
})());

/* ============ 任务2：分类排序 ============ */
section('任务2 分类排序');
reset();
const expIds = () => Store.Categories.byType('expense').map(function (c) { return c.id; });
const list0 = expIds();
check('默认顺序 = 数组顺序', JSON.stringify(Store.Categories.all().filter(function (c) { return c.type === 'expense'; })
  .map(function (c) { return c.id; })) === JSON.stringify(list0), list0);
check('到顶不能上移', (function () {
  const r = Store.Categories.move(list0[0], -1);
  return r.ok === false && r.msg === '已经是第一个了' && JSON.stringify(expIds()) === JSON.stringify(list0);
})());
check('到底不能下移（跨 type 会被拦住）', (function () {
  const lastExp = list0[list0.length - 1];
  const r = Store.Categories.move(lastExp, 1);
  return r.ok === false && r.msg === '已经是最后一个了' && JSON.stringify(expIds()) === JSON.stringify(list0);
})());
check('组内相邻交换并落库（预置分类也可移动）', (function () {
  const builtinId = list0[0];
  const r = Store.Categories.move(builtinId, 1);
  const after = expIds();
  const stored = raw(KEY_CATS).filter(function (c) { return c.type === 'expense'; }).map(function (c) { return c.id; });
  return r.ok === true && after[0] === list0[1] && after[1] === list0[0] &&
    JSON.stringify(stored) === JSON.stringify(after) &&
    Store.Categories.get(builtinId).builtin === true;
})(), expIds());
check('上移回来', (function () {
  const r = Store.Categories.move(list0[0], -1);
  return r.ok === true && JSON.stringify(expIds()) === JSON.stringify(list0);
})());
check('不存在的分类', (function () {
  const r = Store.Categories.move('c_nope', 1);
  return r.ok === false && r.msg === '分类不存在';
})());
check('后添加的支出分类（数组里排在收入之后）也能在组内上移', (function () {
  Store.Categories.add('宠物', 'expense', '🐱');
  const arr = Store.Categories.all();
  const cats = Store.Categories.byType('expense').map(function (c) { return c.id; });
  const petId = cats[cats.length - 1];
  const prevId = cats[cats.length - 2];
  const idxPet = arr.map(function (c) { return c.id; }).indexOf(petId);
  const idxPrev = arr.map(function (c) { return c.id; }).indexOf(prevId);
  const r = Store.Categories.move(petId, -1);
  const after = Store.Categories.byType('expense').map(function (c) { return c.id; });
  return idxPet > idxPrev && r.ok === true && after.indexOf(petId) < after.indexOf(prevId) &&
    JSON.stringify(Store.Categories.byType('income').map(function (c) { return c.id; })) ===
    JSON.stringify(['c_salary', 'c_bonus', 'c_invest', 'c_parttime', 'c_in_other']);
})(), Store.Categories.all().map(function (c) { return c.id + ':' + c.type; }));
check('收入组独立移动，互不影响', (function () {
  const inc = Store.Categories.byType('income').map(function (c) { return c.id; });
  const expBefore = Store.Categories.byType('expense').map(function (c) { return c.id; });
  const r = Store.Categories.move(inc[0], 1);
  const incAfter = Store.Categories.byType('income').map(function (c) { return c.id; });
  const expAfter = Store.Categories.byType('expense').map(function (c) { return c.id; });
  return r.ok === true && incAfter[0] === inc[1] && incAfter[1] === inc[0] &&
    JSON.stringify(expBefore) === JSON.stringify(expAfter);
})());
check('顺序变化会作用到流水渲染顺序（byType 跟随数组）', (function () {
  const cats = Store.Categories.all();
  const ids = cats.map(function (c) { return c.id; });
  const exp = Store.Categories.byType('expense').map(function (c) { return c.id; });
  const expected = cats.filter(function (c) { return c.type === 'expense'; }).map(function (c) { return c.id; });
  return JSON.stringify(exp) === JSON.stringify(expected) &&
    ids.indexOf(expected[0]) !== -1;
})());

console.log('\n===================================');
console.log('PASS ' + pass + ' / FAIL ' + failures.length + (failures.length ? '  -> ' + failures.join(', ') : ''));
console.log('===================================');
process.exit(failures.length ? 1 : 0);
