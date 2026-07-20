package dev.flux.webview

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.view.PixelCopy
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

        /** logcat tag — `adb logcat -s FluxWebView` to trace snapshot capture. */
        private const val TAG = "FluxWebView"

        /** Target width (px) of a tab-switcher cover snapshot. The cards are only
         *  ~160px wide, so this keeps the cached base64 small. */
        private const val THUMB_WIDTH = 200

        /** Returns the page's absolute cover-image URL (og:image / twitter:image /
         *  apple-touch-icon), or "" — used as the fallback cover. */
        private const val OG_IMAGE_JS =
            "(function(){var m=document.querySelector('meta[property=\"og:image\"]')" +
                "||document.querySelector('meta[name=\"twitter:image\"]')" +
                "||document.querySelector('meta[name=\"twitter:image:src\"]')" +
                "||document.querySelector('link[rel=\"apple-touch-icon\"]');" +
                "var v=m&&(m.content||m.href);if(!v)return '';" +
                "try{return new URL(v,location.href).href;}catch(e){return '';}})()"
    }

    private val views = HashMap<Int, WebView>()
    /** Latest cover snapshot (base64 data URL) per tab. Cached here rather than
     *  pushed over the plugin event channel — small nav events ride that fine, but
     *  ~20KB images don't arrive. The shell pulls these via the `thumbnail` command
     *  over the normal IPC, which handles large payloads.
     *
     *  MUST be concurrent: captures are written on the UI thread (postDelayed /
     *  PixelCopy callback) while the `thumbnail` command reads on a plugin worker
     *  thread. A plain HashMap gives no visibility guarantee across those threads,
     *  so the reader saw an empty map. */
    private val thumbs = java.util.concurrent.ConcurrentHashMap<Int, String>()
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

    /** Snapshot a tab for the switcher's cover image.
     *
     *  Uses PixelCopy against the window surface: `View.draw()` renders blank for a
     *  hardware-accelerated WebView, but PixelCopy reads the actual composited
     *  surface. Only works while the view is on-screen, so we call it after a page
     *  loads and when a tab is shown. Falls back to the page's og:image if the copy
     *  fails. PixelCopy scales the source rect into the (smaller) destination bitmap,
     *  so the thumbnail is downscaled for free and the payload stays small.
     */
    private fun captureThumb(id: Int, wv: WebView) {
        try {
            val w = wv.width
            val h = wv.height
            Log.d(TAG, "capture id=$id w=$w h=$h vis=${wv.visibility}")
            if (w <= 0 || h <= 0 || wv.visibility != View.VISIBLE) return captureOgImage(id, wv)
            val loc = IntArray(2)
            wv.getLocationInWindow(loc)
            val src = Rect(loc[0], loc[1], loc[0] + w, loc[1] + h)
            val scale = (THUMB_WIDTH.toFloat() / w).coerceAtMost(1f)
            val tw = (w * scale).toInt().coerceAtLeast(1)
            val th = (h * scale).toInt().coerceAtLeast(1)
            val bmp = Bitmap.createBitmap(tw, th, Bitmap.Config.ARGB_8888)
            PixelCopy.request(
                activity.window,
                src,
                bmp,
                { result ->
                    Log.d(TAG, "pixelCopy id=$id result=$result")
                    if (result == PixelCopy.SUCCESS) {
                        encode(bmp)?.let { thumbs[id] = it; Log.d(TAG, "stored id=$id len=${it.length}") }
                    } else {
                        drawFallback(id, wv, tw, th) // PixelCopy refused — try a plain draw
                    }
                    bmp.recycle()
                },
                Handler(Looper.getMainLooper())
            )
        } catch (_: Throwable) {
            captureOgImage(id, wv)
        }
    }

    private fun encode(bmp: Bitmap): String? =
        try {
            val out = ByteArrayOutputStream()
            bmp.compress(Bitmap.CompressFormat.JPEG, 40, out)
            "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        } catch (_: Throwable) {
            null
        }

    /** Software draw — blank for hardware-accelerated content, but harmless to try
     *  when PixelCopy declines (some views/devices still render). */
    private fun drawFallback(id: Int, wv: WebView, tw: Int, th: Int) {
        try {
            val bmp = Bitmap.createBitmap(tw, th, Bitmap.Config.ARGB_8888)
            val canvas = android.graphics.Canvas(bmp)
            canvas.scale(tw.toFloat() / wv.width, th.toFloat() / wv.height)
            wv.draw(canvas)
            encode(bmp)?.let { thumbs[id] = it }
            bmp.recycle()
        } catch (_: Throwable) {
            captureOgImage(id, wv)
        }
    }

    /** Last resort: the page's own share image (og:image / twitter:image /
     *  apple-touch-icon), resolved absolute. Not every site has one. */
    private fun captureOgImage(id: Int, wv: WebView) {
        try {
            wv.evaluateJavascript(OG_IMAGE_JS) { result ->
                result
                    ?.trim('"')
                    ?.replace("\\/", "/")
                    ?.takeIf { it.isNotEmpty() && it != "null" }
                    ?.let { thumbs[id] = it }
            }
        } catch (_: Throwable) {
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
                // PixelCopy reads the live surface, so wait for the page to paint.
                view.postDelayed({ captureThumb(id, view) }, 700)
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
                // Refresh this tab's cover once it's composited again.
                it.postDelayed({ captureThumb(a.id, it) }, 500)
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
            thumbs.remove(a.id)
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

    /** The shell pulls a tab's cached cover snapshot over the normal IPC — images
     *  are too large for the plugin event channel. "" when nothing captured yet. */
    @Command
    fun thumbnail(invoke: Invoke) {
        val a = invoke.parseArgs(IdArgs::class.java)
        val hit = thumbs[a.id]
        Log.d(TAG, "thumbnail id=${a.id} hit=${hit != null} cached=${thumbs.size}")
        val o = JSObject()
        o.put("data", hit ?: "")
        invoke.resolve(o)
    }
}
