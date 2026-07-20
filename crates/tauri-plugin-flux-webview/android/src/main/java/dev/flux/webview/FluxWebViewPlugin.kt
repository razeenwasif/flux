package dev.flux.webview

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.util.Base64
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
import java.io.ByteArrayOutputStream

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

    /** A downscaled JPEG data-URL snapshot of a WebView, for the tab switcher's
     *  cover thumbnails. Best-effort — returns null if the view isn't drawable. */
    private fun captureThumb(wv: WebView): String? {
        return try {
            val w = wv.width
            val h = wv.height
            if (w <= 0 || h <= 0) return null
            val scale = 0.5f
            val bmp = Bitmap.createBitmap((w * scale).toInt(), (h * scale).toInt(), Bitmap.Config.RGB_565)
            val canvas = Canvas(bmp)
            canvas.scale(scale, scale)
            wv.draw(canvas)
            val out = ByteArrayOutputStream()
            bmp.compress(Bitmap.CompressFormat.JPEG, 55, out)
            bmp.recycle()
            "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        } catch (_: Throwable) {
            null
        }
    }

    private fun emitThumb(id: Int, wv: WebView) {
        val data = captureThumb(wv) ?: return
        val o = JSObject()
        o.put("id", id)
        o.put("data", data)
        trigger("thumb", o)
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
                // Snapshot once it's had a moment to paint, for the tab switcher.
                view.postDelayed({ emitThumb(id, view) }, 450)
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
        activity.runOnUiThread {
            views[a.id]?.let { wv ->
                emitThumb(a.id, wv) // snapshot while still drawn, before hiding
                wv.visibility = WebView.GONE
            }
        }
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
