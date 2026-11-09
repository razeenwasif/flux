// A stack of WKWebViews, one per Flux browser tab, laid over the Tauri shell's
// own WKWebView (ADR 0012). The iOS twin of android/'s FluxWebViewPlugin.kt:
// the same commands, the same "nav" event, the same cover snapshots.
//
// Pages sit *under* the shell (ADR 0021): the tab views fill the screen in a
// child view controller below the shell's WKWebView, which is transparent over
// a page and lets touches through everywhere but its bars (ChromeHost). So the
// bottom bar and the status strip are glass over the page, and the page runs up
// behind the notch. The bars reach WebKit as safe-area insets on that
// controller (`set_chrome`), so content and fixed headers stay clear of them and
// scroll under them, as in Safari.
//
// Bounds arrive as CSS pixels from the shell's getBoundingClientRect (a CSS
// pixel is a point under width=device-width); only their x and width are used,
// since a page takes the full height.
//
// Rust calls these from a worker thread; every UIKit touch hops to the main
// thread, and the snapshot cache is only read and written there.

import LinkPresentation
import Tauri
import UIKit
import UniformTypeIdentifiers
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

struct Shared: Encodable {
  let completed: Bool
}

struct ShareArgs: Decodable {
  let url: String
  let title: String?
}

/// The shared link, with the page's title for the share sheet's header. A bare
/// URL leaves iOS to fetch the title itself, and until it has one the header
/// shows a placeholder.
final class ShareItem: NSObject, UIActivityItemSource {
  let url: URL
  let title: String?
  init(url: URL, title: String?) {
    self.url = url
    self.title = title
  }
  func activityViewControllerPlaceholderItem(_ c: UIActivityViewController) -> Any { url }
  func activityViewController(
    _ c: UIActivityViewController, itemForActivityType t: UIActivity.ActivityType?
  ) -> Any? { url }
  func activityViewControllerLinkMetadata(_ c: UIActivityViewController) -> LPLinkMetadata? {
    let m = LPLinkMetadata()
    m.originalURL = url
    m.url = url
    m.title = title?.isEmpty == false ? title : url.host
    return m
  }
}

struct PathArgs: Decodable {
  let path: String
}

struct Folder: Encodable {
  let name: String
  let path: String
}

final class PickDelegate: NSObject, UIDocumentPickerDelegate {
  let done: (URL?) -> Void
  init(_ done: @escaping (URL?) -> Void) { self.done = done }
  func documentPicker(_ c: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    done(urls.first)
  }
  func documentPickerWasCancelled(_ c: UIDocumentPickerViewController) { done(nil) }
}

/// Folders the user picked through iOS, kept as security-scoped bookmarks in
/// UserDefaults. Opened at launch (`startAccessingSecurityScopedResource`) and
/// held open for the app's life, so Rust's ordinary file calls work on their
/// paths.
final class Folders {
  static let shared = Folders()
  private let key = "flux.pickedFolders"
  private var open: [URL] = []

  private init() {
    var keep: [Data] = []
    for data in (UserDefaults.standard.array(forKey: key) as? [Data]) ?? [] {
      var stale = false
      guard let url = try? URL(resolvingBookmarkData: data, bookmarkDataIsStale: &stale),
        url.startAccessingSecurityScopedResource()
      else { continue }
      open.append(url)
      keep.append(stale ? ((try? url.bookmarkData()) ?? data) : data)
    }
    UserDefaults.standard.set(keep, forKey: key)
  }

  func add(_ url: URL) -> Folder? {
    guard url.startAccessingSecurityScopedResource() else { return nil }
    if !open.contains(where: { $0.standardizedFileURL == url.standardizedFileURL }) {
      guard let data = try? url.bookmarkData() else {
        url.stopAccessingSecurityScopedResource()
        return nil
      }
      open.append(url)
      var all = (UserDefaults.standard.array(forKey: key) as? [Data]) ?? []
      all.append(data)
      UserDefaults.standard.set(all, forKey: key)
    }
    return Folder(name: url.lastPathComponent, path: url.path)
  }

  func list() -> [Folder] {
    open.map { Folder(name: $0.lastPathComponent, path: $0.path) }
  }

  func forget(_ path: String) {
    guard let i = open.firstIndex(where: { $0.path == path }) else { return }
    open[i].stopAccessingSecurityScopedResource()
    open.remove(at: i)
    let all = open.compactMap { try? $0.bookmarkData() }
    UserDefaults.standard.set(all, forKey: key)
  }
}

struct ChromeArgs: Decodable {
  /// The status strip's height and the bottom bar's, in points.
  let top: Double
  let bottom: Double
  /// What fills the strip behind the notch over Flux's own pages ("#rrggbb").
  let fill: String?
}

/// Holds the shell's WKWebView. Over a visible page, only the bars take touches;
/// everywhere else hit-testing returns nil, so UIKit carries on to the page
/// underneath.
final class ChromeHost: UIView {
  var passThrough: (CGPoint) -> Bool = { _ in false }
  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    passThrough(point) ? nil : super.hitTest(point, with: event)
  }
}

extension UIColor {
  /// "#rrggbb".
  convenience init?(fluxHex hex: String) {
    let h = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
    guard h.count == 6, let v = UInt32(h, radix: 16) else { return nil }
    self.init(
      red: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255,
      blue: CGFloat(v & 0xff) / 255, alpha: 1)
  }
}

/// The status bar's style, Safari's way: dark text over a light page, light
/// over a dark one or over Flux itself. The app's view controller is tao's, so
/// its `preferredStatusBarStyle` is replaced at runtime to read `style`.
enum StatusBar {
  static var style: UIStatusBarStyle = .lightContent
  private static var installed = false

  static func install(on vc: UIViewController) {
    if installed { return }
    installed = true
    let read: @convention(block) (AnyObject) -> Int = { _ in StatusBar.style.rawValue }
    class_replaceMethod(
      type(of: vc), #selector(getter: UIViewController.preferredStatusBarStyle),
      imp_implementationWithBlock(read), "q@:")
  }

  static func set(_ s: UIStatusBarStyle, on vc: UIViewController?) {
    if s == style { return }
    style = s
    UIView.animate(withDuration: 0.2) { vc?.setNeedsStatusBarAppearanceUpdate() }
  }
}

/// The tab views' parent, a child of the app's view controller so the bars can
/// be given to WebKit as safe-area insets (`additionalSafeAreaInsets`).
final class PagesController: UIViewController {
  override func loadView() {
    view = UIView()
    view.backgroundColor = .clear
  }
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
  private var pages: PagesController?
  private var chrome: ChromeHost?
  /// The bars' heights, from the shell (`set_chrome`).
  private var topH: CGFloat = 0
  private var barH: CGFloat = 0
  private var pageShown = false
  private var views: [Int: WKWebView] = [:]
  private var watches: [Int: [NSKeyValueObservation]] = [:]
  private var thumbs: [Int: String] = [:]
  /// Per tab: where the page was last scrolled to, and which way the shell
  /// was last told it's going, so a scroll only crosses IPC when it turns.
  private var scrollY: [Int: CGFloat] = [:]
  private var scrollDown: [Int: Bool] = [:]
  /// Hidden tabs whose web process iOS killed: reloaded when next shown.
  private var stale = Set<Int>()
  /// Bumped by every show, so a hide still waiting on its snapshot doesn't
  /// hide a tab that has since been shown again.
  private var shown: [Int: Int] = [:]

  /// One process pool and the default store for every tab, so cookies and
  /// sign-ins are shared the way they are on desktop.
  private let pool = WKProcessPool()

  @objc public override func load(webview: WKWebView) {
    shell = webview
    FluxSceneDelegate.adopt(webview)
    _ = Folders.shared  // reopen the folders picked in earlier sessions
    // iOS's memory warning: the shell treats it as critical pressure and
    // unloads idle background tabs (the `memory` event).
    NotificationCenter.default.addObserver(
      forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.trigger("memory", data: ["level": "critical"]) }
    Opened.shared.plugin = self
    #if DEBUG
      DebugDrive.shared.start(plugin: self)
    #endif
    // The shell lays itself out with env(safe-area-inset-*); UIKit mustn't
    // shift its viewport as well, or every tab rect would be off by the inset.
    webview.scrollView.contentInsetAdjustmentBehavior = .never
    webview.scrollView.bounces = false
    // Transparent, so a page underneath shows through wherever the shell
    // paints nothing; and a tap on the status bar scrolls the page, not it.
    webview.isOpaque = false
    webview.backgroundColor = .clear
    webview.scrollView.backgroundColor = .clear
    webview.scrollView.scrollsToTop = false
  }

  var shellView: WKWebView? { shell }
  func tabView(_ id: Int) -> WKWebView? { views[id] }
  var liveTabs: [Int] { views.keys.sorted() }
  var tabGeometry: String {
    views.filter { !$0.value.isHidden }.map { id, v in
      "tab \(id) frame=\(v.frame) safe=\(v.safeAreaInsets) adjusted=\(v.scrollView.adjustedContentInset) offset=\(v.scrollView.contentOffset) pages=\(pages?.view.frame ?? .zero) extra=\(pages?.additionalSafeAreaInsets ?? .zero) chrome=\(topH)/\(barH)"
    }.joined(separator: "; ")
  }

  /// A page's frame: the card's x and width, the full height of the screen.
  private func frame(_ x: Double, _ y: Double, _ w: Double, _ h: Double) -> CGRect {
    let r = CGRect(x: x, y: y, width: max(0, w), height: max(0, h))
    guard let shell = shell, let pv = layers()?.view else { return r }
    let c = shell.convert(r, to: pv)
    return CGRect(x: c.minX, y: 0, width: c.width, height: pv.bounds.height)
  }

  /// Put the pages under the shell, once: a PagesController below, the shell
  /// moved into a ChromeHost above. Done when the first tab opens, by which
  /// time the shell is in its window.
  private func layers() -> PagesController? {
    if let p = pages { return p }
    guard let shell = shell, let host = shell.superview else { return nil }
    let root = manager.viewController ?? host.window?.rootViewController
    let pc = PagesController()
    if let root = root { StatusBar.install(on: root) }
    root?.addChild(pc)
    pc.view.frame = host.bounds
    pc.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    host.insertSubview(pc.view, belowSubview: shell)
    pc.didMove(toParent: root)

    let ch = ChromeHost(frame: shell.frame)
    ch.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    ch.backgroundColor = .clear
    host.insertSubview(ch, aboveSubview: pc.view)
    shell.removeFromSuperview()
    shell.frame = ch.bounds
    shell.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    ch.addSubview(shell)
    ch.passThrough = { [weak self] p in
      guard let self = self, self.pageShown, let ch = self.chrome else { return false }
      return p.y > self.topH && p.y < ch.bounds.height - self.barH
    }
    pages = pc
    chrome = ch
    applyInsets()
    return pc
  }

  /// The bars as safe-area insets on the pages, beyond what iOS already gives
  /// (the status bar, the home indicator).
  private func applyInsets() {
    guard let pc = pages, let host = pc.view.superview else { return }
    let base = host.safeAreaInsets
    pc.additionalSafeAreaInsets = UIEdgeInsets(
      top: max(0, topH - base.top), left: 0, bottom: max(0, barH - base.bottom), right: 0)
  }

  /// Tell the shell whether a page is on screen, so it paints itself
  /// transparent over one (the `page` event).
  private func syncPageShown() {
    let now = views.values.contains { !$0.isHidden }
    syncStatusBar()
    if now == pageShown { return }
    pageShown = now
    trigger("page", data: ["visible": now])
  }

  /// WebKit leaves the strip behind the notch to the view's own background, so
  /// it takes the page's colour (`underPageBackgroundColor`), and the status
  /// bar reads dark or light to suit it.
  private func pageColor(_ wv: WKWebView) {
    let c = wv.underPageBackgroundColor ?? .systemBackground
    wv.backgroundColor = c
    wv.scrollView.backgroundColor = c
    if !wv.isHidden { syncStatusBar() }
  }

  private func syncStatusBar() {
    let root = manager.viewController ?? shell?.window?.rootViewController
    guard let page = views.values.first(where: { !$0.isHidden }) else {
      return StatusBar.set(.lightContent, on: root)  // Flux's own dark chrome
    }
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    let c = page.underPageBackgroundColor ?? .black
    let light = c.getRed(&r, green: &g, blue: &b, alpha: &a) && 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6
    StatusBar.set(light ? .darkContent : .lightContent, on: root)
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
    // Insets follow the safe area, which carries the bars (applyInsets), so the
    // page scrolls under them and its fixed headers sit below the notch.
    wv.scrollView.contentInsetAdjustmentBehavior = .automatic
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
    w.append(
      wv.observe(\.underPageBackgroundColor, options: [.initial, .new]) { [weak self] v, _ in
        self?.pageColor(v)
      })
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
    let atTop = y + sv.adjustedContentInset.top <= 4
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
    if u.isFileURL {
      // A file from Files: WebKit only reads local files it's been handed
      // access to, so grant the file's folder (for pages with relative links).
      wv.loadFileURL(u, allowingReadAccessTo: u.deletingLastPathComponent())
    } else {
      wv.load(URLRequest(url: u))
    }
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
    // iOS reclaims background pages' processes when memory runs short.
    // Reloading a hidden tab straight away would take that memory back; wait
    // until it's shown.
    if webView.isHidden, let id = idOf(webView) {
      stale.insert(id)
    } else {
      webView.reload()
    }
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
      guard let pv = self.layers()?.view else { return }
      let wv = self.views[a.id] ?? {
        let v = self.makeView(a.id)
        self.views[a.id] = v
        pv.addSubview(v)
        return v
      }()
      wv.frame = self.frame(a.x, a.y, a.width, a.height)
      wv.isHidden = false
      pv.bringSubviewToFront(wv)
      self.load(wv, a.url)
      self.syncPageShown()
    }
    invoke.resolve()
  }

  @objc public func setBounds(_ invoke: Invoke) throws {
    let a = try invoke.parseArgs(BoundsArgs.self)
    DispatchQueue.main.async {
      // Pages take the full height, so the bar shrinking or growing doesn't
      // move them (it changes their insets); this is rotation and layout.
      self.views[a.id]?.frame = self.frame(a.x, a.y, a.width, a.height)
    }
    invoke.resolve()
  }

  @objc public func show(_ invoke: Invoke) throws {
    let a = try invoke.parseArgs(IdArgs.self)
    DispatchQueue.main.async {
      guard let wv = self.views[a.id] else { return }
      self.shown[a.id, default: 0] += 1
      if self.stale.remove(a.id) != nil { wv.reload() }
      wv.isHidden = false
      wv.superview?.bringSubviewToFront(wv)
      self.syncPageShown()
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
        self.syncPageShown()
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
      self.drop(a.id)
    }
    invoke.resolve()
  }

  /// Unload a background tab (the shell's tab sleep): its view goes, so its
  /// page's memory comes back, but its cover stays for the tab grid. The shell
  /// opens it afresh when the tab comes back. A visible tab's cover is
  /// refreshed first; a hidden one keeps the cover it has (hidden views
  /// snapshot black).
  @objc public func hibernate(_ invoke: Invoke) throws {
    let a = try invoke.parseArgs(IdArgs.self)
    DispatchQueue.main.async {
      guard let wv = self.views[a.id] else { return }
      if wv.isHidden {
        self.drop(a.id)
      } else {
        self.capture(a.id, wv) { [weak self] in self?.drop(a.id) }
      }
    }
    invoke.resolve()
  }

  /// Tear a tab's view down, keeping its cover.
  private func drop(_ id: Int) {
    watches[id] = nil
    scrollY[id] = nil
    scrollDown[id] = nil
    shown[id] = nil
    stale.remove(id)
    guard let wv = views.removeValue(forKey: id) else { return }
    // Stop sound and video before the view goes, so nothing plays on.
    wv.pauseAllMediaPlayback(completionHandler: nil)
    wv.stopLoading()
    wv.navigationDelegate = nil
    wv.uiDelegate = nil
    wv.removeFromSuperview()
    syncPageShown()
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

  /// The system share sheet for a page, from the ⋯ menu. Presented by the app's
  /// own view controller, so it's a real sheet over everything, native tabs
  /// included (WebKit's navigator.share showed a cut-off popover). Resolves
  /// with whether something was shared.
  /// The bars' heights, sent by the shell whenever they change (the bottom bar
  /// shrinks while a page scrolls down).
  @objc public func setChrome(_ invoke: Invoke) throws {
    let a = try invoke.parseArgs(ChromeArgs.self)
    DispatchQueue.main.async {
      self.topH = CGFloat(a.top)
      self.barH = CGFloat(a.bottom)
      self.applyInsets()
      // WebKit draws nothing in the strip behind the status bar, in the shell
      // or in a page: what shows there is the native view underneath. Over a
      // page that's the page view, coloured as the page (pageColor); over
      // Flux's own pages it's this, a colour the shell takes from the top edge
      // of its wallpaper, so home's colour runs up around the notch.
      if let hex = a.fill, let c = UIColor(fluxHex: hex) { self.layers()?.view.backgroundColor = c }
    }
    invoke.resolve()
  }

  /// Links shared to Flux since the shell last asked (see `Opened`).
  @objc public func takeOpened(_ invoke: Invoke) throws {
    DispatchQueue.main.async { invoke.resolve(Opened.shared.drain()) }
  }

  // MARK: Folders picked through iOS

  /// Pick a folder through iOS (iCloud Drive, On My iPhone, another app's
  /// folder) so Files and Sync can use it. Flux keeps a security-scoped
  /// bookmark, so the folder stays open to it across launches until forgotten.
  /// Resolves with {name, path}, or null if the picker was cancelled.
  @objc public func pickFolder(_ invoke: Invoke) throws {
    DispatchQueue.main.async {
      guard var top = self.manager.viewController ?? self.shell?.window?.rootViewController
      else { return invoke.reject("nothing to present the folder picker from") }
      while let p = top.presentedViewController { top = p }
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder])
      picker.allowsMultipleSelection = false
      let d = PickDelegate { url in
        self.picking = nil
        guard let url = url else { return invoke.resolve() }
        guard let f = Folders.shared.add(url) else {
          return invoke.reject("iOS didn't give Flux lasting access to that folder")
        }
        invoke.resolve(f)
      }
      self.picking = d
      picker.delegate = d
      top.present(picker, animated: true)
    }
  }
  private var picking: PickDelegate?

  /// The folders picked so far that Flux can still open.
  @objc public func folders(_ invoke: Invoke) throws {
    invoke.resolve(Folders.shared.list())
  }

  @objc public func forgetFolder(_ invoke: Invoke) throws {
    let a = try invoke.parseArgs(PathArgs.self)
    Folders.shared.forget(a.path)
    invoke.resolve()
  }

  @objc public func share(_ invoke: Invoke) throws {
    let a = try invoke.parseArgs(ShareArgs.self)
    DispatchQueue.main.async {
      guard let url = URL(string: a.url),
        var top = self.manager.viewController ?? self.shell?.window?.rootViewController
      else { return invoke.reject("nothing to present the share sheet from") }
      while let p = top.presentedViewController { top = p }
      let sheet = UIActivityViewController(
        activityItems: [ShareItem(url: url, title: a.title)], applicationActivities: nil)
      if top.traitCollection.userInterfaceIdiom == .pad {
        // An iPad shows it as a popover, from the bottom bar's ⋯.
        if let pop = sheet.popoverPresentationController {
          let v = top.view!
          pop.sourceView = v
          pop.sourceRect = CGRect(x: v.bounds.maxX - 30, y: v.bounds.maxY - 40, width: 1, height: 1)
          pop.permittedArrowDirections = [.down]
        }
      } else {
        // A phone gets the usual half-height sheet. Left as a popover, it was
        // pinned to the corner and cut off at the screen's edge.
        sheet.modalPresentationStyle = .pageSheet
        if let s = sheet.sheetPresentationController {
          s.detents = [.medium(), .large()]
          s.prefersGrabberVisible = false
        }
      }
      sheet.completionWithItemsHandler = { _, completed, _, _ in
        invoke.resolve(Shared(completed: completed))
      }
      top.present(sheet, animated: true)
    }
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
  /// The Mac copies a script into the app's own Caches folder (only a paired
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
      // Caches, not Documents: Documents is what the iOS Files app shows.
      FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
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
      if js.hasPrefix("//native:traits") { return write(n, ["ok": traits()]) }
      if js.hasPrefix("//native:present") { return present(n) }
      if js.hasPrefix("//native:tree") { return write(n, ["ok": tree()]) }
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

    /// What UIKit thinks the app's window is: size classes decide whether
    /// sheets and popovers adapt.
    private func traits() -> String {
      guard let w = plugin?.shellView?.window else { return "no window" }
      let t = w.traitCollection
      let root = w.rootViewController
      return [
        "window=\(w.frame) key=\(w.isKeyWindow) scene=\(w.windowScene != nil)",
        "h=\(t.horizontalSizeClass.rawValue) v=\(t.verticalSizeClass.rawValue) idiom=\(t.userInterfaceIdiom.rawValue)",
        "root=\(root.map { String(describing: type(of: $0)) } ?? "nil") rootH=\(root?.traitCollection.horizontalSizeClass.rawValue ?? -1) rootView=\(root?.view.frame ?? .zero)",
        "sceneWindows=\(w.windowScene?.windows.count ?? -1) screen=\(w.screen.bounds)",
        "liveTabs=\(plugin?.liveTabs ?? [])",
        plugin?.tabGeometry ?? "",
      ].joined(separator: " | ")
    }

    /// Every window in the scene, and the views under the window that holds
    /// the shell, with frames and what they paint: for finding what covers what.
    private func tree() -> String {
      var out: [String] = []
      func bg(_ v: UIView) -> String {
        guard let c = v.backgroundColor else { return "nil" }
        var w: CGFloat = 0, a: CGFloat = 0
        c.getWhite(&w, alpha: &a)
        return String(format: "w%.2f a%.2f", w, a)
      }
      func walk(_ v: UIView, _ d: Int) {
        out.append(String(repeating: "  ", count: d) + "\(type(of: v)) \(v.frame) hidden=\(v.isHidden) alpha=\(v.alpha) bg=\(bg(v)) layerBg=\(v.layer.backgroundColor != nil)")
        if d < 7, !(v is WKWebView) { v.subviews.forEach { walk($0, d + 1) } }
      }
      for w in (plugin?.shellView?.window?.windowScene?.windows ?? []) {
        out.append("WINDOW \(type(of: w)) \(w.frame) level=\(w.windowLevel.rawValue) hidden=\(w.isHidden) key=\(w.isKeyWindow)")
        walk(w, 1)
      }
      return out.joined(separator: "\n")
    }

    /// Present a plain page sheet and report where UIKit put it.
    private func present(_ n: Int) {
      guard var top = plugin?.shellView?.window?.rootViewController else {
        return write(n, ["error": "no root"])
      }
      while let p = top.presentedViewController { top = p }
      let vc = UIViewController()
      vc.view.backgroundColor = .systemPink
      vc.modalPresentationStyle = .pageSheet
      top.present(vc, animated: false)
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
        let c = vc.presentationController?.containerView
        let ws = vc.view.window?.windowScene
        let out = [
          "view=\(vc.view.frame) inWindow=\(vc.view.convert(vc.view.bounds, to: nil))",
          "container=\(c?.frame ?? .zero) containerWindow=\(c?.window.map { "\(type(of: $0)) \($0.frame)" } ?? "nil")",
          "sceneBounds=\(ws?.coordinateSpace.bounds ?? .zero) sceneScreen=\(ws?.screen.bounds ?? .zero) style=\(vc.modalPresentationStyle.rawValue) h=\(vc.traitCollection.horizontalSizeClass.rawValue)",
        ].joined(separator: " | ")
        vc.dismiss(animated: false)
        self.write(n, ["ok": out])
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
/// scene with this class as its delegate, and when the scene connects, tao's
/// view controller moves into a window made for that scene.
///
/// Moving tao's own window into the scene (`windowScene = …`) displayed fine,
/// but anything presented from it (the share sheet) was laid out for the wrong
/// space and came out as a card cut off at the screen's edge. A window created
/// with the scene doesn't have that problem. tao's window stays alive, hidden
/// and empty, for tao's own bookkeeping.
///
/// The view controller is found through the shell webview, which the plugin is
/// handed at launch. Whichever comes second (the webview or the scene) does
/// the move.
/// Links handed to Flux by the "Send to Flux" share extension
/// (flux-browser://open?url=…). Kept until the shell takes them, since a link
/// that launches Flux arrives before the shell is listening; the `opened` event
/// only says there's something to take.
final class Opened {
  static let shared = Opened()
  private var links: [String] = []
  weak var plugin: FluxWebViewPlugin?

  func take(_ contexts: Set<UIOpenURLContext>) {
    for c in contexts {
      guard c.url.scheme == "flux-browser", c.url.host == "open",
        let raw = URLComponents(url: c.url, resolvingAgainstBaseURL: false)?
          .queryItems?.first(where: { $0.name == "url" })?.value,
        let link = URL(string: raw), ["http", "https"].contains(link.scheme?.lowercased() ?? "")
      else { continue }
      links.append(link.absoluteString)
    }
    if !links.isEmpty { plugin?.trigger("opened", data: [:]) }
  }

  func drain() -> [String] {
    defer { links.removeAll() }
    return links
  }
}

@objc(FluxSceneDelegate)
public class FluxSceneDelegate: UIResponder, UIWindowSceneDelegate {
  public var window: UIWindow?

  private static weak var scene: UIWindowScene?
  private static weak var shell: WKWebView?
  private static weak var current: FluxSceneDelegate?
  /// The scene's own window, which hosts tao's view controller.
  private static var host: UIWindow?

  static func adopt(_ webview: WKWebView) {
    shell = webview
    // The webview may not be in its window yet; look on the next turn too.
    attach()
    DispatchQueue.main.async { attach() }
  }

  private static func attach() {
    guard let scene = scene, let old = shell?.window, old !== host,
      let root = old.rootViewController
    else { return }
    let w = host ?? UIWindow(windowScene: scene)
    old.rootViewController = nil
    old.isHidden = true
    w.rootViewController = root
    w.makeKeyAndVisible()
    host = w
    current?.window = w
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
    // Launched by a link from the share extension.
    Opened.shared.take(connectionOptions.urlContexts)
  }

  /// A link from the share extension while Flux is running.
  public func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
    Opened.shared.take(contexts)
  }
}

@_cdecl("init_plugin_flux_webview")
func initPlugin() -> Plugin {
  return FluxWebViewPlugin()
}
