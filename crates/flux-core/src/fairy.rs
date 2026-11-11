//! Fairy, your assistant app (the Lyra repo), answering in the agent panel.
//!
//! Fairy listens on `flux.sock` in her data folder
//! (`~/Library/Application Support/lyra-companion/lyra/`), a socket only you can
//! open. The protocol is hers (`desktop/chat-link.mjs` in Lyra), one line of JSON
//! each way:
//!
//! ```text
//! → {type:'hello'}                ← {type:'hello', name}
//! → {type:'ask', text, context}   ← {type:'text', text} (her reply so far), …,
//!                                    then {type:'done', text} or {type:'error', message}
//! → {type:'stop'}                 stops the answer being written
//! → {type:'new'}                  ← {type:'ok'}
//! ```
//!
//! It is conversation only: Fairy gets the question and the page as material,
//! never tools. She answers on whichever subscription is her conversation model
//! (Claude, Codex, Gemini or DeepSeek), so the page leaves this Mac; the panel
//! says so. A private or Tor tab's page is never sent.
//!
//! Plain `std` sockets on a blocking thread, so this adds no dependency.

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::state::{FluxState, TabId};

/// Fairy's bundle id, to open her in the background when she isn't running.
#[cfg(target_os = "macos")]
const BUNDLE_ID: &str = "dev.razeen.lyra";
/// The most of a page's text sent with a question. Fairy keeps the start of
/// it within her own 12,000-character message limit.
const MAX_PAGE_TEXT: usize = 8_000;

/// Whether Fairy can be asked, and what she's called.
#[derive(Serialize, Clone, Debug, Default)]
pub struct FairyStatus {
    /// Fairy.app is on this Mac.
    pub installed: bool,
    /// She is running and answered `hello`.
    pub running: bool,
    pub name: Option<String>,
}

/// Her finished answer, and whether the page went with the question.
#[derive(Serialize, Clone, Debug)]
pub struct FairyReply {
    pub text: String,
    /// False for a private or Tor tab, a Flux page, or a page Flux hasn't read.
    pub with_page: bool,
}

/// The question's page context, as Fairy's `pagePrompt` takes it.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct PageContext {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub title: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub url: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub text: String,
}

impl PageContext {
    fn is_empty(&self) -> bool {
        self.title.is_empty() && self.url.is_empty() && self.text.is_empty()
    }
}

/// What may go to Fairy about a tab: nothing for a private or Tor tab or a
/// page that isn't on the web, else its title, address and the start of its
/// text (only when the snapshot is of the page the tab is on now).
pub fn page_context(
    private: bool,
    tor: bool,
    title: &str,
    url: &str,
    snapshot: Option<(&str, &str)>,
) -> PageContext {
    if private || tor || !(url.starts_with("https://") || url.starts_with("http://")) {
        return PageContext::default();
    }
    let text = snapshot
        .filter(|(snap_url, _)| *snap_url == url)
        .map(|(_, t)| cap_chars(t.trim(), MAX_PAGE_TEXT))
        .unwrap_or_default();
    PageContext {
        title: cap_chars(title.trim(), 300),
        url: url.to_string(),
        text,
    }
}

fn cap_chars(s: &str, n: usize) -> String {
    match s.char_indices().nth(n) {
        Some((at, _)) => s[..at].to_string(),
        None => s.to_string(),
    }
}

#[cfg(target_os = "macos")]
mod link {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    pub fn socket_path() -> PathBuf {
        if let Some(p) = std::env::var_os("FLUX_FAIRY_SOCKET") {
            return PathBuf::from(p);
        }
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default();
        home.join("Library/Application Support/lyra-companion/lyra/flux.sock")
    }

    pub fn installed() -> bool {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default();
        home.join("Applications/Fairy.app").exists()
            || std::path::Path::new("/Applications/Fairy.app").exists()
    }

    /// Connect, opening Fairy in the background first when `launch` and she
    /// isn't listening yet.
    pub fn connect(launch: bool) -> Result<UnixStream, String> {
        let path = socket_path();
        if let Ok(s) = UnixStream::connect(&path) {
            return Ok(s);
        }
        if !launch {
            return Err("Fairy isn't running".into());
        }
        if !installed() {
            return Err("Fairy isn't installed on this Mac".into());
        }
        let _ = std::process::Command::new("open")
            .args(["-g", "-b", super::BUNDLE_ID])
            .status();
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(250));
            if let Ok(s) = UnixStream::connect(&path) {
                return Ok(s);
            }
        }
        Err("Fairy didn't start in time; open her and ask again".into())
    }

    pub fn send(conn: &mut UnixStream, message: &serde_json::Value) -> Result<(), String> {
        let mut line = message.to_string();
        line.push('\n');
        conn.write_all(line.as_bytes()).map_err(|e| e.to_string())
    }

    /// Read reply lines until `done` (her answer) or `error`, passing each
    /// `text` (the reply so far) to `on_text`.
    pub fn read_reply(
        conn: UnixStream,
        timeout: Duration,
        mut on_text: impl FnMut(&str),
    ) -> Result<String, String> {
        conn.set_read_timeout(Some(timeout))
            .map_err(|e| e.to_string())?;
        let reader = BufReader::new(conn);
        for line in reader.lines() {
            let line = line.map_err(|e| match e.kind() {
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut => {
                    "Fairy took too long to answer".to_string()
                }
                _ => e.to_string(),
            })?;
            // A line is capped like Fairy caps hers: 1 MiB.
            if line.len() > 1 << 20 {
                return Err("Fairy's reply was too long".into());
            }
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let text = msg.get("text").and_then(|t| t.as_str()).unwrap_or("");
            match msg.get("type").and_then(|t| t.as_str()) {
                Some("text") => on_text(text),
                Some("done") => return Ok(text.to_string()),
                Some("error") => {
                    let m = msg
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("Fairy couldn't answer");
                    return Err(m.to_string());
                }
                _ => {}
            }
        }
        Err("Fairy closed the connection".into())
    }
}

/// Is Fairy here, and running?
#[tauri::command]
pub async fn fairy_status() -> FairyStatus {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(|| {
            let installed = link::installed();
            let hello = (|| -> Result<Option<String>, String> {
                let mut conn = link::connect(false)?;
                link::send(&mut conn, &serde_json::json!({ "type": "hello" }))?;
                conn.set_read_timeout(Some(std::time::Duration::from_secs(2)))
                    .map_err(|e| e.to_string())?;
                let mut line = String::new();
                std::io::BufRead::read_line(&mut std::io::BufReader::new(conn), &mut line)
                    .map_err(|e| e.to_string())?;
                let v: serde_json::Value =
                    serde_json::from_str(&line).map_err(|e| e.to_string())?;
                Ok(v.get("name").and_then(|n| n.as_str()).map(str::to_string))
            })();
            FairyStatus {
                installed,
                running: hello.is_ok(),
                name: hello.ok().flatten(),
            }
        })
        .await
        .unwrap_or_default()
    }
    #[cfg(not(target_os = "macos"))]
    {
        FairyStatus::default()
    }
}

/// Ask Fairy `question` about `tab`'s page. `on_text` gets her reply so far
/// as she writes it (each message replaces the last); the result is the whole.
#[tauri::command]
pub async fn fairy_ask(
    state: State<'_, FluxState>,
    question: String,
    tab: Option<TabId>,
    on_text: Channel<String>,
) -> Result<FairyReply, String> {
    let question = cap_chars(question.trim(), 4_000);
    if question.is_empty() {
        return Err("Ask Fairy something".into());
    }
    let context = tab
        .and_then(|id| {
            let meta = state.tabs.get(&id)?;
            let snap = state.dom_cache.get(&id).map(|s| s.clone());
            Some(page_context(
                meta.private,
                meta.tor,
                &meta.title,
                &meta.url,
                snap.as_deref().map(|s| (s.url.as_str(), &*s.text)),
            ))
        })
        .unwrap_or_default();
    let with_page = !context.is_empty();
    #[cfg(target_os = "macos")]
    {
        let text = tauri::async_runtime::spawn_blocking(move || {
            let mut conn = link::connect(true)?;
            link::send(
                &mut conn,
                // `speak`: Flux reads its agent's answers aloud, so Fairy says hers,
                // in her own voice (her window does, and stays quiet if she's muted).
                &serde_json::json!({ "type": "ask", "text": question, "context": context, "speak": true }),
            )?;
            // A reply on a subscription CLI can take a few minutes.
            link::read_reply(conn, std::time::Duration::from_secs(300), |so_far| {
                let _ = on_text.send(so_far.to_string());
            })
        })
        .await
        .map_err(|e| e.to_string())??;
        Ok(FairyReply { text, with_page })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (context, on_text, with_page);
        Err("Fairy runs on macOS".into())
    }
}

/// Stop the answer Fairy is writing.
#[tauri::command]
pub async fn fairy_stop() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(|| {
            let mut conn = link::connect(false)?;
            link::send(&mut conn, &serde_json::json!({ "type": "stop" }))
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

/// Start a new conversation with Fairy: the next question doesn't follow on.
#[tauri::command]
pub async fn fairy_new() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(|| {
            let mut conn = link::connect(false)?;
            link::send(&mut conn, &serde_json::json!({ "type": "new" }))?;
            conn.set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .map_err(|e| e.to_string())?;
            let mut line = String::new();
            std::io::BufRead::read_line(&mut std::io::BufReader::new(conn), &mut line)
                .map_err(|e| e.to_string())?;
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_tor_and_non_web_pages_send_nothing() {
        let snap = Some(("https://a.example/", "words"));
        assert!(page_context(true, false, "T", "https://a.example/", snap).is_empty());
        assert!(page_context(false, true, "T", "https://a.example/", snap).is_empty());
        assert!(page_context(false, false, "Settings", "flux://settings", None).is_empty());
    }

    #[test]
    fn a_web_page_sends_its_title_address_and_current_text() {
        let c = page_context(
            false,
            false,
            " Docs ",
            "https://a.example/",
            Some(("https://a.example/", " words ")),
        );
        assert_eq!(c.title, "Docs");
        assert_eq!(c.text, "words");
        // A snapshot of the page before this one isn't sent as this one.
        let stale = page_context(
            false,
            false,
            "Docs",
            "https://a.example/b",
            Some(("https://a.example/", "old")),
        );
        assert_eq!(stale.text, "");
        assert_eq!(stale.url, "https://a.example/b");
        let long = "é".repeat(MAX_PAGE_TEXT + 50);
        let c = page_context(
            false,
            false,
            "",
            "https://a.example/",
            Some(("https://a.example/", &long)),
        );
        assert_eq!(c.text.chars().count(), MAX_PAGE_TEXT);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_reply_streams_then_finishes() {
        use std::io::Write;
        use std::os::unix::net::UnixStream;
        let (a, mut b) = UnixStream::pair().unwrap();
        b.write_all(b"{\"type\":\"text\",\"text\":\"Hi\"}\nnot json\n{\"type\":\"done\",\"text\":\"Hi there\"}\n")
            .unwrap();
        let mut seen = Vec::new();
        let text = link::read_reply(a, std::time::Duration::from_secs(2), |t| {
            seen.push(t.to_string())
        })
        .unwrap();
        assert_eq!(text, "Hi there");
        assert_eq!(seen, ["Hi"]);
        let (a, mut b) = UnixStream::pair().unwrap();
        b.write_all(b"{\"type\":\"error\",\"message\":\"Stopped.\"}\n")
            .unwrap();
        assert_eq!(
            link::read_reply(a, std::time::Duration::from_secs(2), |_| {}).unwrap_err(),
            "Stopped."
        );
    }

    /// Against Fairy's own link code: run Lyra's `startFluxLink` with a stand-in
    /// chat on a socket, point FLUX_FAIRY_SOCKET at it and run this (ignored
    /// otherwise, since it needs that server).
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn talks_to_fairys_link() {
        let mut conn = link::connect(false).expect("a Fairy link at FLUX_FAIRY_SOCKET");
        let ctx = page_context(
            false,
            false,
            "Docs",
            "https://a.example/p",
            Some(("https://a.example/p", "words")),
        );
        link::send(
            &mut conn,
            &serde_json::json!({ "type": "ask", "text": "What is this?", "context": ctx }),
        )
        .unwrap();
        let mut seen = Vec::new();
        let text = link::read_reply(conn, std::time::Duration::from_secs(10), |t| {
            seen.push(t.to_string())
        })
        .unwrap();
        assert!(
            text.contains("<page>") && text.contains("Address: https://a.example/p"),
            "{text}"
        );
        assert!(!seen.is_empty());
    }
}
