//! Native `android.webkit.WebView` stack for Flux tabs on Android (ADR 0012,
//! Milestone 2). Android has a single system WebView showing the Flux shell and
//! no per-tab child-webview API, so this plugin manages real WebViews in a
//! FrameLayout overlay positioned over the content card — the mobile analogue of
//! the desktop multi-webview layer (`flux-core::webview`).
//!
//! Flux calls this from Rust (`webview.rs`'s mobile arm) via `run_mobile_plugin`,
//! not from the webview, so there is no JS command/permission surface. On desktop
//! the plugin compiles to a no-op shell so the workspace still builds everywhere.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod error;
mod models;

pub use error::{Error, Result};
pub use models::*;

/// Handle to the native WebView-stack plugin, managed into Tauri state.
pub struct FluxWebview<R: Runtime> {
    #[cfg(mobile)]
    handle: tauri::plugin::PluginHandle<R>,
    // `fn() -> R` keeps the marker Send + Sync + 'static regardless of R, so the
    // desktop no-op handle can still be `.manage()`d into Tauri state.
    #[cfg(not(mobile))]
    _marker: std::marker::PhantomData<fn() -> R>,
}

impl<R: Runtime> FluxWebview<R> {
    /// Create/attach a native WebView for `id`, positioned + loading `url`.
    pub fn open(&self, args: OpenArgs) -> Result<()> {
        self.call("open", args)
    }
    /// Reposition an existing WebView (the card moved/resized).
    pub fn set_bounds(&self, args: BoundsArgs) -> Result<()> {
        self.call("setBounds", args)
    }
    pub fn show(&self, id: i32) -> Result<()> {
        self.call("show", IdArgs { id })
    }
    pub fn hide(&self, id: i32) -> Result<()> {
        self.call("hide", IdArgs { id })
    }
    pub fn close(&self, id: i32) -> Result<()> {
        self.call("close", IdArgs { id })
    }
    pub fn navigate(&self, id: i32, url: String) -> Result<()> {
        self.call("navigate", NavArgs { id, url })
    }
    pub fn back(&self, id: i32) -> Result<()> {
        self.call("goBack", IdArgs { id })
    }
    pub fn forward(&self, id: i32) -> Result<()> {
        self.call("goForward", IdArgs { id })
    }
    pub fn reload(&self, id: i32) -> Result<()> {
        self.call("reload", IdArgs { id })
    }

    /// A tab's cached cover snapshot (base64 data URL), "" if none yet. Pulled on
    /// demand because images are too large for the plugin event channel.
    pub fn thumbnail(&self, id: i32) -> Result<String> {
        #[cfg(mobile)]
        {
            let r: ThumbResponse = self.handle.run_mobile_plugin("thumbnail", IdArgs { id })?;
            Ok(r.data)
        }
        #[cfg(not(mobile))]
        {
            let _ = id;
            Ok(String::new())
        }
    }

    #[cfg(mobile)]
    fn call(&self, cmd: &str, payload: impl serde::Serialize) -> Result<()> {
        let _: Empty = self.handle.run_mobile_plugin(cmd, payload)?;
        Ok(())
    }
    #[cfg(not(mobile))]
    fn call(&self, _cmd: &str, _payload: impl serde::Serialize) -> Result<()> {
        Ok(()) // desktop has its own native webviews; this plugin is inert here
    }
}

/// `app.flux_webview()` accessor on any [`Manager`].
pub trait FluxWebviewExt<R: Runtime> {
    fn flux_webview(&self) -> &FluxWebview<R>;
}

impl<R: Runtime, T: Manager<R>> FluxWebviewExt<R> for T {
    fn flux_webview(&self) -> &FluxWebview<R> {
        self.state::<FluxWebview<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("flux-webview")
        .setup(|app, api| {
            #[cfg(mobile)]
            let handle = api.register_android_plugin("dev.flux.webview", "FluxWebViewPlugin")?;
            #[cfg(not(mobile))]
            let _ = api;
            app.manage(FluxWebview::<R> {
                #[cfg(mobile)]
                handle,
                #[cfg(not(mobile))]
                _marker: std::marker::PhantomData,
            });
            Ok(())
        })
        .build()
}
