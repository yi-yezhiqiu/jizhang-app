package com.jizhang.app;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebSettings;
import android.webkit.WebView;

/**
 * 应用只有一个 Activity，整个界面由 assets/www 里的网页层绘制。
 *
 * 关于键盘高度（这一类问题的最终结论，改动前请先读完）：
 *
 * targetSdk 35 = Android 15 下，网页层**完全拿不到键盘高度**：
 *   · window.innerHeight 与 visualViewport.height 在键盘开合时恒定不变（实测都是 915）
 *   · 键盘弹起/收起都不改变布局视口，adjustResize 形同失效
 *   · 输入框不会因键盘收起而失焦（实测 activeElement 一直是那个 input）
 * 于是网页层既无法计算键盘高度，也无从知道键盘何时收起 —— 这正是
 * 「手动收起键盘后弹层卡在半空下不来」这类问题反复出现的根因。
 *
 * 修法：由原生层把键盘的真实高度上报给网页层。
 *   · 进入页面与每次窗口 inset 变化时，调用 window.__jzIme(h)；
 *   · 同时提供 window.__jzIme 之外的同步查询入口 __jzImeHeight()，
 *     网页层可主动轮询（用于捕捉键盘收起的那一刻）。
 * h 的单位是 CSS px（已按 density 折算），键盘收起时 h 为 0。
 */
public class MainActivity extends Activity {

    private WebView webView;
    private int imeCssHeight = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 退出 edge-to-edge：Android 15 默认全屏铺满会让输入法完全不让位
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(true);
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
        }

        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            // 配色方案 D「纸感」：系统栏跟随米白底，并让图标转为深色
            getWindow().setStatusBarColor(Color.parseColor("#faf7f2"));
            getWindow().setNavigationBarColor(Color.parseColor("#f2ede4"));
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }

        webView = new WebView(this);
        webView.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        webView.setBackgroundColor(Color.parseColor("#faf7f2"));

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // 记账数据存在这里，必须开启
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setLoadsImagesAutomatically(true);
        s.setTextZoom(100);                    // 忽略系统字体缩放，避免布局被撑坏
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        // 允许通过 adb 的 DevTools 协议检查页面（仅调试包需要）
        WebView.setWebContentsDebuggingEnabled(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            s.setSafeBrowsingEnabled(false);   // 纯本地页面，不需要联网检查
        }

        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

        // 让网页层能同步查询键盘高度（用于捕捉键盘收起那一刻）
        webView.addJavascriptInterface(new ImeBridge(), "__jzIme");

        // 键盘高度上报：insets 变化时推给网页层
        installImeReporter();

        setContentView(webView);
        webView.loadUrl("file:///android_asset/www/index.html");
    }

    /** 给网页层用的同步查询接口。 */
    private class ImeBridge {
        @JavascriptInterface
        public int height() {
            return imeCssHeight;
        }
    }

    /** 折算成 CSS px。 */
    private int pxToCss(int px) {
        float d = getResources().getDisplayMetrics().density;
        if (d <= 0f) return px;
        return Math.round(px / d);
    }

    /**
     * 监听窗口 insets，把输入法高度推给网页层。
     * 用 OnApplyWindowInsetsListener 而不是重写 onApplyWindowInsets：
     * 前者在 WebView 上更可靠，且同样能收到 IME 的显示/隐藏变化。
     */
    private void installImeReporter() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            webView.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
                @Override
                public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                    int px = insets.getInsets(WindowInsets.Type.ime()).bottom;
                    // 某些窗口配置下 IME insets 会是 0，此时用可见显示区兜底
                    if (px <= 0) px = computeImePxLegacy();
                    pushImeCss(pxToCss(px));
                    return v.onApplyWindowInsets(insets);
                }
            });
        } else {
            // API 21–29：用可见显示区推算
            webView.getViewTreeObserver().addOnGlobalLayoutListener(
                new android.view.ViewTreeObserver.OnGlobalLayoutListener() {
                    @Override
                    public void onGlobalLayout() {
                        pushImeCss(pxToCss(computeImePxLegacy()));
                    }
                });
        }
    }

    /** 旧 API 的兜底：屏幕高度 − 可见区域底边。 */
    private int computeImePxLegacy() {
        Rect visible = new Rect();
        getWindow().getDecorView().getWindowVisibleDisplayFrame(visible);
        int screenH = getWindow().getDecorView().getRootView().getHeight();
        int diff = screenH - visible.bottom;
        return diff > 0 ? diff : 0;
    }

    /**
     * 把键盘高度（CSS px）推给网页层。
     * 只在数值真的变化时才注入，避免无谓的 JS 执行。
     */
    private void pushImeCss(int css) {
        if (css < 0) css = 0;
        if (css == imeCssHeight) return;
        imeCssHeight = css;
        if (webView == null) return;
        final String js = "(function(){try{if(window.__jzImeUpdate)window.__jzImeUpdate("
                + css + ");}catch(e){}})()";
        webView.post(new Runnable() {
            @Override
            public void run() {
                if (webView != null) webView.evaluateJavascript(js, null);
            }
        });
    }

    @Override
    public void onBackPressed() {
        // 交给网页层决定：弹层打开时先关弹层，否则再退出
        if (webView != null) {
            // 用匿名类而非 lambda：d8 在不带脱糖配置时编不过 lambda
            webView.evaluateJavascript(
                "(function(){try{return window.__handleBack?window.__handleBack():false}catch(e){return false}})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if (!"true".equals(value)) {
                            finish();
                        }
                    }
                });
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
