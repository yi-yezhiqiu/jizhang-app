/* 主逻辑：界面渲染 + 交互 + 键盘适配
   依赖 store.js（数据层），不直接碰 localStorage。 */
(function () {
  'use strict';

  var S = window.Store;
  var U = S.util;
  var $$ = function (id) { return document.getElementById(id); };

  /* ---------------- 应用状态 ---------------- */

  var state = {
    page: 'home',
    type: 'expense',
    amount: '',          // 用户正在输入的原始字符串
    categoryId: null,
    date: U.todayStr(),
    month: S.Stats.monthKey(),
    editingId: null,
    editType: 'expense',
    editCategoryId: null,
    confirmAction: null,
    editingGoalId: null,   // null = 新建目标，否则为编辑中的目标 id
    savedGoalId: null,     // 正在存取金额的目标 id
    savedKind: 'in',       // 'in' = 存入（弹层记录一变 expense），'out' = 取出
    goalIcon: '🎯'         // 当前选中/输入的目标图标
  };

  /* ---------------- 通用小工具 ---------------- */

  var toastTimer = null;
  function toast(msg) {
    var el = $$('toast');
    el.textContent = msg;
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 1900);
  }

  function confirmAsk(title, msg, onYes) {
    $$('confirmTitle').textContent = title;
    $$('confirmMsg').textContent = msg;
    state.confirmAction = onYes;
    $$('confirmMask').hidden = false;
  }

  /* 关闭弹层：先把弹层内输入框的焦点收掉再隐藏。
     不这样做的话键盘会挂在页面上（弹层已关、键盘还在），
     而且 sheet 的"键盘态"要靠失焦事件解除。 */
  function hideMask(id) {
    var mask = $$(id);
    if (!mask) return;
    var a = document.activeElement;
    if (a && a !== document.body && typeof a.blur === 'function' &&
        mask.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) {
      a.blur();
    }
    mask.hidden = true;
    sheetKbMask = null;
    syncSheetKeyboard();
  }

  /* 金额输入框的内容清洗：只允许数字和一个小数点，最多两位小数 */
  /* 金额输入清洗。
     只做两件事：全角转半角、过滤非法字符、小数位截到两位。
     注意不要用 ^0+(?=\d) 去掉前导零——用户输入 "0." 的过程中
     前导零是必需的，激进清洗会让键入体验变得诡异。 */
  function sanitizeAmount(raw) {
    var s = String(raw == null ? '' : raw);
    s = s.replace(/[０-９]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    }).replace(/[．。]/g, '.');
    s = s.replace(/[^\d.]/g, '');
    var firstDot = s.indexOf('.');
    if (firstDot >= 0) {
      s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, '');
      var parts = s.split('.');
      s = parts[0] + '.' + (parts[1] || '').slice(0, 2);
    }
    return s.slice(0, 12);
  }

  function amountCents() { return U.toCents(state.amount); }

  /* ---------------- 页面切换 ---------------- */

  function switchPage(name) {
    if (name === 'list') name = 'home';   // 流水已合并进首页
    dismissKeyboard();                    // 切页面时把键盘收起来
    state.page = name;
    ['home', 'month', 'goals', 'settings'].forEach(function (p) {
      var el = $$('page-' + p);
      if (el) el.hidden = (p !== name);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.classList.toggle('is-active', t.getAttribute('data-page') === name);
    });
    if (name === 'home') renderHome();
    if (name === 'month') renderMonth();
    if (name === 'goals') renderGoals();
    if (name === 'settings') renderSettings();
  }

  /* ---------------- 首页：汇总 + 流水 + 记账区 ---------------- */

  function renderSummaryBar() {
    var month = S.Stats.monthKey();
    var t = S.Stats.totals(S.Records.byMonth(month));
    /* 可支配 = 总余额（全部记录 收入 − 真实支出，不含攒钱记录）− 已攒合计。
       攒钱只是把钱从"可花"挪到"攒起来"，所以要从可支配里扣掉；
       允许为负（攒过头了），不做截断。 */
    var all = S.Stats.totals(S.Records.all());
    var disposable = all.balance - S.Savings.savedTotal();
    // 标签里带上具体年月，否则只写"本月"会分不清现在是哪个月
    var mLabel = S.Stats.monthLabel(month);
    $$('summaryBar').innerHTML =
      '<div class="sum-item"><div class="sum-label">' + esc(mLabel) + '支出</div>' +
        '<div class="sum-value expense">' + U.prettyAmount(t.expense) + '</div></div>' +
      '<div class="sum-item"><div class="sum-label">' + esc(mLabel) + '收入</div>' +
        '<div class="sum-value income">' + U.prettyAmount(t.income) + '</div></div>' +
      '<div class="sum-item"><div class="sum-label">结余</div>' +
        '<div class="sum-value balance">' + U.prettyAmount(t.balance) + '</div></div>' +
      '<div class="sum-item"><div class="sum-label">可支配</div>' +
        '<div class="sum-value balance">' + U.prettyAmount(disposable) + '</div></div>';
  }

  function renderList() {
    var host = $$('listScroll');
    var all = S.Records.sorted();
    if (!all.length) {
      host.innerHTML = '<div class="empty"><span class="empty-ico">📝</span>' +
        '还没有记录<br>在下面输入金额，点「保存」就能记第一笔</div>';
      return;
    }

    // 按日期分组
    var groups = [];
    var map = {};
    all.forEach(function (r) {
      if (!map[r.date]) { map[r.date] = []; groups.push({ date: r.date, items: map[r.date] }); }
      map[r.date].push(r);
    });

    var html = '';
    groups.forEach(function (g) {
      var t = S.Stats.totals(g.items);
      var parts = [];
      if (t.expense > 0) parts.push('-' + U.prettyAmount(t.expense));
      if (t.income > 0) parts.push('+' + U.prettyAmount(t.income));
      html += '<div class="day-head"><span>' + esc(S.Stats.dayLabel(g.date)) +
        '</span><span class="day-total">' + esc(parts.join('  ')) + '</span></div>';
      g.items.forEach(function (r) {
        var isIncome = r.type === 'income';
        var sav = U.isSavingsRecord(r);
        var ico, label, sub;
        if (sav) {
          /* 攒钱记录：标签固定「攒钱」，用图标区分方向，副标题是目标名称。
             不能按普通消费类目渲染（它本来就没有分类）。 */
          var isOut = U.isSavingsOut(r);
          var goal = S.Savings.get(String(r.goalId));
          ico = isOut ? '📤' : '🏦';
          label = '攒钱';
          sub = goal ? goal.name : '已删除的目标';
          if (r.note) sub += ' · ' + r.note;
        } else {
          ico = S.Categories.iconOf(r.categoryId);
          label = S.Categories.nameOf(r.categoryId);
          sub = r.note || '';
        }
        html += '<div class="rec" data-id="' + esc(r.id) + '">' +
          '<div class="rec-ico">' + esc(ico) + '</div>' +
          '<div class="rec-main"><div class="rec-cat">' + esc(label) + '</div>' +
          (sub ? '<div class="rec-note">' + esc(sub) + '</div>' : '') +
          '</div>' +
          '<div class="rec-amt ' + (isIncome ? 'income' : 'expense') + '">' +
          (isIncome ? '+' : '-') + esc(U.prettyAmount(r.amount)) + '</div>' +
          '</div>';
      });
    });
    host.innerHTML = html;

    // 绑定点击 → 打开编辑
    Array.prototype.forEach.call(host.querySelectorAll('.rec'), function (el) {
      el.addEventListener('click', function () { openEdit(el.getAttribute('data-id')); });
    });
  }

  function renderCatStrip() {
    var cats = S.Categories.byType(state.type);
    // 若当前选中分类不属于该类，自动切到上次用的或第一个
    var ids = cats.map(function (c) { return c.id; });
    if (ids.indexOf(state.categoryId) < 0) {
      var last = S.Categories.lastUsed(state.type);
      state.categoryId = (last && ids.indexOf(last) >= 0) ? last : (ids[0] || null);
    }
    var html = cats.map(function (c) {
      return '<button type="button" class="cat-item' +
        (c.id === state.categoryId ? ' is-active' : '') + '" data-id="' + esc(c.id) + '">' +
        '<span class="cat-ico">' + esc(c.icon) + '</span>' +
        '<span class="cat-name">' + esc(c.name) + '</span></button>';
    }).join('');
    if (!cats.length) html = '<div class="cat-item">点设置添加分类</div>';
    $$('catStrip').innerHTML = html;

    Array.prototype.forEach.call($$('catStrip').querySelectorAll('.cat-item[data-id]'), function (el) {
      /* 只处理 mousedown 与 click，**绝对不要碰 touchstart**。

         这里曾经写过：
             el.addEventListener('touchstart', function (e) { e.preventDefault(); el.click(); });
         本意是"点分类时别让金额框失焦"，但它把浏览器默认的横向滑动手势也一起
         阻止了 —— 手指一碰分类，事件就被抢走并强制触发点击，于是：
           · 想滑动时，滑到哪都会选中那个分类
           · 想点选时，轻微位移又被忽略，感觉点了没反应
         用户反馈的"滑动触发机制很乱"就是这么来的。

         实际上点分类本来就不会收起键盘（button 不抢焦点），这个监听器纯属多余。
         mousedown 的 preventDefault 只影响鼠标场景的焦点转移，不会干扰触摸滚动。 */
      el.addEventListener('mousedown', function (e) { e.preventDefault(); });
      el.addEventListener('click', function () {
        state.categoryId = el.getAttribute('data-id');
        renderCatStrip();
      });
    });
  }

  function renderAmountRow() {
    var row = $$('amountRow');
    row.classList.toggle('is-income', state.type === 'income');
    $$('saveBtn').disabled = amountCents() <= 0;
  }

  function renderDateChip() {
    var chip = $$('dateChip');
    var label = S.Stats.dayLabel(state.date);
    $$('dateChipText').textContent = label;
    chip.classList.toggle('is-past', state.date !== U.todayStr());
  }

  function renderHome() {
    renderSummaryBar();
    renderList();
    renderCatStrip();
    renderAmountRow();
    renderDateChip();
  }

  /* ---------------- 记一笔 ---------------- */

  function saveEntry() {
    var cents = amountCents();
    if (cents <= 0) { toast('请先输入金额'); return; }
    if (!state.categoryId) { toast('请先选择一个分类'); return; }

    var res = S.Records.add({
      amount: cents / 100,
      type: state.type,
      categoryId: state.categoryId,
      date: state.date,
      note: $$('noteInput').value
    });
    if (!res.ok) { toast(res.msg); return; }

    /* 保存后清空金额与备注，但**不动键盘、不动画面**。
       这是用户明确要求的行为：点保存就立刻记下，屏幕保持原样，
       想接着记下一笔直接输金额即可；想收键盘自己点空白处。

       这里曾两次做错过：
         1. 自动 focus 回金额框 -> 键盘反复弹起，挡住流水；
         2. 主动 dismissKeyboard() -> 必须先收键盘、画面降下来才能点保存，
            多了一步很别扭。
       现在的原则：保存是一个纯粹的"写入"动作，不该引起任何布局变化。 */
    state.amount = '';
    $$('amountInput').value = '';
    $$('noteInput').value = '';

    // renderHome 只重绘汇总与流水，不会碰金额/备注输入框，也不影响键盘。
    // 当前分类与日期保持不动，方便连续记账。
    renderHome();
    var total = S.Records.all().length;
    toast(total % 5 === 0 ? '已记录 ' + total + ' 笔' : '已保存');
  }

  /* ---------------- 编辑 / 删除 ---------------- */

  function openEdit(id) {
    var rec = S.Records.all().filter(function (r) { return r.id === id; })[0];
    if (!rec) { toast('记录不存在'); return; }
    state.editingId = id;
    state.editType = rec.type;
    state.editCategoryId = rec.categoryId;
    $$('editAmount').value = U.prettyAmount(rec.amount);
    $$('editDate').value = rec.date;
    $$('editNote').value = rec.note || '';
    Array.prototype.forEach.call($$('editTypeSeg').querySelectorAll('.seg-btn'), function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-type') === rec.type);
    });
    renderEditCats();
    $$('editMask').hidden = false;
  }

  function renderEditCats() {
    var cats = S.Categories.byType(state.editType);
    var ids = cats.map(function (c) { return c.id; });
    if (ids.indexOf(state.editCategoryId) < 0) state.editCategoryId = ids[0] || null;
    $$('editCats').innerHTML = cats.map(function (c) {
      return '<button type="button" class="mini-cat' +
        (c.id === state.editCategoryId ? ' is-active' : '') + '" data-id="' + esc(c.id) + '">' +
        esc(c.icon) + ' ' + esc(c.name) + '</button>';
    }).join('');
    Array.prototype.forEach.call($$('editCats').querySelectorAll('.mini-cat'), function (el) {
      el.addEventListener('click', function () {
        state.editCategoryId = el.getAttribute('data-id');
        renderEditCats();
      });
    });
  }

  function saveEdit() {
    if (!state.editingId) return;
    var res = S.Records.update(state.editingId, {
      amount: $$('editAmount').value,
      type: state.editType,
      categoryId: state.editCategoryId,
      date: $$('editDate').value || U.todayStr(),
      note: $$('editNote').value
    });
    if (!res.ok) { toast(res.msg); return; }
    hideMask('editMask');
    state.editingId = null;
    renderHome();
    if (state.page === 'month') renderMonth();
    toast('已更新');
  }

  function deleteEdit() {
    var id = state.editingId;
    if (!id) return;
    confirmAsk('删除这笔记录？', '删除后无法恢复。', function () {
      var res = S.Records.remove(id);
      if (!res.ok) { toast(res.msg); return; }
      hideMask('editMask');
      state.editingId = null;
      renderHome();
      if (state.page === 'month') renderMonth();
      toast('已删除');
    });
  }

  /* ---------------- 本月 ---------------- */

  function renderMonth() {
    $$('monthTitle').textContent = S.Stats.monthLabel(state.month);
    var list = S.Records.byMonth(state.month);
    var t = S.Stats.totals(list);
    var html = '';

    html += '<div class="card"><div class="month-totals">' +
      '<div class="sum-item"><div class="sum-label">支出</div>' +
        '<div class="big-num expense" style="color:var(--expense)">' + esc(U.prettyAmount(t.expense)) + '</div></div>' +
      '<div class="sum-item"><div class="sum-label">收入</div>' +
        '<div class="big-num income" style="color:var(--income)">' + esc(U.prettyAmount(t.income)) + '</div></div>' +
      '<div class="sum-item"><div class="sum-label">结余</div>' +
        '<div class="big-num balance" style="color:var(--accent)">' + esc(U.prettyAmount(t.balance)) + '</div></div>' +
      '</div>';

    // 每日支出柱状图
    var daily = S.Stats.dailyExpense(state.month);
    var max = Math.max.apply(null, daily.concat([0]));
    var isCurrentMonth = (state.month === S.Stats.monthKey());
    var todayDate = new Date().getDate();
    var bars = '';
    for (var i = 0; i < daily.length; i++) {
      var v = daily[i];
      var h = max > 0 ? Math.max(2, Math.round(v / max * 78)) : 2;
      var cls = 'day-bar' + (v === 0 ? ' is-zero' : '') +
        (isCurrentMonth && (i + 1) === todayDate ? ' is-today' : '');
      var showLabel = (i === 0 || (i + 1) % 5 === 0 || (i + 1) === daily.length);
      bars += '<div class="day-bar-wrap">' +
        '<div class="' + cls + '" style="height:' + h + 'px"></div>' +
        '<div class="day-bar-label">' + (showLabel ? (i + 1) : '') + '</div></div>';
    }
    html += '<div class="chart-wrap"><div class="chart-title">每日支出</div>' +
      '<div class="day-chart">' + bars + '</div>' +
      '<div class="chart-legend"><span>1 日</span><span>最高 ' +
      esc(U.prettyAmount(max)) + '</span><span>' + daily.length + ' 日</span></div></div>';

    html += '<div class="card-hint" style="margin-top:8px">共 ' +
      list.filter(function (r) { return !U.isSavingsRecord(r); }).length +
      ' 笔记录（未含攒钱进出）</div></div>';

    // 分类排名
    var ranks = S.Stats.byCategory(list, 'expense');
    html += '<div class="card"><div class="card-title">支出分类</div>';
    if (!ranks.length) {
      html += '<div class="card-hint">本月还没有支出记录</div>';
    } else {
      html += '<div class="cat-rank">' + ranks.map(function (r) {
        return '<div class="rank-row">' +
          '<div class="rank-top"><span class="rank-ico">' + esc(r.icon) + '</span>' +
          '<span class="rank-name">' + esc(r.name) + '</span>' +
          '<span class="rank-pct">' + r.percent.toFixed(1) + '%</span>' +
          '<span class="rank-amt">' + esc(U.prettyAmount(r.total)) + '</span></div>' +
          '<div class="rank-track"><div class="rank-fill" style="width:' +
          Math.max(1, Math.round(r.percent)) + '%"></div></div></div>';
      }).join('') + '</div>';
    }
    html += '</div>';

    // 收入分类
    var inRanks = S.Stats.byCategory(list, 'income');
    if (inRanks.length) {
      html += '<div class="card"><div class="card-title">收入分类</div><div class="cat-rank">' +
        inRanks.map(function (r) {
          return '<div class="rank-row">' +
            '<div class="rank-top"><span class="rank-ico">' + esc(r.icon) + '</span>' +
            '<span class="rank-name">' + esc(r.name) + '</span>' +
            '<span class="rank-pct">' + r.percent.toFixed(1) + '%</span>' +
            '<span class="rank-amt" style="color:var(--income)">' + esc(U.prettyAmount(r.total)) + '</span></div>' +
            '<div class="rank-track"><div class="rank-fill" style="width:' +
            Math.max(1, Math.round(r.percent)) + '%;background:var(--income)"></div></div></div>';
        }).join('') + '</div></div>';
    }

    $$('monthScroll').innerHTML = html;
  }

  /* ---------------- 设置 ---------------- */

  function renderSettings() {
    var cats = S.Categories.all();
    /* 顺序 = jizhang.categories.v1 数组自身顺序，所以只要交换数组里同组的相邻两项。
       builtin 分类同样可以移动（顺序是用户偏好，与能否删除无关），
       到顶 / 到底时对应按钮禁用。移动按钮只用 click，**绝不碰 touchstart**
       （分类项上曾经因为 touchstart 抢事件把滑动/点击搞坏过）。 */
    function group(type, label) {
      var list = cats.filter(function (c) { return c.type === type; });
      return '<div class="cat-group-label">' + label + '</div><div class="cat-chip-row">' +
        list.map(function (c, i) {
          var first = (i === 0);
          var last = (i === list.length - 1);
          return '<div class="cat-chip' + (c.builtin ? ' is-builtin' : '') + '">' +
            '<span>' + esc(c.icon) + '</span><span>' + esc(c.name) + '</span>' +
            '<button type="button" class="chip-move" data-id="' + esc(c.id) + '" data-dir="-1"' +
              (first ? ' disabled' : '') + ' aria-label="上移" title="上移">▲</button>' +
            '<button type="button" class="chip-move" data-id="' + esc(c.id) + '" data-dir="1"' +
              (last ? ' disabled' : '') + ' aria-label="下移" title="下移">▼</button>' +
            (c.builtin ? '' : '<span class="chip-del" data-id="' + esc(c.id) + '">×</span>') +
            '</div>';
        }).join('') + '</div>';
    }
    $$('catManage').innerHTML = group('expense', '支出分类') + group('income', '收入分类');

    Array.prototype.forEach.call($$('catManage').querySelectorAll('.chip-del'), function (el) {
      el.addEventListener('click', function () {
        var id = el.getAttribute('data-id');
        var name = S.Categories.nameOf(id);
        confirmAsk('删除分类「' + name + '」？', '删除后该分类不再出现在记账界面。', function () {
          var res = S.Categories.remove(id);
          if (!res.ok) { toast(res.msg); return; }
          renderSettings();
          renderHome();
          toast('已删除分类');
        });
      });
    });

    Array.prototype.forEach.call($$('catManage').querySelectorAll('.chip-move'), function (el) {
      el.addEventListener('click', function () {
        if (el.disabled) return;
        var dir = parseInt(el.getAttribute('data-dir'), 10);
        var res = S.Categories.move(el.getAttribute('data-id'), dir);
        if (!res.ok) { toast(res.msg); return; }
        renderSettings();
        renderHome();      // 记账页的分类条顺序同步变化
        toast(dir < 0 ? '已上移' : '已下移');
      });
    });

    var records = S.Records.all();
    var savCount = 0;
    records.forEach(function (r) { if (U.isSavingsRecord(r)) savCount += 1; });
    var t = S.Stats.totals(records);
    $$('dataInfo').innerHTML =
      '记录总数：<b>' + records.length + '</b> 笔<br>' +
      '累计支出：<b style="color:var(--expense)">' + esc(U.prettyAmount(t.expense)) + '</b><br>' +
      '累计收入：<b style="color:var(--income)">' + esc(U.prettyAmount(t.income)) + '</b>' +
      /* 攒钱记录不计入上面的收支（它们是钱在自己口袋之间挪），单独列一行说明 */
      (savCount
        ? '<br>其中攒钱记录 <b>' + savCount + '</b> 笔，当前已攒 <b style="color:var(--accent)">' +
          esc(U.prettyAmount(S.Savings.savedTotal())) + '</b>'
        : '');
  }

  /* ---------------- 攒钱目标 ---------------- */

  var PRESET_GOAL_ICONS = ['🚗', '🏠', '💻', '📱', '🎁', '✈️', '🏦', '💍'];

  function renderEstimateLine(est) {
    switch (est.status) {
      case 'no-data':
        return '暂无历史结余，先记几笔再估算';
      case 'zero':
        return '近三个月月均结余为 0，暂时攒不动，先调整收支';
      case 'negative':
        return '近三个月月均结余为 -¥' + U.prettyAmount(-est.avgBalance) + '，照此速度无法达成';
      case 'ok':
        if (est.monthsNeeded >= 120) return '按当前速度还需约 10 年以上';
        return '按当前速度还需约 ' + est.monthsNeeded + ' 个月';
      default:
        return '';
    }
  }

  function renderGoals() {
    var host = $$('goalsScroll');
    var goals = S.Savings.all();
    if (!goals.length) {
      host.innerHTML = '<div class="empty"><span class="empty-ico">🎯</span>' +
        '还没有攒钱目标<br>点上方「＋ 新建」创建第一个目标</div>';
      return;
    }

    host.innerHTML = goals.map(function (g) {
      /* 已攒金额不再存在目标上：由该目标的存入/取出记录自动汇总 */
      var saved = S.Savings.savedAmount(g.id);
      var est = S.Savings.estimate(g);
      var percent = g.targetAmount > 0 ? (saved / g.targetAmount * 100) : 0;
      var barWidth = Math.min(100, Math.max(0, percent));
      var reached = saved >= g.targetAmount;
      var statusText = reached
        ? '已达成 🎉'
        : '还差 ¥' + esc(U.prettyAmount(g.targetAmount - saved)) +
          ' · 已完成 ' + percent.toFixed(1) + '%';
      var estText = reached ? '' : renderEstimateLine(est);
      var dateText = g.targetDate
        ? '<span class="goal-date">目标日期 ' + esc(g.targetDate) + '</span>' : '';

      return '<div class="goal-card" data-id="' + esc(g.id) + '">' +
        '<div class="goal-top">' +
          '<span class="goal-ico">' + esc(g.icon) + '</span>' +
          '<span class="goal-name">' + esc(g.name) + '</span>' + dateText +
        '</div>' +
        '<div class="goal-amounts">已攒 ¥' + esc(U.prettyAmount(saved)) +
          ' / 目标 ¥' + esc(U.prettyAmount(g.targetAmount)) + '</div>' +
        '<div class="goal-track"><div class="goal-fill' + (reached ? ' is-done' : '') +
          '" style="width:' + barWidth.toFixed(2) + '%"></div></div>' +
        '<div class="goal-status' + (reached ? ' is-done' : '') + '">' + statusText + '</div>' +
        (estText ? '<div class="goal-est">' + estText + '</div>' : '') +
        '<div class="goal-actions">' +
          '<button type="button" class="btn goal-op goal-in" data-id="' + esc(g.id) +
            '" data-kind="in">存入</button>' +
          '<button type="button" class="btn goal-op goal-out" data-id="' + esc(g.id) +
            '" data-kind="out"' + (saved > 0 ? '' : ' disabled') + '>取出</button>' +
        '</div>' +
      '</div>';
    }).join('');

    Array.prototype.forEach.call(host.querySelectorAll('.goal-card'), function (card) {
      card.addEventListener('click', function (e) {
        // 底部操作行整块不吃卡片点击（已禁用的「取出」也不会误开编辑弹层）
        if (e.target.closest && e.target.closest('.goal-actions')) return;
        openGoalEdit(card.getAttribute('data-id'));
      });
    });
    Array.prototype.forEach.call(host.querySelectorAll('.goal-op'), function (btn) {
      btn.addEventListener('click', function () {
        if (btn.disabled) return;
        openSavedMask(btn.getAttribute('data-id'), btn.getAttribute('data-kind'));
      });
    });
  }

  function renderGoalIcons() {
    var host = $$('goalIcons');
    var manual = $$('goalIcon').value.trim();
    var current = manual || state.goalIcon || '🎯';
    host.innerHTML = PRESET_GOAL_ICONS.map(function (ic) {
      var active = !manual && ic === current;
      return '<button type="button" class="goal-icon' + (active ? ' is-active' : '') +
        '" data-icon="' + esc(ic) + '">' + ic + '</button>';
    }).join('');
    Array.prototype.forEach.call(host.querySelectorAll('.goal-icon'), function (btn) {
      btn.addEventListener('click', function () {
        state.goalIcon = btn.getAttribute('data-icon');
        $$('goalIcon').value = '';
        renderGoalIcons();
      });
    });
  }

  function openGoalEdit(id) {
    var goal = id ? S.Savings.get(id) : null;
    if (id && !goal) { toast('目标不存在'); return; }
    state.editingGoalId = id || null;
    $$('goalMaskTitle').textContent = goal ? '编辑目标' : '新建目标';
    $$('goalName').value = goal ? goal.name : '';
    $$('goalAmount').value = goal ? U.prettyAmount(goal.targetAmount) : '';
    $$('goalDate').value = (goal && goal.targetDate) ? goal.targetDate : '';
    var icon = goal ? (goal.icon || '🎯') : '🎯';
    state.goalIcon = icon;
    var isPreset = PRESET_GOAL_ICONS.indexOf(icon) >= 0;
    $$('goalIcon').value = isPreset ? '' : icon;
    $$('goalDelete').hidden = !goal;
    $$('goalMask').hidden = false;
    renderGoalIcons();
  }

  function saveGoal() {
    var name = $$('goalName').value;
    var amount = $$('goalAmount').value;
    var date = $$('goalDate').value || null;
    var icon = $$('goalIcon').value.trim() || state.goalIcon || '🎯';
    var wasEdit = !!state.editingGoalId;
    var res;
    if (wasEdit) {
      res = S.Savings.update(state.editingGoalId, {
        name: name, targetAmount: amount, targetDate: date, icon: icon
      });
    } else {
      res = S.Savings.add({
        name: name, targetAmount: amount, targetDate: date, icon: icon
      });
    }
    if (!res.ok) { toast(res.msg); return; }
    hideMask('goalMask');
    state.editingGoalId = null;
    renderGoals();
    renderHome();     // 目标改了名字，流水里的攒钱副标题也要跟着变
    toast(wasEdit ? '已更新目标' : '已创建目标');
  }

  function deleteGoal() {
    var id = state.editingGoalId;
    var goal = S.Savings.get(id);
    if (!goal) { toast('目标不存在'); return; }
    confirmAsk('删除目标「' + goal.name + '」？',
      '删除后该攒钱目标会被移除，记账记录不受影响。', function () {
        var res = S.Savings.remove(id);
        if (!res.ok) { toast(res.msg); return; }
        hideMask('goalMask');
        state.editingGoalId = null;
        renderGoals();
        renderHome();
        toast('已删除目标');
      });
  }

  /* 存入 / 取出：输入的是「本次」金额，不是累计总额。
     存入 → 一条 type='expense' 的攒钱记录；取出 → type='income' 的攒钱记录。
     这两条记录都不进收支统计（见 store.js 的 Stats.totals）。 */
  function openSavedMask(id, kind) {
    var goal = S.Savings.get(id);
    if (!goal) { toast('目标不存在'); return; }
    var isOut = (kind === 'out');
    var saved = S.Savings.savedAmount(id);
    state.savedGoalId = id;
    state.savedKind = isOut ? 'out' : 'in';
    $$('savedMaskTitle').textContent = isOut ? '取出金额' : '存入金额';
    $$('savedAmountLabel').textContent = isOut ? '本次取出（元）' : '本次存入（元）';
    $$('savedGoalHint').textContent = '「' + goal.name + '」当前已攒 ¥' + U.prettyAmount(saved) +
      ' / 目标 ¥' + U.prettyAmount(goal.targetAmount);
    $$('savedTip').textContent = isOut
      ? '输入本次要取出的金额，最多可取 ¥' + U.prettyAmount(saved) + '。'
      : '输入本次要存入的金额，会记成一笔攒钱记录。';
    $$('savedAmountInput').value = '';   // 每次都是"本次金额"，不给预填
    $$('savedMask').hidden = false;
  }

  function saveSaved() {
    var id = state.savedGoalId;
    if (!id) return;
    var isOut = state.savedKind === 'out';
    var raw = $$('savedAmountInput').value;
    var res = isOut ? S.Savings.withdraw(id, raw) : S.Savings.deposit(id, raw);
    if (!res.ok) { toast(res.msg); return; }
    hideMask('savedMask');
    state.savedGoalId = null;
    renderGoals();
    renderHome();                        // 流水与汇总条（含"可支配"）同步刷新
    if (state.page === 'month') renderMonth();
    toast((isOut ? '已取出 ¥' : '已存入 ¥') + U.prettyAmount(res.amount));
  }

  /* ---------------- 键盘适配 ----------------
     踩过的坑，结论都记在这里，别退回去重试：

     实测（Android 15 / WebView 124，targetSdk 35）键盘弹起时
     **视口高度可能完全不变**（innerHeight 与 visualViewport.height 都保持 915）。
     因此以下三条路都走不通，均已实测排除：
       1. adjustResize 让系统压缩窗口      -> 视口不变
       2. 用 innerHeight - vv.height 算高度 -> 差值为 0
       3. 让文档可滚动再滚到底部            -> scrollHeight 等于视口高，无余量
     退出 edge-to-edge、去掉 viewport-fit=cover 也都试过。

     所以**不能只依赖视口尺寸**。这里采用双保险：
       A. 输入框 focus / blur 作为键盘开关信号（最可靠）
       B. 若 visualViewport 确实给了键盘高度，就用它精确定位面板；
          若给不出（差值为 0），退回 CSS 里的百分比兜底值
     并按可用高度自适应：键盘矮就多显示几行，键盘高就收起收支切换行。

     重要教训：**金额必须始终可见**。
     早先版本在键盘弹起时把金额行一起藏了，用户在真机上误以为"根本没法输入金额"。 */

  /* ---------------- 弹层 + 键盘（与首页同一套双保险） ----------------

     实测（Android 15 / WebView 124，本 App，1080x2400 @2.625 → CSS 视口 412x915）：
     键盘弹起时 window.innerHeight 与 visualViewport.height **都不变**
     （mInputShown=true 时仍然都是 915），键盘只是盖在屏幕下部约 46% 上。

     而 .mask 是 position:fixed; inset:0、.sheet 底部对齐 —— 它们相对"没有变化的
     布局视口"排版，于是底部对齐的 sheet 会整张钻到键盘下面：
     「更新已攒金额」弹层的输入框与「确定」按钮都在键盘背后，
     用户能打字但点不到确定，一碰能碰到的遮罩背景还会把弹层关掉、输入作废。
     实测：真实触摸「确定」按钮坐标 → 已攒金额不变、弹层不关；触摸遮罩背景 → 弹层被关。

     所以这里改用**焦点信号**判定键盘（探测数值的路径在本机完全失效），
     弹层内输入框聚焦 = 键盘开着 → 抬升整个 sheet（见 css 的 body.sheet-kb-open）。
     若某些机型 visualViewport 确实报告了键盘高度，就用它算精确的可用高度，
     没报告则退回 CSS 的百分比兜底 —— 与首页同一个思路。 */
  /* ---------------- 键盘高度：原生桥 ----------------
     Android WebView 不把键盘高度暴露给网页层（innerHeight / visualViewport 恒定不变，
     输入框也不会因键盘收起而失焦），所以高度由 MainActivity 上报：
       · window.__jzImeUpdate(cssPx) —— 原生主动推送（insets 变化时）
       · window.__jzIme.height()     —— 网页层可同步查询（JavascriptInterface）
     cssPx 为 0 表示键盘已收起。拿不到桥时退回 CSS 的百分比兜底。 */
  var imeFromNative = 0;
  var imeBridgeSeen = false;

  window.__jzImeUpdate = function (cssPx) {
    imeFromNative = Number(cssPx) || 0;
    imeBridgeSeen = true;
    // 弹层的键盘态重算
    try { syncSheetKeyboard(); } catch (e) {}
    // 首页记账面板的重算（布局函数稍后注册到 window 上）
    try { if (typeof window.__jzLayoutEntry === 'function') window.__jzLayoutEntry(); } catch (e) {}
  };

  function nativeIme() {
    // 主动查询：捕捉原生推送可能错过的那一刻（比如键盘被手动收起）
    try {
      if (window.__jzIme && typeof window.__jzIme.height === 'function') {
        var v = Number(window.__jzIme.height());
        if (!isNaN(v)) { imeFromNative = v; imeBridgeSeen = true; }
      }
    } catch (e) { /* 桥不可用时忽略 */ }
    return imeFromNative;
  }

  /* 键盘高度（CSS px）。优先原生的真实值；没有桥时返回 0，由调用方走 CSS 兜底。 */
  function keyboardHeightPx() {
    var h = nativeIme();
    return h > 0 ? h : 0;
  }

  /* 键盘上方可用高度（CSS px）—— 注意语义是"可用高度"而不是"键盘高度"。
     sheet 的底部内边距就用它，于是 .sheet-actions（钉在弹层底部）会被顶到
     键盘上沿之上，而弹层顶边不动。
     返回 0 表示拿不到键盘高度，由 CSS 的百分比兜底。 */
  function sheetGuardPx() {
    var kb = keyboardHeightPx();
    if (kb > 60) {
      var avail = window.innerHeight - kb;   // 键盘上方全部可用空间
      return avail > 120 ? avail : 120;
    }
    // 原生没给值（控件桥不可用）时，退回视觉视口的差值
    var vv = window.visualViewport;
    var guess = vv ? (window.innerHeight - vv.height - (vv.offsetTop || 0)) : 0;
    if (guess > 60) {
      var avail2 = window.innerHeight - guess;
      return avail2 > 120 ? avail2 : 120;
    }
    return 0;   // 0 = 拿不到高度，交给 CSS 百分比兜底
  }

  /* "键盘态"归属哪个弹层。
     只在焦点落到弹层里的输入框时建立；焦点只要还在同一个弹层里（比如点到了
     底部的「确定」按钮）就保持 —— 否则弹层会在这一次触摸中间落回屏幕底部，
     click 重新命中测试时按钮已经不在手指位置，那一下点击就丢了（实测踩过）。

     ⚠️ 关键补充：本机没有任何信号能知道"键盘被用户手动收起"——
     焦点没有离开输入框、innerHeight 与 visualViewport.height 又恒定不变。
     所以一旦只靠焦点判断，用户收起键盘后弹层就会卡在半空下不来（真机反馈过）。
     下面加了「重算窗口」：聚焦后的一段时间内每帧重算，只要视觉视口恢复了全高
     就把键盘态摘掉；另外任何触摸都会重算一次，保证用户一碰屏幕就能复位。 */
  var sheetKbMask = null;

  function syncSheetKeyboard() {
    var a = document.activeElement;
    var isField = !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT'));
    var inMask = (a && a.closest) ? a.closest('.mask') : null;
    if (inMask && isField) sheetKbMask = inMask;
    // 焦点离开这个弹层（或落到 body）才算键盘态结束
    if (!inMask || inMask !== sheetKbMask) sheetKbMask = null;

    /* 关键：即使焦点还在输入框里，只要**原生层报告键盘已收起**，就必须退出键盘态。
       实测用户手动收起键盘时输入框不会失焦，只看焦点的话弹层会永远卡在半空。
       条件里带 imeBridgeSeen，避免在拿不到桥的机型上误判成"键盘已收起"。 */
    var kb = keyboardHeightPx();
    var keyboardGone = imeBridgeSeen && kb <= 40;
    if (sheetKbMask && keyboardGone) sheetKbMask = null;

    var guard = sheetKbMask ? sheetGuardPx() : 0;
    if (guard > 0) document.body.style.setProperty('--sheet-guard', guard + 'px');
    else document.body.style.removeProperty('--sheet-guard');
    document.body.classList.toggle('sheet-kb-open', !!sheetKbMask);
  }

  /* 聚焦后的重算窗口：键盘弹出/收起都有动画，且可能完全不触发事件。
     这里持续重算一小段时间，并通过轮询原生桥捕捉"键盘收起"的那一刻
     （用户手动收起键盘时输入框不会失焦，网页层拿不到任何事件，
      只能主动去问原生层"键盘还在不在"）。 */
  var sheetRecheck = null;
  function startSheetRecheck() {
    stopSheetRecheck();
    var elapsed = 0;
    sheetRecheck = setInterval(function () {
      elapsed += 200;
      syncSheetKeyboard();
      // 键盘收起后 guard 会归零，此时再算两拍就收工
      if (!document.body.classList.contains('sheet-kb-open') && elapsed >= 400) stopSheetRecheck();
      if (elapsed >= 6000) stopSheetRecheck();   // 兜底上限，避免长驻
    }, 200);
  }
  function stopSheetRecheck() {
    if (sheetRecheck) { clearInterval(sheetRecheck); sheetRecheck = null; }
  }

  function setupSheetKeyboard() {
    document.addEventListener('focusin', function () { syncSheetKeyboard(); startSheetRecheck(); });
    // focusout 时 activeElement 还没更新，等一拍再判定
    document.addEventListener('focusout', function () { setTimeout(syncSheetKeyboard, 0); });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', syncSheetKeyboard);
      window.visualViewport.addEventListener('scroll', syncSheetKeyboard);
    }
    window.addEventListener('resize', syncSheetKeyboard);
    /* 任何触摸都重算一次：用户收起键盘后随手碰一下屏幕，弹层就应该落回去。
       放在捕获阶段，保证先于弹层自身的点击逻辑执行。 */
    document.addEventListener('touchstart', function () {
      if (sheetKbMask) { syncSheetKeyboard(); startSheetRecheck(); }
    }, true);
  }

  function setupKeyboardAdaptation() {
    var ai = $$('amountInput');
    var ni = $$('noteInput');
    var entry = $$('entryZone');
    var raf = null;
    var watchdog = null;

    /* 回到"键盘收起"的常态：清掉所有键盘态的痕迹。
       抽成函数是因为有多条探测路径都要用它，避免漏掉某一处导致画面卡住。 */
    function resetToClosed() {
      document.body.classList.remove('kb-open');
      if (entry) {
        entry.style.top = '';
        entry.style.bottom = '';
        entry.classList.remove('kb-tight');
      }
    }

    /* 按键盘高度重排记账面板。

       定位策略（优先级从高到低）：
         1. 原生层报告的键盘高度  -> 面板底边精确贴到键盘上沿（含防顶出钳制）
         2. visualViewport 的差值 -> 少数机型这个值才有效
         3. 都拿不到             -> 退回 CSS 的百分比兜底

       复位策略：以上面算出的键盘高度为唯一依据，不看输入框是否还有焦点。
       之前依赖 activeElement 判断，在真机上踩过坑：键盘收起了但输入框仍保持焦点，
       于是永远不满足复位条件，面板就卡在半空下不来。 */
    function layout() {
      raf = null;
      if (!entry) return;

      // 优先用原生上报的真实键盘高度（本机 visualViewport 恒为 915，完全不可用）
      var kb = keyboardHeightPx();
      if (kb <= 60) {
        var vv = window.visualViewport;
        if (vv) kb = window.innerHeight - vv.height - (vv.offsetTop || 0);
      }
      var kbOpen = kb > 60;

      /* 键盘态这个类由这里统一管：原生桥报高度时会直接调 layout()，
         不必依赖 focus 事件（实测键盘收起时输入框不会失焦，focus 不可靠）。
         注意两边都要处理：只加不移会留下一个假的键盘态，
         此时内联样式已被清空、CSS 的百分比兜底规则又接管，面板就卡在半空。 */
      var editing = (document.activeElement === ai || document.activeElement === ni);
      if (kbOpen && editing) {
        document.body.classList.add('kb-open');
      } else if (!kbOpen || !editing) {
        document.body.classList.remove('kb-open');
      }

      if (kbOpen) {
        // 把面板底边贴到键盘上沿
        var bottom = kb;
        /* 边界钳制：键盘特别高时，若面板向上超出屏幕会把金额框顶出可视区
           （金额是必填项，被顶出去就没法记账了）。
           这里保证面板顶边至少留在屏幕内，必要时让面板下沿压到键盘上一点。 */
        var panelH = entry.offsetHeight || 240;
        var maxBottom = window.innerHeight - panelH - 8;
        if (maxBottom < 0) maxBottom = 0;
        if (bottom > maxBottom) bottom = maxBottom;

        entry.style.top = 'auto';
        entry.style.bottom = bottom + 'px';
        /* 面板全部内容约 235px。键盘上方空间不足时才收起分类条，
           优先保住金额与备注这两个真正要打字的输入框。 */
        entry.classList.toggle('kb-tight', (window.innerHeight - kb - panelH) < 10);
      } else {
        // 系统没报告键盘高度：用 CSS 的百分比兜底，保持全部行
        entry.style.top = '';
        entry.style.bottom = '';
        entry.classList.remove('kb-tight');
      }
    }

    function schedule() {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(layout);
    }
    // 供原生键盘高度上报时回调（见文件上方的 __jzImeUpdate）
    window.__jzLayoutEntry = schedule;

    /* 键盘弹起后启动看门狗：
       有些机型的 visualViewport 始终不反映键盘，此时没有任何"键盘收起"事件。
       所以每隔一段时间查一次——只要系统依然没报告键盘高度，
       就无条件复位。这是"画面卡在半空"的最终兜底。 */
    /* 看门狗：只处理一种情况——**键盘曾经被系统报告过、后来消失了但界面没复位**。
       这是真机上遇到的"画面卡在半空下不来"。

       必须区分两种因果，否则会误伤：
         A. 系统从不报告键盘高度（visualViewport 不可用）
            -> kb 恒为 0。此时键盘其实是开着的，绝不能因为 kb==0 就复位，
               否则面板会落回去被键盘盖住。
         B. 系统报告过键盘高度，之后又变回 0
            -> 说明键盘确实收起了，必须复位。

       用 sawKeyboard 记录"曾经报告过"，避免把 A 误判成 B。 */
    function startWatchdog() {
      stopWatchdog();
      var elapsed = 0;
      var sawKeyboard = false;
      watchdog = setInterval(function () {
        elapsed += 400;
        var vv = window.visualViewport;
        var kb = vv ? (window.innerHeight - vv.height - (vv.offsetTop || 0)) : 0;

        if (kb > 60) {
          sawKeyboard = true;      // 情况：系统确认键盘在
          return;
        }

        if (sawKeyboard) {
          /* 情况 B：曾经有键盘、现在没了 -> 键盘已收起，复位。
             不必再等，因为这是视觉视口的权威变化。 */
          resetToClosed();
          schedule();
          stopWatchdog();
          return;
        }

        /* 情况 A：从没见过键盘高度。不能凭 kb==0 就复位。
           但如果输入框也失去焦点了，那才说明确实没有键盘。 */
        if (elapsed >= 800) {
          var a = document.activeElement;
          if (a !== ai && a !== ni) {
            resetToClosed();
            schedule();
            stopWatchdog();
          }
        }
      }, 400);
    }

    function stopWatchdog() {
      if (watchdog) { clearInterval(watchdog); watchdog = null; }
    }

    function open() {
      document.body.classList.add('kb-open');
      schedule();
      // 键盘动画有延迟，多算几次覆盖不同时序
      setTimeout(schedule, 120);
      setTimeout(schedule, 320);
      startWatchdog();
    }

    function close() {
      stopWatchdog();
      // 延迟再判定：从金额框切到备注框时不该闪一下
      setTimeout(function () {
        var a = document.activeElement;
        if (a !== ai && a !== ni) resetToClosed();
      }, 60);
    }

    [ai, ni].forEach(function (el) {
      if (!el) return;
      el.addEventListener('focus', open);
      el.addEventListener('blur', close);
      // focusout 比 blur 更可靠：某些 WebView 上键盘收起只触发 focusout
      el.addEventListener('focusout', close);
    });

    var vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', schedule);
      vv.addEventListener('scroll', schedule);
    }

    /* 多重兜底：以下任一情况都重新算一次布局
       - 窗口尺寸变化（含键盘收起）
       - 从后台切回前台
       这样即使 focus/blur 在某个机型上没有触发，画面也能自己复位。 */
    window.addEventListener('resize', schedule);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) schedule();
    });

    /* 点输入框以外的地方就收键盘。
       早先只监听 focus/blur，导致点空白处键盘一直挂着下不来。

       例外：**按住「保存」按钮时不能收键盘**。
       真机上出现过"第一次点保存只把键盘收掉、要再点一次才真正保存"，
       根因就是这里：手指按到保存时，输入框先被 blur，
       面板随键盘收起而整体下落，等 click 触发时按钮已经不在原来位置，
       于是这一次点击落空——用户感觉第一下白点了。 */
    document.addEventListener('touchstart', function (e) {
      var t = e.target;
      if (!t || !t.tagName) return;
      var tag = t.tagName.toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      // 保存按钮要单独处理：既不改焦点，也不重排布局
      if (t.id === 'saveBtn' || (t.closest && t.closest('#saveBtn'))) return;
      /* 弹层底部操作行（取消 / 确定 / 保存 / 删除）同理：手指按下的那一刻不能让
         输入框先失焦 —— 键盘态一解除，body.sheet-kb-open 被摘掉、sheet 落回屏幕底部，
         等 click 到达时按钮已经不在手指原来的位置，那一次点击就丢了。
         这里不改焦点、不重排，交回给按钮自己的 click。 */
      if (t.closest && t.closest('.sheet-actions')) return;

      var a = document.activeElement;
      if (a && a !== document.body &&
          (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) {
        a.blur();
      }
      // 无论有没有焦点，都重算一次，确保画面落回原位
      schedule();
    }, true);
  }

  /* 主动收起键盘：切页面时调用 */
  function dismissKeyboard() {
    var a = document.activeElement;
    if (a && a !== document.body &&
        (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) {
      a.blur();
    }
    document.body.classList.remove('kb-open');
    document.body.classList.remove('sheet-kb-open');
    sheetKbMask = null;
    document.body.style.removeProperty('--sheet-guard');
    var entry = $$('entryZone');
    if (entry) {
      entry.style.top = '';
      entry.style.bottom = '';
      entry.classList.remove('kb-tight');
    }
  }

  /* 转义，避免备注里的 < > 破坏结构 */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------------- 事件绑定 ---------------- */

  function bindEvents() {
    // 底部导航
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.addEventListener('click', function () { switchPage(t.getAttribute('data-page')); });
    });

    // 收支类型切换
    Array.prototype.forEach.call($$('typeSwitch').querySelectorAll('.type-btn'), function (b) {
      b.addEventListener('click', function () {
        state.type = b.getAttribute('data-type');
        Array.prototype.forEach.call($$('typeSwitch').querySelectorAll('.type-btn'), function (x) {
          x.classList.toggle('is-active', x === b);
        });
        renderCatStrip();
        renderAmountRow();
      });
    });

    // 金额输入
    var ai = $$('amountInput');
    ai.addEventListener('input', function (e) {
      // 从事件取值，不依赖闭包里的 ai.value——避免与 DOM 实际内容不同步
      var raw = (e && e.target) ? e.target.value : ai.value;
      var clean = sanitizeAmount(raw);
      if (clean !== ai.value) ai.value = clean;
      state.amount = clean;
      renderAmountRow();
    });
    ai.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); saveEntry(); }
    });

    /* 兜底：在 document 上再监听一层金额输入。
       真机上出现过"键盘弹出但字符进不去输入框"的情况，如果元素级监听因为
       某些 WebView 差异没有生效，这一层能保证 value 与按钮状态仍然正确。 */
    document.addEventListener('input', function (e) {
      var t = e.target;
      if (!t || t.id !== 'amountInput') return;
      var clean = sanitizeAmount(t.value);
      if (clean !== t.value) t.value = clean;
      state.amount = clean;
      renderAmountRow();
    }, true);

    /* 兜底：点金额整行都能聚焦到输入框。
       金额数字是右对齐的，整行可点能显著降低点不中的概率。 */
    var amountRowEl = $$('amountRow');
    if (amountRowEl) {
      amountRowEl.addEventListener('click', function (e) {
        if (e.target && e.target.id === 'amountInput') return;
        var el = $$('amountInput');
        if (!el) return;
        try { el.focus({ preventScroll: true }); } catch (err) { el.focus(); }
      });
    }

    // 备注回车即保存
    $$('noteInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); saveEntry(); }
    });

    /* 保存按钮：在第一次触摸时就执行，不等 click。

       为什么要这么绕：真机上"第一下点保存只收起键盘、第二下才保存"。
       原因是手指按下的瞬间输入框先失焦，键盘态随之解除、面板整体下落，
       等 click 事件到达时按钮已经不在手指原来的位置，那一次点击就丢了。

       解法：
         1. touchstart 里 preventDefault —— 不让输入框失焦，屏幕保持不动
         2. 同一次触摸里直接调用 saveEntry —— 不依赖后续 click 是否命中
         3. 记录触摸时间，紧随其后的 click 直接忽略，避免重复记账
         4. 触摸事件不可用时（桌面浏览器、无障碍操作）仍走 click

       用时间戳而不是布尔标记：按钮禁用时触摸不会真正保存，
       布尔标记会被错误地留在 true 上，把之后的点击也吃掉。 */
    var saveBtn = $$('saveBtn');
    var lastTouchSaveAt = 0;

    function trySave() {
      if (saveBtn.disabled) return;   // 金额为空时按钮本来就不该响应
      saveEntry();
    }

    saveBtn.addEventListener('touchstart', function (e) {
      e.preventDefault();             // 关键：不让金额/备注框失焦
      lastTouchSaveAt = Date.now();
      trySave();
    }, { passive: false });

    saveBtn.addEventListener('click', function (e) {
      // 刚由触摸处理过 -> 忽略这次 click，避免记成一笔两笔
      if (Date.now() - lastTouchSaveAt < 800) return;
      trySave();
    });

    // 日期
    $$('dateChip').addEventListener('click', function () {
      $$('datePicker').value = state.date;
      $$('dateMask').hidden = false;
    });
    $$('dateCancel').addEventListener('click', function () { hideMask('dateMask'); });
    $$('dateOk').addEventListener('click', function () {
      state.date = $$('datePicker').value || U.todayStr();
      hideMask('dateMask');
      renderDateChip();
    });
    Array.prototype.forEach.call(document.querySelectorAll('.quick-dates .btn'), function (b) {
      b.addEventListener('click', function () {
        var d = new Date();
        d.setDate(d.getDate() + parseInt(b.getAttribute('data-quick'), 10));
        state.date = U.toDateStr(d);
        $$('datePicker').value = state.date;
      });
    });

    // 编辑弹层
    $$('editCancel').addEventListener('click', function () {
      hideMask('editMask'); state.editingId = null;
    });
    $$('editSave').addEventListener('click', saveEdit);
    $$('editDelete').addEventListener('click', deleteEdit);
    Array.prototype.forEach.call($$('editTypeSeg').querySelectorAll('.seg-btn'), function (b) {
      b.addEventListener('click', function () {
        state.editType = b.getAttribute('data-type');
        Array.prototype.forEach.call($$('editTypeSeg').querySelectorAll('.seg-btn'), function (x) {
          x.classList.toggle('is-active', x === b);
        });
        renderEditCats();
      });
    });
    $$('editAmount').addEventListener('input', function () {
      var clean = sanitizeAmount($$('editAmount').value);
      if (clean !== $$('editAmount').value) $$('editAmount').value = clean;
    });

    // 确认弹层
    $$('confirmNo').addEventListener('click', function () {
      hideMask('confirmMask'); state.confirmAction = null;
    });
    $$('confirmYes').addEventListener('click', function () {
      var fn = state.confirmAction;
      hideMask('confirmMask'); state.confirmAction = null;
      if (typeof fn === 'function') fn();
    });

    // 本月切换
    $$('prevMonth').addEventListener('click', function () {
      state.month = S.Stats.shiftMonth(state.month, -1); renderMonth();
    });
    $$('nextMonth').addEventListener('click', function () {
      state.month = S.Stats.shiftMonth(state.month, 1); renderMonth();
    });

    // 添加分类
    $$('addCatBtn').addEventListener('click', function () {
      var name = $$('newCatName').value;
      var icon = $$('newCatIcon').value;
      var type = $$('newCatType').value;
      var res = S.Categories.add(name, type, icon);
      if (!res.ok) { toast(res.msg); return; }
      $$('newCatName').value = '';
      $$('newCatIcon').value = '';
      renderSettings();
      renderCatStrip();
      toast('已添加分类');
    });

    // 攒钱目标
    $$('addGoalBtn').addEventListener('click', function () { openGoalEdit(null); });
    $$('goalCancel').addEventListener('click', function () {
      hideMask('goalMask'); state.editingGoalId = null;
    });
    $$('goalSave').addEventListener('click', saveGoal);
    $$('goalDelete').addEventListener('click', deleteGoal);
    $$('goalDateClear').addEventListener('click', function () {
      $$('goalDate').value = '';
    });
    $$('goalIcon').addEventListener('input', function () {
      renderGoalIcons();
    });
    $$('goalAmount').addEventListener('input', function () {
      var clean = sanitizeAmount($$('goalAmount').value);
      if (clean !== $$('goalAmount').value) $$('goalAmount').value = clean;
    });
    $$('savedCancel').addEventListener('click', function () {
      hideMask('savedMask'); state.savedGoalId = null;
    });
    $$('savedOk').addEventListener('click', saveSaved);
    $$('savedAmountInput').addEventListener('input', function () {
      var clean = sanitizeAmount($$('savedAmountInput').value);
      if (clean !== $$('savedAmountInput').value) $$('savedAmountInput').value = clean;
    });

    /* 点遮罩关闭弹层。
       必须"按下"和"抬起"都落在遮罩上才关 —— 这是踩过的坑：
       弹层里的输入框一聚焦，键盘弹起、sheet 会被抬到键盘上方（body.sheet-kb-open），
       布局在这一次触摸过程中就变了；浏览器在 touchend 后要按手指位置重新做命中测试，
       那时手指下面的元素已经变成遮罩，一次正常的"点输入框"于是变成了
       "点遮罩关弹层" —— 弹层自己关掉、刚点开的输入框也没进去。
       所以这里记录 touchstart / mousedown 的落点，只有两次都落在遮罩上才关。 */
    [['editMask', function () { hideMask('editMask'); state.editingId = null; }],
     ['dateMask', function () { hideMask('dateMask'); }],
     ['confirmMask', function () { hideMask('confirmMask'); state.confirmAction = null; }],
     ['goalMask', function () { hideMask('goalMask'); state.editingGoalId = null; }],
     ['savedMask', function () { hideMask('savedMask'); state.savedGoalId = null; }]
    ].forEach(function (pair) {
      var mask = $$(pair[0]);
      var downOnMask = false;
      function mark(e) { downOnMask = (e.target === mask); }
      mask.addEventListener('touchstart', mark, true);
      mask.addEventListener('mousedown', mark, true);
      mask.addEventListener('click', function (e) {
        var wasOnMask = downOnMask;
        downOnMask = false;
        if (e.target === mask && wasOnMask) pair[1]();
      });
    });
  }

  /* ---------------- 启动 ---------------- */

  function init() {
    bindEvents();
    setupKeyboardAdaptation();
    setupSheetKeyboard();   // 弹层里的输入框 + 键盘抬升，见 syncSheetKeyboard
    switchPage('home');
    renderHome();
    /* 刻意不在启动时自动聚焦金额框。
       那样一打开 App 键盘就弹出来，把流水挡住一半；
       真机反馈这种"自己弹出来"的体验不好。让用户点一下金额再输。 */
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
