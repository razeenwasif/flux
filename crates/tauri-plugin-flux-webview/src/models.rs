use serde::{Deserialize, Serialize};

// Args are sent to the Kotlin @Command / Swift @objc command via
// `run_mobile_plugin`; field names are camelCase to match the Kotlin @InvokeArg
// classes and the Swift Decodable structs. Bounds are logical (CSS)
// pixels straight from the frontend's getBoundingClientRect — the Kotlin side
// multiplies by display density to place the native view.

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenArgs {
    pub id: i32,
    pub url: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// A private tab: an in-memory data store, gone when the tab closes (iOS).
    pub ephemeral: bool,
    /// The tab's container (0 = none): its own cookie and storage jar (iOS).
    pub container: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundsArgs {
    pub id: i32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdArgs {
    pub id: i32,
}

/// Shields for the iOS tab views (ADR 0021): the content-blocker JSON to compile
/// into a WKContentRuleList (and its stamp, which names the compiled list), the
/// global switch, and the hosts where Shields is off.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShieldsArgs {
    pub path: Option<String>,
    pub stamp: Option<String>,
    pub enabled: bool,
    pub off: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavArgs {
    pub id: i32,
    pub url: String,
}

/// A tab's cached cover snapshot (base64 data URL), or "" if none captured yet.
#[derive(Deserialize, Default)]
pub struct ThumbResponse {
    #[serde(default)]
    pub data: String,
}
