# 攒钱目标 — 界面与数据契约

> 状态：可直接实现（需求/契约文档）
> 依据代码：`app/src/main/assets/www/index.html`、`css/app.css`、`js/store.js`、`js/app.js`、`tools/build.cmd`（均已通读）
> 本次任务边界：**只产出本文档，不修改 `app/` 下任何文件**。

---

## 0. 结论速览

| 事项 | 决定 |
|---|---|
| 入口 | 底部导航新增第 4 个标签「攒钱」（🐷），插在「本月」与「设置」之间 |
| 数据位置 | `localStorage` 新键 `jizhang.savingsGoals.v1`（数组），沿用现有 `readJSON/writeJSON` |
| 金额 | 一律按「分」存整数，与现有记录一致（避免浮点误差） |
| 日期 | 本地时区 `YYYY-MM-DD`，与现有记录一致 |
| 代码位置 | 数据层并入 `js/store.js`（新增 `Store.Savings` 模块），界面并入 `js/app.js` / `css/app.css` / `index.html`，**不新建 JS 文件、不改 script 引入** |
| 估算口径 | 前三个完整自然月（M-1 / M-2 / M-3）的「收入 − 支出」结余求平均，空月不参与平均 |
| 硬约束 | 无外部库、不联网、不改现有记账流程、不改 `tools/build.cmd`、不改 `MainActivity.java` |

---

## 1. 数据模型

### 1.1 存储键名（与现有风格一致）

现有键（`store.js` 顶部）：

- `jizhang.records.v1`
- `jizhang.categories.v1`
- `jizhang.lastUsed.v1`

新增键：

- **`jizhang.savingsGoals.v1`** —— 值是一个数组，默认 `[]`

命名规律：`jizhang.<领域>.<版本>`。读写复用 `store.js` 已有的 `readJSON(key, fallback)` / `writeJSON(key, value)`，因此自动获得「存储损坏时回退默认值」的保护。

### 1.2 目标对象字段

单个攒钱目标对象（存进上面数组的每一项）：

| 字段 | 类型 | 说明与约束 |
|---|---|---|
| `id` | string | `uid('g')`；前缀 `'g'`，与现有 `'r'`（记录）、`'c'`（分类）风格一致 |
| `name` | string | `trim()` 后 **1~20 个字符**，非空 |
| `targetAmount` | int | 目标金额，单位「分」，**必须 > 0**；由 `U.toCents()` 转换 |
| `savedAmount` | int | 已攒金额，单位「分」，**>= 0**；新建默认 `0`；允许大于 `targetAmount` |
| `targetDate` | string \| null | 可选目标日期，本地时区 `YYYY-MM-DD`；未填为 `null` |
| `icon` | string | emoji，`String(icon || '🎯').slice(0, 4)`，最多 4 个字符 |
| `createdAt` | int | `Date.now()` |
| `updatedAt` | int | `Date.now()`，每次 `update` 刷新 |

关键约定：

- **金额按「分」存整数**。目标金额、已攒金额、结余、剩余金额全部在「分」域计算，只有显示时才 `fromCents/prettyAmount`。
- **派生值不落库**。进度百分比、还差金额、还需月数都是渲染时实时计算，不写回存储，避免陈旧数据。
- **`targetDate` 只是展示性元数据**，不影响第 4 节的「按当前速度还需几个月」估算（该估算只看结余速度，不看期限）。

### 1.3 `Store.Savings` 模块 API

在 `store.js` 里新增一个模块（放在 `Stats` 之后、`global.Store = {...}` 之前），方法签名与返回值风格和现有 `Records` / `Categories` 完全一致（`{ ok: true }` 或 `{ ok: false, msg: '...' }`）：

```js
var Savings = {
  all:       function () { ... },              // 返回数组，读坏时 []
  get:       function (id) { ... },            // 返回目标对象或 null
  add:       function (data) { ... },          // data: {name, targetAmount, targetDate, icon}
  update:    function (id, patch) { ... },     // patch 可含 name/targetAmount/savedAmount/targetDate/icon
  remove:    function (id) { ... },
  estimate:  function (goal) { ... }           // 返回估算结果，见第 4 节
};
```

并挂到对外接口上：

```js
global.Store = {
  Records: Records,
  Categories: Categories,
  Stats: Stats,
  Savings: Savings,          // ← 新增这一行
  util: { ... }
};
```

### 1.4 校验规则与提示文案

与现有 `Categories.add` / `Records.add` 的拦截风格一致（返回 `{ ok:false, msg }`，界面用 `toast(msg)` 提示）：

| 场景 | 结果 |
|---|---|
| 名称为空 | `{ ok:false, msg:'请填写目标名称' }` |
| 名称超过 20 字 | `{ ok:false, msg:'目标名称请控制在 20 个字以内' }` |
| 目标金额为空 / ≤ 0 / 非法 | `{ ok:false, msg:'目标金额必须大于 0' }` |
| 已攒金额非法 / 负数 | `{ ok:false, msg:'已攒金额不能为负数' }`（允许 `0`，允许超过目标） |
| 目标日期非空但格式非法 | `{ ok:false, msg:'目标日期格式不对' }` |
| `update` / `remove` 找不到 id | `{ ok:false, msg:'目标不存在' }` |
| `writeJSON` 失败 | `{ ok:false, msg:'保存失败，手机存储可能已满' }` |

> `add` 里的 `savedAmount` 固定从 `0` 开始（新建目标不自带已攒金额）；想设初始已攒金额，创建后再用「更新已攒」即可，逻辑更简单、不易混淆。

---

## 2. 界面结构

### 2.1 入口：底部导航第 4 个标签

现有 `index.html` 的 `.tabbar` 是「记一笔 / 本月 / 设置」三个 `.tab`（`data-page` 分别为 `home / month / settings`）。**新增一个标签，插在「本月」和「设置」之间**：

```html
<button class="tab" data-page="goals" type="button">
  <span class="tab-ico">🐷</span><span>攒钱</span>
</button>
```

理由：这是与记账并列的一级功能，放中间更显眼；`data-page="goals"` 与现有 `switchPage` 机制天然兼容。

### 2.2 新页面骨架

在 `page-settings` 区块之后、`.tabbar` 之前新增一个 `section`，结构仿照「设置」页（滚动容器 + 卡片），并增加一个固定头部放「新建」入口：

```html
<section class="page page-goals" id="page-goals" hidden>
  <div class="goals-head">
    <div class="goals-title">攒钱目标</div>
    <button class="btn btn-primary goals-add" id="addGoalBtn" type="button">＋ 新建</button>
  </div>
  <div class="goals-scroll" id="goalsScroll"></div>
</section>
```

- `page-goals` 复用现有 `.page` 基类（自动获得状态栏让位 + 底部导航让位）。
- `goalsScroll` 是滚动容器，样式并入现有 `.month-scroll, .settings-scroll` 规则组。
- 无目标时 `goalsScroll` 渲染空态（复用 `.empty` / `.empty-ico`）。

### 2.3 两个弹层（复用现有 mask/sheet 体系）

在现有 `.mask` 区域（`editMask` / `dateMask` / `confirmMask` 附近）新增两个弹层，全部复用 `.mask` / `.sheet` / `.sheet-title` / `.sheet-body` / `.sheet-actions` / `.field` / `.field-label` / `.text-input` / `.btn` / `.btn-primary` / `.btn-danger` 样式，**不引入新的弹层框架**：

**(1) `goalMask` —— 创建 / 编辑目标元数据**

| 字段 | 控件 | 说明 |
|---|---|---|
| 名称 | `input type="text"`（`maxlength="20"`） | 必填 |
| 目标金额 | `input type="tel"` | 复用 `sanitizeAmount`；必填、>0 |
| 目标日期 | `input type="date"` | 可选；附「清除」按钮（设为无期限） |
| 图标 | 一排 8 个预设 emoji（点选）+ 一个手输框（`maxlength="4"`） | 可选；默认 🎯 |

预设 emoji 建议：`🚗 🏠 💻 📱 🎁 ✈️ 🏦 💍`（实现时可按需换，但必须有点选能力，不能只靠手输，否则「可选图标」形同虚设）。

**(2) `savedMask` —— 更新已攒金额**

| 字段 | 控件 | 说明 |
|---|---|---|
| 已攒金额 | `input type="tel"` | 打开时预填当前 `savedAmount`（用 `U.prettyAmount`）；确认后按「绝对值」写入 |

### 2.4 页面切换触点（`app.js`）

现有代码里有三处必须同步，否则新页面进不去：

1. `switchPage(name)` 里的页面数组 `['home', 'month', 'settings']` → 增加 `'goals'`，并加 `if (name === 'goals') renderGoals();`（`switchPage` 已内置 `dismissKeyboard()`，目标页自动受益）。
2. `state` 初始对象的 `page` 已是通用字符串，无需改；如需要，可加 `editingGoalId: null` 表示「编辑哪个目标（null = 新建）」。
3. `bindEvents()` 里给 `#addGoalBtn`、两个弹层的按钮、预设图标、日期清除等绑定事件（仿照现有 `editMask` / `addCatBtn` 的绑定方式）。

---

## 3. 交互细节

### 3.1 创建目标

1. 点「＋ 新建」→ 打开 `goalMask`（创建模式：标题「新建目标」，无「删除」按钮）。
2. 填名称、目标金额，可选填目标日期 / 图标。
3. 点「保存」→ `Savings.add(...)`。
4. 成功 → 关弹层、`renderGoals()` 重绘、`toast('已创建目标')`；失败 → `toast(res.msg)` 不关弹层。

### 3.2 更新已攒金额

1. 目标卡片上有一个「更新已攒」主按钮（蓝色）。
2. 点击 → 打开 `savedMask`，金额框预填当前已攒金额（`U.prettyAmount(savedAmount)`）。
3. 用户**把金额改成新的总额**（绝对值语义，不是「加一笔」）。
4. 点「确定」→ `Savings.update(id, { savedAmount })` → 重绘卡片 + `toast('已更新已攒金额')`。

> 明确语义：**「更新已攒金额」= 把已攒总额设为输入值**。这样最不容易歧义；「本次再存 X 元」属于便利功能，不在本契约范围，避免把交互做复杂。
> 允许设成 `0`（重置）；允许超过目标金额（此时进入「已达成」态，进度条封顶 100%）。

### 3.3 删除目标

1. 点击目标卡片（除「更新已攒」按钮外的区域）→ 打开 `goalMask`（编辑模式：标题「编辑目标」，含「删除」按钮）。
2. 点「删除」→ 复用现有 `confirmAsk(title, msg, onYes)` 二次确认：标题「删除目标「XX」？」，正文「删除后该攒钱目标会被移除，记账记录不受影响。」
3. 确认 → `Savings.remove(id)` → 关弹层、重绘 + `toast('已删除目标')`。

> 删除目标**只删目标本身**，绝不触碰任何记账记录（记账数据在 `jizhang.records.v1`，与目标完全解耦）。

### 3.4 进度展示（目标卡片）

每张目标卡片自上而下：

1. **头部**：`icon` + `name`；若设了 `targetDate`，右侧显示「目标日期 YYYY-MM-DD」。
2. **金额行**：「已攒 ¥X / 目标 ¥Y」（`U.prettyAmount`，整数不带 `.00`）。
3. **进度条**：
   - `percent = savedAmount / targetAmount * 100`
   - 进度条宽度用 `min(100, percent)`（封顶 100%，防溢出）
   - 文字显示：`savedAmount >= targetAmount` → **「已达成 🎉」**；否则显示 **「还差 ¥Z · 已完成 P%」**，其中 `Z = targetAmount - savedAmount`，`P = percent` 保留 1 位小数（P 允许超 100% 时文字照实显示、条封顶）。
4. **估算行**：`savedAmount < targetAmount` 时显示第 4 节的估算文案；已达成则不显示。

空态（无任何目标）：复用 `.empty`：

```
🎯
还没有攒钱目标
点上方「＋ 新建」创建第一个目标
```

---

## 4. 「还需几个月」估算口径

### 4.1 取数方式（复用现有 `Stats` / `Records`，不另造日期逻辑）

```
当前自然月 key  = Stats.monthKey()                          // 'YYYY-MM'
候选月          = [ shiftMonth(key,-1), shiftMonth(key,-2), shiftMonth(key,-3) ]
每月结余        = Stats.totals(Records.byMonth(month)).balance   // 收入 - 支出，单位「分」
dataMonths      = 候选月里「Records.byMonth(month).length > 0」的那些月
avgBalance      = Σ(每月结余) / dataMonths.length                // 单位「分」，可为负
```

要点：

- **用前三个「完整」自然月 M-1 / M-2 / M-3**，不把当前未结束的月份算进去（会系统性低估结余）。
- **空月（该月没有任何记录）= 无数据，不参与平均**，而不是当成「结余 0」。否则用户只有 1 个月数据时会被硬拉低到三分之一，估算失真。
- `shiftMonth` / `monthKey` 已正确处理跨年（1 月的上一月回到去年 12 月），直接复用，不要手写月份减法。
- 补记的历史记录会算进它所属的那个月，与现有「本月」统计的行为一致。

### 4.2 计算与边界处理（决策表）

令 `remaining = targetAmount - savedAmount`（分）：

| 条件 | `status` | `monthsNeeded` | 展示文案 |
|---|---|---|---|
| `remaining <= 0` | `done` | — | 「已达成 🎉」（不显示估算行） |
| `dataMonths.length === 0` | `no-data` | — | 「暂无历史结余，先记几笔再估算」 |
| `avgBalance === 0` | `zero` | — | 「近三个月月均结余为 0，暂时攒不动，先调整收支」 |
| `avgBalance < 0` | `negative` | — | 「近三个月月均结余为 -¥X，照此速度无法达成」（X = `prettyAmount(-avgBalance)`） |
| `avgBalance > 0` | `ok` | `Math.ceil(remaining / avgBalance)` | 「按当前速度还需约 N 个月」 |

补充规则：

- `status === 'ok'` 时 `monthsNeeded` 保证 **>= 1**（`remaining` 小于一个月结余时 `ceil` 也会得到 1，避免显示「0 个月」）。
- 若 `monthsNeeded` 很大，为防排版溢出可显示上限文案：`monthsNeeded >= 120` 时显示「约 10 年以上」（可选，不影响计算）。
- `avgBalance` 是「分」域整数运算后取平均，可能出现小数（如 `3333.33...`）；`monthsNeeded` 用 `Math.ceil` 向上取整，保守估计。

### 4.3 `Savings.estimate(goal)` 返回结构

```js
{
  remaining:   int,        // targetAmount - savedAmount（分，可 <=0）
  dataMonths:  ['YYYY-MM', ...], // 实际参与平均的有记录月份
  avgBalance:  number,     // 月均结余（分，可为负；无数据时为 0）
  status:      'done' | 'no-data' | 'zero' | 'negative' | 'ok',
  monthsNeeded:int         // 仅 status==='ok' 时有效，>=1
}
```

界面层只根据 `status` 选文案、`monthsNeeded` 填数字，不在 `app.js` 里重复计算口径。

---

## 5. 硬性约束（必须遵守）

1. **不使用任何外部库**：不新增 CDN / npm / `<script src="http...">`；`index.html` 末尾仍只引用本地的 `js/store.js` 和 `js/app.js`。新逻辑并入这两个文件，**不新建 JS 文件**。
2. **不联网**：目标相关代码不发起任何网络请求；数据仍存 `localStorage`（WebView 内 → App 沙箱），与现有记账数据同一持久化机制（覆盖安装保留、卸载清空）。
3. **不改变现有记账流程**：`Records` / `Categories` / `Stats` 的现有方法与存储键名一律不动；所有改动为**追加**。
4. **不改构建脚本**：`tools/build.cmd` 用 `aapt2 link -A "assets"` 整目录打包，`assets/www` 下的任何改动会自动进 APK，无需改构建；也不要改 `tools/` 其他脚本。
5. **不改 `MainActivity.java`**：WebView 已开启 `JavaScriptEnabled` + `DomStorageEnabled`，`localStorage` 可用；无需任何原生改动。
6. **金额与日期规则沿用现有约定**：金额「分」存整数、日期本地时区 `YYYY-MM-DD`、显示整数金额不带 `.00`。

---

## 6. 实现触点清单（参考当前行号，供下游定位）

| 文件 | 改动 | 参考位置 |
|---|---|---|
| `js/store.js` | 新增 `var KEY_SAVINGS = 'jizhang.savingsGoals.v1';` | 顶部现有三个 `KEY_*`（约 L10-12） |
| `js/store.js` | 新增 `Savings` 模块 | `Stats` 之后、`global.Store = {...}` 之前（约 L307-309） |
| `js/store.js` | `global.Store` 暴露 `Savings: Savings` | L309-322 |
| `index.html` | 新增 `#page-goals` section | `page-settings` 之后、`.tabbar` 之前（约 L106 后） |
| `index.html` | tabbar 新增「攒钱」`.tab`（`data-page="goals"`） | L109-119 |
| `index.html` | 新增 `#goalMask`、`#savedMask` 两个 `.mask` | `confirmMask` 之后（约 L187 后） |
| `js/app.js` | `switchPage` 页面数组加 `'goals'` + 调 `renderGoals()` | L67-81 |
| `js/app.js` | 新增 `renderGoals()`（渲染列表/空态/卡片） | 可放 `renderSettings` 附近 |
| `js/app.js` | `bindEvents()` 新增目标页与两个弹层的事件绑定 | L654-829 |
| `css/app.css` | `.goals-scroll` 并入 `.month-scroll, .settings-scroll` 规则 | L365 |
| `css/app.css` | 新增 `.goals-head`、目标卡片、进度条、图标选择等样式 | 文件末尾追加 |

> 行号是「当前读取时」的定位，实现时以实际内容为准。

---

## 7. 验收对照（本契约任务不执行，供下游实现/验收参考）

1. **数据**：创建目标后，`localStorage['jizhang.savingsGoals.v1']` 为数组，元素含 `id/name/targetAmount/savedAmount/targetDate/icon/createdAt/updatedAt`；`targetAmount`、`savedAmount` 为整数「分」（如 `100000` = ¥1000.00）。
2. **入口**：底部导航出现「攒钱」，点击能进 `#page-goals` 且其它三页不受影响。
3. **创建**：空名 / 金额 0 / 非法金额被拦截并 toast；合法创建后卡片出现。
4. **更新已攒**：输入新总额后 `savedAmount` 变为该值的分整数；允许 0、允许超目标；负数被拦截。
5. **删除**：二次确认后目标消失，且 `jizhang.records.v1` 内容不变。
6. **进度**：`savedAmount >= targetAmount` 显示「已达成」，进度条不溢出。
7. **估算边界**（用临时记录构造）：
   - 无任何历史记录 → 「暂无历史结余」
   - 月均结余 0 / 负数 → 对应文案，不显示月份
   - 月均结余正 → 显示「约 N 个月」，`N = ceil(remaining/avg)` 且 >= 1
8. **约束**：APK 内不出现新的外部脚本引用；重新 `tools\build.cmd` 后新页面随 `assets` 自动进包，安装/覆盖安装可用。
