# 任务1 根因记录（模拟器 + CDP 实测，供任务3 复用）

## 复现环境
- 模拟器：AVD `jizhang_test`（android-35 google_apis x86_64，1080x2400 @420dpi → CSS 视口 412x915，dpr 2.625）
- 已安装的 APK 与当前源码一致（build/jizhang.apk 18:00:33 >= app.js 17:14:06）
- CDP：`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`

## 实测数据（键盘弹起时，通过 `input tap` 真实触摸）
1. `dumpsys input_method` → `mInputShown=true`（软键盘确实在）
2. `window.innerHeight = 915`，`visualViewport.height = 915.05`，`visualViewport.offsetTop = 0`
   → **键盘弹起时布局视口完全没有变化**（MainActivity 里的 ADJUST_RESIZE + setDecorFitsSystemWindows(true)
     在这台 Android 15 + WebView 124 上并没有真正压缩 WebView 高度）
3. `savedMask` 打开时（键盘已弹起）：
   - `.sheet` 位置 = CSS y 672 → 915
   - `#savedAmountInput` = y 767 → 807
   - `#savedOk`（确定）= y 855 → 899
   - 键盘上沿 ≈ CSS y 491（由截图换算：物理 1290 / 2.625）
   → 整张 sheet 都落在键盘下面，输入框与「确定」都不可见。
4. 真实触摸「确定」按钮中心（物理 796,2301）→ `Store.Savings.all()[0].savedAmount` 仍为 0，
   mask 仍未关闭：**点不到**（那一下打在键盘上）。
5. 键盘弹起时手输的金额是进得去的：`input text "500"` → `#savedAmountInput.value === "0500"`。
6. 用户唯一能碰到的区域是键盘上方的遮罩背景；真实触摸 (540,1500) 后：
   `savedMask.hidden === true`、`savedAmount` 仍为 0 → **弹层被关掉、输入的值被丢弃**。

## 根因（结论）
`.mask { position: fixed; inset: 0 }` + `.sheet` 底部对齐，是相对**未变化的布局视口**排版的；
键盘只是覆盖在底部 ~46% 上（不是压缩视口）。所以底部对齐的 sheet 会整体钻到键盘下面：
输入框与底部按钮都在键盘背后。用户能输入数字但无法提交，一碰可点区域（遮罩背景）
就把弹层关掉、输入丢失 —— 这正是「攒钱目标设置完无法更新已攒金额」。

不是「被推出可视区」的滚动问题（`.sheet` 的 max-height/overflow 在这个短弹层上根本没触发），
所以不要往 scrollIntoView / adjustPan 方向改。

## 修法（已实施）
1. 键盘判定用**焦点信号**（实测视口数值不可靠，与首页键盘适配的结论一致）：
   弹层内 INPUT/TEXTAREA/SELECT 聚焦 → `body.sheet-kb-open`；失焦 → 移除。
2. CSS：`body.sheet-kb-open .mask { align-items: flex-start }` +
   `body.sheet-kb-open .sheet { max-height: var(--sheet-guard, calc(48vh - 16px)) }`，
   把整张 sheet 抬到键盘上方（48vh 与首页 `bottom: 52%` 的保守预留一致）。
   若 `visualViewport` 真的报告了键盘高度，JS 会把 `--sheet-guard` 设成精确值
   `innerHeight - kb - 16`（同样是双保险）。
3. `.sheet` 改成 flex 纵向布局：`.sheet-body` 内部滚动、`.sheet-actions` 固定不滚
   —— 保证任何弹层在受限高度下「确定/保存」都还在屏幕上。
4. 底部操作行 `.sheet-actions` 从全局「点空白收键盘」里豁免（与 `#saveBtn` 同样处理），
   避免按下「确定」的那一刻输入框先失焦、键盘态解除、sheet 落回去导致这一下点空。
5. 关闭弹层统一走 `hideMask()`：先 blur 弹层内输入框再隐藏，键盘不会挂在页面上。
