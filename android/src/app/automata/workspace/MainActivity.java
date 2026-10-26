package app.automata.workspace;

import android.app.Activity;
import android.os.Bundle;
import android.os.Build;
import android.graphics.Color;
import android.view.View;
import android.view.WindowInsets;
import android.widget.FrameLayout;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import java.io.ByteArrayInputStream;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends Activity {
    private WebView web;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(244,243,239));
        getWindow().setNavigationBarColor(Color.rgb(255,254,250));
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(244,243,239));
        web = new WebView(this);
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);
        web.setBackgroundColor(Color.rgb(244,243,239));
        root.addView(web, new FrameLayout.LayoutParams(-1,-1));
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        setContentView(root);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportMultipleWindows(false);
        // The packaged UI has a fixed synthetic HTTPS origin; LAN hosts may use HTTP.
        // No remote HTML, scripts or Java bridges are loaded into the WebView.
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !"automata.local".equals(request.getUrl().getHost());
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (!"automata.local".equals(request.getUrl().getHost())) return null;
                String file = request.getUrl().getPath();
                if (file == null || file.equals("/")) file = "/index.html";
                if (file.contains("..") || !file.matches("/[a-zA-Z0-9._-]+")) return missing();
                String type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".svg") ? "image/svg+xml" : file.endsWith(".png") ? "image/png" : file.endsWith(".woff2") ? "font/woff2" : "text/html";
                try {
                    Map<String,String> headers = new HashMap<>();
                    headers.put("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src http: https:; object-src 'none'; base-uri 'none'");
                    return new WebResourceResponse(type, "UTF-8", 200, "OK", headers, getAssets().open(file.substring(1)));
                } catch (Exception e) { return missing(); }
            }
            private WebResourceResponse missing() {
                return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", null, new ByteArrayInputStream(new byte[0]));
            }
        });
        web.loadUrl("https://automata.local/index.html");
    }
    @Override public void onBackPressed() {
        web.evaluateJavascript("document.querySelector('dialog[open]') !== null", value -> {
            if ("true".equals(value)) web.evaluateJavascript("document.querySelector('dialog[open]').close()", null);
            else if (web.canGoBack()) web.goBack();
            else super.onBackPressed();
        });
    }
    @Override protected void onDestroy() { web.destroy(); super.onDestroy(); }
}
