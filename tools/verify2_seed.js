/* 灌入最近三个月真实收支：每月收入 10000、支出 5000 -> 结余 5000/月，便于核对估算。
   当前月(2026-10)只放少量数据，用于核对「攒钱记录不进统计」「可支配」。 */
(function () {
  var res = [];
  var S = Store, U = S.util;
  function addRec(date, type, amount, catId) {
    var r = S.Records.add({ date: date, type: type, amount: amount, categoryId: catId });
    res.push({ date: date, type: type, amount: amount, ok: r.ok, msg: r.msg || null });
  }
  var exp = S.Categories.byType('expense')[0];
  var inc = S.Categories.byType('income')[0];
  // 上月 / 上上月 / 往前第三个月，各 收入10000 支出5000
  ['2026-09', '2026-08', '2026-07'].forEach(function (m) {
    addRec(m + '-10', 'income', 10000, inc.id);
    addRec(m + '-15', 'expense', 5000, exp.id);
  });
  // 当前月：收入 8000、支出 3000 -> 结余 5000
  addRec('2026-10-02', 'income', 8000, inc.id);
  addRec('2026-10-03', 'expense', 3000, exp.id);
  var k = S.Stats.monthKey();
  return JSON.stringify({
    seeded: res.length, fails: res.filter(function (x) { return !x.ok; }),
    monthKey: k,
    prev3: [S.Stats.shiftMonth(k, -1), S.Stats.shiftMonth(k, -2), S.Stats.shiftMonth(k, -3)],
    monthTotals: S.Stats.totals(S.Records.byMonth(k)),
    recCount: S.Records.all().length
  }, null, 1);
})()
