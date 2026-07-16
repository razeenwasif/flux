//! AgentAction → JavaScript compiler.
//!
//! Every template:
//!   1. Embeds user-influenced strings ONLY via `serde_json::to_string`
//!      (JSON is a strict subset of JS string literals → injection-safe).
//!   2. Runs inside an IIFE so nothing leaks into page scope.
//!   3. Paints the Flux magenta highlight (#D100D1) on the target before
//!      acting, with a forced reflow so the user perceives intent → effect.

use crate::AgentAction;

/// JSON-encode a string for safe embedding inside a JS source template.
fn js_str(s: &str) -> String {
    serde_json::to_string(s).expect("string serialization is infallible")
}

/// Shared prelude: resolve the selector, flash the "Liquid AI" highlight.
/// `__el` is in scope for the action body that follows.
fn highlight_prelude(selector: &str) -> String {
    format!(
        r#"const __el = document.querySelector({sel});
  if (!__el) {{ window.__FLUX__?.report('not_found', {sel}); return; }}
  __el.scrollIntoView({{ block: 'center', behavior: 'instant' }});
  const __old = __el.style.cssText;
  __el.style.cssText += ';outline:2px solid #D100D1;outline-offset:2px;'
    + 'box-shadow:0 0 18px rgba(209,0,209,.55);transition:outline .12s;';
  void __el.offsetWidth; /* force reflow so the highlight paints pre-action */"#,
        sel = js_str(selector)
    )
}

/// JS that aborts a click when the resolved element's accessible name matches
/// the destructive deny-list (BACKLOG #104). The term list is generated from
/// the single Rust source of truth so it can never drift from
/// [`AgentAction::is_destructive`](crate::AgentAction::is_destructive). Runs
/// inside the click `setTimeout` body, so `return` exits before `__el.click()`.
fn destructive_guard() -> String {
    let deny = js_str_arr(crate::DESTRUCTIVE_TERMS);
    format!(
        r#"const __name = ((__el.getAttribute('aria-label') || __el.innerText || __el.value || __el.title || '') + '').slice(0, 240).toLowerCase();
    const __hit = {deny}.find(t => __name.includes(t));
    if (__hit) {{ __el.style.cssText = __old; window.__FLUX__?.report('blocked_destructive', __hit); return; }}"#
    )
}

/// JSON-encode a string slice as a JS array literal (injection-safe).
fn js_str_arr(items: &[&str]) -> String {
    serde_json::to_string(items).expect("array serialization is infallible")
}

pub fn to_js(action: &AgentAction) -> String {
    match action {
        // The click is gated by the destructive-action guard (#104): at click
        // time we read the element's *real* accessible name and abort if it
        // matches the deny-list — catching destructive controls the planner's
        // selector/reason didn't reveal (defense against prompt injection).
        AgentAction::Click { selector, .. } => format!(
            r#"(() => {{
  {prelude}
  setTimeout(() => {{
    {guard}
    __el.click();
    __el.style.cssText = __old;
    window.__FLUX__?.report('clicked', {sel});
  }}, 180); /* long enough to perceive the highlight, short enough to feel instant */
}})();"#,
            prelude = highlight_prelude(selector),
            guard = destructive_guard(),
            sel = js_str(selector),
        ),

        AgentAction::ExtractTable { selector, format } => format!(
            r#"(() => {{
  {prelude}
  /* Cell-by-cell walk — innerText respects CSS visibility, so hidden
     tracking columns don't pollute the export. */
  const rows = [...__el.querySelectorAll('tr')].map(tr =>
    [...tr.querySelectorAll('th,td')].map(c => c.innerText.trim()));
  const fmt = {fmt};
  const out = fmt === 'csv'
    ? rows.map(r => r.map(c => '"' + c.replaceAll('"', '""') + '"').join(',')).join('\n')
    : JSON.stringify(rows);
  __el.style.cssText = __old;
  /* Hand the payload back to Rust via the capture bridge; flux-core routes
     it to the terminal pane / a download, per the user's sink choice. */
  window.__FLUX__?.deliver('extract', fmt, out);
}})();"#,
            prelude = highlight_prelude(selector),
            fmt = js_str(match format {
                crate::ExtractFormat::Csv => "csv",
                crate::ExtractFormat::Json => "json",
            }),
        ),

        AgentAction::Type { selector, text } => format!(
            r#"(() => {{
  {prelude}
  __el.focus();
  /* Native setter + input event → works with React/Vue controlled inputs. */
  const proto = Object.getPrototypeOf(__el);
  const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (set) set.call(__el, {text}); else __el.value = {text};
  __el.dispatchEvent(new Event('input', {{ bubbles: true }}));
  __el.style.cssText = __old;
  window.__FLUX__?.report('typed', {sel});
}})();"#,
            prelude = highlight_prelude(selector),
            text = js_str(text),
            sel = js_str(selector),
        ),

        AgentAction::Reveal { selector } => format!(
            r#"(() => {{
  {prelude}
  setTimeout(() => {{ __el.style.cssText = __old; }}, 900);
}})();"#,
            prelude = highlight_prelude(selector),
        ),

        // Refusals never touch the page.
        AgentAction::Refuse { reason } => {
            format!("window.__FLUX__?.report('refused', {});", js_str(reason))
        }

        // Task completion — purely a signal back to the chrome; no page effect.
        AgentAction::Finish { summary } => {
            format!("window.__FLUX__?.report('finished', {});", js_str(summary))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ExtractFormat;

    /// A selector containing quote/script-breaking characters must come out
    /// the other side as inert JSON string content.
    #[test]
    fn selector_injection_is_neutralized() {
        let evil = AgentAction::Click {
            selector: r#"a"]; alert(1); //"#.into(),
            reason: "x".into(),
        };
        let js = evil.to_js();
        assert!(!js.contains(r#"a"]; alert"#)); // raw form must not appear
        assert!(js.contains(r#"\"]; alert(1); //"#)); // escaped form does
    }

    #[test]
    fn extract_emits_both_formats() {
        for fmt in [ExtractFormat::Csv, ExtractFormat::Json] {
            let js = AgentAction::ExtractTable {
                selector: "table".into(),
                format: fmt,
            }
            .to_js();
            assert!(js.contains("querySelectorAll('tr')"));
        }
    }

    #[test]
    fn click_embeds_the_destructive_guard() {
        let js = AgentAction::Click {
            selector: "button#x".into(),
            reason: "go".into(),
        }
        .to_js();
        // The guard reads the live label and reports a block before clicking.
        assert!(
            js.contains("blocked_destructive"),
            "click must carry the #104 guard"
        );
        assert!(js.contains("aria-label"));
        // Deny-list terms are baked in from the Rust source of truth.
        assert!(js.contains("\"delete\""));
        assert!(js.contains("\"refund\""));
        // The guard precedes the actual click in source order.
        let g = js.find("blocked_destructive").unwrap();
        let c = js.find("__el.click()").unwrap();
        assert!(g < c, "guard must run before the click");
    }
}
