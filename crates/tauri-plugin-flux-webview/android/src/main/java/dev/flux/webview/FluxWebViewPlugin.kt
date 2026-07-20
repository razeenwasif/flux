package dev.flux.webview

import android.annotation.SuppressLint
import android.app.Activity
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
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
    private val views = HashMap<Int, WebView>()
    private var container: FrameLayout? = null

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
        return fl
    }

    private fun lp(x: Double, y: Double, w: Double, h: Double): FrameLayout.LayoutParams {
        val d = density()
        val p = FrameLayout.LayoutParams((w * d).toInt(), (h * d).toInt())
        p.leftMargin = (x * d).toInt()
        p.topMargin = (y * d).toInt()
        return p
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
        // Keep navigation inside this WebView (don't hand links to an external app).
        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean = false
            override fun onPageFinished(view: WebView, url: String?) {
                val data = JSObject()
                data.put("id", id)
                data.put("url", url ?: "")
                data.put("title", view.title ?: "")
                data.put("canGoBack", view.canGoBack())
                data.put("canGoForward", view.canGoForward())
                trigger("nav", data)
            }
        }
        wv.webChromeClient = WebChromeClient()
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
            views[a.id]?.let { it.visibility = WebView.VISIBLE; it.bringToFront() }
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
