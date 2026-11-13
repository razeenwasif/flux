import CryptoKit
import Foundation
import Security
import UIKit

/// The phone link to Flux on your Mac (macLink.ts in the shell, phonelink.rs on
/// the Mac, ADR 0022), for the notch island's Calendar, Mail and Fairy pages.
///
/// Pairing takes the Mac's `flux-browser://pair?host=…&port=…&code=…&pin=…`
/// link and trades its one-time code for a key. The key stays here, in the
/// Keychain (this device only, never synced or backed up), and every request
/// is made from here: the shell sends a method and a path and gets the status
/// and the body back, so the key never reaches the page.
///
/// The Mac's certificate is self-signed. The pairing link carries its SHA-256,
/// and that certificate is the only thing trusted: anything else, even one a
/// certificate authority signed, is refused.
final class MacLink: NSObject, URLSessionDelegate {
  static let shared = MacLink()

  struct Pairing: Codable {
    let host: String
    let port: Int
    let pin: String
    let key: String
    let name: String
  }

  enum LinkError: LocalizedError {
    case badLink, notPaired, refused(String)
    var errorDescription: String? {
      switch self {
      case .badLink: return "That isn't a pairing link from Flux on your Mac."
      case .notPaired: return "This phone isn't paired with a Mac."
      case .refused(let m): return m
      }
    }
  }

  private let service = "dev.flux.browser.phonelink"
  private let account = "mac"
  private var session: URLSession?
  private var sessionPin = ""

  // MARK: Keychain

  func load() -> Pairing? {
    let q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
    return try? JSONDecoder().decode(Pairing.self, from: data)
  }

  func save(_ p: Pairing?) {
    let base: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    SecItemDelete(base as CFDictionary)
    guard let p = p, let data = try? JSONEncoder().encode(p) else { return }
    var add = base
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    SecItemAdd(add as CFDictionary, nil)
  }

  // MARK: The pinned session

  private func pinned(_ pin: String) -> URLSession {
    if let s = session, sessionPin == pin { return s }
    session?.invalidateAndCancel()
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 20
    config.waitsForConnectivity = false
    let s = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    session = s
    sessionPin = pin
    return s
  }

  func urlSession(
    _ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      let trust = challenge.protectionSpace.serverTrust,
      let cert = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first
    else { return completionHandler(.cancelAuthenticationChallenge, nil) }
    let found = SHA256.hash(data: SecCertificateCopyData(cert) as Data).map { String(format: "%02x", $0) }.joined()
    guard found == sessionPin else { return completionHandler(.cancelAuthenticationChallenge, nil) }
    // Still checks the name and purpose, with this certificate the only anchor.
    SecTrustSetAnchorCertificates(trust, [cert] as CFArray)
    SecTrustSetAnchorCertificatesOnly(trust, true)
    if SecTrustEvaluateWithError(trust, nil) {
      completionHandler(.useCredential, URLCredential(trust: trust))
    } else {
      completionHandler(.cancelAuthenticationChallenge, nil)
    }
  }

  // MARK: Requests

  private func send(
    _ p: (host: String, port: Int, pin: String), method: String, path: String, body: Data?, key: String?,
    timeout: TimeInterval, done: @escaping (Result<(Int, String), Error>) -> Void
  ) {
    guard let url = URL(string: "https://\(p.host):\(p.port)\(path)") else { return done(.failure(LinkError.badLink)) }
    var req = URLRequest(url: url, timeoutInterval: timeout)
    req.httpMethod = method
    if let key = key { req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization") }
    if let body = body {
      req.httpBody = body
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    pinned(p.pin).dataTask(with: req) { data, resp, err in
      if let err = err { return done(.failure(err)) }
      let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
      done(.success((status, String(data: data ?? Data(), encoding: .utf8) ?? "")))
    }.resume()
  }

  /// Pairs with the Mac a `flux-browser://pair?…` link names; resolves with
  /// the Mac's name.
  func pair(link: String, done: @escaping (Result<String, Error>) -> Void) {
    guard let c = URLComponents(string: link), c.scheme == "flux-browser", c.host == "pair" else {
      return done(.failure(LinkError.badLink))
    }
    let v = { (k: String) in c.queryItems?.first(where: { $0.name == k })?.value }
    guard let host = v("host"), host.hasSuffix(".ts.net"), let port = v("port").flatMap(Int.init),
      let code = v("code"), let pin = v("pin")?.lowercased(), pin.count == 64
    else { return done(.failure(LinkError.badLink)) }
    let body = try? JSONSerialization.data(withJSONObject: ["code": code, "name": UIDevice.current.name])
    send((host, port, pin), method: "POST", path: "/v1/pair", body: body, key: nil, timeout: 20) { r in
      switch r {
      case .failure(let e): done(.failure(e))
      case .success(let (status, text)):
        let json = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any]
        guard status == 200, let key = json?["key"] as? String else {
          return done(.failure(LinkError.refused((json?["error"] as? String) ?? "The Mac refused (\(status)).")))
        }
        let name = (json?["name"] as? String) ?? host.components(separatedBy: ".").first ?? host
        self.save(Pairing(host: host, port: port, pin: pin, key: key, name: name))
        done(.success(name))
      }
    }
  }

  /// A request to the paired Mac. Only its `/v1/` routes; a question for
  /// Fairy may take minutes.
  func request(method: String, path: String, body: String?, done: @escaping (Result<(Int, String), Error>) -> Void) {
    guard let p = load() else { return done(.failure(LinkError.notPaired)) }
    guard path.hasPrefix("/v1/"), method == "GET" || method == "POST" else { return done(.failure(LinkError.badLink)) }
    var full = path
    if path == "/v1/glance" { full += "?tz=\(TimeZone.current.secondsFromGMT() / 60)" }
    let timeout: TimeInterval = path == "/v1/fairy" ? 300 : 20
    send((p.host, p.port, p.pin), method: method, path: full, body: body.map { Data($0.utf8) }, key: p.key, timeout: timeout, done: done)
  }
}
