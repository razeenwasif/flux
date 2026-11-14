//! Tor tabs (BACKLOG #63): a private tab whose traffic goes through Tor's SOCKS
//! port on this machine, the Tor daemon's 9050 or Tor Browser's 9150. Flux
//! doesn't run Tor; it finds one that's running.
//!
//! The tab's webview gets the proxy (wry's per-store proxy; on macOS 14 and
//! later, and its store is private to it, so no other tab is routed), the
//! fingerprint defences like any tab, and no WebRTC: a peer connection would
//! reach out directly and tell the far side the machine's real address.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

/// Where a running Tor listens: the daemon, then Tor Browser.
const PORTS: [u16; 2] = [9050, 9150];

/// The port of a Tor that's running here, if one is. Something else listening
/// on one of Tor's ports (an `ssh -D` tunnel, another SOCKS proxy) doesn't
/// count (audit S33): a tab badged as Tor that went out through an ordinary
/// proxy would be worse than no Tor tab.
pub fn port() -> Option<u16> {
    PORTS.into_iter().find(|&p| is_tor(p))
}

/// What Tor's SOCKS port says to a plain HTTP request. Tor answers one with a
/// page explaining the mistake; no other SOCKS server claims to be Tor.
const TOR_BANNER: &[u8] = b"Tor is not an HTTP Proxy";

/// Whether the listener on this machine's `port` is Tor's SOCKS port.
pub fn is_tor(port: u16) -> bool {
    let wait = Duration::from_millis(300);
    let Ok(mut stream) =
        TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), wait)
    else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(wait));
    let _ = stream.set_write_timeout(Some(wait));
    if stream.write_all(b"GET / HTTP/1.0\r\n\r\n").is_err() {
        return false;
    }
    // The banner is in the status line; a few hundred bytes hold it. One
    // deadline for the whole answer: the read timeout is per read, and a
    // listener sending a byte at a time would otherwise hold this for minutes.
    let deadline = std::time::Instant::now() + 2 * wait;
    let mut head = Vec::with_capacity(256);
    let mut buf = [0u8; 256];
    while head.len() < 512 && std::time::Instant::now() < deadline {
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => head.extend_from_slice(&buf[..n]),
        }
        if says_tor(&head) {
            return true;
        }
    }
    says_tor(&head)
}

fn says_tor(reply: &[u8]) -> bool {
    reply
        .windows(TOR_BANNER.len())
        .any(|w| w.eq_ignore_ascii_case(TOR_BANNER))
}

/// The proxy a Tor tab's webview is built with.
pub fn proxy_url(port: u16) -> tauri::Url {
    format!("socks5://127.0.0.1:{port}")
        .parse()
        .expect("a fixed socks5 URL parses")
}

/// Whether this system can route one webview through a proxy. WebKit can from
/// macOS 14; elsewhere wry always can.
pub fn supported() -> bool {
    #[cfg(target_os = "macos")]
    {
        use objc::runtime::{Object, BOOL, NO};
        use objc::{class, msg_send, sel, sel_impl};
        #[repr(C)]
        struct Version {
            major: isize,
            minor: isize,
            patch: isize,
        }
        unsafe {
            let info: *mut Object = msg_send![class!(NSProcessInfo), processInfo];
            let at_least: BOOL = msg_send![info, isOperatingSystemAtLeastVersion: Version {
                major: 14,
                minor: 0,
                patch: 0,
            }];
            at_least != NO
        }
    }
    // Phones: the native tab views (ADR 0012/0021) take no proxy, so a Tor tab
    // there would connect directly (audit S34).
    #[cfg(mobile)]
    {
        false
    }
    #[cfg(all(desktop, not(target_os = "macos")))]
    {
        true
    }
}

/// Turn WebRTC off in a WKWebView's preferences, through WebKit's private
/// `_setPeerConnectionEnabled:` (checked with respondsToSelector, so a WebKit
/// without it is left alone; NO_WEBRTC_JS still runs in every frame).
#[cfg(target_os = "macos")]
pub fn disable_webrtc(wk: *mut objc::runtime::Object) {
    use objc::runtime::{Object, BOOL, NO};
    use objc::{msg_send, sel, sel_impl};
    if wk.is_null() {
        return;
    }
    unsafe {
        let config: *mut Object = msg_send![wk, configuration];
        if config.is_null() {
            return;
        }
        let prefs: *mut Object = msg_send![config, preferences];
        if prefs.is_null() {
            return;
        }
        let can: BOOL = msg_send![prefs, respondsToSelector: sel!(_setPeerConnectionEnabled:)];
        if can != NO {
            let _: () = msg_send![prefs, _setPeerConnectionEnabled: NO];
        } else {
            tracing::warn!(target: "flux::tor", "this WebKit can't turn WebRTC off; the page script is the only guard");
        }
    }
}

/// Every frame of a Tor tab, before the page: WebRTC isn't there to use.
pub const NO_WEBRTC_JS: &str = r#"(function () {
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCRtpSender", "RTCRtpReceiver", "RTCRtpTransceiver", "RTCIceCandidate", "RTCSessionDescription"]) {
    try { Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false }); } catch (_) {}
  }
})();"#;

/// Whether a Tor is running, and on which port: for the shell, before it opens
/// a Tor tab.
#[tauri::command]
pub async fn tor_status() -> Option<u16> {
    if !supported() {
        return None;
    }
    tauri::async_runtime::spawn_blocking(port)
        .await
        .ok()
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A listener on this machine that answers one connection with `reply`.
    fn answering(reply: &'static [u8]) -> u16 {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut conn, _)) = listener.accept() {
                let mut request = [0u8; 64];
                let _ = conn.read(&mut request);
                let _ = conn.write_all(reply);
            }
        });
        port
    }

    #[test]
    fn only_a_listener_that_says_it_is_tor_counts() {
        assert!(is_tor(answering(
            b"HTTP/1.0 501 Tor is not an HTTP Proxy\r\nContent-Type: text/html\r\n\r\n<html>"
        )));
        // Another SOCKS proxy on Tor's port, such as `ssh -D 9050`, hangs up or
        // answers something else.
        assert!(!is_tor(answering(b"")));
        assert!(!is_tor(answering(b"\x05\xff")));
        assert!(!is_tor(answering(b"HTTP/1.1 400 Bad Request\r\n\r\n")));
        // Nothing listening at all.
        let closed = {
            let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
            l.local_addr().unwrap().port()
        };
        assert!(!is_tor(closed));
    }

    #[test]
    fn the_proxy_is_socks5_on_this_machine() {
        assert_eq!(proxy_url(9050).as_str(), "socks5://127.0.0.1:9050");
    }

    #[test]
    fn webrtc_is_taken_away_not_left_half_there() {
        for name in [
            "RTCPeerConnection",
            "webkitRTCPeerConnection",
            "RTCDataChannel",
        ] {
            assert!(NO_WEBRTC_JS.contains(&format!("\"{name}\"")), "{name}");
        }
    }
}
