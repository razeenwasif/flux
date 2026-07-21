//! OAuth consent-screen decoder (ADR 0013, Pillar 1 M3).
//!
//! The subtlest deception uses a *real* domain: a genuine `accounts.google.com`
//! consent screen that grants a **malicious app** broad scopes ("read & send all
//! your email", "full Drive access"). There's no lookalike to catch — the
//! *request* is the attack. So instead of judging the domain, we decode the
//! **scopes the app is asking for** and surface the sensitive ones in plain
//! English, in the un-spoofable chrome layer, before the user clicks Allow.
//!
//! Deterministic and precise by design: routine "Sign in with Google"
//! (`openid email profile`) grants nothing sensitive, so this stays **silent**
//! for them (warning fatigue is a modeled threat) — it speaks up only when an app
//! asks for real reach into your account.

/// One requested OAuth scope, decoded for a human.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct ScopeInfo {
    /// The raw scope token (`https://www.googleapis.com/auth/gmail.modify`).
    pub scope: String,
    /// Plain-English of what it grants.
    pub plain: String,
    /// High-risk: reaches your data/account beyond basic identity.
    pub sensitive: bool,
}

/// A decoded OAuth consent request — what an app is asking to do with your
/// account. `None` from [`detect`] unless at least one scope is sensitive.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct OAuthConsent {
    /// The identity provider hosting the consent screen ("Google", "GitHub", …).
    pub provider: String,
    /// Best-effort app identity — the redirect host, else the client id.
    pub app: String,
    /// Every requested scope, decoded (sensitive ones first).
    pub scopes: Vec<ScopeInfo>,
}

/// Decode a single scope token into (plain-English, sensitive?). Substring-based
/// so it works across providers and scope-URL shapes; unknown scopes are shown
/// verbatim and treated as sensitive (fail toward informing the user).
fn describe_scope(raw: &str) -> (String, bool) {
    let s = raw.to_ascii_lowercase();
    // Basic identity — the routine, harmless SSO grants.
    if s == "openid" || s.ends_with("userinfo.profile") || s == "profile" {
        return ("See your basic profile (name, picture)".into(), false);
    }
    if s.ends_with("userinfo.email") || s == "email" {
        return ("See your email address".into(), false);
    }
    if s == "user.read" || s.ends_with("read:user") {
        return ("Read your basic profile".into(), false);
    }
    // Staying-logged-in / acting while you're away — meaningfully riskier.
    if s.contains("offline_access") || s.contains("offline") {
        return ("Keep access when you're not using the app".into(), true);
    }
    // Mail.
    if s.contains("gmail") || s.contains("mail.") || s.contains("mail.read") {
        let write = s.contains("send") || s.contains("modify") || s.contains("readwrite");
        return (
            if write {
                "Read, send, and manage your email".into()
            } else {
                "Read your email".into()
            },
            true,
        );
    }
    // Files / storage.
    if s.contains("drive") || s.contains("files.") || s.contains("onedrive") {
        return ("Access your files and storage".into(), true);
    }
    // Contacts / calendar / photos.
    if s.contains("contacts") || s.contains("people") {
        return ("Access your contacts".into(), true);
    }
    if s.contains("calendar") {
        return ("Access your calendar".into(), true);
    }
    if s.contains("photos") || s.contains("photoslibrary") {
        return ("Access your photos".into(), true);
    }
    // Source control.
    if s == "repo" || s.contains("repo,") || s.contains(",repo") || s.contains("/repo") {
        return ("Full control of your private repositories".into(), true);
    }
    if s.contains("admin:") || s.contains("delete_repo") || s.contains("write:") {
        return (format!("Administrative access: {raw}"), true);
    }
    // Cloud / full-account.
    if s.contains("cloud-platform") || s.contains("full_access") || s == "*" {
        return ("Full control of your account resources".into(), true);
    }
    // Unknown → show it and treat as sensitive so the user still decides.
    (format!("Requests “{raw}”"), true)
}

/// Split an OAuth `scope` parameter — space, `+`, or comma separated depending on
/// the provider (GitHub uses commas; most use spaces).
fn split_scopes(scope: &str) -> Vec<String> {
    scope
        .split(|c: char| c.is_whitespace() || c == ',' || c == '+')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

/// Identify the provider from the consent-screen host + path, or `None` if this
/// URL isn't a recognizable OAuth *authorize* endpoint.
fn provider_of(host: &str, path: &str) -> Option<&'static str> {
    let h = host.to_ascii_lowercase();
    let p = path.to_ascii_lowercase();
    if h == "accounts.google.com" && (p.contains("/o/oauth2/") || p.contains("/signin/oauth")) {
        return Some("Google");
    }
    if h.contains("login.microsoftonline.com") && p.contains("/oauth2/") && p.contains("/authorize") {
        return Some("Microsoft");
    }
    if h == "github.com" && p == "/login/oauth/authorize" {
        return Some("GitHub");
    }
    if h.ends_with("facebook.com") && p.contains("/dialog/oauth") {
        return Some("Facebook");
    }
    // Generic authorize endpoint (self-hosted / other IdPs).
    if p.ends_with("/authorize") || p.ends_with("/oauth/authorize") {
        return Some("this service");
    }
    None
}

/// Decode an OAuth consent screen from its URL. Returns `Some` only when the app
/// requests at least one **sensitive** scope — routine identity-only sign-in
/// (`openid email profile`) yields `None` so we don't cry wolf.
pub fn detect(url: &str) -> Option<OAuthConsent> {
    let parsed = tauri::Url::parse(url).ok()?;
    let host = parsed.host_str()?.to_string();
    let provider = provider_of(&host, parsed.path())?;

    let mut client_id = String::new();
    let mut scope_param = String::new();
    let mut redirect = String::new();
    let mut has_response_type = false;
    for (k, v) in parsed.query_pairs() {
        match k.as_ref() {
            "scope" => scope_param = v.into_owned(),
            "client_id" => client_id = v.into_owned(),
            "redirect_uri" => redirect = v.into_owned(),
            "response_type" => has_response_type = true,
            _ => {}
        }
    }
    // A consent screen has an app id and asks for scopes (or at least a grant).
    if client_id.is_empty() || (scope_param.is_empty() && !has_response_type) {
        return None;
    }

    let mut scopes: Vec<ScopeInfo> = split_scopes(&scope_param)
        .into_iter()
        .map(|raw| {
            let (plain, sensitive) = describe_scope(&raw);
            ScopeInfo { scope: raw, plain, sensitive }
        })
        .collect();
    // Speak up only when something sensitive is on the table.
    if !scopes.iter().any(|s| s.sensitive) {
        return None;
    }
    // Sensitive scopes first so the risk leads (false sorts before true).
    scopes.sort_by_key(|s| !s.sensitive);

    // Best-effort app identity: the redirect host (what receives the grant) is
    // more meaningful to a human than an opaque client id.
    let app = tauri::Url::parse(&redirect)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .filter(|h| !h.is_empty())
        .unwrap_or(client_id);

    Some(OAuthConsent { provider: provider.to_string(), app, scopes })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn google_broad_scopes_are_surfaced_app_named_by_redirect() {
        let url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=123.apps\
            &response_type=code&redirect_uri=https%3A%2F%2Fsketchy-app.com%2Fcb\
            &scope=openid%20email%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.modify";
        let c = detect(url).expect("gmail.modify is sensitive → surfaced");
        assert_eq!(c.provider, "Google");
        assert_eq!(c.app, "sketchy-app.com");
        assert_eq!(c.scopes[0].plain, "Read, send, and manage your email"); // sensitive leads
        assert!(c.scopes[0].sensitive);
        assert!(c.scopes.iter().any(|s| s.plain == "See your email address" && !s.sensitive));
    }

    #[test]
    fn routine_signin_is_silent() {
        let url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=123\
            &response_type=code&redirect_uri=https%3A%2F%2Fapp.com%2Fcb&scope=openid%20email%20profile";
        assert!(detect(url).is_none(), "identity-only sign-in must not warn");
    }

    #[test]
    fn github_comma_scopes_and_repo_control() {
        let url = "https://github.com/login/oauth/authorize?client_id=abc&scope=read:user,repo";
        let c = detect(url).unwrap();
        assert_eq!(c.provider, "GitHub");
        assert!(c.scopes.iter().any(|s| s.sensitive && s.plain.contains("repositories")));
    }

    #[test]
    fn non_oauth_url_is_ignored() {
        assert!(detect("https://accounts.google.com/ServiceLogin").is_none());
        assert!(detect("https://example.com/authorize").is_none(), "no client_id/scope");
        assert!(detect("not a url").is_none());
    }

    #[test]
    fn offline_access_alone_is_sensitive() {
        let url = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?\
            client_id=x&response_type=code&scope=User.Read%20offline_access&redirect_uri=https://a.com";
        let c = detect(url).unwrap();
        assert_eq!(c.provider, "Microsoft");
        assert!(c.scopes.iter().any(|s| s.sensitive && s.plain.contains("not using the app")));
    }
}
