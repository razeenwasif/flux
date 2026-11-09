// "Send to Flux": a share extension (ADR 0021). In Firefox, Arc, Safari or any
// app that shares a link, Share → Flux opens that link in a new Flux tab.
//
// iOS keeps each app's data to itself, so this is how tabs move from other
// browsers on the phone: one at a time, by the person, through the system's
// share sheet. The extension takes the link (a URL, or text that is one) and
// hands it to Flux as flux-browser://open?url=…, which Flux's scene delegate
// turns into a new tab. It shows no UI of its own.
//
// Extensions can't call UIApplication's open (Xcode builds them extension-API
// only), so the open goes up the responder chain to the UIApplication there and
// sends it `openURL:options:completionHandler:` through the runtime.

import UIKit
import UniformTypeIdentifiers

@objc(ShareViewController)
final class ShareViewController: UIViewController {
  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    Task { @MainActor in
      if let link = await sharedLink() { open(link) }
      extensionContext?.completeRequest(returningItems: nil)
    }
  }

  /// The first web link among what was shared.
  private func sharedLink() async -> URL? {
    let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
    for provider in items.flatMap({ $0.attachments ?? [] }) {
      if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
        let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL,
        isWeb(url)
      {
        return url
      }
      if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
        let text = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier)
          as? String,
        let url = firstLink(in: text)
      {
        return url
      }
    }
    return nil
  }

  private func isWeb(_ url: URL) -> Bool {
    ["http", "https"].contains(url.scheme?.lowercased() ?? "")
  }

  private func firstLink(in text: String) -> URL? {
    let found = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
      .firstMatch(in: text, range: NSRange(text.startIndex..., in: text))
    return found?.url.flatMap { isWeb($0) ? $0 : nil }
  }

  private func open(_ link: URL) {
    var c = URLComponents()
    c.scheme = "flux-browser"
    c.host = "open"
    c.queryItems = [URLQueryItem(name: "url", value: link.absoluteString)]
    guard let target = c.url, let appClass = NSClassFromString("UIApplication") else { return }
    let sel = NSSelectorFromString("openURL:options:completionHandler:")
    typealias Open = @convention(c) (AnyObject, Selector, NSURL, NSDictionary, AnyObject?) -> Void
    var r: UIResponder? = self
    while let cur = r {
      if cur.isKind(of: appClass), cur.responds(to: sel) {
        let open = unsafeBitCast(cur.method(for: sel), to: Open.self)
        open(cur, sel, target as NSURL, NSDictionary(), nil)
        return
      }
      r = cur.next
    }
  }
}
