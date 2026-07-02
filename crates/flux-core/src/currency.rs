//! Live currency rates for the converter widget (#130) — fetched server-side via
//! the European Central Bank reference rates (frankfurter.app, no key, no user
//! data sent). Frontend can't fetch cross-origin under the app CSP, so this Tauri
//! command proxies it (same pattern as the calendar ICS fetch).

use std::collections::HashMap;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::error::{FluxError, FluxResult};

#[derive(Serialize, Clone, specta::Type)]
pub struct CurrencyRates {
    pub base: String,
    /// `YYYY-MM-DD` the rates are quoted for.
    pub date: String,
    /// `code → units of `code` per 1 `base`` (includes `base: 1.0`).
    pub rates: HashMap<String, f64>,
}

#[tauri::command]
pub async fn currency_rates(base: String) -> Result<CurrencyRates, String> {
    let base = base.trim().to_uppercase();
    if base.len() != 3 || !base.chars().all(|c| c.is_ascii_alphabetic()) {
        return Err(FluxError::Invalid("currency code must be 3 letters".into()).into());
    }
    tauri::async_runtime::spawn_blocking(move || fetch_rates(base))
        .await
        .map_err(|e| e.to_string())?
        .map_err(String::from)
}

/// Blocking fetch + parse. Typed errors internally (`?` on ureq/serde); the
/// command converts to the IPC `String` at the boundary.
fn fetch_rates(base: String) -> FluxResult<CurrencyRates> {
    let url = format!("https://api.frankfurter.app/latest?from={base}");
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(8))
        .timeout_read(Duration::from_secs(15))
        .build();
    let resp = agent.get(&url).set("User-Agent", "Flux/1.0").call()?;
    let json: Value = resp.into_json()?;
    let date = json.get("date").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut rates = HashMap::new();
    rates.insert(base.clone(), 1.0);
    if let Some(obj) = json.get("rates").and_then(|v| v.as_object()) {
        for (k, v) in obj {
            if let Some(f) = v.as_f64() {
                rates.insert(k.clone(), f);
            }
        }
    }
    if rates.len() <= 1 {
        return Err(FluxError::Http("no rates returned".into()));
    }
    Ok(CurrencyRates { base, date, rates })
}
