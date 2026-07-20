package dev.flux.webview

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Bitmap
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import java.io.ByteArrayInputStream
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class OpenArgs {
    var id: Int = 0
    var url: String = "about:blank"
    var x: Double = 0.0
    var y: Double = 0.0
    var width: Double = 0.0
    var height: Double = 0.0
}

@InvokeArg
class BoundsArgs {
    var id: Int = 0
    var x: Double = 0.0
    var y: Double = 0.0
    var width: Double = 0.0
    var height: Double = 0.0
}

@InvokeArg
class IdArgs {
    var id: Int = 0
}

@InvokeArg
class NavArgs {
    var id: Int = 0
    var url: String = "about:blank"
}

/**
 * A stack of native WebViews, one per Flux browser tab, layered over the Tauri
 * shell WebView in a full-screen FrameLayout overlay (added to android.R.id.content).
 * Bounds arrive as logical (CSS) pixels from the frontend's getBoundingClientRect;
 * we scale by display density to place the view. All view mutations run on the UI
 * thread. Milestone-1 scope: render + position + basic navigation; shields and DOM
 * capture come later (ADR 0012).
 */
@TauriPlugin
class FluxWebViewPlugin(private val activity: Activity) : Plugin(activity) {
    companion object {
        init {
            // The JNI symbol lives in the app's main Rust lib (libflux_core.so),
            // already loaded by the app — this just guards a standalone load.
            try {
                System.loadLibrary("flux_core")
            } catch (_: Throwable) {
            }
        }

        /** Rust `ShieldsState::should_block` — see crates/flux-core/src/android_jni.rs. */
        @JvmStatic
        external fun nativeShouldBlock(url: String, source: String, type: String): Boolean

        /** Returns the page's absolute cover-image URL (og:image / twitter:image /
         *  apple-touch-icon), or "" — used for tab-switcher thumbnails. */
        private const val OG_IMAGE_JS =
            "(function(){var m=document.querySelector('meta[property=\"og:image\"]')" +
                "||document.querySelector('meta[name=\"twitter:image\"]')" +
                "||document.querySelector('meta[name=\"twitter:image:src\"]')" +
                "||document.querySelector('link[rel=\"apple-touch-icon\"]');" +
                "var v=m&&(m.content||m.href);if(!v)return '';" +
                "try{return new URL(v,location.href).href;}catch(e){return '';}})()"
    }

    private val views = HashMap<Int, WebView>()
    private var container: FrameLayout? = null
    // The active (visible) tab's WebView — the one the Android back gesture drives.
    private var current: WebView? = null
    private var backRegistered = false

    private fun density(): Float = activity.resources.displayMetrics.density

    private fun ensureContainer(): FrameLayout {
        container?.let { return it }
        val root = activity.findViewById<ViewGroup>(android.R.id.content)
        val fl = FrameLayout(activity)
        root.addView(
            fl,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )
        container = fl
        registerBack()
        return fl
    }

    /** Route the Android back gesture: go back in the visible page if it can;
     *  else if the page is hidden (a shell overlay is up) ask the shell to close
     *  it; else fall through to the default (leave the app). */
    private fun registerBack() {
        if (backRegistered) return
        val owner = activity as? ComponentActivity ?: return
        owner.onBackPressedDispatcher.addCallback(
            owner,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    val wv = current
                    when {
                        wv != null && wv.visibility == View.VISIBLE && wv.canGoBack() -> wv.goBack()
                        wv != null && wv.visibility != View.VISIBLE -> trigger("back", JSObject())
                        else -> {
                            isEnabled = false
                            owner.onBackPressedDispatcher.onBackPressed()
                            isEnabled = true
                        }
                    }
                }
            }
        )
        backRegistered = true
    }

    private fun lp(x: Double, y: Double, w: Double, h: Double): FrameLayout.LayoutParams {
        val d = density()
        val p = FrameLayout.LayoutParams((w * d).toInt(), (h * d).toInt())
        p.leftMargin = (x * d).toInt()
        p.topMargin = (y * d).toInt()
        return p
    }

    /** Extract the page's cover image (og:image / twitter:image / apple-touch-icon),
     *  resolved to an absolute URL, as the tab-switcher thumbnail. Bitmap snapshots
     *  of a hardware-accelerated WebView render blank, so we use the site's own
     *  share image instead — reliable and a tiny payload (a URL, not a bitmap). */
    private fun emitThumb(id: Int, wv: WebView) {
        wv.evaluateJavascript(OG_IMAGE_JS) { result ->
            val img = result
                ?.trim('"')
                ?.replace("\\/", "/")
                ?.takeIf { it.isNotEmpty() && it != "null" }
            if (img != null) {
                val o = JSObject()
                o.put("id", id)
                o.put("data", img)
                trigger("thumb", o)
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun makeWebView(id: Int): WebView {
        val wv = WebView(activity)
        wv.settings.javaScriptEnabled = true
        wv.settings.domStorageEnabled = true
        wv.settings.databaseEnabled = true
        wv.settings.useWideViewPort = true
        wv.settings.loadWithOverviewMode = true
        wv.settings.mediaPlaybackRequiresUserGesture = false
        fun emitNav(view: WebView, url: String?) {
            val data = JSObject()
            data.put("id", id)
            data.put("url", url ?: view.url ?: "")
            data.put("title", view.title ?: "")
            data.put("canGoBack", view.canGoBack())
            data.put("canGoForward", view.canGoForward())
            trigger("nav", data)
        }
        // Keep navigation inside this WebView (don't hand links to an external app).
        wv.webViewClient = object : WebViewClient() {
            // The page URL as the source for Shields' allowlist + first/third-party
            // rules. Tracked here because view.url can only be read on the UI thread,
            // but shouldInterceptRequest runs on a background thread.
            @Volatile
            var pageUrl: String = ""

            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean = false
            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                pageUrl = url ?: ""
                emitNav(view, url)
            }
            override fun onPageFinished(view: WebView, url: String?) {
                emitNav(view, url)
                emitThumb(id, view) // extract the page's cover image for the switcher
            }

            // Shields (ADR 0012, M3): ask Rust (ShieldsState::should_block, same as
            // desktop) per request; block by returning an empty response. should_block
            // applies the global toggle + per-site allowlist, so we call every time.
            override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse? {
                return try {
                    val u = req.url?.toString() ?: return null
                    if (!(u.startsWith("http://") || u.startsWith("https://"))) return null
                    val type = if (req.isForMainFrame) "document" else "other"
                    if (nativeShouldBlock(u, pageUrl, type)) {
                        WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
                    } else {
                        null
                    }
                } catch (_: Throwable) {
                    null // never let a blocker error break page loads
                }
            }
        }
        // Title lands after the page starts — push it as soon as it's known.
        wv.webChromeClient = object : WebChromeClient() {
            override fun onReceivedTitle(view: WebView, title: String?) = emitNav(view, view.url)
        }
        return wv
    }

    @Command
    fun open(invoke: Invoke) {
        val a = invoke.parseArgs(OpenArgs::class.java)
        activity.runOnUiThread {
            val c = ensureContainer()
            var wv = views[a.id]
            if (wv == null) {
                wv = makeWebView(a.id)
                views[a.id] = wv
                c.addView(wv, lp(a.x, a.y, a.width, a.height))
            } else {
                wv.layoutParams = lp(a.x, a.y, a.width, a.height)
            }
            wv.visibility = WebView.VISIBLE
            wv.bringToFront()
            wv.loadUrl(a.url)
            current = wv
        }
        invoke.resolve(JSObject())
    }

    @Command
    fun setBounds(invoke: Invoke) {
        val a = invoke.parseArgs(BoundsArgs::class.java)
        activity.runOnUiThread {
            views[a.id]?.let {
                it.layoutParams = lp(a.x, a.y, a.width, a.height)
                it.requestLayout()
            }
        }
        invoke.resolve(JSObject())
    }

    @Command
    fun show(invoke: Invoke) {
        val a = invoke.parseArgs(IdArgs::class.java)
        activity.runOnUiThread {
            views[a.id]?.let {
                it.visibility = WebView.VISIBLE
                it.bringToFront()
                current = it
            }
        }
        invoke.resolve(JSObject())
    }

    @Command
    fun hide(invoke: Invoke) {
        val a = invoke.parseArgs(IdArgs::class.java)
        activity.runOnUiThread { views[a.id]?.visibility = WebView.GONE }
        invoke.resolve(JSObject())
    }

    @Command
    fun close(invoke: Invoke) {
        val a = invoke.parseArgs(IdArgs::class.java)
        activity.runOnUiThread {
            views.remove(a.id)?.let { wv ->
                if (current === wv) current = null
                (wv.parent as? ViewGroup)?.removeView(wv)
                wv.destroy()
            }
        }
        invoke.resolve(JSObject())
    }

    @Command
    fun navigate(invoke: Invoke) {
        val a = invoke.parseArgs(NavArgs::class.java)
        activity.runOnUiThread { views[a.id]?.loadUrl(a.url) }
        invoke.resolve(JSObject())
    }

    @Command
    fun goBack(invoke: Invoke) {
        val a = invoke.parseArgs(IdArgs::class.java)
        activity.runOnUiThread { views[a.id]?.let { if (it.canGoBack()) it.goBack() } }
        invoke.resolve(JSObject())
    }

    @Command
    fun goForward(invoke: Invoke) {
        val a = invoke.parseArgs(IdArgs::class.java)
        activity.runOnUiThread { views[a.id]?.let { if (it.canGoForward()) it.goForward() } }
        invoke.resolve(JSObject())
    }

    @Command
    fun reload(invoke: Invoke) {
        val a = invoke.parseArgs(IdArgs::class.java)
        activity.runOnUiThread { views[a.id]?.reload() }
        invoke.resolve(JSObject())
    }
}
