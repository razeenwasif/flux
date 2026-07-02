//! Typed errors for flux-core (Phase 2 refactor).
//!
//! Commands historically return `Result<T, String>` — the string crosses IPC
//! and the frontend shows it. That contract stays: `FluxError` converts into
//! `String` at the command boundary (`?` just works in a
//! `Result<T, String>`-returning command), so nothing changes on the wire or
//! in the generated bindings. What it buys inside the crate:
//!
//! * `?` on io/json/http errors instead of `.map_err(|e| e.to_string())`
//!   at every call site;
//! * named error kinds (`NotFound`, `Locked`, `Invalid`) that internal code
//!   can match on instead of comparing strings;
//! * one place to evolve toward structured IPC errors later (the enum already
//!   serializes) without touching every module again.
//!
//! Adopt module-by-module: internal fns return `Result<T, FluxError>`, the
//! `#[tauri::command]` wrapper keeps `Result<T, String>`.

/// Crate-wide error type. Message formatting matches what the previous
/// `e.to_string()` conversions produced closely enough for the UI.
#[derive(Debug, thiserror::Error)]
pub enum FluxError {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    /// Network / HTTP failure (ureq or manual status checks).
    #[error("{0}")]
    Http(String),
    /// A named thing the caller asked for doesn't exist ("no such tab").
    #[error("no such {0}")]
    NotFound(&'static str),
    /// A store that must be unlocked first (vault).
    #[error("{0} is locked")]
    Locked(&'static str),
    /// Caller-supplied input failed validation.
    #[error("{0}")]
    Invalid(String),
    /// Anything else — the migration bucket for today's ad-hoc strings.
    #[error("{0}")]
    Other(String),
}

/// Keeps the IPC contract: commands still return `Result<T, String>`.
impl From<FluxError> for String {
    fn from(e: FluxError) -> Self {
        e.to_string()
    }
}

impl From<ureq::Error> for FluxError {
    fn from(e: ureq::Error) -> Self {
        FluxError::Http(e.to_string())
    }
}

impl From<String> for FluxError {
    fn from(s: String) -> Self {
        FluxError::Other(s)
    }
}

impl From<&str> for FluxError {
    fn from(s: &str) -> Self {
        FluxError::Other(s.to_string())
    }
}

impl serde::Serialize for FluxError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Blanket-friendly alias for internal functions.
pub type FluxResult<T> = Result<T, FluxError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_to_the_ipc_string_contract() {
        let s: String = FluxError::NotFound("tab").into();
        assert_eq!(s, "no such tab");
        let s: String = FluxError::Invalid("currency code must be 3 letters".into()).into();
        assert_eq!(s, "currency code must be 3 letters");
    }

    #[test]
    fn io_and_json_auto_convert() {
        fn inner() -> FluxResult<()> {
            let _: serde_json::Value = serde_json::from_str("not json")?;
            Ok(())
        }
        assert!(matches!(inner().unwrap_err(), FluxError::Json(_)));
    }
}
