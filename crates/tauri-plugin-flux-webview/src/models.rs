use serde::{Deserialize, Serialize};

// Args are sent to the Kotlin @Command via `run_mobile_plugin`; field names are
// camelCase to match the Kotlin @InvokeArg classes. Bounds are logical (CSS)
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavArgs {
    pub id: i32,
    pub url: String,
}

/// Empty response — the Kotlin commands `invoke.resolve()` with no payload.
#[derive(Deserialize, Default)]
pub struct Empty {}

/// A tab's cached cover snapshot (base64 data URL), or "" if none captured yet.
#[derive(Deserialize, Default)]
pub struct ThumbResponse {
    #[serde(default)]
    pub data: String,
}
