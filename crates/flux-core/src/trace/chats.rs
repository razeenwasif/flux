//! Per-page chat threads bound to Visits (ADR 0011 step d).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

use super::now_ms;
use super::store::{Visit, VisitId};

// ─── Per-page chat (ADR 0011 step d) ─────────────────────────────────────────
// A Gemma conversation *attached to a Visit*: ask questions about a page and the
// thread is still there when you return months later. Grounded in the visit's
// dwell snapshot text. Own store/file (chats are user words — they must never
// ride along in graph payloads), same lifecycle as the other trace stores, and
// forgotten together with the visit (`trace_forget` cascades).

/// Keep a conversation bounded: the newest messages win.
const MAX_CHAT_MSGS: usize = 200;
/// How much prior conversation the model sees per turn.
const CHAT_CONTEXT_TURNS: usize = 12;
/// How much of the snapshot text grounds the chat (same budget as the agent's
/// page prompts — a 12B model degrades long before the window fills).
const CHAT_PAGE_BUDGET: usize = 6 * 1024;

/// One message in a visit's chat thread.
#[derive(Serialize, Deserialize, Clone, specta::Type)]
pub struct ChatMsg {
    /// "user" | "assistant"
    pub role: String,
    pub text: String,
    pub ms: u64,
}

#[derive(Default, Serialize, Deserialize)]
struct ChatData {
    /// visit id → its thread (serde_json stringifies the integer keys).
    chats: HashMap<VisitId, Vec<ChatMsg>>,
}

/// Per-visit chat threads — persisted to `trace/chats.json`.
#[derive(Default)]
pub struct TraceChats {
    inner: RwLock<ChatData>,
    path: Option<PathBuf>,
    dirty: AtomicBool,
    hydrated: AtomicBool,
}

impl TraceChats {
    pub fn empty(path: PathBuf) -> Self {
        Self {
            path: Some(path),
            ..Default::default()
        }
    }

    /// Load from disk, exactly once (lazy, race-proof — see [`TraceStore::hydrate`]).
    pub fn hydrate(&self) {
        if self.hydrated.swap(true, Ordering::AcqRel) {
            return;
        }
        let Some(path) = &self.path else { return };
        let Some((json, was_plaintext)) = super::sealed::load_string(path) else {
            return;
        };
        let Some(loaded) = serde_json::from_str::<ChatData>(&json).ok() else {
            return;
        };
        if was_plaintext {
            // Legacy pre-encryption file: rewrite sealed on the next flush.
            self.dirty.store(true, Ordering::Relaxed);
        }
        let mut d = self.inner.write();
        if d.chats.is_empty() {
            d.chats = loaded.chats;
        }
    }

    /// A visit's thread (empty if none yet).
    pub fn get(&self, visit: VisitId) -> Vec<ChatMsg> {
        self.hydrate();
        self.inner
            .read()
            .chats
            .get(&visit)
            .cloned()
            .unwrap_or_default()
    }

    /// Whether a (non-empty) thread is attached — no clone, for the ambient
    /// watcher's "you may have worked this problem there" flag.
    pub fn has_thread(&self, visit: VisitId) -> bool {
        self.hydrate();
        self.inner
            .read()
            .chats
            .get(&visit)
            .is_some_and(|t| !t.is_empty())
    }

    /// Append one message, dropping the oldest beyond the per-visit cap.
    pub fn append(&self, visit: VisitId, role: &str, text: &str) {
        self.hydrate();
        {
            let mut d = self.inner.write();
            let thread = d.chats.entry(visit).or_default();
            thread.push(ChatMsg {
                role: role.into(),
                text: text.into(),
                ms: now_ms(),
            });
            if thread.len() > MAX_CHAT_MSGS {
                let over = thread.len() - MAX_CHAT_MSGS;
                thread.drain(0..over);
            }
        }
        self.dirty.store(true, Ordering::Relaxed);
    }

    /// Drop the threads of forgotten visits (cascade from `trace_forget`).
    pub fn forget_visits(&self, visits: &std::collections::HashSet<VisitId>) {
        if visits.is_empty() {
            return;
        }
        self.hydrate();
        let mut d = self.inner.write();
        let before = d.chats.len();
        d.chats.retain(|vid, _| !visits.contains(vid));
        if d.chats.len() != before {
            drop(d);
            self.dirty.store(true, Ordering::Relaxed);
        }
    }

    pub fn persist_if_dirty(&self) {
        if !self.dirty.swap(false, Ordering::Relaxed) {
            return;
        }
        let Some(path) = &self.path else { return };
        let d = self.inner.read();
        super::sealed::save_json_sealed(path, &*d);
    }
}

/// Build the grounded per-page prompt: page context (title/url + snapshot text if
/// captured), the recent thread, then the new message. Shared by the command and
/// its test so the shape can't drift silently.
pub(super) fn chat_prompt(
    visit: &Visit,
    snapshot_text: Option<&str>,
    thread: &[ChatMsg],
    message: &str,
) -> String {
    let mut p = String::from(
        "You are Flux's research assistant. The user is asking about a specific web \
         page from their browsing trail. Ground your answer in the page's captured \
         text below; when the answer isn't in it, say so plainly instead of guessing.\n\n",
    );
    p.push_str(&format!(
        "PAGE: {} ({})\n",
        if visit.title.trim().is_empty() {
            &visit.url
        } else {
            &visit.title
        },
        visit.url
    ));
    match snapshot_text {
        Some(t) if !t.trim().is_empty() => {
            let mut capped = t;
            if capped.len() > CHAT_PAGE_BUDGET {
                let mut end = CHAT_PAGE_BUDGET;
                while !capped.is_char_boundary(end) {
                    end -= 1;
                }
                capped = &capped[..end];
            }
            p.push_str(&format!("CAPTURED TEXT:\n{capped}\n\n"));
        }
        _ => p.push_str("CAPTURED TEXT: (none — the page wasn't captured; answer from the title/URL and say you don't have its content)\n\n"),
    }
    let recent = thread.iter().rev().take(CHAT_CONTEXT_TURNS).rev();
    let mut any = false;
    for m in recent {
        if !any {
            p.push_str("CONVERSATION SO FAR:\n");
            any = true;
        }
        p.push_str(&format!("{}: {}\n", m.role, m.text));
    }
    if any {
        p.push('\n');
    }
    p.push_str(&format!("USER: {message}"));
    p
}

#[cfg(test)]
mod tests {
    use super::super::store::{Provenance, Visit};
    use super::*;
    #[test]
    fn chat_appends_caps_persists_and_forgets() {
        let dir = std::env::temp_dir().join(format!("flux-trace-chat-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("chats.json");
        let c = TraceChats::empty(path.clone());
        c.append(7, "user", "what's this page about?");
        c.append(7, "assistant", "it's about rust lifetimes");
        assert_eq!(c.get(7).len(), 2);
        assert_eq!(c.get(7)[0].role, "user");
        // Cap: the newest messages win.
        for i in 0..(MAX_CHAT_MSGS + 10) {
            c.append(9, "user", &format!("m{i}"));
        }
        assert_eq!(c.get(9).len(), MAX_CHAT_MSGS);
        assert_eq!(
            c.get(9).last().unwrap().text,
            format!("m{}", MAX_CHAT_MSGS + 9)
        );
        // Persist + lazy re-hydrate round-trips (integer map keys included).
        c.persist_if_dirty();
        let c2 = TraceChats::empty(path);
        assert_eq!(c2.get(7).len(), 2, "thread survives restart");
        // Forget cascade drops the thread.
        c2.forget_visits(&std::collections::HashSet::from([7]));
        assert!(c2.get(7).is_empty());
        assert_eq!(c2.get(9).len(), MAX_CHAT_MSGS, "unrelated thread kept");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn chat_prompt_grounds_in_snapshot_and_recent_turns() {
        let v = Visit {
            id: 1,
            url: "https://ex.com/paper".into(),
            title: "A Paper".into(),
            first_ms: 0,
            last_ms: 0,
            hits: 1,
            why: Provenance::default(),
            snapshot_id: Some(0),
            entities: Vec::new(),
        };
        let thread: Vec<ChatMsg> = (0..20)
            .map(|i| ChatMsg {
                role: if i % 2 == 0 {
                    "user".into()
                } else {
                    "assistant".into()
                },
                text: format!("t{i}"),
                ms: 0,
            })
            .collect();
        let p = chat_prompt(
            &v,
            Some("the captured body text"),
            &thread,
            "and the newest question?",
        );
        assert!(p.contains("PAGE: A Paper (https://ex.com/paper)"));
        assert!(p.contains("CAPTURED TEXT:\nthe captured body text"));
        // Only the newest CHAT_CONTEXT_TURNS turns are included.
        assert!(!p.contains("t0"), "oldest turns are dropped");
        assert!(p.contains("t19"));
        assert!(p.ends_with("USER: and the newest question?"));
        // No snapshot → the model is told so, instead of silently hallucinating.
        let p2 = chat_prompt(&v, None, &[], "q");
        assert!(p2.contains("CAPTURED TEXT: (none"));
    }
}
