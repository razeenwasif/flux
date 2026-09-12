//! Website compatibility identity for macOS's system WebKit.
//! Safari's installed version supplies the compatibility version, never a
//! fabricated Chrome version. Other platforms retain their engine's default UA.

#[cfg(any(target_os = "macos", test))]
fn safari_user_agent(version: &str) -> Option<String> {
    if version.len() > 32
        || !version
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    // Safari freezes the OS/engine tokens even on Apple Silicon and newer macOS.
    Some(format!("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/{version} Safari/605.1.15"))
}

#[cfg(target_os = "macos")]
pub fn user_agent() -> Option<&'static str> {
    use std::sync::OnceLock;
    static AGENT: OnceLock<Option<String>> = OnceLock::new();
    AGENT
        .get_or_init(|| installed_safari_version().and_then(|version| safari_user_agent(&version)))
        .as_deref()
}

#[cfg(target_os = "macos")]
#[allow(unexpected_cfgs)] // objc 0.2 macros probe the legacy cargo-clippy cfg.
fn installed_safari_version() -> Option<String> {
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CStr;
    objc::rc::autoreleasepool(|| unsafe {
        let path: *mut Object =
            msg_send![class!(NSString), stringWithUTF8String: c"/Applications/Safari.app".as_ptr()];
        let bundle: *mut Object = msg_send![class!(NSBundle), bundleWithPath: path];
        if bundle.is_null() {
            return None;
        }
        let key: *mut Object = msg_send![class!(NSString), stringWithUTF8String: c"CFBundleShortVersionString".as_ptr()];
        let version: *mut Object = msg_send![bundle, objectForInfoDictionaryKey: key];
        if version.is_null() {
            return None;
        }
        let value: *const std::os::raw::c_char = msg_send![version, UTF8String];
        if value.is_null() {
            return None;
        }
        CStr::from_ptr(value).to_str().ok().map(str::to_owned)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn version_tracks_installed_safari_and_rejects_non_version_values() {
        for version in ["18.6", "26.6.2", "27.0"] {
            let ua = safari_user_agent(version).unwrap();
            assert!(ua.contains(&format!("Version/{version} Safari/")));
            assert!(!ua.contains("Chrome"));
        }
        for version in ["", "26..1", ".26", "26.", "26 beta", "26\r\nX: y"] {
            assert!(safari_user_agent(version).is_none());
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn reads_installed_safari_metadata() {
        let version = installed_safari_version().expect("Safari bundle metadata");
        assert_eq!(user_agent(), safari_user_agent(&version).as_deref());
    }
}
