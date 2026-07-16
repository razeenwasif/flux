//! Native RSS / Atom reader (BACKLOG #72): subscribe to feeds and read them in
//! a Flux internal page (`flux://feeds`). Subscriptions (url + title) persist as
//! plain JSON; items are fetched on demand and never stored — always fresh, no
//! cache to invalidate.
//!
//! Parsing is hand-rolled rather than pulling a feed crate (+ an XML stack): a
//! lean scanner that covers RSS 2.0 and Atom 1.0 — CDATA unwrapping, the common
//! HTML entities, tag stripping for snippets. This keeps the binary small (the
//! low-RAM edge is Flux's whole point) at the cost of not being a conformant XML
//! parser; real-world feeds are regular enough that it holds up.

use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::State;

/// Largest feed document we'll pull — a runaway feed can't exhaust memory.
const MAX_FEED_BYTES: u64 = 4 * 1024 * 1024;
/// Trim item summaries to a readable card length.
const SNIPPET_MAX: usize = 280;

/// A subscribed feed. Only the subscription is persisted (id, url, title).
#[derive(Serialize, Deserialize, Clone, specta::Type)]
pub struct Feed {
    pub id: u64,
    pub url: String,
    pub title: String,
}

/// One entry of a feed — fetched live, never persisted.
#[derive(Serialize, Clone, specta::Type)]
pub struct FeedItem {
    pub feed_id: u64,
    pub feed_title: String,
    pub title: String,
    pub link: String,
    pub summary: String,
    /// Raw published/updated string from the feed (display-only; not parsed).
    pub published: String,
}

#[derive(Default)]
pub struct FeedStore {
    feeds: RwLock<Vec<Feed>>,
    next_id: AtomicU64,
    path: Option<PathBuf>,
}

impl FeedStore {
    pub fn restore(path: PathBuf) -> Self {
        let feeds: Vec<Feed> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let next = feeds.iter().map(|f| f.id).max().unwrap_or(0) + 1;
        Self {
            feeds: RwLock::new(feeds),
            next_id: AtomicU64::new(next),
            path: Some(path),
        }
    }

    pub fn list(&self) -> Vec<Feed> {
        self.feeds.read().clone()
    }

    /// Add a subscription (deduped by url). Returns the existing feed if already
    /// subscribed. `title` is the parsed feed title (falls back to the host).
    pub fn add(&self, url: String, title: String) -> Feed {
        {
            let feeds = self.feeds.read();
            if let Some(f) = feeds.iter().find(|f| f.url == url) {
                return f.clone();
            }
        }
        let feed = Feed {
            id: self.next_id.fetch_add(1, Ordering::Relaxed),
            url,
            title,
        };
        self.feeds.write().push(feed.clone());
        self.save();
        feed
    }

    pub fn remove(&self, id: u64) {
        self.feeds.write().retain(|f| f.id != id);
        self.save();
    }

    pub fn get(&self, id: u64) -> Option<Feed> {
        self.feeds.read().iter().find(|f| f.id == id).cloned()
    }

    fn save(&self) {
        let Some(path) = &self.path else { return };
        crate::persist::save_json(path, &*self.feeds.read());
    }
}

// ─── Fetch ───────────────────────────────────────────────────────────────────

fn fetch_text(url: &str) -> Result<String, String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("feed url must be http(s)".into());
    }
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(8))
        .timeout_read(Duration::from_secs(30))
        .build();
    let resp = agent
        .get(url)
        .set("User-Agent", "Mozilla/5.0")
        .set(
            "Accept",
            "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        )
        .call()
        .map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    resp.into_reader()
        .take(MAX_FEED_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    if buf.is_empty() {
        return Err("empty response".into());
    }
    // Feeds are UTF-8 in practice; lossy keeps a stray byte from killing parse.
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Derive a readable fallback title from a feed url (its host, sans `www.`).
fn host_of(url: &str) -> String {
    url.split("://")
        .nth(1)
        .unwrap_or(url)
        .split('/')
        .next()
        .unwrap_or(url)
        .trim_start_matches("www.")
        .to_string()
}

// ─── Parse (lean RSS 2.0 / Atom 1.0 scanner) ──────────────────────────────────

struct Parsed {
    title: String,
    items: Vec<(String, String, String, String)>, // title, link, summary, published
}

fn parse_feed(doc: &str) -> Parsed {
    let is_atom = doc.contains("<feed") && doc.contains("<entry");
    let item_tag = if is_atom { "entry" } else { "item" };

    // Feed title lives in the header, before the first item.
    let header_end = find_tag_open(doc, item_tag, 0)
        .map(|(s, _)| s)
        .unwrap_or(doc.len());
    let title = field(&doc[..header_end], "title").unwrap_or_else(|| String::new());

    let mut items = Vec::new();
    for chunk in chunks(doc, item_tag) {
        let it_title = field(chunk, "title").unwrap_or_default();
        let link = if is_atom {
            atom_link(chunk)
        } else {
            field(chunk, "link")
        }
        .unwrap_or_default();
        let summary = field(chunk, if is_atom { "summary" } else { "description" })
            .or_else(|| field(chunk, "content:encoded"))
            .or_else(|| field(chunk, "content"))
            .map(|s| snippet(&s))
            .unwrap_or_default();
        let published = field(chunk, if is_atom { "published" } else { "pubDate" })
            .or_else(|| field(chunk, "updated"))
            .or_else(|| field(chunk, "dc:date"))
            .unwrap_or_default();
        if it_title.is_empty() && link.is_empty() {
            continue;
        }
        items.push((it_title, link, summary, published));
    }
    Parsed { title, items }
}

/// Locate `<name` at/after `from`, requiring a tag-boundary char after the name
/// (so `<title` doesn't match `<titlebar`). Returns (start, end-of-`>`).
fn find_tag_open(doc: &str, name: &str, from: usize) -> Option<(usize, usize)> {
    let open = format!("<{name}");
    let mut search = from;
    while let Some(rel) = doc[search..].find(&open) {
        let start = search + rel;
        let after = start + open.len();
        match doc.as_bytes().get(after) {
            Some(b' ' | b'\t' | b'\n' | b'\r' | b'>' | b'/') => {}
            _ => {
                search = after;
                continue;
            }
        }
        if let Some(g) = doc[start..].find('>') {
            return Some((start, start + g));
        }
        return None;
    }
    None
}

/// All `<name ...>…</name>` chunks (inner not included of the closing tag).
fn chunks<'a>(doc: &'a str, name: &str) -> Vec<&'a str> {
    let close = format!("</{name}>");
    let mut out = Vec::new();
    let mut search = 0;
    while let Some((start, _)) = find_tag_open(doc, name, search) {
        if let Some(crel) = doc[start..].find(&close) {
            let end = start + crel + close.len();
            out.push(&doc[start..end]);
            search = end;
        } else {
            break;
        }
    }
    out
}

/// Inner text of the first `<name …>…</name>` in `chunk`, CDATA-unwrapped and
/// entity-decoded. Returns None if absent; "" if self-closing.
fn field(chunk: &str, name: &str) -> Option<String> {
    let (start, gt) = find_tag_open(chunk, name, 0)?;
    let _ = start;
    if chunk.as_bytes().get(gt.wrapping_sub(1)) == Some(&b'/') {
        return Some(String::new());
    }
    let close = format!("</{name}>");
    let rel = chunk[gt + 1..].find(&close)?;
    let raw = &chunk[gt + 1..gt + 1 + rel];
    Some(decode_entities(&strip_cdata(raw)).trim().to_string())
}

/// Atom `<link>` resolution: prefer `rel="alternate"` (or no rel) `href`.
fn atom_link(chunk: &str) -> Option<String> {
    let mut fallback: Option<String> = None;
    let mut search = 0;
    while let Some((start, gt)) = find_tag_open(chunk, "link", search) {
        let tag = &chunk[start..gt];
        search = gt + 1;
        if let Some(href) = attr(tag, "href") {
            let rel = attr(tag, "rel").unwrap_or_else(|| "alternate".into());
            if rel == "alternate" {
                return Some(href);
            }
            fallback.get_or_insert(href);
        }
    }
    // Fall back to a text-content <link> (some Atom feeds, all RSS).
    fallback.or_else(|| field(chunk, "link").filter(|s| !s.is_empty()))
}

/// Read a quoted attribute value out of an opening-tag slice.
fn attr(tag: &str, name: &str) -> Option<String> {
    let key = format!("{name}=");
    let mut from = 0;
    while let Some(rel) = tag[from..].find(&key) {
        let i = from + rel;
        // Ensure the char before `name` is a boundary (avoid `xhref=`/`rel=` vs `rrel=`).
        let ok_before = i == 0 || matches!(tag.as_bytes()[i - 1], b' ' | b'\t' | b'\n' | b'\r');
        let vi = i + key.len();
        from = vi;
        if !ok_before {
            continue;
        }
        let quote = *tag.as_bytes().get(vi)?;
        if quote != b'"' && quote != b'\'' {
            continue;
        }
        let rest = &tag[vi + 1..];
        let end = rest.find(quote as char)?;
        return Some(decode_entities(&rest[..end]));
    }
    None
}

/// Unwrap every `<![CDATA[ … ]]>` section, keeping surrounding text.
fn strip_cdata(s: &str) -> String {
    if !s.contains("<![CDATA[") {
        return s.to_string();
    }
    let mut out = String::new();
    let mut rest = s;
    while let Some(start) = rest.find("<![CDATA[") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 9..];
        match after.find("]]>") {
            Some(end) => {
                out.push_str(&after[..end]);
                rest = &after[end + 3..];
            }
            None => {
                out.push_str(after);
                return out;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Decode the handful of entities that actually appear in feeds. `&amp;` last so
/// we don't double-decode (`&amp;lt;` → `&lt;`, not `<`).
fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

/// Strip HTML tags and collapse whitespace into a card-length plain snippet.
fn snippet(html: &str) -> String {
    let mut text = String::with_capacity(html.len());
    let mut depth = 0u32;
    for c in html.chars() {
        match c {
            '<' => depth += 1,
            '>' => depth = depth.saturating_sub(1),
            _ if depth == 0 => text.push(c),
            _ => {}
        }
    }
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > SNIPPET_MAX {
        let mut s: String = collapsed.chars().take(SNIPPET_MAX).collect();
        s.push('…');
        s
    } else {
        collapsed
    }
}

// ─── Commands ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn feeds_list(store: State<'_, FeedStore>) -> Vec<Feed> {
    store.list()
}

#[tauri::command]
pub async fn feed_add(store: State<'_, FeedStore>, url: String) -> Result<Feed, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("empty url".into());
    }
    // Already subscribed → return it without a network round-trip.
    if let Some(f) = store.list().into_iter().find(|f| f.url == url) {
        return Ok(f);
    }
    let fetch_url = url.clone();
    let doc = tauri::async_runtime::spawn_blocking(move || fetch_text(&fetch_url))
        .await
        .map_err(|e| e.to_string())??;
    let parsed = parse_feed(&doc);
    if parsed.items.is_empty() && parsed.title.is_empty() {
        return Err("no feed found at that url (RSS/Atom only)".into());
    }
    let title = if parsed.title.is_empty() {
        host_of(&url)
    } else {
        parsed.title
    };
    Ok(store.add(url, title))
}

#[tauri::command]
pub fn feed_remove(store: State<'_, FeedStore>, id: u64) {
    store.remove(id);
}

/// Fetch + parse a single subscribed feed (`id`), or all feeds aggregated in
/// subscription order when `id` is `None`/0. Per-feed errors are skipped in the
/// aggregate so one dead feed doesn't blank the page.
#[tauri::command]
pub async fn feed_items(
    store: State<'_, FeedStore>,
    id: Option<u64>,
) -> Result<Vec<FeedItem>, String> {
    let targets: Vec<Feed> = match id {
        Some(id) if id != 0 => {
            vec![store.get(id).ok_or_else(|| "no such feed".to_string())?]
        }
        _ => store.list(),
    };
    let single = matches!(id, Some(id) if id != 0);

    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        for feed in &targets {
            match fetch_text(&feed.url) {
                Ok(doc) => {
                    let parsed = parse_feed(&doc);
                    let feed_title = if feed.title.is_empty() {
                        host_of(&feed.url)
                    } else {
                        feed.title.clone()
                    };
                    for (title, link, summary, published) in parsed.items {
                        out.push(FeedItem {
                            feed_id: feed.id,
                            feed_title: feed_title.clone(),
                            title,
                            link,
                            summary,
                            published,
                        });
                    }
                }
                Err(e) if single => return Err(e),
                Err(_) => {} // aggregate view: skip a failing feed
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const RSS: &str = r#"<?xml version="1.0"?>
    <rss version="2.0"><channel>
      <title>Example Blog</title>
      <link>https://ex.dev</link>
      <item>
        <title>First &amp; Best</title>
        <link>https://ex.dev/1</link>
        <description><![CDATA[<p>Hello <b>world</b> from the feed.</p>]]></description>
        <pubDate>Mon, 01 Jan 2026 12:00:00 GMT</pubDate>
      </item>
      <item>
        <title>Second post</title>
        <link>https://ex.dev/2</link>
        <description>Plain &lt;summary&gt; text</description>
      </item>
    </channel></rss>"#;

    const ATOM: &str = r#"<?xml version="1.0" encoding="utf-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <title>Atom Example</title>
      <entry>
        <title>Atom Entry One</title>
        <link rel="alternate" href="https://atom.dev/a"/>
        <link rel="edit" href="https://atom.dev/edit/a"/>
        <summary>A short summary.</summary>
        <published>2026-01-02T10:00:00Z</published>
      </entry>
    </feed>"#;

    #[test]
    fn parses_rss() {
        let p = parse_feed(RSS);
        assert_eq!(p.title, "Example Blog");
        assert_eq!(p.items.len(), 2);
        assert_eq!(p.items[0].0, "First & Best");
        assert_eq!(p.items[0].1, "https://ex.dev/1");
        assert_eq!(p.items[0].2, "Hello world from the feed.");
        assert_eq!(p.items[0].3, "Mon, 01 Jan 2026 12:00:00 GMT");
        // description is HTML: an escaped <summary> decodes to a tag and is
        // stripped, exactly as a feed reader would render it.
        assert_eq!(p.items[1].2, "Plain text");
    }

    #[test]
    fn parses_atom_and_prefers_alternate_link() {
        let p = parse_feed(ATOM);
        assert_eq!(p.title, "Atom Example");
        assert_eq!(p.items.len(), 1);
        assert_eq!(p.items[0].0, "Atom Entry One");
        assert_eq!(p.items[0].1, "https://atom.dev/a");
        assert_eq!(p.items[0].2, "A short summary.");
        assert_eq!(p.items[0].3, "2026-01-02T10:00:00Z");
    }

    #[test]
    fn store_dedupes_and_persists() {
        let s = FeedStore::default();
        let a = s.add("https://ex.dev/feed".into(), "Ex".into());
        let b = s.add("https://ex.dev/feed".into(), "Ex again".into());
        assert_eq!(a.id, b.id);
        assert_eq!(s.list().len(), 1);
        s.remove(a.id);
        assert!(s.list().is_empty());
    }

    #[test]
    fn host_fallback() {
        assert_eq!(host_of("https://www.example.com/rss.xml"), "example.com");
        assert_eq!(host_of("http://blog.dev/feed"), "blog.dev");
    }

    #[test]
    fn snippet_strips_and_truncates() {
        assert_eq!(snippet("<p>a  b\n c</p>"), "a b c");
        let long = "x ".repeat(400);
        assert!(snippet(&long).chars().count() <= SNIPPET_MAX + 1);
    }
}
