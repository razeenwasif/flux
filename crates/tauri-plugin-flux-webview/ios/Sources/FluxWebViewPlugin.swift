// A stack of WKWebViews, one per Flux browser tab, laid over the Tauri shell's
// own WKWebView (ADR 0012). The iOS twin of android/'s FluxWebViewPlugin.kt:
// the same commands, the same "nav" event, the same cover snapshots.
//
// Bounds arrive as CSS pixels from the shell's getBoundingClientRect. With
// viewport-fit=cover and width=device-width, a CSS pixel is a point and the
// shell's viewport is its WKWebView's frame, so a tab's frame is the rect
// converted from the shell webview into its superview.
//
// Rust calls these from a worker thread; every UIKit touch hops to the main
// thread, and the snapshot cache is only read and written there.

import Tauri
import UIKit
import WebKit

struct OpenArgs: Decodable {
  let id: Int
  let url: String
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

struct BoundsArgs: Decodable {
  let id: Int
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

struct IdArgs: Decodable {
  let id: Int
}

struct Thumb: Encodable {
  let data: String
}

struct NavArgs: Decodable {
  let id: Int
  let url: String
}

/// Width (points) of a tab switcher cover. The grid's cards are about 170pt
/// wide, so this keeps the cached JPEG small.
private let thumbWidth: CGFloat = 220

class FluxWebViewPlugin: Plugin, WKNavigationDelegate, WKUIDelegate {
  private weak var shell: WKWebView?
  private var views: [Int: WKWebView] = [:]
  private var watches: [Int: [NSKeyValueObservation]] = [:]
  private var thumbs: [Int: String] = [:]
  /// Per tab: where the page was last scrolled to, and which way the shell
  /// was last told it's going, so a scroll only crosses IPC when it turns.
  private var scrollY: [Int: CGFloat] = [:]
  private var scrollDown: [Int: Bool] = [:]
  /// Bumped by every show, so a hide still waiting on its snapshot doesn't
  /// hide a tab that has since been shown again.
  private var shown: [Int: Int] = [:]

  /// One process pool and the default store for every tab, so cookies and
  /// sign-ins are shared the way they are on desktop.
  private let pool = WKProcessPool()

  @objc public override func load(webview: WKWebView) {
    shell = webview
    FluxSceneDelegate.adopt(webview)
    #if DEBUG
      DebugDrive.shared.start(plugin: self)
    #endif
    // The shell lays itself out with env(safe-area-inset-*); UIKit mustn't
    // shift its viewport as well, or every tab rect would be off by the inset.
    webview.scrollView.contentInsetAdjustmentBehavior = .never
    webview.scrollView.bounces = false
  }

  var shellView: WKWebView? { shell }
  func tabView(_ id: Int) -> WKWebView? { views[id] }

  private func frame(_ x: Double, _ y: Double, _ w: Double, _ h: Double) -> CGRect {
    let r = CGRect(x: x, y: y, width: max(0, w), height: max(0, h))
    guard let shell = shell, let host = shell.superview else { return r }
    return shell.convert(r, to: host)
  }

  private func makeView(_ id: Int) -> WKWebView {
    let config = WKWebViewConfiguration()
    config.processPool = pool
    config.websiteDataStore = .default()
    config.allowsInlineMediaPlayback = true
    config.allowsPictureInPictureMediaPlayback = true
    config.mediaTypesRequiringUserActionForPlayback = []
    let wv = WKWebView(frame: .zero, configuration: config)
    wv.navigationDelegate = self
    wv.uiDelegate = self
    // The iOS edge swipe goes back and forward in the page, like Safari.
    wv.allowsBackForwardNavigationGestures = true
    wv.allowsLinkPreview = true
    wv.scrollView.contentInsetAdjustmentBehavior = .never
    wv.backgroundColor = .systemBackground
    wv.isOpaque = false
    #if DEBUG
      if #available(iOS 16.4, *) { wv.isInspectable = true }
    #endif
    // Title and back/forward state change without a navigation callback (SPAs,
    // late <title>s), so watch them.
    let push: (WKWebView) -> Void = { [weak self] v in self?.emitNav(id, v) }
    var w = [
      wv.observe(\.title, options: [.new]) { v, _ in push(v) },
      wv.observe(\.url, options: [.new]) { v, _ in push(v) },
      wv.observe(\.canGoBack, options: [.new]) { v, _ in push(v) },
      wv.observe(\.canGoForward, options: [.new]) { v, _ in push(v) },
      wv.observe(\.isLoading, options: [.new]) { v, _ in push(v) },
      // contentOffset by KVO rather than as the scroll view's delegate: WebKit
      // owns that delegate, and taking it breaks zooming.
      wv.scrollView.observe(\.contentOffset, options: [.new]) { [weak self] sv, _ in
        self?.scrolled(id, sv)
      },
    ]
    if #available(iOS 15.0, *) {
      w.append(wv.observe(\.themeColor, options: [.new]) { v, _ in push(v) })
    }
    watches[id] = w
    return wv
  }

  private func idOf(_ wv: WKWebView) -> Int? {
    views.first(where: { $0.value === wv })?.key
  }

  private func emitNav(_ id: Int, _ wv: WKWebView) {
    var data: JSObject = [:]
    data["id"] = id
    data["url"] = wv.url?.absoluteString ?? ""
    data["title"] = wv.title ?? ""
    data["canGoBack"] = wv.canGoBack
    data["canGoForward"] = wv.canGoForward
    data["loading"] = wv.isLoading
    data["progress"] = wv.estimatedProgress
    // The page's <meta name="theme-color">, for the strip under the status
    // bar, the way Safari tints it. "" when the page names none.
    if #available(iOS 15.0, *) { data["theme"] = hex(wv.themeColor) } else { data["theme"] = "" }
    trigger("nav", data: data)
  }

  private func hex(_ color: UIColor?) -> String {
    guard let c = color else { return "" }
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    guard c.getRed(&r, green: &g, blue: &b, alpha: &a), a > 0.5 else { return "" }
    let v = { (x: CGFloat) in Int((min(max(x, 0), 1) * 255).rounded()) }
    return String(format: "#%02x%02x%02x", v(r), v(g), v(b))
  }

  /// Tell the shell which way the page is scrolling, once per turn: down past
  /// 24pt shrinks the bar, any way up (or back at the top) brings it back.
  private func scrolled(_ id: Int, _ sv: UIScrollView) {
    guard sv.isTracking || sv.isDecelerating else {
      // A programmatic jump (a new page, an anchor) isn't the reader scrolling.
      scrollY[id] = sv.contentOffset.y
      return
    }
    let y = sv.contentOffset.y
    let last = scrollY[id] ?? y
    let atTop = y <= 4
    let down: Bool
    if atTop {
      down = false
    } else if y - last > 24 {
      down = true
    } else if last - y > 24 {
      down = false
    } else {
      return
    }
    scrollY[id] = y
    if scrollDown[id] == down { return }
    // Pages shorter than the screen can't hide anything by shrinking the bar.
    if down && sv.contentSize.height <= sv.bounds.height + 80 { return }
    scrollDown[id] = down
    var data: JSObject = [:]
    data["id"] = id
    data["down"] = down
    trigger("scroll", data: data)
  }

  private func load(_ wv: WKWebView, _ url: String) {
    guard let u = URL(string: url) else { return }
    wv.load(URLRequest(url: u))
  }

  /// A cover for the tab switcher. takeSnapshot renders the page itself, so it
  /// works while another view sits on top; it needs the view laid out.
  private func capture(_ id: Int, _ wv: WKWebView, then done: (() -> Void)? = nil) {
    guard wv.bounds.width > 0, wv.bounds.height > 0, !wv.isHidden else {
      done?()
      return
    }
    let cfg = WKSnapshotConfiguration()
    cfg.snapshotWidth = NSNumber(value: Double(thumbWidth))
    wv.takeSnapshot(with: cfg) { [weak self] image, _ in
      defer { done?() }
      guard let self = self, let image = image,
        let jpeg = image.jpegData(compressionQuality: 0.45)
      else { return }
      self.thumbs[id] = "data:image/jpeg;base64," + jpeg.base64EncodedString()
    }
  }

  // MARK: WKNavigationDelegate

  func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    if let id = idOf(webView) { emitNav(id, webView) }
  }

  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    guard let id = idOf(webView) else { return }
    emitNav(id, webView)
    // A new page starts with the full bar.
    if scrollDown[id] == true {
      scrollDown[id] = false
      var data: JSObject = [:]
      data["id"] = id
      data["down"] = false
      trigger("scroll", data: data)
    }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard let id = idOf(webView) else { return }
    emitNav(id, webView)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self, weak webView] in
      if let self = self, let wv = webView { self.capture(id, wv) }
    }
  }

  func webView(
    _ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error
  ) {
    if let id = idOf(webView) { emitNav(id, webView) }
  }

  /// Links that open somewhere else (mailto:, tel:, App Store links) go to iOS;
  /// everything web stays in the tab.
  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = action.request.url, let scheme = url.scheme?.lowercased() else {
      return decisionHandler(.allow)
    }
    if ["http", "https", "about", "blob", "data", "file"].contains(scheme) {
      return decisionHandler(.allow)
    }
    UIApplication.shared.open(url)
    decisionHandler(.cancel)
  }

  /// A web process that dies (memory pressure in the background) leaves a blank
  /// view; reload it rather than show nothing.
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    webView.reload()
  }

  // MARK: WKUIDelegate

  /// target=_blank and window.open load in the same tab for now, rather than
  /// going nowhere.
  func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
      webView.load(URLRequest(url: url))
    }
    return nil
  }

  // MARK: Commands

  @objc public func open(_ invoke: Invoke) throws {
    let a = try invoke.parseArgs(OpenArgs.self)
    DispatchQueue.main.async {
      guard let shell = self.shell, let host = shell.superview else { return }
      let wv = self.views[a.id] ?? {
        let v = self.makeView(a.id)
        self.views[a.id] = v
        host.addSubview(v)
        return v
      }()
      wv.frame = self.frame(a.x, a.y, a.width, a.height)
      wv.isHidden = false
      host.bringSubviewToFront(wv)
      self.load(wv, a.url)
    }
    invoke.resolve()
  }

  @objc public func setBounds(_ invoke: Invoke) throws {
    let a = try invoke.parseArgs(BoundsArgs.self)
    DispatchQueue.main.async {
      guard let wv = self.views[a.id] else { return }
      let to = self.frame(a.x, a.y, a.width, a.height)
      // The bar growing or shrinking moves only the page's bottom edge: ease
      // it, so the page follows the bar instead of jumping. Anything else
      // (rotation, a new layout) lands at once.
      let easy = !wv.isHidden && abs(to.width - wv.frame.width) < 1 && abs(to.minX - wv.frame.minX) < 1
        && abs(to.height - wv.frame.height) < 120
      if easy {
        UIView.animate(
          withDuration: 0.22, delay: 0, options: [.curveEaseInOut, .beginFromCurrentState]
        ) { wv.frame = to }
      } else {
        wv.frame = to
      }
    }
    invoke.resolve()
  }

  @objc public func show(_ invoke: Invoke) throws {
    let a = try invoke.parseArgs(IdArgs.self)
    DispatchQueue.main.async {
      guard let wv = self.views[a.id] else { return }
      self.shown[a.id, default: 0] += 1
      wv.isHidden = false
      wv.superview?.bringSubviewToFront(wv)
      self.emitNav(a.id, wv)
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self, weak wv] in
        if let self = self, let wv = wv { self.capture(a.id, wv) }
      }
    }
    invoke.resolve()
  }

  @objc public func hide(_ invoke: Invoke) throws {
    let a = try invoke.parseArgs(IdArgs.self)
    DispatchQueue.main.async {
      guard let wv = self.views[a.id], !wv.isHidden else { return }
      // Refresh the cover on the way out (the tab grid is usually why), and
      // hide only once it's taken: a hidden view snapshots black. At most
      // 0.2s, so a slow snapshot can't hold the page over the shell.
      let gen = self.shown[a.id, default: 0]
      var done = false
      let finish = { [weak self, weak wv] in
        guard !done, let self = self, let wv = wv else { return }
        done = true
        if self.shown[a.id, default: 0] == gen { wv.isHidden = true }
      }
      self.capture(a.id, wv, then: finish)
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.2, execute: finish)
    }
    invoke.resolve()
  }

  @objc public func close(_ invoke: Invoke) throws {
    let a = try invoke.parseArgs(IdArgs.self)
    DispatchQueue.main.async {
      self.thumbs[a.id] = nil
      self.watches[a.id] = nil
      self.scrollY[a.id] = nil
      self.scrollDown[a.id] = nil
      self.shown[a.id] = nil
      if let wv = self.views.removeValue(forKey: a.id) {
        // Stop sound and video before the view goes, so nothing plays on.
        wv.pauseAllMediaPlayback(completionHandler: nil)
        wv.stopLoading()
        wv.navigationDelegate = nil
        wv.uiDelegate = nil
        wv.removeFromSuperview()
      }
    }
    invoke.resolve()
  }

  @objc public func navigate(_ invoke: Invoke) throws {
    let a = try invoke.parseArgs(NavArgs.self)
    DispatchQueue.main.async {
      if let wv = self.views[a.id] { self.load(wv, a.url) }
    }
    invoke.resolve()
  }

  @objc public func goBack(_ invoke: Invoke) throws {
    let a = try invoke.parseArgs(IdArgs.self)
    DispatchQueue.main.async { _ = self.views[a.id]?.goBack() }
    invoke.resolve()
  }

  @objc public func goForward(_ invoke: Invoke) throws {
    let a = try invoke.parseArgs(IdArgs.self)
    DispatchQueue.main.async { _ = self.views[a.id]?.goForward() }
    invoke.resolve()
  }

  @objc public func reload(_ invoke: Invoke) throws {
    let a = try invoke.parseArgs(IdArgs.self)
    DispatchQueue.main.async { self.views[a.id]?.reload() }
    invoke.resolve()
  }

  @objc public func stop(_ invoke: Invoke) throws {
    let a = try invoke.parseArgs(IdArgs.self)
    DispatchQueue.main.async { self.views[a.id]?.stopLoading() }
    invoke.resolve()
  }

  /// The shell pulls covers over normal IPC; "" before one has been taken.
  @objc public func thumbnail(_ invoke: Invoke) throws {
    let a = try invoke.parseArgs(IdArgs.self)
    DispatchQueue.main.async {
      invoke.resolve(Thumb(data: self.thumbs[a.id] ?? ""))
    }
  }
}

#if DEBUG
  /// Debug builds only: lets a Mac drive the app over USB (scripts/ios-drive.sh).
  /// The Mac copies a script into the app's own Documents folder (only a paired
  /// Mac can write there) and posts a Darwin notification. The app runs the
  /// script in the shell, or in a tab if its first line is `//tab:<id>`, and
  /// writes the result next to it for the Mac to copy back. Never compiled into
  /// a release build.
  final class DebugDrive {
    static let shared = DebugDrive()
    private weak var plugin: FluxWebViewPlugin?
    private var started = false
    private var seq = 0

    private var dir: URL {
      FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("flux-debug", isDirectory: true)
    }

    func start(plugin: FluxWebViewPlugin) {
      self.plugin = plugin
      if started { return }
      started = true
      try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      let center = CFNotificationCenterGetDarwinNotifyCenter()
      CFNotificationCenterAddObserver(
        center, Unmanaged.passUnretained(self).toOpaque(),
        { _, observer, _, _, _ in
          guard let observer = observer else { return }
          let me = Unmanaged<DebugDrive>.fromOpaque(observer).takeUnretainedValue()
          DispatchQueue.main.async { me.run() }
        }, "dev.flux.debug.run" as CFString, nil, .deliverImmediately)
    }

    private func run() {
      seq += 1
      let n = seq
      guard let js = try? String(contentsOf: dir.appendingPathComponent("in.js"), encoding: .utf8)
      else { return write(n, ["error": "no in.js"]) }
      var target: WKWebView? = plugin?.shellView
      if js.hasPrefix("//tab:"), let id = Int(js.dropFirst(6).prefix(while: { $0.isNumber })) {
        target = plugin?.tabView(id)
      }
      guard let wv = target else { return write(n, ["error": "no such view"]) }
      wv.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { r in
        switch r {
        case .success(let v): self.write(n, ["ok": "\(v)"])
        case .failure(let e): self.write(n, ["error": "\(e)"])
        }
      }
    }

    private func write(_ n: Int, _ body: [String: String]) {
      var o = body
      o["seq"] = String(n)
      if let d = try? JSONSerialization.data(withJSONObject: o) {
        try? d.write(to: dir.appendingPathComponent("out.json"))
      }
    }
  }
#endif

/// iOS 27 stops any app built with its SDK at launch unless the app uses
/// scenes (ADR 0021). The tao in Tauri 2.11 makes its UIWindow the old way,
/// in the app delegate, before any scene exists. So Info.ios.plist declares one
/// scene with this class as its delegate, and when the scene connects, the
/// shell's window moves into it. A newer tao (Tauri 2.12) does this itself.
///
/// The window is found through the shell webview, which the plugin is handed
/// at launch. Whichever comes second (the webview or the scene) does the move.
@objc(FluxSceneDelegate)
public class FluxSceneDelegate: UIResponder, UIWindowSceneDelegate {
  public var window: UIWindow?

  private static weak var scene: UIWindowScene?
  private static weak var shell: WKWebView?
  private static weak var current: FluxSceneDelegate?

  static func adopt(_ webview: WKWebView) {
    shell = webview
    // The webview may not be in its window yet; look on the next turn too.
    attach()
    DispatchQueue.main.async { attach() }
  }

  private static func attach() {
    guard let scene = scene, let win = shell?.window else { return }
    if win.windowScene !== scene { win.windowScene = scene }
    current?.window = win
    if !win.isKeyWindow { win.makeKeyAndVisible() }
  }

  public func scene(
    _ scene: UIScene, willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let ws = scene as? UIWindowScene else { return }
    FluxSceneDelegate.scene = ws
    FluxSceneDelegate.current = self
    FluxSceneDelegate.attach()
    DispatchQueue.main.async { FluxSceneDelegate.attach() }
  }
}

@_cdecl("init_plugin_flux_webview")
func initPlugin() -> Plugin {
  return FluxWebViewPlugin()
}
