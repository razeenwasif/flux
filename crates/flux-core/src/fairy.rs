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
    use std::io::{BufRead, BufReader, Read, Write};
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

    /// The next line from Fairy: None at the end, or past the timeout set
    /// on the stream. Capped like Fairy caps hers, at 1 MiB.
    fn next_line(reader: &mut BufReader<UnixStream>) -> Result<Option<String>, String> {
        let mut line = String::new();
        match (&mut *reader).take(1 << 20).read_line(&mut line) {
            Ok(0) => Ok(None),
            Ok(_) => Ok(Some(line)),
            Err(e) => match e.kind() {
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut => {
                    Err("Fairy took too long to answer".to_string())
                }
                _ => Err(e.to_string()),
            },
        }
    }

    /// Read reply lines until `done` (her answer) or `error`, passing each
    /// `text` (the reply so far) to `on_text`. The reader stays usable, for
    /// [`wait_spoken`].
    pub fn read_reply(
        reader: &mut BufReader<UnixStream>,
        timeout: Duration,
        mut on_text: impl FnMut(&str),
    ) -> Result<String, String> {
        reader
            .get_ref()
            .set_read_timeout(Some(timeout))
            .map_err(|e| e.to_string())?;
        while let Some(line) = next_line(reader)? {
            if !line.ends_with('\n') {
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

    /// After an answer she's saying: wait for her `spoken` (she has finished,
    /// or skipped it, muted), the connection closing, or `timeout`.
    pub fn wait_spoken(reader: &mut BufReader<UnixStream>, timeout: Duration) {
        if reader.get_ref().set_read_timeout(Some(timeout)).is_err() {
            return;
        }
        while let Ok(Some(line)) = next_line(reader) {
            let spoken = serde_json::from_str::<serde_json::Value>(&line)
                .ok()
                .and_then(|m| {
                    m.get("type")
                        .and_then(|t| t.as_str())
                        .map(|t| t == "spoken")
                })
                .unwrap_or(false);
            if spoken {
                return;
            }
        }
    }
}

/// Flux's browser tools for Fairy (Lyra's `desktop/flux-tools.mjs`).
///
/// Flux listens on `fairy-tools.sock` in its own data folder (0600). Each ask
/// from the agent panel carries that path and a fresh random key; the key
/// works only until that answer ends, so nothing else on the Mac can drive the
/// browser by connecting, and Fairy can't act outside a question you asked.
/// One line of JSON each way:
///
/// ```text
/// → {id, token, tool, args}   ← {id, result} or {id, error}
/// ```
///
/// A call goes to the agent panel (`flux://fairy-tool`), which runs it with the
/// same checks as `/task` (`fairyTools.ts`): the step guard, the sensitive-site
/// refusal, the committed-URL binding, and its approval card for a commit. The
/// panel answers through `fairy_tool_result`.
#[cfg(target_os = "macos")]
pub mod tools {
    use std::collections::{HashMap, HashSet};
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{mpsc, Mutex, OnceLock};
    use std::time::Duration;

    use tauri::{AppHandle, Emitter, Manager};

    /// What Fairy may ask for. Anything else is refused before the panel sees it.
    pub const TOOLS: &[&str] = &["tabs", "read", "open", "click", "type"];
    /// A commit waits for your answer on its card.
    const ANSWER_WITHIN: Duration = Duration::from_secs(10 * 60);

    static SOCKET: OnceLock<PathBuf> = OnceLock::new();
    static NEXT_CALL: AtomicU64 = AtomicU64::new(1);
    type Answer = Result<serde_json::Value, String>;

    fn keys() -> &'static Mutex<HashSet<String>> {
        static K: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
        K.get_or_init(Default::default)
    }
    fn pending() -> &'static Mutex<HashMap<u64, mpsc::Sender<Answer>>> {
        static P: OnceLock<Mutex<HashMap<u64, mpsc::Sender<Answer>>>> = OnceLock::new();
        P.get_or_init(Default::default)
    }

    /// Listen for Fairy's tool calls. Once, at startup.
    pub fn start(app: &AppHandle) {
        let Ok(dir) = app.path().app_data_dir() else {
            return;
        };
        let path = dir.join("fairy-tools.sock");
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::remove_file(&path);
        let listener = match UnixListener::bind(&path) {
            Ok(l) => l,
            Err(e) => {
                tracing::warn!(target: "flux::fairy", error = %e, "no tool socket for Fairy");
                return;
            }
        };
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        let _ = SOCKET.set(path);
        let app = app.clone();
        std::thread::Builder::new()
            .name("fairy-tools".into())
            .spawn(move || {
                for conn in listener.incoming().flatten() {
                    let app = app.clone();
                    let _ = std::thread::Builder::new()
                        .name("fairy-tool".into())
                        .spawn(move || serve(&app, conn));
                }
            })
            .ok();
    }

    /// A key for one ask, with the socket it opens. None when there's no socket.
    pub fn grant() -> Option<(String, String)> {
        let path = SOCKET.get()?.to_string_lossy().into_owned();
        let token: String = flux_vault::new_key()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        keys().lock().ok()?.insert(token.clone());
        Some((path, token))
    }

    /// The ask is over: its key stops working.
    pub fn revoke(token: &str) {
        if let Ok(mut k) = keys().lock() {
            k.remove(token);
        }
    }

    /// The panel's answer to call `call`.
    pub fn answer(call: u64, result: Answer) {
        let tx = pending().lock().ok().and_then(|mut p| p.remove(&call));
        if let Some(tx) = tx {
            let _ = tx.send(result);
        }
    }

    fn serve(app: &AppHandle, conn: UnixStream) {
        let _ = conn.set_read_timeout(Some(Duration::from_secs(30)));
        let Ok(mut out) = conn.try_clone() else {
            return;
        };
        let mut line = String::new();
        if BufReader::new(conn.take(1 << 20))
            .read_line(&mut line)
            .is_err()
        {
            return;
        }
        let msg: serde_json::Value = serde_json::from_str(&line).unwrap_or_default();
        let id = msg.get("id").cloned().unwrap_or(serde_json::Value::Null);
        let reply = match check(&msg) {
            Err(e) => serde_json::json!({ "id": id, "error": e }),
            Ok((tool, args)) => match call(app, tool, args) {
                Ok(result) => serde_json::json!({ "id": id, "result": result }),
                Err(e) => serde_json::json!({ "id": id, "error": e }),
            },
        };
        let _ = writeln!(out, "{reply}");
    }

    /// A call's tool and arguments, if its key is current and its tool is one
    /// Fairy may use.
    pub(super) fn check(msg: &serde_json::Value) -> Result<(String, serde_json::Value), String> {
        let token = msg.get("token").and_then(|t| t.as_str()).unwrap_or("");
        if token.is_empty() || !keys().lock().map(|k| k.contains(token)).unwrap_or(false) {
            return Err(
                "That key isn't current: Flux's tools work only while it waits for your answer."
                    .into(),
            );
        }
        let tool = msg.get("tool").and_then(|t| t.as_str()).unwrap_or("");
        if !TOOLS.contains(&tool) {
            return Err(format!("Flux has no tool called {tool:?}."));
        }
        let args = msg
            .get("args")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        if !args.is_object() {
            return Err("Those arguments aren't an object.".into());
        }
        Ok((tool.to_string(), args))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use serde_json::json;

        #[test]
        fn tool_calls_need_a_current_key_and_a_known_tool() {
            let key = "b".repeat(64);
            assert!(check(&json!({ "token": key, "tool": "read" }))
                .unwrap_err()
                .contains("current"));
            keys().lock().unwrap().insert(key.clone());
            let (tool, args) =
                check(&json!({ "token": key, "tool": "read", "args": { "tab": 3 } })).unwrap();
            assert_eq!((tool.as_str(), args), ("read", json!({ "tab": 3 })));
            assert!(check(&json!({ "token": key, "tool": "run_shell" }))
                .unwrap_err()
                .contains("no tool"));
            assert!(check(&json!({ "token": key, "tool": "read", "args": [1] })).is_err());
            revoke(&key);
            assert!(
                check(&json!({ "token": key, "tool": "read" })).is_err(),
                "gone with its ask"
            );
        }

        #[test]
        fn an_answer_reaches_the_waiting_call_once() {
            let (tx, rx) = mpsc::channel();
            pending().lock().unwrap().insert(9_000_001, tx);
            answer(9_000_001, Ok(json!({ "ok": true })));
            answer(9_000_001, Err("late".into()));
            assert_eq!(rx.recv().unwrap(), Ok(json!({ "ok": true })));
            assert!(rx.try_recv().is_err());
        }
    }

    fn call(app: &AppHandle, tool: String, args: serde_json::Value) -> Answer {
        let call = NEXT_CALL.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        pending()
            .lock()
            .map_err(|e| e.to_string())?
            .insert(call, tx);
        if app
            .emit(
                "flux://fairy-tool",
                serde_json::json!({ "call": call, "tool": tool, "args": args }),
            )
            .is_err()
        {
            pending().lock().ok().and_then(|mut p| p.remove(&call));
            return Err("Flux's panel isn't listening.".into());
        }
        match rx.recv_timeout(ANSWER_WITHIN) {
            Ok(answer) => answer,
            Err(_) => {
                pending().lock().ok().and_then(|mut p| p.remove(&call));
                Err("Flux didn't answer in time.".into())
            }
        }
    }
}

/// The agent panel's answer to one of Fairy's tool calls.
#[tauri::command]
pub fn fairy_tool_result(call: u64, result: Option<serde_json::Value>, error: Option<String>) {
    #[cfg(target_os = "macos")]
    tools::answer(
        call,
        match error {
            Some(e) => Err(e),
            None => Ok(result.unwrap_or(serde_json::Value::Null)),
        },
    );
    #[cfg(not(target_os = "macos"))]
    let _ = (call, result, error);
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
    app: tauri::AppHandle,
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
        // Flux's browser tools for this ask only: the key stops working when
        // the answer ends, however it ends.
        let grant = tools::grant();
        let token = grant.as_ref().map(|(_, t)| t.clone());
        let mut ask = serde_json::json!({
            "type": "ask", "text": question, "context": context,
            // `speak`: Flux reads its agent's answers aloud, so Fairy says hers,
            // in her own voice (her window does, and stays quiet if she's muted).
            "speak": true,
        });
        if let Some((socket, token)) = grant {
            ask["tools"] = serde_json::json!({ "socket": socket, "token": token });
        }
        let text = tauri::async_runtime::spawn_blocking(move || {
            let mut conn = link::connect(true)?;
            link::send(&mut conn, &ask)?;
            let mut reader = std::io::BufReader::new(conn);
            // A reply on a subscription CLI can take a few minutes, and a task
            // with tools longer, waiting on your answers to its commits.
            let text = link::read_reply(
                &mut reader,
                std::time::Duration::from_secs(20 * 60),
                |so_far| {
                    let _ = on_text.send(so_far.to_string());
                },
            )?;
            // Now she says it: the panel keeps its Stop up until she has
            // (flux://fairy-speaking … flux://fairy-spoken), and a Stop quiets her.
            use tauri::Emitter;
            let _ = app.emit("flux://fairy-speaking", ());
            std::thread::spawn(move || {
                link::wait_spoken(&mut reader, std::time::Duration::from_secs(6 * 60));
                let _ = app.emit("flux://fairy-spoken", ());
            });
            Ok::<String, String>(text)
        })
        .await
        .map_err(|e| e.to_string());
        if let Some(token) = token {
            tools::revoke(&token);
        }
        Ok(FairyReply {
            text: text??,
            with_page,
        })
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
        let text = link::read_reply(
            &mut std::io::BufReader::new(a),
            std::time::Duration::from_secs(2),
            |t| seen.push(t.to_string()),
        )
        .unwrap();
        assert_eq!(text, "Hi there");
        assert_eq!(seen, ["Hi"]);
        // Then her `spoken`, after the answer she's saying, ends the wait.
        let (a, mut b) = UnixStream::pair().unwrap();
        b.write_all(b"{\"type\":\"done\",\"text\":\"x\"}\n{\"type\":\"spoken\"}\n")
            .unwrap();
        let mut reader = std::io::BufReader::new(a);
        assert_eq!(
            link::read_reply(&mut reader, std::time::Duration::from_secs(2), |_| {}).unwrap(),
            "x"
        );
        let started = std::time::Instant::now();
        link::wait_spoken(&mut reader, std::time::Duration::from_secs(5));
        assert!(
            started.elapsed() < std::time::Duration::from_secs(1),
            "spoken was already there"
        );
        let (a, mut b) = UnixStream::pair().unwrap();
        b.write_all(b"{\"type\":\"error\",\"message\":\"Stopped.\"}\n")
            .unwrap();
        assert_eq!(
            link::read_reply(
                &mut std::io::BufReader::new(a),
                std::time::Duration::from_secs(2),
                |_| {}
            )
            .unwrap_err(),
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
        let text = link::read_reply(
            &mut std::io::BufReader::new(conn),
            std::time::Duration::from_secs(10),
            |t| seen.push(t.to_string()),
        )
        .unwrap();
        assert!(
            text.contains("<page>") && text.contains("Address: https://a.example/p"),
            "{text}"
        );
        assert!(!seen.is_empty());
    }
}
