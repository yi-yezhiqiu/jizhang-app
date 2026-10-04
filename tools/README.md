# 构建工具链说明

这个项目**不使用 Gradle**，而是直接用 Android SDK 自带的命令行工具打包。
好处是：不需要下载任何 Maven 依赖、构建只要十几秒、出错面小。

## 需要什么

| 组件 | 版本 | 说明 |
|---|---|---|
| JDK | 17 或更高（本项目用 21） | `javac` / `keytool` / `jar` 都来自它 |
| Android SDK Build-Tools | 35.0.0 | 提供 `aapt2` / `d8` / `apksigner` / `zipalign` |
| Android SDK Platform | android-35 | 提供编译期的 `android.jar` |
| Android SDK Platform-Tools | 任意近期版本 | 提供 `adb`（可选，调试用） |
| Python | 3.x | 仅构建脚本用到（`normalize_apk.py` / `copy_apk.py`） |

**不需要**：Android Studio、Gradle、Node.js、模拟器（除非你要跑模拟器预览）。

## 目录怎么摆

脚本默认按下面的位置找工具链（都可以用环境变量覆盖，见下一节）：

```
D:\android-jdk\                         ← JDK 根目录
D:\android-sdk\                         ← Android SDK 根目录
├── build-tools\35.0.0\                 aapt2 / d8 / apksigner / zipalign
├── platforms\android-35\android.jar    编译期 API
└── platform-tools\adb.exe              可选
```

> **为什么要放在这种短短的 ASCII 路径下？**
> 实测两个坑：`aapt2` 读不了含中文的绝对路径；模拟器在中文路径下会**静默退出**（不报错）。
> 所以工具链与 AVD 都放在纯 ASCII 路径，再用目录联接指向项目内的真实位置。

## 用环境变量覆盖

如果工具链在别处，构建前设这两个变量即可：

```cmd
set JZ_JDK=E:\tools\jdk21
set JZ_SDK=E:\tools\android-sdk
tools\build.cmd
```

## 构建

```cmd
tools\build.cmd
```

成功时输出：

```
 BUILD OK
 APK : <项目>\build\jizhang.apk
 COPY: <项目>\JiZhang.apk
 SIZE: NNN KB
```

## 打包流水线（以及踩过的坑）

```
aapt2 compile   编译资源
      ↓
aapt2 link      链接资源，产出未签名 APK（并生成 R.java）
      ↓
javac           编译 Java 源码
      ↓
d8              Java 字节码 -> classes.dex
      ↓
normalize_apk.py  把 APK 内条目名的反斜杠转成正斜杠   ← 少了这步界面会白屏
      ↓
zipalign        对齐（必须在签名之前）
      ↓
apksigner       签名
```

**六个必须遵守的约束**（都写在 `build.cmd` 顶部注释里，改脚本前请先读）：

1. **脚本必须纯 ASCII** —— 中文会被 `cmd.exe` 按 GBK 错解，破坏行尾续行符
2. **`aapt2` 只能传相对路径** —— 传绝对路径会报 `failed to open directory`
3. **`apksigner` 不能加引号包裹** —— 它内部是批处理
4. **`zipalign` 必须在 `apksigner` 之前** —— 顺序反了签名会失效
5. **`d8` 需要 `JAVA_HOME`**
6. **`apksigner.bat` 结尾有裸 `exit`** —— 直接调用会把构建脚本一起终止，
   而且**不报错**，只表现为"签名之后什么都没发生"

另外两条同样隐蔽：

- `aapt2 link` 需要 `--auto-add-overlay`，否则资源合并阶段报错
- 打完 dex 后必须跑 `normalize_apk.py`：`aapt2` 在 Windows 上会把资产条目名写成
  `assets\www\index.html`（反斜杠），而 Android 要求正斜杠。少了这步，
  界面会白屏并报 `net::ERR_FILE_NOT_FOUND`——文件明明在包里却找不到。

## 工具清单

### 构建必需

| 文件 | 作用 |
|---|---|
| `build.cmd` | 一键构建，串起上面整条流水线 |
| `normalize_apk.py` | 修正 APK 内条目名的路径分隔符（见上） |
| `copy_apk.py` | 把产物复制到项目根目录（`cmd` 的 `copy` 在中文路径下会静默失败） |
| `fix-avd-acl.ps1` | 修 AVD 目录写权限；模拟器起不来时用 |

### 测试与核查

| 文件 | 作用 |
|---|---|
| `test_savings_model.mjs` | 攒钱模型 + 分类排序的数据层测试（离线跑真实 `store.js`） |
| `check_save_path.mjs` | 检查保存路径有没有被改回"会收键盘/抢焦点"的写法 |
| `inspect_apk_js.mjs` | 从 APK 里抠出指定函数原文，确认改动真的进了包 |

### 调试通道

| 文件 | 作用 |
|---|---|
| `cdp_eval.mjs` | 连上 WebView 调试端口执行任意 JS（读页面真实状态） |
| `cdp_diagnose.mjs` | 一次性检查页面易出问题的几个点 |

用法见 [../使用说明.md](../使用说明.md) 的「真机上出了问题怎么查」一节。

> 为什么需要这条通道：Android WebView **不把键盘高度暴露给网页层**，
> 而且键盘收起时输入框不会失焦。只靠读代码判断很容易改错方向，
> 直接读设备上的真实状态要可靠得多。

### 文档生成

| 文件 | 作用 |
|---|---|
| `make_palettes.py` | 生成配色方案预览图（画出真实界面，比色卡直观） |

### 验证套件（`verify2_*.mjs` / `.py`）

这组脚本是开发过程中用来**独立验证**功能的，特点是**不复用实现者自己的测试**，
而是直接加载真实的 `store.js` / `app.js` 跑断言，或通过 CDP 读设备真实状态。

它们记录了"这个项目被真正验证过"，也是回归测试的基础。
