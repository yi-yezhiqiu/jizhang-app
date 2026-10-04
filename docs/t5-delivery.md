# t5 交付说明：修攒钱更新 bug + 分类排序 + 攒钱进出单笔模型

> 交付物：`build/jizhang.apk`（`tools\build.cmd` 退出码 0；根目录副本 `JiZhang.apk` 同 hash）
> 最终构建 SHA256：**796FB998068ED7C9E20562184EA873D5CFE3D5E80A39E09B861DFBD1147BD422**
> 改动文件：`app/src/main/assets/www/{index.html, css/app.css, js/store.js, js/app.js}`
> 新增文件：`docs/bug-savings-update-root-cause.md`（任务1 根因记录）、`tools/test_savings_model.mjs`（数据层测试）、本文档
> `tools/build.cmd` 内部逻辑未改。

## 0. 最终状态与验证边界（重要，先看这段）

| 版本 | SHA256 | 说明 |
|---|---|---|
| 中间版 | `F3DFE7DF…FD1B` | **全部模拟器实测结论都跑在这个版本上**（任务1/2/3 全流程真实触摸 + CDP） |
| 最终版 | `796FB998…D422` | 与中间版只差 `css/app.css` 一条规则：`body.sheet-kb-open .toast { bottom: calc(52% + 12px) }` |

- 最终版与源码同源：APK 内 `assets/www` 四个文件与当前源码逐字节一致（由 verify2 独立比对确认）。
- 那条 toast 规则**没有**由我做真实触摸实测（我准备做时设备已交给 verify2，App 未运行、CDP 不可用）。它只改了 toast 的定位，不影响功能与数据；**已请 verify2 在最终版全流程核验里覆盖**（键盘弹起时校验失败的提示应出现在键盘上方而不是被键盘挡住）。
- 除这条规则外，下文所有"实测返回值"都是中间版上跑出来的，两次构建之间 JS/HTML/数据层零差异。

---

## 1. 任务1：攒钱「已攒金额」更新不了的 bug

### 1.1 复现（模拟器 AVD `jizhang_test`，1080x2400 @420dpi → CSS 视口 412x915，dpr 2.625）

| 步骤 | 真实测量结果 |
|---|---|
| 点「更新已攒」打开弹层，真实触摸金额框 | `dumpsys input_method` → `mInputShown=true`（数字键盘弹起） |
| 键盘弹起后的视口 | `innerHeight = 915`、`visualViewport.height = 915.05`、`offsetTop = 0` —— **布局视口完全没变**（MainActivity 的 `ADJUST_RESIZE + setDecorFitsSystemWindows(true)` 在本机不生效） |
| 弹层位置 | `.sheet` = CSS y 672→915；`#savedAmountInput` = 767→807；`#savedOk`（确定）= 855→899；键盘上沿 ≈ CSS 491（截图换算 1290/2.625） |
| 键盘弹起时打字 | 进得去：`input text "500"` → 输入框值 `"0500"` |
| 真实触摸「确定」按钮中心（物理 796,2301） | `savedAmount` 仍为 0、弹层没关 → **点不到**（那一下打在键盘上） |
| 真实触摸键盘上方"能碰到"的遮罩背景（540,1500） | `savedMask.hidden = true`、`savedAmount` 仍为 0 → **弹层被关掉、输入的值被丢弃** |

### 1.2 根因（已证实，不是猜测）

`.mask{position:fixed;inset:0}` + `.sheet` 底部对齐是相对**未变化的布局视口**排版的；键盘只是盖在底部约 46% 上，
于是底部对齐的 sheet 整张钻到键盘下面：输入框与「确定」按钮都在键盘背后。用户能打字但无法提交，
唯一能碰到的区域（遮罩背景）还会把弹层关掉、输入作废 —— 这正是「攒钱目标设置完无法更新已攒金额」。

**不是**「被推出可视区」的滚动问题（这个短弹层根本没触发 max-height/overflow），所以不要往 `scrollIntoView`/`adjustPan` 方向改。

### 1.3 修法（供任务3 复用，细节见 `docs/bug-savings-update-root-cause.md`）

1. 键盘判定改用**焦点信号**（本机视口数值不可用）：弹层内 `INPUT/TEXTAREA/SELECT` 聚焦 → `body.sheet-kb-open`。
2. CSS 把整张 sheet 抬到键盘之上：`align-items:flex-start` + `max-height: var(--sheet-guard, calc(48vh - 16px))`；若 `visualViewport` 真报告了键盘高度，JS 用 `innerHeight - kb - 16` 给精确值（双保险）。
3. `.sheet` 改为纵向 flex：**.sheet-body 内部滚动、.sheet-actions 固定不滚**，受限高度下「确定/保存」永远在屏幕上。
4. `.sheet-actions` 从全局「点空白收键盘」里豁免（与 `#saveBtn` 同思路），否则按下「确定」的瞬间输入框先失焦、sheet 落回去，这一下点击就丢了。
5. 焦点只要还在同一个弹层里（例如落到「确定」按钮上）就**保持**键盘态 —— 否则弹层会在一次触摸中间下落、click 重新命中测试时落空（实测踩过）。
6. 关闭弹层统一走 `hideMask()`：先 blur 再隐藏，键盘不会挂在页面上。
7. 遮罩关闭要求 `touchstart` 与 `click` **都**落在遮罩上（第2条的抬升会在触摸中途改变布局，一次正常的"点输入框"会被重新命中到遮罩上，把弹层关掉）。

### 1.4 修后实测（真实触摸 + CDP）

```
mInputShown = true
body.className = "sheet-kb-open"
#savedAmountInput  y = 103..143     （键盘上沿 491）
#savedOk           y = 191..235     两点命中测试都返回自身
一次触摸「确定」 → toast「已存入 ¥500」，记录数 3→3(+1)，弹层关闭，无重复记账
```

## 2. 任务2：设置页分类排序

- 每个分类（**含预置**）后面两个 `▲ / ▼` 小按钮，复用 `.cat-chip` 视觉，只用 `click`（分类项上**没有** touchstart）。
- 到顶/到底 disabled：实测第一项 `▲`=`-1#disabled`、上一组最后一项 `▼`=`1#disabled`；9 个支出分类共 18 个按钮。
- 点「餐饮」的 `▼`（真实触摸）后实测：

```
byType('expense') = c_traffic, c_food, c_shop, c_home, c_fun, c_med, c_social, c_daily, c_other
localStorage 数组 = c_traffic, c_food, c_shop …        （落库顺序一致）
首页分类条     = c_traffic, c_food, c_shop …            （流水/记账顺序跟着变）
toast = 已下移；新首位 ▲ 变 disabled
```

- 其余实测：builtin 可移动（`c_salary` 下移成功，`from:9 → to:10`）；跨 type 被拦（支出组最后一个再下移 → `已经是最后一个了`）；到顶 → `已经是第一个了`；不存在 → `分类不存在`。
- 后添加的自定义支出分类在数组里排在收入之后，仍能"组内相邻"上移（只跳过其它 type），已写进离线测试。

## 3. 任务3：攒钱改为进出单笔模型

**(a) 目标对象** 实测落库：`{"id":"g_…","name":"换新手机","targetAmount":200000,"targetDate":null,"icon":"🎯","createdAt":…,"updatedAt":…}` —— 无 `savedAmount`；老目标上残留的该字段不再被读取（离线测试覆盖）。

**(b) 记录新增可选字段**

```
存入记录：{"id":"r_…","amount":50000,"type":"expense","categoryId":null,"date":"2026-10-03","note":"","goalId":"g_…","savingsKind":"in","createdAt":…}
取出记录：{"id":"r_…","amount":20000,"type":"income", "categoryId":null,"date":"2026-10-03","note":"","goalId":"g_…","savingsKind":"out","createdAt":…}
```

存量记录没有这两个字段 → 按 null 处理（离线测试注入老数据：读取不报错、不计入攒钱、统计口径不变）。
`goalId` 非空但 `savingsKind` 缺失/未知的记录按「存入」计入（口径写在 `store.js` 注释里）。

**(c) 存入 / 取出** 目标卡片按钮实测渲染为 `存入` / `取出`（已攒为 0 时 `取出` disabled）。
弹层标题/标签/提示随方向切换：`存入金额`+`本次存入（元）`+「输入本次要存入的金额…」/ `取出金额`+`本次取出（元）`+「最多可取 ¥500」。
输入框每次打开都是空的（本次金额语义）。金额必须 >0：空金额 → toast「存入金额必须大于 0」且不入库。
超额取出实测：toast「取出金额不能超过当前已攒 ¥500，最多可取 ¥500」，记录数不变（3），弹层保持打开可改数字。

**(d) 已攒自动汇总** `Store.Savings.savedAmount(goalId)` / `savedTotal()`；实测 存500→已攒 ¥500、再取200→已攒 ¥300、卡片文案「已攒 ¥300 / 目标 ¥2000」、进度 15.0%。
`estimate().remaining` 改用自动值（离线测试：0/250/100 存入取出后 remaining 依次 100000/75000/85000；存满 `status='done'`；取回 0.01 元又回到未达成）。

**(e) 不计入统计（硬要求）** 有 1 笔存入 + 1 笔取出时实测：
`Stats.totals(本月)` = 支出 100 / 收入 3000 / 结余 2900（与没有攒钱记录时完全相同）；`byCategory('expense')` 只含餐饮 100；`dailyExpense` 合计 100。离线测试 40 项全绿（`node tools/test_savings_model.mjs` → `PASS 40 / FAIL 0`，exit 0）。

**(f) 流水显示** 实测 DOM：

```
🏦 攒钱 / 换新手机 / -500  (rec-amt expense)
📤 攒钱 / 换新手机 / +200  (rec-amt income)
🍜 餐饮 / 午饭   / -100
💰 工资 / 工资   / +3000
```

（当日小计只算真实收支：`-100 +3000`。）

**(g) 可支配** 汇总条 4 列实测：`2026年10月支出 100 / 2026年10月收入 3000 / 结余 2900 / 可支配 2600`
（余额 2900 − 已攒 300）；再存入 5000（已攒 5300）后显示 **-2400**，负数不截断。

## 4. 取舍与需要知晓的实现决定

1. **汇总条 4 列布局**：`.summary-bar` 改成 `display:grid; grid-template-columns: repeat(4, minmax(0,1fr))`；标签沿用带年月的「2026年10月支出/收入」+「结余/可支配」，数值过长时靠既有的 ellipsis 兜底。`@media (max-width:360px)` 退回两行两列，避免窄屏挤压。
2. **「取出」在已攒为 0 时禁用**；卡片上整块 `.goal-actions` 不吃卡片点击，所以点禁用按钮不会误开编辑弹层。
3. **超出规格的统计一致性**：除硬要求的 `Stats.totals`/`byCategory`，`Stats.dailyExpense`（每日支出柱状图）与「本月」页的「共 N 笔记录（未含攒钱进出）」也排除了攒钱记录，否则会出现"总额不含攒钱、图表却含"的自相矛盾。`Savings.estimate` 的 `dataMonths` 也只统计真实收支（某月只有攒钱记录不算"有数据月"，否则会把月均结余硬拉低）。
4. **`.sheet` 改纵向 flex**：`.sheet-body` 滚动、`.sheet-actions` 常驻，所有弹层在受限高度下按钮都可见。
5. **设置页「数据」卡片** 多了一行「其中攒钱记录 N 笔，当前已攒 ¥X」，解释为什么累计收支与记录总数对不上。
6. **首页键盘态的 toast 未动**：`body.kb-open`（首页记账区键盘弹起）时 toast 仍定位在屏幕底部、可能被键盘挡住（例如「已保存」）。这属于既有行为、不在本任务范围，我没改，仅在此记录，供后续决定。
7. 流水里点一条攒钱记录仍会打开原来的「编辑记录」弹层（可改金额/日期/备注，`goalId`/`savingsKind` 不会被 `Records.update` 改掉，所以它始终还是攒钱记录）。没有为攒钱记录单独做编辑入口——规格没要求，保持最小改动。
8. **观察（非本改动引入）**：测试中一次 `adb install -r` 覆盖安装 + `am force-stop` 之后，WebView 里刚写入的 `localStorage` 键丢失（同期 categories 键还在）。与本次改动无关（当时 App 只是被替换/强杀），但如果后续有人依赖"写完立刻杀进程也不丢数据"，值得单独排查。

## 5. 复现命令

```bat
tools\build.cmd                                  :: 退出码 0，产出 build\jizhang.apk
node tools\test_savings_model.mjs                :: PASS 40 / FAIL 0 （离线跑真实 store.js）
node tools\cdp_eval.mjs "<表达式>"               :: 需先 adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
```
