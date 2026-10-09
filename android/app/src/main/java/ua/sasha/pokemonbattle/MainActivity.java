package ua.sasha.pokemonbattle;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.TextUtils;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.lang.ref.WeakReference;
import java.util.Map;

/**
 * The whole app: a full-screen WebView showing the web version of the game
 * (GitHub Pages). The web app does the rest: its service worker keeps the game cached for offline
 * play and downloads new game versions; the page scales the board to the screen and turns a long
 * press into the game's right-click. The user agent carries "PkmnAndroid/<version>" so the page
 * knows it's inside this app (no "install" hint; offers a newer APK when version.json lists one).
 * The screen follows the phone's rotation (game 2.0.0 plays upright too) unless the player picks
 * "always portrait" or "always landscape" in the game's menu: the page then calls
 * PkmnAndroid.setOrientation("portrait" | "landscape" | "auto").
 * Notifications (1.2.0): see Push. A tapped notification opens the game at its link (home + "#go=…"); while
 * the game is on screen, new ones go to the page instead (window.pkmnPushIn) and it shows a banner.
 */
public class MainActivity extends Activity {
    private static final int REQ_FILE = 1;
    private static final int REQ_PUSH = 2;
    static final String ACTION_OPEN = "ua.sasha.pokemonbattle.OPEN";
    static final String EXTRA_LINK = "link";

    // the one activity, for the notification service (it runs on its own thread)
    private static WeakReference<MainActivity> current = new WeakReference<>(null);
    private static volatile boolean onScreen = false;

    private WebView web;
    private String home;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        home = getString(R.string.web_url);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        createWebView();
        String link = linkOf(getIntent());
        web.loadUrl(link != null ? home + link : home);
        hideSystemBars();
        current = new WeakReference<>(this);
        Push.channels(this);
        Push.fetchToken(this, MainActivity::sendToken);
    }

    /** "#go=…", "#join=…" or "#r=…" from a tapped notification; null otherwise. */
    private static String linkOf(Intent i) {
        if (i == null) return null;
        String l = i.getStringExtra(EXTRA_LINK);
        return l != null && l.startsWith("#") && l.length() < 300 ? l : null;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String link = linkOf(intent);
        if (link != null && web != null) js("location.hash=" + JSONObject.quote(link));
    }

    private void js(final String code) {
        runOnUiThread(() -> { if (web != null) web.evaluateJavascript(code, null); });
    }

    /** From the notification service: the game is open, so it shows this one itself. */
    static boolean forward(Map<String, String> d) {
        final MainActivity a = current.get();
        if (a == null || !onScreen || a.web == null) return false;
        a.js("window.pkmnPushIn&&pkmnPushIn(" + JSONObject.quote(Push.json(d)) + ")");
        return true;
    }

    static void sendToken(String token) {
        MainActivity a = current.get();
        if (a != null && token != null) a.js("window.pkmnPushToken&&pkmnPushToken(" + JSONObject.quote(token) + ")");
    }

    private void sendPermission() {
        js("window.pkmnPushPerm&&pkmnPushPerm(" + JSONObject.quote(Push.permission(this)) + ")");
    }

    private void openNotificationSettings() {
        Intent i;
        if (Build.VERSION.SDK_INT >= 26) {
            i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            i.putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
        } else {
            i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()));
        }
        try {
            startActivity(i);
        } catch (ActivityNotFoundException ignored) {
            // nothing to open
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_PUSH) {
            sendPermission();
            Push.fetchToken(this, MainActivity::sendToken);
        }
    }

    private void createWebView() {
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#070d18"));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                 // the game's saves, settings and card images
        s.setMediaPlaybackRequiresUserGesture(false); // music starts with the game, like on PC
        s.setUseWideViewPort(true);                   // honour the page's <meta viewport width=...>
        s.setLoadWithOverviewMode(true);              // ...and fit that width to the screen
        s.setTextZoom(100);                           // the phone's font size must not break the board
        s.setSupportZoom(true);                       // pinch to read a card up close
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setUserAgentString(s.getUserAgentString() + " PkmnAndroid/" + appVersion());

        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.addJavascriptInterface(new Bridge(), "PkmnAndroid");
    }

    /** What the page may ask of the app. Only our own site is ever loaded here (see isOurs). */
    private class Bridge {
        @JavascriptInterface
        public void setOrientation(final String mode) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    int o = "portrait".equals(mode) ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
                            : "landscape".equals(mode) ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                            : ActivityInfo.SCREEN_ORIENTATION_FULL_USER;
                    if (getRequestedOrientation() != o) setRequestedOrientation(o);
                }
            });
        }

        /** {ok, token, perm, enabled}: ok = this build can show notifications at all. */
        @JavascriptInterface
        public String pushInfo() {
            return Push.info(MainActivity.this);
        }

        /** Asks for the permission (Android 13+), or opens the phone's settings when only they can change it. */
        @JavascriptInterface
        public void pushAsk() {
            runOnUiThread(() -> {
                String p = Push.permission(MainActivity.this);
                if (Build.VERSION.SDK_INT >= 33 && "ask".equals(p)) {
                    Push.markAsked(MainActivity.this);
                    requestPermissions(new String[]{Push.PERM}, REQ_PUSH);
                } else if (!"granted".equals(p)) {
                    openNotificationSettings();
                } else {
                    sendPermission();
                }
            });
        }

        @JavascriptInterface
        public void pushSettings() {
            runOnUiThread(MainActivity.this::openNotificationSettings);
        }
    }

    private String appVersion() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "0";
        }
    }

    private boolean isOurs(Uri u) {
        String url = u.toString();
        String path = u.getPath();
        return url.startsWith(home) && (path == null || !path.endsWith(".apk"));
    }

    private void openOutside(Uri u) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (ActivityNotFoundException ignored) {
            // nothing on the phone can open it
        }
    }

    private void showOffline() {
        String html = "<!doctype html><html><head><meta charset='utf-8'>"
                + "<meta name='viewport' content='width=device-width,initial-scale=1'>"
                + "<style>html,body{margin:0;height:100%;background:#070d18;color:#cbd5e1;"
                + "font:16px/1.45 sans-serif;display:flex;align-items:center;justify-content:center;text-align:center}"
                + "div{max-width:460px;padding:24px}h1{color:#a78bfa;font-size:22px;margin:0 0 10px}"
                + "p{color:#94a3b8;margin:0 0 22px}button{font:600 16px sans-serif;color:#fff;border:0;"
                + "border-radius:12px;padding:12px 22px;background:linear-gradient(135deg,#7c3aed,#6d28d9)}</style>"
                + "</head><body><div><h1>" + TextUtils.htmlEncode(getString(R.string.offline_title)) + "</h1>"
                + "<p>" + TextUtils.htmlEncode(getString(R.string.offline_text)) + "</p>"
                + "<button onclick=\"location.href='" + home + "'\">"
                + TextUtils.htmlEncode(getString(R.string.offline_retry)) + "</button></div></body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            String scheme = u.getScheme();
            if (isOurs(u) || "about".equals(scheme) || "data".equals(scheme) || "blob".equals(scheme)) {
                return false;
            }
            openOutside(u); // other sites, and the APK download, go to the phone's browser
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) showOffline();
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // The page's renderer crashed or was killed for memory: start over instead of crashing.
            if (view == web) {
                ViewGroup parent = (ViewGroup) web.getParent();
                if (parent != null) parent.removeView(web);
                web.destroy();
                createWebView();
                web.loadUrl(home);
            }
            return true;
        }
    }

    private class Chrome extends WebChromeClient {
        // Having a WebChromeClient at all is what makes alert()/confirm() show up.

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            // "Upload a card picture" in the game.
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            try {
                startActivityForResult(params.createIntent(), REQ_FILE);
                return true;
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                return false;
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = w.getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            w.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        hideSystemBars();
        onScreen = true;
        current = new WeakReference<>(this);
        sendPermission();// it may have been changed in the phone's settings
    }

    @Override
    protected void onPause() {
        onScreen = false;
        if (web != null) web.onPause(); // the page hears "hidden" and pauses the music
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (current.get() == this) current = new WeakReference<>(null);
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        // One page, no history to go back through: Back leaves the game running in the background
        // (a stray Back mid-battle shouldn't end it).
        moveTaskToBack(true);
    }
}
