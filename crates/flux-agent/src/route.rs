//! Local-first backend routing (#175).
//!
//! Flux runs its agent on the user's own machine. This module adds one
//! deliberately awkward exception: a cloud backend the user can switch on for a
//! single session, for the jobs a local model genuinely can't do.
//!
//! Three properties, in priority order, because this is a privacy boundary and
//! not a performance knob:
//!
//!   1. **Local is the default and the fallback.** Cloud is used only when it is
//!      both switched on *and* configured. Every other state — no key, key
//!      removed, backend failed to build — runs locally. Nothing here can fail
//!      *toward* the network.
//!   2. **The switch does not persist.** It lives in an atomic, not on disk, so
//!      every launch starts local. A toggle you flipped last week for one folder
//!      of PDFs must not silently be shipping your browsing to a third party
//!      today. This is the same shape as the voice stack's "off by default".
//!   3. **The state is legible.** [`status`] reports what will actually happen,
//!      not what was requested, so the UI can show the truth rather than the
//!      intent.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::RwLock;

use crate::{AgentError, Inference};

/// Whether the user has switched cloud escalation on **for this session**.
///
/// Deliberately not persisted — see the module docs. Process-wide rather than
/// thread-local because the agent runs each completion on its own blocking
/// thread, so a thread-local would be invisible to the work it's meant to route.
static CLOUD_ON: AtomicBool = AtomicBool::new(false);

/// What the router will actually do with the next request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct RouteStatus {
    /// The user asked for cloud.
    pub requested: bool,
    /// Escalation is *possible* — a credential exists. Note this is deliberately
    /// **not** "a backend is installed": the backend is only built when the user
    /// escalates, so gating the offer on that would be a deadlock (you could
    /// never turn on the thing that installs the backend).
    pub available: bool,
    /// The next request will leave this machine.
    pub active: bool,
}

pub struct RoutingBackend {
    local: Box<dyn Inference>,
    /// `None` until a key is supplied. Held behind a lock because the key can be
    /// set, changed, or cleared while the browser is running.
    cloud: RwLock<Option<Box<dyn Inference>>>,
}

impl RoutingBackend {
    pub fn new(local: Box<dyn Inference>) -> Self {
        Self {
            local,
            cloud: RwLock::new(None),
        }
    }

    /// Install (or with `None`, remove) the cloud backend.
    ///
    /// Removing it also switches escalation **off**: leaving the flag set while
    /// the backend is gone would mean a later key entry silently resumes sending
    /// prompts off-device, which is not a decision this function is allowed to
    /// make on the user's behalf.
    pub fn set_cloud(&self, backend: Option<Box<dyn Inference>>) {
        let removing = backend.is_none();
        if let Ok(mut g) = self.cloud.write() {
            *g = backend;
        }
        if removing {
            CLOUD_ON.store(false, Ordering::SeqCst);
        }
    }

    pub fn has_cloud(&self) -> bool {
        self.cloud.read().map(|g| g.is_some()).unwrap_or(false)
    }

    /// True when this request will go to the cloud. A poisoned lock reads as
    /// "no cloud", which routes locally — the safe direction.
    fn use_cloud(&self) -> bool {
        CLOUD_ON.load(Ordering::SeqCst) && self.has_cloud()
    }

    /// Run `f` against whichever backend is in force.
    ///
    /// Taking the read lock for the duration is what makes a key cleared
    /// mid-request safe: the clear waits rather than dropping the backend out
    /// from under a call that is already talking to it.
    fn with<T>(&self, f: impl FnOnce(&dyn Inference) -> T) -> T {
        if self.use_cloud() {
            if let Ok(g) = self.cloud.read() {
                if let Some(b) = g.as_ref() {
                    return f(b.as_ref());
                }
            }
        }
        f(self.local.as_ref())
    }
}

impl Inference for RoutingBackend {
    fn complete(
        &self,
        prompt: &str,
        schema: Option<&serde_json::Value>,
    ) -> Result<String, AgentError> {
        self.with(|b| b.complete(prompt, schema))
    }

    fn chat(&self, prompt: &str) -> Result<String, AgentError> {
        self.with(|b| b.chat(prompt))
    }

    fn chat_stream(
        &self,
        prompt: &str,
        on_token: &mut dyn FnMut(&str),
    ) -> Result<String, AgentError> {
        self.with(|b| b.chat_stream(prompt, on_token))
    }
}

/// Delegating impl so the planner can own the router while the command layer
/// keeps a handle to it — the key can be set long after the planner is built,
/// and something has to be able to reach in and install the backend.
impl Inference for std::sync::Arc<RoutingBackend> {
    fn complete(
        &self,
        prompt: &str,
        schema: Option<&serde_json::Value>,
    ) -> Result<String, AgentError> {
        (**self).complete(prompt, schema)
    }

    fn chat(&self, prompt: &str) -> Result<String, AgentError> {
        (**self).chat(prompt)
    }

    fn chat_stream(
        &self,
        prompt: &str,
        on_token: &mut dyn FnMut(&str),
    ) -> Result<String, AgentError> {
        (**self).chat_stream(prompt, on_token)
    }
}

/// Ask for cloud escalation. Honoured only while a cloud backend is installed;
/// [`status`] reports whether it actually took.
pub fn request_cloud(on: bool) {
    CLOUD_ON.store(on, Ordering::SeqCst);
}

/// What the next request will do, given the request and reality.
///
/// Two different facts, and conflating them was a bug: `can_escalate` is whether
/// a credential exists (this crate has no keyring, so the caller supplies it) and
/// decides whether escalation is *offered*; `has_backend` is whether a cloud
/// backend is installed right now and decides whether it is *happening*. Gating
/// the offer on `has_backend` deadlocks, because the backend is only built when
/// the user escalates.
pub fn status(can_escalate: bool, has_backend: bool) -> RouteStatus {
    let requested = CLOUD_ON.load(Ordering::SeqCst);
    RouteStatus {
        requested,
        available: can_escalate,
        active: requested && has_backend,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// The routing flag is process-wide, so these tests must not interleave.
    static SERIAL: Mutex<()> = Mutex::new(());

    struct Say(&'static str);
    impl Inference for Say {
        fn complete(&self, _: &str, _: Option<&serde_json::Value>) -> Result<String, AgentError> {
            Ok(self.0.into())
        }
        fn chat(&self, _: &str) -> Result<String, AgentError> {
            Ok(self.0.into())
        }
    }

    fn router() -> RoutingBackend {
        RoutingBackend::new(Box::new(Say("local")))
    }

    #[test]
    fn defaults_to_local_and_stays_there_without_a_cloud_backend() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        request_cloud(false);
        let r = router();
        assert_eq!(r.chat("x").unwrap(), "local");

        // Asking for cloud with none configured must NOT fail — it runs locally.
        request_cloud(true);
        assert_eq!(r.chat("x").unwrap(), "local", "must fall back, not error");
        assert_eq!(
            status(false, r.has_cloud()),
            RouteStatus {
                requested: true,
                available: false,
                active: false
            },
            "status reports what will happen, not what was asked"
        );
        request_cloud(false);
    }

    #[test]
    fn routes_to_cloud_only_when_switched_on_and_configured() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        request_cloud(false);
        let r = router();
        r.set_cloud(Some(Box::new(Say("cloud"))));

        // Configured but not requested ⇒ still local. Installing a key is not
        // consent to use it.
        assert_eq!(r.chat("x").unwrap(), "local");
        assert!(!status(true, r.has_cloud()).active);

        request_cloud(true);
        assert_eq!(r.chat("x").unwrap(), "cloud");
        assert!(status(true, r.has_cloud()).active);
        request_cloud(false);
    }

    /// Regression: `available` once meant "a backend is installed", which is only
    /// true *after* escalating — and the UI gates the escalate button on
    /// `available`. So the button never appeared, and a user who had just pasted a
    /// valid key was told escalation "needs an API key". The offer must depend on
    /// the credential existing, not on the backend the offer would create.
    #[test]
    fn offers_escalation_from_a_stored_key_alone() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        request_cloud(false);
        let r = router();
        // Key stored, nothing escalated yet: exactly the state after saving a key
        // in Settings.
        assert!(!r.has_cloud(), "no backend built until escalation");
        let st = status(true, r.has_cloud());
        assert!(st.available, "a stored key must make escalation available");
        assert!(!st.active, "…without routing anything anywhere yet");
    }

    #[test]
    fn clearing_the_key_also_revokes_the_request() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let r = router();
        r.set_cloud(Some(Box::new(Say("cloud"))));
        request_cloud(true);
        assert_eq!(r.chat("x").unwrap(), "cloud");

        r.set_cloud(None);
        assert_eq!(r.chat("x").unwrap(), "local");
        // The flag must be down too: otherwise entering a key later would
        // silently resume sending prompts off-device.
        assert!(
            !status(true, false).requested,
            "removing the backend must revoke the request, not just park it"
        );
        request_cloud(false);
    }

    #[test]
    fn every_entry_point_routes_the_same_way() {
        // A method that forgot to route would quietly send some traffic to the
        // wrong backend — the streaming path is the easy one to miss.
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let r = router();
        r.set_cloud(Some(Box::new(Say("cloud"))));
        request_cloud(true);

        assert_eq!(r.chat("x").unwrap(), "cloud");
        assert_eq!(r.complete("x", None).unwrap(), "cloud");
        let mut seen = String::new();
        r.chat_stream("x", &mut |t| seen.push_str(t)).unwrap();
        assert_eq!(seen, "cloud", "chat_stream must route like the others");
        request_cloud(false);
    }
}
