/* verify2 离线数据层测试：直接加载真实的 app/src/main/assets/www/js/store.js
   （不复制、不改写），只 stub 掉 localStorage 与 global，用来复现「口径类」断言。
   注意：这是**离线数据层**证据，不等于模拟器实测。

   用法: node tools/verify2_offline_store.mjs                        */
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync('app/src/main/assets/www/js/store.js', 'utf8');

const results = [];
function check(id, desc, pass, detail) {
  results.push({ id, desc, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${id}] ${desc}${detail !== undefined ? ' :: ' + detail : ''}`);
}

function freshStore() {
  const data = new Map();
  const localStorage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
    clear: () => data.clear(),
  };
  const sandbox = {
    localStorage,
    console,
    JSON,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    parseInt,
    parseFloat,
    isNaN,
    RegExp,
    Error,
  };
  sandbox.global = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'store.js' });
  return { Store: sandbox.Store, data, sandbox };
}

/* ---------- 场景 1：已攒自动汇总（存 500 → 取 200 = 300） ---------- */
{
  const { Store: S } = freshStore();
  const g = S.Savings.add({ name: '换新手机', targetAmount: '1000', icon: '🎯' });
  const goal = S.Savings.all()[0];
  const d1 = S.Savings.deposit(goal.id, '500');
  const savedAfterDeposit = S.Savings.savedAmount(goal.id);
  const w1 = S.Savings.withdraw(goal.id, '200');
  const savedAfterWithdraw = S.Savings.savedAmount(goal.id);
  check('s1-deposit', '存入 500 成功', d1.ok === true && savedAfterDeposit === 50000,
    JSON.stringify({ res: d1, savedAfterDeposit }));
  check('s2-withdraw', '取出 200 成功', w1.ok === true && w1.savedAmount === 30000,
    JSON.stringify({ res: w1 }));
  check('s3-saved-summary', '已攒汇总 = 500 − 200 = 300 元', savedAfterWithdraw === 30000,
    `savedAmount=${savedAfterWithdraw} 分 = ${savedAfterWithdraw / 100} 元`);
  const recs = S.Records.all().filter((r) => r.goalId);
  check('s4-records-count', '落成 2 条攒钱记录（1 存 1 取）', recs.length === 2, JSON.stringify(recs.map((r) => ({ a: r.amount, t: r.type, k: r.savingsKind, c: r.categoryId }))));
}

/* ---------- 场景 2：攒钱不进统计 / 分类 / 每日支出 ---------- */
{
  const { Store: S } = freshStore();
  const exp = S.Categories.byType('expense')[0];
  const inc = S.Categories.byType('income')[0];
  const g = S.Savings.add({ name: '旅行', targetAmount: '5000' });
  const goal = S.Savings.all()[0];
  S.Records.add({ date: '2026-10-05', type: 'income', amount: 3000, categoryId: inc.id });
  S.Records.add({ date: '2026-10-06', type: 'expense', amount: 100, categoryId: exp.id });
  S.Savings.deposit(goal.id, '500');
  S.Savings.withdraw(goal.id, '200');
  S.Savings.deposit(goal.id, '5000');   // 用「存入」再攒 5000（不是记一笔真实支出）

  const t = S.Stats.totals(S.Records.byMonth('2026-10'));
  check('s5-totals-exclude-savings', '本月支出/收入/结余 = 100/3000/2900（攒钱进出全不计）',
    t.expense === 10000 && t.income === 300000 && t.balance === 290000,
    JSON.stringify({ expense: t.expense / 100, income: t.income / 100, balance: t.balance / 100 }));
  const realRecs = S.Records.all().filter((r) => !r.goalId).length;
  check('s5b-only-real-records-in-totals', '本月参与统计的真实记录只有 2 笔（存入/取出都不算）',
    realRecs === 2, `realRecords=${realRecs}`);
  check('s6-totals-match-impl2', '与 impl2 报的实测值一致（100/3000/2900）',
    t.expense / 100 === 100 && t.income / 100 === 3000 && t.balance / 100 === 2900,
    `${t.expense / 100}/${t.income / 100}/${t.balance / 100}`);

  const byCat = S.Stats.byCategory(S.Records.byMonth('2026-10'), 'expense');
  check('s7-byCategory-excludes-savings', '支出分类排名不含攒钱记录（只有餐饮 100）',
    byCat.length === 1 && byCat[0].total === 10000,
    JSON.stringify(byCat.map((x) => ({ n: x.name, total: x.total, pct: x.percent }))));

  const daily = S.Stats.dailyExpense('2026-10');
  const dailySum = daily.reduce((a, b) => a + b, 0);
  check('s8-dailyExpense-excludes-savings', '每日支出柱状图不含攒钱存入（合计 = 100）',
    dailySum === 10000, `dailySum=${dailySum / 100} 元`);
  check('s9-dailyExpense-day6', '10-06 那天 = 100，存入那天 = 0',
    daily[5] === 10000 && daily[6] === 0, JSON.stringify({ d6: daily[5] / 100, d7: daily[6] / 100 }));

  /* 可支配 = 全部记录结余 − 已攒合计；负数不截断 */
  const savedTotal = S.Savings.savedTotal();
  const disposable = S.Stats.totals(S.Records.all()).balance - savedTotal;
  check('s10-savedTotal', '已攒合计 = 500 − 200 + 5000 = 5300 元', savedTotal === 530000, `savedTotal=${savedTotal / 100}`);  check('s11-disposable-negative', '可支配 = 2900 − 5300 = −2400（负数不截断，与 impl2 报的一致）',
    disposable === -240000, `disposable=${disposable / 100} 元`);

  /* 与 impl2 报的中间态再对一次：余额 2900、已攒 300 → 2600 */
  const { Store: S2 } = freshStore();
  const exp2 = S2.Categories.byType('expense')[0];
  const inc2 = S2.Categories.byType('income')[0];
  const g2 = S2.Savings.add({ name: 'X', targetAmount: '1000' });
  const goal2 = S2.Savings.all()[0];
  S2.Records.add({ date: '2026-10-05', type: 'income', amount: 3000, categoryId: inc2.id });
  S2.Records.add({ date: '2026-10-06', type: 'expense', amount: 100, categoryId: exp2.id });
  S2.Savings.deposit(goal2.id, '500');
  S2.Savings.withdraw(goal2.id, '200');
  const disp2 = S2.Stats.totals(S2.Records.all()).balance - S2.Savings.savedTotal();
  check('s12-disposable-2600', '余额 2900 − 已攒 300 = 2600（与 impl2 报的一致）',
    disp2 === 260000, `disposable=${disp2 / 100} 元`);
}

/* ---------- 场景 3：超额取出被拦 ---------- */
{
  const { Store: S } = freshStore();
  const g = S.Savings.add({ name: 'Y', targetAmount: '10000' });
  const goal = S.Savings.all()[0];
  const noSaved = S.Savings.withdraw(goal.id, '100');
  S.Savings.deposit(goal.id, '500');
  const tooMuch = S.Savings.withdraw(goal.id, '600');
  const okWithdraw = S.Savings.withdraw(goal.id, '500');
  check('s13-withdraw-without-saved', '没已攒时取出被拦', noSaved.ok === false && /还没有已攒/.test(noSaved.msg), noSaved.msg);
  check('s14-withdraw-too-much', '超额取出被拦且给出上限文案',
    tooMuch.ok === false && /不能超过当前已攒 ¥500/.test(tooMuch.msg), tooMuch.msg);
  check('s15-withdraw-exact-all', '正好取完（500/500）允许，已攒归零',
    okWithdraw.ok === true && S.Savings.savedAmount(goal.id) === 0, JSON.stringify(okWithdraw));
  check('s16-deposit-zero', '存入 0 被拦', S.Savings.deposit(goal.id, '0').ok === false, S.Savings.deposit(goal.id, '0').msg);
}

/* ---------- 场景 4：估算四种状态 ---------- */
{
  const { Store: S } = freshStore();
  // 无数据（只有攒钱记录，没有真实收支）
  const g0 = S.Savings.add({ name: 'no-data', targetAmount: '1000' });
  const goal0 = S.Savings.all()[0];
  const e0 = S.Savings.estimate(goal0);
  check('s17-estimate-no-data', '最近三个月没有真实收支 → status=no-data',
    e0.status === 'no-data' && e0.monthsNeeded === 0, JSON.stringify(e0));

  // 正常：三个月各 6000 结余
  const { Store: S1 } = freshStore();
  const inc = S1.Categories.byType('income')[0];
  const g1 = S1.Savings.add({ name: 'ok', targetAmount: '12000' });
  const goal1 = S1.Savings.all()[0];
  const shift = (m, d) => S1.Stats.shiftMonth(m, d);
  const key = S1.Stats.monthKey();
  [1, 2, 3].forEach((i) => {
    const m = shift(key, -i);
    S1.Records.add({ date: m + '-10', type: 'income', amount: 6000, categoryId: inc.id });
  });
  const e1 = S1.Savings.estimate(goal1);
  check('s18-estimate-ok', '三个月各 6000 结余 → 还需 2 个月（12000/6000）',
    e1.status === 'ok' && e1.monthsNeeded === 2 && e1.avgBalance === 600000 && e1.dataMonths.length === 3,
    JSON.stringify(e1));

  S1.Savings.deposit(goal1.id, '12000');   // 攒满
  const e1b = S1.Savings.estimate(S1.Savings.get(goal1.id));
  check('s19-estimate-done', '已攒 >= 目标 → status=done、monthsNeeded=0',
    e1b.status === 'done' && e1b.monthsNeeded === 0 && e1b.remaining === 0,
    JSON.stringify(e1b));

  // 零结余
  const { Store: S2 } = freshStore();
  const inc2 = S2.Categories.byType('income')[0];
  const exp2 = S2.Categories.byType('expense')[0];
  const g2 = S2.Savings.add({ name: 'zero', targetAmount: '1000' });
  const goal2 = S2.Savings.all()[0];
  const key2 = S2.Stats.monthKey();
  [1, 2, 3].forEach((i) => {
    const m = S2.Stats.shiftMonth(key2, -i);
    S2.Records.add({ date: m + '-10', type: 'income', amount: 2000, categoryId: inc2.id });
    S2.Records.add({ date: m + '-11', type: 'expense', amount: 2000, categoryId: exp2.id });
  });
  const e2 = S2.Savings.estimate(goal2);
  check('s20-estimate-zero', '三个月结余都是 0 → status=zero',
    e2.status === 'zero' && e2.monthsNeeded === 0, JSON.stringify(e2));

  // 负结余
  const { Store: S3 } = freshStore();
  const inc3 = S3.Categories.byType('income')[0];
  const exp3 = S3.Categories.byType('expense')[0];
  const g3 = S3.Savings.add({ name: 'neg', targetAmount: '1000' });
  const goal3 = S3.Savings.all()[0];
  const key3 = S3.Stats.monthKey();
  [1, 2, 3].forEach((i) => {
    const m = S3.Stats.shiftMonth(key3, -i);
    S3.Records.add({ date: m + '-10', type: 'income', amount: 1000, categoryId: inc3.id });
    S3.Records.add({ date: m + '-11', type: 'expense', amount: 1500, categoryId: exp3.id });
  });
  const e3 = S3.Savings.estimate(goal3);
  check('s21-estimate-negative', '三个月结余为负 → status=negative（不给月份数）',
    e3.status === 'negative' && e3.monthsNeeded === 0, JSON.stringify(e3));

  // 攒钱记录不参与估算
  const { Store: S4 } = freshStore();
  const inc4 = S4.Categories.byType('income')[0];
  const g4 = S4.Savings.add({ name: 'in-one-month', targetAmount: '10000' });
  const goal4 = S4.Savings.all()[0];
  const key4 = S4.Stats.monthKey();
  const m4 = S4.Stats.shiftMonth(key4, -3);
  S4.Records.add({ date: m4 + '-10', type: 'income', amount: 3000, categoryId: inc4.id });
  S4.Savings.deposit(goal4.id, '2000');   // 存入不能被算进「可用于估算的结余」
  const e4 = S4.Savings.estimate(goal4);
  check('s22-estimate-skips-savings-months', '存入不参与估算（总额 10000 − 已攒 2000 = 8000，月均 3000 → 3 个月，且只有 1 个月有效数据）',
    e4.status === 'ok' && e4.dataMonths.length === 1 && e4.avgBalance === 300000 && e4.monthsNeeded === 3,
    JSON.stringify(e4));
}

/* ---------- 场景 5：分类排序边界 ---------- */
{
  const { Store: S } = freshStore();
  const exp = S.Categories.byType('expense');
  const inc = S.Categories.byType('income');
  const firstId = exp[0].id;
  const upFirst = S.Categories.move(firstId, -1);
  check('s23-move-first-up-rejected', '第一个再上移被拦', upFirst.ok === false, upFirst.msg);
  const lastExp = exp[exp.length - 1];
  const downLast = S.Categories.move(lastExp.id, 1);
  check('s24-move-last-down-rejected', '支出组最后一个再下移被拦（不跨到收入组）',
    downLast.ok === false && /最后一个/.test(downLast.msg), downLast.msg);
  const moved = S.Categories.move(exp[0].id, 1);
  const after = S.Categories.byType('expense').map((c) => c.name);
  check('s25-move-down-swaps', '上→下移 交换同组相邻两项',
    moved.ok === true && after[0] === exp[1].name && after[1] === exp[0].name,
    JSON.stringify({ moved, after }));
  const incNames = S.Categories.byType('income').map((c) => c.name);
  check('s26-move-does-not-cross-type', '移动不影响另一组的顺序',
    JSON.stringify(incNames) === JSON.stringify(inc.map((c) => c.name)), JSON.stringify(incNames));
}

/* ---------- 场景 6：存量记录兼容（goalId 缺失不能抛错、不能被当成攒钱） ---------- */
{
  const { Store: S, data } = freshStore();
  S.Records.add({ date: '2026-10-01', type: 'expense', amount: 88 });
  const raw = JSON.parse(data.get('jizhang.records.v1'));
  raw.push({ id: 'legacy1', amount: 1234, type: 'expense', categoryId: null, date: '2026-10-02', note: '', createdAt: 1 });
  data.set('jizhang.records.v1', JSON.stringify(raw));
  const t = S.Stats.totals(S.Records.all());
  const saved = S.Savings.savedAmount('nonexistent');
  check('s27-legacy-records-ok', '缺 goalId 的存量记录照常计入统计、不当成攒钱',
    t.expense === 88 * 100 + 1234 && saved === 0, JSON.stringify({ t, saved }));
  const withKindOnly = { id: 'legacy2', amount: 100, type: 'expense', savingsKind: 'in', goalId: null };
  raw.push(withKindOnly);
  data.set('jizhang.records.v1', JSON.stringify(raw));
  check('s28-kind-without-goal-not-saving', '只有 savingsKind、没有 goalId 的记录不算攒钱',
    S.Savings.savedAmount('nonexistent') === 0 && S.Savings.savedTotal() === 0, `savedTotal=${S.Savings.savedTotal()}`);
}

const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
fs.mkdirSync('verify2-out', { recursive: true });
fs.writeFileSync('verify2-out/offline-store-result.json', JSON.stringify({
  source: 'app/src/main/assets/www/js/store.js',
  pass, fail, results,
}, null, 1), 'utf8');
console.log(`\n=== offline store: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
