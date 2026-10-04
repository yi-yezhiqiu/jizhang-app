/* verify2 实测探针：一次性返回页面关键区块的几何 + 文本。
   用法: node tools/cdp_eval.mjs --file tools/verify2_probe.js */
(function () {
  function round(n) { return Math.round(n); }
  function rect(sel) {
    var el = document.querySelector(sel);
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return {
      sel: sel,
      l: round(r.left), t: round(r.top), r: round(r.right), b: round(r.bottom),
      w: round(r.width), h: round(r.height),
      display: getComputedStyle(el).display,
      visible: r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none'
    };
  }
  function txt(sel) {
    var el = document.querySelector(sel);
    return el ? String(el.textContent).replace(/\s+/g, ' ').trim() : null;
  }
  function rects(sel) {
    return [].slice.call(document.querySelectorAll(sel)).map(function (el) {
      var r = el.getBoundingClientRect();
      return {
        text: String(el.textContent).replace(/\s+/g, ' ').trim().slice(0, 40),
        l: round(r.left), t: round(r.top), r: round(r.right), b: round(r.bottom),
        w: round(r.width), h: round(r.height)
      };
    });
  }
  var sumItems = rects('.summary-bar .sum-item');
  var out = {
    viewport: {
      innerW: window.innerWidth, innerH: window.innerHeight,
      vvH: window.visualViewport ? round(window.visualViewport.height) : null,
      vvTop: window.visualViewport ? round(window.visualViewport.offsetTop) : null,
      dpr: window.devicePixelRatio
    },
    bodyClass: document.body.className,
    activeEl: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
    page: [].slice.call(document.querySelectorAll('.page')).filter(function (p) { return !p.hidden; }).map(function (p) { return p.id; })[0] || null,
    summaryBar: rect('.summary-bar'),
    summaryItems: sumItems,
    summaryCols: sumItems.length ? new Set(sumItems.map(function (x) { return x.l; })).size : 0,
    summaryTexts: [].slice.call(document.querySelectorAll('.summary-bar .sum-item')).map(function (el) {
      return String(el.textContent).replace(/\s+/g, ' ').trim();
    }),
    summaryOverflow: [].slice.call(document.querySelectorAll('.summary-bar .sum-value')).map(function (el) {
      return { text: el.textContent.trim(), scrollW: el.scrollWidth, clientW: el.clientWidth,
               clipped: el.scrollWidth > el.clientWidth + 1 };
    }),
    goalsHead: rect('.goals-head'),
    addGoalBtn: rect('#addGoalBtn'),
    goalCards: rects('.goal-card'),
    goalCardTexts: [].slice.call(document.querySelectorAll('.goal-card')).map(function (el) {
      return String(el.textContent).replace(/\s+/g, ' ').trim();
    }),
    goalOps: rects('.goal-op'),
    goalOpDisabled: [].slice.call(document.querySelectorAll('.goal-op')).map(function (el) {
      return el.textContent.trim() + ':' + (el.disabled ? 'disabled' : 'enabled') + ':' + round(el.getBoundingClientRect().top);
    }),
    masksVisible: ['goalMask', 'savedMask', 'editMask', 'dateMask', 'confirmMask'].filter(function (id) {
      var el = document.getElementById(id);
      return el && !el.hidden;
    }),
    sheets: rects('.mask:not([hidden]) .sheet'),
    sheetTitles: [].slice.call(document.querySelectorAll('.mask:not([hidden]) .sheet-title')).map(function (e) { return e.textContent.trim(); }),
    sheetInputs: rects('.mask:not([hidden]) input'),
    sheetActions: rects('.mask:not([hidden]) .sheet-actions'),
    settingsCats: rects('#catList .cat-item, .cat-list .cat-item').length,
    settingsSortBtns: rects('[data-sort], .sort-btn, .cat-sort'),
    settingsPageText: (function () {
      var p = document.getElementById('page-settings');
      return p ? String(p.textContent).replace(/\s+/g, ' ').trim().slice(0, 600) : null;
    })(),
    toast: txt('#toast'),
    amountHitTest: (function () {
      var ai = document.getElementById('amountInput');
      if (!ai) return null;
      var r = ai.getBoundingClientRect();
      var cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
      var hit = document.elementFromPoint(cx, cy);
      return { point: [cx, cy], elementAtPoint: hit ? (hit.id || hit.className || hit.tagName) : null,
               isAmountInput: hit === ai };
    })(),
    typeSeg: (function () {
      var seg = document.getElementById('typeSwitch');
      if (!seg) return null;
      var btns = [].slice.call(seg.querySelectorAll('button'));
      return { count: btns.length, items: btns.map(function (b) {
        var r = b.getBoundingClientRect();
        return { text: String(b.textContent).trim(), type: b.getAttribute('data-type'),
                 active: b.classList.contains('is-active'), disabled: !!b.disabled,
                 cx: Math.round((r.left + r.width / 2) * 100) / 100,
                 cy: Math.round((r.top + r.height / 2) * 100) / 100,
                 top: round(r.top), bottom: round(r.bottom), w: round(r.width), h: round(r.height) };
      }) };
    })(),
    catItemCount: document.querySelectorAll('#catStrip .cat-item').length,
    catItemTexts: [].slice.call(document.querySelectorAll('#catStrip .cat-item')).map(function (e) { return String(e.textContent).trim(); }),
    catStrip: rect('#catStrip'),
    saveBtn: rect('#saveBtn'),
    entryZone: rect('#entryZone'),
    amountRowRect: rect('#amountRow'),
    amount: rect('#amountInput'),
    toastRect: (function () {
      var el = document.getElementById('toast');
      if (!el) return null;
      var r = el.getBoundingClientRect();
      return { text: String(el.textContent).trim(), hidden: el.hidden,
               l: round(r.left), t: round(r.top), r: round(r.right), b: round(r.bottom) };
    })(),
    store: (function () {
      try {
        var goals = Store.Savings.all();
        return {
          goalCount: goals.length,
          goals: goals.map(function (g) {
            return {
              id: g.id, name: g.name, targetAmount: g.targetAmount, targetDate: g.targetDate, icon: g.icon,
              saved: Store.Savings.savedAmount(g.id),
              est: Store.Savings.estimate(g)
            };
          }),
          recCount: Store.Records.all().length,
          savedTotal: Store.Savings.savedTotal(),
          thisMonth: (function () {
            var k = Store.Stats.monthKey();
            return { month: k, totals: Store.Stats.totals(Store.Records.byMonth(k)) };
          })()
        };
      } catch (e) { return 'ERR: ' + e.message; }
    })()
  };
  return JSON.stringify(out, null, 1);
})()
