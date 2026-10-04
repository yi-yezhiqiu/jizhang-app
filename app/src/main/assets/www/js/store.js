/* 数据层：所有读写都经过这里，是 App 的唯一事实来源。
   数据存在 localStorage（WebView 内 → App 沙箱），不联网、不上传。

   两个关键存储决策（写在最前面，改之前先想清楚）：
   1. 金额一律按「分」存整数。浮点数存钱会出现 0.1+0.2 问题，记账 App 不能犯这个错。
   2. 日期一律用「本地时区」的 YYYY-MM-DD。用 UTC 的话，晚上记账会被算成昨天。 */
(function (global) {
  'use strict';

  var KEY_RECORDS = 'jizhang.records.v1';
  var KEY_CATS = 'jizhang.categories.v1';
  var KEY_LAST = 'jizhang.lastUsed.v1';
  var KEY_SAVINGS = 'jizhang.savingsGoals.v1';

  /* 预置分类。builtin=true 的不可删除，保证用户永远有分类可用，
     不会出现"把分类删光后无法记账"的死局。 */
  var DEFAULT_CATEGORIES = [
    { id: 'c_food',     name: '餐饮', type: 'expense', icon: '🍜', builtin: true },
    { id: 'c_traffic',  name: '交通', type: 'expense', icon: '🚌', builtin: true },
    { id: 'c_shop',     name: '购物', type: 'expense', icon: '🛍️', builtin: true },
    { id: 'c_home',     name: '居住', type: 'expense', icon: '🏠', builtin: true },
    { id: 'c_fun',      name: '娱乐', type: 'expense', icon: '🎮', builtin: true },
    { id: 'c_med',      name: '医疗', type: 'expense', icon: '💊', builtin: true },
    { id: 'c_social',   name: '人情', type: 'expense', icon: '🎁', builtin: true },
    { id: 'c_daily',    name: '日用', type: 'expense', icon: '🧻', builtin: true },
    { id: 'c_other',    name: '其他', type: 'expense', icon: '📦', builtin: true },
    { id: 'c_salary',   name: '工资', type: 'income',  icon: '💰', builtin: true },
    { id: 'c_bonus',    name: '奖金', type: 'income',  icon: '🎉', builtin: true },
    { id: 'c_invest',   name: '理财', type: 'income',  icon: '📈', builtin: true },
    { id: 'c_parttime', name: '兼职', type: 'income',  icon: '💼', builtin: true },
    { id: 'c_in_other', name: '其他', type: 'income',  icon: '📥', builtin: true }
  ];

  function readJSON(key, fallback) {
    try {
      var raw = global.localStorage.getItem(key);
      if (!raw) return fallback;
      var v = JSON.parse(raw);
      return (v === null || v === undefined) ? fallback : v;
    } catch (e) {
      // 存储损坏时不能让 App 打不开，退回默认值
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      global.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---------------- 工具 ---------------- */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function toDateStr(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function todayStr() { return toDateStr(new Date()); }

  /* "12.5" / "12.5元" / "１２" 之类都尽量解析；失败返回 0 */
  function toCents(input) {
    if (typeof input === 'number') {
      return isFinite(input) ? Math.round(input * 100) : 0;
    }
    var s = String(input == null ? '' : input).trim();
    if (!s) return 0;
    // 全角数字与全角句点转半角
    s = s.replace(/[０-９]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    }).replace(/[．。]/g, '.');
    // 去掉货币符号与空白
    s = s.replace(/[¥￥\s,]/g, '');
    if (!/^\d*\.?\d*$/.test(s)) return 0;
    var f = parseFloat(s);
    if (isNaN(f) || !isFinite(f)) return 0;
    return Math.round(f * 100);
  }

  function fromCents(cents) {
    var neg = cents < 0;
    var v = Math.abs(Math.round(Number(cents) || 0));
    return (neg ? '-' : '') + (v / 100).toFixed(2);
  }

  /* 显示用：整数金额不显示 .00，避免流水里全是小数看着吵 */
  function prettyAmount(cents) {
    return fromCents(cents).replace(/\.00$/, '');
  }

  function uid(prefix) {
    return (prefix || 'r') + '_' + Date.now().toString(36) + '_' +
      Math.random().toString(36).slice(2, 8);
  }

  /* ---------------- 攒钱记录判定 ----------------

     记录上新增两个可选字段：
       goalId      string | null   —— 属于哪个攒钱目标
       savingsKind 'in' | 'out' | null —— 存入 / 取出

     存量记录（这个功能之前记的账）没有这两个字段，一律按 null 处理，
     绝不能因为字段缺失抛错或改变原有行为。 */

  function isSavingsRecord(r) {
    return !!(r && r.goalId != null && String(r.goalId) !== '');
  }

  /* 只有显式标成 'out' 才算取出；kind 缺失（存量数据/手改数据）按「存入」处理，
     保证「每条攒钱记录都被算进某个目标的已攒」，不会凭空消失。 */
  function isSavingsOut(r) {
    return !!(r && r.savingsKind === 'out');
  }

  /* ---------------- 分类 ---------------- */

  var Categories = {
    all: function () {
      var cats = readJSON(KEY_CATS, null);
      if (!cats || !cats.length) {
        cats = DEFAULT_CATEGORIES.map(function (c) { return { id: c.id, name: c.name, type: c.type, icon: c.icon, builtin: c.builtin }; });
        writeJSON(KEY_CATS, cats);
      }
      return cats;
    },
    byType: function (type) {
      return Categories.all().filter(function (c) { return c.type === type; });
    },
    get: function (id) {
      var hit = Categories.all().filter(function (c) { return c.id === id; });
      return hit.length ? hit[0] : null;
    },
    nameOf: function (id) {
      var c = Categories.get(id);
      return c ? c.name : '未分类';
    },
    iconOf: function (id) {
      var c = Categories.get(id);
      return c ? c.icon : '❔';
    },
    add: function (name, type, icon) {
      name = String(name == null ? '' : name).trim();
      if (!name) return { ok: false, msg: '分类名不能为空' };
      if (name.length > 8) return { ok: false, msg: '分类名请控制在 8 个字以内' };
      type = (type === 'income') ? 'income' : 'expense';
      var cats = Categories.all();
      var dup = cats.filter(function (c) { return c.type === type && c.name === name; });
      if (dup.length) return { ok: false, msg: '这个分类已经存在了' };
      cats.push({
        id: uid('c'),
        name: name, type: type,
        icon: String(icon || '🏷️').slice(0, 4),
        builtin: false
      });
      if (!writeJSON(KEY_CATS, cats)) return { ok: false, msg: '保存失败，手机存储可能已满' };
      return { ok: true };
    },
    remove: function (id) {
      var cats = Categories.all();
      var target = cats.filter(function (c) { return c.id === id; })[0];
      if (!target) return { ok: false, msg: '分类不存在' };
      if (target.builtin) return { ok: false, msg: '预置分类不能删除' };
      var used = Records.all().filter(function (r) { return r.categoryId === id; });
      if (used.length) {
        return { ok: false, msg: '有 ' + used.length + ' 笔记录在用这个分类，不能删' };
      }
      if (!writeJSON(KEY_CATS, cats.filter(function (c) { return c.id !== id; }))) {
        return { ok: false, msg: '保存失败' };
      }
      return { ok: true };
    },
    /* 记住上次用的分类，让高频记账少点一次 */
    lastUsed: function (type) {
      var m = readJSON(KEY_LAST, {});
      return (m && m[type]) || null;
    },
    setLastUsed: function (type, id) {
      if (!id) return;
      var m = readJSON(KEY_LAST, {}) || {};
      m[type] = id;
      writeJSON(KEY_LAST, m);
    },
    /* 在同一 type 分组内上移 / 下移一个分类（dir: -1 上移，1 下移）。
       顺序就是 jizhang.categories.v1 数组自身的顺序，Categories.byType 自然跟随，
       所以流水与记账分类条的先后顺序也会一起变。

       只允许同 type 组内移动：数组里两种 type 可能交错（后添加的分类总是 push 到末尾），
       因此要跳过其它 type 的项，交换"组内相邻"的那两个。
       预置分类（builtin）同样可以移动：顺序是用户偏好，与能否删除无关。 */
    move: function (id, dir) {
      var step = (Number(dir) < 0) ? -1 : 1;
      var cats = Categories.all();
      var idx = -1;
      for (var i = 0; i < cats.length; i++) { if (cats[i].id === id) { idx = i; break; } }
      if (idx < 0) return { ok: false, msg: '分类不存在' };
      var type = cats[idx].type;
      var j = idx + step;
      while (j >= 0 && j < cats.length && cats[j].type !== type) j += step;
      if (j < 0) return { ok: false, msg: '已经是第一个了' };
      if (j >= cats.length) return { ok: false, msg: '已经是最后一个了' };
      var tmp = cats[idx];
      cats[idx] = cats[j];
      cats[j] = tmp;
      if (!writeJSON(KEY_CATS, cats)) return { ok: false, msg: '保存失败，手机存储可能已满' };
      return { ok: true, from: idx, to: j };
    }
  };

  /* ---------------- 记录 ---------------- */

  var Records = {
    all: function () {
      var rs = readJSON(KEY_RECORDS, []);
      return Array.isArray(rs) ? rs : [];
    },
    /* 时间倒序：先比日期，同一天比创建时间 */
    sorted: function (list) {
      return (list || Records.all()).slice().sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        return (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0);
      });
    },
    add: function (rec) {
      var cents = toCents(rec.amount);
      if (!cents || cents <= 0) return { ok: false, msg: '请先输入金额' };
      var type = (rec.type === 'income') ? 'income' : 'expense';
      var rs = Records.all();
      var goalId = (rec.goalId == null || String(rec.goalId) === '') ? null : String(rec.goalId);
      var kind = (rec.savingsKind === 'in' || rec.savingsKind === 'out') ? rec.savingsKind : null;
      /* 攒钱记录不带分类：它不该出现在「支出分类」里，也不该影响上次用的分类 */
      if (goalId) rec.categoryId = null;
      rs.push({
        id: uid('r'),
        amount: cents,
        type: type,
        categoryId: rec.categoryId || null,
        date: rec.date || todayStr(),
        note: String(rec.note == null ? '' : rec.note).trim().slice(0, 100),
        goalId: goalId,
        savingsKind: kind,
        createdAt: Date.now()
      });
      if (!writeJSON(KEY_RECORDS, rs)) return { ok: false, msg: '保存失败，手机存储可能已满' };
      Categories.setLastUsed(type, rec.categoryId);
      return { ok: true };
    },
    update: function (id, patch) {
      var rs = Records.all();
      var idx = -1;
      for (var i = 0; i < rs.length; i++) { if (rs[i].id === id) { idx = i; break; } }
      if (idx < 0) return { ok: false, msg: '记录不存在' };
      var cur = rs[idx];
      if (patch.amount !== undefined) {
        var cents = toCents(patch.amount);
        if (!cents || cents <= 0) return { ok: false, msg: '金额必须大于 0' };
        cur.amount = cents;
      }
      if (patch.type !== undefined) cur.type = (patch.type === 'income') ? 'income' : 'expense';
      if (patch.categoryId !== undefined) cur.categoryId = patch.categoryId;
      if (patch.date !== undefined) cur.date = patch.date;
      if (patch.note !== undefined) cur.note = String(patch.note).trim().slice(0, 100);
      cur.updatedAt = Date.now();
      if (!writeJSON(KEY_RECORDS, rs)) return { ok: false, msg: '保存失败' };
      return { ok: true };
    },
    remove: function (id) {
      var rs = Records.all();
      var next = rs.filter(function (r) { return r.id !== id; });
      if (next.length === rs.length) return { ok: false, msg: '记录不存在' };
      if (!writeJSON(KEY_RECORDS, next)) return { ok: false, msg: '保存失败' };
      return { ok: true };
    },
    byMonth: function (month) {
      return Records.all().filter(function (r) {
        return String(r.date).slice(0, 7) === month;
      });
    },
    byDate: function (date) {
      return Records.all().filter(function (r) { return r.date === date; });
    }
  };

  /* ---------------- 统计 ---------------- */

  var Stats = {
    /* 只统计「真实收支」。攒钱记录（goalId 非空）是钱在自己口袋之间挪：
       存入记成 expense、取出记成 income 只是为了复用记录结构，
       绝不能让「本月支出 / 本月收入 / 结余」跟着变。 */
    totals: function (list) {
      var income = 0, expense = 0;
      (list || []).forEach(function (r) {
        if (isSavingsRecord(r)) return;
        var v = Number(r.amount) || 0;
        if (r.type === 'income') income += v; else expense += v;
      });
      return { income: income, expense: expense, balance: income - expense };
    },
    /* 按分类汇总，降序；带占比，用于排名展示 */
    byCategory: function (list, type) {
      var map = {};
      (list || []).forEach(function (r) {
        if (isSavingsRecord(r)) return;   // 攒钱记录不进分类排名
        if (r.type !== type) return;
        var k = r.categoryId || '__none__';
        if (!map[k]) map[k] = { categoryId: k, total: 0, count: 0 };
        map[k].total += Number(r.amount) || 0;
        map[k].count += 1;
      });
      var arr = Object.keys(map).map(function (k) { return map[k]; });
      arr.sort(function (a, b) { return b.total - a.total; });
      var sum = arr.reduce(function (s, x) { return s + x.total; }, 0);
      arr.forEach(function (x) {
        x.name = (x.categoryId === '__none__') ? '未分类' : Categories.nameOf(x.categoryId);
        x.icon = (x.categoryId === '__none__') ? '❔' : Categories.iconOf(x.categoryId);
        x.percent = sum > 0 ? (x.total / sum * 100) : 0;
      });
      return arr;
    },
    /* 当月每日支出数组，索引 0 = 1 号 */
    dailyExpense: function (month) {
      var parts = String(month).split('-');
      var y = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
      var days = new Date(y, m, 0).getDate();
      var out = [];
      for (var i = 0; i < days; i++) out.push(0);
      Records.byMonth(month).forEach(function (r) {
        if (isSavingsRecord(r)) return;   // 攒钱存入不是消费，不进每日支出柱状图
        if (r.type !== 'expense') return;
        var d = parseInt(String(r.date).slice(8, 10), 10);
        if (d >= 1 && d <= days) out[d - 1] += Number(r.amount) || 0;
      });
      return out;
    },
    monthKey: function (d) {
      d = d || new Date();
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
    },
    monthLabel: function (month) {
      var p = String(month).split('-');
      return p[0] + '年' + parseInt(p[1], 10) + '月';
    },
    shiftMonth: function (month, delta) {
      var p = String(month).split('-');
      var d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1 + delta, 1);
      return Stats.monthKey(d);
    },
    /* 友好的日期标签：今天 / 昨天 / 9月28日 周日 */
    dayLabel: function (dateStr) {
      var today = todayStr();
      var y = new Date(); y.setDate(y.getDate() - 1);
      var yesterday = toDateStr(y);
      if (dateStr === today) return '今天';
      if (dateStr === yesterday) return '昨天';
      var parts = String(dateStr).split('-');
      var d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      var week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
      return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + week;
    }
  };

  /* ---------------- 攒钱目标 ---------------- */

  function isValidDateStr(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var y = parseInt(s.slice(0, 4), 10);
    var m = parseInt(s.slice(5, 7), 10);
    var d = parseInt(s.slice(8, 10), 10);
    var dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }

  /* 已攒金额不再存在目标对象上（goalId 记录自动汇总），
     所以这里只剩「目标元数据」的校验。 */

  var Savings = {
    all: function () {
      var goals = readJSON(KEY_SAVINGS, []);
      return Array.isArray(goals) ? goals : [];
    },
    get: function (id) {
      var hit = Savings.all().filter(function (g) { return g.id === id; });
      return hit.length ? hit[0] : null;
    },
    add: function (data) {
      var name = String(data.name == null ? '' : data.name).trim();
      if (!name) return { ok: false, msg: '请填写目标名称' };
      if (name.length > 20) return { ok: false, msg: '目标名称请控制在 20 个字以内' };
      var target = toCents(data.targetAmount);
      if (!target || target <= 0) return { ok: false, msg: '目标金额必须大于 0' };
      var targetDate = data.targetDate ? String(data.targetDate) : null;
      if (targetDate && !isValidDateStr(targetDate)) return { ok: false, msg: '目标日期格式不对' };
      var goals = Savings.all();
      goals.push({
        id: uid('g'),
        name: name,
        targetAmount: target,
        targetDate: targetDate,
        icon: String(data.icon || '🎯').slice(0, 4),
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
      if (!writeJSON(KEY_SAVINGS, goals)) return { ok: false, msg: '保存失败，手机存储可能已满' };
      return { ok: true };
    },
    update: function (id, patch) {
      var goals = Savings.all();
      var idx = -1;
      for (var i = 0; i < goals.length; i++) { if (goals[i].id === id) { idx = i; break; } }
      if (idx < 0) return { ok: false, msg: '目标不存在' };
      var cur = goals[idx];
      if (patch.name !== undefined) {
        var name = String(patch.name == null ? '' : patch.name).trim();
        if (!name) return { ok: false, msg: '请填写目标名称' };
        if (name.length > 20) return { ok: false, msg: '目标名称请控制在 20 个字以内' };
        cur.name = name;
      }
      if (patch.targetAmount !== undefined) {
        var target = toCents(patch.targetAmount);
        if (!target || target <= 0) return { ok: false, msg: '目标金额必须大于 0' };
        cur.targetAmount = target;
      }
      if (patch.targetDate !== undefined) {
        var td = patch.targetDate ? String(patch.targetDate) : null;
        if (td && !isValidDateStr(td)) return { ok: false, msg: '目标日期格式不对' };
        cur.targetDate = td;
      }
      if (patch.icon !== undefined) cur.icon = String(patch.icon || '🎯').slice(0, 4);
      cur.updatedAt = Date.now();
      if (!writeJSON(KEY_SAVINGS, goals)) return { ok: false, msg: '保存失败，手机存储可能已满' };
      return { ok: true };
    },
    remove: function (id) {
      var goals = Savings.all();
      var next = goals.filter(function (g) { return g.id !== id; });
      if (next.length === goals.length) return { ok: false, msg: '目标不存在' };
      if (!writeJSON(KEY_SAVINGS, next)) return { ok: false, msg: '保存失败，手机存储可能已满' };
      return { ok: true };
    },
    /* 已攒金额 = 该目标所有「存入」记录金额之和 − 所有「取出」记录金额之和。
       两种记录的 amount 都存正数（分），方向由 savingsKind 表示。
       不再读目标对象上的任何已攒字段：目标只描述「要攒多少」。 */
    savedAmount: function (goalId) {
      var id = String(goalId == null ? '' : goalId);
      var sum = 0;
      Records.all().forEach(function (r) {
        if (!isSavingsRecord(r)) return;
        if (String(r.goalId) !== id) return;
        var v = Number(r.amount) || 0;
        sum += isSavingsOut(r) ? -v : v;
      });
      return sum;
    },
    /* 全部目标的已攒合计，用于首页「可支配」 */
    savedTotal: function () {
      var sum = 0;
      Records.all().forEach(function (r) {
        if (!isSavingsRecord(r)) return;
        var v = Number(r.amount) || 0;
        sum += isSavingsOut(r) ? -v : v;
      });
      return sum;
    },
    /* 存入一笔：记一条 type='expense' 的攒钱记录（钱从"可花"变成"攒起来"）。
       金额必须 > 0。 */
    deposit: function (goalId, amount) {
      var goal = Savings.get(goalId);
      if (!goal) return { ok: false, msg: '目标不存在' };
      var cents = toCents(amount);
      if (!cents || cents <= 0) return { ok: false, msg: '存入金额必须大于 0' };
      var res = Records.add({
        amount: cents / 100, type: 'expense', categoryId: null,
        goalId: goal.id, savingsKind: 'in'
      });
      if (!res.ok) return res;
      return { ok: true, amount: cents, savedAmount: Savings.savedAmount(goal.id) };
    },
    /* 取出一笔：记一条 type='income' 的攒钱记录。
       金额必须 > 0，且不得超过该目标当前已攒。 */
    withdraw: function (goalId, amount) {
      var goal = Savings.get(goalId);
      if (!goal) return { ok: false, msg: '目标不存在' };
      var cents = toCents(amount);
      if (!cents || cents <= 0) return { ok: false, msg: '取出金额必须大于 0' };
      var saved = Savings.savedAmount(goal.id);
      if (saved <= 0) {
        return { ok: false, msg: '「' + goal.name + '」还没有已攒金额，暂时取不出' };
      }
      if (cents > saved) {
        return {
          ok: false,
          msg: '取出金额不能超过当前已攒 ¥' + prettyAmount(saved) + '，最多可取 ¥' + prettyAmount(saved)
        };
      }
      var res = Records.add({
        amount: cents / 100, type: 'income', categoryId: null,
        goalId: goal.id, savingsKind: 'out'
      });
      if (!res.ok) return res;
      return { ok: true, amount: cents, savedAmount: saved - cents };
    },
    estimate: function (goal) {
      var remaining = (Number(goal.targetAmount) || 0) - Savings.savedAmount(goal.id);
      if (remaining <= 0) {
        return { remaining: remaining, dataMonths: [], avgBalance: 0, status: 'done', monthsNeeded: 0 };
      }
      var key = Stats.monthKey();
      var candidates = [Stats.shiftMonth(key, -1), Stats.shiftMonth(key, -2), Stats.shiftMonth(key, -3)];
      var dataMonths = [];
      var sum = 0;
      candidates.forEach(function (m) {
        /* 只看真实收支：某个月只有攒钱记录 = 没有可用于估算的结余数据 */
        var list = Records.byMonth(m).filter(function (r) { return !isSavingsRecord(r); });
        if (list.length > 0) {
          dataMonths.push(m);
          sum += Stats.totals(list).balance;
        }
      });
      if (dataMonths.length === 0) {
        return { remaining: remaining, dataMonths: dataMonths, avgBalance: 0, status: 'no-data', monthsNeeded: 0 };
      }
      var avg = sum / dataMonths.length;
      if (avg === 0) {
        return { remaining: remaining, dataMonths: dataMonths, avgBalance: avg, status: 'zero', monthsNeeded: 0 };
      }
      if (avg < 0) {
        return { remaining: remaining, dataMonths: dataMonths, avgBalance: avg, status: 'negative', monthsNeeded: 0 };
      }
      return {
        remaining: remaining,
        dataMonths: dataMonths,
        avgBalance: avg,
        status: 'ok',
        monthsNeeded: Math.max(1, Math.ceil(remaining / avg))
      };
    }
  };

  global.Store = {
    Records: Records,
    Categories: Categories,
    Stats: Stats,
    Savings: Savings,
    util: {
      toDateStr: toDateStr,
      todayStr: todayStr,
      toCents: toCents,
      fromCents: fromCents,
      prettyAmount: prettyAmount,
      pad2: pad2,
      uid: uid,
      /* 流水渲染要判定"这条是不是攒钱记录"，统一走这两个判定，避免两处口径不一致 */
      isSavingsRecord: isSavingsRecord,
      isSavingsOut: isSavingsOut
    }
  };
})(window);
